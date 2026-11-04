# Bambi A1 MCP

An open-source MCP server for **Bambu Lab A1** printing. Slice with Bambu Studio, inspect an exact file snapshot, submit a print, and verify that the printer is actually running that job. Works with T3 Code and other clients that launch stdio MCP servers.

**First physical acceptance test failed:** the user stopped the job at layer 33 after parts came off the plate and spaghetti extrusion followed. The cause of detachment is still under investigation. The file was unchanged. **Transport verified on hardware:** signed LAN submission, external PLA spool, A1 / 0.4 mm nozzle / textured PEI, with fresh cloud telemetry independently confirming the job and advancing layers. Bambu Studio slicing is also verified. **Direct Bambu Cloud print submission remains experimental and currently fails on the tested runtime with HTTP 403 / `internal blocking`.** Cloud monitoring works. For reliable remote submission, use a nearby host over SSH; see [remote printing](#remote-printing).

**v0.2.1 recovery verified on hardware:** the unchanged retry was accepted after the cleared-bed acknowledgement, without rebooting or clearing faults. Independent telemetry confirmed the new job preparing. The Y-axis warning subsequently recurred while layers advanced. Remote pause attempts failed on both transports; reliable remote pause/cancel is not established. Physical completion is still pending.

No additional MCP elicitation dialog is required. Your MCP client's own tool permissions still apply. The server validates the file, model, nozzle, filament and fresh printer state before dispatch. It does not clear faults or change printer modes.

## Install

Requires **Node.js 24+**, **Docker**, **Bambu Studio**, `tar` and `unzip`. The tested host is macOS with Docker's Linux/amd64 support. Linux x86-64 is supported by the wrapper but has not received the same physical acceptance test. Windows users must run inside WSL2. Other Bambu models are not supported by this release.

```sh
git clone https://github.com/chandraaditya/bambi-a1-mcp.git
cd bambi-a1-mcp
npm ci
npm run install:runtime
npm run setup
```

The runtime installer downloads **FULU v1.0.0** and **Bambu networking plug-in 02.05.02.58** directly from their publishers, verifies pinned SHA-256 hashes before extraction, and installs them privately outside the repo. A repeated run checks installed file integrity. These binaries are not redistributed in this package; their licenses remain with their publishers. Docker uses a pinned Ubuntu image.

Setup asks for the printer's LAN address. If Bambu Studio has exactly one saved printer, setup uses its serial and reads its saved LAN access code at runtime. Otherwise pass `--serial`. If Studio has no access code, supply a private local file using `--access-code-file`; do not put the code in a shell argument, Git or chat.

```sh
npm run setup -- --host PRINTER_ADDRESS --serial PRINTER_SERIAL \
  --access-code-file /private/path/access-code --country US
```

Setup defaults to an **A1, 0.4 mm nozzle and textured PEI**; use `--nozzle` and `--bed` to match your printer. Linux installations also need `--slicer /absolute/path/to/BambuStudio`. `--studio-config` and `--runtime` override discovery. `npm run setup -- --help` lists options. Setup refuses to overwrite existing configuration.

For cloud monitoring, sign in to Bambu Studio, then:

```sh
npm run import:session
npm run doctor -- --connect --lan --cloud
```

Without cloud login, run `npm run doctor -- --connect --lan`. These commands do not print. Studio's encrypted session is copied into a separate private directory; Studio's own settings stay intact. Expired sessions require signing in and importing again.

## Connect an MCP client

Setup writes `~/.config/bambi-a1-mcp/mcp-client.json` with the **actual absolute paths** for your machine. Copy its server entry into your MCP client configuration. The generic form is:

```json
{
  "mcpServers": {
    "bambi-a1": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/bambi-a1-mcp/src/server.mjs"]
    }
  }
}
```

For T3's Codex harness (registration helper requires Python 3.11+):

```sh
python3 scripts/install-codex.py --node /absolute/path/to/node
```

This backs up Codex's configuration, registers this checkout and disables the two known duplicate Bambu MCP entries. Reload the T3 session afterward. Other clients can use the generated JSON entry. `BAMBI_CONFIG` selects a different private configuration file.

**v0.2.2 lifecycle fixes:** the CLI forwards `BAMBI_CONFIG` and other environment configuration to its MCP child. Interrupting the CLI or closing the harness input now closes the MCP server and networking bridge. This only closes the client connection; it never pauses or cancels a printer job.

The package also exposes `bambi-a1-mcp`, `bambi`, `bambi-setup` and `bambi-install-runtime` executable entry points when installed using npm from GitHub or a release tarball. It is not currently published to the npm registry.

## Print workflow

1. **Prepare:** `prepare_job` copies the source, optionally slices it, and inspects a read-only snapshot bound to a SHA-256 hash. It never prints.
2. **Submit once:** `print_job` takes the prepared ID and an explicit route. It validates fresh telemetry immediately before dispatch.
3. **Verify:** `verify_job` checks fresh telemetry against the exact expected job name and saves observed progress. Layer 0 means preparation; advancing layers establish printing. A previous completed job is never treated as this job's success.

For an already sliced 3MF, the MCP arguments are:

```json
{"file_path":"/absolute/path/part.3mf","plate_index":0}
```

Then:

```json
{"job_id":"ID_FROM_PREPARE_JOB","route":"lan"}
```

The same job ID can be verified through `route: "cloud"`, even though submission used LAN. A missing/unavailable matching report never triggers another submission. Repeating a submitted job ID returns its stored state. To intentionally print another copy, prepare a new job **after checking the printer and clearing the bed**.

Omit `ams_mapping` for one external spool. For AMS Lite, map every project filament position to a physical slot: `"ams_mapping": [0, 2]`. Slots are zero based; `-1` is allowed only for unused project positions. Multi-material external-spool jobs are refused. Plate indices are also zero based.

Filament type is validated against printer telemetry. The operator must confirm the actual spool and clear build plate before instructing a print; telemetry cannot establish those physical facts.

### Recover after a cancelled or failed job

An A1 can retain `FAILED` after a job has ended. That describes the previous job; it does not by itself establish an active machine fault. `printer_status` returns `recovery.eligible` and an explanation. An eligible report still requires operator confirmation that the plate has been cleared and a request to start a new print. No reboot or automatic fault clearing is required by this recovery workflow.

Call `print_job` with the prepared, unsubmitted job ID and the **exact previous job name from fresh status**:

```json
{"job_id":"ID_FROM_PREPARE_JOB","route":"lan","recovery":{"previous_job_name":"NAME_FROM_PRINTER_STATUS","bed_cleared":true}}
```

Or use the CLI, which calls that same MCP tool:

```sh
bambi print JOB_ID --route lan --recover-from 'NAME_FROM_PRINTER_STATUS' --bed-cleared
```

Recovery requires fresh A1 telemetry with `gcode_state: FAILED`, `print_type: idle`, no active stage (`stg_cur: 255`), both heater targets off, zero `print_error`, and an empty HMS list. An optional newer job-state field must also be terminal or idle. All identity, nozzle, material and file checks remain in force. The previous job identity is checked again immediately before transmission; a changed job or new fault blocks submission. This neither resumes nor replays the failed job. The recovery acknowledgement is recorded in the new job's journal. A dispatch timeout still produces an unknown, non-replayable outcome.

If preflight fails, the job remains prepared and `get_job` includes `last_preflight_error`. Resolve that condition and inspect fresh status before calling again. Do not invent a cleared-bed confirmation or acknowledge an active fault merely to get a submission through.

### Bambu Studio slicing

An STL needs explicit process and filament profiles. Use `list_profiles` to find your installed profiles, then:

```json
{
  "file_path":"/absolute/path/model.stl",
  "process_profile":"/absolute/path/0.20mm Standard @BBL A1.json",
  "filament_profiles":["/absolute/path/Bambu PLA Basic @BBL A1.json"]
}
```

For an unsliced 3MF, also set `slice: true`. A prepared, sliced 3MF is used unchanged unless slicing was explicitly requested. `profilesRoot` can point `list_profiles` to an extracted Linux BBL profile directory. The configured slicer must contain matching A1 presets.

### Command-line use

The CLI calls the same MCP tools, without an elicitation-capable client:

```sh
npm run bambi -- prepare /absolute/path/part.3mf
npm run bambi -- print JOB_ID --route lan
npm run bambi -- verify JOB_ID --route cloud
npm run bambi -- watch JOB_ID --route cloud
```

`watch` only verifies, at 30-second intervals by default; it stops on matching completion/failure or its 12-hour timeout. It never prints or retries. `status`, `job` and `doctor` are also available. Run `npm run bambi -- --help` for options.

The nine MCP tools are `diagnose`, `list_printers`, `printer_status`, `list_profiles`, `prepare_job`, `get_job`, `print_job`, `verify_job` and `control_print`. Controls are pause and cancel.

## Remote printing

**Verified submission mechanism: a nearby host.** Leave an installed Mac or compatible Linux x86-64 host on the printer's LAN. Connect your remote MCP client using SSH stdio through your existing SSH/VPN setup:

```toml
[mcp_servers.bambi-a1]
command = "/usr/bin/ssh"
args = ["-T", "YOUR_NEARBY_HOST", "/absolute/path/to/node", "/absolute/path/to/bambi-a1-mcp/src/server.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 600
```

Transfer your model to that host first; paths in tool calls refer to the host running the server. Use `route: lan` there. Slicing also runs there, so Bambu Studio must be installed there. SSH/VPN access is configured by the operator; setup does not enable remote login or expose ports. The LAN printing mechanism is physically verified; an off-site SSH deployment has not been independently tested in this release.

The Docker runtime is x86-64. A Raspberry Pi requires a separately configured compatible emulation environment and has not been tested; do not assume a native ARM plug-in exists. Apple Silicon works through Docker's amd64 support in the tested setup.

**Bambu Cloud:** cloud authentication, discovery, fresh status and verification work without LAN sockets. Direct file submission uses `net.start_print`, but the tested service rejected task creation after upload. Neither replacing `connection_type: "cloud"` with an empty value nor a successful upload established printing. The exact vendor rejection rule is unknown. The cloud route is retained for diagnosis and future compatibility work; it never silently falls back to LAN. Do not rely on it for print submission yet.

## Reliability and limits

- Job files, credentials, encrypted sessions and diagnostics live outside the package in private directories.
- Durable job records and a shared-directory operation lock prevent duplicate dispatch by this server across repeats/restarts. This is not a printer-wide lock across other slicers.
- A timeout after dispatch is recorded as `unknown`, never automatically retried. `verify_job` can resolve it from a matching live job.
- The networking library can retry its specific local **publish-failed** error once, with a fresh preflight. There is no generic print retry or automatic transport fallback.
- Faults are reported, not cleared. A crash can leave a lock; inspect the live printer and process before removing it.
- The live test reached layer 33, then the user stopped it after observing a physical failure. It did not produce a completed acceptable part. The printer raised a Y-axis resonance/possible loose-belt HMS entry during preparation; this was surfaced and left intact.
- LAN reachability was intermittent during the live test: after printing started, new connections to port 8883 timed out from both macOS and Docker while FTPS 990 remained reachable. Cloud monitoring continued. `diagnose` with `connect_bridge: true` reports separate host TCP probes; a reachable port alone does not prove protocol authorization. This network/firmware cause remains unresolved.
- Cloud service changes, firmware changes and expired sessions can still require maintenance. Pinned dependencies make the tested setup reproducible, not permanently immune to vendor changes.

Run `npm test` for offline tests. They cover MCP without elicitation, file/printer checks, exact job verification, ambiguous dispatch, idempotency, private setup and transport behavior. See [diagnosis](docs/diagnosis.md) and [live acceptance evidence](docs/acceptance.md). Contributions should preserve those guarantees and distinguish simulated tests from actual printer evidence.

GPL-2.0-only. Built on pinned `bambu-printer-mcp` libraries; see [third-party notices](THIRD_PARTY_NOTICES.md). Independent project, unaffiliated with Bambu Lab.
