'use strict';

/* Senhas, tokens e limite de tentativas. */

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const CUSTO = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const TAMANHO = 64;

async function gerarHash(senha) {
  const sal = crypto.randomBytes(16);
  const chave = await scrypt(senha.normalize('NFC'), sal, TAMANHO, CUSTO);
  return `scrypt$${CUSTO.N}$${CUSTO.r}$${CUSTO.p}$${sal.toString('base64')}$${chave.toString('base64')}`;
}

async function conferirHash(senha, guardado) {
  const [tipo, N, r, p, sal, chave] = String(guardado).split('$');
  if (tipo !== 'scrypt') return false;
  const esperado = Buffer.from(chave, 'base64');
  const obtido = await scrypt(senha.normalize('NFC'), Buffer.from(sal, 'base64'), esperado.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: CUSTO.maxmem
  });
  return crypto.timingSafeEqual(esperado, obtido);
}

/* Comparado quando o e-mail não existe, para a resposta levar o mesmo tempo. */
let iscaPronta;
const hashIsca = () => (iscaPronta ||= gerarHash(crypto.randomBytes(16).toString('hex')));

const novoToken = () => crypto.randomBytes(32).toString('base64url');
/* No banco fica só o resumo do token: quem ler o banco não consegue entrar nas contas. */
const resumo = token => crypto.createHash('sha256').update(token).digest('hex');

/* Janela fixa em memória. Suficiente para um processo só. */
function criarLimite({ maximo, janela }) {
  const mapa = new Map();
  return {
    tentar(chave) {
      const agora = Date.now();
      if (mapa.size > 10000) for (const [k, v] of mapa) if (v.fim <= agora) mapa.delete(k);
      let x = mapa.get(chave);
      if (!x || x.fim <= agora) mapa.set(chave, x = { n: 0, fim: agora + janela });
      x.n++;
      return x.n <= maximo ? 0 : Math.ceil((x.fim - agora) / 1000);
    },
    zerar: chave => mapa.delete(chave)
  };
}

module.exports = { gerarHash, conferirHash, hashIsca, novoToken, resumo, criarLimite };
