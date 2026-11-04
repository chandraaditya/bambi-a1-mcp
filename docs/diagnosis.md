# Investigation: 2026-11-04

The original workspace was empty. Two Bambu MCP installations were already configured in both Codex and Claude: upstream `bambu-printer-mcp` 1.1.51 and a separate ceweldy fork. This work changed only the Codex registrations and added a separate integration/configuration.

## Confirmed causes

1. **Server-side elicitation is separate from harness access.** The upstream launchers did not set `BAMBU_REQUIRE_CONFIRMATION=0`. Upstream's `confirmHardwareAction` consequently calls `server.elicitInput` for print starts. Full filesystem/network access does not implement the client's elicitation UI. Upstream documents its headless opt-out, but some physical-fault paths still require elicitation even with that opt-out. This MCP has no elicitation calls; reported faults return errors.
2. **Upstream cloud printing still needs LAN telemetry.** Its `print3mfViaBambuNetwork` requires host, matching serial/access code, and multiple `getSafetyStatus` reads through LAN MQTT even for `connection_type: cloud`. That prevents true remote use when LAN sockets are unavailable. The new cloud route reads fresh reports through the cloud networking session and uses the same upstream file/printer validation functions.
3. **The Docker bridge had no explicit general-purpose CA bundle.** A live `net.get_user_print_info` returned plug-in code `-11`, HTTP transport code `60`. Setting `CURL_CA_BUNDLE` and `SSL_CERT_FILE` to the installed runtime's `ca-certificates.crt` produced return code 0 and HTTP 200, with the configured A1 in the response. TLS verification stays enabled for cloud HTTPS.
4. **Cloud channel readiness is asynchronous.** `connect_server` returning success does not mean a selected printer's channel can publish yet. Sending immediately returned `-2`. Registering callbacks, waiting for server connection, selecting the printer, subscribing, and waiting for its `on_printer_connected` event resolved this. Fresh full reports then arrived.
5. **Runtime discovery was misleading.** The upstream bridge-status response reports conventional macOS runtime files as missing, even when an explicit Docker bridge is configured. A connect probe succeeded using the installed Linux guest runtime. Missing macOS discovery files were not the actual failure.
6. **Live cloud task creation is rejected by Bambu.** Testing an unchanged approved A1 sliced file through this MCP completed the upload, then returned `-3120`. The plug-in callback reported HTTP `403`, reason `internal blocking`, at task creation. Independent fresh telemetry showed the prior completed job, heaters off and no test job started. Bambu's service rejected this runtime's submission; the exact vendor policy behind that response is not established. No client identity spoofing, firmware changes or printer-mode changes were attempted. This remains a live blocker to cloud print execution.

The ceweldy fork lacks the main upstream's current confirmation implementation, but still uses the same configured bridge and does not establish a verified remote workflow just by avoiding those prompts.

## Chosen implementation

The server exposes eight focused tools. There is no shell-execution or raw networking-bridge tool. Inputs are schema-validated. Tools are serialized because the bridge has a shared event queue. The printer route is explicit; cloud never falls back to LAN and LAN never silently falls back to cloud.

Each prepared job has its own directory and file snapshot. Dispatch records are saved before the bridge receives a print call. A process restart or repeat call cannot replay a dispatched job. A timeout after handing the request to the bridge leaves an `unknown` record and requires inspection before another job is created. A global operation lock prevents simultaneous print dispatch from processes sharing this job directory. A crashed process may leave the lock; inspect the printer and process state before removing it. This is not a printer-wide lock across unrelated clients.

Fresh reports are obtained after clearing the bridge queue and sending new status/version requests. Identity, errors, material and nozzle checks are then applied. These checks establish reported configuration, not a physically clear build plate. There is still a time interval between a preflight report and the plug-in completing its upload; no distributed reservation with other slicer clients is claimed.

Status responses omit serials, module identifiers and raw network/capture data. Authentication stays in private files and the networking plug-in. The copied Studio session is maintained separately from Studio's own files.

## Recovery

Codex's previous configuration is backed up as `~/.codex/config.toml.before-bambi-<timestamp>`. To roll back, restore that backup and reload the Codex session. The old installations and launchers were not deleted or edited. Claude's registrations remain as before. The private new configuration is at `~/.config/bambi-a1-mcp/config.json`.

If cloud login expires, sign in to Studio and re-run `scripts/import-studio-session.mjs`, then restart this MCP. `scripts/cloud-login.mjs` also provides a hosted ticket-login fallback. Do not clear firmware faults or switch printer modes merely to make a diagnostic tool succeed.

## Sources

- [Upstream configuration and headless confirmation option](https://dmontgomery40.github.io/bambu-printer-mcp/guide/setup).
- [Pinned upstream bridge print handler and LAN safety preflight](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/src/index.ts).
- [Bambu Gateway MCP](https://github.com/leolobato/bambu-gateway-mcp) offers a separate `REQUIRE_PRINT_CONFIRMATION=false` option, but requires the gateway service. Its slicer integration uses Orca; this project reuses the installed Bambu Studio instead.
- [Bambu Studio ticket exchange and login payload](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/HttpServer.cpp).
- [FULU host RPC methods and event payloads](https://github.com/FULU-Foundation/OrcaSlicer-bambulab/blob/main/tools/pjarczak_bambu_linux_host/LinuxPluginHost.cpp).
- [Bambu Gateway cloud session implementation](https://github.com/leolobato/bambu-gateway/blob/main/app/cloud/session.py) explains selection/subscription/readiness order; this implementation was also verified against the local runtime and live A1 reports.
