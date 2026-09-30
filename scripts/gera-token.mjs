// Gera um token de acesso para uma pessoa, no formato aceito por
// BGMATCH_MCP_TOKENS. Uso: npm run token -- nome
import { randomBytes } from 'node:crypto';

const nome = (process.argv[2] ?? '').trim().toLowerCase();
if (!/^[a-z0-9._-]+$/.test(nome)) {
  console.error('Uso: npm run token -- nome   (letras minúsculas, números, ponto, hífen ou sublinhado)');
  process.exit(1);
}
console.log(`${nome}:${randomBytes(32).toString('base64url')}`);
