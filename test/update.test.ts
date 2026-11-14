import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changelog, paragraphs, Updates } from '../src/update.ts';

const sha = (n: number) => n.toString(16).padStart(40, '0');
const commit = (id: number, parents: number[], message: string, date = '2026-11-13T10:00:00Z') =>
  ({ sha: sha(id), parents: parents.map(p => ({ sha: sha(p) })), commit: { message, committer: { date } } });

// base(1) → PR #11 met commit A(2) → merge M1(3) → losse commit D(4) → PR #12 met B1(5), B2(6) → merge M2(7)
const commits = [
  commit(2, [1], 'Besteld telt mee\n\nNa het afrekenen is de Picnic-mand leeg. Weekmand telt de\ngeplaatste bestelling nu mee.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'),
  commit(3, [1, 2], 'Merge pull request #11 from RoanWassink/besteld-telt-mee\n\nBestelling telt mee na het afrekenen'),
  commit(4, [3], 'README: kopje over updates\n\n- installeren\n- bijwerken vanuit de webapp'),
  commit(5, [4], 'Updatemelding rechtsboven'),
  commit(6, [5], 'Updater op de router\n\nAls root, met back-up en terugval.'),
  commit(7, [4, 6], 'Merge pull request #12 from RoanWassink/updates\n\nUpdates vanaf GitHub', '2026-11-14T09:00:00Z'),
];

test('changelog: één regel per pull request, losse commits apart, nieuwste bovenaan', () => {
  const entries = changelog(commits);
  assert.deepEqual(entries.map(e => [e.title, e.pr]), [['Updates vanaf GitHub', 12], ['README: kopje over updates', undefined], ['Bestelling telt mee na het afrekenen', 11]]);
  assert.deepEqual(entries[0].details, [{ text: 'Updatemelding rechtsboven', heading: true }, { text: 'Updater op de router', heading: true }, { text: 'Als root, met back-up en terugval.' }]);
  assert.deepEqual(entries[1].details, [{ text: 'installeren' }, { text: 'bijwerken vanuit de webapp' }]);
  assert.deepEqual(entries[2].details, [{ text: 'Na het afrekenen is de Picnic-mand leeg. Weekmand telt de geplaatste bestelling nu mee.' }], 'afgebroken regels weer één zin, zonder Co-Authored-By');
  assert.equal(entries[0].date, '2026-11-14T09:00:00Z');
  assert.deepEqual(paragraphs(['een', 'twee', '', '* drie', 'vier']), ['een twee', 'drie vier']);
});

test('changelog: takken die op elkaar voortbouwen tellen gedeelde commits één keer', () => {
  // X(2) gaat via PR #7 naar main; de tak van PR #9 bouwde daarop voort met Y(3).
  const stacked = [
    commit(2, [1], 'Zoekvenster zichtbaar'),
    commit(3, [2], 'Lidl Plus: kassabonnen'),
    commit(4, [1, 2], 'Merge pull request #7 from x/zoeken\n\nZoekvenster zichtbaar'),
    commit(5, [4, 3], 'Merge pull request #9 from x/lidl\n\nLidl Plus: kassabonnen in budget'),
  ];
  const entries = changelog(stacked);
  assert.deepEqual(entries.map(e => [e.pr, e.title]), [[9, 'Lidl Plus: kassabonnen in budget'], [7, 'Zoekvenster zichtbaar']]);
  assert.deepEqual(entries[0].details, [], 'alleen de eigen commit Y, zonder uitleg; niet ook X');
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'weekmand-update-'));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'release.json'), JSON.stringify({ commit: sha(1), source: 'local', dirty: false, at: '2026-11-13T18:00:00Z' }));
  let calls = 0;
  let reply: () => Response = () => new Response(JSON.stringify({ status: 'ahead', ahead_by: commits.length, commits }), { status: 200 });
  const clock = { now: Date.parse('2026-11-14T10:00:00Z') };
  const updates = new Updates({
    dataDir: join(root, 'data'), releaseFile: join(root, 'release.json'), now: () => clock.now,
    fetch: (async (url: string) => {
      // Versie en changenotes: gewone bestanden van de nieuwste commit.
      if (String(url) === `https://raw.githubusercontent.com/RoanWassink/weekmand/${sha(7)}/package.json`) return new Response('{"version":"2.2.0"}');
      if (String(url) === `https://raw.githubusercontent.com/RoanWassink/weekmand/${sha(7)}/CHANGELOG.md`) {
        return new Response('# Wat er nieuw is\n\n## 2.2.0 — 20 november 2026\n- Recepten voor deze week verplaatst naar Recepten → Deze week.\n- Mand per gerecht,\n  of per afdeling.\n\n## 2.1.0\n- Updates via de site.\n\n## 2.0.0\n- Eerste versie.\n');
      }
      calls++;
      assert.match(String(url), /^https:\/\/api\.github\.com\/repos\/RoanWassink\/weekmand\/compare\/0{39}1\.\.\.main$/);
      return reply();
    }) as typeof fetch,
  });
  return { root, updates, clock, calls: () => calls, setReply: (r: () => Response) => { reply = r; } };
}

test('updates: vergelijken met main, kopbalk wacht nooit, verzoek alleen voor de getoonde versie', async t => {
  const { root, updates, clock, calls, setReply } = setup();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(updates.enabled, true);
  // De kopbalk wacht niet: eerst niets, ondertussen kijkt Weekmand op de achtergrond.
  assert.deepEqual(updates.summary(), { available: false, count: 0, running: false });
  const result = await updates.check();
  assert.equal(calls(), 1, 'één vergelijking, gedeeld met de achtergrondcontrole');
  assert.deepEqual([result.available, result.latest, result.count], [true, sha(7), 3]);
  // Wat draait heeft geen versienummer (van vóór het versiebeheer): dat is 2.0.0.
  assert.equal(updates.installed()!.version, '2.0.0');
  assert.equal(result.version, '2.2.0');
  assert.deepEqual(result.notes, [
    { version: '2.2.0', date: '20 november 2026', items: ['Recepten voor deze week verplaatst naar Recepten → Deze week.', 'Mand per gerecht, of per afdeling.'] },
    { version: '2.1.0', items: ['Updates via de site.'] },
  ], 'alleen nieuwer dan wat draait; doorlopende regels horen bij hun punt');
  assert.deepEqual(updates.summary(), { available: true, count: 3, running: false, version: '2.2.0' });
  // Binnen de minuut niet opnieuw naar GitHub, ook niet als de gebruiker erom vraagt.
  await updates.check(true);
  assert.equal(calls(), 1);
  clock.now += 61_000;
  await updates.check(true);
  assert.equal(calls(), 2);

  // Zonder updater op deze machine (geen map update/ naast data/) kan er niets aangevraagd worden.
  assert.equal(updates.canInstall, false);
  assert.throws(() => updates.request(sha(7)), /alleen op de router/);
  mkdirSync(join(root, 'update'));
  assert.equal(updates.canInstall, true);
  assert.throws(() => updates.request(sha(6)), /Kijk eerst opnieuw/, 'alleen de versie waarvan je de changelog zag');
  assert.throws(() => updates.request('../../etc'), /Onbekende versie/);
  updates.request(sha(7));
  assert.equal(readFileSync(join(root, 'data', 'update-request'), 'utf8'), sha(7) + '\n');
  writeFileSync(join(root, 'update', 'status.json'), JSON.stringify({ state: 'running', step: 'Downloaden', commit: sha(7), at: '2026-11-14T10:01:00Z' }));
  assert.equal(updates.summary()!.running, true);
  assert.throws(() => updates.request(sha(7)), /loopt al een update/);

  // GitHub onbereikbaar: het vorige resultaat blijft, met de fout erbij.
  setReply(() => { throw new Error('getaddrinfo ENOTFOUND'); });
  clock.now += 7 * 36e5;
  const offline = await updates.check();
  assert.equal(offline.available, true);
  assert.match(offline.error!, /niet bereikbaar/);
  // De geïnstalleerde commit staat niet op GitHub (lokaal gebouwd): geen update, wel een signaal.
  setReply(() => new Response('{}', { status: 404 }));
  clock.now += 7 * 36e5;
  const local = await updates.check();
  assert.deepEqual([local.available, local.diverged], [false, true]);
});

test('updates: zonder release.json (ontwikkelen) staat alles uit', async () => {
  const updates = new Updates({ dataDir: null, releaseFile: join(tmpdir(), 'bestaat-niet', 'release.json') });
  assert.equal(updates.enabled, false);
  assert.equal(updates.summary(), null);
  await assert.rejects(updates.check(), /uitgerolde Weekmand/);
});

test('updater (root): weigert vreemde verzoeken, een andere versie dan main en ongecontroleerde pakketten', async t => {
  const root = mkdtempSync(join(tmpdir(), 'weekmand-updater-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'data'));
  process.env.WEEKMAND_ROOT = root;
  const updater = await import('../deploy/updater.mjs');
  const status = () => JSON.parse(readFileSync(join(root, 'update', 'status.json'), 'utf8'));

  await updater.main(); // geen verzoek: niets
  assert.equal(existsSync(join(root, 'update', 'status.json')), false);

  writeFileSync(join(root, 'data', 'update-request'), 'rm -rf /\n');
  await updater.main();
  assert.equal(status().message, 'Ongeldig updateverzoek.');
  assert.equal(existsSync(join(root, 'data', 'update-request')), false, 'verzoek is opgeruimd');

  // main op GitHub is een andere commit dan gevraagd: niets installeren.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    assert.equal(url, 'https://api.github.com/repos/RoanWassink/weekmand/commits/main');
    return new Response(sha(8), { status: 200 });
  }) as typeof fetch;
  try {
    writeFileSync(join(root, 'data', 'update-request'), sha(7));
    await updater.main();
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual([status().state, status().commit], ['failed', sha(7)]);
  assert.match(status().message, /andere versie/);
  assert.equal(existsSync(join(root, 'update', 'lock')), false, 'slot weer vrij');

  // Afhankelijkheden: alleen van npm, met een kloppend controlegetal en zonder installatiescript.
  const release = join(root, 'releases', 'r1');
  mkdirSync(release, { recursive: true });
  const lock = (meta: Record<string, unknown>) => writeFileSync(join(release, 'package-lock.json'), JSON.stringify({ packages: { '': {}, 'node_modules/x': { version: '1.0.0', ...meta } } }));
  const tarball = async () => Buffer.from('niet het echte pakket');
  lock({ resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity: 'sha512-' + Buffer.alloc(64).toString('base64') });
  await assert.rejects(updater.installFromLock(release, tarball), /Controlegetal klopt niet voor x/);
  lock({ resolved: 'https://example.com/x.tgz', integrity: 'sha512-abc' });
  await assert.rejects(updater.installFromLock(release, tarball), /Onbekende bron voor x/);
  lock({ resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity: 'sha512-abc', hasInstallScript: true });
  await assert.rejects(updater.installFromLock(release, tarball), /installatiescript/);
  lock({ resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity: 'sha512-abc', dev: true });
  assert.equal(await updater.installFromLock(release, tarball), 0, 'ontwikkelpakketten slaat hij over');

  writeFileSync(join(root, 'config.env'), 'APP_PASSWORD=x\nUPDATE_REPO="iemand/weekmand-fork"\n');
  assert.equal(updater.readRepo(root), 'iemand/weekmand-fork');
  writeFileSync(join(root, 'config.env'), 'UPDATE_REPO=https://evil.example/x\n');
  assert.equal(updater.readRepo(root), 'RoanWassink/weekmand');
});
