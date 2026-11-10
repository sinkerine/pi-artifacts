import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { startService }: typeof import("../../src/service/server") = await import(
  resolve("dist/service/server.js")
);

import type { ArtifactRevision, PublishRequest } from "../../src/shared/contracts";
import { configuration, publication, root } from "../fixtures/helpers";
import { serviceProcess } from "../fixtures/service-process";

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
  it("returns source-relative build guidance without dependency or server paths", async () => {
    const f = await fixture();
    const cases = [
      {
        source: "import X from 'unapproved';export default X",
        guidance: /Unsupported import unapproved.*Allowed:/s,
        location: true,
      },
      { source: "export const A=1", guidance: /default/, location: false },
      {
        source: "export default function App(){return <broken}",
        guidance: /Expected|Unexpected|Unterminated/,
        location: true,
      },
      {
        source:
          "import X from '/nix/store/test-dependency/node_modules/esbuild/lib/main.js';export default X",
        guidance: /Missing local import.*explicit file list/s,
        location: true,
      },
    ];
    for (const { source, guidance, location } of cases) {
      const response = await f.publish(publication({ "components/main.tsx": source }, { kind: "react" }));
      expect(response.status).toBe(422);
      const message: string = (await response.json()).error.message;
      expect(message).toMatch(guidance);
      expect(message).toContain("Export a default component");
      if (location) expect(message).toMatch(/components\/main\.tsx:1:\d+:/);
      for (const serverPath of ["/nix/store/", "/node_modules/", "esbuild/lib/main.js", process.cwd(), f.dir])
        expect(message).not.toContain(serverPath);
      expect(message).not.toMatch(/(?:^|[\s"'(])(?:\/|[A-Za-z]:[\\/])/);
    }
    expect((await (await fetch(`${f.service.address}api/artifacts`)).json()).artifacts).toEqual([]);
    expect(await readdir(join(f.data.dataDir, "staging"))).toEqual([]);
  });
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
  for (const target of ["source/index.html", "preview/index.html", "manifest.json"]) {
    it(`returns HTTP failure and cleans staging when the actual ${target} flush fails`, async () => {
      const dir = await root(),
        { path, data } = await configuration(dir);
      const update = publication({ "index.html": "never committed" });
      const stage = join(data.dataDir, "staging", update.requestId);
      const service = await serviceProcess(dir, path, { path: join(stage, target), action: "fail" });
      cleanup.push(() => service.stop("SIGKILL"));
      const initial = (await (await service.publish(publication())).json()) as ArtifactRevision;
      update.id = initial.id;
      update.parentRevision = 1;
      const before = await treeDigest(join(data.dataDir, "artifacts"));
      const response = await service.publish(update);
      expect(await service.boundary).toMatchObject({ path: join(stage, target), operation: "sync" });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(data.dataDir);
      expect(await readdir(join(data.dataDir, "staging"))).toEqual([]);
      expect(await treeDigest(join(data.dataDir, "artifacts"))).toEqual(before);
      expect((await (await fetch(`${service.address}api/artifacts`)).json()).artifacts).toEqual([initial]);
      expect(
        (await (await fetch(`${service.address}api/artifacts/${initial.id}`)).json()).revisions,
      ).toHaveLength(1);
    });
  }
  it("aborts an HTTP publication while an actual staging flush is in progress", async () => {
    const dir = await root(),
      { path, data } = await configuration(dir);
    const update = publication({ "index.html": "cancel while staging" });
    const stage = join(data.dataDir, "staging", update.requestId);
    const service = await serviceProcess(dir, path, {
      path: join(stage, "source/index.html"),
      action: "block",
    });
    cleanup.push(() => service.stop("SIGKILL"));
    const initial = (await (await service.publish(publication())).json()) as ArtifactRevision;
    Object.assign(update, { id: initial.id, parentRevision: 1 });
    const before = await treeDigest(join(data.dataDir, "artifacts"));
    const controller = new AbortController();
    const pending = service.publish(update, controller.signal).catch((error: unknown) => error);
    await service.boundary;
    expect(await readFile(join(stage, "source/index.html"), "utf8")).toBe("cancel while staging");
    expect((await (await fetch(`${service.address}api/artifacts`)).json()).artifacts).toEqual([initial]);
    controller.abort();
    expect(await pending).toBeInstanceOf(Error);
    await service.disconnected;
    service.release();
    await expect.poll(() => readdir(join(data.dataDir, "staging"))).toEqual([]);
    expect(await treeDigest(join(data.dataDir, "artifacts"))).toEqual(before);
    expect((await (await fetch(`${service.address}api/artifacts`)).json()).artifacts).toEqual([initial]);
    expect(
      (await (await fetch(`${service.address}api/artifacts/${initial.id}`)).json()).revisions,
    ).toHaveLength(1);
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
  });
  it("recovers an interrupted real publisher and process ownership after SIGKILL", async () => {
    const dir = await root(),
      { path, data } = await configuration(dir);
    const update = publication({ "index.html": "interrupted bytes" });
    const stage = join(data.dataDir, "staging", update.requestId);
    const first = await serviceProcess(dir, path, {
      path: join(stage, "preview/index.html"),
      action: "block",
    });
    cleanup.push(() => first.stop("SIGKILL"));
    const initial = (await (await first.publish(publication())).json()) as ArtifactRevision;
    Object.assign(update, { id: initial.id, parentRevision: 1 });
    const before = await treeDigest(join(data.dataDir, "artifacts"));
    await expect(serviceProcess(dir, path)).rejects.toThrow(/already owned/);
    const pending = first.publish(update).catch((error: unknown) => error);
    await first.boundary;
    expect(await readFile(join(stage, "source/index.html"), "utf8")).toBe("interrupted bytes");
    expect(await readFile(join(stage, "preview/index.html"), "utf8")).toContain("interrupted bytes");
    expect(await readdir(stage)).not.toContain("manifest.json");
    expect(await treeDigest(join(data.dataDir, "artifacts"))).toEqual(before);
    expect((await (await fetch(`${first.address}api/artifacts`)).json()).artifacts).toEqual([initial]);
    await first.stop("SIGKILL");
    expect(first.proc.signalCode).toBe("SIGKILL");
    expect(await pending).toBeInstanceOf(Error);
    expect(await readdir(join(data.dataDir, "staging"))).toEqual([update.requestId]);
    const restarted = await serviceProcess(dir, path);
    cleanup.push(() => restarted.stop("SIGKILL"));
    expect(await readdir(join(data.dataDir, "staging"))).toEqual([]);
    expect(await treeDigest(join(data.dataDir, "artifacts"))).toEqual(before);
    expect((await (await fetch(`${restarted.address}api/artifacts`)).json()).artifacts).toEqual([initial]);
    expect(
      (await (await fetch(`${restarted.address}api/artifacts/${initial.id}`)).json()).revisions,
    ).toHaveLength(1);
    expect((await fetch(`${restarted.address}preview/${initial.id}/2/index.html`)).status).toBe(404);
    const committed = await restarted.publish(update);
    expect(committed.status).toBe(200);
    expect(await committed.json()).toMatchObject({ id: initial.id, revision: 2, parentRevision: 1 });
    for (const [file, hash] of Object.entries(before))
      expect((await treeDigest(join(data.dataDir, "artifacts")))[file]).toBe(hash);
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
