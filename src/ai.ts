import { Problem } from './errors.ts';

/**
 * Taalmodel-aanbieders. Claude loopt via de officiële Anthropic SDK (pas geladen als Claude
 * gekozen is, zodat het geheugen op de router laag blijft); de andere aanbieders gebruiken de
 * OpenAI-compatibele chat-API, ook een lokaal model (bijv. Ollama).
 */
export const providers = {
  claude: { label: 'Claude', model: 'claude-opus-5-5', url: '' },
  openai: { label: 'OpenAI', model: 'gpt-4.1-mini', url: 'https://api.openai.com/v1/chat/completions' },
  mistral: { label: 'Mistral', model: 'mistral-small-latest', url: 'https://api.mistral.ai/v1/chat/completions' },
  deepseek: { label: 'DeepSeek', model: 'deepseek-flash', url: 'https://api.deepseek.com/chat/completions' },
  local: { label: 'Lokaal model', model: 'llama3.1', url: '' },
} as const;
export type Provider = keyof typeof providers;
export type AIConfig = { provider: Provider; key: string; model?: string; baseUrl?: string };

export type ToolSpec = { name: string; description: string; input: Record<string, unknown> };
export type ToolCall = { id: string; name: string; input: unknown };
export type Turn = { role: 'user' | 'assistant'; content: string };
export type Runner = (call: ToolCall) => Promise<{ content: string; isError: boolean }>;
/** Een foto bij het bericht (base64, zonder data:-voorvoegsel). */
export type ImageInput = { mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; data: string };
/**
 * maxTokens: ruimte voor het antwoord (lange lijsten in één toolaanroep hebben meer nodig);
 * images: foto's bij het bericht; model: ander model van dezelfde aanbieder (bijv. eentje dat foto's leest).
 */
type ConverseInput = { system: string; context: string; history: Turn[]; message: string; tools: ToolSpec[]; run: Runner; maxSteps?: number; maxTokens?: number; images?: ImageInput[]; model?: string };

export const modelOf = (c: AIConfig) => c.model?.trim() || providers[c.provider].model;

/** Tokens van één antwoord; `cached` is het deel van de invoer dat uit de cache van de aanbieder kwam. */
export type Usage = { provider: Provider; model: string; input: number; output: number; cached: number };
let usageSink: ((usage: Usage) => void) | null = null;
/** Elk antwoord met tokens meldt zich hier (voor het kostenoverzicht). */
export function onUsage(fn: ((usage: Usage) => void) | null) { usageSink = fn; }
const count = (n: unknown) => Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n)) : 0;
function report(provider: Provider, model: string, input: number, output: number, cached: number) {
  if (!input && !output) return;
  try { usageSink?.({ provider, model, input, output, cached: Math.min(cached, input) }); } catch { /* meten mag het antwoord nooit breken */ }
}
export const labelOf = (c: AIConfig) => providers[c.provider].label;

function apiProblem(status: number | undefined, label: string): Problem {
  if (status === 401 || status === 403) return new Problem(422, `${label} weigert toegang. Controleer de API-sleutel.`);
  if (status === 402 || status === 429) return new Problem(422, `${label} accepteert nu geen aanvragen. Controleer tegoed en limieten.`);
  if (status === 400 || status === 404) return new Problem(422, `${label} weigert de aanvraag. Controleer het model-ID.`);
  return new Problem(502, `${label} gaf geen bruikbaar antwoord. Probeer het opnieuw.`);
}

/**
 * Voer een gesprek met tools uit tot het model klaar is. `history` bevat eerdere beurten als
 * tekst; `context` is wisselende informatie (datum, huishouden) die bij het nieuwe bericht hoort,
 * zodat systeemprompt en tools gelijk blijven en gecachet kunnen worden.
 */
export async function converse(config: AIConfig, input: ConverseInput): Promise<string> {
  return config.provider === 'claude' ? claude(config, input) : openaiCompatible(config, input);
}

/** Aanbieders die foto's kunnen lezen, met een model dat dat zeker kan (als het gekozen model het niet kan). */
export const visionModels: Partial<Record<Provider, string>> = { claude: '', openai: 'gpt-4.1-mini', mistral: 'mistral-medium-latest', local: '' };

// ───────────── Claude (Anthropic SDK) ─────────────

let sdk: Promise<typeof import('@anthropic-ai/sdk')> | null = null;

async function claude(config: AIConfig, input: ConverseInput): Promise<string> {
  sdk ??= import('@anthropic-ai/sdk');
  const { default: Anthropic } = await sdk;
  const client = new Anthropic({ apiKey: config.key, maxRetries: 1, timeout: 90_000 });
  const model = input.model || modelOf(config);
  const current = /^claude-(opus|sonnet|fable|haiku)-5/.test(model);
  // Server-side fallback bij een weigering, voor de modellen die dat ondersteunen.
  const fallback = /^claude-(opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/.test(model);
  const messages: any[] = [
    ...input.history.map(t => ({ role: t.role, content: t.content })),
    { role: 'user', content: [
      { type: 'text', text: input.context },
      ...(input.images ?? []).map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
      { type: 'text', text: input.message },
    ] },
  ];
  const tools = input.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input }));
  let text = '';
  for (let step = 0; step < (input.maxSteps ?? 8); step++) {
    let response: any;
    try {
      response = await client.beta.messages.create({
        model, max_tokens: 16000, system: input.system, messages, ...(tools.length ? { tools } : {}),
        cache_control: { type: 'ephemeral' },
        ...(current ? { output_config: { effort: 'medium' } } : {}),
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      } as any);
    } catch (error) {
      if (error instanceof Anthropic.APIError) throw apiProblem(error.status, 'Claude');
      throw new Problem(502, 'Claude is niet bereikbaar.');
    }
    const u = response.usage ?? {};
    const cachedIn = count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens);
    report('claude', String(response.model || model), count(u.input_tokens) + cachedIn, count(u.output_tokens), count(u.cache_read_input_tokens));
    if (response.stop_reason === 'refusal') return 'Daar kan ik je niet mee helpen.';
    text = response.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim() || text;
    // Volledige inhoud terugsturen (ook denkblokken), anders klopt de gespreksgeschiedenis niet.
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'pause_turn') continue;
    const calls = response.content.filter((b: any) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !calls.length) return text;
    const results = [];
    for (const call of calls) {
      const result = await input.run({ id: call.id, name: call.name, input: call.input });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: result.content, ...(result.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  return text || 'Ik ben er nog niet uit. Kun je het anders formuleren?';
}

// ───────────── OpenAI-compatibele aanbieders ─────────────

async function openaiCompatible(config: AIConfig, input: ConverseInput): Promise<string> {
  const label = labelOf(config);
  const url = config.provider === 'local'
    ? (config.baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/$/, '') + '/chat/completions'
    : providers[config.provider].url;
  const messages: any[] = [
    { role: 'system', content: input.system + '\n\n' + input.context },
    ...input.history.map(t => ({ role: t.role, content: t.content })),
    { role: 'user', content: input.images?.length ? [
      { type: 'text', text: input.message },
      // Mistral wil de afbeelding als tekenreeks, OpenAI als object.
      ...input.images.map(i => ({ type: 'image_url', image_url: config.provider === 'mistral' ? `data:${i.mediaType};base64,${i.data}` : { url: `data:${i.mediaType};base64,${i.data}` } })),
    ] : input.message },
  ];
  const tools = input.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input } }));
  let text = '';
  for (let step = 0; step < (input.maxSteps ?? 8); step++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.provider === 'local' ? 180_000 : input.images?.length ? 120_000 : 60_000),
        headers: { 'Content-Type': 'application/json', ...(config.key ? { Authorization: 'Bearer ' + config.key } : {}) },
        body: JSON.stringify({
          model: input.model || modelOf(config), messages, max_tokens: input.maxTokens ?? 1500, ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
          ...(config.provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
        }),
      });
    } catch (error) {
      throw new Problem(502, (error as Error)?.name === 'TimeoutError' ? `${label} reageerde te laat.` : `${label} is niet bereikbaar.`);
    }
    if (!response.ok) throw apiProblem(response.status, label);
    const data = await response.json().catch(() => null);
    const u = data?.usage ?? {};
    report(config.provider, String(data?.model || input.model || modelOf(config)), count(u.prompt_tokens), count(u.completion_tokens),
      count(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens));
    const message = data?.choices?.[0]?.message;
    if (!message) throw new Problem(502, `${label} gaf een leeg antwoord.`);
    text = (typeof message.content === 'string' ? message.content : '').trim() || text;
    const calls: any[] = message.tool_calls ?? [];
    messages.push({ role: 'assistant', content: message.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) return text;
    for (const call of calls) {
      let args: unknown = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* lege invoer */ }
      const result = await input.run({ id: call.id, name: call.function?.name, input: args });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
    }
  }
  return text || 'Ik ben er nog niet uit. Kun je het anders formuleren?';
}

/** Korte test van een koppeling, zonder tools. */
export async function testConnection(config: AIConfig) {
  const reply = await converse(config, {
    system: 'Antwoord met precies het woord OK.', context: 'Test van de koppeling.', history: [], message: 'Werkt de verbinding?', tools: [], run: async () => ({ content: '', isError: true }), maxSteps: 1,
  });
  if (!reply) throw new Problem(502, `${labelOf(config)} gaf geen antwoord.`);
}

/** Basisadres van de OpenAI-compatibele API van een aanbieder (zonder /chat/completions). */
function apiBase(config: AIConfig) {
  if (config.provider === 'local') return (config.baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  return providers[config.provider].url.replace(/\/chat\/completions$/, '');
}

/** De modellen die deze sleutel mag gebruiken, volgens de aanbieder zelf (gesorteerd, hooguit 80). */
export async function listModels(config: AIConfig): Promise<string[]> {
  const label = labelOf(config);
  let ids: string[] = [];
  if (config.provider === 'claude') {
    sdk ??= import('@anthropic-ai/sdk');
    const { default: Anthropic } = await sdk;
    try {
      const page = await new Anthropic({ apiKey: config.key, maxRetries: 1, timeout: 20_000 }).models.list({ limit: 100 });
      ids = page.data.map((m: { id: string }) => m.id);
    } catch (error) {
      if (error instanceof Anthropic.APIError) throw apiProblem(error.status, label);
      throw new Problem(502, `${label} is niet bereikbaar.`);
    }
  } else {
    let response: Response;
    try {
      response = await fetch(apiBase(config) + '/models', {
        redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: config.key ? { Authorization: 'Bearer ' + config.key } : {},
      });
    } catch {
      throw new Problem(502, `${label} is niet bereikbaar.`);
    }
    if (!response.ok) throw apiProblem(response.status, label);
    const data = await response.json().catch(() => null);
    ids = (Array.isArray(data?.data) ? data.data : []).map((m: any) => m?.id).filter((id: unknown) => typeof id === 'string');
    // OpenAI geeft ook beeld-, spraak- en embeddingmodellen: alleen chatmodellen tonen.
    if (config.provider === 'openai') ids = ids.filter(id => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id));
    if (config.provider === 'mistral') ids = ids.filter(id => !/(embed|moderation|ocr)/.test(id));
  }
  return [...new Set(ids.filter(id => /^[a-z0-9._:/-]{1,128}$/i.test(id)))].sort().slice(0, 80);
}

/**
 * Prijzen in dollar per miljoen tokens (invoer, uitvoer), als schatting voor het kostenoverzicht.
 * Aanbieders melden geen bedragen, alleen tokens; je kunt elke prijs zelf aanpassen. Cache-invoer
 * rekenen we tegen een tiende van de invoerprijs.
 */
export const defaultPrices: { match: RegExp; in: number; out: number }[] = [
  { match: /^claude-opus/, in: 5, out: 25 },
  { match: /^claude-(sonnet|fable)/, in: 3, out: 15 },
  { match: /^claude-haiku/, in: 1, out: 5 },
  { match: /^gpt-4\.1-nano/, in: 0.1, out: 0.4 },
  { match: /^gpt-4\.1-mini/, in: 0.4, out: 1.6 },
  { match: /^gpt-4\.1/, in: 2, out: 8 },
  { match: /^mistral-large/, in: 0.5, out: 1.5 },
  { match: /^mistral-medium/, in: 0.4, out: 2 },
  { match: /^mistral-small/, in: 0.1, out: 0.3 },
  { match: /^deepseek/, in: 0.28, out: 0.42 },
];
