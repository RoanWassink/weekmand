import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { Catalog } from './catalog.ts';
import { check, Problem } from './errors.ts';
import type { BaseUnit } from './types.ts';
import { convert, toBase } from './units.ts';

/**
 * Recepten importeren van een webpagina. Bijna alle receptsites zetten het recept als
 * schema.org/Recipe (JSON-LD) in de pagina; dat lezen we, zonder de pagina zelf te "scrapen".
 */

// ───────────── Veilig ophalen ─────────────

/** Adressen die een link nooit mag bereiken: de router mag niet het eigen thuisnetwerk afspeuren. */
const blocked = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4]] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) blocked.addSubnet(net, prefix, 'ipv6');

function isBlocked(address: string, family: number) {
  // IPv4 in IPv6-notatie (::ffff:192.168.1.1) als IPv4 controleren.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

async function assertPublic(url: URL) {
  check(url.protocol === 'https:' || url.protocol === 'http:', 'Gebruik een link die met http:// of https:// begint.');
  check(!url.username && !url.password, 'Gebruik een gewone link zonder inloggegevens.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  check(addresses.length, 'Deze website is niet te vinden.');
  for (const a of addresses) {
    check(!isBlocked(a.address, a.family), 'Links naar adressen in het eigen netwerk zijn niet toegestaan.');
  }
}

/** Haal een pagina op: alleen publieke adressen, maximaal 3 doorverwijzingen, 3 MB en 12 seconden. */
export async function fetchPage(link: string, fetcher: typeof fetch = fetch): Promise<{ html: string; url: string }> {
  let url: URL;
  try { url = new URL(link.trim()); } catch { throw new Problem(400, 'Dit is geen geldige link.'); }
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url);
    let response: Response;
    try {
      response = await fetcher(url, {
        redirect: 'manual', signal: AbortSignal.timeout(12_000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Weekmand/2.0; recept-import)', Accept: 'text/html,application/xhtml+xml' },
      });
    } catch (error) {
      throw new Problem(502, (error as Error).name === 'TimeoutError' ? 'De website reageerde niet op tijd.' : 'De website is niet bereikbaar.');
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = new URL(response.headers.get('location')!, url);
      continue;
    }
    check(response.ok, `De website gaf een fout (${response.status}).`, 502);
    check(/html|xml/i.test(response.headers.get('content-type') ?? 'text/html'), 'Deze link is geen webpagina.');
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 3_000_000) { await reader.cancel(); throw new Problem(413, 'Deze pagina is te groot.'); }
      chunks.push(value);
    }
    return { html: new TextDecoder().decode(Buffer.concat(chunks)), url: url.href };
  }
  throw new Problem(502, 'Te veel doorverwijzingen.');
}

// ───────────── Recept uit de pagina lezen ─────────────

export type WebRecipe = { name: string; servings: number | null; minutes: number | null; ingredients: string[]; steps: string[]; tags: string[]; url: string };

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', frac12: '½', frac14: '¼', frac34: '¾', deg: '°', eacute: 'é', euml: 'ë', iuml: 'ï', ouml: 'ö', egrave: 'è', ccedil: 'ç' };
export function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => code[0] === '#'
      ? String.fromCodePoint(parseInt(code.slice(code[1].toLowerCase() === 'x' ? 2 : 1), code[1].toLowerCase() === 'x' ? 16 : 10))
      : entities[code.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
}

/** 'PT1H30M' → 90 minuten. */
export function isoMinutes(value: unknown): number | null {
  const m = /^P(?:T)?(?:(\d+)H)?(?:(\d+)M)?/i.exec(String(value ?? '').replace(/^P\d+DT?/i, 'PT'));
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

function findRecipe(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) { const found = findRecipe(item); if (found) return found; }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  const type = obj['@type'];
  if ((Array.isArray(type) ? type : [type]).some(t => typeof t === 'string' && /recipe$/i.test(t))) return obj;
  return findRecipe(obj['@graph']) ?? findRecipe(obj.mainEntity) ?? null;
}

function steps(value: unknown): string[] {
  if (typeof value === 'string') return cleanText(value).split(/(?<=\.)\s+(?=[A-Z])/).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (typeof item === 'string') return [cleanText(item)];
    const obj = item as Record<string, unknown>;
    if (Array.isArray(obj?.itemListElement)) return steps(obj.itemListElement);
    return [cleanText(obj?.text ?? obj?.name)];
  }).filter(Boolean);
}

/** Lees het schema.org-recept uit de HTML, of null als de pagina er geen heeft. */
export function extractRecipe(html: string, url: string): WebRecipe | null {
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try { data = JSON.parse(match[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim()); } catch { continue; }
    const recipe = findRecipe(data);
    if (!recipe) continue;
    const ingredients = ((recipe.recipeIngredient ?? recipe.ingredients) as unknown[] | undefined ?? []).map(cleanText).filter(Boolean);
    if (!ingredients.length) continue;
    const yieldValue = Array.isArray(recipe.recipeYield) ? recipe.recipeYield.find(y => /\d/.test(String(y))) : recipe.recipeYield;
    const servings = Number(/(\d+)/.exec(String(yieldValue ?? ''))?.[1]) || null;
    const keywords = typeof recipe.keywords === 'string' ? recipe.keywords.split(',') : Array.isArray(recipe.keywords) ? recipe.keywords : [];
    const seen = new Set<string>();
    const tags = [recipe.recipeCategory, recipe.recipeCuisine, ...keywords].flat().map(cleanText)
      .filter(t => t && t.length <= 24 && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase())).slice(0, 8);
    return {
      name: cleanText(recipe.name).slice(0, 80) || 'Recept',
      servings: servings && servings <= 40 ? servings : null,
      minutes: isoMinutes(recipe.totalTime) ?? ((isoMinutes(recipe.prepTime) ?? 0) + (isoMinutes(recipe.cookTime) ?? 0) || null),
      ingredients: ingredients.slice(0, 40), steps: steps(recipe.recipeInstructions).slice(0, 20), tags, url,
    };
  }
  return null;
}

/** Een geplakt recept: één ingrediënt per regel. Koppen en lege regels vallen weg. */
export function recipeFromText(input: { name?: unknown; servings?: unknown; text?: unknown }): WebRecipe {
  const text = typeof input.text === 'string' ? input.text : '';
  check(text.trim().length >= 3 && text.length <= 20_000, 'Plak de ingrediëntenlijst.');
  const lines = text.split(/\r?\n/).map(l => cleanText(l.replace(/^[\s•*·\-–]+/, '')))
    .filter(l => l && l.length <= 160 && !/^(ingredi[eë]nten|bereiding|benodigdheden)\b/i.test(l));
  check(lines.length, 'Plak de ingrediëntenlijst.');
  const servings = Number(input.servings);
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  return {
    name: (name || 'Geplakt recept').slice(0, 80),
    servings: Number.isFinite(servings) && servings >= 1 && servings <= 40 ? Math.round(servings) : null,
    minutes: null, ingredients: lines.slice(0, 40), steps: [], tags: [], url: '',
  };
}

// ───────────── Ingrediëntregels lezen ─────────────

const fractions: Record<string, number> = { '½': .5, '¼': .25, '¾': .75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': .125 };
const units: Record<string, string> = {
  g: 'g', gr: 'g', gram: 'g', grams: 'g', kg: 'kg', kilo: 'kg', kilogram: 'kg', ml: 'ml', cl: 'cl', dl: 'dl', l: 'l', liter: 'l', ltr: 'l',
  el: 'el', eetlepel: 'el', eetlepels: 'el', tbsp: 'el', tl: 'tl', theelepel: 'tl', theelepels: 'tl', tsp: 'tl',
  st: 'st', stuk: 'st', stuks: 'st', teen: 'st', teentje: 'st', teentjes: 'st', tenen: 'st', plak: 'st', plakken: 'st', plakje: 'st', plakjes: 'st',
  takje: 'st', takjes: 'st', bos: 'st', bosje: 'st', bosjes: 'st', handje: 'st', handvol: 'st', krop: 'st', kroppen: 'st',
};
/** Verpakkingen: '1 blik kikkererwten' ≈ één verpakking van dat ingrediënt. */
const containers = new Set(['blik', 'blikje', 'blikken', 'pak', 'pakje', 'pakken', 'zak', 'zakje', 'zakken', 'potje', 'pot', 'fles', 'flesje', 'bakje', 'doos', 'doosje', 'tube']);
/** Zonder vaste hoeveelheid; nemen we mee als basisvoorraad. */
const pinch = /\b(snufje|snuf|scheutje|scheut|naar smaak|beetje|mespunt|evt\.?|eventueel)\b/i;

export type ParsedLine = { original: string; name: string; amount: number | null; unit: string | null; container: boolean };

/** '200 g kipfilet, in blokjes' → { amount: 200, unit: 'g', name: 'kipfilet' }. */
export function parseLine(original: string): ParsedLine {
  let text = cleanText(original).toLowerCase();
  // Grammen tussen haakjes ('1 blik tomaten (400 g)') winnen van de verpakking.
  const inner = /\((?:ca\.?\s*)?(\d+(?:[.,]\d+)?)\s*(g|gram|ml|kg|l)\)/.exec(text);
  text = text.replace(/\([^)]*\)/g, ' ');
  for (const [glyph, value] of Object.entries(fractions)) text = text.replace(new RegExp(`(\\d*)\\s*${glyph}`, 'g'), (_m, whole: string) => String((Number(whole) || 0) + value));
  text = text.replace(/(\d+)\s+(\d+)\/(\d+)/g, (_m, w, a, b) => String(Number(w) + Number(a) / Number(b)))
    .replace(/(\d+)\/(\d+)/g, (_m, a, b) => String(Number(a) / Number(b)))
    .replace(/(\d+(?:[.,]\d+)?)\s*(?:-|–|tot)\s*(\d+(?:[.,]\d+)?)/g, '$2') // '2-3' → 3: liever genoeg
    .replace(/,(?=\d)/g, '.').replace(/\s+/g, ' ').trim();
  const m = /^(\d+(?:\.\d+)?)?\s*([a-zé]+\.?)?\s*(.*)$/.exec(text)!;
  let amount = m[1] ? Number(m[1]) : null;
  let unitWord = (m[2] ?? '').replace(/\.$/, '');
  let rest = m[3];
  let unit: string | null = null;
  let container = false;
  if (unitWord && units[unitWord]) unit = units[unitWord];
  else if (unitWord && containers.has(unitWord)) container = true;
  else { rest = `${unitWord} ${rest}`.trim(); unitWord = ''; }
  if (inner) { amount = Number(inner[1].replace(',', '.')) * (container ? (amount ?? 1) : 1); unit = inner[2] === 'gram' ? 'g' : inner[2]; container = false; }
  const name = rest.replace(/^(van de|van|de|het|een)\s+/, '').split(/,| - | – |\bvoor het\b|\bom te\b/)[0]
    .replace(/\b(fijngesneden|gesneden|gehakt|geraspt|in blokjes|in reepjes|uitgelekt|afgespoeld|vers|verse|grote?|kleine?|middelgrote?|rijpe?)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return { original: cleanText(original), name: name || cleanText(original), amount, unit, container };
}

// ───────────── Omzetten naar een Weekmand-recept ─────────────

export type PreviewLine = { original: string; name: string; amount: number; unit: BaseUnit; key: string | null; status: 'bekend' | 'nieuw' | 'overgeslagen'; note?: string };
export type Preview = { name: string; servings: number; minutes: number; steps: string; tags: string[]; url: string; lines: PreviewLine[] };

/**
 * Zet de ingrediëntregels om naar hoeveelheden per persoon in de eenheden van de catalogus.
 * Regels zonder hoeveelheid worden basisvoorraad als het ingrediënt dat is, anders overgeslagen.
 */
export function previewRecipe(recipe: WebRecipe, catalog: Catalog): Preview {
  const servings = recipe.servings ?? 4;
  const lines: PreviewLine[] = recipe.ingredients.map(original => {
    const p = parseLine(original);
    const def = catalog.resolve(p.name);
    const skip = (note: string): PreviewLine => ({ original: p.original, name: def?.name ?? p.name, amount: 0, unit: def?.unit ?? 'st', key: def?.key ?? null, status: 'overgeslagen', note });
    if (p.amount === null || pinch.test(p.original)) {
      if (def?.staple) return { original: p.original, name: def.name, amount: def.unit === 'st' ? 0.1 : 2, unit: def.unit, key: def.key, status: 'bekend', note: 'basisvoorraad' };
      return skip('geen hoeveelheid');
    }
    let amount: number | null;
    let unit: BaseUnit;
    if (p.container) {
      // Eén blik/pak/zak ≈ één verpakking van dat ingrediënt.
      const pack = def?.packs[0];
      if (!def || !pack) return skip('verpakking zonder inhoud');
      amount = p.amount * pack.amount;
      unit = def.unit;
    } else {
      const base = toBase(p.amount, p.unit ?? 'st');
      if (!base) return skip('onbekende eenheid');
      if (def) {
        amount = convert(base.amount, base.unit, def);
        unit = def.unit;
        if (amount === null) return skip(`kan ${base.unit} niet omrekenen`);
      } else {
        amount = base.amount;
        unit = base.unit;
      }
    }
    const perPerson = Math.round(amount / servings * 100) / 100;
    if (!(perPerson > 0)) return skip('hoeveelheid te klein');
    return { original: p.original, name: def?.name ?? p.name.replace(/^./, c => c.toUpperCase()), amount: perPerson, unit, key: def?.key ?? null, status: def ? 'bekend' : 'nieuw' };
  });
  check(lines.some(l => l.status !== 'overgeslagen'), 'Geen enkel ingrediënt kon worden gelezen.');
  return {
    name: recipe.name, servings, minutes: recipe.minutes ?? 30, tags: recipe.tags.slice(0, 6), url: recipe.url, lines,
    steps: [...recipe.steps.map((s, i) => `${i + 1}. ${s}`), ...(recipe.url ? [`Bron: ${recipe.url}`] : [])].join('\n').slice(0, 1500),
  };
}
