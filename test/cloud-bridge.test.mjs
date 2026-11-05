import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudBridge } from '../src/cloud-bridge.mjs';

function fixture() {
  const calls = [], queue = [], serial = 'configured-device';
  let requested = 0;
  const bridge = {
    async ensureAgent() { return { agent: 1 }; },
    getStatus() { return { pid: 123 }; },
    async callWithAgent(method, payload) {
      calls.push([method, payload]);
      if (method === 'net.is_user_login' || method === 'net.is_server_connected') return { ok: true, value: true };
      if (method === 'net.add_subscribe') queue.push({ name: 'on_printer_connected', payload: { topic_str: `device/${serial}/report` } });
      if (method === 'net.send_message') {
        requested++;
        if (requested === 2) queue.push(
          { name: 'on_message', payload: { dev_id: serial, msg: JSON.stringify({ print: { command: 'push_status', gcode_state: 'IDLE', print_error: 0, hms: [] } }) } },
          { name: 'on_message', payload: { dev_id: serial, msg: JSON.stringify({ info: { command: 'get_version', module: [{ name: 'ota', sn: serial }] } }) } },
        );
      }
      return { ok: true, value: 0 };
    },
    async request(method) { assert.equal(method, 'bridge.poll_events'); return { events: queue.splice(0) }; },
  };
  return { cloud: new CloudBridge(bridge, { serial }, () => ({})), calls, queue, bridge };
}

test('cloud bridge waits for selected printer channel, then requests fresh telemetry', async () => {
  const { cloud, calls } = fixture();
  const status = await cloud.status(100);
  assert.equal(status.raw.gcode_state, 'IDLE');
  const methods = calls.map(c => c[0]);
  assert.ok(methods.indexOf('net.set_user_selected_machine') < methods.indexOf('net.add_subscribe'));
  assert.ok(methods.indexOf('net.add_subscribe') < methods.indexOf('net.send_message'));
  assert.ok(!methods.some(method => method.includes('connect_printer')));
});

test('cloud bridge refuses an unauthenticated session', async () => {
  const { cloud, bridge } = fixture();
  bridge.callWithAgent = async () => ({ ok: true, value: false });
  await assert.rejects(cloud.connect(), /login is missing/);
});

test('invalidating a shared LAN session forces cloud reselection before fresh telemetry', async () => {
  const { cloud, calls } = fixture();
  await cloud.connect(); await cloud.connect();
  assert.equal(calls.filter(([method]) => method === 'net.add_subscribe').length, 1);
  cloud.invalidate();
  const status = await cloud.status(100);
  assert.equal(status.raw.gcode_state, 'IDLE');
  assert.equal(calls.filter(([method]) => method === 'net.add_subscribe').length, 2);
  const methods = calls.map(([method]) => method);
  assert.ok(methods.lastIndexOf('net.set_user_selected_machine') < methods.indexOf('net.send_message'));
});

test('queued reports are cleared before requesting status', async () => {
  const { cloud, queue, bridge } = fixture();
  await cloud.connect();
  queue.push({ name: 'on_message', payload: { dev_id: 'configured-device', msg: JSON.stringify({ print: { command: 'push_status', gcode_state: 'IDLE', print_error: 0, hms: [] }, info: { command: 'get_version', module: [] } }) } });
  bridge.callWithAgent = async method => ({ ok: true, value: ['net.is_user_login', 'net.is_server_connected'].includes(method) ? true : 0 });
  await assert.rejects(cloud.status(20), /No fresh complete/);
});
