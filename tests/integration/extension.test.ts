import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createEventBus,
  createExtensionRuntime,
  type ExtensionContext,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import artifacts from "../../extensions/artifacts";
import { loadExtensionFromFactory } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { startService } from "../../src/service/server";
import type { ArtifactRevision } from "../../src/shared/contracts";
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
async function freshRuntime(
  dir: string,
  manager: SessionManager,
  reason: "startup" | "new" | "resume" | "fork" | "reload",
) {
  const runtime = createExtensionRuntime();
  const writes: { type: string; data: unknown }[] = [];
  runtime.appendEntry = (type, data) => {
    writes.push({ type, data });
    manager.appendCustomEntry(type, data);
  };
  const extension = await loadExtensionFromFactory(artifacts, dir, createEventBus(), runtime);
  const models = await ModelRuntime.create({
    authPath: join(dir, "disposable-auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "model-store.json"),
    refreshOnCreate: false,
  });
  const runner = new ExtensionRunner([extension], runtime, dir, manager, new ModelRegistry(models));
  const errors: unknown[] = [];
  runner.onError((error) => errors.push(error));
  await runner.emit({ type: "session_start", reason });
  expect(errors).toEqual([]);
  const context = runner.createToolContext("call", undefined);
  const invoke = (name: string, input: unknown) =>
    runner.getToolDefinition(name)!.execute("call", input, undefined, undefined, context);
  return { runtime, runner, context, invoke, writes, errors };
}
describe("I5 real failed tool build diagnostics", () => {
  it("preserves import/default/TSX guidance without leaking Nix or server paths", async () => {
    const f = await setup();
    const source = join(f.dir, "diagnostic.tsx");
    for (const [content, guidance] of [
      ["import X from 'unapproved';export default X", /Unsupported import unapproved/],
      ["export const A=1", /default/],
      ["export default function App(){return <broken}", /diagnostic\.tsx:1:\d+/],
    ] as const) {
      await writeFile(source, content);
      const failure = await f
        .invoke("artifact_publish", { title: "Invalid", kind: "react", entrypoint: source, files: [source] })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toMatch(guidance);
      expect(message).toContain("Export a default component");
      for (const serverPath of ["/nix/store/", "node_modules/esbuild/lib/main.js", f.dir, process.cwd()])
        expect(message).not.toContain(serverPath);
      expect(branchReferences(f.session.getBranch())).toEqual([]);
    }
  });
});
describe("I7 real branch/fork/clone/compaction and runtime replacement", () => {
  it("restores branch refs through fresh new/resume/fork/clone/reload runtimes and rejects stale contexts", async () => {
    const f = await setup();
    const active = await freshRuntime(f.dir, f.session, "startup");
    const source = join(f.dir, "a.html");
    await writeFile(source, "one");
    const one = (
      await active.invoke("artifact_publish", {
        title: "A",
        kind: "html",
        entrypoint: source,
        files: [source],
      })
    ).details as ArtifactRevision;
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
    await active.invoke("artifact_publish", {
      id: one.id,
      title: "A2",
      kind: "html",
      entrypoint: source,
      files: [source],
    });
    const secondRef = f.session.getLeafId();
    expect((await active.invoke("artifact_get", { id: one.id })).details).toMatchObject({
      artifact: { revision: 2 },
    });
    f.session.branch(firstRef);
    await active.runner.emit({ type: "session_tree", oldLeafId: secondRef, newLeafId: firstRef });
    expect(active.errors).toEqual([]);
    expect((await active.invoke("artifact_get", { id: one.id })).details).toMatchObject({
      artifact: { revision: 1 },
    });
    expect((await active.invoke("artifact_list", {})).details).toMatchObject({
      artifacts: [{ id: one.id, revision: 1 }],
    });
    const custom = f.session.appendCustomEntry("preserved", { x: 1 });
    f.session.appendCompaction("summary", custom, 100);
    f.session.appendMessage({ role: "user", content: "persist branch", timestamp: Date.now() });
    const branchFile = f.session.createBranchedSession(f.session.getLeafId()!)!;
    const oldWrites = [...active.writes];
    const oldEntries = f.session.getEntries();
    await active.runner.emit({
      type: "session_shutdown",
      reason: "resume",
      targetSessionFile: f.session.getSessionFile()!,
    });
    active.runner.invalidate();
    const resumedManager = SessionManager.open(f.session.getSessionFile()!);
    const resumed = await freshRuntime(f.dir, resumedManager, "resume");
    expect(resumed.runtime).not.toBe(active.runtime);
    expect(resumed.context === active.context).toBe(false);
    expect((await resumed.invoke("artifact_list", {})).details).toMatchObject({
      artifacts: [{ id: one.id, revision: 1 }],
    });
    expect((await resumed.invoke("artifact_get", { id: one.id })).details).toMatchObject({
      artifact: { revision: 1 },
      sources: [{ text: "one" }],
    });
    expect((await resumed.invoke("artifact_get", { id: one.id, revision: 2 })).details).toMatchObject({
      artifact: { revision: 2 },
    });
    for (const manager of [
      SessionManager.open(branchFile),
      SessionManager.forkFrom(branchFile, f.dir, join(f.dir, "forks")),
    ]) {
      const copied = await freshRuntime(f.dir, manager, "fork");
      expect((await copied.invoke("artifact_list", {})).details).toMatchObject({
        artifacts: [{ id: one.id, revision: 1 }],
      });
      expect((await copied.invoke("artifact_get", { id: one.id })).details).toMatchObject({
        artifact: { revision: 1 },
      });
      copied.runner.invalidate();
    }
    const unrelated = await freshRuntime(
      f.dir,
      SessionManager.create(f.dir, join(f.dir, "unrelated")),
      "new",
    );
    const memory = await freshRuntime(f.dir, SessionManager.inMemory(f.dir), "new");
    for (const fresh of [unrelated, memory]) {
      expect((await fresh.invoke("artifact_list", {})).details).toEqual({ artifacts: [] });
      await expect(fresh.invoke("artifact_get", { id: one.id })).rejects.toThrow("not referenced");
    }
    await writeFile(source, "resumed runtime child");
    const resumedChild = (
      await resumed.invoke("artifact_publish", {
        id: one.id,
        title: "After resume",
        kind: "html",
        entrypoint: source,
        files: [source],
      })
    ).details;
    expect(resumedChild).toMatchObject({ id: one.id, revision: 3, parentRevision: 1 });
    expect((await resumed.invoke("artifact_get", { id: one.id })).details).toMatchObject({
      artifact: { revision: 3 },
      sources: [{ text: "resumed runtime child" }],
    });
    const resumedWrites = [...resumed.writes];
    const reloadEntries = resumedManager.getEntries();
    await resumed.runner.emit({ type: "session_shutdown", reason: "reload" });
    resumed.runner.invalidate();
    const reloadedManager = SessionManager.open(resumedManager.getSessionFile()!);
    const reloaded = await freshRuntime(f.dir, reloadedManager, "reload");
    expect((await reloaded.invoke("artifact_list", {})).details).toMatchObject({
      artifacts: [{ id: one.id, revision: 3 }],
    });
    await writeFile(source, "fresh runtime child");
    const child = (
      await reloaded.invoke("artifact_publish", {
        id: one.id,
        title: "After reload",
        kind: "html",
        entrypoint: source,
        files: [source],
      })
    ).details;
    expect(child).toMatchObject({ id: one.id, revision: 4, parentRevision: 3 });
    expect((await reloaded.invoke("artifact_get", { id: one.id })).details).toMatchObject({
      artifact: { revision: 4 },
      sources: [{ text: "fresh runtime child" }],
    });
    expect((await reloaded.invoke("artifact_list", {})).details).toMatchObject({
      artifacts: [{ id: one.id, revision: 4 }],
    });
    await expect(
      active.invoke("artifact_publish", {
        id: one.id,
        title: "stale",
        kind: "html",
        entrypoint: source,
        files: [source],
      }),
    ).rejects.toThrow(/stale/);
    await expect(resumed.invoke("artifact_list", {})).rejects.toThrow(/stale/);
    expect(active.writes).toEqual(oldWrites);
    expect(resumed.writes).toEqual(resumedWrites);
    expect(f.session.getEntries()).toEqual(oldEntries);
    expect(resumedManager.getEntries()).toEqual(reloadEntries);
    expect(reloaded.writes).toEqual([{ type: "pi-artifacts.ref.v1", data: { id: one.id, revision: 4 } }]);
    expect((await unrelated.invoke("artifact_list", {})).details).toEqual({ artifacts: [] });
    const own = (
      await unrelated.invoke("artifact_publish", {
        title: "New session",
        kind: "html",
        entrypoint: source,
        files: [source],
      })
    ).details as ArtifactRevision;
    expect(own.id).not.toBe(one.id);
    expect((await unrelated.invoke("artifact_get", { id: own.id })).details).toMatchObject({
      artifact: { id: own.id, revision: 1 },
    });
    expect((await unrelated.invoke("artifact_list", {})).details).toMatchObject({
      artifacts: [{ id: own.id, revision: 1 }],
    });
    expect(active.writes).toEqual(oldWrites);
    expect(resumed.writes).toEqual(resumedWrites);
    for (const runtime of [active, resumed, reloaded, unrelated, memory]) expect(runtime.errors).toEqual([]);
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
