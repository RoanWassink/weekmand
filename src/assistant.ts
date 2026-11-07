import { converse, labelOf, modelOf, providers, testConnection } from './ai.ts';
import type { AIConfig, Provider } from './ai.ts';
import type { Weekmand } from './app.ts';
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
- Je kunt niet bestellen of betalen; dat doet de gebruiker in de Picnic-app.
- Vraag kort door als iets echt onduidelijk is (welke dag, hoeveel personen).`;

export type ChatResult = { reply: string; reviewId?: string; ai: boolean };

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

  /** Verwerk een chatbericht: met een taalmodel als dat gekoppeld is, anders met vaste commando's. */
  async chat(channel: string, message: string, kind: ToolContext['channel'] = 'chat'): Promise<ChatResult> {
    check(typeof message === 'string' && message.trim() && message.length <= 2000, 'Typ een bericht (maximaal 2000 tekens).');
    const text = message.trim();
    const active = this.config();
    let reviewId: string | undefined;
    const ctx: ToolContext = { channel: kind, pendingReview: id => { reviewId = id; } };
    let reply: string;
    if (!active) {
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
            return { content: JSON.stringify(result), isError: false };
          } catch (error) {
            if (!(error instanceof Problem)) console.error('Tool', call.name, error);
            return { content: error instanceof Problem ? error.message : 'De bewerking is mislukt.', isError: true };
          }
        },
      });
    }
    this.#app.store.addChat(channel, 'user', text);
    this.#app.store.addChat(channel, 'assistant', reply);
    return { reply, ai: !!active, ...(reviewId ? { reviewId } : {}) };
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
    ].join('\n');
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
