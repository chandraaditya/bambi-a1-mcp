import test from 'node:test';
import assert from 'node:assert/strict';
import { BambuImplementation } from 'bambu-printer-mcp/dist/printers/bambu.js';
import { createRuntime } from '../src/runtime.mjs';

test('camera uses the configured A1 LAN endpoint and never requests hardware confirmation or writes files', async t => {
  let calls = 0;
  const frame = { status: 'success', format: 'image/jpeg', base64: 'test', sizeBytes: 3, transport: 'tcp-6000' };
  t.mock.method(BambuImplementation.prototype, 'cameraSnapshot', async function(host, serial, token, options) {
    calls++;
    assert.equal(this.confirm, undefined);
    assert.deepEqual([host, serial, token], ['printer.invalid', 'fixture-serial', 'fixture-code']);
    assert.deepEqual(options, { bambuModel: 'a1', timeoutMs: 8000 });
    return frame;
  });
  const runtime = createRuntime({ host: 'printer.invalid', serial: 'fixture-serial', accessCode: 'fixture-code' });
  assert.equal(await runtime.cameraSnapshot(8000), frame);
  assert.equal(calls, 1);
});

test('camera fails clearly without LAN configuration and propagates a timeout without retry', async t => {
  let calls = 0;
  t.mock.method(BambuImplementation.prototype, 'cameraSnapshot', async () => { calls++; throw new Error('camera timed out'); });
  await assert.rejects(createRuntime({}).cameraSnapshot(), /requires the configured LAN host/);
  assert.equal(calls, 0);
  await assert.rejects(createRuntime({ host: 'printer.invalid', accessCode: 'fixture-code' }).cameraSnapshot(), /camera timed out/);
  assert.equal(calls, 1);
});
