import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { controlWithVerification } from '../src/control.mjs';
import { PrintService } from '../src/service.mjs';

const jobName = 'bambi_11111111-1111-4111-8111-111111111111';
function status(state = 'RUNNING', patch = {}) {
  return { connected: true, model: 'a1', status: state,
    observation: { source: 'mqtt', requestedAt: Date.now(), receivedAt: Date.now() },
    raw: { gcode_state: state, subtask_name: jobName, task_id: 'one', print_error: 0, hms: [], ...patch } };
}
function fixture({ after = status('PAUSE'), before = status(), dispatchState = status(), error } = {}) {
  let reads = 0, sends = 0;
  return { sends: () => sends, runtime: {
    status: async () => {
      const report = reads++ === 0 ? before : after;
      if (report instanceof Error) throw report;
      return report;
    },
    control: async (route, command, check, onDispatch) => {
      check(dispatchState); onDispatch(); sends++;
      if (error) throw new Error(error);
      return { status: 'command_sent' };
    },
  } };
}
const request = { route: 'lan', action: 'pause', expectedJob: jobName };

test('pause is confirmed only by fresh matching readback; faults do not prevent stopping', async () => {
  const f = fixture({ before: status('RUNNING', { hms: [{ attr: 50336000, code: 131073 }] }) });
  const r = await controlWithVerification(f.runtime, request);
  assert.equal(r.status, 'observed_paused'); assert.equal(r.confirmed, true); assert.equal(f.sends(), 1);
});

test('accepted publication with a still-running job is explicitly unconfirmed', async () => {
  const f = fixture({ after: status() }); const r = await controlWithVerification(f.runtime, request);
  assert.equal(r.status, 'command_sent'); assert.equal(r.confirmed, false); assert.equal(r.dispatchAccepted, true);
});

test('transport rejection is not reported as paused and never triggers a retry', async () => {
  const f = fixture({ error: 'plugin rejected code -2', after: status() });
  const r = await controlWithVerification(f.runtime, request);
  assert.equal(r.status, 'unknown'); assert.equal(r.ok, false); assert.equal(r.confirmed, false);
  assert.match(r.error, /-2/); assert.equal(f.sends(), 1);
});

test('a timeout may still be followed by confirmed state, with the error retained', async () => {
  const f = fixture({ error: 'timeout', after: status('PAUSE') });
  const r = await controlWithVerification(f.runtime, request);
  assert.equal(r.status, 'observed_paused'); assert.equal(r.error, 'timeout'); assert.equal(f.sends(), 1);
});

test('missing, stale, changed or wrong-job telemetry prevents dispatch', async () => {
  const stale = status(); stale.observation.requestedAt -= 16000;
  for (const settings of [ { before: new Error('offline') }, { before: stale },
    { before: status('RUNNING', { subtask_name: 'other' }) },
    { dispatchState: status('RUNNING', { task_id: 'two' }) }, { dispatchState: status('FINISH') } ]) {
    const f = fixture(settings), r = await controlWithVerification(f.runtime, request);
    assert.equal(r.status, 'not_sent'); assert.equal(r.confirmed, false); assert.equal(f.sends(), 0);
  }
});

test('another job or unavailable readback never falsely confirms execution', async () => {
  for (const after of [status('PAUSE', { subtask_name: 'other' }), status('PAUSE', { task_id: 'two' }), new Error('readback offline')]) {
    const f = fixture({ after }), r = await controlWithVerification(f.runtime, request);
    assert.equal(r.confirmed, false); assert.equal(f.sends(), 1);
  }
});

test('already paused avoids a command; cancellation confirms only observed terminal state', async () => {
  const f = fixture({ before: status('PAUSE') });
  assert.equal((await controlWithVerification(f.runtime, request)).status, 'already_paused'); assert.equal(f.sends(), 0);
  const cancelled = fixture({ after: status('FAILED') });
  assert.equal((await controlWithVerification(cancelled.runtime, { ...request, action: 'cancel' })).status, 'observed_terminal');
});

test('managed control is serialized, refuses unsubmitted jobs and journals failure across restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambi-control-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { workDir: dir }, id = jobName.slice(6), f = fixture({ error: 'control rejected', after: status() });
  const service = new PrintService(config, f.runtime); fs.mkdirSync(path.join(dir, id));
  service.save({ id, state: 'prepared' });
  await assert.rejects(service.control({ ...request, job_id: id }), /not been submitted/); assert.equal(f.sends(), 0);
  service.save({ id, state: 'printing', printerJobName: jobName });
  const release = service.acquireLock();
  await assert.rejects(service.control({ ...request, job_id: id }), /owns the lock/); release();
  const r = await service.control({ ...request, job_id: id }); assert.equal(r.status, 'unknown');
  const saved = new PrintService(config, f.runtime).get(id).last_control;
  assert.equal(saved.confirmed, false); assert.equal(saved.error, 'control rejected');
  assert.equal(service.get(id).state, 'printing'); // No optimistic state mutation.
});

test('resume requires fault-free paused telemetry on both checks and confirms matching running readback', async () => {
  const request = { route: 'lan', action: 'resume', expectedJob: jobName };
  const f = fixture({ before: status('PAUSE'), dispatchState: status('PAUSE'), after: status('RUNNING') });
  const r = await controlWithVerification(f.runtime, request);
  assert.equal(r.status, 'observed_resumed'); assert.equal(r.confirmed, true); assert.equal(r.command, 'resume');
  assert.equal(f.sends(), 1);
  for (const blocked of [status('RUNNING'), status('FAILED'), status('PAUSE', { print_error: 1 }),
    status('PAUSE', { hms: [{ code: 131073 }] }), status('PAUSE', { hms: undefined }),
    status('PAUSE', { print_error: undefined })]) {
    for (const phase of ['before', 'dispatchState']) {
      const f = fixture({ before: status('PAUSE'), dispatchState: status('PAUSE'), [phase]: blocked });
      const r = await controlWithVerification(f.runtime, request);
      assert.equal(r.status, 'not_sent'); assert.equal(f.sends(), 0);
    }
  }
  const pending = fixture({ before: status('PAUSE'), dispatchState: status('PAUSE'), after: status('PAUSE') });
  assert.equal((await controlWithVerification(pending.runtime, request)).confirmed, false);
});

test('resume requires a managed job and refuses a different paused printer job', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambi-resume-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = fixture({ before: status('PAUSE', { subtask_name: 'other' }) });
  const service = new PrintService({ workDir: dir }, f.runtime), id = jobName.slice(6);
  await assert.rejects(service.control({ route: 'lan', action: 'resume' }), /requires the managed job_id/);
  fs.mkdirSync(path.join(dir, id)); service.save({ id, state: 'paused', printerJobName: jobName });
  const r = await service.control({ route: 'lan', action: 'resume', job_id: id });
  assert.equal(r.status, 'not_sent'); assert.equal(f.sends(), 0);
});
