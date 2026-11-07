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

export const modelOf = (c: AIConfig) => c.model?.trim() || providers[c.provider].model;
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
export async function converse(config: AIConfig, input: { system: string; context: string; history: Turn[]; message: string; tools: ToolSpec[]; run: Runner; maxSteps?: number }): Promise<string> {
  return config.provider === 'claude' ? claude(config, input) : openaiCompatible(config, input);
}

// ───────────── Claude (Anthropic SDK) ─────────────

let sdk: Promise<typeof import('@anthropic-ai/sdk')> | null = null;

async function claude(config: AIConfig, input: Parameters<typeof converse>[1]): Promise<string> {
  sdk ??= import('@anthropic-ai/sdk');
  const { default: Anthropic } = await sdk;
  const client = new Anthropic({ apiKey: config.key, maxRetries: 1, timeout: 90_000 });
  const model = modelOf(config);
  const current = /^claude-(opus|sonnet|fable|haiku)-5/.test(model);
  // Server-side fallback bij een weigering, voor de modellen die dat ondersteunen.
  const fallback = /^claude-(opus-5-5|opus-5|fable-5-1|sonnet-5-5)$/.test(model);
  const messages: any[] = [
    ...input.history.map(t => ({ role: t.role, content: t.content })),
    { role: 'user', content: [{ type: 'text', text: input.context }, { type: 'text', text: input.message }] },
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

async function openaiCompatible(config: AIConfig, input: Parameters<typeof converse>[1]): Promise<string> {
  const label = labelOf(config);
  const url = config.provider === 'local'
    ? (config.baseUrl || 'http://127.0.0.1:11434/v1').replace(/\/$/, '') + '/chat/completions'
    : providers[config.provider].url;
  const messages: any[] = [
    { role: 'system', content: input.system + '\n\n' + input.context },
    ...input.history.map(t => ({ role: t.role, content: t.content })),
    { role: 'user', content: input.message },
  ];
  const tools = input.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input } }));
  let text = '';
  for (let step = 0; step < (input.maxSteps ?? 8); step++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.provider === 'local' ? 180_000 : 60_000),
        headers: { 'Content-Type': 'application/json', ...(config.key ? { Authorization: 'Bearer ' + config.key } : {}) },
        body: JSON.stringify({
          model: modelOf(config), messages, max_tokens: 1500, ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
          ...(config.provider === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
        }),
      });
    } catch (error) {
      throw new Problem(502, (error as Error)?.name === 'TimeoutError' ? `${label} reageerde te laat.` : `${label} is niet bereikbaar.`);
    }
    if (!response.ok) throw apiProblem(response.status, label);
    const data = await response.json().catch(() => null);
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
