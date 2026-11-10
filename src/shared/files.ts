import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Limits } from "./config";
import { ArtifactError, type CapturedSource, fail, type PublishInput, sourcePath } from "./contracts";
export async function rejectSymlinks(path: string) {
  const absolute = resolve(path);
  let part: string = sep;
  for (const piece of absolute.split(sep).filter(Boolean)) {
    part = join(part, piece);
    if ((await lstat(part)).isSymbolicLink())
      fail(400, "SYMLINK", "Symlinks are not supported; name ordinary source files.");
  }
}
export async function capture(
  input: PublishInput,
  cwd: string,
  limits: Limits,
  signal?: AbortSignal,
): Promise<{ entrypoint: string; files: CapturedSource[] }> {
  if (input.files.length > limits.maxFiles)
    fail(413, "LIMIT", "Too many files; reduce the explicit file list.");
  const entry = resolve(cwd, input.entrypoint),
    root = dirname(entry),
    seen = new Set<string>();
  let total = 0;
  const files: CapturedSource[] = [];
  for (const name of input.files) {
    signal?.throwIfAborted();
    const path = resolve(cwd, name),
      rel = relative(root, path).split(sep).join("/");
    sourcePath(rel);
    if (seen.has(rel)) fail(400, "DUPLICATE", "Duplicate normalized source path.");
    seen.add(rel);
    try {
      await rejectSymlinks(path);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) fail(400, "FILE", "Only ordinary source files may be published.");
        if (stat.size > limits.maxFileBytes) fail(413, "LIMIT", `File too large: ${rel}`);
        const captured = Buffer.alloc(Math.min(limits.maxFileBytes, limits.maxTotalBytes - total) + 1);
        let offset = 0;
        while (offset < captured.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await handle.read(captured, offset, captured.length - offset, null);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const data = captured.subarray(0, offset);
        total += data.length;
        if (data.length > limits.maxFileBytes || total > limits.maxTotalBytes)
          fail(413, "LIMIT", "Publication exceeds byte limits.");
        files.push({ path: rel, base64: data.toString("base64") });
      } finally {
        await handle.close();
      }
    } catch (e) {
      if (e instanceof Error && !(e instanceof ArtifactError) && "code" in e)
        fail(400, "FILE", `Cannot read ${rel}; check existence, permissions and symlinks.`);
      throw e;
    }
  }
  const entrypoint = relative(root, entry).split(sep).join("/");
  if (!seen.has(entrypoint)) fail(400, "ENTRYPOINT", "Include the entrypoint in files.");
  return { entrypoint, files };
}
export async function restore(destination: string, files: { path: string; data: Buffer }[]) {
  const dest = resolve(destination);
  await rejectSymlinks(dirname(dest));
  try {
    await lstat(dest);
    fail(409, "DESTINATION_EXISTS", "Restore destination must not exist.");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const temp = join(dirname(dest), `.pi-artifacts-restore-${randomUUID()}`);
  try {
    await mkdir(temp);
    for (const file of files) {
      const path = join(temp, sourcePath(file.path));
      await mkdir(dirname(path), { recursive: true });
      const h = await open(path, "wx");
      try {
        await h.writeFile(file.data);
        await h.sync();
      } finally {
        await h.close();
      }
    }
    await promisify(execFile)(process.env.PI_ARTIFACTS_MV ?? "mv", [
      "--no-clobber",
      "--no-target-directory",
      temp,
      dest,
    ]);
    try {
      await lstat(temp);
      fail(409, "DESTINATION_EXISTS", "Restore destination must not exist.");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return dest;
}
export async function readToken(path: string) {
  try {
    const token = (await readFile(path, "utf8")).trim();
    if (!token) throw Error();
    return token;
  } catch {
    return fail(503, "TOKEN", "Publish token unavailable; start the service or check tokenFile permissions.");
  }
}
