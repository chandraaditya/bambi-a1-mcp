#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readConfig, redact, publicStatus, defaultStudioConfig } from './config.mjs';
import { createRuntime } from './runtime.mjs';
import { PrintService } from './service.mjs';
import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';

// Reserve stdout for JSON-RPC even if a library logs during slicing.
console.log = (...args) => console.error(...args);
const config = readConfig();
const runtime = createRuntime(config);
const service = new PrintService(config, runtime);
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const route = { type: 'string', enum: ['lan', 'cloud'], description: 'Explicit transport. Cloud does not require LAN reachability.' };
const tools = [
  { name: 'diagnose', description: 'Check configured slicing, cloud login, LAN and bridge prerequisites. No printer motion.',
    inputSchema: schema({ connect_bridge: { type: 'boolean' } }), annotations: { readOnlyHint: true } },
  { name: 'list_printers', description: 'List cloud-bound printers without returning tokens or serials.', inputSchema: schema(), annotations: { readOnlyHint: true } },
  { name: 'printer_status', description: 'Read fresh printer identity, job, temperatures, AMS and errors through LAN or cloud.', inputSchema: schema({ route }, ['route']), annotations: { readOnlyHint: true } },
  { name: 'list_profiles', description: 'Find installed Bambu Studio machine, process and filament profile paths. Filter by name.',
    inputSchema: schema({ search: string }), annotations: { readOnlyHint: true } },
  { name: 'prepare_job', description: 'Snapshot and inspect a sliced 3MF, or slice STL/3MF using Bambu Studio. Does not print. STL requires process and filament profile paths. Use slice:true for an unsliced 3MF.',
    inputSchema: schema({ file_path: string, plate_index: { type: 'integer', minimum: 0 }, slice: { type: 'boolean' },
      process_profile: string, filament_profiles: { type: 'array', minItems: 1, items: string },
      process_overrides: schema({ layer_height: { type: 'number', minimum: 0.04, maximum: 0.6 }, wall_loops: { type: 'integer', minimum: 1, maximum: 20 }, sparse_infill_density: { type: 'string', pattern: '^(100|[0-9]{1,2})%$' } }),
    }, ['file_path']) },
  { name: 'get_job', description: 'Inspect the durable job record and exact prepared file hash.', inputSchema: schema({ job_id: string }, ['job_id']), annotations: { readOnlyHint: true } },
  { name: 'verify_job', description: 'Verify a submitted job against fresh printer telemetry and save its observed progress. Exact job-name match required. Layer 0 is preparation. Never submits or retries a print. Optional route overrides the submission route, allowing cloud monitoring of a LAN print.',
    inputSchema: schema({ job_id: string, route }, ['job_id']), annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'print_job', description: 'Print an explicitly prepared job using LAN or cloud with fresh printer checks. Direct execution; no MCP elicitation. Repeated job IDs are not dispatched twice. Optional ams_mapping uses zero-based AMS Lite slots; omit for one external spool.',
    inputSchema: schema({ job_id: string, route, ams_mapping: { type: 'array', minItems: 1, items: { type: 'integer', minimum: -1, maximum: 3 } },
      recovery: { ...schema({ previous_job_name: { type: 'string', minLength: 1 }, bed_cleared: { type: 'boolean', const: true } }, ['previous_job_name', 'bed_cleared']),
        description: 'Only for a terminal FAILED previous job after the user confirms cleanup and requests a new print. Fresh telemetry must show idle, no active stage, no errors/HMS and heaters off. Never clears a fault or resumes the old job.' },
    }, ['job_id', 'route']), annotations: { destructiveHint: true, idempotentHint: true } },
  { name: 'control_print', description: 'Pause or cancel a print using the chosen transport. No MCP elicitation.',
    inputSchema: schema({ route, action: { type: 'string', enum: ['pause', 'cancel'] } }, ['route', 'action']), annotations: { destructiveHint: true } },
];
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map(tools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));

function profiles(search = '') {
  const roots = [config.profilesRoot || path.resolve(path.dirname(config.slicerPath), '../Resources/profiles/BBL'),
    path.join(path.dirname(config.studioConfig || defaultStudioConfig()), 'system/BBL'),
    path.join(path.dirname(config.studioConfig || defaultStudioConfig()), 'user')];
  const output = [];
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.json') && file.toLowerCase().includes(search.toLowerCase())) output.push(file);
    }
  }
  for (const root of new Set(roots)) walk(root);
  return { paths: output.slice(0, 200), total: output.length, note: output.length > 200 ? 'Use a narrower search.' : undefined };
}
const server = new Server({ name: 'bambi-a1-mcp', version: '0.2.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
async function executeTool(request) {
  const a = request.params.arguments || {};
  try {
    const validate = validators.get(request.params.name);
    if (!validate) throw new Error('Unknown tool.');
    if (!validate(a)) throw new Error('Invalid tool arguments: ' + ajv.errorsText(validate.errors));
    let result;
    switch (request.params.name) {
      case 'diagnose': result = await runtime.diagnose(a.connect_bridge); break;
      case 'list_printers': result = await runtime.devices(); break;
      case 'printer_status': {
        if (!['lan', 'cloud'].includes(a.route)) throw new Error('route must explicitly be lan or cloud.');
        result = publicStatus(await runtime.status(a.route)); break;
      }
      case 'list_profiles': result = profiles(a.search); break;
      case 'prepare_job': result = await service.prepare(a); break;
      case 'get_job': result = service.get(a.job_id); break;
      case 'verify_job': result = await service.verify(a); break;
      case 'print_job': result = await service.print(a); break;
      case 'control_print': result = await service.control(a); break;
      default: throw new Error('Unknown tool.');
    }
    return { content: [{ type: 'text', text: redact(result, config) }] };
  } catch (error) { return { isError: true, content: [{ type: 'text', text: redact(error.message, config) }] }; }
}
// FULU has one event queue per process. Concurrent tools must not consume each other's telemetry.
let queue = Promise.resolve();
server.setRequestHandler(CallToolRequestSchema, request => {
  const result = queue.then(() => executeTool(request));
  queue = result.catch(() => {});
  return result;
});
let closing = false;
async function shutdown() { if (closing) return; closing = true; await runtime.close(); await server.close(); }
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
server.onclose = () => { void shutdown(); };
await server.connect(new StdioServerTransport());
