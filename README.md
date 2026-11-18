# review

Automated pull request review for GitHub, shared by [ether](https://github.com/heyimada/ether) and [hanare](https://github.com/hanare-suite/hanare). Claude agents look for bugs and security problems, and a merge gate approves and auto-merges the changes that qualify. A `/fix` comment has an agent fix the open findings.

- **Review** (`review.yml`): a bugs pass, then a security pass. Each runs several independent finders, and a finding is posted only when enough voters agree it's real. Findings that are fixed later are resolved automatically.
- **Merge gate** (`gate.yml`): posts a "Review gate" check. The App approves and merges a change only when it qualifies: the author has write access, both reviews finished with no open findings, required CI passed, no sensitive path is touched, and the change is low-risk. Everything else needs a person.
- **Fix** (`fix.yml`): a `/fix` comment from a maintainer has an agent edit the open findings, and the App commits the patch. A person still has to approve that commit.

## How it stays safe

The engine runs on `pull_request_target`, `workflow_run` and `issue_comment`. Each of these runs from the default branch, with secrets available:

- The engine is this repository at the commit the caller pinned in `uses:`. The reusable workflows read that commit from the job's OIDC token, so the workflow and the engine can't come from different commits.
- The settings are `.github/review.json` on the reviewed repository's default branch, never the pull request's copy.
- The pull request's code is checked out into `pr/` as data. It is never installed, built or run. The agents can only read files under `pr/` (`/fix` can also edit them), and a symlink anywhere there stops them.
- The agents never see the App token. Text they write is checked for tokens before it is posted.
- Agent instruction files (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.cursor/`, `.mcp.json`) and `.github/` are always sensitive, whatever the config lists.

## Adding it to a repository

1. **App.** Install the review GitHub App on the repository, with contents, pull requests and checks set to read and write.
2. **Environments.** Create a `review` environment holding the variable `REVIEW_APP_CLIENT_ID` and the secrets `REVIEW_APP_PRIVATE_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`. For `/fix`, also create a `fix` environment holding `FIX_CLAUDE_CODE_OAUTH_TOKEN`. Restrict both to the default branch.
3. **Config.** Add `.github/review.json`, starting from [examples/review.json](examples/review.json) or from ether's or hanare's config. `src/config.ts` documents every key. An unknown or missing key fails the run instead of being ignored. Start with `"reportOnly": true`.
4. **Workflows.** Add the callers for review, merge gate, review trigger and fix, as in [hanare's `.github/workflows`](https://github.com/hanare-suite/hanare/tree/main/.github/workflows). Pin `uses:` to a full commit SHA; Dependabot keeps it current.
5. **CODEOWNERS.** List the sensitive paths there too. The config check warns about any sensitive glob no CODEOWNERS entry covers.
6. **Branch protection.** Require the CI checks named in `requiredChecks` and allow auto-merge. Turn `reportOnly` off once the findings have proved useful.

The `pull_request_target` workflows only take effect once they are on the default branch, so the first pull request that adds them isn't reviewed by them.

## Development

```sh
bun install
bun run test        # unit tests, including a snapshot of every prompt for ether's config
bun run typecheck
REVIEW_CONFIG=path/to/review.json bun src/config.ts    # check a config and its CODEOWNERS
```

`e2e/dry-run.sh OWNER/REPO PR bugs|security|gate [CONFIG]` runs the engine against a real pull request without posting anything. It writes the result to `e2e/out/`. The review runs its agents on your own Claude login and reads GitHub with `gh auth token`.

A change that alters the prompts fails the snapshot test. Update the snapshot (`bun test --update-snapshots`) only when the prompt change is intended.
