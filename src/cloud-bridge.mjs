const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function checked(response, method) {
  if (response?.ok !== true || response.value !== 0) throw new Error(`Bambu cloud ${method} failed (code ${typeof response?.value === 'number' ? response.value : 'unavailable'}).`);
  return response;
}

export class CloudBridge {
  constructor(bridge, config, options) { this.bridge = bridge; this.config = config; this.options = options; this.subscribed = false; }
  async call(method, payload = {}) { return this.bridge.callWithAgent(method, payload, this.options()); }
  async devices() {
    const response = await this.call('net.get_user_print_info');
    if (response?.value !== 0 || response.http_code !== 200) throw new Error(`Cloud account lookup failed (HTTP ${response?.http_code || 'unavailable'}). Check cloud login and bridge CA certificates.`);
    const data = JSON.parse(response.http_body);
    if (!Array.isArray(data.devices)) throw new Error('Cloud returned no device list.');
    return data.devices;
  }
  async connect() {
    const { agent } = await this.bridge.ensureAgent(this.options());
    const generation = `${this.bridge.getStatus(this.options()).pid}:${agent}`;
    if (this.generation !== generation) { this.subscribed = false; this.generation = generation; }
    if ((await this.call('net.is_user_login'))?.value !== true) throw new Error('Cloud login is missing or expired. Import a signed-in Studio session or run the cloud-login script.');
    if ((await this.call('net.is_server_connected'))?.value !== true) {
      this.subscribed = false;
      checked(await this.call('net.connect_server'), 'connect');
      const deadline = Date.now() + 20000;
      while ((await this.call('net.is_server_connected'))?.value !== true) {
        if (Date.now() >= deadline) throw new Error('Cloud MQTT did not connect. Check login and bridge network access.');
        await delay(250);
      }
    }
    if (!this.subscribed) {
      checked(await this.call('net.set_on_message_fn'), 'message callback');
      checked(await this.call('net.set_on_printer_connected_fn'), 'printer callback');
      checked(await this.call('net.start_subscribe', { module: 'app' }), 'subscribe');
      checked(await this.call('net.set_user_selected_machine', { dev_id: this.config.serial }), 'select printer');
      checked(await this.call('net.add_subscribe', { devs: [this.config.serial] }), 'subscribe printer');
      const deadline = Date.now() + 20000;
      let ready = false;
      while (!ready) {
        const polled = await this.bridge.request('bridge.poll_events', { limit: 4096 }, this.options());
        ready = (polled?.events || []).some(event => event.name === 'on_printer_connected' &&
          (event.payload?.dev_id === this.config.serial || String(event.payload?.topic_str || '').includes(this.config.serial)));
        if (ready) break;
        if (Date.now() >= deadline) throw new Error('Cloud printer channel did not become ready; check that the printer is online.');
        await delay(250);
      }
      this.subscribed = true;
    }
  }
  async send(message) {
    checked(await this.call('net.send_message', { dev_id: this.config.serial, msg: JSON.stringify(message), qos: 1, flag: 0 }), 'send message');
  }
  async status(timeoutMs = 15000) {
    await this.connect();
    return await freshBridgeStatus(this.bridge, this.config, this.options(), message => this.send(message), 'on_message', timeoutMs);
  }
}

export async function freshBridgeStatus(bridge, config, options, send, eventName, timeoutMs = 12000) {
    // Discard every queued report before the new request; cached telemetry cannot authorize printing.
    await bridge.request('bridge.poll_events', { limit: 4096 }, options);
    const requestedAt = Date.now(), sequence = String(requestedAt);
    let raw = {}, receivedAt, fullReport = false;
    await send({ info: { sequence_id: sequence, command: 'get_version' } });
    await send({ pushing: { sequence_id: sequence, command: 'pushall', version: 1, push_target: 1 } });
    while (Date.now() - requestedAt < timeoutMs) {
      const polled = await bridge.request('bridge.poll_events', { limit: 4096 }, options);
      for (const event of polled?.events || []) {
        if (event.name !== eventName || event.payload?.dev_id !== config.serial) continue;
        let data;
        try { data = JSON.parse(event.payload.msg); } catch { continue; }
        if (data.print?.command === 'push_status') {
          if (['gcode_state', 'print_error', 'hms'].every(k => k in data.print)) fullReport = true;
          raw = { ...raw, ...data.print }; receivedAt = Date.now();
        }
        if (data.info?.command === 'get_version' && Array.isArray(data.info.module)) raw.modules = data.info.module;
      }
      if (fullReport && Array.isArray(raw.modules)) return { connected: true, serial: config.serial,
        model: 'a1', status: raw.gcode_state, raw, observation: { source: 'mqtt', requestedAt, receivedAt, identitySource: 'report' } };
      await delay(250);
    }
    throw new Error('No fresh complete printer report. No print command was sent.');
}
