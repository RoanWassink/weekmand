import type { Weekmand } from './app.ts';
import { Problem } from './errors.ts';
import { runTool, tools } from './tools.ts';

/**
 * Model Context Protocol via "Streamable HTTP" (POST /mcp, JSON-antwoorden, zonder sessies).
 * Bewust zonder SDK: alleen initialize, tools/list, tools/call en ping zijn nodig, en zo blijft
 * het geheugengebruik op de router laag.
 */
export const version = '2.0.0';
const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const instructions = `Weekmand is de lokale boodschappenassistent van dit huishouden, gekoppeld aan Picnic.
- Begin bij een vraag over boodschappen met get_meal_plan of review_current_cart.
- Mandwijzigingen: eerst add_to_cart of remove_from_cart (berekent en toont), laat de wijzigingen zien, en roep confirm_cart_update pas aan na uitdrukkelijk akkoord.
- Weekmand bestelt en betaalt nooit; de gebruiker rondt af in de Picnic-app.
- Antwoord in het Nederlands.`;

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any };
type RpcResponse = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

export function mcpTools() {
  return tools.map(t => ({
    name: t.name, title: t.title, description: t.description, inputSchema: t.input,
    annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: false, idempotentHint: !!t.readOnly || t.name === 'confirm_cart_update', openWorldHint: !t.readOnly },
  }));
}

async function handle(app: Weekmand, message: Rpc): Promise<RpcResponse | null> {
  const id = message.id ?? null;
  const reply = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, text: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message: text } });
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return fail(-32600, 'Invalid Request');
  if (message.id === undefined) return null; // notificatie, bijv. notifications/initialized
  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      return reply({
        protocolVersion: supported.includes(requested) ? requested : supported[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'weekmand', title: 'Weekmand', version },
        instructions,
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: mcpTools() });
    case 'tools/call': {
      const name = message.params?.name;
      if (!tools.some(t => t.name === name)) return fail(-32602, 'Onbekende tool: ' + name);
      try {
        const result = await runTool(app, name, message.params?.arguments ?? {}, { channel: 'mcp' });
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: false });
      } catch (error) {
        const text = error instanceof Problem ? error.message : 'De bewerking is mislukt.';
        if (!(error instanceof Problem)) console.error('MCP-tool', name, error);
        return reply({ content: [{ type: 'text', text }], isError: true });
      }
    }
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    default: return fail(-32601, 'Method not found: ' + message.method);
  }
}

/** Verwerk één JSON-RPC-bericht of een batch. Geeft null als er niets terug hoeft (alleen notificaties). */
export async function handleMcp(app: Weekmand, body: unknown) {
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map(m => handle(app, m)))).filter(Boolean);
    return responses.length ? responses : null;
  }
  return handle(app, body as Rpc);
}

/** OpenAPI 3.1 voor een Custom GPT (Actions): één POST-route per tool. */
export function openApi(baseUrl: string) {
  return {
    openapi: '3.1.0',
    info: { title: 'Weekmand', version, description: instructions },
    servers: [{ url: baseUrl }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, schemas: {} },
    security: [{ bearer: [] }],
    paths: Object.fromEntries(tools.map(t => [`/api/tools/${t.name}`, {
      post: {
        operationId: t.name, summary: t.title, description: t.description,
        ...(t.needsHostApproval ? { 'x-openai-isConsequential': true } : { 'x-openai-isConsequential': false }),
        requestBody: { required: true, content: { 'application/json': { schema: t.input } } },
        responses: { 200: { description: 'Resultaat', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    }])),
  };
}
