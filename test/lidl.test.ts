import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Weekmand } from '../src/app.ts';
import { Store } from '../src/db.ts';
import { Lidl, lidlCents, parseReceiptHtml, ticketDate, ticketLines } from '../src/lidl.ts';
import { Secrets } from '../src/secrets.ts';
import { tuesday } from './helpers.ts';

const span = (line: number, text: string, cls = '', attrs: Record<string, string> = {}) =>
  `<span id="purchase_list_line_${line}"${cls ? ` class="${cls}"` : ''}${Object.entries(attrs).map(([k, v]) => ` data-${k}="${v}"`).join('')}>${text}</span>\n`;

/**
 * Zo ziet de geprinte bon van een Nederlandse Lidl-bon eruit (htmlPrintedReceipt): kolomkop,
 * non-food met artikelnummer, beide soorten korting, een artikel met aantal, een gewogen artikel
 * met vervolgregel en ingeleverd statiegeld. Opgebouwd naar de vorm die open-source clients
 * beschrijven; geen echte bon van de gebruiker.
 */
const HTML = '<html><body><pre><span class="purchase_list">'
  + span(1, 'OMSCHRIJVING     EUR', 'currency css_bold', { currency: '€' })
  + span(2, 'Bandschuurmachine-0502092     39,99 C', 'article css_bold', { 'art-id': '0502092', 'unit-price': '39,99', 'tax-type': 'C', 'art-description': 'Bandschuurmachine-0502092' })
  + span(3, '     Lidl Plus korting       -20,00', 'discount css_bold', { 'promotion-id': '100001000-NL-1' })
  + span(4, 'In prijs verlaagd             -1,80')
  + span(5, 'Frambozen siroop  2 x 1,79     3,58 B', 'article css_bold', { 'art-id': '6607485', 'art-quantity': '2', 'unit-price': '1,79', 'tax-type': 'B', 'art-description': 'Frambozen siroop' })
  + span(6, 'Bananen                        1,10 B', 'article css_bold', { 'art-id': '0080000', 'art-quantity': '0,792', 'unit-price': '1,39', 'tax-type': 'B', 'art-description': 'Bananen' })
  + span(7, '  0,792 kg x 1,39   EUR/kg', 'article', { 'art-id': '0080000', 'art-quantity': '0,792', 'unit-price': '1,39', 'tax-type': 'B', 'art-description': 'Bananen' })
  + span(8, '[X] Emballage                 -3,90', 'css_bold')
  + '</span></pre></body></html>';

test('bedragen en datums van Lidl', () => {
  assert.equal(lidlCents('1,10'), 110);
  assert.equal(lidlCents('-20,00'), -2000);
  assert.equal(lidlCents('1.10'), 110);
  assert.equal(lidlCents(18.97), 1897);
  assert.equal(lidlCents('1.234,56'), 123456);
  assert.equal(lidlCents('54,31 €'), 5431);
  assert.equal(lidlCents('geen'), null);
  assert.equal(ticketDate('2026-08-12T14:28:11'), '2026-08-12');
  assert.equal(ticketDate('2026-08-12T23:30:00Z'), '2026-08-13', 'UTC wordt Nederlandse tijd');
});

test('geprinte bon: artikelen, kortingen, gewicht en statiegeld', () => {
  const lines = parseReceiptHtml(HTML);
  assert.deepEqual(lines.map(l => l.name), ['Bandschuurmachine', 'Frambozen siroop', 'Bananen', '[X] Emballage'], 'geen kolomkop, artikelnummer eraf, bananen één keer');
  assert.deepEqual(lines[0].discounts, [{ name: 'Lidl Plus korting', cents: -2000 }, { name: 'In prijs verlaagd', cents: -180 }]);
  assert.equal(lines[1].quantity, 2);
  assert.equal(lines[1].cents, 358);
  assert.equal(lines[2].weight, true);
  assert.equal(lines[2].quantity, 0.792);
  assert.equal(lines[3].cents, -390);
  assert.deepEqual(lines[3].discounts, [], 'statiegeld is een eigen regel, geen korting');
  const sum = lines.reduce((s, l) => s + l.cents + l.discounts.reduce((d, x) => d + x.cents, 0), 0);
  assert.equal(sum, 1897, 'regels en kortingen tellen op tot het totaal');
});

test('oudere bonnen met losse regels (itemsLine)', () => {
  const lines = ticketLines({ itemsLine: [
    { name: 'Vegane Frikadellen', quantity: '1', currentUnitPrice: '2,19', originalAmount: '2,19', isWeight: false, discounts: [{ description: '5€ Coupon', amount: '0,21' }] },
    { name: 'Water', quantity: '6', originalAmount: '1,50', deposit: { description: 'Statiegeld', quantity: '6', amount: '0,90' } },
  ] });
  assert.deepEqual(lines.map(l => [l.name, l.cents]), [['Vegane Frikadellen', 219], ['Water', 150], ['Statiegeld', 90]]);
  assert.deepEqual(lines[0].discounts, [{ name: '5€ Coupon', cents: -21 }], 'korting altijd negatief');
});

type Call = { url: URL; method: string; headers: Record<string, string>; form?: URLSearchParams };

/** Nep-Lidl: alleen de routes die Weekmand gebruikt. Geen echte verzoeken. */
function fakeLidl() {
  const calls: Call[] = [];
  const state = {
    refreshes: 0,
    fail: {} as Record<string, number>,
    tickets: [
      { id: 'L3', date: '2026-11-10T09:30:00', totalAmount: 18.97 },
      { id: 'L2', date: '2026-11-08T17:00:00+01:00', totalAmount: '5,60' },
      { id: 'L1', date: '2026-10-20T12:00:00', totalAmount: '3,00' },
    ],
    details: {
      L3: { id: 'L3', date: '2026-11-10T09:30:00', totalAmount: 18.97, ticketType: 'HTML', htmlPrintedReceipt: HTML },
      L2: { id: 'L2', date: '2026-11-08T17:00:00+01:00', totalAmount: '5,60', itemsLine: [{ name: 'Kipdijfilet', quantity: '1', originalAmount: '4,49', discounts: [] }, { name: 'Halfvolle melk', quantity: '1', originalAmount: '1,11', discounts: [] }] },
      L1: { id: 'L1', date: '2026-10-20T12:00:00', totalAmount: '3,00', itemsLine: [{ name: 'Halfvolle melk', quantity: '2', originalAmount: '3,00', discounts: [] }] },
    } as Record<string, unknown>,
  };
  const fetcher = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    const form = typeof init.body === 'string' ? new URLSearchParams(init.body) : undefined;
    calls.push({ url, method, headers, form });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (state.fail[url.pathname]) { const status = state.fail[url.pathname]; delete state.fail[url.pathname]; return json({ message: 'nee' }, status); }
    if (url.host === 'accounts.lidl.com' && url.pathname === '/connect/token') {
      if (form?.get('grant_type') === 'authorization_code') return form.get('code') === 'ABCDEF0123456789' ? json({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
      if (form?.get('refresh_token') === 'ingetrokken') return json({ error: 'invalid_grant' }, 400);
      state.refreshes++;
      return json({ access_token: 'a' + (state.refreshes + 1), refresh_token: 'r' + (state.refreshes + 1), expires_in: 3600 });
    }
    if (url.host === 'tickets.lidlplus.com' && url.pathname === '/api/v2/NL/tickets') {
      const page = Number(url.searchParams.get('pageNumber'));
      return json({ page, size: 2, totalCount: state.tickets.length, tickets: state.tickets.slice((page - 1) * 2, page * 2) });
    }
    const detail = /^\/api\/v3\/NL\/tickets\/(.+)$/.exec(url.pathname);
    if (url.host === 'tickets.lidlplus.com' && detail) return state.details[detail[1]] ? json(state.details[detail[1]]) : json({}, 404);
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { fetcher, calls, state };
}

function setup() {
  const clock = { now: tuesday };
  const secrets = new Secrets(null);
  const fake = fakeLidl();
  const app = new Weekmand({ store: new Store(':memory:'), secrets, lidl: new Lidl(secrets, fake.fetcher, () => clock.now), now: () => clock.now, shared: { ahSizes: {}, labels: {} } });
  app.searchPause = 0;
  const notices: string[] = [];
  app.events.on('notify', n => notices.push(n.text));
  return { app, secrets, fake, clock, notices };
}

/** Zoals in de webapp: eerst de inloglink (maakt de PKCE-sleutel), dan de code plakken. */
const link = (app: Weekmand) => { app.lidlStatus(); return app.linkLidl(CALLBACK); };

const CALLBACK = "Failed to launch 'com.lidlplus.app://callback?code=ABCDEF0123456789&scope=openid%20profile&iss=https%3A%2F%2Faccounts.lidl.com' because the scheme does not have a registered handler.";

test('koppelen: zelf inloggen, code plakken; PKCE en tokens alleen in het geheimenbestand', async () => {
  const { app, secrets, fake } = setup();
  const url = new URL(app.lidlStatus().loginUrl!);
  assert.equal(url.origin + url.pathname, 'https://accounts.lidl.com/connect/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), 'com.lidlplus.app://callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(app.lidlStatus().loginUrl, url.href, 'dezelfde link tot het koppelen lukt');
  const verifier = secrets.get('lidlPending')!.verifier;
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));

  await assert.rejects(app.linkLidl('https://www.lidl.nl/'), /Plak de regel/);
  await assert.rejects(app.linkLidl('com.lidlplus.app://callback?code=VERLOPEN0000'), /accepteert deze code niet/);
  const status = await app.linkLidl(CALLBACK);
  assert.equal(status.linked, true);
  assert.equal(status.loginUrl, null);
  const token = fake.calls.filter(c => c.url.pathname === '/connect/token').at(-1)!;
  assert.equal(token.form?.get('code'), 'ABCDEF0123456789');
  assert.equal(token.form?.get('code_verifier'), verifier);
  assert.equal(token.headers.Authorization, 'Basic ' + Buffer.from('LidlPlusNativeClient:secret').toString('base64'));
  assert.equal(secrets.get('lidl')?.refreshToken, 'r1');
  assert.equal(secrets.get('lidlPending'), undefined, 'PKCE-sleutel weg na het koppelen');
  assert.equal(app.store.get('lidl', null), null, 'niets in de database');
});

test('bonnen tellen bij de voorraad en in het budget, elke bon één keer', async () => {
  const { app, fake } = setup();
  await link(app);
  const first = await app.importLidlReceipts();
  assert.deepEqual(first.receipts.map(r => r.id), ['L3', 'L2'], 'nieuwste eerst, de bon van oktober niet');
  const l2 = first.receipts[1];
  assert.deepEqual(l2.counted, ['1× Kipdijfilet → Kippendijfilet', '1× Halfvolle melk → Halfvolle melk']);
  assert.ok((app.store.pantryItem('kippendij')?.amount ?? 0) > 0);
  assert.ok(first.receipts[0].unmatched.includes('1× Bandschuurmachine'), 'onbekend: komt bij Niet herkend');
  assert.ok(!first.receipts[0].unmatched.some(t => /Emballage/.test(t)), 'statiegeld telt niet mee');
  assert.ok(app.lidlStatus().unmatched.some(u => u.name === 'Bandschuurmachine'));
  assert.equal(app.ahStatus().unmatched.length, 0, 'AH ziet de Lidl-regels niet');

  // De bonnen-API kreeg de kenmerken van de app en een eerlijke User-Agent.
  const ticket = fake.calls.find(c => c.url.host === 'tickets.lidlplus.com')!;
  assert.equal(ticket.headers.App, 'com.lidl.eci.lidl.plus');
  assert.equal(ticket.headers['Operating-System'], 'iOs');
  assert.match(ticket.headers['App-Version'], /^\d+\.\d+\.\d+$/);
  assert.match(ticket.headers['User-Agent'], /^Weekmand\//);
  assert.equal(ticket.headers.Authorization, 'Bearer a1');

  const spend = app.store.spend('lidl:L3')!;
  assert.equal(spend.source, 'lidl');
  assert.equal(spend.totalCents, 1897);
  assert.deepEqual(spend.discounts, [{ name: 'Lidl Plus korting', cents: -2000, line: 0 }, { name: 'In prijs verlaagd', cents: -180, line: 0 }]);
  assert.equal(spend.lines!.find(l => l.name === 'Bananen')?.pack, '0,792 kg');
  const budget = app.budgetOverview({ period: 'month' });
  assert.equal(budget.shops.find(s => s.name === 'Lidl')?.cents, 1897 + 560);
  assert.equal(budget.savingsCents, 2180, 'Lidl Plus-korting en prijsverlaging tellen als besparing');

  const calls = fake.calls.length;
  const again = await app.importLidlReceipts();
  assert.equal(again.receipts.length, 0);
  assert.equal(fake.calls.length, calls + 1, 'alleen de lijst opnieuw');
});

test('budget: oudere bonnen bladzijde voor bladzijde, een foto van dezelfde bon telt niet dubbel', async () => {
  const { app } = setup();
  await link(app);
  app.saveReceiptPhoto({ shop: 'Lidl', date: '2026-10-20', totalCents: 300, lines: [{ name: 'Halfvolle melk', quantity: 2, cents: 300 }] });
  const first = await app.syncSpending({ details: 12 });
  assert.deepEqual(first.errors, []);
  assert.equal(first.added, 3, 'pagina 1 en de oudere pagina 2');
  for (const id of ['L1', 'L2', 'L3']) assert.ok(app.store.spend('lidl:' + id)?.lines?.length, id + ' heeft regels');
  const photo = app.store.spends('2026-10-20', '2026-10-20').find(s => s.source === 'manual')!;
  assert.equal(photo.excluded, true, 'de foto telt niet meer mee');
  assert.match(photo.note ?? '', /Lidl Plus/);
  const second = await app.syncSpending({ details: 12 });
  assert.equal(second.added, 0);
  assert.equal(app.store.get<{ done?: boolean }>('lidlBackfill', {}).done, true);
});

test('verversen: het nieuwe verversingstoken wordt bewaard; één verversing tegelijk', async () => {
  const { app, secrets, clock, fake } = setup();
  await link(app);
  clock.now += 2 * 36e5;
  await Promise.all([app.lidl.tickets(1), app.lidl.tickets(1)]);
  assert.equal(fake.state.refreshes, 1);
  assert.equal(secrets.get('lidl')?.refreshToken, 'r2', 'Lidl roteert het verversingstoken');
  const refresh = fake.calls.find(c => c.form?.get('grant_type') === 'refresh_token')!;
  assert.equal(refresh.form?.get('refresh_token'), 'r1');
});

test('ingetrokken koppeling: ontkoppeld en een melding; weigering: twaalf uur rust', async () => {
  const { app, secrets, clock, notices, fake } = setup();
  await link(app);
  fake.state.fail['/api/v2/NL/tickets'] = 429;
  await assert.rejects(app.importLidlReceipts(), /wacht twaalf uur/);
  await assert.rejects(app.lidl.tickets(1), /weigerde eerder/);
  assert.ok(app.store.get<number>('lidlPausedUntil', 0) > clock.now, 'de pauze blijft bewaard');
  clock.now += 13 * 36e5;
  secrets.set('lidl', { ...secrets.get('lidl')!, refreshToken: 'ingetrokken', expiresAt: 0 });
  await assert.rejects(app.importLidlReceipts(), /verlopen/);
  assert.equal(app.lidl.linked, false);
  assert.ok(notices.some(n => /Lidl Plus-account is verlopen/.test(n)));
});
