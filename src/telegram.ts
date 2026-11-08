import { randomInt, randomUUID } from 'node:crypto';
import { handleAction, openQuestion } from './actions.ts';
import type { Notice, Weekmand } from './app.ts';
import type { Assistant } from './assistant.ts';
import { formatMenu } from './assistant.ts';
import { normalize } from './catalog.ts';
import { Problem } from './errors.ts';
import { euro } from './units.ts';
import type { ReceiptPhoto } from './budget.ts';

/** Een gelezen bon die op "Opslaan" wacht; staat in de database, zodat de knoppen een herstart overleven. */
type PendingReceipt = { at: number; chat: number; preview: ReceiptPhoto & { duplicate: unknown } };
const dayMonth = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long', timeZone: 'UTC' });

/**
 * Telegram-bot via long polling: werkt achter NAT, zonder open poort op de router.
 * Alleen gekoppelde chats mogen de bot gebruiken. Koppelen gaat met een eenmalige code
 * die de webapp toont ("/start 123456").
 */
/**
 * share: wat de bot in de ene chat antwoordt, ook naar de andere gekoppelde chats sturen.
 * 'changes' (standaard): alleen als er iets veranderde (voorraad, menu, lijst, mand); 'all': ook vragen.
 */
export type ShareMode = 'changes' | 'all' | 'off';
type TelegramState = { chats: number[]; code?: string; codeExpires?: number; names?: Record<string, string>; share?: ShareMode };
type Button = { label: string; data: string };
const shareModes: ShareMode[] = ['changes', 'all', 'off'];
/** Knoppen onder een voorgestelde mandwijziging. */
export const reviewButtons = (reviewId?: string): Button[] | undefined =>
  reviewId ? [{ label: 'Naar Picnic sturen', data: 'apply:' + reviewId }, { label: 'Niet nu', data: 'skip:' + reviewId }] : undefined;

export class TelegramBot {
  #app: Weekmand;
  #assistant: Assistant;
  #token: string;
  #offset = 0;
  #running = false;
  #controller: AbortController | null = null;
  lastError: string | null = null;
  botName: string | null = null;

  constructor(app: Weekmand, assistant: Assistant, token: string) {
    this.#app = app;
    this.#assistant = assistant;
    this.#token = token;
    // Na een herstart verder waar de bot was: een bericht wordt nooit twee keer uitgevoerd.
    const saved = app.store.get<{ bot: string; offset: number } | null>('telegramOffset', null);
    this.#offset = saved?.bot === this.#botId ? saved.offset : 0;
  }
  get #botId() { return this.#token.split(':')[0]; }

  get state(): TelegramState { return this.#app.store.get<TelegramState>('telegram', { chats: [] }); }

  /** Nieuwe koppelcode, 15 minuten geldig. */
  pairingCode() {
    const code = String(randomInt(100000, 999999));
    this.#app.store.update<TelegramState>('telegram', { chats: [] }, s => ({ ...s, code, codeExpires: this.#app.now() + 15 * 60_000 }));
    return code;
  }
  unpair(chatId: number) { this.#app.store.update<TelegramState>('telegram', { chats: [] }, s => ({ ...s, chats: s.chats.filter(c => c !== chatId) })); }

  get shareMode(): ShareMode { return this.state.share ?? 'changes'; }
  setShareMode(mode: string) {
    if (!shareModes.includes(mode as ShareMode)) throw new Problem(400, 'Kies changes, all of off.');
    this.#app.store.update<TelegramState>('telegram', { chats: [] }, s => ({ ...s, share: mode as ShareMode }));
  }
  /** Gekoppelde chats met de naam van wie er praat (voor de webapp). */
  chats() { const names = this.state.names ?? {}; return this.state.chats.map(id => ({ id, name: names[id] ?? null })); }

  /**
   * Laat de andere chats meelezen: "Roan: melk is op" plus het antwoord van de bot.
   * `from` is de chat waar het vandaan kwam (null voor de webapp); die krijgt het niet nog eens.
   */
  async share(from: number | null, who: string, said: string, reply: string, changed: boolean, buttons?: Button[]) {
    const mode = this.shareMode;
    if (mode === 'off' || (mode === 'changes' && !changed)) return;
    for (const chat of this.state.chats) {
      if (chat === from) continue;
      try { await this.send(chat, `${who}: ${said.slice(0, 300)}\n\n${reply}`, buttons); } catch (error) { this.lastError = (error as Error).message; }
    }
  }

  /** Foto van een bon: ophalen bij Telegram, laten lezen, en tonen met knoppen om op te slaan. */
  async #readReceipt(chat: number, file: { file_id: string; file_size?: number; mime?: string }) {
    await this.#api('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
    await this.send(chat, 'Bon ontvangen, ik lees hem. Dat duurt een halve minuut.').catch(() => {});
    try {
      if ((file.file_size ?? 0) > 6_000_000) throw new Problem(422, 'Deze foto is te groot. Stuur hem als foto in plaats van als bestand.');
      const info = await this.#api('getFile', { file_id: file.file_id });
      const path = String(info?.file_path ?? '');
      const res = await fetch(`https://api.telegram.org/file/bot${this.#token}/${path}`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
      if (!path || !res?.ok) throw new Problem(502, 'De foto kon niet bij Telegram opgehaald worden. Probeer het nog eens.');
      const mime = file.mime ?? (path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
      const preview = await this.#app.previewReceiptPhoto(`data:${mime};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`);
      const id = randomUUID().slice(0, 8);
      const now = this.#app.now();
      this.#app.store.update<Record<string, PendingReceipt>>('telegramReceipts', {}, all => {
        for (const [k, v] of Object.entries(all)) if (now - v.at > 3 * 86_400_000) delete all[k];
        all[id] = { at: now, chat, preview };
        return all;
      });
      const p = preview;
      const sum = p.lines.reduce((s, l) => s + l.cents, 0) + p.discounts.reduce((s, d) => s + d.cents, 0);
      const text = [
        `${p.shop}, ${dayMonth.format(new Date(p.date + 'T12:00:00Z'))}: ${euro(p.totalCents)}`,
        '',
        ...p.lines.slice(0, 30).map(l => `${l.quantity > 1 ? l.quantity + '× ' : ''}${l.name}  ${euro(l.cents)}${l.kind === 'extra' ? ' (extra)' : ''}`),
        ...(p.lines.length > 30 ? [`… en nog ${p.lines.length - 30} regels`] : []),
        ...p.discounts.map(d => `${d.name}  −${euro(-d.cents)}`),
        '',
        Math.abs(p.totalCents - sum) > 2 ? `Let op: de regels zijn samen ${euro(sum)}, het totaal ${euro(p.totalCents)}. Pas het eventueel aan in de webapp (Budget).` : 'Regels en totaal kloppen.',
        ...(p.duplicate ? ['Deze bon lijkt er al te staan; opslaan zet hem er nog een keer bij.'] : []),
      ].join('\n');
      await this.send(chat, text, [
        { label: 'Opslaan', data: `bon:${id}:save` }, { label: 'Opslaan + voorraad', data: `bon:${id}:pantry` }, { label: 'Weggooien', data: `bon:${id}:skip` },
      ]);
    } catch (error) {
      await this.send(chat, error instanceof Problem ? error.message : 'Het lezen van de bon ging mis. Probeer het zo nog eens.');
      if (!(error instanceof Problem)) console.error('Telegram-bon', (error as Error).message);
    }
  }

  /** Knop onder een gelezen bon: opslaan (eventueel met voorraad) of weggooien. */
  #receiptChoice(data: string): { text: string; buttons?: Button[] } {
    const [, id, choice] = data.split(':');
    const pending = this.#app.store.get<Record<string, PendingReceipt>>('telegramReceipts', {})[id];
    if (!pending) return { text: 'Deze bon is al verwerkt of verlopen. Stuur de foto opnieuw als je hem wilt bewaren.' };
    const forget = () => this.#app.store.update<Record<string, PendingReceipt>>('telegramReceipts', {}, all => { delete all[id]; return all; });
    if (choice === 'skip') { forget(); return { text: 'Bon weggegooid.' }; }
    try {
      const r = this.#app.saveReceiptPhoto({ ...pending.preview, pantry: choice === 'pantry', force: true });
      forget();
      const p = pending.preview;
      return { text: `Bon opgeslagen: ${p.shop}, ${dayMonth.format(new Date(p.date + 'T12:00:00Z'))}, ${euro(p.totalCents)}.`
        + (r.pantry ? ` ${r.pantry.counted.length} producten bij de voorraad geteld${r.pantry.unmatched.length ? `; niet herkend: ${r.pantry.unmatched.slice(0, 5).join(', ')}` : ''}.` : '') };
    } catch (error) {
      return { text: error instanceof Problem ? error.message : 'Opslaan ging mis. Probeer het nog eens.' };
    }
  }

  #rememberName(chat: number, from: any) {
    const name = String(from?.first_name ?? from?.username ?? '').trim().slice(0, 40);
    if (!name || this.state.names?.[chat] === name) return;
    this.#app.store.update<TelegramState>('telegram', { chats: [] }, s => ({ ...s, names: { ...s.names, [chat]: name } }));
  }
  #who(chat: number) { return this.state.names?.[chat] ?? 'Iemand'; }

  async #api(method: string, body: Record<string, unknown>, timeoutMs = 15_000) {
    const response = await fetch(`https://api.telegram.org/bot${this.#token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: this.#controller ? AbortSignal.any([this.#controller.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json().catch(() => ({})) as { ok?: boolean; result?: any; description?: string };
    if (!data.ok) throw new Error(`Telegram ${method}: ${response.status} ${data.description ?? ''}`.trim());
    return data.result;
  }

  async send(chatId: number, text: string, buttons?: Button[]) {
    await this.#api('sendMessage', {
      chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true,
      ...(buttons?.length ? { reply_markup: { inline_keyboard: [buttons.map(b => ({ text: b.label, callback_data: b.data.slice(0, 64) }))] } } : {}),
    });
  }

  async broadcast(notice: Notice) {
    for (const chat of this.state.chats) {
      try { await this.send(chat, notice.text, notice.buttons); } catch (error) { this.lastError = (error as Error).message; }
    }
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#controller = new AbortController();
    void this.#loop();
  }
  stop() {
    this.#running = false;
    this.#controller?.abort();
  }

  async #loop() {
    try { this.botName = (await this.#api('getMe', {})).username; } catch (error) { this.lastError = (error as Error).message; }
    let delay = 2000;
    while (this.#running) {
      try {
        const updates = await this.#api('getUpdates', { offset: this.#offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 65_000);
        delay = 2000;
        this.lastError = null;
        for (const update of updates) {
          this.#offset = update.update_id + 1;
          this.#app.store.set('telegramOffset', { bot: this.#botId, offset: this.#offset });
          try { await this.#handle(update); } catch (error) { console.error('Telegram-bericht', error); }
        }
      } catch (error) {
        if (!this.#running) return;
        this.lastError = (error as Error).message;
        await new Promise(r => setTimeout(r, delay).unref());
        delay = Math.min(delay * 2, 120_000);
      }
    }
  }

  async #handle(update: any) {
    if (update.callback_query) {
      const q = update.callback_query;
      const chat = q.message?.chat?.id;
      await this.#api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
      if (!this.state.chats.includes(chat)) return;
      this.#rememberName(chat, q.from);
      const before = this.#app.revision;
      const isReceipt = typeof q.data === 'string' && q.data.startsWith('bon:');
      const reply = isReceipt ? this.#receiptChoice(q.data) : await handleAction(this.#app, q.data);
      // Knoppen onder het oude bericht weghalen, zodat ze niet twee keer gebruikt worden.
      await this.#api('editMessageReplyMarkup', { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await this.send(chat, reply.text, reply.buttons);
      const label = (q.message?.reply_markup?.inline_keyboard ?? []).flat().find((b: any) => b?.callback_data === q.data)?.text ?? 'knop';
      await this.share(chat, this.#who(chat), isReceipt ? `[foto van een bon: ${label}]` : `[${label}]`, reply.text, this.#app.revision !== before || (isReceipt && /opgeslagen/i.test(reply.text)), reply.buttons);
      return;
    }
    const message = update.message;
    const chat = message?.chat?.id;
    const text: string = (message?.text ?? '').trim();
    // Een foto (of een afbeelding als bestand) is een kassabon.
    const photo = Array.isArray(message?.photo) && message.photo.length ? message.photo.at(-1)
      : /^image\/(jpeg|png|webp)$/.test(message?.document?.mime_type ?? '') ? { ...message.document, mime: message.document.mime_type } : null;
    if (!chat || (!text && !photo)) return;
    if (photo && this.state.chats.includes(chat)) {
      this.#rememberName(chat, message.from);
      await this.#readReceipt(chat, photo);
      return;
    }
    if (!this.state.chats.includes(chat)) {
      const code = /^(?:\/start\s+)?(\d{6})$/.exec(text)?.[1];
      const s = this.state;
      if (code && s.code === code && (s.codeExpires ?? 0) > this.#app.now()) {
        this.#app.store.set('telegram', { ...s, chats: [...s.chats, chat], code: undefined, codeExpires: undefined });
        this.#rememberName(chat, message.from);
        await this.send(chat, 'Gekoppeld! Ik stuur je hier een seintje voor de Picnic-deadline. Je kunt me ook gewoon berichten sturen, zoals "wat eten we deze week?" of "melk is op".');
      } else {
        await this.send(chat, 'Deze bot hoort bij een privé Weekmand. Koppel hem via Instellingen → Telegram in Weekmand en stuur de code hierheen.');
      }
      return;
    }
    this.#rememberName(chat, message.from);
    const t = normalize(text);
    if (t === 'start' || t === 'help') {
      await this.send(chat, 'Stuur gewoon een bericht, bijvoorbeeld: "Wat staat er deze week op het menu?", "We eten vrijdag met 6 man Mexicaans", "Voeg een krat pils toe en haal de kipfilet eruit" of "melk is op". Snelkoppelingen: /menu /mand /voorraad');
      return;
    }
    const before = this.#app.revision;
    if (t === 'menu') {
      const reply = formatMenu(await this.#app.menu());
      await this.send(chat, reply);
      await this.share(chat, this.#who(chat), text, reply, false);
      return;
    }
    const asked = openQuestion(this.#app);
    if (asked && /^(ja|jep|yes|klopt|nee|nope|no|op)$/.test(t)) {
      const reply = await handleAction(this.#app, `q:${asked}:${/^(ja|jep|yes|klopt)$/.test(t) ? 'yes' : 'no'}`);
      await this.send(chat, reply.text, reply.buttons);
      await this.share(chat, this.#who(chat), text, reply.text, this.#app.revision !== before, reply.buttons);
      return;
    }
    await this.#api('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
    try {
      const result = await this.#assistant.chat('tg:' + chat, t === 'mand' ? 'mand' : t === 'voorraad' ? 'voorraad' : text, 'telegram');
      const buttons = reviewButtons(result.reviewId);
      await this.send(chat, result.reply || 'Klaar.', buttons);
      await this.share(chat, this.#who(chat), text, result.reply || 'Klaar.', this.#app.revision !== before || !!buttons, buttons);
    } catch (error) {
      await this.send(chat, error instanceof Problem ? error.message : 'Er ging iets mis. Probeer het zo opnieuw.');
      if (!(error instanceof Problem)) console.error('Telegram-chat', error);
    }
  }
}
