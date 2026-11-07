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
let busy = false;
let chatLoaded = false;

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
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M7 10v10H4V10h3Zm0 0 4.2-6.3c.9-.3 2.2.3 2.1 1.6L12.8 9H18a2 2 0 0 1 2 2.3l-1.2 6.9A2 2 0 0 1 16.8 20H7"/>',
  down: '<g transform="rotate(180 12 12)"><path d="M7 10v10H4V10h3Zm0 0 4.2-6.3c.9-.3 2.2.3 2.1 1.6L12.8 9H18a2 2 0 0 1 2 2.3l-1.2 6.9A2 2 0 0 1 16.8 20H7"/></g>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M8 8v8M11 8v8M14 8v8M17 8v8"/>',
  swipe: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M4 12h16"/>',
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

function showTab(name) {
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.classList.toggle('active', s.id === 'tab-' + name);
  history.replaceState(null, '', '#' + name);
  window.scrollTo({ top: 0 });
  if (name === 'chat' && !chatLoaded) loadChat();
  if (name === 'cart' && !plan && S?.shop.ready) run(calculate, { reload: false });
}
$('tabs').onclick = e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); };
window.addEventListener('hashchange', () => {
  const tab = location.hash.slice(1);
  if (['week', 'cart', 'pantry', 'recipes', 'chat', 'more'].includes(tab) && !$('tab-' + tab).classList.contains('active')) showTab(tab);
});

// ───────────── Laden en tekenen ─────────────

async function load() {
  S = await api('/api/state');
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
  const dot = $('tabs').querySelector('[data-tab="chat"] .dot');
  if (S.notices.length && !dot) $('tabs').querySelector('[data-tab="chat"]').append(el('span', { class: 'dot' }));
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
    btn('Verplaats naar de bezorgperiode', () => run(async () => { const r = await api('menu/shift', {}); toast(`${r.moved} maaltijden verplaatst.`); plan = null; }), 'primary small')));
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
  $('approve-menu').hidden = !S.menu.days.some(day => day.meal?.status === 'proposed');
}

function dayRow(day, portions) {
  const m = day.meal;
  const [, , dd] = day.date.split('-');
  const servings = m?.servings ?? portions;
  const setServings = delta => run(() => api('meal/set', { date: day.date, recipeId: m.id, servings: Math.max(1, Math.round((servings + delta) * 100) / 100) }));
  return el('li', { class: 'day' + (day.inOrder ? '' : ' out') + (m ? '' : ' empty') },
    el('div', { class: 'day-date' }, el('span', { class: 'dow' }, day.day.slice(0, 2)), el('span', { class: 'dom' }, Number(dd))),
    el('div', { class: 'day-body' },
      m ? [
        el('div', { class: 'dish' },
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
    plan = null;
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
    d.planned ? btn('Weer het moment uit Picnic volgen', () => { closeDialog(); run(async () => { await api('delivery/reset', {}); plan = null; }); }, 'ghost') : null));
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
  run(async () => { await api('menu/propose', { wish: $('wish').value, replace: $('replace').checked }); plan = null; toast('Nieuw voorstel klaar.'); });
};
$('approve-menu').onclick = () => run(async () => { const r = await api('menu/approve', {}); toast(`${r.approved} maaltijden goedgekeurd.`); });
$('to-cart').onclick = () => { plan = null; showTab('cart'); };

// ───────────── Mand ─────────────

/** Na elke wijziging het voorstel automatisch opnieuw berekenen (alleen als de Mand-tab open is). */
let calcTimer;
function scheduleCalc() {
  clearTimeout(calcTimer);
  calcTimer = setTimeout(() => {
    if (plan || !S?.shop.ready || !$('tab-cart').classList.contains('active')) return;
    if (busy) return scheduleCalc();
    run(calculate, { reload: false });
  }, 300);
}

/** De echte Picnic-mand, altijd zichtbaar. */
async function loadCartLines() {
  if (!S?.shop.ready) { put($('cart-lines'), el('p', { class: 'muted small' }, 'Niet aangemeld bij Picnic.')); return; }
  try {
    const cart = await api('cart', {});
    const mine = cart.lines.reduce((n, l) => n + (l.byWeekmand ? 1 : 0), 0);
    put($('cart-lines'),
      el('p', {}, el('b', {}, `${cart.lines.reduce((n, l) => n + l.quantity, 0)} producten · ${money(cart.totalCents)}`),
        el('span', { class: 'muted small' }, mine ? ` · ${mine} regels door Weekmand toegevoegd` : '')),
      ...cart.lines.map(l => el('div', { class: 'pantry-item' }, el('span', { class: 'grow' }, `${l.quantity}× ${l.name}`, el('span', { class: 'muted small' }, ` · ${l.unitQuantity}`)),
        l.byWeekmand ? el('span', { class: 'pill' }, l.byWeekmand === l.quantity ? 'Weekmand' : `${l.byWeekmand} door Weekmand`) : el('span', { class: 'pill' }, 'zelf'))),
      !cart.lines.length ? el('p', { class: 'muted small' }, 'Je Picnic-mand is leeg.') : null);
  } catch (e) { put($('cart-lines'), el('p', { class: 'warn small' }, e.message)); }
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

/** force: echt opnieuw berekenen; anders het gedeelde overzicht van de server (snel). */
async function calculate(force = false) {
  const slow = setTimeout(() => toast('Bezig met berekenen… Nieuwe producten koppelen bij Picnic kan even duren.'), 1500);
  const result = await api(force === true ? 'plan' : 'plan/current', {}).finally(() => clearTimeout(slow));
  plan = result.plan;
  renderPlan();
  loadCartLines();
}

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
      iconBtn('x', 'Van de lijst halen', () => run(async () => { await api('order/remove-extra', { id: x.id }); plan = null; }), 'danger'))),
    ...skipped.map(key => el('div', { class: 'pantry-item' },
      el('span', { class: 'grow muted' }, 'Overgeslagen: ' + (S.regulars.find(r => r.productId === key)?.name ?? ingredientName(key))),
      btn('Toch kopen', () => run(async () => { await api('order/undo-skip', { key }); plan = null; }), 'small'))),
    !extras.length && !skipped.length ? el('p', { class: 'muted small' }, 'Niets extra deze keer.') : null);

  put($('regulars'), ...S.regulars.map(r => el('div', { class: 'pantry-item' },
    el('input', { type: 'checkbox', checked: r.enabled || undefined, 'aria-label': 'Vast ' + r.name, onchange: e => run(async () => { await api('regular', { productId: r.productId, enabled: e.target.checked }); plan = null; }) }),
    el('span', { class: 'grow' }, `${r.name}`, el('span', { class: 'muted small' }, ` · ${r.unitQuantity}${r.weeks && !r.enabled ? ` · voorstel: ${r.weeks} weken gekocht` : ''}`)),
    el('span', { class: 'stepper' },
      iconBtn('minus', 'Minder', () => run(async () => { await api('regular', { productId: r.productId, quantity: r.quantity - 1 }); plan = null; })),
      el('span', {}, `${r.quantity}×`),
      iconBtn('plus', 'Meer', () => run(async () => { await api('regular', { productId: r.productId, quantity: r.quantity + 1 }); plan = null; }))))));
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
    el('div', { class: 'row' }, el('span', { class: 'muted small grow' }, `Berekend om ${timeFmt.format(new Date(plan.computedAt))} · voor het hele huishouden`),
      btn('Opnieuw berekenen', () => run(() => calculate(true), { reload: false }), 'small ghost')),
    changes.length ? el('p', { class: 'hint with-icon' }, icon('swipe'), 'Veeg een regel opzij om hem deze keer over te slaan.') : null,
    ...changes.map(l => swipeable(el('div', { class: 'line' },
      el('span', { class: 'qty ' + (l.add ? 'add' : 'remove') }, l.add ? '+' + l.add : '−' + l.remove),
      el('div', {}, el('div', {}, l.product, el('span', { class: 'muted small' }, ' · ' + l.unitQuantity)),
        el('div', { class: 'why' }, l.reason),
        l.need !== undefined ? el('div', { class: 'why' }, [
          'nodig ' + amountText(l.need, l.unit),
          l.inCartAmount ? 'al in mand ' + amountText(l.inCartAmount, l.unit) : null,
          l.stock !== null && l.stock !== undefined ? 'voorraad ' + amountText(l.stock, l.unit) : null,
        ].filter(Boolean).join(' · ')) : null),
      el('span', { class: 'small' }, l.cents ? money(l.cents * (l.add || l.remove)) : 'prijs onbekend')),
    () => run(async () => { await api('plan/decline', { productId: l.productId }); toast(`${l.product} overgeslagen voor deze bestelling.`); plan = null; }))),
    ...plan.lines.filter(l => l.declined).map(l => el('div', { class: 'pantry-item' },
      el('span', { class: 'grow muted small' }, 'Overgeslagen: ' + l.product),
      btn('Ongedaan maken', () => run(async () => { await api('plan/undecline', { productId: l.productId }); plan = null; }), 'small'))),
    el('p', { class: over ? 'warn' : '' }, `Mand daarna ${money(plan.totalCents)} van ${money(plan.budgetCents)} budget${over ? ' — boven budget' : ''}`),
    el('div', { class: 'budget' + (over ? ' over' : '') }, el('div', { style: `width:${Math.min(100, plan.totalCents / plan.budgetCents * 100)}%` })),
    plan.lines.length > changes.length ? el('p', { class: 'muted small' }, `${plan.lines.length - changes.length} regels staan al goed in de mand.`) : null,
    ...plan.missing.map(m => el('div', { class: 'pantry-item' }, el('span', { class: 'grow warn small' }, `${m.name}: geen product gekoppeld`), btn('Koppel', () => linkDialog(m.key), 'small'))),
    changes.length ? btn(`Wijzigingen naar Picnic sturen (${changes.length})`, () => run(async () => {
      const r = await api('apply', { id: plan.id });
      toast(r.summary);
      await calculate();
    }), 'primary wide') : null));
  put(area, ...parts);
}

$('extra-form').onsubmit = e => {
  e.preventDefault();
  const text = $('extra').value.trim();
  if (!text) return;
  const m = /^(\d+(?:[.,]\d+)?)\s*(g|gram|kg|kilo|ml|l|liter)\s+(.+)$/i.exec(text);
  const n = /^(\d+)\s*[x×]?\s+(.+)$/i.exec(text);
  const item = m ? { name: m[3], amount: Number(m[1].replace(',', '.')), unit: m[2].toLowerCase() } : n ? { name: n[2], quantity: Number(n[1]) } : { name: text.replace(/^(een|1)\s+/i, '') };
  run(async () => { const r = await api('order/add', { items: [item] }); toast('Toegevoegd: ' + r.added.join(', ')); $('extra').value = ''; plan = null; });
};
$('regular-form').onsubmit = e => {
  e.preventDefault();
  run(async () => {
    const results = await api('search', { query: $('regular-query').value });
    put($('regular-results'), ...results.map(p => el('div', { class: 'pantry-item' },
      el('span', { class: 'grow' }, p.name, el('span', { class: 'muted small' }, ` · ${p.unitQuantity} · ${money(p.cents)}`)),
      btn('+ vast', () => run(async () => { await api('regular', { productId: p.id, enabled: true, quantity: 1 }); put($('regular-results'), ); plan = null; }), 'small'))));
  }, { reload: false });
};

$('slot').onchange = () => run(async () => { await api('slot', { id: $('slot').value }); plan = null; });
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
    put(results, ...products.map(p => el('button', { type: 'button', class: 'recipe-option', onclick: () => run(async () => {
      await api('link', { name: key, productId: p.id }); closeDialog(); toast(`${name} gekoppeld aan ${p.name}.`); plan = null;
    }) }, el('b', {}, p.name), el('span', { class: 'muted small' }, `${p.unitQuantity} · ${money(p.cents)}${p.available ? '' : ' · niet leverbaar'}`))));
  };
  dialog('Product voor ' + name, el('div', { class: 'stack' }, el('form', { class: 'row', onsubmit: e => { e.preventDefault(); search(); } }, input, el('button', {}, 'Zoek')), results));
  search();
}

// ───────────── Voorraad ─────────────

let openPantry = null; // sleutel van de regel waarvan de bewerker open staat
const shortOf = i => i.amount === null || i.amount < i.neededThisOrder;

/** Status van een product, in verhouding tot het menu als het menu het nodig heeft. */
function pantryStatus(i) {
  const need = i.neededThisOrder || 0;
  if (need > 0) {
    if (i.amount === null) return { text: 'onbekend · wordt besteld', tone: 'short' };
    if (i.amount >= need) return { text: 'genoeg', tone: 'ok' };
    return { text: `tekort · nog ${amountText(need - i.amount, i.unit)}`, tone: 'short' };
  }
  if (i.amount === null) return { text: 'onbekend', tone: '' };
  if (i.amount === 0) return { text: 'op', tone: 'out' };
  if (i.minimum && i.amount <= i.minimum) return { text: 'onder minimum', tone: 'short' };
  return { text: (i.estimate ? 'ca. ' : '') + amountText(i.amount, i.unit), tone: '' };
}

function pantryRow(i) {
  const need = i.neededThisOrder || 0;
  const status = pantryStatus(i);
  const detail = need > 0 ? `menu ${amountText(need, i.unit)} · in huis ${i.amount === null ? 'onbekend' : amountText(i.amount, i.unit)}`
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
  const save = (items, message) => run(async () => { await api('pantry', { items }); openPantry = null; toast(message); plan = null; });
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
    await api('pantry/out', { name: q.key }); toast(`${q.name} staat op 0 en komt in het volgende voorstel.`); plan = null;
  }) }, q.name)));
  const menu = p.items.filter(i => i.neededThisOrder > 0)
    .sort((a, b) => Number(shortOf(b)) - Number(shortOf(a)) || a.name.localeCompare(b.name, 'nl'));
  const other = p.items.filter(i => !(i.neededThisOrder > 0)).sort((a, b) => a.name.localeCompare(b.name, 'nl'));
  const short = menu.filter(shortOf).length;
  $('menu-need-hint').textContent = !menu.length ? 'Er staat nog geen menu voor deze bestelling.'
    : short ? `${short} van de ${menu.length} ingrediënten heb je niet of niet genoeg in huis. Die bestelt Weekmand, of ze liggen al in je mand. Klopt iets niet? Tik de regel en vul in wat je hebt.`
      : 'Alles voor het menu is in huis.';
  $('pantry-menu').hidden = !menu.length;
  put($('pantry-menu'), menu.map(pantryRow));
  put($('pantry-other'), other.length ? other.map(pantryRow) : el('p', { class: 'hint empty' }, 'Nog niets bijgehouden buiten het menu.'));
  put($('ingredient-list'), S.ingredients.map(i => el('option', { value: i.name })));
}

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
    plan = null;
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
$('recipe-tabs').onkeydown = e => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tabs = [...$('recipe-tabs').querySelectorAll('[data-sub]')];
  const next = tabs[(tabs.findIndex(t => t.dataset.sub === recipeTab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  recipeTab = next.dataset.sub;
  renderRecipesTab();
  next.focus();
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
  for (const b of $('recipe-tabs').querySelectorAll('[data-sub]')) {
    b.setAttribute('aria-selected', String(b.dataset.sub === recipeTab));
    b.tabIndex = b.dataset.sub === recipeTab ? 0 : -1;
  }
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
  put(panel, c.search, chips, c.grid, ownRecipeForm());
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
      run(async () => { await api('meal/set', { date: d.date, recipeId: f.id, servings: d.meal?.servings ?? portions }); toast(`${f.name} staat op ${d.day}.`); plan = null; });
    } }, el('b', {}, `${d.day} ${fmtDate(d.date)}`), el('span', { class: 'muted small' }, d.meal ? 'Nu: ' + d.meal.name : 'Nog niets gepland')))));
}

// ───────────── Chat ─────────────

function renderChatMode() {
  $('chat-mode').textContent = S.ai ? `Met ${S.ai.label} (${S.ai.model}). Mandwijzigingen keur je goed met de knop onder het antwoord.`
    : 'Geen AI gekoppeld: ik begrijp vaste commando\'s zoals "menu", "mand", "melk is op", "voeg een krat pils toe en haal de kipfilet eruit". Koppel een AI onder Meer voor vrije tekst.';
  put($('notices'), ...S.notices.slice(0, 3).map(n => el('div', { class: 'card highlight' },
    el('p', { class: 'muted small' }, 'Melding · ' + new Date(n.at).toLocaleString('nl-NL', { weekday: 'short', hour: '2-digit', minute: '2-digit' })),
    el('p', { style: 'white-space:pre-wrap' }, n.text),
    n.buttons?.length ? el('div', { class: 'row' }, ...n.buttons.map(b => btn(b.label, () => run(async () => {
      const r = await api('action', { data: b.data });
      addMessage('assistant', r.text, r.buttons);
      showTab('chat');
    }), 'small'))) : null)));
}

function addMessage(role, text, buttons) {
  const msg = el('div', { class: 'msg ' + role }, text);
  if (buttons?.length) msg.append(el('div', { class: 'row', style: 'margin-top:.5rem' }, ...buttons.map(b => btn(b.label, () => run(async () => {
    const r = await api('action', { data: b.data });
    addMessage('assistant', r.text, r.buttons);
    plan = null;
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
      plan = null;
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
    toast('Opgeslagen.'); plan = null;
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
      codeArea, ...t.chats.map(c => el('div', { class: 'pantry-item' }, el('span', { class: 'grow small' }, `Chat ${c}`), btn('Ontkoppel', () => run(() => api('telegram/unpair', { chat: c })), 'small'))));
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
    btn('Uitloggen', async () => { await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); location.reload(); }, 'danger'));
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
  if (['week', 'cart', 'pantry', 'recipes', 'chat', 'more'].includes(tab)) showTab(tab);
}
start();
