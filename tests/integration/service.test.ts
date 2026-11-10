import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { startService }: typeof import("../../src/service/server") = await import(
  resolve("dist/service/server.js")
);

import { Store } from "../../src/service/store";
import type { ArtifactRevision, PublishRequest } from "../../src/shared/contracts";
import { configuration, publication, root } from "../fixtures/helpers";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function fixture(extra: Record<string, unknown> = {}) {
  const dir = await root(),
    { path, data } = await configuration(dir, extra);
  let service = await startService({ configPath: path });
  cleanup.push(() => service.close());
  const token = (await readFile(data.tokenFile, "utf8")).trim();
  return {
    dir,
    data,
    path,
    get service() {
      return service;
    },
    async restart() {
      await service.close();
      service = await startService({ configPath: path });
    },
    async publish(body: PublishRequest) {
      return fetch(new URL("api/artifacts/publish", service.address), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    },
    token,
  };
}
async function treeDigest(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of await readdir(path, { withFileTypes: true })) {
    if (file.isDirectory()) {
      for (const [k, v] of Object.entries(await treeDigest(join(path, file.name))))
        out[`${file.name}/${k}`] = v;
    } else
      out[file.name] = createHash("sha256")
        .update(await readFile(join(path, file.name)))
        .digest("hex");
  }
  return out;
}
describe("I2–I3 real HTTP builds and immutable sources", () => {
  it("publishes all kinds, binary originals and stable snapshots across restart", async () => {
    const f = await fixture();
    for (const [kind, name, source] of [
      ["html", "index.html", "<h1>Hello</h1>"],
      ["markdown", "index.md", "# Hello\n\n- list"],
      ["react", "index.tsx", "export default function App(){return <button>Click</button>}"],
    ] as const) {
      const response = await f.publish(
        publication({ [name]: source, "image.png": Buffer.from([0, 255, 128]) }, { kind }),
      );
      expect(response.status).toBe(200);
      const artifact = (await response.json()) as ArtifactRevision;
      const original = await fetch(
        `${f.service.address}api/artifacts/${artifact.id}/revisions/1/source/image.png`,
      );
      expect(Buffer.from(await original.arrayBuffer())).toEqual(Buffer.from([0, 255, 128]));
      expect(original.headers.get("Content-Disposition")).toContain("attachment");
      const preview = await fetch(`${f.service.address}preview/${artifact.id}/1/${name}`);
      expect(preview.status).toBe(200);
      expect(preview.headers.get("Content-Type")).toBe("text/html");
    }
    const before = await treeDigest(join(f.data.dataDir, "artifacts"));
    await f.restart();
    expect(await treeDigest(join(f.data.dataDir, "artifacts"))).toEqual(before);
    expect((await (await fetch(`${f.service.address}api/artifacts`)).json()).artifacts).toHaveLength(3);
  });
});
describe("I4 SSE reconnect", () => {
  it("announces ready and committed publications; reconnect catalog includes missed events", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const response = await fetch(`${f.service.address}api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
    const artifact = await (await f.publish(publication())).json();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(`"id":"${artifact.id}"`);
    controller.abort();
    await f.publish(publication({ "other.html": "missed" }));
    const catalog = await (await fetch(`${f.service.address}api/artifacts`)).json();
    expect(catalog.artifacts).toHaveLength(2);
    const reconnect = new AbortController();
    const stream = await fetch(`${f.service.address}api/events`, { signal: reconnect.signal });
    expect(new TextDecoder().decode((await stream.body!.getReader().read()).value)).toContain("ready");
    reconnect.abort();
  });
});
describe("I5 pre-commit failures", () => {
  it("retains all previous bytes/count for invalid encoding, import/default/TSX, limits and missing entrypoint", async () => {
    const f = await fixture({ limits: { maxFileBytes: 4096, maxTotalBytes: 8192 } });
    const a = (await (
      await f.publish(
        publication({ "a.tsx": "export default function A(){return <h1>A</h1>}" }, { kind: "react" }),
      )
    ).json()) as ArtifactRevision;
    const before = await treeDigest(join(f.data.dataDir, "artifacts"));
    const invalid = [
      publication(
        { "a.tsx": "import X from 'unapproved';export default X" },
        { id: a.id, kind: "react", parentRevision: 1 },
      ),
      publication({ "a.tsx": "export const a=1" }, { id: a.id, kind: "react", parentRevision: 1 }),
      publication({ "a.tsx": "export default <x" }, { id: a.id, kind: "react", parentRevision: 1 }),
      publication({ "a.tsx": "a".repeat(4097) }, { id: a.id, kind: "react", parentRevision: 1 }),
      publication({ "a.tsx": "x" }, { id: a.id, kind: "react", parentRevision: 1, entrypoint: "absent.tsx" }),
      { ...publication(), files: [{ path: "a.html", base64: "!!!" }] },
    ];
    for (const body of invalid) {
      expect((await f.publish(body)).ok).toBe(false);
      expect(await treeDigest(join(f.data.dataDir, "artifacts"))).toEqual(before);
    }
  });
  it("cancels before commit and reports actual disposable filesystem failure", async () => {
    const dir = await root(),
      { data } = await configuration(dir);
    const store = new Store(data);
    await store.start();
    cleanup.push(() => store.close());
    const a = await store.publish(publication());
    const before = await treeDigest(join(data.dataDir, "artifacts"));
    const abort = new AbortController();
    abort.abort();
    await expect(
      store.publish(publication({ "index.html": "changed" }, { id: a.id, parentRevision: 1 }), abort.signal),
    ).rejects.toThrow();
    await mkdir(join(data.dataDir, "staging", "bad"));
    await writeFile(join(data.dataDir, "staging", "blocked"), "file");
    const failure = publication({ "index.html": "changed" }, { id: a.id, parentRevision: 1 });
    await writeFile(join(data.dataDir, "staging", failure.requestId), "blocks stage directory");
    await expect(store.publish(failure)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await treeDigest(join(data.dataDir, "artifacts"))).toEqual(before);
  });
});
describe("I6 concurrent commits/ownership/staging", () => {
  it("serializes clients, handles idempotent races and recovers ownership", async () => {
    const f = await fixture();
    const body = publication();
    const same = await Promise.all([f.publish(body), f.publish(body)]);
    const [a, b] = await Promise.all(same.map((r) => r.json()));
    expect(a).toEqual(b);
    const responses = await Promise.all(
      ["A", "B"].map((text) =>
        f.publish(publication({ "index.html": text }, { id: a.id, parentRevision: 1 })),
      ),
    );
    const revisions = await Promise.all(responses.map((r) => r.json()));
    expect(revisions.map((r) => r.revision)).toEqual([2, 3]);
    for (let i = 0; i < 2; i++) {
      const text = await (
        await fetch(`${f.service.address}api/artifacts/${a.id}/revisions/${i + 2}/source/index.html`)
      ).text();
      expect(text).toBe(["A", "B"][i]);
    }
    expect((await f.publish({ ...body, title: "conflict" })).status).toBe(409);
    await expect(startService({ configPath: f.path })).rejects.toThrow(/owned/);
    await mkdir(join(f.data.dataDir, "staging", "interrupted"));
    await writeFile(join(f.data.dataDir, "staging", "interrupted", "partial"), "not committed");
    await f.restart();
    expect(await readdir(join(f.data.dataDir, "staging"))).toEqual([]);
  });
});
describe("I9 prefixed public authority and authentication", () => {
  it("serves every read route and SSE via proxy, keeps token out of reads and rejects unauthorized writes", async () => {
    const f = await fixture({
      publicUrl: "http://public.example/artifacts",
      serviceUrl: "http://127.0.0.1:0/artifacts",
    });
    const proxy = createServer(async (req, res) => {
      const upstream = await fetch(`${f.service.address.replace(/artifacts\/$/, "")}${req.url!.slice(1)}`, {
        signal: AbortSignal.timeout(1000),
      });
      const headers = Object.fromEntries(upstream.headers);
      delete headers["transfer-encoding"];
      res.writeHead(upstream.status, headers);
      if (req.url?.endsWith("/api/events")) {
        const reader = upstream.body!.getReader();
        res.write((await reader.read()).value);
        res.end();
        void reader.cancel();
      } else res.end(Buffer.from(await upstream.arrayBuffer()));
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
    const address = proxy.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}/artifacts/`;
    const artifact = await (
      await f.publish(publication({ "index.html": "<h1>x</h1>", "asset.txt": "asset" }))
    ).json();
    expect(artifact.previewUrl).toBe(`http://public.example/artifacts/a/${artifact.id}`);
    for (const path of [
      "",
      `a/${artifact.id}`,
      "viewer.js",
      "viewer.css",
      "api/artifacts",
      `api/artifacts/${artifact.id}`,
      `api/artifacts/${artifact.id}/revisions/1`,
      `api/artifacts/${artifact.id}/revisions/1/source/asset.txt`,
      `preview/${artifact.id}/1/index.html`,
      "api/events",
    ]) {
      const r = await fetch(origin + path);
      expect(r.status, path).toBe(200);
      expect(await r.text()).not.toContain(f.token);
    }
    const denied = await fetch(`${f.service.address}api/artifacts/publish`, {
      method: "POST",
      body: JSON.stringify(publication()),
    });
    expect(denied.status).toBe(401);
  });
  it("rejects malformed config and occupied ports without retaining ownership", async () => {
    const f = await fixture();
    const port = new URL(f.service.address).port;
    const other = await root();
    const config = await configuration(other, { port: Number(port) });
    await expect(startService({ configPath: config.path })).rejects.toMatchObject({ code: "EADDRINUSE" });
    await writeFile(config.path, '{"unknown":true}');
    await expect(startService({ configPath: config.path })).rejects.toThrow("Unknown");
  });
});

describe("I5 deadlines, malformed paths and token diagnostics", () => {
  it("enforces build deadlines without publishing a partial revision", async () => {
    const f = await fixture({ limits: { buildTimeoutMs: 1 } });
    const response = await f.publish(
      publication(
        { "index.tsx": "export default function App(){return <h1>Slow build</h1>}" },
        { kind: "react" },
      ),
    );
    expect(response.status).toBe(503);
    expect((await (await fetch(`${f.service.address}api/artifacts`)).json()).artifacts).toEqual([]);
  });
  it("refuses unavailable operator token files and unsafe HTTP paths", async () => {
    const dir = await root(),
      { path } = await configuration(dir, { tokenFile: join(dir, "missing-token") });
    await expect(startService({ configPath: path })).rejects.toThrow(/token unavailable/);
    const f = await fixture();
    for (const route of [
      "api/artifacts/not-a-uuid",
      "api/artifacts/00000000-0000-0000-0000-000000000000/revisions/0",
      "preview/00000000-0000-0000-0000-000000000000/1/%2e%2e%2fsecret",
    ]) {
      const response = await fetch(f.service.address + route);
      expect(response.status).toBe(400);
    }
  });
});
