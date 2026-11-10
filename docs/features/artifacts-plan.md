# pi-artifacts feature plan

Status: APPROVED by the user in the independent design tab through the explicit “Approve the plan” choice. Approval covers AC1–AC12, D1–D8, DOC1–DOC4, T1, the verification inventory and E2E journey, including adding AGENTS.md. No live deployment or external integration edits are authorized.

## Goal and acceptance criteria

Build model-independent, Claude-style artifacts for Pi: HTML/CSS/JavaScript, React/TSX, and Markdown, with a browser viewer, immutable saved revisions, source/preview switching, and live refresh after successful publication. Pi edits ordinary files, then explicitly publishes a snapshot. Ship reusable Nix packaging and a Home Manager service module. The initial repository contains only README.md; there are no existing tests or runner.

Worktree: `/home/sinkerine/.paseo/worktrees/1vv1duoi/feat-artifacts`; branch: `feat/artifacts` (recheck before use). Project: `pi-artifacts`, `prj_fdfa72a5310591b0`; workspace: `wks_4c41706e5aaaff55`. Main checkout: `/home/sinkerine/dev/pi-artifacts`. Base: `refs/heads/main`, `491fefb9827edcb53d528ab076dd78432e7f66fd`. Design edits only this plan, without implementation or commits. Implementation happens in this worktree through the existing orchestrator. No additional design orchestrator, worktree, or workers.

### Required decisions

- **D1 — No sandbox component.** No iframe sandbox attribute, microVM runtime/build isolation, container architecture, or sandbox requirements. Generated code runs as trusted browser content. A plain unsandboxed iframe may contain a preview document for layout. Disposable test state is required and is unrelated to product runtime isolation.
- **D2 — No Paseo plugin in v1.** Explicit user choice. Pi returns HTTP(S) viewer links. The user can open one in a Paseo desktop workspace browser and arrange it beside the conversation; ordinary browsers work too. No automatic tab opening, custom Paseo panel, timeline card, or live Paseo configuration edits. Web/mobile use ordinary links; native inline preview is outside v1.
- **D3 — Claude-like React library set.** Explicit user choice: `react`, `react-dom`, `lucide-react`, `recharts`, and Tailwind utility classes. Bundle imports at publication; copy a pinned `@tailwindcss/browser` runtime into each revision and load it locally. No mandatory CDN, package installation, or registry lookup during publication/viewing. No arbitrary dependency installation by generated projects.
- **D4 — Working files outside projects by default.** Explicit user choice: `${workDir}/${sessionId}/${artifact-name}/`, with `workDir` defaulting to `$XDG_STATE_HOME/pi-artifacts/work` (fallback `~/.local/state/pi-artifacts/work`). Supply this absolute directory in model-facing guidance. Existing project files may also be published. Do not create `.artifacts/` or modify another project's ignore/config files automatically.
- **D5 — Service and extension boundaries.** One TypeScript/Node service owns disk persistence, bundling, HTTP reads and publish writes. A Pi extension reads explicitly named source files and sends their bytes to that service. The extension never launches a daemon. The browser viewer is independent of Pi/model providers. One service process owns a data directory; a second owner fails clearly.
- **D6 — Revisions and branches.** Positive integer revisions are immutable within an artifact UUID. Each records an optional parent revision. The service's Latest view follows the most recently committed revision across sessions/branches. Pi list/get defaults follow references on its active conversation branch, not the global latest. Forks inherit references and publish new child revisions without rewriting their parent's references. Viewer labels Latest and pinned revision states explicitly.
- **D7 — Deployment/configuration.** Loopback bind defaults; separate internal service URL and client-reachable public URL. Public URL is an absolute HTTP(S) origin, optionally with a path prefix. Domain/TLS/access policy belong to the operator's proxy. Provide reusable integration and examples inside this repository; do not activate services, edit `/nixfiles`, change DNS/Traefik/firewall, install into a live Pi profile, or deploy.
- **D8 — Implementation/testing shape.** One T1 for the complete feature. Software and browser dependencies come through Nix. E2E runs when this feature is first added, including necessary repairs; future pushes/deployments do not require rerunning E2E; existing unit tests still run. Approval authorizes adding the AGENTS.md instructions specified below.

Ruling: use filesystem manifests and atomic revision-directory commits rather than a database — the initial single-writer service can reconstruct its small catalog from immutable directories — cost if wrong: introduce an indexed store later without changing the public contracts.

Ruling: the viewer's Latest view is global while Pi references are branch-relative — a stable shared preview link can refresh while resumed conversations keep their own source history — cost if wrong: a later branch-specific viewer channel may be needed; v1 must clearly expose pinned links now.

### Acceptance criteria and exact evidence

Evidence IDs refer to the commands and test/journey IDs below. Each row's behavior applies to all entry paths/variants named in that row. Literal wording governs acceptance; screenshots alone do not prove interaction, persistence, or isolation.

| ID | Observable behavior and covered entry paths | Required evidence |
| --- | --- | --- |
| AC1 | In real Pi, a model can write files and call `artifact_publish`, `artifact_list`, and `artifact_get` with the documented schemas. The extension works without provider-specific APIs in TUI, RPC, JSON, and print modes; none requires a terminal dialog. Registration does not start processes/timers/sockets. | U1; I1 (real Pi SDK/tool registration, all four mode contexts); E1–E3 (actual Pi CLI, built-in write and published tool results); E9 (second fixture provider/model). |
| AC2 | HTML renders its supplied HTML/CSS/JS and local image asset; React mounts a default-exported component and responds to interaction using React, lucide-react, recharts, and Tailwind; Markdown renders headings, lists, fenced code, and relative images. Each kind's published preview renders with external network requests blocked. | U2; I2; E3, E5, E6 with DOM assertions, interaction assertions, network log, and screenshots. |
| AC3 | Publishing the same artifact creates a new immutable complete snapshot. Editing/deleting working files after publication cannot alter any saved source/preview bytes. An explicitly selected old revision remains unchanged after new publications and service restart. Source/Preview switching and per-file source selection show the selected revision's original files; binary files show metadata/download rather than text corruption. | U3; I3; E4, E7. Compare SHA-256 of all saved source and preview files before/after mutations and restart; every compared digest must match. |
| AC4 | A viewer already following Latest refreshes automatically after a successful publish, retaining its selected Source/Preview mode. A pinned old revision stays pinned and shows a newer-revision indication. Disconnect/reconnect and service restart recover by fetching current state even when events were missed. | U4; I4; E4, E7. Publish-to-visible update within 5 seconds on loopback after successful response; reconnect convergence within 10 seconds after service health returns. |
| AC5 | A missing/unreadable file, path escape/symlink, unsupported kind/import, missing React default export, TSX build error, oversized input, abort before commit, disk write failure, or unavailable service returns an actionable failed tool result. No partial revision becomes visible; the previous successful revision and Latest preview remain intact. A runtime JS exception is visible in the preview with a reload action. | U5; I5 fault injection; E8 browser/runtime and real Pi failed publish. Previous revision count and saved digests are unchanged for each pre-commit failure. |
| AC6 | Simultaneous clients publishing one artifact receive distinct monotonically increasing revision numbers; each committed revision contains exactly its own source set and parent, never a mixed set. Restart after an interrupted staging write ignores that staging directory and retains committed revisions. A second service cannot own the same data directory; stopping the first permits a new owner. | U6; I6 (two HTTP clients, process restart/staging/ownership tests). |
| AC7 | Resume, conversation tree navigation, compaction, fork, and clone reconstruct references only from the active Pi branch. Default list/get returns that branch's referenced revision even when another branch has a newer global revision. Explicit get can read any committed revision of a referenced artifact. A new unrelated session starts with an empty list. In-memory sessions work during their lifetime without claiming resumability. | U7; I7 with real SessionManager tree/fork/clone/compaction entries and lifecycle events; E7, E9. |
| AC8 | `artifact_get` can restore any referenced revision into a new working directory, preserving all source file bytes. Existing destinations are rejected without writes. Publication from restored files creates a child revision. Default working files remain outside project A and project B and do not change their tracked/untracked files. | U8; I8; E7, E9. Exact source digest equality and before/after project inventories, excluding only the separately configured test evidence/state roots. |
| AC9 | The gallery lists committed artifacts and revisions and provides usable empty, missing-artifact/revision, disconnected, loading, and error states. Viewer navigation, Source/Preview switching, revision selection, and reload work with keyboard controls at 1440×900 and 390×844 in light/dark appearances. Source text renders as text. | U9; E2–E8; V1 accessibility/interaction assertions and screenshots at both viewports and appearances. No screenshot baseline exists; inspect initial captures and record findings, without claiming a baseline comparison. |
| AC10 | Internal publishing works at a configured service URL while every returned viewer/download/asset/SSE URL respects a different configured public origin and optional prefix. No URL is hardcoded to kazuki or its domain. Defaults bind only to `127.0.0.1`. Missing/invalid configuration, occupied ports and unavailable token files produce clear diagnostics. Requests without the publish token cannot write; tokens never occur in HTML, links, source responses, or logs. | U10; I9 using a loopback proxy with a distinct public authority and `/artifacts` prefix; E10; N1. |
| AC11 | The Nix package runs the service and exposes the Pi extension and viewer assets; the Home Manager module generates configuration and a user service with configurable package, bind/port, URLs, data/work paths, and optional extension enablement. Pure evaluation verifies option overrides and disabled behavior. A package launched with disposable state serves and publishes all three kinds. No live activation is performed. | N1 (`nix flake check`); N2 (`nix build`); E1–E10 using the packaged service/extension. |
| AC12 | Documentation DOC1–DOC4 accurately explains the shipped behavior, APIs, revision/branch semantics, trusted-code/no-sandbox constraint, library set, operating/deployment options, and exact first-add E2E recipe. The repository contains AGENTS.md with the required future-push/deployment exemption and unit-test requirement. | C1 doc-contract assertions; consolidated review trace for DOC1–DOC4 and D1–D8; all documented verification commands execute successfully. |

### Required documentation

- **DOC1 — README.md:** purpose, quickstart through Nix, running the service, loading the extension, a file→publish→preview example for each kind, ordinary browser/Paseo desktop opening, links to detailed docs.
- **DOC2 — docs/artifacts.md:** exact tools/command/API contracts; working-directory conventions; explicit file list; default React export; bundled versions/allowed imports; source/restore semantics; failed publication and runtime-error recovery; Latest versus pinned revisions; active branch/resume/fork/clone/compaction behavior; backup and no automatic deletion.
- **DOC3 — docs/deployment.md + examples/:** all configuration fields and defaults, internal vs public URL, subpath proxy rules/SSE buffering, token provisioning, trusted browser content and operator-controlled access, Home Manager example, plain foreground service example, generic Traefik example. Explain remote clients need a reachable public URL; client `localhost` is not the remote host. Document service upgrades, data schema version, and unsupported multi-writer/network-filesystem operation. No deployment-specific activation changes.
- **DOC4 — AGENTS.md + docs/testing.md:** Nix-only dependency setup, exact test commands, isolated E2E state/resources/evidence/cleanup recipe, discovery and coverage, first-add E2E timing and future-push/deployment exemption. AGENTS.md must state: “Run E2E tests when a feature is first added, including repairs and reruns needed for that initial feature. Future pushes and deployments do not require rerunning E2E tests. Existing unit tests must still be run, including for future pushes and deployments.” No E2E exemption for this initial feature.

## Design

### Boundaries and flow

1. `extensions/artifacts.ts` registers the tools and `/artifacts` command. Its model-facing guidance identifies the current session's absolute work directory, the three kinds, supported imports, and the explicit publish workflow. Session hooks rebuild references on startup/tree changes; do not parse all entries as one linear history.
2. Pi's ordinary write/edit tools create source files. Publish reads the exact named set once into bounded memory, validates it, and uploads those captured bytes. No source watchers and no refresh on unpublished edits.
3. `src/service/` validates requests, serializes commits per artifact, builds from captured inputs, writes a complete staging directory, and atomically renames it into a committed revision directory. Commit precedes response/event emission.
4. `src/build/` copies HTML/static inputs, bundles React and allowed dependencies using esbuild, and renders Markdown. `@tailwindcss/browser` is pinned and copied locally. Builds run in the service process/ordinary child tooling without adding runtime/build isolation architecture. Build tools read only the captured virtual source map and packaged approved libraries, never arbitrary project dependencies or project scripts.
5. `src/viewer/` is a small bundled browser UI: gallery, title/kind, Latest/revision selector, Source/Preview switch, file list, original source, download, and a normal unsandboxed iframe for preview layout. The frame is recreated only for successful selected-revision changes or explicit Reload. The shell receives service events through SSE; it never includes the publishing token.
6. `nix/` and `flake.nix` package the application and expose a Home Manager module. Product state lives outside the Nix store. This repository provides integration; activation remains a separate operation.

### Tool contracts

Export shared TypeScript types and corresponding TypeBox/runtime schemas. IDs are UUID strings; revision numbers are positive integers. Successful results include `content` text with clickable URLs, `details`, `structuredContent`, and a matching `outputSchema`. Failed operations throw an actionable error or set `isError: true`; an error string in a successful result is insufficient.

```ts
type ArtifactKind = 'html' | 'react' | 'markdown';
type ArtifactRef = { id: string; revision: number };
type SourceFileInfo = {
  path: string; bytes: number; sha256: string; mediaType: string;
};
type ArtifactRevision = ArtifactRef & {
  schemaVersion: 1; title: string; kind: ArtifactKind;
  parentRevision: number | null; createdAt: string; entrypoint: string;
  files: SourceFileInfo[];
  previewUrl: string; // /a/<id>, follows global Latest
  revisionUrl: string; // /a/<id>?revision=<n>, pinned
};

type PublishInput = {
  id?: string;
  title: string;
  kind: ArtifactKind;
  entrypoint: string;
  files: string[];
};
artifact_publish(input: PublishInput): Promise<ArtifactRevision>;
artifact_list(input: {}): Promise<{ artifacts: ArtifactRevision[] }>;
artifact_get(input: {
  id: string; revision?: number; restoreTo?: string;
}): Promise<{
  artifact: ArtifactRevision;
  sources: Array<SourceFileInfo & { text?: string }>;
  sourceTextTruncated: boolean;
  restoredTo?: string;
}>;
```

Publication path rules: entrypoint and file paths resolve against `ctx.cwd` when relative; absolute paths are allowed. The source root is the entrypoint's parent directory. Every named file must be an ordinary file within that root, entrypoint must be included, duplicate normalized paths and symlinks are rejected. The saved paths are POSIX paths relative to that root. No globs or directory recursion. Static/CSS/JS/image inputs and local imports must be explicitly included. React local imports outside that set fail clearly. Document relative asset URLs; no promise to rewrite arbitrary root-absolute application routing.

Default limits: 100 files, 10 MiB decoded total, 2 MiB per file, title 1–200 characters, build deadline 30 seconds. Expose these as service configuration. Snapshotting captures each file once; it is not an atomic transaction with unrelated concurrent edits to the working tree. Once captured, uploads/builds never reread working files.

For a new artifact omit id; the service assigns a UUID and revision 1. For an update id must already be referenced on the current Pi branch; kind cannot change. The extension supplies `parentRevision` internally from that branch's current ref. Service revision numbering is global and monotonic; parent is allowed to be older than Latest. Title may change per revision. No deletion/rename of saved revision bytes and no automatic retention/GC.

`artifact_list` lists active-branch references, newest reference first, with their exact saved metadata; it does not substitute global Latest. `artifact_get` defaults to the branch ref, validates an explicitly requested revision belongs to that artifact, returns original text up to 64 KiB total with an explicit truncation flag, and returns binary file metadata without binary text. The `revisionUrl` and file endpoints expose the full original bytes. With `restoreTo`, create a previously nonexistent destination atomically from temporary state; never overwrite or partially fill an existing destination. Relative restoreTo resolves against cwd. Restoring does not publish or change refs.

`/artifacts [id]` prints a gallery link or the pinned link for a branch-referenced artifact. It uses a visible Pi message without triggering an agent turn, works in non-TUI modes, and never runs a browser opener on the server. Publish/get/list remain usable in headless contexts. Publish executes sequentially within Pi; server-side serialization also handles other clients. Cancellation before commit removes staging. Cancellation/connection loss after commit cannot undo the published revision; document that the gallery may contain a committed revision whose response/reference was interrupted.

### Pi persistence

On successful publish append `pi-artifacts.ref.v1` with `{ id, revision }` through `pi.appendEntry`, then return the same ref in result details for recovery if a runtime/session boundary interrupts finalization. Reconstruct by walking `ctx.sessionManager.getBranch()` in order and reducing successful reference entries/tool results to one ref per id; deduplicate equal refs. Never rebuild from `getEntries()` across abandoned branches. Use custom refs as primary, tool details as fallback, preserving branch order. List/get do not implicitly advance refs. Compaction does not discard raw custom entries; the full branch remains authoritative. Pi's real fork/clone operations copy the relevant branch entries, so no parent session file traversal is necessary.

Session start/tree handlers refresh model guidance and ref state. Do not retain ExtensionContext across runtime replacement or use stale contexts after reload/new/resume. No long-lived resources in the extension factory. Service restart does not require Pi restart. Missing saved data yields an unavailable-ref diagnostic, not silent removal. An in-memory Pi session keeps normal refs during its lifetime but cannot resume later.

### Service interfaces and storage

```ts
type CapturedSource = { path: string; base64: string };
type PublishRequest = {
  requestId: string; id?: string; title: string; kind: ArtifactKind;
  entrypoint: string; files: CapturedSource[];
  parentRevision: number | null;
};
type ServiceOptions = { configPath?: string };
startService(options: ServiceOptions): Promise<{
  address: string; close(): Promise<void>;
}>;
```

All HTTP routes are mounted beneath the public URL's configured path prefix; serviceUrl contains the matching prefix. JSON is UTF-8, dates ISO 8601, error envelopes `{ error: { code, message } }`. GET source/download responses use correct media types and explicit binary downloads; UI source code is always escaped text. Reject decoded path escapes and malformed IDs/revisions.

| Method and path (after prefix) | Contract |
| --- | --- |
| `GET /health` | `{ status: 'ok', schemaVersion: 1 }`, only ready after store scan/ownership acquisition. |
| `POST /api/artifacts/publish` | Bearer token required; PublishRequest → ArtifactRevision. A requestId is idempotent: repeating identical input returns its original revision; reusing it with different content is a conflict. |
| `GET /api/artifacts` | `{ artifacts: ArtifactRevision[] }`, each global Latest. |
| `GET /api/artifacts/:id` | `{ revisions: ArtifactRevision[] }`, ascending revision order. |
| `GET /api/artifacts/:id/revisions/:n` | ArtifactRevision. |
| `GET /api/artifacts/:id/revisions/:n/source/*path` | Original saved file bytes. |
| `GET /preview/:id/:n/*path` | Saved preview assets/document for that immutable revision. |
| `GET /api/events` | SSE `published` events `{ id, revision }`, heartbeat, initial `ready` event; client always reconciles catalog after connect/reconnect. |
| `GET /`, `GET /a/:id` | Gallery/viewer shell; `?revision=n` selects pinned mode, otherwise Latest. |

HTTP errors: 400 invalid input, 401 absent/wrong write token, 404 missing artifact/revision/file, 409 idempotency conflict/kind change, 413 limits, 422 build/import/default-export error, 503 unavailable store/build deadline. Unexpected I/O errors return 500 and a concise diagnostic; no filesystem paths/credentials in browser messages. Publish retries use the same requestId and body; the extension may retry a transport failure once, then reports uncertainty and the gallery link. No unbounded retries. No browser-callable write secret, npm commands, shell scripts, or arbitrary filesystem paths in publication requests.

Storage layout:

```text
<dataDir>/
  publish-token                    # generated once, mode 0600 unless operator supplies tokenFile
  .owner.lock                      # process-scoped ownership, released on exit/crash
  artifacts/<uuid>/revisions/<n>/
    manifest.json                  # schema, id, parent, requestId/input digest, source/build digests
    source/<relative-path>         # exact original bytes
    preview/<relative-path>        # self-contained generated/captured preview and local runtime
  staging/<request-id>/             # invisible until atomic commit
```

The implementation may use an OS-backed advisory ownership lock supported by the Nix package or equivalent process-scoped exclusivity with crash recovery; do not use an unrecoverable stale PID file. Serialize each artifact's allocate→build→commit operation, and serialize new-id request-id lookup/commit to prevent retry races. Scan only complete committed manifests; a malformed committed manifest reports an integrity error for that artifact and never invents data. Startup ignores/removes stale staging owned by no live publisher. Flush captured files/manifest before atomic rename and persist the directory rename where supported. Latest/catalog and idempotency indexes are reconstructed from manifests; they are not independent mutable authorities. Local POSIX storage is the supported target.

React entries default-export a component; the generated wrapper mounts it into `#root`. Bundle React dependencies into the saved revision (including JSX runtime); support local JS/TS/JSX/TSX/CSS imports and explicitly supplied image assets. Bare imports are limited to the named packages and their documented public subpaths, including `react/jsx-runtime`, `react-dom/client`, and `react-dom`. Clear unsupported-import error names the allowed set. The saved build does not depend on current library versions after restart/upgrade. HTML inputs are served with their supplied relative assets; Markdown is rendered with a packaged renderer and local style. Load a small preview error/reload UI before generated scripts so uncaught errors/rejections are visible; React also has an error boundary. This is runtime feedback, not a sandbox.

### Viewer behavior

A compact toolbar contains title, kind, Latest/revision selector, Source/Preview controls, and Open/download links. Source mode has a file list and read-only escaped text; binary sources have file size/type and a download action. Source is not an editor. Latest reloads to the exact committed preview URL after an SSE update; a selected old revision does not reload and instead offers “New revision available / View latest.” An update preserves mode; if a selected source file disappeared, choose entrypoint and indicate the change. No split conversation clone is built into the viewer.

SSE reconnection uses bounded backoff; reconnect fetches current metadata, so missed events need no durable event log. Show reconnecting/offline state while preserving the last rendered preview; reconcile automatically after service health returns. Pinned revision URLs remain shareable as long as data exists. Persist appearance using system preference and browser storage if needed; browser layout uses accessible native controls and responsive CSS. Do not include implementation diagnostics in normal product flows beyond actionable error messages.

### Configuration and integration

One JSON config file defaults to `$XDG_CONFIG_HOME/pi-artifacts/config.json` (fallback `~/.config/pi-artifacts/config.json`). `PI_ARTIFACTS_CONFIG` selects another path for both extension and service; `pi-artifacts serve --config <path>` overrides it for the service. Precedence: explicit service CLI config path → environment config path → default path; file values → documented defaults. Reject unknown/malformed fields. No hidden host/domain inference.

| Field | Default and meaning |
| --- | --- |
| `schemaVersion` | `1`. |
| `bindAddress` | `127.0.0.1`; explicit `0.0.0.0`/IPv6 only when configured. |
| `port` | `4317`; test configuration allows `0` with actual URL in ready JSON. |
| `publicUrl` | `http://127.0.0.1:4317`; absolute client URL, optional prefix, normalized trailing slash. |
| `serviceUrl` | Derived loopback address/port/prefix for default local use; explicit for an alternate control endpoint. Extension uses this URL, never publicUrl to infer remote localhost. |
| `dataDir` | `$XDG_DATA_HOME/pi-artifacts` or `~/.local/share/pi-artifacts`. |
| `workDir` | `$XDG_STATE_HOME/pi-artifacts/work` or `~/.local/state/pi-artifacts/work`. |
| `tokenFile` | `<dataDir>/publish-token`; generated by service on first start with mode 0600, then reused. Extension reads it on publication; never reads it for browser UI. |
| `limits` | `{ maxFiles: 100, maxTotalBytes: 10485760, maxFileBytes: 2097152, buildTimeoutMs: 30000 }`. |

`pi-artifacts serve` logs one machine-readable ready record to stdout with its bound internal URL and publicUrl; diagnostics go to stderr. On SIGTERM/SIGINT stop accepting new work, finish or cancel pre-commit work, close SSE/connections, and release ownership. An occupied port or invalid configuration exits nonzero. Read-only public endpoints expose published artifacts to whoever can reach the service; use the configured gateway/access policy for private deployment. The publishing token prevents browser content/other unauthenticated clients from modifying the catalog; it is not a reader login system.

Flake outputs: `packages.<system>.default` (service, viewer, extension and runtime libraries), `devShells.<system>.default`, `homeManagerModules.default`, and `checks.<system>` for package/config/module evaluation. Support `x86_64-linux` initially; document other systems as unverified rather than promising them.

Home Manager options under `services.pi-artifacts`: `enable`, `package`, `bindAddress`, `port`, `publicUrl`, `serviceUrl`, `dataDir`, `workDir`, `tokenFile`, `limits`, `enablePiExtension` (default false). Generate config, install package and a `systemd.user.services.pi-artifacts` unit with restart-on-failure. If explicitly enabled, link only this extension under `~/.pi/agent/extensions/pi-artifacts/`; do not own/rewrite Pi settings.json or an unrelated extension path. Both service and extension discover the same generated config. Module evaluation verifies all overrides, disabled state and command paths. Generated state/token files remain writable outside the Nix store.

Include examples of loopback + reverse proxy and foreground bind without a proxy. The generic Traefik example uses configurable hostname/backend/prefix and preserves SSE without response buffering. Do not hardcode the discovered `paeso.kazuki.m.mado.moe` or change the existing Paseo router. Explain activation as an operator step outside this implementation.

## Tasks

### Wave 1: T1 — Deliver complete pi-artifacts feature

- **Goal:** implement AC1–AC12, D1–D8, DOC1–DOC4 in one coherent change including tools, persistence, bundling, viewer, configuration, packaging, docs, and all tests/wiring.
- **Owned files:** all new/changed feature files inside this worktree: README.md, AGENTS.md, package.json/package-lock.json, TypeScript/build/lint/test configs, flake.nix/flake.lock, `.gitignore`, `extensions/`, `src/{shared,service,build,viewer}/`, `nix/`, `examples/`, `scripts/`, `tests/{unit,integration,e2e,fixtures}/`, docs/artifacts.md, docs/deployment.md, docs/testing.md. The approved plan is consumed as the contract; consequential changes to it return to design. Do not edit worktree runtime `.pi` settings or files outside the worktree.
- **Consumes:** Pi ExtensionAPI/session contracts from installed Pi 1.4.0; Node 22/24; esbuild and approved rendering packages; Nix/Home Manager APIs. No upstream producer task or Paseo plugin API dependency.
- **Produces:** the exact tools and service routes above; packaged `pi-artifacts serve`; browser viewer; Pi package/extension entry; reusable HM module and examples; deterministic tests and isolated journey runner with evidence.
- **Dependencies:** none. One writer, no task fanout, no split justification needed. Build/runtime/test outputs share resource groups and serialize as described below.
- **Unit gate:** `nix develop --command npm run test:unit` (all discovered unit tests, not an individual subset).
- **Other required checks:** C1, C2, I, N1, N2, E, V1 below before acceptance/delivery.
- **Review:** consolidated complete-feature review after implementation, including trace of every AC/D/DOC. No early focused review gate: the known API/version constraints are settled and there is no external producer interface.

External dependencies: pinned Nix inputs and registry dependency tarballs must be available during Nix dependency realization; no production model credentials or live services are required by the automated journey. A controlled local model fixture drives the real Pi runtime. Browser binaries/fonts come from Nix. All feature code/docs can be written before dependency realization, but no gate is accepted without running it. Infrastructure failures are reported with the exact error; do not substitute a live deployment or claim unrun evidence.

## Test and verification

### Discovery and prerequisites

Observed at design: only README.md; no AGENTS.md, package manifest, tests, runner, lint/types/build/coverage or screenshot baselines. Installed Node `v24.21.0`, Nix `2.34.9`, Pi `1.4.0`, Paseo `0.15.3`. Chromium is not on PATH. There is no existing suite to remove or narrow. T1 establishes the commands below as repository contracts. All new test projects must be included in discovery and full verification.

Use a committed flake.lock. Suggested initial nixpkgs revision `1c89083e451e891152365b799595cf7790a43325` (the observed host's nixos-unstable input); pin Home Manager to a compatible commit during implementation. Obtain Node, Chromium/Playwright browsers, fonts, shell utilities, and project npm dependency trees through Nix. Use `importNpmLock.buildNodeModules`/`linkNodeModulesHook` or a proven equivalent Nix derivation; the dev shell links a Nix-built dependency tree without npm install. Metadata-only `npm install --package-lock-only --ignore-scripts` may create/update lock metadata during initial implementation; it must not install software/node_modules. Do not use `npm ci`, `npx` downloads, Playwright install, apt, or global npm installs on the host. Nix's normal package builds are packaging, not a new product runtime isolation component.

Pin Pi test/dev package `@earendil-works/pi-coding-agent@1.4.0`, host-provided peers and TypeBox appropriately; runtime extension must use the host's instances, not bundle Pi. Pin esbuild, React/ReactDOM, lucide-react, recharts, @tailwindcss/browser, Markdown renderer, Vitest/v8 coverage, TypeScript, Biome and Playwright in package-lock.json. React/ReactDOM versions must match. Match npm Playwright to the pinned Nix driver/browsers (observed candidate `1.64.1`). The dev shell sets `PLAYWRIGHT_BROWSERS_PATH` and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`; the runner verifies the actual Chromium executable/version. Dev shell includes Node 22 and tooling; the built package runs with its pinned Node, independently of the host Node 24.

### Exact check inventory

Run commands from the verified feature worktree, checking `git branch --show-current` equals `feat/artifacts`. The shell hook may link node_modules; run initial dev-shell setup before concurrent checks. Package scripts must exist exactly as named below, with runner exit status propagated and no silent skipping. Resolve bootstrap Nix fetch hashes while implementing; final verification must not rewrite lockfiles.

```sh
# Setup/discovery; resolves Nix dependencies and links the immutable node_modules tree.
nix develop --command node scripts/check-environment.mjs
nix develop --command npm run test:discover

# C1: formatting/lint and required doc/config contract assertions, no rewrites.
nix develop --command npm run lint

# C2: types for service, browser, extension, scripts and tests.
nix develop --command npm run typecheck

# U: all unit tests (T1 independent host gate).
nix develop --command npm run test:unit

# B: compile/bundle application, extension and browser output into dist/.
nix develop --command npm run build

# I: deterministic integration project, including real Pi/session and service processes.
nix develop --command npm run test:integration

# CV: all U and I tests with V8 coverage; exact same discovered assertions as U + I.
nix develop --command npm run test:coverage

# N1: pure flake/module/config tests and package/config evaluation; no activation.
nix flake check --print-build-logs

# N2: final immutable package for smoke/E2E and recorded Nix output identity.
nix build .#default --out-link .artifacts-checks/package --print-build-logs

# E + V1: isolated packaged user journey, screenshots and browser interactions.
nix develop --command node scripts/e2e.mjs --package .artifacts-checks/package --evidence .artifacts-checks/e2e
```

`test:discover` lists Vitest unit and integration projects and Playwright journey files; fail if any required project or expected U/I/E group is empty. `test:coverage` uses the same unit/integration project selection with all production TypeScript source included, including unexecuted files, and emits text+JSON+HTML under coverage/. There is no arbitrary coverage percentage or baseline claim; require all named behavior assertions and record uncovered behavior for review. A valid coverage receipt can satisfy U and I only when discovery, assertions, relevant inputs, dependency/environment identities and generated build inputs match exactly. E2E is additional and cannot replace U/I. `lint` includes Biome read-only checks and a doc-contract check asserting the required AGENTS wording/tool/config examples; full documentary accuracy is reviewed, not reduced to string tests.

`nix flake check` must include pure Home Manager module evaluation checks (without home-manager switch), disabled/enabled/extension-disabled/options-overridden cases, generated configuration validation and package executable paths. Do not recursively build the whole test suite inside both N1 and CV without need; document equivalent/reused package checks. Package check and N2 receipts may be reused for the identical derivation output. No application E2E is required inside a Nix build. The immutable N2 output is the pinned journey artifact; resolve its store path, save a manifest with output path + source/lock identity, and verify it before and after the journey.

### Required deterministic test groups

- **U1:** extension registration/schema/output contracts, mode-independent behavior and lifecycle initialization/cleanup.
- **U2:** three kind wrappers/rendering, allowed import resolution and snapshot-only local dependencies.
- **U3:** manifests/source byte preservation, source text/binary response semantics and immutable URLs.
- **U4:** viewer Latest/pinned transition reducer, retained Source/Preview mode and reconnect reconciliation.
- **U5:** validation/error code mapping, cancellation/deadlines and build/runtime error presentation.
- **U6:** revision allocation/idempotency/serialization and staging visibility.
- **U7:** active-branch reduction, duplicate custom/tool refs, compaction, missing refs and ephemeral sessions.
- **U8:** restore path validation, nonexistent-destination requirement and byte-preserving restoration.
- **U9:** viewer navigation/source selection/missing/empty/error states and safe text rendering.
- **U10:** config precedence/defaults, URL prefix generation and token exclusion from outputs.
- **I1:** load the actual extension in a real Pi SDK runtime, inspect tools/commands, invoke its registered handlers with realistic mode contexts. No alternate production test hook/tool implementation.
- **I2–I3:** real HTTP publish/build/read all kinds; original sources and preview digest comparisons after working-file mutation/deletion; binary round trip; cross-restart old revision reads.
- **I4:** real SSE connects, publish, disconnect/missed event/reconnect and current catalog reconciliation.
- **I5:** each AC5 failure injected before commit, including invalid encoding, missing file/import/default export, oversized body, abort and mocked failing filesystem boundary. Assert previous revision count/digests unchanged. Actual filesystem failure injected in a disposable store; never chmod the real data dir.
- **I6:** two concurrent HTTP clients and repeated requestIds; distinct contiguous commits/parents/payloads; conflict for changed duplicate input; interrupted staging process restart; double-owner refusal and post-exit recovery.
- **I7:** real Pi SessionManager branching/fork/clone, session-tree hook and compaction replay. Create sibling branches where the globally newest revision differs; assert branch-local list/get. Exercise new/resume runtime replacement and no stale context usage.
- **I8:** full restore/publish round trip and rejecting existing nonempty/empty destinations without mutation; two unrelated project directories remain unchanged.
- **I9:** real loopback reverse proxy representing a different public authority and `/artifacts` prefix; test shell, API, source/download, iframe assets and SSE routes; unauthorized writes/config errors/occupied ports/token absence; inspect all returned output for secret leakage.

### Generated inputs, outputs and resource rules

`.gitignore` excludes node_modules/, dist/, coverage/, `.artifacts-checks/`, test-results/, playwright-report/ and result symlinks. Tests create their own fixture inputs; never depend on the user's artifacts, sessions, credentials, browser profile, live ports or project files. Root only generated evidence/state under the worktree's `.artifacts-checks/`, or harness-owned disposable subdirectories there. Do not repurpose HOME in the agent shell; each subprocess gets an explicit environment object with its own HOME/XDG/Pi configuration paths. Filter inherited PASEO_AGENT_ID/PASEO_HOME/PASEO_LISTEN, PI_SESSION_* and production configuration from child environments.

Build B rewrites dist/; setup can rewrite the node_modules link; lock metadata generation rewrites package-lock.json; N2 rewrites the output symlink. CV writes coverage/, E writes its unique evidence and browser state; other checks are read-only outside their own test state. Save exact commands, input source/lock hashes, test discovery, generated dist identity, tool versions and exit codes with verification receipts. No check may run against a half-written dist/ or updated dependency link.

Use the orchestrator's build lock for unknown/development commands. Resource groups: `deps` (flake/package lock/node_modules setup), `dist` (B writes, I/CV consume), `coverage` (CV), `nix-package` (N1/N2), `e2e` (E state/evidence/ports/browser). Default maximum concurrency 2. Serialize setup and B before consumers; serialize U/I/CV if they share Vitest caches/output. C1 and C2 may run together after setup if outputs are separate. After N2 is pinned, E may overlap CV using the immutable package and independent state/output; otherwise serialize. No live writers or package/lock edits during final verification/review. An input change invalidates affected receipts and journey evidence.

Use port 0 and read bound addresses from ready records; do not reserve fixed ports by probing then closing. The E2E reverse proxy also binds port 0. Browser and Pi fixtures use unique run roots/process groups. Harness cleanup only removes its owned state and processes. On failure preserve state/logs and emit a rerun command; no product-code edits by the journey worker.

### AGENTS.md implementation recipe

AGENTS.md will contain the exact timing wording in DOC4, plus: use only Nix-supplied dependencies; run existing unit tests; use the commands above for initial feature validation; execute `node scripts/e2e.mjs` through `nix develop` against the built package; require every E1–E10/V1 assertion; use disposable HOME/XDG/Pi/session/store/browser/project directories and dynamic loopback ports; never load live Pi/Paseo configuration or deploy; preserve failure evidence; stop only owned child processes after success. It links docs/testing.md for expanded evidence/retry instructions. Approval of this plan resolves the preflight's missing-AGENTS/E2E-instructions gate by authorizing T1 to add this recipe.

## E2E journey

The command E is one reproducible automated harness, not a written manual walkthrough alone. It launches the immutable N2 service/extension, real Pi CLI and Playwright Chromium. A test-only local OpenAI-compatible fixture endpoint returns scripted tool calls; Pi actually executes its built-in write tool and the shipped extension's tools. It records actual JSONL `tool_execution_end`/`entry_appended` events and validates results; directly calling HTTP publication instead of Pi does not satisfy E1/E3/E4/E7/E8/E9. Test-only model fixtures stay under tests/, never enter the shipped package, and require no provider credentials. Configure two fixture provider/model identities to demonstrate no provider-specific coupling. Integration tests complement the journey for real session tree/compaction/clone and fault injection.

For each E step save expected result, actual result, command/output/assertion and evidence paths. Save screenshots for the viewer steps, browser console/network logs, sanitized config, Pi transcript, source/preview digest manifests, service logs and package provenance. Do not store any live tokens/credentials; generated test tokens may be redacted as well.

1. **E1 — Fresh isolated setup and actual Pi loading.** Create a unique run directory under `.artifacts-checks/e2e/`, disposable home/XDG/Pi agent/session roots, stores/work roots and project A/B directories. Start the packaged service on loopback port 0, the local fixture provider and a public-prefix proxy on port 0. Configure Pi with only the shipped extension, test models and needed built-ins. Run `pi --mode json` with an explicit test session id and cwd project A, consuming stdout continuously. Expected: ready health, real tool registration, no live Pi/Paseo config reads, package identity recorded. No Paseo daemon/plugin is needed or changed.
2. **E2 — Empty browser and link path.** Open the configured gallery URL in clean Chromium. Expected: an accessible empty state; direct missing artifact/revision routes display a useful not-found state. Invoke `/artifacts` through real Pi command handling and capture its gallery link; opening it reaches the same viewer. Record viewport/theme screenshots.
3. **E3 — First HTML publication.** Drive a prompt through real Pi; fixture model calls built-in write to create an HTML counter, CSS, JS and small image under its configured external work directory, then `artifact_publish`. Expected: success containing id/revision 1, Latest and pinned links, saved custom ref and source list. Open Latest and click the counter; assert a state change and visible local image/styles. Toggle Source, select HTML/CSS/JS, and assert exact source content. Block all external network requests in the browser; local preview still works.
4. **E4 — Update, pin and immutability.** Keep one Latest browser and one pinned revision-1 browser open. Modify files through Pi write/edit and publish revision 2 using the same id. Expected: Latest changes within 5 seconds, retained mode, pinned revision 1 unchanged with a new-revision indication. Switch modes and revisions to verify both. Mutate/delete working files without publishing and verify neither saved source nor preview digests change. Reload the revision-1 browser and recheck its original behavior.
5. **E5 — React/library preview.** Through Pi write and publish a TSX default-exported component using React state, lucide-react icon, recharts chart, a local CSS file/image and Tailwind utilities. Expected: visible icon, chart geometry, Tailwind computed style, local asset and counter interaction; no external dependency requests. Source shows original TSX/CSS, not compiled JS. A pinned React preview still works after service restart in E7.
6. **E6 — Markdown preview.** Through Pi write and publish Markdown with heading, list, fenced code and relative image. Expected: rendered elements/image in Preview and exact Markdown in Source. Text containing HTML-like source characters does not become active controls in the Source pane. All three artifacts now appear in the gallery.
7. **E7 — Restart/resume/fork/restore.** Stop/restart the service with the same disposable store, disconnecting browser events; publish while one viewer is disconnected, then reconnect. Expected: catalog/Latest convergence within 10 seconds of healthy service, old pinned HTML/React still interactive and all committed digests unchanged. Exit/restart Pi with the same session id; list/get returns prior refs. Fork with real Pi `--fork ... --session-id ...`, restore an inherited old revision into a new work directory, edit/publish a child with parentRevision equal to that old ref. Resume the original session: its default get/list still returns its own saved ref; global Latest and the child session may show the child. Existing restore destination fails without writes. I7 separately proves tree/compaction/clone semantics.
8. **E8 — Recoverable failures.** Through real Pi attempt an invalid TSX/import publish on an existing artifact. Expected: failed tool result with fix guidance; no committed revision/count/digest/Latest change. Publish corrected TSX successfully. Then publish a valid build that throws at runtime: Preview shows the exception and Reload; source/revision navigation remains usable. Stop the service and invoke get/publish: Pi reports service unavailable without hanging or fabricating success; restart and confirm recovery. Deterministic I5 covers the remaining failure variants.
9. **E9 — Provider/project compatibility.** Launch a second configured fixture provider/model in a new unrelated Pi session with cwd project B, using the same shipped extension/service. Expected: initial branch list empty although the gallery contains A's artifacts; B can write/publish/get its own artifact. A's branch refs/source remain intact. Compare exact before/after tracked/untracked inventories of projects A and B: default artifact work created no files there. Capture both provider/model identities and actual tool event evidence.
10. **E10 — Configuration and closure.** Verify all public links, scripts, relative assets, source/download routes and SSE work through the distinct configured public authority with `/artifacts` prefix, while Pi publishes using internal serviceUrl. Test unauthorized write rejection. Recheck package manifest identity and scan captured browser assets/links/logs for publishing token exposure. At both viewports and light/dark appearance, keyboard through gallery, revisions, Source/Preview and reload with assertions/screenshots (**V1**); inspect captures for clipped controls/unreadable content and record actual findings. Successful cleanup stops only this run's processes and deletes transient homes/browser state while retaining sanitized evidence. On a failed step reproduce once and preserve state with a precise rerun command.

An optional live-Paseo desktop demonstration can open a returned URL beside the conversation if separately available/authorized, but it is not required evidence for v1's browser product and cannot replace the automated isolated journey. The absence of a Paseo plugin or sandbox is an approved scope decision, not an unfinished integration.

## Approval and handoff

The user explicitly approved this saved plan in the design tab. Finalize the approved file, recheck branch/worktree, then hand it to the existing orchestrator with exactly:

```sh
paseo send a8746eea-c42f-4af6-9df7-0f45279facc0 --no-wait --prompt "PLAN_READY /home/sinkerine/.paseo/worktrees/1vv1duoi/feat-artifacts/docs/features/artifacts-plan.md: approved by the user. <one-line summary and open notes>"
```

Then tell the user the design was handed off. Do not send PLAN_READY to the original parent, implement, commit, create a goal, or launch another orchestrator/worker from this design tab. If the orchestrator identifies plan gaps, update this file and resend PLAN_READY, obtaining renewed user approval only for consequential scope/behavior changes.
