'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { abrirBanco } = require('../servidor/banco.js');
const { criarApp } = require('../servidor/app.js');

let base, servidor, banco;

test.before(async () => {
  banco = abrirBanco(':memory:');
  servidor = criarApp({ banco, aoErrar: e => { throw e; } });
  await new Promise(ok => servidor.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
test.after(() => { servidor.close(); servidor.closeAllConnections(); banco.fechar(); });

/* Um "aparelho" com seu próprio cookie. */
function aparelho() {
  let cookie = '';
  return async (metodo, caminho, corpo, extra = {}) => {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: { ...(cookie ? { cookie } : {}), ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
      body: corpo === undefined ? undefined : JSON.stringify(corpo)
    });
    const novo = r.headers.get('set-cookie');
    if (novo) cookie = novo.split(';')[0];
    const t = await r.text();
    let json = null;
    try { json = JSON.parse(t); } catch { /* não é JSON */ }
    return { status: r.status, json, texto: t, cab: r.headers, cookieCru: novo };
  };
}

let n = 0;
async function contaNova(senha = 'senha-de-teste') {
  const a = aparelho();
  const email = `pessoa${++n}@exemplo.test`;
  banco.s.criarUsuario.run(`u${n}`, email, 'Pessoa', await require('../servidor/seguranca.js').gerarHash(senha), Date.now());
  const r = await a('POST', '/api/sessao', { email, senha });
  assert.equal(r.status, 200);
  return { a, email, senha };
}

const lembrete = (id, title, alterado, mais = {}) =>
  ({ tipo: 'lembrete', id, alterado, apagado: false, dados: { id, title, ...mais } });

test('criar conta, sair e entrar', async () => {
  const a = aparelho();
  assert.equal((await a('GET', '/api/sessao')).json.usuario, null);
  const c = await a('POST', '/api/conta', { nome: '  Ana  Souza ', email: 'ANA@Exemplo.test', senha: 'uma-senha-boa' });
  assert.equal(c.status, 201);
  assert.deepEqual([c.json.usuario.nome, c.json.usuario.email], ['Ana Souza', 'ana@exemplo.test']);
  assert.match(c.cookieCru, /HttpOnly/);
  assert.match(c.cookieCru, /SameSite=Strict/);
  assert.equal(c.json.usuario.senha, undefined);
  assert.equal((await a('GET', '/api/sessao')).json.usuario.nome, 'Ana Souza');
  assert.equal((await a('DELETE', '/api/sessao')).status, 204);
  assert.equal((await a('GET', '/api/sessao')).json.usuario, null);
  assert.equal((await a('POST', '/api/sessao', { email: 'ana@exemplo.test', senha: 'errada-errada' })).status, 401);
  assert.equal((await a('POST', '/api/sessao', { email: 'ana@exemplo.test', senha: 'uma-senha-boa' })).status, 200);
  assert.equal((await a('POST', '/api/conta', { nome: 'X', email: 'ana@exemplo.test', senha: 'uma-senha-boa' })).status, 409);
});

test('senha fica protegida no banco e a sessão é guardada só como resumo', async () => {
  const { email, senha } = await contaNova();
  const u = banco.s.porEmail.get(email);
  assert.match(u.senha, /^scrypt\$/);
  assert.ok(!u.senha.includes(senha));
});

test('recusa dados ruins', async () => {
  const a = aparelho();
  for (const d of [{}, { nome: 'A', email: 'x', senha: '12345678' }, { nome: 'A', email: 'a@b.co', senha: 'curta' }, { nome: ' ', email: 'a@b.co', senha: '12345678' }]) {
    assert.equal((await a('POST', '/api/conta', d)).status, 400);
  }
  const r = await fetch(base + '/api/sessao', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{quebrado' });
  assert.equal(r.status, 400);
  const semTipo = await fetch(base + '/api/sessao', { method: 'POST', body: '{}' });
  assert.equal(semTipo.status, 415);
});

test('sem entrar, nada de lembretes', async () => {
  const a = aparelho();
  assert.equal((await a('POST', '/api/sincronizar', { desde: 0, mudancas: [] })).status, 401);
  assert.equal((await a('POST', '/api/agenda', {})).status, 401);
});

test('pedido vindo de outro site é recusado', async () => {
  const { a } = await contaNova();
  assert.equal((await a('POST', '/api/sincronizar', { desde: 0, mudancas: [] }, { origin: 'https://outro.test' })).status, 403);
  assert.equal((await a('POST', '/api/sincronizar', { desde: 0, mudancas: [] }, { origin: 'null' })).status, 403);
  assert.equal((await a('POST', '/api/sincronizar', { desde: 0, mudancas: [] }, { origin: base })).status, 200);
});

test('dois aparelhos trocam lembretes e listas', async () => {
  const { a, email, senha } = await contaNova();
  const b = aparelho();
  await b('POST', '/api/sessao', { email, senha });
  const t = Date.now() - 10000;
  const r1 = await a('POST', '/api/sincronizar', {
    desde: 0, mudancas: [lembrete('1', 'Do A', t), { tipo: 'lista', id: 'l1', alterado: t, dados: { nome: 'Casa', cor: 3 } }]
  });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.json.mudancas, [], 'não devolve o que o próprio aparelho acabou de mandar');

  const r2 = await b('POST', '/api/sincronizar', { desde: 0, mudancas: [lembrete('2', 'Do B', t)] });
  assert.deepEqual(r2.json.mudancas.map(m => m.id).sort(), ['1', 'l1']);
  assert.equal(r2.json.mudancas.find(m => m.id === 'l1').dados.cor, 3);

  const r3 = await a('POST', '/api/sincronizar', { desde: r1.json.rev, mudancas: [] });
  assert.deepEqual(r3.json.mudancas.map(m => m.dados.title), ['Do B']);
  const r4 = await a('POST', '/api/sincronizar', { desde: r3.json.rev, mudancas: [] });
  assert.deepEqual(r4.json.mudancas, []);
});

test('conflito: vence a alteração mais recente e quem perdeu recebe a versão certa', async () => {
  const { a, email, senha } = await contaNova();
  const b = aparelho();
  await b('POST', '/api/sessao', { email, senha });
  const t = Date.now() - 10000;
  await a('POST', '/api/sincronizar', { desde: 0, mudancas: [lembrete('1', 'Novo', t + 500)] });
  const r = await b('POST', '/api/sincronizar', { desde: 999, mudancas: [lembrete('1', 'Antigo', t)] });
  assert.equal(r.json.mudancas[0].dados.title, 'Novo');
  const d = await b('POST', '/api/sincronizar', { desde: r.json.rev, mudancas: [{ tipo: 'lembrete', id: '1', alterado: t + 900, apagado: true }] });
  assert.equal(d.status, 200);
  const fim = await a('POST', '/api/sincronizar', { desde: r.json.rev, mudancas: [] });
  assert.deepEqual([fim.json.mudancas[0].apagado, fim.json.mudancas[0].dados], [true, null]);
});

test('relógio adiantado não ganha para sempre', async () => {
  const { a } = await contaNova();
  await a('POST', '/api/sincronizar', { desde: 0, mudancas: [lembrete('1', 'Do futuro', Date.now() + 9e11)] });
  const r = await a('POST', '/api/sincronizar', { desde: 0, mudancas: [] });
  assert.ok(r.json.mudancas[0].alterado <= Date.now() + 5 * 60000);
});

test('uma conta não enxerga a outra', async () => {
  const { a } = await contaNova();
  const { a: b } = await contaNova();
  await a('POST', '/api/sincronizar', { desde: 0, mudancas: [lembrete('segredo', 'Meu', Date.now())] });
  const r = await b('POST', '/api/sincronizar', { desde: 0, mudancas: [lembrete('segredo', 'Outro', Date.now() - 5000)] });
  assert.deepEqual(r.json.mudancas, []);
  const volta = await a('POST', '/api/sincronizar', { desde: 0, mudancas: [] });
  assert.equal(volta.json.mudancas[0].dados.title, 'Meu');
});

test('mudança inválida recusa o lote inteiro', async () => {
  const { a } = await contaNova();
  const ruins = [{ tipo: 'outro', id: '1', alterado: 1 }, lembrete('', 'x', 1), lembrete('1', '', 1), { tipo: 'lista', id: 'l', alterado: 1, dados: {} }, null, lembrete('1', 'x', 'agora')];
  for (const m of ruins) {
    assert.equal((await a('POST', '/api/sincronizar', { desde: 0, mudancas: [lembrete('bom', 'ok', Date.now()), m] })).status, 400);
  }
  assert.deepEqual((await a('POST', '/api/sincronizar', { desde: 0, mudancas: [] })).json.mudancas, []);
  const muitas = Array.from({ length: 501 }, (_, i) => lembrete('m' + i, 'x', 1));
  assert.equal((await a('POST', '/api/sincronizar', { desde: 0, mudancas: muitas })).status, 413);
});

test('muitos itens chegam em páginas, sem perder nenhum', async () => {
  const { a } = await contaNova();
  for (let l = 0; l < 5; l++) {
    const lote = Array.from({ length: 450 }, (_, i) => lembrete(`i${l}-${i}`, 'x', Date.now()));
    assert.equal((await a('POST', '/api/sincronizar', { desde: 1e9, mudancas: lote })).status, 200);
  }
  const vistos = new Set();
  let desde = 0, haMais = true, voltas = 0;
  while (haMais && voltas++ < 10) {
    const r = await a('POST', '/api/sincronizar', { desde, mudancas: [] });
    r.json.mudancas.forEach(m => vistos.add(m.id));
    ({ rev: desde, haMais } = r.json);
  }
  assert.equal(vistos.size, 2250);
});

test('trocar a senha encerra as sessões dos outros aparelhos', async () => {
  const { a, email, senha } = await contaNova();
  const b = aparelho();
  await b('POST', '/api/sessao', { email, senha });
  assert.equal((await a('PATCH', '/api/conta', { senhaAtual: 'errada-errada', novaSenha: 'outra-senha-boa' })).status, 403);
  assert.equal((await a('PATCH', '/api/conta', { senhaAtual: senha, novaSenha: 'outra-senha-boa', nome: 'Novo Nome' })).json.usuario.nome, 'Novo Nome');
  assert.equal((await b('GET', '/api/sessao')).json.usuario, null);
  assert.equal((await a('GET', '/api/sessao')).json.usuario.nome, 'Novo Nome');
});

test('excluir a conta apaga tudo', async () => {
  const { a, email, senha } = await contaNova();
  await a('POST', '/api/sincronizar', { desde: 0, mudancas: [lembrete('1', 'x', Date.now())] });
  const id = banco.s.porEmail.get(email).id;
  assert.equal((await a('DELETE', '/api/conta', { senha: 'errada-errada' })).status, 403);
  assert.equal((await a('DELETE', '/api/conta', { senha })).status, 204);
  assert.equal(banco.s.porEmail.get(email), undefined);
  assert.equal(banco.s.contar.get(id).n, 0);
});

test('link da agenda só funciona enquanto estiver ativo', async () => {
  const { a } = await contaNova();
  await a('POST', '/api/sincronizar', {
    desde: 0, mudancas: [lembrete('1', 'Dentista', Date.now(), { date: '2030-05-10', time: '10:00' }), lembrete('2', 'Sem data', Date.now()), lembrete('3', 'Feito', Date.now(), { date: '2030-05-10', done: true })]
  });
  const { agenda } = (await a('POST', '/api/agenda', {})).json;
  const r = await fetch(base + agenda);
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  const ics = await r.text();
  assert.match(ics, /SUMMARY:Dentista/);
  assert.doesNotMatch(ics, /Sem data|Feito/);
  await a('DELETE', '/api/agenda');
  assert.equal((await fetch(base + agenda)).status, 404);
});

test('muitas senhas erradas travam a conta por um tempo', async () => {
  const { email } = await contaNova();
  const x = aparelho();
  let ultimo;
  for (let i = 0; i < 11; i++) ultimo = await x('POST', '/api/sessao', { email, senha: 'errada-errada' });
  assert.equal(ultimo.status, 429);
  assert.ok(Number(ultimo.cab.get('retry-after')) > 0);
});

test('arquivos: entrega o site e esconde o resto', async () => {
  const pegar = caminho => new Promise((ok, erro) => {
    const { port } = servidor.address();
    http.get({ host: '127.0.0.1', port, path: caminho }, r => { r.resume(); ok(r); }).on('error', erro);
  });
  const inicio = await pegar('/');
  assert.equal(inicio.statusCode, 200);
  assert.match(inicio.headers['content-security-policy'], /script-src 'self'/);
  assert.equal((await pegar('/icons/omega-64.png')).statusCode, 200);
  for (const c of ['/package.json', '/servidor/app.js', '/dados/omega.db', '/../package.json', '/js/../servidor/app.js', '/js/..%2fservidor%2fapp.js', '/js/%2e%2e/package.json', '/.git/config', '/js/', '/icons/..%5c..%5cpackage.json', '/%']) {
    assert.ok([400, 404].includes((await pegar(c)).statusCode), c);
  }
  assert.equal((await pegar('/icons/nucleo.jpg')).headers['content-type'], 'image/jpeg');
  const b = await pegar('/icons/omega-64.png');
  assert.ok(b.headers.etag);
});
