import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Catalog, normalize, slug } from './catalog.ts';
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
import type { AvoidRule, BaseUnit, Category, DeliverySlot, Household, IngredientDef, Meal, PantryItem, Recipe, ShopCart, ShopProduct } from './types.ts';
import { convert, euro, formatAmount, packAmount, parseUnitQuantity, toBase } from './units.ts';
import { adjustmentLine, bonusPerLine, budgetCategories, budgetFor, categoryFromCatalog, categoryKeys, kindKeys, kindOf, labelKey, matchDiscounts, periodRange, priceChanges, ruleCategory, summarize, toCsv } from './budget.ts';
import type { BudgetCategory, Period, ProductLabel, ReceiptPhoto, Spend, SpendKind, SpendSource } from './budget.ts';
import type { ImageInput } from './ai.ts';
import { importPicnicRecipes } from './picnic-recipes.ts';
import { AH_LOGIN_URL, AlbertHeijn } from './ah.ts';
import type { AhDiscount, AhReceiptLine } from './ah.ts';
import { extractRecipe, fetchPage, previewRecipe, recipeFromText } from './recipe-import.ts';
import type { Preview } from './recipe-import.ts';

export const defaultHousehold: Household = { adults: 2, children: 0, toddlers: 0, budget: 80, vegetarian: false, exclude: [], days: 5 };
type Ledger = { cartId: string; lines: Record<string, number> };
type StoredReview = { id: string; createdAt: number; plan: Plan; done?: boolean };
export type Notice = { text: string; buttons?: { label: string; data: string }[]; key?: string };

const day = 86_400_000;

/** Regels op een kassabon die geen boodschappen zijn. */
const notGroceries = /statiegeld|emballage|zegel|airmiles|air miles|bonus|korting|draagtas|\btas\b|cadeaukaart|toeslag|retour/i;
/** 'AH HALFVOLLE MELK 1L' → 'halfvolle melk': merk en maat eraf, zodat de catalogus het herkent. */
export function receiptName(name: string) {
  return name.toLowerCase().replace(/^(ah basic|ah excellent|ah biologisch|ah bio|ah terra|g'woon|ah)\s+/, '')
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:x\s*\d+\s*)?(g|gr|gram|kg|ml|cl|l|ltr|liter|st|stuks?)\b/g, ' ')
    .replace(/\d+/g, ' ').replace(/\b[a-z]\b/g, ' ').replace(/\s+/g, ' ').trim();
}
export type AhReceiptLog = { id: string; date: string; total: number | null; counted: string[]; unmatched: string[]; ignored?: string[] };
/** Wat Weekmand over een bonregel heeft geleerd: een ingrediënt (met inhoud per stuk) of null = geen boodschap. */
export type ReceiptAlias = { key: string | null; amount?: number; by: 'ai' | 'user' };
export type ReceiptMatch = { receipt: string; kind: 'existing' | 'new' | 'ignore' | 'unknown'; key?: string; name?: string; unit?: string; category?: string; amount?: number };
/** null: er is geen AI gekoppeld. */
export type ReceiptMatcher = (lines: string[], ingredients: { key: string; name: string; unit: BaseUnit }[]) => Promise<ReceiptMatch[] | null>;
export const receiptKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');
/** null: er is geen AI gekoppeld. */
/** Een recept zoals de AI het teruggeeft, klaar voor catalog.addRecipe. */
export type AdaptedRecipe = { name: string; minutes?: number; steps?: string; tags?: string[]; ingredients: { name: string; amount: number; unit: string; category?: string }[] };
/** Past een recept aan volgens een opmerking; null: geen AI gekoppeld. */
export type RecipeAdapter = (recipe: { name: string; minutes: number; steps: string; tags: string[]; ingredients: { name: string; amount: number; unit: string }[] }, note: string) => Promise<AdaptedRecipe | null>;
export type ProductClassifier = (names: string[]) => Promise<{ name: string; category: BudgetCategory; kind: SpendKind }[] | null>;
type BudgetPrefs = { monthCents?: number; limits?: Partial<Record<BudgetCategory, number>> };
/** De laatste mandberekening met de Picnic-mand waarmee hij gemaakt is, voor na een herstart. */
type PlanSnapshot = { at: number; shopMode: 'mock' | 'picnic'; plan: Awaited<ReturnType<Weekmand['plan']>>; cart: ShopCart; cartAt: number };
const categories: Category[] = ['groente-fruit', 'aardappel', 'vlees', 'vis', 'vega', 'zuivel-eieren', 'kaas', 'brood', 'pasta-rijst', 'conserven', 'kruiden-sauzen', 'olie-azijn', 'bakken', 'diepvries', 'drinken', 'ontbijt', 'snacks', 'huishouden'];


/** Productnaam zonder maat: 'Kippendijfilet 800 g' en 'Kippendijfilet 400 g' zijn hetzelfde product. */
export function baseName(name: string) {
  const sizeWords = /\b(x|g|gr|gram|kg|kilo|ml|cl|l|liter|st|stuk|stuks|ca|xl|pack|voordeelverpakking|voordeelpak|grootverpakking|familieverpakking)\b/g;
  return normalize(name.replace(/\d+(?:[.,]\d+)?/g, ' ')).replace(sizeWords, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Hoe lang een lezing van de Picnic-mand en de bezorgmomenten goed blijft: hooguit twee keer per
 * dag vanzelf. "Ververs uit Picnic" en doorvoeren lezen altijd vers.
 */
export const PICNIC_READ_INTERVAL = 12 * 36e5;

export class Weekmand {
  readonly store: Store;
  readonly secrets: Secrets;
  readonly catalog: Catalog;
  readonly mock: MockShop;
  readonly picnic: PicnicShop;
  readonly ah: AlbertHeijn;
  readonly events = new EventEmitter();
  now: () => number;
  #slots: { at: number; slots: DeliverySlot[] } | null = null;
  #searchCache = new Map<string, ShopProduct>();
  #generation = 0;
  #planCache: { plan: Awaited<ReturnType<Weekmand['plan']>>; at: number; generation: number } | null = null;
  #planning: { generation: number; promise: Promise<Awaited<ReturnType<Weekmand['plan']>>> } | null = null;
  /** De laatst gelezen mand. Wijzigingen in Weekmand zelf (overslaan, extra's) hoeven Picnic niet opnieuw te lezen. */
  #cartRead: { at: number; shop: Shop; cart: ShopCart } | null = null;
  #cartEpoch = 0;
  /** Of er een mandberekening in de database staat (planSnapshot), zodat wijzigingen hem kunnen wissen. */
  #snapshot = false;
  #planRuns = 0;
  #ahImport: Promise<{ receipts: AhReceiptLog[] }> | null = null;
  /** Koppelt onbekende bonregels met de AI; gezet door de assistent als er een AI gekoppeld is. */
  receiptMatcher?: ReceiptMatcher;
  /** Deelt producten in voor het budget (categorie, nodig of extra); gezet door de assistent. */
  productClassifier?: ProductClassifier;
  /** Past een recept aan volgens een opmerking ("met kippenpoten"); gezet door de assistent. */
  recipeAdapter?: RecipeAdapter;
  /** Leest een foto van een kassabon; gezet door de assistent. null: geen AI. */
  receiptReader?: (image: ImageInput, today: string) => Promise<ReceiptPhoto | null>;
  #spendSync: Promise<{ added: number; detailed: number; errors: string[] }> | null = null;
  /** Pauze tussen automatische Picnic-zoekopdrachten (ms). */
  searchPause = 1500;

  constructor(options: { store: Store; secrets: Secrets; picnic?: PicnicShop; ah?: AlbertHeijn; now?: () => number }) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.now = options.now ?? Date.now;
    this.catalog = new Catalog(this.store);
    this.mock = new MockShop(this.store, () => this.catalog.ingredients());
    this.picnic = options.picnic ?? new PicnicShop(this.secrets);
    this.picnic.onExpired = () => this.notify({ text: 'Je Picnic-sessie is verlopen. Meld je opnieuw aan in Weekmand (Instellingen → Picnic) om automatische aanvullingen te laten werken.', key: 'picnic-expired-' + localDate(this.now()) });
    this.picnic.onImages = images => this.#noteImages(images);
    this.ah = options.ah ?? new AlbertHeijn(this.secrets, fetch, () => this.now());
    this.ah.onExpired = () => this.notify({ text: 'De koppeling met je AH-account is verlopen. Koppel opnieuw in Weekmand (Meer → Albert Heijn) om kassabonnen en Mijn lijst te laten werken.', key: 'ah-expired-' + localDate(this.now()) });
    this.events.setMaxListeners(20);
    // Elke wijziging (menu, lijst, voorraad, mand) maakt het gedeelde overzicht verouderd.
    // De 12 uur rust na een weigering door AH geldt ook na een herstart.
    this.ah.pausedUntil = this.store.get<number>('ahPausedUntil', 0);
    this.ah.onPause = until => this.store.set('ahPausedUntil', until);
    this.events.on('change', () => {
      this.#generation++;
      // De bewaarde mandberekening klopt niet meer.
      if (this.#snapshot) { this.store.set('planSnapshot', null); this.#snapshot = false; }
    });
    this.#migrateV1();
    // Eenmalig: ingrediënten die vroeger standaard "groente-fruit" kregen (kip als groente, kiprecept "vegetarisch").
    if (!this.store.get<boolean>('categoriesFixed1', false)) {
      const fixed = this.catalog.fixGuessedCategories();
      this.store.set('categoriesFixed1', true);
      if (fixed.ingredients || fixed.recipes) console.log(`Categorieën rechtgezet: ${fixed.ingredients} ingrediënten, ${fixed.recipes} recepten niet meer vegetarisch.`);
    }
    // Na een herstart de laatste mandberekening (hooguit tien minuten oud) meteen weer gebruiken.
    const snap = this.store.get<PlanSnapshot | null>('planSnapshot', null);
    if (snap && this.now() - snap.at >= 0 && this.now() - snap.at < PICNIC_READ_INTERVAL && snap.shopMode === this.shopMode) {
      this.#planCache = { plan: snap.plan, at: snap.at, generation: this.#generation };
      this.#cartRead = { at: snap.cartAt, shop: this.shop, cart: snap.cart };
      this.#snapshot = true;
    }
  }

  notify(notice: Notice) {
    if (notice.key) {
      if (this.store.wasNotified(notice.key)) return;
      this.store.markNotified(notice.key);
    }
    this.events.emit('notify', notice);
  }
  changed() { this.events.emit('change'); }
  /** Telt elke wijziging; zo ziet bijvoorbeeld de Telegram-bot of een bericht iets veranderde. */
  get revision() { return this.#generation; }

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
    this.#forgetCart();
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
    if (!force && age >= 0 && age < PICNIC_READ_INTERVAL) return this.#slots!.slots;
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
      this.#forgetCart();
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

  /**
   * Aangevinkte gerechten vervangen. Met een opmerking en een AI: een aangepast recept volgens die
   * opmerking ("met kippenpoten", "zonder paprika", "iets vegetarisch"). Anders kiest Weekmand een
   * ander recept uit de catalogus, met de opmerking als wens.
   */
  async replaceMeals(input: { dates?: unknown; note?: unknown }) {
    const dates = [...new Set(Array.isArray(input.dates) ? input.dates.map(String) : [])];
    check(dates.length >= 1 && dates.length <= 14, 'Vink één of meer gerechten aan.');
    const note = String(input.note ?? '').trim().slice(0, 300);
    const results: { date: string; day: string; from: string; to: string; how: 'aangepast' | 'ander recept' }[] = [];
    for (const date of dates) {
      const meal = this.store.meal(date);
      check(meal, `Op ${date} staat geen gerecht.`);
      const old = this.catalog.recipe(meal.recipeId);
      let adapted: AdaptedRecipe | null = null;
      if (note && old && this.recipeAdapter) {
        adapted = await this.recipeAdapter({
          name: old.name, minutes: old.minutes, steps: old.steps, tags: old.tags,
          ingredients: old.ingredients.map(i => ({ name: this.catalog.ingredient(i.key)?.name ?? i.key, amount: i.amount, unit: i.unit })),
        }, note);
      }
      if (adapted) {
        let id = slug(adapted.name) || 'recept';
        for (let n = 2; this.catalog.recipe(id); n++) id = `${slug(adapted.name).slice(0, 56)}-${n}`;
        const recipe = this.catalog.addRecipe({ ...adapted, id }, 'ai');
        await this.setMeal({ date, recipeId: recipe.id, servings: meal.servings, ...(meal.note ? { note: meal.note } : {}) });
        results.push({ date, day: dayName(date), from: old?.name ?? meal.recipeId, to: recipe.name, how: 'aangepast' });
      } else {
        const swapped = await this.swapMeal(date, note);
        results.push({ date, day: dayName(date), from: old?.name ?? meal.recipeId, to: swapped.recipe.name, how: 'ander recept' });
      }
    }
    return results;
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
    // Wat al in de (Picnic-)mand ligt, uit de laatst berekende mand: geen extra verzoek bij de winkel.
    const inCart = new Map<string, number>();
    for (const l of this.#planCache?.plan.lines ?? []) {
      if (l.key && l.inCartAmount) inCart.set(l.key, Math.max(inCart.get(l.key) ?? 0, l.inCartAmount));
    }
    const items = rows.map(p => {
      const def = this.catalog.ingredient(p.key);
      const s = stockState(p, this.now());
      const status = !s.known ? 'onbekend' : p.amount === 0 ? 'op' : p.minimum > 0 && p.amount! <= p.minimum ? 'bijna op' : 'ok';
      return {
        key: p.key, name: def?.name ?? p.key, category: def?.category ?? 'overig', unit: def?.unit ?? 'st',
        amount: p.amount, text: p.amount === null ? 'onbekend' : formatAmount(p.amount, def?.unit ?? 'st'),
        minimum: p.minimum, checkedAt: p.checkedAt, estimate: !s.fresh, status, neededThisOrder: need.get(p.key) ?? 0,
        inCart: inCart.get(p.key) ?? 0,
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
      let product = item.productId ? await this.#findProduct(item.productId, item.name) : undefined;
      if (item.productId) check(product, `Ik vind product ${item.productId} niet meer; zoek het opnieuw op.`);
      if (!product) {
        // "Kippenpoten 650 g" vindt niets; "kippenpoten" wel.
        for (const query of [item.name, baseName(item.name)]) {
          if (!query) continue;
          const results = (await this.#requireShop().search(query)).filter(p => p.available);
          for (const r of results) this.#searchCache.set(r.id, r);
          product = results[0];
          if (product) break;
        }
      }
      check(product, `Ik vind "${item.name}" niet in de ${this.shop.label.toLowerCase()}.`);
      added.push({ id: randomUUID().slice(0, 8), kind: 'product', productId: product.id, name: product.name, unitQuantity: product.unitQuantity, cents: product.cents, quantity, ...(def ? { key: def.key } : {}) });
    }
    this.#setOrder(o => ({
      ...o,
      extras: [...o.extras, ...added],
      skip: o.skip.filter(k => !added.some(a => (a.kind === 'ingredient' ? a.key : a.key ?? a.productId) === k)),
      // Weggeveegde regels blijven weg, behalve een product dat je nu zelf weer toevoegt.
      declined: (o.declined ?? []).filter(id => !added.some(a => a.kind === 'product' && a.productId === id)),
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
        const cart = this.shop.ready() ? (await this.#readCart(this.shop, PICNIC_READ_INTERVAL)).cart : null;
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
    let results = await this.#requireShop().search(query.trim());
    // "kippenpoten 650 gram" vindt bij Picnic niets; "kippenpoten" wel.
    const bare = baseName(query);
    if (!results.length && bare && bare !== normalize(query)) results = await this.#requireShop().search(bare);
    for (const r of results) this.#searchCache.set(r.id, r);
    return results;
  }

  links() { return this.store.links(); }

  /** Afbeelding-id per Picnic-product, voor de productfoto's in de webapp. Blijft bewaard na een herstart. */
  #images: Record<string, string> | null = null;
  #imageMap() { return this.#images ??= this.store.get<Record<string, string>>('productImages', {}); }
  #noteImages(found: Record<string, string>) {
    const all = this.#imageMap();
    let changed = false;
    for (const [id, image] of Object.entries(found)) if (all[id] !== image) { delete all[id]; all[id] = image; changed = true; }
    if (!changed) return;
    const ids = Object.keys(all);
    for (const id of ids.slice(0, Math.max(0, ids.length - 2000))) delete all[id];
    this.store.set('productImages', all);
  }
  productImage(productId: string): string | undefined { return this.#imageMap()[productId]; }

  /** Het voorstel met de bekende productfoto's, voor de webapp. */
  withImages<T extends { lines: { productId: string }[] }>(plan: T): T {
    return { ...plan, lines: plan.lines.map(l => { const image = this.productImage(l.productId); return image ? { ...l, image } : l; }) };
  }

  /**
   * Meer over één product, voor het productvenster in de webapp: foto, merk en omschrijving van de
   * productpagina bij Picnic, en voor welk ingrediënt Weekmand het koopt (key).
   */
  async productInfo(id: string) {
    check(/^[A-Za-z0-9_-]{1,64}$/.test(id), 'Onbekend product.');
    const key = this.#productKey(id);
    const image = this.productImage(id);
    const base = { id, ...(image ? { image } : {}), ...(key ? { key } : {}) };
    if (this.shopMode !== 'picnic' || !this.picnic.ready()) return base;
    try {
      return { ...await this.picnic.product(id), ...base };
    } catch {
      return base;
    }
  }

  /** Een product dat eerder gezocht is; anders opnieuw zoeken op de naam (de zoekcache verdwijnt bij een herstart). */
  async #findProduct(productId: string, hint?: string) {
    const cached = this.#searchCache.get(productId);
    if (cached || !hint) return cached;
    for (const query of [hint, baseName(hint)]) {
      if (!query) continue;
      for (const r of await this.#requireShop().search(query)) this.#searchCache.set(r.id, r);
      if (this.#searchCache.has(productId)) return this.#searchCache.get(productId);
    }
    return undefined;
  }

  /**
   * Koppel een ingrediënt aan een gekozen product (uit search_products), ook vanuit de chat.
   * perPack: hoeveel van het ingrediënt één verpakking dekt, als de verpakking zich niet laat omrekenen
   * (een ingrediënt in stuks, een product in gram).
   */
  async linkProductFor(name: string, productId: string, options: { productName?: string; perPack?: number } = {}) {
    const def = this.catalog.resolve(name);
    check(def, `Ik ken "${name}" niet als ingrediënt.`);
    const product = await this.#findProduct(productId, options.productName ?? def.query ?? def.name);
    check(product, 'Zoek het product eerst op met search_products en gebruik het product_id daaruit.');
    return this.linkProduct(def.name, product.id, options.perPack);
  }

  linkProduct(name: string, productId: string, perPack?: number) {
    const def = this.catalog.resolve(name);
    check(def, `Ik ken "${name}" niet als ingrediënt.`);
    const product = this.#searchCache.get(productId);
    check(product, 'Zoek het product eerst op.');
    const amount = packAmount(product.unitQuantity, def) ?? (Number(perPack) > 0 && Number(perPack) < 100000 ? Number(perPack) : null);
    check(amount, `Ik kan de verpakking "${product.unitQuantity}" niet omrekenen naar ${def.unit}. Geef per_pack mee (hoeveel ${def.unit === 'st' ? 'stuks' : def.unit} één verpakking dekt) of kies een ander product.`);
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

  /** De mand lezen, of binnen `maxAge` ms de vorige lezing hergebruiken. */
  async #readCart(shop: Shop, maxAge = 0): Promise<{ cart: ShopCart; at: number }> {
    const c = this.#cartRead;
    const age = c ? this.now() - c.at : Infinity;
    if (c && c.shop === shop && age >= 0 && age < maxAge) return c;
    const epoch = this.#cartEpoch;
    const cart = await shop.readCart();
    const read = { at: this.now(), shop, cart };
    // Schreef Weekmand tijdens het lezen naar de mand, dan is deze lezing al verouderd: niet bewaren.
    if (epoch === this.#cartEpoch) this.#cartRead = read;
    return read;
  }
  /** Na een schrijfactie op de mand (of een ander bezorgmoment) de mand opnieuw lezen. */
  #forgetCart() {
    this.#cartRead = null;
    this.#cartEpoch++;
    if (this.#snapshot) { this.store.set('planSnapshot', null); this.#snapshot = false; }
  }

  /** cartMaxAge: een eerdere lezing van de Picnic-mand mag zo oud zijn (ms); standaard altijd vers. */
  async plan(options: { cartMaxAge?: number } = {}): Promise<Plan & { id: string; window: { start: string; end: string }; cartReadAt: string; meals: { date: string; day: string; name: string; servings: number }[] }> {
    const shop = this.#requireShop();
    const generation = this.#generation;
    const run = ++this.#planRuns;
    this.consumePastMeals();
    const w = await this.window();
    const meals: PlanMeal[] = this.store.meals(w.start, w.end).flatMap(m => {
      const recipe = this.catalog.recipe(m.recipeId);
      return recipe ? [{ date: m.date, recipe, servings: m.servings }] : [];
    });
    const keys = new Set([...meals.flatMap(m => m.recipe.ingredients.map(i => i.key)), ...this.store.pantry().filter(p => p.minimum > 0).map(p => p.key),
      ...this.order.extras.flatMap(e => e.kind === 'ingredient' ? [e.key] : [])]);
    await this.#ensureLinks([...keys].filter(k => !this.catalog.ingredient(k)?.staple || (this.store.pantryItem(k)?.amount === 0)));
    const { cart, at: cartAt } = await this.#readCart(shop, options.cartMaxAge);
    this.#rememberCartRecipes(cart);
    const ledger = this.#syncLedger(cart);
    const plan = buildPlan({
      meals, household: this.household, pantry: this.store.pantry(), order: this.order, regulars: this.regulars(), avoid: this.avoid,
      cart, ledger: ledger.lines, ingredient: k => this.catalog.ingredient(k), options: k => this.#options(k),
      productKey: (id, name) => this.#productKey(id, name), now: this.now(),
    });
    const id = randomUUID();
    const result = {
      ...plan, id, window: { start: w.start, end: w.end }, computedAt: new Date(this.now()).toISOString(), cartReadAt: new Date(cartAt).toISOString(),
      meals: meals.map(m => ({ date: m.date, day: dayName(m.date), name: m.recipe.name, servings: m.servings })),
    };
    // Is intussen een nieuwere berekening gestart, dan bewaart die het overzicht; deze mag hem niet overschrijven.
    if (run === this.#planRuns) {
      this.store.set('review', { id, createdAt: this.now(), plan } satisfies StoredReview);
      this.#planCache = { plan: result, at: this.now(), generation };
      // Bewaren voor na een herstart, maar alleen als er tijdens het rekenen niets veranderde.
      if (generation === this.#generation) {
        this.store.set('planSnapshot', { at: this.now(), shopMode: this.shopMode, plan: result, cart, cartAt } satisfies PlanSnapshot);
        this.#snapshot = true;
      }
    }
    return result;
  }

  /**
   * Het gedeelde overzicht voor het hele huishouden: het bewaarde overzicht als er sindsdien niets
   * veranderd is en het jonger is dan `maxAge` (voor wijzigingen in de Picnic-app zelf), anders
   * opnieuw berekenen. Gelijktijdige verzoeken wachten op dezelfde berekening.
   */
  async currentPlan(maxAge = PICNIC_READ_INTERVAL) {
    const cache = this.#planCache;
    const generation = this.#generation;
    if (cache && cache.generation === generation && this.now() - cache.at >= 0 && this.now() - cache.at < maxAge) return cache.plan;
    // Een lopende berekening van vóór de laatste wijziging telt niet: die mist de wijziging.
    if (this.#planning?.generation !== generation) {
      // Alleen iets in Weekmand veranderd: de mand van de vorige berekening is nog goed (tot maxAge).
      const promise = this.plan({ cartMaxAge: maxAge }).finally(() => { if (this.#planning?.promise === promise) this.#planning = null; });
      this.#planning = { generation, promise };
    }
    return this.#planning.promise;
  }

  /** Breng de mand naar het goedgekeurde overzicht. Herhaalbaar en veilig bij tussentijdse wijzigingen. */
  async applyPlan(id: string) {
    if (this.store.get<string[]>('doneReviews', []).includes(id)) return { applied: {}, already: true, summary: 'De mand was al bijgewerkt.' };
    const review = this.store.get<StoredReview | null>('review', null);
    check(review && review.id === id, 'Dit overzicht is niet meer actueel. Bereken de mand opnieuw.', 409);
    if (review.done) return { applied: {}, already: true, summary: 'De mand was al bijgewerkt.' };
    // Vers lezen en vergelijken hieronder is de echte controle; dit vangt alleen hele oude overzichten.
    check(this.now() - review.createdAt <= 2 * PICNIC_READ_INTERVAL, 'Dit overzicht is ouder dan een dag. Ververs het uit Picnic.', 409);
    const fresh = await this.plan();
    check(JSON.stringify(fresh.target) === JSON.stringify(review.plan.target) && fresh.cartId === review.plan.cartId,
      'De mand of het menu is intussen veranderd. Bekijk het nieuwe overzicht.', 409);
    const names = new Map(fresh.lines.map(l => [l.productId, l.product]));
    this.#forgetCart();
    const { applied } = await applyChange(this.shop, { cartId: fresh.cartId, before: fresh.before, target: fresh.target }, (productId, delta) => {
      this.store.update<Ledger>('ledger', { cartId: fresh.cartId, lines: {} }, l => ({ ...l, lines: { ...l.lines, [productId]: Math.max(0, (l.lines[productId] ?? 0) + delta) } }));
    }).finally(() => this.#forgetCart());
    this.store.set('review', { id: fresh.id, createdAt: this.now(), plan: fresh, done: true } satisfies StoredReview);
    this.store.update<string[]>('doneReviews', [], ids => [id, fresh.id, ...ids].slice(0, 20));
    // Deze maaltijden zijn nu echt besteld: ze komen in de receptgeschiedenis.
    this.store.markOrdered(fresh.meals.map(m => m.date));
    const parts = Object.entries(applied).map(([pid, d]) => `${d > 0 ? '+' : ''}${d} ${names.get(pid) ?? pid}`);
    this.changed();
    this.events.emit('applied', applied);
    return { applied, already: false, summary: parts.length ? 'Mand bijgewerkt: ' + parts.join(', ') : 'De mand was al in orde.' };
  }

  /** De Picnic-mand zoals het voorstel hem ziet: dezelfde lezing, zodat lijst en voorstel kloppen. */
  async cart(maxAge = PICNIC_READ_INTERVAL) {
    const shop = this.#requireShop();
    const { cart } = await this.#readCart(shop, maxAge);
    this.#rememberCartRecipes(cart);
    const ledger = this.#syncLedger(cart);
    return {
      shop: shop.label, id: cart.id, totalCents: cart.totalCents, lines: cart.lines.map(l => {
        const byWeekmand = ledger.lines[l.id] ?? 0;
        // Voor regels van Weekmand: het ingrediënt, zodat je in de webapp een ander product kunt kiezen.
        const key = byWeekmand ? this.#productKey(l.id) : undefined;
        return { ...l, byWeekmand, ...(key ? { key } : {}) };
      }),
    };
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

  /** Recept van een website ophalen en omrekenen, nog zonder op te slaan. */
  async previewRecipeFromUrl(url: string) {
    check(typeof url === 'string' && url.length <= 2000, 'Geef een link naar een recept.');
    const page = await fetchPage(url);
    const recipe = extractRecipe(page.html, page.url);
    check(recipe, 'Op deze pagina staat geen leesbaar recept. Probeer de link van de receptpagina zelf.', 422);
    return previewRecipe(recipe, this.catalog);
  }

  /** Een geplakte ingrediëntenlijst omrekenen, nog zonder op te slaan. */
  previewRecipeFromText(input: { name?: unknown; servings?: unknown; text?: unknown }) {
    return previewRecipe(recipeFromText(input), this.catalog);
  }

  /** Een (eventueel aangepast) voorbeeld opslaan als recept. */
  saveImportedRecipe(preview: Preview, skip: string[] = []) {
    check(preview && Array.isArray(preview.lines), 'Geen recept om op te slaan.');
    const lines = preview.lines.filter(l => l.status !== 'overgeslagen' && !skip.includes(l.original) && l.amount > 0).slice(0, 30);
    check(lines.length, 'Kies minstens één ingrediënt.');
    const recipe = this.catalog.addRecipe({
      name: String(preview.name), tags: [...(preview.tags ?? []), ...(preview.url ? ['online'] : [])], minutes: Number(preview.minutes) || 30, steps: String(preview.steps ?? ''),
      ingredients: lines.map(l => ({ name: l.key ? this.catalog.ingredient(l.key)?.name ?? l.name : l.name, amount: l.amount, unit: l.unit })),
    }, 'web');
    this.changed();
    return recipe;
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
    this.#forgetCart();
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
    // Het budget krijgt de regels met prijzen meteen mee; oudere bezorgingen haalt syncSpending op.
    for (const d of history.deliveries) {
      const items = d.orders.flatMap(o => o.items);
      const id = 'picnic:' + d.id;
      if (!items.length || items.some(i => typeof i.cents !== 'number') || this.store.spend(id)?.lines) continue;
      const prev = this.store.spend(id);
      this.store.saveSpend({ ...prev, id, source: 'picnic', date: d.date, totalCents: d.paidCents ?? d.totalCents,
        lines: items.map(i => ({ name: i.name, quantity: i.quantity, cents: i.cents! })), ...(d.savingsCents ? { savingsCents: d.savingsCents } : {}) });
    }
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

  // ───────────── Albert Heijn: Mijn lijst en kassabonnen ─────────────

  ahStatus() {
    return {
      linked: this.ah.linked, linkedAt: this.ah.linkedAt, loginUrl: AH_LOGIN_URL,
      lastSync: this.store.get<number>('ahLastSync', 0) || null,
      receipts: this.store.get<AhReceiptLog[]>('ahReceiptLog', []).slice(0, 5),
      unmatched: this.unmatchedReceiptLines(),
    };
  }

  async linkAh(text: string) {
    await this.ah.link(text);
    // Bonnen van de afgelopen drie dagen tellen mee; oudere zitten al in de voorraad (of zijn op).
    if (!this.store.get<string | null>('ahSince', null)) this.store.set('ahSince', addDays(localDate(this.now()), -3));
    this.changed();
    return this.ahStatus();
  }

  unlinkAh() {
    this.ah.unlink();
    this.changed();
  }

  /**
   * Wat Weekmand nog wil kopen en niet al in de Picnic-mand zit, als tekst voor Mijn lijst in de
   * AH-app: de naam van het ingrediënt met de verpakking die Weekmand zou kopen ('Halfvolle melk (1 liter)').
   */
  async ahListProposal() {
    const plan = await this.currentPlan();
    return plan.lines.filter(l => l.add > 0 && !l.declined).map(l => {
      const def = l.key ? this.catalog.ingredient(l.key) : undefined;
      const name = def?.name ?? l.product;
      return { id: l.productId, text: l.unitQuantity ? `${name} (${l.unitQuantity})` : name, quantity: l.add, match: def ? normalize(def.name) : baseName(l.product) };
    });
  }

  /**
   * Zet boodschappen op Mijn lijst in de AH-app. Zonder keuze: alles wat Weekmand nog wil kopen.
   * Wat al (niet afgestreept) op de lijst staat, wordt overgeslagen.
   */
  async sendToAhList(input: { ids?: string[]; extra?: string[] } = {}) {
    check(this.ah.linked, 'Koppel eerst je AH-account (Meer → Albert Heijn).', 409);
    const proposal = Array.isArray(input.ids) && !input.ids.length ? [] : await this.ahListProposal();
    const chosen = Array.isArray(input.ids) && input.ids.length ? proposal.filter(p => input.ids!.includes(p.id)) : proposal;
    const extra = (Array.isArray(input.extra) ? input.extra : []).map(s => String(s).trim()).filter(s => s && s.length <= 80).slice(0, 30);
    const wanted = [...chosen, ...extra.map(text => ({ text, quantity: 1, match: normalize(text) }))];
    check(wanted.length, 'Er is niets om op de lijst te zetten.');
    const onList = (await this.ah.list()).filter(i => !i.struck).map(i => normalize(i.description));
    const added: typeof wanted = [];
    const skipped: string[] = [];
    for (const w of wanted) {
      if (!w.match || onList.some(d => d.includes(w.match)) || added.some(a => a.match === w.match)) skipped.push(w.text);
      else added.push(w);
    }
    await this.ah.addToList(added.map(a => ({ description: a.text, quantity: a.quantity })));
    return { added: added.map(a => a.text), skipped };
  }

  /** Nieuwe AH-kassabonnen ophalen en de producten bij de voorraad tellen (elke bon één keer). */
  importAhReceipts() {
    // Eén ophaalronde tegelijk (planner en knop), anders kan een bon dubbel tellen.
    this.#ahImport ??= this.#importAhReceipts().finally(() => { this.#ahImport = null; });
    return this.#ahImport;
  }

  async #importAhReceipts() {
    check(this.ah.linked, 'Koppel eerst je AH-account (Meer → Albert Heijn).', 409);
    const since = this.store.get<string | null>('ahSince', null) ?? addDays(localDate(this.now()), -3);
    const applied = new Set(this.store.get<string[]>('ahAppliedReceipts', []));
    const fresh = (await this.ah.receipts(10)).filter(r => !applied.has(r.id) && r.dateTime.slice(0, 10) >= since).reverse().slice(0, 5);
    const done: AhReceiptLog[] = [];
    for (const receipt of fresh) {
      if (done.length && this.searchPause) await new Promise(r => setTimeout(r, this.searchPause));
      const { lines, discounts } = await this.ah.receiptDetails(receipt.id);
      this.#saveAhSpend(receipt.id, receipt.dateTime.slice(0, 10), receipt.total === null ? null : Math.round(receipt.total * 100), lines, discounts);
      const result = this.#addBought(lines);
      applied.add(receipt.id);
      this.store.set('ahAppliedReceipts', [...applied].slice(-200));
      done.unshift({ id: receipt.id, date: receipt.dateTime, total: receipt.total, ...result });
      this.store.update<AhReceiptLog[]>('ahReceiptLog', [], log => [done[0], ...log].slice(0, 10));
    }
    this.store.set('ahLastSync', this.now());
    if (!done.length) return { receipts: done };
    // Onbekende regels: de AI zoekt ze op (als die gekoppeld is). Een fout daarin stopt het ophalen niet.
    if (done.some(r => r.unmatched.length)) await this.matchReceiptLines().catch(error => console.error('Bonregels koppelen:', (error as Error).message));
    this.changed();
    const log = this.store.get<AhReceiptLog[]>('ahReceiptLog', []);
    return { receipts: done.map(d => log.find(l => l.id === d.id) ?? d) };
  }

  /** Producten van een kassabon bij de voorraad tellen. Zonder maat op de bon: één gewone verpakking per stuk. */
  #addBought(lines: AhReceiptLine[]) {
    const counted: string[] = [];
    const unmatched: string[] = [];
    this.store.tx(() => {
      for (const line of lines) {
        if (!(line.quantity > 0) || notGroceries.test(line.name)) continue;
        const quantity = Number.isInteger(line.quantity) && line.quantity <= 50 ? line.quantity : 1;
        const result = this.#countReceiptLine(line.name, quantity);
        if (result === 'ignored') continue;
        if (result) counted.push(result); else unmatched.push(`${quantity}× ${line.name}`);
      }
    });
    return { counted, unmatched };
  }

  /** Telt één bonregel bij de voorraad. Geeft de tekst voor het logboek, 'ignored' of null (onbekend). */
  #countReceiptLine(name: string, quantity: number): string | 'ignored' | null {
    const alias = this.store.get<Record<string, ReceiptAlias>>('receiptAliases', {})[receiptKey(name)];
    if (alias && alias.key === null) return 'ignored';
    const def = alias?.key ? this.catalog.ingredient(alias.key) : this.catalog.resolve(receiptName(name));
    const pack = def ? packAmount(name, def) ?? alias?.amount ?? def.packs[0]?.amount : undefined;
    if (!def || !pack) return null;
    const item = this.store.pantryItem(def.key) ?? { key: def.key, amount: null, checkedAt: null, minimum: 0 };
    this.store.savePantry({ ...item, amount: (item.amount ?? 0) + pack * quantity, checkedAt: new Date(this.now()).toISOString() });
    return `${quantity}× ${name} → ${def.name}`;
  }

  /** Onbekende bonregels uit de recente bonnen, één keer per naam. */
  unmatchedReceiptLines() {
    const seen = new Map<string, { name: string; quantity: number }>();
    for (const entry of this.store.get<AhReceiptLog[]>('ahReceiptLog', [])) {
      for (const text of entry.unmatched) {
        const m = /^(\d+)× (.+)$/.exec(text);
        const name = m ? m[2] : text;
        const known = seen.get(receiptKey(name));
        seen.set(receiptKey(name), { name, quantity: (known?.quantity ?? 0) + (m ? Number(m[1]) : 1) });
      }
    }
    return [...seen.values()];
  }

  /**
   * Laat de AI onbekende bonregels koppelen aan een ingrediënt (of als 'geen boodschap' markeren).
   * Elke uitkomst wordt onthouden, dus een volgende bon met dezelfde regel kost geen AI meer.
   * Zonder `force` vraagt Weekmand een regel maar één keer.
   */
  async matchReceiptLines({ force = false } = {}) {
    const asked = new Set(this.store.get<string[]>('receiptAsked', []));
    const open = this.unmatchedReceiptLines().filter(l => force || !asked.has(receiptKey(l.name))).slice(0, 40);
    if (!open.length) return { matched: [] as string[], unknown: [] as string[] };
    const ingredients = this.catalog.ingredients().map(i => ({ key: i.key, name: i.name, unit: i.unit }));
    const answers = this.receiptMatcher ? await this.receiptMatcher(open.map(l => l.name), ingredients) : null;
    if (!answers) {
      check(!force, 'Koppel eerst een AI-aanbieder (Meer → AI-aanbieder), of koppel de regels zelf.', 409);
      return { matched: [] as string[], unknown: open.map(l => l.name) };
    }
    const aliases = this.store.get<Record<string, ReceiptAlias>>('receiptAliases', {});
    const matched: string[] = [];
    for (const a of answers) {
      const line = open.find(l => receiptKey(l.name) === receiptKey(String(a.receipt ?? '')));
      if (!line) continue;
      const amount = typeof a.amount === 'number' && a.amount > 0 && a.amount <= 20_000 ? a.amount : undefined;
      if (a.kind === 'ignore') aliases[receiptKey(line.name)] = { key: null, by: 'ai' };
      else if (a.kind === 'existing' && a.key && this.catalog.ingredient(a.key)) aliases[receiptKey(line.name)] = { key: a.key, amount, by: 'ai' };
      else if (a.kind === 'new' && typeof a.name === 'string' && /^[\p{L}\d' -]{2,40}$/u.test(a.name.trim()) && ['g', 'ml', 'st'].includes(String(a.unit))) {
        const def = this.catalog.ensureIngredient(a.name.trim(), a.unit as BaseUnit, categories.includes(a.category as Category) ? a.category as Category : undefined);
        aliases[receiptKey(line.name)] = { key: def.key, amount, by: 'ai' };
      } else continue;
      matched.push(line.name);
    }
    this.store.set('receiptAliases', aliases);
    this.store.set('receiptAsked', [...new Set([...asked, ...open.map(l => receiptKey(l.name))])].slice(-500));
    this.#recountReceiptLog();
    return { matched, unknown: open.map(l => l.name).filter(n => !matched.includes(n)) };
  }

  /** Zelf een bonregel koppelen aan een ingrediënt (naam of sleutel), of met null negeren. */
  mapReceiptLine(name: string, ingredient: string | null) {
    check(typeof name === 'string' && name.trim() && name.length <= 80, 'Welke bonregel?');
    let alias: ReceiptAlias = { key: null, by: 'user' };
    if (ingredient !== null) {
      const def = this.catalog.ingredient(String(ingredient)) ?? this.catalog.resolve(String(ingredient));
      check(def, `Ik ken "${ingredient}" niet. Voeg het eerst toe onder Voorraad (Ander product bijhouden).`);
      alias = { key: def.key, by: 'user' };
    }
    this.store.update<Record<string, ReceiptAlias>>('receiptAliases', {}, a => ({ ...a, [receiptKey(name)]: alias }));
    this.#recountReceiptLog();
    this.changed();
    return { name: name.trim(), key: alias.key };
  }

  /** Onbekende regels in het logboek die inmiddels gekoppeld zijn alsnog bij de voorraad tellen. */
  #recountReceiptLog() {
    const log = this.store.get<AhReceiptLog[]>('ahReceiptLog', []);
    this.store.tx(() => {
      for (const entry of log) {
        const still: string[] = [];
        for (const text of entry.unmatched) {
          const m = /^(\d+)× (.+)$/.exec(text);
          const result = m ? this.#countReceiptLine(m[2], Number(m[1])) : null;
          if (result === 'ignored') (entry.ignored ??= []).push(m![2]);
          else if (result) entry.counted.push(result);
          else still.push(text);
        }
        entry.unmatched = still;
      }
      this.store.set('ahReceiptLog', log);
    });
  }

  // ───────────── Budget: wat er werkelijk uitgegeven is ─────────────

  /** Maandbudget (standaard afgeleid van het mandbudget per bestelling) en limieten per categorie. */
  budgetSettings() {
    const s = this.store.get<BudgetPrefs>('budget', {});
    const derived = Math.round(this.household.budget * 52 / 12 / 5) * 500;
    return { monthCents: s.monthCents ?? derived, custom: !!s.monthCents, limits: s.limits ?? {} };
  }

  setBudget(input: { month?: unknown; limit?: { category?: unknown; month?: unknown } }) {
    const empty = (v: unknown) => v === null || v === '' || v === 0 || v === '0';
    this.store.update<BudgetPrefs>('budget', {}, s => {
      const next: BudgetPrefs = { ...s, limits: { ...s.limits } };
      if (input.month !== undefined) {
        if (empty(input.month)) delete next.monthCents;
        else {
          const m = Number(String(input.month).replace(',', '.'));
          check(Number.isFinite(m) && m >= 10 && m <= 20000, 'Kies een maandbudget tussen € 10 en € 20.000.');
          next.monthCents = Math.round(m * 100);
        }
      }
      if (input.limit) {
        const category = String(input.limit.category) as BudgetCategory;
        check(categoryKeys.includes(category), 'Onbekende categorie.');
        if (empty(input.limit.month)) delete next.limits![category];
        else {
          const v = Number(String(input.limit.month).replace(',', '.'));
          check(Number.isFinite(v) && v > 0 && v <= 20000, 'Kies een limiet tussen € 0 en € 20.000 per maand.');
          next.limits![category] = Math.round(v * 100);
        }
      }
      return next;
    });
    return this.budgetSettings();
  }

  /** Hoe een product meetelt: eigen keuze, dan de AI, dan vaste regels, dan de catalogus. */
  #labeler() {
    const saved = this.store.get<Record<string, ProductLabel>>('productLabels', {});
    const aliases = this.store.get<Record<string, ReceiptAlias>>('receiptAliases', {});
    const memo = new Map<string, ProductLabel | null>();
    return (name: string): ProductLabel | null => {
      const key = labelKey(name);
      if (memo.has(key)) return memo.get(key)!;
      let label: ProductLabel | null = saved[key] ?? null;
      const rule = label ? null : ruleCategory(name);
      if (rule) label = { category: rule, kind: kindOf(rule), by: 'regel' };
      if (!label) {
        const alias = aliases[receiptKey(name)];
        if (alias && !alias.key) label = { category: 'huishouden', kind: 'geen-eten', by: 'catalogus' };
        else {
          const def = alias?.key ? this.catalog.ingredient(alias.key) : this.catalog.resolve(name) ?? this.catalog.resolve(receiptName(name));
          if (def) { const category = categoryFromCatalog(def.category); label = { category, kind: kindOf(category), by: 'catalogus' }; }
        }
      }
      memo.set(key, label);
      return label;
    };
  }

  /**
   * Totalen en regels van Picnic-bezorgingen en AH-kassabonnen bijhouden. De totalen komen in één
   * keer (een paar verzoeken); de regels per aankoop rustig aan, `details` per keer, nieuwste eerst.
   */
  syncSpending(options: { details?: number } = {}) {
    this.#spendSync ??= this.#syncSpending(Math.max(1, Math.min(20, options.details ?? 4))).finally(() => { this.#spendSync = null; });
    return this.#spendSync;
  }

  async #syncSpending(details: number) {
    const result = { added: 0, detailed: 0, errors: [] as string[] };
    const today = localDate(this.now());
    const cutoff = addDays(today, -3 * 366);
    let calls = 0;
    const pause = async () => { if (calls++ && this.searchPause) await new Promise(r => setTimeout(r, this.searchPause)); };
    // AH-bonnen van vóór de bonusregels komen ook nog een keer langs.
    const missing = (source: SpendSource, n: number) => [...this.store.spendIndex(source)].filter(([, v]) => !v.detailed || (source === 'ah' && !v.discounts))
      .sort((a, b) => b[1].date.localeCompare(a[1].date)).slice(0, n);
    if (this.picnic.ready()) {
      try {
        await pause();
        const index = this.store.spendIndex('picnic');
        for (const s of await this.picnic.deliverySummaries()) {
          if (s.status !== 'COMPLETED' || !s.id) continue;
          const when = Date.parse(s.windowStart ?? s.creationTime);
          if (!Number.isFinite(when) || when > this.now()) continue;
          const date = localDate(when);
          if (date < cutoff || index.has('picnic:' + s.id)) continue;
          this.store.saveSpend({ id: 'picnic:' + s.id, source: 'picnic', date, totalCents: s.totalPrice });
          result.added++;
        }
        for (const [id, v] of missing('picnic', details)) {
          await pause();
          this.#savePicnicSpend(id, v.date, await this.picnic.delivery(id.slice('picnic:'.length)));
          result.detailed++;
        }
      } catch (error) { result.errors.push('Picnic: ' + (error as Error).message); }
    }
    if (this.ah.linked) {
      try {
        const index = this.store.spendIndex('ah');
        const state = this.store.get<{ ahOffset?: number; ahDone?: boolean }>('spendBackfill', {});
        // Elke keer de nieuwste bonnen, en zolang het terugzoeken niet klaar is één oudere pagina.
        for (const offset of [0, ...(state.ahDone ? [] : [state.ahOffset ?? 25])]) {
          await pause();
          const page = await this.ah.receipts(25, offset);
          let fresh = 0;
          for (const r of page) {
            const date = r.dateTime.slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < cutoff || r.total === null || index.has('ah:' + r.id)) continue;
            this.store.saveSpend({ id: 'ah:' + r.id, source: 'ah', date, totalCents: Math.round(r.total * 100) });
            index.set('ah:' + r.id, { date, detailed: false });
            result.added++;
            fresh++;
          }
          // Klaar bij een korte pagina, bonnen van vóór de grens, of een pagina zonder nieuwe bonnen (dan bladert AH niet verder).
          if (offset) this.store.set('spendBackfill', { ahOffset: offset + 25, ahDone: page.length < 25 || !fresh || page.some(r => r.dateTime.slice(0, 10) < cutoff) });
        }
        for (const [id, v] of missing('ah', Math.max(1, Math.ceil(details * 3 / 4)))) {
          await pause();
          const { lines, discounts } = await this.ah.receiptDetails(id.slice(3));
          this.#saveAhSpend(id.slice(3), v.date, null, lines, discounts);
          result.detailed++;
        }
      } catch (error) { result.errors.push('AH: ' + (error as Error).message); }
    }
    this.store.set('spendSync', { at: this.now(), errors: result.errors });
    return result;
  }

  #savePicnicSpend(id: string, date: string, d: { orders: { status: string; checkoutTotalPrice: number; promotionSavings: number; membershipSavings: number; items: { name: string; quantity: number; displayPrice: number }[] }[] }) {
    const orders = d.orders.filter(o => o.status !== 'CANCELLED');
    const prev = this.store.spend(id);
    const savings = orders.reduce((sum, o) => sum + (o.promotionSavings || 0) + (o.membershipSavings || 0), 0);
    this.store.saveSpend({
      ...prev, id, source: 'picnic', date,
      totalCents: orders.reduce((sum, o) => sum + (o.checkoutTotalPrice || 0), 0) || prev?.totalCents || 0,
      lines: orders.flatMap(o => o.items.map(i => ({ name: i.name, quantity: i.quantity, cents: Math.round(i.displayPrice || 0) }))),
      ...(savings > 0 ? { savingsCents: savings } : {}),
    });
  }

  /** Een AH-bon in het uitgavenboek; de bonusregels worden op naam aan de producten gekoppeld. */
  #saveAhSpend(receiptId: string, date: string, totalCents: number | null, lines: AhReceiptLine[], discounts: AhDiscount[] | null) {
    const id = 'ah:' + receiptId;
    const prev = this.store.spend(id);
    const mapped = lines.map(l => ({ name: l.name, quantity: l.quantity || 1, cents: Math.round((l.amount ?? 0) * 100) }));
    const found = discounts ? matchDiscounts(mapped, discounts.map(d => ({ name: d.name, cents: Math.round(d.amount * 100) })).filter(d => d.cents)) : prev?.discounts;
    this.store.saveSpend({ ...prev, id, source: 'ah', date, totalCents: totalCents ?? prev?.totalCents ?? mapped.reduce((sum, l) => sum + l.cents, 0), lines: mapped, ...(found ? { discounts: found } : {}) });
  }

  /** Het overzicht voor de Budget-tab: één periode, met de trend ervoor. */
  budgetOverview(input: { period?: unknown; offset?: unknown } = {}) {
    const period: Period = input.period === 'week' || input.period === 'year' ? input.period : 'month';
    const offset = Math.max(-600, Math.min(0, Math.round(Number(input.offset) || 0)));
    const today = localDate(this.now());
    const range = periodRange(period, today, offset);
    const spends = this.store.spends(range.start, range.end);
    const counted = spends.filter(s => !s.excluded);
    const label = this.#labeler();
    const summary = summarize(counted, label);
    const settings = this.budgetSettings();
    const budget = budgetFor(period, settings.monthCents);
    const current = today >= range.start && today <= range.end;
    const elapsed = current ? Math.round((Date.parse(today) - Date.parse(range.start)) / day) + 1 : range.days;
    const first = this.store.firstSpendDate();
    const n = period === 'year' ? Math.min(8, Math.max(1, Number(range.start.slice(0, 4)) - Number((first ?? range.start).slice(0, 4)) + 1)) : 12;
    const ranges = Array.from({ length: n }, (_, i) => ({ ...periodRange(period, today, offset - (n - 1 - i)), offset: offset - (n - 1 - i) }));
    const previous = periodRange(period, today, offset - 1);
    const totals = this.store.spendTotals(ranges[0].start < previous.start ? ranges[0].start : previous.start, range.end);
    const sum = (r: { start: string; end: string }) => totals.reduce((s, t) => t.date >= r.start && t.date <= r.end ? s + t.cents : s, 0);
    const persons = Math.max(1, this.household.adults + this.household.children + this.household.toddlers);
    const index = [...this.store.spendIndex('picnic').values(), ...this.store.spendIndex('ah').values()];
    const sync = this.store.get<{ at: number; errors: string[] } | null>('spendSync', null);
    return {
      period, offset, range, current, elapsed, today,
      budget, monthBudget: settings.monthCents, customBudget: settings.custom,
      ...summary,
      previousCents: sum(previous), previousLabel: previous.label,
      forecastCents: current && elapsed < range.days && summary.totalCents ? Math.round(summary.totalCents / elapsed * range.days) : null,
      perPersonDayCents: Math.round(summary.totalCents / persons / elapsed),
      persons,
      trend: ranges.map(r => ({ label: r.short, title: r.label, offset: r.offset, cents: sum(r), budget: budgetFor(period, settings.monthCents) })),
      limits: Object.fromEntries(Object.entries(settings.limits).map(([k, v]) => [k, budgetFor(period, v ?? 0)])),
      monthLimits: settings.limits,
      products: summary.products.slice(0, 200),
      unlabeled: summary.products.filter(p => !p.by).length,
      priceChanges: priceChanges(this.store.spends(addDays(range.end, -365), range.end).filter(s => !s.excluded)).slice(0, 10),
      purchases: [...spends].reverse().map(s => ({
        id: s.id, source: s.source, date: s.date, totalCents: s.totalCents, detailed: !!s.lines, lines: s.lines?.length ?? 0,
        shop: s.source === 'picnic' ? 'Picnic' : s.source === 'ah' ? 'Albert Heijn' : s.shop ?? 'Overig', note: s.note ?? null, category: s.category ?? null, excluded: !!s.excluded,
      })),
      categoryList: budgetCategories.map(c => ({ key: c.key, label: c.label, kind: c.kind })),
      sync: { at: sync?.at ?? null, errors: sync?.errors ?? [], pending: index.filter(v => !v.detailed).length, total: index.length, sources: { picnic: this.picnic.ready(), ah: this.ah.linked } },
    };
  }

  /** De regels van één aankoop, met hoe elk product meetelt. */
  spendDetail(id: string) {
    const spend = this.store.spend(String(id));
    check(spend, 'Onbekende aankoop.', 404);
    const label = this.#labeler();
    const bonus = bonusPerLine(spend);
    return {
      ...spend,
      lines: spend.lines?.map((l, i) => {
        const adjustment = adjustmentLine.test(l.name) || l.cents < 0;
        const found = adjustment ? null : label(l.name);
        return {
          ...l, adjustment, category: found?.category ?? null, kind: found?.kind ?? null, by: found?.by ?? null,
          bonusCents: bonus.perLine.get(i) ?? 0, bonusNames: (spend.discounts ?? []).filter(d => d.line === i).map(d => d.name),
        };
      }) ?? null,
      /** Bonusregels die Weekmand niet aan een product kon koppelen. */
      looseDiscounts: (spend.discounts ?? []).filter(d => d.line === null || !spend.lines?.[d.line]),
    };
  }

  /** Productnamen die nog niet ingedeeld zijn (geen eigen keuze, AI, regel of catalogus). */
  unlabeledProducts(includeAsked = false) {
    const label = this.#labeler();
    // Pas na drie pogingen zonder antwoord laat Weekmand een product rusten (tot je zelf op "AI indelen" tikt).
    const tries = this.store.get<Record<string, number>>('productLabelTries', {});
    const asked = new Set(includeAsked ? [] : Object.keys(tries).filter(k => tries[k] >= 3));
    const names = new Map<string, string>();
    const today = localDate(this.now());
    for (const s of this.store.spends(addDays(today, -3 * 366), today)) {
      for (const l of s.lines ?? []) {
        const key = labelKey(l.name);
        if (l.cents <= 0 || adjustmentLine.test(l.name) || names.has(key) || asked.has(key) || label(l.name)) continue;
        names.set(key, l.name);
      }
    }
    return [...names.values()];
  }

  /** Laat de AI producten indelen (categorie, en of het nodig of extra is). Zonder AI: niets (force: 409). */
  async labelProducts(options: { force?: boolean } = {}) {
    const names = this.unlabeledProducts(options.force);
    if (!names.length) return { labeled: 0, remaining: 0 };
    if (!this.productClassifier) {
      check(!options.force, 'Koppel eerst een AI (Meer → AI-aanbieder) om producten te laten indelen.', 409);
      return { labeled: 0, remaining: names.length };
    }
    // Kleine porties: een lange lijst past niet in één antwoord en komt dan maar half terug.
    let labeled = 0, asked = 0;
    for (let i = 0; i < Math.min(names.length, 100); i += 25) {
      const batch = names.slice(i, i + 25);
      const answers = await this.productClassifier(batch);
      if (!answers) break;
      labeled += this.#saveProductLabels(batch, answers);
      asked += batch.length;
    }
    return { labeled, remaining: names.length - asked };
  }

  #saveProductLabels(batch: string[], answers: { name: string; category: BudgetCategory; kind: SpendKind }[]) {
    const wanted = new Set(batch.map(labelKey));
    const answered = new Set<string>();
    let labeled = 0;
    this.store.update<Record<string, ProductLabel>>('productLabels', {}, saved => {
      for (const a of answers) {
        const key = labelKey(String(a.name ?? ''));
        if (!wanted.has(key) || !categoryKeys.includes(a.category) || !kindKeys.includes(a.kind)) continue;
        answered.add(key);
        if (saved[key]?.by === 'user') continue;
        saved[key] = { category: a.category, kind: a.kind, by: 'ai' };
        labeled++;
      }
      return saved;
    });
    this.store.update<Record<string, number>>('productLabelTries', {}, tries => {
      for (const key of wanted) if (answered.has(key)) delete tries[key]; else tries[key] = (tries[key] ?? 0) + 1;
      return tries;
    });
    return labeled;
  }

  setProductLabel(input: { name?: unknown; category?: unknown; kind?: unknown }) {
    const name = String(input.name ?? '').trim();
    check(name && name.length <= 200, 'Geen product.');
    const category = String(input.category) as BudgetCategory;
    check(categoryKeys.includes(category), 'Onbekende categorie.');
    const kind = (input.kind ? String(input.kind) : kindOf(category)) as SpendKind;
    check(kindKeys.includes(kind), 'Kies nodig, extra of geen-eten.');
    this.store.update<Record<string, ProductLabel>>('productLabels', {}, saved => ({ ...saved, [labelKey(name)]: { category, kind, by: 'user' } }));
    return { name, category, kind };
  }

  /** Een uitgave buiten Picnic en AH (markt, bakker, andere supermarkt). Negatief bedrag = terugbetaling. */
  addExpense(input: { date?: unknown; amount?: unknown; shop?: unknown; category?: unknown; note?: unknown }) {
    const today = localDate(this.now());
    const date = typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : today;
    check(date <= today && date >= addDays(today, -5 * 366), 'Kies een datum in de afgelopen vijf jaar.');
    const amount = Number(String(input.amount ?? '').replace(',', '.'));
    check(Number.isFinite(amount) && amount !== 0 && Math.abs(amount) <= 5000, 'Vul een bedrag in (maximaal € 5.000).');
    const category = (input.category ? String(input.category) : 'overig') as BudgetCategory;
    check(categoryKeys.includes(category), 'Onbekende categorie.');
    const shop = String(input.shop ?? '').trim().slice(0, 60) || 'Overig';
    const note = String(input.note ?? '').trim().slice(0, 120);
    const spend: Spend = { id: 'manual:' + randomUUID().slice(0, 8), source: 'manual', date, totalCents: Math.round(amount * 100), shop, category, ...(note ? { note } : {}) };
    this.store.saveSpend(spend);
    return spend;
  }

  /**
   * Foto van een kassabon (data-URL) laten lezen door de AI. Slaat nog niets op: de gebruiker
   * controleert winkel, datum, totaal en regels eerst.
   */
  async previewReceiptPhoto(dataUrl: unknown) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''));
    check(m, 'Kies een foto (jpg, png of webp).');
    check(m[2].length <= 8_000_000, 'De foto is te groot. Maak hem kleiner of dichterbij.');
    check(this.receiptReader, 'Koppel eerst een AI (Meer → AI-aanbieder) om bonnetjes te lezen.', 409);
    const today = localDate(this.now());
    const read = await this.receiptReader({ mediaType: m[1] as ImageInput['mediaType'], data: m[2] }, today);
    check(read, 'Koppel eerst een AI (Meer → AI-aanbieder) om bonnetjes te lezen.', 409);
    check(read.lines.length, 'Op deze foto kon de AI geen kassabon lezen. Probeer een scherpere foto, recht van boven, met de hele bon erop.', 422);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(read.date) && read.date <= today && read.date >= addDays(today, -5 * 366) ? read.date : today;
    const shop = read.shop && read.shop === read.shop.toUpperCase() ? read.shop.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase()) : read.shop || 'Onbekende winkel';
    const sumCents = read.lines.reduce((s, l) => s + l.cents, 0) + read.discounts.reduce((s, d) => s + d.cents, 0);
    const totalCents = read.totalCents > 0 ? read.totalCents : sumCents;
    return { ...read, shop, date, totalCents, sumCents, duplicate: this.#sameSpend(date, totalCents) };
  }

  /** Een aankoop op dezelfde dag met hetzelfde bedrag (bijv. een AH-bon die ook uit de app komt). */
  #sameSpend(date: string, totalCents: number) {
    const s = this.store.spends(date, date).find(x => Math.abs(x.totalCents - totalCents) <= 1);
    return s ? { id: s.id, shop: s.source === 'picnic' ? 'Picnic' : s.source === 'ah' ? 'Albert Heijn' : s.shop ?? 'Overig', date: s.date, totalCents: s.totalCents } : null;
  }

  /** De gecontroleerde bon opslaan; met pantry ook de producten bij de voorraad tellen. */
  saveReceiptPhoto(input: { shop?: unknown; date?: unknown; totalCents?: unknown; lines?: unknown; discounts?: unknown; pantry?: unknown; force?: unknown }) {
    const today = localDate(this.now());
    const date = typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : '';
    check(date && date <= today && date >= addDays(today, -5 * 366), 'Kies een datum in de afgelopen vijf jaar.');
    const totalCents = Math.round(Number(input.totalCents));
    check(Number.isFinite(totalCents) && totalCents !== 0 && Math.abs(totalCents) <= 500_000, 'Vul het totaal van de bon in.');
    const raw = Array.isArray(input.lines) ? input.lines.slice(0, 200) : [];
    const lines = raw.flatMap((l: any) => l && typeof l.name === 'string' && l.name.trim() && Number.isFinite(Number(l.cents))
      ? [{ name: l.name.trim().slice(0, 80), quantity: Number(l.quantity) > 0 ? Math.min(999, Number(l.quantity)) : 1, cents: Math.round(Number(l.cents)) }] : []);
    check(lines.length, 'Er staan geen producten op deze bon.');
    const discounts = (Array.isArray(input.discounts) ? input.discounts.slice(0, 50) : []).flatMap((d: any) => d && typeof d.name === 'string' && Number(d.cents)
      ? [{ name: d.name.trim().slice(0, 80), cents: -Math.abs(Math.round(Number(d.cents))) }] : []);
    const duplicate = this.#sameSpend(date, totalCents);
    check(!duplicate || input.force === true, `Deze bon lijkt er al te staan (${duplicate?.shop}, ${duplicate?.date}).`, 409);
    const shop = String(input.shop ?? '').trim().slice(0, 60) || 'Onbekende winkel';
    const spend: Spend = { id: 'photo:' + randomUUID().slice(0, 8), source: 'manual', date, totalCents, shop, note: 'foto van de bon', lines, ...(discounts.length ? { discounts: matchDiscounts(lines, discounts) } : {}) };
    this.store.saveSpend(spend);
    // De indeling die de AI bij het lezen gaf, bewaren (een eigen keuze gaat voor).
    this.store.update<Record<string, ProductLabel>>('productLabels', {}, saved => {
      for (const l of raw as any[]) {
        const key = labelKey(String(l?.name ?? ''));
        if (!key || saved[key]?.by === 'user' || !categoryKeys.includes(l?.category) || !kindKeys.includes(l?.kind)) continue;
        saved[key] = { category: l.category, kind: l.kind, by: 'ai' };
      }
      return saved;
    });
    let pantry: { counted: string[]; unmatched: string[] } | null = null;
    if (input.pantry === true) {
      pantry = this.#addBought(lines.filter(l => l.cents > 0).map(l => ({ name: l.name, quantity: l.quantity, amount: l.cents / 100 })));
      this.changed();
    }
    return { spend, pantry };
  }

  removeExpense(id: string) {
    const spend = this.store.spend(String(id));
    check(spend && spend.source === 'manual', 'Alleen zelf ingevoerde uitgaven kun je verwijderen; een bon kun je wel niet laten meetellen.');
    this.store.deleteSpend(spend.id);
  }

  /** Een bon niet meetellen (bijv. een cadeau of iets voor het werk), of weer wel. */
  excludeSpend(id: string, excluded: boolean) {
    const spend = this.store.spend(String(id));
    check(spend, 'Onbekende aankoop.', 404);
    const { excluded: _old, ...rest } = spend;
    this.store.saveSpend(excluded ? { ...rest, excluded: true } : rest);
  }

  budgetCsv(input: { from?: unknown; to?: unknown } = {}) {
    const today = localDate(this.now());
    const valid = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const from = valid(input.from) ? String(input.from) : addDays(today, -3 * 366);
    const to = valid(input.to) ? String(input.to) : today;
    return toCsv(this.store.spends(from, to).filter(s => !s.excluded), this.#labeler());
  }

  /** Seintje bij 80% en 100% van een zelf ingesteld maandbudget, en bij een overschreden limiet. */
  budgetAlerts() {
    const settings = this.budgetSettings();
    const limits = Object.entries(settings.limits).filter(([, v]) => v);
    if (!settings.custom && !limits.length) return;
    const range = periodRange('month', localDate(this.now()));
    const summary = summarize(this.store.spends(range.start, range.end).filter(s => !s.excluded), this.#labeler());
    if (settings.custom) {
      const share = summary.totalCents / settings.monthCents;
      if (share >= 1) this.notify({ key: `budget-${range.start}-100`, text: `Het boodschappenbudget voor ${range.label} is op: ${euro(summary.totalCents)} uitgegeven van ${euro(settings.monthCents)}.` });
      else if (share >= 0.8) this.notify({ key: `budget-${range.start}-80`, text: `${Math.round(share * 100)}% van het boodschappenbudget voor ${range.label} is uitgegeven: ${euro(summary.totalCents)} van ${euro(settings.monthCents)}, nog ${euro(settings.monthCents - summary.totalCents)} over.` });
    }
    for (const [category, limit] of limits) {
      const spent = summary.categories.find(c => c.key === category)?.cents ?? 0;
      const name = budgetCategories.find(c => c.key === category)?.label.toLowerCase() ?? category;
      if (spent > limit!) this.notify({ key: `budget-${range.start}-${category}`, text: `De limiet voor ${name} in ${range.label} is overschreden: ${euro(spent)} van ${euro(limit!)}.` });
    }
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
