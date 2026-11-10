import { createHash, randomBytes } from 'node:crypto';
import { loginCode } from './ah.ts';
import { check, Problem } from './errors.ts';
import type { Secrets } from './secrets.ts';
import { localDate } from './time.ts';

/**
 * Lidl Plus: alleen de kassabonnen van het eigen Lidl Plus-account lezen, voor het budget en de
 * voorraad. Geen coupons, geen aanbiedingen, geen profiel (besluit 10-11-2026).
 *
 * Lidl heeft geen openbare API. Dit is de API van de Lidl Plus-app, zoals open-source projecten
 * die beschrijven (o.a. Andre0512/lidl-plus en erwindamsma/lidl-receipts-analyser). Inloggen doet
 * de gebruiker zelf in de browser (inclusief captcha en sms-code); Weekmand krijgt alleen de
 * eenmalige code terug en wisselt die met PKCE in. De bonnen-API wil de app-kenmerken (App,
 * App-Version, Operating-System); de User-Agent blijft eerlijk. Weinig verzoeken, en na een
 * weigering (403/429) twaalf uur wachten.
 */

const AUTH = 'https://accounts.lidl.com';
const TICKETS = 'https://tickets.lidlplus.com/api';
const CLIENT = 'LidlPlusNativeClient';
/** Openbare waarde uit de app; geen geheim van de gebruiker. */
const BASIC = 'Basic ' + Buffer.from(CLIENT + ':secret').toString('base64');
const REDIRECT = 'com.lidlplus.app://callback';
const SCOPES = 'openid profile offline_access lpprofile lpapis';
const COUNTRY = 'NL';
const LANGUAGE = 'nl';
/** Lidl weigert onwaarschijnlijke app-versies. Weigert Lidl deze ooit, zet dan LIDL_APP_VERSION. */
export const LIDL_APP_VERSION = process.env.LIDL_APP_VERSION?.trim() || '16.45.5';
const UA = 'Weekmand/2.0 (boodschappenassistent)';

export type LidlLink = { accessToken: string; refreshToken: string; expiresAt: number; linkedAt: string };
export type LidlTicket = { id: string; date: string; totalCents: number | null };
/** Eén artikel op de bon. Kortingen (negatief) horen bij het artikel erboven; weight: gewogen (quantity in kg). */
export type LidlLine = { name: string; quantity: number; cents: number; weight?: boolean; discounts: { name: string; cents: number }[] };

// ───────────── Bonnen lezen (los te testen) ─────────────

/** "1,10", "-20,00", "1.10", 18.97 of "54,31 €" → centen. */
export function lidlCents(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  const t = String(value ?? '').replace(/€|eur/gi, '').replace(/\s/g, '');
  const m = /^(-?)(\d[\d.,]*?)(?:[.,](\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const whole = Number(m[2].replace(/[.,]/g, ''));
  const cents = m[3] ? Number(m[3].padEnd(2, '0')) : 0;
  return Number.isFinite(whole) ? (m[1] ? -1 : 1) * (whole * 100 + cents) : null;
}

/** "0,792" → 0.792; "2" → 2. */
function quantity(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(text: string) {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === '#') { const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(code) ? String.fromCodePoint(code) : all; }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** Een bedrag aan het eind van de regel, met de btw-letter erachter: "Bananen   1,10 B". */
const AMOUNT = /(-?\d[\d.,]*[.,]\d{2})\s*([A-Z])?\s*$/;

/** Non-food staat op de bon als "Bandschuurmachine-0502092"; het artikelnummer eraf. */
function cleanName(name: string, artId: string) {
  const n = name.trim();
  return artId && n.endsWith('-' + artId) ? n.slice(0, -artId.length - 1).trim() : n;
}

/**
 * De geprinte bon (htmlPrintedReceipt) die Nederlandse bonnen hebben in plaats van losse regels.
 * Elke regel van de bon zit in één of meer spans met id "purchase_list_line_N"; artikelen hebben
 * data-art-id, data-art-quantity en data-art-description. Een regel zonder bedrag met hetzelfde
 * artikel ("0,792 kg x 1,39 EUR/kg") hoort bij het artikel erboven. Een bedragregel zonder artikel
 * is een korting op het artikel erboven ("Lidl Plus korting", "In prijs verlaagd"), behalve als hij
 * een eigen opmaak heeft: dan is het een losse regel, zoals ingeleverd statiegeld ("[X] Emballage").
 */
export function parseReceiptHtml(html: string): LidlLine[] {
  const rows = new Map<number, { text: string; classes: Set<string>; attrs: Record<string, string> }>();
  const stack: (number | null)[] = [];
  for (const m of String(html ?? '').matchAll(/<(\/)?span\b([^>]*)>|<[^>]*>|[^<]+/gi)) {
    const token = m[0];
    if (token[0] !== '<') {
      const top = stack.at(-1);
      if (top !== undefined && top !== null) rows.get(top)!.text += decode(token);
      continue;
    }
    if (!/^<\/?span\b/i.test(token)) continue;
    if (m[1]) { stack.pop(); continue; }
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? '').matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1].toLowerCase()] = decode(a[2]);
    const n = /^purchase_list_line_(\d+)$/.exec(attrs.id ?? '');
    if (token.endsWith('/>')) continue;
    if (!n) { stack.push(null); continue; }
    const number = Number(n[1]);
    const row = rows.get(number) ?? { text: '', classes: new Set<string>(), attrs: {} };
    for (const c of (attrs.class ?? '').split(/\s+/)) if (c) row.classes.add(c);
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) row.attrs[k] = v;
    rows.set(number, row);
    stack.push(number);
  }

  const out: LidlLine[] = [];
  let current: LidlLine | null = null;
  for (const number of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(number)!;
    const text = row.text.replace(/\s+$/, '');
    if (!text.trim() || row.classes.has('currency')) continue;
    const amount = AMOUNT.exec(text);
    const artId = row.attrs['data-art-id'] ?? '';
    if (artId) {
      if (!amount) {
        if (current && /\bkg\b/i.test(text)) current.weight = true;
        continue;
      }
      const q = row.attrs['data-art-quantity'];
      current = {
        name: cleanName(row.attrs['data-art-description'] || text.slice(0, amount.index), artId),
        quantity: quantity(q ?? '1'), cents: lidlCents(amount[1]) ?? 0, discounts: [],
        ...(q && /[.,]/.test(q) ? { weight: true } : {}),
      };
      out.push(current);
      continue;
    }
    if (!amount) continue;
    const description = text.slice(0, amount.index).trim();
    const cents = lidlCents(amount[1]) ?? 0;
    const discount = row.classes.has('discount') || 'data-promotion-id' in row.attrs || !row.classes.size;
    if (discount && current) {
      current.discounts.push({ name: description || 'Korting', cents: -Math.abs(cents) });
      continue;
    }
    if (description) out.push({ name: description, quantity: 1, cents, discounts: [] });
    current = null;
  }
  return out.filter(l => l.name);
}

/** Oudere bonnen (en andere landen) hebben losse regels in itemsLine. */
function nativeLines(items: any[]): LidlLine[] {
  return items.filter(i => i && typeof i.name === 'string' && i.name.trim()).flatMap(i => {
    const q = quantity(i.quantity);
    const cents = lidlCents(i.originalAmount) ?? Math.round((lidlCents(i.currentUnitPrice) ?? 0) * q);
    const discounts = (Array.isArray(i.discounts) ? i.discounts : []).flatMap((d: any) => {
      const c = lidlCents(d?.amount);
      return c ? [{ name: String(d.description ?? d.name ?? 'Korting').trim(), cents: -Math.abs(c) }] : [];
    });
    const line: LidlLine = { name: String(i.name).trim(), quantity: q, cents, discounts, ...(i.isWeight ? { weight: true } : {}) };
    const deposit = lidlCents(i.deposit?.amount);
    return deposit ? [line, { name: String(i.deposit.description ?? 'Statiegeld').trim(), quantity: quantity(i.deposit.quantity), cents: deposit, discounts: [] }] : [line];
  });
}

/** De regels van één bon, uit itemsLine of uit de geprinte bon. */
export function ticketLines(ticket: any): LidlLine[] {
  if (Array.isArray(ticket?.itemsLine) && ticket.itemsLine.length) return nativeLines(ticket.itemsLine);
  if (typeof ticket?.htmlPrintedReceipt === 'string') return parseReceiptHtml(ticket.htmlPrintedReceipt);
  return [];
}

/** "2026-08-12T14:28:11" en "2026-08-12T14:28:11+02:00" zijn lokale tijd; met Z omrekenen. */
export function ticketDate(value: unknown): string {
  const s = String(value ?? '');
  if (/Z$/i.test(s) && Number.isFinite(Date.parse(s))) return localDate(Date.parse(s));
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

// ───────────── Het account ─────────────

export class Lidl {
  #secrets: Secrets;
  #fetch: typeof fetch;
  #now: () => number;
  #refreshing: Promise<string> | null = null;
  #pausedUntil = 0;
  /** Wordt aangeroepen als Lidl de koppeling heeft ingetrokken. */
  onExpired?: () => void;
  /** Na een weigering (403/429): tot wanneer Weekmand Lidl met rust laat. */
  onPause?: (until: number) => void;
  get pausedUntil() { return this.#pausedUntil; }
  set pausedUntil(until: number) { this.#pausedUntil = Number(until) || 0; }

  constructor(secrets: Secrets, fetcher: typeof fetch = fetch, now: () => number = Date.now) {
    this.#secrets = secrets;
    this.#fetch = fetcher;
    this.#now = now;
  }

  get linked() { return !!this.#secrets.get('lidl')?.refreshToken; }
  get linkedAt() { return this.#secrets.get('lidl')?.linkedAt ?? null; }

  /**
   * De inlogpagina van Lidl. De PKCE-sleutel blijft bewaard (alleen in het geheimenbestand) tot
   * het koppelen lukt, zodat de link hetzelfde blijft en de code die terugkomt erbij past.
   */
  loginUrl() {
    let pending = this.#secrets.get('lidlPending');
    if (!pending?.verifier) {
      pending = { verifier: randomBytes(48).toString('base64url') };
      this.#secrets.set('lidlPending', pending);
    }
    const challenge = createHash('sha256').update(pending.verifier).digest('base64url');
    const params = new URLSearchParams({
      client_id: CLIENT, response_type: 'code', scope: SCOPES, redirect_uri: REDIRECT,
      code_challenge: challenge, code_challenge_method: 'S256', Country: COUNTRY, language: `${LANGUAGE}-${COUNTRY}`,
    });
    return `${AUTH}/connect/authorize?${params}`;
  }

  /** Wissel de eenmalige code in voor tokens. Het Lidl-wachtwoord komt nooit bij Weekmand. */
  async link(text: string) {
    const code = loginCode(text);
    check(code, 'Plak de regel met com.lidlplus.app://callback?code=… (of alleen de code).');
    const verifier = this.#secrets.get('lidlPending')?.verifier;
    check(verifier, 'Open eerst de inlogpagina van Lidl via Weekmand en log daar in.', 409);
    const res = await this.#tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier });
    if (res.status === 400 || res.status === 401) throw new Problem(400, 'Lidl accepteert deze code niet. Een code werkt één keer en maar een paar minuten: log opnieuw in via de link in Weekmand en plak de nieuwe code meteen.');
    if (!res.ok) throw failure(res.status);
    this.#save(await res.json().catch(() => null), new Date(this.#now()).toISOString());
    this.#secrets.set('lidlPending', undefined);
  }

  unlink() { this.#secrets.set('lidl', undefined); }

  /** Eén pagina bonnen, nieuwste eerst. more: er zijn oudere pagina's. */
  async tickets(page = 1): Promise<{ tickets: LidlTicket[]; more: boolean }> {
    const data = await this.#get(`/v2/${COUNTRY}/tickets?pageNumber=${page}&onlyFavorite=false`);
    const list: any[] = Array.isArray(data?.tickets) ? data.tickets : [];
    const size = Number(data?.size) > 0 ? Number(data.size) : list.length;
    const total = Number(data?.totalCount);
    return {
      tickets: list.filter(t => t?.id).map(t => ({ id: String(t.id), date: ticketDate(t.date), totalCents: lidlCents(t.totalAmount) })),
      more: list.length > 0 && (Number.isFinite(total) ? page * size < total : list.length >= size),
    };
  }

  /** Eén bon met zijn regels. */
  async ticket(id: string): Promise<{ date: string; totalCents: number | null; lines: LidlLine[] }> {
    const t = await this.#get(`/v3/${COUNTRY}/tickets/${encodeURIComponent(id)}`);
    return { date: ticketDate(t?.date), totalCents: lidlCents(t?.totalAmount), lines: ticketLines(t) };
  }

  // ───────────── Intern ─────────────

  #save(data: any, linkedAt: string) {
    if (typeof data?.access_token !== 'string' || typeof data?.refresh_token !== 'string') throw new Problem(502, 'Lidl gaf een onverwacht antwoord bij het koppelen.');
    const seconds = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
    this.#secrets.set('lidl', { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: this.#now() + seconds * 1000, linkedAt });
  }

  async #send(url: string, init: RequestInit) {
    if (this.#now() < this.#pausedUntil) throw new Problem(503, 'Lidl weigerde eerder verzoeken van Weekmand. Weekmand probeert het later vanzelf opnieuw.');
    let res: Response;
    try {
      res = await this.#fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Problem(502, 'Lidl is niet bereikbaar. Probeer het later opnieuw.');
    }
    if (res.status === 403 || res.status === 429) {
      this.#pausedUntil = this.#now() + 12 * 36e5;
      this.onPause?.(this.#pausedUntil);
      throw new Problem(503, 'Lidl weigert op dit moment verzoeken van Weekmand. Weekmand wacht twaalf uur voordat het opnieuw probeert.');
    }
    return res;
  }

  #tokenRequest(form: Record<string, string>) {
    return this.#send(AUTH + '/connect/token', {
      method: 'POST',
      headers: { Authorization: BASIC, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA },
      body: new URLSearchParams(form).toString(),
    });
  }

  /**
   * Geldig toegangstoken. Lidl geeft bij elke verversing een nieuw verversingstoken en het oude
   * vervalt; daarom één verversing tegelijk en het nieuwe meteen bewaren.
   */
  async #token(force = false): Promise<string> {
    const link = this.#secrets.get('lidl');
    check(link?.refreshToken, 'Koppel eerst je Lidl Plus-account (Meer → Lidl Plus).', 409);
    if (!force && link.expiresAt - 60_000 > this.#now()) return link.accessToken;
    this.#refreshing ??= (async () => {
      try {
        const res = await this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: link.refreshToken });
        if (res.status === 400 || res.status === 401) {
          this.unlink();
          this.onExpired?.();
          throw new Problem(409, 'De koppeling met je Lidl Plus-account is verlopen. Koppel opnieuw via Meer → Lidl Plus.');
        }
        if (!res.ok) throw failure(res.status);
        const data = await res.json().catch(() => null);
        this.#save({ ...data, refresh_token: data?.refresh_token ?? link.refreshToken }, link.linkedAt);
        return this.#secrets.get('lidl')!.accessToken;
      } finally {
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }

  async #get(path: string): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#token(attempt > 0);
      const res = await this.#send(TICKETS + path, {
        headers: {
          Authorization: 'Bearer ' + token, Accept: 'application/json', 'User-Agent': UA, 'Accept-Language': LANGUAGE,
          // Zonder deze kenmerken van de app weigert de bonnen-API het verzoek.
          App: 'com.lidl.eci.lidl.plus', 'App-Version': LIDL_APP_VERSION, 'Operating-System': 'iOs',
        },
      });
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 401) throw new Problem(409, 'Lidl accepteert de koppeling niet meer. Koppel opnieuw via Meer → Lidl Plus.');
      if (res.status === 426 || res.status === 400) {
        const body = await res.text().catch(() => '');
        if (res.status === 426 || /version/i.test(body)) throw new Problem(502, `Lidl weigert app-versie ${LIDL_APP_VERSION}. Zet LIDL_APP_VERSION in de instellingen van de server op de versie van de Lidl Plus-app en herstart Weekmand.`);
        throw failure(res.status);
      }
      if (!res.ok) throw failure(res.status);
      return res.json().catch(() => null);
    }
  }
}

const failure = (status: number) => new Problem(502, `Lidl gaf een fout (${status}). Probeer het later opnieuw.`);
