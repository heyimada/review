// Every prompt the engine sends, for ether's config, pinned by a snapshot taken before the engine read its settings from a
// config file. Moving ether onto the shared engine must not change a word its agents see.
import { expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const prompts: { prompt: string; maxTurns: number; model: string }[] = [];
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: { prompt: string; options: { maxTurns: number; model: string } }) =>
    (async function* () {
      prompts.push({ prompt, maxTurns: options.maxTurns, model: options.model });
      yield { type: "result", subtype: "success", is_error: false, total_cost_usd: 0, structured_output: { findings: [], risk: "low", reason: "", fixed: false } };
    })(),
}));

const { classifyEligibility, isFixed, runFinder, runVoter } = await import("./agents");
const { fixPrompt } = await import("./fix");

const cwd = mkdtempSync(`${tmpdir()}/prompts-`);
const ctx = {
  pr: 7,
  title: "Add a thing",
  body: "It adds a thing.",
  diff: "--- src/a.ts (modified)\n@@ -1 +1 @@\n-a\n+b\n",
  sinceSha: null,
  prior: [{ fingerprint: "f1", file: "src/a.ts", lens: "correctness", title: "Old bug" }],
  cwd,
};
const finding = { file: "src/a.ts", line: 1, lens: "correctness" as const, severity: "important" as const, title: "Bug", failure: "It fails.", fingerprint: "f2" };

test("ether's prompts are unchanged", async () => {
  prompts.length = 0;
  await runFinder("bugs", ctx);
  await runFinder("security", { ...ctx, sinceSha: "b".repeat(40) });
  await runVoter(finding, [], ctx);
  await runVoter({ ...finding, suggestion: { endLine: 1, code: "c\n" } }, [{ ...finding, fingerprint: "f0" }], ctx);
  await isFixed({ file: "src/a.ts", line: 1, title: "Bug", failure: "It fails." }, cwd);
  await classifyEligibility(ctx);
  expect(prompts).toMatchSnapshot();
  expect(fixPrompt([{ fingerprint: "abc", file: "src/a.ts", line: 3, body: "x" }], "only this")).toMatchSnapshot();
});
