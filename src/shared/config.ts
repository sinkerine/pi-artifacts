import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fail } from "./contracts";
export interface Limits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  buildTimeoutMs: number;
}
export interface Config {
  schemaVersion: 1;
  bindAddress: string;
  port: number;
  publicUrl: string;
  serviceUrl: string;
  dataDir: string;
  workDir: string;
  tokenFile: string;
  limits: Limits;
}
export const defaultLimits: Limits = {
  maxFiles: 100,
  maxTotalBytes: 10485760,
  maxFileBytes: 2097152,
  buildTimeoutMs: 30000,
};
export function configPath(explicit?: string, env = process.env) {
  return (
    explicit ??
    env.PI_ARTIFACTS_CONFIG ??
    join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config"), "pi-artifacts/config.json")
  );
}
export function normalizeUrl(value: unknown): string {
  try {
    const u = new URL(String(value));
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash)
      throw Error();
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}/`;
  } catch {
    return fail(
      400,
      "CONFIG",
      "URLs must be absolute HTTP(S) URLs, with an optional path prefix and no credentials/query/fragment.",
    );
  }
}
export function parseConfig(input: unknown, env = process.env): Config {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(400, "CONFIG", "Configuration must be a JSON object.");
  const raw = input as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "bindAddress",
    "port",
    "publicUrl",
    "serviceUrl",
    "dataDir",
    "workDir",
    "tokenFile",
    "limits",
  ];
  for (const [k, value] of Object.entries(raw)) {
    if (!keys.includes(k)) fail(400, "CONFIG", `Unknown configuration field: ${k}`);
    if (value === null) fail(400, "CONFIG", `Invalid configuration field: ${k}`);
  }
  const home = env.HOME ?? homedir();
  const dataDir = raw.dataDir ?? join(env.XDG_DATA_HOME ?? join(home, ".local/share"), "pi-artifacts");
  const workDir = raw.workDir ?? join(env.XDG_STATE_HOME ?? join(home, ".local/state"), "pi-artifacts/work");
  const port = raw.port ?? 4317;
  const bindAddress = raw.bindAddress ?? "127.0.0.1";
  if (
    (raw.schemaVersion ?? 1) !== 1 ||
    !Number.isInteger(port) ||
    Number(port) < 0 ||
    Number(port) > 65535 ||
    typeof bindAddress !== "string" ||
    !bindAddress
  )
    fail(400, "CONFIG", "Expected schemaVersion 1, a bindAddress and port 0–65535.");
  const publicUrl = normalizeUrl(raw.publicUrl ?? "http://127.0.0.1:4317");
  const prefix = new URL(publicUrl).pathname;
  const serviceUrl = normalizeUrl(raw.serviceUrl ?? `http://127.0.0.1:${port}${prefix}`);
  if (new URL(serviceUrl).pathname !== prefix)
    fail(400, "CONFIG", "serviceUrl and publicUrl must use the same path prefix.");
  const tokenFile = raw.tokenFile ?? join(String(dataDir), "publish-token");
  for (const [name, v] of Object.entries({ dataDir, workDir, tokenFile }))
    if (typeof v !== "string" || !isAbsolute(v)) fail(400, "CONFIG", `${name} must be an absolute path.`);
  if (raw.limits !== undefined && (typeof raw.limits !== "object" || Array.isArray(raw.limits)))
    fail(400, "CONFIG", "limits must be an object.");
  const limits = { ...defaultLimits, ...(raw.limits as object) };
  for (const [k, v] of Object.entries(limits))
    if (!Object.hasOwn(defaultLimits, k) || !Number.isSafeInteger(v) || v <= 0)
      fail(400, "CONFIG", `Invalid limit: ${k}`);
  return {
    schemaVersion: 1,
    bindAddress,
    port: Number(port),
    publicUrl,
    serviceUrl,
    dataDir: String(dataDir),
    workDir: String(workDir),
    tokenFile: String(tokenFile),
    limits,
  };
}
export async function loadConfig(explicit?: string): Promise<Config> {
  const path = configPath(explicit);
  try {
    return parseConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && !explicit && !process.env.PI_ARTIFACTS_CONFIG)
      return parseConfig({});
    if (e instanceof SyntaxError) fail(400, "CONFIG", "Configuration contains invalid JSON.");
    throw e;
  }
}
