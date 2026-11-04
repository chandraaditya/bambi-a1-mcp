import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePrinterState } from '../src/vendor/printer-state.mjs';
import { validatePrinterState as upstreamValidate } from 'bambu-printer-mcp/dist/safety/printer-state.js';
import { recoveryStatus } from '../src/recovery.mjs';
import { PrintService } from '../src/service.mjs';

const recovery = { previous_job_name: 'auto_cali_for_user_param.gcode', bed_cleared: true };
const requirements = { model: 'a1', nozzleDiameters: [0.4], nozzleTypes: ['stainless_steel'],
  nozzleFlows: ['standard'], materials: ['PLA'], usedFilamentPositions: [0], useAMS: false, amsMapping: [254] };
function status(patch = {}) {
  return { connected: true, serial: '039TEST', model: 'a1', status: 'FAILED',
    observation: { source: 'mqtt', requestedAt: Date.now(), receivedAt: Date.now() },
    raw: { model_id: 'N2S', serial: '039TEST', gcode_state: 'FAILED', subtask_name: recovery.previous_job_name,
      task_id: 'old-task', print_type: 'idle', stg_cur: 255, print_error: 0, hms: [],
      nozzle_target_temper: 0, bed_target_temper: 0, nozzle_diameter: '0.4', nozzle_type: 'stainless_steel',
      vt_tray: { tray_type: 'PLA' }, ...patch } };
}

test('observed terminal A1 job requires explicit named recovery and retains original telemetry', () => {
  const observed = status(), original = structuredClone(observed);
  assert.throws(() => upstreamValidate(observed, requirements), /not safely idle/);
  assert.throws(() => validatePrinterState(observed, requirements), /Previous job ended FAILED/);
  assert.throws(() => validatePrinterState(observed, { ...requirements, recovery: { ...recovery, bed_cleared: false } }), /confirm the bed/);
  validatePrinterState(observed, { ...requirements, recovery });
  assert.deepEqual(observed, original);
  assert.equal(recoveryStatus(observed.raw).eligible, true);
  assert.throws(() => validatePrinterState(observed, { ...requirements, recovery: { ...recovery, previous_job_name: 'other' } }), /different previous job/);
});

test('recovery never accepts active, ambiguous or faulted printer reports', () => {
  for (const patch of [
    ...['RUNNING', 'PAUSE', 'PREPARE', 'SLICING', 'UNKNOWN'].map(gcode_state => ({ gcode_state })),
    { print_type: 'local' }, { print_type: undefined }, { stg_cur: 3 }, { stg_cur: undefined },
    { job: { job_state: 4 } }, { job: {} }, { job: null },
    { print_error: 1 }, { print_error: undefined }, { hms: undefined },
    { hms: [{ attr: 50336000, code: 131073 }] },
    { nozzle_target_temper: 205 }, { bed_target_temper: 65 }, { nozzle_target_temper: undefined },
    { subtask_name: 'different-job' },
  ]) {
    assert.throws(() => validatePrinterState(status(patch), { ...requirements, recovery }), JSON.stringify(patch));
  }
});

test('recovery retains freshness, identity, nozzle and material validation', () => {
  for (const patch of [{ serial: '039OTHER' }, { model_id: 'C12' }, { nozzle_diameter: '0.6' },
    { nozzle_type: 'hardened_steel' }, { vt_tray: { tray_type: 'ABS' } }]) {
    assert.throws(() => validatePrinterState(status(patch), { ...requirements, recovery }), JSON.stringify(patch));
  }
  const stale = status(); stale.observation.requestedAt -= 16000;
  assert.throws(() => validatePrinterState(stale, { ...requirements, recovery }), /fresh observed/);
  const disconnected = status(); disconnected.connected = false;
  assert.throws(() => validatePrinterState(disconnected, { ...requirements, recovery }), /connected/);
});

test('ordinary idle and finished-job validation remains equivalent to upstream', () => {
  for (const state of ['IDLE', 'FINISH']) {
    const observed = status({ gcode_state: state });
    assert.deepEqual(validatePrinterState(observed, requirements), upstreamValidate(observed, requirements));
    assert.throws(() => validatePrinterState(status({ gcode_state: state, print_error: 1 }), requirements), /print error/);
  }
});

function serviceFixture(t, reports) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambi-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'model.3mf'); fs.writeFileSync(file, 'test model');
  const config = { workDir: path.join(dir, 'jobs'), serial: '039TEST', bedType: 'textured_plate' };
  let sent = 0;
  const runtime = { inspect: async () => structuredClone(requirements), validate: validatePrinterState,
    status: async () => reports.shift(), dispatch: async (r, p, preflight, onSent) => {
      await preflight(); onSent(); sent++; return { ok: true, value: 0 };
    } };
  return { file, config, runtime, service: new PrintService(config, runtime), sent: () => sent };
}

test('recovery is rechecked before dispatch and remains idempotent after a server restart', async t => {
  const f = serviceFixture(t, [status(), status()]);
  const job = await f.service.prepare({ file_path: f.file });
  await f.service.print({ job_id: job.job_id, route: 'lan', recovery });
  assert.equal(f.sent(), 1);
  assert.equal(f.service.get(job.job_id).recovery.previous_job_name, recovery.previous_job_name);
  const restarted = new PrintService(f.config, f.runtime);
  await restarted.print({ job_id: job.job_id, route: 'lan', recovery });
  assert.equal(f.sent(), 1);
});

test('changed job or new fault between preflights prevents transmission and preserves prepared job', async t => {
  for (const patch of [{ task_id: 'new-task' }, { gcode_state: 'RUNNING' }, { hms: [{ attr: 50336000, code: 131073 }] }]) {
    const f = serviceFixture(t, [status(), status(patch)]);
    const job = await f.service.prepare({ file_path: f.file });
    await assert.rejects(f.service.print({ job_id: job.job_id, route: 'lan', recovery }));
    assert.equal(f.sent(), 0); assert.equal(f.service.get(job.job_id).state, 'prepared');
    assert.ok(f.service.get(job.job_id).last_preflight_error);
  }
});

test('a corrected pre-dispatch failure clears obsolete errors on the next successful request', async t => {
  const f = serviceFixture(t, [status(), status({ task_id: 'new-task' }), status(), status()]);
  const job = await f.service.prepare({ file_path: f.file });
  await assert.rejects(f.service.print({ job_id: job.job_id, route: 'lan', recovery }), /identity changed/);
  const result = await f.service.print({ job_id: job.job_id, route: 'lan', recovery });
  assert.equal(result.state, 'command_sent'); assert.equal(f.sent(), 1);
  assert.equal(result.error, undefined); assert.equal(result.last_preflight_error, undefined);
});
