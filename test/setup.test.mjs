import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('public setup creates portable private config, never prints secrets and refuses overwrites', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bambi-setup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, 'runtime'), bin = path.join(directory, 'bin');
  fs.mkdirSync(runtime); fs.mkdirSync(bin);
  for (const name of ['pjarczak_bambu_linux_host', 'libbambu_networking.so', 'libBambuSource.so', 'ca-certificates.crt']) fs.writeFileSync(path.join(runtime, name), 'fixture');
  const executable = path.join(bin, 'docker'); fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const secret = path.join(directory, 'access-code'); fs.writeFileSync(secret, 'private-test-access-code', { mode: 0o600 });
  const config = path.join(directory, 'private', 'config.json');
  const args = ['scripts/setup.mjs', '--host', 'printer.invalid', '--serial', 'test-device',
    '--access-code-file', secret, '--runtime', runtime, '--slicer', executable, '--studio-config', path.join(directory, 'no-studio')];
  const env = { ...process.env, BAMBI_CONFIG: config, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const run = () => spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('private-test-access-code'));
  const saved = JSON.parse(fs.readFileSync(config));
  assert.equal(saved.accessCode, 'private-test-access-code');
  assert.equal(saved.bridgeRuntimeDir, runtime); assert.equal(saved.nozzle, 0.4);
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  const mcp = JSON.parse(fs.readFileSync(path.join(path.dirname(config), 'mcp-client.json')));
  assert.equal(mcp.mcpServers['bambi-a1'].env.BAMBI_CONFIG, config);
  const before = fs.readFileSync(config, 'utf8');
  const again = run(); assert.notEqual(again.status, 0); assert.match(again.stderr, /already exists/);
  assert.equal(fs.readFileSync(config, 'utf8'), before);
});

test('CLI rejects an implicit print route before launching any MCP', () => {
  const result = spawnSync(process.execPath, ['scripts/bambi.mjs', 'print', 'any-job'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /route.*required/);
});

test('CLI requires paired recovery name and cleared-bed confirmation', () => {
  for (const args of [ ['print', 'id', '--route', 'lan', '--recover-from', 'old'],
    ['print', 'id', '--route', 'lan', '--bed-cleared'],
    ['status', '--route', 'lan', '--recover-from', 'old', '--bed-cleared'] ]) {
    const result = spawnSync(process.execPath, ['scripts/bambi.mjs', ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Recovery requires print/);
  }
});

test('CLI forwards BAMBI_CONFIG to its MCP server instead of using another printer setup', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bambi-cli-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const id = '11111111-1111-4111-8111-111111111111', workDir = path.join(directory, 'jobs');
  fs.mkdirSync(path.join(workDir, id), { recursive: true });
  fs.writeFileSync(path.join(workDir, id, 'job.json'), JSON.stringify({ id, state: 'prepared', sha256: 'fixture-only' }));
  const config = path.join(directory, 'config.json'); fs.writeFileSync(config, JSON.stringify({ workDir }));
  const result = spawnSync(process.execPath, ['scripts/bambi.mjs', 'job', id], {
    env: { ...process.env, BAMBI_CONFIG: config }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sha256, 'fixture-only');
});
