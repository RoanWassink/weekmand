import { randomInt } from 'node:crypto';
import { handleAction, openQuestion } from './actions.ts';
import type { Notice, Weekmand } from './app.ts';
import type { Assistant } from './assistant.ts';
import { formatMenu } from './assistant.ts';
import { normalize } from './catalog.ts';
import { Problem } from './errors.ts';

/**
 * Telegram-bot via long polling: werkt achter NAT, zonder open poort op de router.
 * Alleen gekoppelde chats mogen de bot gebruiken. Koppelen gaat met een eenmalige code
 * die de webapp toont ("/start 123456").
 */
type TelegramState = { chats: number[]; code?: string; codeExpires?: number };
type Button = { label: string; data: string };

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
  }

  get state(): TelegramState { return this.#app.store.get<TelegramState>('telegram', { chats: [] }); }

  /** Nieuwe koppelcode, 15 minuten geldig. */
  pairingCode() {
    const code = String(randomInt(100000, 999999));
    this.#app.store.update<TelegramState>('telegram', { chats: [] }, s => ({ ...s, code, codeExpires: this.#app.now() + 15 * 60_000 }));
    return code;
  }
  unpair(chatId: number) { this.#app.store.update<TelegramState>('telegram', { chats: [] }, s => ({ ...s, chats: s.chats.filter(c => c !== chatId) })); }

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
      const reply = await handleAction(this.#app, q.data);
      // Knoppen onder het oude bericht weghalen, zodat ze niet twee keer gebruikt worden.
      await this.#api('editMessageReplyMarkup', { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await this.send(chat, reply.text, reply.buttons);
      return;
    }
    const message = update.message;
    const chat = message?.chat?.id;
    const text: string = (message?.text ?? '').trim();
    if (!chat || !text) return;
    if (!this.state.chats.includes(chat)) {
      const code = /^(?:\/start\s+)?(\d{6})$/.exec(text)?.[1];
      const s = this.state;
      if (code && s.code === code && (s.codeExpires ?? 0) > this.#app.now()) {
        this.#app.store.set('telegram', { chats: [...s.chats, chat], code: undefined, codeExpires: undefined });
        await this.send(chat, 'Gekoppeld! Ik stuur je hier een seintje voor de Picnic-deadline. Je kunt me ook gewoon berichten sturen, zoals "wat eten we deze week?" of "melk is op".');
      } else {
        await this.send(chat, 'Deze bot hoort bij een privé Weekmand. Koppel hem via Instellingen → Telegram in Weekmand en stuur de code hierheen.');
      }
      return;
    }
    const t = normalize(text);
    if (t === 'start' || t === 'help') {
      await this.send(chat, 'Stuur gewoon een bericht, bijvoorbeeld: "Wat staat er deze week op het menu?", "We eten vrijdag met 6 man Mexicaans", "Voeg een krat pils toe en haal de kipfilet eruit" of "melk is op". Snelkoppelingen: /menu /mand /voorraad');
      return;
    }
    if (t === 'menu') { await this.send(chat, formatMenu(await this.#app.menu())); return; }
    const asked = openQuestion(this.#app);
    if (asked && /^(ja|jep|yes|klopt|nee|nope|no|op)$/.test(t)) {
      const reply = await handleAction(this.#app, `q:${asked}:${/^(ja|jep|yes|klopt)$/.test(t) ? 'yes' : 'no'}`);
      await this.send(chat, reply.text, reply.buttons);
      return;
    }
    await this.#api('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
    try {
      const result = await this.#assistant.chat('tg:' + chat, t === 'mand' ? 'mand' : t === 'voorraad' ? 'voorraad' : text, 'telegram');
      await this.send(chat, result.reply || 'Klaar.', result.reviewId ? [{ label: 'Naar Picnic sturen', data: 'apply:' + result.reviewId }, { label: 'Niet nu', data: 'skip:' + result.reviewId }] : undefined);
    } catch (error) {
      await this.send(chat, error instanceof Problem ? error.message : 'Er ging iets mis. Probeer het zo opnieuw.');
      if (!(error instanceof Problem)) console.error('Telegram-chat', error);
    }
  }
}
