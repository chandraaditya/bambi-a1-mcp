import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}
async function until(predicate, label) {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}
function fixture(t, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambi-shutdown-'));
  const marker = path.join(dir, 'bridge-pids.json'), fake = path.join(dir, 'bridge.mjs');
  // A pending handshake keeps a real bridge process and real server alive.
  // This process never opens a network socket or sends a printer command.
  fs.writeFileSync(fake, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({bridge:process.pid,server:process.ppid})); setInterval(()=>{},1000);`);
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ workDir: path.join(dir, 'jobs'),
    bridgeConfigDir: path.join(dir, 'network'), bridgeCommand: `exec ${quote(process.execPath)} ${quote(fake)}` }));
  const child = spawn(process.execPath, args, { env: { ...process.env, BAMBI_CONFIG: config }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', stderr = '', exited = false;
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { stderr += data; });
  child.on('exit', () => { exited = true; });
  t.after(() => {
    if (!exited) child.kill('SIGKILL');
    if (fs.existsSync(marker)) for (const pid of Object.values(JSON.parse(fs.readFileSync(marker)))) {
      if (pid !== process.pid && alive(pid)) process.kill(pid, 'SIGKILL');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { child, marker, output: () => output, stderr: () => stderr, exited: () => exited };
}

test('MCP input EOF closes a pending bridge instead of orphaning it', async t => {
  const f = fixture(t, ['src/server.mjs']);
  const send = value => f.child.stdin.write(JSON.stringify(value) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'shutdown-test', version: '1' } } });
  await until(() => f.output().includes('"id":1'), 'MCP initialization');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'diagnose', arguments: { connect_bridge: true } } });
  await until(() => fs.existsSync(f.marker), 'bridge start');
  const { bridge } = JSON.parse(fs.readFileSync(f.marker)); assert.ok(alive(bridge));
  f.child.stdin.end();
  await until(f.exited, 'server exit after EOF');
  await until(() => !alive(bridge), 'bridge exit after EOF');
});

test('SIGTERM closes CLI, its MCP server and pending bridge without a printer command', async t => {
  const f = fixture(t, ['scripts/bambi.mjs', 'doctor']);
  await until(() => {
    if (f.exited()) throw new Error(`CLI exited before bridge start: ${f.stderr()}`);
    return fs.existsSync(f.marker);
  }, 'bridge start');
  const { bridge, server } = JSON.parse(fs.readFileSync(f.marker));
  assert.ok(alive(bridge)); assert.ok(alive(server));
  f.child.kill('SIGTERM');
  await until(f.exited, 'CLI exit');
  await until(() => !alive(server) && !alive(bridge), 'server and bridge cleanup');
  assert.equal(f.child.exitCode, 143);
});
