import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Weekmand } from '../src/app.ts';
import { Store } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { PicnicShop } from '../src/shop.ts';
import { makeApp } from './helpers.ts';

test('paprika om te vullen: geen puntpaprika, ook een oude automatische koppeling wordt vervangen', async () => {
  const products: Record<string, { name: string; unitQuantity: string; cents: number }> = {
    punt: { name: "Puntpaprika's", unitQuantity: '2-3 stuks', cents: 199 },
    rood: { name: 'Rode paprika', unitQuantity: '1 stuk', cents: 129 },
    mix: { name: 'Paprika mix', unitQuantity: '3 stuks', cents: 219 },
  };
  const searches: string[] = [];
  const fake = {
    cart: {
      getCart: async () => ({ id: 'c', mts: 1, totalCount: 0, totalPrice: 0, selectedSlot: null, items: [] }),
      getDeliverySlots: async () => ({ selectedSlot: null, slots: [{ slotId: 's', windowStart: '2026-11-14T13:30:00Z', windowEnd: '2026-11-14T15:30:00Z', cutOffTime: '2026-11-13T22:00:00Z', isAvailable: true, isSelected: true }] }),
    },
    catalog: {
      getSearchResults: async (query: string) => {
        searches.push(query);
        // Picnic zet de puntpaprika's soms bovenaan.
        const ids = query === 'paprika' ? ['punt', 'rood', 'mix'] : [];
        return { products: { sections: [{ products: ids.map(id => ({ id, ...products[id], displayPrice: products[id].cents, isUnavailable: false })) }] } };
      },
    },
    delivery: { getDeliverySummaries: async () => [] },
  };
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'k');
  const app = new Weekmand({ store: new Store(':memory:'), secrets, picnic: new PicnicShop(secrets, () => fake as never), now: () => Date.parse('2026-11-12T18:00:00Z') });
  app.searchPause = 0;
  app.setShopMode('picnic');
  const recipe = app.catalog.addRecipe({ name: 'Gevulde paprika', ingredients: [{ name: 'paprika', amount: 1, unit: 'st' }] }, 'user');
  await app.setMeal({ date: '2026-11-14', recipeId: recipe.id, servings: 2 });
  // Zo stond het op de router: automatisch gekoppeld aan puntpaprika's.
  app.store.saveLink({ key: 'paprika', productId: 'punt', name: "Puntpaprika's", unitQuantity: '2-3 stuks', packAmount: 3, cents: 199, auto: true, updatedAt: '2026-11-08T10:00:00Z' });
  const plan = await app.plan();
  assert.equal(app.store.link('paprika')?.productId, 'rood', 'opnieuw gekoppeld aan gewone paprika');
  assert.deepEqual(plan.lines.filter(l => l.add).map(l => [l.productId, l.add]), [['rood', 2]]);
  assert.ok(!app.variants('paprika').some(v => v.id === 'punt'), 'puntpaprika ook niet als andere maat');
  assert.equal(app.catalog.resolve("Zoete puntpaprika's")?.key, 'puntpaprika', 'een eigen ingrediënt');
  // Zelf gekozen blijft staan, ook als het puntpaprika is.
  app.store.saveLink({ key: 'paprika', productId: 'punt', name: "Puntpaprika's", unitQuantity: '2-3 stuks', packAmount: 3, cents: 199, auto: false, updatedAt: '2026-11-12T10:00:00Z' });
  await app.plan();
  assert.equal(app.store.link('paprika')?.productId, 'punt');
});

test('mand: per regel bij welke gerechten en welke afdeling hij hoort, ook wat je zelf toevoegde', async () => {
  const { app } = makeApp();
  const w = await app.window();
  const pasta = app.catalog.addRecipe({ name: 'Pasta met kaas', ingredients: [{ name: 'penne', amount: 100, unit: 'g' }, { name: 'geraspte kaas', amount: 30, unit: 'g' }] }, 'user');
  const ovenschotel = app.catalog.addRecipe({ name: 'Ovenschotel', ingredients: [{ name: 'geraspte kaas', amount: 40, unit: 'g' }, { name: 'aardappelen', amount: 250, unit: 'g' }] }, 'user');
  await app.setMeal({ date: w.dates[0], recipeId: pasta.id, servings: 2 });
  await app.setMeal({ date: w.dates[1], recipeId: ovenschotel.id, servings: 2 });
  await app.applyPlan((await app.plan()).id);
  // Zelf nog iets in de mand gelegd dat bij een gerecht hoort, en iets wat nergens bij hoort.
  const penne = app.catalog.ingredient(app.catalog.resolve('penne')!.key)!;
  const melk = app.catalog.ingredient(app.catalog.resolve('melk')!.key)!;
  await app.shop.add(penne.packs[0].id, 1);
  await app.shop.add(melk.packs[0].id, 1);
  const cart = await app.cart(0);
  const line = (key: string) => cart.lines.find(l => l.ingredient === key)!;
  assert.deepEqual(line(penne.key).meals.map(m => m.name), ['Pasta met kaas']);
  assert.equal(line(penne.key).byWeekmand > 0 && line(penne.key).quantity > line(penne.key).byWeekmand, true, 'Weekmand en zelf: één regel');
  assert.deepEqual(line(app.catalog.resolve('geraspte kaas')!.key).meals.map(m => m.name), ['Pasta met kaas', 'Ovenschotel'], 'kaas is voor beide');
  assert.equal(line(app.catalog.resolve('geraspte kaas')!.key).category, 'zuivel');
  assert.deepEqual(line(melk.key).meals, [], 'melk hoort bij geen gerecht');
  assert.ok(cart.categories.some(c => c.key === 'zuivel' && c.label));
});
