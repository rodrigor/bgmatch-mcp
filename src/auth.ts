import { createHash, timingSafeEqual } from 'node:crypto';

const hash = (valor: string) => createHash('sha256').update(valor).digest();

/**
 * Identifica a pessoa pelo cabeçalho "Authorization: Bearer <token>".
 * Devolve o nome associado ao token ou null se o token não for reconhecido.
 *
 * Compara os hashes em tempo constante e percorre todos os tokens, para não
 * vazar pela duração da resposta qual token chegou mais perto.
 */
export function identifica(authorization: string | undefined, tokens: Map<string, string>): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  if (!m) {
    return null;
  }
  const recebido = hash(m[1]);
  let pessoa: string | null = null;
  for (const [token, nome] of tokens) {
    if (timingSafeEqual(recebido, hash(token))) {
      pessoa = nome;
    }
  }
  return pessoa;
}

/**
 * Limita tentativas com token inválido por IP numa janela de tempo.
 */
export class LimiteDeFalhas {
  private falhas = new Map<string, number[]>();

  constructor(private maximo = 20, private janelaMs = 10 * 60 * 1000) {}

  bloqueado(ip: string, agora = Date.now()): boolean {
    return this.recentes(ip, agora).length >= this.maximo;
  }

  registra(ip: string, agora = Date.now()): void {
    const lista = this.recentes(ip, agora);
    lista.push(agora);
    this.falhas.set(ip, lista);
  }

  private recentes(ip: string, agora: number): number[] {
    const lista = (this.falhas.get(ip) ?? []).filter((t) => agora - t < this.janelaMs);
    if (lista.length) {
      this.falhas.set(ip, lista);
    } else {
      this.falhas.delete(ip);
    }
    return lista;
  }
}
