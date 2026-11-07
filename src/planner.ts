import { createHash } from 'node:crypto';
import { normalize } from './catalog.ts';
import { weekday } from './time.ts';
import type { AvoidRule, BaseUnit, Household, IngredientDef, PantryItem, Recipe, ShopCart } from './types.ts';
import { formatAmount, packAmount } from './units.ts';

const day = 86_400_000;

export function portions(h: Pick<Household, 'adults' | 'children' | 'toddlers'>) {
  return Math.round((h.adults + h.children * 0.65 + h.toddlers * 0.35) * 100) / 100;
}

// ───────────────────────────── Weekwens lezen ─────────────────────────────

export type Wish = { include: string[]; exclude: string[]; excludeKeys: string[] };

const tagWords: Record<string, string[]> = {
  vegetarisch: ['vegetarisch', 'vega', 'veggie', 'vleesloos', 'zonder vlees'],
  vegan: ['vegan', 'veganistisch', 'plantaardig'],
  vis: ['vis', 'visgerecht', 'zalm'], kip: ['kip'], rund: ['rund', 'rundvlees', 'biefstuk'], varken: ['varken', 'varkensvlees'],
  gehakt: ['gehakt'], hollands: ['hollands', 'oudhollands', 'stamppot'], italiaans: ['italiaans', 'pasta', 'pizza'],
  mexicaans: ['mexicaans', 'taco', 'tacos', 'burrito'], aziatisch: ['aziatisch', 'oosters', 'wok', 'chinees', 'thais'],
  indiaas: ['indiaas', 'curry'], mediterraan: ['mediterraan', 'grieks'], 'midden-oosten': ['midden oosten', 'turks', 'libanees'],
  snel: ['snel', 'snelle', 'makkelijk', 'weinig tijd'], kindvriendelijk: ['kindvriendelijk', 'kinderen', 'kids'],
  favoriet: ['favoriet', 'favorieten', 'lievelingseten', 'lievelings', 'bekend', 'vertrouwd'],
  soep: ['soep'], salade: ['salade'], oven: ['oven', 'ovenschotel'], budget: ['goedkoop', 'budget', 'zuinig'], feest: ['feest', 'gasten', 'visite'],
};
const meatTags = ['kip', 'rund', 'varken', 'gehakt'];

/**
 * Haal tags uit een vrije weekwens: 'graag iets mexicaans, geen vis en geen champignons'.
 * Een ontkenning (geen, zonder, niet) geldt voor de woorden erna, tot 'maar', 'wel', 'graag'
 * of een leesteken.
 */
export function parseWish(text: string, resolveKey?: (word: string) => string | undefined): Wish {
  const wish: Wish = { include: [], exclude: [], excludeKeys: [] };
  const phrases = Object.entries(tagWords).flatMap(([tag, words]) => words.map(w => ({ tag, words: w.split(' ') })))
    .sort((a, b) => b.words.length - a.words.length);
  for (const clause of text.split(/[,.;!?\n]|\bmaar\b/i)) {
    const tokens = normalize(clause).split(' ').filter(Boolean);
    let negative = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (['geen', 'zonder', 'niet', 'minder', 'nooit'].includes(t)) { negative = true; continue; }
      if (['wel', 'graag', 'liever', 'iets', 'meer'].includes(t)) { negative = false; continue; }
      const phrase = phrases.find(p => p.words.every((w, j) => tokens[i + j] === w));
      if (phrase) {
        (negative ? wish.exclude : wish.include).push(phrase.tag);
        i += phrase.words.length - 1;
        continue;
      }
      if (negative && t === 'vlees') { wish.exclude.push(...meatTags); continue; }
      if (negative && resolveKey && t.length > 2 && !['en', 'of', 'ook', 'een', 'deze', 'week', 'keer', 'dagen'].includes(t)) {
        const key = resolveKey(t);
        if (key) wish.excludeKeys.push(key);
      }
    }
  }
  wish.exclude = [...new Set(wish.exclude)];
  wish.include = [...new Set(wish.include.filter(t => !wish.exclude.includes(t)))];
  wish.excludeKeys = [...new Set(wish.excludeKeys)];
  return wish;
}

// ───────────────────────────── Menu voorstellen ─────────────────────────────

export type MenuInput = {
  recipes: Recipe[];
  dates: string[];
  /** Maaltijden die blijven staan (handmatig gekozen of goedgekeurd). */
  fixed: Record<string, string>;
  household: Household;
  avoid: AvoidRule[];
  /** Recepten van de afgelopen twee weken. */
  recent: string[];
  wish: Wish;
  costPerPortion: (recipe: Recipe) => number;
  ingredient: (key: string) => IngredientDef | undefined;
  seed: string;
  /** Extra punten per recept, bijv. voor favorieten of afgekeurde gerechten. */
  bonus?: (recipe: Recipe) => number;
};

function jitter(seed: string, value: string) {
  return createHash('sha256').update(seed + '|' + value).digest().readUInt32BE(0) / 2 ** 32;
}
const proteinOf = (r: Recipe) => ['vis', 'kip', 'rund', 'varken', 'gehakt', 'vegetarisch'].find(t => r.tags.includes(t)) ?? 'overig';
const cuisines = ['hollands', 'italiaans', 'mexicaans', 'aziatisch', 'indiaas', 'mediterraan', 'midden-oosten', 'amerikaans'];
const cuisineOf = (r: Recipe) => cuisines.find(t => r.tags.includes(t)) ?? 'overig';

/** Recepten die mogen volgens dieet, uitsluitingen en geleerde regels. */
export function allowedRecipes(recipes: Recipe[], household: Household, avoid: AvoidRule[], wish?: Wish) {
  // Een dieet in de weekwens ('deze week vegetarisch') geldt voor alle dagen; een keuken is een voorkeur.
  const diet = (wish?.include ?? []).filter(t => t === 'vegetarisch' || t === 'vegan');
  return recipes.filter(r =>
    (!household.vegetarian || r.tags.includes('vegetarisch')) &&
    diet.every(t => r.tags.includes(t)) &&
    !r.ingredients.some(i => household.exclude.includes(i.key) || wish?.excludeKeys.includes(i.key)) &&
    !avoid.some(a => a.kind === 'recipe' && a.recipeId === r.id) &&
    !(wish?.exclude ?? []).some(t => r.tags.includes(t)));
}

export function allowedOn(recipe: Recipe, date: string, avoid: AvoidRule[]) {
  const wd = weekday(date);
  return !avoid.some(a => a.kind === 'tag-weekday' && a.weekday === wd && recipe.tags.includes(a.tag));
}

/**
 * Kies per vrije datum een recept. Hebberig maar met afwisseling: geen herhaling binnen de week,
 * straf voor recente gerechten en voor twee keer achter elkaar hetzelfde eiwit, bonus voor de
 * weekwens en voor ingrediënten die al gekocht worden (minder verspilling). Daarna wordt het
 * duurste gerecht vervangen zolang het menu boven budget zit.
 */
export function proposeMenu(input: MenuInput): Record<string, string> {
  const { household, avoid, wish } = input;
  const pool = allowedRecipes(input.recipes, household, avoid, wish);
  const result: Record<string, string> = { ...input.fixed };
  const used = () => new Set(Object.values(result));
  const servings = portions(household);
  const keysOf = (r: Recipe) => new Set(r.ingredients.filter(i => !input.ingredient(i.key)?.staple).map(i => i.key));

  const score = (r: Recipe, date: string) => {
    let s = 0;
    // Een wens weegt zwaar voor het eerste gerecht en steeds minder daarna: 'iets mexicaans' is niet elke dag.
    for (const tag of wish.include) if (r.tags.includes(tag)) {
      const already = [...used()].filter(id => input.recipes.find(x => x.id === id)?.tags.includes(tag)).length;
      s += 3.5 * 0.25 ** already;
    }
    if (input.recent.includes(r.id)) s -= 4;
    const neighbours = [-1, 1].map(o => result[new Date(Date.parse(date) + o * day).toISOString().slice(0, 10)]).filter(Boolean);
    for (const id of neighbours) {
      const other = input.recipes.find(x => x.id === id);
      if (other && proteinOf(other) === proteinOf(r)) s -= 1.5;
    }
    const chosen = [...used()].map(id => input.recipes.find(x => x.id === id)).filter(Boolean) as Recipe[];
    // Afwisseling over de hele week: niet twee keer dezelfde keuken of hetzelfde vlees.
    const sameCuisine = chosen.filter(c => cuisineOf(c) === cuisineOf(r) && cuisineOf(r) !== 'overig').length;
    s -= sameCuisine * 2;
    const sameProtein = chosen.filter(c => proteinOf(c) === proteinOf(r) && !['vegetarisch', 'overig'].includes(proteinOf(r))).length;
    s -= sameProtein * 1;
    const shared = new Set(chosen.flatMap(c => [...keysOf(c)]));
    // Kleine bonus voor gedeelde ingrediënten (minder restjes), niet zo groot dat gelijksoortige gerechten winnen.
    s += Math.min(0.6, [...keysOf(r)].filter(k => shared.has(k)).length * 0.15);
    s -= input.costPerPortion(r) / 100 * 0.35;
    const wd = weekday(date);
    if (wd >= 1 && wd <= 4 && r.tags.includes('snel')) s += 0.4;
    if (household.children + household.toddlers > 0 && r.tags.includes('kindvriendelijk')) s += 0.6;
    s += input.bonus?.(r) ?? 0;
    s += jitter(input.seed, date + r.id) * 0.9;
    return s;
  };

  for (const date of input.dates) {
    if (result[date]) continue;
    let options = pool.filter(r => !used().has(r.id) && allowedOn(r, date, avoid));
    if (!options.length) options = pool.filter(r => allowedOn(r, date, avoid));
    if (!options.length) continue;
    options.sort((a, b) => score(b, date) - score(a, date));
    result[date] = options[0].id;
  }

  // Budget: vervang het duurste vrije gerecht door een goedkoper alternatief.
  const budget = household.budget * 100;
  const total = () => Object.values(result).reduce((sum, id) => sum + input.costPerPortion(input.recipes.find(r => r.id === id)!) * servings, 0);
  for (let round = 0; round < input.dates.length && total() > budget * 0.8; round++) {
    const free = input.dates.filter(d => result[d] && !input.fixed[d]);
    const priciest = free.sort((a, b) => input.costPerPortion(input.recipes.find(r => r.id === result[b])!) - input.costPerPortion(input.recipes.find(r => r.id === result[a])!))[0];
    if (!priciest) break;
    const current = input.recipes.find(r => r.id === result[priciest])!;
    const cheaper = pool.filter(r => !used().has(r.id) && allowedOn(r, priciest, avoid) && input.costPerPortion(r) < input.costPerPortion(current) * 0.85)
      .sort((a, b) => score(b, priciest) - score(a, priciest))[0];
    if (!cheaper) break;
    result[priciest] = cheaper.id;
  }
  return result;
}

// ───────────────────────────── Behoefte en mandverschil ─────────────────────────────

export type PriceTier = { from: number; cents: number };
export type ProductOption = {
  id: string; name: string; unitQuantity: string;
  /** Actuele prijs per verpakking (met aanbieding). */
  cents: number; packAmount: number;
  /** Staffelprijzen per stuk vanaf een aantal, bijv. "2 voor €7". */
  tiers?: PriceTier[];
};

/** Prijs van n verpakkingen, met staffelkorting als die er is. */
export function packCost(o: ProductOption, n: number) {
  if (n <= 0) return 0;
  const tier = (o.tiers ?? []).filter(t => t.from <= n).sort((a, b) => b.from - a.from)[0];
  return n * Math.min(o.cents, tier?.cents ?? o.cents);
}
export type Extra =
  | { id: string; kind: 'ingredient'; key: string; amount: number; label: string }
  | { id: string; kind: 'product'; productId: string; name: string; unitQuantity: string; cents: number; quantity: number; key?: string };
export type Regular = { productId: string; name: string; unitQuantity: string; cents: number; quantity: number; enabled: boolean; weeks?: number; key?: string };
/** declined: producten die de gebruiker voor deze bestelling heeft weggeveegd (niets bij, niets af). */
export type OrderOptions = { extras: Extra[]; skip: string[]; declined?: string[] };

export type PlanMeal = { date: string; recipe: Recipe; servings: number };

export type PlanLine = {
  productId: string; product: string; unitQuantity: string; cents: number;
  key?: string; name: string; unit?: BaseUnit; need?: number; stock?: number | null;
  /** Hoeveel van het ingrediënt al in de mand zit (alle passende producten), in de eenheid van het ingrediënt. */
  inCartAmount?: number;
  inCart: number; add: number; remove: number; reason: string; declined?: boolean;
};
export type Question = { key: string; name: string; amount: number; unit: BaseUnit; text: string };
export type Plan = {
  cartId: string;
  before: Record<string, number>;
  target: Record<string, number>;
  lines: PlanLine[];
  questions: Question[];
  missing: { key: string; name: string; reason: string }[];
  addCents: number; removeCents: number; totalCents: number; budgetCents: number;
};

export type PlanInput = {
  meals: PlanMeal[];
  household: Household;
  pantry: PantryItem[];
  order: OrderOptions;
  regulars: Regular[];
  avoid: AvoidRule[];
  cart: ShopCart;
  /** Wat Weekmand zelf al in deze mand heeft gezet (productId → verpakkingen). */
  ledger: Record<string, number>;
  ingredient: (key: string) => IngredientDef | undefined;
  /** Productopties per ingrediënt; leeg als er geen passend product is. */
  options: (key: string) => ProductOption[];
  /** Ingrediënt waar een product in de mand bij hoort (voor dekking door bestaande regels). */
  productKey: (productId: string, cartName?: string) => string | undefined;
  now?: number;
};

/** Voorraad die als bekend geldt: bevestigd of geschat. Ouder dan drie dagen → vragen. */
export function stockState(item: PantryItem | undefined, now = Date.now()) {
  if (!item || item.amount === null) return { amount: 0, known: false, fresh: false };
  const age = item.checkedAt ? now - Date.parse(item.checkedAt) : Infinity;
  return { amount: item.amount, known: true, fresh: age >= 0 && age <= 3 * day };
}

/** Optellen wat de geplande maaltijden nodig hebben, per ingrediënt in de basiseenheid. */
export function mealNeeds(meals: PlanMeal[]) {
  const needs = new Map<string, { amount: number; meals: string[] }>();
  for (const meal of meals) for (const i of meal.recipe.ingredients) {
    const entry = needs.get(i.key) ?? { amount: 0, meals: [] };
    entry.amount += i.amount * meal.servings;
    if (!entry.meals.includes(meal.recipe.name)) entry.meals.push(meal.recipe.name);
    needs.set(i.key, entry);
  }
  return needs;
}

/**
 * Goedkoopste manier om `need` te dekken: één maat, of een mix van twee maten (bijv. 800 g + 400 g).
 * Bij gelijke prijs wint de combinatie met de minste rest en daarna de minste verpakkingen.
 */
export function choose(options: ProductOption[], need: number): { o: ProductOption; packs: number }[] {
  type Pick = { parts: { o: ProductOption; packs: number }[]; cost: number; amount: number; packs: number };
  const candidates: Pick[] = [];
  const add = (parts: { o: ProductOption; packs: number }[]) => {
    const used = parts.filter(p => p.packs > 0);
    candidates.push({ parts: used, cost: used.reduce((s, p) => s + packCost(p.o, p.packs), 0), amount: used.reduce((s, p) => s + p.packs * p.o.packAmount, 0), packs: used.reduce((s, p) => s + p.packs, 0) });
  };
  for (const o of options) add([{ o, packs: Math.ceil(need / o.packAmount - 1e-9) }]);
  for (const a of options) for (const b of options) {
    if (a === b || a.packAmount <= b.packAmount) continue;
    const max = Math.ceil(need / a.packAmount - 1e-9);
    for (let n = 1; n < max; n++) add([{ o: a, packs: n }, { o: b, packs: Math.ceil((need - n * a.packAmount) / b.packAmount - 1e-9) }]);
  }
  candidates.sort((x, y) => x.cost - y.cost || (x.amount - need) - (y.amount - need) || x.packs - y.packs);
  return candidates[0]?.parts ?? [];
}

/**
 * Bereken de gewenste mand. Idempotent: wat de gebruiker zelf in de mand legde blijft staan en
 * telt als dekking; Weekmand beheert alleen haar eigen toevoegingen (het grootboek). Opnieuw
 * rekenen na het toepassen geeft daardoor geen nieuwe wijzigingen.
 */
export function buildPlan(input: PlanInput): Plan {
  const now = input.now ?? Date.now();
  const cartQty = new Map<string, number>();
  const cartInfo = new Map(input.cart.lines.map(l => [l.id, l]));
  for (const l of input.cart.lines) cartQty.set(l.id, (cartQty.get(l.id) ?? 0) + l.quantity);
  const ledger = (id: string) => Math.min(input.ledger[id] ?? 0, cartQty.get(id) ?? 0);
  const manual = (id: string) => (cartQty.get(id) ?? 0) - ledger(id);
  const managed = new Map<string, number>();
  const zeroed = new Set<string>();
  const info = new Map<string, Omit<ProductOption, 'packAmount'>>();
  const reasons = new Map<string, Partial<PlanLine>>();
  const questions: Question[] = [];
  const missing: Plan['missing'] = [];
  const skip = new Set(input.order.skip);
  const autoBlocked = new Set(input.avoid.flatMap(a => a.kind === 'ingredient-auto' ? [a.key] : []));
  const pantry = new Map(input.pantry.map(p => [p.key, p]));

  // Behoefte per ingrediënt
  const needs = new Map<string, { amount: number; reason: string[] }>();
  const addNeed = (key: string, amount: number, reason: string) => {
    const entry = needs.get(key) ?? { amount: 0, reason: [] };
    entry.amount += amount;
    if (!entry.reason.includes(reason)) entry.reason.push(reason);
    needs.set(key, entry);
  };
  for (const [key, need] of mealNeeds(input.meals)) {
    const def = input.ingredient(key);
    if (!def) continue;
    if (def.staple) {
      // Basisvoorraad alleen kopen als die op is of bijna op.
      const s = stockState(pantry.get(key), now);
      if (s.known && s.amount <= Math.max(need.amount, pantry.get(key)!.minimum)) addNeed(key, Math.max(need.amount, 1), 'Basisvoorraad bijna op');
      continue;
    }
    addNeed(key, need.amount, need.meals.join(', '));
  }
  for (const item of input.pantry) {
    if (item.minimum > 0 && !autoBlocked.has(item.key)) {
      const s = stockState(item, now);
      if (!s.known || s.amount < item.minimum) addNeed(item.key, item.minimum, 'Vaste voorraad');
    }
  }
  for (const extra of input.order.extras) if (extra.kind === 'ingredient') addNeed(extra.key, extra.amount, 'Extra: ' + extra.label);

  for (const [key, need] of needs) {
    const def = input.ingredient(key);
    if (!def) continue;
    const options = input.options(key);
    const s = stockState(pantry.get(key), now);
    if (skip.has(key)) {
      for (const o of options) zeroed.add(o.id);
      for (const l of input.cart.lines) if (input.productKey(l.id, l.name) === key) zeroed.add(l.id);
      continue;
    }
    if (s.known && !s.fresh && s.amount > 0 && need.reason.some(r => !r.startsWith('Extra'))) {
      questions.push({ key, name: def.name, amount: s.amount, unit: def.unit, text: `Heb je nog ${formatAmount(s.amount, def.unit)} ${def.name.toLowerCase()}?` });
    }
    const shortfall = Math.max(0, need.amount - s.amount);
    // Dekking door wat de gebruiker zelf al in de mand heeft gelegd.
    const related = new Set([...options.map(o => o.id), ...input.cart.lines.filter(l => input.productKey(l.id, l.name) === key).map(l => l.id)]);
    let covered = 0;
    let inCartAmount = 0;
    for (const id of related) {
      const line = cartInfo.get(id);
      const amount = options.find(o => o.id === id)?.packAmount ?? (line ? packAmount(line.unitQuantity, def) : null);
      if (amount) { covered += manual(id) * amount; inCartAmount += (cartQty.get(id) ?? 0) * amount; }
    }
    const line: Partial<PlanLine> = { key, name: def.name, unit: def.unit, need: need.amount, stock: s.known ? s.amount : null, inCartAmount, reason: need.reason.join(' · ') };
    if (!options.length) {
      if (shortfall - covered > 1e-9) missing.push({ key, name: def.name, reason: 'Geen passend product gevonden; koppel er een in Instellingen → Producten.' });
      continue;
    }
    const rest = Math.max(0, shortfall - covered);
    if (rest <= 1e-9) {
      // Al gedekt; eerdere toevoegingen van Weekmand mogen weg.
      for (const id of related) if (ledger(id) > 0) { info.set(id, cartOrOption(id)); reasons.set(id, line); managed.set(id, managed.get(id) ?? 0); }
      continue;
    }
    const picks = choose(options, rest);
    for (const { o, packs } of picks) {
      managed.set(o.id, (managed.get(o.id) ?? 0) + packs);
      info.set(o.id, o);
      reasons.set(o.id, line);
    }
    // Eerdere toevoegingen van Weekmand in een andere maat gaan eruit (bijv. 2× 400 g → 1× 800 g).
    for (const id of related) if (!picks.some(p => p.o.id === id) && ledger(id) > 0 && !managed.has(id)) { managed.set(id, 0); info.set(id, cartOrOption(id)); reasons.set(id, line); }
  }

  function cartOrOption(id: string) {
    const c = cartInfo.get(id);
    return c ? { id, name: c.name, unitQuantity: c.unitQuantity, cents: c.cents } : { id, name: id, unitQuantity: '', cents: 0 };
  }

  // Vaste producten en losse productregels (bijv. een krat pils).
  const productLines = [
    ...input.regulars.filter(r => r.enabled && !skip.has(r.productId) && !(r.key && (skip.has(r.key) || autoBlocked.has(r.key))))
      .map(r => ({ id: r.productId, name: r.name, unitQuantity: r.unitQuantity, cents: r.cents, quantity: r.quantity, reason: 'Vaste boodschap', topUp: true })),
    ...input.order.extras.flatMap(e => e.kind === 'product' ? [{ id: e.productId, name: e.name, unitQuantity: e.unitQuantity, cents: e.cents, quantity: e.quantity, reason: 'Extra', topUp: false }] : []),
  ];
  for (const p of productLines) {
    if (zeroed.has(p.id)) continue;
    // Een vaste boodschap vult aan tot het gewone aantal; een extra komt er bovenop.
    const extra = p.topUp ? Math.max(0, p.quantity - manual(p.id) - (managed.get(p.id) ?? 0)) : p.quantity;
    managed.set(p.id, (managed.get(p.id) ?? 0) + extra);
    info.set(p.id, { id: p.id, name: p.name, unitQuantity: p.unitQuantity, cents: p.cents });
    if (!reasons.has(p.id)) reasons.set(p.id, { name: p.name, reason: p.reason });
  }

  // Eerdere toevoegingen die nergens meer voor nodig zijn, gaan eruit.
  for (const [id] of cartQty) if (ledger(id) > 0 && !managed.has(id) && !zeroed.has(id)) {
    managed.set(id, 0);
    info.set(id, cartOrOption(id));
    reasons.set(id, { name: cartOrOption(id).name, reason: 'Niet meer nodig' });
  }

  const before: Record<string, number> = {};
  const target: Record<string, number> = {};
  const lines: PlanLine[] = [];
  const ids = new Set([...managed.keys(), ...zeroed]);
  const declined = new Set(input.order.declined ?? []);
  for (const id of ids) {
    const current = cartQty.get(id) ?? 0;
    // Weggeveegd door de gebruiker: dit product blijft zoals het in de mand staat.
    const want = declined.has(id) ? current : zeroed.has(id) ? 0 : manual(id) + (managed.get(id) ?? 0);
    before[id] = current;
    target[id] = want;
    const p = info.get(id) ?? cartOrOption(id);
    const r = reasons.get(id) ?? { name: p.name, reason: zeroed.has(id) ? 'Overgeslagen' : '' };
    lines.push({
      productId: id, product: p.name, unitQuantity: p.unitQuantity, name: r.name ?? p.name,
      // Stuksprijs bij dit aantal (staffelkorting meegerekend).
      cents: want > 0 && (p as ProductOption).tiers?.length ? Math.round(packCost(p as ProductOption, want) / want) : p.cents,
      ...(r.key ? { key: r.key, unit: r.unit, need: r.need, stock: r.stock, inCartAmount: r.inCartAmount } : {}),
      inCart: current, add: Math.max(0, want - current), remove: Math.max(0, current - want),
      reason: zeroed.has(id) ? 'Overgeslagen deze week' : r.reason ?? '', ...(declined.has(id) ? { declined: true } : {}),
    });
  }
  lines.sort((a, b) => (b.add - a.add) || a.name.localeCompare(b.name, 'nl'));
  const addCents = lines.reduce((s, l) => s + l.add * l.cents, 0); // prijs per stuk; staffelkorting zit in l.cents
  const removeCents = lines.reduce((s, l) => s + l.remove * l.cents, 0);
  return {
    cartId: input.cart.id, before, target, lines, questions: questions.slice(0, 6), missing,
    addCents, removeCents, totalCents: input.cart.totalCents + addCents - removeCents, budgetCents: Math.round(input.household.budget * 100),
  };
}

/** Wat een recept per portie ongeveer kost, op basis van de goedkoopste verpakking per eenheid. */
export function recipeCost(recipe: Recipe, options: (key: string) => ProductOption[], ingredient: (key: string) => IngredientDef | undefined) {
  let cents = 0;
  for (const i of recipe.ingredients) {
    if (ingredient(i.key)?.staple) continue;
    const best = options(i.key).map(o => o.cents / o.packAmount).sort((a, b) => a - b)[0];
    cents += (best ?? 0.5) * i.amount;
  }
  return Math.round(cents);
}
