// A connected LAN socket does not establish that protected commands can be
// sent. Exercise a read-only Studio query before any physical control. Only
// this query may be repeated; a pause/resume/stop is never retried here.
const query = 'extrusion_cali_get_result';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function accepted(response, operation) {
  if (response?.ok !== true || response.value !== 0) {
    const code = typeof response?.value === 'number' ? response.value : 'unavailable';
    throw new Error(`LAN control readiness ${operation} failed (code ${code}). No control command was sent.`);
  }
}

export async function ensureLanControlReady({ bridge, config, options, session, nextSequence,
  replyTimeoutMs = 5000 }) {
  const send = async () => {
    const sequence = nextSequence();
    const response = await bridge.callWithAgent('net.send_message_to_printer', {
      dev_id: config.serial, msg: JSON.stringify({ print: { command: query,
        sequence_id: sequence, nozzle_diameter: String(config.nozzle || 0.4) } }), qos: 1, flag: 0,
    }, options);
    return { sequence, response };
  };
  let probe = await send();
  if (probe.response?.ok === true && [-4, -4030].includes(probe.response.value)) {
    // The first protected query can bootstrap asynchronous device-key setup.
    // Complete the normal vendor certificate exchange, then repeat only the
    // read-only query. A matching printer reply below is the readiness proof.
    await session.settle(10000);
    accepted(await bridge.callWithAgent('net.install_device_cert', {
      dev_id: config.serial, lan_only: true,
    }, options), 'certificate installation');
    accepted(await bridge.callWithAgent('net.update_cert', {}, options), 'certificate update');
    await session.settle(3000);
    probe = await send();
  }
  accepted(probe.response, 'query');
  const deadline = Date.now() + replyTimeoutMs;
  while (Date.now() < deadline) {
    const polled = await bridge.request('bridge.poll_events', { limit: 4096 }, options);
    for (const event of polled?.events || []) {
      if (event.name !== 'on_local_message' || event.payload?.dev_id !== config.serial) continue;
      let message;
      try { message = JSON.parse(event.payload.msg).print; } catch { continue; }
      if (message?.command !== query || String(message.sequence_id) !== probe.sequence) continue;
      if (message.result !== 'success') {
        const code = Number.isInteger(message.err_code) ? ` (code ${message.err_code})` : '';
        throw new Error(`LAN control readiness query was not confirmed by the printer${code}. No control command was sent.`);
      }
      return;
    }
    await delay(100);
  }
  throw new Error('LAN control readiness query had no matching successful printer reply. No control command was sent.');
}
