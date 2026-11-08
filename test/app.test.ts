import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Weekmand } from '../src/app.ts';
import { Store } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { makeApp, tuesday } from './helpers.ts';

const day = 86_400_000;

test('menu, boodschappen, toepassen en opnieuw rekenen zonder dubbele toevoegingen', async () => {
  const { app } = makeApp();
  const menu = await app.proposeMenu({ wish: 'snel, geen vis' });
  const meals = menu.days.filter(d => d.inOrder && d.meal);
  assert.equal(meals.length, app.household.days);
  assert.ok(meals.every(d => !d.meal!.tags.includes('vis')));
  const plan = await app.plan();
  assert.ok(plan.lines.some(l => l.add > 0));
  const result = await app.applyPlan(plan.id);
  assert.equal(result.already, false);
  const again = await app.plan();
  assert.ok(again.lines.every(l => !l.add && !l.remove), 'tweede berekening hoort niets te wijzigen');
  assert.equal((await app.applyPlan(plan.id)).already, true);
});

test('vrijdag met 6 man Mexicaans en een krat pils; kipfilet eruit', async () => {
  const { app } = makeApp();
  await app.proposeMenu();
  const friday = await app.setMeal({ date: '2026-11-13', recipeId: 'chili-con-carne', servings: 6 });
  assert.equal(friday.day, 'vrijdag');
  const plan = await app.plan();
  const gehakt = plan.lines.find(l => l.key === 'rundergehakt');
  assert.ok(gehakt && gehakt.need! >= 6 * 110, 'rundergehakt voor 6 personen');
  assert.deepEqual(await app.addItems([{ name: 'krat pils' }]), ['1× Krat pils 24 x 30 cl']);
  await app.removeItems(['kipfilet']);
  const after = await app.plan();
  assert.equal(after.lines.find(l => l.product.startsWith('Krat pils'))?.add, 1);
  assert.ok(!after.lines.some(l => l.key === 'kipfilet' && l.add > 0));
});

test('een tussentijds gewijzigde mand: nooit dubbel toevoegen', async () => {
  const { app } = makeApp();
  await app.proposeMenu();
  const plan = await app.plan();
  const first = plan.lines.find(l => l.add > 0)!;
  const wanted = plan.target[first.productId];
  await app.mock.add(first.productId, 3);
  // Óf het overzicht is verlopen, óf Weekmand vult alleen aan wat na de eigen 3 nog nodig is.
  const result = await app.applyPlan(plan.id).catch((e: { status: number }) => e);
  const now = (await app.mock.readCart()).lines.find(l => l.id === first.productId)!.quantity;
  if ('status' in result) assert.equal(result.status, 409);
  else assert.ok(now <= Math.max(wanted, 3), `niet meer dan nodig (${now})`);
  assert.ok(now < wanted + 3);
});

test('demobestelling afronden vult de voorraad; gegeten maaltijden gaan eraf', async () => {
  const { app, clock } = makeApp();
  await app.setMeal({ date: '2026-11-11', recipeId: 'shakshuka', servings: 2 });
  const plan = await app.plan();
  await app.applyPlan(plan.id);
  await app.completeDemoOrder();
  const eggs = app.store.pantryItem('ei');
  assert.ok(eggs && eggs.amount! >= 4);
  clock.now = tuesday + 2 * day;
  app.consumePastMeals();
  assert.ok(app.store.pantryItem('ei')!.amount! < eggs.amount!);
  // Nieuwe mand na de bestelling: lijst voor de bestelling is leeg.
  assert.deepEqual(app.order, { extras: [], skip: [] });
});

test('twee weken achter elkaar vis op donderdag schrappen geeft een voorstel', async () => {
  const { app, clock } = makeApp();
  const notices: string[] = [];
  app.events.on('notify', n => notices.push(n.text));
  for (const date of ['2026-11-12', '2026-11-19']) {
    app.store.saveMeal({ date, recipeId: 'zalm-krieltjes-broccoli', servings: 2, status: 'proposed' });
    await app.swapMeal(date);
    clock.now += 7 * day;
  }
  const open = app.suggestions();
  assert.ok(open.some(s => /vis op donderdag/.test(s.text)), JSON.stringify(open));
  assert.ok(notices.some(t => /vis op donderdag/.test(t)));
  const s = open.find(x => /vis op donderdag/.test(x.text))!;
  app.respondSuggestion(s.id, true);
  assert.deepEqual(app.avoid, [{ kind: 'tag-weekday', tag: 'vis', weekday: 4 }]);
  clock.now = tuesday;
  const menu = await app.proposeMenu({ wish: 'vis', replace: true });
  const thursday = menu.days.find(d => d.date === '2026-11-12');
  assert.ok(!thursday?.meal || !thursday.meal.tags.includes('vis'));
});

test('voorraad: op, minimum, barcode koppelen en scannen', () => {
  const { app } = makeApp();
  app.markOut('melk');
  assert.equal(app.store.pantryItem('melk')!.amount, 0);
  app.updatePantry([{ name: 'eieren', amount: 10, minimum: 6 }]);
  assert.deepEqual([app.store.pantryItem('ei')!.amount, app.store.pantryItem('ei')!.minimum], [10, 6]);
  assert.deepEqual(app.scanBarcode('8710400000006'), { known: false, code: '8710400000006' });
  const scanned = app.registerBarcode({ code: '8710400000006', name: 'eieren', packAmount: 6, unit: 'st' });
  assert.equal(scanned.known && scanned.amount, 4);
  assert.equal((app.scanBarcode('8710400000006') as { amount: number }).amount, 0);
});

test('eigen recept met onbekend ingrediënt en eenheden', () => {
  const { app } = makeApp();
  const recipe = app.catalog.addRecipe({ name: 'Quesadilla', tags: ['mexicaans'], ingredients: [{ name: 'tortilla', amount: 2, unit: 'st' }, { name: 'geraspte kaas', amount: 0.05, unit: 'kg' }, { name: 'jalapeño', amount: 10, unit: 'g' }] }, 'user');
  assert.deepEqual(recipe.ingredients.map(i => [i.key, i.amount, i.unit]), [['tortilla', 2, 'st'], ['geraspte-kaas', 50, 'g'], ['jalapeno', 10, 'g']]);
  assert.ok(recipe.tags.includes('vegetarisch'));
  assert.ok(app.catalog.ingredient('jalapeno'));
});

test('versie 1 wordt overgezet: huishouden, voorraad in de juiste eenheid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'weekmand-'));
  try {
    const path = join(dir, 'db.sqlite');
    const old = new DatabaseSync(path);
    old.exec('CREATE TABLE documents (key TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT');
    old.prepare('INSERT INTO documents VALUES (?, ?)').run('state', JSON.stringify({
      preferences: { people: 3, children: 1, toddlers: 0, days: 4, budget: 70, vegetarian: false, exclude: ['kip'] },
      stock: { tomaat: { amount: 300, date: '2026-11-07T10:00:00Z' }, melk: { amount: 2000, date: '2026-11-07T10:00:00Z' } },
    }));
    old.prepare('INSERT INTO documents VALUES (?, ?)').run('picnicHistory', 'null');
    old.close();
    const app = new Weekmand({ store: new Store(path), secrets: new Secrets(null), now: () => tuesday });
    assert.equal(app.household.adults, 3);
    assert.equal(app.household.days, 4);
    assert.deepEqual(app.household.exclude, ['kipfilet']);
    assert.equal(app.store.pantryItem('tomaat')!.amount, 3);
    assert.equal(app.store.pantryItem('melk')!.amount, 2000);
    app.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receptgeschiedenis: alleen bestelde maaltijden, duimpjes en favorietenpool', async () => {
  const { app, clock } = makeApp();
  await app.setMeal({ date: '2026-11-11', recipeId: 'shakshuka', servings: 2 });
  await app.setMeal({ date: '2026-11-12', recipeId: 'chili-con-carne', servings: 2 });
  await app.applyPlan((await app.plan()).id);
  app.store.saveMeal({ date: '2026-11-14', recipeId: 'hachee', servings: 2, status: 'approved' }); // niet besteld
  clock.now = Date.parse('2026-11-15T09:00:00Z');
  assert.deepEqual(app.recipeHistory().map(h => h.recipeId), ['chili-con-carne', 'shakshuka']);
  assert.match(app.rateMeal('2026-11-11', 'up'), /favorieten/);
  assert.match(app.rateMeal('2026-11-12', 'down', 'Te veel werk'), /Te veel werk/);
  assert.deepEqual(app.favorites().map(f => [f.id, f.timesEaten]), [['shakshuka', 1]]);
  assert.deepEqual(app.disliked().map(d => [d.id, d.reason]), [['chili-con-carne', 'Te veel werk']]);
  assert.equal(app.recipeHistory()[0].rating, 'down');
  // Favoriet komt vaker terug, afgekeurd zelden: over tien voorstellen voor dezelfde dag.
  app.store.saveMeal({ date: '2026-11-16', recipeId: 'hachee', servings: 2, status: 'approved' });
  let fav = 0, bad = 0;
  for (let i = 0; i < 10; i++) {
    const r = (await app.swapMeal('2026-11-16')).recipe.id;
    fav += r === 'shakshuka' ? 1 : 0;
    bad += r === 'chili-con-carne' ? 1 : 0;
  }
  assert.equal(bad, 0);
  clock.now = Date.parse('2026-12-08T09:00:00Z'); // weken later: favoriet mag weer terugkomen
  const wish = await app.proposeMenu({ wish: 'een favoriet', replace: true });
  assert.ok(wish.days.some(d => d.meal?.id === 'shakshuka'), 'wens "favoriet" kiest een gelikt recept');
});

test('bezorgdag kiezen: net geleverd, volgende bezorging zaterdag', async () => {
  const { app } = makeApp(); // dinsdag 10 november; demo heeft momenten t/m maandag 16
  assert.equal((await app.window()).start, '2026-11-11');
  const saturday = (await app.delivery()).slots.find(s => s.windowStart.startsWith('2026-11-14'))!;
  const chosen = await app.chooseDelivery({ slotId: saturday.id });
  assert.equal(chosen.planned, '2026-11-14');
  const w = await app.window();
  assert.equal(w.start, '2026-11-14');
  assert.equal((await app.delivery()).cutOff, saturday.cutOff);
  // Verder dan de lijst: alleen een datum; nog geen moment en geen deadline.
  const later = await app.chooseDelivery({ date: '2026-11-21' });
  assert.equal(later.slot, null);
  assert.match(later.note!, /nog geen bezorgmomenten/);
  assert.equal((await app.window()).start, '2026-11-21');
  const menu = await app.proposeMenu();
  assert.ok(menu.days.filter(d => d.inOrder).every(d => d.date >= '2026-11-21'));
  app.clearDeliveryChoice();
  // Terug naar de winkel volgen: daar staat het eerder gekozen moment (zaterdag) nog in de mand.
  assert.equal((await app.window()).start, '2026-11-14');
  await assert.rejects(app.chooseDelivery({ date: '2026-11-10' }), { status: 400 });
});

test('nieuwe bezorgdatum: geplande maaltijden schuiven mee, bestelde blijven staan', async () => {
  const { app } = makeApp(); // dinsdag 10 november, bezorging eerst woensdag 11
  await app.proposeMenu();
  const before = (await app.menu()).days.filter(d => d.meal).map(d => d.meal!.id);
  await app.setMeal({ date: '2026-11-18', recipeId: 'hachee', servings: 2 }); // al gepland in de nieuwe periode
  const r = await app.chooseDelivery({ date: '2026-11-16' });
  assert.equal(r.moved, before.length);
  const after = (await app.menu()).days.filter(d => d.meal);
  assert.ok(after.every(d => d.date >= '2026-11-16'), 'niets meer vóór de bezorging');
  assert.equal(after.find(d => d.date === '2026-11-18')?.meal?.id, 'hachee');
  assert.deepEqual(after.filter(d => d.meal!.id !== 'hachee').map(d => d.meal!.id), before, 'volgorde blijft gelijk');
  assert.equal(await app.shiftMenuToWindow(), 0);
  // Automatische voorstellen in de nieuwe periode maken plaats voor verplaatste maaltijden.
  app.store.saveMeal({ date: '2026-11-15', recipeId: 'shakshuka', servings: 2, status: 'approved' });
  app.store.saveMeal({ date: '2026-11-25', recipeId: 'tomatensoep', servings: 2, status: 'proposed' });
  await app.chooseDelivery({ date: '2026-11-25' });
  const moved = (await app.menu()).days.filter(d => d.meal && d.date >= '2026-11-25');
  assert.equal(moved.find(d => d.date === '2026-11-25')?.meal?.id, 'shakshuka');
});

test('gedeeld overzicht: hergebruikt tot er iets verandert of het te oud is', async () => {
  const { app, clock } = makeApp();
  await app.proposeMenu();
  const first = await app.currentPlan();
  const again = await app.currentPlan();
  assert.equal(again.id, first.id, 'zelfde overzicht zonder wijzigingen');
  const [a, b] = await Promise.all([app.plan(), app.currentPlan()]);
  assert.ok(a.id && b.id);
  await app.addItems([{ name: 'krat pils' }]);
  const changed = await app.currentPlan();
  assert.notEqual(changed.id, again.id, 'na een wijziging opnieuw berekend');
  assert.ok(changed.lines.some(l => l.product.startsWith('Krat pils')));
  clock.now += 11 * 60_000;
  assert.notEqual((await app.currentPlan()).id, changed.id, 'na 10 minuten opnieuw berekend');
});

test('gedeeld overzicht: overslaan is lokaal en leest de mand niet opnieuw', async () => {
  const { app, clock } = makeApp();
  await app.proposeMenu();
  let reads = 0;
  const read = app.mock.readCart.bind(app.mock);
  app.mock.readCart = async () => { reads++; return read(); };
  const first = await app.currentPlan();
  assert.equal(reads, 1);
  const line = first.lines.find(l => l.add)!;
  app.declineLine(line.productId);
  const after = await app.currentPlan();
  assert.equal(reads, 1, 'overslaan: geen nieuwe lezing van de mand');
  assert.ok(after.lines.find(l => l.productId === line.productId)?.declined);
  assert.notEqual(after.id, first.id);
  await app.cart();
  assert.equal(reads, 1, 'de mandlijst gebruikt dezelfde lezing');
  await app.addItems([{ name: 'krat pils' }]);
  assert.ok((await app.currentPlan()).lines.find(l => l.productId === line.productId)?.declined, 'iets toevoegen haalt weggeveegde regels niet terug');
  // Een berekening die liep vóór een wijziging mag die wijziging niet missen.
  app.undoDecline(line.productId);
  const running = app.currentPlan();
  app.declineLine(line.productId);
  const latest = await app.currentPlan();
  await running;
  assert.ok(latest.lines.find(l => l.productId === line.productId)?.declined, 'nieuwste wijziging zit erin');
  // Doorvoeren leest vers en daarna opnieuw; het nieuwste overzicht is het bewaarde.
  const before = reads;
  await app.applyPlan(latest.id);
  assert.ok(reads > before, 'doorvoeren leest de mand vers');
  const n = reads;
  await app.currentPlan();
  assert.equal(reads, n + 1, 'na doorvoeren opnieuw gelezen');
  clock.now += 11 * 60_000;
  await app.currentPlan();
  assert.equal(reads, n + 2, 'een lezing ouder dan 10 minuten wordt ververst');
});

test('voorraad opnieuw opbouwen uit de laatste levering', async () => {
  const { app, clock } = makeApp();
  app.setShopMode('picnic');
  app.updatePantry([{ name: 'eieren', amount: 0 }, { name: 'rijst', amount: 0 }, { name: 'melk', amount: 500, minimum: 2000 }]);
  app.store.set('picnicHistory', { syncedAt: '', deliveries: [
    { id: 'd2', date: '2026-11-10', totalCents: 0, orders: [{ id: 'o', orderedAt: '', items: [
      { productId: 'x1', name: 'Picnic scharreleieren', pack: '12 stuks M', quantity: 2 },
      { productId: 'x2', name: 'Picnic volle melk houdbaar', pack: '1 liter', quantity: 6 },
      { productId: 'x3', name: 'Bbq rice cookies', pack: '100 gram', quantity: 1 },
    ] }] },
    { id: 'd1', date: '2026-11-03', totalCents: 0, orders: [{ id: 'o', orderedAt: '', items: [{ productId: 'x9', name: 'Basmatirijst', pack: '1 kilo', quantity: 1 }] }] },
  ] });
  clock.now = Date.parse('2026-11-12T09:00:00Z');
  app.store.saveMeal({ date: '2026-11-11', recipeId: 'shakshuka', servings: 2, status: 'approved' });
  const r = app.rebuildPantryFromLastDelivery();
  assert.equal(r.delivery, '2026-11-10');
  assert.deepEqual(r.unmatched, ['1× Bbq rice cookies']);
  assert.equal(r.mealsSubtracted, 1);
  const eggsUsed = app.catalog.recipe('shakshuka')!.ingredients.find(i => i.key === 'ei')!.amount * 2;
  assert.equal(app.store.pantryItem('ei')!.amount, 24 - eggsUsed);
  assert.equal(app.store.pantryItem('melk')!.amount, 6000);
  assert.equal(app.store.pantryItem('melk')!.minimum, 2000, 'minimum blijft');
  assert.equal(app.store.pantryItem('rijst')!.amount, null, 'niet in de levering → onbekend');
});

test('voorraad: wat al in de mand ligt telt niet als tekort', async () => {
  const { app } = makeApp();
  await app.setMeal({ date: '2026-11-11', recipeId: 'shakshuka', servings: 2 });
  const before = (await app.pantryStatus()).items.filter(i => i.neededThisOrder > 0);
  assert.ok(before.length && before.every(i => i.inCart === 0), 'nog niets in de mand');
  await app.applyPlan((await app.plan()).id);
  await app.currentPlan();
  const after = (await app.pantryStatus()).items.filter(i => i.neededThisOrder > 0);
  const short = after.filter(i => (i.amount ?? 0) + i.inCart < i.neededThisOrder);
  assert.deepEqual(short.map(i => i.key), [], 'alles ligt nu in de mand');
});
