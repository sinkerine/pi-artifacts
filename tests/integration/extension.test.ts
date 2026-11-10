import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createEventBus,
  createExtensionRuntime,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import artifacts from "../../extensions/artifacts";
import { loadExtensionFromFactory } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { startService } from "../../src/service/server";
import { branchReferences } from "../../src/shared/refs";
import { configuration, root } from "../fixtures/helpers";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  delete process.env.PI_ARTIFACTS_CONFIG;
});
async function setup() {
  const dir = await root(),
    { path } = await configuration(dir);
  const service = await startService({ configPath: path });
  closes.push(() => service.close());
  const config = JSON.parse(await readFile(path, "utf8"));
  config.serviceUrl = service.address;
  await writeFile(path, JSON.stringify(config));
  process.env.PI_ARTIFACTS_CONFIG = path;
  const runtime = createExtensionRuntime(),
    session = SessionManager.create(dir, join(dir, "sessions"));
  runtime.appendEntry = (type, data) => {
    session.appendCustomEntry(type, data);
  };
  runtime.sendMessage = () => {};
  const extension = await loadExtensionFromFactory(artifacts, dir, createEventBus(), runtime);
  const context = (mode: string, manager = session) =>
    ({ cwd: dir, mode, sessionManager: manager, hasUI: false }) as unknown as ExtensionContext;
  const invoke = (name: string, input: unknown, ctx = context("json")) =>
    extension.tools.get(name)!.definition.execute("call", input as any, undefined, undefined, ctx as any);
  return { dir, session, context, extension, runtime, invoke };
}
describe("I1 actual Pi SDK extension registration", () => {
  it("registers schemas/command and works in tui/rpc/json/print with no UI dialogs", async () => {
    const f = await setup();
    expect([...f.extension.tools.keys()]).toEqual(["artifact_publish", "artifact_list", "artifact_get"]);
    expect(f.extension.commands.has("artifacts")).toBe(true);
    for (const mode of ["tui", "rpc", "json", "print"]) {
      const ctx = f.context(mode);
      for (const handler of f.extension.handlers.get("session_start") ?? []) await handler({}, ctx);
      const list = await f.invoke("artifact_list", {}, ctx);
      expect(list.details).toEqual({
        artifacts: expect.any(Array),
      });
      expect(
        Value.Check(f.extension.tools.get("artifact_list")!.definition.outputSchema!, list.structuredContent),
      ).toBe(true);
      const messages: any[] = [];
      f.runtime.sendMessage = (m, o) => {
        messages.push({ m, o });
      };
      await f.extension.commands.get("artifacts")!.handler("", ctx as any);
      expect(messages[0].o.triggerTurn).toBe(false);
      expect(messages[0].m.content).toMatch(/^http:/);
      const source = join(f.dir, `${mode}.html`);
      const content = `<button>${mode}</button>`;
      await writeFile(source, content);
      const published = await f.invoke(
        "artifact_publish",
        { title: mode, kind: "html", entrypoint: source, files: [source] },
        ctx,
      );
      expect(
        Value.Check(
          f.extension.tools.get("artifact_publish")!.definition.outputSchema!,
          published.structuredContent,
        ),
      ).toBe(true);
      const artifact = published.details as { id: string; revision: number };
      const fetched = await f.invoke("artifact_get", { id: artifact.id }, ctx);
      expect(
        Value.Check(
          f.extension.tools.get("artifact_get")!.definition.outputSchema!,
          fetched.structuredContent,
        ),
      ).toBe(true);
      expect(fetched.details).toMatchObject({
        artifact: { id: artifact.id, revision: 1 },
        sources: [{ path: `${mode}.html`, text: content }],
        sourceTextTruncated: false,
      });
      const listed = (await f.invoke("artifact_list", {}, ctx)).details as {
        artifacts: { id: string; revision: number }[];
      };
      expect(listed.artifacts[0]).toMatchObject({ id: artifact.id, revision: 1 });
      await f.extension.commands.get("artifacts")!.handler(artifact.id, ctx as any);
      expect(messages.at(-1).m.content).toContain(`a/${artifact.id}?revision=1`);
    }
    expect(branchReferences(f.session.getBranch())).toHaveLength(4);
  });
});
describe("I7 real branch/fork/clone/compaction and runtime replacement", () => {
  it("keeps branch-local refs while global latest advances and unrelated/in-memory contexts stay separate", async () => {
    const f = await setup();
    const source = join(f.dir, "a.html");
    await writeFile(source, "one");
    const one = (
      await f.invoke("artifact_publish", { title: "A", kind: "html", entrypoint: source, files: [source] })
    ).details as any;
    const firstRef = f.session.getLeafId()!;
    f.session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "published" }],
      api: "openai-completions",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    f.session.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
    await writeFile(source, "two");
    await f.invoke("artifact_publish", {
      id: one.id,
      title: "A2",
      kind: "html",
      entrypoint: source,
      files: [source],
    });
    expect((await f.invoke("artifact_get", { id: one.id })).details).toMatchObject({
      artifact: { revision: 2 },
    });
    f.session.branch(firstRef);
    for (const handler of f.extension.handlers.get("session_tree") ?? [])
      await handler({}, f.context("json"));
    expect((await f.invoke("artifact_get", { id: one.id })).details).toMatchObject({
      artifact: { revision: 1 },
    });
    const custom = f.session.appendCustomEntry("preserved", { x: 1 });
    f.session.appendCompaction("summary", custom, 100);
    f.session.appendMessage({ role: "user", content: "persist branch", timestamp: Date.now() });
    expect(branchReferences(f.session.getBranch())).toEqual([{ id: one.id, revision: 1 }]);
    const branchFile = f.session.createBranchedSession(f.session.getLeafId()!)!;
    const cloned = SessionManager.open(branchFile);
    expect(branchReferences(cloned.getBranch())).toEqual([{ id: one.id, revision: 1 }]);
    const fork = SessionManager.forkFrom(branchFile, f.dir, join(f.dir, "forks"));
    expect(branchReferences(fork.getBranch())).toEqual([{ id: one.id, revision: 1 }]);
    const unrelated = SessionManager.inMemory(f.dir);
    expect((await f.invoke("artifact_list", {}, f.context("print", unrelated))).details).toEqual({
      artifacts: [],
    });
    await expect(f.invoke("artifact_get", { id: one.id }, f.context("json", unrelated))).rejects.toThrow(
      "not referenced",
    );
    expect((await f.invoke("artifact_get", { id: one.id, revision: 2 })).details).toMatchObject({
      artifact: { revision: 2 },
    });
  });
});
describe("I8 byte-preserving restoration outside projects", () => {
  it("restores without writes to existing destinations and publishes a child", async () => {
    const f = await setup();
    const a = join(f.dir, "project-A"),
      b = join(f.dir, "project-B"),
      work = join(f.dir, "external");
    await mkdir(a);
    await mkdir(b);
    await mkdir(work);
    await writeFile(join(work, "index.html"), "original");
    await writeFile(join(work, "binary.png"), Buffer.from([0, 255, 1, 128]));
    const beforeA = await readdir(a),
      beforeB = await readdir(b);
    const published = (
      await f.invoke("artifact_publish", {
        title: "Restorable",
        kind: "html",
        entrypoint: join(work, "index.html"),
        files: [join(work, "index.html"), join(work, "binary.png")],
      })
    ).details as any;
    const target = join(f.dir, "restore");
    const restored = (await f.invoke("artifact_get", { id: published.id, restoreTo: target })).details as any;
    expect(restored.restoredTo).toBe(target);
    expect(await readFile(join(target, "binary.png"))).toEqual(Buffer.from([0, 255, 1, 128]));
    await expect(f.invoke("artifact_get", { id: published.id, restoreTo: target })).rejects.toThrow(
      "must not exist",
    );
    await writeFile(join(target, "index.html"), "child");
    const child = (
      await f.invoke("artifact_publish", {
        id: published.id,
        title: "Child",
        kind: "html",
        entrypoint: join(target, "index.html"),
        files: [join(target, "index.html"), join(target, "binary.png")],
      })
    ).details as any;
    expect(child.parentRevision).toBe(1);
    expect(await readdir(a)).toEqual(beforeA);
    expect(await readdir(b)).toEqual(beforeB);
  });
});
