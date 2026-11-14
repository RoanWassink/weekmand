// Weekmand-updater. Draait als root (via /etc/init.d/weekmand-updater) en doet pas iets als de
// webapp een verzoek heeft neergelegd in data/update-request: de commit die de gebruiker koos.
//
// Veiligheid: de webapp (gebruiker nobody) kan alleen om een update vragen. De updater installeert
// uitsluitend de commit die op dat moment de top van main is in de ingestelde GitHub-repo; staat er
// iets anders, dan weigert hij. Afhankelijkheden komen uit de vorige versie (zelfde lockbestand) of
// van registry.npmjs.org met het sha512-controlegetal uit package-lock.json, zonder installatiescripts.
// Daarna dezelfde stappen als een uitrol vanaf de pc: back-up, activate.sh, gezondheidscontrole en
// zo nodig terug naar de vorige versie.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chownSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.WEEKMAND_ROOT || '/opt/weekmand';
const DATA = join(ROOT, 'data');
const REQUEST = join(DATA, 'update-request');
const DIR = join(ROOT, 'update');
const STATUS = join(DIR, 'status.json');
const LOCK = join(DIR, 'lock');
const TMP = join(DIR, 'tmp');
const NOBODY = 65534;
const SHA = /^[0-9a-f]{40}$/;
const RELEASE = /^[a-z0-9-]+$/;
const DEFAULT_REPO = 'RoanWassink/weekmand';
// Proefdraaien: alles tot en met klaarzetten, maar geen back-up en niet activeren.
const DRY = process.env.WEEKMAND_UPDATER_DRY === '1';
// Afhankelijkheden altijd van npm halen, ook als het lockbestand niet veranderde (om dat pad te testen).
const FRESH_DEPS = process.env.WEEKMAND_UPDATER_FRESH_DEPS === '1';

export function setStatus(status) {
  mkdirSync(DIR, { recursive: true, mode: 0o755 });
  const body = JSON.stringify({ ...status, at: new Date().toISOString() });
  writeFileSync(STATUS + '.tmp', body, { mode: 0o644 });
  renameSync(STATUS + '.tmp', STATUS);
}

/** UPDATE_REPO uit config.env (zelfde instelling als de webapp), anders de standaardrepo. */
export function readRepo(root = ROOT) {
  try {
    const line = readFileSync(join(root, 'config.env'), 'utf8').split('\n').find(l => /^\s*UPDATE_REPO\s*=/.test(l));
    const value = line?.split('=')[1]?.trim().replace(/^["']|["']$/g, '');
    if (value && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return value;
  } catch {}
  return DEFAULT_REPO;
}

async function download(url, maxBytes, accept) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Weekmand-updater', ...(accept ? { Accept: accept } : {}) }, redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${new URL(url).host} antwoordde ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('Download is groter dan verwacht.');
  return buffer;
}

/** Pak een .tgz uit in een lege map en geef de ene map erin terug (GitHub: weekmand-<sha>, npm: package). */
function untar(buffer, name) {
  rmSync(join(TMP, name), { recursive: true, force: true });
  mkdirSync(join(TMP, name), { recursive: true });
  const file = join(TMP, name + '.tgz');
  writeFileSync(file, buffer, { mode: 0o600 });
  const result = spawnSync('tar', ['-xzf', file, '-C', join(TMP, name)], { encoding: 'utf8' });
  rmSync(file, { force: true });
  if (result.status !== 0) throw new Error('Uitpakken mislukt: ' + (result.stderr || '').trim().slice(-200));
  const entries = readdirSync(join(TMP, name));
  if (entries.length !== 1 || !statSync(join(TMP, name, entries[0])).isDirectory()) throw new Error('Onverwachte inhoud in het archief.');
  return join(TMP, name, entries[0]);
}

/** Afhankelijkheden precies volgens package-lock.json, rechtstreeks van npm en gecontroleerd. */
export async function installFromLock(release, fetchTarball = url => download(url, 30 * 1048576)) {
  const lock = JSON.parse(readFileSync(join(release, 'package-lock.json'), 'utf8'));
  let n = 0;
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith('node_modules/') || meta.dev || meta.link) continue;
    if (meta.os && !meta.os.includes(process.platform)) continue;
    if (meta.cpu && !meta.cpu.includes(process.arch)) continue;
    const target = normalize(join(release, path));
    if (!target.startsWith(join(release, 'node_modules')) || path.split('/').includes('..')) throw new Error('Ongeldig pad in package-lock.json: ' + path);
    if (meta.hasInstallScript) throw new Error(`${path.slice(13)} heeft een installatiescript. Werk deze versie bij vanaf de pc.`);
    if (typeof meta.resolved !== 'string' || !meta.resolved.startsWith('https://registry.npmjs.org/')) throw new Error('Onbekende bron voor ' + path.slice(13));
    const expected = String(meta.integrity ?? '').split(/\s+/).find(i => i.startsWith('sha512-'));
    if (!expected) throw new Error('Geen controlegetal voor ' + path.slice(13));
    const tarball = await fetchTarball(meta.resolved);
    if ('sha512-' + createHash('sha512').update(tarball).digest('base64') !== expected) throw new Error('Controlegetal klopt niet voor ' + path.slice(13));
    const unpacked = untar(tarball, 'pkg-' + n++);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { recursive: true, force: true });
    renameSync(unpacked, target);
  }
  return n;
}

function backupData(release) {
  const target = join(ROOT, 'backups', 'data-voor-' + release);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  return target;
}

async function update(repo, sha) {
  setStatus({ state: 'running', step: 'Versie controleren', commit: sha });
  const head = (await download(`https://api.github.com/repos/${repo}/commits/main`, 1024, 'application/vnd.github.sha')).toString('utf8').trim();
  if (head !== sha) throw new Error('Op GitHub staat intussen een andere versie. Kijk opnieuw in Weekmand en kies dan Updaten.');
  const current = readFileSync(join(ROOT, 'current'), 'utf8').trim();
  if (!RELEASE.test(current)) throw new Error('Onbekende actieve versie.');
  const currentDir = join(ROOT, 'releases', current);
  try {
    const running = JSON.parse(readFileSync(join(currentDir, 'release.json'), 'utf8'));
    if (!DRY && running.commit === sha && !running.dirty) {
      setStatus({ state: 'done', commit: sha, release: current, message: 'Deze versie draait al.' });
      return;
    }
  } catch {}

  setStatus({ state: 'running', step: 'Downloaden', commit: sha });
  const source = untar(await download(`https://codeload.github.com/${repo}/tar.gz/${sha}`, 50 * 1048576), 'source');
  for (const file of ['src/server.ts', 'package.json', 'package-lock.json', 'deploy/activate.sh', 'deploy/weekmand.init']) {
    if (!existsSync(join(source, file))) throw new Error(`De versie op GitHub mist ${file}.`);
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const release = `${stamp}-${sha.slice(0, 8)}`;
  const target = join(ROOT, 'releases', release);
  renameSync(source, target);
  let activated = false;
  try {
    setStatus({ state: 'running', step: 'Onderdelen installeren', commit: sha });
    const sameLock = existsSync(join(currentDir, 'node_modules')) && readFileSync(join(currentDir, 'package-lock.json'), 'utf8') === readFileSync(join(target, 'package-lock.json'), 'utf8');
    let deps = 'uit de vorige versie';
    if (sameLock && !FRESH_DEPS) cpSync(join(currentDir, 'node_modules'), join(target, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    else deps = `${await installFromLock(target)} van npm`;
    writeFileSync(join(target, 'release.json'), JSON.stringify({ commit: sha, source: 'github', repo, at: new Date().toISOString() }) + '\n', { mode: 0o644 });
    if (DRY) {
      const ok = existsSync(join(target, 'node_modules', 'picnic-api', 'package.json'));
      setStatus({ state: ok ? 'done' : 'failed', commit: sha, release, message: `Proef: gedownload en klaargezet, afhankelijkheden ${deps}${ok ? '' : ', maar picnic-api ontbreekt'}; niet geactiveerd.` });
      return;
    }

    setStatus({ state: 'running', step: 'Back-up maken', commit: sha });
    const saved = backupData(release);
    const db = new DatabaseSync(join(DATA, 'weekmand.sqlite'), { readOnly: true });
    try { await backup(db, join(saved, 'weekmand.sqlite')); } finally { db.close(); }
    if (existsSync(join(DATA, 'secrets.json'))) copyFileSync(join(DATA, 'secrets.json'), join(saved, 'secrets.json'));
    for (const f of ['', 'weekmand.sqlite', 'secrets.json']) if (existsSync(join(saved, f))) chownSync(join(saved, f), NOBODY, NOBODY);

    setStatus({ state: 'running', step: 'Nieuwe versie starten', commit: sha, release });
    const run = spawnSync('sh', [join(target, 'deploy', 'activate.sh'), ROOT, release], {
      encoding: 'utf8', timeout: 240_000, env: { ...process.env, WEEKMAND_FROM_UPDATER: '1' },
    });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
    if (run.status !== 0) throw new Error('De nieuwe versie startte niet goed; de vorige draait weer. ' + output.split('\n').slice(-3).join(' '));
    activated = true;
    setStatus({ state: 'done', commit: sha, release, message: 'Bijgewerkt.' });
    console.log('Weekmand bijgewerkt naar', release);
  } finally {
    // Niet geactiveerd: de half geïnstalleerde map opruimen (nooit de actieve versie).
    if (!activated && readFileSync(join(ROOT, 'current'), 'utf8').trim() !== release) rmSync(target, { recursive: true, force: true });
  }
}

export async function main() {
  let sha;
  try {
    const info = lstatSync(REQUEST);
    sha = info.isFile() && info.size <= 100 ? readFileSync(REQUEST, 'utf8').trim() : '';
    unlinkSync(REQUEST);
  } catch { return; } // geen verzoek
  if (!SHA.test(sha)) { setStatus({ state: 'failed', message: 'Ongeldig updateverzoek.' }); return; }
  mkdirSync(DIR, { recursive: true, mode: 0o755 });
  // Een slot tegen twee updates tegelijk; een slot ouder dan een half uur is van een vastgelopen poging.
  try { if (Date.now() - statSync(LOCK).mtimeMs > 30 * 60_000) rmSync(LOCK, { recursive: true, force: true }); } catch {}
  try { mkdirSync(LOCK); } catch { setStatus({ state: 'failed', commit: sha, message: 'Er loopt al een update.' }); return; }
  try {
    await update(readRepo(), sha);
  } catch (error) {
    console.error('Weekmand-update mislukt:', error.message);
    setStatus({ state: 'failed', commit: sha, message: error.message });
  } finally {
    rmSync(TMP, { recursive: true, force: true });
    rmSync(LOCK, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
