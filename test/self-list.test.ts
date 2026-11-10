import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeApp } from './helpers.ts';

test('zelf boodschappen doen: lijst per afdeling en per gerecht, zonder mand of deadline', async () => {
  const { app } = makeApp();
  app.setShopMode('self');
  assert.equal(app.shop.label, 'Zelf boodschappen doen');
  const delivery = await app.delivery();
  assert.equal(delivery.cutOff, null, 'geen deadline');
  assert.equal((await app.window()).start, '2026-11-10', 'standaard vanaf vandaag');

  await app.proposeMenu();
  const list = await app.shoppingList();
  assert.ok(list.items.length > 0, 'er staat iets op de lijst');
  assert.ok(list.items.every(i => i.name && i.category && !('cents' in i)), 'naam en afdeling, geen prijzen');
  assert.ok(list.meals.length > 0);
  const meal = list.meals[0];
  assert.ok(meal.ingredients.length > 0);
  assert.ok(meal.ingredients.every(i => 'id' in i || i.have), 'elk ingrediënt staat op de lijst of is er al');

  // Afvinken is gedeeld en verandert het voorstel niet.
  const item = list.items[0];
  app.checkListItem(item.id, true);
  const again = await app.shoppingList();
  assert.equal(again.items.find(i => i.id === item.id)?.checked, true);
  const inMeal = again.meals.flatMap(m => m.ingredients).find(i => 'id' in i && i.id === item.id);
  if (inMeal) assert.equal(inMeal.checked, true, 'zelfde vinkje in de weergave per gerecht');
  app.clearListChecks();
  assert.equal((await app.shoppingList()).items.find(i => i.id === item.id)?.checked, false);

  // Voorraad telt mee: wat er al is, verdwijnt van de lijst.
  if (item.key) {
    app.store.savePantry({ key: item.key, amount: 100_000, checkedAt: new Date(app.now()).toISOString(), minimum: 0 });
    app.changed();
    assert.ok(!(await app.shoppingList()).items.some(i => i.key === item.key), 'genoeg in huis: niet meer op de lijst');
  }

  // Boodschappendag: vandaag mag; er is geen mand om in te schrijven.
  await app.chooseDelivery({ date: '2026-11-10' });
  await assert.rejects(app.shop.add('x', 1), /geen mand/);
});
