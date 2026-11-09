import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlbertHeijn, loginCode } from '../src/ah.ts';
import { Weekmand } from '../src/app.ts';
import { Store } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { tuesday } from './helpers.ts';

type Call = { path: string; method: string; body: any; auth?: string };

/** Nep-AH: alleen de routes die Weekmand gebruikt. Geen echte verzoeken. */
function fakeAh() {
  const calls: Call[] = [];
  const state = {
    list: [] as any[],
    refreshes: 0,
    fail: {} as Record<string, number>,
    receipts: [
      { id: 'B3', dateTime: '2026-11-10T09:30:00', totalAmount: { amount: 9.1 } },
      { id: 'B2', dateTime: '2026-11-08T17:00:00', totalAmount: { amount: 4.2 } },
      { id: 'B1', dateTime: '2026-10-20T12:00:00', totalAmount: { amount: 3.0 } },
    ],
    details: {
      B3: [{ id: 1, quantity: 2, name: 'AH KIPDIJFILET 400G', amount: { amount: 7.98 } }, { id: 2, quantity: 1, name: 'STATIEGELD', amount: { amount: 0.25 } }, { id: 3, quantity: 1, name: 'AH TANDENBORSTEL', amount: { amount: 2 } }],
      B2: [{ id: 4, quantity: 1, name: 'AH SCHARRELEIEREN M 10ST', amount: { amount: 4.2 } }],
      B1: [{ id: 5, quantity: 1, name: 'AH HALFVOLLE MELK 1L', amount: { amount: 1.2 } }],
    } as Record<string, unknown[]>,
  };
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body, auth: (init.headers as Record<string, string>)?.Authorization });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (state.fail[path]) { const status = state.fail[path]; delete state.fail[path]; return json({ message: 'nee' }, status); }
    if (path === '/mobile-auth/v1/auth/token') return body.code === 'eenmalige-code-123' ? json({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
    if (path === '/mobile-auth/v1/auth/token/refresh') {
      if (body.refreshToken === 'ingetrokken') return json({ error: 'invalid_grant' }, 400);
      state.refreshes++;
      return json({ access_token: 'a' + (state.refreshes + 1), refresh_token: 'r' + (state.refreshes + 1), expires_in: 3600 });
    }
    if (path === '/mobile-services/shoppinglist/v2/items') {
      if (method === 'PATCH') state.list.push(...body.items.map((i: any) => ({ description: i.description, quantity: i.quantity, strikedthrough: false, originCode: 'TXT' })));
      return json({ items: state.list });
    }
    if (path === '/graphql') {
      if (body.query.includes('posReceiptsPage')) return json({ data: { posReceiptsPage: { posReceipts: state.receipts } } });
      return json({ data: { posReceiptDetails: { id: body.variables.id, products: state.details[body.variables.id] } } });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { fetcher, calls, state };
}

function setup() {
  const clock = { now: tuesday };
  const secrets = new Secrets(null);
  const fake = fakeAh();
  const app = new Weekmand({ store: new Store(':memory:'), secrets, ah: new AlbertHeijn(secrets, fake.fetcher, () => clock.now), now: () => clock.now, shared: { ahSizes: {}, labels: {} } });
  app.searchPause = 0;
  const notices: string[] = [];
  app.events.on('notify', n => notices.push(n.text));
  return { app, secrets, fake, clock, notices };
}

test('inlogcode uit de geplakte regel', () => {
  assert.equal(loginCode("Failed to launch 'appie://login-exit?code=abc_DEF-123.x' because the scheme"), 'abc_DEF-123.x');
  assert.equal(loginCode('appie://login-exit?code=abc%2Fdef123'), 'abc/def123');
  assert.equal(loginCode('  eenmalige-code-123 '), 'eenmalige-code-123');
  // Zo ziet het antwoord van ingelogd.json eruit (november 2026); de code is een UUID.
  assert.equal(loginCode('{"pageProps":{"__N_REDIRECT":"appie://login-exit?code=00000000-1111-4222-8333-444444444444","__N_REDIRECT_STATUS":302},"theme":"AH_APP","uiTheme":"light","__N_SSP":true}'), '00000000-1111-4222-8333-444444444444');
  assert.equal(loginCode('{"pageProps":{"__N_REDIRECT":"appie://login-exit?code=Ab+c/9:x_Y-1","__N_REDIRECT_STATUS":307}}'), 'Ab+c/9:x_Y-1');
  assert.equal(loginCode('Failed to launch \'appie://login-exit?code=xyz12345\' because the scheme does not have a registered handler.'), 'xyz12345');
  assert.equal(loginCode('hallo daar'), null);
  assert.equal(loginCode('https://www.ah.nl/'), null);
  assert.equal(loginCode(''), null);
});

test('koppelen bewaart alleen tokens, in het geheimenbestand', async () => {
  const { app, secrets, fake } = setup();
  await assert.rejects(app.linkAh('appie://login-exit?code=verlopen-code-9'), { status: 400 });
  const status = await app.linkAh('appie://login-exit?code=eenmalige-code-123');
  assert.equal(status.linked, true);
  assert.equal(secrets.get('ah')?.refreshToken, 'r1');
  assert.equal(app.store.get('ah', null), null, 'niets in de database');
  assert.equal(app.store.get('ahSince', ''), '2026-11-07');
  assert.equal(fake.calls[0].body.clientId, 'appie-ios');
  app.unlinkAh();
  assert.equal(app.ahStatus().linked, false);
  assert.equal(secrets.get('ah'), undefined);
});

test('verlopen token wordt één keer ververst, ook bij gelijktijdige verzoeken', async () => {
  const { app, secrets, fake, clock } = setup();
  await app.linkAh('eenmalige-code-123');
  clock.now += 2 * 36e5;
  await Promise.all([app.ah.list(), app.ah.list(), app.ah.receipts()]);
  assert.equal(fake.state.refreshes, 1);
  assert.equal(secrets.get('ah')?.refreshToken, 'r2', 'nieuwste verversingstoken bewaard');
  assert.ok(fake.calls.filter(c => c.path.includes('shoppinglist')).every(c => c.auth === 'Bearer a2'));
  // Een ingetrokken token (401): verversen en één keer opnieuw.
  fake.state.fail['/mobile-services/shoppinglist/v2/items'] = 401;
  await app.ah.list();
  assert.equal(fake.state.refreshes, 2);
});

test('ingetrokken koppeling: ontkoppeld en een melding', async () => {
  const { app, secrets, clock, notices } = setup();
  await app.linkAh('eenmalige-code-123');
  secrets.set('ah', { ...secrets.get('ah')!, refreshToken: 'ingetrokken', expiresAt: 0 });
  clock.now += 1000;
  await assert.rejects(app.ah.list(), { status: 409 });
  assert.equal(app.ah.linked, false);
  assert.match(notices.join(), /AH-account is verlopen/);
});

test('boodschappen naar Mijn lijst: alleen wat er nog niet op staat', async () => {
  const { app, fake } = setup();
  await assert.rejects(app.sendToAhList(), { status: 409 });
  await app.linkAh('eenmalige-code-123');
  await app.setMeal({ date: '2026-11-11', recipeId: 'shakshuka', servings: 2 });
  const proposal = await app.ahListProposal();
  assert.ok(proposal.length >= 2);
  assert.ok(proposal.every(p => p.text && p.quantity >= 1));
  const eggs = proposal.find(p => p.match === 'eieren');
  assert.match(eggs!.text, /^Eieren \(.+\)$/);
  fake.state.list.push({ description: 'eieren', quantity: 1, strikedthrough: false }, { description: 'Uien', quantity: 1, strikedthrough: true });
  const r = await app.sendToAhList({ extra: ['tandpasta', 'Tandpasta'] });
  assert.ok(r.skipped.some(s => s.startsWith('Eieren')), 'eieren stonden er al op');
  assert.ok(r.added.includes('tandpasta'));
  assert.equal(r.skipped.filter(s => /tandpasta/i.test(s)).length, 1, 'geen dubbele regel');
  const patch = fake.calls.find(c => c.method === 'PATCH')!;
  assert.equal(patch.body.items.length, r.added.length);
  assert.ok(patch.body.items.every((i: any) => i.quantity >= 1 && i.quantity <= 99 && !('productId' in i) && i.strikeThrough === false));
  // Nog een keer: alles staat er al op, dus geen nieuw verzoek met regels.
  const again = await app.sendToAhList({ extra: ['tandpasta'] });
  assert.equal(again.added.length, 0);
  assert.equal(fake.calls.filter(c => c.method === 'PATCH').length, 1);
  // Alleen gekozen regels.
  const one = await app.sendToAhList({ ids: [], extra: ['wc-papier'] });
  assert.deepEqual(one.added, ['wc-papier']);
});

test('open bestelling bij AH en weigeringen geven een duidelijke melding', async () => {
  const { app, fake, clock } = setup();
  await app.linkAh('eenmalige-code-123');
  fake.state.fail['/mobile-services/shoppinglist/v2/items'] = 412;
  await assert.rejects(app.ah.list(), /bestelling open/);
  fake.state.fail['/graphql'] = 429;
  await assert.rejects(app.ah.receipts(), { status: 503 });
  const before = fake.calls.length;
  await assert.rejects(app.ah.list(), /later vanzelf/);
  assert.equal(fake.calls.length, before, 'geen verzoek tijdens de pauze');
  clock.now += 13 * 36e5;
  await app.ah.list();
});

test('onbekende bonregels: de AI koppelt ze en Weekmand onthoudt dat', async () => {
  const { app, fake } = setup();
  const line = (name: string, quantity = 1) => ({ id: 1, quantity, name, amount: { amount: 1 } });
  fake.state.details.B3 = [line('TOMAATBLOKJE', 2), line('KL KEUKEN'), line('TIJGER WIT'), line('RAAR DING')];
  fake.state.details.B2 = [];
  const asked: string[][] = [];
  app.receiptMatcher = async lines => {
    asked.push(lines);
    return [
      { receipt: 'TOMAATBLOKJE', kind: 'existing', key: 'tomatenblokjes', amount: 400 },
      { receipt: 'kl keuken', kind: 'ignore' },
      { receipt: 'TIJGER WIT', kind: 'new', name: 'Tijgerbrood', unit: 'g', category: 'brood', amount: 800 },
      { receipt: 'RAAR DING', kind: 'unknown' },
      { receipt: 'NIET GEVRAAGD', kind: 'existing', key: 'melk' },
    ];
  };
  await app.linkAh('eenmalige-code-123');
  const first = await app.importAhReceipts();
  const b3 = first.receipts.find(r => r.id === 'B3')!;
  assert.deepEqual(b3.unmatched, ['1× RAAR DING']);
  assert.deepEqual(b3.ignored, ['KL KEUKEN']);
  assert.equal(app.store.pantryItem('tomatenblokjes')?.amount, 800, '2 blikken van 400 g');
  const bread = app.store.get<Record<string, { key: string }>>('receiptAliases', {})['tijger wit'].key;
  assert.equal(app.store.pantryItem(bread)?.amount, 800);
  assert.equal(app.store.pantryItem('melk')?.amount ?? null, null, 'niet gevraagde regel genegeerd');
  assert.equal(asked.length, 1);

  // Een volgende bon met dezelfde regels: geen AI meer nodig.
  fake.state.receipts.unshift({ id: 'B4', dateTime: '2026-11-10T10:00:00', totalAmount: { amount: 1 } });
  fake.state.details.B4 = [line('TOMAATBLOKJE'), line('KL KEUKEN'), line('RAAR DING')];
  await app.importAhReceipts();
  assert.equal(asked.length, 1, 'alles al bekend of al gevraagd');
  assert.equal(app.store.pantryItem('tomatenblokjes')?.amount, 1200);
  assert.deepEqual(app.unmatchedReceiptLines(), [{ name: 'RAAR DING', quantity: 2 }]);

  // Zelf koppelen telt de open regels van beide bonnen alsnog.
  app.mapReceiptLine('RAAR DING', 'Halfvolle melk');
  assert.deepEqual(app.unmatchedReceiptLines(), []);
  assert.equal(app.store.pantryItem('melk')?.amount, 2 * app.catalog.ingredient('melk')!.packs[0].amount);
  assert.throws(() => app.mapReceiptLine('X', 'bestaat echt niet'), { status: 400 });
});

test('zonder AI: zelf koppelen of negeren, en een duidelijke melding bij "laat de AI zoeken"', async () => {
  const { app } = setup();
  await app.linkAh('eenmalige-code-123');
  await app.importAhReceipts();
  assert.deepEqual(app.unmatchedReceiptLines(), [{ name: 'AH TANDENBORSTEL', quantity: 1 }]);
  await assert.rejects(app.matchReceiptLines({ force: true }), { status: 409 });
  app.mapReceiptLine('AH TANDENBORSTEL', null);
  assert.deepEqual(app.unmatchedReceiptLines(), []);
  assert.deepEqual(app.ahStatus().receipts.find(r => r.id === 'B3')!.ignored, ['AH TANDENBORSTEL']);
});

test('kassabonnen tellen bij de voorraad, elke bon één keer', async () => {
  const { app, fake } = setup();
  await app.linkAh('eenmalige-code-123');
  const first = await app.importAhReceipts();
  assert.deepEqual(first.receipts.map(r => r.id), ['B3', 'B2'], 'nieuwste eerst, de oude bon van oktober niet');
  const b3 = first.receipts[0];
  assert.deepEqual(b3.counted, ['2× AH KIPDIJFILET 400G → Kippendijfilet']);
  assert.deepEqual(b3.unmatched, ['1× AH TANDENBORSTEL'], 'statiegeld telt niet mee');
  assert.equal(app.store.pantryItem('kippendij')?.amount, 800);
  assert.equal(app.store.pantryItem('ei')?.amount, 10);
  assert.equal(app.store.pantryItem('melk')?.amount ?? null, null, 'bon van vóór de koppeling telt niet');
  const details = fake.calls.filter(c => c.path === '/graphql').length;
  const second = await app.importAhReceipts();
  assert.equal(second.receipts.length, 0);
  assert.equal(fake.calls.filter(c => c.path === '/graphql').length, details + 1, 'alleen de lijst opnieuw, geen bon');
  assert.equal(app.store.pantryItem('kippendij')?.amount, 800, 'niet dubbel geteld');
  assert.equal(app.ahStatus().receipts.length, 2);
});
