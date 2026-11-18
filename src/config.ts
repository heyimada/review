// Settings for the automated review (review.ts), the merge gate (gate.ts) and /fix (fix.ts). What differs between
// repositories comes from the repository's own .github/review.json, read from its default branch; the rest lives here.

import { readFileSync } from "node:fs";

export interface RepoConfig {
  // Who the agents are reviewing: the product, where its parts live, and where the conventions are written down.
  project: string;
  // The App's login, for local dry runs. In CI the login comes from the App token step.
  botLogin: string;
  // Prefix of the hidden markers on the App's comments. Changing it forgets every review already posted.
  markerTag: string;
  // While on, the App only reports: it posts findings and a neutral gate check, but never approves, requests changes or
  // enables auto-merge.
  reportOnly: boolean;
  // What CI already catches, so the finders don't report it.
  checks: string;
  focus: Record<Lens, string>;
  eligibility: {
    // Stored data whose format and meaning must not change in a low-risk change.
    storedData: string;
    // What other people or programs rely on, which a low-risk change may only add to.
    interfaces: string;
    // What always needs a human, on top of error handling and the build or CI, which always do.
    alwaysNotLow: string;
  };
  // Changes that touch only these paths can be auto-merged unless the eligibility check escalates them.
  lowRisk: string[];
  // Always need a human, whatever the eligibility check says, on top of ALWAYS_SENSITIVE. Keep in sync with CODEOWNERS.
  sensitive: string[];
  // The required CI checks from branch protection, all run by GitHub Actions.
  requiredChecks: string[];
  // In every commit /fix makes. The gate also looks for the App as author; either one is enough.
  fixTrailer: string;
  model: string;
  // Each lens group gets `finders` independent finders, and each candidate `voters` voters; `votesToPost` must say real.
  depth: { finders: number; voters: number; votesToPost: number };
  // From this round on, only commits since the last reviewed SHA are reviewed. After it, only important findings are posted.
  roundCap: number;
  gateCheck: string;
  noAutomergeLabel: string;
}

export const LENS_GROUPS = {
  bugs: ["correctness", "lifecycle", "contracts"],
  security: ["security"],
} as const;
export type LensGroup = keyof typeof LENS_GROUPS;
export type Lens = (typeof LENS_GROUPS)[LensGroup][number];
const LENSES: Lens[] = Object.values(LENS_GROUPS).flat();

// Sensitive in every repository. Agent instruction and config files steer every agent that works on the repo, like a
// system prompt, and the workflows hold the secrets.
export const ALWAYS_SENSITIVE = [
  ".github/**",
  "claude.md",
  "agents.md",
  "gemini.md",
  "**/claude.md",
  "**/claude.local.md",
  "**/agents.md",
  "**/gemini.md",
  ".claude/**",
  "**/.claude/**",
  ".mcp.json",
  "**/.mcp.json",
  ".cursor/**",
  "**/.cursor/**",
  "**/.cursorrules",
];

const DEFAULTS = {
  model: "claude-opus-5-5",
  depth: { finders: 2, voters: 2, votesToPost: 2 },
  roundCap: 3,
  gateCheck: "Review gate",
  noAutomergeLabel: "no-automerge",
};

// Checks a parsed .github/review.json. Anything unexpected is an error rather than ignored: a misspelled "sensitive"
// would otherwise drop every sensitive path without a sound.
export function parseConfig(raw: unknown): RepoConfig {
  const fail = (msg: string): never => {
    throw new Error(`review config: ${msg}`);
  };
  const object = (v: unknown, at: string) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(`${at} must be an object`));
  const only = (o: Record<string, unknown>, keys: string[], at: string) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`unknown key ${at}${k}`);
  };
  const text = (v: unknown, at: string) => (typeof v === "string" && v.trim() ? v : fail(`${at} must be a non-empty string`));
  // Names compared with what GitHub reports, or matched line by line: one line, no padding.
  const line = (v: unknown, at: string) => (typeof v === "string" && v.trim() && v === v.trim() && !/[\r\n]/.test(v) ? v : fail(`${at} must be one line with no surrounding spaces`));
  const lines = (v: unknown, at: string) => (Array.isArray(v) ? v.map((x, i) => line(x, `${at}[${i}]`)) : fail(`${at} must be a list of strings`));
  // Paths are matched relative to the repository root with no leading slash, so a CODEOWNERS-style "/a", "./a" or "dir/"
  // would never match, and "!" negates in Bun's globs.
  const globs = (v: unknown, at: string) =>
    lines(v, at).map((g) => (/^(\/|\.\/|!)|\/$|\\/.test(g) ? fail(`${at}: "${g}" never matches a path; write it relative to the root, like src/** or a/b.ts`) : g));
  const count = (v: unknown, at: string, max: number) => (Number.isInteger(v) && (v as number) > 0 && (v as number) <= max ? (v as number) : fail(`${at} must be a whole number from 1 to ${max}`));
  const required = (o: Record<string, unknown>, k: string, at: string) => (k in o ? o[k] : fail(`missing ${at}${k}`));

  const c = object(raw, "the config");
  only(c, ["project", "botLogin", "markerTag", "reportOnly", "checks", "focus", "eligibility", "lowRisk", "sensitive", "requiredChecks", "fixTrailer", "model", "depth", "roundCap", "gateCheck", "noAutomergeLabel"], "");
  const get = (k: string) => required(c, k, "");

  const focusRaw = object(get("focus"), "focus");
  only(focusRaw, LENSES, "focus.");
  const focus = Object.fromEntries(LENSES.map((l) => [l, text(required(focusRaw, l, "focus."), `focus.${l}`)])) as Record<Lens, string>;

  const eligRaw = object(get("eligibility"), "eligibility");
  const eligKeys = ["storedData", "interfaces", "alwaysNotLow"] as const;
  only(eligRaw, [...eligKeys], "eligibility.");
  const eligibility = Object.fromEntries(eligKeys.map((k) => [k, text(required(eligRaw, k, "eligibility."), `eligibility.${k}`)])) as RepoConfig["eligibility"];

  const reportOnly = get("reportOnly");
  if (typeof reportOnly !== "boolean") fail("reportOnly must be true or false");
  const requiredChecks = lines(get("requiredChecks"), "requiredChecks");
  const gateCheck = "gateCheck" in c ? line(c.gateCheck, "gateCheck") : DEFAULTS.gateCheck;
  // The gate waits for every required check, so requiring its own would leave it waiting forever.
  if (requiredChecks.includes(gateCheck)) fail(`requiredChecks can't include the gate's own check, ${gateCheck}`);
  // With no required checks the gate would approve and merge on the review alone.
  if (!reportOnly && !requiredChecks.length) fail("requiredChecks can't be empty unless reportOnly is on");

  const markerTag = text(get("markerTag"), "markerTag");
  // The tag goes into an HTML comment and a regular expression.
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(markerTag)) fail("markerTag must be lowercase letters, digits and single dashes");

  let depth = DEFAULTS.depth;
  if ("depth" in c) {
    const d = object(c.depth, "depth");
    only(d, ["finders", "voters", "votesToPost"], "depth.");
    // Each finder and voter is a full agent run, so the caps keep a typo from costing hundreds of runs per push.
    depth = { finders: count(required(d, "finders", "depth."), "depth.finders", 8), voters: count(required(d, "voters", "depth."), "depth.voters", 8), votesToPost: count(required(d, "votesToPost", "depth."), "depth.votesToPost", 8) };
    if (depth.votesToPost > depth.voters) fail("depth.votesToPost can't be more than depth.voters, or nothing is ever posted");
  }

  return {
    project: text(get("project"), "project"),
    botLogin: text(get("botLogin"), "botLogin"),
    markerTag,
    reportOnly: reportOnly as boolean,
    checks: text(get("checks"), "checks"),
    focus,
    eligibility,
    lowRisk: globs(get("lowRisk"), "lowRisk"),
    sensitive: globs(get("sensitive"), "sensitive"),
    requiredChecks,
    fixTrailer: line(get("fixTrailer"), "fixTrailer"),
    model: "model" in c ? text(c.model, "model") : DEFAULTS.model,
    depth,
    roundCap: "roundCap" in c ? count(c.roundCap, "roundCap", 20) : DEFAULTS.roundCap,
    gateCheck,
    noAutomergeLabel: "noAutomergeLabel" in c ? line(c.noAutomergeLabel, "noAutomergeLabel") : DEFAULTS.noAutomergeLabel,
  };
}

export function loadConfig(path: string): RepoConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`review config: can't read ${path}: ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`review config: ${path} is not valid JSON: ${(e as Error).message}`);
  }
  return parseConfig(json);
}

// "owner/name", or an error: a missing value must never fall back to some other repository.
export function repoFrom(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error("GITHUB_REPOSITORY must be set to owner/name");
  return value;
}

const matches = (globs: string[], path: string) => globs.some((g) => new Bun.Glob(g).match(path));

// Case-insensitive, so CLAUDE.md, Claude.md and claude.md all count.
export function sensitiveMatcher(c: RepoConfig) {
  const lower = [...ALWAYS_SENSITIVE, ...c.sensitive].map((g) => g.toLowerCase());
  return (path: string) => matches(lower, path.toLowerCase());
}

// Sensitive globs that no CODEOWNERS entry overlaps, so a person isn't asked to review them. It catches a renamed or
// forgotten path, not a partial match: cli/Cargo.* counts as covered by /cli/Cargo.toml alone.
export function codeownersGaps(c: RepoConfig, codeowners: string): string[] {
  const entries = codeowners
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split(/\s+/)[0].replace(/^\//, "").replace(/^\*\*\//, "").toLowerCase());
  return [...ALWAYS_SENSITIVE, ...c.sensitive].filter((g) => {
    const glob = new Bun.Glob(g.toLowerCase());
    return !entries.some((e) => (e.endsWith("/") ? glob.match(`${e}x`) : glob.match(e)));
  });
}

// --- The settings for this run ---------------------------------------------------------------------------------------

// In the workflows the repository's default branch is checked out into repo/, which sets this. Locally, run from the
// repository root.
export const CONFIG_PATH = process.env.REVIEW_CONFIG ?? ".github/review.json";
export const CONFIG = loadConfig(CONFIG_PATH);

export const MODEL = CONFIG.model;
export const REPORT_ONLY = CONFIG.reportOnly;
export const DEPTH = CONFIG.depth;
export const ROUND_CAP = CONFIG.roundCap;
export const LOW_RISK = CONFIG.lowRisk;
export const REQUIRED_CHECKS = CONFIG.requiredChecks;
export const FIX_TRAILER = CONFIG.fixTrailer;
export const GATE_CHECK = CONFIG.gateCheck;
export const NO_AUTOMERGE_LABEL = CONFIG.noAutomergeLabel;

// Parallel query() calls per process; each lens job is its own process.
export const concurrency = (raw: string | undefined) => (raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : 3);
export const CONCURRENCY = concurrency(process.env.REVIEW_CONCURRENCY);

export const MAX_TURNS = { finder: 60, voter: 30, isFixed: 20, eligibility: 30, fix: 150 };

// Read lazily, so loading the engine for tests or a config check needs no repository.
export const repo = () => repoFrom(process.env.GITHUB_REPOSITORY);
// Markers are only trusted on comments by this login, so nobody else can plant "already reported" or "reviewed" state.
export const BOT_LOGIN = process.env.REVIEW_BOT_LOGIN || CONFIG.botLogin;
// The PR head is checked out here; agents can't read anything outside it.
export const PR_DIR = process.env.REVIEW_PR_DIR ?? "pr";

export const isSensitive = sensitiveMatcher(CONFIG);
export const isLowRisk = (path: string) => matches(LOW_RISK, path);

// GitHub sends no patch for a binary file, a rename without changes, or a text diff too large to show. Only the last
// hides code from every agent, so such a change never rests on the model's verdict. Archives aren't listed here: their
// contents are hidden even when small.
const BINARY = ["**/*.{png,jpg,jpeg,gif,webp,avif,ico,woff,woff2,ttf,otf,pdf}"];
export const hidesDiff = (f: { filename: string; status: string; patch?: string; changes?: number }) =>
  !f.patch && !(f.status === "renamed" && f.changes === 0) && !matches(BINARY, f.filename.toLowerCase());

export type EligibilityVerdict = "low" | "not-low" | "errored" | "missing";

// The path rules win over the model: a sensitive path is never eligible, and the model can only escalate an allowlisted
// change. Code outside the allowlist needs the model's "low", and a diff no agent saw (hidden) can't get one.
export function eligibility(paths: string[], verdict: EligibilityVerdict, hidden: string[]): { eligible: boolean; reason: string } {
  const sensitive = paths.filter(isSensitive);
  if (sensitive.length) return { eligible: false, reason: `touches sensitive paths: ${sensitive.slice(0, 5).join(", ")}${sensitive.length > 5 ? ", …" : ""}` };
  if (paths.length === 0) return { eligible: false, reason: "no changed files" };
  if (verdict === "not-low") return { eligible: false, reason: "the eligibility check rated the change above low risk" };
  if (paths.every(isLowRisk)) return { eligible: true, reason: "only low-risk paths" };
  if (hidden.length) return { eligible: false, reason: `GitHub shows no diff for ${hidden.slice(0, 5).join(", ")}${hidden.length > 5 ? ", …" : ""}, so no review saw it` };
  if (verdict === "low") return { eligible: true, reason: "the eligibility check rated the change low risk" };
  return { eligible: false, reason: verdict === "errored" ? "the eligibility check errored" : "no eligibility check for this commit" };
}

// `REVIEW_CONFIG=path bun src/config.ts` checks a config (loading this module already did) and fails on sensitive paths
// that CODEOWNERS next to it doesn't cover.
if (import.meta.main) {
  const owners = Bun.file(CONFIG_PATH.replace(/review\.json$/, "CODEOWNERS"));
  const gaps = CONFIG_PATH.endsWith("review.json") && (await owners.exists()) ? codeownersGaps(CONFIG, await owners.text()) : [];
  for (const g of gaps) console.log(`::error::${g} is sensitive in ${CONFIG_PATH} but no CODEOWNERS entry next to it covers it`);
  if (gaps.length) process.exit(1);
  console.error(`${CONFIG_PATH}: ok`);
}
