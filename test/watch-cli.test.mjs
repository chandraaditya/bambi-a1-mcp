import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('real watch CLI uses MCP, emits an unsubmitted event and closes without connecting to hardware', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bambi-watch-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = '00000000-0000-4000-8000-000000000001', workDir = path.join(dir, 'jobs');
  fs.mkdirSync(path.join(workDir, id), { recursive: true });
  fs.writeFileSync(path.join(workDir, id, 'job.json'), JSON.stringify({ id, state: 'prepared' }));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ workDir, cloudCredentialsFile: path.join(dir, 'none') }));
  const child = spawn(process.execPath, ['scripts/bambi.mjs', 'watch', id, '--route', 'cloud', '--until-event'],
    { env: { ...process.env, BAMBI_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('watch CLI failed to close')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 1, stderr);
  assert.deepEqual(stdout.trim().split('\n').map(JSON.parse), [{ event: 'not_submitted', job_id: id }]);
});
