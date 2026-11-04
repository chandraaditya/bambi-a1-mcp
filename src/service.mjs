import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { privateJson } from './config.mjs';
import { bridgeAmsMapping2Entry } from 'bambu-printer-mcp/dist/ams-mapping.js';
import { resolveStudioPrintOptions } from 'bambu-printer-mcp/dist/studio-print-options.js';

const routeCheck = route => {
  if (!['lan', 'cloud'].includes(route)) throw new Error('route must explicitly be lan or cloud.');
};
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function dispatchFailure(result) {
  const numeric = typeof result?.value === 'number' ? result.value : 'unknown';
  const last = result?.diagnostics?.findLast(event => event.code === result.value);
  const http = String(last?.msg || '').match(/\[http code\]:\s*(\d{3})/i)?.[1];
  const reason = String(last?.msg || '').match(/\[reason\]:\s*([^\r\n]+)/i)?.[1]?.trim();
  // Only known short labels are public; callback bodies may contain URLs, tokens or request identifiers.
  const known = ['internal blocking', 'unauthorized', 'forbidden'].includes(reason?.toLowerCase()) ? reason : undefined;
  return `Networking plug-in rejected print (code ${numeric}${http ? `, HTTP ${http}` : ''}${known ? `, reason: ${known}` : ''}).`;
}
const publicJob = job => ({ job_id: job.id, state: job.state, file: job.file, sha256: job.sha256,
  plate_index: job.plateIndex, inspection: job.inspection, route: job.route, error: job.lastError,
  note: job.state === 'dispatching' || job.state === 'unknown' ? 'Dispatch may have reached the printer. Check status before creating another job.' : undefined });

export class PrintService {
  constructor(config, runtime) {
    this.config = config; this.runtime = runtime;
    fs.mkdirSync(config.workDir, { recursive: true, mode: 0o700 });
  }
  jobFile(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid job id.');
    return path.join(this.config.workDir, id, 'job.json');
  }
  read(id) { return JSON.parse(fs.readFileSync(this.jobFile(id), 'utf8')); }
  save(job) { privateJson(this.jobFile(job.id), job); }
  get(id) { return publicJob(this.read(id)); }

  async prepare({ file_path, plate_index = 0, slice = false, process_profile, filament_profiles, process_overrides }) {
    if (!Number.isInteger(plate_index) || plate_index < 0) throw new Error('plate_index must be a nonnegative integer (zero based).');
    const file = path.resolve(file_path);
    if (!fs.statSync(file).isFile() || !/\.(?:stl|3mf)$/i.test(file)) throw new Error('Provide a local STL or 3MF file.');
    if (process_profile && !fs.statSync(process_profile).isFile()) throw new Error('Process profile does not exist.');
    for (const profile of filament_profiles || []) if (!fs.statSync(profile).isFile()) throw new Error('Filament profile does not exist.');
    if (/\.stl$/i.test(file) && (!process_profile || !filament_profiles?.length)) {
      throw new Error('STL slicing requires explicit process_profile and filament_profiles. Use list_profiles to choose.');
    }
    const id = randomUUID();
    const directory = path.join(this.config.workDir, id);
    fs.mkdirSync(directory, { mode: 0o700 });
    try {
      const source = path.join(directory, `source${path.extname(file).toLowerCase()}`);
      fs.copyFileSync(file, source); fs.chmodSync(source, 0o600);
      let output = source;
      if (slice || /\.stl$/i.test(file)) {
        const sliced = await this.runtime.slice(source, directory, { processProfile: process_profile,
          filamentProfiles: filament_profiles, processOverrides: process_overrides });
        output = sliced.path;
      }
      const snapshot = path.join(directory, 'prepared.3mf');
      fs.copyFileSync(output, snapshot); fs.chmodSync(snapshot, 0o400);
      const inspection = await this.runtime.inspect(snapshot, plate_index);
      const job = { id, state: 'prepared', file: snapshot, sha256: digest(snapshot), plateIndex: plate_index,
        inspection, createdAt: new Date().toISOString() };
      this.save(job);
      return publicJob(job);
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  }

  async print({ job_id, route, ams_mapping }) {
    routeCheck(route);
    const lock = path.join(this.config.workDir, '.printer-operation');
    try { fs.mkdirSync(lock); } catch (error) {
      if (error.code === 'EEXIST') throw new Error('Another printer operation owns the lock. If its process crashed, inspect printer_status before removing the lock.');
      throw error;
    }
    let job, dispatched = false;
    try {
      job = this.read(job_id);
      if (job.state !== 'prepared') return publicJob(job); // Idempotent across repeats and process restarts.
      if (digest(job.file) !== job.sha256) throw new Error('Prepared file changed; prepare a new job.');
      const inspection = await this.runtime.inspect(job.file, job.plateIndex);
      const useAMS = ams_mapping !== undefined;
      if (useAMS && (!Array.isArray(ams_mapping) || ams_mapping.length !== inspection.materials.length ||
        ams_mapping.some(v => !Number.isInteger(v) || v < -1 || v > 3) ||
        inspection.usedFilamentPositions.some(p => ams_mapping[p] < 0))) {
        throw new Error('ams_mapping must map each used project filament to an A1 AMS Lite slot 0..3; unused positions may be -1.');
      }
      if (!useAMS && inspection.usedFilamentPositions.length > 1) throw new Error('Multiple materials require explicit AMS Lite mapping.');
      const mapping = useAMS ? ams_mapping.slice() : inspection.materials.map(() => 254);
      const requirements = { ...inspection, useAMS, amsMapping: mapping };
      const preflight = async observedStatus => {
        if (digest(job.file) !== job.sha256) throw new Error('Prepared file changed before dispatch.');
        const status = observedStatus || await this.runtime.status(route);
        this.runtime.validate(status, requirements);
      };
      await preflight();
      job = { ...job, state: 'dispatching', route, amsMapping: mapping };
      this.save(job);
      const name = `bambi_${job.id}`;
      const calibration = resolveStudioPrintOptions('a1', { bedLeveling: true, flowCalibration: true });
      const params = {
        dev_id: this.config.serial, task_name: name, project_name: name, preset_name: name,
        filename: job.file, config_filename: job.file, plate_index: job.plateIndex + 1,
        dst_file: `${name}.3mf`, connection_type: route,
        dev_ip: route === 'lan' ? this.config.host : '', username: 'bblp',
        password: route === 'lan' ? this.config.accessCode : '',
        use_ssl_for_ftp: true, use_ssl_for_mqtt: true,
        task_bed_leveling: calibration.task_bed_leveling, task_flow_cali: calibration.task_flow_cali,
        task_vibration_cali: calibration.task_vibration_cali, task_layer_inspect: calibration.task_layer_inspect,
        auto_bed_leveling: calibration.auto_bed_leveling, auto_flow_cali: calibration.auto_flow_cali,
        auto_offset_cali: calibration.auto_offset_cali, extruder_cali_manual_mode: calibration.extruder_cali_manual_mode,
        task_record_timelapse: false,
        task_use_ams: useAMS, task_bed_type: this.config.bedType,
        ams_mapping: JSON.stringify(mapping), ams_mapping2: JSON.stringify(mapping.map(value => bridgeAmsMapping2Entry(value))),
        print_type: 'from_normal', try_emmc_print: false,
      };
      const result = await this.runtime.dispatch(route, params, preflight, () => { dispatched = true; });
      if (result?.diagnostics) job.dispatchDiagnostics = result.diagnostics;
      if (result?.ok !== true || result.value !== 0) throw new Error(dispatchFailure(result));
      job.state = 'command_sent'; job.dispatchedAt = new Date().toISOString(); this.save(job);
      return { ...publicJob(job), note: 'Networking plug-in accepted dispatch. Read printer_status to confirm the printer started.' };
    } catch (error) {
      if (job?.state === 'dispatching') {
        job.state = dispatched ? 'unknown' : 'prepared'; job.lastError = error.message; this.save(job);
      }
      if (dispatched) throw new Error('Print dispatch outcome is unknown; it will not be automatically retried. Read printer_status and inspect the printer before creating another job. Underlying error: ' + error.message);
      throw error;
    } finally { fs.rmSync(lock, { recursive: true, force: true }); }
  }

  async control({ route, action }) {
    routeCheck(route);
    const command = { pause: 'pause', cancel: 'stop' }[action];
    if (!command) throw new Error('action must be pause or cancel.');
    return await this.runtime.control(route, command);
  }
}
