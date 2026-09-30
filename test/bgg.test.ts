import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BggApi, sugereCategoria } from '../src/bgg.js';

const THING = `<?xml version="1.0" encoding="utf-8"?>
<items termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">
  <item type="boardgame" id="361255">
    <thumbnail>https://cf.geekdo-images.com/t.jpg</thumbnail>
    <image>https://cf.geekdo-images.com/i.jpg</image>
    <name type="primary" sortindex="1" value="Galactic Cruise" />
    <name type="alternate" sortindex="1" value="Cruzeiro Galáctico" />
    <yearpublished value="2025" />
    <minplayers value="1" />
    <maxplayers value="4" />
    <link type="boardgamecategory" id="1016" value="Science Fiction" />
    <link type="boardgamemechanic" id="2082" value="Worker Placement" />
    <statistics page="1"><ratings><averageweight value="3.8732" /></ratings></statistics>
  </item>
  <item type="boardgameexpansion" id="999">
    <name type="primary" sortindex="1" value="Galactic Cruise: Extra" />
    <yearpublished value="2026" />
    <minplayers value="1" /><maxplayers value="5" />
    <link type="boardgamemechanic" id="2023" value="Cooperative Game" />
    <link type="boardgameexpansion" id="361255" value="Galactic Cruise" inbound="true" />
    <statistics page="1"><ratings><averageweight value="0" /></ratings></statistics>
  </item>
</items>`;

const SEARCH = `<items total="3">
  <item type="boardgame" id="1"><name type="primary" value="Galactic Cruise Deluxe"/><yearpublished value="2026"/></item>
  <item type="boardgame" id="361255"><name type="primary" value="Galactic Cruise"/><yearpublished value="2025"/></item>
  <item type="boardgameexpansion" id="999"><name type="primary" value="Galactic Cruise: Extra"/></item>
</items>`;

function bggFalso(respostas: Record<string, string>, chamadas: string[] = []) {
  return new BggApi('token', (async (url: string, init?: RequestInit) => {
    chamadas.push(`${url} ${(init?.headers as Record<string, string>).Authorization}`);
    const chave = Object.keys(respostas).find((k) => url.includes(k));
    return new Response(chave ? respostas[chave] : '', { status: chave ? 200 : 404 });
  }) as typeof fetch);
}

test('detalhes lê nome, jogadores, peso, imagem e base de expansão', async () => {
  const chamadas: string[] = [];
  const [jogo, expansao] = await bggFalso({ '/thing': THING }, chamadas).detalhes([361255, 999]);
  assert.match(chamadas[0], /thing\?stats=1&id=361255,999 Bearer token$/);
  assert.equal(jogo.nome, 'Galactic Cruise');
  assert.deepEqual(jogo.outros_nomes, ['Cruzeiro Galáctico']);
  assert.equal(jogo.peso, 3.87);
  assert.equal(jogo.min, 1);
  assert.equal(jogo.max, 4);
  assert.equal(jogo.imagem, 'https://cf.geekdo-images.com/i.jpg');
  assert.equal(jogo.cooperativo, false);
  assert.equal(sugereCategoria(jogo), 'P');
  assert.equal(expansao.peso, null);
  assert.equal(expansao.cooperativo, true);
  assert.deepEqual(expansao.bases, [361255]);
  assert.equal(sugereCategoria(expansao), 'X');
});

test('busca põe o nome exato primeiro', async () => {
  const r = await bggFalso({ '/search': SEARCH }).busca('galactic cruise');
  assert.equal(r[0].bgg_id, 361255);
  assert.equal(r.length, 3);
});

test('sugereCategoria segue as faixas de peso do grupo', () => {
  const base = { bgg_id: 1, tipo: 'boardgame', nome: 'x', outros_nomes: [], ano: null, min: null, max: null,
    imagem: null, cooperativo: false, party_ou_infantil: false, bases: [] };
  assert.equal(sugereCategoria({ ...base, peso: 2.7 }), 'P');
  assert.equal(sugereCategoria({ ...base, peso: 2.2 }), 'M');
  assert.equal(sugereCategoria({ ...base, peso: 1.5 }), 'L');
  assert.equal(sugereCategoria({ ...base, peso: 1.1, party_ou_infantil: true }), 'Y');
});

test('sem token o BGG não é chamado', async () => {
  await assert.rejects(new BggApi(undefined).busca('x'), /sem token/);
});
