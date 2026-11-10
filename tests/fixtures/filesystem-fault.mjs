import fs from "node:fs/promises";
import { IncomingMessage, Server, ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";

/** @typedef {{path: string, action: "fail" | "block"}} FilesystemFault */
/** @type {FilesystemFault} */
const fault = JSON.parse(process.env.ARTIFACTS_TEST_FS_FAULT ?? "null");
if (!fault || !process.send) throw Error("Filesystem fixture requires a target and IPC child.");
const emit = Server.prototype.emit;
/** @param {string | symbol} event @param {unknown[]} args */
Server.prototype.emit = function (event, ...args) {
  const [request, response] = args;
  if (
    event === "request" &&
    request instanceof IncomingMessage &&
    response instanceof ServerResponse &&
    request.method === "POST"
  ) {
    response.once("close", () => {
      if (!response.writableEnded) process.send?.({ event: "request-disconnected" });
    });
  }
  return Boolean(Reflect.apply(emit, this, [event, ...args]));
};
const open = fs.open;
fs.open = async (...args) => {
  const handle = await open(...args);
  if (String(args[0]) === fault.path && args[1] === "wx") {
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      // Store.write has already created and written this real staging file.
      process.send?.({ event: "filesystem-boundary", path: fault.path, operation: "sync" });
      if (fault.action === "fail") {
        const error = Object.assign(Error("Injected disposable staging flush failure"), { code: "EIO" });
        throw error;
      }
      await new Promise((resolve) => process.once("message", resolve));
      await sync();
    };
  }
  return handle;
};
syncBuiltinESMExports();
