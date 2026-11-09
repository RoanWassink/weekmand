import { check, Problem } from './errors.ts';
import type { Secrets } from './secrets.ts';

/**
 * Albert Heijn voor boodschappen in de winkel, met het eigen AH-account van het huishouden.
 * Weekmand doet hier precies drie dingen: boodschappen op "Mijn lijst" zetten (zichtbaar in de
 * AH-app en de zelfscanner), kassabonnen lezen, en de verpakkingsmaat opzoeken van producten
 * die op een bon staan (één keer per product). Geen mand, geen bestellingen, geen vrij zoeken.
 *
 * AH heeft geen openbare API. Dit is de API van de AH-app, zoals community-projecten die
 * beschrijven (o.a. MealieShopper, appie-go). Weekmand stuurt een eerlijke User-Agent; de
 * clientvelden zijn wat de inlogdienst van AH verwacht. Weinig verzoeken, nooit schrijfacties
 * herhalen, en na een weigering (403/429) twaalf uur wachten.
 */

const API = 'https://api.ah.nl';
const CLIENT = 'appie-ios';
export const AH_LOGIN_URL = `https://login.ah.nl/login?client_id=${CLIENT}&response_type=code&redirect_uri=appie://login-exit`;
const HEADERS = {
  'User-Agent': 'Weekmand/2.0 (boodschappenassistent)',
  'x-client-name': CLIENT, 'x-client-version': '9.28', 'x-application': 'AHWEBSHOP',
  Accept: 'application/json',
};

export type AhLink = { accessToken: string; refreshToken: string; expiresAt: number; linkedAt: string };
export type AhListItem = { description: string; quantity: number; struck: boolean };
export type AhReceipt = { id: string; dateTime: string; total: number | null };
/** productId: het kassa-id van het product (niet het id van de webwinkel). */
export type AhReceiptLine = { name: string; quantity: number; amount: number | null; productId?: string };
/** Een bonusregel onderaan de bon ("BONUS AHRUNDERGEHA -0,40"): naam en bedrag, zonder product erbij. */
export type AhDiscount = { name: string; amount: number };

const RECEIPTS = `query Kassabonnen($offset: Int!, $limit: Int!) {
  posReceiptsPage(pagination: {offset: $offset, limit: $limit}) { posReceipts { id dateTime totalAmount { amount } } }
}`;
const RECEIPT = `query Kassabon($id: String!) {
  posReceiptDetails(id: $id) { id products { id quantity name amount { amount } } discounts { name amount { amount } } }
}`;
/** Zonder kortingen: als AH het kortingenveld ooit weigert, blijft de bon zelf leesbaar. */
const RECEIPT_BASIC = `query Kassabon($id: String!) {
  posReceiptDetails(id: $id) { id products { id quantity name amount { amount } } }
}`;

/**
 * De code uit wat de gebruiker plakt: de consoleregel "Failed to launch 'appie://login-exit?code=…'",
 * de URL zelf, een stuk JSON uit het Netwerk-tabblad of alleen de code. Anders null.
 */
export function loginCode(text: string): string | null {
  const t = String(text ?? '').trim();
  const fromUrl = /(?:^|[?&#\s'"(])code=([^&\s'"<>)\\]{8,4096})/.exec(t);
  const raw = fromUrl ? fromUrl[1] : !t.includes('://') && /^[^\s&'"<>=?]{8,4096}$/.test(t) ? t : null;
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

const money = (value: unknown) => {
  const n = Number((value as { amount?: unknown } | null)?.amount);
  return Number.isFinite(n) ? n : null;
};

export class AlbertHeijn {
  #secrets: Secrets;
  #fetch: typeof fetch;
  #now: () => number;
  #refreshing: Promise<string> | null = null;
  #pausedUntil = 0;
  /** Wordt aangeroepen als AH de koppeling heeft ingetrokken. */
  onExpired?: () => void;
  /** Na een weigering (403/429): tot wanneer Weekmand AH met rust laat. De app bewaart dit over een herstart heen. */
  onPause?: (until: number) => void;
  get pausedUntil() { return this.#pausedUntil; }
  set pausedUntil(until: number) { this.#pausedUntil = Number(until) || 0; }

  constructor(secrets: Secrets, fetcher: typeof fetch = fetch, now: () => number = Date.now) {
    this.#secrets = secrets;
    this.#fetch = fetcher;
    this.#now = now;
  }

  get linked() { return !!this.#secrets.get('ah')?.refreshToken; }
  get linkedAt() { return this.#secrets.get('ah')?.linkedAt ?? null; }

  /** Wissel de eenmalige inlogcode in voor tokens. Het AH-wachtwoord komt nooit bij Weekmand. */
  async link(text: string) {
    const code = loginCode(text);
    check(code, 'Plak de regel met appie://login-exit?code=… (of alleen de code).');
    const res = await this.#send('/mobile-auth/v1/auth/token', { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: CLIENT, code }) });
    if (res.status === 400 || res.status === 401) throw new Problem(400, 'AH accepteert deze code niet. Een code werkt één keer en maar kort: log opnieuw in en plak de nieuwe code meteen.');
    if (!res.ok) throw failure(res.status);
    this.#save(await res.json().catch(() => null), new Date(this.#now()).toISOString());
  }

  unlink() { this.#secrets.set('ah', undefined); }

  async list(): Promise<AhListItem[]> {
    const data = await this.#call('GET', '/mobile-services/shoppinglist/v2/items');
    const items: any[] = Array.isArray(data?.items) ? data.items : [];
    return items.map(i => ({
      description: String(i.description || i.productDetails?.product?.title || i.vagueTermDetails?.searchTermValue || ''),
      quantity: Number(i.quantity) || 1,
      struck: !!i.strikedthrough,
    }));
  }

  /** Vrije tekst op Mijn lijst. AH weigert dubbele regels in één verzoek en aantallen buiten 1–99. */
  async addToList(items: { description: string; quantity: number }[]) {
    const unique = [...new Map(items.map(i => [i.description.toLowerCase(), i])).values()];
    if (!unique.length) return;
    await this.#call('PATCH', '/mobile-services/shoppinglist/v2/items', {
      items: unique.map(i => ({
        description: i.description.slice(0, 100), quantity: Math.min(99, Math.max(1, Math.round(i.quantity) || 1)),
        type: 'SHOPPABLE', originCode: 'PRD', strikeThrough: false,
      })),
    });
  }

  /** De nieuwste kassabonnen (winkelaankopen), nieuwste eerst. */
  async receipts(limit = 10, offset = 0): Promise<AhReceipt[]> {
    const data = await this.#graphql(RECEIPTS, { offset, limit });
    const list: any[] = data?.posReceiptsPage?.posReceipts ?? [];
    return list.filter(r => r?.id).map(r => ({ id: String(r.id), dateTime: String(r.dateTime ?? ''), total: money(r.totalAmount) }));
  }

  async receipt(id: string): Promise<AhReceiptLine[]> { return (await this.receiptDetails(id)).lines; }

  /** Productregels en bonusregels van één bon. discounts is null als AH de kortingen niet gaf. */
  async receiptDetails(id: string): Promise<{ lines: AhReceiptLine[]; discounts: AhDiscount[] | null }> {
    let raw = await this.#call('POST', '/graphql', { query: RECEIPT, variables: { id } });
    let withDiscounts = true;
    if (!raw?.data?.posReceiptDetails && raw?.errors?.length) {
      raw = { data: await this.#graphql(RECEIPT_BASIC, { id }) };
      withDiscounts = false;
    }
    const d = raw?.data?.posReceiptDetails ?? {};
    const lines: any[] = Array.isArray(d.products) ? d.products : [];
    const discounts: any[] = Array.isArray(d.discounts) ? d.discounts : [];
    return {
      lines: lines.filter(l => l?.name).map(l => ({
        name: String(l.name).trim(), quantity: Number(l.quantity) || 0, amount: money(l.amount),
        ...(Number.isSafeInteger(Number(l.id)) && Number(l.id) > 0 ? { productId: String(Number(l.id)) } : {}),
      })),
      discounts: withDiscounts ? discounts.filter(k => k?.name).map(k => ({ name: String(k.name).trim(), amount: money(k.amount) ?? 0 })) : null,
    };
  }

  /**
   * Verpakkingsmaat ("300 g") van producten op de bon. Het id op de bon is een kassa-id; AH zet
   * dat om naar het product in de webwinkel, en dat product kent zijn maat. Twee verzoeken voor
   * de hele lijst. Een product dat AH niet (meer) kent, komt terug als null.
   */
  async productSizes(posIds: string[]): Promise<Map<string, string | null>> {
    const ids = [...new Set(posIds.map(Number).filter(n => Number.isSafeInteger(n) && n > 0))].slice(0, 25);
    const result = new Map<string, string | null>(ids.map(id => [String(id), null]));
    if (!ids.length) return result;
    const converted = await this.#graphqlPartial(`query Producten { ${ids.map((id, i) => `p${i}: productConvertId(sourceId: ${id})`).join(' ')} }`);
    const webshop = new Map<number, string>();
    ids.forEach((id, i) => { const w = Number(converted[`p${i}`]); if (Number.isSafeInteger(w) && w > 0) webshop.set(w, String(id)); });
    if (!webshop.size) return result;
    const list = [...webshop.keys()];
    const details = await this.#graphqlPartial(`query Maten { ${list.map((w, i) => `p${i}: product(id: ${w}) { id salesUnitSize }`).join(' ')} }`);
    list.forEach((w, i) => {
      const size = details[`p${i}`]?.salesUnitSize;
      if (typeof size === 'string' && size.trim()) result.set(webshop.get(w)!, size.trim().slice(0, 60));
    });
    return result;
  }

  // ───────────── Intern ─────────────

  #save(data: any, linkedAt: string) {
    if (typeof data?.access_token !== 'string' || typeof data?.refresh_token !== 'string') throw new Problem(502, 'AH gaf een onverwacht antwoord bij het koppelen.');
    const seconds = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
    this.#secrets.set('ah', { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: this.#now() + seconds * 1000, linkedAt });
  }

  async #send(path: string, init: RequestInit) {
    if (this.#now() < this.#pausedUntil) throw new Problem(503, 'AH weigerde eerder verzoeken van Weekmand. Weekmand probeert het later vanzelf opnieuw.');
    let res: Response;
    try {
      res = await this.#fetch(API + path, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Problem(502, 'Albert Heijn is niet bereikbaar. Probeer het later opnieuw.');
    }
    if (res.status === 403 || res.status === 429) {
      this.#pausedUntil = this.#now() + 12 * 36e5;
      this.onPause?.(this.#pausedUntil);
      throw new Problem(503, 'AH weigert op dit moment verzoeken van Weekmand. Weekmand wacht twaalf uur voordat het opnieuw probeert.');
    }
    return res;
  }

  /** Geldig toegangstoken; ververst één keer tegelijk en bewaart steeds het nieuwste verversingstoken. */
  async #token(force = false): Promise<string> {
    const link = this.#secrets.get('ah');
    check(link?.refreshToken, 'Koppel eerst je AH-account (Meer → Albert Heijn).', 409);
    if (!force && link.expiresAt - 60_000 > this.#now()) return link.accessToken;
    this.#refreshing ??= (async () => {
      try {
        const res = await this.#send('/mobile-auth/v1/auth/token/refresh', {
          method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: CLIENT, refreshToken: link.refreshToken }),
        });
        if (res.status === 400 || res.status === 401) {
          this.unlink();
          this.onExpired?.();
          throw new Problem(409, 'De koppeling met je AH-account is verlopen. Koppel opnieuw via Meer → Albert Heijn.');
        }
        if (!res.ok) throw failure(res.status);
        const data = await res.json().catch(() => null);
        this.#save({ ...data, refresh_token: data?.refresh_token ?? link.refreshToken }, link.linkedAt);
        return this.#secrets.get('ah')!.accessToken;
      } finally {
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }

  async #call(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#token(attempt > 0);
      const res = await this.#send(path, {
        method,
        headers: { ...HEADERS, Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      // Een geweigerd token is niet verwerkt: één keer verversen en opnieuw is dan veilig, ook bij schrijven.
      if (res.status === 401 && attempt === 0) continue;
      if (res.status === 412) throw new Problem(409, 'Er staat een bestelling open bij AH (in de app of op de website). Zolang die openstaat weigert AH wijzigingen in Mijn lijst. Rond die bestelling eerst af.');
      if (res.status === 401) throw new Problem(409, 'AH accepteert de koppeling niet meer. Koppel opnieuw via Meer → Albert Heijn.');
      if (!res.ok) throw failure(res.status);
      return res.status === 204 ? null : res.json().catch(() => null);
    }
  }

  /** GraphQL waarbij losse onderdelen mogen ontbreken (een onbekend product); alleen helemaal niets is een fout. */
  async #graphqlPartial(query: string): Promise<Record<string, any>> {
    const data = await this.#call('POST', '/graphql', { query, variables: {} });
    if (!data?.data) throw new Problem(502, 'AH gaf een fout bij het opzoeken van de verpakkingen.');
    return data.data;
  }

  async #graphql(query: string, variables: Record<string, unknown>) {
    const data = await this.#call('POST', '/graphql', { query, variables });
    if (!data?.data && data?.errors?.length) throw new Problem(502, 'AH gaf een fout bij het ophalen van de kassabonnen.');
    return data?.data ?? {};
  }
}

const failure = (status: number) => new Problem(502, `Albert Heijn gaf een fout (${status}). Probeer het later opnieuw.`);
