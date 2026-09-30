// Teste rápido de um servidor bgmatch-mcp: lista as ferramentas e chama as de
// leitura. Uso: BGMATCH_MCP_URL=https://.../mcp BGMATCH_MCP_TOKEN=... node scripts/fumaca.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.BGMATCH_MCP_URL ?? 'http://localhost:8096/mcp';
const token = process.env.BGMATCH_MCP_TOKEN;
if (!token) {
  console.error('Defina BGMATCH_MCP_TOKEN.');
  process.exit(1);
}

const client = new Client({ name: 'fumaca', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
}));

const { tools } = await client.listTools();
console.log(`${tools.length} ferramentas: ${tools.map((t) => t.name).join(', ')}`);

let falhas = 0;
for (const [nome, args] of [
  ['listar_jogadores', {}],
  ['listar_jogos', { limite: 3 }],
  ['listar_partidas', { limite: 3 }],
  ['listar_locais', {}],
  ['ranking', {}],
]) {
  const r = await client.callTool({ name: nome, arguments: args });
  const texto = r.content?.[0]?.text ?? '';
  if (r.isError) falhas++;
  console.log(`${r.isError ? 'ERRO' : 'ok  '} ${nome}: ${texto.replace(/\s+/g, ' ').slice(0, 140)}`);
}
await client.close();
process.exit(falhas ? 1 : 0);
