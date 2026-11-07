import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutoffNotice, handleAction, openQuestion } from '../src/actions.ts';
import { Assistant } from '../src/assistant.ts';
import { handleMcp } from '../src/mcp.ts';
import { tools, validateArgs } from '../src/tools.ts';
import { makeApp } from './helpers.ts';

test('zonder AI: vaste commando\'s, ook samengesteld', async () => {
  const { app } = makeApp();
  const assistant = new Assistant(app);
  await app.proposeMenu();
  const r = await assistant.chat('t', 'Voeg een krat pils toe en haal de kipfilet eruit');
  assert.match(r.reply, /Krat pils/);
  assert.match(r.reply, /Kipfilet wordt deze bestelling overgeslagen/);
  assert.ok(r.reviewId);
  assert.match((await assistant.chat('t', 'melk is op')).reply, /melk is op/i);
  assert.match((await assistant.chat('t', 'stel een menu voor, graag snel')).reply, /^Menu:/);
  assert.match((await assistant.chat('t', 'wat is de zin van het leven')).reply, /begrijp ik niet/);
  assert.equal(app.store.chat('t').length, 8);
});

test('Claude: toolgebruik via de Anthropic SDK met mandknop', async t => {
  const { app } = makeApp();
  process.env.AI_PROVIDER = 'claude';
  process.env.AI_API_KEY = 'sk-test';
  t.after(() => { delete process.env.AI_PROVIDER; delete process.env.AI_API_KEY; });
  const requests: any[] = [];
  const replies = [
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name: 'find_recipes', input: { tag: 'mexicaans' } }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu2', name: 'set_meal', input: { day: 'vrijdag', recipe_id: 'chili-con-carne', servings: 6 } }, { type: 'tool_use', id: 'tu3', name: 'add_to_cart', input: {} }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Vrijdag chili con carne voor 6. Druk op Mandje bijwerken.' }] },
  ];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url instanceof Request ? url.url : url);
    assert.match(href, /api\.anthropic\.com\/v1\/messages/);
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const reply = replies[requests.length - 1];
    return Response.json({ id: 'msg' + requests.length, type: 'message', role: 'assistant', model: body.model, usage: { input_tokens: 1, output_tokens: 1 }, ...reply });
  });
  const result = await new Assistant(app).chat('w', 'We eten vrijdag met 6 man Mexicaans, pas de boodschappen aan.');
  assert.equal(result.reply, 'Vrijdag chili con carne voor 6. Druk op Mandje bijwerken.');
  assert.ok(result.reviewId, 'add_to_cart geeft een review voor de knop');
  assert.equal(app.store.meal('2026-11-13')?.servings, 6);
  assert.equal(requests[0].model, 'claude-opus-5-5');
  assert.equal(requests[0].fallbacks, 'default');
  assert.ok(!requests[0].tools.some((x: any) => x.name === 'confirm_cart_update'), 'chat mag de mand niet zelf toepassen');
  // Toolresultaten gaan in één user-bericht terug, na de volledige assistant-inhoud.
  const last = requests[2].messages;
  assert.equal(last.at(-1).role, 'user');
  assert.deepEqual(last.at(-1).content.map((b: any) => b.tool_use_id), ['tu2', 'tu3']);
  assert.equal(last.at(-2).role, 'assistant');
});

test('OpenAI-compatibel (Mistral): tool_calls worden uitgevoerd', async t => {
  const { app } = makeApp();
  process.env.AI_PROVIDER = 'mistral';
  process.env.AI_API_KEY = 'test-key-123';
  t.after(() => { delete process.env.AI_PROVIDER; delete process.env.AI_API_KEY; });
  let call = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    call++;
    if (call === 1) return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'update_pantry', arguments: '{"items":[{"name":"eieren","status":"op"}]}' } }] } }] });
    assert.equal(body.messages.at(-1).role, 'tool');
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Genoteerd, de eieren zijn op.' } }] });
  });
  const result = await new Assistant(app).chat('w', 'de eieren zijn op');
  assert.equal(result.reply, 'Genoteerd, de eieren zijn op.');
  assert.equal(app.store.pantryItem('ei')?.amount, 0);
});

test('deadlinemelding: menu klaarzetten, voorraad navragen, dan mand goedkeuren', async () => {
  const { app, clock } = makeApp();
  clock.now = Date.parse('2026-11-10T17:30:00Z'); // 18:30, deadline 22:00
  app.updatePantry([{ name: 'eieren', amount: 6 }]);
  app.store.savePantry({ ...app.store.pantryItem('ei')!, checkedAt: '2026-11-01T10:00:00Z' });
  await app.setMeal({ date: '2026-11-11', recipeId: 'shakshuka', servings: 2 });
  const notice = await cutoffNotice(app);
  assert.ok(notice);
  assert.match(notice.text, /wordt vanavond om 22:00 definitief/);
  assert.match(notice.text, /Heb je nog 6 stuks eieren\?/);
  assert.equal(openQuestion(app), 'ei');
  assert.deepEqual(notice.buttons!.map(b => b.data), ['q:ei:yes', 'q:ei:no']);
  const next = await handleAction(app, 'q:ei:yes');
  assert.match(next.text, /hoef ik niet te kopen/);
  const apply = next.buttons!.find(b => b.data.startsWith('apply:'))!;
  const done = await handleAction(app, apply.data);
  assert.match(done.text, /Mand bijgewerkt/);
  assert.match((await handleAction(app, apply.data)).text, /al bijgewerkt/);
});

test('MCP: initialize, tools/list, tools/call en fouten', async () => {
  const { app } = makeApp();
  const init = await handleMcp(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) as any;
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(await handleMcp(app, { jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await handleMcp(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' }) as any;
  assert.deepEqual(list.result.tools.map((x: any) => x.name).slice(0, 4), ['get_pantry_status', 'update_pantry', 'get_meal_plan', 'propose_meal_plan']);
  for (const name of ['get_pantry_status', 'propose_meal_plan', 'add_to_cart', 'review_current_cart']) assert.ok(list.result.tools.some((x: any) => x.name === name));
  const call = await handleMcp(app, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'add_to_cart', arguments: { items: [{ name: 'krat pils' }] } } }) as any;
  const body = JSON.parse(call.result.content[0].text);
  assert.ok(body.review_id && body.changes.some((c: any) => c.product.startsWith('Krat pils')));
  const confirm = await handleMcp(app, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'confirm_cart_update', arguments: { review_id: body.review_id } } }) as any;
  assert.equal(confirm.result.isError, false);
  const bad = await handleMcp(app, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'update_pantry', arguments: { items: 'melk' } } }) as any;
  assert.equal(bad.result.isError, true);
  const unknown = await handleMcp(app, { jsonrpc: '2.0', id: 6, method: 'nope' }) as any;
  assert.equal(unknown.error.code, -32601);
});

test('alle toolschema\'s zijn geldige objectschema\'s', () => {
  for (const tool of tools) {
    assert.equal(tool.input.type, 'object', tool.name);
    assert.ok(tool.description.length > 20, tool.name);
  }
  assert.equal(validateArgs(tools.find(x => x.name === 'set_meal')!.input, {}), 'invoer.day ontbreekt.');
});

test('beoordelen via knoppen: vraag na het eten, duimpje omlaag met reden', async () => {
  const { app, clock } = makeApp();
  const { ratingNotice } = await import('../src/actions.ts');
  await app.setMeal({ date: '2026-11-11', recipeId: 'shakshuka', servings: 2 });
  assert.equal(ratingNotice(app, '2026-11-11'), null, 'nog niet besteld');
  await app.applyPlan((await app.plan()).id);
  clock.now = Date.parse('2026-11-12T09:30:00Z');
  const notice = ratingNotice(app, '2026-11-11')!;
  assert.match(notice.text, /Hoe was de shakshuka met pita van woensdag/);
  const down = await handleAction(app, notice.buttons![1].data);
  assert.match(down.text, /Wat was er mis/);
  const why = down.buttons!.find(b => b.label === 'Kinderen lustten het niet')!;
  assert.match((await handleAction(app, why.data)).text, /Kinderen lustten het niet/);
  assert.equal(ratingNotice(app, '2026-11-11'), null, 'al beoordeeld');
  const mcp = await handleMcp(app, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rate_meal', arguments: { day: 'woensdag', rating: 'up' } } }) as any;
  assert.match(JSON.parse(mcp.result.content[0].text).message, /favorieten/);
});
