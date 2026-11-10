import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseConfig } from "../../src/shared/config";
import type { PublishRequest } from "../../src/shared/contracts";
export async function root() {
  await mkdir(".artifacts-checks/tests", { recursive: true });
  return mkdtemp(resolve(".artifacts-checks/tests/run-"));
}
export async function configuration(dir: string, extra: Record<string, unknown> = {}) {
  const data = parseConfig({ dataDir: join(dir, "data"), workDir: join(dir, "work"), port: 0, ...extra });
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(data));
  return { data, path };
}
export function publication(
  files: Record<string, string | Buffer> = { "index.html": "<h1>Hello</h1>" },
  extra: Partial<PublishRequest> = {},
): PublishRequest {
  return {
    requestId: randomUUID(),
    title: "Example",
    kind: "html",
    entrypoint: Object.keys(files)[0],
    parentRevision: null,
    files: Object.entries(files).map(([path, data]) => ({
      path,
      base64: Buffer.from(data).toString("base64"),
    })),
    ...extra,
  };
}
