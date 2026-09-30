export interface Config {
  /** URL base da API do BGMatch, terminando em /api. */
  apiUrl: string;
  /** Conta de serviço usada pelo MCP para falar com a API. */
  usuario: string;
  senha: string;
  /** Token de acesso de cada pessoa: token => nome. */
  tokens: Map<string, string>;
  /** Token da XML API do BGG; sem ele, as ferramentas do BGG respondem com erro. */
  bggToken?: string;
  porta: number;
  /** Hosts aceitos no cabeçalho Host (proteção contra DNS rebinding). */
  hostsPermitidos: string[];
}

/**
 * Lê "ana:tokenA,bruno:tokenB" e devolve token => nome.
 */
export function leTokens(valor: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const item of valor.split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = item.indexOf(':');
    if (i < 1 || i === item.length - 1) {
      throw new Error(`Entrada inválida em BGMATCH_MCP_TOKENS: "${item.slice(0, 20)}..." (formato: nome:token)`);
    }
    const nome = item.slice(0, i).trim();
    const token = item.slice(i + 1).trim();
    if (token.length < 24) {
      throw new Error(`O token de "${nome}" é curto demais; gere um com "npm run token -- ${nome}".`);
    }
    if (tokens.has(token)) {
      throw new Error(`Token repetido em BGMATCH_MCP_TOKENS (${nome}).`);
    }
    tokens.set(token, nome);
  }
  return tokens;
}

export function carregaConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const obrigatoria = (nome: string): string => {
    const valor = env[nome];
    if (!valor) {
      throw new Error(`Variável de ambiente ${nome} não definida.`);
    }
    return valor;
  };

  const tokens = leTokens(obrigatoria('BGMATCH_MCP_TOKENS'));
  if (tokens.size === 0) {
    throw new Error('BGMATCH_MCP_TOKENS não tem nenhum token.');
  }

  return {
    apiUrl: obrigatoria('BGMATCH_API_URL').replace(/\/+$/, ''),
    usuario: obrigatoria('BGMATCH_USUARIO'),
    senha: obrigatoria('BGMATCH_SENHA'),
    tokens,
    bggToken: env.BGG_TOKEN || undefined,
    porta: Number(env.PORT ?? 8096),
    hostsPermitidos: (env.BGMATCH_MCP_HOSTS ?? 'localhost,127.0.0.1')
      .split(',').map((h) => h.trim()).filter(Boolean),
  };
}
