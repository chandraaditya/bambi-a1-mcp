import { publicStatus } from './config.mjs';
import { previousJobName } from './recovery.mjs';

function observed(status) {
  const o = status?.observation, now = Date.now();
  if (status?.connected !== true || !status.raw || o?.source !== 'mqtt' ||
      !Number.isFinite(o.requestedAt) || !Number.isFinite(o.receivedAt) ||
      o.receivedAt < o.requestedAt || o.receivedAt > now || now - o.requestedAt > 15000) {
    throw new Error('Fresh connected printer telemetry is required to identify the control target.');
  }
  return publicStatus(status);
}
const matches = (name, expected) => [expected, `${expected}.3mf`, `${expected}.gcode.3mf`].includes(name);
const active = state => ['RUNNING', 'PREPARE', 'PAUSE'].includes(state);
const jobIdentity = raw => JSON.stringify([previousJobName(raw), raw.task_id,
  raw.subtask_id, raw.project_id, raw.profile_id]);

// Pause/stop must remain available when HMS faults are present. These checks
// identify the operation being stopped; they do not apply print-start gates.
export async function controlWithVerification(runtime, { route, action, expectedJob }) {
  const command = action === 'pause' ? 'pause' : 'stop';
  const result = { ok: false, status: 'not_sent', confirmed: false, command, route };
  let attempted = false, accepted = false, expected = expectedJob, identity;
  const checkTarget = status => {
    const report = observed(status);
    expected ||= report.jobName;
    if (!expected || !matches(report.jobName, expected)) throw new Error('Printer reports a different or unnamed job; no control command was sent.');
    const nextIdentity = jobIdentity(status.raw);
    if (identity && nextIdentity !== identity) throw new Error('Printer job identity changed before control dispatch; no command was sent.');
    identity ||= nextIdentity;
    if (!active(report.state)) throw new Error(`Target job is ${report.state}; no active print was identified for control.`);
    return report;
  };
  try {
    const before = await runtime.status(route);
    result.before = checkTarget(before);
    result.expectedJob = expected;
    if (action === 'pause' && result.before.state === 'PAUSE') {
      return { ...result, ok: true, status: 'already_paused', confirmed: true, after: result.before };
    }
    await runtime.control(route, command, checkTarget, () => { attempted = true; });
    accepted = true;
  } catch (error) {
    result.error = error.message;
  }
  result.dispatchAttempted = attempted;
  result.dispatchAccepted = accepted;
  if (!attempted) return { ...result, nextAction: 'Inspect printer_status or use the printer screen. No command was sent.' };
  // A timeout can occur after a command reaches the printer. Read back once;
  // never retry a physical command merely because its acknowledgement failed.
  try {
    const status = await runtime.status(route), after = observed(status);
    result.after = after;
    if (matches(after.jobName, expected) && jobIdentity(status.raw) === identity) {
      const confirmed = action === 'pause' ? after.state === 'PAUSE' : ['FAILED', 'FINISH', 'IDLE'].includes(after.state);
      if (confirmed) return { ...result, ok: true, status: action === 'pause' ? 'observed_paused' : 'observed_terminal', confirmed: true,
        note: 'Fresh telemetry confirms the target state. It does not prove which actor or event caused that state.' };
    }
  } catch (error) { result.verificationError = error.message; }
  return { ...result, ok: accepted, status: accepted ? 'command_sent' : 'unknown',
    nextAction: 'Execution is not confirmed. Inspect fresh printer_status or use the printer screen; do not assume the printer paused/stopped. No automatic retry was performed.' };
}
