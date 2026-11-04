#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { configHome, defaultStudioConfig, privateJson } from '../src/config.mjs';

const usage = `Create a private Bambi A1 configuration. Never overwrites an existing file.
  node scripts/setup.mjs [--host PRINTER_IP] [--serial SERIAL]
      [--access-code-file PRIVATE_FILE] [--studio-config FILE]
      [--runtime DIRECTORY] [--slicer EXECUTABLE] [--nozzle 0.4]
      [--country US] [--region us|cn] [--bed textured_plate]

macOS: sign in to Bambu Studio first; a single saved printer is selected automatically.
If no LAN access code is saved in Studio, supply a private file, never a command-line secret.
Run npm run install:runtime first. Docker must be installed and running.
Use BAMBI_CONFIG to select a new configuration file/location.
`;
let prompt;
try {
  const { values: v } = parseArgs({ options: Object.fromEntries([
    'host', 'serial', 'access-code-file', 'studio-config', 'runtime', 'slicer', 'nozzle', 'country', 'region', 'bed',
  ].map(name => [name, { type: 'string' }]).concat([['help', { type: 'boolean', short: 'h' }]])) });
  if (v.help) console.log(usage);
  else {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required.');
    if (process.platform === 'win32') throw new Error('Use WSL2. Native Windows is not supported.');
    const destination = path.resolve(process.env.BAMBI_CONFIG || path.join(configHome(), 'config.json'));
    if (fs.existsSync(destination)) throw new Error('Configuration already exists; edit it locally or choose a new BAMBI_CONFIG. Nothing was overwritten.');
    const studioConfig = path.resolve(v['studio-config'] || defaultStudioConfig());
    const studio = fs.existsSync(studioConfig) ? JSON.parse(fs.readFileSync(studioConfig, 'utf8')) : {};
    const serials = Object.keys(studio.access_code || {});
    async function ask(value, label) {
      if (value) return value;
      if (!process.stdin.isTTY) throw new Error(`${label} is required; supply its setup flag.`);
      prompt ||= createInterface({ input: process.stdin, output: process.stderr });
      const answer = (await prompt.question(`${label}: `)).trim();
      if (!answer) throw new Error(`${label} cannot be empty.`);
      return answer;
    }
    const serial = await ask(v.serial || (serials.length === 1 ? serials[0] : ''), 'Printer serial (--serial)');
    const host = await ask(v.host, 'Printer LAN address (--host)');
    const nozzle = Number(v.nozzle || '0.4');
    if (![0.2, 0.4, 0.6, 0.8].includes(nozzle)) throw new Error('Nozzle must be 0.2, 0.4, 0.6 or 0.8 mm.');
    const region = v.region || 'us', country = (v.country || (region === 'cn' ? 'CN' : 'US')).toUpperCase();
    if (!['us', 'cn'].includes(region) || !/^[A-Z]{2}$/.test(country)) throw new Error('Use region us/cn and a two-letter country code.');
    let accessCode;
    if (v['access-code-file']) {
      const file = path.resolve(v['access-code-file']);
      if (fs.statSync(file).mode & 0o077) throw new Error('Access-code file must be private: chmod 600 FILE.');
      accessCode = fs.readFileSync(file, 'utf8').trim();
      if (!accessCode) throw new Error('Access-code file is empty.');
    }
    if (!accessCode && !studio.access_code?.[serial]) throw new Error('No saved LAN access code. Sign in to Studio or use --access-code-file with a private local file.');
    const runtime = path.resolve(v.runtime || path.join(os.homedir(), '.local/share/bambi-a1-mcp/runtime/fulu-1.0.0-network-02.05.02.58/linux-x86_64'));
    for (const name of ['pjarczak_bambu_linux_host', 'libbambu_networking.so', 'libBambuSource.so', 'ca-certificates.crt']) {
      if (!fs.existsSync(path.join(runtime, name))) throw new Error(`Missing runtime component ${name}. Run npm run install:runtime.`);
    }
    const slicerPath = v.slicer || (process.platform === 'darwin' ? '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio' : '');
    if (!slicerPath || !fs.existsSync(slicerPath)) throw new Error('Install Bambu Studio and pass --slicer with its executable path.');
    const dockerPath = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'docker')).find(p => {
      try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
    });
    if (!dockerPath) throw new Error('Install Docker and make its docker command available on PATH.');
    const root = fileURLToPath(new URL('..', import.meta.url));
    const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
    const configDir = path.dirname(destination);
    const config = { model: 'a1', nozzle, bedType: v.bed || 'textured_plate', host, serial, country, region,
      studioConfig, slicerPath: path.resolve(slicerPath), workDir: path.join(configDir, 'jobs'),
      bridgeConfigDir: path.join(configDir, 'network'), bridgeRuntimeDir: runtime,
      bridgeCommand: `${quote(process.execPath)} ${quote(path.join(root, 'scripts/bridge-docker.mjs'))}`,
      dockerPath, ...(accessCode ? { accessCode } : {}) };
    privateJson(destination, config);
    const mcpFile = path.join(configDir, 'mcp-client.json');
    privateJson(mcpFile, { mcpServers: { 'bambi-a1': { command: process.execPath,
      args: [path.join(root, 'src/server.mjs')], env: { BAMBI_CONFIG: destination } } } });
    console.log(`Private configuration created: ${destination}`);
    console.log(`MCP client configuration example: ${mcpFile}`);
    console.log('Next: npm run import:session (for cloud monitoring), then npm run doctor -- --lan --cloud. No print was sent.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { prompt?.close(); }
