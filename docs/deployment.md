# Configuration and operation

Only x86_64-linux is verified by the package definition; other systems are unverified. Installation/build dependencies come through Nix. No activation, DNS/firewall changes, live profile edits or deployment is performed by this repository's tests.

One JSON file configures both service and extension. Selection precedence: service `--config <path>`, `PI_ARTIFACTS_CONFIG`, then `$XDG_CONFIG_HOME/pi-artifacts/config.json` (fallback `~/.config/pi-artifacts/config.json`). Explicit/environment-selected missing files fail clearly; an absent default file uses defaults. File fields override defaults. Unknown/malformed fields fail.

| Field | Default |
| --- | --- |
| schemaVersion | 1 |
| bindAddress | 127.0.0.1; external/IPv6 binding requires explicit configuration |
| port | 4317; 0 binds a dynamic test port reported in ready JSON |
| publicUrl | http://127.0.0.1:4317; absolute HTTP(S) URL with optional prefix, normalized trailing slash |
| serviceUrl | derived loopback host, configured port and public prefix; may explicitly select another internal endpoint |
| dataDir | $XDG_DATA_HOME/pi-artifacts or ~/.local/share/pi-artifacts |
| workDir | $XDG_STATE_HOME/pi-artifacts/work or ~/.local/state/pi-artifacts/work |
| tokenFile | <dataDir>/publish-token |
| limits.maxFiles | 100 |
| limits.maxTotalBytes | 10485760 |
| limits.maxFileBytes | 2097152 |
| limits.buildTimeoutMs | 30000 |

Paths must be absolute. URLs cannot contain credentials/query/fragment. serviceUrl and publicUrl must have the same prefix. The extension publishes to serviceUrl; every viewer link uses publicUrl. Remote clients need a reachable public URL: client localhost refers to the client, not the remote service. There is no domain inference or hardcoded deployment hostname. Port 0 does not rewrite a separately configured public URL; a test harness reads readiness and writes its actual reachable addresses.

The service generates tokenFile once, mode 0600, or reuses an operator-provisioned token. Supply a nonempty unpredictable token in a readable private file. The extension reads it only for publication. Never embed it in viewer links, browser assets or logs. An unavailable/empty token produces a clear error. Keep serviceUrl/token access within a trusted control plane. The default bind is loopback and unauthenticated writes fail.

## Foreground and proxy

See [examples/config.json](../examples/config.json) and [examples/foreground.sh](../examples/foreground.sh). Replace paths, then run `pi-artifacts serve --config /absolute/config.json`; ensure Pi has the same PI_ARTIFACTS_CONFIG. No daemon starts from extension registration. Occupied ports exit nonzero. SIGTERM/SIGINT finishes or cancels pre-commit work, closes HTTP/SSE and releases ownership.

A reverse proxy controls domain, TLS, reader authentication and access policy. Preserve the configured path prefix on upstream requests, including /preview, /api/events, source/download and shell asset routes. Disable SSE buffering and allow persistent event streams; do not cache shell/API/event responses. Preview/source revision bytes can be cached immutably. The [generic Traefik example](../examples/traefik.yaml) uses operator-supplied hostname/backend/prefix without changing any existing router. It has no strip-prefix middleware. Traefik flushes streaming responses immediately; response forwarding is configured explicitly.

Generated code is trusted browser content and runs in an ordinary unsandboxed iframe. No microVM/container/runtime sandbox exists. HTML/Markdown may include active markup. Read endpoints expose the catalog and sources to anybody who can reach them. The write token is not a reader login. Use a dedicated operator-controlled origin/access gateway appropriate to your trust policy.

## Home Manager

The flake exports packages.x86_64-linux.default, devShells.x86_64-linux.default, homeManagerModules.default and package/module checks. The package contains bin/pi-artifacts and lib/pi-artifacts/dist/{service,viewer,extensions}, with immutable runtime libraries. Runtime Pi peers remain host-provided; Pi is not bundled into the extension.

[examples/home-manager.nix](../examples/home-manager.nix) shows importing the module. Options under services.pi-artifacts are enable, package, bindAddress, port, publicUrl, serviceUrl, dataDir, workDir, tokenFile, limits and enablePiExtension (false by default). Defaults match the table; Home Manager expands user XDG paths. Enabling generates config, installs the package and adds a restart-on-failure user service. An explicitly enabled extension links only ~/.pi/agent/extensions/pi-artifacts/; it never owns Pi settings.json or unrelated extension paths. home.sessionVariables.PI_ARTIFACTS_CONFIG points to the generated file. Restart Pi's environment after operator activation so both discover that path.

Pure module checks evaluate disabled, enabled, extension-disabled and overridden options/config/command paths without activation. Applying a Home Manager configuration remains an operator step, outside this implementation. No /nixfiles or live profile changes are part of the feature.

For upgrades, stop the single writer, back up dataDir/token, review schema compatibility, switch package and restart. Schema version 1 reconstructs indexes from immutable manifests; there is no database migration or automatic deletion. Multi-writer and network-filesystem operation are unsupported. See [backup and recovery](artifacts.md).
