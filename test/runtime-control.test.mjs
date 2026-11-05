import test from 'node:test';
import assert from 'node:assert/strict';
import { BambuNetworkBridge } from 'bambu-printer-mcp/dist/bambu-network-bridge.js';
import { CloudBridge } from '../src/cloud-bridge.mjs';
import { createRuntime } from '../src/runtime.mjs';

const config = { serial: '039TEST', host: 'printer.invalid', accessCode: 'fixture-code',
  bridgeCommand: 'unused-in-this-test', bridgeConfigDir: '/unused-test-directory', country: 'US' };

test('cloud control waits for a fresh report and caller target check before publishing', async t => {
  const events = [], report = { raw: { gcode_state: 'RUNNING' } };
  t.mock.method(CloudBridge.prototype, 'connect', async () => { events.push('connect'); });
  t.mock.method(CloudBridge.prototype, 'status', async () => { events.push('fresh-status'); return report; });
  t.mock.method(CloudBridge.prototype, 'send', async message => {
    assert.equal(message.print.command, 'pause');
    assert.match(message.print.sequence_id, /^\d+$/);
    assert.ok(Number(message.print.sequence_id) >= 20000 && Number(message.print.sequence_id) < 30000);
    events.push('publish');
  });
  await createRuntime(config).control('cloud', 'pause', s => { assert.equal(s, report); events.push('check'); }, () => events.push('attempt'));
  assert.deepEqual(events, ['connect', 'fresh-status', 'check', 'attempt', 'publish']);
});

function lan(t, rejection = 0, readyCode = 0) {
  const events = [], queued = [];
  t.mock.method(BambuNetworkBridge.prototype, 'withLocalSession', async (_p, _o, _a, _t, run) => run({ settle: async () => {} }));
  t.mock.method(BambuNetworkBridge.prototype, 'request', async method => {
    assert.equal(method, 'bridge.poll_events'); return { events: queued.splice(0) };
  });
  t.mock.method(BambuNetworkBridge.prototype, 'callWithAgent', async (method, payload) => {
    if (method === 'net.set_on_message_fn') return { ok: true, value: 0 };
    assert.equal(method, 'net.send_message_to_printer');
    const message = JSON.parse(payload.msg);
    if (message.print?.command === 'extrusion_cali_get_result') {
      assert.ok(Number(message.print.sequence_id) >= 20000 && Number(message.print.sequence_id) < 30000);
      events.push('ready-query');
      if (readyCode) return { ok: true, value: readyCode };
      queued.push({ name: 'on_local_message', payload: { dev_id: config.serial,
        msg: JSON.stringify({ print: { ...message.print, result: 'success' } }) } });
      return { ok: true, value: 0 };
    }
    if (message.print) {
      assert.match(message.print.sequence_id, /^\d+$/);
      assert.ok(Number(message.print.sequence_id) >= 20000 && Number(message.print.sequence_id) < 30000);
      events.push('publish'); return { ok: true, value: rejection };
    }
    const data = message.info ? { info: { command: 'get_version', module: [] } } :
      { print: { command: 'push_status', gcode_state: 'RUNNING', print_error: 0, hms: [] } };
    queued.push({ name: 'on_local_message', payload: { dev_id: config.serial, msg: JSON.stringify(data) } });
    return { ok: true, value: 0 };
  });
  return events;
}

test('LAN target rejection occurs inside the connected session before any control publish', async t => {
  const events = lan(t);
  await assert.rejects(createRuntime(config).control('lan', 'pause', s => {
    assert.equal(s.raw.gcode_state, 'RUNNING'); throw new Error('target changed');
  }, () => events.push('attempt')), /target changed/);
  assert.deepEqual(events, []);
});

test('LAN control retains the exact rejection code and performs no automatic retry', async t => {
  const events = lan(t, -2);
  await assert.rejects(createRuntime(config).control('lan', 'pause', () => events.push('check'),
    () => events.push('attempt')), /failed \(code -2\).*not confirmed/);
  assert.deepEqual(events, ['check', 'ready-query', 'check', 'attempt', 'publish']);
});

test('LAN readiness does not replace the fresh target check immediately before control', async t => {
  const events = lan(t); let checks = 0;
  await assert.rejects(createRuntime(config).control('lan', 'resume', () => {
    events.push('check'); if (++checks === 2) throw new Error('target changed during readiness');
  }, () => events.push('attempt')), /target changed during readiness/);
  assert.deepEqual(events, ['check', 'ready-query', 'check']);
});

test('failed LAN readiness never marks a physical dispatch attempted or publishes a control', async t => {
  const events = lan(t, 0, -2);
  await assert.rejects(createRuntime(config).control('lan', 'pause', () => events.push('check'),
    () => events.push('attempt')), /readiness query failed \(code -2\).*No control command was sent/);
  assert.deepEqual(events, ['check', 'ready-query']);
});
