# Live acceptance — 2026-11-04

## Scope

One previously sliced and approved single-plate A1 job, unchanged across file inspection, snapshot and dispatch. SHA-256 was independently checked against the user's approved source. The private source file, credentials, serial, LAN address, cloud request identifiers and camera captures are not published.

Configuration: A1, 0.4 mm stainless nozzle, textured PEI, external PLA spool, no AMS, bed leveling on, timelapse off. The file contains 375 layers and an estimated 126 minutes of printing.

## Observations

1. Fresh telemetry before each experiment showed the previous job `FINISH`, heaters off, no print error and no HMS entries. The other agent held all submissions; no duplicate work was pending.
2. The cloud path uploaded the file completely, then returned `-3120`, HTTP 403, reason `internal blocking`. Changing only `connection_type` from `cloud` to an empty string produced the same result. Fresh status still showed the previous job. That experiment did not fix cloud printing.
3. Both host TCP probes and the signed LAN session became reachable. The cause of the earlier LAN timeouts was not established; no network/privacy/firmware setting was changed.
4. `print_job` via the real stdio MCP, with no elicitation capability, returned a successful signed LAN submission. Independent cloud telemetry matched its unique expected job name and showed `RUNNING`, 375 total layers, and heating/preparation at layer 0.
5. The new `verify_job` tool, also exercised through a real stdio client, observed the matching job at layer 1, nozzle target 205 C and bed target 65 C. A lit live camera capture showed deposited material in the hanger footprint. The light was returned to off.
6. During preparation the printer reported HMS `0300-1100-0002-0001`. The installed Bambu Studio HMS table identifies low Y-axis resonance and a possibly loose timing belt. Printing continued with `print_error: 0`; the entry was reported to the user and not cleared. This is not a claim of warning-free operation or completed-part quality.

7. Later read-only checks reproduced the LAN timeout on both the existing and fresh runtime configurations. Direct TCP probes narrowed it to port 8883: both macOS and Docker could reach FTPS 990, while MQTT 8883 timed out. Closing retired MCP clients did not resolve it. Cloud telemetry continued to report advancing layers. No printer restart, fault clearing or mode change was performed. The reason the printer stopped accepting new MQTT TCP connections remains unknown.

## Reproducibility

The public runtime installer downloads FULU v1.0.0 and Bambu Linux networking plug-in 02.05.02.58 directly from the publishers, verifies the exact archive hashes, and records extracted-file hashes. A fresh installation and a subsequent integrity-check run both succeeded on the test Mac. The installer does not depend on the user's older MCP installation. Fresh generated setup and imported session successfully initialized the new runtime and read live cloud telemetry; its LAN probe encountered the same port-8883 timeout as the original configuration.

The verified remote arrangement is cloud monitoring plus LAN submission from a nearby host. SSH stdio is documented for reaching that host remotely, but an off-site SSH deployment was not part of this hardware test. Direct Bambu Cloud submission remains unsuccessful on this runtime.

A print command being accepted is not completion evidence. Use `verify_job` or `bambi watch JOB_ID --route cloud` to follow the matching job to a terminal state, then inspect the physical part.
