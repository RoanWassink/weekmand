import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Assistant } from '../src/assistant.ts';
import { summarize } from '../src/budget.ts';
import type { ReceiptPhoto } from '../src/budget.ts';
import { makeApp } from './helpers.ts';

const photo = 'data:image/jpeg;base64,' + Buffer.from('nepfoto').toString('base64');
/** Wat de AI van een Lidl-bonnetje zou lezen. */
const lidl: ReceiptPhoto = {
  shop: 'LIDL', date: '2026-11-09', totalCents: 1062,
  lines: [
    { name: 'Halfvolle melk 1L', quantity: 2, cents: 218, category: 'zuivel', kind: 'nodig' },
    { name: 'Chips paprika', quantity: 1, cents: 129, category: 'snacks', kind: 'extra' },
    { name: 'Kipfilet 500g', quantity: 1, cents: 765, category: 'vlees-vis', kind: 'nodig' },
  ],
  discounts: [{ name: 'Korting kipfilet', cents: -50 }],
};

test('foto van een bon: lezen, controleren, opslaan (en niet twee keer)', async () => {
  const { app } = makeApp();
  let seen: { mediaType: string; data: string } | null = null;
  await assert.rejects(app.previewReceiptPhoto(photo), { status: 409 }, 'zonder AI');
  app.receiptReader = async image => { seen = image; return structuredClone(lidl); };
  await assert.rejects(app.previewReceiptPhoto('geen foto'), /Kies een foto/);

  const preview = await app.previewReceiptPhoto(photo);
  assert.deepEqual(seen, { mediaType: 'image/jpeg', data: Buffer.from('nepfoto').toString('base64') });
  assert.equal(preview.shop, 'Lidl', 'HOOFDLETTERS worden gewoon');
  assert.equal(preview.date, '2026-11-09');
  assert.equal(preview.sumCents, 1062, 'regels min korting = totaal');
  assert.equal(preview.duplicate, null);

  const saved = app.saveReceiptPhoto({ ...preview, pantry: true });
  assert.equal(saved.spend.source, 'manual');
  assert.equal(saved.spend.discounts![0].line, 2, 'korting bij de kipfilet');
  assert.ok(saved.pantry!.counted.length >= 2, 'melk en kipfilet bij de voorraad');
  assert.ok(app.store.pantryItem('melk')!.amount! >= 2000);

  const month = app.budgetOverview({ period: 'month' });
  assert.deepEqual(month.shops, [{ name: 'Lidl', cents: 1062 }]);
  assert.equal(month.savingsCents, 50);
  assert.equal(month.kinds.find(k => k.key === 'extra')!.cents, 129, 'de AI-indeling van het lezen is bewaard');
  assert.equal(month.products.find(p => p.name === 'Kipfilet 500g')!.cents, 715);

  // Dezelfde bon nog eens: gewaarschuwd, alleen met force opgeslagen.
  const again = await app.previewReceiptPhoto(photo);
  assert.equal(again.duplicate?.shop, 'Lidl');
  assert.throws(() => app.saveReceiptPhoto({ ...again }), /lijkt er al te staan/);
  app.saveReceiptPhoto({ ...again, force: true });
  assert.equal(app.budgetOverview({ period: 'month' }).count, 2);

  // Een foto van een AH-bon telt bij Albert Heijn.
  assert.deepEqual(summarize([{ id: 'x', source: 'manual', date: '2026-11-09', totalCents: 100, shop: 'Albert Heijn 1234', lines: [{ name: 'Brood', quantity: 1, cents: 100 }] }], () => null).shops, [{ name: 'Albert Heijn', cents: 100 }]);
});

test('foto van een bon via Mistral: afbeelding in het verzoek, ander model als het gekozen model geen foto leest', async t => {
  const { app } = makeApp();
  process.env.AI_PROVIDER = 'mistral';
  process.env.AI_API_KEY = 'test-key-123';
  process.env.AI_MODEL = 'mistral-large-latest';
  t.after(() => { delete process.env.AI_PROVIDER; delete process.env.AI_API_KEY; delete process.env.AI_MODEL; });
  const models: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    models.push(body.model);
    if (body.model === 'mistral-large-latest') return new Response('{"message":"model does not support images"}', { status: 400 });
    const content = body.messages.at(-1).content;
    if (body.messages.at(-1).role === 'tool') return Response.json({ choices: [{ message: { role: 'assistant', content: 'Klaar.' } }] });
    assert.equal(content[1].type, 'image_url');
    assert.match(content[1].image_url, /^data:image\/jpeg;base64,/, 'Mistral: afbeelding als tekenreeks');
    assert.equal(body.max_tokens, 6000);
    const args = { winkel: 'Jumbo', datum: '2026-11-08', totaal: 3.98, regels: [{ naam: 'Bananen', aantal: 1, bedrag: 1.99, categorie: 'groente-fruit', soort: 'nodig' }, { naam: 'Stroopwafels', aantal: 1, bedrag: 1.99, categorie: 'snacks', soort: 'extra' }], kortingen: [] };
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lees_bon', arguments: JSON.stringify(args) } }] } }] });
  });
  const read = await new Assistant(app).readReceiptPhoto({ mediaType: 'image/jpeg', data: 'abc' }, '2026-11-10');
  assert.deepEqual(models.slice(0, 2), ['mistral-large-latest', 'mistral-medium-latest']);
  assert.deepEqual(read, {
    shop: 'Jumbo', date: '2026-11-08', totalCents: 398, discounts: [],
    lines: [{ name: 'Bananen', quantity: 1, cents: 199, category: 'groente-fruit', kind: 'nodig' }, { name: 'Stroopwafels', quantity: 1, cents: 199, category: 'snacks', kind: 'extra' }],
  });
});

test('foto van een bon: DeepSeek kan geen foto\'s lezen en zegt dat', async t => {
  const { app } = makeApp();
  process.env.AI_PROVIDER = 'deepseek';
  process.env.AI_API_KEY = 'test-key-123';
  t.after(() => { delete process.env.AI_PROVIDER; delete process.env.AI_API_KEY; });
  await assert.rejects(new Assistant(app).readReceiptPhoto({ mediaType: 'image/jpeg', data: 'abc' }, '2026-11-10'), /kan geen foto's lezen/);
});

test('foto van een bon via Telegram: lezen, knoppen, opslaan met voorraad', async t => {
  const { TelegramBot } = await import('../src/telegram.ts');
  const { app } = makeApp();
  app.receiptReader = async () => structuredClone(lidl);
  app.store.set('telegram', { chats: [1], names: { 1: 'Roan' } });
  const sent: { text: string; buttons: any[] }[] = [];
  const queue: any[] = [{ update_id: 1, message: { chat: { id: 1 }, from: { first_name: 'Roan' }, photo: [{ file_id: 'klein', file_size: 900 }, { file_id: 'groot', file_size: 90000 }] } }];
  let asked = '';
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    if (url.includes('/file/bottoken/')) { asked = url.split('/').pop()!; return new Response(Buffer.from('nepfoto')); }
    const method = url.split('/').pop();
    const body = JSON.parse(String(init.body ?? '{}'));
    if (method === 'getUpdates') {
      const batch = queue.splice(0);
      if (!batch.length) await new Promise(r => setTimeout(r, 20));
      return Response.json({ ok: true, result: batch });
    }
    if (method === 'getFile') { assert.equal(body.file_id, 'groot', 'de grootste versie van de foto'); return Response.json({ ok: true, result: { file_path: 'photos/bon.jpg' } }); }
    if (method === 'sendMessage') {
      const buttons = body.reply_markup?.inline_keyboard?.[0] ?? [];
      sent.push({ text: body.text, buttons });
      const save = buttons.find((b: any) => b.text === 'Opslaan + voorraad');
      if (save) queue.push({ update_id: 2, callback_query: { id: 'q', from: { first_name: 'Roan' }, data: save.callback_data, message: { message_id: 5, chat: { id: 1 }, reply_markup: { inline_keyboard: [buttons] } } } });
    }
    return Response.json({ ok: true, result: method === 'getMe' ? { username: 'weekmand_bot' } : true });
  });
  const bot = new TelegramBot(app, new Assistant(app), 'token');
  bot.start();
  for (let i = 0; i < 200 && !sent.some(s => s.text.startsWith('Bon opgeslagen')); i++) await new Promise(r => setTimeout(r, 10));
  bot.stop();
  assert.equal(asked, 'bon.jpg');
  const shown = sent.find(s => s.buttons.length)!;
  assert.match(shown.text, /^Lidl, 9 november: €\s10,62/);
  assert.match(shown.text, /Chips paprika  €\s1,29 \(extra\)/);
  assert.match(shown.text, /Regels en totaal kloppen/);
  assert.match(sent.at(-1)!.text, /^Bon opgeslagen: Lidl, 9 november, €\s10,62\. \d+ producten bij de voorraad geteld/);
  assert.equal(app.budgetOverview({ period: 'month' }).shops[0].name, 'Lidl');
  assert.deepEqual(app.store.get('telegramReceipts', {}), {}, 'verwerkt: de knoppen werken niet nog eens');
});
