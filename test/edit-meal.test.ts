import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeApp } from './helpers.ts';

test('gerecht zelf bewerken: eigen versie voor die dag, het origineel blijft, en zo staat het onder Gegeten', async () => {
  const { app, clock } = makeApp();
  const w = await app.window();
  const [d1, d2] = w.dates;
  await app.setMeal({ date: d1, recipeId: 'gevulde-paprika', servings: 2 });
  const original = structuredClone(app.catalog.recipe('gevulde-paprika')!);

  // Hoeveelheden voor 2 personen: 300 g gehakt wordt 150 g per persoon.
  const first = app.editMeal({
    date: d1, name: 'Gevulde paprika met kaaskorst', minutes: 50, steps: '1. Vul de paprika.\n2. Kaas erover.',
    ingredients: [{ name: 'Paprika', amount: 2, unit: 'st' }, { name: 'Gehakt', amount: 300, unit: 'g' }, { name: 'Geraspte kaas', amount: 80, unit: 'g' }, { name: '', amount: 5, unit: 'g' }, { name: 'zout', amount: 0, unit: 'g' }],
  });
  assert.equal(first.copied, true);
  const mine = app.catalog.recipe(first.recipe.id)!;
  assert.equal(mine.id, 'gevulde-paprika-met-kaaskorst-aangepast');
  assert.deepEqual([mine.name, mine.minutes, mine.source], ['Gevulde paprika met kaaskorst', 50, 'user']);
  assert.ok(mine.tags.includes('aangepast'));
  assert.deepEqual(mine.ingredients.map(i => [i.key, i.amount]), [['paprika', 1], ['gehakt', 150], ['geraspte-kaas', 40]], 'per persoon; lege regels vallen weg');
  assert.deepEqual(app.catalog.recipe('gevulde-paprika'), original, 'het oorspronkelijke recept is onveranderd');
  assert.equal(app.store.meal(d1)!.recipeId, mine.id);
  assert.equal(app.store.meal(d1)!.status, 'approved');

  // Nog eens bewerken: dezelfde eigen versie, geen tweede kopie.
  const again = app.editMeal({ date: d1, name: 'Gevulde paprika met kaaskorst', minutes: 45, ingredients: [{ name: 'Paprika', amount: 2, unit: 'st' }, { name: 'Gehakt', amount: 250, unit: 'g' }] });
  assert.deepEqual([again.copied, again.recipe.id], [false, mine.id]);
  assert.equal(app.catalog.recipe(mine.id)!.ingredients.find(i => i.key === 'gehakt')!.amount, 125);

  // Staat die versie ook op een andere dag, dan krijgt deze dag een nieuwe kopie (de andere blijft gelijk).
  await app.setMeal({ date: d2, recipeId: mine.id, servings: 2 });
  const third = app.editMeal({ date: d1, name: 'Gevulde paprika met kaaskorst', ingredients: [{ name: 'Paprika', amount: 4, unit: 'st' }] });
  assert.deepEqual([third.copied, third.recipe.id], [true, `${mine.id}-2`]);
  assert.equal(app.store.meal(d2)!.recipeId, mine.id);

  // Besteld en voorbij: onder Gegeten staat de aangepaste versie.
  app.store.markOrdered([d1]);
  clock.now = Date.parse(d1 + 'T21:00:00Z') + 86_400_000;
  const eaten = app.recipeHistory().find(h => h.date === d1)!;
  assert.deepEqual([eaten.recipeId, eaten.name], [`${mine.id}-2`, 'Gevulde paprika met kaaskorst']);

  assert.throws(() => app.editMeal({ date: d2, name: 'Leeg', ingredients: [] }), /minstens één ingrediënt/);
  assert.throws(() => app.editMeal({ date: '2030-01-01', name: 'X', ingredients: [{ name: 'Paprika', amount: 1, unit: 'st' }] }), /geen gerecht/);
});
