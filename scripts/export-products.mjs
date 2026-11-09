// Gedeelde productkennis exporteren naar src/data/products.json, zodat andere installaties
// minder bij AH en de AI hoeven te vragen.
//
//   node scripts/export-products.mjs data/weekmand.sqlite [src/data/products.json] > nieuw.json
//
// Alleen wat over producten gaat, niets over het huishouden:
// - ahSizes: kassa-id van een AH-product → verpakking ("300 g");
// - labels: productnaam (genormaliseerd) → categorie en soort, zoals de AI of jij ze indeelde;
//   alleen eten en drinken.
// Geen datums, aantallen, prijzen of bonnen. Een bestaand bestand wordt aangevuld; de nieuwe
// gegevens gaan voor.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [dbPath, existingPath] = process.argv.slice(2);
if (!dbPath) {
  console.error('Gebruik: node scripts/export-products.mjs <weekmand.sqlite> [bestaande products.json]');
  process.exit(2);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const setting = (key, fallback) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(String(row.value)) : fallback;
};
const existing = existingPath ? JSON.parse(readFileSync(existingPath, 'utf8')) : {};

const saved = setting('productLabels', {});
// Zoals labelKey in src/budget.ts.
const labelKey = name => String(name).trim().toLowerCase().replace(/\s+/g, ' ');
// Welk product hoort bij een kassa-id (uit de bonnen), om niet-eten over te slaan.
const nameOf = new Map();
for (const row of db.prepare("SELECT body FROM spending WHERE source = 'ah'").all()) {
  for (const l of JSON.parse(String(row.body)).lines ?? []) if (l.productId) nameOf.set(l.productId, l.name);
}
const notFood = id => { const v = saved[labelKey(nameOf.get(id) ?? '')]; return v && (v.kind === 'geen-eten' || v.category === 'overig'); };

const ahSizes = { ...existing.ahSizes };
for (const [id, v] of Object.entries(setting('ahSizes', {}))) {
  if (/^\d{1,12}$/.test(id) && typeof v?.pack === 'string' && v.pack.trim() && !notFood(id)) ahSizes[id] = v.pack.trim().slice(0, 60);
}
const labels = { ...existing.labels };
for (const [key, v] of Object.entries(saved)) {
  // Alleen eten en drinken: niet-eten (verzorging, medicijnen, luiers) zegt te veel over een huishouden.
  if ((v?.by === 'ai' || v?.by === 'user') && key.length <= 120 && v.category && v.kind && v.kind !== 'geen-eten' && v.category !== 'overig') labels[key] = { category: v.category, kind: v.kind };
}

const sorted = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
process.stdout.write(JSON.stringify({
  about: 'Gedeelde productkennis voor Weekmand: AH-verpakkingen per kassa-id en de indeling van productnamen. Gemaakt met scripts/export-products.mjs.',
  ahSizes: sorted(ahSizes),
  labels: sorted(labels),
}, null, 1) + '\n');
