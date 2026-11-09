import { decodeBarcode } from '/barcode.js';

const $ = id => document.getElementById(id);
const eur = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const money = cents => eur.format(cents / 100);
const num = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
const timeFmt = new Intl.DateTimeFormat('nl-NL', { hour: '2-digit', minute: '2-digit' });
const dayShort = date => new Intl.DateTimeFormat('nl-NL', { weekday: 'short', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));

let S = null;
let plan = null;
/** Het voorstel klopt niet meer helemaal: blijft staan tot het nieuwe er is (geen "laden…"). */
let planStale = false;
let planSeq = 0;
let planWrites = 0;
let busy = false;
let chatLoaded = false;
/** Het laatste voorstel staat ook op dit apparaat, zodat het na het heropenen van de app meteen in beeld is. */
const PLAN_KEY = 'weekmand-voorstel';
let planRestored = false;

// ───────────── Hulpjes ─────────────

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : String(child));
  return node;
}
const btn = (label, onclick, cls = '') => el('button', { type: 'button', class: cls, onclick }, label);
/** Vervang de inhoud van een element; lege waarden (null, false) worden overgeslagen. */
/** Eén iconenset (24px, lijn 1,75), in plaats van tekens of emoji. */
const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M7 10v10H4V10h3Zm0 0 4.2-6.3c.9-.3 2.2.3 2.1 1.6L12.8 9H18a2 2 0 0 1 2 2.3l-1.2 6.9A2 2 0 0 1 16.8 20H7"/>',
  down: '<g transform="rotate(180 12 12)"><path d="M7 10v10H4V10h3Zm0 0 4.2-6.3c.9-.3 2.2.3 2.1 1.6L12.8 9H18a2 2 0 0 1 2 2.3l-1.2 6.9A2 2 0 0 1 16.8 20H7"/></g>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M8 8v8M11 8v8M14 8v8M17 8v8"/>',
  swipe: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M4 12h16"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  truck: '<path d="M3 7h11v9H3zM14 10h3.5l3.5 3.5V16h-7"/><circle cx="7" cy="17.5" r="1.6"/><circle cx="17.5" cy="17.5" r="1.6"/>',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  return svg;
}
const iconBtn = (name, label, onclick, cls = '') => el('button', { type: 'button', class: 'icon-btn ' + cls, onclick, 'aria-label': label, title: label }, icon(name));
const put = (node, ...kids) => node.replaceChildren(...kids.flat().filter(k => k !== null && k !== undefined && k !== false));

// ───────────── Direct zoeken in lijsten ─────────────

const listQueries = {};
const fold = text => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Zoekveld boven een lijst; filtert terwijl je typt en onthoudt de zoekterm als de lijst opnieuw getekend wordt. */
function searchBox(id, label) {
  const input = el('input', { type: 'search', placeholder: label, 'aria-label': label, 'aria-controls': id, value: listQueries[id] ?? '' });
  input.oninput = () => { listQueries[id] = input.value; applyListSearch(id); };
  return el('label', { class: 'list-search', 'data-search-box': id }, icon('search'), input);
}

/** Verberg de regels van een lijst die niet bij de zoekterm passen. Bij korte lijsten blijft het zoekveld weg. */
function applyListSearch(id) {
  const list = document.getElementById(id);
  const box = document.querySelector(`[data-search-box="${id}"]`);
  if (!list) return;
  const query = fold((listQueries[id] ?? '').trim());
  const rows = [...list.children].filter(row => !row.matches('p, .search-empty'));
  let shown = 0;
  for (const row of rows) {
    const hit = !query || fold(row.textContent).includes(query);
    row.hidden = !hit;
    if (hit) shown++;
  }
  list.querySelector(':scope > .search-empty')?.remove();
  if (query && !shown) list.append(el('p', { class: 'hint search-empty' }, `Niets gevonden voor "${listQueries[id].trim()}".`));
  if (box) box.hidden = rows.length < 5 && !query;
}

// Vaste lijsten krijgen hun zoekveld één keer; de lijst van het voorstel maakt renderPlan zelf.
for (const [id, label] of [['pantry-menu', 'Zoek in het menu'], ['pantry-other', 'Zoek in je voorraad'], ['cart-lines', 'Zoek in je Picnic-mand']]) {
  document.getElementById(id).before(searchBox(id, label));
}

async function api(path, data) {
  const response = await fetch(path.startsWith('/') ? path : '/api/ui/' + path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const json = await response.json().catch(() => ({}));
  if (response.status === 401 && json.login) { showLogin(); throw new Error('Log eerst in.'); }
  if (!response.ok) throw new Error(json.error ?? 'Aanvraag mislukt.');
  return json;
}

let toastTimer;
function toast(message, error = false) {
  const t = $('toast');
  t.textContent = message;
  t.className = error ? 'error' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.textContent = ''; }, error ? 7000 : 3500);
}

/** Voer een actie uit met knoppen geblokkeerd en een foutmelding als het misgaat. */
async function run(fn, { reload = true } = {}) {
  if (busy) return;
  busy = true;
  document.body.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    const result = await fn();
    if (reload) await load();
    return result;
  } catch (error) {
    toast(error.message, true);
  } finally {
    busy = false;
    document.body.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
}

function dialog(title, ...content) {
  $('dialog-title').textContent = title;
  put($('dialog-body'), ...content);
  if (!$('dialog').open) $('dialog').showModal();
}
const closeDialog = () => $('dialog').close();
$('dialog-close').onclick = closeDialog;
$('dialog-close').append(icon('x'));

const ingredientName = key => S?.ingredients.find(i => i.key === key)?.name ?? key;

// ───────────── Tabs ─────────────

/** Recepten hoort bij Week (schakelaar bovenaan); Chat zit rechtsboven en heeft geen tab. */
const navTab = name => name === 'recipes' ? 'week' : name === 'chat' ? null : name;

function showTab(name) {
  for (const b of $('tabs').querySelectorAll('button')) {
    const on = b.dataset.tab === navTab(name);
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  $('chat-button').classList.toggle('active', name === 'chat');
  if (name === 'chat') { $('chat-button').setAttribute('aria-current', 'page'); markNoticesSeen(); } else $('chat-button').removeAttribute('aria-current');
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('active', s.id === 'tab-' + name);
  history.replaceState(null, '', '#' + name);
  window.scrollTo({ top: 0 });
  if (name === 'chat' && !chatLoaded) loadChat();
  if (name === 'cart' && S?.shop.ready) { if (!plan) run(calculate, { reload: false }); else if (planStale) scheduleCalc(); }
  if (name === 'pantry') loadPlanQuietly();
  if (name === 'budget') loadBudget();
}
$('tabs').onclick = e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); };
$('chat-button').onclick = () => showTab('chat');

// Terug in de app na een tijdje (bijv. na een wijziging via Telegram): de stand en de mand opnieuw ophalen.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !S || busy || Date.now() - lastLoad < 30_000) return;
  planStale = true;
  load().then(() => { if ($('tab-budget').classList.contains('active')) loadBudget(); }).catch(() => {});
});

// Het puntje op de chatknop: alleen voor meldingen die nieuwer zijn dan je laatste bezoek aan de chat.
const SEEN_KEY = 'weekmand-meldingen-gezien';
function noticesSeen() { try { return localStorage.getItem(SEEN_KEY) ?? ''; } catch { return ''; } }
function markNoticesSeen() {
  const newest = S?.notices?.[0]?.at;
  if (newest) { try { localStorage.setItem(SEEN_KEY, newest); } catch { /* privévenster */ } }
  renderUnread();
}
function renderUnread() {
  const newest = S?.notices?.[0]?.at ?? '';
  const unread = !!newest && newest > noticesSeen() && !$('tab-chat').classList.contains('active');
  $('chat-unread').hidden = !unread;
  $('chat-button').setAttribute('aria-label', unread ? 'Chat, nieuwe melding' : 'Chat');
}
window.addEventListener('hashchange', () => {
  const tab = location.hash.slice(1);
  if (['week', 'cart', 'pantry', 'budget', 'recipes', 'chat', 'more'].includes(tab) && !$('tab-' + tab).classList.contains('active')) showTab(tab);
});

// ───────────── Laden en tekenen ─────────────

let lastLoad = 0;
async function load() {
  S = await api('/api/state');
  lastLoad = Date.now();
  if (!planRestored) { planRestored = true; restorePlan(); }
  renderHeader();
  renderWeek();
  renderCart();
  renderPantry();
  renderChatMode();
  renderMore();
  renderRecipesTab();
}

function renderHeader() {
  $('shop-badge').textContent = S.shop.mode === 'picnic' ? (S.shop.ready ? 'Picnic' : 'Picnic · niet aangemeld') : 'Demo';
  const d = S.delivery;
  $('deadline').hidden = !d.cutOff;
  if (d.cutOff) {
    $('deadline').textContent = d.hoursLeft < 24 ? `Deadline over ${num.format(d.hoursLeft)} u` : `Deadline ${dayShort(new Date(d.cutOff).toISOString().slice(0, 10))} ${timeFmt.format(new Date(d.cutOff))}`;
    $('deadline').classList.toggle('urgent', d.hoursLeft < 6);
  }
  $('version').textContent = 'Weekmand ' + S.version;
  renderUnread();
}

function renderWeek() {
  const d = S.delivery;
  const notices = [];
  // Geleerde voorstellen
  for (const s of S.suggestions) notices.push(el('div', { class: 'notice' },
    el('p', {}, s.text),
    el('div', { class: 'row' },
      btn('Ja, graag', () => run(async () => toast((await api('suggestion', { id: s.id, accept: true })).message)), 'primary small'),
      btn('Nee', () => run(async () => toast((await api('suggestion', { id: s.id, accept: false })).message)), 'small ghost'))));
  // Maaltijden vóór de bezorgdag (bijv. na het wijzigen van de bezorgdatum): aanbieden om mee te schuiven.
  const before = S.menu.days.filter(day => day.meal && day.date < S.menu.window.start);
  if (before.length) notices.push(el('div', { class: 'notice' },
    el('p', {}, `${before.length} maaltijd${before.length === 1 ? '' : 'en'} ${before.length === 1 ? 'valt' : 'vallen'} vóór de bezorging van ${fmtDate(S.menu.window.start)}.`),
    btn('Verplaats naar de bezorgperiode', () => run(async () => { const r = await api('menu/shift', {}); toast(`${r.moved} maaltijden verplaatst.`); planStale = true; }), 'primary small')));
  put($('suggestions'), notices);

  // Bezorging: het hoofdblok van het scherm.
  const hero = $('delivery-card');
  const change = btn('Bezorgmoment wijzigen', chooseDelivery, 'secondary small');
  if (!S.shop.ready) {
    put(hero, el('h2', {}, 'Weekmenu'),
      el('p', { class: 'hero-sub' }, 'Picnic is niet aangemeld. Het menu werkt wel; meld je aan onder Meer voor de echte mand en de deadline.'));
  } else if (d.next) {
    const start = new Date(d.next.windowStart), end = new Date(d.next.windowEnd), cut = new Date(d.cutOff);
    const urgent = d.hoursLeft < 6;
    put(hero,
      el('h2', {}, 'Bezorging ' + dateFmt.format(start)),
      el('p', { class: 'hero-sub' }, `${timeFmt.format(start)}–${timeFmt.format(end)} · voor ${fmtRange(S.menu.window.start, S.menu.window.end)}`),
      el('p', { class: 'hero-deadline' + (urgent ? ' urgent' : '') },
        el('span', { class: 'countdown' }, d.hoursLeft < 48 ? `nog ${num.format(d.hoursLeft)} uur` : `nog ${Math.round(d.hoursLeft / 24)} dagen`),
        ` om te wijzigen, tot ${dayShort(cut.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }))} ${timeFmt.format(cut)}`),
      change);
  } else if (d.planned) {
    put(hero, el('h2', {}, 'Bezorging ' + fmtDate(d.planned)),
      el('p', { class: 'hero-sub' }, 'Moment nog niet vrijgegeven door Picnic. Weekmand kiest het zodra het kan; dan volgt ook de deadline.'), change);
  } else {
    put(hero, el('h2', {}, 'Weekmenu'), el('p', { class: 'hero-sub' }, d.error ?? 'Nog geen bezorgmoment bekend.'), btn('Bezorgmoment kiezen', chooseDelivery, 'secondary small'));
  }

  // De week als tijdlijn, met de bezorging als markering.
  const portions = Math.round((S.household.adults + S.household.children * 0.65 + S.household.toddlers * 0.35) * 100) / 100;
  const marker = () => el('li', { class: 'marker' }, icon('truck'),
    el('span', {}, d.next ? `Bezorging ${dayShort(S.menu.window.start)} ${timeFmt.format(new Date(d.next.windowStart))}` : `Bezorging ${fmtDate(S.menu.window.start)}`));
  const items = [];
  let marked = false;
  for (const day of S.menu.days) {
    if (!marked && day.date >= S.menu.window.start) { items.push(marker()); marked = true; }
    items.push(dayRow(day, portions));
  }
  if (!marked) items.push(marker());
  put($('days'), items);
  renderPickBar();
  $('approve-menu').hidden = !S.menu.days.some(day => day.meal?.status === 'proposed');
}

// Gerechten aanvinken om te vervangen, eventueel met een opmerking.
const picked = new Set();
function renderPickBar() {
  for (const date of [...picked]) if (!S.menu.days.some(d => d.date === date && d.meal)) picked.delete(date);
  const n = picked.size;
  $('pick-bar').hidden = !n;
  $('tab-week').classList.toggle('picking', !!n);
  if (!n) return;
  $('pick-count').textContent = `${n} ${n === 1 ? 'gerecht' : 'gerechten'} aangevinkt`;
  $('pick-hint').textContent = S.ai
    ? 'Met een opmerking past de AI het recept daarop aan. Leeg: Weekmand kiest een ander gerecht.'
    : 'Weekmand kiest een ander gerecht; je opmerking geldt als wens.';
  $('pick-replace').textContent = n === 1 ? 'Vervangen' : `Vervang ${n} gerechten`;
}
$('pick-bar').onsubmit = e => {
  e.preventDefault();
  const note = $('pick-note').value.trim();
  run(async () => {
    if (note && S.ai) toast('Recept aanpassen… dit duurt even.');
    const r = await api('meal/replace', { dates: [...picked], note });
    picked.clear();
    $('pick-note').value = '';
    planStale = true;
    toast(r.replaced.map(x => `${x.day}: ${x.to}`).join(' · '));
  });
};
$('pick-cancel').onclick = () => { picked.clear(); $('pick-note').value = ''; renderWeek(); };

function dayRow(day, portions) {
  const m = day.meal;
  const [, , dd] = day.date.split('-');
  const servings = m?.servings ?? portions;
  const setServings = delta => run(() => api('meal/set', { date: day.date, recipeId: m.id, servings: Math.max(1, Math.round((servings + delta) * 100) / 100) }));
  const toggle = e => { if (e.target.checked) picked.add(day.date); else picked.delete(day.date); e.target.closest('.day').classList.toggle('picked', e.target.checked); renderPickBar(); };
  return el('li', { class: 'day' + (day.inOrder ? '' : ' out') + (m ? '' : ' empty') + (m && picked.has(day.date) ? ' picked' : '') },
    el('div', { class: 'day-date' }, el('span', { class: 'dow' }, day.day.slice(0, 2)), el('span', { class: 'dom' }, Number(dd))),
    el('div', { class: 'day-body' },
      m ? [
        el('div', { class: 'dish' },
          el('label', { class: 'pick', title: 'Aanvinken om te vervangen' },
            el('input', { type: 'checkbox', checked: picked.has(day.date) || undefined, 'aria-label': `${m.name} aanvinken om te vervangen`, onchange: toggle })),
          el('button', { type: 'button', class: 'dish-name', onclick: () => showRecipe(m.id, servings) }, m.name),
          m.status === 'proposed' ? el('span', { class: 'pill proposed' }, 'voorstel') : null),
        el('p', { class: 'day-meta' }, `${m.minutes} min · ${m.tags.filter(t => !['favoriet', 'picnic', 'bewaard', 'besteld'].includes(t)).slice(0, 3).join(', ')}${m.note ? ' · ' + m.note : ''}`),
        el('div', { class: 'day-actions' },
          el('span', { class: 'stepper' }, iconBtn('minus', 'Minder porties', () => setServings(-1)), el('span', {}, `${num.format(servings)} p.`), iconBtn('plus', 'Meer porties', () => setServings(1))),
          btn('Ander gerecht', () => run(() => api('meal/swap', { date: day.date })), 'small ghost'),
          btn('Kiezen', () => pickRecipe(day.date, servings), 'small ghost'),
          iconBtn('x', 'Maaltijd schrappen', () => run(() => api('meal/remove', { date: day.date })), 'danger')),
      ] : [
        el('p', { class: 'day-empty' }, 'Nog niets gepland'),
        el('div', { class: 'day-actions' }, btn('Gerecht kiezen', () => pickRecipe(day.date, portions), 'small secondary')),
      ],
      day.inOrder ? null : el('p', { class: 'day-meta' }, 'Valt buiten deze bestelling')));
}

function fmtRange(from, to) {
  const f = new Date(from + 'T12:00:00Z'), t = new Date(to + 'T12:00:00Z');
  const day = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', timeZone: 'UTC' });
  const full = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  return f.getUTCMonth() === t.getUTCMonth() ? `${day.format(f)}–${full.format(t)}` : `${full.format(f)} – ${full.format(t)}`;
}

function chooseDelivery() {
  const d = S.delivery;
  const local = t => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const byDay = Object.groupBy(d.slots, s => local(s.windowStart));
  const pick = data => { closeDialog(); run(async () => {
    const r = await api('delivery', data);
    toast(r.warning ?? r.note ?? `Bezorging ${fmtDate(r.planned)} gekozen.`, !!r.warning);
    planStale = true;
  }); };
  const dateInput = el('input', { type: 'date', min: local(Date.now() + 86400000), value: d.planned ?? '' });
  dialog('Bezorgmoment', el('div', { class: 'stack' },
    el('p', { class: 'muted small' }, 'Net boodschappen gehad? Kies hier de volgende bezorging; menu en boodschappen schuiven mee. Bij Picnic zet Weekmand het moment ook in je mand (er wordt niets besteld).'),
    ...Object.entries(byDay).map(([date, slots]) => el('details', { open: date === d.planned || undefined },
      el('summary', {}, fmtDate(date)),
      ...slots.map(s => el('button', { type: 'button', class: 'recipe-option' + (s.id === d.next?.id ? ' primary' : ''), onclick: () => pick({ slotId: s.id }) },
        el('b', {}, `${timeFmt.format(new Date(s.windowStart))}–${timeFmt.format(new Date(s.windowEnd))}`),
        el('span', { class: 'small' }, ` · wijzigen tot ${dayShort(local(s.cutOff))} ${timeFmt.format(new Date(s.cutOff))}`))))),
    el('h3', {}, 'Later dan deze lijst?'),
    el('form', { class: 'row', onsubmit: e => { e.preventDefault(); if (dateInput.value) pick({ date: dateInput.value }); } },
      el('span', { class: 'grow' }, dateInput), el('button', {}, 'Alleen datum kiezen')),
    d.planned ? btn('Weer het moment uit Picnic volgen', () => { closeDialog(); run(async () => { await api('delivery/reset', {}); planStale = true; }); }, 'ghost') : null));
}

const fmtDate = date => date ? dateFmt.format(new Date(date + 'T12:00:00')) : '';

async function showRecipe(id, servings) {
  const r = await api('recipe', { id, servings }).catch(e => toast(e.message, true));
  if (!r) return;
  dialog(r.name,
    el('p', { class: 'muted' }, `${r.minutes} min · ${num.format(r.servings)} porties · ca. ${money(r.costPerPortionCents)} p.p.`),
    el('ul', {}, ...r.ingredients.map(i => el('li', {}, i.text))),
    el('p', {}, r.steps));
}

async function pickRecipe(date, servings) {
  const list = el('div');
  const search = el('input', { placeholder: 'Zoek op naam of ingrediënt', 'aria-label': 'Recept zoeken' });
  let tag = '';
  const tags = ['vegetarisch', 'vis', 'kip', 'gehakt', 'hollands', 'italiaans', 'mexicaans', 'aziatisch', 'indiaas', 'snel', 'kindvriendelijk', 'feest', 'soep'].filter(t => S.tags.includes(t));
  const chips = el('div', { class: 'chips' }, ...tags.map(t => el('button', { type: 'button', class: 'chip', onclick: e => {
    tag = tag === t ? '' : t;
    chips.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.textContent === tag));
    refresh();
  } }, t)));
  async function refresh() {
    const recipes = await api('recipes', { query: search.value, tag });
    put(list, ...recipes.slice(0, 40).map(r => el('button', {
      type: 'button', class: 'recipe-option', disabled: !r.allowed || undefined,
      onclick: () => { closeDialog(); run(() => api('meal/set', { date, recipeId: r.id, servings })); },
    }, el('b', {}, r.name), el('span', { class: 'muted small' }, `${r.minutes} min · ca. ${money(r.costPerPortionCents)} p.p. · ${r.tags.slice(0, 4).join(', ')}${r.allowed ? '' : ' · past niet bij je voorkeuren'}`))));
  }
  search.oninput = () => refresh();
  dialog('Gerecht voor ' + fmtDate(date), el('div', { class: 'stack' }, search, chips, list));
  refresh();
}

$('propose-form').onsubmit = e => {
  e.preventDefault();
  run(async () => { await api('menu/propose', { wish: $('wish').value, replace: $('replace').checked }); planStale = true; toast('Nieuw voorstel klaar.'); });
};
$('approve-menu').onclick = () => run(async () => { const r = await api('menu/approve', {}); toast(`${r.approved} maaltijden goedgekeurd.`); });
$('to-cart').onclick = () => { planStale = true; showTab('cart'); };

// ───────────── Mand ─────────────

/** Na elke wijziging het voorstel automatisch opnieuw berekenen (alleen als de Mand-tab open is). */
let calcTimer;
function scheduleCalc() {
  clearTimeout(calcTimer);
  calcTimer = setTimeout(() => {
    if ((plan && !planStale) || !S?.shop.ready || !$('tab-cart').classList.contains('active')) return;
    // Bijwerken gebeurt stil: het oude voorstel blijft staan en knoppen blijven bruikbaar.
    if (plan) return calculate(false, { quiet: true }).catch(e => toast(e.message, true));
    if (busy) return scheduleCalc();
    run(calculate, { reload: false });
  }, plan ? 50 : 300);
}

// Productfoto's komen rechtstreeks van Picnic (openbaar); de CSP in server.ts staat deze bron toe.
const PICNIC_IMAGES = 'https://storefront-prod.nl.picnicinternational.com/static/images/';
function productPhoto(image, size = 'small', cls = 'thumb') {
  const none = () => el('span', { class: cls + ' none', 'aria-hidden': 'true' });
  if (!image) return none();
  const img = el('img', { class: cls, src: `${PICNIC_IMAGES}${encodeURIComponent(image)}/${size}.png`, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(none()), { once: true });
  return img;
}

/**
 * Productvenster: grote foto, maat, prijs en wat Picnic over het product zegt, om te zien of het het
 * juiste product is (spuitbus of bekertje). Bij een product van Weekmand: een ander product kiezen.
 */
let productToken = null;
function productDialog(p) {
  const token = productToken = {};
  const photo = el('div', { class: 'product-photo' }, productPhoto(p.image, 'large', 'photo'));
  const facts = el('p', { class: 'muted' }, [p.unitQuantity, p.cents ? money(p.cents) + ' per stuk' : null, p.unitPrice].filter(Boolean).join(' · '));
  const brand = el('p', { class: 'small muted' });
  const about = el('p', { class: 'product-about small' });
  const tags = el('div', { class: 'row' });
  const choose = key => el('div', { class: 'stack' },
    el('p', { class: 'hint' }, `Weekmand koopt dit voor ${ingredientName(key)}. Klopt het niet? Kies een ander product; bij de volgende berekening wisselt Weekmand het om in je mand.`),
    btn('Ander product kiezen', () => linkDialog(key), 'secondary'));
  const link = el('div', {}, p.key ? choose(p.key) : null);
  dialog(p.name, el('div', { class: 'stack product-sheet' }, photo, facts, p.context ? el('p', { class: 'small' }, p.context) : null, brand, about, tags, link));
  api('product', { id: p.id }).then(d => {
    if (token !== productToken || !$('dialog').open) return;
    if (!p.image && d.image) put(photo, productPhoto(d.image, 'large', 'photo'));
    if (d.brand) brand.textContent = d.brand;
    if (d.description) about.textContent = d.description;
    if (!p.unitPrice && d.unitPrice) facts.textContent = [facts.textContent, d.unitPrice].filter(Boolean).join(' · ');
    put(tags, ...(d.labels ?? []).map(t => el('span', { class: 'tag' }, t)));
    if (!p.key && d.key) put(link, choose(d.key));
  }).catch(() => {});
}

/** De echte Picnic-mand, altijd zichtbaar. */
let cartShown = '';
async function loadCartLines() {
  if (!S?.shop.ready) { cartShown = ''; put($('cart-lines'), el('p', { class: 'muted small' }, 'Niet aangemeld bij Picnic.')); return; }
  try {
    const cart = await api('cart', {});
    const shown = JSON.stringify(cart);
    if (shown === cartShown && $('cart-lines').childElementCount) return;
    cartShown = shown;
    const mine = cart.lines.reduce((n, l) => n + (l.byWeekmand ? 1 : 0), 0);
    const photos = cart.lines.some(l => l.image);
    put($('cart-lines'),
      el('p', {}, el('b', {}, `${cart.lines.reduce((n, l) => n + l.quantity, 0)} producten · ${money(cart.totalCents)}`),
        el('span', { class: 'muted small' }, mine ? ` · ${mine} regels door Weekmand toegevoegd` : '')),
      ...cart.lines.map(l => {
        const who = l.byWeekmand ? (l.byWeekmand === l.quantity ? 'Weekmand' : `${l.byWeekmand} door Weekmand`) : 'zelf';
        const context = `${l.quantity}× in je Picnic-mand · ${l.byWeekmand ? (l.byWeekmand === l.quantity ? 'door Weekmand' : `${l.byWeekmand} door Weekmand`) : 'zelf toegevoegd'}`;
        return el('button', { type: 'button', class: 'product-row', 'aria-label': `${l.quantity}× ${l.name}, ${l.unitQuantity}: bekijk het product`, onclick: () => productDialog({ ...l, context }) },
          photos ? productPhoto(l.image) : null,
          el('span', { class: 'grow' }, el('span', { class: 'product-name' }, `${l.quantity}× ${l.name}`),
            el('span', { class: 'muted small' }, [l.unitQuantity, l.unitPrice].filter(Boolean).join(' · '))),
          el('span', { class: 'pill' }, who));
      }),
      !cart.lines.length ? el('p', { class: 'muted small' }, 'Je Picnic-mand is leeg.') : null);
    applyListSearch('cart-lines');
  } catch (e) { cartShown = ''; put($('cart-lines'), el('p', { class: 'warn small' }, e.message)); }
}

const amountNl = new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1 });
function amountText(amount, unit) {
  if (unit === 'g' && amount >= 1000) return amountNl.format(amount / 1000) + ' kg';
  if (unit === 'ml' && amount >= 1000) return amountNl.format(amount / 1000) + ' l';
  if (unit === 'st') return amountNl.format(amount) + ' st';
  return amountNl.format(Math.round(amount)) + ' ' + (unit ?? '');
}

/** Veeg een element links of rechts weg (touch en muis); bij ver genoeg vegen volgt `onSwipe`. */
function swipeable(node, onSwipe) {
  let x0 = null, y0 = 0, dx = 0, horizontal = false;
  node.style.touchAction = 'pan-y';
  node.addEventListener('pointerdown', e => {
    if (e.target.closest('button, a')) return;
    x0 = e.clientX; y0 = e.clientY; dx = 0; horizontal = false;
    node.style.transition = 'none';
  });
  node.addEventListener('pointermove', e => {
    if (x0 === null) return;
    dx = e.clientX - x0;
    if (!horizontal && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(e.clientY - y0)) { horizontal = true; node.setPointerCapture(e.pointerId); }
    if (!horizontal) return;
    node.style.transform = `translateX(${dx}px)`;
    node.style.opacity = String(1 - Math.min(Math.abs(dx) / 260, 0.7));
  });
  const end = () => {
    if (x0 === null) return;
    x0 = null;
    node.style.transition = 'transform .2s, opacity .2s';
    if (horizontal && Math.abs(dx) > 90) {
      node.style.transform = `translateX(${dx > 0 ? 420 : -420}px)`;
      node.style.opacity = '0';
      setTimeout(onSwipe, 180);
    } else { node.style.transform = ''; node.style.opacity = ''; }
  };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  return node;
}

/**
 * force: de Picnic-mand opnieuw lezen en alles opnieuw berekenen. Anders het gedeelde overzicht van
 * de server; na een wijziging in Weekmand zelf rekent die met de al gelezen mand (snel, geen Picnic).
 */
async function calculate(force = false, { quiet = false } = {}) {
  const seq = ++planSeq;
  const slow = quiet ? null : setTimeout(() => toast('Bezig met berekenen… Je Picnic-mand lezen en nieuwe producten koppelen kan even duren.'), 1500);
  const result = await api(force === true ? 'plan' : 'plan/current', {}).finally(() => clearTimeout(slow));
  // Een nieuwere berekening of een nog lopende wijziging wint; die tekent zelf.
  if (seq !== planSeq || planWrites) return;
  // Komt er hetzelfde uit, dan alleen de tijd bijwerken: de lijst springt niet en je plek blijft.
  const same = plan && planSignature(plan) === planSignature(result.plan) && $('plan-read');
  plan = result.plan;
  planStale = false;
  savePlan();
  if (same) $('plan-read').textContent = planReadText();
  else renderPlan();
  loadCartLines();
  renderPantry(); // wat in de mand ligt telt mee in de voorraad
}

/** Het voorstel zonder id en tijden: gelijk betekent dat er niets te zien veranderde. */
const planSignature = p => JSON.stringify({ ...p, id: null, computedAt: null, cartReadAt: null });
const planReadText = () => planStale ? 'Bijwerken…' : `Picnic-mand gelezen ${readMoment(plan.cartReadAt ?? plan.computedAt)} · voor het hele huishouden`;
/** "om 08:12" vandaag, anders "gisteren om 20:01" of "ma om 20:01". */
function readMoment(iso) {
  const d = new Date(iso);
  const day = x => x.toLocaleDateString('sv-SE');
  const today = new Date();
  const yesterday = new Date(today.getTime() - 864e5);
  const when = day(d) === day(today) ? '' : day(d) === day(yesterday) ? 'gisteren ' : dayShort(day(d)) + ' ';
  return `${when}om ${timeFmt.format(d)}`;
}

function savePlan() {
  try { localStorage.setItem(PLAN_KEY, JSON.stringify({ mode: S?.shop.mode, plan })); } catch { /* privévenster of vol */ }
}

/** Bij het openen van de app: het bewaarde voorstel (hooguit een dag oud) meteen tonen en stil bijwerken. */
function restorePlan() {
  if (plan || !S?.shop.ready) return;
  try {
    const saved = JSON.parse(localStorage.getItem(PLAN_KEY) ?? 'null');
    const age = Date.now() - Date.parse(saved?.plan?.computedAt);
    if (saved?.mode !== S.shop.mode || !(age >= 0 && age < 24 * 36e5) || !Array.isArray(saved.plan.lines)) return;
    plan = saved.plan;
    planStale = true;
  } catch { /* geen of kapotte opslag: gewoon opnieuw laden */ }
}

/** Een regel meteen uit het voorstel halen of terugzetten; de server rekent daarna stil na. */
async function changePlanLine(path, productId, update, message) {
  if (plan) plan = { ...plan, lines: plan.lines.map(l => l.productId === productId ? { ...l, ...update } : l) };
  planStale = true;
  planWrites++;
  renderPlan();
  try {
    await api(path, { productId });
    if (message) toast(message);
  } catch (e) { toast(e.message, true); }
  finally { planWrites--; }
  if (!planWrites) await calculate(false, { quiet: true }).catch(e => toast(e.message, true));
}

/** Voorraad: de mand op de achtergrond laden, zodat "in je mand" klopt zonder eerst de Mand-tab te openen. */
function loadPlanQuietly() {
  if ((plan && !planStale) || !S?.shop.ready || planLoading) return;
  planLoading = calculate(false, { quiet: true }).catch(() => {}).finally(() => { planLoading = null; });
}
let planLoading = null;

function renderCart() {
  const status = $('cart-status');
  if (!S.shop.ready) {
    put(status, el('p', {}, 'Meld je aan bij Picnic (Meer → Winkel en Picnic) of gebruik de demowinkel.'));
  } else {
    put(status, 
      el('p', {}, el('b', {}, S.shop.label), S.delivery.cutOff ? ` · wijzigen tot ${dateFmt.format(new Date(S.delivery.cutOff))} ${timeFmt.format(new Date(S.delivery.cutOff))}` : ''),
      el('p', { class: 'muted small' }, "Weekmand vergelijkt wat nodig is (menu, vaste boodschappen, extra's, min voorraad) met je Picnic-mand en stelt alleen de verschillen voor."));
  }
  renderPlan();
  loadCartLines();

  const extras = S.order.extras;
  const skipped = S.order.skip;
  put($('extras'), 
    ...extras.map(x => el('div', { class: 'pantry-item' },
      el('span', { class: 'grow' }, x.kind === 'product' ? `${x.quantity}× ${x.name}` : x.label),
      iconBtn('x', 'Van de lijst halen', () => run(async () => { await api('order/remove-extra', { id: x.id }); planStale = true; }), 'danger'))),
    ...skipped.map(key => el('div', { class: 'pantry-item' },
      el('span', { class: 'grow muted' }, 'Overgeslagen: ' + (S.regulars.find(r => r.productId === key)?.name ?? ingredientName(key))),
      btn('Toch kopen', () => run(async () => { await api('order/undo-skip', { key }); planStale = true; }), 'small'))),
    !extras.length && !skipped.length ? el('p', { class: 'muted small' }, 'Niets extra deze keer.') : null);

  put($('regulars'), ...S.regulars.map(r => el('div', { class: 'pantry-item' },
    el('input', { type: 'checkbox', checked: r.enabled || undefined, 'aria-label': 'Vast ' + r.name, onchange: e => run(async () => { await api('regular', { productId: r.productId, enabled: e.target.checked }); planStale = true; }) }),
    el('span', { class: 'grow' }, `${r.name}`, el('span', { class: 'muted small' }, ` · ${r.unitQuantity}${r.weeks && !r.enabled ? ` · voorstel: ${r.weeks} weken gekocht` : ''}`)),
    el('span', { class: 'stepper' },
      iconBtn('minus', 'Minder', () => run(async () => { await api('regular', { productId: r.productId, quantity: r.quantity - 1 }); planStale = true; })),
      el('span', {}, `${r.quantity}×`),
      iconBtn('plus', 'Meer', () => run(async () => { await api('regular', { productId: r.productId, quantity: r.quantity + 1 }); planStale = true; }))))));
  if (!S.regulars.length) $('regulars').append(el('p', { class: 'muted small' }, 'Nog geen vaste boodschappen.'));

  $('demo-card').hidden = S.shop.mode !== 'mock';
  if (S.shop.mode === 'mock') {
    put($('slot'), ...S.delivery.slots.map(s => el('option', { value: s.id, selected: s.selected || undefined },
      `${dateFmt.format(new Date(s.windowStart))} ${timeFmt.format(new Date(s.windowStart))} (deadline ${dayShort(new Date(s.cutOff).toISOString().slice(0, 10))} ${timeFmt.format(new Date(s.cutOff))})`)));
  }
}

function renderPlan() {
  const area = $('plan');
  if (!plan) {
    put(area, S?.shop.ready ? el('div', { class: 'card' }, el('p', { class: 'muted' }, 'Voorstel laden…')) : null);
    scheduleCalc();
    return;
  }
  const changes = plan.lines.filter(l => l.add || l.remove);
  const over = plan.totalCents > plan.budgetCents;
  const parts = [];
  if (plan.questions.length) {
    parts.push(el('div', { class: 'card highlight' }, el('h3', {}, 'Even checken'),
      ...plan.questions.map(q => el('div', { class: 'pantry-item' }, el('span', { class: 'grow' }, q.text),
        btn('Ja', () => run(async () => { await api('pantry', { items: [{ name: q.key, status: 'genoeg' }] }); await calculate(); }), 'small primary'),
        btn('Nee, op', () => run(async () => { await api('pantry', { items: [{ name: q.key, status: 'op' }] }); await calculate(); }), 'small')))));
  }
  parts.push(el('div', { class: 'card' },
    el('h3', {}, changes.length ? `${changes.length} ${changes.length === 1 ? 'wijziging' : 'wijzigingen'} voorgesteld` : 'Je Picnic-mand is compleet'),
    el('p', { class: 'muted small' }, changes.length ? 'Nog niet doorgevoerd. Alleen deze verschillen gaan naar Picnic; wat je zelf in Picnic zet blijft staan.' : 'Alles wat nodig is zit al in je Picnic-mand. Afrekenen doe je in de Picnic-app.'),
    el('p', { class: 'muted small' }, `Voor ${plan.meals.length} maaltijden: ${plan.meals.map(m => m.name).join(', ') || 'geen'}.`),
    el('div', { class: 'row' }, el('span', { class: 'muted small grow', id: 'plan-read' }, planReadText()),
      btn('Ververs uit Picnic', () => run(() => calculate(true), { reload: false }), 'small ghost')),
    changes.length ? el('p', { class: 'hint with-icon' }, icon('swipe'), 'Veeg een regel opzij om hem deze keer over te slaan.') : null,
    changes.length ? searchBox('plan-lines', 'Zoek in het voorstel') : null,
    el('div', { id: 'plan-lines' }, ...changes.map(l => swipeable(el('div', { class: 'line' },
      el('span', { class: 'qty ' + (l.add ? 'add' : 'remove') }, l.add ? '+' + l.add : '−' + l.remove),
      el('div', {}, el('div', {},
        el('button', { type: 'button', class: 'product-link', onclick: () => productDialog({ id: l.productId, name: l.product, unitQuantity: l.unitQuantity, cents: l.cents, image: l.image, key: l.key, context: l.add ? `Weekmand zet er ${l.add} bij.` : `Weekmand haalt er ${l.remove} uit.` }) }, l.product),
        el('span', { class: 'muted small' }, ' · ' + l.unitQuantity)),
        el('div', { class: 'why' }, l.reason),
        l.need !== undefined ? el('div', { class: 'why' }, [
          'nodig ' + amountText(l.need, l.unit),
          l.inCartAmount ? 'al in mand ' + amountText(l.inCartAmount, l.unit) : null,
          l.stock !== null && l.stock !== undefined ? 'voorraad ' + amountText(l.stock, l.unit) : null,
        ].filter(Boolean).join(' · ')) : null),
      el('span', { class: 'small' }, l.cents ? money(l.cents * (l.add || l.remove)) : 'prijs onbekend')),
    () => changePlanLine('plan/decline', l.productId, { add: 0, remove: 0, declined: true }, `${l.product} overgeslagen voor deze bestelling.`)))),
    ...plan.lines.filter(l => l.declined).map(l => el('div', { class: 'pantry-item' },
      el('span', { class: 'grow muted small' }, 'Overgeslagen: ' + l.product),
      btn('Ongedaan maken', () => changePlanLine('plan/undecline', l.productId, { declined: false }), 'small'))),
    el('p', { class: over ? 'warn' : '' }, `Mand daarna ${money(plan.totalCents)} van ${money(plan.budgetCents)} budget${over ? ' — boven budget' : ''}`),
    el('div', { class: 'budget' + (over ? ' over' : '') }, budgetFill(Math.min(100, plan.totalCents / plan.budgetCents * 100))),
    plan.lines.length > changes.length ? el('p', { class: 'muted small' }, `${plan.lines.length - changes.length} regels staan al goed in de mand.`) : null,
    ...plan.missing.map(m => el('div', { class: 'pantry-item' }, el('span', { class: 'grow warn small' }, `${m.name}: geen product gekoppeld`), btn('Koppel', () => linkDialog(m.key), 'small'))),
    changes.length ? btn(`Wijzigingen naar Picnic sturen (${changes.length})`, () => planStale ? toast('Even wachten: het voorstel wordt bijgewerkt.') : run(async () => {
      // Doorvoeren leest de mand vers. Veranderde hij in de Picnic-app, dan het nieuwe voorstel tonen.
      const r = await api('apply', { id: plan.id }).catch(async e => { await calculate().catch(() => {}); throw e; });
      toast(r.summary);
      await calculate();
    }), 'primary wide') : null));
  if (S.ah?.linked) {
    parts.push(el('div', { class: 'card' }, el('h3', {}, 'Zelf naar de AH'),
      el('p', { class: 'muted small' }, 'Zet de boodschappen op Mijn lijst in de AH-app, zodat je ze in de winkel en in de zelfscanner ziet. Je Picnic-mand verandert niet.'),
      btn('Op mijn AH-lijst zetten', () => run(ahListDialog, { reload: false }), 'secondary')));
  }
  put(area, ...parts);
  applyListSearch('plan-lines');
  if (planStale && !planWrites) scheduleCalc();
}

/** De CSP staat geen style-attributen toe; via het CSSOM mag het wel. */
function budgetFill(percent) {
  const fill = el('div');
  fill.style.width = percent + '%';
  return fill;
}

async function ahListDialog() {
  const proposal = await api('ah/proposal', {});
  const chosen = new Set(proposal.map(p => p.id));
  const rows = proposal.map(p => {
    const box = el('input', { type: 'checkbox', checked: true, 'aria-label': 'Op de lijst: ' + p.text });
    box.onchange = () => { if (box.checked) chosen.add(p.id); else chosen.delete(p.id); };
    return el('label', { class: 'import-line' }, box, el('span', { class: 'row-text' }, el('span', { class: 'row-title' }, p.text)));
  });
  const extra = el('textarea', { placeholder: 'Nog iets anders? Eén per regel.', 'aria-label': 'Extra boodschappen' });
  dialog('Op je AH-lijst zetten', el('div', { class: 'stack' },
    el('p', { class: 'hint' }, 'Wat Weekmand nog wil kopen en niet al in je Picnic-mand zit. Wat al op je AH-lijst staat, slaat Weekmand over.'),
    proposal.length ? el('div', { class: 'list' }, rows) : el('p', { class: 'hint' }, 'Weekmand hoeft nu niets te kopen. Zet hieronder zelf iets op de lijst.'),
    el('label', {}, 'Extra', extra),
    el('div', { class: 'row' },
      btn('Op de lijst zetten', () => {
        const more = extra.value.split('\n').map(s => s.trim()).filter(Boolean);
        closeDialog();
        run(async () => {
          const r = await api('ah/send', { ids: [...chosen], extra: more });
          toast(`${r.added.length} op je AH-lijst gezet${r.skipped.length ? `; ${r.skipped.length} stond${r.skipped.length === 1 ? '' : 'en'} er al op` : ''}.`);
        }, { reload: false });
      }, 'primary'),
      btn('Annuleren', closeDialog, 'ghost'))));
}

$('extra-form').onsubmit = e => {
  e.preventDefault();
  const text = $('extra').value.trim();
  if (!text) return;
  const m = /^(\d+(?:[.,]\d+)?)\s*(g|gram|kg|kilo|ml|l|liter)\s+(.+)$/i.exec(text);
  const n = /^(\d+)\s*[x×]?\s+(.+)$/i.exec(text);
  const item = m ? { name: m[3], amount: Number(m[1].replace(',', '.')), unit: m[2].toLowerCase() } : n ? { name: n[2], quantity: Number(n[1]) } : { name: text.replace(/^(een|1)\s+/i, '') };
  run(async () => { const r = await api('order/add', { items: [item] }); toast('Toegevoegd: ' + r.added.join(', ')); $('extra').value = ''; planStale = true; });
};
$('regular-form').onsubmit = e => {
  e.preventDefault();
  run(async () => {
    const results = await api('search', { query: $('regular-query').value });
    const photos = results.some(p => p.image);
    put($('regular-results'), ...results.map(p => el('div', { class: 'pantry-item' }, photos ? productPhoto(p.image) : null,
      el('span', { class: 'grow' }, p.name, el('span', { class: 'muted small' }, ` · ${p.unitQuantity} · ${money(p.cents)}`)),
      btn('+ vast', () => run(async () => { await api('regular', { productId: p.id, enabled: true, quantity: 1 }); put($('regular-results'), ); planStale = true; }), 'small'))));
  }, { reload: false });
};

$('slot').onchange = () => run(async () => { await api('slot', { id: $('slot').value }); planStale = true; });
$('demo-checkout').onclick = () => {
  if (!confirm('Demobestelling afronden? De mand wordt geleegd en de producten gaan in je voorraad.')) return;
  run(async () => { const r = await api('demo-checkout', {}); toast(`${r.delivered} producten "geleverd".`); plan = null; });
};

async function linkDialog(key) {
  const name = ingredientName(key);
  const results = el('div');
  const input = el('input', { value: name, 'aria-label': 'Zoekterm' });
  const search = async () => {
    const products = await api('search', { query: input.value }).catch(e => { toast(e.message, true); return []; });
    const photos = products.some(p => p.image);
    put(results, ...products.map(p => el('button', { type: 'button', class: 'recipe-option product-option', onclick: () => run(async () => {
      await api('link', { name: key, productId: p.id }); closeDialog(); toast(`${name} gekoppeld aan ${p.name}.`); planStale = true;
    }) }, photos ? productPhoto(p.image) : null, el('span', { class: 'grow' }, el('b', {}, p.name),
      el('span', { class: 'muted small' }, [p.brand, p.unitQuantity, money(p.cents), p.unitPrice, p.available ? null : 'niet leverbaar'].filter(Boolean).join(' · '))))));
  };
  dialog('Product voor ' + name, el('div', { class: 'stack' }, el('form', { class: 'row', onsubmit: e => { e.preventDefault(); search(); } }, input, el('button', {}, 'Zoek')), results));
  search();
}

// ───────────── Voorraad ─────────────

let openPantry = null; // sleutel van de regel waarvan de bewerker open staat
/** In huis plus wat al in de mand ligt. */
const covered = i => (i.amount ?? 0) + (i.inCart || 0);
const shortOf = i => covered(i) < i.neededThisOrder;
const inCartOnly = i => !shortOf(i) && (i.amount ?? 0) < i.neededThisOrder;

/** Status van een product, in verhouding tot het menu als het menu het nodig heeft. */
function pantryStatus(i) {
  const need = i.neededThisOrder || 0;
  if (need > 0) {
    if ((i.amount ?? 0) >= need) return { text: 'genoeg', tone: 'ok' };
    if (covered(i) >= need) return { text: 'in je mand', tone: 'ok' };
    if (i.amount === null && !i.inCart) return { text: 'onbekend · wordt besteld', tone: 'short' };
    return { text: `tekort · nog ${amountText(need - covered(i), i.unit)}`, tone: 'short' };
  }
  if (i.amount === null) return { text: 'onbekend', tone: '' };
  if (i.amount === 0) return { text: 'op', tone: 'out' };
  if (i.minimum && i.amount <= i.minimum) return { text: 'onder minimum', tone: 'short' };
  return { text: (i.estimate ? 'ca. ' : '') + amountText(i.amount, i.unit), tone: '' };
}

function pantryRow(i) {
  const need = i.neededThisOrder || 0;
  const status = pantryStatus(i);
  const detail = need > 0 ? `menu ${amountText(need, i.unit)} · in huis ${i.amount === null ? 'onbekend' : amountText(i.amount, i.unit)}${i.inCart ? ` · in mand ${amountText(i.inCart, i.unit)}` : ''}`
    : i.minimum ? `altijd minimaal ${amountText(i.minimum, i.unit)}` : null;
  const open = openPantry === i.key;
  return el('div', { class: 'list-row' + (open ? ' open' : '') },
    el('button', { type: 'button', class: 'row-main', 'aria-expanded': String(open), onclick: () => { openPantry = open ? null : i.key; renderPantry(); } },
      el('span', { class: 'row-text' }, el('span', { class: 'row-title' }, i.name), detail ? el('span', { class: 'row-detail' }, detail) : null),
      el('span', { class: 'row-status ' + status.tone }, status.text)),
    open ? pantryEditor(i) : null);
}

function pantryEditor(i) {
  const unitLabel = { g: 'gram', ml: 'ml', st: 'stuks' }[i.unit] ?? i.unit;
  const amount = el('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: i.amount ?? '', placeholder: 'onbekend' });
  const minimum = el('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: i.minimum || '', placeholder: 'geen' });
  const save = (items, message) => run(async () => { await api('pantry', { items }); openPantry = null; toast(message); planStale = true; });
  setTimeout(() => { amount.focus(); amount.select(); }, 0);
  return el('form', { class: 'row-editor', onsubmit: e => {
    e.preventDefault();
    save([{ name: i.key, ...(amount.value === '' ? { status: 'onbekend' } : { amount: Number(amount.value) }), minimum: minimum.value === '' ? 0 : Number(minimum.value) }], `${i.name} bijgewerkt.`);
  } },
  el('div', { class: 'grid' }, el('label', {}, `In huis (${unitLabel})`, amount), el('label', {}, `Altijd minimaal (${unitLabel})`, minimum)),
  el('div', { class: 'row' },
    el('button', { class: 'primary' }, 'Opslaan'),
    btn('Is op', () => save([{ name: i.key, status: 'op' }], `${i.name} staat op 0.`)),
    btn('Annuleren', () => { openPantry = null; renderPantry(); }, 'ghost')));
}

function renderPantry() {
  const p = S.pantry;
  put($('scan-button'), icon('scan'), 'Barcode scannen');
  put($('quick'), p.quick.map(q => el('button', { type: 'button', class: 'chip', onclick: () => run(async () => {
    await api('pantry/out', { name: q.key }); toast(`${q.name} staat op 0 en komt in het volgende voorstel.`); planStale = true;
  }) }, q.name)));
  // Wat in de mand ligt: uit de mandberekening in deze pagina (nieuwst), anders uit die van de server.
  const cartIn = new Map();
  for (const l of plan?.lines ?? []) if (l.key && l.inCartAmount) cartIn.set(l.key, Math.max(cartIn.get(l.key) ?? 0, l.inCartAmount));
  const items = plan ? p.items.map(i => ({ ...i, inCart: cartIn.get(i.key) ?? 0 })) : p.items;
  const menu = items.filter(i => i.neededThisOrder > 0)
    .sort((a, b) => Number(shortOf(b)) - Number(shortOf(a)) || a.name.localeCompare(b.name, 'nl'));
  const other = items.filter(i => !(i.neededThisOrder > 0)).sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  const short = menu.filter(shortOf).length;
  const cart = menu.filter(inCartOnly).length;
  const cartText = cart ? `${cart} ${cart === 1 ? 'ligt' : 'liggen'} al in je mand.` : '';
  $('menu-need-hint').textContent = !menu.length ? 'Er staat nog geen menu voor deze bestelling.'
    : short ? `${short} van de ${menu.length} ingrediënten heb je nog niet genoeg; die bestelt Weekmand. ${cartText} Klopt iets niet? Tik de regel en vul in wat je hebt.`
      : cart ? `Alles voor het menu is in huis of ligt in je mand. ${cartText}` : 'Alles voor het menu is in huis.';
  $('pantry-menu').hidden = !menu.length;
  put($('pantry-menu'), menu.map(pantryRow));
  put($('pantry-other'), other.length ? other.map(pantryRow) : el('p', { class: 'hint empty' }, 'Nog niets bijgehouden buiten het menu.'));
  put($('ingredient-list'), S.ingredients.map(i => el('option', { value: i.name })));
  $('ah-receipts-action').hidden = !S.ah?.linked;
  applyListSearch('pantry-menu');
  applyListSearch('pantry-other');
  if ($('tab-pantry').classList.contains('active')) loadPlanQuietly();
}

function fetchReceipts() {
  run(async () => {
    const { receipts } = await api('ah/receipts', {});
    const counted = receipts.reduce((n, r) => n + r.counted.length, 0);
    const unmatched = receipts.reduce((n, r) => n + r.unmatched.length, 0);
    toast(!receipts.length ? 'Geen nieuwe kassabonnen.'
      : `${receipts.length} ${receipts.length === 1 ? 'kassabon' : 'kassabonnen'}: ${counted} producten bij de voorraad geteld${unmatched ? `, ${unmatched} niet herkend (zie Meer → Albert Heijn)` : ''}.`);
    planStale = true;
  });
}
$('ah-receipts').onclick = fetchReceipts;

$('pantry-add').onsubmit = e => {
  e.preventDefault();
  const name = $('pantry-add-name').value.trim();
  if (!name) return;
  const known = S.pantry.items.find(i => i.name.toLowerCase() === name.toLowerCase() || i.key === name.toLowerCase());
  if (known) { openPantry = known.key; $('pantry-add-name').value = ''; renderPantry(); return; }
  run(async () => {
    const [r] = await api('pantry', { items: [{ name, status: 'onbekend' }] });
    $('pantry-add-name').value = '';
    openPantry = S.ingredients.find(i => i.name === r.name)?.key ?? null;
  });
};
$('pantry-rebuild').onclick = () => {
  if (!confirm('Alle hoeveelheden vervangen door de laatste Picnic-levering?')) return;
  run(async () => {
    const r = await api('pantry/rebuild', {});
    toast(`Levering van ${fmtDate(r.delivery)}: ${r.counted.length} producten geteld, ${r.unmatched.length} niet herkend.`);
    planStale = true;
  });
};

$('scan-button').onclick = () => $('scan-input').click();
$('scan-input').onchange = async () => {
  const file = $('scan-input').files?.[0];
  $('scan-input').value = '';
  if (!file) return;
  put($('scan-result'), el('p', { class: 'muted' }, 'Barcode zoeken…'));
  let code = null;
  try {
    const bitmap = await createImageBitmap(file);
    if ('BarcodeDetector' in window) {
      const found = await new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] }).detect(bitmap).catch(() => []);
      code = found[0]?.rawValue ?? null;
    }
    if (!code) {
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      code = decodeBarcode(ctx.getImageData(0, 0, canvas.width, canvas.height))?.text ?? null;
    }
  } catch { /* afbeelding onleesbaar */ }
  if (!code) {
    const input = el('input', { inputmode: 'numeric', placeholder: 'Of typ de cijfers onder de streepjes', 'aria-label': 'Barcode' });
    put($('scan-result'), el('p', { class: 'warn' }, 'Geen barcode gevonden. Houd de barcode recht en scherp in beeld, of typ hem over.'),
      el('form', { class: 'row', onsubmit: e => { e.preventDefault(); handleCode(input.value.trim()); } }, input, el('button', {}, 'Verwerk')));
    return;
  }
  handleCode(code);
};

async function handleCode(code) {
  const r = await api('scan', { code }).catch(e => { toast(e.message, true); return null; });
  if (!r) return;
  if (r.known) {
    put($('scan-result'), el('p', { class: 'ok' }, `${r.name}: van de voorraad gehaald. Nog ${r.left} ${r.ingredient.toLowerCase()} over.`));
    await load();
    return;
  }
  const name = el('input', { list: 'ingredient-list', placeholder: 'Bijv. melk', required: true, 'aria-label': 'Product' });
  const pack = el('input', { type: 'number', min: '0', step: 'any', placeholder: 'optioneel', 'aria-label': 'Inhoud' });
  const unit = el('select', {}, ...['', 'g', 'kg', 'ml', 'l', 'st'].map(u => el('option', { value: u }, u || 'standaard')));
  put($('scan-result'), el('form', { class: 'stack', onsubmit: e => {
    e.preventDefault();
    run(async () => {
      const result = await api('barcode', { code, name: name.value, ...(pack.value ? { packAmount: Number(pack.value), unit: unit.value || undefined } : {}) });
      put($('scan-result'), el('p', { class: 'ok' }, `Onthouden. ${result.ingredient}: nog ${result.left} over.`));
    });
  } }, el('p', {}, `Nieuwe barcode ${code}. Welk product is dit? Weekmand onthoudt het voor de volgende keer.`),
  el('div', { class: 'grid' }, el('label', {}, 'Product', name), el('label', {}, 'Inhoud verpakking', pack), el('label', {}, 'Eenheid', unit)),
  el('button', { class: 'primary' }, 'Opslaan en van voorraad halen')));
}

// ───────────── Recepten ─────────────

let recipeTab = 'eaten';
let recipeQuery = '';
let recipeTag = '';
let recipeLimit = 40;
let askReasonFor = null;
const fmtShort = date => new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
const picnicLabel = { bewaard: 'Bewaard', besteld: 'Besteld', eigen: 'Eigen recept' };

$('recipe-tabs').onclick = e => {
  const b = e.target.closest('[data-sub]');
  if (!b || b.dataset.sub === recipeTab) return;
  recipeTab = b.dataset.sub;
  recipeQuery = ''; recipeTag = ''; recipeLimit = 40;
  renderRecipesTab();
};

function whenText(r) {
  if (r.lastEaten) return 'Laatst gegeten ' + fmtShort(r.lastEaten);
  if (r.lastOrdered) return 'Besteld voor ' + fmtShort(r.lastOrdered);
  if (r.picnicLabels?.includes('besteld')) return 'Eerder besteld bij Picnic';
  return 'Nog niet gegeten';
}

function recipeCard(r) {
  const tags = r.tags.filter(t => !['picnic', 'bewaard', 'besteld', 'eigen', 'favoriet'].includes(t)).slice(0, 3);
  return el('article', { class: 'recipe-card' + (r.allowed === false ? ' dimmed' : '') },
    el('button', { type: 'button', class: 'recipe-open', onclick: () => showRecipe(r.id) },
      el('h4', {}, r.name),
      el('p', { class: 'meta' }, `${r.minutes} min` + (r.costPerPortionCents ? ` · ca. ${money(r.costPerPortionCents)} p.p.` : '')),
      el('p', { class: 'when' + (r.lastEaten || r.lastOrdered ? '' : ' faint') }, whenText(r)),
      el('p', { class: 'tags' }, ...(r.picnicLabels ?? []).map(l => el('span', { class: 'tag strong' }, picnicLabel[l] ?? l)), ...tags.map(t => el('span', { class: 'tag' }, t)))),
    el('div', { class: 'card-foot' },
      r.rating ? el('span', { class: 'rated ' + r.rating }, icon(r.rating), r.rating === 'up' ? 'Favoriet' : 'Liever niet') : el('span'),
      btn('Op menu', () => planFavorite(r), 'small')));
}

function catalog(recipes, empty) {
  const grid = el('div', { class: 'catalog' });
  const draw = () => {
    const q = recipeQuery.toLowerCase();
    const shown = recipes.filter(r => (!q || r.name.toLowerCase().includes(q) || r.tags.some(t => t.includes(q))) && (!recipeTag || r.tags.includes(recipeTag)));
    put(grid, shown.length ? shown.slice(0, recipeLimit).map(recipeCard) : el('p', { class: 'hint empty' }, recipes.length ? 'Geen recepten gevonden met deze zoekopdracht.' : empty),
      shown.length > recipeLimit ? btn(`Toon alle ${shown.length}`, () => { recipeLimit = Infinity; draw(); }, 'ghost') : null);
  };
  const search = el('input', { type: 'search', value: recipeQuery, placeholder: 'Zoek op naam of soort', 'aria-label': 'Recepten zoeken' });
  search.oninput = () => { recipeQuery = search.value; draw(); };
  draw();
  return { search, grid, draw };
}

async function renderRecipesTab() {
  for (const b of $('recipe-tabs').querySelectorAll('[data-sub]')) b.setAttribute('aria-pressed', String(b.dataset.sub === recipeTab));
  const panel = $('recipes-panel');
  try {
    if (recipeTab === 'eaten') await renderEaten(panel);
    else if (recipeTab === 'favorites') await renderFavorites(panel);
    else if (recipeTab === 'picnic') await renderPicnicCatalog(panel);
    else await renderAllCatalog(panel);
  } catch (e) {
    put(panel, el('p', { class: 'warn' }, e.message));
  }
}

async function renderEaten(panel) {
  const data = await api('history', {});
  const rate = (h, rating, reason) => run(async () => { askReasonFor = null; toast((await api('rate', { date: h.date, rating, reason })).message); });
  const row = h => el('div', { class: 'list-row' },
    el('div', { class: 'row-main static' },
      el('span', { class: 'date-col' }, fmtShort(h.date)),
      el('span', { class: 'row-text' },
        el('button', { type: 'button', class: 'link', onclick: () => showRecipe(h.recipeId, h.servings) }, h.name),
        h.reason ? el('span', { class: 'row-detail' }, h.reason) : null),
      el('span', { class: 'rate-pair' },
        el('button', { type: 'button', class: 'icon-btn rate up', 'aria-pressed': String(h.rating === 'up'), 'aria-label': 'Lekker, bewaren als favoriet', title: 'Lekker', onclick: () => rate(h, 'up') }, icon('up')),
        el('button', { type: 'button', class: 'icon-btn rate down', 'aria-pressed': String(h.rating === 'down'), 'aria-label': 'Niet goed', title: 'Niet goed', onclick: () => { askReasonFor = askReasonFor === h.date ? null : h.date; renderRecipesTab(); } }, icon('down')))),
    askReasonFor === h.date ? el('div', { class: 'row-editor' }, el('p', { class: 'hint' }, 'Wat was er mis?'),
      el('div', { class: 'chips' }, ...data.reasons.map(r => el('button', { type: 'button', class: 'chip', onclick: () => rate(h, 'down', r) }, r)))) : null);
  if (!data.history.length) {
    put(panel, el('div', { class: 'empty-state' }, el('h3', {}, 'Nog niets gegeten'),
      el('p', { class: 'hint' }, 'Gerechten verschijnen hier zodra ze besteld zijn (Naar Picnic sturen) en de dag voorbij is. Daarna geef je ze een duim omhoog of omlaag.')));
    return;
  }
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const recent = data.history.filter(h => h.date >= weekAgo);
  const older = data.history.filter(h => h.date < weekAgo);
  put(panel,
    el('p', { class: 'hint' }, 'Duim omhoog zet een gerecht bij je favorieten; duim omlaag houdt het voorlopig van het menu.'),
    recent.length ? [el('h3', {}, 'Afgelopen week'), el('div', { class: 'list' }, recent.map(row))] : null,
    older.length ? [el('h3', {}, 'Eerder'), el('div', { class: 'list' }, older.slice(0, 40).map(row))] : null);
}

async function renderFavorites(panel) {
  const [all, data] = await Promise.all([api('recipes', {}), api('history', {})]);
  const favorites = all.filter(r => r.rating === 'up').sort((a, b) => (a.lastEaten ?? '').localeCompare(b.lastEaten ?? ''));
  const c = catalog(favorites, 'Geef een gegeten gerecht een duim omhoog om het hier te bewaren.');
  put(panel,
    el('p', { class: 'hint' }, 'Favorieten komen vaker terug in het menuvoorstel. Wat het langst niet gegeten is, staat bovenaan. Typ "favoriet" in je weekwens voor extra voorrang.'),
    favorites.length > 6 ? c.search : null, c.grid,
    data.disliked.length ? el('details', { class: 'disclosure' }, el('summary', {}, `Liever niet (${data.disliked.length})`),
      el('div', { class: 'list' }, data.disliked.map(d => el('div', { class: 'list-row' }, el('div', { class: 'row-main static' },
        el('span', { class: 'row-text' }, el('span', { class: 'row-title' }, d.name), d.reason ? el('span', { class: 'row-detail' }, d.reason) : null)))))) : null);
}

async function renderPicnicCatalog(panel) {
  const all = await api('recipes', {});
  const picnic = all.filter(r => r.source === 'picnic').sort((a, b) => (b.lastEaten ?? '').localeCompare(a.lastEaten ?? '') || a.name.localeCompare(b.name, 'nl'));
  const connected = S.shop.picnic === 'connected';
  const fetchButton = connected ? btn(picnic.length ? 'Opnieuw ophalen' : 'Ophalen uit Picnic', () => run(async () => {
    const r = await api('picnic/recipes', {});
    toast(`${r.found} Picnic-recepten gevonden, ${r.added} nieuw${r.remaining ? `, nog ${r.remaining} bij de volgende keer` : ''}.`);
  }), 'small secondary') : null;
  const c = catalog(picnic, connected ? 'Nog geen Picnic-recepten opgehaald.' : 'Meld je aan bij Picnic (Meer, Winkel en Picnic) om je bewaarde en bestelde recepten op te halen.');
  put(panel,
    el('div', { class: 'row panel-head' }, el('p', { class: 'hint grow' }, picnic.length ? `${picnic.length} recepten uit Picnic: bewaard, eigen en eerder besteld.` : 'Je bewaarde, eigen en eerder bestelde Picnic-recepten.'), fetchButton),
    picnic.length > 6 ? c.search : null, c.grid);
}

async function renderAllCatalog(panel) {
  const all = (await api('recipes', {})).sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  const c = catalog(all, 'Nog geen recepten.');
  const filters = ['vegetarisch', 'vis', 'kip', 'gehakt', 'hollands', 'italiaans', 'mexicaans', 'aziatisch', 'snel', 'kindvriendelijk'].filter(t => S.tags.includes(t));
  const chips = el('div', { class: 'chips' }, ...filters.map(t => el('button', { type: 'button', class: 'chip' + (recipeTag === t ? ' on' : ''), 'aria-pressed': String(recipeTag === t), onclick: () => {
    recipeTag = recipeTag === t ? '' : t;
    chips.querySelectorAll('.chip').forEach(ch => { ch.classList.toggle('on', ch.textContent === recipeTag); ch.setAttribute('aria-pressed', String(ch.textContent === recipeTag)); });
    c.draw();
  } }, t)));
  put(panel, el('h3', { class: 'first' }, 'Recept van een website'), importForm(), el('p', { class: 'hint' }, 'Werkt met de meeste receptsites. Lukt ophalen niet, zoals bij Allerhande en Plus, plak dan de ingrediënten.'), pasteForm(),
    el('h3', {}, 'Alle recepten'), c.search, chips, c.grid, ownRecipeForm());
}

/** Recept van een website: link plakken, voorbeeld bekijken, opslaan. */
function importForm() {
  const url = el('input', { type: 'url', inputmode: 'url', placeholder: 'Plak een link naar een recept', 'aria-label': 'Link naar recept', required: true });
  return el('form', { class: 'import-row', onsubmit: e => {
    e.preventDefault();
    run(async () => { showImportPreview(await api('recipe/import-preview', { url: url.value.trim() })); url.value = ''; }, { reload: false });
  } }, url, el('button', { class: 'primary' }, 'Ophalen'));
}

/** Voor sites die het recept niet leesbaar in de pagina zetten: de ingrediënten zelf plakken. */
function pasteForm() {
  const name = el('input', { placeholder: 'Naam van het gerecht', 'aria-label': 'Naam' });
  const servings = el('input', { type: 'number', min: '1', max: '40', value: '4', 'aria-label': 'Aantal personen' });
  const text = el('textarea', { required: true, placeholder: '400 g kipfilet\n1 ui\n2 el olijfolie', 'aria-label': 'Ingrediënten' });
  return el('details', { class: 'disclosure' }, el('summary', {}, 'Ingrediënten plakken'),
    el('form', { class: 'stack', onsubmit: e => {
      e.preventDefault();
      run(async () => showImportPreview(await api('recipe/import-text', { name: name.value, servings: Number(servings.value), text: text.value })), { reload: false });
    } },
    el('p', { class: 'hint' }, 'Kopieer de ingrediëntenlijst van de receptpagina, één ingrediënt per regel.'),
    el('label', {}, 'Naam', name), el('label', {}, 'Voor hoeveel personen', servings),
    el('label', {}, 'Ingrediënten', text),
    el('button', { class: 'secondary' }, 'Omrekenen')));
}

function showImportPreview(preview) {
  const skip = new Set();
  const unitText = { g: 'g', ml: 'ml', st: 'st' };
  const rows = preview.lines.map(l => {
    const usable = l.status !== 'overgeslagen';
    const box = el('input', { type: 'checkbox', checked: usable || undefined, disabled: usable ? undefined : true, 'aria-label': 'Meenemen: ' + l.original });
    box.onchange = () => { if (box.checked) skip.delete(l.original); else skip.add(l.original); };
    return el('label', { class: 'import-line' + (usable ? '' : ' skipped') }, box,
      el('span', { class: 'row-text' },
        el('span', { class: 'row-title' }, usable ? `${l.name} · ${amountText(l.amount, l.unit)} p.p.` : l.original),
        el('span', { class: 'row-detail' }, usable ? l.original : `Overgeslagen: ${l.note}`)),
      l.status === 'nieuw' ? el('span', { class: 'tag strong' }, 'nieuw') : l.note === 'basisvoorraad' ? el('span', { class: 'tag' }, 'basisvoorraad') : null);
  });
  dialog(preview.name, el('div', { class: 'stack' },
    el('p', { class: 'hint' }, `Omgerekend van ${preview.servings} personen naar hoeveelheden per persoon · ${preview.minutes} min. Vink uit wat je niet wilt meenemen. "Nieuw" betekent dat Weekmand dit ingrediënt nog niet kende; het wordt toegevoegd.`),
    el('div', { class: 'list' }, rows),
    el('div', { class: 'row' },
      btn('Recept opslaan', () => { closeDialog(); run(async () => {
        const r = await api('recipe/import-save', { preview, skip: [...skip] });
        toast(`"${r.name}" staat bij je recepten.`);
      }); }, 'primary'),
      btn('Annuleren', closeDialog, 'ghost'))));
}

function ownRecipeForm() {
  const name = el('input', { required: true, placeholder: 'Naam van het gerecht' });
  const tags = el('input', { placeholder: 'Soort, bijv. kip, mexicaans, snel' });
  const minutes = el('input', { type: 'number', min: '5', max: '240', value: '30' });
  const ingredients = el('textarea', { required: true, placeholder: '125 g kipfilet\n1 paprika\n2 tortilla' });
  const steps = el('textarea', { placeholder: 'Bereiding' });
  const form = el('form', { class: 'stack', onsubmit: e => {
    e.preventDefault();
    const items = ingredients.value.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
      const m = /^(\d+(?:[.,]\d+)?)\s*(g|gram|kg|ml|l|el|tl|st|stuks?)?\s+(.+)$/i.exec(line);
      return m ? { name: m[3], amount: Number(m[1].replace(',', '.')), unit: (m[2] ?? 'st').toLowerCase().replace(/^gram$/, 'g').replace(/^stuks?$/, 'st') } : { name: line, amount: 1, unit: 'st' };
    });
    run(async () => {
      const r = await api('recipe/add', { recipe: { name: name.value, tags: tags.value.split(',').map(t => t.trim()).filter(Boolean), minutes: Number(minutes.value), steps: steps.value, ingredients: items } });
      toast(`Recept "${r.name}" opgeslagen.`);
    });
  } }, name, tags, el('label', {}, 'Bereidingstijd in minuten', minutes), el('label', {}, 'Ingrediënten per persoon, één per regel', ingredients), steps,
  el('button', { class: 'primary' }, 'Recept opslaan'));
  return el('details', { class: 'disclosure' }, el('summary', {}, 'Eigen recept toevoegen'), form);
}

function planFavorite(f) {
  const portions = Math.round((S.household.adults + S.household.children * 0.65 + S.household.toddlers * 0.35) * 100) / 100;
  dialog(f.name + ' op het menu', el('div', { class: 'stack' }, el('p', { class: 'hint' }, 'Kies een dag:'),
    ...S.menu.days.map(d => el('button', { type: 'button', class: 'recipe-option', onclick: () => {
      closeDialog();
      run(async () => { await api('meal/set', { date: d.date, recipeId: f.id, servings: d.meal?.servings ?? portions }); toast(`${f.name} staat op ${d.day}.`); planStale = true; });
    } }, el('b', {}, `${d.day} ${fmtDate(d.date)}`), el('span', { class: 'muted small' }, d.meal ? 'Nu: ' + d.meal.name : 'Nog niets gepland')))));
}

// ───────────── Chat ─────────────

function renderChatMode() {
  $('chat-mode').textContent = S.ai ? `Met ${S.ai.label} (${S.ai.model}). Mandwijzigingen keur je goed met de knop onder het antwoord.`
    : 'Geen AI gekoppeld: ik begrijp vaste commando\'s zoals "menu", "mand", "melk is op", "voeg een krat pils toe en haal de kipfilet eruit". Koppel een AI onder Meer voor vrije tekst.';
  put($('notices'), ...S.notices.slice(0, 3).map(n => el('div', { class: 'card highlight' },
    el('p', { class: 'muted small' }, 'Melding · ' + new Date(n.at).toLocaleString('nl-NL', { weekday: 'short', hour: '2-digit', minute: '2-digit' })),
    el('p', { class: 'pre-wrap' }, n.text),
    n.buttons?.length ? el('div', { class: 'row' }, ...n.buttons.map(b => btn(b.label, () => run(async () => {
      const r = await api('action', { data: b.data });
      addMessage('assistant', r.text, r.buttons);
      showTab('chat');
    }), 'small'))) : null)));
}

function addMessage(role, text, buttons) {
  const msg = el('div', { class: 'msg ' + role }, text);
  if (buttons?.length) msg.append(el('div', { class: 'row msg-actions' }, ...buttons.map(b => btn(b.label, () => run(async () => {
    const r = await api('action', { data: b.data });
    addMessage('assistant', r.text, r.buttons);
    planStale = true;
  }), 'small' + (b.data.startsWith('apply') ? ' primary' : '')))));
  $('chat').append(msg);
  msg.scrollIntoView({ block: 'end', behavior: 'smooth' });
}

async function loadChat() {
  chatLoaded = true;
  const history = await api('chat/history', {}).catch(() => []);
  put($('chat'), );
  for (const t of history) addMessage(t.role, t.content);
  if (!history.length) addMessage('assistant', 'Hoi! Vraag me bijvoorbeeld "Wat staat er deze week op het menu?" of "Voeg een krat pils toe".');
}

$('chat-form').onsubmit = e => {
  e.preventDefault();
  const text = $('chat-text').value.trim();
  if (!text || busy) return;
  $('chat-text').value = '';
  addMessage('user', text);
  const thinking = el('div', { class: 'msg assistant muted' }, '…');
  $('chat').append(thinking);
  run(async () => {
    try {
      const r = await api('chat', { message: text });
      thinking.remove();
      addMessage('assistant', r.reply, r.reviewId ? [{ label: 'Naar Picnic sturen', data: 'apply:' + r.reviewId }, { label: 'Niet nu', data: 'skip:' + r.reviewId }] : undefined);
      planStale = true;
    } catch (error) { thinking.remove(); throw error; }
  });
};

// ───────────── Meer ─────────────

function renderMore() {
  const f = $('household-form').elements;
  for (const key of ['adults', 'children', 'toddlers', 'days', 'budget']) f[key].value = S.household[key];
  f.vegetarian.checked = S.household.vegetarian;
  f.exclude.value = S.household.exclude.map(ingredientName).join(', ');
  put($('rules'), ...(S.rules.length ? [el('h3', {}, 'Geleerde regels')] : []),
    ...S.rules.map((text, index) => el('div', { class: 'pantry-item' }, el('span', { class: 'grow' }, text), btn('Vergeet', () => run(() => api('rule/remove', { index })), 'small'))));
  renderAppearance();
  renderAccounts();
  renderPicnic();
  renderAh();
  renderAI();
  renderTelegram();
  renderIntegrations();
}

$('household-form').onsubmit = e => {
  e.preventDefault();
  const f = e.target.elements;
  run(async () => {
    await api('household', {
      adults: Number(f.adults.value), children: Number(f.children.value), toddlers: Number(f.toddlers.value), days: Number(f.days.value),
      budget: Number(f.budget.value), vegetarian: f.vegetarian.checked, exclude: f.exclude.value.split(',').map(s => s.trim()).filter(Boolean),
    });
    toast('Opgeslagen.'); planStale = true;
  });
};

function renderPicnic() {
  const s = S.shop;
  const modes = el('div', { class: 'row' },
    btn('Demowinkel', () => run(async () => { await api('shop-mode', { mode: 'mock' }); plan = null; }), s.mode === 'mock' ? 'primary small' : 'small'),
    btn('Picnic', () => run(async () => { await api('shop-mode', { mode: 'picnic' }); plan = null; }), s.mode === 'picnic' ? 'primary small' : 'small'));
  const parts = [el('p', { class: 'muted small' }, 'Weekmand vult alleen de mand. Afrekenen en bestellen doe je zelf in de Picnic-app.'), modes];
  const status = { connected: 'Aangemeld bij Picnic' + (s.remembered ? ' (sessie onthouden)' : ' (tot herstart)'), sms: 'Wacht op sms-code', disconnected: 'Niet aangemeld', expired: 'Sessie verlopen, meld je opnieuw aan' }[s.picnic];
  parts.push(el('p', {}, el('b', {}, status)));
  if (s.picnic === 'connected') {
    parts.push(el('div', { class: 'row' },
      btn('Leveringen ophalen', () => run(async () => { const r = await api('picnic/import', {}); toast(`${r.deliveries} leveringen opgehaald; ${r.addedToPantry} nieuw in de voorraad.`); }), 'small'),
      btn('Afmelden', () => run(() => api('picnic/disconnect', {})), 'small danger')));
  } else if (!S.canConfigure) {
    parts.push(el('p', { class: 'muted small' }, 'Aanmelden kan alleen via localhost of het toegestane thuisnetwerk.'));
  } else if (s.picnic === 'sms') {
    const code = el('input', { inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{4,8}', required: true, 'aria-label': 'Sms-code' });
    parts.push(el('form', { class: 'row', onsubmit: e => { e.preventDefault(); run(async () => { await api('picnic/verify', { code: code.value }); toast('Aangemeld bij Picnic.'); plan = null; }); } }, code, el('button', { class: 'primary' }, 'Bevestigen')));
  } else {
    const email = el('input', { type: 'email', autocomplete: 'username', required: true, placeholder: 'E-mailadres' });
    const password = el('input', { type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Wachtwoord' });
    const remember = el('input', { type: 'checkbox', checked: true });
    parts.push(el('form', { class: 'stack', onsubmit: e => {
      e.preventDefault();
      run(async () => { const r = await api('picnic/login', { email: email.value, password: password.value, remember: remember.checked }); password.value = ''; toast(r.status === 'sms' ? 'Picnic stuurt je een sms-code.' : 'Aangemeld bij Picnic.'); });
    } }, el('div', { class: 'grid' }, email, password),
    el('label', { class: 'check small' }, remember, 'Sessie onthouden op dit apparaat (nodig voor automatische meldingen na een herstart). Je wachtwoord wordt nooit bewaard.'),
    el('button', { class: 'primary' }, 'Aanmelden bij Picnic')));
  }
  if (s.mode === 'picnic' && S.links.length) {
    parts.push(el('h3', {}, 'Gekoppelde producten'), ...S.links.map(l => el('div', { class: 'pantry-item' },
      el('span', { class: 'grow' }, ingredientName(l.key), el('span', { class: 'muted small' }, ` → ${l.name} (${l.unitQuantity})${l.auto ? ' · automatisch' : ''}`)),
      btn('Wijzig', () => linkDialog(l.key), 'small'))));
  }
  const h = S.history;
  if (h?.deliveries?.length) {
    parts.push(el('details', {}, el('summary', {}, `Bestelgeschiedenis (${h.deliveries.length} leveringen)`),
      ...h.deliveries.slice(0, 12).map(d => el('p', { class: 'small' }, el('b', {}, d.date), ` · ${money(d.totalCents)} · ${d.orders.flatMap(o => o.items).length} producten`))));
  }
  put($('picnic'), ...parts);
}

function renderAh() {
  const a = S.ah;
  const parts = [el('p', { class: 'muted small' }, 'Voor boodschappen in de AH-winkel. Weekmand zet boodschappen op Mijn lijst in de AH-app (ook in de zelfscanner) en telt je kassabonnen bij de voorraad. Weekmand bestelt niets bij AH en krijgt je wachtwoord niet te zien.')];
  if (a.linked) {
    parts.push(el('p', {}, el('b', {}, 'Gekoppeld'), a.linkedAt ? ` sinds ${fmtDate(a.linkedAt.slice(0, 10))}` : ''),
      el('p', { class: 'muted small' }, (a.lastSync ? `Kassabonnen laatst opgehaald ${dateFmt.format(new Date(a.lastSync))} ${timeFmt.format(new Date(a.lastSync))}. ` : '') + 'Weekmand kijkt elke vier uur naar nieuwe bonnen.'));
    if (a.receipts.length) {
      parts.push(el('h3', {}, 'Laatste kassabonnen'), ...a.receipts.map(r => el('details', { class: 'disclosure' },
        el('summary', {}, `${fmtDate(r.date.slice(0, 10))}${r.total !== null ? ' · ' + money(Math.round(r.total * 100)) : ''} · ${r.counted.length} geteld${r.unmatched.length ? ` · ${r.unmatched.length} niet herkend` : ''}`),
        ...r.counted.map(t => el('p', { class: 'small' }, t)),
        ...r.unmatched.map(t => el('p', { class: 'small muted' }, `Niet herkend: ${t}`)),
        ...(r.ignored ?? []).map(t => el('p', { class: 'small muted' }, `Overgeslagen (geen boodschap): ${t}`)))));
    }
    if (a.unmatched?.length) {
      parts.push(el('h3', {}, 'Niet herkend'),
        el('p', { class: 'hint' }, 'Kies het ingrediënt waar een bonregel bij hoort, of negeer hem (bijvoorbeeld keukenrol). Weekmand telt hem dan alsnog bij de voorraad en onthoudt het voor volgende bonnen.'),
        ...a.unmatched.map(receiptMapRow),
        S.ai ? btn('Laat de AI zoeken', () => run(async () => {
          const r = await api('ah/match', {});
          toast(r.matched.length ? `De AI heeft ${r.matched.length} ${r.matched.length === 1 ? 'regel' : 'regels'} gekoppeld${r.unknown.length ? `; ${r.unknown.length} bleef onbekend` : ''}.` : 'De AI herkende geen van deze regels.');
          planStale = true;
        }), 'small secondary') : el('p', { class: 'hint' }, 'Met een gekoppelde AI (Meer → AI-aanbieder) zoekt Weekmand deze regels zelf op.'));
    }
    parts.push(el('div', { class: 'row' },
      btn('Kassabonnen ophalen', fetchReceipts, 'small'),
      S.canConfigure ? btn('Ontkoppelen', () => { if (confirm('AH-account ontkoppelen? Weekmand vergeet de toegang; je lijst en bonnen bij AH blijven staan.')) run(() => api('ah/unlink', {})); }, 'small danger') : null));
  } else if (!S.canConfigure) {
    parts.push(el('p', { class: 'muted small' }, 'Koppelen kan alleen via localhost of het toegestane thuisnetwerk.'));
  } else {
    const code = el('input', { autocomplete: 'off', required: true, placeholder: 'appie://login-exit?code=…', 'aria-label': 'Inlogcode van AH' });
    parts.push(el('ol', { class: 'steps' },
      el('li', {}, 'Gebruik Chrome of Edge op een computer. ', el('a', { href: a.loginUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open de inlogpagina van AH'), '; die opent in een nieuw tabblad.'),
      el('li', {}, 'Druk in dát tabblad op F12, kies het tabblad Network (Netwerk) en typ ', el('code', {}, 'ingelogd'), ' in het filterveld. Doe dit vóórdat je inlogt.'),
      el('li', {}, 'Log in en vul de sms-code in. Het scherm blijft daarna hangen met een draaiend rondje. Dat is normaal.'),
      el('li', {}, 'In de lijst staat nu één regel: ', el('code', {}, 'ingelogd.json'), '. Klik erop en kies Response (Reactie). Je ziet een regel met appie://login-exit?code=…'),
      el('li', {}, 'Klik in die tekst, druk op Ctrl+A en Ctrl+C, en plak het hieronder. Weekmand haalt de code eruit. Doe dit binnen een paar minuten: de code werkt één keer.')),
    el('p', { class: 'hint' }, 'Geen ingelogd.json in de lijst? Dan stond F12 nog niet open toen je inlogde. Laat F12 open, ververs de inlogpagina en log opnieuw in.'),
    el('form', { class: 'import-row', onsubmit: e => {
      e.preventDefault();
      run(async () => { await api('ah/link', { code: code.value }); code.value = ''; toast('AH-account gekoppeld. Weekmand haalt de kassabonnen van de afgelopen drie dagen op.'); });
    } }, code, el('button', { class: 'primary' }, 'Koppelen')));
  }
  put($('ah'), ...parts);
}

/** Eén onbekende bonregel: koppelen aan een ingrediënt of negeren. */
function receiptMapRow(u) {
  const input = el('input', { list: 'ingredient-list', required: true, placeholder: 'Hoort bij…', 'aria-label': 'Ingrediënt voor ' + u.name });
  return el('form', { class: 'map-row', onsubmit: e => {
    e.preventDefault();
    run(async () => { await api('ah/map', { name: u.name, ingredient: input.value.trim() }); toast(`${u.name} telt voortaan als ${input.value.trim()}.`); planStale = true; });
  } },
  el('span', { class: 'map-name' }, u.quantity > 1 ? `${u.quantity}× ${u.name}` : u.name),
  el('span', { class: 'map-controls' }, input,
    el('button', { class: 'small' }, 'Koppel'),
    btn('Negeer', () => run(async () => { await api('ah/map', { name: u.name, ingredient: null }); toast(`${u.name} wordt voortaan overgeslagen.`); }), 'small ghost')));
}

function renderAI() {
  const parts = [el('p', {}, S.ai ? el('b', {}, `Actief: ${S.ai.label} · ${S.ai.model} (${S.ai.source})`) : 'Geen AI gekoppeld. De chat werkt dan met vaste commando\'s.')];
  if (!S.canConfigure) {
    parts.push(el('p', { class: 'muted small' }, 'Een sleutel invoeren kan alleen via localhost of het toegestane thuisnetwerk.'));
  } else {
    const provider = el('select', {}, ...[['claude', 'Claude (Anthropic)'], ['openai', 'OpenAI'], ['mistral', 'Mistral'], ['deepseek', 'DeepSeek'], ['local', 'Lokaal model (Ollama e.d.)']].map(([v, t]) => el('option', { value: v }, t)));
    const key = el('input', { type: 'password', autocomplete: 'off', placeholder: 'API-sleutel' });
    const model = el('input', { placeholder: 'Model-ID (leeg = standaard)' });
    const baseUrl = el('input', { placeholder: 'http://192.168.1.20:11434/v1', hidden: true });
    const remember = el('input', { type: 'checkbox', checked: true });
    provider.onchange = () => { baseUrl.hidden = provider.value !== 'local'; };
    parts.push(el('form', { class: 'stack', onsubmit: e => {
      e.preventDefault();
      run(async () => { await api('ai/connect', { provider: provider.value, key: key.value, model: model.value, baseUrl: baseUrl.value, remember: remember.checked }); key.value = ''; toast('AI gekoppeld.'); });
    } }, provider, key, model, baseUrl,
    el('label', { class: 'check small' }, remember, 'Sleutel onthouden (nodig voor Telegram-chat na een herstart). Wordt opgeslagen in een apart bestand, niet in de database.'),
    el('p', { class: 'muted small' }, 'Standaardmodel voor Claude is claude-opus-5-5. Voor lagere kosten kun je claude-haiku-5-5 invullen. De test doet één kleine aanvraag.'),
    el('div', { class: 'row' }, el('button', { class: 'primary' }, 'Testen en koppelen'), S.ai && S.ai.source !== 'server' ? btn('Ontkoppelen', () => run(() => api('ai/disconnect', {})), 'danger') : null)));
  }
  put($('ai'), ...parts);
}

// ───────────── Budget ─────────────

const budgetView = { period: 'month', offset: 0 };
let budgetData = null;
let budgetOpenCat = null;
const kindClass = { nodig: 'k-nodig', extra: 'k-extra', 'geen-eten': 'k-geen' };
const kindOptions = [['nodig', 'Nodig'], ['extra', 'Extra: snack of traktatie'], ['geen-eten', 'Geen eten']];
const pctOf = (part, whole) => whole > 0 ? Math.round(part / whole * 100) + '%' : '';
/** Breedte, hoogte of positie in procenten via het CSSOM: de CSP staat geen style-attributen toe. */
function sized(node, prop, percent) { node.style[prop] = Math.max(0, Math.min(100, percent || 0)) + '%'; return node; }
const dayMonth = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const shortDate = date => dayMonth.format(new Date(date + 'T12:00:00Z'));

async function loadBudget() {
  try {
    budgetData = await api('budget', budgetView);
    renderBudget();
  } catch (e) { put($('budget'), el('p', { class: 'warn' }, e.message)); }
}

for (const b of $('budget-periods').querySelectorAll('button')) b.onclick = () => {
  budgetView.period = b.dataset.period;
  budgetView.offset = 0;
  budgetOpenCat = null;
  for (const x of $('budget-periods').querySelectorAll('button')) x.setAttribute('aria-selected', String(x === b));
  loadBudget();
};
const syncBudget = () => run(async () => {
  toast('Uitgaven ophalen bij Picnic en AH…');
  const r = await api('budget/sync', {});
  toast(r.errors?.length ? r.errors.join(' ') : r.added || r.detailed ? `${r.added} nieuwe aankopen, ${r.detailed} uitgesplitst.` : 'Alles is al bijgewerkt.', !!r.errors?.length);
  await loadBudget();
}, { reload: false });
$('budget-sync').onclick = syncBudget;

// Foto van een kassabon: de AI leest hem, jij controleert, daarna pas opslaan.
$('budget-photo').onclick = () => $('budget-photo-input').click();
$('budget-photo-input').onchange = () => {
  const file = $('budget-photo-input').files?.[0];
  $('budget-photo-input').value = '';
  if (!file) return;
  run(async () => {
    toast('Bon lezen… Dit kan een halve minuut duren.');
    const preview = await api('budget/photo', { image: await photoData(file) });
    photoDialog(preview);
  }, { reload: false });
};

/** Foto verkleinen tot hooguit 2048 px als JPEG: scherp genoeg voor bonnetjes, klein genoeg om te versturen. */
async function photoData(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('Deze foto kan de browser niet openen. Probeer een jpg of png.'); }
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
  const canvas = el('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}

function photoDialog(p) {
  const lines = p.lines.map(l => ({ ...l, keep: true }));
  const shop = el('input', { value: p.shop, maxlength: '60', required: true });
  const date = el('input', { type: 'date', value: p.date, max: budgetData?.today, required: true });
  const total = el('input', { type: 'text', inputmode: 'decimal', value: (p.totalCents / 100).toFixed(2).replace('.', ','), required: true });
  const pantry = el('input', { type: 'checkbox', checked: true });
  const sumLine = el('p', { class: 'small' });
  const totalCents = () => Math.round(Number(total.value.replace(',', '.')) * 100);
  const update = () => {
    const sum = lines.filter(l => l.keep).reduce((s, l) => s + l.cents, 0) + p.discounts.reduce((s, d) => s + d.cents, 0);
    const diff = totalCents() - sum;
    sumLine.className = 'small ' + (Math.abs(diff) > 2 ? 'warn' : 'muted');
    sumLine.textContent = Math.abs(diff) > 2
      ? `De regels zijn samen ${money(sum)}, ${money(Math.abs(diff))} ${diff > 0 ? 'minder' : 'meer'} dan het totaal. Kijk het totaal of de regels na.`
      : `Regels en totaal kloppen (${money(sum)}).`;
  };
  const row = l => {
    const node = el('div', { class: 'prod-row' + (l.keep ? '' : ' excluded') },
      el('span', { class: 'grow' }, `${num.format(l.quantity)}× ${l.name}`),
      l.kind === 'extra' ? el('span', { class: 'pill low' }, 'extra') : l.kind === 'geen-eten' ? el('span', { class: 'pill' }, 'geen eten') : null,
      el('b', {}, money(l.cents)),
      iconBtn(l.keep ? 'x' : 'plus', l.keep ? 'Regel weglaten' : 'Regel terugzetten', () => { l.keep = !l.keep; node.replaceWith(row(l)); update(); }));
    return node;
  };
  total.oninput = update;
  update();
  dialog('Bon controleren', el('div', { class: 'stack' },
    el('p', { class: 'hint' }, 'Zo las de AI je bon. Klopt iets niet, pas het dan aan of laat een regel weg.'),
    p.duplicate ? el('p', { class: 'warn small' }, `Deze bon lijkt er al te staan: ${p.duplicate.shop}, ${shortDate(p.duplicate.date)}, ${money(p.duplicate.totalCents)}.`) : null,
    el('div', { class: 'grid' }, el('label', {}, 'Winkel', shop), el('label', {}, 'Datum', date)),
    el('label', {}, 'Totaal betaald (€)', total),
    sumLine,
    el('div', { class: 'list' }, lines.map(row),
      p.discounts.map(d => el('div', { class: 'prod-row' }, el('span', { class: 'grow muted' }, d.name), el('b', {}, '−' + money(-d.cents))))),
    el('label', { class: 'check' }, pantry, 'Ook bij de voorraad tellen'),
    el('div', { class: 'row' },
      btn(p.duplicate ? 'Toch opslaan' : 'Opslaan', () => {
        closeDialog();
        run(async () => {
          const r = await api('budget/photo/save', { shop: shop.value, date: date.value, totalCents: totalCents(), lines: lines.filter(l => l.keep), discounts: p.discounts, pantry: pantry.checked, force: !!p.duplicate });
          toast('Bon opgeslagen' + (r.pantry ? `; ${r.pantry.counted.length} producten bij de voorraad geteld${r.pantry.unmatched.length ? `, ${r.pantry.unmatched.length} niet herkend` : ''}` : '') + '.');
          await loadBudget();
        }, { reload: pantry.checked });
      }, 'primary'),
      btn('Annuleren', closeDialog, 'ghost'))));
}

function stat(label, value, sub) {
  return el('div', { class: 'stat' }, el('span', { class: 'stat-label' }, label), el('b', {}, value), sub ? el('span', { class: 'muted small' }, sub) : null);
}

function renderBudget() {
  const b = budgetData;
  if (!b) return;
  const unit = { week: 'week', month: 'maand', year: 'jaar' }[b.period];
  const thisOne = { week: 'deze week', month: 'deze maand', year: 'dit jaar' }[b.period];
  const lastOne = { week: 'Vorige week', month: 'Vorige maand', year: 'Vorig jaar' }[b.period];
  const over = b.totalCents > b.budget;
  const parts = [];

  const next = iconBtn('right', 'Volgende ' + unit, () => { budgetView.offset++; budgetOpenCat = null; loadBudget(); });
  if (b.offset >= 0) next.classList.add('invisible');
  parts.push(el('div', { class: 'period-nav' },
    iconBtn('left', 'Vorige ' + unit, () => { budgetView.offset--; budgetOpenCat = null; loadBudget(); }),
    el('b', {}, b.range.label), next));

  if (!b.sync.total && !b.count) {
    parts.push(el('div', { class: 'card highlight' }, el('h3', {}, 'Nog geen uitgaven'),
      el('p', {}, b.sync.sources.picnic || b.sync.sources.ah
        ? 'Weekmand haalt je Picnic-bezorgingen en AH-kassabonnen van de afgelopen drie jaar op. De totalen zijn er meteen; de producten per bon volgen rustig, een paar per uur.'
        : 'Meld je aan bij Picnic of koppel je AH-account (Meer), dan houdt Weekmand je uitgaven vanzelf bij. Andere uitgaven voer je hieronder zelf in.'),
      b.sync.sources.picnic || b.sync.sources.ah ? btn('Nu ophalen', syncBudget, 'primary') : null));
  }

  // Hoofdblok: uitgegeven tegenover het budget.
  const left = b.budget - b.totalCents;
  parts.push(el('div', { class: 'card budget-hero' },
    el('p', { class: 'muted small' }, b.current ? `Uitgegeven ${thisOne}` : `Uitgegeven in ${b.range.label}`),
    el('p', { class: 'big' }, money(b.totalCents), el('span', { class: 'muted' }, ` van ${money(b.budget)}`)),
    el('div', { class: 'budget' + (over ? ' over' : '') }, sized(el('div'), 'width', b.totalCents / b.budget * 100)),
    el('p', { class: over ? 'warn' : '' }, over ? `${money(-left)} boven budget` : `Nog ${money(left)} over`,
      b.forecastCents ? el('span', { class: 'muted' }, ` · op deze koers ${money(b.forecastCents)}`) : null),
    el('p', { class: 'muted small' }, `${lastOne}: ${money(b.previousCents)}`,
      !b.current && b.previousCents ? ` (${b.totalCents >= b.previousCents ? '+' : '−'}${pctOf(Math.abs(b.totalCents - b.previousCents), b.previousCents)})` : ''),
    b.customBudget ? null : el('p', { class: 'hint' }, `Budget afgeleid van je mandbudget (${money(b.monthBudget)} per maand). Stel onderaan een eigen maandbudget in.`)));

  const weeks = Math.max(1, b.elapsed / 7);
  parts.push(el('div', { class: 'grid stats' },
    stat('Per persoon per dag', money(b.perPersonDayCents), `${b.persons} ${b.persons === 1 ? 'persoon' : 'personen'}`),
    b.period === 'week' ? stat('Per dag', money(Math.round(b.totalCents / b.elapsed))) : stat('Per week', money(Math.round(b.totalCents / weeks)), 'gemiddeld'),
    stat('Bespaard met acties', money(b.savingsCents), 'Picnic-acties en AH-bonus'),
    stat('Aankopen', String(b.count), b.count ? `${money(Math.round(b.totalCents / b.count))} per keer` : null)));

  // Verloop: tik een staaf om naar die periode te gaan.
  const max = Math.max(...b.trend.map(t => Math.max(t.cents, t.budget)), 1);
  const columns = `repeat(${b.trend.length}, 1fr)`;
  const plot = el('div', { class: 'trend-plot' }, b.trend.map(t => el('button', {
    type: 'button', class: 'trend-col' + (t.offset === b.offset ? ' on' : '') + (t.cents > t.budget ? ' over' : ''),
    'aria-label': `${t.title}: ${money(t.cents)}`, title: `${t.title}: ${money(t.cents)}`,
    onclick: () => { budgetView.offset = t.offset; budgetOpenCat = null; loadBudget(); },
  }, sized(el('span', { class: 'trend-bar' }), 'height', t.cents / max * 100))),
  sized(el('span', { class: 'trend-line', title: 'Budget' }), 'bottom', b.trend[0].budget / max * 100));
  plot.style.gridTemplateColumns = columns;
  const labels = el('div', { class: 'trend-labels', 'aria-hidden': 'true' }, b.trend.map(t => el('span', { class: t.offset === b.offset ? 'on' : '' }, t.label.replace('wk ', ''))));
  labels.style.gridTemplateColumns = columns;
  parts.push(el('section', { class: 'card' },
    el('h3', {}, { week: 'Laatste twaalf weken', month: 'Laatste twaalf maanden', year: 'Per jaar' }[b.period]),
    el('p', { class: 'hint' }, 'De stippellijn is het budget. Tik een staaf om die periode te bekijken.'),
    plot, labels));

  // Nodig of extra.
  const kindTotal = b.kinds.reduce((s, k) => s + k.cents, 0);
  parts.push(el('section', { class: 'card' }, el('h3', {}, 'Nodig of extra?'),
    kindTotal > 0
      ? el('div', { class: 'stackbar', role: 'img', 'aria-label': b.kinds.map(k => `${k.label} ${pctOf(k.cents, kindTotal)}`).join(', ') },
        b.kinds.filter(k => k.cents > 0).map(k => sized(el('span', { class: kindClass[k.key] }), 'width', k.cents / kindTotal * 100)))
      : el('p', { class: 'hint' }, 'Nog geen producten om in te delen.'),
    ...b.kinds.map(k => el('div', { class: 'legend-row' }, el('span', { class: 'dot ' + kindClass[k.key] }), el('span', { class: 'grow' }, k.label),
      el('span', { class: 'muted small' }, pctOf(k.cents, kindTotal)), el('b', {}, money(k.cents)))),
    b.unlabeled ? el('div', { class: 'row' }, el('p', { class: 'hint grow' }, `${b.unlabeled} ${b.unlabeled === 1 ? 'product is' : 'producten zijn'} nog niet ingedeeld en ${b.unlabeled === 1 ? 'telt' : 'tellen'} als nodig. Tik een product om het zelf in te delen.`),
      S.ai ? btn('Laat de AI indelen', () => run(async () => { const r = await api('budget/label', {}); toast(`${r.labeled} producten ingedeeld.`); await loadBudget(); }, { reload: false }), 'small secondary') : null) : null,
    b.coverage < 1 ? el('p', { class: 'hint' }, `Van ${pctOf(1 - b.coverage, 1)} van het bedrag zijn de producten nog niet bekend; Weekmand haalt die bonnen rustig op.`) : null));

  // Per categorie, uitklapbaar naar de producten.
  const catMax = Math.max(...b.categories.map(c => c.cents), 1);
  parts.push(el('section', { class: 'card' }, el('h3', {}, 'Per categorie'),
    b.categories.length ? b.categories.map(c => categoryRow(c, catMax)) : el('p', { class: 'hint' }, 'Nog niets uitgegeven in deze periode.')));

  // Per winkel.
  const shops = b.shops.filter(s => s.cents).map(s => [s.name, s.cents]);
  if (shops.length > 1) {
    const shopMax = Math.max(...shops.map(([, c]) => c), 1);
    parts.push(el('section', { class: 'card' }, el('h3', {}, 'Per winkel'),
      shops.map(([name, cents]) => el('div', { class: 'cat' }, el('div', { class: 'cat-head' }, el('span', { class: 'cat-name' }, name),
        el('span', { class: 'muted small' }, pctOf(cents, b.totalCents)), el('b', {}, money(cents)),
        el('span', { class: 'cat-bar' }, sized(el('span'), 'width', cents / shopMax * 100)))))));
  }

  // Waar het meeste geld heen gaat.
  if (b.products.length) {
    parts.push(el('section', { class: 'card' }, el('h3', {}, 'Meest uitgegeven aan'),
      el('div', {}, b.products.slice(0, 10).map(productRow)),
      b.products.length > 10 ? el('details', { class: 'more-list' }, el('summary', {}, `Alle ${b.products.length} producten`),
        searchBox('budget-products', 'Zoek een product'), el('div', { id: 'budget-products' }, b.products.map(productRow))) : null));
  }

  if (b.priceChanges.length) {
    parts.push(el('section', { class: 'card' }, el('h3', {}, 'Duurder geworden'),
      el('p', { class: 'hint' }, 'Prijs per stuk bij de laatste aankoop, tegenover de eerste in het jaar ervoor.'),
      b.priceChanges.map(p => el('div', { class: 'prod-row' }, el('span', { class: 'grow' }, p.name, el('span', { class: 'muted small' }, ` · ${money(p.from.unit)} → ${money(p.to.unit)}`)),
        el('span', { class: 'pill op' }, `+${p.percent}%`)))));
  }

  // Alle aankopen in deze periode.
  parts.push(el('section', { class: 'card' }, el('h3', {}, 'Aankopen'),
    b.purchases.length ? [searchBox('budget-purchases', 'Zoek een aankoop'), el('div', { id: 'budget-purchases' }, b.purchases.map(purchaseRow))]
      : el('p', { class: 'hint' }, 'Geen aankopen in deze periode.')));

  parts.push(expenseCard(b), settingsCard(b));
  put($('budget'), ...parts);
  applyListSearch('budget-products');
  applyListSearch('budget-purchases');
}

function categoryRow(c, max) {
  const b = budgetData;
  const limit = b.limits[c.key];
  const open = budgetOpenCat === c.key;
  const fixed = !c.kind; // Kosten en "nog niet uitgesplitst": geen producten om te tonen.
  const head = el(fixed ? 'div' : 'button', {
    type: fixed ? undefined : 'button', class: 'cat-head', 'aria-expanded': fixed ? undefined : String(open),
    onclick: fixed ? undefined : () => { budgetOpenCat = open ? null : c.key; renderBudget(); },
  },
  el('span', { class: 'cat-name' }, c.label),
  el('span', { class: 'muted small' }, pctOf(c.cents, b.totalCents)),
  el('b', {}, money(c.cents)),
  el('span', { class: 'cat-bar' + (c.kind === 'extra' ? ' extra' : '') + (limit && c.cents > limit ? ' over' : '') }, sized(el('span'), 'width', c.cents / max * 100)),
  limit ? el('span', { class: 'cat-limit small ' + (c.cents > limit ? 'warn' : 'muted') }, c.cents > limit ? `${money(c.cents - limit)} boven de limiet van ${money(limit)}` : `Limiet ${money(limit)} · nog ${money(limit - c.cents)}`) : null);
  if (!open) return el('div', { class: 'cat' }, head);
  const items = b.products.filter(p => p.category === c.key);
  return el('div', { class: 'cat open' }, head, el('div', { class: 'cat-body' },
    items.length ? items.slice(0, 25).map(productRow) : el('p', { class: 'hint' }, 'Geen producten met een bekende prijs in deze periode.'),
    items.length > 25 ? el('p', { class: 'hint' }, `En nog ${items.length - 25} andere.`) : null,
    limitForm(c)));
}

function productRow(p) {
  return el('button', { type: 'button', class: 'prod-row', onclick: () => labelDialog(p.name, p.category, p.kind) },
    el('span', { class: 'grow' }, p.name, el('span', { class: 'muted small' }, ` · ${num.format(p.quantity)}×`)),
    p.kind === 'extra' ? el('span', { class: 'pill low' }, 'extra') : p.kind === 'geen-eten' ? el('span', { class: 'pill' }, 'geen eten') : null,
    p.bonusCents ? el('span', { class: 'pill bonus', title: `${money(p.bonusCents)} bonuskorting` }, 'bonus') : null,
    p.by ? null : el('span', { class: 'pill', title: 'Nog niet ingedeeld' }, '?'),
    el('b', {}, money(p.cents)));
}

function labelDialog(name, category, kind) {
  const cats = budgetData.categoryList;
  const cat = el('select', {}, cats.map(c => el('option', { value: c.key, selected: c.key === category || undefined }, c.label)));
  const sort = el('select', {}, kindOptions.map(([value, label]) => el('option', { value, selected: value === kind || undefined }, label)));
  cat.onchange = () => { sort.value = cats.find(c => c.key === cat.value)?.kind ?? 'nodig'; };
  dialog(name, el('div', { class: 'stack' },
    el('p', { class: 'hint' }, 'Zo telt dit product voortaan mee, ook in eerdere weken en maanden.'),
    el('label', {}, 'Categorie', cat),
    el('label', {}, 'Nodig of extra', sort),
    el('div', { class: 'row' },
      btn('Opslaan', () => { closeDialog(); run(async () => { await api('budget/product', { name, category: cat.value, kind: sort.value }); toast('Opgeslagen.'); await loadBudget(); }, { reload: false }); }, 'primary'),
      btn('Annuleren', closeDialog, 'ghost'))));
}

function limitForm(c) {
  const current = budgetData.monthLimits?.[c.key];
  const input = el('input', { type: 'number', min: '0', step: '1', inputmode: 'decimal', placeholder: 'Geen limiet', value: current ? String(current / 100) : undefined, 'aria-label': 'Limiet per maand in euro' });
  return el('form', { class: 'row limit-form', onsubmit: e => {
    e.preventDefault();
    run(async () => { await api('budget/settings', { limit: { category: c.key, month: input.value } }); toast(input.value ? 'Limiet opgeslagen.' : 'Limiet verwijderd.'); await loadBudget(); }, { reload: false });
  } }, el('span', { class: 'small muted' }, 'Limiet per maand €'), el('span', { class: 'grow' }, input), el('button', { class: 'small' }, 'Opslaan'));
}

function purchaseRow(p) {
  return el('button', { type: 'button', class: 'prod-row' + (p.excluded ? ' excluded' : ''), onclick: () => run(() => spendDialog(p.id), { reload: false }) },
    el('span', { class: 'spend-date small' }, shortDate(p.date)),
    el('span', { class: 'grow' }, p.shop, el('span', { class: 'muted small' }, p.note ? ` · ${p.note}` : p.source === 'manual' ? '' : p.detailed ? ` · ${p.lines} regels` : ' · regels volgen')),
    p.excluded ? el('span', { class: 'pill' }, 'telt niet mee') : null,
    el('b', {}, money(p.totalCents)));
}

async function spendDialog(id) {
  const s = await api('budget/spend', { id });
  const shop = s.source === 'picnic' ? 'Picnic' : s.source === 'ah' ? 'Albert Heijn' : s.shop ?? 'Uitgave';
  const lines = s.lines ?? [];
  const toggle = (path, data, message) => { closeDialog(); run(async () => { await api(path, data); if (message) toast(message); await loadBudget(); }, { reload: false }); };
  // AH-bonus: van de bonusregels (nieuw), of het verschil tussen de producten en het totaal (oudere bonnen).
  const bonus = s.discounts ? -s.discounts.reduce((sum, d) => sum + d.cents, 0)
    : s.source === 'ah' ? Math.max(0, lines.reduce((sum, l) => sum + l.cents, 0) - s.totalCents) : 0;
  const saved = (s.savingsCents ?? 0) + bonus;
  dialog(`${shop}, ${shortDate(s.date)}`, el('div', { class: 'stack' },
    el('p', {}, el('b', {}, money(s.totalCents)), saved ? ` · ${money(saved)} ${s.source === 'ah' ? 'bonusvoordeel' : 'bespaard'}` : '', s.excluded ? el('span', { class: 'muted' }, ' · telt niet mee') : ''),
    lines.length ? el('div', { class: 'list' }, lines.map(l => el(l.adjustment ? 'div' : 'button', {
      type: l.adjustment ? undefined : 'button', class: 'prod-row',
      onclick: l.adjustment ? undefined : () => labelDialog(l.name, l.category ?? 'overig', l.kind ?? 'nodig'),
    }, el('span', { class: 'grow' }, `${num.format(l.quantity)}× ${l.name}`),
    l.bonusCents ? el('span', { class: 'pill bonus', title: 'Bonus: ' + l.bonusNames.join(', ') }, `B −${money(l.bonusCents)}`) : null,
    l.kind === 'extra' ? el('span', { class: 'pill low' }, 'extra') : l.kind === 'geen-eten' ? el('span', { class: 'pill' }, 'geen eten') : null,
    el('b', {}, money(l.cents - (l.bonusCents ?? 0))))),
    ...(s.looseDiscounts ?? []).map(d => el('div', { class: 'prod-row' }, el('span', { class: 'grow muted' }, `Bonus ${d.name}`),
      el('span', { class: 'pill bonus', title: 'Weekmand weet niet bij welk product deze bonus hoort' }, 'los'), el('b', {}, '−' + money(-d.cents)))),
    !s.discounts && bonus ? el('div', { class: 'prod-row' }, el('span', { class: 'grow muted' }, 'Bonuskorting (per product volgt bij de volgende ronde)'), el('b', {}, '−' + money(bonus))) : null)
      : el('p', { class: 'hint' }, s.source === 'manual' ? (budgetData.categoryList.find(c => c.key === s.category)?.label ?? 'Overig') + (s.note ? ` · ${s.note}` : '') : 'De producten van deze aankoop worden nog opgehaald.'),
    el('div', { class: 'row' },
      s.source === 'manual'
        ? btn('Verwijderen', () => toggle('budget/expense/remove', { id }, 'Verwijderd.'), 'danger')
        : btn(s.excluded ? 'Weer meetellen' : 'Niet meetellen', () => toggle('budget/exclude', { id, excluded: !s.excluded }), 'secondary'),
      btn('Sluiten', closeDialog, 'ghost'))));
}

function expenseCard(b) {
  const date = el('input', { type: 'date', value: b.today, max: b.today, required: true });
  const amount = el('input', { type: 'text', inputmode: 'decimal', placeholder: '0,00', required: true, autocomplete: 'off' });
  const shop = el('input', { placeholder: 'Bijv. markt, bakker, Lidl', maxlength: '60' });
  const cat = el('select', {}, b.categoryList.map(c => el('option', { value: c.key, selected: c.key === 'overig' || undefined }, c.label)));
  const note = el('input', { placeholder: 'Optioneel', maxlength: '120' });
  return el('details', { class: 'card' }, el('summary', {}, 'Losse uitgave toevoegen'),
    el('form', { class: 'stack', onsubmit: e => {
      e.preventDefault();
      run(async () => {
        await api('budget/expense', { date: date.value, amount: amount.value, shop: shop.value, category: cat.value, note: note.value });
        toast('Uitgave toegevoegd.');
        await loadBudget();
      }, { reload: false });
    } },
    el('p', { class: 'hint' }, 'Voor boodschappen buiten Picnic en de AH-app om. Een min-bedrag is een terugbetaling.'),
    el('div', { class: 'grid' }, el('label', {}, 'Datum', date), el('label', {}, 'Bedrag (€)', amount)),
    el('div', { class: 'grid' }, el('label', {}, 'Winkel', shop), el('label', {}, 'Categorie', cat)),
    el('label', {}, 'Notitie', note),
    el('button', { class: 'primary' }, 'Toevoegen')));
}

function settingsCard(b) {
  const month = el('input', { type: 'number', min: '10', step: '5', inputmode: 'decimal', value: b.customBudget ? String(b.monthBudget / 100) : undefined, placeholder: `${Math.round(b.monthBudget / 100)} (afgeleid)`, 'aria-label': 'Maandbudget in euro' });
  const s = b.sync;
  return el('details', { class: 'card' }, el('summary', {}, 'Budget en gegevens'),
    el('form', { class: 'stack', onsubmit: e => {
      e.preventDefault();
      run(async () => { await api('budget/settings', { month: month.value }); toast(month.value ? 'Budget opgeslagen.' : 'Budget weer afgeleid van je mandbudget.'); await loadBudget(); }, { reload: false });
    } },
    el('label', {}, 'Budget per maand voor alle boodschappen (€)', month),
    el('p', { class: 'hint' }, 'Leeg: afgeleid van je mandbudget per bestelling. Met een eigen budget krijg je een seintje bij 80% en 100%, ook via Telegram. Een limiet per categorie stel je in door de categorie open te tikken.'),
    el('button', {}, 'Opslaan')),
    el('div', { class: 'stack sync-info' },
      el('p', { class: 'small' }, s.at ? `Laatst bijgewerkt ${dateFmt.format(new Date(s.at))} om ${timeFmt.format(new Date(s.at))}.` : 'Nog niet bijgewerkt.',
        s.pending ? ` Van ${s.pending} van de ${s.total} aankopen haalt Weekmand de producten nog op, een paar per uur.` : ''),
      ...s.errors.map(e => el('p', { class: 'warn small' }, e)),
      el('div', { class: 'row' },
        btn('Nu bijwerken', syncBudget, 'small'),
        el('a', { href: '/api/budget.csv', download: '', class: 'small' }, 'Alle uitgaven downloaden (CSV)'))));
}

function renderTelegram() {
  const t = S.telegram;
  const parts = [el('p', { class: 'muted small' }, 'Telegram stuurt je een seintje vóór de Picnic-deadline en je kunt Weekmand er berichten sturen. Vier uur voor de deadline vraagt Weekmand naar twijfelachtige voorraad en laat je de mand goedkeuren.')];
  if (t.configured) parts.push(el('p', {}, el('b', {}, `Bot ${t.bot ? '@' + t.bot : ''} actief`), ` · ${t.chats.length} gekoppelde chat(s)`), t.error ? el('p', { class: 'warn small' }, t.error) : null);
  if (S.canConfigure) {
    if (!t.fromEnv) {
      const token = el('input', { type: 'password', autocomplete: 'off', placeholder: 'Bottoken van @BotFather' });
      parts.push(el('form', { class: 'row', onsubmit: e => { e.preventDefault(); run(async () => { await api('telegram/token', { token: token.value }); toast('Bot ingesteld.'); }); } },
        el('span', { class: 'grow' }, token), el('button', {}, t.configured ? 'Vervangen' : 'Instellen')));
    }
    if (t.configured) {
      const codeArea = el('div');
      parts.push(el('div', { class: 'row' },
        btn('Koppelcode maken', () => run(async () => {
          const r = await api('telegram/pair', {});
          put(codeArea, el('p', {}, `Stuur binnen 15 minuten `, el('b', {}, `/start ${r.code}`), ` naar ${r.bot ? '@' + r.bot : 'je bot'} in Telegram.`));
        }, { reload: false }), 'primary small'),
        t.chats.length ? btn('Testbericht', () => run(() => api('telegram/test', {})), 'small') : null,
        btn('Deadline-melding nu proberen', () => run(async () => { await api('cutoff/test', {}); toast('Melding verstuurd.'); }), 'small')),
      codeArea, ...t.chats.map(c => el('div', { class: 'pantry-item' }, el('span', { class: 'grow small' }, c.name ?? `Chat ${c.id}`), btn('Ontkoppel', () => run(() => api('telegram/unpair', { chat: c.id })), 'small'))));
      if (t.chats.length > 1) {
        const share = el('select', { 'aria-label': 'Antwoorden delen', onchange: e => run(async () => { await api('telegram/share', { mode: e.target.value }); toast('Opgeslagen.'); }) },
          ...[['changes', 'Alleen als er iets verandert (voorraad, menu, lijst, mand)'], ['all', 'Alles, ook vragen'], ['off', 'Niets: ieder zijn eigen chat']]
            .map(([value, label]) => el('option', { value, selected: t.share === value || undefined }, label)));
        parts.push(el('label', { class: 'stack' }, el('span', { class: 'small' }, 'Antwoorden van de bot ook naar de andere chats (en wat je in de webapp-chat vraagt)'), share));
      }
    }
  }
  put($('telegram'), ...parts);
}

function renderIntegrations() {
  const origin = location.origin;
  const tokenArea = el('div');
  const show = token => put(tokenArea, 
    el('h3', {}, 'Claude Code'), el('pre', {}, `claude mcp add --transport http weekmand ${origin}/mcp --header "Authorization: Bearer ${token}"`),
    el('h3', {}, 'Claude Desktop (claude_desktop_config.json)'),
    el('pre', {}, JSON.stringify({ mcpServers: { weekmand: { command: 'node', args: ['<pad naar weekmand>/src/mcp-stdio.ts'], env: { WEEKMAND_URL: origin, WEEKMAND_TOKEN: token } } } }, null, 2)),
    el('h3', {}, 'ChatGPT (Custom GPT → Actions)'),
    el('p', { class: 'small' }, `Importeer ${origin}/openapi.json en kies authenticatie "API key, Bearer" met het token. ChatGPT moet Weekmand via internet kunnen bereiken: gebruik een HTTPS-tunnel (bijv. Tailscale Funnel of Cloudflare Tunnel) en zet PUBLIC_URL.`),
    el('h3', {}, 'Home Assistant zonder MQTT (rest_command)'),
    el('pre', {}, `rest_command:\n  melk_op:\n    url: ${origin}/api/tools/update_pantry\n    method: POST\n    headers:\n      Authorization: Bearer ${token}\n    content_type: application/json\n    payload: '{"items":[{"name":"melk","status":"op"}]}'`));
  put($('integrations'), 
    el('p', { class: 'small' }, `MCP-server: `, el('code', {}, origin + '/mcp'), ` · OpenAPI: `, el('code', {}, origin + '/openapi.json')),
    el('p', { class: 'small' }, S.mqtt.configured ? `Home Assistant (MQTT): ${S.mqtt.connected ? 'verbonden' : 'niet verbonden'}${S.mqtt.error ? ' · ' + S.mqtt.error : ''}. Sensoren en knoppen verschijnen automatisch onder het apparaat "Weekmand".` : 'Home Assistant via MQTT: zet MQTT_URL in de configuratie (bijv. mqtt://gebruiker:wachtwoord@homeassistant.local:1883).'),
    el('p', { class: 'small' }, 'NFC-tag of QR-code voor "is op": ', el('code', {}, `${origin}/?op=melk`), ' (vervang melk door het product).'),
    S.canConfigure ? btn('Toon API-token en voorbeelden', () => run(async () => show((await api('token', {})).token), { reload: false }), 'small') : el('p', { class: 'muted small' }, 'Het API-token is alleen zichtbaar via localhost of het toegestane thuisnetwerk.'),
    tokenArea);
}

// ───────────── Inloggen en accounts ─────────────

async function showLogin() {
  const status = await fetch('/api/auth/status').then(r => r.json()).catch(() => ({}));
  if (status.user) return;
  const area = $('login');
  const name = el('input', { autocomplete: 'username', autocapitalize: 'none', required: true, placeholder: 'Gebruikersnaam' });
  const password = el('input', { type: 'password', autocomplete: status.setup ? 'new-password' : 'current-password', required: true, placeholder: 'Wachtwoord', minlength: status.setup ? 8 : undefined });
  const error = el('p', { class: 'warn' });
  const submit = async e => {
    e.preventDefault();
    const r = await fetch(status.setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.value, password: password.value }) });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) { error.textContent = json.error ?? 'Inloggen mislukt.'; return; }
    area.hidden = true;
    start();
  };
  put(area, el('div', { class: 'box stack' },
    el('h1', {}, 'Weekmand'),
    status.setup
      ? el('p', {}, 'Maak het eerste account aan. Dat kan alleen nu, vanaf je thuisnetwerk. Daarna kun je onder Meer → Accounts meer accounts toevoegen.')
      : el('p', { class: 'muted' }, 'Log in. Je blijft op dit apparaat 180 dagen ingelogd.'),
    el('form', { class: 'card stack', onsubmit: submit }, name, password, error,
      el('button', { class: 'primary wide' }, status.setup ? 'Account aanmaken' : 'Inloggen')),
    !status.setup ? el('p', { class: 'muted small' }, 'Nog geen eigen account? Log één keer in met gebruiker "weekmand" en het app-wachtwoord, of vraag iemand met een account er een voor je aan te maken.') : null));
  area.hidden = false;
  name.focus();
}

function renderAppearance() {
  const current = window.weekmandTheme?.get() ?? 'light';
  const options = [['light', 'Licht'], ['dark', 'Donker'], ['system', 'Systeem volgen']];
  const group = el('div', { class: 'segmented three', role: 'radiogroup', 'aria-label': 'Weergave' },
    ...options.map(([value, label]) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(current === value), 'aria-selected': String(current === value), onclick: () => {
      window.weekmandTheme?.set(value);
      renderAppearance();
    } }, label)));
  put($('appearance'), group, el('p', { class: 'hint' }, 'Geldt voor dit apparaat. Licht leest het best in de keuken; "Systeem volgen" neemt de instelling van je telefoon of computer over.'));
}

function renderAccounts() {
  const me = S.user;
  const own = S.accounts.includes(me);
  const newName = el('input', { autocomplete: 'off', autocapitalize: 'none', placeholder: 'Gebruikersnaam', required: true });
  const newPass = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Wachtwoord (min. 8 tekens)', minlength: 8, required: true });
  const myPass = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Nieuw wachtwoord', minlength: 8, required: true });
  put($('accounts'),
    el('p', {}, 'Ingelogd als ', el('b', {}, me), me === 'weekmand' ? ' (app-wachtwoord)' : ''),
    S.accounts.length ? el('div', {}, ...S.accounts.map(n => el('div', { class: 'pantry-item' }, el('span', { class: 'grow' }, n),
      n !== me ? btn('Verwijderen', () => { if (confirm(`Account ${n} verwijderen?`)) run(() => api('account/delete', { name: n })); }, 'small danger') : el('span', { class: 'muted small' }, 'jij')))) : el('p', { class: 'muted small' }, 'Nog geen accounts.'),
    el('form', { class: 'stack', onsubmit: e => { e.preventDefault(); run(async () => { await api('account/create', { name: newName.value, password: newPass.value }); toast(`Account ${newName.value} aangemaakt.`); }); } },
      el('h3', {}, 'Account toevoegen'), el('div', { class: 'grid' }, newName, newPass), el('button', {}, 'Toevoegen')),
    own ? el('form', { class: 'stack', onsubmit: e => {
      e.preventDefault();
      run(async () => {
        await api('account/password', { password: myPass.value });
        await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: me, password: myPass.value }) });
        toast('Wachtwoord gewijzigd. Andere apparaten zijn uitgelogd.');
      });
    } }, el('h3', {}, 'Mijn wachtwoord wijzigen'), myPass, el('button', {}, 'Wijzigen')) : null,
    btn('Uitloggen', async () => {
      try { localStorage.removeItem(PLAN_KEY); } catch { /* niets bewaard */ }
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); location.reload();
    }, 'danger'));
}

// ───────────── Start ─────────────

async function start() {
  const status = await fetch('/api/auth/status').then(r => r.json()).catch(() => ({}));
  if (!status.user) { showLogin(); return; }
  try {
    await load();
  } catch (error) {
    toast(error.message, true);
    return;
  }
  const params = new URLSearchParams(location.search);
  const op = params.get('op');
  if (op) {
    history.replaceState(null, '', location.pathname + location.hash);
    const name = S.ingredients.find(i => i.key === op || i.name.toLowerCase() === op.toLowerCase())?.name ?? op;
    dialog(`${name} is op?`, el('p', {}, 'Weekmand zet het in de volgende bestelling.'),
      el('div', { class: 'row' }, btn(`Ja, ${name.toLowerCase()} is op`, () => { closeDialog(); run(async () => { await api('pantry/out', { name: op }); toast(`${name} genoteerd.`); }); }, 'primary'), btn('Annuleren', closeDialog)));
  }
  const tab = location.hash.slice(1);
  if (['week', 'cart', 'pantry', 'budget', 'recipes', 'chat', 'more'].includes(tab)) showTab(tab);
}
start();
