# review

Automated pull request review for GitHub, shared by [ether](https://github.com/heyimada/ether) and [hanare](https://github.com/hanare-suite/hanare). Claude agents look for bugs and security problems, and a merge gate approves and auto-merges the changes that qualify. A `/fix` comment has an agent fix the open findings.

- **Review** (`actions/trust`, `actions/review`): a bugs pass, then a security pass. Each runs several independent finders, and a finding is posted only when enough voters agree it's real. Findings that are fixed later are resolved automatically.
- **Merge gate** (`actions/gate`): posts a "Review gate" check. The App approves and merges a change only when it qualifies: the author has write access, both reviews finished with no open findings, required CI passed, no sensitive path is touched, and the change is low-risk. Everything else needs a person.
- **Fix** (`actions/trust`, `actions/fix-edit`, `actions/fix-commit`): a `/fix` comment from a maintainer has an agent edit the open findings, and the App commits the patch. A person still has to approve that commit.

## How it stays safe

The engine ships as composite actions that run inside the reviewed repository's own jobs. Those jobs run on `pull_request_target`, `workflow_run` and `issue_comment`, so their workflow files come from the default branch, and they name the `review` or `fix` environment that holds the secrets:

- The engine is this repository at the commit the caller pinned in `uses:`; each action runs the engine from its own checkout (`github.action_path`).
- The secrets stay environment secrets, which can be limited to the default branch. Composite actions, unlike reusable workflows, work this way across account owners: GitHub never passes environment secrets to a reusable workflow another owner hosts.
- The settings are `.github/review.json` on the reviewed repository's default branch, never the pull request's copy.
- The pull request's code is checked out into `pr/` as data. It is never installed, built or run. The agents can only read files under `pr/` (`/fix` can also edit them), and a symlink anywhere there stops them.
- The agents never see the App token. Text they write is checked for tokens before it is posted.
- Agent instruction files (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.cursor/`, `.mcp.json`) and `.github/` are always sensitive, whatever the config lists.

## Adding it to a repository

1. **App.** Install the review GitHub App on the repository, with contents, pull requests and checks set to read and write.
2. **Environments.** Create a `review` environment holding the variable `REVIEW_APP_CLIENT_ID` and the secrets `REVIEW_APP_PRIVATE_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`. For `/fix`, also create a `fix` environment holding `FIX_CLAUDE_CODE_OAUTH_TOKEN`. Restrict both to the default branch.
3. **Config.** Add `.github/review.json`, starting from [examples/review.json](examples/review.json) or from ether's or hanare's config. `src/config.ts` documents every key. An unknown or missing key fails the run instead of being ignored. Start with `"reportOnly": true`.
4. **Workflows.** Copy [examples/workflows](examples/workflows) into `.github/workflows/`, and add the job in `ci-job.yml` to CI. Replace `ENGINE_SHA` with one full commit SHA of this repository everywhere. A Dependabot group on `heyimada/review*` keeps them together.
5. **CODEOWNERS.** List the sensitive paths in `.github/CODEOWNERS` too. The `Review config` check fails on a sensitive glob that no entry covers, and on any config error. A broken config on the default branch would stop every review.
6. **Branch protection.** Require the CI checks named in `requiredChecks` and allow auto-merge. Turn `reportOnly` off once the findings have proved useful.

One App can serve several owners, but its private key can then mint tokens for every installation. Anyone who can read one repository's `review` environment can act as the App on all of them, so use one App per owner when the maintainers differ.

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
