import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlbertHeijn } from '../src/ah.ts';
import { Weekmand } from '../src/app.ts';
import { Store } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';
import { tuesday } from './helpers.ts';

/** Een herstart: een nieuwe Weekmand op dezelfde database. */
function restartable() {
  const store = new Store(':memory:');
  const secrets = new Secrets(null);
  const clock = { now: tuesday };
  const start = (ah?: AlbertHeijn) => {
    const app = new Weekmand({ store, secrets, now: () => clock.now, ...(ah ? { ah } : {}) });
    let reads = 0;
    const read = app.mock.readCart.bind(app.mock);
    app.mock.readCart = async () => { reads++; return read(); };
    return { app, reads: () => reads };
  };
  return { store, secrets, clock, start };
}

test('herstart: de laatste mandberekening blijft staan (tot tien minuten, of tot er iets verandert)', async () => {
  const { clock, start } = restartable();
  const first = start();
  await first.app.proposeMenu();
  const plan = await first.app.currentPlan();
  assert.equal(first.reads(), 1);

  const second = start();
  const again = await second.app.currentPlan();
  assert.equal(again.id, plan.id, 'zelfde overzicht na de herstart');
  assert.equal(second.reads(), 0, 'de Picnic-mand hoeft niet opnieuw gelezen te worden');
  assert.ok((await second.app.pantryStatus()).items.length, 'voorraad werkt meteen');

  // Een wijziging wist de bewaarde berekening; een volgende herstart rekent opnieuw.
  second.app.declineLine(plan.lines.find(l => l.add)!.productId);
  const third = start();
  assert.notEqual((await third.app.currentPlan()).id, plan.id);
  assert.equal(third.reads(), 1);

  // Ouder dan twaalf uur: opnieuw lezen.
  clock.now += 12 * 36e5 + 60_000;
  const fourth = start();
  await fourth.app.currentPlan();
  assert.equal(fourth.reads(), 1);
});

test('herstart: na een weigering van AH blijft Weekmand twaalf uur weg, ook na een herstart', async () => {
  const { secrets, clock, start } = restartable();
  secrets.set('ah', { accessToken: 'a', refreshToken: 'r', expiresAt: tuesday + 36e5, linkedAt: '2026-11-01T00:00:00Z' });
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response('{}', { status: 429 }); }) as unknown as typeof fetch;
  const first = start(new AlbertHeijn(secrets, fetcher, () => clock.now));
  await assert.rejects(first.app.ah.list(), { status: 503 });
  assert.equal(calls, 1);
  const second = start(new AlbertHeijn(secrets, fetcher, () => clock.now));
  await assert.rejects(second.app.ah.list(), /later vanzelf opnieuw/);
  assert.equal(calls, 1, 'geen nieuw verzoek naar AH');
  clock.now += 13 * 36e5;
  await assert.rejects(second.app.ah.list(), { status: 503 });
  assert.equal(calls, 2, 'na twaalf uur mag het weer');
});
