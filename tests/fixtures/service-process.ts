import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isolatedEnvironment } from "../../scripts/environment.mjs";
import type { PublishRequest } from "../../src/shared/contracts";

export async function serviceProcess(
  dir: string,
  configPath: string,
  fault?: { path: string; action: "fail" | "block" },
) {
  const env = await isolatedEnvironment(join(dir, "child"));
  if (fault) env.ARTIFACTS_TEST_FS_FAULT = JSON.stringify(fault);
  const args = fault ? ["--import", pathToFileURL(resolve("tests/fixtures/filesystem-fault.mjs")).href] : [];
  const proc = spawn(
    process.execPath,
    [...args, resolve("dist/service/cli.js"), "serve", "--config", configPath],
    {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stdout = "",
    stderr = "";
  proc.stdout!.on("data", (chunk) => {
    stdout += chunk;
  });
  proc.stderr!.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = once(proc, "close");
  const disconnected = new Promise<void>((resolve) => {
    proc.on("message", (message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "event" in message &&
        message.event === "request-disconnected"
      )
        resolve();
    });
  });
  const boundary = new Promise<{ event: string; path: string; operation: string }>((resolve, reject) => {
    proc.on("message", (message) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "event" in message &&
        message.event === "filesystem-boundary"
      )
        resolve(message as { event: string; path: string; operation: string });
    });
    proc.once("error", reject);
  });
  // An unconsumed rejection must not mask an early startup failure.
  void boundary.catch(() => {});
  const ready = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Service readiness timed out: ${stderr}`)), 15000);
    proc.stdout!.on("data", () => {
      const line = stdout.split("\n").find((line) => line.startsWith("{"));
      if (line) {
        clearTimeout(timer);
        resolve((JSON.parse(line) as { address: string }).address);
      }
    });
    proc.once("error", reject);
    proc.once("exit", () => {
      clearTimeout(timer);
      reject(Error(`Service exited before readiness: ${stderr}`));
    });
  });
  async function stop(signal: NodeJS.Signals = "SIGTERM") {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
    await closed;
    await writeFile(join(dir, `service-${proc.pid}.stdout`), stdout);
    await writeFile(join(dir, `service-${proc.pid}.stderr`), stderr);
  }
  let address: string;
  try {
    address = await ready;
  } catch (error) {
    await stop("SIGKILL");
    throw error;
  }
  const config = JSON.parse(await readFile(configPath, "utf8")) as { tokenFile: string };
  const token = (await readFile(config.tokenFile, "utf8")).trim();
  return {
    proc: proc as ChildProcess,
    address,
    boundary,
    disconnected,
    stop,
    release() {
      proc.send("release");
    },
    publish(body: PublishRequest, signal?: AbortSignal) {
      return fetch(new URL("api/artifacts/publish", address), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal,
      });
    },
  };
}
