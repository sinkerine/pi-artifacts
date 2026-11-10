import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const modules = await realpath("node_modules");
if (!modules.startsWith("/nix/store/")) throw Error("node_modules must be an immutable Nix output.");
if (!process.env.PLAYWRIGHT_BROWSERS_PATH?.startsWith("/nix/store/"))
  throw Error("Nix Playwright browsers are required.");
const playwright = require("@playwright/test/package.json").version;
const nixDriver = JSON.parse(
  await readFile(`${process.env.PLAYWRIGHT_BROWSERS_PATH}/../package/package.json`, "utf8").catch(
    () => '{"version":"unknown"}',
  ),
);
const chromium = execFileSync(process.env.PI_ARTIFACTS_CHROMIUM, ["--version"], { encoding: "utf8" }).trim();
console.log(
  JSON.stringify(
    {
      node: process.version,
      modules,
      playwright,
      nixDriver: nixDriver.version,
      browsers: process.env.PLAYWRIGHT_BROWSERS_PATH,
      chromiumExecutable: process.env.PI_ARTIFACTS_CHROMIUM,
      chromium,
    },
    null,
    2,
  ),
);
