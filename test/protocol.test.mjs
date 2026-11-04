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
  assert.equal(result.tools.length, 9);
  const diagnosis = await client.callTool({ name: 'diagnose', arguments: {} });
  assert.equal(diagnosis.isError, undefined);
  const invalid = await client.callTool({ name: 'print_job', arguments: { job_id: 'test', route: 'unexpected' } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /Invalid tool arguments/);
  const pathTraversal = await client.callTool({ name: 'get_job', arguments: { job_id: '../../private' } });
  assert.equal(pathTraversal.isError, true);
});
