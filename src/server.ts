import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIPv4 } from 'node:net';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';
import { handleAction, reasons } from './actions.ts';
import { Weekmand } from './app.ts';
import { Assistant } from './assistant.ts';
import { Accounts, cookieValue, privateClient, sessionDays } from './auth.ts';
import { Store } from './db.ts';
import { PICNIC_IMAGE_ORIGIN } from './shop.ts';
import { check, Problem } from './errors.ts';
import { HomeAssistantBridge } from './homeassistant.ts';
import { handleMcp, openApi, version } from './mcp.ts';
import { Scheduler, wireNotices } from './scheduler.ts';
import type { StoredNotice } from './scheduler.ts';
import { Secrets } from './secrets.ts';
import { reviewButtons, TelegramBot } from './telegram.ts';
import { planSummary, runTool } from './tools.ts';

// ───────────── Opstarten ─────────────

const dbPath = process.env.DB_PATH || 'data/weekmand.sqlite';
if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
const store = new Store(dbPath);
const secrets = new Secrets(dbPath === ':memory:' ? null : process.env.SECRETS_PATH || join(dirname(dbPath), 'secrets.json'));
const app = new Weekmand({ store, secrets });
const accounts = new Accounts(store);
const assistant = new Assistant(app);
app.receiptMatcher = (lines, ingredients) => assistant.matchReceiptLines(lines, ingredients);
app.productClassifier = names => assistant.classifyProducts(names);
app.receiptReader = (image, today) => assistant.readReceiptPhoto(image, today);
app.recipeAdapter = (recipe, note) => assistant.adaptRecipe(recipe, note);
const publicUrl = process.env.PUBLIC_URL;
wireNotices(app, publicUrl);

let telegram: TelegramBot | null = null;
function startTelegram() {
  telegram?.stop();
  const token = process.env.TELEGRAM_BOT_TOKEN || secrets.get('telegramToken');
  telegram = token ? new TelegramBot(app, assistant, token) : null;
  telegram?.start();
}
app.events.on('notify', notice => void telegram?.broadcast(notice));
startTelegram();

const mqtt = process.env.MQTT_URL ? new HomeAssistantBridge(app, process.env.MQTT_URL) : null;
mqtt?.start();
const scheduler = new Scheduler(app);
if (process.env.SCHEDULER !== 'off') scheduler.start();

// ───────────── Toegang ─────────────

const password = process.env.APP_PASSWORD;
const digest = (value: string) => createHash('sha256').update(value).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

function basicOk(req: IncomingMessage) {
  const auth = req.headers.authorization ?? '';
  return !!password && auth.startsWith('Basic ') && same(Buffer.from(auth.slice(6), 'base64').toString(), 'weekmand:' + password);
}
function tokenOk(req: IncomingMessage) {
  const auth = req.headers.authorization ?? '';
  return auth.startsWith('Bearer ') && same(auth.slice(7).trim(), secrets.apiToken());
}
const COOKIE = 'weekmand_session';
/** Inloggen is nodig zodra er een APP_PASSWORD of een account is; zonder beide is de app open (standaard alleen localhost). */
const loginRequired = () => !!password || accounts.count > 0;
function uiUser(req: IncomingMessage): string | null {
  return accounts.session(cookieValue(req.headers.cookie, COOKIE)) ?? (basicOk(req) ? 'weekmand' : tokenOk(req) ? 'api' : loginRequired() ? null : 'lokaal');
}
const uiAllowed = (req: IncomingMessage) => uiUser(req) !== null;
/** MCP, OpenAPI en Home Assistant: altijd het API-token (of het app-wachtwoord). */
const apiAllowed = (req: IncomingMessage) => tokenOk(req) || basicOk(req);

/**
 * LAN_LISTEN=uit zet het luisteren op het thuisnetwerk tijdelijk uit, zonder LAN_HOST weg te halen:
 * Weekmand is dan alleen via 127.0.0.1 bereikbaar. Standaard aan.
 */
const lanListen = !/^(uit|off|false|0|nee|no)$/i.test(process.env.LAN_LISTEN?.trim() ?? '');
const lanHost = lanListen ? process.env.LAN_HOST : undefined;
if (!lanListen && process.env.LAN_HOST) console.log('LAN_LISTEN staat uit: Weekmand luistert niet op ' + process.env.LAN_HOST + '.');
if (lanHost && (!isIPv4(lanHost) || !/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(lanHost) || !password?.trim())) {
  throw new Error('LAN_HOST vereist een privé-IPv4-adres en een ingesteld APP_PASSWORD.');
}
/**
 * Koppelingen (Picnic, AH, AI, Telegram) beheert iedereen die is ingelogd, vanaf elk adres
 * (besluit 09-11: "Haal dat gewoon weg"). Het eerste account maak je aan vanuit het eigen netwerk.
 */
const canConfigure = (req: IncomingMessage) => uiAllowed(req);
function requireConfigure(req: IncomingMessage) {
  check(canConfigure(req), 'Log eerst in.', 401);
}
const firstAccountAllowed = (req: IncomingMessage) => privateClient(req.socket.remoteAddress ?? '');

// ───────────── Hulpjes ─────────────

async function body(req: IncomingMessage, limit = 65536) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new Problem(415, 'Verwacht application/json.');
  const parts: Buffer[] = [];
  let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > limit) throw new Problem(413, 'Verzoek is te groot.');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { throw new Problem(400, 'Ongeldige JSON.'); }
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
const obj = (v: unknown) => { check(v && typeof v === 'object' && !Array.isArray(v), 'Verwacht een JSON-object.'); return v as Record<string, any>; };

const assets: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/barcode.js': ['barcode.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

// ───────────── Webapp-acties ─────────────

async function state(req: IncomingMessage) {
  const [menu, delivery, pantry] = await Promise.all([app.menu(), app.delivery(), app.pantryStatus()]);
  const configure = canConfigure(req);
  return {
    version, canConfigure: configure, household: app.household, user: uiUser(req), accounts: accounts.list(),
    shop: { mode: app.shopMode, label: app.shop.label, ready: app.shop.ready(), picnic: app.picnic.status, remembered: app.picnic.remembered },
    ah: app.ahStatus(), lidl: app.lidlStatus(), ai: assistant.status(), menu, delivery, pantry,
    order: app.order, regulars: app.regulars(), links: app.shopMode === 'picnic' ? app.links() : [],
    suggestions: app.suggestions(), rules: app.avoid.map(r => app.describeRule(r)),
    notices: store.get<StoredNotice[]>('notices', []).slice(0, 10),
    telegram: { configured: !!telegram, bot: telegram?.botName ?? null, chats: telegram?.chats() ?? [], share: telegram?.shareMode ?? 'changes', error: telegram?.lastError ?? null, fromEnv: !!process.env.TELEGRAM_BOT_TOKEN },
    mqtt: { configured: !!mqtt, connected: mqtt?.connected ?? false, error: mqtt?.lastMessage ?? null },
    history: store.get('picnicHistory', null),
    tags: [...new Set(app.catalog.recipes().flatMap(r => r.tags))].sort(),
    ingredients: app.catalog.ingredients().map(i => ({ key: i.key, name: i.name, unit: i.unit, category: i.category })),
  };
}

type Handler = (input: Record<string, any>, req: IncomingMessage) => Promise<unknown> | unknown;
const ui: Record<string, Handler> = {
  // "Ververs uit Picnic": mand en bezorgmomenten vers lezen.
  // De webapp wacht hooguit anderhalve seconde; daarna het vorige voorstel met refreshing: true.
  plan: async () => { const r = await app.planForUi(true); return { plan: app.withImages(r.plan), summary: planSummary(r.plan), refreshing: r.refreshing }; },
  'plan/current': async () => { const r = await app.planForUi(false); return { plan: app.withImages(r.plan), summary: planSummary(r.plan), refreshing: r.refreshing }; },
  product: async i => app.productInfo(String(i.id ?? '')),
  apply: async i => app.applyPlan(String(i.id)),
  action: async i => handleAction(app, String(i.data)),
  chat: async (i, req) => {
    const before = app.revision;
    const message = String(i.message ?? '');
    const result = await assistant.chat('web', message, 'web');
    // Wat in de webapp verandert, lezen de gekoppelde Telegram-chats mee (Meer → Telegram → Antwoorden delen).
    const who = uiUser(req);
    void telegram?.share(null, who && !['lokaal', 'weekmand', 'api'].includes(who) ? who : 'Iemand in de webapp', message, result.reply, app.revision !== before || !!result.reviewId, reviewButtons(result.reviewId));
    return result;
  },
  'chat/history': () => store.chat('web', 30),
  'chat/clear': () => { store.clearChat('web'); return {}; },
  household: i => app.setHousehold(i),
  'shop-mode': i => app.setShopMode(i.mode),
  list: async () => app.shoppingList(),
  'list/check': i => app.checkListItem(String(i.id ?? ''), i.checked === true),
  'list/clear': () => { app.clearListChecks(); return {}; },
  slot: async i => app.chooseDelivery({ slotId: String(i.id) }),
  delivery: async i => app.chooseDelivery({ slotId: i.slotId ? String(i.slotId) : undefined, date: i.date ? String(i.date) : undefined }),
  'delivery/reset': () => { app.clearDeliveryChoice(); return {}; },
  'menu/shift': async () => ({ moved: await app.shiftMenuToWindow() }),
  'demo-checkout': async () => ({ delivered: await app.completeDemoOrder() }),
  pantry: i => app.updatePantry(i.items),
  'pantry/out': i => app.markOut(String(i.name)),
  'pantry/rebuild': () => app.rebuildPantryFromLastDelivery(),
  'quick-items': i => app.setQuickItems(i.keys),
  scan: i => app.scanBarcode(String(i.code)),
  barcode: i => app.registerBarcode(obj(i) as any),
  recipes: i => app.listRecipes(String(i.query ?? ''), String(i.tag ?? '')),
  recipe: i => app.recipeDetail(String(i.id), i.servings),
  'recipe/add': i => app.catalog.addRecipe(obj(i.recipe) as any, 'user'),
  'recipe/import-preview': async i => app.previewRecipeFromUrl(String(i.url ?? '')),
  'recipe/import-text': i => app.previewRecipeFromText({ name: i.name, servings: i.servings, text: i.text }),
  'recipe/import-save': i => app.saveImportedRecipe(obj(i.preview) as any, Array.isArray(i.skip) ? i.skip.map(String) : []),
  'recipe/delete': i => { app.catalog.deleteRecipe(String(i.id)); return {}; },
  'meal/set': async i => app.setMeal({ date: String(i.date), recipeId: String(i.recipeId), servings: i.servings }),
  'meal/swap': async i => app.swapMeal(String(i.date), String(i.wish ?? '')),
  'meal/replace': async i => ({ replaced: await app.replaceMeals({ dates: i.dates, note: i.note }) }),
  'meal/remove': i => { app.removeMeal(String(i.date)); return {}; },
  'menu/propose': async i => app.proposeMenu({ wish: String(i.wish ?? ''), replace: !!i.replace }),
  'menu/approve': async () => ({ approved: await app.approveMenu() }),
  'order/add': async i => ({ added: await app.addItems(i.items) }),
  'order/remove': async i => ({ removed: await app.removeItems(i.names) }),
  'order/undo-skip': i => { app.undoSkip(String(i.key)); return {}; },
  'plan/decline': i => { app.declineLine(String(i.productId)); return {}; },
  'plan/undecline': i => { app.undoDecline(String(i.productId)); return {}; },
  'order/remove-extra': i => { app.removeExtra(String(i.id)); return {}; },
  cart: async () => app.cart(),
  regular: i => { app.setRegular(obj(i) as any); return {}; },
  search: async i => app.searchProducts(String(i.query ?? '')),
  link: i => app.linkProduct(String(i.name), String(i.productId)),
  suggestion: i => ({ message: app.respondSuggestion(String(i.id), !!i.accept) }),
  'rule/remove': i => { app.removeAvoidRule(Number(i.index)); return {}; },
  history: () => ({ history: app.recipeHistory(), favorites: app.favorites(), disliked: app.disliked(), reasons: Object.values(reasons) }),
  rate: i => ({ message: app.rateMeal(String(i.date), i.rating, i.reason) }),
  'picnic/login': async (i, req) => {
    requireConfigure(req);
    check(typeof i.email === 'string' && i.email.trim() && i.email.length <= 254 && typeof i.password === 'string' && i.password && i.password.length <= 1024,
      'Vul het e-mailadres en wachtwoord van Picnic in.');
    await app.picnic.login(i.email.trim(), i.password, !!i.remember);
    return { status: app.picnic.status };
  },
  'picnic/verify': async (i, req) => {
    requireConfigure(req);
    check(typeof i.code === 'string' && /^\d{4,8}$/.test(i.code), 'Vul de sms-code in.');
    await app.picnic.verify(i.code);
    if (app.shopMode === 'mock') app.setShopMode('picnic');
    return { status: app.picnic.status };
  },
  'picnic/disconnect': () => { app.picnic.disconnect(); app.setShopMode('mock'); return {}; },
  'picnic/import': async () => app.importHistory(),
  'picnic/recipes': async () => app.importPicnicRecipes(),
  'picnic/recipe-list': () => app.picnicRecipes(),
  'ah/link': async (i, req) => { requireConfigure(req); return app.linkAh(String(i.code ?? '')); },
  'ah/unlink': (_i, req) => { requireConfigure(req); app.unlinkAh(); return {}; },
  'ah/proposal': async () => app.ahListProposal(),
  'ah/send': async i => app.sendToAhList({ ids: Array.isArray(i.ids) ? i.ids.map(String) : undefined, extra: Array.isArray(i.extra) ? i.extra.map(String) : [] }),
  'ah/receipts': async () => app.importAhReceipts(),
  'ah/match': async () => app.matchReceiptLines({ force: true }),
  'lidl/link': async (i, req) => { requireConfigure(req); return app.linkLidl(String(i.code ?? '')); },
  'lidl/unlink': (_i, req) => { requireConfigure(req); app.unlinkLidl(); return {}; },
  'lidl/receipts': async () => app.importLidlReceipts(),
  'ah/map': i => app.mapReceiptLine(String(i.name ?? ''), i.ingredient === null ? null : String(i.ingredient ?? ''), i.create ? obj(i.create) : undefined),
  budget: i => app.budgetOverview({ period: i.period, offset: i.offset }),
  'budget/sync': async () => { const r = await app.syncSpending({ details: 12 }); await app.labelProducts().catch(() => null); return r; },
  'budget/label': async () => app.labelProducts({ force: true }),
  'budget/product': i => app.setProductLabel(i),
  'budget/spend': i => app.spendDetail(String(i.id ?? '')),
  'budget/expense': i => app.addExpense(i),
  'budget/expense/remove': i => { app.removeExpense(String(i.id ?? '')); return {}; },
  'budget/exclude': i => { app.excludeSpend(String(i.id ?? ''), !!i.excluded); return {}; },
  'budget/settings': i => app.setBudget({ month: i.month, limit: i.limit }),
  'budget/photo': async i => app.previewReceiptPhoto(i.image),
  'budget/photo/save': i => app.saveReceiptPhoto(i),
  'ai/connect': async (i, req) => { requireConfigure(req); return assistant.connect(obj(i) as any); },
  'ai/disconnect': (i, req) => { requireConfigure(req); assistant.disconnect(typeof i.provider === 'string' ? i.provider : undefined); return {}; },
  // Wisselen en de modellijst gebruiken de bewaarde sleutel; die gaat nooit naar de webapp.
  'ai/use': async i => assistant.use(obj(i) as any),
  'ai/models': async i => assistant.models(String(i.provider ?? '')),
  'ai/usage': () => assistant.usage(),
  'ai/price': i => assistant.setPrice(String(i.model ?? ''), i.price === null ? null : { in: Number((i.price as any)?.in), out: Number((i.price as any)?.out) }),
  'telegram/token': (i, req) => {
    requireConfigure(req);
    check(typeof i.token === 'string' && /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(i.token.trim()), 'Dit lijkt geen Telegram-bottoken. Je krijgt het van @BotFather.');
    secrets.set('telegramToken', i.token.trim());
    startTelegram();
    return {};
  },
  'telegram/pair': (_i, req) => { requireConfigure(req); check(telegram, 'Stel eerst een Telegram-bot in.'); return { code: telegram.pairingCode(), bot: telegram.botName }; },
  'telegram/unpair': (i, req) => { requireConfigure(req); telegram?.unpair(Number(i.chat)); return {}; },
  'telegram/share': (i, req) => { requireConfigure(req); check(telegram, 'Geen Telegram-bot ingesteld.'); telegram.setShareMode(String(i.mode)); return {}; },
  'telegram/remove': (_i, req) => { requireConfigure(req); secrets.set('telegramToken', undefined); startTelegram(); return {}; },
  'telegram/test': async () => { check(telegram, 'Geen Telegram-bot ingesteld.'); await telegram.broadcast({ text: 'Testbericht van Weekmand. Werkt!' }); return {}; },
  'cutoff/test': async () => { const { cutoffNotice } = await import('./actions.ts'); const n = await cutoffNotice(app); check(n, 'Geen bezorgmoment bekend.'); app.notify({ ...n, key: undefined }); return n; },
  token: (_i, req) => { requireConfigure(req); return { token: secrets.apiToken() }; },
  'account/create': i => ({ name: accounts.create(i.name, i.password) }),
  'account/password': (i, req) => {
    const user = uiUser(req)!;
    check(accounts.list().includes(user), 'Je bent ingelogd met het app-wachtwoord. Maak een eigen account aan om een wachtwoord te kiezen.');
    accounts.setPassword(user, i.password);
    return {};
  },
  'account/delete': (i, req) => { accounts.remove(String(i.name), uiUser(req)!); return {}; },
};

// ───────────── Inloggen ─────────────

function setSession(res: ServerResponse, token: string | null) {
  res.setHeader('Set-Cookie', token
    ? `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDays * 86400}`
    : `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}
async function auth(action: string, req: IncomingMessage, res: ServerResponse) {
  const status = () => ({ user: uiUser(req), required: loginRequired(), setup: accounts.count === 0 && firstAccountAllowed(req) });
  if (action === 'status') return json(res, 200, status());
  if (req.method !== 'POST') throw new Problem(405, 'Gebruik POST.');
  const input = obj(await body(req));
  if (action === 'login') {
    const name = accounts.verify(input.name, input.password, req.socket.remoteAddress ?? '', password);
    setSession(res, accounts.startSession(name));
    return json(res, 200, { user: name });
  }
  if (action === 'setup') {
    check(accounts.count === 0, 'Er bestaat al een account. Log in.', 409);
    check(firstAccountAllowed(req), 'Het eerste account maak je aan vanaf het thuisnetwerk.', 403);
    const name = accounts.create(input.name, input.password);
    setSession(res, accounts.startSession(name));
    return json(res, 200, { user: name });
  }
  if (action === 'logout') {
    accounts.endSession(cookieValue(req.headers.cookie, COOKIE));
    setSession(res, null);
    return json(res, 200, {});
  }
  throw new Problem(404, 'Onbekend adres.');
}

// ───────────── HTTP ─────────────

// Meten waar de app op wacht: trage aanvragen (meestal Picnic of de AI) en momenten waarop de
// server helemaal vastzit (zwaar rekenwerk). Alleen het adres en de duur, geen inhoud.
const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS || 1500);
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
setInterval(() => {
  const worst = loopDelay.max / 1e6;
  if (worst > 300) console.log(`Weekmand zat ${Math.round(worst)} ms vast (de traagste keer in de afgelopen minuut).`);
  loopDelay.reset();
}, 60_000).unref();

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const started = performance.now();
  res.once('finish', () => {
    const ms = Math.round(performance.now() - started);
    if (ms >= SLOW_REQUEST_MS && req.url !== '/mcp') console.log(`Traag: ${req.method} ${(req.url ?? '').split('?')[0]} ${ms} ms (status ${res.statusCode})`);
  });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', `default-src 'self'; img-src 'self' blob: data: ${PICNIC_IMAGE_ORIGIN}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
  const url = new URL(req.url ?? '/', 'http://x');
  const route = url.pathname;
  try {
    if (route === '/health' && req.method === 'GET') return json(res, 200, { ok: true, version, rssMb: Math.round(process.memoryUsage.rss() / 1048576) });
    // Verzoeken uit een andere website (CSRF) weigeren.
    const origin = req.headers.origin;
    if (req.method === 'POST' && origin && origin !== 'null' && new URL(origin).host !== req.headers.host) throw new Problem(403, 'Verzoek van een andere website geweigerd.');

    if (route === '/mcp') {
      if (!apiAllowed(req)) { res.setHeader('WWW-Authenticate', 'Bearer realm="Weekmand"'); return json(res, 401, { error: 'API-token vereist.' }); }
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'Gebruik POST.' }); }
      const reply = await handleMcp(app, await body(req, 262144));
      if (reply === null) { res.writeHead(202); return res.end(); }
      return json(res, 200, reply);
    }
    if (route === '/openapi.json' && req.method === 'GET') {
      if (!apiAllowed(req) && !uiAllowed(req)) return json(res, 401, { error: 'API-token vereist.' });
      return json(res, 200, openApi(publicUrl || `http://${req.headers.host}`));
    }
    if (route.startsWith('/api/tools/') && req.method === 'POST') {
      if (!apiAllowed(req)) return json(res, 401, { error: 'API-token vereist.' });
      return json(res, 200, await runTool(app, route.slice(11), await body(req), { channel: 'openapi' }));
    }

    // De app zelf (HTML, JS, CSS) bevat geen gegevens en laadt zonder login; het inlogscherm zit erin.
    const asset = Object.hasOwn(assets, route) ? assets[route] : null;
    if (req.method === 'GET' && asset) {
      res.writeHead(200, { 'Content-Type': asset[1] });
      return res.end(readFileSync(new URL('../public/' + asset[0], import.meta.url)));
    }
    if (route.startsWith('/api/auth/')) return await auth(route.slice(10), req, res);
    if (!uiAllowed(req)) return json(res, 401, { error: 'Log eerst in.', login: true });
    if (req.method === 'GET' && route === '/api/state') return json(res, 200, await state(req));
    if (req.method === 'GET' && route === '/api/budget.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="weekmand-uitgaven-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
      return res.end(app.budgetCsv({ from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
    }
    if (req.method === 'POST' && route.startsWith('/api/ui/')) {
      const handler = Object.hasOwn(ui, route.slice(8)) ? ui[route.slice(8)] : null;
      if (!handler) throw new Problem(404, 'Onbekend adres.');
      // Een foto van een bon mag groter zijn dan een gewoon verzoek.
      const result = await handler(obj(await body(req, route === '/api/ui/budget/photo' ? 9_000_000 : undefined)), req);
      return json(res, 200, result ?? {});
    }
    return json(res, 404, { error: 'Onbekend adres.' });
  } catch (error) {
    if (error instanceof Problem) return json(res, error.status, { error: error.message });
    console.error(route, error);
    return json(res, 500, { error: 'De bewerking is mislukt. Probeer het opnieuw.' });
  }
}

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '127.0.0.1';
const servers: ReturnType<typeof createServer>[] = [];
function listen(address: string, ready?: () => void) {
  const server = createServer(handleRequest);
  server.requestTimeout = 180_000;
  servers.push(server);
  server.listen(port, address, () => {
    const bound = server.address();
    if (bound && typeof bound !== 'string') console.log(`Weekmand ${version} luistert op ${address}:${bound.port}`);
    ready?.();
  });
}
if (lanHost && lanHost !== host) listen(lanHost, () => listen(host));
else listen(host);

async function shutdown() {
  scheduler.stop();
  telegram?.stop();
  await mqtt?.stop().catch(() => {});
  for (const s of servers) s.close();
  store.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
