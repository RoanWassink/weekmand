import type PicnicClient from 'picnic-api';
import type { Weekmand } from './app.ts';
import { normalize, slug } from './catalog.ts';
import type { BaseUnit, Category } from './types.ts';
import { convert, packAmount, parseUnitQuantity, toBase } from './units.ts';

type Client = InstanceType<typeof PicnicClient>;
type Summary = Awaited<ReturnType<Client['recipe']['getSavedRecipes']>>[number];
type Detail = Awaited<ReturnType<Client['recipe']['getRecipe']>>;
export type PicnicRecipeLabel = 'bewaard' | 'besteld' | 'eigen';
type Imported = { labels: PicnicRecipeLabel[]; at: number; recipeId: string; name: string };

/** Rijen in het Picnic-receptenoverzicht die over eerder bestelde recepten gaan. */
const orderedRow = /besteld|eerder|opnieuw|nog eens|vaker|gekookt|jouw favorieten/i;

/** '(150 g nodig)' → 150 g; '(2 stuks nodig)' → 2 st. */
export function neededAmount(text: string | null): { amount: number; unit: BaseUnit } | null {
  const m = /([\d]+(?:[.,]\d+)?)\s*(g|gr|gram|kg|kilo|ml|cl|dl|l|liter|el|tl|st|stuks?|teentjes?|plakjes?)?\s*nodig/i.exec(text ?? '');
  if (!m) return null;
  return toBase(Number(m[1].replace(',', '.')), (m[2] ?? 'st').replace(/^stuks?$|^teentjes?$|^plakjes?$/i, 'st'));
}

/**
 * Zet een Picnic-recept om naar een Weekmand-recept: hoeveelheden per persoon, bereidingsstappen,
 * labels. Picnic-producten uit het recept worden de koppeling van het ingrediënt als dat er nog geen heeft.
 * Kastvoorraad (zout, olie, …) slaat Picnic zelf al over bij het bestellen; die nemen we niet mee.
 */
export function convertRecipe(app: Weekmand, detail: Detail, summary: Summary | undefined, labels: PicnicRecipeLabel[]) {
  const portions = detail.portions || detail.defaultPortions || 2;
  const ingredients: { name: string; amount: number; unit: string }[] = [];
  for (const ing of detail.ingredients) {
    if (ing.type === 'CUPBOARD' || !ing.name) continue;
    const pack = ing.unitQuantity ? parseUnitQuantity(ing.unitQuantity) : {};
    const needed = neededAmount(ing.neededText);
    const unit: BaseUnit = needed?.unit ?? (pack.g !== undefined ? 'g' : pack.ml !== undefined ? 'ml' : 'st');
    const def = app.catalog.resolve(ing.name) ?? app.catalog.ensureIngredient(ing.name, unit, 'groente-fruit' as Category);
    let amount: number | null = needed ? convert(needed.amount, needed.unit, def) : null;
    if (amount === null && ing.unitQuantity) {
      const per = packAmount(ing.unitQuantity, def);
      amount = per ? per * Math.max(1, ing.quantity) : null;
    }
    if (!amount) continue;
    ingredients.push({ name: def.name, amount: Math.round(amount / portions * 100) / 100, unit: def.unit });
    // Het product uit het Picnic-recept is een goede koppeling voor dit ingrediënt.
    if (!app.store.link(def.key) && ing.sellingUnitId && ing.unitQuantity && ing.isAvailable) {
      const per = packAmount(ing.unitQuantity, def);
      if (per) app.store.saveLink({ key: def.key, productId: ing.sellingUnitId, name: ing.name, unitQuantity: ing.unitQuantity, packAmount: per, cents: ing.price ?? 0, auto: true, updatedAt: new Date(app.now()).toISOString() });
    }
  }
  if (!ingredients.length) return null;
  const tags = [...(summary?.tags ?? []), ...(detail.tag ? [detail.tag] : [])]
    .map(t => normalize(t)).filter(t => t && !/\bmin\b|\d/.test(t)).map(t => t.replace(/ /g, '-'));
  const steps = detail.steps.map((s, i) => `${i + 1}. ${s.replace(/\*\*/g, '')}`).join('\n');
  return app.catalog.addRecipe({
    id: ('picnic-' + slug(detail.id)).slice(0, 60), name: detail.name,
    tags: ['picnic', ...labels, ...tags], minutes: detail.cookingTimeMinutes ?? summary?.cookingTimeMinutes ?? 30,
    steps: steps || detail.description || '', ingredients,
  }, 'picnic');
}

/**
 * Haal bewaarde, eigen en eerder bestelde Picnic-recepten op en zet nieuwe om. Recepten die al
 * zijn opgehaald krijgen alleen hun labels bijgewerkt; details worden rustig (met pauzes) opgehaald.
 */
export async function importPicnicRecipes(app: Weekmand, max = 15) {
  const picnic = app.picnic;
  const found = new Map<string, { summary?: Summary; labels: Set<PicnicRecipeLabel> }>();
  const add = (s: Summary | { id: string }, label: PicnicRecipeLabel) => {
    const entry = found.get(s.id) ?? { labels: new Set<PicnicRecipeLabel>() };
    if ('name' in s) entry.summary = s;
    entry.labels.add(label);
    found.set(s.id, entry);
  };
  const lists: string[] = [];
  for (const s of await picnic.savedRecipes()) add(s, 'bewaard');
  for (const s of await picnic.userRecipes().catch(() => [] as Summary[])) add(s, 'eigen');
  const overview = await picnic.recipeOverview().catch(() => null);
  for (const section of overview?.sections ?? []) {
    if (!orderedRow.test(section.title)) continue;
    lists.push(section.title);
    for (const s of section.recipes) add(s, 'besteld');
  }
  for (const id of Object.keys(app.store.get<Record<string, string>>('picnicCartRecipes', {}))) add({ id }, 'besteld');

  const known = app.store.get<Record<string, Imported>>('picnicRecipes', {});
  let fetched = 0, added = 0, skipped = 0;
  for (const [id, entry] of found) {
    const labels = [...entry.labels].sort();
    const previous = known[id];
    if (previous && labels.every(l => previous.labels.includes(l))) continue;
    if (previous) {
      // Alleen labels bijwerken.
      const recipe = app.catalog.recipe(previous.recipeId);
      if (recipe) app.store.saveRecipe({ ...recipe, tags: [...new Set([...recipe.tags, ...labels])] });
      known[id] = { ...previous, labels: [...new Set([...previous.labels, ...labels])] };
      continue;
    }
    if (fetched >= max) break;
    if (fetched++ && app.searchPause) await new Promise(r => setTimeout(r, app.searchPause));
    let detail: Detail;
    try { detail = await picnic.recipe(id); } catch (error) {
      if ((error as { status?: number }).status === 401) throw error;
      skipped++;
      continue;
    }
    const recipe = convertRecipe(app, detail, entry.summary, labels);
    if (!recipe) { skipped++; continue; }
    known[id] = { labels, at: app.now(), recipeId: recipe.id, name: recipe.name };
    added++;
  }
  app.store.set('picnicRecipes', known);
  app.changed();
  return { found: found.size, added, skipped, remaining: [...found.keys()].filter(id => !known[id]).length, orderedLists: lists };
}
