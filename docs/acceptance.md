# Live acceptance

## PETG plate and camera — 2026-11-05

The operator loaded external-spool PETG and explicitly requested hardware testing and printing a previously approved two-part plate. The existing sliced archive was inspected and snapshotted unchanged: A1 / 0.4 mm stainless nozzle / textured PEI, two parts, 190 layers, 2 walls, 8% gyroid, 240 C printing temperature, 80 C bed, 52.17 g and a 144-minute slicer estimate. The archive and prepared snapshot had identical SHA-256 hashes. Personal model files and hashes remain in the private job journal.

Before dispatch, independent LAN and cloud telemetry agreed on a finished previous job, zero heater targets, PETG on the external spool, zero print error and no HMS warnings. A live camera frame showed the plate clear. MCP control checks refused both an unsubmitted managed job and the already finished printer job, without publishing a physical command.

One `print_job` call through the real stdio MCP accepted signed LAN submission with bed leveling and flow calibration. Cloud `verify_job` independently matched the new unique job name and observed heating/preparation. No cloud print submission, fallback, second submission, printer-mode change or fault clearing occurred.

The new `camera_snapshot` tool was exercised through a real MCP client and returned JPEG image content from the A1. This provides an agent with visual evidence when zero error telemetry alone cannot establish adhesion. It is not automatic spaghetti detection or automatic pausing.

Independent cloud observations subsequently matched layers 1 and 2 of 190 at 240 C nozzle / 80 C bed, with zero print error and no HMS entries. MCP camera frames showed two white footprints lying on the plate and no visible spaghetti; the head and low camera angle obscure portions of the print, so this does not certify adhesion or final quality.

At layer 2, the explicit LAN pause test returned plug-in code -4. Fresh matching readback still showed RUNNING. A separate cloud-route pause test returned code -2, again followed by fresh matching RUNNING telemetry. Both calls returned `isError: true`, `confirmed: false`, `status: unknown`, preserved the observed state and journaled the failure. Neither tool automatically retried. No resume was sent because a paused target was never observed. Cancellation was not tested by discarding the production print. Direct cloud print submission was not retested.

Control sequence IDs were aligned with Studio's signed 32-bit integer representation before these tests. That format correction did not fix either rejection; the cause remains unresolved. Reliable pause/resume/cancel is not established, and physical print completion remains pending.

### Read-only control diagnosis

A subsequent LAN probe added the cloud-message callback and allowed an additional ten seconds of event settling. It observed a successful local connection and fresh advancing print telemetry. A single read-only `extrusion_cali_get_result` request, using the payload shape from Bambu Studio and a numeric sequence ID of 24001, returned the same -4 code. No pause, resume, cancel, calibration start, setting change or print submission was sent during this probe. This establishes that the observed send failure is not specific to pause; it does not identify the root cause or prove a certificate/signing failure. No certificate-ready event was observed, which alone is not proof that certificate setup failed.

Independent cloud verification subsequently matched layer 20 of 190, approximately 115 minutes remaining, 240 C nozzle / 80 C bed, zero print error and no HMS entries. Completion and finished-part quality remain unverified.

Primary reference: [Bambu Studio calibration-result query](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/DeviceManager.cpp).

### LAN pause and resume verified after readiness correction

Further read-only probes isolated two reproducible differences. After an initial query returned -4, waiting for the vendor certificate exchange, reinstalling/updating the device certificate and waiting for `device_cert_installed` allowed the next query to publish successfully. A same-session comparison then returned error 84033546 for sequence ID 500004, while the identical query with ID 24008 returned `result: success`. Bambu Studio defines its command sequence window as 20000 through 29999. This is evidence for using that range on this A1; it is not a claim that every printer rejects all other values.

The runtime now uses that sequence window, registers the certificate message callback and proves LAN command readiness with the read-only `extrusion_cali_get_result` query. A bounded certificate-bootstrap recovery may repeat that query once, never the physical command. Readiness requires a successful reply matched by printer, command and sequence ID; socket connection or publication success alone is insufficient. The exact active job is checked both before and after readiness. Any readiness failure returns `not_sent`, with `dispatchAttempted: false`.

A real stdio MCP `control_print` call subsequently paused the managed PETG job at layer 44: publication succeeded and fresh readback confirmed the exact job in `PAUSE`, with zero print error and no HMS entries. A separately requested guarded resume then succeeded and fresh readback confirmed the same job `RUNNING`, nozzle target restored to 240 C, bed target 80 C, zero print error and no HMS entries. Exactly one physical pause and one resume were sent for this successful test. The earlier readiness-guard failure sent neither. No cancellation, duplicate print, fault clear or printer-mode change was performed.

All 57 automated tests pass, including failed readiness, stale/wrong query replies, job changes during readiness, and no retry after physical-command rejection. Cloud control remains unresolved. Cancellation was not tested by discarding the production print. Completed-part quality remains unverified.

Primary references: [Studio sequence window](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/DeviceCore/DevUtil.h), [read-only query payload](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/DeviceManager.cpp).

## Hanger tests — 2026-11-04

**First test outcome: unsuccessful physical print.** The user reported that parts shifted and came off the plate, followed by spaghetti extrusion, and stopped the job at layer 33. Matching fresh telemetry confirmed `FAILED`, nozzle/bed targets zero. A fresh post-stop camera image could not be obtained: direct camera requests timed out and the Studio UI was unavailable. The user observation establishes detachment from the plate; why the parts detached is not established, and the Y-axis HMS warning is not by itself proof of its cause. The failure report itself did not authorize a retry; a later explicit user request did, as recorded below.

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

## Stopped-print follow-up

The user described parts shifting and coming off the plate, followed by spaghetti extrusion. This is user-observed evidence; no post-failure camera image was available for independent inspection. The unchanged archive contains `brim_type = no_brim`, initial-layer settings of 50 mm/s for walls and 105 mm/s for infill, and actual G-code temperature commands of 205 C nozzle / 65 C bed. Its project metadata says 220 C nozzle, so the executable temperature commands and matching telemetry take precedence over that metadata. These settings are observations, not proof of the cause. No file edits, re-slicing, fault clearing or printer adjustment followed the failure report. The user subsequently reported cleaning the plate and explicitly requested one fresh print of the same file. A new durable job was prepared, and its SHA-256 matched the approved file.

The explicitly authorized retry was blocked by preflight with `Printer state FAILED is not safely idle.` No new dispatch was sent, and the prepared retry remains unsubmitted. Returning to the ready screen did not change fresh LAN telemetry from `FAILED`; the Y-axis HMS entry remained present. A later live camera capture succeeded and showed the plate cleared. The user reported having tightened the belt and started calibration. Printing is held pending that calibration and fresh preflight checks; no safety validation was removed or overridden.

## Explicit terminal-job recovery (v0.2.1)

The A1 retained `FAILED` after the calibration job ended, with `print_type: idle`, `stg_cur: 255`, both heater targets zero, `print_error: 0` and an empty HMS list. Bambu Studio's `MachineObject::is_printing_finished()` classifies both `FINISH` and `FAILED` as finished jobs. The pinned MCP dependency had narrow terminal-job handling for other models, but none for this A1 condition. Asking the user to dismiss the screen did not change that telemetry, and a reboot was not performed for the successful recovery below.

The updated MCP accepts an explicit recovery acknowledgement bound to the exact previous job name and a cleared bed. It still validates the original fresh telemetry, idle stage, heater targets, print errors, HMS, model, nozzle, material and file integrity. The previous job identity is checked again before transmission. No telemetry was rewritten, no fault was cleared, and no previous job was resumed or replayed.

The user explicitly requested the recovery fix and another print after cleaning the plate. A fresh camera image showed the plate clear. `print_job` through the real stdio MCP accepted the unchanged prepared retry over signed LAN. Independent cloud telemetry matched its unique new job name and reported `RUNNING`, layer 0 of 375, with no print errors or HMS entries. This proves recovery and submission, not yet a completed acceptable physical part.

Validation: 33 automated tests cover recovery rejection for active/calibrating states, malformed or stale reports, identity and material/nozzle mismatches, actionable HMS, heater targets, changed previous-job identity, repeated calls and server restarts. A release tarball was installed into a clean prefix and its actual stdio tool schema was verified without elicitation support.

Primary reference: [Bambu Studio device state classification](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/DeviceManager.cpp).

### Subsequent warning and control limitation

After the recovered job started, a newly timestamped Y-axis low-resonance HMS entry appeared again during preparation. Fresh telemetry then confirmed the new job actually printing at layers 1 and 2 of 375, with nozzle target 205 C, bed target 65 C and `print_error: 0`. The warning is not proof of a loose belt or a failed physical part. Initial camera frames were too obstructed by the bed/head angle to establish adhesion quality.

A precautionary pause attempt through `control_print` failed: the cloud call returned code -2, and the LAN call also rejected the control command. Subsequent telemetry still showed RUNNING, so no pause success is claimed. The operator was informed. Reliable remote pause/cancel is therefore not established on this runtime, even though print submission and monitoring work. No further print, resume or fault-clear command was sent. Physical completion remains unverified.
