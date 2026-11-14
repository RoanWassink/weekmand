import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MenuIdea, MenuRequest } from '../src/app.ts';
import { previewRecipe, searchResults } from '../src/recipe-import.ts';
import { makeApp } from './helpers.ts';

const tikka = {
  name: 'Kip tikka masala', servings: 4, minutes: 30, tags: ['Hoofdgerecht', 'Indiaas'], steps: ['Snijd de kip.', 'Laat sudderen.'], url: 'https://www.lekkerensimpel.com/kip-tikka-masala/',
  ingredients: ['500 gram kippendijfilet', '400 ml kokosmelk', '1 ui', '2 teentjes knoflook', '300 gram rijst'],
};

test('menu met AI: bekende recepten, een recept van de receptensite en een dat de AI schrijft', async () => {
  const { app } = makeApp();
  const w = await app.window();
  const [d1, d2, d3] = w.dates;
  let request: MenuRequest | null = null;
  app.menuPlanner = async input => {
    request = input;
    return [
      { date: d1, recipeId: 'pasta-carbonara' },
      { date: d2, name: 'Kip tikka masala', query: 'kip tikka masala', tags: ['kip', 'indiaas'] },
      { date: d3, name: 'Pompoenrisotto met salie', query: 'pompoenrisotto salie', tags: ['vegetarisch'] },
      { date: '2030-01-01', recipeId: 'pasta-carbonara' }, // niet gevraagd: genegeerd
    ] satisfies MenuIdea[];
  };
  const searched: string[] = [];
  app.webRecipe = async query => { searched.push(query); return query === 'kip tikka masala' ? previewRecipe(tikka, app.catalog) : null; };
  app.recipeAdapter = async (_recipe, note) => {
    assert.match(note, /Pompoenrisotto met salie/);
    return { name: 'Pompoenrisotto met salie', minutes: 40, steps: '1. Rooster de pompoen.', tags: ['vegetarisch'], ingredients: [{ name: 'risottorijst', amount: 80, unit: 'g' }, { name: 'pompoen', amount: 200, unit: 'g' }] };
  };
  const known = app.catalog.recipe('pasta-carbonara');
  assert.ok(known, 'ingebouwd recept bestaat');

  const menu = await app.proposeMenu();
  assert.ok(request, 'de AI kreeg de vraag');
  assert.deepEqual(request!.dates.map(d => d.date), w.dates, 'alle open dagen');
  assert.ok(request!.known.some(r => r.id === 'pasta-carbonara'));
  assert.deepEqual(searched, ['kip tikka masala', 'pompoenrisotto salie']);
  const byDate = Object.fromEntries(menu.days.filter(d => d.meal).map(d => [d.date, d.meal!]));
  assert.equal(byDate[d1].id, 'pasta-carbonara');
  const web = app.catalog.recipe(byDate[d2].id)!;
  assert.deepEqual([web.name, web.source], ['Kip tikka masala', 'web']);
  assert.ok(web.tags.includes('online') && web.tags.includes('kip'));
  assert.match(web.steps, /Bron: https:\/\/www\.lekkerensimpel\.com\/kip-tikka-masala\//);
  assert.deepEqual([app.catalog.recipe(byDate[d3].id)!.name, app.catalog.recipe(byDate[d3].id)!.source], ['Pompoenrisotto met salie', 'ai']);
  assert.equal(Object.keys(byDate).length, w.dates.length, 'de rest vult Weekmand zelf aan');
  assert.match((menu as { note?: string }).note!, /^Menu met AI: 2 nieuwe gerechten \(1 van Lekker en Simpel, 1 door de AI geschreven\) en 1 uit je eigen recepten\. \d+ dagen vulde Weekmand zelf aan\.$/);

  // Opnieuw voorstellen: het recept van de site wordt hergebruikt, niet nog eens opgeslagen.
  const count = app.catalog.recipes().length;
  await app.proposeMenu({ replace: true });
  assert.equal(app.catalog.recipes().length, count);
});

test('menu zonder bruikbaar AI-antwoord: Weekmand kiest zelf en zegt dat', async () => {
  const { app } = makeApp();
  app.menuPlanner = async () => null;
  const menu = await app.proposeMenu();
  assert.equal(menu.days.filter(d => d.inOrder && d.meal).length, app.household.days);
  assert.match((menu as { note?: string }).note!, /koos uit je eigen recepten/);
  // Zonder AI gekoppeld: geen melding, gewoon een voorstel.
  const { app: plain } = makeApp();
  assert.equal((await plain.proposeMenu() as { note?: string }).note, undefined);
});

test('opnieuw voorstellen geeft andere gerechten (pas voorgestelde tellen minder)', async () => {
  let overlap = 0;
  for (let round = 0; round < 10; round++) {
    const { app } = makeApp();
    const first = (await app.proposeMenu()).days.filter(d => d.meal).map(d => d.meal!.id);
    const second = (await app.proposeMenu({ replace: true })).days.filter(d => d.meal).map(d => d.meal!.id);
    overlap += second.filter(id => first.includes(id)).length / first.length;
  }
  assert.ok(overlap / 10 < 0.35, `gemiddeld ${Math.round(overlap * 10)}% dezelfde gerechten`);
});

test('receptensite: links uit de zoekresultaten, in volgorde en zonder dubbele', () => {
  const html = `<nav><a href="https://www.lekkerensimpel.com/bakken/">Bakken</a></nav>
    <a href="https://www.lekkerensimpel.com/kip-tikka-masala/" rel="bookmark" class="post-item__anchor"><h2>Kip tikka masala</h2></a>
    <a class="post-item__anchor" href="https://www.lekkerensimpel.com/tikka-masala-wraps/">x</a>
    <a href="https://www.lekkerensimpel.com/kip-tikka-masala/" class="post-item__anchor">dubbel</a>
    <a href="https://evil.example/x/" class="post-item__anchor">vreemd</a>`;
  assert.deepEqual(searchResults(html), ['https://www.lekkerensimpel.com/kip-tikka-masala/', 'https://www.lekkerensimpel.com/tikka-masala-wraps/']);
});
