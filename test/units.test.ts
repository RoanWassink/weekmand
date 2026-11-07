import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, isoWeek, localDate, previousWeek, resolveDay, weekday, zonedTime } from '../src/time.ts';
import { convert, formatAmount, packAmount, parseUnitQuantity, toBase } from '../src/units.ts';

test('Picnic-verpakkingen worden omgerekend naar basiseenheden', () => {
  assert.deepEqual(parseUnitQuantity('500 gram'), { g: 500 });
  assert.deepEqual(parseUnitQuantity('1,5 liter'), { ml: 1500 });
  assert.deepEqual(parseUnitQuantity('6 x 33 cl'), { ml: 1980, st: 6 });
  assert.deepEqual(parseUnitQuantity('Krat 24 x 30 cl'), { ml: 7200, st: 24 });
  assert.deepEqual(parseUnitQuantity('3 stuks (ca. 450 gram)'), { st: 3, g: 450 });
  assert.deepEqual(parseUnitQuantity('ca. 1 kilo'), { g: 1000 });
  assert.deepEqual(parseUnitQuantity('per stuk'), { st: 1 });
  assert.deepEqual(parseUnitQuantity('4 x 125 gram'), { g: 500, st: 4 });
});

test('omrekenen tussen stuks en gram gebruikt het stukgewicht', () => {
  const tomaat = { unit: 'st' as const, pieceGrams: 100 };
  assert.equal(convert(300, 'g', tomaat), 3);
  assert.equal(packAmount('500 gram', tomaat), 5);
  assert.equal(packAmount('6 stuks', tomaat), 6);
  assert.equal(packAmount('1 liter', { unit: 'ml' }), 1000);
  assert.equal(packAmount('250 gram', { unit: 'st' }), null);
  assert.deepEqual(toBase(2, 'el'), { amount: 30, unit: 'ml' });
  assert.equal(formatAmount(1500, 'g'), '1,5 kg');
  assert.equal(formatAmount(1, 'st'), '1 stuk');
});

test('datums in Nederlandse tijd, ook rond zomertijd', () => {
  assert.equal(localDate(Date.parse('2026-11-07T23:30:00Z')), '2026-11-08');
  assert.equal(new Date(zonedTime('2026-11-10', 22)).toISOString(), '2026-11-10T21:00:00.000Z');
  assert.equal(new Date(zonedTime('2026-07-10', 22)).toISOString(), '2026-07-10T20:00:00.000Z');
  assert.equal(new Date(zonedTime('2026-03-29', 12)).toISOString(), '2026-03-29T10:00:00.000Z');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekday('2026-11-13'), 5);
  assert.equal(isoWeek('2026-11-10'), '2026-W46');
  assert.equal(previousWeek('2026-W46'), '2026-W45');
  assert.equal(previousWeek('2027-W01'), '2026-W53');
});

test('dagen in gewone taal', () => {
  const today = '2026-11-10'; // dinsdag
  assert.equal(resolveDay('vrijdag', today), '2026-11-13');
  assert.equal(resolveDay('dinsdag', today), '2026-11-10');
  assert.equal(resolveDay('maandag', today), '2026-11-16');
  assert.equal(resolveDay('morgen', today), '2026-11-11');
  assert.equal(resolveDay('vr', today), '2026-11-13');
  assert.equal(resolveDay('14-11', today), '2026-11-14');
  assert.equal(resolveDay('2026-12-01', today), '2026-12-01');
  assert.equal(resolveDay('ooit', today), null);
});

test('productnamen van Picnic herkennen als ingrediënt', async () => {
  const { Store } = await import('../src/db.ts');
  const { Catalog } = await import('../src/catalog.ts');
  const c = new Catalog(new Store(':memory:'));
  const cases: [string, string | undefined][] = [
    ['Picnic scharreleieren', 'ei'], ["'t Slagershuys kipdijfilets", 'kippendij'], ['De Kaaskamer jong belegen kaas 48+ plakken', 'jong-belegen-plakken'],
    ['Picnic cheddar geraspte kaas', 'geraspte-kaas'], ['Botersla', 'sla'], ["Zoete puntpaprika's", 'paprika'], ['Picnic gezeefde tomaten met dop', 'passata'],
    ['Jongens van de Klei kruimige aardappelen', 'aardappelen'], ['pindakaas', 'pindakaas'], ['krat bier', 'pils'], ['Bbq rice cookies', undefined],
  ];
  for (const [name, key] of cases) assert.equal(c.resolve(name)?.key, key, name);
});
