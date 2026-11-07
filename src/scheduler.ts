import { cutoffNotice, ratingNotice } from './actions.ts';
import type { Notice, Weekmand } from './app.ts';
import { addDays, localDate, weekday, zonedTime } from './time.ts';

export type StoredNotice = Notice & { at: string };

/**
 * Bewaar meldingen voor de webapp en stuur ze door naar ntfy (optioneel, alleen tekst en een
 * link: nooit tokens in een bericht via een externe dienst). Telegram en Home Assistant
 * abonneren zich zelf op dezelfde 'notify'-gebeurtenis.
 */
export function wireNotices(app: Weekmand, publicUrl?: string) {
  app.events.on('notify', (notice: Notice) => {
    app.store.update<StoredNotice[]>('notices', [], list => [{ ...notice, at: new Date(app.now()).toISOString() }, ...list].slice(0, 20));
    const ntfy = process.env.NTFY_URL;
    if (ntfy) {
      fetch(ntfy, {
        method: 'POST', body: notice.text, signal: AbortSignal.timeout(10_000),
        headers: { Title: 'Weekmand', Tags: 'shopping_cart', ...(publicUrl ? { Click: publicUrl } : {}), ...(process.env.NTFY_TOKEN ? { Authorization: 'Bearer ' + process.env.NTFY_TOKEN } : {}) },
      }).catch(error => console.error('ntfy:', (error as Error).message));
    }
  });
}

/**
 * Elke minuut: gegeten maaltijden van de voorraad afhalen, vóór de wijzigdeadline het
 * huishouden een seintje geven, Picnic-leveringen ophalen en wekelijks de database opruimen.
 */
export class Scheduler {
  #app: Weekmand;
  #timer: NodeJS.Timeout | null = null;
  #busy = false;
  warnHours: number;

  constructor(app: Weekmand, warnHours = Number(process.env.CUTOFF_WARNING_HOURS || 4)) {
    this.#app = app;
    this.warnHours = warnHours > 0 && warnHours < 48 ? warnHours : 4;
  }

  start() {
    setTimeout(() => void this.tick(), 15_000).unref();
    this.#timer = setInterval(() => void this.tick(), 60_000);
    this.#timer.unref();
  }
  stop() { if (this.#timer) clearInterval(this.#timer); }

  async tick() {
    if (this.#busy) return;
    this.#busy = true;
    const app = this.#app;
    try {
      app.consumePastMeals();
      await this.#cutoff();
      // 's Ochtends na een bestelde maaltijd: hoe was het? (één keer per maaltijd)
      const today = localDate(app.now());
      if (process.env.RATE_PROMPTS !== 'off' && app.now() >= zonedTime(today, 10)) {
        const notice = ratingNotice(app, addDays(today, -1));
        if (notice) app.notify(notice);
      }
      if (app.shopMode === 'picnic' && app.picnic.ready()) {
        const last = app.store.get<number>('lastImport', 0);
        if (app.now() - last > 6 * 36e5) {
          app.store.set('lastImport', app.now());
          await app.importHistory().catch(error => console.error('Picnic-import:', error.message));
          await app.importPicnicRecipes().catch(error => console.error('Picnic-recepten:', error.message));
        }
        // Elk uur maten en aanbiedingsprijzen bijwerken, zodat het overzicht zelf snel blijft.
        if (app.now() - app.store.get<number>('lastPriceRefresh', 0) > 36e5) {
          app.store.set('lastPriceRefresh', app.now());
          await app.refreshPrices().catch(error => console.error('Prijzen:', error.message));
        }
      }
      if (weekday(today) === 0 && app.store.get<string>('lastMaintenance', '') !== today && new Date(app.now()).getUTCHours() >= 2) {
        app.store.set('lastMaintenance', today);
        app.store.maintain(new Date(app.now() - 90 * 86_400_000).toISOString());
      }
    } catch (error) {
      console.error('Planner:', (error as Error).message);
    } finally {
      this.#busy = false;
    }
  }

  async #cutoff() {
    const app = this.#app;
    // Alleen bij de echte Picnic: de demowinkel heeft elke dag een deadline. Testen kan via de webapp.
    if (app.shopMode !== 'picnic' || !app.shop.ready()) return;
    const delivery = await app.delivery();
    const slot = delivery.next;
    if (!slot || delivery.hoursLeft === null) return;
    if (delivery.hoursLeft > this.warnHours || delivery.hoursLeft <= 0.05) return;
    if (app.store.wasNotified('cutoff-' + slot.id)) return;
    const notice = await cutoffNotice(app);
    if (notice) app.notify(notice);
  }
}
