import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BGMatchApi, Jogo } from '../src/api.js';
import { identifica, LimiteDeFalhas } from '../src/auth.js';
import { leTokens } from '../src/config.js';
import { ErroDeUso, resolveJogadores, resolveJogoEExpansao } from '../src/ferramentas.js';
import { ErroDeNome, normaliza, resolve } from '../src/nomes.js';

const jogadores = [
  { id: 1, nome: 'Gedvan' },
  { id: 2, nome: 'Rodrigo' },
  { id: 3, nome: 'Rodrigo Alves' },
  { id: 4, nome: 'Fechine' },
];

test('normaliza ignora acento, caixa e pontuação', () => {
  assert.equal(normaliza('  Brass: Birmingham! '), 'brass birmingham');
  assert.equal(normaliza('Ágora Médio'), 'agora medio');
});

test('resolve prefere nome exato a trecho', () => {
  assert.equal(resolve(jogadores, 'rodrigo', 'jogador').id, 2);
  assert.equal(resolve(jogadores, 'FECHINE', 'jogador').id, 4);
});

test('resolve aceita trecho único e id', () => {
  assert.equal(resolve(jogadores, 'alves', 'jogador').id, 3);
  assert.equal(resolve(jogadores, '#1', 'jogador').nome, 'Gedvan');
  assert.equal(resolve(jogadores, '4', 'jogador').nome, 'Fechine');
});

test('resolve falha em ambiguidade e em nome inexistente', () => {
  assert.throws(() => resolve(jogadores, 'rod', 'jogador'), (e: Error) => e instanceof ErroDeNome && /mais de um/.test(e.message));
  assert.throws(() => resolve(jogadores, 'Zé', 'jogador'), ErroDeNome);
  assert.throws(() => resolve(jogadores, '99', 'jogador'), /id 99/);
});

const tokenA = 'a'.repeat(40);
const tokenB = 'b'.repeat(40);

test('leTokens valida formato e tamanho', () => {
  const tokens = leTokens(`ana:${tokenA}, bruno:${tokenB}`);
  assert.equal(tokens.get(tokenB), 'bruno');
  assert.throws(() => leTokens('ana:curto'), /curto/);
  assert.throws(() => leTokens(`sem-dois-pontos${tokenA}`), /formato/);
  assert.throws(() => leTokens(`ana:${tokenA},bia:${tokenA}`), /repetido/);
});

test('identifica a pessoa pelo Bearer', () => {
  const tokens = leTokens(`ana:${tokenA},bruno:${tokenB}`);
  assert.equal(identifica(`Bearer ${tokenB}`, tokens), 'bruno');
  assert.equal(identifica(`bearer ${tokenA}`, tokens), 'ana');
  assert.equal(identifica(`Bearer ${tokenA}x`, tokens), null);
  assert.equal(identifica(undefined, tokens), null);
  assert.equal(identifica(tokenA, tokens), null);
});

test('LimiteDeFalhas bloqueia depois do máximo e libera após a janela', () => {
  const limite = new LimiteDeFalhas(3, 1000);
  for (let i = 0; i < 3; i++) limite.registra('1.2.3.4', 0);
  assert.equal(limite.bloqueado('1.2.3.4', 500), true);
  assert.equal(limite.bloqueado('5.6.7.8', 500), false);
  assert.equal(limite.bloqueado('1.2.3.4', 1500), false);
});

function jwt(expSegundos: number) {
  const payload = Buffer.from(JSON.stringify({ sub: 1, exp: expSegundos })).toString('base64url');
  return `x.${payload}.y`;
}

test('BGMatchApi reaproveita o token e entra de novo após 401', async () => {
  const chamadas: string[] = [];
  let logins = 0;
  let recusaProxima = false;
  const fetchFalso = (async (url: string, init?: RequestInit) => {
    const caminho = url.replace('http://api', '');
    chamadas.push(`${init?.method} ${caminho}`);
    if (caminho === '/login') {
      logins++;
      return new Response(JSON.stringify({ token: jwt(Date.now() / 1000 + 7200) }), { status: 200 });
    }
    if (recusaProxima) {
      recusaProxima = false;
      return new Response('expirado', { status: 401 });
    }
    return new Response(JSON.stringify([{ id: 1, nome: 'Ana', cor: '#000' }]), { status: 200 });
  }) as typeof fetch;

  const api = new BGMatchApi('http://api', 'mcp', 'senha', fetchFalso);
  await api.jogadores();
  await api.jogadores();
  assert.equal(logins, 1);
  recusaProxima = true;
  const lista = await api.jogadores();
  assert.equal(lista[0].nome, 'Ana');
  assert.equal(logins, 2);
});

test('BGMatchApi renova o token perto de expirar', async () => {
  let logins = 0;
  const fetchFalso = (async (url: string) => {
    if (url.endsWith('/login')) {
      logins++;
      // Expira em 30 s: dentro da folga de 1 minuto, então renova sempre.
      return new Response(JSON.stringify({ token: jwt(Date.now() / 1000 + 30) }), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  const api = new BGMatchApi('http://api', 'mcp', 'senha', fetchFalso);
  await api.jogadores();
  await api.jogadores();
  assert.equal(logins, 2);
});

const jogo = (id: number, nome: string, categoria: string, extra: Partial<Jogo> = {}): Jogo => ({
  id, nome, categoria, min: 1, max: 4, slug: nome.toLowerCase(), id_base: null, coop: false, excluido: false,
  bgg_id: null, bgg_weight: null, num_partidas: 0, ultima_partida: null, ...extra,
});

const jogos = [
  jogo(1, 'Wingspan', 'M'),
  jogo(2, 'Wingspan: Europa', 'X', { id_base: 1 }),
  jogo(3, 'Terraforming Mars', 'P'),
  jogo(4, 'Prelúdio', 'X', { id_base: 3 }),
  jogo(5, 'Catan', 'M', { excluido: true }),
];

test('resolveJogoEExpansao deduz o jogo base a partir da expansão', () => {
  const r = resolveJogoEExpansao(jogos, 'europa');
  assert.equal(r.jogo.nome, 'Wingspan');
  assert.equal(r.expansao?.nome, 'Wingspan: Europa');
});

test('resolveJogoEExpansao recusa expansão de outro jogo e jogo fora da coleção', () => {
  assert.throws(() => resolveJogoEExpansao(jogos, 'wingspan', 'preludio'), ErroDeUso);
  assert.throws(() => resolveJogoEExpansao(jogos, 'catan'), ErroDeNome);
  const r = resolveJogoEExpansao(jogos, 'terraforming', 'prelúdio');
  assert.equal(r.expansao?.id, 4);
});

test('resolveJogadores ordena por posição e recusa jogador repetido', () => {
  const r = resolveJogadores(jogadores, [
    { jogador: 'fechine', posicao: 2 },
    { jogador: 'gedvan', posicao: 1, pontuacao: 87 },
  ]);
  assert.deepEqual(r, [{ id: 1, posicao: 1, pontuacao: 87 }, { id: 4, posicao: 2, pontuacao: 0 }]);
  assert.throws(() => resolveJogadores(jogadores, [
    { jogador: 'gedvan', posicao: 1 },
    { jogador: '1', posicao: 2 },
  ]), /mais de uma vez/);
});
