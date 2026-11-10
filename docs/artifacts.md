# Artifact contracts

Previews execute trusted browser content in an ordinary iframe without a sandbox. Only publish code you trust. There is no Paseo plugin; open the returned HTTP(S) link in an ordinary browser or a Paseo desktop workspace browser.

The service owns disk storage, builds, immutable revisions and HTTP. The Pi extension captures explicitly named source bytes and sends them to the already running service; it never starts a daemon, installs dependencies or watches working files. The viewer operates independently of Pi and model providers. TUI, RPC, JSON and print modes use the same tools. `/artifacts [id]` sends a visible Pi message with the gallery or branch-referenced pinned link, with no browser opener or new agent turn.

## Tools

Shared TypeBox schemas and TypeScript types live in `src/shared/contracts.ts`. Unknown tool input properties are rejected. IDs are UUIDs and revisions are positive integers.

- `artifact_publish({id?, title, kind, entrypoint, files})` returns an ArtifactRevision. `kind` is `html`, `react` or `markdown`; title is 1–200 characters; files is an explicit list of file paths. A new artifact omits id. Updating requires the id to be referenced on this active Pi branch, retains kind, and uses the branch's revision as parent.
- `artifact_list({})` returns `{artifacts: ArtifactRevision[]}` in newest-reference-first order. It never substitutes global Latest.
- `artifact_get({id, revision?, restoreTo?})` returns `{artifact, sources, sourceTextTruncated, restoredTo?}`. Id must be branch-referenced. Revision defaults to that branch's reference; an explicit revision may select any committed revision of that artifact. Each source includes `{path, bytes, sha256, mediaType, text?}`. Text is limited to 64 KiB (65536 bytes) total with explicit truncation. Binary files omit text; full originals are available at source/download endpoints. Restore creates a previously nonexistent destination atomically and never overwrites existing empty or nonempty directories. Relative restoreTo resolves against cwd. Restore does not publish or advance refs.

Successful results include readable JSON text with clickable viewer URLs, `details`, `structuredContent` and a matching outputSchema. Failures throw, producing failed Pi tool results. There is no terminal confirmation flow.

An ArtifactRevision is `{schemaVersion:1,id,revision,title,kind,parentRevision,createdAt,entrypoint,files,previewUrl,revisionUrl}`. Parent is a positive integer or null, createdAt is ISO 8601, files is SourceFileInfo[], previewUrl follows global Latest and revisionUrl pins `?revision=n`.

## Working files and snapshots

Guidance gives an absolute `${workDir}/${sessionId}/<artifact-name>/` directory. Default workDir is `$XDG_STATE_HOME/pi-artifacts/work`, falling back to `~/.local/state/pi-artifacts/work`. These defaults do not create files or ignore rules in the project. Existing project files can also be published deliberately.

Relative paths resolve against Pi's cwd; absolute paths are accepted. The source root is the entrypoint's parent. Every named path must be an ordinary file within that root, and the entrypoint must appear in files. No globs, recursion, symlinks, duplicate normalized paths, or path escapes are accepted. Saved paths are POSIX paths relative to this root. Include every local CSS/JS/import/image explicitly. Use relative asset URLs; arbitrary root-absolute routing is not rewritten.

Files are captured once into bounded memory. Capture is not a transaction with unrelated concurrent working-tree edits. After capture, publication/builds do not reread working files. Editing or deleting them cannot alter saved bytes. Limits default to 100 files, 10 MiB decoded total, 2 MiB/file and a 30-second build deadline. All limits are configurable.

HTML preserves supplied local assets and code with a small error/reload handler loaded before scripts. Markdown uses marked 17.0.4 with local typography CSS. React requires a default-exported component; it bundles JSX/TSX, local JS/TS/JSX/TSX/CSS and explicitly supplied images. Bare imports are restricted to react 19.2.4, react-dom 19.2.4, lucide-react 0.577.0 and recharts 3.8.0 and their public subpaths (including react/jsx-runtime and react-dom/client). Tailwind utilities use a locally copied @tailwindcss/browser 4.2.1 runtime. There is no mandatory CDN or runtime registry lookup. Builds use esbuild 0.27.4 and packaged libraries, never arbitrary project dependencies/scripts. Saved preview assets remain independent of later package upgrades.

## History and recovery

A successful publication appends `pi-artifacts.ref.v1` with `{id,revision}`. The full active `sessionManager.getBranch()` is reduced in branch order; successful artifact_publish tool-result details provide recovery if finalization was interrupted. Abandoned branches are never read as one linear history. Resume, tree navigation, compaction, fork and clone retain raw active-branch entries. List/get do not advance refs. A new unrelated session starts empty. In-memory sessions keep refs during their lifetime and cannot be resumed. Missing saved data reports an unavailable-reference error rather than silently dropping it.

Revisions are complete immutable snapshots within an artifact UUID. Revision numbers increase globally; parent may be older than Latest. Forks inherit refs and publish children without rewriting the parent's branch. Latest is the most recently committed global revision. The viewer labels Latest and pinned revision states, preserves Source/Preview on updates, indicates newer publications for pinned views and reconciles after SSE reconnect/restart. A removed selected source switches to entrypoint with a notice. Binary sources show metadata/download; source text is escaped text, never active markup.

Publication failures identify missing/unreadable files, symlinks/escapes, unsupported imports, missing default exports, syntax errors, limits, aborts, deadlines, storage failures and unavailable service. Build diagnostics retain captured source-relative locations and import/default-export guidance without exposing server filesystem or dependency paths. Fix the indicated source/config problem and retry. Pre-commit failures never expose a partial revision or replace Latest. Runtime exceptions appear in Preview with Reload; the shell and saved source stay navigable. The extension retries a transport-failed publish once with exactly the same requestId/body. Connection loss or cancellation after commit cannot undo it: the gallery may contain a committed revision whose response/ref was interrupted. Check the gallery before assuming it failed.

## HTTP and persistence

All routes below are relative to the public URL prefix (also required on serviceUrl). JSON is UTF-8. Read endpoints are public to reachable clients; the token protects writes, not readers.

| Method/path | Response |
| --- | --- |
| GET /health | `{status:"ok",schemaVersion:1}` after store ownership/scan |
| POST /api/artifacts/publish | Bearer token; PublishRequest → ArtifactRevision |
| GET /api/artifacts | `{artifacts}` containing each global Latest |
| GET /api/artifacts/:id | `{revisions}` in ascending order |
| GET /api/artifacts/:id/revisions/:n | ArtifactRevision |
| GET /api/artifacts/:id/revisions/:n/source/*path | Original bytes with media type; `?download=1` forces attachment; binary downloads explicitly |
| GET /preview/:id/:n/*path | Immutable self-contained preview document/asset |
| GET /api/events | SSE `ready`, `published` `{id,revision}`, heartbeats; reconcile catalog after connect |
| GET / and /a/:id | Gallery/viewer shell; `?revision=n` pins |

PublishRequest is `{requestId,id?,title,kind,entrypoint,files:[{path,base64}],parentRevision}`. Source paths are relative only, bytes encoded as strict base64. No arbitrary filesystem paths, shell commands or dependency-install instructions are accepted. Repeating an identical requestId/body returns its original revision; changed input with the same requestId conflicts. Per-service serialization covers allocate/build/commit and retry races.

Errors use `{error:{code,message}}`: 400 invalid input/paths/encoding, 401 absent/wrong token, 404 missing artifact/revision/file, 409 idempotency conflict/kind change/existing restore destination, 413 limits, 422 build/import/default-export failure, 503 unavailable store/deadline, 500 unexpected I/O. Browser-facing errors do not expose server filesystem paths or credentials; concise diagnostics go to stderr.

`startService({configPath?})` resolves to `{address,close()}`. The CLI logs `{event:"ready",address,publicUrl}` once to stdout; diagnostics use stderr. SIGINT/SIGTERM closes connections/SSE and releases ownership after queued work.

The data schema is version 1. Storage is `artifacts/<uuid>/revisions/<n>/{manifest.json,source/,preview/}` under dataDir. Manifests record source/build digests, requestId/input digest and parent. A complete staging directory is flushed then atomically renamed to commit; catalog/idempotency indexes rebuild from committed manifests. Interrupted staging is removed at startup. Malformed committed data reports an integrity error. An OS-backed flock protects one owner with crash recovery; a second owner fails clearly. Local POSIX filesystems only; network filesystems and multiple writers are unsupported.

There is no automatic deletion, retention or GC. Back up the complete data directory while the service is stopped (including immutable revisions and manifests). Protect tokenFile separately when supplied externally. Restore backups before starting one owner. Upgrades must retain schema compatibility; do not downgrade a store written by an incompatible schema. Working files are separate from saved source snapshots.
