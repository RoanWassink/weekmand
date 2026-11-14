import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutoffNotice } from '../src/actions.ts';
import { Weekmand } from '../src/app.ts';
import { Store } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { PicnicShop } from '../src/shop.ts';

// Bezorging za 14 nov 14:30, wijzigen kan tot vr 13 nov 23:00 (Nederlandse tijd).
const slot = { slotId: 'za14', windowStart: '2026-11-14T13:30:00Z', windowEnd: '2026-11-14T15:30:00Z', cutOffTime: '2026-11-13T22:00:00Z', isAvailable: true, isSelected: true };
const products: Record<string, { name: string; unitQuantity: string; cents: number }> = {
  kd400: { name: 'Kippendijfilet 400 g', unitQuantity: '400 gram', cents: 449 },
  kom: { name: 'Komkommer', unitQuantity: '1 stuk', cents: 89 },
};
const item = (id: string, quantity: number) => ({ productId: id, name: products[id].name, unitQuantity: products[id].unitQuantity, quantity, displayPrice: products[id].cents * quantity, isUnavailable: false });

function fakePicnic() {
  const state = {
    cart: {} as Record<string, number>,
    placed: [] as { id: string; items: ReturnType<typeof item>[] }[],
    summaryCalls: 0, deliveryCalls: 0,
  };
  const raw = () => {
    const items = Object.entries(state.cart).filter(([, q]) => q > 0).map(([id, q]) => item(id, q));
    return { id: 'shopping_cart', mts: 1, totalCount: 0, totalPrice: items.reduce((s, i) => s + i.displayPrice, 0), selectedSlot: null, items };
  };
  const total = (items: ReturnType<typeof item>[]) => items.reduce((s, i) => s + i.displayPrice, 0);
  const fake = {
    cart: {
      getCart: async () => raw(),
      getDeliverySlots: async () => ({ selectedSlot: { slotId: slot.slotId }, slots: [slot] }),
      addProductToCart: async (id: string, n: number) => { state.cart[id] = (state.cart[id] ?? 0) + n; return raw(); },
      removeProductFromCart: async (id: string, n: number) => { state.cart[id] -= n; return raw(); },
    },
    catalog: {
      getSearchResults: async (query: string) => ({ products: { sections: [{ products: Object.entries(products)
        .filter(([, p]) => p.name.toLowerCase().includes(query.toLowerCase().split(' ')[0].slice(0, 5)))
        .map(([id, p]) => ({ id, name: p.name, unitQuantity: p.unitQuantity, displayPrice: p.cents, isUnavailable: false })) }] } }),
    },
    delivery: {
      getDeliverySummaries: async () => {
        state.summaryCalls++;
        return state.placed.map(d => ({ id: d.id, status: 'CURRENT', creationTime: '2026-11-12T19:02:06Z', windowStart: slot.windowStart, windowEnd: slot.windowEnd, orderCount: 1, totalPrice: total(d.items), itemCount: 0 }));
      },
      getDelivery: async (id: string) => {
        state.deliveryCalls++;
        const d = state.placed.find(p => p.id === id)!;
        return { id, status: 'CURRENT', creationTime: '2026-11-12T19:02:06Z', windowStart: slot.windowStart, windowEnd: slot.windowEnd, totalPrice: total(d.items),
          orders: [{ id: 'o1', status: 'CURRENT', creationTime: '2026-11-12T19:02:06Z', items: d.items, totalPrice: total(d.items) }] };
      },
    },
  };
  /** Afrekenen in de Picnic-app: de mand wordt een bestelling en is daarna leeg. */
  const checkout = () => {
    state.placed.push({ id: 'pvm1', items: Object.entries(state.cart).filter(([, q]) => q > 0).map(([id, q]) => item(id, q)) });
    state.cart = {};
  };
  return { fake, state, checkout };
}

test('na het afrekenen: de bestelling telt mee, de mand blijft leeg en de deadline-melding klopt', async () => {
  const { fake, state, checkout } = fakePicnic();
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'k');
  const picnic = new PicnicShop(secrets, () => fake as never);
  const clock = { now: Date.parse('2026-11-12T18:00:00Z') };
  const app = new Weekmand({ store: new Store(':memory:'), secrets, picnic, now: () => clock.now });
  app.searchPause = 0;
  app.setShopMode('picnic');
  const recipe = app.catalog.addRecipe({ name: 'Kippendij met komkommersalade', ingredients: [{ name: 'kippendijfilet', amount: 400, unit: 'g' }, { name: 'komkommer', amount: 0.5, unit: 'st' }] }, 'user');
  await app.setMeal({ date: '2026-11-14', recipeId: recipe.id, servings: 2 });

  const first = await app.plan();
  assert.deepEqual(first.lines.filter(l => l.add).map(l => [l.productId, l.add]).sort(), [['kd400', 2], ['kom', 1]]);
  assert.equal(first.placed, undefined, 'nog niets besteld');
  // Komkommer is er nog: weggeveegd. De rest gaat naar Picnic.
  app.declineLine('kom');
  const second = await app.plan();
  await app.applyPlan(second.id);
  assert.deepEqual(state.cart, { kd400: 2 });

  // Do 20:02 afgerekend in de Picnic-app; de mand is leeg.
  checkout();
  clock.now = Date.parse('2026-11-13T17:57:00Z');
  const after = await app.plan();
  assert.ok(after.placed, 'de geplaatste bestelling is gevonden');
  assert.deepEqual([after.placed.date, after.placed.totalCents, after.placed.count], ['2026-11-14', 898, 2]);
  assert.deepEqual(after.lines.filter(l => l.add || l.remove), [], 'niets opnieuw voorstellen: alles is besteld');
  assert.equal(after.totalCents, 0, 'de mand zelf blijft leeg');
  assert.deepEqual(app.order.declined, ['kom'], 'wegvegen geldt nog voor deze bestelling');
  assert.equal(app.order.placed, 'pvm1');

  // De melding vier uur voor de deadline: geen volle mand, geen knoppen.
  const notice = (await cutoffNotice(app))!;
  assert.match(notice.text, /is al geplaatst \(€\s?8,98, 2 producten\)/);
  assert.match(notice.text, /Alles voor het menu zit erin/);
  assert.equal(notice.buttons, undefined);
  assert.equal(state.deliveryCalls, 1, 'de regels van de bestelling één keer ophalen zolang hij niet verandert');

  // Iets vergeten: er komt nog een maaltijd bij. Alleen dat ontbreekt; doorsturen kan nog.
  const extra = app.catalog.addRecipe({ name: 'Kippendij uit de oven', ingredients: [{ name: 'kippendijfilet', amount: 200, unit: 'g' }] }, 'user');
  await app.setMeal({ date: '2026-11-15', recipeId: extra.id, servings: 2 });
  const missing = await app.plan();
  assert.deepEqual(missing.lines.filter(l => l.add).map(l => [l.productId, l.add]), [['kd400', 1]]);
  const { formatPlan } = await import('../src/assistant.ts');
  const { planSummary } = await import('../src/tools.ts');
  const text = formatPlan(planSummary(missing));
  assert.match(text, /^Al besteld voor zaterdag 2026-11-14: €\s?8,98 \(2 producten\)\.\nDit ontbreekt nog/);

  // Na de bezorging is de bestelling geen lopende meer: overslaan en wegvegen beginnen opnieuw.
  state.placed = [];
  clock.now = Date.parse('2026-11-15T09:00:00Z');
  const next = await app.plan();
  assert.equal(next.placed, undefined);
  assert.deepEqual(app.order, { extras: [], skip: [] });
});

test('vaste producten uit de bezorggeschiedenis krijgen een prijs (geen € 0,00 in het totaal)', async () => {
  const weeks = ['2026-10-17', '2026-10-24', '2026-10-31', '2026-11-07'];
  const fake = {
    cart: { getCart: async () => ({ id: 'c', mts: 1, items: [], totalCount: 0, totalPrice: 0, selectedSlot: null }), getDeliverySlots: async () => ({ slots: [], selectedSlot: null }) },
    delivery: {
      getDeliverySummaries: async () => weeks.map((d, i) => ({ id: 'd' + i, status: 'COMPLETED', creationTime: d, windowStart: d + 'T13:30:00Z', windowEnd: d + 'T15:30:00Z', orderCount: 1, totalPrice: 594, itemCount: 6 })),
      getDelivery: async (id: string) => {
        const d = weeks[Number(id.slice(1))];
        // De laatste week is melk duurder geworden: die prijs telt.
        const price = id === 'd3' ? 105 : 99;
        return { id, status: 'COMPLETED', creationTime: d, windowStart: d + 'T13:30:00Z', windowEnd: d + 'T15:30:00Z', totalPrice: 6 * price, promotionSavings: 0, membershipSavings: 0,
          orders: [{ id: 'o' + id, status: 'COMPLETED', creationTime: d + 'T10:00:00Z', checkoutTotalPrice: 6 * price, items: [{ productId: 'melk', name: 'Picnic volle melk houdbaar', unitQuantity: '1 liter', quantity: 6, displayPrice: 6 * price }] }] };
      },
    },
  };
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'k');
  const picnic = new PicnicShop(secrets, () => fake as never);
  const store = new Store(':memory:');
  // Al eerder afgeleid, toen nog zonder prijs.
  store.set('regulars', [{ productId: 'melk', name: 'Picnic volle melk houdbaar', unitQuantity: '1 liter', cents: 0, quantity: 6, enabled: true }]);
  const app = new Weekmand({ store, secrets, picnic, now: () => Date.parse('2026-11-12T18:00:00Z') });
  app.setShopMode('picnic');
  await app.importHistory();
  assert.equal(app.regulars().find(r => r.productId === 'melk')!.cents, 105);
});

test('na de deadline van een bestelde bezorging plant Weekmand dezelfde dag een week later', async () => {
  const { fake, checkout } = fakePicnic();
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'k');
  const picnic = new PicnicShop(secrets, () => fake as never);
  const clock = { now: Date.parse('2026-11-12T18:00:00Z') };
  const app = new Weekmand({ store: new Store(':memory:'), secrets, picnic, now: () => clock.now });
  app.searchPause = 0;
  app.setShopMode('picnic');
  await app.chooseDelivery({ slotId: 'za14' });
  const recipe = app.catalog.addRecipe({ name: 'Kippendij uit de pan', ingredients: [{ name: 'kippendijfilet', amount: 400, unit: 'g' }] }, 'user');
  await app.setMeal({ date: '2026-11-14', recipeId: recipe.id, servings: 2 });
  await app.applyPlan((await app.plan()).id);
  checkout();
  await app.plan(); // ziet de geplaatste bestelling

  // Vóór de deadline: nog steeds zaterdag 14 (aanvullen kan).
  clock.now = Date.parse('2026-11-13T21:00:00Z');
  assert.equal((await app.delivery()).planned, '2026-11-14');
  // Na de deadline (vr 23:00): door naar zaterdag 21, zelfde tijd; de bestelde week blijft staan.
  clock.now = Date.parse('2026-11-13T22:30:00Z');
  const d = await app.delivery();
  assert.equal(d.planned, '2026-11-21');
  assert.equal(app.deliveryChoice?.time, '14:30');
  const w = await app.window();
  assert.equal(w.start, '2026-11-21');
  assert.equal(app.store.meal('2026-11-14')?.recipeId, recipe.id, 'de bestelde maaltijd blijft in de geschiedenis');
  const menu = await app.proposeMenu({ ai: false });
  const proposed = menu.days.filter(x => x.meal?.status === 'proposed');
  assert.equal(proposed.length, app.household.days);
  assert.ok(proposed.every(x => x.date >= '2026-11-21' && x.inOrder), 'nieuwe voorstellen gaan naar de volgende week');
  assert.equal(menu.days.some(x => x.date === '2026-11-14'), false, 'de bestelde dag staat niet meer bij het plannen');
  assert.deepEqual(menu.thisWeek.map(x => [x.date, x.ordered, x.meal.name]), [['2026-11-14', true, 'Kippendij uit de pan']], 'maar wel onder Recepten → Deze week');
  const { formatMenu } = await import('../src/assistant.ts');
  assert.match(formatMenu(menu), /^Deze week \(besteld\):\nza 14-11: Kippendij uit de pan \(2 p\.\)\n\nVolgende bestelling:\nza 21-11: /);
  // Zelf de keuze wissen: Weekmand zet hem niet opnieuw.
  app.clearDeliveryChoice();
  await app.delivery();
  assert.equal(app.deliveryChoice, null);
});

test('zonder bestelling schuift de bezorgdag niet vanzelf door', async () => {
  const { fake } = fakePicnic();
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'k');
  const picnic = new PicnicShop(secrets, () => fake as never);
  const clock = { now: Date.parse('2026-11-12T18:00:00Z') };
  const app = new Weekmand({ store: new Store(':memory:'), secrets, picnic, now: () => clock.now });
  app.setShopMode('picnic');
  await app.chooseDelivery({ slotId: 'za14' });
  clock.now = Date.parse('2026-11-13T22:30:00Z');
  assert.equal((await app.delivery()).planned, '2026-11-14', 'niets besteld: jij kiest zelf een nieuwe dag');
});

test('kort na de bezorging haalt Weekmand hem op voor de voorraad', async () => {
  const { fake, checkout } = fakePicnic();
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'k');
  const picnic = new PicnicShop(secrets, () => fake as never);
  const clock = { now: Date.parse('2026-11-12T18:00:00Z') };
  const app = new Weekmand({ store: new Store(':memory:'), secrets, picnic, now: () => clock.now });
  app.setShopMode('picnic');
  checkout();
  await app.plan();
  assert.equal(app.deliveryImportDue(), false, 'nog niet bezorgd');
  clock.now = Date.parse('2026-11-14T15:50:00Z'); // venster tot 15:30Z
  assert.equal(app.deliveryImportDue(), true);
  app.store.set('appliedDeliveries', ['pvm1']);
  assert.equal(app.deliveryImportDue(), false, 'al bij de voorraad geteld');
});
