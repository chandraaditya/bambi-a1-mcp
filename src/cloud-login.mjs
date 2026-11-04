import { privateJson } from './config.mjs';

export function signinUrl(region = 'us') {
  const base = region === 'cn' ? 'https://bambulab.cn/sign-in' : 'https://bambulab.com/sign-in';
  const callback = new URL(base + '/callback');
  for (const [key, value] of Object.entries({ source: 'portal', locale: 'en', redirect_url: 'http://localhost:13618',
    openBy: 'suite', from: 'studio', slicerLoginType: 'ticket' })) callback.searchParams.set(key, value);
  const url = new URL(base);
  url.searchParams.set('from', 'studio'); url.searchParams.set('source', 'portal'); url.searchParams.set('to', callback.href);
  return url.href;
}

export function parseTicket(text) {
  const url = new URL(text.trim());
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Provide the localhost callback URL from Bambu sign-in.');
  const ticket = url.searchParams.get('ticket') || new URLSearchParams(url.hash.slice(1)).get('ticket');
  if (!ticket) throw new Error('The callback URL has no ticket.');
  return ticket;
}

export async function exchangeTicket(config, bridge, callbackUrl) {
  const options = { bridgeCommand: config.bridgeCommand, configDir: config.bridgeConfigDir, countryCode: config.country, timeoutMs: 30000 };
  const response = await bridge.callWithAgent('net.get_my_token', { ticket: parseTicket(callbackUrl) }, options);
  if (response?.ok !== true || response.value !== 0 || response.http_code !== 200) {
    throw new Error(`Cloud sign-in exchange failed (HTTP ${response?.http_code || 'unavailable'}). Get a fresh sign-in ticket.`);
  }
  const tokens = JSON.parse(response.http_body);
  if (!tokens.accessToken) throw new Error('Bambu sign-in returned no access token.');
  const profileResponse = await bridge.callWithAgent('net.get_my_profile', { token: tokens.accessToken }, options);
  if (profileResponse?.value !== 0 || profileResponse.http_code !== 200) throw new Error('Cloud profile lookup failed after sign-in.');
  const profile = JSON.parse(profileResponse.http_body);
  const uid = profile.uidStr || profile.uid || profile.id;
  if (!uid) throw new Error('Cloud profile returned no user id.');
  privateJson(config.cloudCredentialsFile, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken || tokens.accessToken,
    expiresIn: tokens.expiresIn, uid: String(uid), name: profile.name || '', savedAt: new Date().toISOString() });
  return { status: 'signed_in', credentialsSavedPrivately: true };
}
