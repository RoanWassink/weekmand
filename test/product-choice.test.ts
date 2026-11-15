import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Weekmand } from '../src/app.ts';
import type { LinkReview, ProductChoice } from '../src/app.ts';
import { Store } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { PicnicShop } from '../src/shop.ts';

// Wat Picnic op de router echt teruggaf voor "roerbakgroenten diepvries" (15-11), ingekort.
const products: Record<string, { name: string; unitQuantity: string; cents: number }> = {
  holl: { name: 'Hollandse roerbak', unitQuantity: '400 gram', cents: 259 },
  ital: { name: 'Italiaanse wokmix', unitQuantity: '450 gram', cents: 159 },
  holl2: { name: 'Hollandse roerbak', unitQuantity: '600 gram', cents: 349 },
  chin: { name: 'Chinese wokmix', unitQuantity: '400 gram', cents: 203 },
  bn: { name: 'Bami & nasi mix', unitQuantity: '450 gram', cents: 189 },
  gele: { name: 'Gele wortel-nasi', unitQuantity: '400 gram', cents: 179 },
};
const searchResults: Record<string, string[]> = {
  'roerbakgroenten diepvries': ['holl', 'ital', 'holl2', 'chin'],
  'bami nasi groente': ['bn', 'gele'],
};

function makePicnicApp() {
  const searches: string[] = [];
  const fake = {
    cart: {
      getCart: async () => ({ id: 'c', mts: 1, totalCount: 0, totalPrice: 0, selectedSlot: null, items: [] }),
      getDeliverySlots: async () => ({ selectedSlot: null, slots: [{ slotId: 's', windowStart: '2026-11-14T13:30:00Z', windowEnd: '2026-11-14T15:30:00Z', cutOffTime: '2026-11-13T22:00:00Z', isAvailable: true, isSelected: true }] }),
    },
    catalog: {
      getSearchResults: async (query: string) => {
        searches.push(query);
        const ids = searchResults[query] ?? [];
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
  return { app, searches };
}

async function nasiMeal(app: Weekmand) {
  const recipe = app.catalog.addRecipe({ name: 'Nasi met kip', ingredients: [{ name: 'roerbakgroenten', amount: 150, unit: 'g' }] }, 'user');
  await app.setMeal({ date: '2026-11-14', recipeId: recipe.id, servings: 2 });
}

test('lastige productkeuze: de AI weegt af met de gerechten erbij, geen Hollandse roerbak voor nasi', async () => {
  const { app } = makePicnicApp();
  const asked: ProductChoice[][] = [];
  app.productChooser = async asks => { asked.push(asks); return [{ key: 'wokgroente', productId: 'chin', reason: 'Past bij nasi.' }]; };
  await nasiMeal(app);
  await app.plan();
  assert.equal(asked.length, 1, 'één aanroep voor alle lastige keuzes');
  const ask = asked[0][0];
  assert.equal(ask.key, 'wokgroente');
  assert.ok(ask.recipes.includes('Nasi met kip'), 'de AI ziet in welk gerecht het gaat');
  assert.deepEqual(ask.candidates.map(c => c.name), ['Hollandse roerbak', 'Italiaanse wokmix', 'Chinese wokmix'], 'elke soort één keer; de maat regelt Weekmand');
  assert.equal(app.store.link('wokgroente')?.productId, 'chin');
  assert.equal(app.store.link('wokgroente')?.auto, true);
  assert.equal(app.linkReviewDue(), false, 'door de AI gekozen: hoeft niet nog eens nagekeken');
});

test('lastige productkeuze: past niets, dan geen product (het huishouden kiest), en zonder AI het eerste passende', async () => {
  let { app } = makePicnicApp();
  app.productChooser = async () => [{ key: 'wokgroente', productId: null, reason: 'Geen Aziatische mix.' }];
  await nasiMeal(app);
  let plan = await app.plan();
  assert.equal(app.store.link('wokgroente'), null);
  assert.ok(plan.missing.some(m => m.key === 'wokgroente'), 'het voorstel meldt dat er geen product is');

  ({ app } = makePicnicApp());
  app.productChooser = async () => null; // AI niet bereikbaar
  await nasiMeal(app);
  await app.plan();
  assert.equal(app.store.link('wokgroente')?.productId, 'holl', 'zoals voorheen: het eerste passende');

  ({ app } = makePicnicApp());
  await nasiMeal(app);
  plan = await app.plan();
  assert.equal(app.store.link('wokgroente')?.productId, 'holl', 'zonder AI ook');
});

test('nasi en bami hebben eigen bami- en nasigroente; precies dat product hoeft niet afgewogen', async () => {
  const { app, searches } = makePicnicApp();
  let asked = 0;
  app.productChooser = async () => { asked++; return null; };
  assert.ok(app.catalog.recipe('nasi-kippendij')!.ingredients.some(i => i.key === 'nasi-groente'));
  assert.ok(app.catalog.recipe('bami-kip')!.ingredients.some(i => i.key === 'nasi-groente'));
  assert.equal(app.catalog.resolve('Bami & nasi mix')?.key, 'nasi-groente');
  const recipe = app.catalog.addRecipe({ name: 'Bami', ingredients: [{ name: 'nasigroente', amount: 120, unit: 'g' }] }, 'user');
  await app.setMeal({ date: '2026-11-14', recipeId: recipe.id, servings: 2 });
  await app.plan();
  assert.ok(searches.includes('bami nasi groente'));
  assert.equal(app.store.link('nasi-groente')?.productId, 'bn');
  assert.equal(asked, 0);
});

test('nakijken: een slecht automatisch product wordt afgekeurd en met de AI opnieuw gekozen; zelf gekozen blijft', async () => {
  const { app } = makePicnicApp();
  await nasiMeal(app);
  // Zo stond het op de router sinds 7 november.
  app.store.saveLink({ key: 'wokgroente', productId: 'holl', name: 'Hollandse roerbak', unitQuantity: '400 gram', packAmount: 400, cents: 259, auto: true, updatedAt: '2026-11-07T18:06:49Z' });
  app.store.saveLink({ key: 'paprika', productId: 'p', name: "Puntpaprika's", unitQuantity: '3 stuks', packAmount: 3, cents: 199, auto: false, updatedAt: '2026-11-10T10:00:00Z' });
  assert.equal(app.linkReviewDue(), false, 'zonder AI niets na te kijken');

  const reviewed: LinkReview[][] = [];
  app.linkReviewer = async links => { reviewed.push(links); return links.map(l => ({ key: l.key, fits: l.key !== 'wokgroente', reason: l.key === 'wokgroente' ? 'Hollands past niet bij nasi.' : 'Prima.' })); };
  assert.equal(app.linkReviewDue(), true);
  const result = await app.reviewLinks();
  assert.deepEqual(reviewed[0].map(l => [l.key, l.product]), [['wokgroente', 'Hollandse roerbak']], 'alleen automatisch gekozen producten');
  assert.ok(reviewed[0][0].recipes.includes('Nasi met kip'));
  assert.deepEqual(result.rejected, ['Roerbakgroenten: Hollandse roerbak']);
  assert.equal(app.linkReviewDue(), false, 'één keer per product');

  // Zonder antwoord van de AI blijft het afgekeurde product staan (liever iets dan niets bij een storing).
  app.productChooser = async () => null;
  await app.plan();
  assert.equal(app.store.link('wokgroente')?.productId, 'holl');

  // Volgende dag met AI: opnieuw kiezen, zonder Hollandse roerbak (ook niet in een andere maat).
  const asked: ProductChoice[][] = [];
  app.productChooser = async asks => { asked.push(asks); return [{ key: 'wokgroente', productId: 'chin', reason: 'Aziatisch.' }]; };
  app.store.set('linkMisses', {});
  await app.plan();
  assert.equal(asked[0][0].rejected, 'Hollandse roerbak');
  assert.deepEqual(asked[0][0].candidates.map(c => c.id), ['ital', 'chin']);
  assert.equal(app.store.link('wokgroente')?.productId, 'chin');
  assert.ok(!app.variants('wokgroente').some(v => v.name === 'Hollandse roerbak'));
  assert.equal(app.store.link('paprika')?.productId, 'p', 'zelf gekozen blijft staan');
});
