// A connected socket does not establish that protected commands can be
// sent. Exercise a read-only Studio query before any physical control. Only
// this query may be repeated; a pause/resume/stop is never retried here.
const query = 'extrusion_cali_get_result';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function accepted(response, operation, label) {
  if (response?.ok !== true || response.value !== 0) {
    const code = typeof response?.value === 'number' ? response.value : 'unavailable';
    throw new Error(`${label} control readiness ${operation} failed (code ${code}). No control command was sent.`);
  }
}

export async function ensureControlReady({ route, bridge, config, options, session, nextSequence,
  replyTimeoutMs = 5000 }) {
  if (!['lan', 'cloud'].includes(route)) throw new Error('Explicit LAN or cloud readiness route is required.');
  const label = route === 'lan' ? 'LAN' : 'Cloud';
  const method = route === 'lan' ? 'net.send_message_to_printer' : 'net.send_message';
  const eventName = route === 'lan' ? 'on_local_message' : 'on_message';
  const settle = session ? ms => session.settle(ms) : async ms => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await bridge.request('bridge.poll_events', { limit: 4096 }, options);
      await delay(250);
    }
  };
  const send = async () => {
    const sequence = nextSequence();
    const response = await bridge.callWithAgent(method, {
      dev_id: config.serial, msg: JSON.stringify({ print: { command: query,
        sequence_id: sequence, nozzle_diameter: String(config.nozzle || 0.4) } }), qos: 1, flag: 0,
    }, options);
    return { sequence, response };
  };
  let probe = await send();
  const bootstrapCodes = route === 'lan' ? [-4, -4030] : [-2, -4];
  if (probe.response?.ok === true && bootstrapCodes.includes(probe.response.value)) {
    // The first protected query can bootstrap asynchronous device-key setup.
    // Complete the normal vendor certificate exchange, then repeat only the
    // read-only query. A matching printer reply below is the readiness proof.
    await settle(10000);
    const install = async () => accepted(await bridge.callWithAgent('net.install_device_cert', {
      dev_id: config.serial, lan_only: route === 'lan',
    }, options), 'certificate installation', label);
    const update = async () => accepted(await bridge.callWithAgent('net.update_cert', {}, options), 'certificate update', label);
    // Preserve the order exercised on each transport in the live probes.
    if (route === 'lan') { await install(); await update(); }
    else { await update(); await install(); }
    await settle(3000);
    probe = await send();
  }
  accepted(probe.response, 'query', label);
  const deadline = Date.now() + replyTimeoutMs;
  while (Date.now() < deadline) {
    const polled = await bridge.request('bridge.poll_events', { limit: 4096 }, options);
    for (const event of polled?.events || []) {
      if (event.name !== eventName || event.payload?.dev_id !== config.serial) continue;
      let message;
      try { message = JSON.parse(event.payload.msg).print; } catch { continue; }
      if (message?.command !== query || String(message.sequence_id) !== probe.sequence) continue;
      if (message.result !== 'success') {
        const code = Number.isInteger(message.err_code) ? ` (code ${message.err_code})` : '';
        throw new Error(`${label} control readiness query was not confirmed by the printer${code}. No control command was sent.`);
      }
      return;
    }
    await delay(100);
  }
  throw new Error(`${label} control readiness query had no matching successful printer reply. No control command was sent.`);
}
