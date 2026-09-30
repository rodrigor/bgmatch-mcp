import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BGMatchApi, DadosPartida, ErroApi, Jogo, Partida } from './api.js';
import { ErroDeNome, localCanonico, normaliza, resolve } from './nomes.js';

const CATEGORIAS: Record<string, string> = {
  P: 'Pesado',
  M: 'Médio',
  L: 'Leve',
  X: 'Expansão',
  Y: 'Party/Infantil',
  F: 'Party',
  I: 'Infantil',
};

const MESES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const REGRAS: Record<string, string> = {
  '2019': '2019 a 2021: pontos pela posição (1º a 3º) e pela categoria do jogo. Party/infantil pontua; expansão não.',
  '2022': '2022 e 2023: pontos pela posição (1º a 6º) e pela categoria (pesado, médio, leve). Party/infantil e expansão não pontuam.',
  '2024': 'Desde 2024: cada partida vale (peso no BGG ÷ 5) × fator da posição (10, 7, 4, 1, 1, 1); com expansão, vale o peso da expansão. '
    + 'Os três primeiros de cada mês concluído ganham 3, 2 e 1 estrelas. Vence quem somar mais estrelas; o desempate é pelo número de meses vencidos.',
};

const DATA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use o formato AAAA-MM-DD');
const PERIODO = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, 'Use AAAA, AAAA-MM ou AAAA-MM-DD');

export type Registro = (acao: string, pessoa: string, detalhes: Record<string, unknown>) => void;

const registroPadrao: Registro = (acao, pessoa, detalhes) => {
  console.log(JSON.stringify({ quando: new Date().toISOString(), pessoa, acao, ...detalhes }));
};

/**
 * Registra as ferramentas no servidor MCP. `pessoa` é quem está usando (vem do
 * token) e entra no log de toda escrita.
 */
export function registraFerramentas(server: McpServer, api: BGMatchApi, pessoa: string, registro: Registro = registroPadrao) {
  const ferramenta = <S extends z.ZodRawShape>(
    nome: string,
    config: {
      title: string;
      description: string;
      inputSchema: S;
      annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
    },
    executa: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
  ) => {
    server.registerTool(nome, config, (async (args: z.infer<z.ZodObject<S>>): Promise<CallToolResult> => {
      try {
        return texto(await executa(args));
      } catch (e) {
        if (e instanceof ErroDeNome || e instanceof ErroApi || e instanceof ErroDeUso) {
          return { isError: true, content: [{ type: 'text', text: e.message }] };
        }
        console.error(`[${nome}]`, e);
        return { isError: true, content: [{ type: 'text', text: 'Erro inesperado no servidor MCP do BGMatch.' }] };
      }
    }) as never);
  };

  // ---------------------------------------------------------------- leitura

  ferramenta('listar_jogadores', {
    title: 'Listar jogadores',
    description: 'Jogadores do grupo com número de partidas, vitórias, jogos em que mais venceram e quantas vezes ficaram em cada posição.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    const jogadores = await api.dadosJogadores();
    return jogadores.map((j) => ({
      id: j.id,
      nome: j.nome,
      partidas: j.num_partidas,
      vitorias: j.num_vitorias,
      jogos_com_mais_vitorias: j.vitorias.map((v) => `${v.nome_jogo} (${v.qtd})`),
      posicoes: Object.fromEntries(j.resultados.map((r) => [r.posicao === null ? 'sem posição' : `${r.posicao}º`, r.quantidade])),
    }));
  });

  ferramenta('listar_jogos', {
    title: 'Listar jogos',
    description: 'Jogos da coleção do grupo, com categoria, peso no BGG, número de jogadores e partidas. '
      + 'Filtra por trecho do nome e por categoria (P pesado, M médio, L leve, X expansão, Y party/infantil).',
    inputSchema: {
      busca: z.string().optional().describe('Trecho do nome, sem diferenciar acentos e maiúsculas'),
      categoria: z.enum(['P', 'M', 'L', 'X', 'Y']).optional(),
      incluir_excluidos: z.boolean().default(false).describe('Inclui jogos que saíram da coleção'),
      limite: z.number().int().min(1).max(300).default(50),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ busca, categoria, incluir_excluidos, limite }) => {
    const jogos = await api.jogos();
    const porId = new Map(jogos.map((j) => [j.id, j]));
    const alvo = busca ? normaliza(busca) : '';
    const filtrados = jogos.filter((j) =>
      (incluir_excluidos || !j.excluido)
      && (!categoria || categoriaUnificada(j.categoria) === categoria)
      && (!alvo || normaliza(j.nome).includes(alvo)));
    return {
      total_encontrado: filtrados.length,
      jogos: filtrados.slice(0, limite).map((j) => ({
        id: j.id,
        nome: j.nome,
        categoria: CATEGORIAS[j.categoria] ?? j.categoria,
        ...(j.id_base ? { expansao_de: porId.get(j.id_base)?.nome ?? j.id_base } : {}),
        peso_bgg: numero(j.bgg_weight),
        jogadores: j.min || j.max ? `${j.min ?? '?'} a ${j.max ?? '?'}` : null,
        cooperativo: j.coop,
        partidas: Number(j.num_partidas),
        ultima_partida: j.ultima_partida,
        ...(j.excluido ? { fora_da_colecao: true } : {}),
      })),
    };
  });

  ferramenta('listar_partidas', {
    title: 'Listar partidas',
    description: 'Partidas registradas, da mais recente para a mais antiga. Sem período, usa o ano atual. '
      + 'Pode filtrar por jogo (inclui partidas com a expansão) e por jogador.',
    inputSchema: {
      inicio: PERIODO.optional().describe('Início do período: AAAA, AAAA-MM ou AAAA-MM-DD'),
      fim: PERIODO.optional().describe('Fim do período: AAAA, AAAA-MM ou AAAA-MM-DD'),
      jogo: z.string().optional().describe('Nome ou id do jogo'),
      jogador: z.string().optional().describe('Nome ou id do jogador'),
      apenas_ranking: z.boolean().default(false).describe('Só partidas que contam para o ranking'),
      limite: z.number().int().min(1).max(200).default(30),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ inicio, fim, jogo, jogador, apenas_ranking, limite }) => {
    const periodo = inicio || fim ? `${inicio ?? ''}:${fim ?? ''}` : String(new Date().getFullYear());
    let partidas = await api.partidas(periodo, { apenasRanking: apenas_ranking });
    if (jogo) {
      const alvo = resolve(await api.jogos(), jogo, 'jogo');
      partidas = partidas.filter((p) => p.jogo.id === alvo.id || p.expansao?.id === alvo.id);
    }
    if (jogador) {
      const alvo = resolve(await api.jogadores(), jogador, 'jogador');
      partidas = partidas.filter((p) => p.jogadores.some((j) => j.id === alvo.id));
    }
    return {
      periodo,
      total_encontrado: partidas.length,
      partidas: partidas.slice(0, limite).map(formataPartida),
    };
  });

  ferramenta('ver_partida', {
    title: 'Ver partida',
    description: 'Detalhes de uma partida pelo id.',
    inputSchema: { id: z.number().int().positive() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ id }) => formataPartida(await api.partida(id)));

  ferramenta('listar_locais', {
    title: 'Listar locais',
    description: 'Locais onde já houve partidas. Útil para escrever o local igual ao já usado ao registrar uma partida.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => (await api.locais()).filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt-BR')));

  ferramenta('ranking', {
    title: 'Ranking do ano',
    description: 'Classificação do ranking de um ano (padrão: ano atual), calculada com a regra em vigor naquele ano. '
      + 'Desde 2024 dá para detalhar um mês: partidas, pontos de cada jogador e classificação do mês.',
    inputSchema: {
      ano: z.number().int().min(2019).max(2100).optional(),
      mes: z.number().int().min(1).max(12).optional().describe('Mês a detalhar (só a partir de 2024)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ ano, mes }) => {
    const alvo = ano ?? new Date().getFullYear();
    const r = await api.ranking(alvo) as any;
    if (!r || typeof r.regra !== 'string') {
      throw new ErroDeUso('O servidor do BGMatch ainda não calcula o ranking no backend. '
        + 'Isso passa a funcionar quando a versão nova do BGMatch for publicada.');
    }
    return r.regra === '2024' ? formataRanking2024(r, mes) : formataRankingTrilha(r, mes);
  });

  ferramenta('pesquisar_ludopedia', {
    title: 'Pesquisar na Ludopedia',
    description: 'Procura jogos na Ludopedia pelo nome. Devolve o slug usado por importar_jogo e diz se o jogo já está cadastrado.',
    inputSchema: { termo: z.string().min(2) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ termo }) => {
    const resultados = await api.pesquisaLudopedia(termo.trim().replace(/\s+/g, '+'));
    if (!resultados.length) {
      return {
        resultados: [],
        aviso: 'Nenhum resultado. A Ludopedia tem recusado consultas automáticas do servidor (HTTP 403), '
          + 'então a lista vazia pode não significar que o jogo não existe lá.',
      };
    }
    return resultados.map((j) => ({ titulo: j.title, slug: j.slug, ja_cadastrado: j.cadastrado, link: j.link }));
  });

  ferramenta('consultar_bgg', {
    title: 'Consultar BGG',
    description: 'Busca no BoardGameGeek o id e o peso de um jogo cadastrado. Só consulta; para gravar, use atualizar_jogo.',
    inputSchema: { jogo: z.string().describe('Nome ou id do jogo') },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ jogo }) => {
    const alvo = resolve(await api.jogos(), jogo, 'jogo');
    const bgg = await api.dadosBgg(alvo.id);
    return {
      jogo: alvo.nome,
      bgg_id_encontrado: bgg.bgg_id,
      peso_bgg_encontrado: bgg.bgg_weight,
      bgg_id_cadastrado: alvo.bgg_id,
      peso_bgg_cadastrado: numero(alvo.bgg_weight),
    };
  });

  // ---------------------------------------------------------------- escrita

  const JOGADORES_PARTIDA = z.array(z.object({
    jogador: z.string().describe('Nome ou id do jogador'),
    posicao: z.number().int().min(1).max(20).describe('Colocação; empates repetem a posição'),
    pontuacao: z.number().int().optional().describe('Pontos no jogo, se alguém anotou'),
  })).min(1);

  ferramenta('registrar_partida', {
    title: 'Registrar partida',
    description: 'Registra uma partida nova. Informe o jogo base em `jogo` e, se houver, a expansão em `expansao` '
      + '(se só a expansão for informada em `jogo`, o jogo base é deduzido). Empates repetem a posição.',
    inputSchema: {
      jogo: z.string().describe('Nome ou id do jogo base'),
      expansao: z.string().optional().describe('Nome ou id da expansão usada'),
      data: DATA,
      local: z.string().min(1).describe('Onde foi jogada. Se bater com um local já usado (sem diferenciar acento, caixa e espaços), fica a grafia existente'),
      jogadores: JOGADORES_PARTIDA,
      conta_para_ranking: z.boolean().default(true),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => {
    validaData(args.data);
    const [jogos, jogadores, locais] = await Promise.all([api.jogos(), api.jogadores(), api.locais()]);
    const { jogo, expansao } = resolveJogoEExpansao(jogos, args.jogo, args.expansao);
    const lista = resolveJogadores(jogadores, args.jogadores);
    const local = localCanonico(args.local, locais);

    const dados: DadosPartida = {
      id_jogo: jogo.id,
      id_expansao: expansao?.id ?? null,
      data: args.data,
      local: local.local,
      ranking: args.conta_para_ranking,
      jogadores: lista,
    };
    await api.criaPartida(dados);

    // A API não devolve o id; procura a partida recém-criada.
    const doDia = await api.partidas(args.data);
    const ids = new Set(lista.map((j) => j.id));
    const criada = doDia
      .filter((p) => p.jogo.id === jogo.id && p.jogadores.length === ids.size && p.jogadores.every((j) => ids.has(j.id)))
      .sort((a, b) => b.id - a.id)[0];

    registro('registrar_partida', pessoa, { id: criada?.id ?? null, dados });
    return {
      registrada: true,
      partida: criada ? formataPartida(criada) : dados,
      ...(local.novo ? { aviso: `"${local.local}" é um local novo no BGMatch.` } : {}),
    };
  });

  ferramenta('editar_partida', {
    title: 'Editar partida',
    description: 'Altera uma partida existente. Só os campos informados mudam; `jogadores`, se informado, substitui a lista inteira. '
      + 'Use expansao: null para tirar a expansão.',
    inputSchema: {
      id: z.number().int().positive(),
      jogo: z.string().optional(),
      expansao: z.string().nullable().optional(),
      data: DATA.optional(),
      local: z.string().min(1).optional(),
      jogadores: JOGADORES_PARTIDA.optional(),
      conta_para_ranking: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    const atual = await api.partida(args.id);
    const dados: DadosPartida = {
      id_jogo: atual.jogo.id,
      id_expansao: atual.expansao?.id ?? null,
      data: atual.data,
      local: atual.local,
      ranking: Boolean(atual.ranking),
      jogadores: atual.jogadores.map((j) => ({ id: j.id, posicao: j.posicao as number, pontuacao: j.pontuacao ?? 0 })),
    };

    if (args.jogo !== undefined || args.expansao !== undefined) {
      const jogos = await api.jogos();
      const nomeJogo = args.jogo ?? String(atual.jogo.id);
      const nomeExpansao = args.expansao === undefined
        ? (atual.expansao ? String(atual.expansao.id) : undefined)
        : (args.expansao ?? undefined);
      const { jogo, expansao } = resolveJogoEExpansao(jogos, nomeJogo, nomeExpansao);
      dados.id_jogo = jogo.id;
      dados.id_expansao = expansao?.id ?? null;
    }
    if (args.data !== undefined) {
      validaData(args.data);
      dados.data = args.data;
    }
    if (args.local !== undefined) {
      dados.local = localCanonico(args.local, await api.locais()).local;
    }
    if (args.conta_para_ranking !== undefined) {
      dados.ranking = args.conta_para_ranking;
    }
    if (args.jogadores !== undefined) {
      dados.jogadores = resolveJogadores(await api.jogadores(), args.jogadores);
    }

    await api.atualizaPartida(args.id, dados);
    const depois = await api.partida(args.id);
    registro('editar_partida', pessoa, { id: args.id, antes: formataPartida(atual), depois: formataPartida(depois) });
    return { atualizada: true, antes: formataPartida(atual), depois: formataPartida(depois) };
  });

  ferramenta('excluir_partida', {
    title: 'Excluir partida',
    description: 'Apaga uma partida de forma definitiva. Confirme com a pessoa antes de usar.',
    inputSchema: { id: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const partida = await api.partida(id);
    await api.excluiPartida(id);
    registro('excluir_partida', pessoa, { id, partida: formataPartida(partida) });
    return { excluida: true, partida: formataPartida(partida) };
  });

  ferramenta('importar_jogo', {
    title: 'Importar jogo da Ludopedia',
    description: 'Cadastra um jogo a partir da Ludopedia. Use pesquisar_ludopedia antes para achar o slug.',
    inputSchema: { slug: z.string().regex(/^[a-z0-9-]+$/, 'Slug da Ludopedia, como "brass-birmingham"') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ slug }) => {
    const jaExiste = (await api.jogos()).find((j) => j.slug === slug);
    if (jaExiste) {
      throw new ErroDeUso(`${jaExiste.nome} já está cadastrado (id ${jaExiste.id}).`);
    }
    const resposta = await api.importaJogo(slug);
    registro('importar_jogo', pessoa, { slug, jogo: resposta.jogo });
    return { importado: resposta.sucesso, jogo: resposta.jogo };
  });

  ferramenta('atualizar_jogo', {
    title: 'Atualizar jogo',
    description: 'Muda categoria, modo cooperativo, id e peso do BGG ou marca o jogo como fora da coleção. Só os campos informados mudam.',
    inputSchema: {
      jogo: z.string().describe('Nome ou id do jogo'),
      categoria: z.enum(['P', 'M', 'L', 'X', 'Y']).optional(),
      cooperativo: z.boolean().optional(),
      fora_da_colecao: z.boolean().optional(),
      bgg_id: z.number().int().positive().nullable().optional(),
      peso_bgg: z.number().min(0).max(5).nullable().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    const alvo = resolve(await api.jogos(), args.jogo, 'jogo');
    const campos: Record<string, unknown> = {};
    if (args.categoria !== undefined) campos.categoria = args.categoria;
    if (args.cooperativo !== undefined) campos.coop = args.cooperativo;
    if (args.fora_da_colecao !== undefined) campos.excluido = args.fora_da_colecao;
    if (args.bgg_id !== undefined) campos.bgg_id = args.bgg_id;
    if (args.peso_bgg !== undefined) campos.bgg_weight = args.peso_bgg;
    if (!Object.keys(campos).length) {
      throw new ErroDeUso('Informe ao menos um campo para alterar.');
    }
    const antes = Object.fromEntries(Object.keys(campos).map((k) => [k, (alvo as any)[k]]));
    const { updated } = await api.atualizaJogo(alvo.id, campos);
    registro('atualizar_jogo', pessoa, { id: alvo.id, jogo: alvo.nome, antes, depois: campos });
    return { atualizado: updated === 1, jogo: alvo.nome, antes, depois: campos };
  });
}

// ------------------------------------------------------------------ apoio

export class ErroDeUso extends Error {}

function texto(dados: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(dados, null, 2) }] };
}

function numero(valor: string | number | null | undefined): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

const umaCasa = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10;

function categoriaUnificada(categoria: string): string {
  return categoria === 'F' || categoria === 'I' ? 'Y' : categoria;
}

function validaData(data: string) {
  const d = new Date(`${data}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== data) {
    throw new ErroDeUso(`Data inválida: ${data}.`);
  }
}

export function formataPartida(p: Partida) {
  return {
    id: p.id,
    data: p.data,
    local: p.local,
    jogo: p.jogo.nome,
    expansao: p.expansao?.nome ?? null,
    conta_para_ranking: Boolean(p.ranking),
    resultado: p.jogadores.map((j) => ({
      posicao: j.posicao,
      jogador: j.nome,
      ...(j.pontuacao ? { pontuacao: j.pontuacao } : {}),
    })),
  };
}

/**
 * Resolve jogo base e expansão. Se o "jogo" informado for uma expansão e não
 * vier expansão separada, usa o jogo base dela.
 */
export function resolveJogoEExpansao(jogos: Jogo[], nomeJogo: string, nomeExpansao?: string) {
  const ativos = jogos.filter((j) => !j.excluido);
  let jogo = resolve(ativos, nomeJogo, 'jogo');
  let expansao: Jogo | null = null;

  if (jogo.categoria === 'X') {
    if (nomeExpansao || !jogo.id_base) {
      throw new ErroDeUso(`${jogo.nome} é uma expansão. Informe o jogo base em "jogo" e a expansão em "expansao".`);
    }
    expansao = jogo;
    jogo = resolve(jogos, String(jogo.id_base), 'jogo');
  } else if (nomeExpansao) {
    expansao = resolve(ativos.filter((j) => j.categoria === 'X'), nomeExpansao, 'expansão');
    if (expansao.id_base && expansao.id_base !== jogo.id) {
      const base = jogos.find((j) => j.id === expansao!.id_base);
      throw new ErroDeUso(`${expansao.nome} é expansão de ${base?.nome ?? `id ${expansao.id_base}`}, não de ${jogo.nome}.`);
    }
  }
  return { jogo, expansao };
}

export function resolveJogadores(
  jogadores: { id: number; nome: string }[],
  lista: { jogador: string; posicao: number; pontuacao?: number }[],
) {
  const resolvidos = lista.map((j) => ({
    id: resolve(jogadores, j.jogador, 'jogador').id,
    posicao: j.posicao,
    pontuacao: j.pontuacao ?? 0,
  }));
  const ids = resolvidos.map((j) => j.id);
  const repetido = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repetido !== undefined) {
    const nome = jogadores.find((j) => j.id === repetido)?.nome;
    throw new ErroDeUso(`${nome} aparece mais de uma vez na partida.`);
  }
  return resolvidos.sort((a, b) => a.posicao - b.posicao);
}

function formataRanking2024(r: any, mes?: number) {
  const classificacao = r.jogadores.map((j: any, i: number) => ({
    posicao: i + 1,
    jogador: j.nome,
    estrelas: j.pontos_total,
    meses_vencidos: j.pontos_meses.filter((pv: number) => pv === 3).length,
    estrelas_por_mes: Object.fromEntries(j.pontos_meses
      .map((pv: number, m: number) => [MESES_ABREV[m], pv])
      .filter(([, pv]: [string, number]) => pv > 0)),
  }));

  if (mes) {
    const m = r.meses[mes - 1];
    return {
      ano: r.ano,
      regra: REGRAS['2024'],
      mes: m.nome,
      concluido: m.concluido,
      classificacao_do_mes: m.classificacao.map((c: any) => ({ jogador: c.nome, pontos: umaCasa(c.pontos) })),
      partidas: m.partidas.map((p: any) => ({
        id: p.id,
        data: p.data,
        jogo: p.expansao ? `${p.jogo.nome} + ${p.expansao.nome}` : p.jogo.nome,
        peso: p.peso,
        resultado: p.jogadores.map((j: any) => ({ posicao: j.posicao, jogador: j.nome, pontos: umaCasa(j.pontos) })),
      })),
      classificacao_do_ano: classificacao,
    };
  }

  const meses = r.meses
    .map((m: any, i: number) => {
      if (!m.partidas.length && !m.concluido) return null;
      const base = { mes: m.nome, concluido: m.concluido, partidas: m.partidas.length };
      if (m.concluido) {
        const podio = r.jogadores
          .filter((j: any) => j.pontos_meses[i] > 0)
          .sort((a: any, b: any) => b.pontos_meses[i] - a.pontos_meses[i])
          .map((j: any) => {
            const pontos = m.classificacao.find((c: any) => c.id === j.id)?.pontos ?? 0;
            return `${j.nome}: ${j.pontos_meses[i]} estrela(s), ${umaCasa(pontos)} pontos`;
          });
        return { ...base, podio };
      }
      const parcial = m.classificacao.filter((c: any) => c.pontos > 0).slice(0, 3)
        .map((c: any) => `${c.nome}: ${umaCasa(c.pontos)} pontos`);
      return { ...base, lideres_parciais: parcial };
    })
    .filter(Boolean);

  return { ano: r.ano, regra: REGRAS['2024'], classificacao, meses };
}

function formataRankingTrilha(r: any, mes?: number) {
  if (mes) {
    throw new ErroDeUso(`O detalhamento por mês só existe a partir de 2024; em ${r.ano} a pontuação é acumulada no ano.`);
  }
  return {
    ano: r.ano,
    regra: REGRAS[r.regra] ?? r.regra,
    classificacao: r.jogadores.map((j: any, i: number) => ({
      posicao: i + 1,
      jogador: j.nome,
      pontos: j.total,
      pontos_por_mes: Object.fromEntries(j.mensal
        .map((p: number, m: number) => [MESES_ABREV[m], p])
        .filter(([, p]: [string, number]) => p > 0)),
    })),
    tabela_de_pontos: r.tabela.posicoes.map((p: any) => ({
      posicao: `${p.posicao}º`,
      ...Object.fromEntries(Object.entries(p.pontos).map(([k, v]) => [CATEGORIAS[k] ?? k, v])),
    })),
  };
}
