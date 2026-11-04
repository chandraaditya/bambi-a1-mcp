import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTicket, signinUrl, exchangeTicket } from '../src/cloud-login.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('sign-in uses Bambu hosted login with the official loopback callback', () => {
  const url = new URL(signinUrl());
  assert.equal(url.origin, 'https://bambulab.com');
  const callback = new URL(url.searchParams.get('to'));
  assert.equal(callback.searchParams.get('redirect_url'), 'http://localhost:13618');
  assert.equal(callback.searchParams.get('slicerLoginType'), 'ticket');
});

test('tickets are accepted from loopback URLs only, from query or fragment', () => {
  assert.equal(parseTicket('http://localhost:13618/?ticket=private'), 'private');
  assert.equal(parseTicket('http://127.0.0.1:13618/#ticket=private'), 'private');
  assert.throws(() => parseTicket('https://example.com/?ticket=private'), /localhost/);
  assert.throws(() => parseTicket('http://localhost:13618/'), /no ticket/);
});

test('ticket exchange stores credentials privately without returning them', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bambi-login-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = { cloudCredentialsFile: path.join(directory, 'cloud.json') };
  const bridge = { async callWithAgent(method, payload) {
    if (method === 'net.get_my_token') {
      assert.equal(payload.ticket, 'private-ticket');
      return { ok: true, value: 0, http_code: 200, http_body: JSON.stringify({ accessToken: 'private-token', refreshToken: 'private-refresh' }) };
    }
    assert.equal(method, 'net.get_my_profile'); assert.equal(payload.token, 'private-token');
    return { value: 0, http_code: 200, http_body: JSON.stringify({ uidStr: '123456', name: 'Example' }) };
  } };
  const result = await exchangeTicket(config, bridge, 'http://localhost:13618/?ticket=private-ticket');
  assert.equal(JSON.stringify(result).includes('private-token'), false);
  assert.equal(fs.statSync(config.cloudCredentialsFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(config.cloudCredentialsFile)).uid, '123456');
});

test('an expired sign-in ticket returns a bounded error without leaking its value', async () => {
  const bridge = { async callWithAgent() { return { ok: true, value: -1, http_code: 401 }; } };
  await assert.rejects(exchangeTicket({}, bridge, 'http://localhost:13618/?ticket=private-ticket'), /HTTP 401/);
});
