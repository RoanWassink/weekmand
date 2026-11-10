import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

test('server: wachtwoord, API-token, CSRF en webapp', async t => {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['src/server.ts'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: ':memory:', APP_PASSWORD: 'geheim', SCHEDULER: 'off', API_TOKEN: 'test-token-1234567890', TELEGRAM_BOT_TOKEN: '', MQTT_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let output = '';
  child.stderr.on('data', d => { output += d; });
  for await (const chunk of child.stdout) if (String(chunk).includes('luistert op')) break;
  const base = `http://127.0.0.1:${port}`;
  const basic = { Authorization: 'Basic ' + Buffer.from('weekmand:geheim').toString('base64') };
  const json = { 'Content-Type': 'application/json' };

  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/api/state')).status, 401);
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Weekmand<\/title>/);
  assert.match(page.headers.get('content-security-policy') ?? '', /img-src 'self' blob: data: https:\/\/storefront-prod\.nl\.picnicinternational\.com;/, "productfoto's van Picnic");
  for (const asset of ['/app.js', '/barcode.js', '/style.css', '/manifest.webmanifest', '/icon.svg']) {
    assert.equal((await fetch(base + asset, { headers: basic })).status, 200, asset);
  }
  const state = await (await fetch(base + '/api/state', { headers: basic })).json();
  assert.equal(state.shop.mode, 'mock');
  assert.equal(state.canConfigure, true);

  // MCP alleen met token of wachtwoord.
  const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: json, body: rpc })).status, 401);
  const listed = await fetch(base + '/mcp', { method: 'POST', headers: { ...json, Authorization: 'Bearer test-token-1234567890' }, body: rpc });
  assert.equal((await listed.json()).result.tools.length, 29);
  assert.equal((await fetch(base + '/mcp', { method: 'POST', headers: { ...json, Authorization: 'Bearer fout' }, body: rpc })).status, 401);

  // Verzoeken vanaf een andere website worden geweigerd.
  const csrf = await fetch(base + '/api/ui/pantry/out', { method: 'POST', headers: { ...json, ...basic, Origin: 'http://evil.example' }, body: '{"name":"melk"}' });
  assert.equal(csrf.status, 403);
  const ok = await fetch(base + '/api/ui/pantry/out', { method: 'POST', headers: { ...json, ...basic, Origin: base }, body: '{"name":"melk"}' });
  assert.equal(ok.status, 200);

  // Accounts: eerste account vanaf localhost, daarna inloggen met cookie.
  const post = (path: string, data: unknown, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(data) });
  assert.equal((await (await fetch(base + '/api/auth/status')).json()).setup, true);
  const setup = await post('/api/auth/setup', { name: 'Roan', password: 'kort' });
  assert.equal(setup.status, 400);
  const created = await post('/api/auth/setup', { name: 'Roan', password: 'lang-genoeg' });
  assert.equal(created.status, 200);
  const cookie = created.headers.get('set-cookie')!.split(';')[0];
  assert.match(created.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  const me = await (await fetch(base + '/api/state', { headers: { cookie } })).json();
  assert.equal(me.user, 'roan');
  assert.equal((await post('/api/auth/setup', { name: 'x2', password: 'lang-genoeg' })).status, 409);
  assert.equal((await post('/api/ui/account/create', { name: 'partner', password: 'ook-lang-genoeg' }, { cookie })).status, 200);
  const partner = await post('/api/auth/login', { name: 'Partner', password: 'ook-lang-genoeg' });
  assert.equal(partner.status, 200);
  assert.equal((await post('/api/auth/login', { name: 'weekmand', password: 'geheim' })).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/auth/login', { name: 'roan', password: 'fout-wachtwoord' })).status, 401);
  assert.equal((await post('/api/auth/login', { name: 'roan', password: 'lang-genoeg' })).status, 429);
  assert.equal((await post('/api/auth/logout', {}, { cookie })).status, 200);
  assert.equal((await fetch(base + '/api/state', { headers: { cookie } })).status, 401);

  const tool = await fetch(base + '/api/tools/get_pantry_status', { method: 'POST', headers: { ...json, Authorization: 'Bearer test-token-1234567890' }, body: '{}' });
  assert.equal((await tool.json()).low[0].key, 'melk');
  assert.equal(output, '');
  child.kill();
  await once(child, 'exit');
});

test('eerste account alleen vanuit het eigen netwerk (ook Docker); koppelen daarna voor iedereen die is ingelogd', async () => {
  const { privateClient } = await import('../src/auth.ts');
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.168.1.40', '10.0.0.5', '172.17.0.1', '::ffff:192.168.65.1']) assert.equal(privateClient(ip), true, ip);
  for (const ip of ['8.8.8.8', '::ffff:8.8.8.8', '172.32.0.1', '2001:db8::1', '']) assert.equal(privateClient(ip), false, ip);
});
