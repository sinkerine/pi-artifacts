import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Config, loadConfig } from "../src/shared/config";
import {
  type ArtifactRevision,
  Get,
  type GetOutput,
  GetResult,
  isText,
  ListResult,
  Publish,
  Revision,
} from "../src/shared/contracts";
import { capture, readToken, restore } from "../src/shared/files";
import { branchReferences } from "../src/shared/refs";

async function request(config: Config, path: string, signal?: AbortSignal, body?: unknown) {
  const url = new URL(path, config.serviceUrl);
  const headers: Record<string, string> = {};
  if (body) {
    headers.Authorization = `Bearer ${await readToken(config.tokenFile)}`;
    headers["Content-Type"] = "application/json";
  }
  const options = {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000),
  };
  let response: Response | undefined;
  for (let attempt = 0; attempt < (body ? 2 : 1); attempt++) {
    try {
      response = await fetch(url, options);
      break;
    } catch {
      signal?.throwIfAborted();
    }
  }
  if (!response)
    throw Error(
      `Artifact service unavailable. Check serviceUrl and start the service; publication may have committed if interrupted. Gallery: ${config.publicUrl}`,
    );
  if (!response.ok) {
    const error = (await response.json()) as { error: { message: string } };
    throw Error(error.error.message);
  }
  return response;
}
function result<T>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
    structuredContent: JSON.parse(JSON.stringify(data)),
  };
}
function referenced(ctx: ExtensionContext, id: string) {
  const ref = branchReferences(ctx.sessionManager.getBranch()).find((r) => r.id === id);
  if (!ref)
    throw Error(
      "Artifact is not referenced on this conversation branch; list this branch’s artifacts first.",
    );
  return ref;
}
async function metadata(
  config: Config,
  id: string,
  n: number,
  signal?: AbortSignal,
): Promise<ArtifactRevision> {
  try {
    return (await (
      await request(config, `api/artifacts/${id}/revisions/${n}`, signal)
    ).json()) as ArtifactRevision;
  } catch (e) {
    throw Error(`Referenced artifact ${id} revision ${n} is unavailable: ${(e as Error).message}`);
  }
}
export default function artifacts(pi: ExtensionAPI) {
  const guidance = async (ctx: ExtensionContext) => {
    const config = await loadConfig();
    return `Artifacts: write explicit HTML/CSS/JS, React/TSX default-exported components, or Markdown files under ${join(config.workDir, ctx.sessionManager.getSessionId(), "<artifact-name>")}. Publish with artifact_publish and an explicit file list including every local import/asset. React imports: react, react-dom, lucide-react, recharts and public subpaths; Tailwind utilities are bundled. Published snapshots are immutable. No sandbox: previews run trusted code. No daemon is started by this extension. In-memory sessions cannot resume.`;
  };
  pi.on("session_start", async (_e, ctx) => {
    branchReferences(ctx.sessionManager.getBranch());
  });
  pi.on("session_tree", async (_e, ctx) => {
    branchReferences(ctx.sessionManager.getBranch());
  });
  pi.on("before_agent_start", async (_event, ctx) => ({
    message: { customType: "pi-artifacts.guidance", content: await guidance(ctx), display: false },
  }));
  pi.registerTool({
    name: "artifact_publish",
    label: "Publish artifact",
    description:
      "Capture explicitly named files and publish an immutable HTML, React or Markdown revision. Returns Latest and pinned viewer links.",
    parameters: Publish,
    outputSchema: Revision,
    executionMode: "sequential",
    async execute(_call, input, signal, _update, ctx) {
      const config = await loadConfig();
      const parent = input.id ? referenced(ctx, input.id).revision : null;
      const captured = await capture(input, ctx.cwd, config.limits, signal);
      const body = { ...input, ...captured, parentRevision: parent, requestId: randomUUID() };
      const artifact = (await (
        await request(config, "api/artifacts/publish", signal, body)
      ).json()) as ArtifactRevision;
      pi.appendEntry("pi-artifacts.ref.v1", { id: artifact.id, revision: artifact.revision });
      return result(artifact);
    },
  });
  pi.registerTool({
    name: "artifact_list",
    label: "List artifacts",
    description:
      "List exact artifact revisions referenced on the active conversation branch, newest reference first.",
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema: ListResult,
    async execute(_call, _input, signal, _update, ctx) {
      const config = await loadConfig();
      const artifacts = [];
      for (const ref of branchReferences(ctx.sessionManager.getBranch()))
        artifacts.push(await metadata(config, ref.id, ref.revision, signal));
      return result({ artifacts });
    },
  });
  pi.registerTool({
    name: "artifact_get",
    label: "Get artifact",
    description:
      "Read original sources of a branch-referenced artifact; optionally restore bytes into a destination that does not exist.",
    parameters: Get,
    outputSchema: GetResult,
    async execute(_call, input, signal, _update, ctx) {
      const config = await loadConfig(),
        ref = referenced(ctx, input.id);
      const artifact = await metadata(config, input.id, input.revision ?? ref.revision, signal);
      let remaining = 65536;
      let truncated = false;
      const sources: GetOutput["sources"] = [],
        files: { path: string; data: Buffer }[] = [];
      for (const info of artifact.files) {
        const relative = `api/artifacts/${artifact.id}/revisions/${artifact.revision}/source/${info.path.split("/").map(encodeURIComponent).join("/")}`;
        const data = Buffer.from(await (await request(config, relative, signal)).arrayBuffer());
        files.push({ path: info.path, data });
        if (isText(info.mediaType)) {
          const text = data.subarray(0, remaining).toString("utf8");
          if (data.length > remaining) truncated = true;
          remaining = Math.max(0, remaining - data.length);
          sources.push({ ...info, text });
        } else sources.push(info);
      }
      const restoredTo = input.restoreTo
        ? await restore(resolve(ctx.cwd, input.restoreTo), files)
        : undefined;
      return result({
        artifact,
        sources,
        sourceTextTruncated: truncated,
        ...(restoredTo ? { restoredTo } : {}),
      });
    },
  });
  pi.registerCommand("artifacts", {
    description: "Print the artifact gallery or a branch-referenced pinned link",
    async handler(args, ctx) {
      const config = await loadConfig();
      let link = config.publicUrl;
      if (args.trim()) {
        const ref = referenced(ctx, args.trim());
        link = (await metadata(config, ref.id, ref.revision)).revisionUrl;
      }
      pi.sendMessage(
        { customType: "pi-artifacts.link", content: link, display: true },
        { triggerTurn: false },
      );
    },
  });
}
