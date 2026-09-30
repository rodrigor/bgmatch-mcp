# bgmatch-mcp

Servidor MCP do [BGMatch](https://github.com/gedvan/bgmatch), o sistema em que o grupo registra as partidas de boardgame e acompanha o ranking do ano. Com ele, um assistente como o Claude consulta partidas, jogos e ranking e registra partidas novas a partir de uma conversa ("registra um Wingspan com a Europa ontem na Ludoteca: Gedvan ganhou, Rodrigo e Bruno empataram em segundo").

O servidor não acessa o banco. Ele chama a API REST do BGMatch com uma conta de serviço, então valem as mesmas validações do site.

## Como usar

Peça um token ao Rodrigo. Cada pessoa tem o seu, e toda alteração feita pelo MCP fica registrada no log com o nome de quem a fez.

No Claude Code:

```bash
claude mcp add --transport http --scope user bgmatch https://bgmatch.vps.rodrigor.com/mcp --header "Authorization: Bearer SEU_TOKEN"
```

No Claude Desktop, o servidor entra pelo `mcp-remote`, no `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bgmatch": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://bgmatch.vps.rodrigor.com/mcp", "--header", "Authorization: Bearer SEU_TOKEN"]
    }
  }
}
```

Outros clientes funcionam se aceitarem MCP por HTTP (Streamable HTTP) com o cabeçalho `Authorization`.

## Ferramentas

Jogos e jogadores são informados pelo nome, sem diferenciar acentos e maiúsculas, ou pelo id. Se o nome bater com mais de um registro, a ferramenta devolve as opções em vez de escolher.

| Ferramenta | O que faz |
|---|---|
| `listar_jogadores` | Jogadores com partidas, vitórias, jogos em que mais venceram e contagem por posição |
| `listar_jogos` | Coleção, com filtro por trecho do nome e por categoria |
| `listar_partidas` | Partidas por período, jogo e jogador (sem período, o ano atual) |
| `ver_partida` | Uma partida pelo id |
| `listar_locais` | Locais já usados, para manter a grafia |
| `ranking` | Classificação do ano pela regra da época; desde 2024, também o detalhe de um mês |
| `pesquisar_ludopedia` | Procura um jogo na Ludopedia para importar |
| `consultar_bgg` | Busca id e peso de um jogo no BoardGameGeek, sem gravar |
| `registrar_partida` | Registra uma partida; se só a expansão for informada, deduz o jogo base |
| `editar_partida` | Altera campos de uma partida; `jogadores` substitui a lista inteira |
| `excluir_partida` | Apaga uma partida (sem volta) |
| `importar_jogo` | Cadastra um jogo a partir do slug da Ludopedia |
| `atualizar_jogo` | Muda categoria, cooperativo, id e peso do BGG ou tira o jogo da coleção |

As ferramentas que alteram ou apagam dados vêm marcadas como destrutivas, e os clientes MCP costumam pedir confirmação antes de executá-las.

Duas limitações de hoje:

- `ranking` depende do endpoint `GET /api/ranking/{ano}` com o cálculo no backend, que ainda não está publicado no BGMatch em produção. Até lá, a ferramenta responde avisando disso.
- A Ludopedia tem recusado as requisições do servidor com HTTP 403, então `pesquisar_ludopedia` e `importar_jogo` falham também pelo site.

## Administração

### Variáveis de ambiente

| Variável | Uso |
|---|---|
| `BGMATCH_API_URL` | URL da API, terminando em `/api` |
| `BGMATCH_USUARIO`, `BGMATCH_SENHA` | Conta de serviço na tabela `usuarios` do BGMatch |
| `BGMATCH_MCP_TOKENS` | Tokens de acesso, `nome:token` separados por vírgula |
| `BGMATCH_MCP_HOSTS` | Valores aceitos no cabeçalho `Host` (proteção contra DNS rebinding) |
| `PORT` | Porta HTTP, padrão 8096 |

Veja `.env.example`.

### Dar acesso a alguém

```bash
npm run token -- nome
```

O comando imprime `nome:token`. Acrescente essa linha em `BGMATCH_MCP_TOKENS`, reinicie o container e mande o token para a pessoa por um canal privado. Para revogar, tire a entrada e reinicie.

### Deploy

```bash
docker compose up -d --build
```

O `compose.yaml` publica a porta só em `127.0.0.1`. O acesso externo passa pelo proxy com TLS, que encaminha `/mcp` para o container. As alterações ficam no log do container, uma linha JSON por ação:

```bash
docker logs bgmatch-mcp | grep '"acao"'
```

Depois de 20 tentativas com token inválido em 10 minutos, o IP recebe HTTP 429 até a janela passar.

## Desenvolvimento

```bash
npm install
npm test
BGMATCH_API_URL=http://localhost:8000/api BGMATCH_USUARIO=mcp BGMATCH_SENHA=... BGMATCH_MCP_TOKENS=eu:$(openssl rand -hex 24) npm run dev
```

Para conferir um servidor no ar, o `scripts/fumaca.mjs` lista as ferramentas e chama as de leitura:

```bash
BGMATCH_MCP_URL=https://bgmatch.vps.rodrigor.com/mcp BGMATCH_MCP_TOKEN=SEU_TOKEN node scripts/fumaca.mjs
```

## Licença

MIT
