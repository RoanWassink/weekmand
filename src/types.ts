// Gedeelde typen. Alleen "erasable" TypeScript: Node draait deze bestanden zonder build-stap.

/** Basiseenheid waarin recepten, voorraad en verpakkingen rekenen. */
export type BaseUnit = 'g' | 'ml' | 'st';

export type Category =
  | 'groente-fruit' | 'aardappel' | 'vlees' | 'vis' | 'vega' | 'zuivel-eieren' | 'kaas'
  | 'brood' | 'pasta-rijst' | 'conserven' | 'kruiden-sauzen' | 'olie-azijn' | 'bakken'
  | 'diepvries' | 'drinken' | 'ontbijt' | 'snacks' | 'huishouden';

/** Een product uit de democatalogus (mock-winkel). */
export type DemoPack = { id: string; name: string; amount: number; unit: BaseUnit; cents: number };

export type IngredientDef = {
  /** Unieke sleutel, kleine letters a-z, cijfers en '-' (bijv. 'kipfilet'). */
  key: string;
  /** Weergavenaam, bijv. 'Kipfilet'. */
  name: string;
  /** De eenheid waarin recepten en voorraad dit ingrediënt tellen. */
  unit: BaseUnit;
  /** Gewicht van één stuk in gram, voor omrekenen tussen stuks en gram. */
  pieceGrams?: number;
  category: Category;
  /** Basisvoorraad (zout, olie, kruiden): niet per recept kopen, alleen als de voorraad op is. */
  staple?: boolean;
  /** Zoekterm voor Picnic. */
  query: string;
  /** Varianten in de democatalogus. */
  packs: DemoPack[];
  /** Synoniemen voor tekstcommando's, bijv. ['kip', 'kippenborst']. */
  aliases?: string[];
};

export type RecipeIngredient = { key: string; amount: number; unit: BaseUnit };

export type RecipeDef = {
  id: string;
  name: string;
  /** Bijv. 'vegetarisch', 'vis', 'kip', 'mexicaans', 'snel', 'kindvriendelijk'. */
  tags: string[];
  minutes: number;
  /** Hoeveelheden voor één volwassen portie. */
  ingredients: RecipeIngredient[];
  steps: string;
};

export type Recipe = RecipeDef & { source: 'builtin' | 'user' | 'ai' | 'picnic' | 'web' };

export type Household = {
  adults: number;
  children: number;
  toddlers: number;
  /** Totaalbudget voor de mand in euro. */
  budget: number;
  vegetarian: boolean;
  /** Ingrediëntsleutels die nooit in het menu mogen. */
  exclude: string[];
  /** Aantal avondmaaltijden per bestelling. */
  days: number;
};

/** Een regel die het systeem heeft geleerd of die de gebruiker heeft ingesteld. */
export type AvoidRule =
  | { kind: 'tag-weekday'; tag: string; weekday: number }
  | { kind: 'recipe'; recipeId: string }
  | { kind: 'ingredient-auto'; key: string };

export type Meal = {
  date: string; // YYYY-MM-DD
  recipeId: string;
  /** Porties (volwassen-equivalent). */
  servings: number;
  status: 'proposed' | 'approved';
  note?: string;
};

export type PantryItem = {
  key: string;
  /** Hoeveelheid in de basiseenheid van het ingrediënt, of null als onbekend. */
  amount: number | null;
  /** ISO-tijd van de laatste bevestiging. */
  checkedAt: string | null;
  /** Gewenste minimumvoorraad (vaste voorraad), in basiseenheid. */
  minimum: number;
};

/** Een product in de echte of gesimuleerde winkel. */
export type ShopProduct = {
  id: string;
  name: string;
  /** Verpakkingsomschrijving zoals de winkel die toont, bijv. '500 gram'. */
  unitQuantity: string;
  cents: number;
  available: boolean;
  /** Staffelprijzen per stuk vanaf een aantal ("2 voor €7"). */
  tiers?: { from: number; cents: number }[];
  /** Aanbiedingslabel, bijv. '1+1 gratis'. */
  promo?: string;
};

export type CartLine = ShopProduct & { quantity: number };

export type ShopCart = {
  id: string;
  lines: CartLine[];
  totalCents: number;
  /** Recepten in de mand (alleen Picnic). */
  recipes?: { id: string; title: string }[];
};

export type DeliverySlot = {
  id: string;
  windowStart: string;
  windowEnd: string;
  cutOff: string;
  selected: boolean;
  available: boolean;
};
