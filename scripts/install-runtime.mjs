#!/usr/bin/env node
// Downloads stay outside the repository. These are publisher artifacts, not redistributed binaries.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

export const artifacts = [
  { name: 'runtime.tar.gz', sha256: '42056ff106fba4387655b5f6393d70b441853f2ee6b7500a9d9b59d64aab0a62',
    url: 'https://github.com/FULU-Foundation/OrcaSlicer-bambulab/releases/download/v1.0.0/linux_host_runtime_c661ddc2ebd4d4759aeb922629c37c9f58662129.tar.gz' },
  { name: 'plugin.zip', sha256: 'e7158dca80c0853520877229a18739e1b6f21b70a9c0f01db19af78a374287d3',
    url: 'https://public-cdn.bblmw.com/upgrade/studio/plugins/02.05.02.58/9fb586c207/linux_02.05.02.58.zip' },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const { values } = parseArgs({ options: { destination: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { console.log('Downloads checksum-pinned FULU v1.0.0 and Bambu networking 02.05.02.58 from their publishers. Requires tar and unzip. --destination DIRECTORY overrides the private install location.'); }
  else {
    if (process.platform === 'win32') throw new Error('Run this installer inside WSL2; native Windows is not supported.');
    const destination = path.resolve(values.destination || path.join(os.homedir(), '.local/share/bambi-a1-mcp/runtime/fulu-1.0.0-network-02.05.02.58'));
    const installed = path.join(destination, 'linux-x86_64');
    const manifestFile = path.join(destination, 'manifest.json');
    if (fs.existsSync(destination)) {
      const manifest = JSON.parse(fs.readFileSync(manifestFile));
      for (const name of ['pjarczak_bambu_linux_host', 'libbambu_networking.so', 'libBambuSource.so', 'ca-certificates.crt']) {
        if (!/^[a-f0-9]{64}$/.test(manifest.files?.[name] || '')) throw new Error('Incomplete runtime manifest. Install into a new directory.');
      }
      for (const [name, expected] of Object.entries(manifest.files)) {
        if (path.basename(name) !== name || hash(fs.readFileSync(path.join(installed, name))) !== expected) throw new Error('Installed runtime integrity check failed. Install into a new directory.');
      }
      console.log(`Verified existing runtime: ${installed}`);
    } else {
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      const stage = fs.mkdtempSync(path.join(path.dirname(destination), '.install-'));
      try {
        for (const artifact of artifacts) {
          console.log(`Downloading ${artifact.name} from ${new URL(artifact.url).hostname}`);
          const response = await fetch(artifact.url, { signal: AbortSignal.timeout(120000) });
          if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (hash(bytes) !== artifact.sha256) throw new Error(`${artifact.name} SHA-256 mismatch; refusing to extract.`);
          fs.writeFileSync(path.join(stage, artifact.name), bytes, { mode: 0o600 });
        }
        // Archives are immutable, checksum-verified artifacts with a reviewed file layout.
        execFileSync('tar', ['-xzf', path.join(stage, 'runtime.tar.gz'), '-C', stage]);
        const runtime = path.join(stage, 'linux-x86_64');
        execFileSync('unzip', ['-q', path.join(stage, 'plugin.zip'), '-d', runtime]);
        const files = Object.fromEntries(fs.readdirSync(runtime).map(name => [name, hash(fs.readFileSync(path.join(runtime, name)))]));
        fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ artifacts, files }, null, 2), { mode: 0o600 });
        fs.unlinkSync(path.join(stage, 'runtime.tar.gz')); fs.unlinkSync(path.join(stage, 'plugin.zip'));
        fs.renameSync(stage, destination);
        console.log(`Installed and verified runtime: ${installed}`);
      } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
