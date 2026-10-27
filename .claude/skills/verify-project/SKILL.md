---
name: verify-project
description: Verify the current changes in Signal Network by running the project's real tests, type checks, lint, build and (if configured) Playwright flows, then report exactly what passed, failed or could not run. Use before declaring work done.
---

# Verify project

Evidence before claims. A check counts as passed only if it ran in this session and exited successfully.

## 1. Inspect

- Review what changed: run `git status` and `git diff` (staged and unstaged), or the commits since the base branch.
- Find the real commands. Read `package.json` scripts (root and workspaces). Work out the package manager from the lockfile (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json` or `bun.lockb`). Also check the configs for the test runner, `tsconfig*.json`, the lint config and `playwright.config.*`. Don't assume any tool that isn't configured.
- If there is no project setup yet, say so and stop there. There is nothing to verify.

## 2. Run checks

Run each one that exists, scoped to the change first and then broader where that's cheap:

1. **Tests:** the tests related to the changed code, then the full unit suite.
2. **Type check:** for example, a `typecheck` script or `tsc --noEmit` against the project's tsconfig.
3. **Lint:** the project's lint script.
4. **Build:** the project's build script(s) for the client and server.
5. **Playwright:** only if it's configured. Run the specs that cover the affected user flows: signal and route setting, train movement, and multiplayer join/sync. If the app has to be started first, use the project's own dev/preview command.

Capture the real output of each command. If a check can't run (the tool isn't installed, the config is missing, or it needs a service or network), record the reason. Do not substitute another check for it.

## 3. Regressions and bugs

- For each failure, decide whether this change caused it or it was already there (compare against the base branch if you're unsure).
- For each bug this change introduced or touched, add a failing regression test first, then fix the code, then rerun.
- Don't weaken, skip or delete tests to get a green run.

## 4. Report

End with a table:

| Check      | Command           | Result                    | Notes                                       |
| ---------- | ----------------- | ------------------------- | ------------------------------------------- |
| Unit tests | `<exact command>` | passed / failed / not run | counts, failing tests, or why it didn't run |

Then list:

- regression tests added
- fixes made
- remaining failures, and any flows that were not verified
