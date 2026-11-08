import { converse, labelOf, modelOf, providers, testConnection, visionModels } from './ai.ts';
import type { AIConfig, ImageInput, Provider } from './ai.ts';
import type { AdaptedRecipe, ReceiptMatch, RecipeAdapter, Weekmand } from './app.ts';
import { budgetCategories, categoryKeys, kindKeys } from './budget.ts';
import type { BudgetCategory, ReceiptPhoto, SpendKind } from './budget.ts';
import { normalize } from './catalog.ts';
import { check, Problem } from './errors.ts';
import { portions } from './planner.ts';
import { clock, dayName, localDate, longDate } from './time.ts';
import { planSummary, runTool, tools } from './tools.ts';
import type { ToolContext } from './tools.ts';
import { euro } from './units.ts';

const system = `Je bent Weekmand, de boodschappenassistent van een Nederlands huishouden dat boodschappen doet bij Picnic.
Je praat via een chat op de telefoon: antwoord kort, vriendelijk en in het Nederlands, zonder opmaak met sterretjes of tabellen.

Werkwijze:
- Gebruik de tools voor alle feiten over menu, voorraad, mand en producten. Verzin geen producten, prijzen of hoeveelheden.
- "Vrijdag eten we met 6 man Mexicaans": zoek met find_recipes (tag mexicaans) en zet het gerecht met set_meal op vrijdag met servings 6. Bestaat er geen passend recept, geef dan zelf een recept mee aan set_meal (ingrediënten per persoon).
- Na een wijziging aan het menu of als de gebruiker iets wil toevoegen of weghalen: roep add_to_cart (of remove_from_cart) aan. Dat berekent alleen het verschil met de mand.
- De gebruiker keurt mandwijzigingen goed met de knop "Naar Picnic sturen" onder jouw antwoord (alleen de verschillen gaan naar Picnic; wat de gebruiker zelf in Picnic zette blijft staan). Noem kort de belangrijkste wijzigingen en het nieuwe totaal, en zeg dat ze op de knop kunnen drukken.
- Zeg alleen dat iets is toegevoegd of weggehaald als add_to_cart, remove_from_cart of link_product dat in deze beurt teruggaf. Noem dan de wijzigingen en het totaal uit die uitkomst (changes, cart_total_after), nooit uit je geheugen of een eerder bericht.
- missing_products betekent: voor dat ingrediënt is nog geen product, dus het komt niet in de mand. Zoek met search_products en koppel met link_product. Kiest de gebruiker een product uit een lijst die jij liet zien, gebruik dan precies het product_id uit search_products, ook bij add_to_cart. Zeg nooit dat een product niet bestaat als search_products het vond.
- Wat jij eerder in dit gesprek zei over producten of de mand kan fout of verouderd zijn. Controleer het met de tools voordat je het herhaalt. Zeg nooit dat een product niet bestaat zonder in deze beurt search_products te hebben gebruikt, met een korte zoekterm zonder maat ("kippenpoten", niet "kippenpoten 650 gram").
- Wil de gebruiker een gerecht op het menu veranderen ("vervang het recept door één met kippenpoten", "zonder paprika"), gebruik dan adapt_meal met die opmerking en daarna add_to_cart. Bedenk het recept niet zelf met set_meal.
- Vraagt de gebruiker om een product "voor" een recept of ingrediënt (bijv. "voeg kippenpoten toe voor het kiprecept"), en staat dat ingrediënt bij de ingrediënten zonder product: zoek het product en koppel het met link_product aan dat ingrediënt, niet met add_to_cart.
- Haal niets van de lijst of uit de mand dat iemand anders in het huishouden heeft toegevoegd (de lijst wordt gedeeld, ook via Telegram), tenzij de gebruiker daar zelf om vraagt.
- Je kunt niet bestellen of betalen; dat doet de gebruiker in de Picnic-app. Zelf iets naar Picnic sturen kun je ook niet; daarvoor is de knop.
- Vraag kort door als iets echt onduidelijk is (welke dag, hoeveel personen).`;

export type ChatResult = { reply: string; reviewId?: string; ai: boolean };
/** Getypte goedkeuring ("naar picnic sturen", "stuur maar", "verstuur"), na normalize(). */
const sendPhrase = /^(ja |ok |oke |prima )?(naar picnic( sturen| versturen)?|(stuur|verstuur)( het| alles| de mand| de wijzigingen)?( maar)?( door| naar picnic)?|doorvoeren|mand (versturen|doorvoeren))$/;

export class Assistant {
  #app: Weekmand;
  #session: AIConfig | null = null;

  constructor(app: Weekmand) { this.#app = app; }

  /** Actieve koppeling: in deze sessie ingesteld, opgeslagen, of uit de serverconfiguratie. */
  config(): { config: AIConfig; source: 'sessie' | 'opgeslagen' | 'server' } | null {
    if (this.#session) return { config: this.#session, source: 'sessie' };
    const saved = this.#app.secrets.get('ai');
    if (saved && saved.provider in providers) return { config: saved as AIConfig, source: 'opgeslagen' };
    const provider = (process.env.AI_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : '')) as Provider;
    const key = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '';
    if (provider && provider in providers && (key || provider === 'local')) {
      return { config: { provider, key, model: process.env.AI_MODEL || process.env.OPENAI_MODEL || undefined, baseUrl: process.env.AI_BASE_URL || undefined }, source: 'server' };
    }
    return null;
  }

  status() {
    const active = this.config();
    return active ? { provider: active.config.provider, label: labelOf(active.config), model: modelOf(active.config), source: active.source } : null;
  }

  async connect(input: { provider: string; key?: string; model?: string; baseUrl?: string; remember?: boolean }) {
    check(typeof input.provider === 'string' && input.provider in providers, 'Kies een bekende AI-aanbieder.');
    const provider = input.provider as Provider;
    const key = (input.key ?? '').trim();
    check(provider === 'local' || /^[!-~]{8,2048}$/.test(key), 'Vul een geldige API-sleutel in.');
    const model = (input.model ?? '').trim();
    check(!model || /^[a-z0-9._:/-]{1,128}$/i.test(model), 'Vul een geldig model-ID in of laat het veld leeg.');
    const baseUrl = (input.baseUrl ?? '').trim();
    if (provider === 'local') check(/^https?:\/\/[^\s]{3,200}$/.test(baseUrl), 'Vul het adres van je lokale model in, bijv. http://192.168.1.20:11434/v1.');
    const config: AIConfig = { provider, key, ...(model ? { model } : {}), ...(baseUrl ? { baseUrl } : {}) };
    await testConnection(config);
    this.#session = config;
    this.#app.secrets.set('ai', input.remember ? config : undefined);
    return this.status();
  }

  disconnect() {
    this.#session = null;
    this.#app.secrets.set('ai', undefined);
  }

  /**
   * Afgekorte regels van een AH-kassabon ('TOMAATBLOKJE', 'KL KEUKEN') koppelen aan ingrediënten.
   * Eén aanroep; het model antwoordt via één tool, zodat de uitkomst gestructureerd is.
   * Naar de AI gaan alleen de bonregels en de namen van de ingrediënten.
   */
  async matchReceiptLines(lines: string[], ingredients: { key: string; name: string; unit: string }[]): Promise<ReceiptMatch[] | null> {
    const active = this.config();
    if (!active) return null;
    let answers: ReceiptMatch[] = [];
    const kinds: Record<string, ReceiptMatch['kind']> = { bestaand: 'existing', nieuw: 'new', 'geen-boodschap': 'ignore', onbekend: 'unknown' };
    await converse(active.config, {
      system: `Je koppelt regels van Albert Heijn-kassabonnen aan ingrediënten van een boodschappenapp. Bonregels zijn afgekort en in hoofdletters: "TOMAATBLOKJE" = tomatenblokjes, "TIJGER WIT" = wit tijgerbrood, "AH GEMALEN" = gemalen koffie, "KL KEUKEN" = keukenrol.
Per regel:
- bestaand: het ingrediënt staat in de lijst; geef de sleutel.
- nieuw: eten of drinken dat niet in de lijst staat; geef een korte Nederlandse naam, eenheid en categorie.
- geen-boodschap: geen eten of drinken (keukenrol, vuilniszakken, cadeaus) en niet in de lijst.
- onbekend: je weet echt niet wat het is.
Geef bij per_stuk de inhoud van één stuk in de eenheid van het ingrediënt als je die redelijk weet (blik tomatenblokjes 400 g, pak melk 1000 ml, brood 800 g). Roep koppel_bonregels precies één keer aan met alle regels.`,
      context: 'Ingrediënten (sleutel: naam, eenheid):\n' + ingredients.map(i => `${i.key}: ${i.name} (${i.unit})`).join('\n'),
      history: [],
      message: 'Bonregels:\n' + lines.map(l => '- ' + l).join('\n'),
      tools: [{
        name: 'koppel_bonregels', description: 'Sla de koppeling van alle bonregels op.',
        input: {
          type: 'object', required: ['regels'], additionalProperties: false,
          properties: {
            regels: {
              type: 'array',
              items: {
                type: 'object', required: ['bon', 'soort'], additionalProperties: false,
                properties: {
                  bon: { type: 'string', description: 'De bonregel precies zoals gegeven.' },
                  soort: { type: 'string', enum: Object.keys(kinds) },
                  sleutel: { type: 'string', description: 'Bij bestaand: de sleutel uit de lijst.' },
                  naam: { type: 'string', description: 'Bij nieuw: korte naam, bijv. "Tijgerbrood".' },
                  eenheid: { type: 'string', enum: ['g', 'ml', 'st'] },
                  categorie: { type: 'string', enum: ['groente-fruit', 'aardappel', 'vlees', 'vis', 'vega', 'zuivel-eieren', 'kaas', 'brood', 'pasta-rijst', 'conserven', 'kruiden-sauzen', 'olie-azijn', 'bakken', 'diepvries', 'drinken', 'ontbijt', 'snacks', 'huishouden'] },
                  per_stuk: { type: 'number', description: 'Inhoud van één stuk in de eenheid van het ingrediënt.' },
                },
              },
            },
          },
        },
      }],
      run: async call => {
        if (call.name !== 'koppel_bonregels') return { content: 'Onbekende tool.', isError: true };
        const rows = (call.input as { regels?: unknown })?.regels;
        answers = (Array.isArray(rows) ? rows : []).flatMap((r: any) => r && typeof r.bon === 'string' && kinds[r.soort] ? [{
          receipt: r.bon, kind: kinds[r.soort], key: r.sleutel, name: r.naam, unit: r.eenheid ?? ingredients.find(i => i.key === r.sleutel)?.unit, category: r.categorie, amount: r.per_stuk,
        }] : []);
        return { content: 'Opgeslagen.', isError: false };
      },
      maxSteps: 2,
    });
    return answers;
  }

  /**
   * Producten indelen voor het budget: categorie en of het nodig is of een extraatje.
   * Alleen productnamen gaan naar de AI. null: er is geen AI gekoppeld.
   */
  async classifyProducts(names: string[]): Promise<{ name: string; category: BudgetCategory; kind: SpendKind }[] | null> {
    const active = this.config();
    if (!active) return null;
    let answers: { name: string; category: BudgetCategory; kind: SpendKind }[] = [];
    await converse(active.config, {
      system: `Je deelt boodschappen in voor het huishoudbudget van een Nederlands gezin. De namen komen van Picnic of van Albert Heijn-kassabonnen (afgekort, hoofdletters: "TOMAATBLOKJE" = tomatenblokjes, "KL KEUKEN" = keukenrol).
Per product een categorie en een soort:
- nodig: gewone boodschappen voor maaltijden, ontbijt en lunch, ook koffie, thee, melk, water en fruit.
- extra: wat je niet nodig hebt maar lekker is: snoep, chips, koek, gebak, ijs, frisdrank, energydrank, alcohol, luxe tussendoortjes en traktaties.
- geen-eten: huishouden, schoonmaak, verzorging, baby, huisdier, cadeaus.
Twijfel je tussen nodig en extra, kies dan nodig. Roep deel_in precies één keer aan met alle producten.`,
      context: 'Categorieën: ' + budgetCategories.map(c => `${c.key} (${c.label})`).join(', '),
      history: [],
      message: 'Producten:\n' + names.map(n => '- ' + n).join('\n'),
      tools: [{
        name: 'deel_in', description: 'Sla de indeling van alle producten op.',
        input: {
          type: 'object', required: ['producten'], additionalProperties: false,
          properties: {
            producten: {
              type: 'array',
              items: {
                type: 'object', required: ['naam', 'categorie', 'soort'], additionalProperties: false,
                properties: {
                  naam: { type: 'string', description: 'De productnaam precies zoals gegeven.' },
                  categorie: { type: 'string', enum: categoryKeys },
                  soort: { type: 'string', enum: kindKeys },
                },
              },
            },
          },
        },
      }],
      run: async call => {
        if (call.name !== 'deel_in') return { content: 'Onbekende tool.', isError: true };
        const rows = (call.input as { producten?: unknown })?.producten;
        answers = (Array.isArray(rows) ? rows : []).flatMap((r: any) => r && typeof r.naam === 'string' && categoryKeys.includes(r.categorie) && kindKeys.includes(r.soort)
          ? [{ name: r.naam, category: r.categorie, kind: r.soort }] : []);
        return { content: 'Opgeslagen.', isError: false };
      },
      maxSteps: 2,
      maxTokens: 4000,
    });
    return answers;
  }

  /**
   * Een foto van een kassabon lezen: winkel, datum, totaal, productregels (met categorie en of het
   * nodig of extra is) en kortingen. Alleen de foto gaat naar de AI. null: er is geen AI gekoppeld.
   */
  async readReceiptPhoto(image: ImageInput, today: string): Promise<ReceiptPhoto | null> {
    const active = this.config();
    if (!active) return null;
    const config = active.config;
    check(config.provider in visionModels, `${labelOf(config)} kan geen foto's lezen. Kies onder Meer → AI-aanbieder Claude, OpenAI of Mistral.`, 422);
    let found = null as ReceiptPhoto | null;
    const input = (model?: string) => ({
      system: `Je leest een foto van een Nederlandse kassabon voor het huishoudbudget. Neem de productregels over zoals ze op de bon staan, met aantal en het regelbedrag in euro (wat er voor die regel betaald moest worden, vóór kortingen onderaan). Kortingen, bonus en zegels onderaan zijn aparte regels met een negatief bedrag. Statiegeld is een gewone regel. Sla bonuskaart- en airmilesnummers, btw, betaalregels en wisselgeld over. Het totaal is wat er betaald is. Per product: een categorie, en of het nodig is (gewone boodschappen), extra (snoep, chips, koek, gebak, ijs, frisdrank, alcohol) of geen eten (schoonmaak, verzorging, cadeaus). Staat er geen jaar bij de datum, neem dan het jaar van vandaag. Is de foto onleesbaar of geen kassabon, roep lees_bon dan aan met een lege lijst regels. Roep lees_bon precies één keer aan.`,
      context: `Vandaag is het ${today}. Categorieën: ` + budgetCategories.map(c => `${c.key} (${c.label})`).join(', '),
      history: [], message: 'Lees deze kassabon.', images: [image], maxSteps: 2, maxTokens: 6000, ...(model ? { model } : {}),
      tools: [{
        name: 'lees_bon', description: 'Sla de gelezen kassabon op.',
        input: {
          type: 'object', required: ['winkel', 'datum', 'totaal', 'regels'], additionalProperties: false,
          properties: {
            winkel: { type: 'string', description: 'Naam van de winkel, bijv. "Lidl" of "Albert Heijn".' },
            datum: { type: 'string', description: 'Datum van de bon als JJJJ-MM-DD.' },
            totaal: { type: 'number', description: 'Betaald totaal in euro.' },
            regels: {
              type: 'array',
              items: {
                type: 'object', required: ['naam', 'aantal', 'bedrag'], additionalProperties: false,
                properties: {
                  naam: { type: 'string' }, aantal: { type: 'number' },
                  bedrag: { type: 'number', description: 'Regelbedrag in euro.' },
                  categorie: { type: 'string', enum: categoryKeys }, soort: { type: 'string', enum: kindKeys },
                },
              },
            },
            kortingen: {
              type: 'array',
              items: { type: 'object', required: ['naam', 'bedrag'], additionalProperties: false, properties: { naam: { type: 'string' }, bedrag: { type: 'number', description: 'Negatief bedrag in euro.' } } },
            },
          },
        },
      }],
      run: async (call: { name: string; input: unknown }) => {
        if (call.name !== 'lees_bon') return { content: 'Onbekende tool.', isError: true };
        const r = call.input as any;
        const cents = (v: unknown) => Math.round(Number(v) * 100);
        found = {
          shop: String(r?.winkel ?? '').trim().slice(0, 60),
          date: String(r?.datum ?? ''),
          totalCents: Number.isFinite(Number(r?.totaal)) ? cents(r.totaal) : 0,
          lines: (Array.isArray(r?.regels) ? r.regels : []).flatMap((l: any) => l && typeof l.naam === 'string' && Number.isFinite(Number(l.bedrag)) ? [{
            name: l.naam.trim().slice(0, 80), quantity: Number(l.aantal) > 0 ? Number(l.aantal) : 1, cents: cents(l.bedrag),
            ...(categoryKeys.includes(l.categorie) ? { category: l.categorie } : {}), ...(kindKeys.includes(l.soort) ? { kind: l.soort } : {}),
          }] : []).slice(0, 200),
          discounts: (Array.isArray(r?.kortingen) ? r.kortingen : []).flatMap((k: any) => k && typeof k.naam === 'string' && Number(k.bedrag) ? [{ name: k.naam.trim().slice(0, 80), cents: -Math.abs(cents(k.bedrag)) }] : []).slice(0, 50),
        };
        return { content: 'Opgeslagen.', isError: false };
      },
    });
    try {
      await converse(config, input());
    } catch (error) {
      // Kan het gekozen model geen foto's lezen, dan het fotomodel van dezelfde aanbieder.
      const fallback = visionModels[config.provider];
      if (!(error instanceof Problem) || error.status !== 422 || !fallback || fallback === modelOf(config)) throw error;
      await converse(config, input(fallback));
    }
    return found;
  }

  /**
   * Een recept aanpassen volgens een opmerking van het huishouden. Behoudt wat de opmerking niet
   * noemt. null: er is geen AI gekoppeld.
   */
  async adaptRecipe(recipe: Parameters<RecipeAdapter>[0], note: string): Promise<AdaptedRecipe | null> {
    const active = this.config();
    if (!active) return null;
    let result = null as AdaptedRecipe | null;
    await converse(active.config, {
      system: `Je past een recept aan voor een Nederlands huishouden. Volg de opmerking van de gebruiker. Gaat de opmerking over een onderdeel ("met kippenpoten in plaats van kippenbouten", "zonder paprika", "pittiger"), houd dan de rest van het recept gelijk en pas naam, ingrediënten en bereiding daarop aan. Is de opmerking een wens voor iets anders ("iets vegetarisch", "iets snels"), maak dan een passend nieuw gerecht. Hoeveelheden per portie (1 persoon). Gebruik gewone ingrediëntnamen zoals in de supermarkt (kippenpoten, tijm, aardappelen), zonder bijvoeglijke naamwoorden als "groot" of "vers". Eenheden: g, ml, st, el of tl. Geef bij elk ingrediënt een categorie. Roep nieuw_recept precies één keer aan.`,
      context: 'Huidig recept: ' + JSON.stringify(recipe),
      history: [],
      message: 'Opmerking: ' + note,
      tools: [{
        name: 'nieuw_recept', description: 'Sla het aangepaste recept op.',
        input: {
          type: 'object', required: ['naam', 'ingredienten'], additionalProperties: false,
          properties: {
            naam: { type: 'string' }, minuten: { type: 'integer' }, bereiding: { type: 'string', description: 'Korte bereiding in stappen.' },
            tags: { type: 'array', items: { type: 'string' } },
            ingredienten: {
              type: 'array', minItems: 1, maxItems: 30,
              items: {
                type: 'object', required: ['naam', 'hoeveelheid', 'eenheid'], additionalProperties: false,
                properties: {
                  naam: { type: 'string' }, hoeveelheid: { type: 'number', description: 'Per portie.' }, eenheid: { type: 'string', enum: ['g', 'ml', 'st', 'el', 'tl'] },
                  categorie: { type: 'string', enum: ['groente-fruit', 'aardappel', 'vlees', 'vis', 'vega', 'zuivel-eieren', 'kaas', 'brood', 'pasta-rijst', 'conserven', 'kruiden-sauzen', 'olie-azijn', 'bakken', 'diepvries', 'drinken', 'ontbijt', 'snacks', 'huishouden'] },
                },
              },
            },
          },
        },
      }],
      run: async call => {
        if (call.name !== 'nieuw_recept') return { content: 'Onbekende tool.', isError: true };
        const r = call.input as any;
        const ingredients = (Array.isArray(r?.ingredienten) ? r.ingredienten : []).flatMap((i: any) => i && typeof i.naam === 'string' && Number(i.hoeveelheid) > 0
          ? [{ name: i.naam.trim(), amount: Number(i.hoeveelheid), unit: String(i.eenheid ?? 'st'), ...(i.categorie ? { category: String(i.categorie) } : {}) }] : []);
        if (typeof r?.naam !== 'string' || !r.naam.trim() || !ingredients.length) return { content: 'Geef een naam en minstens één ingrediënt.', isError: true };
        result = { name: r.naam.trim().slice(0, 80), minutes: Number(r.minuten) || recipe.minutes, steps: String(r.bereiding ?? '').slice(0, 1500), tags: Array.isArray(r.tags) ? r.tags.map(String).slice(0, 8) : recipe.tags, ingredients };
        return { content: 'Opgeslagen.', isError: false };
      },
      maxSteps: 3,
      maxTokens: 3000,
    });
    return result;
  }

  /** Verwerk een chatbericht: met een taalmodel als dat gekoppeld is, anders met vaste commando's. */
  async chat(channel: string, message: string, kind: ToolContext['channel'] = 'chat'): Promise<ChatResult> {
    check(typeof message === 'string' && message.trim() && message.length <= 2000, 'Typ een bericht (maximaal 2000 tekens).');
    const text = message.trim();
    const active = this.config();
    let reviewId: string | undefined;
    const ctx: ToolContext = { channel: kind, pendingReview: id => { reviewId = id; } };
    let reply: string;
    if (sendPhrase.test(normalize(text))) {
      // "Naar Picnic sturen" getypt: niet aan een taalmodel geven, maar tonen wat er echt klaarstaat, met de knop.
      reply = await this.#readyToSend(ctx);
    } else if (!active) {
      reply = await this.#commands(text, ctx);
    } else {
      const app = this.#app;
      const history = app.store.chat(channel, 10).map(t => ({ role: t.role, content: t.content }));
      reply = await converse(active.config, {
        system, context: await this.#context(), history, message: text,
        tools: tools.filter(t => !t.needsHostApproval).map(t => ({ name: t.name, description: t.description, input: t.input })),
        run: async call => {
          try {
            const result = await runTool(app, call.name, call.input, ctx);
            console.log(`Chat-tool ${call.name}: ok`);
            return { content: JSON.stringify(result), isError: false };
          } catch (error) {
            console.log(`Chat-tool ${call.name}: ${error instanceof Problem ? error.message : 'fout'}`);
            if (!(error instanceof Problem)) console.error('Tool', call.name, error);
            return { content: error instanceof Problem ? error.message : 'De bewerking is mislukt.', isError: true };
          }
        },
      });
      // Belooft het antwoord de knop zonder dat er in deze beurt iets berekend is: de echte stand erbij, met de knop.
      if (!reviewId && /naar picnic sturen/i.test(reply)) {
        const ready = await this.#readyToSend(ctx).catch(() => null);
        if (ready && reviewId) reply += '\n\n' + ready;
      }
    }
    this.#app.store.addChat(channel, 'user', text);
    this.#app.store.addChat(channel, 'assistant', reply);
    return { reply, ai: !!active, ...(reviewId ? { reviewId } : {}) };
  }

  /** Wat er nu echt naar Picnic zou gaan (berekend door Weekmand, niet door een taalmodel). */
  async #readyToSend(ctx: ToolContext) {
    const app = this.#app;
    if (!app.shop.ready()) return 'Weekmand is niet aangemeld bij Picnic; meld je aan onder Meer.';
    const plan = await app.currentPlan();
    const changes = plan.lines.filter(l => l.add || l.remove);
    const missing = plan.missing.map(m => m.name);
    const note = missing.length ? `\nLet op: voor ${missing.join(', ')} is nog geen product gekoppeld, dus dat komt niet mee. Noem een product of koppel er een in de app (Mand).` : '';
    if (!changes.length) return 'Er staat niets klaar om te sturen: je Picnic-mand is al compleet.' + note;
    ctx.pendingReview?.(plan.id);
    return 'Dit gaat naar Picnic:\n' + changes.map(l => `${l.add ? '+' + l.add : '−' + l.remove} ${l.product}`).join('\n')
      + `\nTotaal daarna: ${euro(plan.totalCents)}.` + note + '\nDruk op "Naar Picnic sturen" om het door te voeren.';
  }

  async #context() {
    const app = this.#app;
    const h = app.household;
    const delivery = await app.delivery().catch(() => null);
    const next = delivery?.next;
    return [
      `Vandaag is het ${longDate(app.now())} (${localDate(app.now())}).`,
      `Huishouden: ${h.adults} volwassenen, ${h.children} kinderen, ${h.toddlers} dreumesen (${portions(h)} porties per maaltijd), budget ${euro(h.budget * 100)} per bestelling${h.vegetarian ? ', vegetarisch' : ''}.`,
      `Winkel: ${app.shop.label}${app.shop.ready() ? '' : ' (niet aangemeld)'}.`,
      next ? `Volgende bezorging: ${longDate(next.windowStart)} ${clock(next.windowStart)}; wijzigen kan tot ${longDate(next.cutOff)} ${clock(next.cutOff)}.` : 'Geen bezorgmoment bekend.',
      ...this.#missingNote(),
    ].join('\n');
  }

  /** Feiten uit de laatste mandberekening, zodat het taalmodel niet op zijn eigen eerdere berichten leunt. */
  #missingNote() {
    const review = this.#app.store.get<{ plan?: { missing?: { name: string }[] } } | null>('review', null);
    const missing = review?.plan?.missing?.map(m => m.name) ?? [];
    return missing.length ? [`Ingrediënten van het menu zonder product (die komen nu NIET in de mand): ${missing.join(', ')}. Zoek een product met search_products (korte zoekterm zonder maat) en koppel het met link_product.`] : [];
  }

  /** Vaste Nederlandse commando's voor als er geen taalmodel is gekoppeld. */
  async #commands(text: string, ctx: ToolContext): Promise<string> {
    const app = this.#app;
    // Splits alleen tussen losse opdrachten ('voeg … toe en haal … eruit'), niet binnen een wens met komma's.
    const parts = text.replace(/[.!?]+$/, '').split(/\s*(?:;|(?:,|\ben)\s+(?=(?:haal|verwijder|voeg|zet|doe|schrap)\b))\s*/i).filter(Boolean);
    const replies: string[] = [];
    let changedList = false;
    for (const part of parts) {
      const t = normalize(part);
      let m: RegExpExecArray | null;
      if (/^(hulp|help|\?|wat kun je)/.test(t)) {
        replies.push(helpText);
      } else if (/(menu|wat eten we|wat staat er)/.test(t) && /(stel|maak|nieuw)/.test(t)) {
        const wish = t.replace(/.*menu\s*/, '');
        await app.proposeMenu({ wish });
        replies.push(formatMenu(await app.menu()));
      } else if (/(menu|wat eten we|wat staat er)/.test(t)) {
        replies.push(formatMenu(await app.menu()));
      } else if ((m = /^(?:voeg|doe|zet)\s+(.+?)\s+(?:toe|erbij|in de mand|op de lijst)$/.exec(t)) || (m = /^(?:extra|ook)\s+(.+)$/.exec(t))) {
        const items = m[1].split(/\s+en\s+/).map(s => parseItem(s));
        replies.push('Op de lijst: ' + (await app.addItems(items)).join(', ') + '.');
        changedList = true;
      } else if ((m = /^(?:haal|verwijder|schrap)\s+(?:de |het )?(.+?)(?:\s+(?:eruit|weg|eraf|van de lijst))?$/.exec(t))) {
        replies.push(...(await app.removeItems(m[1].split(/\s+en\s+(?:de |het )?/))));
        changedList = true;
      } else if ((m = /^(?:de |het )?(.+?) (?:is |zijn )?op$/.exec(t)) || (m = /^op:?\s+(.+)$/.exec(t))) {
        const result = app.markOut(m[1]);
        replies.push(`Genoteerd: ${result.name} is op.`);
      } else if (/(voorraad|bijna op)/.test(t)) {
        const p = await app.pantryStatus();
        replies.push(p.low.length ? 'Bijna of helemaal op: ' + p.low.map(l => `${l.name} (${l.status})`).join(', ') + '.' : 'Er is niets als (bijna) op gemeld.');
      } else if (/(mand|boodschappen|bestelling)/.test(t)) {
        changedList = true;
      } else {
        replies.push('Dat begrijp ik niet zonder gekoppeld taalmodel. ' + helpText);
      }
    }
    if (changedList) {
      const plan = await app.plan();
      if (plan.lines.some(l => l.add || l.remove)) ctx.pendingReview?.(plan.id);
      replies.push(formatPlan(planSummary(plan)));
    }
    return replies.join('\n\n');
  }
}

const helpText = 'Zonder AI-koppeling begrijp ik: "menu", "stel een menu voor (wens)", "mand", "voorraad", "melk is op", "voeg een krat pils toe", "haal de kipfilet eruit".';

function parseItem(text: string) {
  const m = /^(\d+(?:[.,]\d+)?)\s*(g|gram|kg|kilo|ml|l|liter|st|stuks?)?\s+(.+)$/.exec(text.trim());
  if (m && m[2]) return { name: m[3], amount: Number(m[1].replace(',', '.')), unit: m[2] };
  if (m) return { name: m[3], quantity: Math.max(1, Math.round(Number(m[1]))) };
  return { name: text.replace(/^(een|1)\s+/, '') };
}

export function formatMenu(menu: Awaited<ReturnType<Weekmand['menu']>>) {
  const lines = menu.days.map(d => `${d.day.slice(0, 2)} ${d.date.slice(8)}-${d.date.slice(5, 7)}: ${d.meal ? `${d.meal.name}${d.meal.servings !== undefined ? ` (${d.meal.servings} p.)` : ''}${d.meal.status === 'proposed' ? ' · voorstel' : ''}` : '—'}`);
  return 'Menu:\n' + lines.join('\n');
}

export function formatPlan(s: ReturnType<typeof planSummary>) {
  if (!s.changes.length) return `De mand is compleet voor ${s.window}. Totaal ${s.cart_total_after} (budget ${s.budget}).` +
    (s.missing_products.length ? '\nNog niet gekoppeld: ' + s.missing_products.join('; ') : '');
  const lines = s.changes.slice(0, 25).map(c => `${'add' in c ? '+' + c.add : '−' + c.remove} ${c.product} (${c.price})`);
  return [
    `Wijzigingen voor ${s.window}:`, ...lines,
    ...(s.changes.length > 25 ? [`… en nog ${s.changes.length - 25} regels`] : []),
    `Mand daarna: ${s.cart_total_after} (budget ${s.budget})${s.over_budget ? ' — boven budget' : ''}.`,
    ...(s.stock_questions.length ? ['Klopt dit nog? ' + s.stock_questions.join(' ')] : []),
    ...(s.missing_products.length ? ['Niet gevonden: ' + s.missing_products.join('; ')] : []),
  ].join('\n');
}

export { dayName };
