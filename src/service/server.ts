import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { loadConfig } from "../shared/config";
import { ArtifactError, fail, Id, mediaType, RevisionNumber } from "../shared/contracts";
import { readToken } from "../shared/files";
import { Store } from "./store";
export type ServiceOptions = { configPath?: string };
export async function startService(options: ServiceOptions = {}) {
  const config = await loadConfig(options.configPath),
    store = new Store(config);
  await store.start();
  let token: string;
  try {
    token = await readToken(config.tokenFile);
  } catch (e) {
    await store.close();
    throw e;
  }
  const prefix = new URL(config.publicUrl).pathname.replace(/\/$/, "");
  const events = new Set<ServerResponse>();
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  };
  const shell = async (res: ServerResponse) => {
    const content = await readFile(
      join(fileURLToPath(new URL("../viewer/", import.meta.url)), "index.html"),
      "utf8",
    );
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(content.replaceAll("__BASE__", `${prefix}/`));
  };
  const server = createServer(async (req, res) => {
    try {
      const raw = (req.url ?? "/").split("?")[0];
      let path: string;
      try {
        path = decodeURIComponent(raw);
      } catch {
        fail(400, "PATH", "Invalid URL encoding.");
      }
      if (path !== prefix && !path.startsWith(`${prefix}/`)) fail(404, "NOT_FOUND", "Route not found.");
      path = path.slice(prefix.length) || "/";
      if (path.split("/").some((s) => s === ".." || s === ".") || path.includes("\\") || path.includes("\0"))
        fail(400, "PATH", "Invalid URL path.");
      if (req.method === "GET" && path === "/health")
        return json(res, 200, { status: "ok", schemaVersion: 1 });
      if (req.method === "POST" && path === "/api/artifacts/publish") {
        const supplied = req.headers.authorization ?? "",
          expected = `Bearer ${token}`;
        if (
          Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
        )
          fail(401, "UNAUTHORIZED", "A valid publish token is required.");
        const abort = new AbortController();
        req.on("aborted", () => abort.abort());
        res.on("close", () => {
          if (!res.writableEnded) abort.abort();
        });
        const chunks: Buffer[] = [];
        let bytes = 0;
        const max = Math.ceil((config.limits.maxTotalBytes * 4) / 3) + config.limits.maxFiles * 2048 + 8192;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > max) fail(413, "LIMIT", "Request exceeds publication limits.");
          chunks.push(chunk);
        }
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          fail(400, "JSON", "Invalid JSON body.");
        }
        const artifact = await store.publish(body, abort.signal);
        json(res, 200, artifact);
        for (const client of events)
          client.write(
            `event: published\ndata: ${JSON.stringify({ id: artifact.id, revision: artifact.revision })}\n\n`,
          );
        return;
      }
      if (req.method !== "GET") fail(404, "NOT_FOUND", "Route not found.");
      if (path === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write("event: ready\ndata: {}\n\n");
        events.add(res);
        req.on("close", () => events.delete(res));
        return;
      }
      if (path === "/api/artifacts") return json(res, 200, { artifacts: store.list() });
      const artifactMatch = path.match(
        /^\/api\/artifacts\/([^/]+)(?:\/revisions\/([^/]+)(?:\/source\/(.+))?)?$/,
      );
      const previewMatch = path.match(/^\/preview\/([^/]+)\/([^/]+)\/(.+)$/);
      const match = artifactMatch ?? previewMatch;
      if (match) {
        const [, id, n, file] = match;
        if (
          !Value.Check(Id, id) ||
          (n !== undefined && (!/^\d+$/.test(n) || !Value.Check(RevisionNumber, Number(n))))
        )
          fail(400, "REFERENCE", "Invalid artifact id or revision.");
        if (!n) return json(res, 200, { revisions: store.revisions(id) });
        if (!file) return json(res, 200, store.get(id, Number(n)));
        const metadata = store.get(id, Number(n));
        if (!previewMatch && !metadata.files.some((f) => f.path === file))
          fail(404, "NOT_FOUND", "Source file not found.");
        let data: Buffer;
        try {
          data = await readFile(store.path(id, Number(n), previewMatch ? "preview" : "source", file));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") fail(404, "NOT_FOUND", "File not found.");
          throw e;
        }
        const type = previewMatch && file === metadata.entrypoint ? "text/html" : mediaType(file);
        const download =
          new URL(req.url ?? "/", config.serviceUrl).searchParams.has("download") ||
          (!previewMatch &&
            !type.startsWith("text/") &&
            type !== "application/json" &&
            type !== "image/svg+xml");
        res.writeHead(200, {
          "Content-Type": type,
          "Cache-Control": "public, max-age=31536000, immutable",
          ...(download
            ? {
                "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.split("/").pop()!)}`,
              }
            : {}),
        });
        res.end(data);
        return;
      }
      if (path === "/" || /^\/a\/[^/]+$/.test(path)) return await shell(res);
      if (path === "/viewer.js" || path === "/viewer.css") {
        const file = path.slice(1);
        const content = await readFile(new URL(`../viewer/${file}`, import.meta.url));
        res.writeHead(200, { "Content-Type": mediaType(file) });
        res.end(content);
        return;
      }
      fail(404, "NOT_FOUND", "Route not found.");
    } catch (e) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const known = e instanceof ArtifactError;
      const status = known ? e.status : (e as Error).name === "AbortError" ? 503 : 500;
      json(res, status, {
        error: {
          code: known ? e.code : "SERVICE",
          message: known ? e.message : "Service operation failed; check service diagnostics and retry.",
        },
      });
      if (!known)
        process.stderr.write(
          `Service operation failed (${(e as NodeJS.ErrnoException).code ?? (e as Error).name}).\n`,
        );
    }
  });
  const heartbeat = setInterval(() => {
    for (const res of events) res.write(": heartbeat\n\n");
  }, 15000);
  heartbeat.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.bindAddress, resolve);
    });
  } catch (e) {
    clearInterval(heartbeat);
    await store.close();
    throw e;
  }
  const bound = server.address();
  if (!bound || typeof bound === "string") throw Error("Expected TCP address.");
  const host = config.bindAddress.includes(":") ? `[${config.bindAddress}]` : config.bindAddress;
  return {
    address: `http://${host}:${bound.port}${prefix}/`,
    async close() {
      clearInterval(heartbeat);
      for (const res of events) res.end();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeIdleConnections();
      });
      await store.close();
    },
  };
}
