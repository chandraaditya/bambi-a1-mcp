# Bambi A1 MCP

One stdio MCP for Bambu Lab A1 model slicing, prepared-job inspection, cloud/LAN printing, status, pause and cancel. Uses your installed **Bambu Studio** CLI and the FULU BambuNetwork bridge. It never sends an MCP elicitation request. The client's own tool permissions still apply.

This is a focused integration around pinned `bambu-printer-mcp@1.1.51` libraries, rather than a replacement slicer or an official Bambu product. The print transports and file/printer validators come from that project. Cloud authentication, fresh telemetry, job lifecycle and MCP interface are implemented here.

**Current validation status:** Bambu Studio slicing, cloud authentication, fresh cloud telemetry and live preflight work. The live cloud print test reached 100% upload, then Bambu rejected task creation with `-3120`, HTTP `403`, reason `internal blocking`. The printer did not start the test job. Cloud print execution is therefore **not working on the tested bridge/runtime**. The LAN route also remains unverified; see the limitations below.

## Requirements

- Node.js 24 or newer.
- Bambu Studio on the machine that slices, with its matching A1 profiles.
- The FULU BambuNetwork bridge host and Bambu networking plug-in. The supplied Docker wrapper reuses an installed x86-64 runtime and its CA bundle.
- A Bambu account session for cloud access, or local printer access for the nearby-host route.

Start with [setup](#setup-on-another-host), then reload your MCP client to discover the tools. Configuration, account sessions and job artifacts stay outside this repository.

## Use

Ask the agent to inspect `diagnose`, choose profiles with `list_profiles`, then prepare a job:

```json
{
  "file_path": "/absolute/path/to/model.stl",
  "process_profile": "/Applications/BambuStudio.app/Contents/Resources/profiles/BBL/process/0.20mm Standard @BBL A1.json",
  "filament_profiles": ["/Applications/BambuStudio.app/Contents/Resources/profiles/BBL/filament/Bambu PLA Basic @BBL A1.json"]
}
```

Call `prepare_job` with those arguments. It invokes Bambu Studio, exports a sliced 3MF and inspects it for the configured A1, nozzle and plate. Profile inheritance is resolved by the upstream slicer library. STL inputs need explicit filament and process profiles. An already sliced 3MF needs only `file_path`; an unsliced 3MF needs `slice: true`.

Then call `print_job`:

```json
{ "job_id": "ID_RETURNED_BY_PREPARE_JOB", "route": "cloud" }
```

Omitting `ams_mapping` selects a single external spool. For AMS Lite, map **every project filament position** to a zero-based physical slot, e.g. `"ams_mapping": [0, 2]`. Unused project positions may be `-1`. An A1 with no AMS rejects an AMS-mapped job. Filament type is checked against live inventory; visually confirm the actual spool and clear bed before instructing a print.

Plate indices in MCP calls are **zero based**. The bridge converts them to the plug-in's one-based plate index. Job files are copied into a private directory and bound to a SHA-256 hash. Repeating a job ID returns its recorded state instead of printing it again. To intentionally print another copy, prepare another job.

`printer_status` takes `{"route":"cloud"}` or `{"route":"lan"}`. `control_print` takes a route and `"action":"pause"` or `"action":"cancel"`. Neither requests another approval dialog. Faults fail with an error; the server never asks the harness to approve fault clearing.

## Remote access options

**Bambu Cloud:** run this MCP and Bambu Studio on the Mac you are using, choose `route: cloud`, and leave the printer bound to your Bambu account with internet access. Cloud status, preflight and dispatch use the authenticated networking plug-in. They do not require a LAN socket to the printer. Files upload through the plug-in's cloud print method.

**Nearby host:** run this MCP on an always-on Mac or compatible Linux host near the printer, choose `route: lan`, and connect T3 to it over SSH stdio or a private VPN. Bambu Studio must be on the host that slices. With SSH stdio, model paths refer to that host: transfer the model there first using your usual file-transfer tool. Example MCP configuration:

```toml
[mcp_servers.bambi-a1]
command = "/usr/bin/ssh"
args = ["-T", "YOUR_NEARBY_HOST", "/absolute/path/to/node", "/absolute/path/to/bambi-a1-mcp/src/server.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 600
```

The default LAN route uses the networking plug-in's certificate exchange and signed local session. `"lanTelemetry":"mqtt"` optionally uses direct MQTT for telemetry on firmware/settings that permit it. No printer mode is changed automatically. A Raspberry Pi needs a compatible x86-64 bridge environment; the supplied Docker wrapper does not install CPU emulation or an ARM plug-in.

## Setup on another host

1. Install Node.js 24+, Bambu Studio and its networking plug-in. Run `npm ci`. The pinned upstream dependency installs its required `bambu-node` compatibility patch.
2. Copy [examples/config.json](examples/config.json) to `~/.config/bambi-a1-mcp/config.json`, set actual absolute paths and restrict its permissions to `600`. Set the printer's real nozzle size and plate. `BAMBI_CONFIG` can select another config file.
3. Install the [FULU bridge runtime](https://github.com/DMontgomery40/bambu-printer-mcp/blob/main/docs/FULU.md). `bridgeRuntimeDir` must contain `pjarczak_bambu_linux_host`, its networking libraries and `ca-certificates.crt`. The Docker wrapper reuses an installed runtime; it does not download proprietary binaries. The job directory must be visible inside the bridge guest.
4. Sign in to Studio, then run `node scripts/import-studio-session.mjs`. This copies the encrypted session into this MCP's separate configuration directory. It does not edit Studio's configuration.
5. Run `node scripts/doctor.mjs --connect --cloud`, and `--lan` on the nearby network. This reads state; it does not print.
6. Register the stdio server. On Codex, `python3 scripts/install-codex.py --node /absolute/path/to/node` saves a private backup and disables the two known duplicate Bambu entries. Other MCP clients can launch `node /absolute/path/to/src/server.mjs` directly.

If Studio session import is unavailable, `node scripts/cloud-login.mjs` prints Bambu's hosted sign-in URL. Supply the resulting localhost callback URL via `--callback-file /private/file`; do not put tickets or tokens in chat, command-line arguments or the repository. The script exchanges the ticket with the networking plug-in and stores credentials in a private file. This fallback is unit-tested but has not been exercised with a fresh live login here. Expired/revoked sessions require signing in again.

The MCP is local stdio. There is no unauthenticated network listener and no printer port forwarding.

## Verified and remaining

- Tests cover MCP initialization without elicitation, input validation, identity/nozzle/state checks, stale telemetry rejection, file mutation, job idempotency, ambiguous dispatch, cloud subscription order and transport separation.
- A real 10 × 10 × 5 mm STL was sliced by the installed Bambu Studio with A1/0.4 mm/PLA profiles. Its resulting 3MF passed file inspection.
- The existing account's A1 was discovered through the cloud. Fresh cloud telemetry showed `FINISH`, no print error and no HMS entries. The real sliced job passed live cloud preflight, including nozzle and external PLA checks.
- Both direct MQTT and signed bridge LAN reads timed out at the configured address on this Mac. The address is on a directly connected subnet. The cause is not yet established; local reachability/firmware authorization needs an on-site check. No printer settings were changed.
- **The live cloud print acceptance test failed.** An unchanged, inspected, previously approved A1 sliced file uploaded successfully. Task creation returned `-3120`, HTTP `403`, reason `internal blocking`. Independent fresh telemetry continued to show the previous completed job with heater targets zero and no print errors. No test print start was observed. Failed/uncertain jobs are retained and never replayed automatically. A successful supervised print remains outstanding.
- Status includes the reported job name so a submitted job can be distinguished from a previous one. Plug-in failures retain private callback diagnostics and expose the numeric error, HTTP status and known short reason; raw API bodies and request identifiers stay private.
- Cloud functionality depends on Bambu's service and the installed third-party bridge/plug-in ABI. Versions are pinned; future vendor changes can require an update. No promise of a supported vendor API is implied.

Run `npm test` for offline tests. Run `node scripts/doctor.mjs --cloud` for read-only live cloud checks. See [diagnosis](docs/diagnosis.md) for the original failures and configuration recovery.
