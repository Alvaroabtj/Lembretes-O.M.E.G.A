/* O.M.E.G.A. — conta e sincronização com o servidor.
 * Sem servidor (arquivo aberto direto ou hospedagem estática) o site segue funcionando só neste aparelho. */
(function (raiz) {
  'use strict';

  const B = raiz.OmegaBanco;
  const LOTE = 200;
  const estado = { servidor: false, usuario: null, situacao: 'local', pendentes: 0 };
  let avisar = () => {};
  let aoReceber = async () => {};
  let ajustar = () => {};
  let correndo = null;
  let deNovo = false;
  let relogio;
  let espera = 0;

  class Falha extends Error {
    constructor(status, mensagem) { super(mensagem); this.status = status; }
  }

  async function pedir(metodo, caminho, corpo) {
    let r;
    try {
      r = await fetch(new URL(caminho.replace(/^\//, ''), document.baseURI), {
        method: metodo, credentials: 'same-origin',
        headers: corpo === undefined ? {} : { 'Content-Type': 'application/json' },
        body: corpo === undefined ? undefined : JSON.stringify(corpo)
      });
    } catch { throw new Falha(0, 'Sem conexão com o servidor. Confira a internet e tente de novo.'); }
    let dados = null;
    try { dados = await r.json(); } catch { /* resposta sem corpo */ }
    if (!r.ok) throw new Falha(r.status, (dados && dados.erro) || 'O servidor não respondeu como esperado.');
    return dados;
  }

  function mudar(situacao) {
    estado.situacao = situacao;
    avisar(estado);
  }

  async function iniciar(opcoes) {
    ({ avisar, aoReceber, ajustar } = opcoes);
    const guardada = await B.lerMeta('conta');
    if (guardada) { estado.usuario = guardada; B.ligarFila(true); estado.pendentes = await B.contarPendencias(); }
    if (!/^https?:$/.test(location.protocol)) return mudar('local');
    try {
      const d = await pedir('GET', 'api/sessao');
      if (!d || d.servidor !== 'omega') return mudar('local');
      estado.servidor = true;
      if (d.usuario && guardada && guardada.id !== d.usuario.id) {
        /* Sessão de outra conta neste navegador: não mistura os lembretes das duas. */
        estado.usuario = guardada;
        return mudar('expirada');
      }
      if (d.usuario) await assumir(d.usuario);
      else mudar(guardada ? 'expirada' : 'fora');
    } catch (e) {
      /* 404 significa hospedagem sem servidor; outros erros são falha passageira de quem já tem conta. */
      mudar(guardada ? 'semRede' : 'local');
      if (guardada && e.status !== 404) { estado.servidor = true; agendar(15000); }
    }
  }

  async function assumir(usuario) {
    const anterior = await B.lerMeta('conta');
    estado.servidor = true;
    estado.usuario = usuario;
    B.ligarFila(true);
    if (!anterior || anterior.id !== usuario.id) {
      await B.gravarMeta('rev', 0);
      await B.enfileirarTudo();
    }
    await B.gravarMeta('conta', usuario);
    mudar('sincronizando');
    await sincronizar();
  }

  /* Conta anterior deste aparelho, se for outra. A tela pergunta antes de trocar. */
  async function contaAnterior(email) {
    const a = await B.lerMeta('conta');
    return a && a.email !== email.trim().toLowerCase() ? a : null;
  }

  async function entrar({ email, senha }, trocando) {
    const d = await pedir('POST', 'api/sessao', { email, senha });
    if (trocando) await B.esvaziar();
    await assumir(d.usuario);
  }

  async function criar({ nome, email, senha }, trocando) {
    const d = await pedir('POST', 'api/conta', { nome, email, senha });
    if (trocando) await B.esvaziar();
    await assumir(d.usuario);
  }

  async function desligar() {
    clearTimeout(relogio);
    B.ligarFila(false);
    await B.esvaziar();
    estado.usuario = null;
    estado.pendentes = 0;
    mudar('fora');
  }

  async function sair() {
    await pedir('DELETE', 'api/sessao');
    await desligar();
  }

  async function editar(campos) {
    const d = await pedir('PATCH', 'api/conta', campos);
    await guardarUsuario(d.usuario);
  }

  async function excluir(senha) {
    await pedir('DELETE', 'api/conta', { senha });
    await desligar();
  }

  async function guardarUsuario(u) {
    estado.usuario = u;
    await B.gravarMeta('conta', u);
    avisar(estado);
  }

  async function ligarAgenda() {
    const d = await pedir('POST', 'api/agenda', {});
    await guardarUsuario({ ...estado.usuario, agenda: d.agenda });
  }

  async function desligarAgenda() {
    await pedir('DELETE', 'api/agenda');
    await guardarUsuario({ ...estado.usuario, agenda: '' });
  }

  /* ---------- Sincronização ---------- */

  function agendar(ms) {
    clearTimeout(relogio);
    if (estado.usuario && estado.servidor) relogio = setTimeout(sincronizar, ms);
  }

  async function sincronizar() {
    if (!estado.usuario || !estado.servidor || estado.situacao === 'expirada') return;
    if (correndo) { deNovo = true; return correndo; }
    clearTimeout(relogio);
    correndo = rodada().finally(() => {
      correndo = null;
      if (deNovo) { deNovo = false; agendar(50); }
    });
    return correndo;
  }

  async function rodada() {
    const dono = estado.usuario.id;
    mudar('sincronizando');
    try {
      let chegou = false;
      let mais = true;
      for (let voltas = 0; mais && voltas < 200; voltas++) {
        const { prontas, restam } = await B.pendencias(LOTE);
        const d = await pedir('POST', 'api/sincronizar', { desde: (await B.lerMeta('rev')) || 0, mudancas: prontas });
        if (!estado.usuario || estado.usuario.id !== dono) return; // saiu no meio do caminho
        await B.receber({ enviadas: prontas, chegadas: d.mudancas, rev: d.rev, ajustar });
        chegou = chegou || d.mudancas.length > 0;
        mais = d.haMais || restam > 0;
      }
      espera = 0;
      estado.pendentes = await B.contarPendencias();
      if (chegou) await aoReceber();
      mudar('emDia');
      agendar(60000);
    } catch (e) {
      estado.pendentes = await B.contarPendencias().catch(() => estado.pendentes);
      if (e.status === 401) return mudar('expirada');
      console.warn('Sincronização:', e.message);
      mudar(e.status === 0 ? 'semRede' : 'falhou');
      espera = Math.min((espera || 5000) * 2, 300000);
      agendar(espera);
    }
  }

  /* Chamado a cada alteração local; junta várias em um envio só. */
  async function alterou() {
    if (!estado.usuario) return;
    estado.pendentes = await B.contarPendencias();
    avisar(estado);
    agendar(800);
  }

  raiz.addEventListener('online', () => sincronizar());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sincronizar(); });

  raiz.OmegaConta = {
    estado, iniciar, contaAnterior, entrar, criar, sair, desligar, editar, excluir, ligarAgenda, desligarAgenda, sincronizar, alterou
  };
})(window);
