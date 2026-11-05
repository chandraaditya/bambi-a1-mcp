import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureLanControlReady } from '../src/lan-control-readiness.mjs';

function fixture({ codes = [0], certCode = 0, reply = {} } = {}) {
  const calls = [], queue = []; let sequence = 24000, sends = 0;
  const config = { serial: 'test-device', nozzle: 0.4 };
  const bridge = {
    async callWithAgent(method, payload) {
      calls.push(method);
      if (method !== 'net.send_message_to_printer') return { ok: true, value: certCode };
      const print = JSON.parse(payload.msg).print;
      assert.equal(print.command, 'extrusion_cali_get_result');
      const value = codes[sends++];
      if (value === 0) queue.push({ name: 'on_local_message', payload: {
        dev_id: reply.device || config.serial,
        msg: JSON.stringify({ print: { ...print, result: 'success', ...reply.message } }),
      } });
      return { ok: true, value };
    },
    async request() { return { events: queue.splice(0) }; },
  };
  return { calls, run: () => ensureLanControlReady({ bridge, config, options: {},
    session: { settle: async () => { calls.push('settle'); } },
    nextSequence: () => String(++sequence), replyTimeoutMs: 1 }) };
}

test('readiness requires the matching read-only reply and avoids unnecessary certificate exchange', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.calls, ['net.send_message_to_printer']);
});

test('certificate bootstrap repeats only the read-only query after an initial send failure', async () => {
  for (const code of [-4, -4030]) {
    const f = fixture({ codes: [code, 0] }); await f.run();
    assert.deepEqual(f.calls, ['net.send_message_to_printer', 'settle', 'net.install_device_cert',
      'net.update_cert', 'settle', 'net.send_message_to_printer']);
  }
});

test('persistent query failure, unrelated errors and failed certificate setup fail closed', async () => {
  for (const options of [{ codes: [-4, -4] }, { codes: [-2] }, { codes: [-4], certCode: -1 }]) {
    const f = fixture(options);
    await assert.rejects(f.run(), /No control command was sent/);
    assert.ok(f.calls.filter(c => c === 'net.send_message_to_printer').length <= 2);
  }
});

test('publication without a matching successful printer reply is insufficient', async () => {
  for (const reply of [{ device: 'another-device' }, { message: { sequence_id: 'stale' } },
    { message: { command: 'push_status' } }, { message: { result: 'failed' } }]) {
    await assert.rejects(fixture({ reply }).run(), /No control command was sent/);
  }
});
