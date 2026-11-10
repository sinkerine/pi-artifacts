import { spawn } from "node:child_process";
import { isolatedEnvironment } from "./environment.mjs";

const group = process.argv[2];
if (!group || !["unit", "integration", "coverage"].includes(group))
  throw Error("Expected unit, integration or coverage.");
const args = ["node_modules/vitest/vitest.mjs", "run", "--configLoader", "runner"];
if (group === "coverage") args.push("--project", "unit", "--project", "integration", "--coverage");
else args.push("--project", group);
const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: await isolatedEnvironment(`.artifacts-checks/runner/${group}`),
});
child.on("error", (e) => {
  console.error(e);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
