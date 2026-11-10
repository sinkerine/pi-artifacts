# pi-artifacts

Publish immutable HTML, React/TSX and Markdown snapshots from Pi and open their Preview or original Source in an ordinary browser. A shared Latest link updates after publication; pinned revision links retain their saved bytes. Pi list/get follows references on the active conversation branch. No provider-specific API, terminal dialog, browser opener, or Paseo plugin is required. In Paseo desktop, open the returned URL in a workspace browser beside the conversation.

Previews run trusted browser code without a sandbox. Only publish code you trust, and put private deployments behind an operator-controlled gateway.

## Quickstart (x86_64-linux)

Dependencies and Chromium come only through Nix. Other systems are unverified.

```sh
nix develop --command node scripts/check-environment.mjs
nix develop --command npm run build
nix build .#default --out-link .artifacts-checks/package
.artifacts-checks/package/bin/pi-artifacts serve
```

With no config file the service binds `127.0.0.1:4317`. It generates a publishing token under the default data directory. To use an explicit config, copy [examples/config.json](examples/config.json), replace its absolute paths, then run `pi-artifacts serve --config /absolute/config.json`. Set `PI_ARTIFACTS_CONFIG` to that path in the Pi environment too.

Load the extension for one invocation (no live profile installation):

```sh
PI_ARTIFACTS_CONFIG=/absolute/config.json pi --extension .artifacts-checks/package/lib/pi-artifacts/dist/extensions/artifacts.js
```

Ask Pi to write files under the absolute session work directory given in its artifact guidance, then call a tool with the explicit file list. These JSON examples are tool arguments; replace `/work/session/example` with the supplied directory:

```json
{"title":"HTML counter","kind":"html","entrypoint":"/work/session/example/index.html","files":["/work/session/example/index.html","/work/session/example/style.css","/work/session/example/app.js"]}
```

For HTML, write `<button id="counter">0</button><script src="app.js"></script>` in index.html and an onclick counter in app.js. Include a relative CSS link and list style.css. Call `artifact_publish`, then open its `previewUrl` or `revisionUrl`.

```json
{"title":"React counter","kind":"react","entrypoint":"/work/session/example/main.tsx","files":["/work/session/example/main.tsx"]}
```

For React, write `import {useState} from 'react'; export default function App(){const [n,setN]=useState(0);return <button className="p-4" onClick={()=>setN(n+1)}>{n}</button>}`. Publish and click in Preview. React, ReactDOM, lucide-react, recharts and Tailwind are packaged locally.

```json
{"title":"Markdown note","kind":"markdown","entrypoint":"/work/session/example/note.md","files":["/work/session/example/note.md","/work/session/example/image.svg"]}
```

For Markdown, write `# Note`, a list, fenced code and `![Example](image.svg)`, plus the image file. Publish, open Preview, then switch to Source to see the exact original Markdown.

`artifact_list({})` lists this branch's revisions. `artifact_get({"id":"<uuid>"})` reads its saved sources; adding `restoreTo` restores bytes to a new directory. `/artifacts` prints the gallery link without starting another agent turn.

See [tool, API and revision contracts](docs/artifacts.md), [deployment and Home Manager](docs/deployment.md), and [testing and isolated journey evidence](docs/testing.md).
