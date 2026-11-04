#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readConfig } from '../src/config.mjs';

const config = readConfig();
const runtime = config.bridgeRuntimeDir;
if (!runtime || !fs.existsSync(path.join(runtime, 'pjarczak_bambu_linux_host'))) {
  throw new Error('bridgeRuntimeDir must contain the installed FULU Linux host and networking plug-in.');
}
for (const directory of [config.workDir, config.bridgeConfigDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
// Paths are identical on host and guest; every prepared job remains visible to the upload plug-in.
const mounts = [...new Set([runtime, config.workDir, config.bridgeConfigDir])];
const args = ['run', '--rm', '-i', '--platform', 'linux/amd64', '--network', 'bridge'];
for (const directory of mounts) args.push('-v', `${directory}:${directory}:${directory === runtime ? 'ro' : 'rw'}`);
args.push('-w', runtime, '-e', `LD_LIBRARY_PATH=${runtime}`,
  '-e', `CURL_CA_BUNDLE=${runtime}/ca-certificates.crt`, '-e', `SSL_CERT_FILE=${runtime}/ca-certificates.crt`,
  config.dockerImage || 'ubuntu@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852',
  'sh', '-c', './pjarczak_bambu_linux_host | cat');
// The pipe inside the container is required by FULU's host (stdout cannot be a socket).
const child = spawn(config.dockerPath || 'docker', args, { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
