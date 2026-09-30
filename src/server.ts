import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { BGMatchApi } from './api.js';
import { identifica, LimiteDeFalhas } from './auth.js';
import { carregaConfig, Config } from './config.js';
import { registraFerramentas } from './ferramentas.js';

const VERSAO = '0.1.0';

const INSTRUCOES = 'Servidor do BGMatch, o registro de partidas de boardgame do grupo e do ranking anual. '
  + 'Jogos e jogadores podem ser informados pelo nome; se o nome for ambíguo, a ferramenta devolve as opções. '
  + 'Antes de excluir ou editar uma partida, confirme com a pessoa.';

export function criaApp(config: Config, api: BGMatchApi) {
  const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: config.hostsPermitidos });
  // Atrás do Caddy: o IP do cliente vem no X-Forwarded-For posto por ele.
  app.set('trust proxy', 1);

  const limite = new LimiteDeFalhas();

  app.get('/saude', (_req, res) => {
    res.json({ ok: true, versao: VERSAO });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const ip = req.ip ?? 'desconhecido';
    if (limite.bloqueado(ip)) {
      res.status(429).json({ erro: 'Muitas tentativas com token inválido. Tente de novo mais tarde.' });
      return;
    }
    const pessoa = identifica(req.headers.authorization, config.tokens);
    if (!pessoa) {
      limite.registra(ip);
      res.status(401).set('WWW-Authenticate', 'Bearer realm="bgmatch-mcp"').json({ erro: 'Token ausente ou inválido.' });
      return;
    }

    // Modo sem sessão: um servidor e um transporte por requisição.
    const server = new McpServer({ name: 'bgmatch', version: VERSAO }, { instructions: INSTRUCOES });
    registraFerramentas(server, api, pessoa);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('Erro ao tratar requisição MCP:', e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Erro interno' }, id: null });
      }
    }
  });

  const naoPermitido = (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Método não permitido.' }, id: null });
  };
  app.get('/mcp', naoPermitido);
  app.delete('/mcp', naoPermitido);

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = carregaConfig();
  const api = new BGMatchApi(config.apiUrl, config.usuario, config.senha);
  const pessoas = [...new Set(config.tokens.values())].join(', ');
  criaApp(config, api).listen(config.porta, () => {
    console.log(`bgmatch-mcp ${VERSAO} ouvindo na porta ${config.porta}; API ${config.apiUrl}; tokens de: ${pessoas}`);
  });
}
