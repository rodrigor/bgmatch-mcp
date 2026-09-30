/**
 * Resolve nomes digitados numa conversa ("brass", "Rodrigo") para registros.
 * Aceita também o id numérico.
 */

export class ErroDeNome extends Error {}

export function normaliza(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Procura pelo id (se o texto for só dígitos), depois pelo nome exato e por
 * fim por trecho do nome. Falha se não achar nada ou se achar mais de um.
 */
export function resolve<T extends { id: number; nome: string }>(itens: T[], texto: string, tipo: string): T {
  const bruto = texto.trim();
  if (/^#?\d+$/.test(bruto)) {
    const id = Number(bruto.replace('#', ''));
    const item = itens.find((i) => i.id === id);
    if (item) {
      return item;
    }
    throw new ErroDeNome(`Nenhum ${tipo} com id ${id}.`);
  }

  // O BG Stats acrescenta o grupo entre parênteses: "Gedvan (Amigos Board)".
  const alvo = normaliza(bruto.replace(/\([^)]*\)/g, ' '));
  if (!alvo) {
    throw new ErroDeNome(`Informe o nome do ${tipo}.`);
  }

  const exatos = itens.filter((i) => normaliza(i.nome) === alvo);
  if (exatos.length === 1) {
    return exatos[0];
  }
  if (exatos.length > 1) {
    throw ambiguo(exatos, texto, tipo);
  }

  const parciais = itens.filter((i) => normaliza(i.nome).includes(alvo));
  if (parciais.length === 1) {
    return parciais[0];
  }
  if (parciais.length > 1) {
    throw ambiguo(parciais, texto, tipo);
  }

  // Nome completo informado para um cadastro mais curto: "Bruno Vinicius" é
  // "Bruno" e "Rodrigo Rebouças" é "Rodrigo". Vale só palavra inteira no início.
  const prefixos = itens.filter((i) => alvo.startsWith(`${normaliza(i.nome)} `));
  if (prefixos.length === 1) {
    return prefixos[0];
  }
  if (prefixos.length > 1) {
    throw ambiguo(prefixos, texto, tipo);
  }

  // Sugestões: itens que compartilham alguma palavra com o texto.
  const palavras = alvo.split(' ').filter((p) => p.length > 2);
  const sugestoes = itens
    .filter((i) => palavras.some((p) => normaliza(i.nome).includes(p)))
    .slice(0, 8)
    .map(descreve);
  const dica = sugestoes.length ? ` Parecidos: ${sugestoes.join('; ')}.` : '';
  throw new ErroDeNome(`Nenhum ${tipo} encontrado para "${texto}".${dica}`);
}

function ambiguo(itens: { id: number; nome: string }[], texto: string, tipo: string): ErroDeNome {
  const lista = itens.slice(0, 10).map(descreve).join('; ');
  const resto = itens.length > 10 ? ` e mais ${itens.length - 10}` : '';
  return new ErroDeNome(`"${texto}" corresponde a mais de um ${tipo}: ${lista}${resto}. Use o nome completo ou o id.`);
}

const descreve = (i: { id: number; nome: string }) => `${i.nome} (id ${i.id})`;

/**
 * Devolve a grafia já usada de um local, comparando sem acento, caixa e
 * espaços ("Boardgamearena" é "Board Game Arena"). Sem correspondência,
 * devolve o texto informado e `novo: true`.
 */
export function localCanonico(local: string, existentes: string[]): { local: string; novo: boolean } {
  const chave = (s: string) => normaliza(s).replace(/ /g, '');
  const alvo = chave(local);
  const achado = existentes.find((e) => e && chave(e) === alvo);
  return achado ? { local: achado, novo: false } : { local: local.trim(), novo: true };
}
