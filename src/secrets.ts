import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Geheimen staan los van SQLite in een eigen bestand met rechten 600 (alleen de app-gebruiker).
 * Nooit in logs, broncode of de database. Het Picnic-wachtwoord en sms-codes worden nooit bewaard.
 */
export type SecretData = {
  apiToken?: string;
  picnicAuthKey?: string;
  ai?: { provider: string; key: string; model?: string };
  telegramToken?: string;
  /** Tokens van het AH-account (geen wachtwoord). */
  ah?: { accessToken: string; refreshToken: string; expiresAt: number; linkedAt: string };
};

export class Secrets {
  #path: string | null;
  #data: SecretData;

  constructor(path: string | null) {
    this.#path = path;
    this.#data = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  }

  get<K extends keyof SecretData>(key: K): SecretData[K] { return this.#data[key]; }

  set<K extends keyof SecretData>(key: K, value: SecretData[K] | undefined) {
    if (value === undefined) delete this.#data[key];
    else this.#data[key] = value;
    this.#save();
  }

  /** Het API-token voor MCP, OpenAPI en Home Assistant; wordt bij eerste gebruik aangemaakt. */
  apiToken(): string {
    const fromEnv = process.env.API_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    if (!this.#data.apiToken) this.set('apiToken', randomBytes(24).toString('base64url'));
    return this.#data.apiToken!;
  }

  #save() {
    if (!this.#path) return;
    const temp = this.#path + '.tmp';
    writeFileSync(temp, JSON.stringify(this.#data, null, 2), { mode: 0o600 });
    try { chmodSync(temp, 0o600); } catch { /* Windows */ }
    renameSync(temp, this.#path);
  }
}
