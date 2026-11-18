// How reading a repository's .github/review.json can go wrong. Each of these would otherwise fail quietly: a typo that
// drops the sensitive list, a gate that approves without CI, a marker tag that breaks the marker regex, a review that
// posts nothing, or an engine that falls back to another repository.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALWAYS_SENSITIVE, codeownersGaps, loadConfig, parseConfig, repoFrom, sensitiveMatcher } from "./config";

const ether = await Bun.file(join(import.meta.dir, "testdata/ether.json")).json();
const valid = () => structuredClone(ether);
const rejects = (over: (c: any) => void, message: RegExp) => {
  const c = valid();
  over(c);
  expect(() => parseConfig(c)).toThrow(message);
};

test("ether's config parses, with the engine's defaults filled in", () => {
  const c = parseConfig(valid());
  expect(c.markerTag).toBe("ether-review");
  expect(c.depth).toEqual({ finders: 2, voters: 2, votesToPost: 2 });
  expect(c.roundCap).toBe(3);
  expect(c.gateCheck).toBe("Review gate");
  expect(c.noAutomergeLabel).toBe("no-automerge");
});

test("a misspelled key is an error, at any depth", () => {
  rejects((c) => ((c.sensitve = c.sensitive), delete c.sensitive), /sensitve/);
  rejects((c) => (c.focus.secuirty = "x"), /focus\.secuirty/);
  rejects((c) => (c.depth = { finders: 2, voters: 2, votesToPost: 2, extra: 1 }), /depth\.extra/);
});

test("a missing required key is an error that names it", () => {
  for (const key of ["project", "botLogin", "markerTag", "reportOnly", "checks", "focus", "eligibility", "lowRisk", "sensitive", "requiredChecks", "fixTrailer"])
    rejects((c) => delete c[key], new RegExp(key));
  rejects((c) => delete c.focus.security, /focus\.security/);
  rejects((c) => delete c.eligibility.alwaysNotLow, /eligibility\.alwaysNotLow/);
});

test("a value of the wrong type is an error", () => {
  rejects((c) => (c.sensitive = "src/**"), /sensitive/);
  rejects((c) => (c.sensitive = ["src/**", 3]), /sensitive/);
  rejects((c) => (c.reportOnly = "false"), /reportOnly/);
  rejects((c) => (c.project = ""), /project/);
  rejects((c) => (c.focus.contracts = 1), /focus\.contracts/);
});

test("the gate can't approve without required checks", () => {
  rejects((c) => (c.requiredChecks = []), /requiredChecks/);
  const c = valid();
  c.requiredChecks = [];
  c.reportOnly = true;
  expect(parseConfig(c).requiredChecks).toEqual([]);
});

test("a depth that could never post, or isn't a positive integer, is an error", () => {
  rejects((c) => (c.depth = { finders: 2, voters: 2, votesToPost: 3 }), /votesToPost/);
  rejects((c) => (c.depth = { finders: 0, voters: 2, votesToPost: 1 }), /finders/);
  rejects((c) => (c.depth = { finders: 1.5, voters: 2, votesToPost: 1 }), /finders/);
  rejects((c) => (c.roundCap = 0), /roundCap/);
});

test("a marker tag that could break the hidden markers is an error", () => {
  for (const tag of ["", "a b", "x-->", "Ether", "a.b", "a(b"]) rejects((c) => (c.markerTag = tag), /markerTag/);
});

test("workflows and agent instructions stay sensitive whatever the config lists", () => {
  const c = valid();
  c.sensitive = [];
  const isSensitive = sensitiveMatcher(parseConfig(c));
  for (const p of [".github/workflows/ci.yml", ".github/review.json", "CLAUDE.md", "docs/AGENTS.md", ".claude/settings.json", "a/.mcp.json", ".cursor/rules/x.mdc"]) expect(isSensitive(p)).toBe(true);
  expect(isSensitive("src/main.rs")).toBe(false);
  expect(ALWAYS_SENSITIVE).toContain(".github/**");
});

test("a missing or unreadable config file is an error that names the path", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-config-"));
  expect(() => loadConfig(join(dir, "nope.json"))).toThrow(/nope\.json/);
  writeFileSync(join(dir, "bad.json"), "{ not json");
  expect(() => loadConfig(join(dir, "bad.json"))).toThrow(/bad\.json/);
  writeFileSync(join(dir, "ok.json"), JSON.stringify(ether));
  expect(loadConfig(join(dir, "ok.json")).project).toStartWith("Ether");
});

test("the repository comes from GITHUB_REPOSITORY, never a default", () => {
  expect(() => repoFrom(undefined)).toThrow(/GITHUB_REPOSITORY/);
  expect(() => repoFrom("")).toThrow(/GITHUB_REPOSITORY/);
  expect(() => repoFrom("ether")).toThrow(/GITHUB_REPOSITORY/);
  expect(() => repoFrom("a/b/c")).toThrow(/GITHUB_REPOSITORY/);
  expect(repoFrom("hanare-suite/hanare")).toBe("hanare-suite/hanare");
});

test("a sensitive path CODEOWNERS doesn't cover is reported", () => {
  const c = parseConfig({ ...valid(), sensitive: ["src/server/auth.ts", "src/server/db/**", "cli/Cargo.*"] });
  const owners = "# comment\n/.github/ @a\nCLAUDE.md @a\nAGENTS.md @a\nGEMINI.md @a\n**/.claude/ @a\n**/.cursor/ @a\n**/.mcp.json @a\n.cursorrules @a\nCLAUDE.local.md @a\n/src/server/auth.ts @a\n/cli/Cargo.toml @a\n";
  expect(codeownersGaps(c, owners)).toEqual(["src/server/db/**"]);
  expect(codeownersGaps(c, `${owners}/src/server/db/ @a\n`)).toEqual([]);
});

test("a glob that can never match a repository path is an error", () => {
  for (const g of ["/src/server/auth.ts", "src/server/db/", "./package.json", "!src/**", "src\\a.ts", " src/a.ts"]) {
    rejects((c) => (c.sensitive = [g]), /sensitive/);
    rejects((c) => (c.lowRisk = [g]), /lowRisk/);
  }
});

test("names that must stay on one line can't hold a newline", () => {
  rejects((c) => (c.fixTrailer = "Written-by: x\nmore"), /fixTrailer/);
  rejects((c) => (c.gateCheck = "Review\ngate"), /gateCheck/);
  rejects((c) => (c.noAutomergeLabel = "no\nmerge"), /noAutomergeLabel/);
  rejects((c) => (c.requiredChecks = ["CI\n"]), /requiredChecks/);
  rejects((c) => (c.requiredChecks = [" CI"]), /requiredChecks/);
});

test("the gate's own check can't be a required check, or the gate waits on itself", () => {
  rejects((c) => (c.requiredChecks = ["CI", "Review gate"]), /requiredChecks/);
});

test("a depth or round cap far past what a review needs is an error", () => {
  rejects((c) => (c.depth = { finders: 9, voters: 2, votesToPost: 2 }), /finders/);
  rejects((c) => (c.depth = { finders: 2, voters: 9, votesToPost: 2 }), /voters/);
  rejects((c) => (c.roundCap = 21), /roundCap/);
});
