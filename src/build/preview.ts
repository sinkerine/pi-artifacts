import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, posix } from "node:path";
import { type BuildResult, context, type Loader } from "esbuild";
import { marked } from "marked";
import { type ArtifactKind, fail } from "../shared/contracts";

const require = createRequire(import.meta.url);
export const allowedImports = ["react", "react-dom", "lucide-react", "recharts"];
export const runtimeFeedback = `<script>(function(){function show(e){var box=document.getElementById('pi-artifacts-runtime-error');if(!box){box=document.createElement('aside');box.id='pi-artifacts-runtime-error';box.style.cssText='position:fixed;z-index:2147483647;inset:8px 8px auto;background:#fff1f2;color:#881337;padding:16px;font:14px system-ui;border:2px solid #be123c';document.documentElement.appendChild(box)}box.replaceChildren();var text=document.createElement('pre');text.textContent='Preview error: '+String(e&&e.message||e);box.appendChild(text);var button=document.createElement('button');button.textContent='Reload';button.onclick=function(){location.reload()};box.appendChild(button)}window.addEventListener('error',function(e){show(e.error||e.message)});window.addEventListener('unhandledrejection',function(e){show(e.reason)});window.__artifactError=show})();</script>`;
function html(body: string, head = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${runtimeFeedback}${head}</head><body>${body}</body></html>`;
}
export async function buildPreview(
  kind: ArtifactKind,
  entrypoint: string,
  files: Map<string, Buffer>,
  signal?: AbortSignal,
): Promise<Map<string, Buffer>> {
  signal?.throwIfAborted();
  const result = new Map(files);
  const source = files.get(entrypoint);
  if (!source) fail(400, "ENTRYPOINT", "Entrypoint must be included.");
  if (kind === "html") {
    const content = source.toString("utf8");
    result.set(
      entrypoint,
      Buffer.from(
        content.includes("<head>")
          ? content.replace("<head>", `<head>${runtimeFeedback}`)
          : `${runtimeFeedback}${content}`,
      ),
    );
    return result;
  }
  if (kind === "markdown") {
    result.set(
      entrypoint,
      Buffer.from(
        html(
          await marked.parse(source.toString("utf8")),
          "<style>body{max-width:75ch;margin:2rem auto;padding:1rem;font:16px/1.6 system-ui}pre{overflow:auto;background:#eee;padding:1rem}img{max-width:100%}</style>",
        ),
      ),
    );
    return result;
  }
  const virtualEntry = ".pi-artifacts-entry.tsx";
  const virtual = new Map(files);
  virtual.set(
    virtualEntry,
    Buffer.from(
      `import React from 'react';import {createRoot} from 'react-dom/client';import App from './${entrypoint}';class Boundary extends React.Component{state={failed:false};static getDerivedStateFromError(){return {failed:true}}componentDidCatch(e){window.__artifactError(e)}render(){return this.state.failed?null:this.props.children}};createRoot(document.getElementById('root')).render(<Boundary><App/></Boundary>);`,
    ),
  );
  try {
    const builder = await context({
      entryPoints: [virtualEntry],
      bundle: true,
      write: false,
      outdir: "out",
      entryNames: ".pi-artifacts-app",
      assetNames: ".pi-artifacts-asset-[hash]",
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      logLevel: "silent",
      plugins: [
        {
          name: "snapshot",
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) => {
              if (args.kind === "entry-point") return { path: virtualEntry, namespace: "snapshot" };
              if (args.namespace === "file") return;
              const spec = args.path;
              if (!spec.startsWith(".") && !spec.startsWith("/")) {
                if (!allowedImports.some((p) => spec === p || spec.startsWith(`${p}/`)))
                  fail(
                    422,
                    "IMPORT",
                    `Unsupported import ${spec}. Allowed: ${allowedImports.join(", ")} and their public subpaths.`,
                  );
                try {
                  return { path: require.resolve(spec) };
                } catch {
                  fail(422, "IMPORT", `Cannot resolve public import ${spec}.`);
                }
              }
              const path = posix.normalize(
                posix.join(args.importer ? posix.dirname(args.importer) : "", spec),
              );
              const candidates = [
                path,
                ...[
                  ".tsx",
                  ".ts",
                  ".jsx",
                  ".js",
                  ".css",
                  "/index.tsx",
                  "/index.ts",
                  "/index.jsx",
                  "/index.js",
                ].map((e) => path + e),
              ];
              const found = candidates.find((p) => virtual.has(p));
              if (!found)
                fail(422, "IMPORT", `Missing local import ${spec}; include it in the explicit file list.`);
              return { path: found, namespace: "snapshot" };
            });
            builder.onLoad({ filter: /.*/, namespace: "snapshot" }, (args) => {
              const ext = extname(args.path).slice(1);
              return {
                contents: virtual.get(args.path)!,
                loader:
                  (
                    { ts: "ts", tsx: "tsx", js: "jsx", jsx: "jsx", css: "css", json: "json" } as Record<
                      string,
                      Loader
                    >
                  )[ext] ?? "file",
              };
            });
          },
        },
      ],
    });
    const cancel = () => {
      void builder.cancel();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    let output: BuildResult & { outputFiles: NonNullable<BuildResult["outputFiles"]> };
    try {
      signal?.throwIfAborted();
      output = (await builder.rebuild()) as typeof output;
    } finally {
      signal?.removeEventListener("abort", cancel);
      await builder.dispose();
    }
    signal?.throwIfAborted();
    const scripts: string[] = [],
      styles: string[] = [];
    for (const out of output.outputFiles) {
      const name = out.path.split("/").pop()!;
      result.set(posix.join(posix.dirname(entrypoint), name), Buffer.from(out.contents));
      if (name.endsWith(".js")) scripts.push(`<script src="./${name}"></script>`);
      if (name.endsWith(".css")) styles.push(`<link rel="stylesheet" href="./${name}">`);
    }
    const twPath = require.resolve("@tailwindcss/browser");
    result.set(posix.join(posix.dirname(entrypoint), ".pi-artifacts-tailwind.js"), await readFile(twPath));
    result.set(
      entrypoint,
      Buffer.from(
        html(
          `<div id="root"></div>${scripts.join("")}`,
          `${styles.join("")}<script src="./.pi-artifacts-tailwind.js"></script>`,
        ),
      ),
    );
    return result;
  } catch (e) {
    if (signal?.aborted) throw e;
    fail(
      422,
      "BUILD",
      `React build failed. Export a default component and fix TSX/imports: ${(e as Error).message}`,
    );
  }
}
