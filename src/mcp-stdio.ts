#!/usr/bin/env node
// Brug voor MCP-programma's die alleen stdio kennen (zoals Claude Desktop): leest JSON-RPC
// van stdin en stuurt het door naar de Weekmand-server (bijv. op de router).
//
// Claude Desktop, claude_desktop_config.json:
//   "weekmand": { "command": "node", "args": ["C:/pad/naar/weekmand/src/mcp-stdio.ts"],
//                 "env": { "WEEKMAND_URL": "http://192.168.1.1:8080", "WEEKMAND_TOKEN": "<API-token uit Instellingen>" } }
import { createInterface } from 'node:readline';

const base = (process.env.WEEKMAND_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const token = process.env.WEEKMAND_TOKEN || '';

async function forward(line: string) {
  let message: { id?: unknown };
  try { message = JSON.parse(line); } catch { return; }
  try {
    const response = await fetch(base + '/mcp', {
      method: 'POST', signal: AbortSignal.timeout(120_000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: line,
    });
    if (response.status === 202 || response.status === 204) return;
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    process.stdout.write(text.trim() + '\n');
  } catch (error) {
    if (message.id === undefined) return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Weekmand niet bereikbaar op ' + base + ': ' + (error as Error).message } }) + '\n');
  }
}

const rl = createInterface({ input: process.stdin });
const pending = new Set<Promise<void>>();
rl.on('line', line => {
  if (!line.trim()) return;
  const p = forward(line).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on('close', async () => { await Promise.all(pending); });
