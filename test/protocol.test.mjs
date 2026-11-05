import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real stdio protocol works without elicitation and validates tool arguments', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bambi-protocol-'));
  const config = path.join(directory, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ workDir: path.join(directory, 'jobs'), cloudCredentialsFile: path.join(directory, 'none') }));
  const client = new Client({ name: 'no-elicitation-client', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve('src/server.mjs')], env: { ...process.env, BAMBI_CONFIG: config }, stderr: 'pipe' });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  const result = await client.listTools();
  assert.equal(result.tools.length, 10);
  assert.equal(result.tools.find(t => t.name === 'camera_snapshot').annotations.readOnlyHint, true);
  const badCamera = await client.callTool({ name: 'camera_snapshot', arguments: { timeout_ms: 0 } });
  assert.equal(badCamera.isError, true); assert.match(badCamera.content[0].text, /Invalid tool arguments/);
  const unmanagedResume = await client.callTool({ name: 'control_print', arguments: { route: 'lan', action: 'resume' } });
  assert.equal(unmanagedResume.isError, true); assert.match(unmanagedResume.content[0].text, /requires the managed job_id/);
  const diagnosis = await client.callTool({ name: 'diagnose', arguments: {} });
  assert.equal(diagnosis.isError, undefined);
  const invalid = await client.callTool({ name: 'print_job', arguments: { job_id: 'test', route: 'unexpected' } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /Invalid tool arguments/);
  for (const recovery of [{ previous_job_name: 'old' }, { previous_job_name: 'old', bed_cleared: false },
    { previous_job_name: '', bed_cleared: true }, { previous_job_name: 'old', bed_cleared: true, force: true }]) {
    const rejected = await client.callTool({ name: 'print_job', arguments: { job_id: 'test', route: 'lan', recovery } });
    assert.equal(rejected.isError, true); assert.match(rejected.content[0].text, /Invalid tool arguments/);
  }
  const pathTraversal = await client.callTool({ name: 'get_job', arguments: { job_id: '../../private' } });
  assert.equal(pathTraversal.isError, true);
});
