#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const help = `Bambi A1 — uses the same MCP tools as your agent; no additional approval UI.

  bambi prepare FILE [--plate 0] [--slice --process-profile FILE --filament-profile FILE]
  bambi print JOB_ID --route lan|cloud [--ams 0,2] [--recover-from PREVIOUS_JOB --bed-cleared]
  bambi verify JOB_ID [--route lan|cloud]
  bambi watch JOB_ID [--route lan|cloud] [--interval 30] [--timeout 43200]
  bambi status --route lan|cloud
  bambi job JOB_ID
  bambi doctor

prepare never prints. print dispatches a prepared ID at most once.
verify/watch never resubmit. watch ends on matching completion/failure or timeout.
Files and profiles are paths on the host running the MCP. Omit --ams for one external spool.
`;
const client = new Client({ name: 'bambi-cli', version: '0.2.1' });
let connected = false;
try {
  const { values: v, positionals: p } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, route: { type: 'string' }, plate: { type: 'string' },
    slice: { type: 'boolean' }, 'process-profile': { type: 'string' },
    'recover-from': { type: 'string' }, 'bed-cleared': { type: 'boolean' },
    'filament-profile': { type: 'string', multiple: true }, ams: { type: 'string' },
    interval: { type: 'string', default: '30' }, timeout: { type: 'string', default: '43200' },
  } });
  const [command, target] = p;
  if (v.help || !command) { process.stdout.write(help); }
  else {
    const commands = { prepare: 'prepare_job', print: 'print_job', verify: 'verify_job', watch: 'verify_job',
      status: 'printer_status', job: 'get_job', doctor: 'diagnose' };
    if (!commands[command]) throw new Error('Unknown command. Run bambi --help.');
    const needsTarget = ['prepare', 'print', 'verify', 'watch', 'job'].includes(command);
    if (p.length !== (needsTarget ? 2 : 1)) throw new Error('Wrong arguments. Run bambi --help.');
    if (['print', 'status'].includes(command) && !v.route) throw new Error('--route lan|cloud is required.');
    if (v.route && !['lan', 'cloud'].includes(v.route)) throw new Error('--route must be lan or cloud.');
    if ((v['recover-from'] !== undefined || v['bed-cleared']) &&
        (command !== 'print' || !v['recover-from']?.trim() || v['bed-cleared'] !== true)) {
      throw new Error('Recovery requires print --recover-from PREVIOUS_JOB --bed-cleared, after user confirmation of cleanup.');
    }
    const interval = Number(v.interval), timeout = Number(v.timeout);
    if (!Number.isFinite(interval) || interval < 5 || !Number.isFinite(timeout) || timeout < 1 || timeout > 43200) {
      throw new Error('interval must be at least 5 seconds; timeout must be 1..43200 seconds.');
    }
    const args = command === 'prepare' ? { file_path: target,
      ...(v.plate !== undefined ? { plate_index: Number(v.plate) } : {}),
      ...(v.slice ? { slice: true } : {}),
      ...(v['process-profile'] ? { process_profile: v['process-profile'] } : {}),
      ...(v['filament-profile'] ? { filament_profiles: v['filament-profile'] } : {}),
    } : command === 'doctor' ? { connect_bridge: true } : {
      ...(target ? { job_id: target } : {}), ...(v.route ? { route: v.route } : {}),
      ...(command === 'print' && v.ams !== undefined ? { ams_mapping: v.ams.split(',').map(Number) } : {}),
      ...(command === 'print' && v['recover-from'] ? { recovery: { previous_job_name: v['recover-from'], bed_cleared: true } } : {}),
    };
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], stderr: 'inherit' });
    await client.connect(transport); connected = true;
    const deadline = Date.now() + timeout * 1000;
    do {
      const result = await client.callTool({ name: commands[command], arguments: args }, undefined, { timeout: 600000 });
      const output = result.content.find(item => item.type === 'text')?.text;
      if (result.isError) throw new Error(output || 'MCP tool failed.');
      process.stdout.write(output + '\n');
      if (command !== 'watch') break;
      const job = JSON.parse(output);
      if (job.state === 'completed' && job.matched) break;
      if (job.state === 'failed' && job.matched) { process.exitCode = 2; break; }
      if (job.state === 'prepared') throw new Error('This job has not been submitted.');
      if (Date.now() >= deadline) throw new Error('Watch timed out. No print command was sent or retried.');
      await new Promise(resolve => setTimeout(resolve, Math.min(interval * 1000, deadline - Date.now())));
    } while (true);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (connected) await client.close(); }
