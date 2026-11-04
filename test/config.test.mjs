import test from 'node:test';
import assert from 'node:assert/strict';
import { publicStatus } from '../src/config.mjs';

test('public telemetry explains reported HMS without hiding warnings or exposing device identity', () => {
  const result = publicStatus({ model: 'a1', status: 'RUNNING', serial: 'private-serial',
    observation: { receivedAt: 1 }, raw: { print_error: 0, hms: [{ attr: 50336000, code: 131073 }],
      modules: [{ sn: 'private-serial' }], net: { ip: 'private-address' } } });
  assert.equal(result.hms[0].hex, '0300110000020001');
  assert.match(result.hms[0].message, /Y axis.*timing belt/i);
  assert.equal(result.printError, 0);
  assert.ok(!JSON.stringify(result).includes('private-'));
});
