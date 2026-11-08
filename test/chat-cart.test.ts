import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Weekmand } from '../src/app.ts';
import { Assistant } from '../src/assistant.ts';
import { guessCategory } from '../src/catalog.ts';
import { Store } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { PicnicShop } from '../src/shop.ts';
import { runTool } from '../src/tools.ts';
import { makeApp } from './helpers.ts';

/** Nep-Picnic met kippenpoten, zoals in het gesprek van 8 november. */
function picnicApp() {
  const cartLines: Record<string, number> = {};
  const products = [
    { id: 'kp650', name: 'Kippenpoten', unitQuantity: '650 gram', displayPrice: 469, isUnavailable: false },
    { id: 'kb1000', name: 'Kippenbouten', unitQuantity: '1 kilo', displayPrice: 699, isUnavailable: false },
    { id: 'kan40', name: 'Kaneel', unitQuantity: '40 gram', displayPrice: 179, isUnavailable: false },
  ];
  const searches: string[] = [];
  const raw = () => ({ id: 'c1', mts: 1, totalCount: 0, totalPrice: 0, selectedSlot: null,
    items: Object.entries(cartLines).filter(([, q]) => q > 0).map(([id, q]) => { const p = products.find(x => x.id === id)!; return { productId: id, name: p.name, unitQuantity: p.unitQuantity, quantity: q, displayPrice: p.displayPrice * q, isUnavailable: false }; }) });
  const fake = {
    cart: {
      getCart: async () => raw(),
      getDeliverySlots: async () => ({ selectedSlot: null, slots: [{ slotId: 's', windowStart: '2026-11-14T08:00:00Z', windowEnd: '2026-11-14T09:00:00Z', cutOffTime: '2026-11-13T21:00:00Z', isAvailable: true, isSelected: true }] }),
      addProductToCart: async (id: string, n: number) => { cartLines[id] = (cartLines[id] ?? 0) + n; return raw(); },
      removeProductFromCart: async (id: string, n: number) => { cartLines[id] -= n; return raw(); },
    },
    // Picnic vindt op "kippenpoten", niet op "kippenpoten 650 g" (zoals echt gebeurde).
    catalog: { getSearchResults: async (q: string) => { searches.push(q); const t = q.toLowerCase(); return { products: { sections: [{ products: /\d/.test(t) ? [] : products.filter(p => t.split(' ').some(w => w.length > 3 && p.name.toLowerCase().includes(w))) }] } }; } },
  };
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'k');
  const picnic = new PicnicShop(secrets, () => fake as never);
  const app = new Weekmand({ store: new Store(':memory:'), secrets, picnic, now: () => Date.parse('2026-11-10T09:00:00Z') });
  app.searchPause = 0;
  app.setShopMode('picnic');
  return { app, searches, cartLines };
}

test('categorie schatten: kip is vlees, en een kiprecept is niet vegetarisch', () => {
  assert.equal(guessCategory('Kippenbout groot'), 'vlees');
  assert.equal(guessCategory('Tijmblaadjes gedroogd'), 'kruiden-sauzen');
  assert.equal(guessCategory('Kipkruidenmix tandoori'), 'kruiden-sauzen', 'kruiden gaan voor kip');
  assert.equal(guessCategory('Pindakaas'), 'groente-fruit', 'geen kaas');
  const { app } = makeApp();
  const recipe = app.catalog.addRecipe({ name: 'Luxe kippenbouten', ingredients: [{ name: 'grote kippenbout', amount: 1, unit: 'st' }, { name: 'rozemarijn', amount: 2, unit: 'g' }] }, 'ai');
  assert.ok(!recipe.tags.includes('vegetarisch'));

  // Oude gegevens: ingrediënt als "groente-fruit" opgeslagen en recept als vegetarisch: eenmalig rechtgezet.
  const store = new Store(':memory:');
  store.saveIngredient({ key: 'kippenbout-groot', name: 'Kippenbout groot', unit: 'st', category: 'groente-fruit', query: 'kippenbout groot', packs: [] } as never);
  store.saveRecipe({ id: 'kip-luxe', name: 'Kip luxe', tags: ['vegetarisch'], minutes: 30, steps: '', source: 'ai', ingredients: [{ key: 'kippenbout-groot', amount: 1, unit: 'st' }] } as never);
  const fresh = new Weekmand({ store, secrets: new Secrets(null) });
  assert.equal(fresh.catalog.ingredient('kippenbout-groot')!.category, 'vlees');
  assert.deepEqual(fresh.catalog.recipe('kip-luxe')!.tags, []);
  assert.equal(store.get('categoriesFixed1', false), true, 'maar één keer');
});

test('chat-tools: een ingrediënt zonder product koppelen, en een gekozen product toevoegen', async () => {
  const { app, searches } = picnicApp();
  const ctx = { channel: 'chat' as const, pendingReview: (id: string) => { review = id; } };
  let review = '';
  await runTool(app, 'set_meal', { day: '2026-11-15', servings: 2, recipe: { name: 'Luxe geroosterde kippenbouten', ingredients: [{ name: 'Kippenbout groot', amount: 1, unit: 'st', category: 'vlees' }] } }, ctx);
  const before = await runTool(app, 'add_to_cart', {}, ctx) as any;
  assert.deepEqual(before.missing_products.map((m: string) => m.split(':')[0]), ['Kippenbout groot']);

  // De AI zoekt, de gebruiker kiest "Kippenpoten 650 g": koppelen met het id, 3 stuks per verpakking.
  const found = await runTool(app, 'search_products', { query: 'kippenpoten' }, ctx) as any[];
  assert.equal(found[0].id, 'kp650');
  await assert.rejects(runTool(app, 'link_product', { ingredient: 'Kippenbout groot', product_id: 'kp650' }, ctx), /per_pack/);
  const linked = await runTool(app, 'link_product', { ingredient: 'Kippenbout groot', product_id: 'kp650', per_pack: 3 }, ctx) as any;
  assert.equal(linked.linked, 'Kippenpoten (650 gram) voor Kippenbout groot');
  assert.deepEqual(linked.missing_products, []);
  assert.ok(linked.changes.some((c: any) => c.product === 'Kippenpoten' && c.add === 1), 'kip zit nu in de mand');
  assert.equal(review, linked.review_id);

  // Een extra product op naam met maat ("Kaneel 40 g") vindt Picnic niet; zonder maat wel.
  const added = await runTool(app, 'add_to_cart', { items: [{ name: 'Kaneel 40 g' }] }, ctx) as any;
  assert.deepEqual(added.added, ['1× Kaneel']);
  assert.ok(searches.includes('kaneel'));
  // Met het id uit search_products, ook als het niet meer in het geheugen staat (na een herstart).
  const again = await runTool(app, 'add_to_cart', { items: [{ name: 'Kippenbouten 1 kg', product_id: 'kb1000' }] }, ctx) as any;
  assert.deepEqual(again.added, ['1× Kippenbouten']);
});

test('chat: "naar picnic sturen" getypt toont wat echt klaarstaat, met de knop', async t => {
  const { app } = makeApp();
  await app.proposeMenu();
  const assistant = new Assistant(app);
  const r = await assistant.chat('t', 'Naar picnic sturen');
  assert.match(r.reply, /^Dit gaat naar Picnic:\n\+\d/);
  assert.match(r.reply, /Druk op "Naar Picnic sturen"/);
  assert.equal(r.reviewId, (await app.currentPlan()).id, 'knoppen voor de echte berekening');

  // Met een AI die beweert iets te hebben toegevoegd zonder tool: de echte stand komt erbij, met de knop.
  process.env.AI_PROVIDER = 'mistral';
  process.env.AI_API_KEY = 'test-key-123';
  t.after(() => { delete process.env.AI_PROVIDER; delete process.env.AI_API_KEY; });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ choices: [{ message: { role: 'assistant', content: 'Ik heb kaneel weer toegevoegd. Druk op Naar Picnic sturen.' } }] }); });
  const ai = await assistant.chat('t', 'zet kaneel erbij');
  assert.equal(calls, 1);
  assert.match(ai.reply, /Ik heb kaneel weer toegevoegd[\s\S]*Dit gaat naar Picnic:/);
  assert.ok(ai.reviewId);
  // Getypte goedkeuring gaat niet naar de AI.
  await assistant.chat('t', 'stuur maar');
  assert.equal(calls, 1);
});
