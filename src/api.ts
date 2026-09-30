/**
 * Cliente da API REST do BGMatch.
 *
 * Entra com a conta de serviço, guarda o JWT e renova quando está para vencer
 * ou quando a API responde 401.
 */

export interface Jogador {
  id: number;
  nome: string;
  cor: string;
}

export interface Jogo {
  id: number;
  nome: string;
  categoria: string;
  min: number | null;
  max: number | null;
  slug: string;
  id_base: number | null;
  coop: boolean;
  excluido: boolean;
  bgg_id: number | null;
  bgg_weight: string | number | null;
  num_partidas: number;
  ultima_partida: string | null;
}

export interface JogadorPartida {
  id: number;
  nome: string;
  posicao: number | null;
  pontuacao: number | null;
}

export interface Partida {
  id: number;
  data: string;
  local: string;
  ranking: boolean;
  jogo: { id: number; nome: string; peso: string | number | null; categoria: string };
  expansao: { id: number; nome: string; peso: string | number | null } | null;
  jogadores: JogadorPartida[];
}

/** Corpo aceito por /partidas/new e /partidas/{id}/update. */
export interface DadosPartida {
  id_jogo: number;
  id_expansao: number | null;
  data: string;
  local: string;
  ranking: boolean;
  jogadores: { id: number; posicao: number; pontuacao: number }[];
}

export class ErroApi extends Error {
  constructor(public status: number, mensagem: string) {
    super(mensagem);
  }
}

type Fetch = typeof fetch;

export class BGMatchApi {
  private token: string | null = null;
  private expiraEm = 0;

  constructor(
    private apiUrl: string,
    private usuario: string,
    private senha: string,
    private fetchImpl: Fetch = fetch,
  ) {}

  private async login(): Promise<void> {
    const resposta = await this.fetchImpl(`${this.apiUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: this.usuario, senha: this.senha }),
    });
    const corpo = (await resposta.json().catch(() => ({}))) as { token?: string };
    if (!resposta.ok || !corpo.token) {
      throw new ErroApi(resposta.status, 'O MCP não conseguiu entrar na API do BGMatch (conta de serviço recusada).');
    }
    this.token = corpo.token;
    this.expiraEm = expiracaoJwt(corpo.token);
  }

  private async garanteToken(): Promise<string> {
    // Renova com um minuto de folga.
    if (!this.token || Date.now() > this.expiraEm - 60_000) {
      await this.login();
    }
    return this.token!;
  }

  async request<T>(metodo: 'GET' | 'POST', caminho: string, corpo?: unknown): Promise<T> {
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      const token = await this.garanteToken();
      const resposta = await this.fetchImpl(`${this.apiUrl}${caminho}`, {
        method: metodo,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      });
      if (resposta.status === 401 && tentativa === 0) {
        this.token = null;
        continue;
      }
      if (!resposta.ok) {
        throw new ErroApi(resposta.status, mensagemDeErro(resposta.status, caminho));
      }
      return (await resposta.json()) as T;
    }
    throw new ErroApi(401, 'A API do BGMatch recusou a autenticação.');
  }

  jogadores() {
    return this.request<Jogador[]>('GET', '/jogadores');
  }

  dadosJogadores() {
    return this.request<Array<Jogador & {
      num_partidas: number;
      num_vitorias: number;
      vitorias: { qtd: number; nome_jogo: string }[];
      resultados: { posicao: number | null; quantidade: number }[];
    }>>('GET', '/jogadores/dados');
  }

  jogos() {
    return this.request<Jogo[]>('GET', '/jogos');
  }

  /** Período: "AAAA", "AAAA-MM", "AAAA-MM-DD" ou "inicio:fim" com esses formatos. */
  partidas(periodo: string, opcoes: { apenasRanking?: boolean; ordem?: 'asc' | 'desc' } = {}) {
    const params = new URLSearchParams({ sort: opcoes.ordem ?? 'desc' });
    if (opcoes.apenasRanking) {
      params.set('ranking', '1');
    }
    // O ":" separa início e fim e precisa chegar literal: a API não decodifica %3A.
    const caminho = periodo.split(':').map(encodeURIComponent).join(':');
    return this.request<Partida[]>('GET', `/partidas/lista/${caminho}?${params}`);
  }

  async partida(id: number): Promise<Partida> {
    const lista = await this.request<Partida[]>('GET', `/partidas/${id}`);
    if (!lista.length) {
      throw new ErroApi(404, `Partida ${id} não encontrada.`);
    }
    return lista[0];
  }

  locais() {
    return this.request<string[]>('GET', '/partidas/locais');
  }

  ranking(ano: number) {
    return this.request<Record<string, unknown>>('GET', `/ranking/${ano}`);
  }

  criaPartida(dados: DadosPartida) {
    return this.request<{ ok: boolean }>('POST', '/partidas/new', dados);
  }

  atualizaPartida(id: number, dados: DadosPartida) {
    return this.request<{ ok: boolean }>('POST', `/partidas/${id}/update`, dados);
  }

  excluiPartida(id: number) {
    return this.request<boolean>('POST', `/partidas/${id}/delete`);
  }

  pesquisaLudopedia(termo: string) {
    return this.request<Array<{ id: string | null; slug: string; title: string; link: string; cadastrado: boolean }>>(
      'GET', `/jogos/pesquisa/${encodeURIComponent(termo)}`);
  }

  importaJogo(slug: string) {
    return this.request<{ sucesso: boolean; jogo: Record<string, unknown> }>(
      'POST', `/jogos/importa/${encodeURIComponent(slug)}`);
  }

  atualizaJogo(id: number, campos: Record<string, unknown>) {
    return this.request<{ updated: number }>('POST', `/jogos/${id}/update`, campos);
  }

  dadosBgg(id: number) {
    return this.request<{ bgg_id: number | null; bgg_weight: number | null }>('GET', `/jogos/${id}/bgg`);
  }
}

/** Lê o campo exp (em segundos) do JWT e devolve em milissegundos. */
export function expiracaoJwt(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function mensagemDeErro(status: number, caminho: string): string {
  if (status === 404) {
    return `Não encontrado na API do BGMatch (${caminho.split('?')[0]}).`;
  }
  if (status >= 500) {
    return `A API do BGMatch falhou ao processar ${caminho.split('?')[0]} (HTTP ${status}).`;
  }
  return `A API do BGMatch respondeu HTTP ${status} para ${caminho.split('?')[0]}.`;
}
