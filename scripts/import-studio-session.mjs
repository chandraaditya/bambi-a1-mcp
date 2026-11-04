#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { readConfig, defaultStudioConfig } from '../src/config.mjs';

const config = readConfig();
const studio = config.studioConfig || defaultStudioConfig();
const source = path.join(path.dirname(studio), 'BambuNetworkEngine.conf');
if (!config.bridgeConfigDir) throw new Error('Configure bridgeConfigDir first.');
if (!fs.existsSync(source)) throw new Error('No Bambu Studio session found. Sign in to Studio on this host first.');
fs.mkdirSync(config.bridgeConfigDir, { recursive: true, mode: 0o700 });
const target = path.join(config.bridgeConfigDir, 'BambuNetworkEngine.conf');
if (fs.existsSync(target)) fs.copyFileSync(target, target + '.before-import');
fs.copyFileSync(source, target); fs.chmodSync(target, 0o600);
if (fs.existsSync(target + '.before-import')) fs.chmodSync(target + '.before-import', 0o600);
console.log('Copied the encrypted Studio session privately. Restart this MCP and run doctor --cloud.');
