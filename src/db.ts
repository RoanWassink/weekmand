import { DatabaseSync } from 'node:sqlite';
import type { Spend } from './budget.ts';
import type { IngredientDef, Meal, PantryItem, Recipe } from './types.ts';

export type ProductLink = {
  key: string; productId: string; name: string; unitQuantity: string;
  /** Inhoud van één verpakking in de eenheid van het ingrediënt. */
  packAmount: number; cents: number; auto: boolean; updatedAt: string;
};
export type Feedback = { at: string; kind: 'meal-rejected' | 'item-removed'; recipeId?: string; key?: string; weekday?: number; week: string; tags?: string[] };
export type Suggestion = { id: string; text: string; rule: unknown; status: 'open' | 'accepted' | 'declined'; createdAt: string; notified?: boolean };
export type Barcode = { code: string; key: string; amount: number; name: string };
export type ChatTurn = { role: 'user' | 'assistant'; content: string; at: string };

const schema = `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS meals (date TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, servings REAL NOT NULL, status TEXT NOT NULL, note TEXT, consumed INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE IF NOT EXISTS pantry (key TEXT PRIMARY KEY, amount REAL, checked_at TEXT, minimum REAL NOT NULL DEFAULT 0) STRICT;
CREATE TABLE IF NOT EXISTS ingredients (key TEXT PRIMARY KEY, def TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, def TEXT NOT NULL, source TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS product_links (key TEXT PRIMARY KEY, product_id TEXT NOT NULL, name TEXT NOT NULL, unit_quantity TEXT NOT NULL, pack_amount REAL NOT NULL, cents INTEGER NOT NULL, auto INTEGER NOT NULL, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY, body TEXT NOT NULL, at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS suggestions (id TEXT PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS barcodes (code TEXT PRIMARY KEY, key TEXT NOT NULL, amount REAL NOT NULL, name TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY, channel TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, at TEXT NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS chat_channel ON chat(channel, id);
CREATE TABLE IF NOT EXISTS notified (key TEXT PRIMARY KEY, at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS ratings (date TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, rating INTEGER NOT NULL, reason TEXT, at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS spending (id TEXT PRIMARY KEY, source TEXT NOT NULL, date TEXT NOT NULL, total_cents INTEGER NOT NULL, detailed INTEGER NOT NULL, body TEXT NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS spending_date ON spending(date);
`;
export type Rating = { date: string; recipeId: string; rating: 1 | -1; reason: string | null; at: string };

type Row = Record<string, unknown>;

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(schema);
    const columns = (this.db.prepare('PRAGMA table_info(meals)').all() as { name: string }[]).map(c => c.name);
    if (!columns.includes('ordered')) this.db.exec('ALTER TABLE meals ADD COLUMN ordered INTEGER NOT NULL DEFAULT 0');
  }

  close() { this.db.close(); }

  /** Voer fn uit in één transactie. Geneste aanroepen lopen mee in de buitenste. */
  #depth = 0;
  tx<T>(fn: () => T): T {
    if (this.#depth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.#depth++;
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#depth--;
    }
  }

  #all(sql: string, ...args: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  #get(sql: string, ...args: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  #run(sql: string, ...args: (string | number | null)[]) {
    return this.db.prepare(sql).run(...args);
  }

  // Instellingen (kleine JSON-documenten)
  get<T>(key: string, fallback: T): T {
    const row = this.#get('SELECT value FROM settings WHERE key = ?', key);
    return row ? JSON.parse(String(row.value)) as T : fallback;
  }
  set(key: string, value: unknown) {
    this.#run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }
  update<T>(key: string, fallback: T, fn: (value: T) => T): T {
    return this.tx(() => {
      const value = fn(this.get(key, fallback));
      this.set(key, value);
      return value;
    });
  }

  // Maaltijden
  #meal(row: Row): Meal & { consumed: boolean; ordered: boolean } {
    return {
      date: String(row.date), recipeId: String(row.recipe_id), servings: Number(row.servings),
      status: row.status as Meal['status'], ...(row.note ? { note: String(row.note) } : {}), consumed: !!row.consumed, ordered: !!row.ordered,
    };
  }
  meals(from: string, to: string) {
    return this.#all('SELECT * FROM meals WHERE date >= ? AND date <= ? ORDER BY date', from, to).map(r => this.#meal(r));
  }
  meal(date: string) {
    const row = this.#get('SELECT * FROM meals WHERE date = ?', date);
    return row ? this.#meal(row) : null;
  }
  saveMeal(meal: Meal) {
    this.#run(`INSERT INTO meals (date, recipe_id, servings, status, note) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET recipe_id = excluded.recipe_id, servings = excluded.servings, status = excluded.status, note = excluded.note, consumed = 0`,
    meal.date, meal.recipeId, meal.servings, meal.status, meal.note ?? null);
  }
  deleteMeal(date: string) { this.#run('DELETE FROM meals WHERE date = ?', date); }
  unconsumedBefore(date: string) {
    return this.#all('SELECT * FROM meals WHERE date < ? AND consumed = 0 ORDER BY date', date).map(r => this.#meal(r));
  }
  markConsumed(date: string) { this.#run('UPDATE meals SET consumed = 1 WHERE date = ?', date); }
  markOrdered(dates: string[]) { for (const d of dates) this.#run('UPDATE meals SET ordered = 1 WHERE date = ?', d); }
  orderedMeals(before: string, limit = 60) {
    return this.#all('SELECT * FROM meals WHERE ordered = 1 AND date <= ? ORDER BY date DESC LIMIT ?', before, limit).map(r => this.#meal(r));
  }

  // Beoordelingen van gegeten maaltijden
  rating(date: string): Rating | null {
    const r = this.#get('SELECT * FROM ratings WHERE date = ?', date);
    return r ? { date: String(r.date), recipeId: String(r.recipe_id), rating: Number(r.rating) as 1 | -1, reason: r.reason === null ? null : String(r.reason), at: String(r.at) } : null;
  }
  ratings(): Rating[] {
    return this.#all('SELECT * FROM ratings ORDER BY date').map(r => ({ date: String(r.date), recipeId: String(r.recipe_id), rating: Number(r.rating) as 1 | -1, reason: r.reason === null ? null : String(r.reason), at: String(r.at) }));
  }
  saveRating(r: Rating) {
    this.#run('INSERT INTO ratings (date, recipe_id, rating, reason, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET recipe_id = excluded.recipe_id, rating = excluded.rating, reason = excluded.reason, at = excluded.at',
      r.date, r.recipeId, r.rating, r.reason, r.at);
  }
  recentRecipeIds(from: string, to: string): string[] {
    return this.#all('SELECT recipe_id FROM meals WHERE date >= ? AND date < ?', from, to).map(r => String(r.recipe_id));
  }

  // Voorraad
  #pantry(row: Row): PantryItem {
    return {
      key: String(row.key), amount: row.amount === null ? null : Number(row.amount),
      checkedAt: row.checked_at === null ? null : String(row.checked_at), minimum: Number(row.minimum),
    };
  }
  pantry(): PantryItem[] { return this.#all('SELECT * FROM pantry ORDER BY key').map(r => this.#pantry(r)); }
  pantryItem(key: string): PantryItem | null {
    const row = this.#get('SELECT * FROM pantry WHERE key = ?', key);
    return row ? this.#pantry(row) : null;
  }
  savePantry(item: PantryItem) {
    this.#run(`INSERT INTO pantry (key, amount, checked_at, minimum) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET amount = excluded.amount, checked_at = excluded.checked_at, minimum = excluded.minimum`,
    item.key, item.amount, item.checkedAt, item.minimum);
  }

  // Eigen ingrediënten en recepten
  customIngredients(): IngredientDef[] {
    return this.#all('SELECT def FROM ingredients').map(r => JSON.parse(String(r.def)));
  }
  saveIngredient(def: IngredientDef) {
    this.#run('INSERT INTO ingredients (key, def) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET def = excluded.def', def.key, JSON.stringify(def));
  }
  customRecipes(): Recipe[] {
    return this.#all('SELECT def, source FROM recipes').map(r => ({ ...JSON.parse(String(r.def)), source: r.source }));
  }
  saveRecipe(recipe: Recipe) {
    const { source, ...def } = recipe;
    this.#run('INSERT INTO recipes (id, def, source) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET def = excluded.def, source = excluded.source',
      recipe.id, JSON.stringify(def), source);
  }
  deleteRecipe(id: string) { this.#run('DELETE FROM recipes WHERE id = ?', id); }

  // Koppelingen ingrediënt → winkelproduct
  #link(row: Row): ProductLink {
    return {
      key: String(row.key), productId: String(row.product_id), name: String(row.name), unitQuantity: String(row.unit_quantity),
      packAmount: Number(row.pack_amount), cents: Number(row.cents), auto: !!row.auto, updatedAt: String(row.updated_at),
    };
  }
  links(): ProductLink[] { return this.#all('SELECT * FROM product_links').map(r => this.#link(r)); }
  link(key: string): ProductLink | null {
    const row = this.#get('SELECT * FROM product_links WHERE key = ?', key);
    return row ? this.#link(row) : null;
  }
  saveLink(link: ProductLink) {
    this.#run(`INSERT INTO product_links (key, product_id, name, unit_quantity, pack_amount, cents, auto, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET product_id = excluded.product_id, name = excluded.name, unit_quantity = excluded.unit_quantity,
      pack_amount = excluded.pack_amount, cents = excluded.cents, auto = excluded.auto, updated_at = excluded.updated_at`,
    link.key, link.productId, link.name, link.unitQuantity, link.packAmount, link.cents, link.auto ? 1 : 0, link.updatedAt);
  }
  deleteLink(key: string) { this.#run('DELETE FROM product_links WHERE key = ?', key); }

  // Feedback en suggesties
  addFeedback(feedback: Feedback) { this.#run('INSERT INTO feedback (body, at) VALUES (?, ?)', JSON.stringify(feedback), feedback.at); }
  feedback(since: string): Feedback[] {
    return this.#all('SELECT body FROM feedback WHERE at >= ? ORDER BY id', since).map(r => JSON.parse(String(r.body)));
  }
  suggestions(status?: Suggestion['status']): Suggestion[] {
    const rows = status ? this.#all('SELECT body FROM suggestions WHERE status = ? ORDER BY rowid', status) : this.#all('SELECT body FROM suggestions ORDER BY rowid');
    return rows.map(r => JSON.parse(String(r.body)));
  }
  suggestion(id: string): Suggestion | null {
    const row = this.#get('SELECT body FROM suggestions WHERE id = ?', id);
    return row ? JSON.parse(String(row.body)) : null;
  }
  saveSuggestion(s: Suggestion) {
    this.#run('INSERT INTO suggestions (id, body, status) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, status = excluded.status',
      s.id, JSON.stringify(s), s.status);
  }

  // Barcodes
  barcode(code: string): Barcode | null {
    const row = this.#get('SELECT * FROM barcodes WHERE code = ?', code);
    return row ? { code: String(row.code), key: String(row.key), amount: Number(row.amount), name: String(row.name) } : null;
  }
  saveBarcode(b: Barcode) {
    this.#run('INSERT INTO barcodes (code, key, amount, name) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET key = excluded.key, amount = excluded.amount, name = excluded.name',
      b.code, b.key, b.amount, b.name);
  }

  // Chatgeheugen (kort)
  chat(channel: string, limit = 12): ChatTurn[] {
    return this.#all('SELECT role, content, at FROM chat WHERE channel = ? ORDER BY id DESC LIMIT ?', channel, limit)
      .reverse().map(r => ({ role: r.role as ChatTurn['role'], content: String(r.content), at: String(r.at) }));
  }
  addChat(channel: string, role: ChatTurn['role'], content: string) {
    this.#run('INSERT INTO chat (channel, role, content, at) VALUES (?, ?, ?, ?)', channel, role, content, new Date().toISOString());
    this.#run('DELETE FROM chat WHERE channel = ? AND id NOT IN (SELECT id FROM chat WHERE channel = ? ORDER BY id DESC LIMIT 40)', channel, channel);
  }
  clearChat(channel: string) { this.#run('DELETE FROM chat WHERE channel = ?', channel); }

  // Uitgaven (budget): bezorgingen, kassabonnen en losse uitgaven
  #spend(row: Row): Spend { return { ...JSON.parse(String(row.body)), id: String(row.id), source: row.source as Spend['source'], date: String(row.date), totalCents: Number(row.total_cents) }; }
  spends(from: string, to: string): Spend[] {
    return this.#all('SELECT * FROM spending WHERE date >= ? AND date <= ? ORDER BY date', from, to).map(r => this.#spend(r));
  }
  spend(id: string): Spend | null { const row = this.#get('SELECT * FROM spending WHERE id = ?', id); return row ? this.#spend(row) : null; }
  saveSpend(s: Spend) {
    const { id, source, date, totalCents, ...body } = s;
    this.#run('INSERT INTO spending (id, source, date, total_cents, detailed, body) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET source = excluded.source, date = excluded.date, total_cents = excluded.total_cents, detailed = excluded.detailed, body = excluded.body',
      id, source, date, Math.round(totalCents), s.lines ? 1 : 0, JSON.stringify(body));
  }
  deleteSpend(id: string) { this.#run('DELETE FROM spending WHERE id = ?', id); }
  /** Welke aankopen er al zijn (en of hun regels bekend zijn), zonder alles in te lezen. */
  spendIndex(source: Spend['source']): Map<string, { date: string; detailed: boolean; discounts: boolean }> {
    return new Map(this.#all("SELECT id, date, detailed, json_type(body, '$.discounts') IS NOT NULL AS discounts FROM spending WHERE source = ?", source)
      .map(r => [String(r.id), { date: String(r.date), detailed: !!r.detailed, discounts: !!r.discounts }]));
  }
  /** Totalen per dag, voor grafieken over lange tijd. */
  spendTotals(from: string, to: string): { date: string; cents: number }[] {
    return this.#all('SELECT date, SUM(total_cents) AS cents FROM spending WHERE date >= ? AND date <= ? GROUP BY date ORDER BY date', from, to).map(r => ({ date: String(r.date), cents: Number(r.cents) }));
  }
  firstSpendDate(): string | null { const row = this.#get('SELECT MIN(date) AS d FROM spending'); return row?.d ? String(row.d) : null; }

  // Eenmalige meldingen
  wasNotified(key: string) { return !!this.#get('SELECT 1 FROM notified WHERE key = ?', key); }
  markNotified(key: string) { this.#run('INSERT OR IGNORE INTO notified (key, at) VALUES (?, ?)', key, new Date().toISOString()); }

  /** Opschonen en compacteren; draait wekelijks. */
  maintain(before: string) {
    this.#run('DELETE FROM feedback WHERE at < ?', before);
    this.#run('DELETE FROM notified WHERE at < ?', before);
    this.#run('DELETE FROM meals WHERE date < ? AND ordered = 0', before.slice(0, 10));
    this.db.exec('VACUUM');
  }

  /** De toestand van de eerste versie (tabel `documents`), als die nog niet is overgezet. */
  legacyState(): Record<string, unknown> | null {
    if (this.get('migratedV1', false)) return null;
    const table = this.#get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents'");
    if (!table) return null;
    const rows = this.#all('SELECT key, body FROM documents');
    return Object.fromEntries(rows.map(r => [String(r.key), JSON.parse(String(r.body))]));
  }
}
