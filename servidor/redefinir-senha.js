'use strict';

/* Uso: npm run redefinir-senha -- pessoa@exemplo.com
 * Gera uma senha provisória e encerra as sessões da conta. */

const path = require('node:path');
const crypto = require('node:crypto');
const { abrirBanco } = require('./banco.js');
const { gerarHash } = require('./seguranca.js');

(async () => {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) { console.error('Informe o e-mail da conta.'); process.exit(1); }
  const banco = abrirBanco(process.env.OMEGA_BANCO || path.join(__dirname, '..', 'dados', 'omega.db'));
  const u = banco.s.porEmail.get(email);
  if (!u) { console.error('Nenhuma conta com esse e-mail.'); process.exit(1); }
  const senha = crypto.randomBytes(9).toString('base64url');
  banco.s.trocarSenha.run(await gerarHash(senha), u.id);
  banco.s.apagarSessoes.run(u.id);
  banco.fechar();
  console.log(`Senha provisória: ${senha}\nTroque-a em Ajustes > Conta depois de entrar.`);
})();
