import { createHash } from 'node:crypto';

export const previousJobName = raw => raw?.subtask_name || raw?.gcode_file;

// FAILED describes a terminal job, not necessarily an active machine fault.
// Studio: MachineObject::is_printing_finished() includes FINISH and FAILED.
// Recovery is a new, explicitly requested print, never a resume or fault reset.
export function validateA1Recovery(raw, recovery) {
  if (raw.gcode_state !== 'FAILED') return false;
  if (!recovery || recovery.bed_cleared !== true ||
      typeof recovery.previous_job_name !== 'string' || !recovery.previous_job_name.trim()) {
    throw new Error('Previous job ended FAILED. Inspect printer_status and confirm the bed is cleared, then supply recovery.previous_job_name and recovery.bed_cleared:true to print_job. No command was sent.');
  }
  if (previousJobName(raw) !== recovery.previous_job_name) {
    throw new Error('Recovery names a different previous job. Read fresh printer_status before proceeding.');
  }
  if (raw.print_type !== 'idle' || raw.stg_cur !== 255 ||
      (raw.job !== undefined && (!raw.job || ![0, 8, 9].includes(raw.job.job_state)))) {
    throw new Error('Recovery requires an explicitly idle printer with no active print or calibration stage.');
  }
  if (raw.print_error !== 0 || !Array.isArray(raw.hms) || raw.hms.length !== 0) {
    throw new Error('Recovery requires zero print_error and an empty HMS list. Inspect and resolve reported faults first.');
  }
  if (raw.nozzle_target_temper !== 0 || raw.bed_target_temper !== 0) {
    throw new Error('Recovery requires both heater targets explicitly off. Wait for the prior operation to end.');
  }
  return true;
}

export function recoveryIdentity(raw) {
  return createHash('sha256').update(JSON.stringify([
    raw.gcode_state, raw.subtask_name, raw.gcode_file, raw.task_id, raw.subtask_id,
    raw.project_id, raw.profile_id, raw.print_type, raw.stg_cur, raw.job?.job_state,
  ])).digest('hex');
}

// Read-only explanation, not dispatch authorization. Full fresh identity,
// material and nozzle validation still runs on every print preflight.
export function recoveryStatus(raw) {
  if (raw.gcode_state !== 'FAILED') return undefined;
  const previous_job_name = previousJobName(raw);
  try {
    validateA1Recovery(raw, { previous_job_name, bed_cleared: true });
    return { eligible: true, previous_job_name,
      nextAction: 'After the user confirms the plate is clear and requests a new print, pass recovery:{previous_job_name,bed_cleared:true} to print_job. This does not resume or replay the previous job.' };
  } catch (error) {
    return { eligible: false, previous_job_name, nextAction: error.message };
  }
}
