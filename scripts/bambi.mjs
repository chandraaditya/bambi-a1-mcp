#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import packageInfo from '../package.json' with { type: 'json' };
import { watchJob } from '../src/watch.mjs';

const help = `Bambi A1 — uses the same MCP tools as your agent; no additional approval UI.

  bambi prepare FILE [--plate 0] [--slice --process-profile FILE --filament-profile FILE]
  bambi print JOB_ID --route lan|cloud [--ams 0,2] [--recover-from PREVIOUS_JOB --bed-cleared]
  bambi verify JOB_ID [--route lan|cloud]
  bambi watch JOB_ID [--route lan|cloud] [--interval 60] [--timeout 43200]
                    [--notify important|milestones|all] [--until-event]
  bambi status --route lan|cloud
  bambi job JOB_ID
  bambi doctor

prepare never prints. print dispatches a prepared ID at most once.
verify/watch never resubmit. watch ends on matching completion/failure or timeout.
watch is quiet after startup unless issues or completion occur. --notify milestones
adds at most five intermediate updates. --until-event also exits on an issue or
lost observation, for hosts that wake an agent when its background task finishes.
Files and profiles are paths on the host running the MCP. Omit --ams for one external spool.
`;
const client = new Client({ name: 'bambi-cli', version: packageInfo.version });
let transport, shutdown;
const closeClient = () => shutdown ||= (async () => {
  try { await client.close(); } finally { await transport?.close(); }
})();
// Stop the client/bridge, never the printer. An interrupted dispatch retains its
// durable dispatching/unknown journal and cannot be automatically replayed.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => { void closeClient().finally(() => process.exit(code)); });
}
try {
  const { values: v, positionals: p } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, route: { type: 'string' }, plate: { type: 'string' },
    slice: { type: 'boolean' }, 'process-profile': { type: 'string' },
    'recover-from': { type: 'string' }, 'bed-cleared': { type: 'boolean' },
    'filament-profile': { type: 'string', multiple: true }, ams: { type: 'string' },
    interval: { type: 'string', default: '60' }, timeout: { type: 'string', default: '43200' },
    notify: { type: 'string', default: 'important' }, 'until-event': { type: 'boolean' },
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
    if (!['important', 'milestones', 'all'].includes(v.notify)) throw new Error('--notify must be important, milestones or all.');
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
    transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], env: { ...process.env }, stderr: 'inherit' });
    await client.connect(transport);
    const invoke = async (timeoutMs = 600000) => {
      const result = await client.callTool({ name: commands[command], arguments: args }, undefined, { timeout: timeoutMs });
      const output = result.content.find(item => item.type === 'text')?.text;
      if (result.isError) throw new Error(output || 'MCP tool failed.');
      return output;
    };
    if (command === 'watch') process.exitCode = await watchJob({
      verify: async timeoutMs => JSON.parse(await invoke(timeoutMs)),
      emit: event => process.stdout.write(JSON.stringify(event) + '\n'),
      notify: v.notify, untilEvent: v['until-event'], intervalMs: interval * 1000, timeoutMs: timeout * 1000,
    });
    else process.stdout.write(await invoke() + '\n');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await closeClient(); }
