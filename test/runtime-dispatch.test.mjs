import test from 'node:test';
import assert from 'node:assert/strict';
import { BambuNetworkBridge } from 'bambu-printer-mcp/dist/bambu-network-bridge.js';
import { createRuntime } from '../src/runtime.mjs';

const config = { serial: '039TEST', host: 'printer.invalid', accessCode: 'fixture-code',
  bridgeCommand: 'unused-test', cloudCredentialsFile: '/unused-test/cloud.json' };

// Exercise the actual dependency request framing and dispatch callbacks against
// a fake wire; no network process or physical printer is involved.
function wire(t, outcome) {
  let publishes = 0;
  const events = [], diagnostics = [{ code: -4030, msg: 'fixture publish failure' }];
  t.mock.method(BambuNetworkBridge.prototype, 'ensureAgent', async () => ({ agent: 1 }));
  t.mock.method(BambuNetworkBridge.prototype, 'withLocalSession', async (_p, _o, _a, _t, run) => run({ jobUpdates: diagnostics }));
  t.mock.method(BambuNetworkBridge.prototype, 'ensureStarted', async function () {
    this.child = { stdin: { write: (frame, callback) => {
      const id = frame.readUInt32LE(8), { method, payload } = JSON.parse(frame.subarray(16));
      let result = { ok: true, value: 0 };
      if (method === 'bridge.poll_events') result = { events: events.splice(0) };
      else if (method === 'net.start_local_print') {
        publishes++; result = outcome;
      } else {
        assert.equal(method, 'net.send_message_to_printer');
        const message = JSON.parse(payload.msg);
        events.push({ name: 'on_local_message', payload: { dev_id: config.serial,
          msg: JSON.stringify(message.info ? { info: { command: 'get_version', module: [] } } :
            { print: { command: 'push_status', gcode_state: 'FINISH', print_error: 0, hms: [] } }) } });
      }
      callback();
      queueMicrotask(() => {
        const pending = this.pending.get(id); clearTimeout(pending.timer); this.pending.delete(id);
        if (result instanceof Error) pending.reject(result); else pending.resolve(result);
      });
    } } };
  });
  return { runtime: createRuntime(config), publishes: () => publishes, diagnostics };
}

test('LAN publish failure is returned after exactly one physical attempt', async t => {
  const f = wire(t, { ok: true, value: -4030 }); let attempts = 0, checks = 0;
  const result = await f.runtime.dispatch('lan', {}, status => {
    assert.equal(status.raw.gcode_state, 'FINISH'); checks++;
  }, () => attempts++);
  assert.equal(result.value, -4030); assert.deepEqual(result.diagnostics, f.diagnostics);
  assert.equal(f.publishes(), 1); assert.equal(attempts, 1); assert.equal(checks, 1);
});

test('LAN transport timeout is not replayed', async t => {
  const f = wire(t, new Error('transport timeout')); let attempts = 0;
  await assert.rejects(f.runtime.dispatch('lan', {}, () => {}, () => attempts++), /transport timeout/);
  assert.equal(f.publishes(), 1); assert.equal(attempts, 1);
});

test('LAN final preflight rejection prevents any print frame', async t => {
  const f = wire(t, { ok: true, value: 0 });
  await assert.rejects(f.runtime.dispatch('lan', {}, () => { throw new Error('printer busy'); },
    () => assert.fail('must not dispatch')), /printer busy/);
  assert.equal(f.publishes(), 0);
});
