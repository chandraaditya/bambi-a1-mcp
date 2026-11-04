import mqtt from 'mqtt';

export async function withLanMqtt(config, action, connect = mqtt.connect) {
  if (!config.host || !config.serial || !config.accessCode) throw new Error('LAN host, serial, and access code are required.');
  const client = connect(`mqtts://${config.host}:8883`, {
    username: 'bblp', password: config.accessCode, reconnectPeriod: 0, connectTimeout: 10000,
    // Bambu LAN printers use a device certificate rather than a public DNS certificate.
    rejectUnauthorized: false, clean: true,
  });
  client.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('LAN connection timed out; check network reachability.')), 12000);
      const finish = error => { clearTimeout(timer); client.off('connect', connected); client.off('error', failed); error ? reject(error) : resolve(); };
      const connected = () => finish(); const failed = error => finish(error);
      client.once('connect', connected); client.once('error', failed);
    });
    return await action(client);
  } finally { await client.endAsync(true); }
}

export async function freshMqttStatus(client, config, timeoutMs = 12000) {
  const serial = config.serial;
  const topic = `device/${serial}/report`;
  await client.subscribeAsync(topic, { qos: 0 });
  return await new Promise((resolve, reject) => {
    const requestedAt = Date.now();
    let raw = {}, receivedAt, published = false, fullReport = false;
    const cleanup = () => { clearTimeout(timer); client.off('message', message); client.off('error', fail); client.off('close', closed); };
    const fail = error => { cleanup(); reject(error); };
    const closed = () => fail(new Error('LAN MQTT disconnected during telemetry read.'));
    const maybeResolve = () => {
      if (!published || !fullReport || !Array.isArray(raw.modules) ||
          !['gcode_state', 'print_error', 'hms'].every(k => k in raw)) return;
      cleanup();
      resolve({ connected: true, serial, model: 'a1', status: raw.gcode_state, raw,
        observation: { source: 'mqtt', requestedAt, receivedAt, identitySource: 'report' } });
    };
    const message = (incoming, buffer, packet) => {
      if (incoming !== topic || packet?.retain) return;
      let data;
      try { data = JSON.parse(buffer.toString()); } catch { return; }
      if (data.print?.command === 'push_status') {
        // Never assemble the core authorization fields from unrelated partial reports.
        if (['gcode_state', 'print_error', 'hms'].every(k => k in data.print)) fullReport = true;
        raw = { ...raw, ...data.print }; receivedAt = Date.now();
      }
      if (data.info?.command === 'get_version' && Array.isArray(data.info.module)) raw.modules = data.info.module;
      maybeResolve();
    };
    const timer = setTimeout(() => fail(new Error('No fresh complete LAN telemetry; no printer command was sent.')), timeoutMs);
    client.on('message', message); client.once('error', fail); client.once('close', closed);
    const sequence = String(Date.now());
    Promise.all([
      client.publishAsync(`device/${serial}/request`, JSON.stringify({ pushing: { sequence_id: sequence, command: 'pushall', version: 1, push_target: 1 } })),
      client.publishAsync(`device/${serial}/request`, JSON.stringify({ info: { sequence_id: sequence, command: 'get_version' } })),
    ]).then(() => { published = true; maybeResolve(); }, fail);
  });
}
