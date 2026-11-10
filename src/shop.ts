import { randomUUID } from 'node:crypto';
import PicnicClient from 'picnic-api';
import type { Store } from './db.ts';
import { Problem } from './errors.ts';
import { importDeliveries } from './picnic-history.ts';
import type { Secrets } from './secrets.ts';
import { addDays, localDate, zonedTime } from './time.ts';
import type { CartLine, DeliverySlot, IngredientDef, ProductDetails, ShopCart, ShopProduct } from './types.ts';

/** Productfoto's van Picnic zijn openbaar (geen sessiesleutel). De CSP van de webapp staat deze bron toe. */
export const PICNIC_IMAGE_ORIGIN = 'https://storefront-prod.nl.picnicinternational.com';
const imageId = (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(id) ? id : undefined;
/** Productomschrijving zonder markdown, kort genoeg voor het productvenster. */
const plainText = (text: unknown) => typeof text === 'string'
  ? text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_#>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 500)
  : '';

/** Alles wat Weekmand van een winkel nodig heeft. Er is geen checkout of betaalroute. */
export interface Shop {
  readonly kind: 'mock' | 'picnic' | 'self';
  readonly label: string;
  ready(): boolean;
  readCart(): Promise<ShopCart>;
  search(query: string): Promise<ShopProduct[]>;
  add(productId: string, count: number): Promise<ShopCart>;
  remove(productId: string, count: number): Promise<ShopCart>;
  slots(): Promise<DeliverySlot[]>;
}

export const quantityOf = (cart: ShopCart, id: string) =>
  cart.lines.filter(line => line.id === id).reduce((sum, line) => sum + line.quantity, 0);

const normalize = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ');

// ───────────────────────────── Zelf boodschappen doen ─────────────────────────────

/**
 * Geen bezorgdienst: je doet zelf boodschappen (Lidl, markt, AH). Er is geen mand en geen
 * deadline; Weekmand rekent met de gewone verpakkingen uit de catalogus en maakt een lijst.
 */
export class SelfShop implements Shop {
  readonly kind = 'self' as const;
  readonly label = 'Zelf boodschappen doen';
  #mock: MockShop;
  constructor(mock: MockShop) { this.#mock = mock; }
  ready() { return true; }
  async readCart(): Promise<ShopCart> { return { id: 'zelf', lines: [], totalCents: 0 }; }
  search(query: string) { return this.#mock.search(query); }
  async add(): Promise<ShopCart> { throw new Problem(409, 'Zonder Picnic is er geen mand: gebruik de boodschappenlijst.'); }
  async remove(): Promise<ShopCart> { throw new Problem(409, 'Zonder Picnic is er geen mand: gebruik de boodschappenlijst.'); }
  async slots(): Promise<DeliverySlot[]> { return []; }
}

// ───────────────────────────── Demo-winkel ─────────────────────────────

type MockCart = { id: string; lines: Record<string, number> };

/** Gesimuleerde Picnic-winkel met de democatalogus, voor testen zonder account. */
export class MockShop implements Shop {
  readonly kind = 'mock' as const;
  readonly label = 'Demowinkel';
  #store: Store;
  #ingredients: () => IngredientDef[];

  constructor(store: Store, ingredients: () => IngredientDef[]) {
    this.#store = store;
    this.#ingredients = ingredients;
  }

  ready() { return true; }

  products(): (ShopProduct & { key: string; aliases: string[] })[] {
    return this.#ingredients().flatMap(i => i.packs.map(p => ({
      id: p.id, name: p.name, key: i.key, aliases: [i.name, ...(i.aliases ?? [])],
      unitQuantity: p.unit === 'g' ? `${p.amount} gram` : p.unit === 'ml' ? (p.amount >= 1000 ? `${p.amount / 1000} liter` : `${p.amount} ml`) : `${p.amount} stuks`,
      cents: p.cents, available: true,
    })));
  }

  #cart(): MockCart {
    const cart = this.#store.get<MockCart | null>('mockCart', null);
    if (cart?.id) return cart;
    const fresh = { id: randomUUID(), lines: {} };
    this.#store.set('mockCart', fresh);
    return fresh;
  }

  #view(cart: MockCart): ShopCart {
    const catalog = new Map(this.products().map(p => [p.id, p]));
    const lines: CartLine[] = Object.entries(cart.lines).filter(([, q]) => q > 0).map(([id, quantity]) => {
      const { key: _key, aliases: _aliases, ...product } = catalog.get(id) ?? { id, name: id, unitQuantity: '', cents: 0, available: false, key: '', aliases: [] };
      return { ...product, quantity };
    });
    return { id: cart.id, lines, totalCents: lines.reduce((sum, l) => sum + l.cents * l.quantity, 0) };
  }

  async readCart() { return this.#view(this.#cart()); }

  async search(query: string) {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    const scored = this.products().map(p => {
      // Treffers in de productnaam wegen zwaarder dan synoniemen: 'krat pils' → het krat.
      const name = normalize(p.name);
      const aliases = normalize(p.aliases.join(' '));
      const stem = (w: string) => w.replace(/(en|s)$/, '');
      const score = words.reduce((s, w) => s + (name.includes(w) ? 3 : name.includes(stem(w)) ? 2 : aliases.includes(w) || aliases.includes(stem(w)) ? 1 : 0), 0);
      return { p, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.p.cents - b.p.cents);
    return scored.slice(0, 15).map(({ p: { key: _k, aliases: _a, ...product } }) => product);
  }

  #change(productId: string, delta: number) {
    if (!this.products().some(p => p.id === productId)) throw new Problem(404, 'Onbekend product in de demowinkel.');
    this.#cart();
    const cart = this.#store.update<MockCart>('mockCart', { id: randomUUID(), lines: {} }, cart => {
      const quantity = Math.max(0, (cart.lines[productId] ?? 0) + delta);
      const lines = { ...cart.lines, [productId]: quantity };
      if (!quantity) delete lines[productId];
      return { ...cart, lines };
    });
    return this.#view(cart);
  }
  async add(productId: string, count: number) { return this.#change(productId, count); }
  async remove(productId: string, count: number) { return this.#change(productId, -count); }

  async slots(now = Date.now()): Promise<DeliverySlot[]> {
    const chosen = this.#store.get<string | null>('mockSlot', null);
    const today = localDate(now);
    const slots = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(today, i + 1);
      const cutOff = zonedTime(addDays(date, -1), 22);
      return {
        id: 'demo-' + date, windowStart: new Date(zonedTime(date, 18)).toISOString(), windowEnd: new Date(zonedTime(date, 20)).toISOString(),
        cutOff: new Date(cutOff).toISOString(), selected: false, available: cutOff > now,
      };
    });
    const selected = slots.find(s => s.id === chosen && s.available) ?? slots.find(s => s.available);
    if (selected) selected.selected = true;
    return slots;
  }

  selectSlot(id: string) { this.#store.set('mockSlot', id); }

  /** Demo: plaats de bestelling en "lever" haar meteen. Geeft de geleverde regels terug. */
  async checkout(): Promise<CartLine[]> {
    const cart = await this.readCart();
    this.#store.set('mockCart', { id: randomUUID(), lines: {} });
    this.#store.set('mockSlot', null);
    return cart.lines;
  }
}

// ───────────────────────────── Echte Picnic ─────────────────────────────

type Client = InstanceType<typeof PicnicClient>;
export type PicnicStatus = 'disconnected' | 'sms' | 'connected' | 'expired';

/**
 * Koppeling met Picnic via de onofficiële picnic-api. De sessiesleutel blijft in het geheugen
 * en wordt alleen met toestemming ("onthouden") in het geheimenbestand bewaard, zodat
 * automatische meldingen na een herstart blijven werken. Picnic vernieuwt de sleutel soms in een
 * antwoord; die nieuwe sleutel wordt dan bijgewerkt.
 */
/** Status, Picnics foutcode en (bij een HTML-pagina zonder code) een stukje tekst; nooit de sessiesleutel. */
function logPicnicError(label: string, error: unknown) {
  const { status, code, body } = (error ?? {}) as { status?: number; code?: string | null; body?: unknown };
  const text = !code && typeof body === 'string' ? body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  console.error(label, status ?? '', code ?? (error as Error)?.name ?? '', text);
}

export class PicnicShop implements Shop {
  readonly kind = 'picnic' as const;
  readonly label = 'Picnic';
  #client: Client | null = null;
  #pending = false;
  #remember = false;
  #expired = false;
  #secrets: Secrets;
  onExpired: (() => void) | null = null;
  /** Klok (tests zetten hem vast). */
  now: () => number = Date.now;
  /**
   * Weigert Picnic ook het lezen van de mand, dan rust Weekmand even (15, 30, daarna 60 minuten)
   * in plaats van de sessie weg te gooien: een 403 zonder foutcode is Picnic die afremt.
   */
  #pausedUntil = 0;
  #strikes = 0;
  /** Sinds wanneer Picnic de sessie zelf afwijst (401); na zes uur volgt de melding "verlopen". */
  #authRefusedSince: number | null = null;
  /** Gemeld bij het lezen van de mand en bij zoeken: product-id → afbeelding-id. */
  onImages: ((images: Record<string, string>) => void) | null = null;
  #details = new Map<string, { at: number; value: ProductDetails }>();

  constructor(secrets: Secrets, makeClient = (authKey?: string) => new PicnicClient({ countryCode: 'NL', ...(authKey ? { authKey } : {}) })) {
    this.#secrets = secrets;
    this.#make = makeClient;
    const saved = secrets.get('picnicAuthKey');
    if (saved) {
      this.#client = makeClient(saved);
      this.#remember = true;
    }
  }
  #make: (authKey?: string) => Client;

  get status(): PicnicStatus {
    if (this.#pending) return 'sms';
    if (this.#client) return 'connected';
    return this.#expired ? 'expired' : 'disconnected';
  }
  get remembered() { return this.#remember && !!this.#secrets.get('picnicAuthKey'); }
  ready() { return this.status === 'connected'; }

  async login(email: string, password: string, remember: boolean) {
    const client = this.#make();
    try {
      const result = await client.auth.login(email, password);
      if (result.secondFactorAuthenticationRequired) await client.auth.generate2FACode('SMS');
      this.#client = client;
      this.#pending = !!result.secondFactorAuthenticationRequired;
      this.#remember = remember;
      this.#expired = false;
      this.#resetRefusals();
      this.#persist();
    } catch (error) {
      throw this.#problem(error);
    }
  }

  async verify(code: string) {
    if (!this.#client || !this.#pending) throw new Problem(409, 'Start eerst de Picnic-aanmelding.');
    try {
      await this.#client.auth.verify2FACode(code);
    } catch (error) {
      throw this.#problem(error);
    }
    this.#pending = false;
    this.#persist();
  }

  disconnect() {
    this.#client = null;
    this.#pending = false;
    this.#expired = false;
    this.#resetRefusals();
    this.#secrets.set('picnicAuthKey', undefined);
  }

  #resetRefusals() { this.#pausedUntil = 0; this.#strikes = 0; this.#authRefusedSince = null; }

  #persist() {
    if (this.#remember && this.#client && !this.#pending && this.#client.authKey) {
      if (this.#secrets.get('picnicAuthKey') !== this.#client.authKey) this.#secrets.set('picnicAuthKey', this.#client.authKey);
    } else if (!this.#remember) {
      this.#secrets.set('picnicAuthKey', undefined);
    }
  }

  /**
   * Picnic wijst de sessie al uren af. De bewaarde sleutel blijft staan: na een herstart probeert
   * Weekmand hem opnieuw, en opnieuw aanmelden vervangt hem.
   */
  #expire(): Problem {
    this.#client = null;
    this.#pending = false;
    this.#expired = true;
    this.#resetRefusals();
    this.onExpired?.();
    return new Problem(401, 'Je Picnic-sessie is verlopen. Meld je opnieuw aan bij Picnic.');
  }

  /** Picnic weigerde ook de controle: even rusten, en pas na zes uur afwijzen "verlopen" melden. */
  #refused(status: number | undefined, code: string | null | undefined): Problem {
    const now = this.now();
    if (status === 401 || code) {
      this.#authRefusedSince ??= now;
      if (now - this.#authRefusedSince >= 6 * 36e5) return this.#expire();
    }
    this.#strikes++;
    this.#pausedUntil = now + Math.min(60, 15 * 2 ** (this.#strikes - 1)) * 60_000;
    return this.#pauseProblem();
  }

  #pauseProblem() {
    const at = new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' }).format(this.#pausedUntil);
    return new Problem(503, `Picnic weigert Weekmand even. Je sessie blijft bewaard; Weekmand probeert het om ${at} opnieuw.`);
  }

  #problem(error: unknown): Problem {
    if (error instanceof Problem) return error;
    const { status, code } = (error ?? {}) as { status?: number; code?: string };
    if (code === 'AUTH_INVALID_CRED') return new Problem(401, 'Picnic accepteert dit e-mailadres en wachtwoord niet.');
    if (code === 'OTP_NOT_VALID') return new Problem(400, 'Picnic accepteert deze sms-code niet.');
    if (status === 429) return new Problem(503, 'Picnic krijgt even te veel verzoeken. Probeer het over een paar minuten opnieuw.');
    if ((error as Error)?.name === 'TimeoutError') return new Problem(504, 'Picnic reageerde niet op tijd. Probeer het zo opnieuw.');
    return new Problem(502, 'Picnic kon de bewerking niet voltooien. Probeer het zo opnieuw.');
  }

  async #call<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    if (!this.#client || this.#pending) throw new Problem(409, 'Meld je eerst aan bij Picnic.');
    // Tijdens een rustpauze geen verzoeken: dat zou Picnic alleen langer laten weigeren.
    if (this.now() < this.#pausedUntil) throw this.#pauseProblem();
    const client = this.#client;
    try {
      const value = await fn(client);
      this.#resetRefusals();
      this.#persist();
      return value;
    } catch (error) {
      const { status } = (error ?? {}) as { status?: number };
      logPicnicError('Picnic-fout', error);
      if (status === 401 || status === 403) {
        // Een weigering betekent niet altijd een verlopen sessie (bijv. te veel zoekopdrachten).
        // Alleen als ook het lezen van de mand geweigerd wordt, rust Weekmand even.
        try {
          await client.cart.getCart();
          throw new Problem(503, 'Picnic weigerde dit verzoek even. Probeer het over een paar minuten opnieuw.');
        } catch (check) {
          if (check instanceof Problem) throw check;
          const c = (check ?? {}) as { status?: number; code?: string | null };
          if (c.status === 401 || c.status === 403) {
            logPicnicError('Picnic weigert ook de mand', check);
            throw this.#refused(c.status, c.code);
          }
          throw this.#problem(check);
        }
      }
      throw this.#problem(error);
    }
  }

  #cart(raw: Awaited<ReturnType<Client['cart']['getCart']>>): ShopCart {
    if (!raw.id || !Array.isArray(raw.items)) throw new Problem(502, 'Picnic gaf een onbekende mandindeling.');
    const lines = new Map<string, CartLine>();
    for (const item of raw.items) {
      if (!item.productId || !Number.isSafeInteger(item.quantity) || item.quantity < 1) continue;
      const existing = lines.get(item.productId);
      if (existing) existing.quantity += item.quantity;
      // display_price is de prijs van de hele regel; de stuksprijs is regelprijs / aantal.
      else {
        const image = imageId(item.imageId);
        lines.set(item.productId, {
          id: item.productId, name: item.name, unitQuantity: item.unitQuantity, quantity: item.quantity,
          cents: Math.round(item.displayPrice / item.quantity), available: !item.isUnavailable,
          ...(image ? { image } : {}), ...(item.basePrice ? { unitPrice: String(item.basePrice) } : {}),
        });
      }
    }
    this.#noteImages([...lines.values()]);
    return { id: raw.id, lines: [...lines.values()], totalCents: raw.totalPrice, recipes: (raw.recipes ?? []).map(r => ({ id: r.id, title: r.title })) };
  }

  readCart() { return this.#call(async c => this.#cart(await c.cart.getCart())); }
  add(productId: string, count: number) { return this.#call(async c => this.#cart(await c.cart.addProductToCart(productId, count))); }
  remove(productId: string, count: number) { return this.#call(async c => this.#cart(await c.cart.removeProductFromCart(productId, count))); }

  search(query: string) {
    return this.#call(async c => {
      const result = await c.catalog.getSearchResults(query);
      const products: ShopProduct[] = [];
      for (const section of result.products?.sections ?? []) for (const p of section.products) {
        if (products.length >= 15 || !p.id || !p.name || !Number.isSafeInteger(p.displayPrice)) continue;
        const tiers = (p.priceRanges ?? []).map((r: any) => ({ from: Number(r.from_quantity ?? r.fromQuantity), cents: Number(r.price) })).filter(t => t.from > 1 && t.cents > 0);
        const promo = p.labels?.find(l => l.type === 'PROMO' && l.text)?.text ?? undefined;
        const image = imageId(p.imageId);
        products.push({
          id: p.id, name: p.name, unitQuantity: p.unitQuantity, cents: p.displayPrice, available: !p.isUnavailable, ...(tiers.length ? { tiers } : {}), ...(promo ? { promo } : {}),
          ...(image ? { image } : {}), ...(p.unitPrice ? { unitPrice: p.unitPrice } : {}), ...(p.brand ? { brand: p.brand } : {}),
        });
      }
      this.#noteImages(products);
      return products;
    });
  }

  /** De productpagina van Picnic (merk, omschrijving, foto), voor het productvenster. Een uur onthouden. */
  async product(id: string): Promise<ProductDetails> {
    const hit = this.#details.get(id);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.value;
    return this.#call(async c => {
      const p = await c.catalog.getProduct(id);
      const image = imageId(p.imageIds?.[0]);
      const description = plainText(p.description);
      const labels = (p.labels ?? []).map(l => l.text).filter(Boolean);
      const value: ProductDetails = {
        id, name: p.name, unitQuantity: p.unitQuantity, cents: p.displayPrice, available: true,
        ...(image ? { image } : {}), ...(p.unitPrice ? { unitPrice: p.unitPrice } : {}), ...(p.brand ? { brand: p.brand } : {}),
        ...(description ? { description } : {}), ...(labels.length ? { labels } : {}),
      };
      if (this.#details.size >= 200) this.#details.clear();
      this.#details.set(id, { at: Date.now(), value });
      this.#noteImages([value]);
      return value;
    });
  }

  #noteImages(products: ShopProduct[]) {
    const found: Record<string, string> = {};
    for (const p of products) if (p.image) found[p.id] = p.image;
    if (Object.keys(found).length) this.onImages?.(found);
  }

  slots() {
    return this.#call(async c => {
      const { slots, selectedSlot } = await c.cart.getDeliverySlots();
      return slots.map(s => ({
        id: s.slotId, windowStart: s.windowStart, windowEnd: s.windowEnd, cutOff: s.cutOffTime,
        selected: s.isSelected || s.slotId === selectedSlot?.slotId, available: s.isAvailable,
      }));
    });
  }

  history(now = Date.now()) { return this.#call(c => importDeliveries(c.delivery, now)); }
  /** Alle voltooide bezorgingen met hun totaal (één verzoek), voor het budget. */
  deliverySummaries() { return this.#call(c => c.delivery.getDeliverySummaries(['COMPLETED'])); }
  delivery(id: string) { return this.#call(c => c.delivery.getDelivery(id)); }

  savedRecipes() { return this.#call(c => c.recipe.getSavedRecipes()); }
  userRecipes() { return this.#call(c => c.recipe.getUserDefinedRecipes()); }
  recipeOverview() { return this.#call(c => c.recipe.getRecipeOverview()); }
  // Zonder resolveIngredientNames: dat vraagt per product een extra pagina op, en Picnic weigert te veel verzoeken.
  recipe(id: string) { return this.#call(c => c.recipe.getRecipe(id)); }

  /** Zet het bezorgmoment in de Picnic-mand (geen bestelling). */
  selectSlot(slotId: string) { return this.#call(async c => { await c.cart.setDeliverySlot(slotId); }); }
}

// ───────────────────────────── Wijzigingen toepassen ─────────────────────────────

export type CartChange = { cartId: string; before: Record<string, number>; target: Record<string, number> };

/**
 * Breng de mand van `before` naar `target`. Herhaalbaar: een regel die al op het doel staat
 * wordt overgeslagen. Elke andere afwijking stopt de synchronisatie, zodat Weekmand nooit
 * over wijzigingen van iemand anders heen schrijft. `onApplied` legt elke geslaagde stap vast.
 */
export async function applyChange(shop: Shop, change: CartChange, onApplied: (productId: string, delta: number) => void) {
  const conflict = () => new Problem(409, 'De mand is intussen gewijzigd. Bekijk de wijzigingen opnieuw.');
  const ids = [...new Set([...Object.keys(change.before), ...Object.keys(change.target)])];
  const validate = (cart: ShopCart) => {
    if (cart.id !== change.cartId) throw conflict();
    for (const id of ids) {
      const value = quantityOf(cart, id);
      if (value !== (change.before[id] ?? 0) && value !== (change.target[id] ?? 0)) throw conflict();
    }
  };
  let cart = await shop.readCart();
  validate(cart);
  const applied: Record<string, number> = {};
  for (const id of ids) {
    const want = change.target[id] ?? 0;
    const delta = want - quantityOf(cart, id);
    if (!delta) continue;
    cart = delta > 0 ? await shop.add(id, delta) : await shop.remove(id, -delta);
    const now = quantityOf(cart, id);
    if (now !== want) {
      if (now !== want - delta) onApplied(id, now - (want - delta));
      throw new Problem(409, 'De winkel gaf een ander aantal terug dan verwacht. Controleer de mand in de Picnic-app.');
    }
    onApplied(id, delta);
    applied[id] = delta;
    validate(cart);
  }
  return { cart, applied };
}
