import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/viewer", { recursive: true });
await build({
  entryPoints: ["src/service/cli.ts", "src/service/server.ts"],
  outdir: "dist/service",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  define: { "process.env.PI_ARTIFACTS_MV": JSON.stringify(process.env.PI_ARTIFACTS_MV ?? "mv") },
  sourcemap: true,
});
await build({
  entryPoints: ["extensions/artifacts.ts"],
  outdir: "dist/extensions",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  define: { "process.env.PI_ARTIFACTS_MV": JSON.stringify(process.env.PI_ARTIFACTS_MV ?? "mv") },
  sourcemap: true,
});
await build({
  entryPoints: ["src/viewer/main.ts"],
  outfile: "dist/viewer/viewer.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  sourcemap: true,
});
await cp("src/viewer/index.html", "dist/viewer/index.html");
await cp("src/viewer/viewer.css", "dist/viewer/viewer.css");

await writeFile("dist/extensions/index.js", 'export { default } from "./artifacts.js";\n');
