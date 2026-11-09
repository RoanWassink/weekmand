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
