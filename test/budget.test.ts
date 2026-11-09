import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlbertHeijn } from '../src/ah.ts';
import { Weekmand } from '../src/app.ts';
import type { SharedProducts } from '../src/app.ts';
import { Assistant } from '../src/assistant.ts';
import { matchDiscounts, periodRange, priceChanges, summarize, toCsv } from '../src/budget.ts';
import type { Spend } from '../src/budget.ts';
import { Store } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { PicnicShop } from '../src/shop.ts';
import { TelegramBot } from '../src/telegram.ts';
import { tuesday } from './helpers.ts';

test('perioden: week vanaf maandag, maand en jaar, ook terug in de tijd', () => {
  assert.deepEqual(periodRange('week', '2026-11-10'), { start: '2026-11-09', end: '2026-11-15', days: 7, label: 'Week 46 · 9–15 nov', short: 'wk 46' });
  assert.equal(periodRange('week', '2026-11-10', -2).start, '2026-10-26');
  assert.equal(periodRange('week', '2026-11-15').start, '2026-11-09', 'zondag hoort bij de week ervoor');
  assert.deepEqual(periodRange('month', '2026-11-10', -11), { start: '2025-12-01', end: '2025-12-31', days: 31, label: 'december 2025', short: 'dec' });
  assert.equal(periodRange('month', '2028-02-10').end, '2028-02-29');
  assert.deepEqual(periodRange('year', '2026-11-10', -1), { start: '2025-01-01', end: '2025-12-31', days: 365, label: '2025', short: '2025' });
});

test('optellen: categorieën, nodig of extra, kosten en wat nog niet uitgesplitst is', () => {
  const spends: Spend[] = [
    { id: 'picnic:1', source: 'picnic', date: '2026-11-02', totalCents: 1500, savingsCents: 120, lines: [
      { name: 'Halfvolle melk 1 L', quantity: 2, cents: 230 }, { name: "Lay's naturel chips", quantity: 1, cents: 199 }, { name: 'Raar ding', quantity: 1, cents: 871 },
    ] },
    { id: 'ah:1', source: 'ah', date: '2026-11-03', totalCents: 500, lines: [{ name: 'AH PILS 6X33', quantity: 1, cents: 550 }, { name: 'BONUS PILS', quantity: 1, cents: -100 }, { name: 'STATIEGELD', quantity: 1, cents: 50 }] },
    { id: 'ah:2', source: 'ah', date: '2026-11-04', totalCents: 700 },
    { id: 'manual:1', source: 'manual', date: '2026-11-05', totalCents: 300, shop: 'Markt', category: 'groente-fruit' },
  ];
  const label = (name: string) => /melk/i.test(name) ? { category: 'zuivel', kind: 'nodig', by: 'catalogus' } as const : /chips/i.test(name) ? { category: 'snacks', kind: 'extra', by: 'regel' } as const : /pils/i.test(name) ? { category: 'alcohol', kind: 'extra', by: 'regel' } as const : null;
  const s = summarize(spends, label);
  assert.equal(s.totalCents, 3000);
  assert.deepEqual(s.bySource, { picnic: 1500, ah: 1200, manual: 300 });
  assert.equal(s.savingsCents, 120 + 100, 'Picnic-actiekorting en AH-bonus');
  const cat = Object.fromEntries(s.categories.map(c => [c.key, c.cents]));
  assert.deepEqual(cat, { zuivel: 230, snacks: 199, overig: 871, alcohol: 550, kosten: -50 + 200, 'nog-niet': 700, 'groente-fruit': 300 });
  assert.equal(s.categories.reduce((sum, c) => sum + c.cents, 0), s.totalCents, 'de categorieën tellen op tot het totaal');
  assert.deepEqual(Object.fromEntries(s.kinds.map(k => [k.key, k.cents])), { nodig: 230 + 871 + 300, extra: 199 + 550, 'geen-eten': 0 });
  assert.equal(s.coverage, 2300 / 3000);
  assert.equal(s.products[0].name, 'Raar ding');
  assert.equal(s.products[0].by, null, 'nog niet ingedeeld');

  const csv = toCsv(spends, label);
  assert.ok(csv.startsWith('﻿datum;winkel;product;aantal;bedrag;bonus;categorie;soort'));
  assert.ok(csv.includes('"2026-11-03";"Albert Heijn";"AH PILS 6X33";1;5,50;0,00;"Alcohol";"Extra: snacks en traktaties"'));
  assert.ok(csv.includes('"2026-11-05";"Markt";"Losse uitgave";1;3,00;0,00;"Groente en fruit";"Nodig"'));
});

/** De AH-bon van 5 november 2026, zoals de AH-API hem teruggeeft. */
const bon = {
  lines: [['TOMAATBLOKJE', 35], ['AH GEMALEN', 279], ['KL KEUKEN', 319], ['RUNDERGEHAKT', 419], ['COURGETTE', 89], ['SWIRL ZAKKEN', 375], ['PINDAKOEKEN', 229], ['PAPRIKA', 109], ['HERTOG IJS', 199]]
    .map(([name, cents]) => ({ name: String(name), quantity: 1, cents: Number(cents) })),
  discounts: [{ name: 'BIOPREMIUMST', cents: -32 }, { name: 'AHRUNDERGEHA', cents: -40 }, { name: 'HERTOG MINIS', cents: -84 }, { name: 'ALLESWIRL&TO', cents: -113 }],
};

test('AH-bonus: bonusregels op naam bij het product, wat onduidelijk is blijft los', () => {
  const matched = matchDiscounts(bon.lines, bon.discounts);
  assert.deepEqual(matched.map(d => [d.name, d.line === null ? null : bon.lines[d.line].name]), [
    ['BIOPREMIUMST', null], ['AHRUNDERGEHA', 'RUNDERGEHAKT'], ['HERTOG MINIS', 'HERTOG IJS'], ['ALLESWIRL&TO', 'SWIRL ZAKKEN'],
  ]);
  const spend: Spend = { id: 'ah:5nov', source: 'ah', date: '2026-11-05', totalCents: 1784, lines: bon.lines, discounts: matched };
  const s = summarize([spend], () => null);
  assert.equal(s.savingsCents, 269, 'UW VOORDEEL 2,69');
  const gehakt = s.products.find(p => p.name === 'RUNDERGEHAKT')!;
  assert.deepEqual([gehakt.cents, gehakt.bonusCents], [379, 40], 'betaald na bonus');
  assert.equal(s.categories.find(c => c.key === 'kosten')!.cents, -32, 'de losse bonusregel');
  assert.equal(s.categories.reduce((sum, c) => sum + c.cents, 0), 1784);
  assert.ok(toCsv([spend], () => null).includes('"RUNDERGEHAKT";1;3,79;0,40;'));
  // Een oudere bon zonder bonusregels: het verschil met het totaal telt toch als besparing.
  const old = summarize([{ ...spend, discounts: undefined }], () => null);
  assert.equal(old.savingsCents, 269);
  assert.equal(old.totalCents, 1784);
});

test('AH-bonus: weigert AH het kortingenveld, dan blijft de bon leesbaar', async () => {
  const queries: string[] = [];
  const fetcher = (async (_url: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body));
    queries.push(body.query);
    const data = body.query.includes('discounts') ? { errors: [{ message: 'Cannot query field "discounts"' }] } : { data: { posReceiptDetails: { products: [{ name: 'PAPRIKA', quantity: 1, amount: { amount: 1.09 } }] } } };
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const secrets = new Secrets(null);
  secrets.set('ah', { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 36e5, linkedAt: '2026-11-01T00:00:00Z' });
  const r = await new AlbertHeijn(secrets, fetcher).receiptDetails('B1');
  assert.deepEqual(r, { lines: [{ name: 'PAPRIKA', quantity: 1, amount: 1.09 }], discounts: null });
  assert.equal(queries.length, 2);
});

test('duurder geworden: stuksprijs van de laatste aankoop tegenover de eerste', () => {
  const buy = (date: string, cents: number, quantity = 1): Spend => ({ id: date, source: 'picnic', date, totalCents: cents, lines: [{ name: 'Koffiebonen 1 kg', quantity, cents }, { name: 'Brood', quantity: 1, cents: 250 }] });
  const changes = priceChanges([buy('2026-03-01', 1200), buy('2026-06-01', 2700, 2), buy('2026-10-01', 1450)]);
  assert.deepEqual(changes.map(c => [c.name, c.from.unit, c.to.unit, c.percent]), [['Koffiebonen 1 kg', 1200, 1450, 21]]);
});

test('duurder geworden: alleen dezelfde verpakking telt', () => {
  const buy = (date: string, cents: number, pack?: string, productId?: string): Spend => ({ id: date, source: 'ah', date, totalCents: cents, lines: [{ name: 'RUNDERGEHAKT', quantity: 1, cents, ...(pack ? { pack } : {}), ...(productId ? { productId } : {}) }] });
  // Zonder maat: 300 g en 1 kg onder één naam zijn geen prijsstijging van 127%.
  assert.deepEqual(priceChanges([buy('2026-01-01', 499), buy('2026-02-01', 1149), buy('2026-03-01', 499), buy('2026-04-01', 1149)]), []);
  // Een echte stijging binnen dezelfde verpakking blijft zichtbaar.
  assert.deepEqual(priceChanges([buy('2026-01-01', 499), buy('2026-02-01', 1149), buy('2026-03-01', 569)]).map(c => [c.from.unit, c.to.unit, c.percent]), [[499, 569, 14]]);
  // Met maat: per maat vergeleken, ook als de prijs van de grote verpakking sterk stijgt.
  const sized = priceChanges([buy('2026-01-01', 499, '300 gram'), buy('2026-02-01', 1000, '1 kg'), buy('2026-03-01', 1690, '1000 g'), buy('2026-04-01', 489, '300 g')]);
  assert.deepEqual(sized.map(c => [c.pack, c.from.unit, c.to.unit, c.percent]), [['1000 g', 1000, 1690, 69]]);
  assert.equal(sized[0].pack, '1000 g', 'de maat van de laatste aankoop');
  // AH-bonregels krijgen de maat via het product-id.
  const ah = priceChanges([buy('2026-01-01', 499, undefined, 'p300'), buy('2026-02-01', 1149, undefined, 'p1000'), buy('2026-03-01', 549, undefined, 'p300')], l => ({ p300: '300 g', p1000: '1 kg' } as Record<string, string>)[l.productId ?? '']);
  assert.deepEqual(ah.map(c => [c.pack, c.percent]), [['300 g', 10]]);
});

/** Nep-Picnic met bezorgingen en nep-AH met bonnen: alleen wat het budget gebruikt. */
function setup(shared: SharedProducts = { ahSizes: {}, labels: {} }) {
  const clock = { now: tuesday };
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'k');
  const calls: string[] = [];
  const delivery = (id: string, start: string, items: [string, number, number, string?][], extra = {}) => ({
    id, status: 'COMPLETED', windowStart: start, orders: [
      { id: 'o' + id, status: 'COMPLETED', checkoutTotalPrice: items.reduce((s, i) => s + i[2], 0) + 99, promotionSavings: 50, membershipSavings: 0, items: items.map(([name, quantity, displayPrice, unitQuantity]) => ({ name, quantity, displayPrice, ...(unitQuantity ? { unitQuantity } : {}) })), ...extra },
      { id: 'x' + id, status: 'CANCELLED', checkoutTotalPrice: 5000, promotionSavings: 0, membershipSavings: 0, items: [{ name: 'Geannuleerd', quantity: 1, displayPrice: 5000 }] },
    ],
  });
  const deliveries: Record<string, any> = {
    d1: delivery('d1', '2026-11-05T17:00:00Z', [['Halfvolle melk 1 L', 2, 230, '1 liter'], ['Haribo goudberen', 1, 199]]),
    d2: delivery('d2', '2026-10-20T17:00:00Z', [['Kipfilet 600 g', 1, 699, '600 gram']]),
    old: delivery('old', '2021-01-05T17:00:00Z', [['Melk', 1, 100]]),
  };
  const fake = {
    delivery: {
      getDeliverySummaries: async () => { calls.push('summaries'); return Object.values(deliveries).map((d: any) => ({ id: d.id, status: 'COMPLETED', creationTime: d.windowStart, windowStart: d.windowStart, totalPrice: 1, orderCount: 1, itemCount: 1 })); },
      getDelivery: async (id: string) => { calls.push('delivery ' + id); return deliveries[id]; },
    },
  };
  const picnic = new PicnicShop(secrets, () => fake as never);
  const receipts = [
    { id: 'B2', dateTime: '2026-11-09T10:00:00', totalAmount: { amount: 6.5 } },
    { id: 'B1', dateTime: '2026-09-01T10:00:00', totalAmount: { amount: 3 } },
  ];
  const details: Record<string, unknown[]> = {
    B2: [{ id: 111, name: 'AH PILS 6X33', quantity: 1, amount: { amount: 5.5 } }, { name: 'RAAR PRODUCT', quantity: 1, amount: { amount: 1 } }],
    B1: [{ id: 222, name: 'AH HALFVOLLE MELK', quantity: 2, amount: { amount: 3 } }],
  };
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    const path = new URL(url).pathname;
    calls.push('ah ' + path);
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/mobile-auth/v1/auth/token/refresh') return json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 });
    if (body.query?.includes('posReceiptsPage')) return json({ data: { posReceiptsPage: { posReceipts: body.variables.offset ? [] : receipts } } });
    // Kassa-id 111 is in de webwinkel product 9111; 222 kent AH niet meer.
    if (body.query?.includes('productConvertId')) {
      calls.push('ah omzetten');
      return json({ data: Object.fromEntries([...body.query.matchAll(/(p\d+): productConvertId\(sourceId: (\d+)\)/g)].map(m => [m[1], m[2] === '111' ? 9111 : null])) });
    }
    if (body.query?.includes('salesUnitSize')) {
      calls.push('ah maten');
      return json({ data: Object.fromEntries([...body.query.matchAll(/(p\d+): product\(id: (\d+)\)/g)].map(m => [m[1], { id: Number(m[2]), salesUnitSize: '6 x 330 ml' }])) });
    }
    return json({ data: { posReceiptDetails: { id: body.variables.id, products: details[body.variables.id] } } });
  }) as unknown as typeof fetch;
  secrets.set('ah', { accessToken: 'a', refreshToken: 'r', expiresAt: tuesday + 36e5, linkedAt: '2026-11-01T00:00:00Z' });
  const ah = new AlbertHeijn(secrets, fetcher, () => clock.now);
  const app = new Weekmand({ store: new Store(':memory:'), secrets, picnic, ah, now: () => clock.now, shared });
  app.searchPause = 0;
  return { app, clock, calls };
}

test('budget: verpakkingen van Picnic en AH, elk AH-product één keer opgezocht', async () => {
  const { app, clock, calls } = setup();
  // Een bezorging van vóór de verpakkingen: wordt rustig opnieuw opgehaald.
  app.store.saveSpend({ id: 'picnic:d2', source: 'picnic', date: '2026-10-20', totalCents: 798, lines: [{ name: 'Kipfilet 600 g', quantity: 1, cents: 699 }] });
  await app.syncSpending({ details: 4 });
  assert.equal(app.store.spend('picnic:d1')!.lines![0].pack, '1 liter');
  assert.equal(app.store.spend('picnic:d2')!.lines![0].pack, '600 gram', 'oudere bezorging bijgewerkt');
  assert.equal(app.store.spend('ah:B2')!.lines![0].productId, '111');
  assert.equal(app.store.spend('ah:B2')!.lines![1].productId, undefined);
  assert.deepEqual(app.store.get('ahSizes', {}), { 111: { pack: '6 x 330 ml', at: clock.now }, 222: { pack: null, at: clock.now } });
  assert.deepEqual(calls.filter(c => c === 'ah omzetten' || c === 'ah maten'), ['ah omzetten', 'ah maten']);

  // Volgende ronde: niets opnieuw opgezocht; een onbekend product pas na een maand weer.
  await app.syncSpending();
  assert.equal(calls.filter(c => c === 'ah omzetten').length, 1);
  clock.now += 31 * 864e5;
  await app.syncSpending();
  assert.equal(calls.filter(c => c === 'ah omzetten').length, 2);
  assert.equal(calls.filter(c => c === 'ah maten').length, 1, 'zonder webwinkelproduct geen tweede verzoek');
});

test('budget: meegeleverde productkennis scheelt verzoeken aan AH en de AI; eigen keuze gaat voor', async () => {
  const { app, calls } = setup({ ahSizes: { 111: '6 x 33 cl' }, labels: { 'raar product': { category: 'huishouden', kind: 'geen-eten' } } });
  await app.syncSpending({ details: 4 });
  assert.ok(!(app.store.get('ahSizes', {}) as Record<string, unknown>)[111], '111 niet opgezocht');
  assert.equal(calls.filter(c => c === 'ah maten').length, 0, 'alleen 222 bleef over, en die kent AH niet');
  const asked: string[][] = [];
  app.productClassifier = async names => { asked.push(names); return names.map(name => ({ name, category: 'snacks', kind: 'extra' })); };
  await app.labelProducts();
  assert.ok(!asked.flat().includes('RAAR PRODUCT'), 'bekende naam niet aan de AI gevraagd');
  const month = app.budgetOverview({ period: 'month' });
  assert.equal(month.products.find(p => p.name === 'RAAR PRODUCT')!.by, 'gedeeld');
  app.setProductLabel({ name: 'raar product', category: 'snacks' });
  assert.equal(app.budgetOverview({ period: 'month' }).products.find(p => p.name === 'RAAR PRODUCT')!.category, 'snacks');
});

test('budget: totalen in één keer, regels rustig aan, overzicht per maand', async () => {
  const { app, calls } = setup();
  const first = await app.syncSpending({ details: 1 });
  assert.equal(first.added, 4, 'twee bezorgingen en twee bonnen; die van 2021 valt buiten de drie jaar');
  assert.equal(first.detailed, 2, 'per bron de nieuwste eerst');
  assert.ok(calls.includes('delivery d1') && !calls.includes('delivery d2'));
  await app.syncSpending({ details: 4 });
  assert.equal((await app.syncSpending()).detailed, 0, 'alles uitgesplitst');

  const month = app.budgetOverview({ period: 'month' });
  assert.equal(month.range.label, 'november 2026');
  assert.equal(month.totalCents, 230 + 199 + 99 + 650, 'geannuleerde bestelling telt niet; bezorgkosten wel');
  assert.equal(month.savingsCents, 50);
  assert.deepEqual(month.bySource, { picnic: 528, ah: 650, manual: 0 });
  assert.equal(month.categories.find(c => c.key === 'kosten')?.cents, 99);
  assert.equal(month.categories.find(c => c.key === 'alcohol')?.cents, 550, 'pils via de vaste regels');
  assert.equal(month.categories.find(c => c.key === 'zuivel')?.cents, 230, 'melk via de catalogus');
  assert.equal(month.coverage, 1);
  assert.equal(month.trend.length, 12);
  assert.equal(month.trend.at(-2)!.cents, 699 + 99, 'oktober in de trend, met bezorgkosten');
  assert.equal(month.previousCents, 798);
  assert.equal(month.forecastCents, Math.round(month.totalCents / 10 * 30), 'op 10 november: koers voor de hele maand');
  assert.equal(app.budgetOverview({ period: 'year' }).totalCents, 1178 + 798 + 300);

  // De AI deelt in wat regels en catalogus niet kennen; een eigen keuze gaat voor.
  const asked: string[][] = [];
  app.productClassifier = async names => { asked.push(names); return names.map(name => ({ name, category: /haribo/i.test(name) ? 'snacks' : 'overig', kind: /haribo/i.test(name) ? 'extra' : 'nodig' })); };
  const r = await app.labelProducts();
  assert.deepEqual(asked[0].sort(), ['Haribo goudberen', 'RAAR PRODUCT']);
  assert.equal(r.labeled, 2);
  assert.equal(app.budgetOverview().kinds.find(k => k.key === 'extra')!.cents, 199 + 550);
  app.setProductLabel({ name: 'raar product', category: 'huishouden' });
  assert.equal(app.budgetOverview().kinds.find(k => k.key === 'geen-eten')!.cents, 100);
  await app.labelProducts();
  assert.equal(asked.length, 1, 'niets meer om te vragen');

  // Losse uitgave, een bon niet meetellen, export.
  const expense = app.addExpense({ amount: '12,50', shop: 'Markt', category: 'groente-fruit', date: '2026-11-07' });
  assert.equal(app.budgetOverview().bySource.manual, 1250);
  app.excludeSpend('ah:B2', true);
  assert.equal(app.budgetOverview().bySource.ah, 0);
  assert.ok(app.budgetOverview().purchases.find(p => p.id === 'ah:B2')?.excluded, 'blijft zichtbaar, doorgestreept');
  app.excludeSpend('ah:B2', false);
  assert.throws(() => app.removeExpense('ah:B2'), /Alleen zelf ingevoerde/);
  app.removeExpense(expense.id);
  assert.ok(app.budgetCsv().includes('"Haribo goudberen";1;1,99;0,00;"Snoep, koek en chips";"Extra: snacks en traktaties"'));
  assert.equal(app.spendDetail('ah:B2').lines!.find(l => l.name === 'AH PILS 6X33')!.category, 'alcohol');
});

test('budget: seintje bij 80% en 100% van een zelf ingesteld maandbudget en bij een limiet', async () => {
  const { app } = setup();
  const notices: string[] = [];
  app.events.on('notify', n => notices.push(n.text));
  await app.syncSpending({ details: 10 });
  app.budgetAlerts();
  assert.deepEqual(notices, [], 'geen eigen budget: geen seintjes');
  app.setBudget({ month: 14 });
  app.budgetAlerts();
  assert.match(notices[0], /84% van het boodschappenbudget voor november 2026/);
  app.setBudget({ month: 11, limit: { category: 'alcohol', month: 5 } });
  app.budgetAlerts();
  app.budgetAlerts();
  assert.equal(notices.length, 3, 'elk seintje één keer');
  assert.match(notices[1], /budget voor november 2026 is op/);
  assert.match(notices[2], /limiet voor alcohol/);
  assert.equal(app.budgetSettings().limits.alcohol, 500);
  assert.throws(() => app.setBudget({ month: 5 }), /tussen € 10/);
});

test('telegram: antwoorden op een wijziging gaan ook naar de andere gekoppelde chats', async t => {
  const app = new Weekmand({ store: new Store(':memory:'), secrets: new Secrets(null), now: () => tuesday, shared: { ahSizes: {}, labels: {} } });
  const sent: { chat: number; text: string }[] = [];
  let updates = [{ update_id: 1, message: { chat: { id: 1 }, from: { first_name: 'Roan' }, text: 'melk is op' } }];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const method = url.split('/').pop();
    const body = JSON.parse(String(init.body ?? '{}'));
    if (method === 'getUpdates') {
      const batch = updates;
      updates = [];
      if (!batch.length) await new Promise(r => setTimeout(r, 20));
      return Response.json({ ok: true, result: batch });
    }
    if (method === 'sendMessage') sent.push({ chat: body.chat_id, text: body.text });
    return Response.json({ ok: true, result: method === 'getMe' ? { username: 'weekmand_bot' } : true });
  });
  const bot = new TelegramBot(app, new Assistant(app), 'token');
  app.store.set('telegram', { chats: [1, 2], names: { 2: 'Sanne' } });
  bot.start();
  for (let i = 0; i < 100 && sent.length < 2; i++) await new Promise(r => setTimeout(r, 10));
  bot.stop();
  assert.equal(sent[0].chat, 1);
  assert.equal(sent[1].chat, 2);
  assert.ok(sent[1].text.startsWith('Roan: melk is op\n\n'), sent[1].text);
  assert.deepEqual(bot.chats(), [{ id: 1, name: 'Roan' }, { id: 2, name: 'Sanne' }]);
  assert.deepEqual(app.store.get('telegramOffset', null), { bot: 'token', offset: 2 }, 'na een herstart niet opnieuw uitvoeren');
  bot.setShareMode('off');
  assert.equal(bot.shareMode, 'off');
  assert.throws(() => bot.setShareMode('iedereen'));
});
