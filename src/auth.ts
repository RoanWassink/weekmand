import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Store } from './db.ts';
import { check, Problem } from './errors.ts';

/**
 * Accounts voor de webapp. Wachtwoorden worden gehasht met scrypt; een sessie is een willekeurig
 * token in een HttpOnly-cookie, waarvan alleen de hash in de database staat.
 */
export const sessionDays = 180;
type Account = { name: string; hash: string; salt: string; createdAt: string };

const hash = (password: string, salt: string) => scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export class Accounts {
  #store: Store;
  #failures = new Map<string, { count: number; until: number }>();

  constructor(store: Store) {
    this.#store = store;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (name TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, name TEXT NOT NULL, expires INTEGER NOT NULL) STRICT;`);
  }

  list(): string[] { return (this.#store.db.prepare('SELECT name FROM accounts ORDER BY name').all() as { name: string }[]).map(r => r.name); }
  get count() { return this.list().length; }
  #get(name: string): Account | null {
    const row = this.#store.db.prepare('SELECT body FROM accounts WHERE name = ?').get(name) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : null;
  }

  static validName(name: unknown): string {
    check(typeof name === 'string' && /^[a-z0-9._-]{2,32}$/.test(name.trim().toLowerCase()), 'Kies een gebruikersnaam van 2 tot 32 tekens (letters, cijfers, punt, streep).');
    return name.trim().toLowerCase();
  }
  static validPassword(password: unknown): string {
    check(typeof password === 'string' && password.length >= 8 && password.length <= 200, 'Kies een wachtwoord van minimaal 8 tekens.');
    return password;
  }

  create(name: unknown, password: unknown) {
    const n = Accounts.validName(name);
    const p = Accounts.validPassword(password);
    check(!this.#get(n), 'Dit account bestaat al.', 409);
    const salt = randomBytes(16).toString('hex');
    const account: Account = { name: n, salt, hash: hash(p, salt), createdAt: new Date().toISOString() };
    this.#store.db.prepare('INSERT INTO accounts (name, body) VALUES (?, ?)').run(n, JSON.stringify(account));
    return n;
  }

  setPassword(name: string, password: unknown) {
    const account = this.#get(name);
    check(account, 'Onbekend account.', 404);
    const salt = randomBytes(16).toString('hex');
    this.#store.db.prepare('UPDATE accounts SET body = ? WHERE name = ?').run(JSON.stringify({ ...account, salt, hash: hash(Accounts.validPassword(password), salt) }), name);
    this.#store.db.prepare('DELETE FROM sessions WHERE name = ?').run(name);
  }

  remove(name: string, by: string) {
    check(name !== by, 'Je kunt je eigen account niet verwijderen.');
    check(this.#get(name), 'Onbekend account.', 404);
    this.#store.db.prepare('DELETE FROM accounts WHERE name = ?').run(name);
    this.#store.db.prepare('DELETE FROM sessions WHERE name = ?').run(name);
  }

  /** Controleer naam en wachtwoord, met een korte blokkade na herhaalde fouten per adres. */
  verify(name: unknown, password: unknown, address: string, appPassword?: string): string {
    const now = Date.now();
    const f = this.#failures.get(address);
    if (f && f.until > now) throw new Problem(429, 'Te veel pogingen. Probeer het over een minuut opnieuw.');
    const n = typeof name === 'string' ? name.trim().toLowerCase() : '';
    const p = typeof password === 'string' ? password : '';
    const account = this.#get(n);
    let ok = false;
    if (account) ok = timingSafeEqual(Buffer.from(hash(p, account.salt), 'hex'), Buffer.from(account.hash, 'hex'));
    else if (n === 'weekmand' && appPassword) ok = timingSafeEqual(createHash('sha256').update(p).digest(), createHash('sha256').update(appPassword).digest());
    if (!ok) {
      const count = (f?.count ?? 0) + 1;
      this.#failures.set(address, { count, until: count >= 5 ? now + 60_000 : 0 });
      throw new Problem(401, 'Onbekende gebruikersnaam of verkeerd wachtwoord.');
    }
    this.#failures.delete(address);
    return n;
  }

  startSession(name: string): string {
    const token = randomBytes(32).toString('base64url');
    this.#store.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    this.#store.db.prepare('INSERT INTO sessions (token, name, expires) VALUES (?, ?, ?)').run(tokenHash(token), name, Date.now() + sessionDays * 86_400_000);
    return token;
  }

  session(token: string | undefined): string | null {
    if (!token || token.length > 100) return null;
    const row = this.#store.db.prepare('SELECT name, expires FROM sessions WHERE token = ?').get(tokenHash(token)) as { name: string; expires: number } | undefined;
    if (!row || row.expires < Date.now()) return null;
    // 'weekmand' (APP_PASSWORD) heeft geen accountregel; andere sessies alleen zolang het account bestaat.
    if (row.name !== 'weekmand' && !this.#get(row.name)) return null;
    return row.name;
  }

  endSession(token: string | undefined) {
    if (token) this.#store.db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash(token));
  }
}

export function cookieValue(header: string | undefined, name: string) {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}
