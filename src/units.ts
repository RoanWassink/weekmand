import type { BaseUnit, IngredientDef } from './types.ts';

export type Measures = Partial<Record<BaseUnit, number>>;

const factors: Record<string, [BaseUnit, number]> = {
  g: ['g', 1], gr: ['g', 1], gram: ['g', 1], grams: ['g', 1], kg: ['g', 1000], kilo: ['g', 1000], kilogram: ['g', 1000],
  ml: ['ml', 1], cl: ['ml', 10], dl: ['ml', 100], l: ['ml', 1000], liter: ['ml', 1000], lt: ['ml', 1000],
  el: ['ml', 15], eetlepel: ['ml', 15], eetlepels: ['ml', 15], tl: ['ml', 5], theelepel: ['ml', 5], theelepels: ['ml', 5],
  st: ['st', 1], stuk: ['st', 1], stuks: ['st', 1], x: ['st', 1], plakjes: ['st', 1], plakken: ['st', 1],
  rollen: ['st', 1], rol: ['st', 1], eieren: ['st', 1], tabletten: ['st', 1], zakjes: ['st', 1], blikjes: ['st', 1],
  flessen: ['st', 1], fles: ['st', 1], teentjes: ['st', 1], teen: ['st', 1], bossen: ['st', 1], bos: ['st', 1],
  krop: ['st', 1], kroppen: ['st', 1], pakken: ['st', 1], pak: ['st', 1],
};
const unitWords = Object.keys(factors).sort((a, b) => b.length - a.length).join('|');
const number = String.raw`(\d+(?:[.,]\d+)?)`;
const multi = new RegExp(String.raw`${number}\s*[x×]\s*${number}\s*(${unitWords})\b`, 'g');
const single = new RegExp(String.raw`${number}\s*(${unitWords})\b`, 'g');

const num = (text: string) => Number(text.replace(',', '.'));

/** Converteer een hoeveelheid met eenheid (kg, l, el, …) naar een basiseenheid. */
export function toBase(amount: number, unit: string): { amount: number; unit: BaseUnit } | null {
  const factor = factors[unit.toLowerCase().replace(/\.$/, '')];
  return factor ? { amount: amount * factor[1], unit: factor[0] } : null;
}

/**
 * Lees een verpakkingsomschrijving zoals Picnic die toont: '500 gram', '6 x 33 cl',
 * '3 stuks (ca. 450 gram)', 'ca. 1 kilo', '1,5 liter'. Geeft alle gevonden maten terug.
 */
export function parseUnitQuantity(text: string): Measures {
  const lower = ` ${text.toLowerCase().replace(/ /g, ' ')} `;
  const result: Measures = {};
  const used: [number, number][] = [];
  for (const match of lower.matchAll(multi)) {
    const base = toBase(num(match[1]) * num(match[2]), match[3]);
    if (base && result[base.unit] === undefined) result[base.unit] = base.amount;
    if (base && base.unit !== 'st' && result.st === undefined) result.st = num(match[1]);
    used.push([match.index, match.index + match[0].length]);
  }
  for (const match of lower.matchAll(single)) {
    if (used.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const base = toBase(num(match[1]), match[2]);
    if (base && result[base.unit] === undefined) result[base.unit] = base.amount;
  }
  if (!Object.keys(result).length && /\b(per stuk|stuk)\b/.test(lower)) result.st = 1;
  return result;
}

/** Zet een hoeveelheid om naar de eenheid van een ingrediënt, via het stukgewicht waar nodig. */
export function convert(amount: number, from: BaseUnit, ingredient: Pick<IngredientDef, 'unit' | 'pieceGrams'>): number | null {
  const to = ingredient.unit;
  if (from === to) return amount;
  const piece = ingredient.pieceGrams;
  const mass = (unit: BaseUnit) => unit === 'g' || unit === 'ml';
  if (mass(from) && mass(to)) return amount; // 1 ml ≈ 1 g
  if (from === 'st' && mass(to) && piece) return amount * piece;
  if (mass(from) && to === 'st' && piece) return amount / piece;
  return null;
}

/** Inhoud van één verpakking in de eenheid van het ingrediënt, of null als dat niet te bepalen is. */
export function packAmount(unitQuantity: string, ingredient: Pick<IngredientDef, 'unit' | 'pieceGrams'>): number | null {
  const measures = parseUnitQuantity(unitQuantity);
  if (measures[ingredient.unit] !== undefined) return measures[ingredient.unit]!;
  for (const unit of ['g', 'ml', 'st'] as BaseUnit[]) {
    if (measures[unit] === undefined) continue;
    const value = convert(measures[unit]!, unit, ingredient);
    if (value) return value;
  }
  return null;
}

const nl = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1 });
/** Leesbare hoeveelheid: 1500 g → '1,5 kg', 6 st → '6 stuks'. */
export function formatAmount(amount: number, unit: BaseUnit): string {
  if (unit === 'g' && amount >= 1000) return nl.format(amount / 1000) + ' kg';
  if (unit === 'ml' && amount >= 1000) return nl.format(amount / 1000) + ' l';
  if (unit === 'st') return nl.format(amount) + (amount === 1 ? ' stuk' : ' stuks');
  return nl.format(Math.round(amount)) + ' ' + unit;
}

export const euro = (cents: number) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(cents / 100);
