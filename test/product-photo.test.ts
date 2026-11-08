import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Weekmand } from '../src/app.ts';
import { Store } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { PicnicShop } from '../src/shop.ts';

/** Nep-Picnic met twee soorten slagroom: spuitbus en bekertje. */
function picnicApp(store = new Store(':memory:')) {
  const cartLines: Record<string, number> = { sp250: 1 };
  const products = [
    { id: 'sp250', name: 'Slagroom spuitbus', brand: 'Campina', unitQuantity: '250 ml', displayPrice: 299, unitPrice: '€11,96/l', imageId: 'aaaa1111bbbb2222', isUnavailable: false },
    { id: 'sb200', name: 'Slagroom', brand: 'Campina', unitQuantity: '200 ml', displayPrice: 189, unitPrice: '€9,45/l', imageId: 'cccc3333dddd4444', isUnavailable: false },
  ];
  let details = 0;
  const raw = () => ({ id: 'c1', totalPrice: 0, selectedSlot: null,
    items: Object.entries(cartLines).filter(([, q]) => q > 0).map(([id, q]) => { const p = products.find(x => x.id === id)!; return { productId: id, name: p.name, unitQuantity: p.unitQuantity, quantity: q, displayPrice: p.displayPrice * q, isUnavailable: false, imageId: p.imageId, basePrice: p.unitPrice }; }) });
  const fake = {
    cart: {
      getCart: async () => raw(),
      getDeliverySlots: async () => ({ selectedSlot: null, slots: [{ slotId: 's', windowStart: '2026-11-14T08:00:00Z', windowEnd: '2026-11-14T09:00:00Z', cutOffTime: '2026-11-13T21:00:00Z', isAvailable: true, isSelected: true }] }),
      addProductToCart: async (id: string, n: number) => { cartLines[id] = (cartLines[id] ?? 0) + n; return raw(); },
      removeProductFromCart: async (id: string, n: number) => { cartLines[id] -= n; return raw(); },
    },
    catalog: {
      getSearchResults: async (q: string) => ({ products: { sections: [{ products: q.toLowerCase().includes('slagroom') ? products : [] }] } }),
      getProduct: async (id: string) => {
        details++;
        const p = products.find(x => x.id === id);
        if (!p) throw Object.assign(new Error('Niet gevonden'), { status: 404 });
        return { ...p, imageIds: [p.imageId], description: '**Slagroom** in een *spuitbus*, [meer](https://example.com).', labels: [{ text: 'Biologisch' }] };
      },
    },
  };
  const secrets = new Secrets(null);
  secrets.set('picnicAuthKey', 'k');
  const app = new Weekmand({ store, secrets, picnic: new PicnicShop(secrets, () => fake as never), now: () => Date.parse('2026-11-10T09:00:00Z') });
  app.searchPause = 0;
  app.setShopMode('picnic');
  return { app, store, cartLines, details: () => details };
}

test("productfoto's: mand en zoeken geven foto en prijs per liter, ook na een herstart", async () => {
  const { app, store } = picnicApp();
  const cart = await app.cart();
  assert.equal(cart.lines[0].image, 'aaaa1111bbbb2222');
  assert.equal(cart.lines[0].unitPrice, '€11,96/l');
  const found = await app.searchProducts('slagroom');
  assert.deepEqual([found[1].image, found[1].brand, found[1].unitPrice], ['cccc3333dddd4444', 'Campina', '€9,45/l']);
  assert.equal(app.productImage('sb200'), 'cccc3333dddd4444');

  // Na een herstart weet Weekmand de foto's nog (voor het voorstel).
  const fresh = new Weekmand({ store, secrets: new Secrets(null) });
  assert.equal(fresh.productImage('sp250'), 'aaaa1111bbbb2222');
  assert.deepEqual(fresh.withImages({ lines: [{ productId: 'sb200' }, { productId: 'onbekend' }] }).lines,
    [{ productId: 'sb200', image: 'cccc3333dddd4444' }, { productId: 'onbekend' }]);
});

test('productvenster: merk, omschrijving en het ingrediënt waarvoor Weekmand het koopt', async () => {
  const { app, details } = picnicApp();
  const def = app.catalog.ensureIngredient('slagroom', 'ml');
  await app.searchProducts('slagroom');
  app.linkProduct(def.name, 'sb200');

  const info = await app.productInfo('sb200') as any;
  assert.equal(info.key, def.key);
  assert.equal(info.brand, 'Campina');
  assert.equal(info.description, 'Slagroom in een spuitbus, meer.', 'zonder markdown');
  assert.deepEqual(info.labels, ['Biologisch']);
  assert.equal(info.image, 'cccc3333dddd4444');
  await app.productInfo('sb200');
  assert.equal(details(), 1, 'de productpagina wordt een uur onthouden');
  // Kan Picnic de pagina niet geven, dan blijft het venster bruikbaar.
  assert.deepEqual(await app.productInfo('weg123'), { id: 'weg123' });
  await assert.rejects(app.productInfo('../x'), /Onbekend product/);

  // In de mand: een regel van Weekmand krijgt het ingrediënt mee, een eigen regel niet.
  await app.addItems([{ name: 'Slagroom', productId: 'sb200' }]);
  const plan = await app.plan();
  assert.ok(plan.lines.some(l => l.productId === 'sb200' && l.add === 1));
  await app.applyPlan(plan.id);
  const lines = (await app.cart(0)).lines;
  assert.equal(lines.find(l => l.id === 'sb200')!.key, def.key);
  assert.equal(lines.find(l => l.id === 'sp250')!.key, undefined);
});
