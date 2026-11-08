import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Assistant } from '../src/assistant.ts';
import { runTool } from '../src/tools.ts';
import { makeApp } from './helpers.ts';

test('gerechten vervangen: met opmerking past de AI het recept aan, het oude recept blijft', async () => {
  const { app } = makeApp();
  const old = app.catalog.addRecipe({ name: 'Luxe geroosterde kippenbouten', ingredients: [{ name: 'kippenbouten', amount: 250, unit: 'g' }, { name: 'aardappelen', amount: 200, unit: 'g' }] }, 'ai');
  await app.setMeal({ date: '2026-11-15', recipeId: old.id, servings: 2.35, note: 'Houd een portie apart' });
  await app.setMeal({ date: '2026-11-12', recipeId: 'shakshuka', servings: 2 });
  const seen: { recipe: any; note: string }[] = [];
  // Geeft de AI dezelfde naam terug, dan krijgt het nieuwe recept toch een eigen id.
  app.recipeAdapter = async (recipe, note) => { seen.push({ recipe, note }); return { name: recipe.name, ingredients: [{ name: 'kippenpoten', amount: 250, unit: 'g', category: 'vlees' }, { name: 'aardappelen', amount: 200, unit: 'g' }] }; };

  const r = await app.replaceMeals({ dates: ['2026-11-15'], note: 'met kippenpoten in plaats van kippenbouten' });
  assert.equal(r[0].how, 'aangepast');
  assert.equal(seen[0].note, 'met kippenpoten in plaats van kippenbouten');
  assert.deepEqual(seen[0].recipe.ingredients.map((i: any) => i.name), ['Kippenbouten', 'Aardappelen']);
  const meal = app.store.meal('2026-11-15')!;
  assert.notEqual(meal.recipeId, old.id);
  assert.equal(meal.servings, 2.35, 'porties blijven');
  assert.equal(meal.note, 'Houd een portie apart', 'opmerking bij de maaltijd blijft');
  assert.ok(app.catalog.recipe(meal.recipeId)!.ingredients.some(i => i.key === 'kippenpoten'));
  assert.ok(app.catalog.recipe(old.id)!.ingredients.some(i => i.key === 'kippenbouten'), 'oude recept onveranderd');

  // Zonder opmerking: een ander recept uit de catalogus, de AI wordt niet gevraagd.
  const swap = await app.replaceMeals({ dates: ['2026-11-12'] });
  assert.equal(swap[0].how, 'ander recept');
  assert.notEqual(app.store.meal('2026-11-12')!.recipeId, 'shakshuka');
  assert.equal(seen.length, 1);

  await assert.rejects(app.replaceMeals({ dates: [] }), /Vink één of meer/);
  await assert.rejects(app.replaceMeals({ dates: ['2026-11-30'] }), /geen gerecht/);
});

test('gerechten vervangen zonder AI: de opmerking geldt als wens', async () => {
  const { app } = makeApp();
  await app.setMeal({ date: '2026-11-13', recipeId: 'shakshuka', servings: 2 });
  const r = await app.replaceMeals({ dates: ['2026-11-13'], note: 'iets met vis' });
  assert.equal(r[0].how, 'ander recept');
  assert.ok(app.catalog.recipe(app.store.meal('2026-11-13')!.recipeId)!.tags.includes('vis'));
});

test('recept aanpassen via Mistral, en de chattool adapt_meal', async t => {
  const { app } = makeApp();
  await app.setMeal({ date: '2026-11-15', recipeId: 'shakshuka', servings: 2 });
  process.env.AI_PROVIDER = 'mistral';
  process.env.AI_API_KEY = 'test-key-123';
  t.after(() => { delete process.env.AI_PROVIDER; delete process.env.AI_API_KEY; });
  let context = '';
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.messages.at(-1).role === 'tool') return Response.json({ choices: [{ message: { role: 'assistant', content: 'Klaar.' } }] });
    context = body.messages[0].content;
    const args = { naam: 'Shakshuka zonder paprika', minuten: 25, bereiding: '1. Fruit de ui.', ingredienten: [{ naam: 'eieren', hoeveelheid: 2, eenheid: 'st', categorie: 'zuivel-eieren' }, { naam: 'tomatenblokjes', hoeveelheid: 200, eenheid: 'g' }] };
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'r', type: 'function', function: { name: 'nieuw_recept', arguments: JSON.stringify(args) } }] } }] });
  });
  const assistant = new Assistant(app);
  app.recipeAdapter = (recipe, note) => assistant.adaptRecipe(recipe, note);
  const r = await runTool(app, 'adapt_meal', { day: '2026-11-15', note: 'zonder paprika' }, { channel: 'chat' }) as any;
  assert.match(context, /Huidig recept: \{"name":"Shakshuka/);
  assert.deepEqual(r.replaced.map((x: any) => [x.to, x.how]), [['Shakshuka zonder paprika', 'aangepast']]);
  assert.equal(app.catalog.recipe(app.store.meal('2026-11-15')!.recipeId)!.minutes, 25);
});
