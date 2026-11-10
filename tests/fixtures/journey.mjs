import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join, resolve } from "node:path";
import { isolatedEnvironment } from "../../scripts/environment.mjs";

/** @param {string} path @returns {Promise<Record<string, string>>} */
export async function digestTree(path) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      for (const [name, hash] of Object.entries(await digestTree(child))) out[`${entry.name}/${name}`] = hash;
    } else
      out[entry.name] = createHash("sha256")
        .update(await readFile(child))
        .digest("hex");
  }
  return out;
}
export async function journey() {
  const root = process.env.ARTIFACTS_E2E_ROOT;
  const packageArg = process.env.ARTIFACTS_E2E_PACKAGE;
  if (!root || !packageArg) throw Error("Journey requires an isolated root and package.");
  const packagePath = await realpath(packageArg);
  const env = await isolatedEnvironment(join(root, "state"));
  const logs = join(root, "logs");
  await mkdir(logs, { recursive: true });
  const configPath = join(root, "config.json"),
    projectA = join(root, "project-A"),
    projectB = join(root, "project-B");
  await mkdir(projectA);
  await mkdir(projectB);
  const config = {
    schemaVersion: 1,
    port: 0,
    publicUrl: "http://127.0.0.1:0/artifacts/",
    serviceUrl: "http://127.0.0.1:0/artifacts/",
    dataDir: join(root, "store"),
    workDir: join(root, "work"),
  };
  env.PI_ARTIFACTS_CONFIG = configPath;
  /** @type {import("node:child_process").ChildProcessWithoutNullStreams | undefined} */
  let service;
  let internal = "",
    publicUrl = "",
    sequence = 0;
  /** @type {Set<import("node:child_process").ChildProcessWithoutNullStreams>} */
  const children = new Set();
  process.once("exit", () => {
    for (const proc of children) proc.kill("SIGTERM");
  });
  /** @param {string} command @param {string[]} args @param {{cwd?: string}} options */
  async function child(command, args, options = {}) {
    const proc = spawn(command, args, { env, cwd: projectA, ...options });
    children.add(proc);
    proc.once("exit", () => children.delete(proc));
    return proc;
  }
  async function stopService() {
    if (!service) return;
    const proc = service;
    service = undefined;
    if (proc.exitCode !== null) return;
    await new Promise(
      /** @param {(value: void) => void} resolve */ (resolve, reject) => {
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(Error("Service did not stop."));
        }, 10000);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        proc.kill("SIGTERM");
      },
    );
  }
  async function start() {
    await writeFile(configPath, JSON.stringify(config));
    const run = ++sequence;
    const proc = await child(join(packagePath, "bin/pi-artifacts"), ["serve", "--config", configPath]);
    service = proc;
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
      void writeFile(join(logs, `service-${run}.stderr`), stderr);
    });
    const record = await new Promise(
      /** @param {(value: {address: string}) => void} resolve */ (resolve, reject) => {
        let text = "";
        const timer = setTimeout(() => reject(Error(`Service readiness timed out: ${stderr}`)), 15000);
        proc.stdout.on("data", (chunk) => {
          text += chunk;
          void writeFile(join(logs, `service-${run}.stdout`), text);
          const line = text.split("\n").find((line) => line.startsWith("{"));
          if (line) {
            clearTimeout(timer);
            resolve(JSON.parse(line));
          }
        });
        proc.once("exit", (code) => {
          clearTimeout(timer);
          reject(Error(`Service exited ${code}: ${stderr}`));
        });
      },
    );
    internal = record.address;
    config.serviceUrl = internal;
    await writeFile(configPath, JSON.stringify(config));
    return record;
  }
  await start();
  const proxy = createServer((req, res) => {
    const upstream = request(
      new URL((req.url ?? "/").slice(1), internal.replace(/artifacts\/$/, "")),
      { method: req.method, headers: req.headers },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(503);
      res.end();
    });
    req.pipe(upstream);
    res.on("close", () => upstream.destroy());
  });
  await new Promise(
    /** @param {(value: void) => void} resolve */ (resolve) => proxy.listen(0, "127.0.0.1", resolve),
  );
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === "string") throw Error("Expected TCP proxy.");
  publicUrl = `http://127.0.0.1:${proxyAddress.port}/artifacts/`;
  config.publicUrl = publicUrl;
  await stopService();
  await start();
  /** @type {import("./journey-types.ts").ScriptedToolCall[]} */
  let queued = [];
  /** @type {{model: string, toolNames?: string[], step: string}[]} */
  const modelCalls = [];
  const fixture = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const c of req) body += c;
      const input = /** @type {{model: string, tools?: {function: {name: string}}[]}} */ (JSON.parse(body));
      const step = queued.shift();
      modelCalls.push({
        model: input.model,
        toolNames: input.tools?.map((t) => t.function.name),
        step: step?.name ?? "done",
      });
      if (!step) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      const tool = {
        id: `call_${randomUUID().replaceAll("-", "")}`,
        type: "function",
        function: { name: step.name, arguments: JSON.stringify(step.args) },
      };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, ...tool }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      );
    } catch (e) {
      res.writeHead(500);
      res.end(e instanceof Error ? e.message : String(e));
    }
  });
  await new Promise(
    /** @param {(value: void) => void} resolve */ (resolve) => fixture.listen(0, "127.0.0.1", resolve),
  );
  const fixtureAddress = fixture.address();
  if (!fixtureAddress || typeof fixtureAddress === "string") throw Error("Expected TCP fixture.");
  /** @type {Record<string, {baseUrl: string, api: string, apiKey: string, models: {id: string, name: string, reasoning: boolean, input: string[], contextWindow: number, maxTokens: number, cost: {input: number, output: number, cacheRead: number, cacheWrite: number}}[]}>} */
  const providers = {};
  for (const provider of ["fixture-a", "fixture-b"])
    providers[provider] = {
      baseUrl: `http://127.0.0.1:${fixtureAddress.port}/v1`,
      api: "openai-completions",
      apiKey: "disposable-fixture",
      models: [
        {
          id: `${provider}-model`,
          name: provider,
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
  await writeFile(join(env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers }));
  await writeFile(
    join(env.PI_CODING_AGENT_DIR, "settings.json"),
    JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, update: { enabled: false } }),
  );
  const piCli = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  /** @param {import("./journey-types.ts").ScriptedToolCall[]} steps @param {import("./journey-types.ts").PiOptions} options @returns {Promise<import("./journey-types.ts").PiRecord[]>} */
  async function pi(
    steps,
    {
      session = "journey-A",
      provider = "fixture-a",
      project = projectA,
      fork,
      prompt = "Execute the scripted artifact workflow.",
    } = {},
  ) {
    if (queued.length) throw Error("Previous fixture script was not consumed.");
    queued = [...steps];
    const number = ++sequence;
    const args = [
      piCli,
      "--mode",
      "json",
      "--provider",
      provider,
      "--model",
      `${provider}-model`,
      "--thinking",
      "off",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-mcp",
      "--extension",
      join(packagePath, "lib/pi-artifacts/dist/extensions/artifacts.js"),
      "--tools",
      "write,edit,artifact_publish,artifact_list,artifact_get",
      "--session-id",
      session,
    ];
    if (fork) args.push("--fork", fork);
    args.push(prompt);
    const proc = await child(process.execPath, args, { cwd: project });
    proc.stdin.end();
    let stdout = "",
      stderr = "";
    proc.stdout.on("data", (c) => {
      stdout += c;
      void writeFile(join(logs, `pi-${number}.jsonl`), stdout);
    });
    proc.stderr.on("data", (c) => {
      stderr += c;
      void writeFile(join(logs, `pi-${number}.stderr`), stderr);
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(Error("Pi fixture timed out."));
      }, 60000);
      proc.once("error", reject);
      proc.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    await writeFile(join(logs, `pi-${number}.jsonl`), stdout);
    await writeFile(join(logs, `pi-${number}.stderr`), stderr);
    await writeFile(join(logs, "model-calls.json"), JSON.stringify(modelCalls, null, 2));
    if (code !== 0) throw Error(`Pi exited ${code}: ${stderr}\n${stdout.slice(-1000)}`);
    const records = /** @type {import("./journey-types.ts").PiRecord[]} */ (
      stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    );
    if (queued.length)
      throw Error(`Pi did not execute all scripted steps: ${stderr}\n${stdout.slice(-2000)}`);
    return records;
  }
  /** @param {import("../../src/shared/contracts.ts").ArtifactKind} kind @param {string} name @param {Record<string, string>} files @param {string | undefined} [id] @param {import("./journey-types.ts").PiOptions} options */
  async function publish(kind, name, files, id, options = {}) {
    const work = join(config.workDir, options.session ?? "journey-A", name);
    /** @type {import("./journey-types.ts").ScriptedToolCall[]} */
    const steps = Object.entries(files).map(([path, content]) => ({
      name: "write",
      args: { path: join(work, path), content },
    }));
    steps.push({
      name: "artifact_publish",
      args: {
        ...(id ? { id } : {}),
        title: name,
        kind,
        entrypoint: join(work, Object.keys(files)[0]),
        files: Object.keys(files).map((path) => join(work, path)),
      },
    });
    const records = await pi(steps, options);
    const end = records.findLast((r) => r.type === "tool_execution_end" && r.toolName === "artifact_publish");
    if (!end?.result) throw Error("No actual artifact_publish execution event.");
    return {
      records,
      result: end.result,
      isError: end.isError,
      artifact: /** @type {import("../../src/shared/contracts.ts").ArtifactRevision} */ (end.result.details),
      work,
    };
  }
  return {
    root,
    config,
    get internal() {
      return internal;
    },
    publicUrl,
    projectA,
    projectB,
    pi,
    publish,
    start,
    stopService,
    async close() {
      await stopService();
      for (const proc of children) proc.kill("SIGTERM");
      await Promise.all([
        new Promise(/** @param {(value: void) => void} resolve */ (resolve) => proxy.close(() => resolve())),
        new Promise(
          /** @param {(value: void) => void} resolve */ (resolve) => fixture.close(() => resolve()),
        ),
      ]);
    },
  };
}
