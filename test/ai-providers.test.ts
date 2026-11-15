import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Assistant } from '../src/assistant.ts';
import { makeApp } from './helpers.ts';

/** Nep-API voor OpenAI-compatibele aanbieders (Mistral, DeepSeek): modellijst en antwoorden met tokens. */
function fakeApi(t: { mock: { method: Function } }) {
  const calls: { url: string; auth: string; model?: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit = {}) => {
    const auth = new Headers(options.headers).get('authorization') ?? '';
    if (url.endsWith('/models')) {
      calls.push({ url, auth });
      return Response.json({ data: [{ id: 'deepseek-flash' }, { id: 'deepseek-pro' }, { id: 'mistral-large-latest' }, { id: 'mistral-embed' }] });
    }
    const body = JSON.parse(String(options.body));
    calls.push({ url, auth, model: body.model });
    return Response.json({ model: body.model, choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 400 } });
  });
  return calls;
}

test('AI: oude koppeling wordt omgezet, meerdere aanbieders, wisselen zonder sleutel opnieuw in te voeren', async t => {
  const calls = fakeApi(t);
  const { app } = makeApp();
  app.secrets.set('ai', { provider: 'mistral', key: 'mistral-sleutel-1234', model: 'mistral-large-latest' });
  const assistant = new Assistant(app);
  assert.equal(app.secrets.get('ai'), undefined, 'oude vorm opgeruimd');
  assert.equal(assistant.status()?.model, 'mistral-large-latest');

  // DeepSeek erbij: wordt actief, Mistral blijft gekoppeld.
  await assistant.connect({ provider: 'deepseek', key: 'deepseek-sleutel-9876', remember: true });
  let status = assistant.status()!;
  assert.equal(status.provider, 'deepseek');
  assert.deepEqual(status.providers.map(p => [p.provider, p.keyHint, p.active]), [['mistral', '…1234', false], ['deepseek', '…9876', true]]);
  assert.ok(!JSON.stringify(status).includes('sleutel-9876'), 'de sleutel zelf gaat nooit naar de webapp');
  assert.equal(calls.at(-1)!.url, 'https://api.deepseek.com/chat/completions');

  // Model kiezen uit de lijst van de aanbieder, met de bewaarde sleutel.
  const { models } = await assistant.models('deepseek');
  assert.ok(models.includes('deepseek-pro'));
  assert.equal(calls.at(-1)!.auth, 'Bearer deepseek-sleutel-9876');
  await assistant.use({ provider: 'deepseek', model: 'deepseek-pro' });
  assert.equal(calls.at(-1)!.model, 'deepseek-pro', 'nieuw model kort getest');
  assert.equal(assistant.status()!.model, 'deepseek-pro');

  // Terug naar Mistral zonder sleutel; opnieuw opslaan zonder sleutel houdt de bewaarde.
  await assistant.use({ provider: 'mistral' });
  assert.equal(assistant.status()!.provider, 'mistral');
  await assistant.connect({ provider: 'mistral', key: '', model: '', remember: true });
  assert.equal(app.secrets.get('aiProviders')!.mistral.key, 'mistral-sleutel-1234');
  assert.equal(app.secrets.get('aiProviders')!.mistral.model, 'mistral-large-latest', 'leeg model houdt het gekozen model');

  // Na een herstart: alles nog gekoppeld, Mistral actief.
  const restarted = new Assistant(app);
  assert.equal(restarted.status()!.provider, 'mistral');
  assert.equal(restarted.status()!.providers.length, 2);

  // Eén aanbieder ontkoppelen; de andere wordt actief.
  restarted.disconnect('mistral');
  assert.equal(restarted.status()!.provider, 'deepseek');
  assert.equal(app.secrets.get('aiProviders')!.mistral, undefined);
  await assert.rejects(restarted.use({ provider: 'mistral' }), { status: 404 });
});

test('AI: verbruik per aanbieder en model, met geschatte kosten en eigen prijs', async t => {
  fakeApi(t);
  const { app, clock } = makeApp();
  const assistant = new Assistant(app);
  await assistant.connect({ provider: 'deepseek', key: 'deepseek-sleutel-9876', model: 'deepseek-flash', remember: true });
  await assistant.connect({ provider: 'mistral', key: 'mistral-sleutel-1234', model: 'mistral-large-latest', remember: true });
  let usage = assistant.usage();
  assert.equal(usage.months.length, 1);
  const deepseek = usage.months[0].rows.find(r => r.provider === 'deepseek')!;
  assert.deepEqual([deepseek.calls, deepseek.input, deepseek.output, deepseek.cached], [1, 1000, 200, 400]);
  // (600 × 0,28 + 400 × 0,028 + 200 × 0,42) / 1e6
  assert.ok(Math.abs(deepseek.cost! - (600 * 0.28 + 400 * 0.028 + 200 * 0.42) / 1e6) < 1e-12);

  usage = assistant.setPrice('mistral-large-latest', { in: 2, out: 6 });
  const mistral = usage.months[0].rows.find(r => r.provider === 'mistral')!;
  assert.equal(mistral.price!.own, true);
  assert.ok(Math.abs(mistral.cost! - (600 * 2 + 400 * 0.2 + 200 * 6) / 1e6) < 1e-12);
  assert.throws(() => assistant.setPrice('mistral-large-latest', { in: -1, out: 1 }), /tussen 0 en 1000/);

  // Een model zonder bekende prijs telt mee in tokens, zonder bedrag.
  await assistant.connect({ provider: 'local', key: '', model: 'llama3.1', baseUrl: 'http://192.168.1.20:11434/v1', remember: true });
  const local = assistant.usage().months[0].rows.find(r => r.provider === 'local')!;
  assert.equal(local.cost, null);
  assert.equal(assistant.usage().months[0].unpriced, true);

  // Een nieuwe maand krijgt een eigen regel.
  clock.now += 31 * 864e5;
  await assistant.use({ provider: 'deepseek', model: 'deepseek-pro' });
  assert.deepEqual(assistant.usage().months.map(m => m.month), ['2026-12', '2026-11']);
});

/** Nep-Mistral die net zo streng is als de echte: een lege beurt in het gesprek geeft fout 400. */
function strictMistral(t: { mock: { method: Function } }, answers: object[]) {
  const bodies: any[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit = {}) => {
    const body = JSON.parse(String(options.body));
    bodies.push(body);
    if (body.messages.some((m: any) => m.role === 'assistant' && !m.content && !m.tool_calls)) {
      return Response.json({ object: 'error', message: 'Assistant message must have either content or tool_calls, but not none.', type: 'invalid_request_assistant_message', code: '3240' }, { status: 400 });
    }
    return Response.json(answers.shift() ?? { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] });
  });
  return bodies;
}
const thinkingOnly = (finish: string) => ({ choices: [{ finish_reason: finish, message: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Even nadenken…' }] }] } }] });
const ask = (history: { role: 'user' | 'assistant'; content: string }[] = []) => ({
  system: 'Test', context: 'Vandaag', history, message: 'Wat eten we?', tools: [], run: async () => ({ content: '', isError: true }),
});

test('AI: een leeg antwoord in de geschiedenis blokkeert het gesprek niet meer', async t => {
  const { converse } = await import('../src/ai.ts');
  const bodies = strictMistral(t, []);
  const config = { provider: 'mistral' as const, key: 'mistral-sleutel-1234', model: 'mistral-large-latest' };
  const reply = await converse(config, ask([{ role: 'user', content: 'Zet melk erbij' }, { role: 'assistant', content: '' }]));
  assert.equal(reply, 'OK');
  assert.deepEqual(bodies[0].messages.map((m: any) => m.content).slice(1, 3), ['Zet melk erbij', '(geen antwoord)']);
});

test('AI: alleen denkstappen geeft nooit een leeg antwoord; bij te weinig ruimte nog eens met meer', async t => {
  const { converse } = await import('../src/ai.ts');
  t.mock.method(console, 'warn', () => {});
  const config = { provider: 'mistral' as const, key: 'mistral-sleutel-1234', model: 'mistral-large-latest' };

  let bodies = strictMistral(t, [thinkingOnly('length'), { choices: [{ finish_reason: 'stop', message: { content: [{ type: 'thinking', thinking: [] }, { type: 'text', text: 'Pasta pesto.' }] } }] }]);
  assert.equal(await converse(config, ask()), 'Pasta pesto.');
  assert.deepEqual(bodies.map(b => b.max_tokens), [1500, 6000]);

  t.mock.restoreAll();
  t.mock.method(console, 'warn', () => {});
  bodies = strictMistral(t, [thinkingOnly('stop')]);
  assert.equal(await converse(config, ask()), 'Ik ben er nog niet uit. Kun je het anders formuleren?');
  assert.equal(bodies.length, 1);
});

test('AI: een geweigerde aanvraag zegt niet meer ten onrechte dat het model-ID fout is', async t => {
  const { converse } = await import('../src/ai.ts');
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.join(' ')); });
  const config = { provider: 'mistral' as const, key: 'mistral-sleutel-1234', model: 'mistral-large-latest' };
  const reject = (message: string, type: string) => t.mock.method(globalThis, 'fetch', async () => Response.json({ object: 'error', message, type }, { status: 400 }));

  reject('Assistant message must have either content or tool_calls, but not none. key mistral-sleutel-1234', 'invalid_request_assistant_message');
  await assert.rejects(converse(config, ask()), (e: Error) => /weigert de aanvraag/.test(e.message) && !/model-ID/.test(e.message));
  assert.match(logged.at(-1)!, /Mistral HTTP 400: .*Assistant message must have/);
  assert.ok(!logged.join('\n').includes('mistral-sleutel-1234'), 'de sleutel komt nooit in het logboek');

  t.mock.restoreAll();
  t.mock.method(console, 'error', () => {});
  reject('Invalid model: mistral-groot', 'invalid_model');
  await assert.rejects(converse(config, ask()), /kent dit model niet\. Controleer het model-ID/);
});
