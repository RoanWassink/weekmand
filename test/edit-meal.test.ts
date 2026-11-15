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

test('recept zelf bewerken vanuit Recepten: geldt overal; een ingebouwd recept kan terug naar het origineel', async () => {
  const { app } = makeApp();
  const original = structuredClone(app.catalog.recipe('pasta-carbonara')!);
  assert.equal(app.recipeDetail('pasta-carbonara').overridesBuiltin, false);
  // Hoeveelheden voor 4 personen.
  const r = app.editRecipe({ id: 'pasta-carbonara', servings: 4, name: 'Pasta carbonara met erwtjes', minutes: 20,
    ingredients: [{ name: 'Spaghetti', amount: 400, unit: 'g' }, { name: 'Spekblokjes', amount: 200, unit: 'g' }, { name: 'Doperwten', amount: 300, unit: 'g' }] });
  assert.equal(r.overridesBuiltin, true);
  const mine = app.catalog.recipe('pasta-carbonara')!;
  assert.deepEqual([mine.name, mine.source, mine.minutes], ['Pasta carbonara met erwtjes', 'user', 20]);
  assert.equal(mine.ingredients.find(i => i.key === app.catalog.resolve('spaghetti')!.key)!.amount, 100, 'per persoon');
  assert.equal(app.catalog.recipes().filter(x => x.id === 'pasta-carbonara').length, 1, 'geen dubbel recept');
  assert.equal(app.recipeDetail('pasta-carbonara').overridesBuiltin, true);
  app.restoreRecipe('pasta-carbonara');
  assert.deepEqual(app.catalog.recipe('pasta-carbonara'), original, 'het origineel is terug');
  assert.throws(() => app.restoreRecipe('pasta-carbonara'), /geen eigen versie/);
});

test('een al gegeten gerecht bewerken gaat niet nog eens van de voorraad af', async () => {
  const { app, clock } = makeApp();
  const w = await app.window();
  await app.setMeal({ date: w.dates[0], recipeId: 'gevulde-paprika', servings: 2 });
  app.store.markOrdered([w.dates[0]]);
  clock.now = Date.parse(w.dates[0] + 'T21:00:00Z') + 86_400_000;
  app.consumePastMeals();
  assert.equal((app.store.meal(w.dates[0]) as { consumed: boolean }).consumed, true);
  app.editMeal({ date: w.dates[0], name: 'Gevulde paprika (zoals we hem echt maakten)', ingredients: [{ name: 'Paprika', amount: 2, unit: 'st' }] });
  assert.equal((app.store.meal(w.dates[0]) as { consumed: boolean }).consumed, true, 'blijft gegeten');
  assert.equal(app.recipeHistory().find(h => h.date === w.dates[0])!.name, 'Gevulde paprika (zoals we hem echt maakten)');
});
