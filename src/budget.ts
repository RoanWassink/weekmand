// Budget: wat er werkelijk uitgegeven is (Picnic-bezorgingen, AH-kassabonnen, losse uitgaven),
// per week, maand en jaar, per categorie en per soort (nodig, extra, geen eten).
import type { Category } from './types.ts';
import { addDays, isoWeek, weekday } from './time.ts';
import { parseUnitQuantity } from './units.ts';

export type SpendSource = 'picnic' | 'ah' | 'manual';
/**
 * Eén regel van een aankoop. `pack` is de verpakking zoals de winkel die noemt ("300 gram");
 * `productId` het AH-product van een bonregel, waarmee Weekmand de maat opzoekt.
 */
export type SpendLine = { name: string; quantity: number; cents: number; pack?: string; productId?: string };
/**
 * Eén aankoop. `lines` ontbreekt zolang de regels nog niet opgehaald zijn: het totaal telt dan
 * al wel mee, de uitsplitsing nog niet.
 */
export type Spend = {
  id: string; source: SpendSource; date: string; totalCents: number;
  lines?: SpendLine[]; savingsCents?: number; shop?: string; note?: string; category?: BudgetCategory;
  /** Niet meetellen (bijv. een cadeau of iets voor het werk). */
  excluded?: boolean;
  /** De regels hebben hun verpakking (Picnic) of AH-product-id; oudere aankopen worden rustig bijgewerkt. */
  sized?: boolean;
  /**
   * Bonusregels van een AH-bon (negatief bedrag), met de productregel waar ze bij horen (index in
   * `lines`, of null als Weekmand dat niet kon bepalen). Ontbreekt bij bonnen van vóór deze indeling.
   */
  discounts?: SpendDiscount[];
};
export type SpendDiscount = { name: string; cents: number; line: number | null };
/** Wat de AI van een foto van een kassabon las (nog niet opgeslagen). */
export type ReceiptPhoto = {
  shop: string; date: string; totalCents: number;
  lines: (SpendLine & { category?: BudgetCategory; kind?: SpendKind })[];
  discounts: { name: string; cents: number }[];
};

export type SpendKind = 'nodig' | 'extra' | 'geen-eten';
export type BudgetCategory = 'groente-fruit' | 'vlees-vis' | 'zuivel' | 'brood' | 'voorraadkast' | 'diepvries' | 'drinken' | 'alcohol' | 'snacks' | 'huishouden' | 'overig';
export type ProductLabel = { category: BudgetCategory; kind: SpendKind; by: 'regel' | 'catalogus' | 'ai' | 'user' };

export const budgetCategories: { key: BudgetCategory; label: string; kind: SpendKind }[] = [
  { key: 'groente-fruit', label: 'Groente en fruit', kind: 'nodig' },
  { key: 'vlees-vis', label: 'Vlees, vis en vega', kind: 'nodig' },
  { key: 'zuivel', label: 'Zuivel, kaas en eieren', kind: 'nodig' },
  { key: 'brood', label: 'Brood en ontbijt', kind: 'nodig' },
  { key: 'voorraadkast', label: 'Pasta, rijst en voorraadkast', kind: 'nodig' },
  { key: 'diepvries', label: 'Diepvries en kant-en-klaar', kind: 'nodig' },
  { key: 'drinken', label: 'Drinken', kind: 'nodig' },
  { key: 'alcohol', label: 'Alcohol', kind: 'extra' },
  { key: 'snacks', label: 'Snoep, koek en chips', kind: 'extra' },
  { key: 'huishouden', label: 'Huishouden en verzorging', kind: 'geen-eten' },
  { key: 'overig', label: 'Overig', kind: 'nodig' },
];
export const categoryKeys = budgetCategories.map(c => c.key);
export const kindKeys: SpendKind[] = ['nodig', 'extra', 'geen-eten'];
export const kindLabels: Record<SpendKind, string> = { nodig: 'Nodig', extra: 'Extra: snacks en traktaties', 'geen-eten': 'Geen eten' };
/** Twee rekenposten naast de categorieën. */
export const COSTS = 'kosten';
export const UNSPLIT = 'nog-niet';
const specialLabels: Record<string, string> = { [COSTS]: 'Bezorging, statiegeld en korting', [UNSPLIT]: 'Nog niet uitgesplitst' };

const fromCatalog: Record<Category, BudgetCategory> = {
  'groente-fruit': 'groente-fruit', aardappel: 'voorraadkast', vlees: 'vlees-vis', vis: 'vlees-vis', vega: 'vlees-vis',
  'zuivel-eieren': 'zuivel', kaas: 'zuivel', brood: 'brood', ontbijt: 'brood', 'pasta-rijst': 'voorraadkast', conserven: 'voorraadkast',
  'kruiden-sauzen': 'voorraadkast', 'olie-azijn': 'voorraadkast', bakken: 'voorraadkast', diepvries: 'diepvries', drinken: 'drinken',
  snacks: 'snacks', huishouden: 'huishouden',
};
export function categoryFromCatalog(category: Category): BudgetCategory { return fromCatalog[category] ?? 'overig'; }
export const kindOf = (category: BudgetCategory): SpendKind => budgetCategories.find(c => c.key === category)?.kind ?? 'nodig';

/** Overduidelijke gevallen zonder AI. Al het andere: catalogus, AI of de gebruiker. */
const rules: [RegExp, BudgetCategory][] = [
  [/\b(bier|pils|speciaalbier|wijn|prosecco|cava|champagne|whisky|wodka|vodka|rum|gin|jenever|likeur|radler|cider)\b/i, 'alcohol'],
  [/\b(chips|nacho'?s|borrelnootjes|chocolade|chocoladereep|snoep|drop|winegums?|koekjes|stroopwafels?|gevulde koek|tompoucen?|gebak|muffins?|donuts?|ijsjes|magnum|cola|fanta|sprite|energydrink|ice ?tea|frisdrank)\b/i, 'snacks'],
  [/\b(wc-?papier|toiletpapier|keukenrol|tissues|zakdoekjes|afwasmiddel|vaatwas\w*|wasmiddel|wasverzachter|allesreiniger|vuilniszak\w*|afvalzak\w*|shampoo|douchegel|handzeep|tandpasta|tandenborstel|deodorant|scheermes\w*|maandverband|tampons?|luiers|billendoekjes|batterijen|aluminiumfolie|bakpapier|vershoudfolie|diepvrieszak\w*|kattenvoer|hondenvoer|kattenbakvulling)\b/i, 'huishouden'],
];
export function ruleCategory(name: string): BudgetCategory | null {
  for (const [re, category] of rules) if (re.test(name)) return category;
  return null;
}

/** Regels op een bon die geen product zijn: statiegeld, bonus, korting, tasjes. */
export const adjustmentLine = /statiegeld|emballage|zegel|airmiles|air miles|\bbonus\b|korting|draagtas|\btas\b|toeslag|retour|bezorg/i;
export const labelKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

// ───────────── Bonusregels koppelen ─────────────

const compact = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
/** AH zet er vaak AH, ALLE of BONUS voor: "AHRUNDERGEHA", "ALLESWIRL&TO". */
const bare = (c: string) => c.replace(/^(AH|ALLE|BONUS|BBOX)(?=[A-Z]{4})/, '');
const words = (s: string) => s.toUpperCase().split(/[^A-Z0-9]+/).filter(w => w.length >= 4);
function discountScore(discount: string, product: string) {
  const d = bare(compact(discount)), p = bare(compact(product));
  if (d.length >= 4 && p.length >= 4 && (p.startsWith(d) || d.startsWith(p))) return 3; // RUNDERGEHA → RUNDERGEHAKT
  if (words(product).some(w => d.includes(bare(w))) || words(discount).some(w => p.includes(bare(w)))) return 2; // HERTOG MINIS → HERTOG IJS
  let n = 0;
  while (n < d.length && n < p.length && d[n] === p[n]) n++;
  return n >= 5 ? 1 : 0;
}

/**
 * Koppel de bonusregels onderaan een AH-bon aan de productregels, op naam. De bon zegt niet welk
 * product de korting kreeg; wat niet duidelijk is, blijft los (line: null) en telt alleen als besparing.
 */
export function matchDiscounts(lines: SpendLine[], discounts: { name: string; cents: number }[]): SpendDiscount[] {
  const out: SpendDiscount[] = discounts.map(d => ({ name: d.name, cents: d.cents, line: null }));
  const pairs = discounts.flatMap((d, di) => lines.map((l, li) => ({ di, li, score: l.cents > 0 && !adjustmentLine.test(l.name) ? discountScore(d.name, l.name) : 0 })))
    .filter(p => p.score > 0).sort((a, b) => b.score - a.score);
  const used = new Set<number>();
  for (const p of pairs) if (out[p.di].line === null && !used.has(p.li)) { out[p.di].line = p.li; used.add(p.li); }
  // Twee kortingen op één product (bonus en Bonus Box) kan, maar alleen bij een duidelijke naam.
  for (const p of pairs) if (out[p.di].line === null && p.score >= 2) out[p.di].line = p.li;
  return out;
}

/** Korting per productregel (positief), en wat los bleef. */
export function bonusPerLine(s: Spend) {
  const perLine = new Map<number, number>();
  let loose = 0;
  for (const d of s.discounts ?? []) {
    if (d.line !== null && s.lines?.[d.line]) perLine.set(d.line, (perLine.get(d.line) ?? 0) - d.cents);
    else loose -= d.cents;
  }
  return { perLine, loose };
}

// ───────────── Perioden ─────────────

export type Period = 'week' | 'month' | 'year';
const months = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const short = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1-12

/** Begin en eind (inclusief) van de week/maand/jaar rond `date`, `offset` perioden verschoven. */
export function periodRange(period: Period, date: string, offset = 0): { start: string; end: string; label: string; short: string; days: number } {
  const [y, m] = date.split('-').map(Number);
  if (period === 'week') {
    const start = addDays(date, -((weekday(date) + 6) % 7) + offset * 7);
    const end = addDays(start, 6);
    const [, sm, sd] = start.split('-').map(Number);
    const [, em, ed] = end.split('-').map(Number);
    const week = Number(isoWeek(start).split('-W')[1]);
    return { start, end, days: 7, label: `Week ${week} · ${sd}${sm === em ? '' : ' ' + short[sm - 1]}–${ed} ${short[em - 1]}`, short: `wk ${week}` };
  }
  if (period === 'month') {
    const index = y * 12 + (m - 1) + offset;
    const yy = Math.floor(index / 12), mm = index % 12 + 1;
    return { start: `${yy}-${pad(mm)}-01`, end: `${yy}-${pad(mm)}-${pad(lastDay(yy, mm))}`, days: lastDay(yy, mm), label: `${months[mm - 1]} ${yy}`, short: short[mm - 1] };
  }
  const yy = y + offset;
  const days = (Date.UTC(yy + 1, 0, 1) - Date.UTC(yy, 0, 1)) / 86_400_000;
  return { start: `${yy}-01-01`, end: `${yy}-12-31`, days, label: String(yy), short: String(yy) };
}

/** Budget voor een periode, uitgaande van een maandbudget. */
export function budgetFor(period: Period, monthCents: number) {
  return Math.round(period === 'week' ? monthCents * 12 / 52 : period === 'month' ? monthCents : monthCents * 12);
}

// ───────────── Optellen ─────────────

export type Summary = {
  totalCents: number; count: number; savingsCents: number;
  bySource: Record<SpendSource, number>;
  /** Per winkel: Picnic, Albert Heijn en de winkels van losse uitgaven en foto's. */
  shops: { name: string; cents: number }[];
  categories: { key: string; label: string; cents: number; kind?: SpendKind }[];
  kinds: { key: SpendKind; label: string; cents: number }[];
  /** Deel van het totaal waarvan de regels bekend zijn (0–1). */
  coverage: number;
  products: { key: string; name: string; cents: number; quantity: number; bonusCents: number; category: BudgetCategory; kind: SpendKind; by: ProductLabel['by'] | null }[];
};

export function summarize(spends: Spend[], label: (name: string) => ProductLabel | null): Summary {
  const bySource: Record<SpendSource, number> = { picnic: 0, ah: 0, manual: 0 };
  const cats = new Map<string, number>();
  const kinds = new Map<SpendKind, number>();
  const products = new Map<string, Summary['products'][number]>();
  const shops = new Map<string, number>();
  let total = 0, split = 0, savings = 0;
  const add = (map: Map<any, number>, key: unknown, cents: number) => map.set(key, (map.get(key) ?? 0) + cents);
  for (const s of spends) {
    total += s.totalCents;
    bySource[s.source] += s.totalCents;
    savings += s.savingsCents ?? 0;
    add(shops, shopName(s), s.totalCents);
    if (s.source === 'manual' && !s.lines) {
      const category = s.category ?? 'overig';
      add(cats, category, s.totalCents);
      add(kinds, kindOf(category), s.totalCents);
      split += s.totalCents;
      continue;
    }
    if (!s.lines) { add(cats, UNSPLIT, s.totalCents); continue; }
    // Bonuskorting gaat van het product af waar hij bij hoort; wat los blijft telt alleen als besparing.
    const bonus = bonusPerLine(s);
    savings += bonus.loose;
    let lines = 0;
    s.lines.forEach((l, i) => {
      const off = bonus.perLine.get(i) ?? 0;
      const net = l.cents - off;
      savings += off;
      lines += net;
      if (adjustmentLine.test(l.name) || l.cents < 0) {
        if (l.cents < 0 && s.source === 'ah') savings += -l.cents;
        add(cats, COSTS, net);
        return;
      }
      const found = label(l.name);
      const category = found?.category ?? 'overig';
      const kind = found?.kind ?? kindOf(category);
      add(cats, category, net);
      add(kinds, kind, net);
      const key = labelKey(l.name);
      const p = products.get(key) ?? { key, name: l.name, cents: 0, quantity: 0, bonusCents: 0, category, kind, by: found?.by ?? null };
      p.cents += net;
      p.bonusCents += off;
      p.quantity += l.quantity;
      products.set(key, p);
    });
    // Wat de regels niet verklaren: bezorgkosten, statiegeld, losse bonuskorting, afronding.
    if (s.totalCents !== lines) add(cats, COSTS, s.totalCents - lines);
    // Oudere AH-bonnen zonder bonusregels: wat de bon minder kost dan de producten samen, is bonuskorting.
    if (s.source === 'ah' && !s.discounts && s.totalCents < lines) savings += lines - s.totalCents;
    split += s.totalCents;
  }
  return {
    totalCents: total, count: spends.length, savingsCents: savings, bySource,
    shops: [...shops].map(([name, cents]) => ({ name, cents })).sort((a, b) => b.cents - a.cents),
    categories: [...cats].filter(([, c]) => c !== 0).map(([key, cents]) => ({
      key, cents, label: specialLabels[key] ?? budgetCategories.find(c => c.key === key)?.label ?? key,
      ...(categoryKeys.includes(key as BudgetCategory) ? { kind: kindOf(key as BudgetCategory) } : {}),
    })).sort((a, b) => b.cents - a.cents),
    kinds: kindKeys.map(key => ({ key, label: kindLabels[key], cents: kinds.get(key) ?? 0 })),
    coverage: total ? split / total : 1,
    products: [...products.values()].sort((a, b) => b.cents - a.cents),
  };
}

/** Verpakkingsmaat als vergelijkbare sleutel: '300 gram' → 'g300', '1 kg' → 'g1000', '6 x 33 cl' → 'ml1980'. */
export function packKey(pack?: string | null): string | null {
  if (!pack) return null;
  const m = parseUnitQuantity(pack);
  const unit = m.g !== undefined ? 'g' : m.ml !== undefined ? 'ml' : m.st !== undefined ? 'st' : null;
  return unit && m[unit]! > 0 ? unit + Math.round(m[unit]!) : null;
}

/** Zonder bekende maat: wie ineens zoveel meer of minder betaalt, kocht vrijwel zeker een andere verpakking. */
const OTHER_PACK = 1.6;

/**
 * Producten die duurder werden: de stuksprijs van de laatste aankoop tegenover de eerste in
 * de gegeven aankopen (minstens 10% en 10 cent erbij), steeds voor dezelfde verpakking. Is de
 * maat bekend, dan telt alleen dezelfde maat. Anders ziet een sprong van 60% of meer eruit als
 * een andere verpakking (300 g of 1 kg rundergehakt onder één naam) en wordt die apart gevolgd.
 */
export function priceChanges(spends: Spend[], packOf: (line: SpendLine) => string | null | undefined = l => l.pack) {
  type Track = { name: string; pack: string | null; first: { date: string; unit: number }; last: { date: string; unit: number } };
  const seen = new Map<string, Track[]>();
  for (const s of [...spends].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const l of s.lines ?? []) {
      if (l.cents <= 0 || l.quantity <= 0 || adjustmentLine.test(l.name)) continue;
      const unit = Math.round(l.cents / l.quantity);
      const pack = packOf(l) || null;
      const size = packKey(pack);
      const key = labelKey(l.name) + (size ? '|' + size : '');
      const tracks = seen.get(key) ?? [];
      seen.set(key, tracks);
      const ratio = (t: Track) => Math.max(t.last.unit / unit, unit / t.last.unit);
      const track = size ? tracks[0] : tracks.filter(t => ratio(t) < OTHER_PACK).sort((a, b) => ratio(a) - ratio(b))[0];
      if (track) { track.last = { date: s.date, unit }; track.pack = pack ?? track.pack; }
      else tracks.push({ name: l.name, pack, first: { date: s.date, unit }, last: { date: s.date, unit } });
    }
  }
  return [...seen.values()].flat()
    .filter(p => p.last.date > p.first.date && p.last.unit - p.first.unit >= 10 && p.last.unit >= p.first.unit * 1.1)
    .map(p => ({ name: p.name, pack: p.pack, from: p.first, to: p.last, percent: Math.round((p.last.unit / p.first.unit - 1) * 100) }))
    .sort((a, b) => b.percent - a.percent);
}

/** CSV voor een spreadsheet: één regel per product (of per aankoop zonder regels). */
/** Winkelnaam voor overzichten: een foto van een AH-bon telt bij Albert Heijn. */
export function shopName(s: Spend) {
  if (s.source === 'picnic') return 'Picnic';
  if (s.source === 'ah' || /^(ah|albert ?heijn)\b/i.test(s.shop ?? '')) return 'Albert Heijn';
  return s.shop?.trim() || 'Overig';
}

export function toCsv(spends: Spend[], label: (name: string) => ProductLabel | null) {
  const q = (v: string | number) => typeof v === 'number' ? (v / 100).toFixed(2).replace('.', ',') : `"${v.replace(/"/g, '""')}"`;
  const rows = [['datum', 'winkel', 'product', 'aantal', 'bedrag', 'bonus', 'categorie', 'soort'].join(';')];
  const shop = shopName;
  const catLabel = (k: string) => specialLabels[k] ?? budgetCategories.find(c => c.key === k)?.label ?? k;
  for (const s of [...spends].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!s.lines?.length) {
      const cat = s.source === 'manual' ? s.category ?? 'overig' : UNSPLIT;
      rows.push([q(s.date), q(shop(s)), q(s.note ?? (s.source === 'manual' ? 'Losse uitgave' : 'Totaal van de bon')), '1', q(s.totalCents), q(0), q(catLabel(cat)), q(s.source === 'manual' ? kindLabels[kindOf(cat as BudgetCategory)] : '')].join(';'));
      continue;
    }
    const bonus = bonusPerLine(s);
    s.lines.forEach((l, i) => {
      const found = adjustmentLine.test(l.name) || l.cents < 0 ? null : label(l.name);
      const cat = adjustmentLine.test(l.name) || l.cents < 0 ? COSTS : found?.category ?? 'overig';
      const off = bonus.perLine.get(i) ?? 0;
      rows.push([q(s.date), q(shop(s)), q(l.name), String(l.quantity), q(l.cents - off), q(off), q(catLabel(cat)), q(cat === COSTS ? '' : kindLabels[found?.kind ?? kindOf(cat as BudgetCategory)])].join(';'));
    });
    for (const d of (s.discounts ?? []).filter(d => d.line === null || !s.lines![d.line])) {
      rows.push([q(s.date), q(shop(s)), q('Bonus ' + d.name), '1', q(d.cents), q(-d.cents), q(catLabel(COSTS)), q('')].join(';'));
    }
  }
  return '﻿' + rows.join('\r\n') + '\r\n';
}
