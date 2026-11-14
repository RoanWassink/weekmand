import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './errors.ts';

/**
 * Updates vanaf de publieke GitHub-repo.
 *
 * De webapp kijkt (zonder te wachten) of er op `main` nieuwere commits staan dan de geïnstalleerde
 * versie en maakt daar een changelog van. Bijwerken zelf doet Weekmand niet: dat mag de webapp
 * (gebruiker nobody) niet. Hij legt alleen een verzoek neer; de updater op de router (root,
 * deploy/updater.mjs) haalt precies die commit op, maakt een back-up en activeert de nieuwe versie
 * met dezelfde gezondheidscontrole en terugval als een gewone uitrol.
 */

/** Zo vaak kijkt Weekmand vanzelf naar GitHub (zonder token mag dat 60 keer per uur). */
const CHECK_INTERVAL = 36e5;
/** "Zoek naar updates" en "Opnieuw kijken" in de webapp: hooguit eens per minuut echt naar GitHub. */
const FORCE_INTERVAL = 60_000;

/** De versie die draait. Een uitrol legt release.json naast src/; zonder dat bestand (ontwikkelen) geen updates. */
export type Installed = { commit: string; dirty?: boolean; source?: 'github' | 'local'; at?: string };
/** details: de uitleg; bij een pull request met meer commits staat elke committitel er als kopje tussen. */
export type ChangeEntry = { title: string; pr?: number; date: string; sha: string; details: { text: string; heading?: boolean }[] };
export type UpdateStatus = { state: 'idle' | 'running' | 'done' | 'failed'; step?: string; message?: string; commit?: string; release?: string; at: string };
/** Eén versie uit CHANGELOG.md: in gewone taal wat er verandert. */
export type ReleaseNotes = { version: string; date?: string; items: string[] };
export type UpdateCheck = {
  checkedAt: string; available: boolean; latest: string | null; count: number; changes: ChangeEntry[];
  /** Versienummer op GitHub en de punten uit CHANGELOG.md die nieuwer zijn dan wat draait. */
  version?: string; notes?: ReleaseNotes[];
  /** De geïnstalleerde versie staat niet (meer) op main: bijvoorbeeld lokaal uitgerold vanaf een branch. */
  diverged?: boolean; error?: string;
};

type Commit = { sha: string; parents: { sha: string }[]; commit: { message: string; author?: { date?: string }; committer?: { date?: string } } };

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Versienummers vergelijken (2.10.0 is nieuwer dan 2.9.1). */
export function newer(a: string, b: string) {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** CHANGELOG.md lezen: kopjes "## 2.1.0 — 14 november 2026" met daaronder punten "- ...". */
export function parseChangelog(markdown: string): ReleaseNotes[] {
  const notes: ReleaseNotes[] = [];
  for (const raw of markdown.replace(/\r/g, '').split('\n')) {
    const head = /^##\s+v?(\d+(?:\.\d+){0,2})\s*(?:[—–-]\s*(.+))?$/.exec(raw.trim());
    if (head) { notes.push({ version: head[1], ...(head[2] ? { date: head[2].trim() } : {}), items: [] }); continue; }
    const item = /^\s*[-*]\s+(.+)$/.exec(raw);
    const last = notes.at(-1);
    if (item && last) last.items.push(item[1].trim());
    else if (last?.items.length && /^\s{2,}\S/.test(raw)) last.items[last.items.length - 1] += ' ' + raw.trim();
  }
  return notes;
}

/** Commitberichten zijn op 72 tekens afgebroken: weer hele alinea's maken; opsommingen blijven losse punten. */
export function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let current = '';
  const flush = () => { if (current) out.push(current); current = ''; };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (/^(Co-Authored-By|Signed-off-by):/i.test(line)) continue;
    if (/^[-*•]\s+/.test(line)) { flush(); current = line.replace(/^[-*•]\s+/, ''); continue; }
    current = current ? current + ' ' + line : line;
  }
  flush();
  return out;
}

/**
 * Changelog uit de commits tussen de geïnstalleerde versie en main (oud naar nieuw, zoals GitHub ze
 * geeft). Per samengevoegde pull request één regel met de titel van de PR; wat de commits daarin
 * zeggen wordt de uitleg. Losse commits op main krijgen een eigen regel. Nieuwste bovenaan.
 */
export function changelog(commits: Commit[]): ChangeEntry[] {
  const bySha = new Map(commits.map(c => [c.sha, c]));
  const order = new Map(commits.map((c, i) => [c.sha, i]));
  const lines = (c: Commit) => c.commit.message.replace(/\r/g, '').split('\n');
  const title = (c: Commit) => lines(c)[0].trim();
  const body = (c: Commit) => paragraphs(lines(c).slice(1));
  const date = (c: Commit) => c.commit.committer?.date ?? c.commit.author?.date ?? '';
  const parent = (c: Commit, i = 0) => bySha.get(c.parents[i]?.sha ?? '');
  // De hoofdlijn: vanaf de nieuwste commit steeds de eerste ouder.
  const main: Commit[] = [];
  const onMain = new Set<string>();
  for (let c = commits.at(-1); c && !onMain.has(c.sha); c = parent(c)) { main.unshift(c); onMain.add(c.sha); }
  // Van oud naar nieuw: een commit hoort bij de eerste pull request die hem op main bracht. Takken die
  // op elkaar voortbouwen tellen zo hun gedeelde commits maar één keer.
  const seen = new Set<string>();
  const entries = main.map((c): ChangeEntry => {
    seen.add(c.sha);
    if (c.parents.length < 2) return { title: title(c), date: date(c), sha: c.sha, details: body(c).slice(0, 30).map(text => ({ text })) };
    const inside: Commit[] = [];
    const todo = [c.parents[1].sha];
    while (todo.length && inside.length < 30) {
      const p = bySha.get(todo.pop()!);
      if (!p || seen.has(p.sha)) continue;
      seen.add(p.sha);
      inside.push(p);
      todo.push(...p.parents.map(x => x.sha));
    }
    inside.sort((a, b) => order.get(a.sha)! - order.get(b.sha)!); // volgorde van GitHub: oud naar nieuw
    const pr = /^Merge pull request #(\d+)\b/.exec(title(c));
    const prTitle = body(c)[0] ?? (inside.at(-1) ? title(inside.at(-1)!) : title(c));
    // Eén commit: alleen zijn uitleg (de titel is die van de PR). Meer: per commit een kopje met uitleg.
    const details = inside.length === 1 ? body(inside[0]).map(text => ({ text }))
      : inside.flatMap(p => [{ text: title(p), heading: true }, ...body(p).map(text => ({ text }))]);
    return { title: prTitle, ...(pr ? { pr: Number(pr[1]) } : {}), date: date(c), sha: c.sha, details: details.slice(0, 30) };
  });
  return entries.reverse();
}

export class Updates {
  readonly repo: string;
  readonly enabled: boolean;
  #releaseFile: string;
  #requestFile: string;
  #statusFile: string;
  #fetch: typeof fetch;
  #now: () => number;
  #last: UpdateCheck | null = null;
  #lastAt = 0;
  #checking: Promise<UpdateCheck> | null = null;

  constructor(options: {
    dataDir: string | null; repo?: string; releaseFile?: string; statusFile?: string;
    fetch?: typeof fetch; now?: () => number; enabled?: boolean;
  }) {
    const repo = options.repo || 'RoanWassink/weekmand';
    this.repo = REPO.test(repo) ? repo : 'RoanWassink/weekmand';
    this.#releaseFile = options.releaseFile ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'release.json');
    // Op de router: /opt/weekmand/data (van de app) en /opt/weekmand/update (van root).
    this.#requestFile = options.dataDir ? join(options.dataDir, 'update-request') : '';
    this.#statusFile = options.statusFile ?? (options.dataDir ? join(dirname(options.dataDir), 'update', 'status.json') : '');
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.enabled = (options.enabled ?? true) && !!this.installed();
  }

  installed(): (Installed & { version: string }) | null {
    try {
      const value = JSON.parse(readFileSync(this.#releaseFile, 'utf8').replace(/^\uFEFF/, ''));
      return value && SHA.test(value.commit) ? { ...value, version: this.#version() } : null;
    } catch { return null; }
  }

  /** Het versienummer van wat draait: package.json naast release.json. */
  #version() {
    // Zonder versie in package.json: van vóór het versiebeheer, toen heette alles 2.0.0.
    try { return String(JSON.parse(readFileSync(join(dirname(this.#releaseFile), 'package.json'), 'utf8')).version ?? '2.0.0'); } catch { return '2.0.0'; }
  }

  /** Staat de updater op deze machine? Die schrijft zijn status naast de data, als root. */
  get canInstall() { return this.enabled && !!this.#statusFile && existsSync(dirname(this.#statusFile)); }

  status(): UpdateStatus | null {
    if (!this.#statusFile) return null;
    try { return JSON.parse(readFileSync(this.#statusFile, 'utf8')); } catch { return null; }
  }

  /** Voor de kopbalk: het laatste resultaat, zonder te wachten. Te oud, dan op de achtergrond opnieuw kijken. */
  summary() {
    if (!this.enabled) return null;
    if (this.#now() - this.#lastAt >= CHECK_INTERVAL || this.#now() < this.#lastAt) this.check().catch(() => {});
    const last = this.#last;
    const status = this.status();
    return { available: !!last?.available, count: last?.count ?? 0, running: status?.state === 'running', ...(last?.version ? { version: last.version } : {}) };
  }

  /** Vergelijk met main op GitHub. `force`: de gebruiker vraagt erom (hooguit eens per minuut echt). */
  async check(force = false): Promise<UpdateCheck> {
    check(this.enabled, 'Updates werken alleen in een uitgerolde Weekmand.', 409);
    const age = this.#now() - this.#lastAt;
    if (this.#last && age >= 0 && age < (force ? FORCE_INTERVAL : CHECK_INTERVAL)) return this.#last;
    return this.#checking ??= this.#compare().finally(() => { this.#checking = null; });
  }

  async #compare(): Promise<UpdateCheck> {
    const installed = this.installed()!;
    const checkedAt = new Date(this.#now()).toISOString();
    try {
      const response = await this.#fetch(`https://api.github.com/repos/${this.repo}/compare/${installed.commit}...main`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Weekmand', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) {
        // De geïnstalleerde commit kent GitHub niet: lokaal gebouwd en (nog) niet gepusht.
        return this.#remember({ checkedAt, available: false, latest: null, count: 0, changes: [], diverged: true });
      }
      if (!response.ok) throw new Error(`GitHub antwoordde ${response.status}`);
      const data = await response.json() as { status: string; ahead_by: number; commits: Commit[] };
      const commits = Array.isArray(data.commits) ? data.commits.filter(c => SHA.test(c?.sha)) : [];
      const latest = commits.at(-1)?.sha ?? null;
      const available = data.status === 'ahead' && data.ahead_by > 0 && !!latest;
      const changes = available ? changelog(commits).slice(0, 50) : [];
      const release = available ? await this.#releaseNotes(latest!, installed.version ?? this.#version()) : {};
      return this.#remember({ checkedAt, available, latest: available ? latest : null, count: changes.length, changes, ...release, ...(data.status === 'diverged' || data.status === 'behind' ? { diverged: true } : {}) });
    } catch (error) {
      // Geen internet of GitHub weigert even: het vorige resultaat blijft staan, met de fout erbij.
      const failed = { ...(this.#last ?? { available: false, latest: null, count: 0, changes: [] }), checkedAt, error: 'GitHub was niet bereikbaar: ' + (error as Error).message };
      this.#lastAt = this.#now() - CHECK_INTERVAL + 30 * 60_000; // over een half uur opnieuw
      this.#last = failed;
      return failed;
    }
  }

  /** Versienummer en changenotes van de nieuwe versie (gewone bestanden in de repo, geen API-verzoeken). */
  async #releaseNotes(sha: string, current: string): Promise<{ version?: string; notes?: ReleaseNotes[] }> {
    const raw = async (file: string) => {
      const response = await this.#fetch(`https://raw.githubusercontent.com/${this.repo}/${sha}/${file}`, { headers: { 'User-Agent': 'Weekmand' }, signal: AbortSignal.timeout(15_000) });
      return response.ok ? response.text() : null;
    };
    try {
      const [pkg, log] = await Promise.all([raw('package.json'), raw('CHANGELOG.md')]);
      const version = pkg ? String(JSON.parse(pkg).version ?? '') : '';
      const notes = log ? parseChangelog(log).filter(n => newer(n.version, current) && n.items.length).slice(0, 10) : [];
      return { ...(version ? { version } : {}), ...(notes.length ? { notes } : {}) };
    } catch { return {}; }
  }

  #remember(result: UpdateCheck) {
    this.#last = result;
    this.#lastAt = this.#now();
    return result;
  }

  /**
   * Vraag de updater om precies `sha` te installeren: de versie waarvan de gebruiker de changelog zag.
   * Staat er intussen iets nieuwers op main, dan weigert de updater en kijk je opnieuw.
   */
  request(sha: unknown) {
    check(this.canInstall, 'Bijwerken kan alleen op de router met de Weekmand-updater.', 409);
    check(typeof sha === 'string' && SHA.test(sha), 'Onbekende versie.');
    check(this.#last?.available && this.#last.latest === sha, 'Kijk eerst opnieuw naar updates.', 409);
    check(this.status()?.state !== 'running', 'Er loopt al een update.', 409);
    if (existsSync(this.#requestFile)) check(!lstatSync(this.#requestFile).isSymbolicLink(), 'Ongeldig updateverzoek.', 409);
    const temp = this.#requestFile + '.tmp';
    writeFileSync(temp, sha + '\n', { mode: 0o600 });
    renameSync(temp, this.#requestFile);
    return { requested: sha, at: new Date(this.#now()).toISOString() };
  }

  /** Alles voor het updatevenster in de webapp. */
  async info(force = false) {
    const installed = this.installed();
    const result = this.enabled ? await this.check(force) : null;
    return { enabled: this.enabled, repo: this.repo, installed, canInstall: this.canInstall, status: this.status(), check: result };
  }
}

