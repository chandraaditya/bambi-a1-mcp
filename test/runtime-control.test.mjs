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
  t.mock.method(CloudBridge.prototype, 'send', async message => { assert.equal(message.print.command, 'pause'); events.push('publish'); });
  await createRuntime(config).control('cloud', 'pause', s => { assert.equal(s, report); events.push('check'); }, () => events.push('attempt'));
  assert.deepEqual(events, ['connect', 'fresh-status', 'check', 'attempt', 'publish']);
});

function lan(t, rejection = 0) {
  const events = [], queued = [];
  t.mock.method(BambuNetworkBridge.prototype, 'withLocalSession', async (_p, _o, _a, _t, run) => run());
  t.mock.method(BambuNetworkBridge.prototype, 'request', async method => {
    assert.equal(method, 'bridge.poll_events'); return { events: queued.splice(0) };
  });
  t.mock.method(BambuNetworkBridge.prototype, 'callWithAgent', async (method, payload) => {
    assert.equal(method, 'net.send_message_to_printer');
    const message = JSON.parse(payload.msg);
    if (message.print) { events.push('publish'); return { ok: true, value: rejection }; }
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
  assert.deepEqual(events, ['check', 'attempt', 'publish']);
});
