import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingredients } from '../src/data/ingredients.ts';
import { recipes } from '../src/data/recipes.ts';

const byKey = new Map(ingredients.map((i) => [i.key, i]));
const KEY = /^[a-z0-9-]+$/;
const DIET = ['vegetarisch', 'vegan', 'vis', 'kip', 'rund', 'varken', 'gehakt'];
const CUISINE = ['hollands', 'italiaans', 'mexicaans', 'aziatisch', 'indiaas', 'mediterraan', 'midden-oosten', 'amerikaans'];

test('ingrediëntsleutels zijn uniek en geldig', () => {
  assert.equal(new Set(ingredients.map((i) => i.key)).size, ingredients.length);
  for (const i of ingredients) assert.match(i.key, KEY, i.key);
});

test('pack-id\'s zijn uniek en geldig', () => {
  const ids = ingredients.flatMap((i) => i.packs.map((p) => p.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, KEY, id);
});

test('recept-id\'s zijn uniek en geldig', () => {
  assert.equal(new Set(recipes.map((r) => r.id)).size, recipes.length);
  for (const r of recipes) assert.match(r.id, KEY, r.id);
});

test('elk ingrediënt heeft 1-3 packs met dezelfde unit, amount>0 en gehele cents>0', () => {
  for (const i of ingredients) {
    assert.ok(i.packs.length >= 1 && i.packs.length <= 3, `${i.key}: aantal packs`);
    assert.ok(i.query.length > 0, `${i.key}: query`);
    for (const p of i.packs) {
      assert.equal(p.unit, i.unit, `${p.id}: unit`);
      assert.ok(p.amount > 0, `${p.id}: amount`);
      assert.ok(Number.isInteger(p.cents) && p.cents > 0, `${p.id}: cents`);
    }
  }
});

test('receptingrediënten bestaan en hebben de unit van het ingrediënt', () => {
  for (const r of recipes) {
    assert.ok(r.ingredients.length > 0, r.id);
    for (const g of r.ingredients) {
      const ing = byKey.get(g.key);
      assert.ok(ing, `${r.id}: onbekend ingrediënt ${g.key}`);
      assert.equal(g.unit, ing.unit, `${r.id}/${g.key}: unit`);
      assert.ok(g.amount > 0, `${r.id}/${g.key}: amount`);
    }
    assert.equal(new Set(r.ingredients.map((g) => g.key)).size, r.ingredients.length, `${r.id}: dubbel ingrediënt`);
  }
});

test('recepten hebben minuten, stappen en een eiwit/dieettag plus een keukentag', () => {
  for (const r of recipes) {
    assert.ok(r.minutes > 0, r.id);
    assert.ok(r.steps.length > 0, r.id);
    assert.ok(r.tags.some((t) => DIET.includes(t)), `${r.id}: geen eiwit/dieettag`);
    assert.ok(r.tags.some((t) => CUISINE.includes(t)), `${r.id}: geen keukentag`);
  }
});

test('vegetarische recepten bevatten geen vlees of vis', () => {
  for (const r of recipes.filter((x) => x.tags.includes('vegetarisch'))) {
    for (const g of r.ingredients) {
      const cat = byKey.get(g.key)!.category;
      assert.ok(cat !== 'vlees' && cat !== 'vis', `${r.id}: ${g.key} is ${cat}`);
    }
  }
});

test('genoeg recepten per tag', () => {
  const count = (tag: string) => recipes.filter((r) => r.tags.includes(tag)).length;
  assert.ok(count('mexicaans') >= 4);
  assert.ok(count('vegetarisch') >= 10);
});

test('pils staat in de catalogus', () => {
  const pils = byKey.get('pils');
  assert.ok(pils);
  assert.equal(pils.unit, 'ml');
  assert.ok(pils.packs.some((p) => p.amount === 7200) && pils.packs.some((p) => p.amount === 1980));
});
