# Investigation: 2026-11-04

The original workspace was empty. Two Bambu MCP installations were already configured in both Codex and Claude: upstream `bambu-printer-mcp` 1.1.51 and a separate ceweldy fork. This work changed only the Codex registrations and added a separate integration/configuration.

**Later live result:** the signed LAN route successfully submitted the unchanged approved file, and independent cloud telemetry verified the matching job with advancing layers. LAN timeouts later recurred, isolated to new TCP connections on port 8883 from both macOS and Docker while FTPS 990 stayed reachable; their cause remains unknown. The cloud task-creation failure still reproduces, including with an empty `connection_type`. See [acceptance evidence](acceptance.md). The reusable supported submission path is LAN from the local/nearby host; cloud monitoring works.

## Confirmed causes

1. **Server-side elicitation is separate from harness access.** The upstream launchers did not set `BAMBU_REQUIRE_CONFIRMATION=0`. Upstream's `confirmHardwareAction` consequently calls `server.elicitInput` for print starts. Full filesystem/network access does not implement the client's elicitation UI. Upstream documents its headless opt-out, but some physical-fault paths still require elicitation even with that opt-out. This MCP has no elicitation calls; reported faults return errors.
2. **Upstream cloud printing still needs LAN telemetry.** Its `print3mfViaBambuNetwork` requires host, matching serial/access code, and multiple `getSafetyStatus` reads through LAN MQTT even for `connection_type: cloud`. That prevents true remote use when LAN sockets are unavailable. The new cloud route reads fresh reports through the cloud networking session and uses the same upstream file/printer validation functions.
3. **The Docker bridge had no explicit general-purpose CA bundle.** A live `net.get_user_print_info` returned plug-in code `-11`, HTTP transport code `60`. Setting `CURL_CA_BUNDLE` and `SSL_CERT_FILE` to the installed runtime's `ca-certificates.crt` produced return code 0 and HTTP 200, with the configured A1 in the response. TLS verification stays enabled for cloud HTTPS.
4. **Cloud channel readiness is asynchronous.** `connect_server` returning success does not mean a selected printer's channel can publish yet. Sending immediately returned `-2`. Registering callbacks, waiting for server connection, selecting the printer, subscribing, and waiting for its `on_printer_connected` event resolved this. Fresh full reports then arrived.
5. **Runtime discovery was misleading.** The upstream bridge-status response reports conventional macOS runtime files as missing, even when an explicit Docker bridge is configured. A connect probe succeeded using the installed Linux guest runtime. Missing macOS discovery files were not the actual failure.
6. **Live cloud task creation is rejected by Bambu.** Testing an unchanged approved A1 sliced file through this MCP completed the upload, then returned `-3120`. The plug-in callback reported HTTP `403`, reason `internal blocking`, at task creation. Independent fresh telemetry showed the prior completed job, heaters off and no test job started. Bambu's service rejected this runtime's submission; the exact vendor policy behind that response is not established. No client identity spoofing, firmware changes or printer-mode changes were attempted. This remains a live blocker to cloud print execution.

The ceweldy fork lacks the main upstream's current confirmation implementation, but still uses the same configured bridge and does not establish a verified remote workflow just by avoiding those prompts.

## Chosen implementation

The server exposes ten focused tools. There is no shell-execution or raw networking-bridge tool. Inputs are schema-validated. Tools are serialized because the bridge has a shared event queue. The printer route is explicit; cloud never falls back to LAN and LAN never silently falls back to cloud.

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

## CLI configuration and orphaned server (v0.2.2)

Stopping the read-only CLI monitor with SIGTERM left its MCP server reparented to PID 1. The server creation time matched the monitor log, and terminating that specific server let the monitor wrapper finish. No printer command was involved. MCP SDK 1.32.1's server stdio transport listens for data/error but not input EOF, so closing the parent did not itself close the active bridge.

A subprocess regression test also exposed that the CLI had not forwarded `BAMBI_CONFIG`: the SDK's default inherited environment omitted this setting, causing the child to use the default setup. The CLI now forwards its environment and explicitly closes its transport on signals; the server closes its bridge on input EOF. Tests exercise a real server and deliberately pending fake bridge, assert all child processes exit, and verify an isolated configuration is actually used. These tests do not send printer commands. Together with recovery and other existing tests, 36 tests pass.

Cloud HTTP 403 and pause/control rejection remain unresolved hardware/runtime limitations. These lifecycle fixes do not establish that either limitation is fixed.

## Control outcome handling (v0.2.3)

The actual pause attempts returned failure and the job continued. That evidence requires distinguishing transport acceptance from observed execution. `control_print` now obtains a fresh named target, rechecks that identity within the connected cloud/LAN session, publishes at most once, and reads back the target state. Managed jobs retain `last_control`, including failed or unconfirmed attempts, without optimistically marking the job paused. Control also shares the operation lock with dispatch and verification. A timeout after publishing never triggers an automatic second command.

Eleven new tests cover state confirmation, missing/stale/wrong-job reports, a job change before transmission, active HMS while pausing, rejected/unknown transport outcomes, absent or unrelated readback, same-job terminal observation, locking, journaling and runtime call order. The full suite has 47 passing tests. These tests use fake transports; the running physical print was not used for further pause/cancel experiments. The cloud HTTP 403 and hardware control rejection remain open.

## Camera evidence and guarded resume (v0.2.4)

Physical detachment can occur while telemetry still reports printing with no errors. `camera_snapshot` now exposes the existing A1 LAN camera reader as a read-only MCP image tool, with bounded timeout and no lighting or motion commands. A live real-stdio test returned a JPEG successfully. Camera failure is an explicit error, not a claim that the bed is clear or the print is healthy.

The control tool also accepts explicit resume of a managed job. Both fresh pre-dispatch checks require the exact paused job, zero print error and an empty HMS list. Missing fault fields, new warnings, a changed job or a running/terminal job prevent transmission. Resume does not clear errors and never happens automatically. As with pause/cancel, only fresh matching readback confirms the requested state; rejected or unknown commands are not retried.

The 51-test suite passes, including new checks for fault-blocked resume at either pre-dispatch check, required managed identity, camera configuration, timeout without retry, and the public stdio schema. These tests do not prove physical control reliability; hardware evidence is tracked in [acceptance](acceptance.md).

Control sequence IDs now stay within a signed 32-bit integer range, matching [Studio's counter representation](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/DeviceManager.hpp), instead of using oversized millisecond timestamps. Live tests still failed: LAN pause returned -4, cloud pause returned -2, and both readbacks showed the target still running. The format change is not claimed as a transport fix. [Bambu's published error definitions](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/Utils/bambu_networking.hpp) name -4 `BAMBU_NETWORK_ERR_SEND_MSG_FAILED` and -2 `BAMBU_NETWORK_ERR_CONNECT_FAILED`; these labels do not identify why control failed while status requests succeeded.

## Command readiness and route switching (v0.2.4–v0.2.5)

A connected socket and working status reads did not establish protected-command readiness. Live read-only probes reproduced LAN -4 and cloud -2 before the vendor certificate exchange, followed by a matching successful query afterward. The A1 also rejected sequence ID 500004 with error 84033546 while accepting the identical query at 24008. Controls now use Studio's sequence range, require a matching successful read-only query, and recheck the target before sending the physical command once. LAN pause/resume passed live MCP acceptance; cloud readiness passed a read-only live check, with physical cloud control still unverified.

The shared vendor agent also changed its selected channel during LAN sessions. A real cloud → LAN → cloud MCP status sequence failed on the last read until the cached cloud subscription was invalidated before LAN use. The corrected sequence passed without printer controls. See the dated acceptance record for exact evidence and remaining limits.

## Quiet monitoring and single-attempt submission (v0.2.6)

The old CLI printed a full job record at each poll. The CLI itself did not invoke an LLM; an independent active harness goal was repeatedly continuing the agent. Changing polling output does not disable that harness behavior.

The watcher now separates inexpensive local status reads from agent-facing events. Its default output is startup, changed issues, recovery and terminal results. Normal layers and ETA changes stay quiet; an optional milestone mode adds at most five intermediate updates. Identical HMS reports are deduplicated without depending on timestamps or array order. Observation outages are explicit unknown-state events, with bounded read-only retry backoff. `--until-event` ends the background process on an issue or lost observation, allowing a compatible host to wake the agent on task completion. This mode does not keep monitoring after an alert; the host must restart observation after handling it. No automatic physical control or visual-defect detection is added.

The dispatch audit also found that the dependency's `startLocalPrint` wrapper retries a synchronous -4030 response. The runtime now uses the same local-session setup with one direct `net.start_local_print` call, retaining final preflight and durable dispatch callbacks. No library retry wrapper is called. A returned rejection or transport exception therefore cannot cause a second print attempt inside that operation. The underlying vendor service is not claimed to provide distributed exactly-once execution.

All 75 offline tests pass. New tests cover a full healthy progress sequence with no intermediate events, warning deduplication/recurrence, mismatched job completion, pause/missing telemetry, five milestones, late attachment, observation outage/recovery, event-mode exits, and a real CLI-to-MCP unsubmitted-job result. Dispatch tests exercise the dependency's actual request framing and callbacks against a fake wire, confirming one attempt on -4030/timeout and no attempt after final-preflight rejection. These are software checks, not a new live print submission or cloud-control acceptance test.
