import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrintService } from '../src/service.mjs';

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bambi-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'model.3mf'); fs.writeFileSync(file, 'private model');
  const calls = [];
  const config = { workDir: path.join(directory, 'jobs'), serial: 'test-serial', host: 'test-host', accessCode: 'test-secret', bedType: 'textured_plate' };
  const inspection = { model: 'a1', materials: ['PLA'], usedFilamentPositions: [0], nozzleDiameters: [0.4] };
  const runtime = {
    inspect: async () => structuredClone(inspection), status: async route => { calls.push(['status', route]); return {}; },
    validate: () => {}, dispatch: async (route, params, preflight, sent) => {
      await preflight(); sent(); calls.push(['dispatch', route, params]); return { ok: true, value: 0 };
    }, ...overrides,
  };
  return { service: new PrintService(config, runtime), runtime, file, calls, config };
}

test('cloud dispatch uses only cloud telemetry and omits LAN credentials', async t => {
  const { service, file, calls } = fixture(t);
  const job = await service.prepare({ file_path: file, plate_index: 2 });
  const result = await service.print({ job_id: job.job_id, route: 'cloud' });
  assert.equal(result.state, 'command_sent');
  assert.deepEqual(calls.filter(c => c[0] === 'status'), [['status', 'cloud'], ['status', 'cloud']]);
  const params = calls.find(c => c[0] === 'dispatch')[2];
  assert.equal(params.password, ''); assert.equal(params.dev_ip, ''); assert.equal(params.plate_index, 3);
  assert.equal(params.ams_mapping, '[254]');
  assert.equal(params.ams_mapping2, '[{"ams_id":254,"slot_id":254}]');
  assert.equal(params.task_bed_leveling, true);
});

test('repeated tool calls and restarts never dispatch the same job twice', async t => {
  const { service, file, calls, config, runtime } = fixture(t);
  const job = await service.prepare({ file_path: file });
  await service.print({ job_id: job.job_id, route: 'lan' });
  const restarted = new PrintService(config, runtime);
  await restarted.print({ job_id: job.job_id, route: 'lan' });
  assert.equal(calls.filter(c => c[0] === 'dispatch').length, 1);
});

test('timeout after sending is persisted as unknown and never retried', async t => {
  let attempts = 0;
  const { service, file } = fixture(t, { dispatch: async (r, p, check, sent) => { attempts++; sent(); throw new Error('timeout'); } });
  const job = await service.prepare({ file_path: file });
  await assert.rejects(service.print({ job_id: job.job_id, route: 'cloud' }), /outcome is unknown/);
  assert.equal(service.get(job.job_id).state, 'unknown');
  assert.equal(service.read(job.job_id).lastError, 'timeout');
  await service.print({ job_id: job.job_id, route: 'cloud' });
  assert.equal(attempts, 1);
});

test('a failed preflight never sends and leaves the job prepared', async t => {
  const { service, file, calls } = fixture(t, { validate: () => { throw new Error('busy'); } });
  const job = await service.prepare({ file_path: file });
  await assert.rejects(service.print({ job_id: job.job_id, route: 'lan' }), /busy/);
  assert.equal(service.get(job.job_id).state, 'prepared');
  assert.equal(calls.filter(c => c[0] === 'dispatch').length, 0);
});

test('cloud rejection exposes the HTTP cause and privately retains callback diagnostics without replay', async t => {
  let attempts = 0;
  const diagnostics = [{ status: 3, code: -3120,
    msg: '[http code]: 403\n[request_id]: private-request-id\n[reason]: internal blocking' }];
  const { service, file } = fixture(t, { dispatch: async (r, p, check, sent) => {
    attempts++; sent(); return { ok: true, value: -3120, diagnostics };
  } });
  const job = await service.prepare({ file_path: file });
  await assert.rejects(service.print({ job_id: job.job_id, route: 'cloud' }), error => {
    assert.match(error.message, /code -3120, HTTP 403, reason: internal blocking/);
    assert.ok(!error.message.includes('private-request-id')); return true;
  });
  assert.deepEqual(service.read(job.job_id).dispatchDiagnostics, diagnostics);
  assert.ok(!JSON.stringify(service.get(job.job_id)).includes('private-request-id'));
  await service.print({ job_id: job.job_id, route: 'cloud' });
  assert.equal(attempts, 1);
});

test('mutated snapshots are rejected before telemetry or dispatch', async t => {
  const { service, file, calls } = fixture(t);
  const job = await service.prepare({ file_path: file });
  fs.chmodSync(job.file, 0o600); fs.writeFileSync(job.file, 'changed');
  await assert.rejects(service.print({ job_id: job.job_id, route: 'cloud' }), /file changed/);
  assert.equal(calls.length, 0);
});

test('invalid AMS mapping, missing route, and concurrent lock are rejected', async t => {
  const { service, file, config } = fixture(t);
  const job = await service.prepare({ file_path: file });
  await assert.rejects(service.print({ job_id: job.job_id }), /explicitly/);
  await assert.rejects(service.print({ job_id: job.job_id, route: 'lan', ams_mapping: [4] }), /AMS Lite/);
  fs.mkdirSync(path.join(config.workDir, '.printer-operation'));
  await assert.rejects(service.print({ job_id: job.job_id, route: 'lan' }), /owns the lock/);
});

test('an unsliced or incompatible file fails inspection before a job is saved', async t => {
  const { service, file, config } = fixture(t, { inspect: async () => { throw new Error('not sliced'); } });
  await assert.rejects(service.prepare({ file_path: file }), /not sliced/);
  assert.deepEqual(fs.readdirSync(config.workDir), []);
});


test('verification requires an exact job name, distinguishes preparation from layers, and survives restart', async t => {
  let raw;
  const { service, runtime, file, config, calls } = fixture(t);
  const job = await service.prepare({ file_path: file });
  await service.print({ job_id: job.job_id, route: 'lan' });
  runtime.status = async route => { calls.push(['verify-status', route]); return {
    model: 'a1', status: raw.gcode_state, raw, observation: { receivedAt: Date.now() },
  }; };
  raw = { gcode_state: 'FINISH', subtask_name: 'previous-job', mc_percent: 100, layer_num: 100 };
  let result = await service.verify({ job_id: job.job_id, route: 'cloud' });
  assert.equal(result.matched, false); assert.equal(result.state, 'command_sent');
  raw = { ...raw, gcode_state: 'RUNNING', subtask_name: `bambi_${job.job_id}`, mc_percent: 0, layer_num: 0 };
  result = await service.verify({ job_id: job.job_id, route: 'cloud' });
  assert.equal(result.state, 'preparing'); assert.ok(result.started_at);
  raw.layer_num = 1;
  result = await service.verify({ job_id: job.job_id, route: 'cloud' });
  assert.equal(result.state, 'printing');
  const restarted = new PrintService(config, runtime);
  assert.equal(restarted.get(job.job_id).last_observation.layer, 1);
  await restarted.print({ job_id: job.job_id, route: 'lan' });
  assert.equal(calls.filter(c => c[0] === 'dispatch').length, 1);
  raw.gcode_state = 'FINISH'; raw.mc_percent = 100;
  result = await restarted.verify({ job_id: job.job_id, route: 'cloud' });
  assert.equal(result.state, 'completed'); assert.ok(result.completed_at);
});

test('verification cannot race dispatch and does not query or mark an unsubmitted job', async t => {
  const { service, file, config, calls } = fixture(t);
  const job = await service.prepare({ file_path: file });
  const result = await service.verify({ job_id: job.job_id, route: 'cloud' });
  assert.equal(result.state, 'prepared'); assert.equal(result.matched, false); assert.equal(calls.length, 0);
  fs.mkdirSync(path.join(config.workDir, '.printer-operation'));
  await assert.rejects(service.verify({ job_id: job.job_id }), /owns the lock/);
});

test('verification failure preserves the non-replayable submitted record and releases the lock', async t => {
  const { service, runtime, file, config } = fixture(t);
  const job = await service.prepare({ file_path: file });
  await service.print({ job_id: job.job_id, route: 'lan' });
  runtime.status = async () => { throw new Error('offline'); };
  await assert.rejects(service.verify({ job_id: job.job_id }), /offline/);
  assert.equal(service.get(job.job_id).state, 'command_sent');
  assert.equal(fs.existsSync(path.join(config.workDir, '.printer-operation')), false);
});
