import { Weekmand } from '../src/app.ts';
import { Store } from '../src/db.ts';
import { Secrets } from '../src/secrets.ts';

/** Dinsdag 10 november 2026, 10:00 Nederlandse tijd. */
export const tuesday = Date.parse('2026-11-10T09:00:00Z');

export function makeApp(now = tuesday) {
  const clock = { now };
  const app = new Weekmand({ store: new Store(':memory:'), secrets: new Secrets(null), now: () => clock.now });
  return { app, clock };
}
