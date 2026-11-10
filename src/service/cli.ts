#!/usr/bin/env node
import { loadConfig } from "../shared/config";
import { startService } from "./server";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "serve" || args.length > 3 || (args.length > 1 && (args[1] !== "--config" || !args[2])))
    throw Error("Usage: pi-artifacts serve [--config <path>]");
  const configPath = args[2];
  const config = await loadConfig(configPath);
  const service = await startService({ configPath });
  process.stdout.write(
    `${JSON.stringify({ event: "ready", address: service.address, publicUrl: config.publicUrl })}\n`,
  );
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      await service.close();
    });
}
main().catch((e) => {
  process.stderr.write(`pi-artifacts: ${e.message}\n`);
  process.exitCode = 1;
});
