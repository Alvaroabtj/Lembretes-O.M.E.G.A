/* O.M.E.G.A. — banco local do navegador. Guarda tudo no aparelho e a fila do que falta sincronizar. */
(function (raiz) {
  'use strict';

  const { normalizar } = raiz.OmegaDados;
  const NOME = 'omega-reminders-db'; // mesmo banco da versão 1: os lembretes antigos continuam aqui
  const VERSAO = 2;
  const LOJAS = { lembrete: 'reminders', lista: 'lists' };
  let db;
  let filaLigada = false;

  function abrir() {
    return new Promise((ok, erro) => {
      const r = indexedDB.open(NOME, VERSAO);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('reminders')) d.createObjectStore('reminders', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
        if (!d.objectStoreNames.contains('lists')) d.createObjectStore('lists', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'chave' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'chave' });
      };
      r.onsuccess = () => { db = r.result; db.onversionchange = () => db.close(); ok(); };
      r.onerror = () => erro(r.error);
      r.onblocked = () => erro(new Error('O banco está em uso por uma aba antiga'));
    });
  }

  const pedido = r => new Promise((ok, erro) => { r.onsuccess = () => ok(r.result); r.onerror = () => erro(r.error); });
  const fim = t => new Promise((ok, erro) => { t.oncomplete = () => ok(); t.onerror = t.onabort = () => erro(t.error || new Error('Falha ao gravar')); });

  async function tudo() {
    const t = db.transaction(['reminders', 'lists']);
    const [itens, listas] = await Promise.all([pedido(t.objectStore('reminders').getAll()), pedido(t.objectStore('lists').getAll())]);
    return { itens: itens.map(normalizar).filter(Boolean), listas };
  }

  function normalizarLista(x) {
    if (!x || typeof x.id !== 'string' || !x.id || typeof x.nome !== 'string' || !x.nome.trim()) return null;
    return { id: x.id.slice(0, 80), nome: x.nome.trim().slice(0, 30), cor: Number.isInteger(x.cor) && x.cor >= 1 && x.cor <= 8 ? x.cor : 1, updatedAt: Number.isFinite(x.updatedAt) ? x.updatedAt : Date.now() };
  }

  /* Uma transação só: lembretes, listas e fila mudam juntos ou não mudam. */
  function aplicar({ gravar = [], apagar = [], listas = [], apagarListas = [] }) {
    const t = db.transaction(['reminders', 'lists', 'outbox'], 'readwrite');
    const fila = (tipo, id, apagado) => filaLigada && t.objectStore('outbox').put({ chave: `${tipo}:${id}`, tipo, id, apagado, alterado: Date.now() });
    apagar.forEach(id => { t.objectStore('reminders').delete(id); fila('lembrete', id, true); });
    gravar.forEach(x => { t.objectStore('reminders').put(x); fila('lembrete', x.id, false); });
    apagarListas.forEach(id => { t.objectStore('lists').delete(id); fila('lista', id, true); });
    listas.forEach(x => { t.objectStore('lists').put(x); fila('lista', x.id, false); });
    return fim(t);
  }

  /* Marca o aviso como dado neste aparelho. Devolve false se outra aba já avisou. */
  async function reivindicarAviso(id, chave) {
    const t = db.transaction('reminders', 'readwrite');
    const loja = t.objectStore('reminders');
    let meu = false;
    const r = loja.get(id);
    r.onsuccess = () => {
      const x = r.result;
      if (!x || x.done || x.notifiedFor === chave) return;
      meu = true;
      loja.put({ ...x, notifiedFor: chave });
    };
    await fim(t);
    return meu;
  }

  /* ---------- Sincronização ---------- */

  const ligarFila = v => { filaLigada = v; };
  const lerMeta = async chave => (await pedido(db.transaction('meta').objectStore('meta').get(chave)))?.valor;
  const gravarMeta = (chave, valor) => { const t = db.transaction('meta', 'readwrite'); t.objectStore('meta').put({ chave, valor }); return fim(t); };

  /* Ao entrar numa conta, tudo que já está no aparelho vai para a fila. */
  async function enfileirarTudo() {
    const t = db.transaction(['reminders', 'lists', 'outbox'], 'readwrite');
    const saida = t.objectStore('outbox');
    for (const [tipo, loja] of Object.entries(LOJAS)) {
      const r = t.objectStore(loja).getAll();
      r.onsuccess = () => r.result.forEach(x => saida.put({ chave: `${tipo}:${x.id}`, tipo, id: x.id, apagado: false, alterado: x.updatedAt || Date.now() }));
    }
    return fim(t);
  }

  async function pendencias(maximo) {
    const t = db.transaction(['reminders', 'lists', 'outbox']);
    const fila = await pedido(t.objectStore('outbox').getAll());
    const prontas = [];
    for (const f of fila.slice(0, maximo)) {
      const cru = f.apagado ? null : await pedido(t.objectStore(LOJAS[f.tipo]).get(f.id));
      const dados = f.tipo === 'lembrete' ? normalizar(cru) : normalizarLista(cru);
      prontas.push({ tipo: f.tipo, id: f.id, alterado: f.alterado, apagado: f.apagado || !dados, dados: f.apagado ? null : dados });
    }
    return { prontas, restam: fila.length - prontas.length };
  }

  async function contarPendencias() {
    return pedido(db.transaction('outbox').objectStore('outbox').count());
  }

  /* Tira da fila o que foi aceito, grava o que chegou e avança a revisão, tudo junto. */
  function receber({ enviadas, chegadas, rev, ajustar }) {
    const t = db.transaction(['reminders', 'lists', 'outbox', 'meta'], 'readwrite');
    const fila = t.objectStore('outbox');
    const recebidos = new Map(chegadas.map(m => [`${m.tipo}:${m.id}`, m]));
    const guardar = m => {
      const loja = t.objectStore(LOJAS[m.tipo]);
      if (m.apagado) return void loja.delete(m.id);
      if (m.tipo === 'lista') { const l = normalizarLista(m.dados); return void (l && loja.put(l)); }
      const novo = normalizar(m.dados);
      if (!novo) return;
      const r = loja.get(m.id);
      r.onsuccess = () => {
        if (r.result) novo.notifiedFor = r.result.notifiedFor || ''; // o aviso é de cada aparelho
        else ajustar(novo);
        loja.put(novo);
      };
    };
    enviadas.forEach(e => {
      const chave = `${e.tipo}:${e.id}`;
      const r = fila.get(chave);
      r.onsuccess = () => { if (r.result && r.result.alterado === e.alterado) fila.delete(chave); };
    });
    recebidos.forEach((m, chave) => {
      const r = fila.get(chave);
      /* Editado aqui depois de sincronizar: a versão local segue na fila e decide no próximo envio. */
      r.onsuccess = () => { if (!r.result || r.result.alterado < m.alterado) { fila.delete(chave); guardar(m); } };
    });
    t.objectStore('meta').put({ chave: 'rev', valor: rev });
    return fim(t);
  }

  function esvaziar() {
    const nomes = ['reminders', 'lists', 'outbox', 'meta'];
    const t = db.transaction(nomes, 'readwrite');
    nomes.forEach(n => t.objectStore(n).clear());
    return fim(t);
  }

  raiz.OmegaBanco = {
    abrir, tudo, aplicar, reivindicarAviso, normalizarLista, ligarFila, lerMeta, gravarMeta,
    enfileirarTudo, pendencias, contarPendencias, receber, esvaziar
  };
})(window);
