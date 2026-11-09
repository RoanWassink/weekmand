import assert from 'node:assert/strict';
import { test } from 'node:test';
import PicnicClient from 'picnic-api';
import { Problem } from '../src/errors.ts';
import { importDeliveries } from '../src/picnic-history.ts';
import { Secrets } from '../src/secrets.ts';
import { applyChange, PicnicShop } from '../src/shop.ts';
import { Weekmand } from '../src/app.ts';
import { Store } from '../src/db.ts';
import type { Shop } from '../src/shop.ts';
import type { ShopCart } from '../src/types.ts';

const rawCart = {
  id: 'cart-1', mts: 1, total_count: 3, checkout_total_price: 507,
  items: [
    { id: 'line1', items: [{ id: 's1', name: 'Halfvolle melk', unit_quantity: '1 liter' }], display_price: 258, price: 258, decorators: [{ type: 'QUANTITY', quantity: 2 }] },
    { id: 'line2', items: [{ id: 's2', name: 'Eieren', unit_quantity: '10 stuks' }], display_price: 249, price: 249, decorators: [{ type: 'QUANTITY', quantity: 1 }] },
  ],
  delivery_slots: [{ slot_id: 'slot1', window_start: '2026-11-12T16:00:00Z', window_end: '2026-11-12T18:00:00Z', cut_off_time: '2026-11-11T21:00:00Z', is_available: true, selected: true, minimum_order_value: 3500 }],
  selected_slot: { slot_id: 'slot1', state: 'EXPLICIT' },
};

test('aanmelden met sms; sessie alleen onthouden na akkoord en geslaagde verificatie', async t => {
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/user/login')) return Response.json({ second_factor_authentication_required: true }, { headers: { 'x-picnic-auth': 'pre-2fa' } });
    if (path.endsWith('/user/2fa/generate')) return new Response(null, { status: 204 });
    if (path.endsWith('/user/2fa/verify')) return new Response(null, { status: 204, headers: { 'x-picnic-auth': 'verified' } });
    assert.ok(path.endsWith('/cart'));
    assert.equal(new Headers(options.headers).get('x-picnic-auth'), 'verified');
    return Response.json(rawCart);
  });
  const secrets = new Secrets(null);
  const shop = new PicnicShop(secrets);
  await shop.login('synthetic@example.invalid', 'synthetic', true);
  assert.equal(shop.status, 'sms');
  assert.equal(secrets.get('picnicAuthKey'), undefined);
  await assert.rejects(shop.readCart(), { status: 409 });
  await shop.verify('123456');
  assert.equal(shop.status, 'connected');
  assert.equal(secrets.get('picnicAuthKey'), 'verified');

  // Na een herstart is de bewaarde sessie direct bruikbaar.
  const restarted = new PicnicShop(secrets);
  assert.equal(restarted.status, 'connected');
  const cart = await restarted.readCart();
  assert.deepEqual(cart.lines.map(l => [l.id, l.quantity, l.cents]), [['s1', 2, 129], ['s2', 1, 249]]);
  assert.equal(cart.totalCents, 507);
  const slots = await restarted.slots();
  assert.deepEqual(slots.map(s => [s.id, s.cutOff, s.selected]), [['slot1', '2026-11-11T21:00:00Z', true]]);
});

test('zonder "onthouden" blijft de sessie alleen in het geheugen', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ second_factor_authentication_required: false }, { headers: { 'x-picnic-auth': 'key' } }));
  const secrets = new Secrets(null);
  const shop = new PicnicShop(secrets);
  await shop.login('synthetic@example.invalid', 'synthetic', false);
  assert.equal(shop.status, 'connected');
  assert.equal(secrets.get('picnicAuthKey'), undefined);
});

test('Picnic remt af (403 zonder code): sleutel blijft, pauze, daarna gewoon verder', async t => {
  let throttled = true;
  let calls = 0;
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return throttled ? new Response('<html><title>403 Forbidden</title></html>', { status: 403, headers: { 'Content-Type': 'text/html' } }) : Response.json(rawCart);
  });
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'goed');
  const shop = new PicnicShop(secrets);
  let now = Date.parse('2026-11-09T06:05:00Z');
  shop.now = () => now;
  let expired = 0;
  shop.onExpired = () => { expired++; };
  await assert.rejects(shop.readCart(), (e: Problem) => e.status === 503 && /07:20/.test(e.message) && /bewaard/.test(e.message));
  assert.equal(calls, 2, 'het verzoek en één controle');
  assert.equal(shop.status, 'connected');
  assert.equal(secrets.get('picnicAuthKey'), 'goed');
  // Tijdens de pauze gaat er niets naar Picnic.
  now += 10 * 60_000;
  await assert.rejects(shop.readCart(), { status: 503 });
  assert.equal(calls, 2);
  // Nog steeds afgeremd: langere pauze (30 minuten).
  now += 6 * 60_000;
  await assert.rejects(shop.readCart(), (e: Problem) => /07:51/.test(e.message));
  // Uren afremmen is nooit "verlopen".
  for (let i = 0; i < 10; i++) { now += 61 * 60_000; await assert.rejects(shop.readCart(), { status: 503 }); }
  assert.equal(expired, 0);
  // Picnic doet het weer: alles normaal, pauzes vergeten.
  throttled = false;
  now += 61 * 60_000;
  assert.equal((await shop.readCart()).lines.length, 2);
  assert.equal(expired, 0);
  assert.equal(secrets.get('picnicAuthKey'), 'goed');
});

test('sessie echt afgewezen (401): pas na zes uur verlopen, sleutel blijft bewaard', async t => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'AUTH_ERROR' } }, { status: 401 }));
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'old');
  const shop = new PicnicShop(secrets);
  let now = Date.parse('2026-11-09T06:00:00Z');
  shop.now = () => now;
  let expired = 0;
  shop.onExpired = () => { expired++; };
  await assert.rejects(shop.readCart(), { status: 503 });
  assert.equal(shop.status, 'connected');
  now += 5 * 36e5;
  await assert.rejects(shop.readCart(), { status: 503 });
  assert.equal(expired, 0);
  now += 36e5;
  await assert.rejects(shop.readCart(), (e: Problem) => e.status === 401 && /verlopen/.test(e.message));
  assert.equal(shop.status, 'expired');
  assert.equal(expired, 1);
  assert.equal(secrets.get('picnicAuthKey'), 'old', 'bewaard: na een herstart probeert Weekmand hem opnieuw');
  assert.equal(new PicnicShop(secrets).status, 'connected');
});

test('zoeken gebruikt alleen geldige producten', async () => {
  const fake = { catalog: { getSearchResults: async () => ({ products: { sections: [{ products: [
    { id: 's9', name: 'Krat pils', unitQuantity: '24 x 30 cl', displayPrice: 1899, isUnavailable: false },
    { id: '', name: 'kapot', unitQuantity: '', displayPrice: 1, isUnavailable: false },
    { id: 's10', name: 'Pils', unitQuantity: '6 x 33 cl', displayPrice: 729, isUnavailable: true },
  ] }] } }) } };
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'k');
  const shop = new PicnicShop(secrets, () => fake as never);
  assert.deepEqual((await shop.search('pils')).map(p => [p.id, p.available]), [['s9', true], ['s10', false]]);
});

test('historie: voltooide leveringen van de laatste twaalf weken, zonder dubbelen', async t => {
  const summary = { delivery_id: 'delivery1', status: 'COMPLETED', slot: { window_start: '2026-11-01T23:30:00Z' } };
  const raw = { ...summary, orders: [
    { id: 'order1', status: 'COMPLETED', creation_time: '2026-10-31T20:00:00Z', checkout_total_price: 774,
      items: [{ id: 'line1', items: [{ id: 's123', name: 'Halfvolle melk', unit_quantity: '1 liter' }], display_price: 774, decorators: [{ type: 'QUANTITY', quantity: 6 }] }] },
    { id: 'order2', status: 'CANCELLED', creation_time: '2026-10-31T21:00:00Z', items: [] },
  ] };
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/deliveries/summary')) return Response.json([summary, summary, { ...summary, delivery_id: 'x', status: 'CANCELLED' }, { ...summary, delivery_id: 'old', slot: { window_start: '2025-11-01T23:30:00Z' } }]);
    return Response.json(raw);
  });
  const client = new PicnicClient({ countryCode: 'NL', authKey: 'synthetic' });
  const history = await importDeliveries(client.delivery, Date.parse('2026-11-07T12:00:00Z'));
  assert.deepEqual(history.deliveries, [{ id: 'delivery1', date: '2026-11-02', totalCents: 774, paidCents: 774, orders: [{ id: 'order1', orderedAt: '2026-10-31T20:00:00Z', items: [{ productId: 's123', name: 'Halfvolle melk', pack: '1 liter', quantity: 6, cents: 774 }] }] }]);
});

test('mandwijziging: afgebroken synchronisatie hervat zonder dubbel toevoegen', async () => {
  const lines: Record<string, number> = { a: 1 };
  let failNext = false;
  const view = (): ShopCart => ({ id: 'c', totalCents: 0, lines: Object.entries(lines).map(([id, quantity]) => ({ id, name: id, unitQuantity: '', cents: 0, available: true, quantity })) });
  const shop: Shop = {
    kind: 'mock', label: 'test', ready: () => true, search: async () => [], slots: async () => [],
    readCart: async () => view(),
    add: async (id, n) => { if (failNext) throw new Error('netwerk'); lines[id] = (lines[id] ?? 0) + n; failNext = id === 'b'; return view(); },
    remove: async (id, n) => { lines[id] -= n; return view(); },
  };
  const change = { cartId: 'c', before: { a: 1, b: 0, c: 0 }, target: { a: 1, b: 2, c: 1 } };
  const ledger: Record<string, number> = {};
  await assert.rejects(applyChange(shop, change, (id, d) => { ledger[id] = (ledger[id] ?? 0) + d; }));
  assert.deepEqual(lines, { a: 1, b: 2 });
  failNext = false;
  await applyChange(shop, change, (id, d) => { ledger[id] = (ledger[id] ?? 0) + d; });
  assert.deepEqual(lines, { a: 1, b: 2, c: 1 });
  assert.deepEqual(ledger, { b: 2, c: 1 });
  // Iemand anders wijzigt de mand: stoppen.
  lines.a = 5;
  await assert.rejects(applyChange(shop, { cartId: 'c', before: { a: 1 }, target: { a: 2 } }, () => {}), { status: 409 });
});

test('geweigerde zoekopdracht bij geldige sessie: sessie blijft, berekening gaat door', async () => {
  let searches = 0;
  const cart = { id: 'c1', mts: 1, items: [], totalCount: 0, totalPrice: 0, selectedSlot: null };
  const fake = {
    cart: {
      getCart: async () => cart,
      getDeliverySlots: async () => ({ slots: [{ slotId: 's1', windowStart: '2026-11-12T16:00:00Z', windowEnd: '2026-11-12T18:00:00Z', cutOffTime: '2026-11-11T21:00:00Z', isAvailable: true, isSelected: true }], selectedSlot: null }),
    },
    catalog: { getSearchResults: async (q: string) => {
      if (++searches > 2) throw Object.assign(new Error('Forbidden'), { status: 403 });
      return { products: { sections: [{ products: [{ id: 'p-' + q, name: q, unitQuantity: '1 kilo', displayPrice: 199, isUnavailable: false }] }] } };
    } },
  };
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'k');
  let expired = 0;
  const picnic = new PicnicShop(secrets, () => fake as never);
  const app = new Weekmand({ store: new Store(':memory:'), secrets, picnic, now: () => Date.parse('2026-11-10T09:00:00Z') });
  picnic.onExpired = () => { expired++; };
  app.searchPause = 0;
  app.setShopMode('picnic');
  await app.setMeal({ date: '2026-11-12', recipeId: 'chili-con-carne', servings: 2 });
  const plan = await app.plan();
  assert.equal(picnic.status, 'connected');
  assert.equal(expired, 0);
  assert.ok(app.links().length >= 1);
  assert.ok(plan.missing.length > 0, 'niet-gekoppelde ingrediënten worden gemeld');
  // Een losse geweigerde zoekopdracht geeft een tijdelijke fout, geen verlopen sessie.
  await assert.rejects(app.searchProducts('melk'), { status: 503 });
  assert.equal(picnic.status, 'connected');
});

test('bezorgmoment kiezen zet het moment ook in de Picnic-mand', async () => {
  const set: string[] = [];
  const fake = { cart: {
    getCart: async () => ({ id: 'c1', mts: 1, items: [], totalCount: 0, totalPrice: 0, selectedSlot: null }),
    getDeliverySlots: async () => ({ selectedSlot: null, slots: [
      { slotId: 'zo', windowStart: '2026-11-15T16:00:00Z', windowEnd: '2026-11-15T17:00:00Z', cutOffTime: '2026-11-14T21:00:00Z', isAvailable: true, isSelected: false },
      { slotId: 'za', windowStart: '2026-11-14T08:00:00Z', windowEnd: '2026-11-14T09:00:00Z', cutOffTime: '2026-11-13T21:00:00Z', isAvailable: true, isSelected: false },
    ] }),
    setDeliverySlot: async (id: string) => { set.push(id); },
  } };
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'k');
  const picnic = new PicnicShop(secrets, () => fake as never);
  const app = new Weekmand({ store: new Store(':memory:'), secrets, picnic, now: () => Date.parse('2026-11-10T09:00:00Z') });
  app.setShopMode('picnic');
  const r = await app.chooseDelivery({ slotId: 'za' });
  assert.deepEqual(set, ['za']);
  assert.equal(r.planned, '2026-11-14');
  assert.equal((await app.delivery()).next?.id, 'za');
  const { handleMcp } = await import('../src/mcp.ts');
  const reply = await handleMcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_delivery', arguments: { day: 'zondag' } } }) as any;
  assert.equal(JSON.parse(reply.result.content[0].text).slot.id, 'zo');
});

test('maatvarianten: 800 g in de aanbieding vervangt 2× 400 g in de mand', async () => {
  const cartLines: Record<string, number> = {};
  const raw = () => ({ id: 'c1', mts: 1, totalCount: 0, totalPrice: 0, selectedSlot: null,
    items: Object.entries(cartLines).filter(([, q]) => q > 0).map(([id, q]) => ({ productId: id, name: id === 'kd400' ? 'Kippendijfilet 400 g' : 'Kippendijfilet 800 g', unitQuantity: id === 'kd400' ? '400 gram' : '800 gram', quantity: q, displayPrice: (id === 'kd400' ? 449 : 699) * q, isUnavailable: false })) });
  let promo = false;
  const fake = {
    cart: {
      getCart: async () => raw(),
      getDeliverySlots: async () => ({ selectedSlot: null, slots: [{ slotId: 's', windowStart: '2026-11-14T08:00:00Z', windowEnd: '2026-11-14T09:00:00Z', cutOffTime: '2026-11-13T21:00:00Z', isAvailable: true, isSelected: true }] }),
      addProductToCart: async (id: string, n: number) => { cartLines[id] = (cartLines[id] ?? 0) + n; return raw(); },
      removeProductFromCart: async (id: string, n: number) => { cartLines[id] -= n; return raw(); },
    },
    catalog: { getSearchResults: async () => ({ products: { sections: [{ products: [
      { id: 'kd400', name: 'Kippendijfilet 400 g', unitQuantity: '400 gram', displayPrice: 449, isUnavailable: false },
      { id: 'kd800', name: 'Kippendijfilet 800 g', unitQuantity: '800 gram', displayPrice: promo ? 699 : 949, isUnavailable: false, labels: promo ? [{ type: 'PROMO', text: 'Actie' }] : [] },
      { id: 'kip', name: 'Kipfilet 600 g', unitQuantity: '600 gram', displayPrice: 599, isUnavailable: false },
    ] }] } }) },
  };
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'k');
  const picnic = new PicnicShop(secrets, () => fake as never);
  const clock = { now: Date.parse('2026-11-10T09:00:00Z') };
  const app = new Weekmand({ store: new Store(':memory:'), secrets, picnic, now: () => clock.now });
  app.searchPause = 0;
  app.setShopMode('picnic');
  // Een recept met 400 g kippendij per persoon, voor 2 personen = 800 g.
  const recipe = app.catalog.addRecipe({ name: 'Kippendij uit de pan', ingredients: [{ name: 'kippendijfilet', amount: 400, unit: 'g' }] }, 'user');
  await app.setMeal({ date: '2026-11-14', recipeId: recipe.id, servings: 2 });
  const first = await app.plan();
  assert.deepEqual(first.lines.filter(l => l.add).map(l => [l.productId, l.add]), [['kd400', 2]], 'zonder actie: 2× 400 g');
  assert.deepEqual(app.variants(app.catalog.resolve('kippendijfilet')!.key).map(v => v.id).sort(), ['kd400', 'kd800']);
  await app.applyPlan(first.id);
  assert.deepEqual(cartLines, { kd400: 2 });
  // Een dag later: 800 g is in de aanbieding. Weekmand ververst de prijs en ruilt om.
  promo = true;
  clock.now += 26 * 36e5;
  assert.ok(await app.refreshPrices() > 0, 'achtergrondtaak ververst de prijzen');
  const second = await app.currentPlan();
  assert.deepEqual(second.lines.filter(l => l.add || l.remove).map(l => [l.productId, l.add, l.remove]).sort(), [['kd400', 0, 2], ['kd800', 1, 0]]);
  await app.applyPlan(second.id);
  assert.deepEqual(cartLines, { kd400: 0, kd800: 1 });
});

test('Picnic-recepten: bewaard, besteld en in de mand worden Weekmand-recepten', async () => {
  const { neededAmount } = await import('../src/picnic-recipes.ts');
  assert.deepEqual(neededAmount('(150 g nodig)'), { amount: 150, unit: 'g' });
  assert.deepEqual(neededAmount('(2 stuks nodig)'), { amount: 2, unit: 'st' });
  assert.equal(neededAmount(null), null);

  const summary = (id: string, name: string) => ({ id, name, imageType: null, imageId: null, subtitle: null, tags: ['25 min', 'Vegetarisch'], cookingTimeMinutes: 25 });
  const ing = (name: string, sellingUnitId: string, unitQuantity: string, neededText: string | null, type = 'CORE') => ({
    ingredientId: name, name, sellingUnitId, quantity: 1, status: 'ACTIVE', swapType: null, checked: true, type, isAvailable: true, unavailableReason: null,
    brand: null, imageId: null, unitQuantity, neededText, price: 199, originalPrice: null, priceRanges: null, promotionLabel: null, allergens: { contains: [], mayContain: [] },
  });
  const details: Record<string, unknown> = {
    r1: { id: 'r1', name: 'Romige pasta met spinazie', portions: 2, defaultPortions: 2, ingredients: [ing('Penne', 'p-penne', '500 gram', '(250 g nodig)'), ing('Spinazie', 'p-spin', '300 gram', null), ing('Zout', 'p-zout', '500 gram', null, 'CUPBOARD')], steps: ['Kook de **penne**.', 'Roer de spinazie erdoor.'], cookingTimeMinutes: 20, tag: null, description: null },
    r2: { id: 'r2', name: 'Picnic curry', portions: 4, defaultPortions: 4, ingredients: [ing('Kokosmelk', 'p-kokos', '400 ml', '(400 ml nodig)')], steps: [], cookingTimeMinutes: 30, tag: null, description: 'Curry' },
    r9: { id: 'r9', name: 'Uit de mand', portions: 2, defaultPortions: 2, ingredients: [ing('Rode linzen', 'p-linzen', '400 gram', '(150 g nodig)')], steps: [], cookingTimeMinutes: 25, tag: null, description: null },
  };
  let detailCalls = 0;
  const fake = {
    cart: { getCart: async () => ({ id: 'c1', mts: 1, items: [], totalCount: 0, totalPrice: 0, selectedSlot: null, recipes: [{ id: 'r9', title: 'Uit de mand' }] }), getDeliverySlots: async () => ({ slots: [], selectedSlot: null }) },
    recipe: {
      getSavedRecipes: async () => [summary('r1', 'Romige pasta met spinazie')],
      getUserDefinedRecipes: async () => [],
      getRecipeOverview: async () => ({ categorySections: [], sections: [{ title: 'Eerder besteld', pill: null, recipes: [summary('r2', 'Picnic curry')] }, { title: 'Uitgelicht deze week', pill: null, recipes: [summary('r3', 'Nieuw')] }] }),
      getRecipe: async (id: string) => { detailCalls++; return details[id]; },
    },
  };
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'k');
  const picnic = new PicnicShop(secrets, () => fake as never);
  const app = new Weekmand({ store: new Store(':memory:'), secrets, picnic, now: () => Date.parse('2026-11-10T09:00:00Z') });
  app.searchPause = 0;
  app.setShopMode('picnic');
  await app.cart(); // r9 zit in de mand en telt daarna als besteld
  const result = await app.importPicnicRecipes();
  assert.deepEqual([result.found, result.added], [3, 3]);
  assert.deepEqual(result.orderedLists, ['Eerder besteld']);
  const list = app.picnicRecipes();
  assert.deepEqual(list.map(r => [r.name, r.labels.join(',')]), [['Picnic curry', 'besteld'], ['Romige pasta met spinazie', 'bewaard'], ['Uit de mand', 'besteld']]);
  const pasta = app.catalog.recipe(list[1].id)!;
  assert.equal(pasta.source, 'picnic');
  assert.ok(pasta.tags.includes('vegetarisch') && pasta.tags.includes('bewaard'));
  const penne = pasta.ingredients.find(i => app.catalog.ingredient(i.key)!.name.toLowerCase().includes('penne'))!;
  assert.equal(penne.amount, 125, '250 g voor 2 porties = 125 g per persoon');
  assert.ok(!pasta.ingredients.some(i => i.key === 'zout'), 'kastvoorraad niet mee');
  assert.match(pasta.steps, /1\. Kook de penne\./);
  assert.equal(app.store.link(penne.key)?.productId, 'p-penne', 'Picnic-product uit het recept wordt de koppeling');
  // Nogmaals ophalen haalt niets dubbel op.
  const calls = detailCalls;
  assert.equal((await app.importPicnicRecipes()).added, 0);
  assert.equal(detailCalls, calls);
});
