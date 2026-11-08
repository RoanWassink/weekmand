import type { Weekmand } from './app.ts';
import { check } from './errors.ts';
import { addDays, localDate, resolveDay } from './time.ts';
import { euro } from './units.ts';

/**
 * Eén lijst met tools voor alle ingangen: MCP (Claude, ChatGPT), de OpenAPI-koppeling voor een
 * Custom GPT, de chat in de webapp en Telegram. Mandwijzigingen gaan altijd in twee stappen:
 * eerst `add_to_cart` / `remove_from_cart` (berekenen en tonen), daarna `confirm_cart_update`
 * na akkoord van de gebruiker. Er is geen tool om af te rekenen of te bestellen.
 */
export type ToolContext = { channel: 'mcp' | 'openapi' | 'chat' | 'telegram' | 'web'; pendingReview?: (id: string) => void };
export type Tool = {
  name: string;
  title: string;
  description: string;
  input: Record<string, unknown>;
  readOnly?: boolean;
  /** Alleen voor ingangen waar het host-programma de gebruiker om toestemming vraagt. */
  needsHostApproval?: boolean;
  run: (app: Weekmand, args: Record<string, any>, ctx: ToolContext) => Promise<unknown>;
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const day = str("Dag: 'vandaag', 'morgen', een weekdag zoals 'vrijdag', of een datum YYYY-MM-DD.");

function date(app: Weekmand, text: unknown) {
  check(typeof text === 'string', 'Geef een dag.');
  const value = resolveDay(text, localDate(app.now()));
  check(value, `Ik begrijp de dag "${text}" niet.`);
  check(value >= localDate(app.now()), 'Die dag is al voorbij.');
  return value;
}

/** Compacte weergave van een mandberekening voor een taalmodel of chatbericht. */
export function planSummary(plan: Awaited<ReturnType<Weekmand['plan']>>) {
  const changes = plan.lines.filter(l => l.add || l.remove).map(l => ({
    product: l.product, pack: l.unitQuantity, ...(l.add ? { add: l.add } : { remove: l.remove }), price: euro(l.cents), reason: l.reason,
  }));
  return {
    review_id: plan.id,
    window: `${plan.window.start} t/m ${plan.window.end}`,
    meals: plan.meals.map(m => `${m.day} ${m.date}: ${m.name} (${m.servings} p.)`),
    changes,
    unchanged_lines: plan.lines.length - changes.length,
    add_total: euro(plan.addCents), remove_total: euro(plan.removeCents),
    cart_total_after: euro(plan.totalCents), budget: euro(plan.budgetCents), over_budget: plan.totalCents > plan.budgetCents,
    stock_questions: plan.questions.map(q => q.text),
    missing_products: plan.missing.map(m => `${m.name}: ${m.reason}`),
  };
}

export const tools: Tool[] = [
  {
    name: 'get_pantry_status', title: 'Voorraad bekijken', readOnly: true,
    description: 'Welke producten zijn (bijna) op, en wat is de geschatte voorraad thuis? Schattingen ouder dan drie dagen zijn onzeker.',
    input: obj({}),
    run: async app => {
      const p = await app.pantryStatus();
      return { low: p.low, items: p.items.map(i => ({ name: i.name, amount: i.text, status: i.status, estimate: i.estimate, needed_this_order: i.neededThisOrder || undefined })) };
    },
  },
  {
    name: 'update_pantry', title: 'Voorraad bijwerken',
    description: "Werk de voorraad bij: een hoeveelheid met eenheid, of een status 'op', 'bijna op', 'genoeg' (bevestigt de schatting) of 'onbekend'. Optioneel een minimum ('altijd 2 liter melk in huis').",
    input: obj({
      items: {
        type: 'array', minItems: 1, maxItems: 60, items: obj({
          name: str('Ingrediënt, bijv. "melk" of "eieren".'), amount: num('Hoeveelheid.'), unit: str('g, kg, ml, l of st.'),
          status: { type: 'string', enum: ['op', 'bijna op', 'genoeg', 'onbekend'] }, minimum: num('Gewenste minimumvoorraad in dezelfde eenheid.'),
        }, ['name']),
      },
    }, ['items']),
    run: async (app, a) => ({ updated: app.updatePantry(a.items) }),
  },
  {
    name: 'get_meal_plan', title: 'Weekmenu bekijken', readOnly: true,
    description: 'Wat staat er op het menu? Geeft per dag het gerecht, de porties en of de dag in de komende bestelling valt, plus de bezorgdeadline.',
    input: obj({}),
    run: async app => {
      const [menu, delivery] = await Promise.all([app.menu(), app.delivery()]);
      return {
        order_window: menu.window, cut_off: delivery.cutOff, hours_left: delivery.hoursLeft,
        days: menu.days.map(d => ({ date: d.date, day: d.day, in_order: d.inOrder, meal: d.meal ? { recipe_id: d.meal.id, name: d.meal.name, servings: d.meal.servings, status: d.meal.status } : null })),
      };
    },
  },
  {
    name: 'propose_meal_plan', title: 'Weekmenu voorstellen',
    description: 'Stel een weekmenu voor de komende bestelling voor. Goedgekeurde en zelf gekozen maaltijden blijven staan. Voorkeuren in gewone taal, bijv. "graag snel, geen vis en een keer Mexicaans".',
    input: obj({
      days: { type: 'integer', minimum: 1, maximum: 7, description: 'Aantal avondmaaltijden.' },
      preferences: str('Weekwens in gewone taal.'),
      replace: { type: 'boolean', description: 'Ook bestaande voorstellen (niet goedgekeurd) vervangen.' },
    }),
    run: async (app, a) => {
      const menu = await app.proposeMenu({ wish: a.preferences, days: a.days, replace: a.replace });
      return { days: menu.days.filter(d => d.inOrder).map(d => ({ date: d.date, day: d.day, meal: d.meal?.name ?? null, recipe_id: d.meal?.id, servings: d.meal?.servings })) };
    },
  },
  {
    name: 'set_meal', title: 'Gerecht op een dag zetten',
    description: 'Zet een gerecht op een dag, met het aantal porties (volwassenen; "6 man" = 6). Gebruik recipe_id uit find_recipes, of geef een nieuw recept mee (ingrediënten per 1 portie). Voorbeeld: "vrijdag met 6 man Mexicaans" → find_recipes(tag "mexicaans") en dan set_meal.',
    input: obj({
      day, recipe_id: str('Bestaand recept-ID.'), servings: num('Aantal porties.'), note: str('Opmerking, bijv. "visite".'),
      recipe: obj({
        name: str('Naam van het gerecht.'), tags: { type: 'array', items: { type: 'string' } }, minutes: { type: 'integer' }, steps: str('Korte bereiding.'),
        ingredients: { type: 'array', minItems: 1, items: obj({ name: str('Ingrediënt; gebruik bij voorkeur een gewone naam (kippenpoten, tijm), geen omschrijving.'), amount: num('Per portie.'), unit: str('g, kg, ml, l, el, tl of st.'), category: { type: 'string', enum: ['groente-fruit', 'aardappel', 'vlees', 'vis', 'vega', 'zuivel-eieren', 'kaas', 'brood', 'pasta-rijst', 'conserven', 'kruiden-sauzen', 'olie-azijn', 'bakken', 'diepvries', 'drinken', 'ontbijt', 'snacks', 'huishouden'] } }, ['name', 'amount', 'unit']) },
      }, ['name', 'ingredients']),
    }, ['day']),
    run: async (app, a) => {
      check(a.recipe_id || a.recipe, 'Geef recipe_id of een nieuw recept.');
      const recipeId = a.recipe ? app.catalog.addRecipe(a.recipe, 'ai').id : a.recipe_id;
      return app.setMeal({ date: date(app, a.day), recipeId, servings: a.servings, note: a.note });
    },
  },
  {
    name: 'swap_meal', title: 'Ander gerecht kiezen',
    description: 'Vervang het gerecht op een dag door een ander voorstel, optioneel met een wens. Telt als afwijzing (Weekmand leert daarvan).',
    input: obj({ day, preferences: str('Wens voor het nieuwe gerecht.') }, ['day']),
    run: async (app, a) => app.swapMeal(date(app, a.day), a.preferences ?? ''),
  },
  {
    name: 'adapt_meal', title: 'Gerecht aanpassen of vervangen',
    description: 'Vervang het gerecht op een dag volgens een opmerking: een aanpassing ("met kippenpoten in plaats van kippenbouten", "zonder paprika", "voor 6 personen pittiger") of een wens ("iets vegetarisch"). Weekmand maakt een aangepast recept en zet het op die dag; het oude recept blijft in de receptenlijst. Gebruik dit in plaats van zelf een recept te bedenken als de gebruiker een bestaand gerecht wil veranderen. Daarna add_to_cart om de mand opnieuw te berekenen.',
    input: obj({ day, note: str('Wat er anders moet.') }, ['day', 'note']),
    run: async (app, a) => ({ replaced: await app.replaceMeals({ dates: [date(app, a.day)], note: a.note }) }),
  },
  {
    name: 'remove_meal', title: 'Maaltijd schrappen', description: 'Haal de maaltijd van een dag van het menu (bijv. uit eten).',
    input: obj({ day }, ['day']),
    run: async (app, a) => { const d = date(app, a.day); app.removeMeal(d); return { removed: d }; },
  },
  {
    name: 'approve_meal_plan', title: 'Weekmenu goedkeuren', description: 'Keur alle voorgestelde maaltijden goed, zodat een nieuw voorstel ze niet meer vervangt.',
    input: obj({}),
    run: async app => ({ approved: await app.approveMenu() }),
  },
  {
    name: 'find_recipes', title: 'Recepten zoeken', readOnly: true,
    description: 'Zoek recepten op naam, ingrediënt of tag (vegetarisch, vis, kip, mexicaans, italiaans, aziatisch, snel, kindvriendelijk, feest, soep …).',
    input: obj({ query: str('Zoekwoord.'), tag: str('Tag.') }),
    run: async (app, a) => app.listRecipes(a.query ?? '', a.tag ?? '').slice(0, 25).map(r => ({ id: r.id, name: r.name, tags: r.tags, minutes: r.minutes, allowed: r.allowed, per_portion: euro(r.costPerPortionCents) })),
  },
  {
    name: 'import_recipe', title: 'Recept van een website importeren',
    description: 'Haal een recept op van een receptwebsite (link) en sla het op in Weekmand, met hoeveelheden per persoon. Werkt voor sites met schema.org-receptgegevens (bijna alle grote receptsites). Daarna kan het met set_meal op het menu.',
    input: obj({ url: str('Link naar de receptpagina.') }, ['url']),
    run: async (app, a) => {
      const preview = await app.previewRecipeFromUrl(a.url);
      const recipe = app.saveImportedRecipe(preview);
      return { recipe_id: recipe.id, name: recipe.name, minutes: recipe.minutes, ingredients: recipe.ingredients.length, skipped: preview.lines.filter(l => l.status === 'overgeslagen').map(l => `${l.original} (${l.note})`), new_ingredients: preview.lines.filter(l => l.status === 'nieuw').map(l => l.name) };
    },
  },
  {
    name: 'get_recipe', title: 'Recept bekijken', readOnly: true, description: 'Ingrediënten en bereiding van een recept, voor een aantal porties.',
    input: obj({ recipe_id: str('Recept-ID.'), servings: num('Porties.') }, ['recipe_id']),
    run: async (app, a) => app.recipeDetail(a.recipe_id, a.servings),
  },
  {
    name: 'get_recipe_history', title: 'Receptgeschiedenis', readOnly: true,
    description: 'Gerechten die echt besteld en gegeten zijn, met duimpje omhoog/omlaag en reden, plus de favorietenpool (gelikte recepten om te herhalen) en afgekeurde recepten.',
    input: obj({}),
    run: async app => ({ history: app.recipeHistory().slice(0, 30), favorites: app.favorites().map(f => ({ recipe_id: f.id, name: f.name, times_eaten: f.timesEaten, last_eaten: f.lastEaten })), disliked: app.disliked() }),
  },
  {
    name: 'rate_meal', title: 'Maaltijd beoordelen',
    description: "Duimpje omhoog (komt in de favorietenpool en vaker terug) of omlaag (wordt voorlopig niet meer voorgesteld) voor een gegeten maaltijd. Bij omlaag graag de reden, bijv. 'niet lekker', 'te veel werk', 'kinderen lustten het niet'.",
    input: obj({ day, rating: { type: 'string', enum: ['up', 'down'] }, reason: str('Reden bij duimpje omlaag.') }, ['day', 'rating']),
    run: async (app, a) => {
      check(typeof a.day === 'string', 'Geef een dag.');
      const value = resolveDay(a.day, localDate(app.now()));
      check(value, `Ik begrijp de dag "${a.day}" niet.`);
      // Weekdagen verwijzen hier naar het verleden: 'maandag' = afgelopen maandag.
      const past = value > localDate(app.now()) ? addDays(value, -7) : value;
      return { message: app.rateMeal(past, a.rating, a.reason) };
    },
  },
  {
    name: 'add_to_cart', title: 'Boodschappen berekenen en toevoegen',
    description: 'Zet optioneel extra producten op de lijst (bijv. "krat pils", of "500 g gehakt") en bereken het verschil tussen wat nodig is (menu, vaste boodschappen, extra\'s, min voorraad) en de huidige Picnic-mand. Past NIETS toe: laat de gebruiker de wijzigingen zien en roep pas na akkoord confirm_cart_update aan met het review_id.',
    input: obj({
      items: { type: 'array', maxItems: 25, items: obj({ name: str('Product, bijv. "krat pils".'), product_id: str('Het id uit search_products als de gebruiker precies dat product wil.'), quantity: { type: 'integer', minimum: 1, maximum: 50 }, amount: num('Hoeveelheid voor een ingrediënt.'), unit: str('Eenheid bij amount.') }, ['name']) },
    }),
    run: async (app, a, ctx) => {
      const added = a.items?.length ? await app.addItems(a.items.map((i: any) => ({ ...i, productId: i.product_id }))) : [];
      const plan = await app.plan();
      if (plan.lines.some(l => l.add || l.remove)) ctx.pendingReview?.(plan.id);
      return { added, ...planSummary(plan) };
    },
  },
  {
    name: 'link_product', title: 'Ingrediënt aan een product koppelen',
    description: 'Koppel een ingrediënt uit het menu aan een product van de winkel. Gebruik dit als missing_products een ingrediënt zonder product noemt, of als de gebruiker voor een ingrediënt een ander product wil ("neem kippenpoten voor de kip"). product_id komt uit search_products. Is het ingrediënt in stuks en het product in gram (of andersom), geef dan per_pack: hoeveel van het ingrediënt één verpakking dekt (bijv. 650 g kippenpoten = 3 stuks). Berekent daarna de mand opnieuw; toepassen gaat via de knop.',
    input: obj({ ingredient: str('Het ingrediënt, zoals in missing_products of het recept.'), product_id: str('Het id uit search_products.'), product_name: str('De productnaam uit search_products.'), per_pack: num('Hoeveel van het ingrediënt (in zijn eigen eenheid) één verpakking dekt.') }, ['ingredient', 'product_id']),
    run: async (app, a, ctx) => {
      const link = await app.linkProductFor(a.ingredient, a.product_id, { productName: a.product_name, perPack: a.per_pack });
      const plan = await app.plan();
      if (plan.lines.some(l => l.add || l.remove)) ctx.pendingReview?.(plan.id);
      return { linked: `${link.name} (${link.unitQuantity}) voor ${a.ingredient}`, ...planSummary(plan) };
    },
  },
  {
    name: 'remove_from_cart', title: 'Product weghalen',
    description: 'Haal producten van de lijst of uit de mand voor deze bestelling ("haal de kipfilet eruit"). Berekent daarna opnieuw; toepassen gaat via confirm_cart_update.',
    input: obj({ items: { type: 'array', minItems: 1, maxItems: 25, items: { type: 'string' } } }, ['items']),
    run: async (app, a, ctx) => {
      const removed = await app.removeItems(a.items);
      const plan = await app.plan();
      if (plan.lines.some(l => l.add || l.remove)) ctx.pendingReview?.(plan.id);
      return { removed, ...planSummary(plan) };
    },
  },
  {
    name: 'confirm_cart_update', title: 'Mandwijziging toepassen', needsHostApproval: true,
    description: 'Pas een berekende mandwijziging toe in Picnic. Alleen na uitdrukkelijk akkoord van de gebruiker op de getoonde wijzigingen. Bestelt of betaalt niets.',
    input: obj({ review_id: str('Het review_id uit add_to_cart of remove_from_cart.') }, ['review_id']),
    run: async (app, a) => app.applyPlan(a.review_id),
  },
  {
    name: 'review_current_cart', title: 'Winkelmand bekijken', readOnly: true,
    description: 'Wat zit er nu in de Picnic-mand, wat kost het, wanneer is de wijzigdeadline en welke regels heeft Weekmand toegevoegd?',
    input: obj({}),
    run: async app => {
      const [cart, delivery] = await Promise.all([app.cart(), app.delivery()]);
      return {
        shop: cart.shop, total: euro(cart.totalCents), cut_off: delivery.cutOff, hours_left: delivery.hoursLeft,
        lines: cart.lines.map(l => ({ product: l.name, pack: l.unitQuantity, quantity: l.quantity, price: euro(l.cents), added_by_weekmand: l.byWeekmand || undefined })),
      };
    },
  },
  {
    name: 'send_to_ah_list', title: 'Op de AH-boodschappenlijst zetten',
    description: 'Zet boodschappen op "Mijn lijst" in de Albert Heijn-app, voor wie zelf naar de AH-winkel gaat (zelfscanner). Zonder items: alles wat Weekmand nog wil kopen. Met items: alleen die teksten, bijv. ["melk", "2 komkommers"]. Wat al op de lijst staat wordt overgeslagen. Raakt de Picnic-mand niet.',
    input: obj({ items: { type: 'array', items: { type: 'string' }, description: 'Optioneel: losse boodschappen als tekst.' } }),
    run: async (app, a) => app.sendToAhList(Array.isArray(a.items) && a.items.length ? { ids: [], extra: a.items } : {}),
  },
  {
    name: 'import_ah_receipts', title: 'AH-kassabonnen ophalen',
    description: 'Haal nieuwe kassabonnen van het gekoppelde AH-account op en tel de gekochte producten bij de voorraad. Elke bon telt één keer.',
    input: obj({}),
    run: async app => app.importAhReceipts(),
  },
  {
    name: 'get_budget', title: 'Uitgaven en budget', readOnly: true,
    description: 'Wat het huishouden aan boodschappen uitgaf (Picnic, AH-kassabonnen, losse uitgaven) in een week, maand of jaar: totaal tegenover het budget, per categorie, nodig tegenover extra (snacks, alcohol), per winkel, grootste posten en wat duurder werd.',
    input: obj({ period: { type: 'string', enum: ['week', 'month', 'year'] }, back: num('Hoeveel perioden terug: 0 = deze, 1 = vorige.') }),
    run: async (app, a) => {
      const b = app.budgetOverview({ period: a.period ?? 'month', offset: -Math.abs(Number(a.back) || 0) });
      return {
        period: b.range.label, spent: euro(b.totalCents), budget: euro(b.budget), left: euro(b.budget - b.totalCents),
        forecast: b.forecastCents === null ? null : euro(b.forecastCents), previous: `${b.previousLabel}: ${euro(b.previousCents)}`,
        savedWithOffers: euro(b.savingsCents), perPersonPerDay: euro(b.perPersonDayCents), purchases: b.count,
        notYetSplit: b.coverage < 1 ? `${Math.round((1 - b.coverage) * 100)}% van het bedrag is nog niet per product bekend` : null,
        byShop: { Picnic: euro(b.bySource.picnic), 'Albert Heijn': euro(b.bySource.ah), overig: euro(b.bySource.manual) },
        byCategory: b.categories.map(c => `${c.label}: ${euro(c.cents)}`),
        byKind: b.kinds.map(k => `${k.label}: ${euro(k.cents)}`),
        topProducts: b.products.slice(0, 8).map(p => `${p.name}: ${euro(p.cents)}`),
        moreExpensive: b.priceChanges.slice(0, 5).map(p => `${p.name}: ${euro(p.from.unit)} → ${euro(p.to.unit)} (+${p.percent}%)`),
      };
    },
  },
  {
    name: 'search_products', title: 'Producten zoeken', readOnly: true, description: 'Zoek producten in de winkel (Picnic of demo).',
    input: obj({ query: str('Zoekterm.') }, ['query']),
    run: async (app, a) => (await app.searchProducts(a.query)).map(p => ({ id: p.id, name: p.name, pack: p.unitQuantity, price: euro(p.cents), available: p.available })),
  },
  {
    name: 'get_delivery_info', title: 'Bezorging en deadline', readOnly: true, description: 'Gekozen bezorgmoment, wijzigdeadline en beschikbare momenten.',
    input: obj({}),
    run: async app => {
      const d = await app.delivery();
      return { planned_date: d.planned ?? undefined, selected: d.selected, next: d.next, cut_off: d.cutOff, hours_left: d.hoursLeft, available: d.slots.map(s => ({ slot_id: s.id, start: s.windowStart, end: s.windowEnd, cut_off: s.cutOff })), error: d.error ?? undefined };
    },
  },
  {
    name: 'set_delivery', title: 'Bezorgdag kiezen',
    description: 'Kies de volgende bezorging, bijv. "we willen zaterdag geleverd krijgen" of "deze week overslaan, volgende bestelling dinsdag". Met slot_id (uit get_delivery_info) wordt dat moment ook in de Picnic-mand gezet; met alleen een dag plant Weekmand vanaf die dag en kiest het moment zodra Picnic het vrijgeeft. reset: weer het Picnic-moment volgen.',
    input: obj({ day, slot_id: str('Bezorgmoment-ID uit get_delivery_info.'), reset: { type: 'boolean' } }),
    run: async (app, a) => {
      if (a.reset) { app.clearDeliveryChoice(); return { message: 'Weekmand volgt weer het bezorgmoment uit Picnic.' }; }
      if (a.slot_id) return app.chooseDelivery({ slotId: a.slot_id });
      return app.chooseDelivery({ date: date(app, a.day) });
    },
  },
  {
    name: 'get_suggestions', title: 'Geleerde voorstellen', readOnly: true,
    description: 'Voorstellen die Weekmand uit je gedrag heeft geleerd (bijv. "Je schrapt vaak vis op donderdag, zal ik dat vermijden?").',
    input: obj({}),
    run: async app => ({ open: app.suggestions().map(s => ({ id: s.id, text: s.text })), active_rules: app.avoid.map(r => app.describeRule(r)) }),
  },
  {
    name: 'answer_suggestion', title: 'Voorstel beantwoorden', description: 'Accepteer of weiger een geleerd voorstel.',
    input: obj({ id: str('ID uit get_suggestions.'), accept: { type: 'boolean' } }, ['id', 'accept']),
    run: async (app, a) => ({ message: app.respondSuggestion(a.id, !!a.accept) }),
  },
  {
    name: 'set_household', title: 'Huishouden instellen',
    description: 'Pas het huishouden aan: volwassenen, kinderen (vanaf 2 jaar, 0,65 portie), dreumesen (0,35), budget in euro voor de hele mand, vegetarisch, uit te sluiten ingrediënten, avondmaaltijden per bestelling.',
    input: obj({
      adults: { type: 'integer' }, children: { type: 'integer' }, toddlers: { type: 'integer' }, budget: num('Euro.'),
      vegetarian: { type: 'boolean' }, exclude: { type: 'array', items: { type: 'string' } }, days: { type: 'integer', minimum: 1, maximum: 7 },
    }),
    run: async (app, a) => app.setHousehold(a),
  },
];

export const toolMap = new Map(tools.map(t => [t.name, t]));

/** Minimale controle van tool-invoer tegen het schema: verplichte velden, typen en enums. */
export function validateArgs(schema: any, value: unknown, path = 'invoer'): string | null {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} moet een object zijn.`;
    const v = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (v[key] === undefined || v[key] === null) return `${path}.${key} ontbreekt.`;
    for (const key of Object.keys(v)) {
      if (!schema.properties?.[key]) { if (schema.additionalProperties === false) delete v[key]; continue; }
      if (v[key] === undefined || v[key] === null) { delete v[key]; continue; }
      const error = validateArgs(schema.properties[key], v[key], `${path}.${key}`);
      if (error) return error;
    }
    return null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} moet een lijst zijn.`;
    if (schema.minItems && value.length < schema.minItems) return `${path} is te kort.`;
    if (schema.maxItems && value.length > schema.maxItems) return `${path} is te lang.`;
    for (let i = 0; i < value.length; i++) { const e = validateArgs(schema.items ?? {}, value[i], `${path}[${i}]`); if (e) return e; }
    return null;
  }
  if (schema.type === 'string' && typeof value !== 'string') return `${path} moet tekst zijn.`;
  if (schema.type === 'string' && (value as string).length > 2000) return `${path} is te lang.`;
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return `${path} moet een getal zijn.`;
  if (schema.type === 'integer' && !Number.isInteger(value)) return `${path} moet een geheel getal zijn.`;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return `${path} moet waar of onwaar zijn.`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} moet een van ${schema.enum.join(', ')} zijn.`;
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return `${path} valt buiten het bereik.`;
  return null;
}

export async function runTool(app: Weekmand, name: string, args: unknown, ctx: ToolContext) {
  const tool = toolMap.get(name);
  check(tool, 'Onbekende tool: ' + name, 404);
  const input = (args ?? {}) as Record<string, unknown>;
  const error = validateArgs(tool.input, input);
  check(!error, error!);
  return tool.run(app, input, ctx);
}
