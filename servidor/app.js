'use strict';

/* Servidor HTTP: entrega o site e responde à API. */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizar, gerarIcs } = require('../js/dados.js');
const { gerarHash, conferirHash, hashIsca, novoToken, resumo, criarLimite } = require('./seguranca.js');

const RAIZ = path.join(__dirname, '..');
const COOKIE = 'omega_sessao';
const DURACAO = 60 * 24 * 3600; // 60 dias, em segundos
const CORPO_MAXIMO = 2 * 1024 * 1024;
const MUDANCAS_MAXIMO = 500;
const PAGINA = 1000;

/* Só estes caminhos do projeto são públicos. O código do servidor e o banco nunca são servidos. */
const PASTAS_PUBLICAS = ['css', 'js', 'icons'];
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'
};

const CABECALHOS = {
  'Content-Security-Policy': [
    "default-src 'none'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
    "form-action 'self'", "base-uri 'none'", "frame-ancestors 'none'"
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

class Erro extends Error {
  constructor(status, mensagem, cabecalhos) {
    super(mensagem);
    this.status = status;
    this.cabecalhos = cabecalhos || {};
  }
}

function criarApp({ banco, proxy = false, aoErrar = console.error }) {
  const { s } = banco;
  const limites = {
    entrarIp: criarLimite({ maximo: 40, janela: 15 * 60000 }),
    entrarConta: criarLimite({ maximo: 10, janela: 15 * 60000 }),
    criar: criarLimite({ maximo: 10, janela: 60 * 60000 }),
    senha: criarLimite({ maximo: 10, janela: 15 * 60000 })
  };

  /* ---------- Pedido e resposta ---------- */

  /* Atrás de um proxy confiável, o último endereço é o que ele mesmo anotou. */
  const ipDe = req => (proxy && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress;
  const ehHttps = req => !!req.socket.encrypted || (proxy && req.headers['x-forwarded-proto'] === 'https');

  function enviar(res, status, dados, cabecalhos) {
    const corpo = dados === undefined ? '' : JSON.stringify(dados);
    res.writeHead(status, {
      ...CABECALHOS, 'Cache-Control': 'no-store',
      ...(corpo ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...cabecalhos
    });
    res.end(corpo);
  }

  function lerJson(req) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new Erro(415, 'Envie os dados em JSON.');
    return new Promise((ok, falha) => {
      const partes = [];
      let tamanho = 0;
      req.on('data', p => {
        tamanho += p.length;
        if (tamanho > CORPO_MAXIMO) { req.pause(); return falha(new Erro(413, 'Dados grandes demais.', { Connection: 'close' })); }
        partes.push(p);
      });
      req.on('end', () => {
        try {
          const v = JSON.parse(Buffer.concat(partes).toString('utf8'));
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
          ok(v);
        } catch { falha(new Erro(400, 'Não foi possível ler os dados enviados.')); }
      });
      req.on('error', falha);
    });
  }

  /* Pedidos que alteram algo precisam vir do próprio site. */
  function conferirOrigem(req) {
    const origem = req.headers.origin;
    if (!origem) return;
    let host = '';
    try { host = new URL(origem).host; } catch { /* origem "null" ou inválida */ }
    if (host !== req.headers.host) throw new Erro(403, 'Pedido de outro site recusado.');
  }

  /* ---------- Sessão ---------- */

  function tokenDe(req) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,100})`).exec(req.headers.cookie || '');
    return m && m[1];
  }

  function usuarioDe(req) {
    const token = tokenDe(req);
    return token ? s.sessao.get(resumo(token), Date.now()) : undefined;
  }

  function exigirUsuario(req) {
    const u = usuarioDe(req);
    if (!u) throw new Erro(401, 'Entre na sua conta para continuar.');
    return u;
  }

  const cookie = (req, valor, duracao) =>
    `${COOKIE}=${valor}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${duracao}${ehHttps(req) ? '; Secure' : ''}`;

  function abrirSessao(req, usuario) {
    const token = novoToken();
    const agora = Date.now();
    s.limparSessoes.run(agora);
    s.criarSessao.run(resumo(token), usuario, agora, agora + DURACAO * 1000);
    return { 'Set-Cookie': cookie(req, token, DURACAO) };
  }

  const publico = u => ({ id: u.id, nome: u.nome, email: u.email, agenda: u.agenda ? `/agenda/${u.agenda}.ics` : '' });

  /* ---------- Validação ---------- */

  function campoNome(v) {
    const nome = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
    if (!nome || nome.length > 60) throw new Erro(400, 'Informe um nome com até 60 letras.');
    return nome;
  }

  function campoEmail(v) {
    const email = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Erro(400, 'Informe um e-mail válido.');
    return email;
  }

  function campoSenha(v) {
    if (typeof v !== 'string' || v.length < 8) throw new Erro(400, 'A senha precisa ter pelo menos 8 caracteres.');
    if (v.length > 200) throw new Erro(400, 'A senha pode ter até 200 caracteres.');
    return v;
  }

  function limitar(limite, chave) {
    const espera = limite.tentar(chave);
    if (espera) throw new Erro(429, `Muitas tentativas. Tente de novo em ${Math.ceil(espera / 60)} min.`, { 'Retry-After': String(espera) });
  }

  async function exigirSenha(usuario, senha) {
    limitar(limites.senha, usuario.id);
    if (typeof senha !== 'string' || senha.length > 200 || !await conferirHash(senha, usuario.senha)) {
      throw new Erro(403, 'A senha atual não confere.');
    }
    limites.senha.zerar(usuario.id);
  }

  function normalizarLista(x) {
    const nome = typeof x?.nome === 'string' ? x.nome.trim().slice(0, 30) : '';
    return nome ? { id: x.id, nome, cor: Number.isInteger(x.cor) && x.cor >= 1 && x.cor <= 8 ? x.cor : 1 } : null;
  }

  function validarMudanca(m) {
    const tipo = m?.tipo;
    const id = m?.id;
    if ((tipo !== 'lembrete' && tipo !== 'lista') || typeof id !== 'string' || !id || id.length > 80) throw new Erro(400, 'Mudança inválida.');
    if (!Number.isFinite(m.alterado) || m.alterado <= 0) throw new Erro(400, 'Mudança sem data.');
    /* Relógio adiantado não pode ganhar todos os conflitos futuros. */
    const alterado = Math.min(Math.floor(m.alterado), Date.now() + 5 * 60000);
    if (m.apagado === true) return { tipo, id, alterado, apagado: true, dados: null };
    const dados = tipo === 'lembrete' ? normalizar({ ...m.dados, id }) : normalizarLista({ ...m.dados, id });
    if (!dados) throw new Erro(400, tipo === 'lembrete' ? 'Lembrete sem título.' : 'Lista sem nome.');
    if (tipo === 'lembrete') { dados.notifiedFor = ''; dados.updatedAt = alterado; }
    else dados.updatedAt = alterado;
    return { tipo, id, alterado, apagado: false, dados };
  }

  /* ---------- Rotas ---------- */

  const rotas = {
    'GET /api/saude': async () => [200, { ok: true }],

    'GET /api/sessao': async req => {
      const u = usuarioDe(req);
      return [200, { servidor: 'omega', usuario: u ? publico(u) : null }];
    },

    'POST /api/sessao': async req => {
      const d = await lerJson(req);
      limitar(limites.entrarIp, ipDe(req));
      const email = campoEmail(d.email);
      limitar(limites.entrarConta, email);
      const senha = typeof d.senha === 'string' ? d.senha.slice(0, 200) : '';
      const u = s.porEmail.get(email);
      const certa = await conferirHash(senha, u ? u.senha : await hashIsca());
      if (!u || !certa) throw new Erro(401, 'E-mail ou senha incorretos.');
      limites.entrarConta.zerar(email);
      return [200, { usuario: publico(u) }, abrirSessao(req, u.id)];
    },

    'DELETE /api/sessao': async req => {
      const token = tokenDe(req);
      if (token) s.apagarSessao.run(resumo(token));
      return [204, undefined, { 'Set-Cookie': cookie(req, '', 0) }];
    },

    'POST /api/conta': async req => {
      const d = await lerJson(req);
      const nome = campoNome(d.nome);
      const email = campoEmail(d.email);
      const senha = campoSenha(d.senha);
      limitar(limites.criar, ipDe(req));
      const hash = await gerarHash(senha);
      if (s.porEmail.get(email)) throw new Erro(409, 'Já existe uma conta com esse e-mail.');
      const id = crypto.randomUUID();
      s.criarUsuario.run(id, email, nome, hash, Date.now());
      return [201, { usuario: publico(s.porId.get(id)) }, abrirSessao(req, id)];
    },

    'PATCH /api/conta': async req => {
      const u = exigirUsuario(req);
      const d = await lerJson(req);
      const nome = d.nome === undefined ? null : campoNome(d.nome);
      const nova = d.novaSenha === undefined ? null : campoSenha(d.novaSenha);
      let cabecalhos;
      if (nova) {
        await exigirSenha(u, d.senhaAtual);
        const hash = await gerarHash(nova);
        s.trocarSenha.run(hash, u.id);
        /* Senha nova encerra as sessões dos outros aparelhos. */
        s.apagarSessoes.run(u.id);
        cabecalhos = abrirSessao(req, u.id);
      }
      if (nome) s.trocarNome.run(nome, u.id);
      return [200, { usuario: publico(s.porId.get(u.id)) }, cabecalhos];
    },

    'DELETE /api/conta': async req => {
      const u = exigirUsuario(req);
      const d = await lerJson(req);
      await exigirSenha(u, d.senha);
      s.apagarUsuario.run(u.id);
      return [204, undefined, { 'Set-Cookie': cookie(req, '', 0) }];
    },

    'POST /api/sincronizar': async req => {
      const u = exigirUsuario(req);
      const d = await lerJson(req);
      const desde = Number.isInteger(d.desde) && d.desde >= 0 ? d.desde : 0;
      const lista = Array.isArray(d.mudancas) ? d.mudancas : [];
      if (lista.length > MUDANCAS_MAXIMO) throw new Erro(413, `Envie até ${MUDANCAS_MAXIMO} mudanças por vez.`);
      const mudancas = lista.map(validarMudanca);
      try {
        return [200, banco.sincronizar(u.id, desde, mudancas, PAGINA)];
      } catch (e) {
        if (e.limite) throw new Erro(413, `A conta chegou ao limite de ${e.limite} itens. Apague os concluídos para continuar.`);
        throw e;
      }
    },

    'POST /api/agenda': async req => {
      const u = exigirUsuario(req);
      const token = novoToken();
      s.trocarAgenda.run(token, u.id);
      return [200, { agenda: `/agenda/${token}.ics` }];
    },

    'DELETE /api/agenda': async req => {
      const u = exigirUsuario(req);
      s.trocarAgenda.run(null, u.id);
      return [204];
    }
  };

  function agenda(res, token, soCabecalho) {
    const u = s.porAgenda.get(token);
    if (!u) throw new Erro(404, 'Agenda não encontrada.');
    const itens = banco.lembretesDe(u.id).map(normalizar).filter(i => i && !i.done && i.date);
    res.writeHead(200, {
      ...CABECALHOS, 'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="omega.ics"', 'Cache-Control': 'private, max-age=300'
    });
    res.end(soCabecalho ? '' : gerarIcs(itens));
  }

  function arquivo(req, res, caminho) {
    const rel = caminho === '/' ? 'index.html' : caminho.slice(1);
    const partes = rel.split('/');
    const permitido = rel === 'index.html' ||
      (partes.length === 2 && PASTAS_PUBLICAS.includes(partes[0]) && /^[\w][\w.-]*$/.test(partes[1]) && TIPOS[path.extname(partes[1])]);
    if (!permitido) throw new Erro(404, 'Página não encontrada.');
    const cheio = path.join(RAIZ, ...partes);
    let info;
    try { info = fs.statSync(cheio); } catch { throw new Erro(404, 'Página não encontrada.'); }
    if (!info.isFile()) throw new Erro(404, 'Página não encontrada.');
    const etag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
    const cab = { ...CABECALHOS, 'Content-Type': TIPOS[path.extname(cheio)], ETag: etag, 'Cache-Control': 'no-cache' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, cab); return res.end(); }
    res.writeHead(200, { ...cab, 'Content-Length': info.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(cheio).on('error', () => res.destroy()).pipe(res);
  }

  return http.createServer(async (req, res) => {
    try {
      const leitura = req.method === 'GET' || req.method === 'HEAD';
      let caminho;
      try { caminho = decodeURIComponent(new URL(req.url, 'http://omega').pathname); } catch { throw new Erro(400, 'Endereço inválido.'); }
      if (caminho.startsWith('/api/')) {
        if (!leitura) conferirOrigem(req);
        const rota = rotas[`${req.method} ${caminho}`];
        if (!rota) throw new Erro(404, 'Recurso não encontrado.');
        return enviar(res, ...await rota(req));
      }
      if (!leitura) throw new Erro(405, 'Método não permitido.', { Allow: 'GET, HEAD' });
      const m = /^\/agenda\/([A-Za-z0-9_-]{40,50})\.ics$/.exec(caminho);
      if (m) return agenda(res, m[1], req.method === 'HEAD');
      return arquivo(req, res, caminho);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      if (e instanceof Erro) return enviar(res, e.status, { erro: e.message }, e.cabecalhos);
      aoErrar(e);
      enviar(res, 500, { erro: 'Algo falhou no servidor. Tente de novo.' });
    }
  });
}

module.exports = { criarApp };
