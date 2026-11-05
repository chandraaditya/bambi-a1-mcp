import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureControlReady } from '../src/control-readiness.mjs';

function fixture({ route = 'lan', codes = [0], certCode = 0, reply = {} } = {}) {
  const calls = [], queue = []; let sequence = 24000, sends = 0;
  const config = { serial: 'test-device', nozzle: 0.4 };
  const bridge = {
    async callWithAgent(method, payload) {
      calls.push(method);
      if (method === 'net.install_device_cert') assert.equal(payload.lan_only, route === 'lan');
      if (!['net.send_message_to_printer', 'net.send_message'].includes(method)) return { ok: true, value: certCode };
      assert.equal(method, route === 'lan' ? 'net.send_message_to_printer' : 'net.send_message');
      const print = JSON.parse(payload.msg).print;
      assert.equal(print.command, 'extrusion_cali_get_result');
      const value = codes[sends++];
      if (value === 0) queue.push({ name: reply.event || (route === 'lan' ? 'on_local_message' : 'on_message'), payload: {
        dev_id: reply.device || config.serial,
        msg: JSON.stringify({ print: { ...print, result: 'success', ...reply.message } }),
      } });
      return { ok: true, value };
    },
    async request() { return { events: queue.splice(0) }; },
  };
  return { calls, run: () => ensureControlReady({ route, bridge, config, options: {},
    session: { settle: async () => { calls.push('settle'); } },
    nextSequence: () => String(++sequence), replyTimeoutMs: 50 }) };
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
  for (const route of ['lan', 'cloud']) {
  for (const reply of [{ device: 'another-device' }, { message: { sequence_id: 'stale' } },
    { message: { command: 'push_status' } }, { message: { result: 'failed' } },
    { event: route === 'lan' ? 'on_message' : 'on_local_message' }]) {
    await assert.rejects(fixture({ route, reply }).run(), /No control command was sent/);
  }
  }
});

test('cloud readiness completes cloud certificate exchange without opening a LAN channel', async () => {
  for (const code of [-2, -4]) {
    const f = fixture({ route: 'cloud', codes: [code, 0] }); await f.run();
    assert.deepEqual(f.calls, ['net.send_message', 'settle', 'net.update_cert',
      'net.install_device_cert', 'settle', 'net.send_message']);
  }
});

test('cloud readiness failures are bounded and do not fall back to LAN', async () => {
  for (const options of [{ codes: [-2, -2] }, { codes: [-11] }, { codes: [-2], certCode: -1 }]) {
    const f = fixture({ route: 'cloud', ...options });
    await assert.rejects(f.run(), /Cloud control readiness.*No control command was sent/);
    assert.ok(!f.calls.includes('net.send_message_to_printer'));
    assert.ok(f.calls.filter(c => c === 'net.send_message').length <= 2);
  }
});
