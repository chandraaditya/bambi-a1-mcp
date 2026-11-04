import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hmsCode } from 'bambu-printer-mcp/dist/safety/printer-state.js';
import { HMS_MESSAGES } from 'bambu-printer-mcp/dist/safety/hms-messages.js';
import { recoveryStatus } from './recovery.mjs';

export const configHome = () => path.join(os.homedir(), '.config', 'bambi-a1-mcp');
export const defaultStudioConfig = () => path.join(os.homedir(), process.platform === 'darwin'
  ? 'Library/Application Support/BambuStudio/BambuStudio.conf' : '.config/BambuStudio/BambuStudio.conf');

export function readConfig(env = process.env) {
  const file = env.BAMBI_CONFIG || path.join(configHome(), 'config.json');
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const config = {
    model: 'a1', nozzle: 0.4, bedType: 'textured_plate', country: 'IN', region: 'us',
    slicerPath: '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
    workDir: path.join(configHome(), 'jobs'),
    cloudCredentialsFile: path.join(configHome(), 'cloud.json'),
    ...saved,
  };
  for (const [key, variable] of Object.entries({ host: 'PRINTER_HOST', serial: 'BAMBU_SERIAL',
    accessCode: 'BAMBU_TOKEN', slicerPath: 'SLICER_PATH', bridgeCommand: 'BAMBU_NETWORK_BRIDGE_COMMAND',
    bridgeConfigDir: 'BAMBU_NETWORK_CONFIG_DIR', cloudCredentialsFile: 'BAMBI_CLOUD_CREDENTIALS_FILE' })) {
    if (env[variable]) config[key] = env[variable];
  }
  if (config.model !== 'a1') throw new Error('This server currently supports the Bambu Lab A1 only.');
  if (![0.2, 0.4, 0.6, 0.8].includes(config.nozzle)) throw new Error('Invalid configured nozzle diameter.');
  if (!['us', 'cn'].includes(config.region)) throw new Error('region must be us (global) or cn.');
  // Read the LAN code from Studio each time, so a code change needs no launcher edit.
  const studio = config.studioConfig || defaultStudioConfig();
  if (!config.accessCode && config.serial && fs.existsSync(studio)) {
    config.accessCode = JSON.parse(fs.readFileSync(studio, 'utf8')).access_code?.[config.serial];
  }
  return config;
}

export function credentials(config) {
  if (!fs.existsSync(config.cloudCredentialsFile)) {
    throw new Error('Cloud login is missing. Run the local cloud-login script; LAN access codes are not cloud tokens.');
  }
  const data = JSON.parse(fs.readFileSync(config.cloudCredentialsFile, 'utf8'));
  if (!data.accessToken || !data.uid) throw new Error('Cloud credentials require accessToken and uid.');
  return data;
}

export function privateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function redact(value, config) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  const secrets = [config.accessCode, config.serial, config.host];
  try { const c = credentials(config); secrets.push(c.accessToken, c.refreshToken, String(c.uid)); } catch {}
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
  return text;
}

export function publicStatus(status) {
  const raw = status.raw;
  return { model: status.model, state: status.status, jobName: raw.subtask_name || raw.gcode_file || undefined, progressPercent: raw.mc_percent,
    remainingMinutes: raw.mc_remaining_time, layer: raw.layer_num, totalLayers: raw.total_layer_num,
    temperatures: { nozzle: raw.nozzle_temper, nozzleTarget: raw.nozzle_target_temper,
      bed: raw.bed_temper, bedTarget: raw.bed_target_temper },
    nozzleDiameter: raw.nozzle_diameter, nozzleType: raw.nozzle_type,
    ams: raw.ams?.ams?.map(unit => ({ id: unit.id, slots: unit.tray?.map(tray => ({ id: tray.id,
      material: tray.tray_type, color: tray.tray_color })) })),
    externalFilament: raw.vt_tray ? { material: raw.vt_tray.tray_type, color: raw.vt_tray.tray_color } : undefined,
    printType: raw.print_type, stage: raw.stg_cur, recovery: recoveryStatus(raw),
    printError: raw.print_error, hms: raw.hms?.map(entry => {
      const parsed = hmsCode(entry), description = HMS_MESSAGES[parsed?.hex];
      const message = typeof description === 'string' ? description : description?.[status.serial?.slice(0, 3)] ?? description?.['*'];
      return { ...entry, hex: parsed?.hex, message };
    }), observedAt: status.observation.receivedAt };
}
