# Isolated verification

Use Nix-only dependency setup. The committed flake.lock pins nixpkgs/Home Manager; package-lock.json pins npm tarballs. importNpmLock.buildNodeModules realizes the immutable dependency tree and the shell links node_modules to it. No npm ci/install, npx downloads, host browser installation or Playwright install is used. Metadata-only npm install --package-lock-only --ignore-scripts is allowed for lock changes. The package uses pinned Node 22 independently of the host version. Runtime Pi peers are external; dev/tests pin Pi 1.4.0. Playwright is 1.64.1 and Nix supplies Chromium/browsers/fonts; check-environment records actual executable/version and dependency identity.

Confirm `git branch --show-current` is feat/artifacts. Serialize development commands with `flock /home/sinkerine/dev/pi-artifacts/.git/worktrees/feat-artifacts/e2e-feature-build.lock <command>`, acquired once without nesting. In the initial untracked implementation review, use the explicit `path:.` flake reference (`nix develop path:.`, `nix flake check path:.`, `nix build path:.#default`) because Git flakes omit untracked files; do not stage files merely to run checks. After the flake is tracked the canonical commands are:

```sh
nix develop --command node scripts/check-environment.mjs
nix develop --command npm run test:discover
nix develop --command npm run lint
nix develop --command npm run typecheck
nix develop --command npm run test:unit
nix develop --command npm run build
nix develop --command npm run test:integration
nix develop --command npm run test:coverage
nix flake check --print-build-logs
nix build .#default --out-link .artifacts-checks/package --print-build-logs
nix develop --command node scripts/e2e.mjs --package .artifacts-checks/package --evidence .artifacts-checks/e2e
```

Discovery includes all Vitest unit/integration files and Playwright journey files and rejects missing U1–U10/I1–I9/E1–E10/V1 groups. Lint is read-only Biome plus documentation/config contract assertions. Typecheck uses the strict root tsconfig with allowJs/checkJs enabled: it includes service/browser/extension TypeScript, every scripts/**/*.mjs entry point, and all test TypeScript and .mjs files (including the browser journey, helpers and Playwright configuration). JSDoc describes JavaScript inputs and Pi event results; no JavaScript sources are excluded. Build bundles the service, external-peer extension and viewer into ignored dist/. Integration consumes that completed build; do not rewrite it during tests. Coverage executes exactly the same full U+I project selection and includes unexecuted production TS files, emitting text/JSON/HTML under coverage/. No percentage gate or baseline is invented: review named assertions and unexecuted behavior.

The Nix package and pure Home Manager checks cover disabled/enabled/extension-disabled/override configurations without activation. `nix flake check`'s package derivation can be reused by `nix build` for identical source/lock inputs; application E2E does not run inside Nix builds. No service is activated and no live profile is changed.

## Journey and evidence

Run E2E tests when a feature is first added, including repairs and reruns needed for that initial feature. Future pushes and deployments do not require rerunning E2E tests. Existing unit tests must still be run, including for future pushes and deployments.

The initial feature requires every E1–E10/V1 assertion. `scripts/e2e.mjs` accepts only an immutable /nix/store package and evidence beneath .artifacts-checks. It creates a unique run directory and records package/lock/source identities before and after. The real packaged service binds port 0. A loopback proxy exposes a distinct authority with /artifacts prefix, while Pi publishes to the internal URL. A local OpenAI-compatible fixture returns scripted tool calls to two provider/model identities. The real Pi CLI executes built-in write and the shipped extension; actual tool_execution_end/entry_appended events are saved. Fixtures never enter the shipped package and use no provider credentials.

Child HOME/XDG/Pi/session/store/work/browser/project paths are disposable. The environment helper allows only required tool/browser environment fields, excluding production PI_SESSION_*, PI_ARTIFACTS_CONFIG and PASEO_AGENT_ID/PASEO_HOME/PASEO_LISTEN. Each journey writes only its owned files. Projects A/B have before/after inventories; sources default outside them. Dynamic loopback listeners report actual addresses rather than probing fixed ports.

The journey asserts empty/missing states and /artifacts links (E1/E2), HTML interaction/source/styles/image (E3), Latest/pinned update and immutability (E4), React/ReactDOM/lucide/recharts/Tailwind/CSS/image with external browser requests blocked (E5), Markdown and safe Source (E6), restart/resume/real fork/restore and missed-event convergence (E7), failed tool/build/runtime/unavailable-service recovery (E8), second provider/project/session independence (E9), prefix/auth/token exclusion plus keyboard/responsive/theme controls (E10/V1). Integration complements this with deterministic concurrent commits, idempotency, ownership, branch/tree/clone/compaction and validation/failure cases.

I5 starts the built service CLI in disposable child processes and mocks FileHandle.sync at the real staging-file boundary, after Store has written source, preview or manifest bytes. Each injected EIO must return an HTTP failure, clean staging and preserve committed source/preview digests, revision count and Latest. A separate HTTP abort pauses an actual source flush; IPC confirms the server observed the disconnected client before the flush resumes. I6 pauses a real preview flush, verifies uncommitted source/preview files exist, refuses a second live owner, and SIGKILLs only that child. Restart on the same store must remove stale staging, preserve every committed digest/count and Latest, reacquire the process-scoped lock and publish successfully. The preload fixture exists only under tests/; production code has no fault switches. Child service logs and disposable state remain under .artifacts-checks/tests/.

I7 creates fresh SDK extension runtimes and ExtensionRunner instances against real new, resumed, cloned, forked and in-memory SessionManagers. Runner session_start/session_tree/session_shutdown dispatches exercise lifecycle handlers; list/get/publish execute with contexts created by each runner. Compaction and tree navigation preserve exact branch references. Resume and reload publish child revisions through fresh contexts; invalidated contexts fail and their old managers receive no further writes. HTTP and tool build-error assertions retain source-relative line/column/import/default-export guidance while rejecting server and Nix dependency paths.

Every step records expected/actual assertions and duration. Evidence includes Pi JSONL/diagnostics, service readiness/logs, sanitized config, model tool declarations/identities, source/preview SHA-256 manifests, browser console/network logs, project inventories, screenshot captures, Playwright report/trace and before/after package provenance. Test tokens stay in disposable store state and must never appear in captured output. Do not copy live credentials into evidence. Review initial screenshots manually for clipped controls/unreadable text and record findings. No baseline exists and no baseline comparison is claimed.

On failure the command exits nonzero, preserves state/logs and prints an exact rerun command. Reproduce once and preserve both attempts. Only the implementation worker edits code; a journey/review worker reports failures. After success stop only owned child processes and remove transient homes/browser state while retaining sanitized evidence. The runner's cleanup never touches live services or user state.

## Resource ordering

Setup rewrites the node_modules link and must finish first. Build rewrites dist and precedes integration/coverage consumers. Serialize U/I/CV to avoid shared Vitest output; CV writes coverage. N1/N2 share the package resource; N2 pins the immutable journey artifact. E2E may overlap coverage only after N2, using independent state. Default concurrency is at most two; final review runs with no active writers. Input changes invalidate affected receipts. Store command, exit status, discovery, source/lock/dependency hashes, build identity and tool versions alongside logs under .artifacts-checks. The orchestrator's independent gate receipts remain authoritative.
