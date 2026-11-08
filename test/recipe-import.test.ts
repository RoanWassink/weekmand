import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractRecipe, fetchPage, isoMinutes, parseLine, previewRecipe } from '../src/recipe-import.ts';
import { makeApp } from './helpers.ts';

const page = `<!doctype html><html><head><title>Kip tikka</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
  {"@type":"WebSite","name":"Recepten"},
  {"@type":["Recipe"],"name":"Snelle kip tikka masala &amp; rijst","recipeYield":["4","4 personen"],"prepTime":"PT15M","cookTime":"PT25M",
   "recipeCategory":"Hoofdgerecht","recipeCuisine":"Indiaas","keywords":"kip, curry",
   "recipeIngredient":["600 g kipfilet, in blokjes","1 blik tomatenblokjes (400 g)","2 uien","3 teentjes knoflook","2 el olijfolie","300 g basmatirijst","1 bosje koriander","zout en peper naar smaak","250 ml kookroom","1½ tl kerriepoeder"],
   "recipeInstructions":[{"@type":"HowToSection","name":"Saus","itemListElement":[{"@type":"HowToStep","text":"Fruit de ui en knoflook."},{"@type":"HowToStep","text":"Bak de kip <b>goudbruin</b>."}]},{"@type":"HowToStep","text":"Kook de rijst."}]}
]}</script></head><body></body></html>`;

test('ingrediëntregels lezen', () => {
  assert.deepEqual(parseLine('600 g kipfilet, in blokjes'), { original: '600 g kipfilet, in blokjes', name: 'kipfilet', amount: 600, unit: 'g', container: false });
  assert.deepEqual(parseLine('1 blik tomatenblokjes (400 g)'), { original: '1 blik tomatenblokjes (400 g)', name: 'tomatenblokjes', amount: 400, unit: 'g', container: false });
  assert.equal(parseLine('1½ tl kerriepoeder').amount, 1.5);
  assert.equal(parseLine('1/2 komkommer').amount, 0.5);
  assert.equal(parseLine('2-3 tomaten').amount, 3);
  assert.equal(parseLine('1,5 liter melk').unit, 'l');
  assert.deepEqual([parseLine('2 uien').amount, parseLine('2 uien').unit, parseLine('2 uien').name], [2, null, 'uien']);
  assert.equal(parseLine('3 teentjes knoflook').unit, 'st');
  assert.equal(parseLine('1 blik kikkererwten').container, true);
  assert.equal(parseLine('zout en peper naar smaak').amount, null);
  assert.equal(isoMinutes('PT1H30M'), 90);
});

test('schema.org-recept uit een pagina, ook in @graph en met secties', () => {
  const r = extractRecipe(page, 'https://example.com/kip-tikka')!;
  assert.equal(r.name, 'Snelle kip tikka masala & rijst');
  assert.equal(r.servings, 4);
  assert.equal(r.minutes, 40);
  assert.equal(r.ingredients.length, 10);
  assert.deepEqual(r.steps, ['Fruit de ui en knoflook.', 'Bak de kip goudbruin.', 'Kook de rijst.']);
  assert.ok(r.tags.includes('Indiaas'));
  assert.equal(extractRecipe('<html><body>geen recept</body></html>', 'x'), null);
});

test('omrekenen naar per persoon met de catalogus', () => {
  const { app } = makeApp();
  const p = previewRecipe(extractRecipe(page, 'https://example.com/kip-tikka')!, app.catalog);
  const line = (start: string) => p.lines.find(l => l.original.startsWith(start))!;
  assert.deepEqual([line('600 g kipfilet').key, line('600 g kipfilet').amount], ['kipfilet', 150]);
  assert.deepEqual([line('1 blik').key, line('1 blik').amount], ['tomatenblokjes', 100]);
  assert.deepEqual([line('2 uien').key, line('2 uien').amount], ['ui', 0.5]);
  assert.equal(line('3 teentjes').key, 'knoflook');
  assert.equal(line('zout').status, 'bekend', 'basisvoorraad zonder hoeveelheid');
  assert.match(p.steps, /^1\. Fruit de ui/);
  assert.match(p.steps, /Bron: https:\/\/example\.com\/kip-tikka$/);
  const saved = app.saveImportedRecipe(p, [line('1 bosje').original]);
  assert.equal(saved.source, 'web');
  assert.ok(saved.tags.includes('online'));
  assert.ok(!saved.ingredients.some(i => /koriander/.test(i.key)), 'uitgevinkte regel niet opgeslagen');
  assert.equal(app.catalog.recipe(saved.id)?.ingredients.find(i => i.key === 'kipfilet')?.amount, 150);
});

test('geplakte ingrediëntenlijst en dubbele labels', () => {
  const { app } = makeApp();
  const p = app.previewRecipeFromText({ name: 'Kip pesto', servings: 2, text: 'Ingrediënten\n• 300 g kipfilet\n- 1 ui\n\n200 g penne\nBereiding' });
  assert.deepEqual(p.lines.map(l => [l.key, l.amount]), [['kipfilet', 150], ['ui', 0.5], ['penne', 100]]);
  assert.equal(p.steps, '', 'geen bronregel zonder link');
  assert.deepEqual(app.saveImportedRecipe(p).tags, [], 'geen label online');
  assert.throws(() => app.previewRecipeFromText({ text: '  ' }), { status: 400 });
  const doubled = page.replace('"keywords":"kip, curry"', '"keywords":"Indiaas, kip, Hoofdgerecht, kip"');
  assert.deepEqual(extractRecipe(doubled, 'x')!.tags, ['Hoofdgerecht', 'Indiaas', 'kip']);
});

test('links naar het eigen netwerk worden geweigerd, ook via doorverwijzing', async () => {
  const fakeFetch = (async (url: URL) => url.hostname === '93.184.216.34'
    ? new Response(null, { status: 302, headers: { location: 'http://192.168.1.1/' } })
    : new Response(page, { headers: { 'content-type': 'text/html' } })) as typeof fetch;
  for (const link of ['http://127.0.0.1:8080/', 'http://192.168.1.1/', 'http://[::1]/', 'http://[::ffff:192.168.1.1]/', 'http://localhost/', 'file:///etc/passwd', 'http://user:pw@93.184.216.34/']) {
    await assert.rejects(fetchPage(link, fakeFetch), { status: 400 }, link);
  }
  await assert.rejects(fetchPage('http://93.184.216.34/recept', fakeFetch), /eigen netwerk/);
  const ok = await fetchPage('https://8.8.8.8/recept', fakeFetch);
  assert.match(ok.html, /kip tikka/i);
});
