import fs from 'node:fs';
import net from 'node:net';
import { BambuNetworkBridge } from 'bambu-printer-mcp/dist/bambu-network-bridge.js';
import { STLManipulator } from 'bambu-printer-mcp/dist/stl/stl-manipulator.js';
import { inspectPrintFile } from 'bambu-printer-mcp/dist/safety/print-file.js';
import { validatePrinterState } from 'bambu-printer-mcp/dist/safety/printer-state.js';
import { credentials } from './config.mjs';
import { freshMqttStatus, withLanMqtt } from './telemetry.mjs';
import { CloudBridge, freshBridgeStatus, checked } from './cloud-bridge.mjs';

function tcpProbe(host, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = result => { if (settled) return; settled = true; socket.destroy(); resolve(result); };
    socket.setTimeout(2500, () => finish({ reachable: false, error: 'TIMEOUT' }));
    socket.once('connect', () => finish({ reachable: true }));
    socket.once('error', error => finish({ reachable: false, error: error.code || 'CONNECTION_FAILED' }));
  });
}

export function createRuntime(config) {
  const bridge = new BambuNetworkBridge();
  const bridgeOptions = () => ({ bridgeCommand: config.bridgeCommand, configDir: config.bridgeConfigDir,
    countryCode: config.country, timeoutMs: 180000 });
  const cloudOptions = () => {
    if (!fs.existsSync(config.cloudCredentialsFile)) return bridgeOptions();
    const auth = credentials(config);
    return { ...bridgeOptions(), userInfo: JSON.stringify({ command: 'user_login', data: {
      token: auth.accessToken, access_token: auth.accessToken, refresh_token: auth.refreshToken || auth.accessToken,
      expires_in: String(auth.expiresIn || 7776000), refresh_expires_in: String(auth.expiresIn || 7776000),
      user_id: String(auth.uid), uidStr: String(auth.uid),
      user: { id: String(auth.uid), uid: String(auth.uid), name: auth.name || '' },
    } }) };
  };
  const cloud = new CloudBridge(bridge, config, cloudOptions);
  const localPrinter = () => {
    if (!config.host || !config.serial || !config.accessCode) throw new Error('LAN host, serial, and access code are required.');
    return { devId: config.serial, devIp: config.host, username: 'bblp', password: config.accessCode, useSsl: true };
  };
  const localTiming = { connectTimeoutMs: 15000, pollMs: 250, settleMs: 3000, retryWaitMs: 8000 };
  const localStatus = async () => freshBridgeStatus(bridge, config, bridgeOptions(), async message => {
    checked(await bridge.callWithAgent('net.send_message_to_printer', { dev_id: config.serial,
      msg: JSON.stringify(message), qos: 1, flag: 0 }, bridgeOptions()), 'LAN telemetry request');
  }, 'on_local_message');
  return {
    inspect: (file, plateIndex) => inspectPrintFile(file, { model: 'a1', nozzleDiameters: [config.nozzle], bedType: config.bedType, plateIndex }),
    validate: validatePrinterState,
    async status(route) {
      if (route === 'cloud') return cloud.status();
      if (config.lanTelemetry === 'mqtt') return withLanMqtt(config, client => freshMqttStatus(client, config));
      return bridge.withLocalSession(localPrinter(), bridgeOptions(), () => {}, localTiming, localStatus);
    },
    async devices() {
      const devices = await cloud.devices();
      return devices.map(device => ({ configured: device.dev_id === config.serial, name: device.name || device.dev_name,
        model: device.dev_product_name, online: device.online ?? device.dev_online }));
    },
    async slice(file, directory, options = {}) {
      const slicer = new STLManipulator(directory);
      return await slicer.sliceSTLWithResult(file, 'bambustudio', config.slicerPath, options.processProfile,
        undefined, `Bambu Lab A1 ${config.nozzle} nozzle`, {
          bedType: config.bedType, ensureOnBed: true, arrange: true,
          loadFilaments: options.filamentProfiles?.join(';'), processOverrides: options.processOverrides,
        });
    },
    async dispatch(route, params, beforeDispatch, onDispatched) {
      if (!config.bridgeCommand) throw new Error('Configure the BambuNetwork bridge command before printing.');
      if (route === 'cloud') {
        const devices = await cloud.devices();
        const device = devices.find(device => device.dev_id === config.serial);
        if (!(device?.online ?? device?.dev_online)) throw new Error('Configured printer is not online in this cloud account.');
        const options = cloudOptions();
        await cloud.connect();
        const clientJobId = Date.now();
        const result = await bridge.callWithAgent('net.start_print', { client_job_id: clientJobId, params }, {
          ...options, beforeDispatch: async method => { if (method === 'net.start_print') await beforeDispatch(); },
          onDispatched: method => { if (method === 'net.start_print') onDispatched(); },
        });
        if (result?.ok === true && result.value === 0) return result;
        // Keep callback failures in the private job journal for diagnosis; never expose raw API bodies as tool output.
        const events = await bridge.request('bridge.poll_events', { limit: 4096 }, options).catch(() => ({ events: [] }));
        return { ...result, diagnostics: (events?.events || []).filter(event =>
          event.name === 'job.update_status' && event.payload?.job_id === clientJobId).map(event => event.payload) };
      }
      const result = await bridge.startLocalPrint(localPrinter(), 'net.start_local_print',
      { client_job_id: Date.now(), params }, { ...bridgeOptions(),
        beforeDispatch: async method => { if (method === 'net.start_local_print') await beforeDispatch(await localStatus()); },
        onDispatched: method => { if (method === 'net.start_local_print') onDispatched(); },
      }, () => {}, localTiming);
      return { ...result.result, diagnostics: result.jobUpdates };
    },
    async control(route, command) {
      if (route === 'cloud') {
        await cloud.connect();
        await cloud.send({ print: { command, sequence_id: String(Date.now()), param: '' } });
        return { status: 'command_sent', command, route, note: 'Read printer_status to confirm execution.' };
      }
      const options = bridgeOptions();
      return bridge.withLocalSession({ devId: config.serial, devIp: config.host, username: 'bblp', password: config.accessCode, useSsl: true },
        options, () => {}, { connectTimeoutMs: 30000, pollMs: 250, settleMs: 3000, retryWaitMs: 8000 }, async () => {
          const result = await bridge.callWithAgent('net.send_message_to_printer', { dev_id: config.serial,
            msg: JSON.stringify({ print: { command, sequence_id: String(Date.now()), param: '' } }), qos: 1, flag: 0 }, options);
          if (result?.ok !== true || result.value !== 0) throw new Error('Printer control command failed.');
          return { status: 'command_sent', command, route };
        });
    },
    async diagnose(connect) {
      const output = { model: config.model, nozzle: config.nozzle, slicerInstalled: fs.existsSync(config.slicerPath),
        lanConfigured: !!(config.host && config.serial && config.accessCode),
        cloudCredentialsPresent: fs.existsSync(config.cloudCredentialsFile), bridgeConfigured: !!config.bridgeCommand,
        studioSessionPresent: !!config.bridgeConfigDir && fs.existsSync(`${config.bridgeConfigDir}/BambuNetworkEngine.conf`),
        approvalMode: 'direct tool calls; no MCP elicitation', node: process.version };
      if (connect && config.bridgeCommand) {
        const probe = await bridge.ensureAgent(bridgeOptions());
        output.bridgeReady = true;
        output.bridgeVersion = probe.handshake?.bridge_version;
        output.bridgePluginVersion = probe.handshake?.network_actual_abi_version;
      }
      if (connect && config.host) {
        const [mqtt, ftps] = await Promise.all([tcpProbe(config.host, 8883), tcpProbe(config.host, 990)]);
        output.lanTcp = { mqtt8883: mqtt, ftps990: ftps };
        output.lanTcpNote = 'Host TCP reachability only; this does not establish MQTT authentication or print readiness.';
      }
      return output;
    },
    async close() { await bridge.stop(); },
  };
}
