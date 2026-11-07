import { ingredients as builtinIngredients } from './data/ingredients.ts';
import { recipes as builtinRecipes } from './data/recipes.ts';
import type { Store } from './db.ts';
import { check } from './errors.ts';
import type { BaseUnit, Category, IngredientDef, Recipe, RecipeDef } from './types.ts';
import { toBase } from './units.ts';

export const normalize = (text: string) =>
  text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
export const slug = (text: string) => normalize(text).replace(/ /g, '-').slice(0, 60);

/** Grove enkelvoudsvorm voor Nederlandse meervouden: 'tomaten' → 'tomaat', 'eieren' → 'ei'. */
function singular(word: string): string[] {
  const forms = [word];
  if (word.endsWith('eren')) forms.push(word.slice(0, -4));
  if (word.endsWith('jes')) forms.push(word.slice(0, -3), word.slice(0, -1));
  if (word.endsWith('en')) {
    const stem = word.slice(0, -2);
    forms.push(stem);
    if (/[^aeiou][aeiou][^aeiou]$/.test(stem)) forms.push(stem.slice(0, -1) + stem.at(-2) + stem.at(-1)); // tomat → tomaat
    if (/(.)\1$/.test(stem)) forms.push(stem.slice(0, -1)); // flessen → fles
  }
  if (word.endsWith('s')) forms.push(word.slice(0, -1));
  return forms;
}

export class Catalog {
  #store: Store;
  #ingredients: Map<string, IngredientDef> | null = null;
  #recipes: Map<string, Recipe> | null = null;

  constructor(store: Store) { this.#store = store; }

  #refresh() { this.#ingredients = null; this.#recipes = null; }

  ingredients(): IngredientDef[] { return [...this.#ingredientMap().values()]; }
  #ingredientMap() {
    if (!this.#ingredients) {
      this.#ingredients = new Map(builtinIngredients.map(i => [i.key, i]));
      for (const custom of this.#store.customIngredients()) this.#ingredients.set(custom.key, custom);
    }
    return this.#ingredients;
  }
  ingredient(key: string) { return this.#ingredientMap().get(key); }

  recipes(): Recipe[] { return [...this.#recipeMap().values()]; }
  #recipeMap() {
    if (!this.#recipes) {
      this.#recipes = new Map(builtinRecipes.map(r => [r.id, { ...r, source: 'builtin' as const }]));
      for (const custom of this.#store.customRecipes()) this.#recipes.set(custom.id, custom);
    }
    return this.#recipes;
  }
  recipe(id: string) { return this.#recipeMap().get(id); }

  /**
   * Zoek het ingrediënt dat bij vrije tekst of een productnaam hoort: 'kip', 'krat bier',
   * "'t Slagershuys kipdijfilets", 'Picnic scharreleieren'. Volgorde: exacte naam; een naam
   * waarvan alle woorden voorkomen (langste wint, ook meervoud); een samenstelling die op een
   * naam eindigt (scharrel-eieren, boter-sla).
   */
  resolve(text: string): IngredientDef | undefined {
    const query = normalize(text);
    if (!query) return undefined;
    const all = this.ingredients();
    const names = (i: IngredientDef) => [i.key.replace(/-/g, ' '), normalize(i.name), ...(i.aliases ?? []).map(normalize)];
    const exact = all.find(i => names(i).includes(query));
    if (exact) return exact;
    const forms = new Set(query.split(' ').flatMap(singular));
    const queryWords = new Set(query.split(' '));
    const has = (word: string) => forms.has(word) || singular(word).some(f => forms.has(f));
    let best: { i: IngredientDef; score: number } | undefined;
    for (const i of all) for (const n of names(i)) {
      const words = n.split(' ');
      let score = 0;
      // Woorden die letterlijk voorkomen winnen van woorden die alleen via enkelvoud passen ('brood' vs 'broodjes').
      if (words.every(has)) score = 100 + n.length - 6 * words.filter(w => !queryWords.has(w)).length;
      else if (words.length === 1 && n.length >= 3) {
        const stems = singular(n);
        const hit = stems.find(st => st.length >= 3 && [...forms].some(f => f.length >= st.length + 3 && f.endsWith(st)));
        if (hit) score = 50 + hit.length + (hit === n ? 1 : 0);
      }
      if (score && (!best || score > best.score)) best = { i, score };
    }
    return best?.i;
  }

  /** Voeg een ingrediënt toe dat de AI of gebruiker noemt maar dat nog niet bestaat. */
  ensureIngredient(name: string, unit: BaseUnit, category: Category = 'groente-fruit'): IngredientDef {
    const existing = this.resolve(name);
    if (existing) return existing;
    const key = slug(name);
    check(/^[a-z0-9-]{2,60}$/.test(key), 'Ongeldige ingrediëntnaam: ' + name);
    const def: IngredientDef = {
      key, name: name.trim().replace(/^./, c => c.toUpperCase()), unit, category, query: name.trim(),
      packs: [{ id: key + '-demo', name: name.trim() + ' (demo)', amount: unit === 'st' ? 1 : unit === 'g' ? 250 : 500, unit, cents: 299 }],
    };
    this.#store.saveIngredient(def);
    this.#refresh();
    return def;
  }

  /**
   * Bewaar een recept uit vrije invoer. Ingrediëntnamen worden gekoppeld aan de catalogus;
   * onbekende ingrediënten worden aangemaakt. Hoeveelheden gelden per volwassen portie.
   */
  addRecipe(input: { id?: string; name: string; tags?: string[]; minutes?: number; steps?: string; ingredients: { name: string; amount: number; unit: string }[] }, source: Recipe['source']): Recipe {
    check(typeof input.name === 'string' && input.name.trim().length >= 2 && input.name.length <= 80, 'Geef het recept een naam.');
    check(Array.isArray(input.ingredients) && input.ingredients.length >= 1 && input.ingredients.length <= 30, 'Een recept heeft 1 tot 30 ingrediënten.');
    const ingredients = input.ingredients.map(item => {
      check(typeof item.name === 'string' && item.name.trim(), 'Elk ingrediënt heeft een naam.');
      check(typeof item.amount === 'number' && item.amount > 0 && item.amount < 100000, 'Ongeldige hoeveelheid voor ' + item.name + '.');
      const base = toBase(item.amount, String(item.unit || 'st'));
      check(base, 'Onbekende eenheid "' + item.unit + '" bij ' + item.name + '. Gebruik g, kg, ml, l, el, tl of st.');
      const def = this.ensureIngredient(item.name, base.unit);
      const amount = base.unit === def.unit ? base.amount
        : def.pieceGrams && base.unit === 'st' ? base.amount * def.pieceGrams
          : def.pieceGrams && def.unit === 'st' ? base.amount / def.pieceGrams
            : base.unit !== 'st' && def.unit !== 'st' ? base.amount : null;
      check(amount !== null, `Kan ${item.amount} ${item.unit} ${item.name} niet omrekenen naar ${def.unit}.`);
      return { key: def.key, amount: Math.round(amount * 100) / 100, unit: def.unit };
    });
    const tags = (input.tags ?? []).map(t => normalize(t).replace(/ /g, '-')).filter(Boolean).slice(0, 12);
    if (!tags.includes('vegetarisch') && ingredients.every(i => !['vlees', 'vis'].includes(this.ingredient(i.key)!.category))) tags.push('vegetarisch');
    let id = input.id && /^[a-z0-9-]{2,60}$/.test(input.id) ? input.id : slug(input.name);
    if (!input.id && this.recipe(id)?.source === 'builtin') id += '-eigen';
    const recipe: Recipe = {
      id, name: input.name.trim(), tags, minutes: Math.min(240, Math.max(5, Math.round(input.minutes ?? 30))),
      ingredients, steps: (input.steps ?? '').trim().slice(0, 1500), source,
    };
    this.#store.saveRecipe(recipe);
    this.#refresh();
    return recipe;
  }

  deleteRecipe(id: string) {
    check(this.recipe(id)?.source !== 'builtin', 'Ingebouwde recepten kun je niet verwijderen; sluit ze uit in de voorkeuren.');
    this.#store.deleteRecipe(id);
    this.#refresh();
  }

  /** Zoek recepten op naam, tag of ingrediënt. */
  searchRecipes(query = '', tag = ''): Recipe[] {
    const q = normalize(query);
    const t = normalize(tag).replace(/ /g, '-');
    return this.recipes().filter(r => (!t || r.tags.includes(t)) && (!q ||
      normalize(r.name).includes(q) || r.tags.some(x => x.includes(q.replace(/ /g, '-'))) ||
      r.ingredients.some(i => normalize(this.ingredient(i.key)?.name ?? i.key).includes(q))));
  }
}

export type { RecipeDef };
