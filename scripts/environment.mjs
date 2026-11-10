import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
export async function isolatedEnvironment(root) {
  root = resolve(root);
  const env = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "PLAYWRIGHT_BROWSERS_PATH",
    "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
    "PI_ARTIFACTS_CHROMIUM",
    "NIX_SSL_CERT_FILE",
    "SSL_CERT_FILE",
  ])
    if (process.env[key]) env[key] = process.env[key];
  for (const [key, relative] of Object.entries({
    HOME: "home",
    XDG_CONFIG_HOME: "config",
    XDG_DATA_HOME: "data",
    XDG_STATE_HOME: "state",
    XDG_CACHE_HOME: "cache",
    PI_CODING_AGENT_DIR: "pi",
    PI_CODING_AGENT_SESSION_DIR: "sessions",
  })) {
    env[key] = join(root, relative);
    await mkdir(env[key], { recursive: true });
  }
  return env;
}
