import { randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { buildPreview, runtimeFeedback } from "../../src/build/preview";
import { Store } from "../../src/service/store";
import { configPath, parseConfig } from "../../src/shared/config";
import { fileUrl, Get, isText, mediaType, Publish, sourcePath } from "../../src/shared/contracts";
import { capture, restore } from "../../src/shared/files";
import { branchReferences } from "../../src/shared/refs";
import { reconcile, type ViewerState } from "../../src/viewer/state";
import { configuration, publication, root } from "../fixtures/helpers";

const id = randomUUID();
describe("U1 shared tool contracts", () => {
  it("rejects invalid tool inputs and accepts explicit files", () => {
    expect(
      Value.Check(Publish, { title: "x", kind: "react", entrypoint: "main.tsx", files: ["main.tsx"] }),
    ).toBe(true);
    for (const data of [
      { title: "", kind: "html", entrypoint: "x", files: ["x"] },
      { title: "a", kind: "vue", entrypoint: "x", files: ["x"] },
    ])
      expect(Value.Check(Publish, data)).toBe(false);
    expect(Value.Check(Get, { id, revision: 0 })).toBe(false);
  });
});
describe("U2 snapshot builders", () => {
  it("wraps HTML and renders Markdown without a CDN", async () => {
    const html = await buildPreview(
      "html",
      "index.html",
      new Map([["index.html", Buffer.from("<head></head><h1>Hello</h1>")]]),
    );
    expect(html.get("index.html")!.toString()).toContain("pi-artifacts-runtime-error");
    const md = await buildPreview(
      "markdown",
      "a.md",
      new Map([["a.md", Buffer.from("# Hi\n\n- one\n\n```js\nconst a=1;\n```\n![x](x.png)")]]),
    );
    expect(md.get("a.md")!.toString()).toMatch(/<h1>Hi<\/h1>/);
    expect(md.get("a.md")!.toString()).toContain('<code class="language-js">');
  });
  it("bundles React, local CSS and all approved libraries", async () => {
    const output = await buildPreview(
      "react",
      "main.tsx",
      new Map([
        [
          "main.tsx",
          Buffer.from(
            "import React from 'react';import {Heart} from 'lucide-react';import {BarChart} from 'recharts';import './style.css';export default function App(){return <div><Heart/><BarChart width={100} height={100}/></div>}",
          ),
        ],
        ["style.css", Buffer.from("body{color:red}")],
      ]),
    );
    expect([...output.keys()].some((k) => k.endsWith(".js"))).toBe(true);
    expect(output.has(".pi-artifacts-tailwind.js")).toBe(true);
  });
});
describe("U3 immutable metadata and text/binary semantics", () => {
  it("maps source types and immutable URLs", () => {
    expect(isText(mediaType("x.png"))).toBe(false);
    expect(isText(mediaType("x.tsx"))).toBe(true);
    expect(fileUrl("https://example.test/p/", id, 2, "a b.png")).toBe(
      `https://example.test/p/api/artifacts/${id}/revisions/2/source/a%20b.png`,
    );
  });
});
const initial: ViewerState = {
  revision: 1,
  pinned: false,
  mode: "source",
  source: "gone.css",
  newer: false,
  connection: "reconnecting",
  sourceChanged: false,
};
describe("U4 viewer reconciliation", () => {
  it("updates Latest retaining mode, replaces missing source", () => {
    expect(reconcile(initial, 2, ["index.html"], "index.html")).toMatchObject({
      revision: 2,
      mode: "source",
      source: "index.html",
      sourceChanged: true,
      connection: "connected",
    });
  });
  it("keeps pinned revisions and indicates newer", () => {
    expect(reconcile({ ...initial, pinned: true }, 3, ["index.html"], "index.html")).toMatchObject({
      revision: 1,
      newer: true,
      mode: "source",
    });
  });
});
describe("U5 actionable failures", () => {
  it("rejects missing imports, default exports and invalid TSX", async () => {
    for (const source of [
      "import X from 'lodash'; export default X;",
      "export const A=1;",
      "export default function(){return <broken}",
      "import X from './missing';export default X",
    ]) {
      await expect(buildPreview("react", "a.tsx", new Map([["a.tsx", Buffer.from(source)]]))).rejects.toThrow(
        /React build failed/,
      );
    }
  });
  it("includes runtime exception and reload handlers", () => {
    expect(runtimeFeedback).toContain("unhandledrejection");
    expect(runtimeFeedback).toContain("Reload");
  });
});
describe("U6 serialization and idempotency", () => {
  it("commits complete distinct revisions and replays request IDs", async () => {
    const dir = await root(),
      { data } = await configuration(dir);
    const store = new Store(data);
    await store.start();
    try {
      const first = publication();
      const a = await store.publish(first);
      expect(await store.publish(first)).toEqual(a);
      const results = await Promise.all([
        store.publish(publication({ "index.html": "A" }, { id: a.id, parentRevision: 1 })),
        store.publish(publication({ "index.html": "B" }, { id: a.id, parentRevision: 1 })),
      ]);
      expect(results.map((r) => r.revision)).toEqual([2, 3]);
      expect(results.map((r) => r.parentRevision)).toEqual([1, 1]);
      await expect(store.publish({ ...first, title: "changed" })).rejects.toMatchObject({ status: 409 });
    } finally {
      await store.close();
    }
  });
});
describe("U7 active branch refs", () => {
  it("reduces primary entries and tool fallback without compaction loss", () => {
    const entries: any[] = [
      { type: "custom", customType: "pi-artifacts.ref.v1", data: { id, revision: 1 } },
      {
        type: "message",
        message: { role: "toolResult", toolName: "artifact_publish", details: { id, revision: 1 } },
      },
      { type: "compaction" },
      { type: "custom", customType: "pi-artifacts.ref.v1", data: { id, revision: 3 } },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "artifact_publish",
          isError: true,
          details: { id, revision: 9 },
        },
      },
    ];
    expect(branchReferences(entries)).toEqual([{ id, revision: 3 }]);
    expect(branchReferences([])).toEqual([]);
  });
});
describe("U8 capture and restore", () => {
  it("captures bytes, rejects escapes/symlinks and preserves binary restore", async () => {
    const dir = await root();
    await writeFile(join(dir, "index.html"), "original");
    await writeFile(join(dir, "image.png"), Buffer.from([0, 255, 1]));
    const { data } = await configuration(dir);
    const captured = await capture(
      { title: "x", kind: "html", entrypoint: "index.html", files: ["index.html", "image.png"] },
      dir,
      data.limits,
    );
    await writeFile(join(dir, "index.html"), "changed");
    expect(Buffer.from(captured.files[0].base64, "base64").toString()).toBe("original");
    await symlink(join(dir, "index.html"), join(dir, "link.html"));
    await expect(
      capture({ title: "x", kind: "html", entrypoint: "link.html", files: ["link.html"] }, dir, data.limits),
    ).rejects.toThrow();
    const destination = join(dir, "restored");
    await restore(
      destination,
      captured.files.map((f) => ({ path: f.path, data: Buffer.from(f.base64, "base64") })),
    );
    expect(await readFile(join(destination, "image.png"))).toEqual(Buffer.from([0, 255, 1]));
    await expect(restore(destination, [])).rejects.toThrow("must not exist");
    await mkdir(join(dir, "empty"));
    await expect(restore(join(dir, "empty"), [])).rejects.toThrow();
  });
});
describe("U9 viewer source selection and path validation", () => {
  it("retains existing selection and rejects decoded escape variants", () => {
    expect(
      reconcile({ ...initial, source: "index.html" }, 2, ["index.html"], "index.html").sourceChanged,
    ).toBe(false);
    for (const path of ["../x", "/x", "a/../x", "a\\b", "a//b"]) expect(() => sourcePath(path)).toThrow();
  });
});
describe("U10 configuration", () => {
  it("defaults to loopback and separates internal/public prefixes", () => {
    const c = parseConfig({
      publicUrl: "https://example.test/artifacts",
      serviceUrl: "http://127.0.0.1:9999/artifacts",
    });
    expect(c.bindAddress).toBe("127.0.0.1");
    expect(c.publicUrl).toBe("https://example.test/artifacts/");
    expect(c.serviceUrl).toBe("http://127.0.0.1:9999/artifacts/");
    expect(configPath("/explicit", { PI_ARTIFACTS_CONFIG: "/env" })).toBe("/explicit");
    expect(configPath(undefined, { PI_ARTIFACTS_CONFIG: "/env" })).toBe("/env");
  });
  it("rejects unknown, malformed and conflicting fields", () => {
    for (const c of [
      { wat: 1 },
      { port: -1 },
      { publicUrl: "ftp://x" },
      { limits: { maxFiles: 0 } },
      { limits: false },
      { limits: 0 },
      { limits: "" },
      { limits: null },
      { limits: { toString: 1 } },
      { port: null },
      { schemaVersion: null },
      { publicUrl: "https://x/p", serviceUrl: "http://127.0.0.1/q" },
    ])
      expect(() => parseConfig(c)).toThrow();
  });
});

describe("U5 bounded capture and deadline", () => {
  it("rejects missing/unreadable source paths, oversize input and abort without committing", async () => {
    const dir = await root(),
      { data } = await configuration(dir, {
        limits: { maxFileBytes: 8, maxTotalBytes: 8, buildTimeoutMs: 1 },
      });
    await writeFile(join(dir, "large.html"), "123456789");
    await expect(
      capture(
        { title: "x", kind: "html", entrypoint: "large.html", files: ["large.html"] },
        dir,
        data.limits,
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      capture(
        { title: "x", kind: "html", entrypoint: "missing.html", files: ["missing.html"] },
        dir,
        data.limits,
      ),
    ).rejects.toThrow("Cannot read");
    const abort = new AbortController();
    abort.abort();
    await expect(
      capture(
        { title: "x", kind: "html", entrypoint: "large.html", files: ["large.html"] },
        dir,
        data.limits,
        abort.signal,
      ),
    ).rejects.toThrow();
  });
});
describe("U6 store integrity", () => {
  it("does not expose staging and refuses malformed committed revisions", async () => {
    const dir = await root(),
      { data } = await configuration(dir);
    const store = new Store(data);
    await store.start();
    const saved = await store.publish(publication());
    await store.close();
    await writeFile(join(data.dataDir, "artifacts", saved.id, "revisions/1/manifest.json"), "{}");
    const restarted = new Store(data);
    await expect(restarted.start()).rejects.toThrow("integrity");
  });
});
