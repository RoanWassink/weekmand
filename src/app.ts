import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Catalog, normalize } from './catalog.ts';
import type { Feedback, ProductLink, Store } from './db.ts';
import { check, Problem } from './errors.ts';
import { detectHabits, ruleId } from './learn.ts';
import type { PicnicHistory } from './picnic-history.ts';
import { allowedOn, allowedRecipes, buildPlan, parseWish, portions, proposeMenu, recipeCost, stockState } from './planner.ts';
import type { Extra, OrderOptions, Plan, PlanMeal, ProductOption, Regular } from './planner.ts';
import type { Secrets } from './secrets.ts';
import { applyChange, MockShop, PicnicShop, quantityOf } from './shop.ts';
import type { Shop } from './shop.ts';
import { addDays, dayName, isoWeek, localDate, weekday, weekdays } from './time.ts';
import type { AvoidRule, BaseUnit, DeliverySlot, Household, IngredientDef, Meal, PantryItem, Recipe, ShopCart, ShopProduct } from './types.ts';
import { convert, formatAmount, packAmount, parseUnitQuantity, toBase } from './units.ts';
import { importPicnicRecipes } from './picnic-recipes.ts';

export const defaultHousehold: Household = { adults: 2, children: 0, toddlers: 0, budget: 80, vegetarian: false, exclude: [], days: 5 };
type Ledger = { cartId: string; lines: Record<string, number> };
type StoredReview = { id: string; createdAt: number; plan: Plan; done?: boolean };
export type Notice = { text: string; buttons?: { label: string; data: string }[]; key?: string };

const day = 86_400_000;

/** Productnaam zonder maat: 'Kippendijfilet 800 g' en 'Kippendijfilet 400 g' zijn hetzelfde product. */
export function baseName(name: string) {
  const sizeWords = /\b(x|g|gr|gram|kg|kilo|ml|cl|l|liter|st|stuk|stuks|ca|xl|pack|voordeelverpakking|voordeelpak|grootverpakking|familieverpakking)\b/g;
  return normalize(name.replace(/\d+(?:[.,]\d+)?/g, ' ')).replace(sizeWords, ' ').replace(/\s+/g, ' ').trim();
}

export class Weekmand {
  readonly store: Store;
  readonly secrets: Secrets;
  readonly catalog: Catalog;
  readonly mock: MockShop;
  readonly picnic: PicnicShop;
  readonly events = new EventEmitter();
  now: () => number;
  #slots: { at: number; slots: DeliverySlot[] } | null = null;
  #searchCache = new Map<string, ShopProduct>();
  #generation = 0;
  #planCache: { plan: Awaited<ReturnType<Weekmand['plan']>>; at: number; generation: number } | null = null;
  #planning: Promise<Awaited<ReturnType<Weekmand['plan']>>> | null = null;
  /** Pauze tussen automatische Picnic-zoekopdrachten (ms). */
  searchPause = 1500;

  constructor(options: { store: Store; secrets: Secrets; picnic?: PicnicShop; now?: () => number }) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.now = options.now ?? Date.now;
    this.catalog = new Catalog(this.store);
    this.mock = new MockShop(this.store, () => this.catalog.ingredients());
    this.picnic = options.picnic ?? new PicnicShop(this.secrets);
    this.picnic.onExpired = () => this.notify({ text: 'Je Picnic-sessie is verlopen. Meld je opnieuw aan in Weekmand (Instellingen → Picnic) om automatische aanvullingen te laten werken.', key: 'picnic-expired-' + localDate(this.now()) });
    this.events.setMaxListeners(20);
    // Elke wijziging (menu, lijst, voorraad, mand) maakt het gedeelde overzicht verouderd.
    this.events.on('change', () => { this.#generation++; });
    this.#migrateV1();
  }

  notify(notice: Notice) {
    if (notice.key) {
      if (this.store.wasNotified(notice.key)) return;
      this.store.markNotified(notice.key);
    }
    this.events.emit('notify', notice);
  }
  changed() { this.events.emit('change'); }

  // ───────────── Instellingen ─────────────

  get household(): Household { return { ...defaultHousehold, ...this.store.get<Partial<Household>>('household', {}) }; }
  setHousehold(input: Partial<Household>) {
    const h = { ...this.household };
    const int = (v: unknown, min: number, max: number, label: string) => {
      check(typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max, `Ongeldige waarde voor ${label}.`);
      return v;
    };
    if (input.adults !== undefined) h.adults = int(input.adults, 1, 20, 'volwassenen');
    if (input.children !== undefined) h.children = int(input.children, 0, 20, 'kinderen');
    if (input.toddlers !== undefined) h.toddlers = int(input.toddlers, 0, 20, 'dreumesen');
    if (input.days !== undefined) h.days = int(input.days, 1, 7, 'avondmaaltijden');
    if (input.budget !== undefined) {
      check(typeof input.budget === 'number' && input.budget >= 1 && input.budget <= 2000, 'Ongeldig budget.');
      h.budget = input.budget;
    }
    if (input.vegetarian !== undefined) h.vegetarian = !!input.vegetarian;
    if (input.exclude !== undefined) {
      check(Array.isArray(input.exclude) && input.exclude.length <= 50, 'Ongeldige uitsluitingen.');
      h.exclude = [...new Set(input.exclude.map(x => this.catalog.resolve(String(x))?.key ?? String(x)).filter(k => this.catalog.ingredient(k)))];
    }
    this.store.set('household', h);
    this.changed();
    return h;
  }
  get avoid(): AvoidRule[] { return this.store.get<AvoidRule[]>('avoid', []); }
  removeAvoidRule(index: number) {
    this.store.update<AvoidRule[]>('avoid', [], rules => rules.filter((_, i) => i !== index));
  }

  get shopMode(): 'mock' | 'picnic' { return this.store.get<'mock' | 'picnic'>('shopMode', 'mock'); }
  setShopMode(mode: 'mock' | 'picnic') {
    check(mode === 'mock' || mode === 'picnic', 'Kies demo of picnic.');
    this.store.set('shopMode', mode);
    this.#slots = null;
    this.changed();
  }
  get shop(): Shop { return this.shopMode === 'picnic' ? this.picnic : this.mock; }
  #requireShop() {
    if (!this.shop.ready()) throw new Problem(409, 'Meld je eerst aan bij Picnic (Instellingen → Picnic), of schakel naar de demowinkel.');
    return this.shop;
  }

  // ───────────── Bezorging en planperiode ─────────────

  async slots(force = false): Promise<DeliverySlot[]> {
    if (!this.shop.ready()) return [];
    const age = this.#slots ? this.now() - this.#slots.at : Infinity;
    if (!force && age >= 0 && age < 10 * 60_000) return this.#slots!.slots;
    const slots = this.shop === this.mock ? await this.mock.slots(this.now()) : await this.shop.slots();
    this.#slots = { at: this.now(), slots };
    return slots;
  }

  async delivery() {
    let slots: DeliverySlot[] = [];
    let error: string | null = null;
    try { slots = await this.slots(); } catch (e) { error = e instanceof Problem ? e.message : 'Bezorgmomenten niet beschikbaar.'; }
    const now = this.now();
    const open = (s: DeliverySlot) => s.available && Date.parse(s.cutOff) > now;
    const selected = slots.find(s => s.selected && Date.parse(s.cutOff) > now) ?? null;
    const choice = this.deliveryChoice;
    let next: DeliverySlot | null;
    if (choice) {
      // Zelf gekozen bezorgdag: het gekozen moment, anders het geselecteerde of eerste moment op die dag.
      // Heeft Picnic die dag nog niet vrijgegeven, dan is er nog geen moment (en dus nog geen deadline).
      const onDay = slots.filter(s => open(s) && localDate(Date.parse(s.windowStart)) === choice.date);
      next = onDay.find(s => s.id === choice.slotId) ?? onDay.find(s => s.selected) ?? onDay[0] ?? null;
    } else {
      next = selected ?? slots.find(open) ?? null;
    }
    return {
      selected, next, error, planned: choice?.date ?? null,
      slots: slots.filter(open).slice(0, 120),
      cutOff: next?.cutOff ?? null,
      hoursLeft: next ? Math.round((Date.parse(next.cutOff) - now) / 36e5 * 10) / 10 : null,
    };
  }

  /** De zelf gekozen bezorgdag (en eventueel moment); vervalt vanzelf als de dag voorbij is. */
  get deliveryChoice(): { date: string; slotId?: string } | null {
    const choice = this.store.get<{ date: string; slotId?: string } | null>('deliveryChoice', null);
    return choice && choice.date >= localDate(this.now()) ? choice : null;
  }

  /**
   * Kies de volgende bezorging: een moment uit de lijst (wordt bij Picnic ook in de mand gezet) of
   * alleen een datum, als Picnic die dag nog niet vrijgeeft. Zonder keuze volgt Weekmand Picnic.
   */
  async chooseDelivery(input: { slotId?: string; date?: string }) {
    let warning: string | undefined;
    if (input.slotId) {
      const slot = (await this.slots(true)).find(s => s.id === input.slotId);
      check(slot && slot.available && Date.parse(slot.cutOff) > this.now(), 'Dit bezorgmoment is niet (meer) beschikbaar.');
      if (this.shop === this.mock) this.mock.selectSlot(slot.id);
      else {
        try { await this.picnic.selectSlot(slot.id); }
        catch (error) { warning = 'Weekmand plant vanaf deze dag, maar kon het moment niet in Picnic zetten: kies het in de Picnic-app. (' + (error as Error).message + ')'; }
      }
      this.store.set('deliveryChoice', { date: localDate(Date.parse(slot.windowStart)), slotId: slot.id });
    } else {
      const today = localDate(this.now());
      check(typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date), 'Kies een datum.');
      check(input.date > today && input.date <= addDays(today, 60), 'Kies een dag vanaf morgen, binnen twee maanden.');
      this.store.set('deliveryChoice', { date: input.date });
    }
    this.#slots = null;
    const moved = await this.shiftMenuToWindow();
    this.changed();
    const d = await this.delivery();
    return { planned: d.planned, slot: d.next, cutOff: d.cutOff, moved, ...(warning ? { warning } : {}),
      note: d.next ? undefined : 'Picnic heeft voor die dag nog geen bezorgmomenten vrijgegeven. Weekmand plant er alvast vanaf en pakt het moment zodra het beschikbaar is.' };
  }

  /** Geplande maaltijden vóór de bezorgdag (nog niet besteld) die naar de bezorgperiode kunnen. */
  async mealsBeforeWindow() {
    const w = await this.window();
    const today = localDate(this.now());
    return this.store.meals(today, addDays(w.start, -1)).filter(m => !m.ordered);
  }

  /**
   * Schuif die maaltijden mee naar de bezorgperiode, met behoud van volgorde en onderlinge
   * afstand waar mogelijk. Een dag met een gekozen gerecht wordt overgeslagen; een automatisch voorstel
   * maakt plaats. Geeft het aantal verplaatste terug.
   */
  async shiftMenuToWindow() {
    const meals = await this.mealsBeforeWindow();
    if (!meals.length) return 0;
    const w = await this.window();
    const days = Array.from({ length: 7 }, (_, i) => addDays(w.start, i));
    // Gekozen of goedgekeurde maaltijden in de nieuwe periode blijven staan; automatische voorstellen maken plaats.
    const taken = new Set(this.store.meals(w.start, w.end).filter(m => m.status === 'approved' || m.ordered).map(m => m.date));
    const first = meals[0].date;
    let moved = 0;
    this.store.tx(() => {
      for (const meal of meals) {
        const offset = Math.round((Date.parse(meal.date) - Date.parse(first)) / day);
        const wanted = addDays(w.start, offset);
        const target = [wanted, ...days].find(d => d >= wanted && d <= w.end && !taken.has(d)) ?? days.find(d => !taken.has(d));
        if (!target) continue;
        this.store.deleteMeal(meal.date);
        const { consumed: _c, ordered: _o, ...rest } = meal as typeof meal & { consumed?: boolean; ordered?: boolean };
        this.store.saveMeal({ ...rest, date: target });
        taken.add(target);
        moved++;
      }
    });
    this.changed();
    return moved;
  }

  clearDeliveryChoice() {
    this.store.set('deliveryChoice', null);
    this.#slots = null;
    this.changed();
  }

  /** Oude naam, voor de demoselectie in de webapp. */
  selectSlot(id: string) { return this.chooseDelivery({ slotId: id }); }

  /** De dagen waarvoor deze bestelling de avondmaaltijden levert. */
  async window() {
    const { next } = await this.delivery();
    const today = localDate(this.now());
    const deliveryDate = next ? localDate(Date.parse(next.windowStart)) : this.deliveryChoice?.date ?? addDays(today, 1);
    const start = deliveryDate > today ? deliveryDate : addDays(today, 1);
    const days = this.household.days;
    // Voorstellen vullen `days` avonden; de bestelling dekt alle geplande maaltijden in de week vanaf de bezorging.
    return { start, end: addDays(start, 6), dates: Array.from({ length: days }, (_, i) => addDays(start, i)), slot: next };
  }

  // ───────────── Menu ─────────────

  #recipeView(r: Recipe) { return { id: r.id, name: r.name, tags: r.tags, minutes: r.minutes, source: r.source }; }

  async menu() {
    const w = await this.window();
    const today = localDate(this.now());
    const meals = this.store.meals(today, w.end);
    const byDate = new Map(meals.map(m => [m.date, m]));
    const dates = [...new Set([...meals.map(m => m.date), ...w.dates])].sort();
    return {
      window: { start: w.start, end: w.end, deliverySlot: w.slot },
      days: dates.map(date => {
        const meal = byDate.get(date);
        const recipe = meal ? this.catalog.recipe(meal.recipeId) : undefined;
        return {
          date, day: dayName(date), inOrder: date >= w.start && date <= w.end,
          meal: meal && recipe ? { ...this.#recipeView(recipe), servings: meal.servings, status: meal.status, note: meal.note ?? null } : null,
        };
      }),
    };
  }

  #options(key: string): ProductOption[] {
    const def = this.catalog.ingredient(key);
    if (!def) return [];
    if (this.shopMode === 'picnic') {
      const link = this.store.link(key);
      if (!link) return [];
      const variants = this.variants(key);
      return variants.length ? variants : [{ id: link.productId, name: link.name, unitQuantity: link.unitQuantity, cents: link.cents, packAmount: link.packAmount }];
    }
    const products = new Map(this.mock.products().map(p => [p.id, p]));
    return def.packs.map(p => ({ id: p.id, name: p.name, unitQuantity: products.get(p.id)?.unitQuantity ?? '', cents: p.cents, packAmount: p.amount }));
  }
  /** Voor kostenramingen: de echte koppeling als die er is, anders de democatalogus. */
  #costOptions(key: string): ProductOption[] {
    const link = this.store.link(key);
    if (link) return [{ id: link.productId, name: link.name, unitQuantity: link.unitQuantity, cents: link.cents, packAmount: link.packAmount }];
    const def = this.catalog.ingredient(key);
    return def ? def.packs.map(p => ({ id: p.id, name: p.name, unitQuantity: '', cents: p.cents, packAmount: p.amount })) : [];
  }
  recipeCost(recipe: Recipe) { return recipeCost(recipe, k => this.#costOptions(k), k => this.catalog.ingredient(k)); }

  /** Stel een weekmenu voor. Goedgekeurde of handmatig gekozen maaltijden blijven staan. */
  async proposeMenu(input: { wish?: string; days?: number; replace?: boolean } = {}) {
    if (input.days !== undefined) this.setHousehold({ days: input.days });
    const w = await this.window();
    const existing = this.store.meals(w.dates[0], w.dates.at(-1)!);
    const fixed: Record<string, string> = {};
    for (const m of existing) if (m.status === 'approved' || !input.replace) fixed[m.date] = m.recipeId;
    const recent = this.store.recentRecipeIds(addDays(w.start, -14), w.start);
    const wish = parseWish(input.wish ?? '', word => word.length > 2 ? this.catalog.resolve(word)?.key : undefined);
    const chosen = proposeMenu({
      recipes: this.#withFavorites(this.catalog.recipes()), dates: w.dates, fixed, household: this.household, avoid: this.avoid, recent, wish,
      costPerPortion: r => this.recipeCost(r), ingredient: k => this.catalog.ingredient(k), seed: randomUUID(), bonus: r => this.#ratingBonus(r, recent),
    });
    const servings = portions(this.household);
    this.store.tx(() => {
      for (const [date, recipeId] of Object.entries(chosen)) {
        if (fixed[date]) continue;
        this.store.saveMeal({ date, recipeId, servings, status: 'proposed' });
      }
    });
    this.changed();
    return this.menu();
  }

  #reject(meal: Meal) {
    if (meal.status !== 'proposed') return;
    const recipe = this.catalog.recipe(meal.recipeId);
    this.#feedback({ at: new Date(this.now()).toISOString(), kind: 'meal-rejected', recipeId: meal.recipeId, tags: recipe?.tags ?? [], weekday: weekday(meal.date), week: isoWeek(meal.date) });
  }

  #feedback(f: Feedback) {
    this.store.addFeedback(f);
    const known = new Set(this.store.suggestions().map(s => s.id));
    const found = detectHabits(this.store.feedback(new Date(this.now() - 42 * day).toISOString()), {
      recipe: id => this.catalog.recipe(id)?.name, ingredient: key => this.catalog.ingredient(key)?.name,
    }, known);
    for (const s of found.slice(0, 1)) {
      this.store.saveSuggestion(s);
      this.notify({ text: s.text, buttons: [{ label: 'Ja, vermijden', data: `sugg:${s.id}:yes` }, { label: 'Nee', data: `sugg:${s.id}:no` }], key: 'sugg-' + s.id });
    }
  }

  /** Zet een gerecht op een dag. `day` mag 'vrijdag', 'morgen' of een datum zijn. */
  async setMeal(input: { date: string; recipeId: string; servings?: number; note?: string }) {
    const recipe = this.catalog.recipe(input.recipeId);
    check(recipe, 'Onbekend recept: ' + input.recipeId);
    check(/^\d{4}-\d{2}-\d{2}$/.test(input.date) && input.date >= localDate(this.now()), 'Kies vandaag of een dag in de toekomst.');
    const servings = input.servings ?? portions(this.household);
    check(typeof servings === 'number' && servings > 0 && servings <= 40, 'Ongeldig aantal porties.');
    const old = this.store.meal(input.date);
    if (old && old.recipeId !== recipe.id) this.#reject(old);
    this.store.saveMeal({ date: input.date, recipeId: recipe.id, servings, status: 'approved', ...(input.note ? { note: input.note.slice(0, 200) } : {}) });
    this.changed();
    const w = await this.window();
    const warning = input.date < w.start ? `Let op: ${dayName(input.date)} valt vóór de volgende bezorging (${dayName(w.start)} ${w.start}); de boodschappen hiervoor zitten niet in deze bestelling.`
      : input.date > w.end ? `Deze dag valt na deze bestelling; de boodschappen komen in een volgende bestelling.` : undefined;
    return { date: input.date, day: dayName(input.date), recipe: this.#recipeView(recipe), servings, ...(warning ? { warning } : {}) };
  }

  /** Vervang een gerecht door een ander voorstel ("liever iets anders"). */
  async swapMeal(date: string, wish = '') {
    const meal = this.store.meal(date);
    check(meal, 'Op die dag staat geen maaltijd.');
    this.#reject(meal);
    const w = await this.window();
    const others = this.store.meals(addDays(date, -7), addDays(date, 7)).filter(m => m.date !== date).map(m => m.recipeId);
    const wishParsed = parseWish(wish, word => word.length > 2 ? this.catalog.resolve(word)?.key : undefined);
    const fixed = Object.fromEntries(w.dates.filter(d => d !== date).flatMap(d => {
      const m = this.store.meal(d);
      return m ? [[d, m.recipeId]] : [];
    }));
    const chosen = proposeMenu({
      recipes: this.#withFavorites(this.catalog.recipes().filter(r => r.id !== meal.recipeId)), dates: [date], fixed, household: this.household, avoid: this.avoid,
      recent: [...others, ...this.store.recentRecipeIds(addDays(date, -14), date)], wish: wishParsed,
      costPerPortion: r => this.recipeCost(r), ingredient: k => this.catalog.ingredient(k), seed: randomUUID(), bonus: r => this.#ratingBonus(r, others),
    });
    const recipeId = chosen[date];
    check(recipeId, 'Geen ander passend recept gevonden.');
    this.store.saveMeal({ date, recipeId, servings: meal.servings, status: 'proposed' });
    this.changed();
    return { date, day: dayName(date), recipe: this.#recipeView(this.catalog.recipe(recipeId)!) };
  }

  removeMeal(date: string) {
    const meal = this.store.meal(date);
    check(meal, 'Op die dag staat geen maaltijd.');
    this.#reject(meal);
    this.store.deleteMeal(date);
    this.changed();
  }

  async approveMenu() {
    const w = await this.window();
    let count = 0;
    this.store.tx(() => {
      for (const m of this.store.meals(localDate(this.now()), w.end)) {
        if (m.status !== 'proposed') continue;
        this.store.saveMeal({ ...m, status: 'approved' });
        count++;
      }
    });
    this.changed();
    return count;
  }

  recipeDetail(id: string, servings?: number) {
    const r = this.catalog.recipe(id);
    check(r, 'Onbekend recept.');
    const n = servings ?? portions(this.household);
    return {
      ...this.#recipeView(r), steps: r.steps, servings: n, costPerPortionCents: this.recipeCost(r),
      ingredients: r.ingredients.map(i => {
        const def = this.catalog.ingredient(i.key);
        return { key: i.key, name: def?.name ?? i.key, amount: i.amount * n, unit: i.unit, text: formatAmount(i.amount * n, i.unit) + ' ' + (def?.name.toLowerCase() ?? i.key) };
      }),
    };
  }

  listRecipes(query = '', tag = '') {
    const allowed = new Set(allowedRecipes(this.catalog.recipes(), this.household, this.avoid).map(r => r.id));
    // Laatst gegeten (bestelde maaltijd die voorbij is) en laatst besteld (ook komende bestelde maaltijden).
    const ordered = this.store.orderedMeals('9999-12-31', 1000);
    const today = localDate(this.now());
    const picnic = this.store.get<Record<string, { labels: string[]; recipeId: string }>>('picnicRecipes', {});
    const labels = new Map(Object.values(picnic).map(p => [p.recipeId, p.labels]));
    const ratings = this.#latestRatings();
    return this.catalog.searchRecipes(query, tag).map(r => {
      const mine = ordered.filter(m => m.recipeId === r.id);
      return {
        ...this.#recipeView(r), allowed: allowed.has(r.id), costPerPortionCents: this.recipeCost(r),
        lastEaten: mine.find(m => m.date <= today)?.date ?? null, lastOrdered: mine[0]?.date ?? null,
        picnicLabels: labels.get(r.id) ?? [], rating: ratings.get(r.id)?.rating === 1 ? 'up' : ratings.get(r.id)?.rating === -1 ? 'down' : null,
      };
    });
  }

  // ───────────── Voorraad ─────────────

  /** Trek gegeten maaltijden af van de geschatte voorraad (eenmalig per maaltijd). */
  consumePastMeals() {
    const today = localDate(this.now());
    for (const meal of this.store.unconsumedBefore(today)) {
      const recipe = this.catalog.recipe(meal.recipeId);
      this.store.tx(() => {
        for (const i of recipe?.ingredients ?? []) {
          const item = this.store.pantryItem(i.key);
          if (!item || item.amount === null) continue;
          this.store.savePantry({ ...item, amount: Math.max(0, item.amount - i.amount * meal.servings) });
        }
        this.store.markConsumed(meal.date);
      });
    }
  }

  async pantryStatus() {
    this.consumePastMeals();
    const w = await this.window().catch(() => null);
    const planned: PlanMeal[] = w ? this.store.meals(w.start, w.end).flatMap(m => {
      const recipe = this.catalog.recipe(m.recipeId);
      return recipe ? [{ date: m.date, recipe, servings: m.servings }] : [];
    }) : [];
    const need = new Map<string, number>();
    for (const m of planned) for (const i of m.recipe.ingredients) need.set(i.key, (need.get(i.key) ?? 0) + i.amount * m.servings);
    // Ook ingrediënten die het menu nodig heeft maar die (nog) niet in de voorraad staan.
    const rows = [...this.store.pantry()];
    for (const key of need.keys()) {
      if (!rows.some(r => r.key === key) && !this.catalog.ingredient(key)?.staple) rows.push({ key, amount: null, checkedAt: null, minimum: 0 });
    }
    const items = rows.map(p => {
      const def = this.catalog.ingredient(p.key);
      const s = stockState(p, this.now());
      const status = !s.known ? 'onbekend' : p.amount === 0 ? 'op' : p.minimum > 0 && p.amount! <= p.minimum ? 'bijna op' : 'ok';
      return {
        key: p.key, name: def?.name ?? p.key, category: def?.category ?? 'overig', unit: def?.unit ?? 'st',
        amount: p.amount, text: p.amount === null ? 'onbekend' : formatAmount(p.amount, def?.unit ?? 'st'),
        minimum: p.minimum, checkedAt: p.checkedAt, estimate: !s.fresh, status, neededThisOrder: need.get(p.key) ?? 0,
      };
    });
    return {
      items,
      low: items.filter(i => i.status === 'op' || i.status === 'bijna op').map(i => ({ key: i.key, name: i.name, status: i.status, text: i.text })),
      quick: this.quickItems().map(key => ({ key, name: this.catalog.ingredient(key)?.name ?? key })),
    };
  }

  quickItems(): string[] {
    return this.store.get<string[]>('quickItems', ['melk', 'ei', 'brood', 'boter', 'jong-belegen-plakken', 'koffie', 'wc-papier'])
      .filter(k => this.catalog.ingredient(k));
  }
  setQuickItems(keys: string[]) {
    check(Array.isArray(keys) && keys.length <= 24, 'Maximaal 24 snelknoppen.');
    this.store.set('quickItems', keys.map(k => this.catalog.resolve(String(k))?.key).filter(Boolean));
    this.changed();
  }

  /**
   * Werk de voorraad bij. Per item: een hoeveelheid (met eenheid), of een status:
   * 'op', 'bijna op', 'genoeg' (bevestigt de schatting) of 'onbekend'. Optioneel een minimum.
   */
  updatePantry(items: { name: string; amount?: number; unit?: string; status?: string; minimum?: number; minimumUnit?: string }[]) {
    check(Array.isArray(items) && items.length > 0 && items.length <= 60, 'Geef 1 tot 60 voorraaditems.');
    const now = new Date(this.now()).toISOString();
    const result: { name: string; text: string }[] = [];
    this.store.tx(() => {
      for (const input of items) {
        check(input && typeof input.name === 'string', 'Elk item heeft een naam.');
        const def = this.catalog.resolve(input.name);
        check(def, `Ik ken "${input.name}" niet als ingrediënt.`);
        const item: PantryItem = this.store.pantryItem(def.key) ?? { key: def.key, amount: null, checkedAt: null, minimum: 0 };
        const amountIn = (value: number, unit?: string) => {
          check(typeof value === 'number' && value >= 0 && value < 1e6, 'Ongeldige hoeveelheid voor ' + def.name + '.');
          if (!unit) return value;
          const base = toBase(value, unit);
          check(base, 'Onbekende eenheid ' + unit + '.');
          const v = convert(base.amount, base.unit, def);
          check(v !== null, `Kan ${unit} niet omrekenen voor ${def.name}.`);
          return v;
        };
        const status = normalize(input.status ?? '');
        if (input.amount !== undefined) { item.amount = amountIn(input.amount, input.unit); item.checkedAt = now; }
        else if (status === 'op' || status === 'leeg') { item.amount = 0; item.checkedAt = now; }
        else if (status === 'bijna op') { item.amount = item.minimum || Math.min(item.amount ?? Infinity, (this.#costOptions(def.key)[0]?.packAmount ?? 1) * 0.2); item.checkedAt = now; }
        else if (['genoeg', 'vol', 'ja', 'ok'].includes(status)) {
          if (item.amount === null || item.amount === 0) item.amount = this.#costOptions(def.key)[0]?.packAmount ?? 1;
          item.checkedAt = now;
        } else if (status === 'onbekend') { item.amount = null; item.checkedAt = null; }
        if (input.minimum !== undefined) item.minimum = amountIn(input.minimum, input.minimumUnit ?? input.unit);
        this.store.savePantry(item);
        result.push({ name: def.name, text: item.amount === null ? 'onbekend' : formatAmount(item.amount, def.unit) });
      }
    });
    this.changed();
    return result;
  }

  /** Iets is op: vanuit Home Assistant, NFC-tag, snelknop of chat. */
  markOut(name: string) { return this.updatePantry([{ name, status: 'op' }])[0]; }

  scanBarcode(code: string) {
    check(/^\d{8,14}$/.test(code), 'Ongeldige barcode.');
    const known = this.store.barcode(code);
    if (!known) return { known: false as const, code };
    const def = this.catalog.ingredient(known.key);
    check(def, 'Het gekoppelde ingrediënt bestaat niet meer.');
    const item = this.store.pantryItem(def.key) ?? { key: def.key, amount: null, checkedAt: null, minimum: 0 };
    const amount = item.amount === null ? 0 : Math.max(0, item.amount - known.amount);
    this.store.savePantry({ ...item, amount, checkedAt: new Date(this.now()).toISOString() });
    this.changed();
    return { known: true as const, code, name: known.name, ingredient: def.name, left: formatAmount(amount, def.unit), amount };
  }

  registerBarcode(input: { code: string; name: string; packAmount?: number; unit?: string; label?: string }) {
    check(/^\d{8,14}$/.test(input.code), 'Ongeldige barcode.');
    const def = this.catalog.resolve(input.name);
    check(def, `Ik ken "${input.name}" niet als ingrediënt.`);
    let amount = this.#costOptions(def.key)[0]?.packAmount ?? 1;
    if (input.packAmount) {
      const base = toBase(input.packAmount, input.unit ?? def.unit);
      const v = base && convert(base.amount, base.unit, def);
      check(v, 'Kan de verpakkingsinhoud niet omrekenen.');
      amount = v;
    }
    this.store.saveBarcode({ code: input.code, key: def.key, amount, name: (input.label || def.name).slice(0, 80) });
    return this.scanBarcode(input.code);
  }

  // ───────────── Boodschappenlijst voor deze bestelling ─────────────

  get order(): OrderOptions { return this.store.get<OrderOptions>('order', { extras: [], skip: [] }); }
  #setOrder(fn: (o: OrderOptions) => OrderOptions) { this.store.update<OrderOptions>('order', { extras: [], skip: [] }, fn); this.changed(); }

  /**
   * Zet producten op de lijst voor deze bestelling. Met hoeveelheid en eenheid ('500 g gehakt')
   * wordt het een ingrediëntbehoefte; anders zoekt Weekmand het product in de winkel ('krat pils').
   */
  async addItems(items: { name: string; quantity?: number; amount?: number; unit?: string; productId?: string }[]) {
    check(Array.isArray(items) && items.length > 0 && items.length <= 25, 'Geef 1 tot 25 producten.');
    const added: Extra[] = [];
    for (const item of items) {
      check(item && typeof item.name === 'string' && item.name.trim() && item.name.length <= 100, 'Elk product heeft een naam.');
      const quantity = item.quantity ?? 1;
      check(Number.isInteger(quantity) && quantity >= 1 && quantity <= 50, 'Aantal moet 1 tot 50 zijn.');
      const def = this.catalog.resolve(item.name);
      if (def && item.amount !== undefined && item.unit) {
        const base = toBase(item.amount, item.unit);
        const amount = base && convert(base.amount, base.unit, def);
        check(amount, `Kan ${item.amount} ${item.unit} niet omrekenen voor ${def.name}.`);
        added.push({ id: randomUUID().slice(0, 8), kind: 'ingredient', key: def.key, amount, label: `${formatAmount(amount, def.unit)} ${def.name.toLowerCase()}` });
        continue;
      }
      let product = item.productId ? this.#searchCache.get(item.productId) : undefined;
      if (!product) {
        const results = (await this.#requireShop().search(item.name)).filter(p => p.available);
        for (const r of results) this.#searchCache.set(r.id, r);
        product = results[0];
      }
      check(product, `Ik vind "${item.name}" niet in de ${this.shop.label.toLowerCase()}.`);
      added.push({ id: randomUUID().slice(0, 8), kind: 'product', productId: product.id, name: product.name, unitQuantity: product.unitQuantity, cents: product.cents, quantity, ...(def ? { key: def.key } : {}) });
    }
    this.#setOrder(o => ({
      extras: [...o.extras, ...added],
      skip: o.skip.filter(k => !added.some(a => (a.kind === 'ingredient' ? a.key : a.key ?? a.productId) === k)),
    }));
    return added.map(a => a.kind === 'product' ? `${a.quantity}× ${a.name}` : a.label);
  }

  /** Haal iets van de lijst of sla het deze bestelling over ('haal de kipfilet eruit'). */
  async removeItems(names: string[]) {
    check(Array.isArray(names) && names.length > 0 && names.length <= 25, 'Geef 1 tot 25 producten.');
    const done: string[] = [];
    const regulars = this.regulars();
    for (const name of names) {
      const query = normalize(String(name));
      const def = this.catalog.resolve(String(name));
      const order = this.order;
      const extra = order.extras.find(e => (def && (e.kind === 'ingredient' ? e.key : e.key) === def.key) || normalize(e.kind === 'product' ? e.name : e.label).includes(query));
      if (extra) {
        this.#setOrder(o => ({ ...o, extras: o.extras.filter(e => e.id !== extra.id) }));
        done.push(`${extra.kind === 'product' ? extra.name : extra.label} van de lijst gehaald`);
        continue;
      }
      const regular = regulars.find(r => r.enabled && ((def && r.key === def.key) || normalize(r.name).includes(query)));
      const key = def?.key ?? regular?.productId;
      if (!key) {
        const cart = this.shop.ready() ? await this.shop.readCart() : null;
        const line = cart?.lines.find(l => normalize(l.name).includes(query));
        check(line, `Ik vind "${name}" niet op de lijst of in de mand.`);
        this.#setOrder(o => ({ ...o, skip: [...new Set([...o.skip, line.id])] }));
        done.push(`${line.name} wordt uit de mand gehaald`);
        continue;
      }
      this.#setOrder(o => ({ ...o, skip: [...new Set([...o.skip, key, ...(regular ? [regular.productId] : [])])] }));
      const auto = regular || (def && (this.store.pantryItem(def.key)?.minimum ?? 0) > 0);
      if (auto && def) this.#feedback({ at: new Date(this.now()).toISOString(), kind: 'item-removed', key: def.key, week: isoWeek(localDate(this.now())) });
      const usedBy = def ? (await this.menu()).days.filter(d => d.inOrder && d.meal && this.catalog.recipe(d.meal.id)?.ingredients.some(i => i.key === def.key)).map(d => d.meal!.name) : [];
      done.push(`${def?.name ?? regular!.name} wordt deze bestelling overgeslagen` + (usedBy.length ? ` (let op: nodig voor ${usedBy.join(', ')})` : ''));
    }
    return done;
  }

  undoSkip(key: string) { this.#setOrder(o => ({ ...o, skip: o.skip.filter(k => k !== key) })); }
  /** Een voorgestelde regel wegvegen: dit product voor deze bestelling niet aanpassen. */
  declineLine(productId: string) {
    check(typeof productId === 'string' && productId, 'Geen product.');
    this.#setOrder(o => ({ ...o, declined: [...new Set([...(o.declined ?? []), productId])] }));
    const key = this.#productKey(productId);
    // Telt mee voor het leren: steeds hetzelfde vaste product wegvegen geeft een voorstel.
    if (key && this.regulars().some(r => r.productId === productId)) this.#feedback({ at: new Date(this.now()).toISOString(), kind: 'item-removed', key, week: isoWeek(localDate(this.now())) });
  }
  undoDecline(productId: string) { this.#setOrder(o => ({ ...o, declined: (o.declined ?? []).filter(id => id !== productId) })); }
  removeExtra(id: string) { this.#setOrder(o => ({ ...o, extras: o.extras.filter(e => e.id !== id) })); }

  // ───────────── Vaste boodschappen ─────────────

  regulars(): Regular[] { return this.store.get<Regular[]>('regulars', []); }
  setRegular(input: { productId: string; enabled?: boolean; quantity?: number; name?: string; unitQuantity?: string; cents?: number }) {
    check(typeof input.productId === 'string' && input.productId, 'Kies een product.');
    this.store.update<Regular[]>('regulars', [], list => {
      const existing = list.find(r => r.productId === input.productId);
      const cached = this.#searchCache.get(input.productId);
      if (!existing) {
        check(cached || input.name, 'Zoek het product eerst op.');
        list.push({
          productId: input.productId, name: cached?.name ?? input.name!, unitQuantity: cached?.unitQuantity ?? input.unitQuantity ?? '',
          cents: cached?.cents ?? input.cents ?? 0, quantity: input.quantity ?? 1, enabled: input.enabled ?? true,
          ...(this.#productKey(input.productId, cached?.name ?? input.name) ? { key: this.#productKey(input.productId, cached?.name ?? input.name) } : {}),
        });
        return list;
      }
      if (input.enabled !== undefined) existing.enabled = !!input.enabled;
      if (input.quantity !== undefined) {
        check(Number.isInteger(input.quantity) && input.quantity >= 0 && input.quantity <= 50, 'Aantal 0 tot 50.');
        existing.quantity = input.quantity;
      }
      return list.filter(r => r.quantity > 0);
    });
    this.changed();
  }

  /** Producten die in minstens 3 weken en 60% van de weken voorkomen. */
  #deriveRegulars(history: PicnicHistory) {
    const weeks = new Map<string, Map<string, number>>();
    for (const d of history.deliveries) {
      const week = isoWeek(d.date);
      const lines = weeks.get(week) ?? new Map<string, number>();
      for (const o of d.orders) for (const i of o.items) lines.set(i.productId, (lines.get(i.productId) ?? 0) + i.quantity);
      weeks.set(week, lines);
    }
    const span = weeks.size;
    if (span < 3) return;
    const info = new Map(history.deliveries.flatMap(d => d.orders.flatMap(o => o.items.map(i => [i.productId, i] as const))));
    const counts = new Map<string, number[]>();
    for (const lines of weeks.values()) for (const [id, q] of lines) counts.set(id, [...(counts.get(id) ?? []), q]);
    this.store.update<Regular[]>('regulars', [], list => {
      for (const [id, qs] of counts) {
        if (qs.length < 3 || qs.length / span < 0.6 || list.some(r => r.productId === id)) continue;
        const sorted = [...qs].sort((a, b) => a - b);
        const item = info.get(id)!;
        const key = this.#productKey(id, item.name);
        list.push({ productId: id, name: item.name, unitQuantity: item.pack, cents: 0, quantity: sorted[Math.floor(sorted.length / 2)], enabled: false, weeks: qs.length, ...(key ? { key } : {}) });
      }
      return list;
    });
  }

  // ───────────── Productkoppelingen (Picnic) ─────────────

  async searchProducts(query: string) {
    check(typeof query === 'string' && query.trim() && query.length <= 80, 'Geef een zoekterm van maximaal 80 tekens.');
    const results = await this.#requireShop().search(query.trim());
    for (const r of results) this.#searchCache.set(r.id, r);
    return results;
  }

  links() { return this.store.links(); }

  linkProduct(name: string, productId: string) {
    const def = this.catalog.resolve(name);
    check(def, `Ik ken "${name}" niet als ingrediënt.`);
    const product = this.#searchCache.get(productId);
    check(product, 'Zoek het product eerst op.');
    const amount = packAmount(product.unitQuantity, def);
    check(amount, `Ik kan de verpakking "${product.unitQuantity}" niet omrekenen naar ${def.unit}. Kies een ander product.`);
    const link: ProductLink = { key: def.key, productId: product.id, name: product.name, unitQuantity: product.unitQuantity, packAmount: amount, cents: product.cents, auto: false, updatedAt: new Date(this.now()).toISOString() };
    this.store.saveLink(link);
    this.#saveVariants(def, link, [...this.#searchCache.values()]);
    this.changed();
    return link;
  }

  /** Andere maten van hetzelfde product (bijv. kippendijfilet 400 g en 800 g), met actuele prijs. */
  variants(key: string): ProductOption[] {
    return this.store.get<Record<string, { at: number; options: ProductOption[] }>>('variants', {})[key]?.options ?? [];
  }
  #saveVariants(def: IngredientDef, link: ProductLink, results: ShopProduct[]) {
    const base = baseName(link.name);
    const options: ProductOption[] = [];
    for (const r of results) {
      const amount = packAmount(r.unitQuantity, def);
      if (!amount || !(r.available || r.id === link.productId) || baseName(r.name) !== base || options.some(o => o.id === r.id)) continue;
      options.push({ id: r.id, name: r.name, unitQuantity: r.unitQuantity, cents: r.cents, packAmount: amount, ...(r.tiers?.length ? { tiers: r.tiers } : {}) });
    }
    if (!options.some(o => o.id === link.productId)) options.unshift({ id: link.productId, name: link.name, unitQuantity: link.unitQuantity, cents: link.cents, packAmount: link.packAmount });
    const current = options.find(o => o.id === link.productId)!;
    if (current.cents !== link.cents) this.store.saveLink({ ...link, cents: current.cents, updatedAt: new Date(this.now()).toISOString() });
    this.store.update<Record<string, { at: number; options: ProductOption[] }>>('variants', {}, v => ({ ...v, [def.key]: { at: this.now(), options } }));
  }

  /**
   * Koppel ontbrekende ingrediënten automatisch aan het eerste passende Picnic-product, en ververs
   * van gekoppelde producten de maten en prijzen (aanbiedingen wisselen wekelijks). Rustig aan:
   * Picnic weigert te veel zoekopdrachten kort na elkaar.
   */
  async #ensureLinks(keys: string[], refresh = false) {
    if (this.shopMode !== 'picnic' || !this.picnic.ready()) return;
    const misses = this.store.get<Record<string, number>>('linkMisses', {});
    const variants = this.store.get<Record<string, { at: number }>>('variants', {});
    const missing = keys.filter(k => !this.store.link(k) && !(misses[k] && this.now() - misses[k] < day)).slice(0, 12);
    const stale = refresh ? keys.filter(k => this.store.link(k) && this.now() - (variants[k]?.at ?? 0) > 20 * 36e5).slice(0, 6) : [];
    let searched = 0;
    for (const key of [...missing, ...stale]) {
      const def = this.catalog.ingredient(key);
      if (!def) continue;
      if (searched++ && this.searchPause) await new Promise(r => setTimeout(r, this.searchPause));
      let results: ShopProduct[];
      try {
        results = await this.picnic.search(def.query);
      } catch (error) {
        // Stoppen zonder de berekening te laten mislukken; de volgende berekening gaat verder.
        console.error('Koppelen gestopt bij', key, (error as Error).message);
        if ((error as Problem).status === 401) throw error;
        break;
      }
      for (const r of results) this.#searchCache.set(r.id, r);
      let link = this.store.link(key);
      if (!link) {
        const match = results.find(r => r.available && packAmount(r.unitQuantity, def));
        if (!match) { misses[key] = this.now(); continue; }
        link = { key, productId: match.id, name: match.name, unitQuantity: match.unitQuantity, packAmount: packAmount(match.unitQuantity, def)!, cents: match.cents, auto: true, updatedAt: new Date(this.now()).toISOString() };
        this.store.saveLink(link);
      }
      this.#saveVariants(def, link, results);
    }
    this.store.set('linkMisses', misses);
    return searched;
  }

  /** Maten en aanbiedingsprijzen verversen (op de achtergrond, rustig aan). */
  async refreshPrices() {
    if (this.shopMode !== 'picnic' || !this.picnic.ready()) return 0;
    const w = await this.window();
    const keys = [...new Set(this.store.meals(w.start, w.end).flatMap(m => this.catalog.recipe(m.recipeId)?.ingredients.map(i => i.key) ?? []))]
      .filter(k => !this.catalog.ingredient(k)?.staple);
    const searched = await this.#ensureLinks(keys, true);
    if (searched) this.changed();
    return searched;
  }

  #productKey(productId: string, name?: string): string | undefined {
    if (this.shopMode === 'mock') return this.catalog.ingredients().find(i => i.packs.some(p => p.id === productId))?.key;
    const link = this.store.links().find(l => l.productId === productId);
    if (link) return link.key;
    const variants = this.store.get<Record<string, { options: ProductOption[] }>>('variants', {});
    const variant = Object.entries(variants).find(([, v]) => v.options.some(o => o.id === productId));
    if (variant) return variant[0];
    return name ? this.catalog.resolve(name)?.key : undefined;
  }

  // ───────────── Mand: berekenen en bijwerken ─────────────

  /** Grootboek bijwerken: nieuwe mand (na een bestelling) of handmatig verwijderde regels. */
  #syncLedger(cart: ShopCart): Ledger {
    return this.store.tx(() => {
      const ledger = this.store.get<Ledger>('ledger', { cartId: cart.id, lines: {} });
      const fresh = ledger.cartId !== cart.id || (!cart.lines.length && Object.values(ledger.lines).some(q => q > 0));
      if (fresh) {
        // Nieuwe mand: de vorige bestelling is geplaatst. Lijst voor deze bestelling begint opnieuw.
        this.store.set('order', { extras: [], skip: [] });
        const next = { cartId: cart.id, lines: {} };
        this.store.set('ledger', next);
        return next;
      }
      const lines: Record<string, number> = {};
      for (const [id, q] of Object.entries(ledger.lines)) {
        const capped = Math.min(q, quantityOf(cart, id));
        if (capped > 0) lines[id] = capped;
      }
      const next = { cartId: cart.id, lines };
      this.store.set('ledger', next);
      return next;
    });
  }

  async plan(): Promise<Plan & { id: string; window: { start: string; end: string }; meals: { date: string; day: string; name: string; servings: number }[] }> {
    const shop = this.#requireShop();
    const generation = this.#generation;
    this.consumePastMeals();
    const w = await this.window();
    const meals: PlanMeal[] = this.store.meals(w.start, w.end).flatMap(m => {
      const recipe = this.catalog.recipe(m.recipeId);
      return recipe ? [{ date: m.date, recipe, servings: m.servings }] : [];
    });
    const keys = new Set([...meals.flatMap(m => m.recipe.ingredients.map(i => i.key)), ...this.store.pantry().filter(p => p.minimum > 0).map(p => p.key),
      ...this.order.extras.flatMap(e => e.kind === 'ingredient' ? [e.key] : [])]);
    await this.#ensureLinks([...keys].filter(k => !this.catalog.ingredient(k)?.staple || (this.store.pantryItem(k)?.amount === 0)));
    const cart = await shop.readCart();
    this.#rememberCartRecipes(cart);
    const ledger = this.#syncLedger(cart);
    const plan = buildPlan({
      meals, household: this.household, pantry: this.store.pantry(), order: this.order, regulars: this.regulars(), avoid: this.avoid,
      cart, ledger: ledger.lines, ingredient: k => this.catalog.ingredient(k), options: k => this.#options(k),
      productKey: (id, name) => this.#productKey(id, name), now: this.now(),
    });
    const id = randomUUID();
    this.store.set('review', { id, createdAt: this.now(), plan } satisfies StoredReview);
    const result = {
      ...plan, id, window: { start: w.start, end: w.end }, computedAt: new Date(this.now()).toISOString(),
      meals: meals.map(m => ({ date: m.date, day: dayName(m.date), name: m.recipe.name, servings: m.servings })),
    };
    this.#planCache = { plan: result, at: this.now(), generation };
    return result;
  }

  /**
   * Het gedeelde overzicht voor het hele huishouden: het bewaarde overzicht als er sindsdien niets
   * veranderd is en het jonger is dan `maxAge` (voor wijzigingen in de Picnic-app zelf), anders
   * opnieuw berekenen. Gelijktijdige verzoeken wachten op dezelfde berekening.
   */
  async currentPlan(maxAge = 10 * 60_000) {
    const cache = this.#planCache;
    if (cache && cache.generation === this.#generation && this.now() - cache.at >= 0 && this.now() - cache.at < maxAge) return cache.plan;
    this.#planning ??= this.plan().finally(() => { this.#planning = null; });
    return this.#planning;
  }

  /** Breng de mand naar het goedgekeurde overzicht. Herhaalbaar en veilig bij tussentijdse wijzigingen. */
  async applyPlan(id: string) {
    if (this.store.get<string[]>('doneReviews', []).includes(id)) return { applied: {}, already: true, summary: 'De mand was al bijgewerkt.' };
    const review = this.store.get<StoredReview | null>('review', null);
    check(review && review.id === id, 'Dit overzicht is niet meer actueel. Bereken de mand opnieuw.', 409);
    if (review.done) return { applied: {}, already: true, summary: 'De mand was al bijgewerkt.' };
    check(this.now() - review.createdAt <= 30 * 60_000, 'Dit overzicht is ouder dan 30 minuten. Bereken de mand opnieuw.', 409);
    const fresh = await this.plan();
    check(JSON.stringify(fresh.target) === JSON.stringify(review.plan.target) && fresh.cartId === review.plan.cartId,
      'De mand of het menu is intussen veranderd. Bekijk het nieuwe overzicht.', 409);
    const names = new Map(fresh.lines.map(l => [l.productId, l.product]));
    const { applied } = await applyChange(this.shop, { cartId: fresh.cartId, before: fresh.before, target: fresh.target }, (productId, delta) => {
      this.store.update<Ledger>('ledger', { cartId: fresh.cartId, lines: {} }, l => ({ ...l, lines: { ...l.lines, [productId]: Math.max(0, (l.lines[productId] ?? 0) + delta) } }));
    });
    this.store.set('review', { id: fresh.id, createdAt: this.now(), plan: fresh, done: true } satisfies StoredReview);
    this.store.update<string[]>('doneReviews', [], ids => [id, fresh.id, ...ids].slice(0, 20));
    // Deze maaltijden zijn nu echt besteld: ze komen in de receptgeschiedenis.
    this.store.markOrdered(fresh.meals.map(m => m.date));
    const parts = Object.entries(applied).map(([pid, d]) => `${d > 0 ? '+' : ''}${d} ${names.get(pid) ?? pid}`);
    this.changed();
    this.events.emit('applied', applied);
    return { applied, already: false, summary: parts.length ? 'Mand bijgewerkt: ' + parts.join(', ') : 'De mand was al in orde.' };
  }

  async cart() {
    const shop = this.#requireShop();
    const cart = await shop.readCart();
    this.#rememberCartRecipes(cart);
    const ledger = this.#syncLedger(cart);
    return { shop: shop.label, id: cart.id, totalCents: cart.totalCents, lines: cart.lines.map(l => ({ ...l, byWeekmand: ledger.lines[l.id] ?? 0 })) };
  }

  /** Picnic-recepten in de mand onthouden: na de bestelling zijn dat "bestelde" recepten. */
  #rememberCartRecipes(cart: ShopCart) {
    if (!cart.recipes?.length) return;
    this.store.update<Record<string, string>>('picnicCartRecipes', {}, seen => {
      for (const r of cart.recipes!) seen[r.id] = localDate(this.now());
      return seen;
    });
  }

  /** Bewaarde, eigen en bestelde Picnic-recepten ophalen en als Weekmand-recept opslaan. */
  async importPicnicRecipes() {
    check(this.picnic.ready(), 'Meld je eerst aan bij Picnic.');
    return importPicnicRecipes(this);
  }

  /** Opgehaalde Picnic-recepten voor de receptentab. */
  picnicRecipes() {
    const known = this.store.get<Record<string, { labels: string[]; recipeId: string; name: string }>>('picnicRecipes', {});
    return Object.values(known).flatMap(k => {
      const r = this.catalog.recipe(k.recipeId);
      return r ? [{ id: r.id, name: r.name, minutes: r.minutes, labels: k.labels }] : [];
    }).sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  }

  /** Demo: bestelling plaatsen en meteen leveren. De voorraad krijgt de geleverde producten erbij. */
  async completeDemoOrder() {
    check(this.shop === this.mock, 'Alleen in de demowinkel. Bij Picnic rond je de bestelling af in de Picnic-app.');
    const w = await this.window();
    this.store.markOrdered(this.store.meals(w.start, w.end).map(m => m.date));
    const lines = await this.mock.checkout();
    this.#addDelivered(lines.map(l => ({ productId: l.id, name: l.name, unitQuantity: l.unitQuantity, quantity: l.quantity })));
    this.store.set('ledger', { cartId: (await this.mock.readCart()).id, lines: {} });
    this.store.set('order', { extras: [], skip: [] });
    this.#slots = null;
    this.changed();
    return lines.length;
  }

  /** Tel geleverde producten bij de voorraad. Geeft terug wat geteld is en wat niet herkend werd. */
  #addDelivered(lines: { productId: string; name: string; unitQuantity: string; quantity: number }[]) {
    const now = new Date(this.now()).toISOString();
    const counted: string[] = [];
    const unmatched: string[] = [];
    this.store.tx(() => {
      for (const line of lines) {
        const key = this.#productKey(line.productId, line.name);
        const def = key ? this.catalog.ingredient(key) : undefined;
        const pack = def ? (this.shopMode === 'mock' ? def.packs.find(p => p.id === line.productId)?.amount : packAmount(line.unitQuantity, def)) : undefined;
        if (!def || !pack) { unmatched.push(`${line.quantity}× ${line.name}`); continue; }
        const item = this.store.pantryItem(def.key) ?? { key: def.key, amount: null, checkedAt: null, minimum: 0 };
        this.store.savePantry({ ...item, amount: (item.amount ?? 0) + pack * line.quantity, checkedAt: now });
        counted.push(`${line.quantity}× ${line.name} → ${def.name}`);
      }
    });
    return { counted, unmatched };
  }

  /**
   * Voorraad opnieuw opbouwen: alle hoeveelheden leeg (minimums blijven), de laatste Picnic-levering
   * tellen en maaltijden die sindsdien gegeten zijn eraf halen. Wat niet geleverd is wordt "onbekend".
   */
  rebuildPantryFromLastDelivery() {
    const history = this.store.get<PicnicHistory | null>('picnicHistory', null);
    const last = history?.deliveries?.[0];
    check(last, 'Er is nog geen Picnic-levering opgehaald. Meld je aan bij Picnic en haal de leveringen op.');
    this.store.tx(() => {
      for (const p of this.store.pantry()) this.store.savePantry({ ...p, amount: null, checkedAt: null });
    });
    const result = this.#addDelivered(last.orders.flatMap(o => o.items.map(i => ({ productId: i.productId, name: i.name, unitQuantity: i.pack, quantity: i.quantity }))));
    // Maaltijden van na de levering die al gegeten zijn, gaan er weer af.
    const today = localDate(this.now());
    let eaten = 0;
    for (const meal of this.store.meals(last.date, addDays(today, -1))) {
      const recipe = this.catalog.recipe(meal.recipeId);
      for (const i of recipe?.ingredients ?? []) {
        const item = this.store.pantryItem(i.key);
        if (item?.amount) this.store.savePantry({ ...item, amount: Math.max(0, item.amount - i.amount * meal.servings) });
      }
      this.store.markConsumed(meal.date);
      eaten++;
    }
    this.changed();
    return { delivery: last.date, counted: result.counted, unmatched: result.unmatched, mealsSubtracted: eaten };
  }

  /** Haal recente Picnic-leveringen op; nieuwe leveringen gaan in de voorraad. */
  async importHistory() {
    const history = await this.picnic.history(this.now());
    this.store.set('picnicHistory', history);
    const since = this.store.get<string | null>('trackingSince', null) ?? this.store.update<string | null>('trackingSince', null, () => localDate(this.now()));
    const applied = new Set(this.store.get<string[]>('appliedDeliveries', []));
    let added = 0;
    for (const d of history.deliveries) {
      if (applied.has(d.id) || d.date < since!) continue;
      this.#addDelivered(d.orders.flatMap(o => o.items.map(i => ({ productId: i.productId, name: i.name, unitQuantity: i.pack, quantity: i.quantity }))));
      applied.add(d.id);
      added++;
    }
    this.store.set('appliedDeliveries', [...applied].slice(-100));
    this.#deriveRegulars(history);
    this.changed();
    return { deliveries: history.deliveries.length, addedToPantry: added };
  }

  // ───────────── Voorstellen uit gewoontes ─────────────

  suggestions() { return this.store.suggestions('open'); }
  respondSuggestion(id: string, accept: boolean) {
    const s = this.store.suggestion(id);
    check(s && s.status === 'open', 'Dit voorstel is al afgehandeld.');
    this.store.saveSuggestion({ ...s, status: accept ? 'accepted' : 'declined' });
    if (accept) this.store.update<AvoidRule[]>('avoid', [], rules => rules.some(r => ruleId(r) === ruleId(s.rule as AvoidRule)) ? rules : [...rules, s.rule as AvoidRule]);
    this.changed();
    return accept ? 'Begrepen, daar houd ik voortaan rekening mee.' : 'Prima, ik laat het zoals het is.';
  }

  describeRule(rule: AvoidRule) {
    if (rule.kind === 'recipe') return `Niet meer voorstellen: ${this.catalog.recipe(rule.recipeId)?.name ?? rule.recipeId}`;
    if (rule.kind === 'tag-weekday') return `Geen ${rule.tag} op ${weekdays[rule.weekday]}`;
    return `Niet automatisch toevoegen: ${this.catalog.ingredient(rule.key)?.name ?? rule.key}`;
  }

  // ───────────── Receptgeschiedenis en beoordelingen ─────────────

  /** Per recept de laatste beoordeling: 1 = favoriet, -1 = liever niet. */
  #latestRatings(): Map<string, { rating: 1 | -1; reason: string | null; date: string; ups: number; downs: number }> {
    const map = new Map<string, { rating: 1 | -1; reason: string | null; date: string; ups: number; downs: number }>();
    for (const r of this.store.ratings()) {
      const prev = map.get(r.recipeId);
      map.set(r.recipeId, { rating: r.rating, reason: r.reason, date: r.date, ups: (prev?.ups ?? 0) + (r.rating === 1 ? 1 : 0), downs: (prev?.downs ?? 0) + (r.rating === -1 ? 1 : 0) });
    }
    return map;
  }
  #withFavorites(recipes: Recipe[]): Recipe[] {
    const latest = this.#latestRatings();
    return recipes.map(r => latest.get(r.id)?.rating === 1 ? { ...r, tags: [...r.tags, 'favoriet'] } : r);
  }
  /** Favorieten komen vaker terug (niet te snel), afgekeurde gerechten zelden. */
  #ratingBonus(recipe: Recipe, recent: string[]) {
    const r = this.#latestRatings().get(recipe.id);
    if (!r) return 0;
    if (r.rating === -1) return -4;
    return recent.includes(recipe.id) ? 0 : 1.5;
  }

  /** Maaltijden die echt besteld zijn en al voorbij (of vandaag), nieuwste eerst. */
  recipeHistory() {
    const today = localDate(this.now());
    return this.store.orderedMeals(today).map(m => {
      const recipe = this.catalog.recipe(m.recipeId);
      const rating = this.store.rating(m.date);
      return {
        date: m.date, day: dayName(m.date), recipeId: m.recipeId, name: recipe?.name ?? m.recipeId, servings: m.servings,
        rating: rating ? (rating.rating === 1 ? 'up' : 'down') : null, reason: rating?.reason ?? null,
      };
    });
  }

  /** De pool van gelikte recepten om te herhalen, met hoe vaak en wanneer het laatst gegeten. */
  favorites() {
    const history = this.store.orderedMeals(localDate(this.now()), 500);
    return [...this.#latestRatings()].filter(([, r]) => r.rating === 1).flatMap(([id, r]) => {
      const recipe = this.catalog.recipe(id);
      if (!recipe) return [];
      const eaten = history.filter(m => m.recipeId === id);
      return [{ id, name: recipe.name, tags: recipe.tags, minutes: recipe.minutes, likes: r.ups, timesEaten: eaten.length, lastEaten: eaten[0]?.date ?? null }];
    }).sort((a, b) => (a.lastEaten ?? '').localeCompare(b.lastEaten ?? ''));
  }

  disliked() {
    return [...this.#latestRatings()].filter(([, r]) => r.rating === -1)
      .map(([id, r]) => ({ id, name: this.catalog.recipe(id)?.name ?? id, reason: r.reason, date: r.date }));
  }

  /** Duimpje omhoog of omlaag voor een gegeten maaltijd; bij omlaag een reden. */
  rateMeal(date: string, rating: 'up' | 'down', reason?: string) {
    check(rating === 'up' || rating === 'down', 'Kies duimpje omhoog of omlaag.');
    const meal = this.store.meal(date);
    check(meal, 'Op die dag staat geen maaltijd.');
    check(date <= localDate(this.now()), 'Beoordelen kan na het eten.');
    const text = (reason ?? '').trim().slice(0, 200) || null;
    this.store.saveRating({ date, recipeId: meal.recipeId, rating: rating === 'up' ? 1 : -1, reason: rating === 'down' ? text : null, at: new Date(this.now()).toISOString() });
    this.changed();
    const name = this.catalog.recipe(meal.recipeId)?.name ?? meal.recipeId;
    return rating === 'up' ? `${name} staat bij je favorieten en komt vaker terug.` : `Genoteerd${text ? ` (${text})` : ''}; ${name} stel ik voorlopig niet meer voor.`;
  }

  // ───────────── Samenvatting voor Home Assistant en meldingen ─────────────

  async snapshot() {
    const today = localDate(this.now());
    const meal = this.store.meal(today);
    const pantry = await this.pantryStatus();
    const delivery = await this.delivery();
    return {
      today: meal ? this.catalog.recipe(meal.recipeId)?.name ?? '' : '',
      tomorrow: (() => { const m = this.store.meal(addDays(today, 1)); return m ? this.catalog.recipe(m.recipeId)?.name ?? '' : ''; })(),
      low_count: pantry.low.length,
      low: pantry.low.map(l => l.name),
      cutoff: delivery.cutOff,
      hours_left: delivery.hoursLeft,
      open_suggestions: this.suggestions().length,
      shop: this.shop.label,
    };
  }

  // ───────────── Overzetten van versie 1 ─────────────

  #migrateV1() {
    const legacy = this.store.legacyState();
    if (!legacy) return;
    const state = legacy.state as { preferences?: Record<string, unknown>; stock?: Record<string, { amount: number; date: string }> } | undefined;
    const prefs = state?.preferences;
    if (prefs && !this.store.get('household', null)) {
      this.store.set('household', {
        ...defaultHousehold, adults: Number(prefs.people) || 2, children: Number(prefs.children) || 0, toddlers: Number(prefs.toddlers) || 0,
        budget: Number(prefs.budget) || defaultHousehold.budget, vegetarian: !!prefs.vegetarian, days: Number(prefs.days) || defaultHousehold.days,
        exclude: ((prefs.exclude as string[]) ?? []).map(k => this.catalog.resolve(k)?.key).filter(Boolean),
      });
    }
    // Versie 1 telde ei en brood in stuks, melk en olie in ml en de rest in gram.
    const v1Unit = (key: string): BaseUnit => ['ei', 'brood'].includes(key) ? 'st' : ['melk', 'olie'].includes(key) ? 'ml' : 'g';
    for (const [key, s] of Object.entries(state?.stock ?? {})) {
      const def = this.catalog.resolve(key);
      if (!def || this.store.pantryItem(def.key)) continue;
      const amount = convert(s.amount, v1Unit(key), def);
      if (amount !== null) this.store.savePantry({ key: def.key, amount: Math.round(amount * 100) / 100, checkedAt: s.date, minimum: 0 });
    }
    if (legacy.picnicHistory) this.store.set('picnicHistory', legacy.picnicHistory);
    this.store.set('migratedV1', true);
  }
}

export type { BaseUnit, IngredientDef };
export { parseUnitQuantity };
