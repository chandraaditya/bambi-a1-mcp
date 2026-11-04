#!/usr/bin/env node
import fs from 'node:fs';
import { BambuNetworkBridge } from 'bambu-printer-mcp/dist/bambu-network-bridge.js';
import { readConfig } from '../src/config.mjs';
import { exchangeTicket, signinUrl } from '../src/cloud-login.mjs';

const config = readConfig();
const fileIndex = process.argv.indexOf('--callback-file');
if (fileIndex < 0) {
  console.log('Sign in with Bambu, then provide the localhost callback URL in a private file.');
  console.log(signinUrl(config.region));
  console.log('Run: node scripts/cloud-login.mjs --callback-file /private/path/to/callback');
} else {
  const bridge = new BambuNetworkBridge();
  try {
    const callback = fs.readFileSync(process.argv[fileIndex + 1], 'utf8');
    console.log(JSON.stringify(await exchangeTicket(config, bridge, callback)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await bridge.stop(); }
}
