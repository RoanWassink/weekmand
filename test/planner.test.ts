import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlan, parseWish, proposeMenu } from '../src/planner.ts';
import type { PlanInput, ProductOption } from '../src/planner.ts';
import type { Household, IngredientDef, Recipe, ShopCart } from '../src/types.ts';

const ingredients: IngredientDef[] = [
  { key: 'ei', name: 'Eieren', unit: 'st', category: 'zuivel-eieren', query: 'eieren', packs: [] },
  { key: 'melk', name: 'Melk', unit: 'ml', category: 'zuivel-eieren', query: 'melk', packs: [] },
  { key: 'zout', name: 'Zout', unit: 'g', category: 'kruiden-sauzen', staple: true, query: 'zout', packs: [] },
];
const options: Record<string, ProductOption[]> = {
  ei: [{ id: 'ei6', name: 'Eieren 6 st', unitQuantity: '6 stuks', cents: 249, packAmount: 6 }, { id: 'ei10', name: 'Eieren 10 st', unitQuantity: '10 stuks', cents: 349, packAmount: 10 }],
  melk: [{ id: 'melk1', name: 'Melk 1 l', unitQuantity: '1 liter', cents: 129, packAmount: 1000 }],
  zout: [{ id: 'zout', name: 'Zout', unitQuantity: '500 gram', cents: 79, packAmount: 500 }],
};
const household: Household = { adults: 1, children: 0, toddlers: 0, budget: 50, vegetarian: false, exclude: [], days: 3 };
const recipe = (id: string, eggs: number): Recipe => ({ id, name: id, tags: ['vegetarisch'], minutes: 10, steps: '', source: 'builtin', ingredients: [{ key: 'ei', amount: eggs, unit: 'st' }, { key: 'zout', amount: 1, unit: 'g' }] });
const cart = (lines: Record<string, number>, id = 'cart1'): ShopCart => ({
  id, totalCents: 0,
  lines: Object.entries(lines).map(([pid, quantity]) => ({ ...Object.values(options).flat().find(o => o.id === pid)!, available: true, quantity })),
});

function plan(overrides: Partial<PlanInput> = {}) {
  return buildPlan({
    meals: [{ date: '2026-11-11', recipe: recipe('a', 2), servings: 1 }, { date: '2026-11-12', recipe: recipe('b', 4), servings: 1 }, { date: '2026-11-13', recipe: recipe('c', 3), servings: 1 }],
    household, pantry: [], order: { extras: [], skip: [] }, regulars: [], avoid: [], cart: cart({}), ledger: {},
    ingredient: k => ingredients.find(i => i.key === k), options: k => options[k] ?? [],
    productKey: id => Object.entries(options).find(([, o]) => o.some(x => x.id === id))?.[0], now: Date.parse('2026-11-10T09:00:00Z'),
    ...overrides,
  });
}

test('overlappende eieren: 2 + 4 + 3 = 9, een doos van 10 is goedkoper dan twee van 6', () => {
  const p = plan();
  assert.deepEqual(p.target, { ei10: 1 });
  const line = p.lines.find(l => l.key === 'ei')!;
  assert.equal(line.need, 9);
  assert.equal(line.add, 1);
  // Zout is basisvoorraad en wordt niet per recept gekocht.
  assert.ok(!p.lines.some(l => l.key === 'zout'));
});

test('idempotent: na toepassen geeft opnieuw rekenen geen wijzigingen', () => {
  const first = plan();
  const second = plan({ cart: cart(first.target), ledger: { ...first.target } });
  assert.deepEqual(second.target, second.before);
  assert.ok(second.lines.every(l => !l.add && !l.remove));
});

test('wat de gebruiker zelf in de mand legde telt mee en blijft staan', () => {
  const p = plan({ cart: cart({ ei6: 1 }) }); // 6 eieren zelf toegevoegd, 9 nodig: nog 3, dus één doos van 6 erbij
  assert.deepEqual(p.target, { ei6: 2 });
  assert.ok(p.lines.every(l => !l.remove));
});

test('minder nodig: alleen eigen toevoegingen van Weekmand gaan eruit', () => {
  const p = plan({ meals: [{ date: '2026-11-11', recipe: recipe('a', 2), servings: 1 }], cart: cart({ ei10: 1, ei6: 1 }), ledger: { ei10: 1 } });
  // ei6 is van de gebruiker en dekt de 2 eieren; de door Weekmand toegevoegde doos van 10 mag weg.
  assert.equal(p.target.ei10, 0);
  assert.equal(p.target.ei6 ?? 1, 1);
});

test('voorraad telt mee; een oude meting wordt nagevraagd', () => {
  const pantry = [{ key: 'ei', amount: 8, checkedAt: '2026-11-01T10:00:00Z', minimum: 0 }];
  const p = plan({ pantry });
  assert.deepEqual(p.target, { ei6: 1 });
  assert.equal(p.questions.length, 1);
  assert.match(p.questions[0].text, /8 stuks eieren/);
  const fresh = plan({ pantry: [{ ...pantry[0], checkedAt: '2026-11-10T08:00:00Z' }] });
  assert.equal(fresh.questions.length, 0);
});

test('overslaan haalt het product uit de mand, ook als de gebruiker het zelf toevoegde', () => {
  const p = plan({ order: { extras: [], skip: ['ei'] }, cart: cart({ ei6: 2 }) });
  assert.equal(p.target.ei6, 0);
  assert.equal(p.lines.find(l => l.productId === 'ei6')!.remove, 2);
});

test('vaste boodschap vult aan, extra komt erbovenop, minimumvoorraad wordt aangevuld', () => {
  const regulars = [{ productId: 'melk1', name: 'Melk 1 l', unitQuantity: '1 liter', cents: 129, quantity: 2, enabled: true }];
  const a = plan({ meals: [], regulars, cart: cart({ melk1: 1 }) });
  assert.equal(a.target.melk1, 2); // 1 zelf + 1 aanvulling
  const extras = [{ id: 'x', kind: 'product' as const, productId: 'melk1', name: 'Melk 1 l', unitQuantity: '1 liter', cents: 129, quantity: 1 }];
  const b = plan({ meals: [], order: { extras, skip: [] }, cart: cart({ melk1: 1 }) });
  assert.equal(b.target.melk1, 2); // zelf 1 + extra 1
  const c = plan({ meals: [], pantry: [{ key: 'melk', amount: 500, checkedAt: '2026-11-10T08:00:00Z', minimum: 2000 }] });
  assert.equal(c.target.melk1, 2); // 2000 - 500 = 1500 ml → 2 pakken
  const d = plan({ meals: [], pantry: [{ key: 'melk', amount: 500, checkedAt: '2026-11-10T08:00:00Z', minimum: 2000 }], avoid: [{ kind: 'ingredient-auto', key: 'melk' }] });
  assert.deepEqual(d.target, {});
});

test('weekwens: ontkenning, keukens en ingrediënten', () => {
  assert.deepEqual(parseWish('graag iets mexicaans, geen vis'), { include: ['mexicaans'], exclude: ['vis'], excludeKeys: [] });
  assert.deepEqual(parseWish('geen vis en geen champignons', w => w.startsWith('champignon') ? 'champignon' : undefined).excludeKeys, ['champignon']);
  assert.deepEqual(parseWish('zonder vlees').exclude, ['kip', 'rund', 'varken', 'gehakt']);
  assert.deepEqual(parseWish('snel maar wel een keer kip').include, ['snel', 'kip']);
});

test('menuvoorstel: afwisselend, binnen dieet en vaste dagen blijven staan', () => {
  const recipes: Recipe[] = ['vis', 'kip', 'rund', 'vegetarisch', 'vegetarisch', 'kip'].map((tag, i) => ({
    id: 'r' + i, name: 'R' + i, tags: [tag, ['italiaans', 'aziatisch', 'hollands', 'mexicaans', 'indiaas', 'italiaans'][i]], minutes: 20, steps: '', source: 'builtin', ingredients: [{ key: 'ei', amount: 1, unit: 'st' }],
  }));
  const base = { recipes, household, avoid: [], recent: [], wish: parseWish(''), costPerPortion: () => 100, ingredient: (k: string) => ingredients.find(i => i.key === k), seed: 's' };
  const dates = ['2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'];
  const menu = proposeMenu({ ...base, dates, fixed: { '2026-11-12': 'r5' } });
  assert.equal(menu['2026-11-12'], 'r5');
  assert.equal(new Set(Object.values(menu)).size, 4);
  const veg = proposeMenu({ ...base, dates: dates.slice(0, 2), fixed: {}, household: { ...household, vegetarian: true } });
  assert.deepEqual(Object.values(veg).sort(), ['r3', 'r4']);
  const noFishFriday = proposeMenu({ ...base, dates: ['2026-11-13'], fixed: {}, wish: parseWish('vis'), avoid: [{ kind: 'tag-weekday', tag: 'vis', weekday: 5 }] });
  assert.notEqual(noFishFriday['2026-11-13'], 'r0');
});

test('weggeveegde regel: niets erbij en niets eraf; toont wat al in de mand zit', () => {
  const base = plan({ cart: cart({ ei6: 1 }) });
  const line = base.lines.find(l => l.add > 0)!;
  assert.equal(line.inCartAmount, 6, '6 eieren al in de mand');
  const declined = plan({ cart: cart({ ei6: 1 }), order: { extras: [], skip: [], declined: [line.productId] } });
  assert.equal(declined.target[line.productId], declined.before[line.productId]);
  assert.ok(declined.lines.find(l => l.productId === line.productId)!.declined);
  assert.ok(declined.lines.every(l => !l.add && !l.remove));
});
