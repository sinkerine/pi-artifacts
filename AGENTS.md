# Repository instructions

Use only Nix-supplied software, npm dependencies and browsers. Metadata-only `npm install --package-lock-only --ignore-scripts` is permitted when changing dependency metadata; never run npm install/ci, npx downloads or Playwright install to install software. Do not edit runtime .pi configuration, load live Pi/Paseo credentials, deploy, or activate services while testing.

Run E2E tests when a feature is first added, including repairs and reruns needed for that initial feature. Future pushes and deployments do not require rerunning E2E tests. Existing unit tests must still be run, including for future pushes and deployments.

For initial feature validation use the exact commands in [docs/testing.md](docs/testing.md): setup, discovery, lint, typecheck, all unit tests, build, integration, coverage, flake check, package build, then `nix develop --command node scripts/e2e.mjs --package .artifacts-checks/package --evidence .artifacts-checks/e2e`. Require every E1–E10/V1 assertion; this initial feature has no E2E exemption.

All test state, disposable HOME/XDG/Pi/session/store/browser/project directories, evidence and failures belong under ignored `.artifacts-checks/`. Use dynamic loopback ports. Never load live user configuration. Preserve failure evidence and exact rerun instructions. Stop only owned child processes and remove only owned transient test state after success. Review initial screenshots for clipped controls and unreadable content; no screenshot baseline exists.

Development checks share the orchestrator build lock: `flock /home/sinkerine/dev/pi-artifacts/.git/worktrees/feat-artifacts/e2e-feature-build.lock <command>`. Acquire it once, without nesting. Do not stage or commit unless separately instructed.
