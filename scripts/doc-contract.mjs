import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const timing =
  "Run E2E tests when a feature is first added, including repairs and reruns needed for that initial feature. Future pushes and deployments do not require rerunning E2E tests. Existing unit tests must still be run, including for future pushes and deployments.";
assert((await readFile("AGENTS.md", "utf8")).includes(timing));
for (const [file, words] of Object.entries({
  "README.md": [
    "artifact_publish",
    "artifact_list",
    "artifact_get",
    "nix develop",
    "markdown",
    "react",
    "html",
  ],
  "docs/artifacts.md": ["requestId", "parentRevision", "getBranch()", "65536", "sandbox"],
  "docs/deployment.md": ["bindAddress", "serviceUrl", "publicUrl", "tokenFile", "enablePiExtension"],
  "docs/testing.md": ["test:discover", "test:coverage", "E1–E10/V1", "scripts/e2e.mjs"],
})) {
  const text = await readFile(file, "utf8");
  for (const word of words) assert(text.includes(word), `${file}: missing ${word}`);
}
const config = JSON.parse(await readFile("examples/config.json", "utf8"));
assert.equal(new URL(config.serviceUrl).pathname, new URL(config.publicUrl).pathname);
assert.equal(config.bindAddress, "127.0.0.1");
console.log("Documentation/config contracts passed.");
