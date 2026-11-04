import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { freshMqttStatus } from '../src/telemetry.mjs';
import { validatePrinterState } from 'bambu-printer-mcp/dist/safety/printer-state.js';

class Client extends EventEmitter {
  async subscribeAsync() {}
  async publishAsync(topic, body) { this.onPublish?.(JSON.parse(body)); }
  report(data, retain = false, topic = 'device/test/report') { this.emit('message', topic, Buffer.from(JSON.stringify(data)), { retain }); }
}

test('fresh telemetry ignores retained data and other devices, requires report and identity', async () => {
  const client = new Client();
  client.onPublish = body => {
    if (!body.info) return;
    queueMicrotask(() => {
      client.report({ print: { command: 'push_status', gcode_state: 'RUNNING', print_error: 0, hms: [] } }, true);
      client.report({ print: { command: 'push_status', gcode_state: 'RUNNING', print_error: 0, hms: [] } }, false, 'device/other/report');
      client.report({ info: { command: 'get_version', module: [{ name: 'ota', sn: 'test' }] } });
      client.report({ print: { command: 'push_status', gcode_state: 'IDLE', print_error: 0, hms: [], model: 'A1' } });
    });
  };
  const result = await freshMqttStatus(client, { serial: 'test' }, 100);
  assert.equal(result.raw.gcode_state, 'IDLE');
  assert.equal(client.listenerCount('message'), 0);
});

test('partial or missing telemetry times out and cleans up listeners', async () => {
  const client = new Client();
  client.onPublish = () => queueMicrotask(() => client.report({ print: { command: 'push_status', gcode_state: 'IDLE' } }));
  await assert.rejects(freshMqttStatus(client, { serial: 'test' }, 20), /No fresh complete/);
  assert.equal(client.listenerCount('message'), 0);
});

test('upstream validator rejects stale, busy, wrong-model, and wrong-nozzle telemetry', () => {
  const status = () => ({ connected: true, serial: 'test', raw: { model: 'A1', gcode_state: 'IDLE', print_error: 0,
    hms: [], nozzle_diameter: '0.4', nozzle_type: 'stainless_steel' },
    observation: { source: 'mqtt', requestedAt: Date.now(), receivedAt: Date.now() } });
  const requirements = { model: 'a1', nozzleDiameters: [0.4], verifyMaterials: false };
  assert.doesNotThrow(() => validatePrinterState(status(), requirements));
  for (const [field, value] of [['gcode_state', 'RUNNING'], ['model', 'P1S'], ['nozzle_diameter', '0.6']]) {
    const changed = status(); changed.raw[field] = value;
    assert.throws(() => validatePrinterState(changed, requirements));
  }
  const stale = status(); stale.observation.requestedAt -= 20000;
  assert.throws(() => validatePrinterState(stale, requirements), /stale/);
});
