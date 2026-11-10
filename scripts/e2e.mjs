import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isolatedEnvironment } from "./environment.mjs";

const args = process.argv.slice(2);
const packageArg = args[args.indexOf("--package") + 1],
  evidence = args[args.indexOf("--evidence") + 1];
if (!args.includes("--package") || !args.includes("--evidence"))
  throw Error("Usage: node scripts/e2e.mjs --package <Nix output> --evidence .artifacts-checks/e2e");
const packagePath = await realpath(packageArg);
if (!packagePath.startsWith("/nix/store/")) throw Error("Journey requires an immutable Nix package.");
const evidencePath = resolve(evidence);
if (!evidencePath.startsWith(`${resolve(".artifacts-checks")}/`))
  throw Error("Evidence must stay under .artifacts-checks/.");
await mkdir(evidencePath, { recursive: true });
const root = await mkdtemp(join(evidencePath, "run-"));
async function sourceDigest() {
  const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path && !path.startsWith(".pi/"))
    .sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    const bytes = await readFile(path);
    hash.update(`${Buffer.byteLength(path)}:${path}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}
const identity = async () => ({
  packagePath,
  source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceDigest: await sourceDigest(),
  lock: createHash("sha256")
    .update(await readFile("package-lock.json"))
    .digest("hex"),
  flakeLock: createHash("sha256")
    .update(await readFile("flake.lock"))
    .digest("hex"),
  executable: createHash("sha256")
    .update(await readFile(join(packagePath, "bin/pi-artifacts")))
    .digest("hex"),
});
const before = await identity();
await writeFile(join(root, "package-before.json"), JSON.stringify(before, null, 2));
const env = {
  ...(await isolatedEnvironment(join(root, "launcher"))),
  ARTIFACTS_E2E_ROOT: root,
  ARTIFACTS_E2E_PACKAGE: packagePath,
};
const child = spawn(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test", "--config", "tests/e2e/playwright.config.mjs"],
  { env, stdio: "inherit" },
);
const code = await new Promise((resolve) => child.on("exit", resolve));
const after = await identity();
await writeFile(join(root, "package-after.json"), JSON.stringify(after, null, 2));
if (JSON.stringify(before) !== JSON.stringify(after)) throw Error("Package identity changed during journey.");
console.log(`Evidence: ${root}`);
if (code === 0) {
  for (const name of ["state", "launcher"]) await rm(join(root, name), { recursive: true, force: true });
} else
  console.error(
    "Preserved failure state. Rerun: nix develop --command node scripts/e2e.mjs --package " +
      packageArg +
      " --evidence " +
      evidence,
  );
process.exitCode = code ?? 1;
