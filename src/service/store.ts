import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Value } from "typebox/value";
import { buildPreview } from "../build/preview";
import type { Config } from "../shared/config";
import {
  type ArtifactRevision,
  fail,
  Id,
  mediaType,
  PublishBody,
  type PublishRequest,
  Revision,
  sourcePath,
} from "../shared/contracts";
import { readToken } from "../shared/files";
export const digest = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`)
    .join(",")}}`;
}
export interface Manifest {
  artifact: ArtifactRevision;
  requestId: string;
  inputDigest: string;
  sourceDigests: Record<string, string>;
  previewDigests: Record<string, string>;
}
async function flushDirectory(path: string) {
  const h = await open(path, "r");
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}
async function flushTree(path: string) {
  for (const entry of await readdir(path, { withFileTypes: true }))
    if (entry.isDirectory()) await flushTree(join(path, entry.name));
  await flushDirectory(path);
}
async function write(path: string, data: Buffer | string) {
  await mkdir(dirname(path), { recursive: true });
  const h = await open(path, "wx", 0o600);
  try {
    await h.writeFile(data);
    await h.sync();
  } finally {
    await h.close();
  }
}
export class Store {
  private owner?: ChildProcess;
  private queue: Promise<unknown> = Promise.resolve();
  readonly catalog = new Map<string, Manifest[]>();
  private requests = new Map<string, Manifest>();
  constructor(readonly config: Config) {}
  async start() {
    await mkdir(this.config.dataDir, { recursive: true });
    this.owner = spawn(
      "flock",
      ["--nonblock", join(this.config.dataDir, ".owner.lock"), "sh", "-c", "echo owned; cat >/dev/null"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    await new Promise<void>((resolve, reject) => {
      this.owner!.once("error", reject);
      this.owner!.stdout!.once("data", () => resolve());
      this.owner!.once("exit", () =>
        reject(new Error("Data directory already owned or advisory lock unavailable.")),
      );
    });
    try {
      if (this.config.tokenFile !== join(this.config.dataDir, "publish-token"))
        await readToken(this.config.tokenFile);
      else
        try {
          await write(this.config.tokenFile, `${randomBytes(32).toString("hex")}\n`);
          const h = await open(this.config.tokenFile, "r+");
          try {
            await h.chmod(0o600);
          } finally {
            await h.close();
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
      await mkdir(join(this.config.dataDir, "artifacts"), { recursive: true });
      await rm(join(this.config.dataDir, "staging"), { recursive: true, force: true });
      await mkdir(join(this.config.dataDir, "staging"));
      for (const id of await readdir(join(this.config.dataDir, "artifacts"))) {
        const revDir = join(this.config.dataDir, "artifacts", id, "revisions");
        const entries = await readdir(revDir);
        for (const n of entries) {
          try {
            const m: Manifest = JSON.parse(await readFile(join(revDir, n, "manifest.json"), "utf8"));
            if (
              !Value.Check(Id, id) ||
              !Value.Check(Revision, m.artifact) ||
              m.artifact.id !== id ||
              String(m.artifact.revision) !== n ||
              m.artifact.schemaVersion !== 1 ||
              !m.inputDigest ||
              !m.requestId
            )
              throw Error();
            if (this.requests.has(m.requestId)) throw Error();
            for (const kind of ["source", "preview"] as const) {
              const digests = kind === "source" ? m.sourceDigests : m.previewDigests;
              if (!digests || typeof digests !== "object" || !Object.keys(digests).length) throw Error();
              for (const [path, expected] of Object.entries(digests)) {
                sourcePath(path, kind === "preview");
                if (digest(await readFile(join(revDir, n, kind, path))) !== expected) throw Error();
              }
            }
            if (m.artifact.files.some((f) => m.sourceDigests[f.path] !== f.sha256)) throw Error();
            this.index(m);
          } catch {
            fail(
              503,
              "INTEGRITY",
              `Committed artifact integrity error: ${id} revision ${n}. Restore from backup.`,
            );
          }
        }
      }
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  private index(m: Manifest) {
    const list = this.catalog.get(m.artifact.id) ?? [];
    list.push(m);
    list.sort((a, b) => a.artifact.revision - b.artifact.revision);
    this.catalog.set(m.artifact.id, list);
    this.requests.set(m.requestId, m);
  }
  private metadata(m: Manifest): ArtifactRevision {
    const a = m.artifact;
    const url = `${this.config.publicUrl}a/${a.id}`;
    return { ...a, previewUrl: url, revisionUrl: `${url}?revision=${a.revision}` };
  }
  list() {
    return [...this.catalog.values()].map((a) => this.metadata(a[a.length - 1]));
  }
  revisions(id: string) {
    const list = this.catalog.get(id);
    if (!list) fail(404, "NOT_FOUND", "Artifact not found.");
    return list.map((m) => this.metadata(m));
  }
  get(id: string, n: number) {
    const m = this.catalog.get(id)?.find((m) => m.artifact.revision === n);
    if (!m) fail(404, "NOT_FOUND", "Artifact revision not found.");
    return this.metadata(m);
  }
  path(id: string, n: number, kind: "source" | "preview", path: string) {
    this.get(id, n);
    return join(
      this.config.dataDir,
      "artifacts",
      id,
      "revisions",
      String(n),
      kind,
      sourcePath(path, kind === "preview"),
    );
  }
  publish(input: unknown, signal?: AbortSignal): Promise<ArtifactRevision> {
    const operation = this.queue.then(() => this.commit(input, signal));
    this.queue = operation.catch(() => {});
    return operation;
  }
  private async commit(raw: unknown, signal?: AbortSignal) {
    if (!Value.Check(PublishBody, raw))
      fail(
        400,
        "INVALID_INPUT",
        "Invalid publish request; check requestId, kind, title, files and parentRevision.",
      );
    const input = raw as PublishRequest;
    const inputDigest = digest(canonicalJson(input));
    const prior = this.requests.get(input.requestId);
    if (prior) {
      if (prior.inputDigest !== inputDigest)
        fail(409, "IDEMPOTENCY", "requestId already used with different input.");
      return this.metadata(prior);
    }
    const id = input.id ?? randomUUID(),
      history = this.catalog.get(id) ?? [];
    if (input.id && !history.length) fail(404, "NOT_FOUND", "Artifact does not exist.");
    if (history.length && history[0].artifact.kind !== input.kind)
      fail(409, "KIND", "Artifact kind cannot change.");
    if (input.parentRevision !== null && !history.some((m) => m.artifact.revision === input.parentRevision))
      fail(400, "PARENT", "Parent revision does not exist.");
    if (!history.length && input.parentRevision !== null)
      fail(400, "PARENT", "A new artifact has no parent.");
    if (input.files.length > this.config.limits.maxFiles) fail(413, "LIMIT", "Too many source files.");
    const files = new Map<string, Buffer>();
    let total = 0;
    for (const f of input.files) {
      sourcePath(f.path);
      if (files.has(f.path)) fail(400, "DUPLICATE", "Duplicate source path.");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.base64))
        fail(400, "ENCODING", "Invalid source base64.");
      const bytes = Buffer.from(f.base64, "base64");
      total += bytes.length;
      if (bytes.length > this.config.limits.maxFileBytes || total > this.config.limits.maxTotalBytes)
        fail(413, "LIMIT", "Source byte limit exceeded.");
      files.set(f.path, bytes);
    }
    sourcePath(input.entrypoint);
    if (!files.has(input.entrypoint)) fail(400, "ENTRYPOINT", "Include the entrypoint in files.");
    const stage = join(this.config.dataDir, "staging", input.requestId);
    const deadline = AbortSignal.timeout(this.config.limits.buildTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      combined.throwIfAborted();
      await mkdir(stage);
      const previews = await buildPreview(input.kind, input.entrypoint, files, combined);
      combined.throwIfAborted();
      for (const [path, bytes] of files) {
        combined.throwIfAborted();
        await write(join(stage, "source", path), bytes);
      }
      for (const [path, bytes] of previews) {
        combined.throwIfAborted();
        await write(join(stage, "preview", path), bytes);
      }
      const revision = history.length ? history[history.length - 1].artifact.revision + 1 : 1;
      const url = `${this.config.publicUrl}a/${id}`;
      const artifact: ArtifactRevision = {
        schemaVersion: 1,
        id,
        revision,
        title: input.title,
        kind: input.kind,
        parentRevision: input.parentRevision,
        createdAt: new Date().toISOString(),
        entrypoint: input.entrypoint,
        files: [...files].map(([path, data]) => ({
          path,
          bytes: data.length,
          sha256: digest(data),
          mediaType: mediaType(path),
        })),
        previewUrl: url,
        revisionUrl: `${url}?revision=${revision}`,
      };
      const manifest: Manifest = {
        artifact,
        requestId: input.requestId,
        inputDigest,
        sourceDigests: Object.fromEntries([...files].map(([p, b]) => [p, digest(b)])),
        previewDigests: Object.fromEntries([...previews].map(([p, b]) => [p, digest(b)])),
      };
      await write(join(stage, "manifest.json"), JSON.stringify(manifest));
      await flushTree(stage);
      const revisions = join(this.config.dataDir, "artifacts", id, "revisions");
      await mkdir(revisions, { recursive: true });
      combined.throwIfAborted();
      await rename(stage, join(revisions, String(revision)));
      await flushDirectory(revisions);
      this.index(manifest);
      return artifact;
    } catch (e) {
      await rm(stage, { recursive: true, force: true });
      if (deadline.aborted) fail(503, "DEADLINE", "Build deadline exceeded; simplify the artifact.");
      throw e;
    }
  }
  async close() {
    await this.queue;
    const owner = this.owner;
    if (!owner) return;
    this.owner = undefined;
    await new Promise<void>((resolve) => {
      if (owner.exitCode !== null) return resolve();
      owner.once("exit", () => resolve());
      owner.stdin?.end();
    });
  }
}
