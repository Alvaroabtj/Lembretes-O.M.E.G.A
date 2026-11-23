'use strict';

/*
 * Liga o servidor. Configuração por variáveis de ambiente:
 *   PORT          porta (padrão 3000)
 *   HOST          endereço (padrão: só este computador; 0.0.0.0 com NODE_ENV=production)
 *   OMEGA_BANCO   arquivo do banco (padrão dados/omega.db)
 *   OMEGA_PROXY   "1" se houver um proxy com HTTPS na frente
 */

const path = require('node:path');
const { abrirBanco } = require('./banco.js');
const { criarApp } = require('./app.js');

const porta = Number(process.env.PORT) || 3000;
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const arquivo = process.env.OMEGA_BANCO || path.join(__dirname, '..', 'dados', 'omega.db');

const banco = abrirBanco(arquivo);
const servidor = criarApp({ banco, proxy: process.env.OMEGA_PROXY === '1' });

servidor.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `A porta ${porta} já está em uso. Defina outra em PORT.` : e);
  process.exit(1);
});

servidor.listen(porta, host, () => {
  console.log(`O.M.E.G.A. no ar: http://${host === '0.0.0.0' || host === '127.0.0.1' ? 'localhost' : host}:${porta}`);
  console.log(`Banco: ${arquivo}`);
});

function desligar() {
  servidor.close(() => { banco.fechar(); process.exit(0); });
  servidor.closeIdleConnections();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', desligar);
process.on('SIGTERM', desligar);
