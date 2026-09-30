/**
 * Cliente da XML API2 do BoardGameGeek. Desde 2025 a API exige token de
 * aplicação (Authorization: Bearer); sem ele responde 401.
 */
import { XMLParser } from 'fast-xml-parser';
import { normaliza } from './nomes.js';

const API = 'https://boardgamegeek.com/xmlapi2';

export interface ResultadoBusca {
  bgg_id: number;
  nome: string;
  ano: number | null;
  tipo: string;
}

export interface JogoBgg {
  bgg_id: number;
  /** "boardgame" ou "boardgameexpansion". */
  tipo: string;
  nome: string;
  outros_nomes: string[];
  ano: number | null;
  min: number | null;
  max: number | null;
  peso: number | null;
  imagem: string | null;
  cooperativo: boolean;
  party_ou_infantil: boolean;
  /** Para expansões: ids no BGG dos jogos base. */
  bases: number[];
}

export class ErroBgg extends Error {}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (nome) => ['item', 'name', 'link'].includes(nome),
});

const valor = (no: any): string | undefined => (no && typeof no === 'object' ? no.value : undefined);
const inteiro = (no: any): number | null => {
  const n = Number.parseInt(valor(no) ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export class BggApi {
  constructor(private token: string | undefined, private fetchImpl: typeof fetch = fetch) {}

  private async get(caminho: string): Promise<any> {
    if (!this.token) {
      throw new ErroBgg('O MCP está sem token do BGG (variável BGG_TOKEN).');
    }
    for (let tentativa = 0; tentativa < 3; tentativa++) {
      const resposta = await this.fetchImpl(`${API}${caminho}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/xml', 'User-Agent': 'bgmatch-mcp' },
      });
      // 202 = pedido na fila do BGG; 429 = limite de requisições.
      if (resposta.status === 202 || resposta.status === 429) {
        await new Promise((r) => setTimeout(r, 2000 * (tentativa + 1)));
        continue;
      }
      if (resposta.status === 401) {
        throw new ErroBgg('O BGG recusou o token (HTTP 401).');
      }
      if (!resposta.ok) {
        throw new ErroBgg(`O BGG respondeu HTTP ${resposta.status}.`);
      }
      return parser.parse(await resposta.text());
    }
    throw new ErroBgg('O BGG não respondeu a tempo; tente de novo em alguns segundos.');
  }

  /** Procura por nome; nomes iguais ao termo vêm primeiro. */
  async busca(termo: string): Promise<ResultadoBusca[]> {
    const xml = await this.get(`/search?type=boardgame,boardgameexpansion&query=${encodeURIComponent(termo)}`);
    const itens: any[] = xml?.items?.item ?? [];
    const alvo = normaliza(termo);
    const vistos = new Set<number>();
    const lista: ResultadoBusca[] = [];
    for (const item of itens) {
      const id = Number(item.id);
      if (vistos.has(id)) continue;
      vistos.add(id);
      lista.push({ bgg_id: id, nome: valor(item.name?.[0]) ?? '', ano: inteiro(item.yearpublished), tipo: item.type });
    }
    const exato = (r: ResultadoBusca) => (normaliza(r.nome) === alvo ? 0 : 1);
    return lista.sort((a, b) => exato(a) - exato(b) || (b.ano ?? 0) - (a.ano ?? 0));
  }

  /** Detalhes de até 20 jogos por chamada. */
  async detalhes(ids: number[]): Promise<JogoBgg[]> {
    if (!ids.length) return [];
    const xml = await this.get(`/thing?stats=1&id=${ids.slice(0, 20).join(',')}`);
    return (xml?.items?.item ?? []).map(converteThing);
  }
}

export function converteThing(item: any): JogoBgg {
  const nomes: any[] = item.name ?? [];
  const links: any[] = item.link ?? [];
  const principal = nomes.find((n) => n.type === 'primary') ?? nomes[0];
  const peso = Number.parseFloat(valor(item.statistics?.ratings?.averageweight) ?? '');
  const categorias = links.filter((l) => l.type === 'boardgamecategory').map((l) => String(l.value));
  const mecanicas = links.filter((l) => l.type === 'boardgamemechanic').map((l) => String(l.value));
  return {
    bgg_id: Number(item.id),
    tipo: item.type,
    nome: String(principal?.value ?? ''),
    outros_nomes: nomes.filter((n) => n !== principal).map((n) => String(n.value)).slice(0, 15),
    ano: inteiro(item.yearpublished),
    min: inteiro(item.minplayers),
    max: inteiro(item.maxplayers),
    peso: Number.isFinite(peso) && peso > 0 ? Math.round(peso * 100) / 100 : null,
    imagem: typeof item.image === 'string' ? item.image : typeof item.thumbnail === 'string' ? item.thumbnail : null,
    cooperativo: mecanicas.includes('Cooperative Game'),
    party_ou_infantil: categorias.includes('Party Game') || categorias.includes("Children's Game"),
    bases: item.type === 'boardgameexpansion'
      ? links.filter((l) => l.type === 'boardgameexpansion' && l.inbound === 'true').map((l) => Number(l.id))
      : [],
  };
}

/**
 * Categoria sugerida pela faixa de peso do cadastro do grupo (em 2026: médio
 * vai de ~1,9 a 2,5 e pesado de ~2,8 para cima).
 */
export function sugereCategoria(jogo: JogoBgg): 'P' | 'M' | 'L' | 'X' | 'Y' {
  if (jogo.tipo === 'boardgameexpansion') return 'X';
  if (jogo.party_ou_infantil) return 'Y';
  if (jogo.peso === null) return 'M';
  if (jogo.peso >= 2.7) return 'P';
  if (jogo.peso >= 1.9) return 'M';
  return 'L';
}
