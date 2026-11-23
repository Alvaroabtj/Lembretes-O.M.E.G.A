/* O.M.E.G.A. — interface. */
(function () {
  'use strict';

  const D = window.OmegaDados;
  const B = window.OmegaBanco;
  const Conta = window.OmegaConta;
  const { interpretar, dobrar } = window.OmegaFrases;

  /* ---------- Utilidades de tela ---------- */

  const $ = id => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';

  function por(el, atributos, filhos) {
    for (const [k, v] of Object.entries(atributos || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    el.append(...filhos.flat(Infinity).filter(f => f !== null && f !== undefined && f !== false));
    return el;
  }
  const h = (tag, atributos, ...filhos) => por(document.createElement(tag), atributos, filhos);
  const s = (tag, atributos, ...filhos) => por(document.createElementNS(SVG, tag), atributos, filhos);
  const icone = nome => s('svg', { 'aria-hidden': 'true' }, s('use', { href: `#i-${nome}` }));
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const semMovimento = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const celular = () => matchMedia('(max-width: 860px)').matches;

  /* ---------- Estado ---------- */

  const cfg = { som: true, horaPadrao: '09:00', ordem: 'data', ultimoBackup: 0 };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem('omega-config') || '{}')); } catch { /* sem armazenamento */ }
  if (!D.horaValida(cfg.horaPadrao)) cfg.horaPadrao = '09:00';
  function salvarCfg() { try { localStorage.setItem('omega-config', JSON.stringify(cfg)); } catch { /* sem armazenamento */ } }

  const est = {
    itens: [], mapa: new Map(), listas: [],
    vista: 'hoje', lista: '', busca: '',
    dia: D.hoje(), mes: D.hoje().slice(0, 8) + '01',
    abertos: new Set(), ignorar: new Set()
  };

  const VISTAS = [
    ['hoje', 'Hoje'], ['proximos', 'Próximos'], ['calendario', 'Calendário'], ['todos', 'Todos'], ['concluidos', 'Concluídos']
  ];

  const listaDe = id => est.listas.find(l => l.id === id);

  async function carregar() {
    const { itens, listas } = await B.tudo();
    est.itens = itens;
    est.mapa = new Map(itens.map(i => [i.id, i]));
    est.listas = listas.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }

  const canal = 'BroadcastChannel' in window ? new BroadcastChannel('omega') : null;
  if (canal) canal.onmessage = async () => { await carregar(); desenhar(); };

  /* Toda alteração passa por aqui: grava, recarrega, redesenha e avisa as outras abas e o servidor. */
  async function mudar(m) {
    try {
      await B.aplicar(m);
    } catch (e) {
      console.error(e);
      toast('Não foi possível salvar. Confira se há espaço livre neste aparelho.');
      return false;
    }
    await carregar();
    desenhar();
    canal && canal.postMessage('mudou');
    Conta.alterou();
    return true;
  }

  const mexido = (item, campos) => ({ ...item, ...campos, updatedAt: Date.now() });

  /* Um aviso cujo momento já passou na hora de salvar não deve disparar logo em seguida. */
  function prepararAviso(item) {
    const t = D.momentoDoAviso(item, cfg.horaPadrao);
    item.notifiedFor = t && t <= Date.now() ? String(t) : '';
    return item;
  }

  /* ---------- Textos de data ---------- */

  const fmt = opcoes => new Intl.DateTimeFormat('pt-BR', opcoes);
  const fDiaMes = fmt({ day: 'numeric', month: 'short' });
  const fDiaMesAno = fmt({ day: 'numeric', month: 'short', year: 'numeric' });
  const fSemana = fmt({ weekday: 'long' });
  const fLongo = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
  const fMes = fmt({ month: 'long', year: 'numeric' });
  const maiuscula = t => t.charAt(0).toUpperCase() + t.slice(1);

  function rotuloDia(iso) {
    const dif = D.diasEntre(D.hoje(), iso);
    if (dif === 0) return 'Hoje';
    if (dif === 1) return 'Amanhã';
    if (dif === -1) return 'Ontem';
    const d = D.deIso(iso);
    if (dif > 1 && dif < 7) return maiuscula(fSemana.format(d));
    return (iso.slice(0, 4) === D.hoje().slice(0, 4) ? fDiaMes : fDiaMesAno).format(d).replace(/\./g, '');
  }
  const rotuloQuando = i => rotuloDia(i.date) + (i.time ? `, ${i.time}` : '');

  function duracao(min) {
    if (min < 60) return `${min} min`;
    const hs = Math.floor(min / 60), m = min % 60;
    return m && hs < 6 ? `${hs} h ${m} min` : `${hs} h`;
  }

  function atrasoDe(i) {
    const dias = D.diasEntre(i.date, D.hoje());
    if (dias > 0) return dias === 1 ? 'atrasado há 1 dia' : `atrasado há ${dias} dias`;
    return `passou há ${duracao(Math.max(1, Math.round((Date.now() - D.deIso(i.date, i.time)) / 60000)))}`;
  }

  /* ---------- Toast e confirmação ---------- */

  function toast(texto, desfazer) {
    const el = h('div', { class: 'toast' }, h('span', {}, texto));
    if (desfazer) el.append(h('button', { type: 'button', onclick: () => { el.remove(); desfazer(); } }, 'Desfazer'));
    const pilha = $('toasts');
    while (pilha.children.length > (celular() ? 0 : 1)) pilha.firstChild.remove();
    pilha.append(el);
    setTimeout(() => el.remove(), desfazer ? 7000 : 3500);
  }

  function confirmar({ titulo, texto, sim }) {
    const dlg = $('dlgConfirma');
    $('cfTitulo').textContent = titulo;
    $('cfTexto').textContent = texto;
    $('cfSim').textContent = sim;
    return new Promise(ok => {
      let resposta = false;
      $('cfSim').onclick = () => { resposta = true; dlg.close(); };
      $('cfNao').onclick = () => dlg.close();
      dlg.addEventListener('close', () => ok(resposta), { once: true });
      dlg.showModal();
      $('cfNao').focus();
    });
  }

  /* ---------- Ações nos lembretes ---------- */

  async function concluir(item) {
    const feito = mexido(item, { done: true, completedAt: Date.now(), snoozeUntil: 0 });
    let prox = null;
    if (item.repeat !== 'none' && !est.mapa.has(item.nextId)) {
      prox = D.proximaOcorrencia(item);
      if (est.mapa.has(prox.id)) prox.id = D.novoId();
      feito.nextId = prox.id;
      prepararAviso(prox);
    }
    fecharAviso(item.id);
    if (!await mudar({ gravar: prox ? [feito, prox] : [feito] })) return;
    toast(prox ? `Concluído. O próximo é ${rotuloQuando(prox).toLowerCase()}.` : 'Lembrete concluído.', () =>
      mudar({ gravar: [mexido(item, {})], apagar: prox ? [prox.id] : [] }));
  }

  async function reabrir(item) {
    if (await mudar({ gravar: [prepararAviso(mexido(item, { done: false, completedAt: 0 }))] })) {
      toast('Lembrete reaberto.', () => mudar({ gravar: [mexido(item, {})] }));
    }
  }

  async function apagar(itens, texto) {
    itens.forEach(i => fecharAviso(i.id));
    if (await mudar({ apagar: itens.map(i => i.id) })) {
      toast(texto || 'Lembrete excluído.', () => mudar({ gravar: itens.map(i => mexido(i, {})) }));
    }
  }

  async function reagendar(item, date, time) {
    fecharAviso(item.id);
    const novo = mexido(item, { date, time, snoozeUntil: 0 });
    if (!item.repeatDay && item.repeat === 'monthly') novo.repeatDay = D.deIso(item.date).getDate();
    if (await mudar({ gravar: [prepararAviso(novo)] })) {
      toast(`Reagendado para ${rotuloQuando(novo).toLowerCase()}.`, () => mudar({ gravar: [mexido(item, {})] }));
    }
  }

  async function adiar(item, min) {
    fecharAviso(item.id);
    await mudar({ gravar: [mexido(item, { snoozeUntil: Date.now() + min * 60000, notifiedFor: '' })] });
    toast(`Aviso de novo em ${duracao(min)}.`);
  }

  async function alternar(item) {
    if (item.done) return reabrir(item);
    const el = document.querySelector(`.item[data-id="${CSS.escape(item.id)}"]`);
    if (el && !semMovimento()) {
      el.classList.add('saindo');
      await new Promise(r => setTimeout(r, 240));
    }
    const atual = est.mapa.get(item.id);
    if (atual && !atual.done) await concluir(atual);
  }

  function alternarSub(item, id) {
    return mudar({ gravar: [mexido(item, { subtasks: item.subtasks.map(x => (x.id === id ? { ...x, done: !x.done } : x)) })] });
  }

  function duplicar(item) {
    const copia = prepararAviso(mexido(item, { id: D.novoId(), done: false, completedAt: 0, nextId: '', snoozeUntil: 0, createdAt: Date.now(), subtasks: item.subtasks.map(x => ({ ...x, id: D.novoId(), done: false })) }));
    return mudar({ gravar: [copia] }).then(ok => ok && toast('Lembrete duplicado.', () => mudar({ apagar: [copia.id] })));
  }

  function baixar(nome, tipo, conteudo) {
    const url = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
    const a = h('a', { href: url, download: nome });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ---------- Seleção e agrupamento ---------- */

  const PESO = { high: 0, medium: 1, low: 2 };
  const ORDENS = {
    data: (a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '99').localeCompare(b.time || '99') || PESO[a.priority] - PESO[b.priority],
    prioridade: (a, b) => PESO[a.priority] - PESO[b.priority] || ORDENS.data(a, b),
    nome: (a, b) => a.title.localeCompare(b.title, 'pt-BR'),
    criacao: (a, b) => b.createdAt - a.createdAt
  };
  const ordenar = l => l.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (ORDENS[cfg.ordem] || ORDENS.data)(a, b));

  function porData(itens) {
    const hoje = D.hoje();
    const g = { atraso: [], hoje: [], amanha: [], semana: [], depois: [], sem: [] };
    for (const i of itens) {
      if (!i.date) g.sem.push(i);
      else if (i.date < hoje) g.atraso.push(i);
      else {
        const d = D.diasEntre(hoje, i.date);
        (d === 0 ? g.hoje : d === 1 ? g.amanha : d < 7 ? g.semana : g.depois).push(i);
      }
    }
    return [
      ['Atrasados', g.atraso, 'atraso'], ['Hoje', g.hoje], ['Amanhã', g.amanha],
      ['Próximos 7 dias', g.semana], ['Mais adiante', g.depois], ['Sem data', g.sem]
    ];
  }

  function grupos() {
    const hoje = D.hoje();
    const pend = est.itens.filter(i => !i.done);
    if (est.busca) {
      const alvo = dobrar(est.busca.trim());
      const bate = i => dobrar([i.title, i.description, (listaDe(i.category) || {}).nome || '', ...i.subtasks.map(x => x.text)].join(' \n ')).includes(alvo);
      return [['Pendentes', pend.filter(bate)], ['Concluídos', est.itens.filter(i => i.done && bate(i))]];
    }
    switch (est.vista) {
      case 'hoje': {
        const semDataFixos = pend.filter(i => i.pinned && (!i.date || i.date > hoje));
        return [
          ['Fixados', semDataFixos],
          ['Atrasados', pend.filter(i => i.date && i.date < hoje), 'atraso'],
          ['Hoje', pend.filter(i => i.date === hoje)]
        ];
      }
      case 'proximos': {
        const m = new Map();
        for (const i of pend.filter(x => x.date > hoje).sort(ORDENS.data)) {
          const nome = D.diasEntre(hoje, i.date) < 7 ? rotuloDia(i.date) : maiuscula(fMes.format(D.deIso(i.date)).replace(' de ', ' '));
          if (!m.has(nome)) m.set(nome, []);
          m.get(nome).push(i);
        }
        return [...m];
      }
      case 'concluidos': {
        const m = new Map();
        for (const i of est.itens.filter(x => x.done).sort((a, b) => b.completedAt - a.completedAt)) {
          const dias = D.diasEntre(D.isoDe(new Date(i.completedAt)), hoje);
          const nome = dias <= 0 ? 'Hoje' : dias === 1 ? 'Ontem' : dias < 7 ? 'Últimos 7 dias' : 'Antes disso';
          if (!m.has(nome)) m.set(nome, []);
          m.get(nome).push(i);
        }
        return [...m].map(([n, l]) => [n, l, 'semOrdem']);
      }
      case 'lista': return porData(pend.filter(i => i.category === est.lista));
      default: return porData(pend);
    }
  }

  /* ---------- Desenho ---------- */

  function tituloVista() {
    if (est.busca) return `Busca por “${est.busca.trim()}”`;
    if (est.vista === 'lista') return (listaDe(est.lista) || {}).nome || 'Lista';
    return VISTAS.find(v => v[0] === est.vista)[1];
  }

  function desenhar() {
    if (est.vista === 'lista' && !listaDe(est.lista)) est.vista = 'todos';
    const foco = document.activeElement && document.activeElement.getAttribute('data-foco');
    desenharNav();
    desenharPainel();
    desenharCorpo();
    desenharLeitura();
    desenharConta();
    if (foco) {
      const el = document.querySelector(`[data-foco="${CSS.escape(foco)}"]`);
      el && el.focus({ preventScroll: true });
    }
    const n = contagens().urgentes;
    document.title = (n ? `(${n}) ` : '') + 'O.M.E.G.A.';
  }

  function contagens() {
    const hoje = D.hoje();
    const pend = est.itens.filter(i => !i.done);
    const atrasados = pend.filter(i => i.date && i.date < hoje).length;
    const doDia = pend.filter(i => i.date === hoje).length;
    return {
      pend, atrasados, doDia, urgentes: atrasados + doDia,
      hoje: atrasados + doDia, proximos: pend.filter(i => i.date > hoje).length, todos: pend.length
    };
  }

  function desenharNav() {
    const c = contagens();
    $('navVistas').replaceChildren(...VISTAS.map(([id, nome]) => h('button', {
      class: 'nav-item', type: 'button', 'data-foco': `nav-${id}`,
      'aria-current': est.vista === id && !est.busca ? 'page' : null, onclick: () => ir(id)
    }, icone(id), h('span', {}, nome), c[id] ? h('span', { class: `conta-n${id === 'hoje' && c.atrasados ? ' quente' : ''}` }, String(c[id])) : null)));

    $('navListas').replaceChildren(...(est.listas.length ? est.listas.map(l => {
      const n = c.pend.filter(i => i.category === l.id).length;
      return h('div', { class: 'linha-lista' },
        h('button', { class: `nav-item cor-${l.cor}`, type: 'button', 'data-foco': `lista-${l.id}`, 'aria-current': est.vista === 'lista' && est.lista === l.id && !est.busca ? 'page' : null, onclick: () => ir('lista', l.id) },
          h('i', { class: 'ponto' }), h('span', {}, l.nome), n ? h('span', { class: 'conta-n' }, String(n)) : null),
        h('button', { class: 'icone', type: 'button', 'aria-label': `Editar lista ${l.nome}`, title: 'Editar lista', onclick: () => abrirLista(l) }, icone('editar')));
    }) : [h('p', { class: 'vazio-curto' }, 'Crie listas ou escreva #nome no lembrete.')]));

    const itens = [['hoje', 'Hoje'], ['proximos', 'Próximos'], null, ['calendario', 'Calendário'], ['todos', 'Todos']];
    $('inferior').replaceChildren(...itens.map(x => x
      ? h('button', { type: 'button', 'data-foco': `inf-${x[0]}`, 'aria-current': est.vista === x[0] && !est.busca ? 'page' : null, onclick: () => ir(x[0]) }, icone(x[0]), x[1])
      : h('button', { class: 'adicionar', type: 'button', 'aria-label': 'Novo lembrete', onclick: () => abrirEditor() }, icone('mais'))));
  }

  function desenharPainel() {
    fecharCartao();
    const hoje = D.hoje();
    const naHoje = est.vista === 'hoje' && !est.busca;
    $('painel').classList.toggle('simples', !naHoje);
    $('dataHoje').hidden = !naHoje;
    $('proximo').hidden = true;
    $('tituloLista').textContent = naHoje ? 'Para hoje' : '';
    if (!naHoje) {
      $('titulo').textContent = tituloVista();
      const n = est.vista === 'calendario' && !est.busca ? 0 : grupos().reduce((t, g) => t + g[1].length, 0);
      $('resumo').textContent = est.vista === 'calendario' && !est.busca ? 'Escolha um dia para ver ou criar lembretes.' : n ? plural(n, 'lembrete', 'lembretes') : '';
      $('mostrador').replaceChildren();
      return;
    }
    const agora = new Date();
    const hora = agora.getHours();
    const nome = Conta.estado.usuario ? `, ${Conta.estado.usuario.nome.split(' ')[0]}` : '';
    $('dataHoje').textContent = maiuscula(fLongo.format(agora));
    $('titulo').textContent = (hora < 5 ? 'Boa noite' : hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite') + nome;

    const c = contagens();
    const feitos = est.itens.filter(i => i.done && D.isoDe(new Date(i.completedAt)) === hoje).length;
    const partes = [];
    if (c.doDia) partes.push(h('b', {}, plural(c.doDia, 'lembrete', 'lembretes')), ' para hoje');
    if (c.atrasados) partes.push(partes.length ? ' e ' : '', h('span', { class: 'quente' }, plural(c.atrasados, 'atrasado', 'atrasados')));
    if (!partes.length) partes.push(feitos ? 'Tudo pronto por hoje' : 'Nada marcado para hoje');
    partes.push('. ');
    if (feitos) partes.push(`${plural(feitos, 'concluído', 'concluídos')} até agora.`);
    $('resumo').replaceChildren(...partes);

    const agoraH = D.horaDe(agora);
    const prox = c.pend.filter(i => i.date && i.time && (i.date > hoje || (i.date === hoje && i.time >= agoraH))).sort(ORDENS.data)[0];
    if (prox) {
      const min = Math.round((D.deIso(prox.date, prox.time) - agora) / 60000);
      const quando = min < 1 ? 'agora' : min < 1440 ? `em ${duracao(min)}` : rotuloQuando(prox).toLowerCase();
      $('proximo').replaceChildren(
        h('small', {}, `A seguir, ${quando}`),
        h('button', { type: 'button', 'data-foco': 'proximo', onclick: () => abrirEditor(prox) }, `${prox.time}  ${prox.title}`));
      $('proximo').hidden = false;
    }
    desenharMostrador(agora, prox);
  }

  /* O anel da imagem vira um relógio de 24 h: meia-noite no topo, meio-dia embaixo. */
  function desenharMostrador(agora, prox) {
    const C = 565;
    const pos = (min, r) => { const a = min / 1440 * Math.PI * 2 - Math.PI / 2; return [C + Math.cos(a) * r, C + Math.sin(a) * r]; };
    const minutos = t => { const [x, y] = t.split(':').map(Number); return x * 60 + y; };
    const m = agora.getHours() * 60 + agora.getMinutes();
    const partes = [];

    const [ax, ay] = pos(0, 240), [bx, by] = pos(m, 240);
    if (m > 1) partes.push(s('path', { class: 'm-arco', d: `M${ax} ${ay}A240 240 0 ${m > 720 ? 1 : 0} 1 ${bx} ${by}` }));
    const [p1x, p1y] = pos(m, 138), [p2x, p2y] = pos(m, 300);
    partes.push(s('line', { class: 'm-agora', x1: p1x, y1: p1y, x2: p2x, y2: p2y }));
    [0, 6, 12, 18].forEach(x => { const [tx, ty] = pos(x * 60, 346); partes.push(s('text', { class: 'm-hora', x: tx, y: ty }, `${x}h`)); });

    const hoje = D.hoje();
    const doDia = est.itens.filter(i => i.date === hoje && i.time).sort((a, b) => a.time.localeCompare(b.time));
    /* Horários muito próximos vão para a órbita de dentro, para um nó não cobrir o outro. */
    const orbitas = [268, 212, 320];
    const ultimo = orbitas.map(() => -999);
    for (const i of doDia) {
      const t = minutos(i.time);
      let o = orbitas.findIndex((_, k) => t - ultimo[k] >= 36);
      if (o < 0) o = 0;
      ultimo[o] = t;
      const [x, y] = pos(t, orbitas[o]);
      const classe = i.done ? 'feito' : D.vencido(i, agora) ? 'vencido' : prox && prox.id === i.id ? 'seguinte' : '';
      const situacao = i.done ? 'concluído' : classe === 'vencido' ? 'passou do horário' : 'pendente';
      const abrir = () => (i.done ? abrirEditor(i) : destacar(i.id));
      partes.push(s('g', {
        class: `m-no ${classe}`, transform: `translate(${x} ${y})`, tabindex: '0', role: 'button', 'data-foco': `no-${i.id}`,
        'aria-label': `${i.time}, ${i.title}, ${situacao}`, onclick: () => { fecharCartao(); abrir(); },
        onpointerenter: e => { if (e.pointerType !== 'touch') abrirCartao(e.currentTarget, i, classe); }, onpointerleave: fecharCartao,
        onfocus: e => { if (e.currentTarget.matches(':focus-visible')) abrirCartao(e.currentTarget, i, classe); }, onblur: fecharCartao,
        onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fecharCartao(); abrir(); } }
      }, s('circle', { class: 'alvo', r: 44 }), s('circle', { class: 'anel', r: 21 }), s('circle', { class: 'miolo', r: 10 })));
    }
    $('mostrador').replaceChildren(...partes);
  }

  /* Cartão que aparece ao apontar (ou focar) um lembrete no relógio. */
  let cartao = null;

  function fecharCartao() { if (cartao) cartao.remove(); cartao = null; }

  function abrirCartao(no, i, classe) {
    fecharCartao();
    const lista = listaDe(i.category);
    const min = Math.round((D.deIso(i.date, i.time) - Date.now()) / 60000);
    const situacao = i.done ? 'Concluído' : classe === 'vencido' ? maiuscula(atrasoDe(i)) : min < 1 ? 'Agora' : `Em ${duracao(min)}`;
    const etapas = i.subtasks.length ? `${i.subtasks.filter(x => x.done).length} de ${plural(i.subtasks.length, 'etapa', 'etapas')}` : '';
    cartao = h('div', { class: `cartao ${classe}`, 'aria-hidden': 'true' },
      h('div', { class: 'cartao-topo' }, h('b', {}, i.time), h('span', {}, situacao)),
      h('strong', {}, i.title),
      i.description ? h('p', {}, i.description) : null,
      h('div', { class: 'cartao-meta' },
        lista ? h('span', { class: `cor-${lista.cor}` }, h('i', { class: 'ponto' }), lista.nome) : null,
        i.priority === 'high' ? h('span', { class: 'alta' }, 'Prioridade alta') : null,
        i.repeat !== 'none' ? h('span', {}, icone('repetir'), D.REPETICOES[i.repeat]) : null,
        etapas ? h('span', {}, icone('todos'), etapas) : null));
    document.body.append(cartao);
    const r = no.querySelector('.anel').getBoundingClientRect();
    const w = cartao.offsetWidth, a = cartao.offsetHeight, meio = r.left + r.width / 2;
    const x = Math.max(12, Math.min(meio - w / 2, innerWidth - w - 12));
    const abaixo = r.top - a - 14 < 12;
    cartao.classList.toggle('abaixo', abaixo);
    cartao.style.left = `${x}px`;
    cartao.style.top = `${abaixo ? r.bottom + 14 : r.top - a - 14}px`;
    cartao.style.setProperty('--ponta', `${Math.max(14, Math.min(meio - x, w - 14))}px`);
  }
  addEventListener('scroll', fecharCartao, { passive: true });
  addEventListener('keydown', e => { if (e.key === 'Escape') fecharCartao(); });

  function destacar(id) {
    const el = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: semMovimento() ? 'auto' : 'smooth' });
    el.classList.remove('destaque');
    void el.offsetWidth;
    el.classList.add('destaque');
    el.querySelector('.item-titulo').focus({ preventScroll: true });
  }

  function desenharCorpo() {
    const cal = est.vista === 'calendario' && !est.busca;
    const feitos = est.vista === 'concluidos' && !est.busca;
    $('rapido').hidden = feitos || !!est.busca;
    const dir = $('ferramentasDir');
    dir.querySelector('.ordem').hidden = cal || feitos;
    const antigo = $('limparFeitos');
    if (antigo) antigo.remove();
    if (feitos && est.itens.some(i => i.done)) {
      dir.append(h('button', { class: 'botao fantasma', id: 'limparFeitos', type: 'button', onclick: () => { const l = est.itens.filter(i => i.done); apagar(l, `${plural(l.length, 'concluído removido', 'concluídos removidos')}.`); } }, icone('lixo'), 'Limpar concluídos'));
    }
    $('ferramentas').hidden = cal;
    if (cal) return desenharCalendario();

    const gs = grupos().filter(g => g[1].length);
    $('corpo').replaceChildren(...(gs.length ? gs.map(([nome, itens, tipo]) => grupo(nome, tipo === 'semOrdem' ? itens : ordenar(itens), tipo)) : [vazio()]));
  }

  function grupo(nome, itens, tipo) {
    return h('section', { class: `grupo${tipo === 'atraso' ? ' atraso' : ''}` },
      h('h3', { class: 'grupo-topo' }, nome, h('span', { class: 'n' }, String(itens.length))),
      h('ul', { class: 'itens' }, itens.map(i => linha(i))));
  }

  function linha(i, previsto) {
    const lista = listaDe(i.category);
    const vencido = !previsto && D.vencido(i);
    const feitas = i.subtasks.filter(x => x.done).length;
    const aberto = est.abertos.has(i.id) && !previsto;
    const meta = [];
    if (i.date) {
      meta.push(h('span', { class: `quando${vencido ? ' vencido' : ''}` }, icone(i.time ? 'relogio' : 'calendario'),
        rotuloQuando(i) + (vencido ? `, ${atrasoDe(i)}` : '')));
    }
    if (i.snoozeUntil > Date.now() && !i.done) meta.push(h('span', {}, icone('sino'), `Adiado para ${D.horaDe(new Date(i.snoozeUntil))}`));
    if (i.repeat !== 'none') meta.push(h('span', {}, icone('repetir'), D.REPETICOES[i.repeat]));
    if (i.priority !== 'medium') meta.push(h('span', { class: i.priority === 'high' ? 'alta' : '' }, h('span', { class: 'nivel', 'aria-hidden': 'true' }, h('b'), i.priority === 'high' ? [h('b'), h('b')] : null), `Prioridade ${D.PRIORIDADES[i.priority].toLowerCase()}`));
    if (lista) meta.push(h('button', { type: 'button', class: `cor-${lista.cor}`, 'data-foco': `il-${i.id}`, onclick: () => ir('lista', lista.id) }, h('i', { class: 'ponto' }), lista.nome));
    if (i.subtasks.length) {
      meta.push(h('button', { type: 'button', 'aria-expanded': String(aberto), 'data-foco': `sb-${i.id}`, onclick: () => { est.abertos[aberto ? 'delete' : 'add'](i.id); desenhar(); } },
        icone('todos'), `${feitas} de ${plural(i.subtasks.length, 'etapa', 'etapas')}`, icone('seta')));
    }
    return h('li', { class: `item${i.done ? ' feito' : ''}${i.priority === 'high' ? ' alta' : ''}${previsto ? ' previsto' : ''}`, 'data-id': previsto ? null : i.id },
      previsto
        ? h('span', { class: 'marcar' }, icone('repetir'))
        : h('button', { class: 'marcar', type: 'button', role: 'checkbox', 'aria-checked': String(i.done), 'aria-label': `${i.done ? 'Reabrir' : 'Concluir'}: ${i.title}`, 'data-foco': `mk-${i.id}`, onclick: () => alternar(i) }, h('i', {}, icone('ok'))),
      h('div', { class: 'item-corpo' },
        h('button', { class: 'item-titulo', type: 'button', 'data-foco': `tt-${i.id}`, onclick: () => abrirEditor(est.mapa.get(i.id)) }, i.title),
        i.description ? h('p', { class: 'item-nota' }, i.description) : null,
        h('div', { class: 'item-meta' }, previsto ? [h('span', {}, `Previsto, ${D.REPETICOES[i.repeat].toLowerCase()}`)] : meta),
        aberto ? h('ul', { class: 'subs' }, i.subtasks.map(x => h('li', {}, h('button', { type: 'button', role: 'checkbox', 'aria-checked': String(x.done), 'data-foco': `sx-${x.id}`, onclick: () => alternarSub(i, x.id) }, h('i', {}, icone('ok')), x.text)))) : null),
      previsto ? h('span') : h('div', { class: 'item-fim' },
        i.pinned ? h('span', { class: 'fixado', title: 'Fixado' }, icone('fixar')) : null,
        h('button', { class: 'icone', type: 'button', 'aria-label': `Opções de ${i.title}`, 'aria-haspopup': 'menu', 'data-foco': `op-${i.id}`, onclick: e => menuItem(e.currentTarget, i) }, icone('opcoes'))));
  }

  const EXEMPLOS = ['Pagar internet todo dia 10 às 9h #casa', 'Reunião amanhã 14h30 !alta', 'Tomar água em 40 minutos'];

  function vazio() {
    if (est.busca) return h('div', { class: 'vazio' }, h('h3', {}, 'Nada encontrado'), h('p', {}, 'Tente outra palavra do título, dos detalhes, das etapas ou o nome da lista.'));
    if (est.vista === 'concluidos') return h('div', { class: 'vazio' }, h('h3', {}, 'Nenhum lembrete concluído'), h('p', {}, 'O que você concluir fica guardado aqui e pode ser reaberto.'));
    if (est.vista === 'hoje' && est.itens.length) {
      const feitos = est.itens.some(i => i.done && D.isoDe(new Date(i.completedAt)) === D.hoje());
      return h('div', { class: 'vazio' }, h('h3', {}, feitos ? 'Dia concluído' : 'Dia livre'), h('p', {}, 'Nenhum lembrete pendente para hoje. Escreva acima para criar um.'));
    }
    return h('div', { class: 'vazio' },
      h('h3', {}, 'Crie um lembrete'),
      h('p', {}, 'Escreva do seu jeito. O O.M.E.G.A. entende data, horário, repetição, lista e prioridade.'),
      h('div', { class: 'exemplos' }, EXEMPLOS.map(t => h('button', { class: 'pilula', type: 'button', onclick: () => { $('rapidoTexto').value = t; est.ignorar.clear(); desenharLeitura(); $('rapidoTexto').focus(); } }, t))));
  }

  /* ---------- Calendário ---------- */

  /* Dias em que o lembrete cai dentro do intervalo, contando as repetições futuras. */
  function ocorrencias(i, ini, fim) {
    if (!i.date) return [];
    const dias = i.date >= ini && i.date <= fim ? [i.date] : [];
    if (i.done || i.repeat === 'none' || i.date > fim) return dias;
    let d = i.date;
    const dia = i.repeatDay || D.deIso(i.date).getDate();
    for (let n = 0; n < 60; n++) {
      d = D.proximaData({ ...i, date: d, repeatDay: dia }, n ? D.somaDias(d, 1) : ini > d ? ini : D.somaDias(d, 1));
      if (d > fim) break;
      if (d >= ini) dias.push(d);
    }
    return dias;
  }

  function desenharCalendario() {
    const hoje = D.hoje();
    const inicio = D.somaDias(est.mes, -D.deIso(est.mes).getDay());
    const ultimo = D.somaDias(D.somaMeses(est.mes, 1), -1);
    const semanas = Math.ceil((D.diasEntre(inicio, ultimo) + 1) / 7);
    const fim = D.somaDias(inicio, semanas * 7 - 1);
    const porDia = new Map();
    for (const i of est.itens) {
      for (const d of ocorrencias(i, inicio, fim)) {
        if (!porDia.has(d)) porDia.set(d, []);
        porDia.get(d).push({ i, previsto: d !== i.date });
      }
    }
    porDia.forEach(l => l.sort((a, b) => Number(a.i.done) - Number(b.i.done) || (a.i.time || '99').localeCompare(b.i.time || '99')));
    const trocar = n => { est.mes = D.somaMeses(est.mes, n); est.dia = est.mes.slice(0, 7) === hoje.slice(0, 7) ? hoje : est.mes; desenhar(); };

    const celulas = [];
    for (let n = 0; n < semanas * 7; n++) {
      const d = D.somaDias(inicio, n);
      const l = porDia.get(d) || [];
      celulas.push(h('button', {
        class: `cal-dia${d.slice(0, 7) !== est.mes.slice(0, 7) ? ' fora' : ''}${d === hoje ? ' hoje' : ''}`, type: 'button', 'aria-pressed': String(d === est.dia),
        'aria-label': `${fLongo.format(D.deIso(d))}${l.length ? `, ${plural(l.length, 'lembrete', 'lembretes')}` : ''}`, 'data-foco': `dia-${d}`,
        onclick: () => { est.dia = d; est.mes = d.slice(0, 8) + '01'; desenhar(); },
        ondblclick: () => abrirEditor(null, { date: d })
      }, h('span', { class: 'num' }, String(Number(d.slice(8)))),
        l.slice(0, 3).map(({ i, previsto }) => h('span', { class: `cal-ev${previsto ? ' previsto' : ''}${i.done ? ' feito' : ''}${!previsto && D.vencido(i) ? ' vencido' : ''} ${listaDe(i.category) ? `cor-${listaDe(i.category).cor}` : ''}` }, i.title)),
        l.length > 3 ? h('span', { class: 'cal-mais' }, `+${l.length - 3}`) : null));
    }
    const doDia = porDia.get(est.dia) || [];
    $('corpo').replaceChildren(
      h('section', { class: 'cal', 'aria-label': 'Calendário' },
        h('div', { class: 'cal-topo' },
          h('h3', { 'aria-live': 'polite' }, fMes.format(D.deIso(est.mes)).replace(' de ', ' ')),
          h('button', { class: 'botao fantasma', type: 'button', 'data-foco': 'cal-hoje', onclick: () => { est.dia = hoje; est.mes = hoje.slice(0, 8) + '01'; desenhar(); } }, 'Hoje'),
          h('button', { class: 'icone', type: 'button', 'aria-label': 'Mês anterior', 'data-foco': 'cal-esq', onclick: () => trocar(-1) }, icone('esq')),
          h('button', { class: 'icone', type: 'button', 'aria-label': 'Próximo mês', 'data-foco': 'cal-dir', onclick: () => trocar(1) }, icone('dir'))),
        h('div', { class: 'cal-grade' }, ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map(x => h('div', { class: 'cal-sem', 'aria-hidden': 'true' }, x)), celulas)),
      h('section', { class: 'grupo cal-lista' },
        h('h3', { class: 'grupo-topo' }, maiuscula(fLongo.format(D.deIso(est.dia))), h('span', { class: 'n' }, String(doDia.length))),
        doDia.length ? h('ul', { class: 'itens' }, doDia.map(({ i, previsto }) => linha(i, previsto)))
          : h('div', { class: 'vazio' }, h('p', {}, 'Nenhum lembrete neste dia.'), h('button', { class: 'botao fantasma', type: 'button', onclick: () => abrirEditor(null, { date: est.dia }) }, icone('mais'), 'Criar para este dia'))));
  }

  /* ---------- Navegação ---------- */

  function ir(vista, lista) {
    const alvo = vista === 'lista' ? `lista-${lista}` : vista;
    if (est.busca) { est.busca = ''; $('busca').value = ''; }
    fecharLateral();
    if (location.hash.slice(1) === alvo) { lerHash(); } else location.hash = alvo;
  }

  function lerHash() {
    let alvo = '';
    try { alvo = decodeURIComponent(location.hash.slice(1)); } catch { /* endereço malformado: abre em Hoje */ }
    if (alvo === 'conteudo') return;
    const antes = est.vista + est.lista;
    if (alvo.startsWith('lista-')) { est.vista = 'lista'; est.lista = alvo.slice(6); }
    else est.vista = VISTAS.some(v => v[0] === alvo) ? alvo : 'hoje';
    if (est.vista !== 'lista') est.lista = '';
    desenhar();
    if (antes !== est.vista + est.lista) window.scrollTo(0, 0);
  }

  function abrirLateral() { $('lateral').classList.add('aberta'); $('veu').hidden = false; $('abrirMenu').setAttribute('aria-expanded', 'true'); $('lateral').querySelector('button').focus(); }
  function fecharLateral() { $('lateral').classList.remove('aberta'); $('veu').hidden = true; $('abrirMenu').setAttribute('aria-expanded', 'false'); }

  /* ---------- Menu de opções ---------- */

  let menuAberto = null;

  function fecharMenu(devolverFoco) {
    if (!menuAberto) return;
    const { el, ancora } = menuAberto;
    menuAberto = null;
    el.remove();
    if (devolverFoco && ancora.isConnected) ancora.focus();
  }

  function abrirMenu(ancora, itens) {
    const mesma = menuAberto && menuAberto.ancora === ancora;
    fecharMenu();
    if (mesma) return;
    const el = h('div', { class: 'menu', role: 'menu' }, itens.map(x => (x === '-' ? h('hr') : h('button', {
      type: 'button', role: 'menuitem', class: x.perigo ? 'perigo' : '', onclick: () => { fecharMenu(true); x.acao(); }
    }, icone(x.icone), h('span', {}, x.nome), x.extra ? h('small', {}, x.extra) : null))));
    document.body.append(el);
    const r = ancora.getBoundingClientRect();
    const alto = el.offsetHeight, largo = el.offsetWidth;
    el.style.left = `${Math.max(12, Math.min(r.right - largo, innerWidth - largo - 12))}px`;
    el.style.top = `${Math.max(12, r.bottom + alto + 12 > innerHeight ? r.top - alto - 6 : r.bottom + 6)}px`;
    menuAberto = { el, ancora };
    const botoes = [...el.querySelectorAll('button')];
    botoes[0].focus();
    el.addEventListener('keydown', e => {
      const n = botoes.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); botoes[(n + (e.key === 'ArrowDown' ? 1 : -1) + botoes.length) % botoes.length].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fecharMenu(true); }
      else if (e.key === 'Tab') fecharMenu();
    });
  }
  document.addEventListener('pointerdown', e => { if (menuAberto && !menuAberto.el.contains(e.target) && !menuAberto.ancora.contains(e.target)) fecharMenu(); });
  addEventListener('scroll', () => fecharMenu(), { passive: true });

  function menuItem(ancora, i) {
    const comuns = [
      { icone: 'copiar', nome: 'Duplicar', acao: () => duplicar(i) },
      ...(i.date ? [{ icone: 'calendario', nome: 'Baixar para a agenda', acao: () => baixar('lembrete.ics', 'text/calendar', D.gerarIcs([i], cfg.horaPadrao)) }] : []),
      '-', { icone: 'lixo', nome: 'Excluir', perigo: true, acao: () => apagar([i]) }
    ];
    if (i.done) return abrirMenu(ancora, [{ icone: 'repetir', nome: 'Reabrir', acao: () => reabrir(i) }, ...comuns]);
    const hoje = D.hoje();
    const seg = D.somaDias(hoje, ((8 - D.deIso(hoje).getDay()) % 7) || 7);
    const umaHora = new Date(Date.now() + 3600000);
    abrirMenu(ancora, [
      { icone: 'editar', nome: 'Editar', acao: () => abrirEditor(i) },
      { icone: 'fixar', nome: i.pinned ? 'Desafixar' : 'Fixar no topo', acao: () => mudar({ gravar: [mexido(i, { pinned: !i.pinned })] }) },
      '-',
      { icone: 'relogio', nome: 'Daqui a 1 hora', extra: D.horaDe(umaHora), acao: () => reagendar(i, D.isoDe(umaHora), D.horaDe(umaHora)) },
      { icone: 'hoje', nome: 'Amanhã', extra: i.time, acao: () => reagendar(i, D.somaDias(hoje, 1), i.time) },
      { icone: 'proximos', nome: 'Segunda-feira', extra: rotuloDia(seg).length < 8 ? rotuloDia(seg) : '', acao: () => reagendar(i, seg, i.time) },
      { icone: 'calendario', nome: 'Escolher data', acao: () => abrirEditor(i, {}, 'edData') },
      '-', ...comuns
    ]);
  }

  /* ---------- Novo lembrete por frase ---------- */

  const lerFrase = () => interpretar($('rapidoTexto').value, new Date(), est.ignorar);
  const acharLista = nome => est.listas.find(l => dobrar(l.nome).replace(/[\s_]+/g, '-') === dobrar(nome).replace(/[\s_]+/g, '-'));

  /* O contexto da tela completa o que a frase não disse. */
  function completar(r) {
    const x = { ...r };
    if (!x.date && !est.ignorar.has('data')) {
      if (est.vista === 'hoje') x.date = D.hoje();
      if (est.vista === 'calendario') x.date = est.dia;
    }
    if (!x.category && est.vista === 'lista') x.listaId = est.lista;
    return x;
  }

  function desenharLeitura() {
    const alvo = $('rapidoLeitura');
    if (!$('rapidoTexto').value.trim()) { est.ignorar.clear(); return alvo.replaceChildren(); }
    const r = lerFrase();
    const c = completar(r);
    const chips = [];
    const chip = (tipo, ic, texto) => chips.push(h('button', { class: 'etiqueta', type: 'button', title: 'Não usar', 'aria-label': `${texto}. Não usar`, 'data-foco': `chip-${tipo}`, onclick: () => { est.ignorar.add(tipo); desenharLeitura(); $('rapidoTexto').focus(); } }, icone(ic), texto, icone('fechar')));
    if (c.date) chip('data', 'calendario', rotuloDia(c.date));
    if (r.time) chip('hora', 'relogio', r.time);
    if (r.repeat) chip('repetir', 'repetir', D.REPETICOES[r.repeat]);
    if (r.priority) chip('prioridade', 'sino', `Prioridade ${D.PRIORIDADES[r.priority].toLowerCase()}`);
    if (r.category) chip('categoria', 'todos', acharLista(r.category) ? acharLista(r.category).nome : `Nova lista: ${r.category}`);
    alvo.replaceChildren(...(chips.length ? [h('span', {}, 'Entendi:'), ...chips] : []));
  }

  async function adicionarRapido(e) {
    e.preventDefault();
    const campo = $('rapidoTexto');
    if (!campo.value.trim()) return abrirEditor(null, completar({ date: '' }));
    const r = completar(lerFrase());
    if (!r.title) return abrirEditor(null, r);
    let lista = r.listaId || '';
    const listas = [];
    if (r.category) {
      const achada = acharLista(r.category);
      if (achada) lista = achada.id;
      else { listas.push(novaLista(r.category)); lista = listas[0].id; }
    }
    const item = prepararAviso(D.normalizar({
      id: D.novoId(), title: r.title, date: r.date, time: r.time, priority: r.priority || 'medium',
      repeat: r.repeat || 'none', repeatDay: r.repeatDay, category: lista, createdAt: Date.now(), updatedAt: Date.now()
    }));
    if (!await mudar({ gravar: [item], listas })) return;
    campo.value = '';
    est.ignorar.clear();
    desenharLeitura();
    toast(item.date ? `Lembrete criado para ${rotuloQuando(item).toLowerCase()}.` : 'Lembrete criado.', () => mudar({ apagar: [item.id], apagarListas: listas.map(l => l.id) }));
    pedirPersistencia();
  }

  const novaLista = nome => ({ id: D.novoId(), nome: maiuscula(nome.trim()).slice(0, 30), cor: est.listas.length % 8 + 1, updatedAt: Date.now() });

  /* ---------- Editor ---------- */

  let edItem = null;
  let edSubs = [];

  function opcoes(sel, pares) { sel.replaceChildren(...pares.map(([v, t]) => h('option', { value: String(v) }, t))); }

  function abrirEditor(item, inicial, foco) {
    edItem = item || null;
    const x = { title: '', description: '', date: '', time: '', priority: 'medium', repeat: 'none', lead: 0, category: '', subtasks: [], ...(item || completar({})), ...(inicial || {}) };
    if (!x.title && !item && inicial && inicial.title === '') x.title = '';
    $('edTitulo').textContent = item ? 'Editar lembrete' : 'Novo lembrete';
    $('edNome').value = x.title || '';
    $('edNota').value = x.description || '';
    $('edData').value = x.date || '';
    $('edHora').value = x.time || '';
    $('edRepetir').value = x.repeat || 'none';
    $('edAviso').value = String(x.lead || 0);
    opcoes($('edLista'), [['', 'Nenhuma'], ...est.listas.map(l => [l.id, l.nome]), ...(x.category && !item && !listaDe(x.category) && !acharLista(x.category) ? [['nova', `Nova: ${x.category}`]] : [])]);
    const lista = item ? x.category : x.listaId || (x.category && (acharLista(x.category) ? acharLista(x.category).id : 'nova')) || '';
    $('edLista').value = lista;
    $('edLista').dataset.nova = lista === 'nova' ? x.category : '';
    if ($('edLista').selectedIndex < 0) $('edLista').value = '';
    document.querySelector(`[name=prioridade][value=${x.priority || 'medium'}]`).checked = true;
    edSubs = x.subtasks.map(y => ({ ...y }));
    $('edSub').value = '';
    $('edErro').hidden = true;
    $('edApagar').hidden = !item;
    desenharEdData();
    desenharEdSubs();
    $('dlgEditor').showModal();
    $('dlgEditor').querySelector('.dlg-corpo').scrollTop = 0;
    const alvo = $(foco || 'edNome');
    if (!celular() || !item) alvo.focus();
  }

  function desenharEdData() {
    const hoje = D.hoje();
    const seg = D.somaDias(hoje, ((8 - D.deIso(hoje).getDay()) % 7) || 7);
    const pares = [['Hoje', hoje], ['Amanhã', D.somaDias(hoje, 1)], ...(D.diasEntre(hoje, seg) > 1 ? [['Segunda', seg]] : []), ['Em 1 semana', D.somaDias(hoje, 7)], ['Sem data', '']];
    const vistos = new Set();
    $('edAtalhosData').replaceChildren(...pares.filter(([, v]) => !vistos.has(v) && vistos.add(v)).map(([nome, v]) => h('button', {
      class: 'pilula', type: 'button', 'aria-pressed': String($('edData').value === v), onclick: () => { $('edData').value = v; if (!v) { $('edHora').value = ''; $('edRepetir').value = 'none'; } desenharEdData(); }
    }, nome)));
  }

  function desenharEdSubs() {
    $('edSubs').replaceChildren(...edSubs.map((x, n) => h('li', {}, h('span', {}, x.text), h('button', { class: 'icone', type: 'button', 'aria-label': `Remover etapa ${x.text}`, onclick: () => { edSubs.splice(n, 1); desenharEdSubs(); $('edSub').focus(); } }, icone('fechar')))));
  }

  function incluirSub() {
    const t = $('edSub').value.trim();
    if (!t || edSubs.length >= 50) return;
    edSubs.push({ id: D.novoId(), text: t, done: false });
    $('edSub').value = '';
    desenharEdSubs();
    $('edSub').focus();
  }

  async function salvarEditor(e) {
    e.preventDefault();
    incluirSub();
    const title = $('edNome').value.trim();
    if (!title) { $('edErro').textContent = 'Escreva um título para salvar.'; $('edErro').hidden = false; $('edNome').focus(); return; }
    let date = $('edData').value;
    const time = $('edHora').value;
    const repeat = $('edRepetir').value;
    if (!date && time) date = time > D.horaDe(new Date()) ? D.hoje() : D.somaDias(D.hoje(), 1);
    if (!date && repeat !== 'none') date = D.hoje();
    const listas = [];
    let category = $('edLista').value;
    if (category === 'nova') { listas.push(novaLista($('edLista').dataset.nova)); category = listas[0].id; }
    /* O item pode ter mudado em outra aba ou aparelho enquanto o editor estava aberto. */
    const base = edItem ? est.mapa.get(edItem.id) || edItem : { id: D.novoId(), createdAt: Date.now() };
    const lead = Number($('edAviso').value);
    const mudouHora = base.date !== date || base.time !== time || base.lead !== lead;
    const item = D.normalizar({
      ...base, title, description: $('edNota').value.trim(), date, time, repeat, lead, category,
      repeatDay: base.date === date && base.repeat === repeat ? base.repeatDay : 0,
      priority: document.querySelector('[name=prioridade]:checked').value, subtasks: edSubs,
      snoozeUntil: mudouHora ? 0 : base.snoozeUntil, updatedAt: Date.now()
    });
    if (mudouHora) prepararAviso(item);
    if (!await mudar({ gravar: [item], listas })) return;
    $('dlgEditor').close();
    if (!edItem) { $('rapidoTexto').value = ''; est.ignorar.clear(); desenharLeitura(); pedirPersistencia(); }
    toast(edItem ? 'Alterações salvas.' : item.date ? `Lembrete criado para ${rotuloQuando(item).toLowerCase()}.` : 'Lembrete criado.');
  }

  /* ---------- Listas ---------- */

  let lsAtual = null;

  function abrirLista(l) {
    lsAtual = l || null;
    $('lsTitulo').textContent = l ? 'Editar lista' : 'Nova lista';
    $('lsNome').value = l ? l.nome : '';
    $('lsErro').hidden = true;
    $('lsApagar').hidden = !l;
    const cor = l ? l.cor : est.listas.length % 8 + 1;
    const nomes = ['Azul', 'Ciano', 'Verde', 'Lima', 'Âmbar', 'Coral', 'Rosa', 'Lilás'];
    $('lsCores').replaceChildren(...nomes.flatMap((nome, n) => [
      h('input', { type: 'radio', name: 'cor', id: `cor${n + 1}`, value: String(n + 1), checked: cor === n + 1, 'aria-label': nome }),
      h('label', { for: `cor${n + 1}`, class: `cor-${n + 1}`, title: nome })
    ]));
    $('dlgLista').showModal();
    $('lsNome').focus();
  }

  async function salvarLista(e) {
    e.preventDefault();
    const nome = $('lsNome').value.trim();
    const igual = nome && acharLista(nome);
    const erro = !nome ? 'Dê um nome à lista.' : igual && (!lsAtual || igual.id !== lsAtual.id) ? 'Já existe uma lista com esse nome.' : '';
    if (erro) { $('lsErro').textContent = erro; $('lsErro').hidden = false; $('lsNome').focus(); return; }
    const lista = { id: lsAtual ? lsAtual.id : D.novoId(), nome, cor: Number(document.querySelector('[name=cor]:checked').value), updatedAt: Date.now() };
    if (!await mudar({ listas: [lista] })) return;
    $('dlgLista').close();
    toast(lsAtual ? 'Lista salva.' : 'Lista criada.');
  }

  async function apagarLista() {
    const l = lsAtual;
    const itens = est.itens.filter(i => i.category === l.id);
    $('dlgLista').close();
    if (await mudar({ apagarListas: [l.id], gravar: itens.map(i => mexido(i, { category: '' })) })) {
      if (est.vista === 'lista' && est.lista === l.id) ir('todos');
      toast(itens.length ? `Lista excluída. ${plural(itens.length, 'lembrete ficou', 'lembretes ficaram')} sem lista.` : 'Lista excluída.', () =>
        mudar({ listas: [{ ...l, updatedAt: Date.now() }], gravar: itens.map(i => mexido(i, {})) }));
    }
  }

  /* ---------- Avisos ---------- */

  let audio = null;

  function tocarSino() {
    if (!cfg.som) return;
    try {
      audio = audio || new AudioContext();
      if (audio.state === 'suspended') audio.resume();
      const t = audio.currentTime;
      [[880, 0, .3, 1.6], [1318, 0, .16, 1.2], [1760, .16, .18, 1.4]].forEach(([f, atraso, vol, dur]) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t + atraso);
        g.gain.linearRampToValueAtTime(vol, t + atraso + .01);
        g.gain.exponentialRampToValueAtTime(.0001, t + atraso + dur);
        o.connect(g).connect(audio.destination);
        o.start(t + atraso);
        o.stop(t + atraso + dur);
      });
    } catch { /* navegador sem áudio ou ainda sem interação */ }
  }
  /* Navegadores só liberam som depois de um toque na página. */
  addEventListener('pointerdown', () => { try { audio = audio || new AudioContext(); audio.resume(); } catch { /* sem áudio */ } }, { once: true });

  function notificar(titulo, corpo, tag, aoClicar) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(titulo, { body: corpo, icon: 'icons/omega-256.png', tag });
      n.onclick = () => { window.focus(); n.close(); aoClicar(); };
    } catch { /* o Chrome do Android não permite; o aviso na tela e o som continuam */ }
  }

  const fecharAviso = id => document.querySelectorAll(`.aviso[data-id="${CSS.escape(id)}"]`).forEach(e => e.remove());

  function mostrarAviso(i) {
    fecharAviso(i.id);
    const lista = listaDe(i.category);
    const quando = [rotuloQuando(i), lista && lista.nome].filter(Boolean).join(', ');
    const atual = () => est.mapa.get(i.id) || i;
    $('avisos').append(h('div', { class: 'aviso', 'data-id': i.id },
      h('div', { class: 'aviso-topo' }, icone('sino'),
        h('div', {}, h('strong', {}, i.title), h('p', {}, quando)),
        h('button', { class: 'icone', type: 'button', 'aria-label': 'Dispensar aviso', onclick: () => fecharAviso(i.id) }, icone('fechar'))),
      h('div', { class: 'botoes' },
        h('button', { class: 'botao', type: 'button', onclick: () => concluir(atual()) }, 'Concluir'),
        h('button', { class: 'botao fantasma', type: 'button', onclick: () => adiar(atual(), 10) }, 'Em 10 min'),
        h('button', { class: 'botao fantasma', type: 'button', onclick: () => adiar(atual(), 60) }, 'Em 1 h'))));
  }

  let verificando = false;
  async function verificarAvisos() {
    if (verificando) return;
    verificando = true;
    try {
      const agora = Date.now();
      const novos = [];
      for (const i of est.itens) {
        const t = D.momentoDoAviso(i, cfg.horaPadrao);
        if (!t || t > agora || i.notifiedFor === String(t)) continue;
        if (!await B.reivindicarAviso(i.id, String(t))) continue;
        i.notifiedFor = String(t);
        if (agora - t < 12 * 3600000) novos.push(i);
      }
      if (!novos.length) return;
      tocarSino();
      if (novos.length <= 3) {
        novos.forEach(i => { mostrarAviso(i); notificar(i.title, rotuloQuando(i), i.id, () => abrirEditor(est.mapa.get(i.id) || i)); });
      } else {
        const texto = `${novos.length} lembretes chegaram na hora`;
        notificar(texto, novos.slice(0, 4).map(i => i.title).join(', '), 'omega-varios', () => ir('hoje'));
        novos.slice(0, 3).forEach(mostrarAviso);
        toast(`${texto}.`);
      }
    } catch (e) { console.error(e); } finally { verificando = false; }
  }

  function pedirPersistencia() {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  /* ---------- Ajustes ---------- */

  function desenharAjustes() {
    const pode = 'Notification' in window;
    const p = pode ? Notification.permission : '';
    $('notifEstado').textContent = !pode ? 'Este navegador não oferece notificações. O aviso na tela e o som continuam.'
      : p === 'granted' ? 'Ativadas neste navegador.'
        : p === 'denied' ? 'Bloqueadas. Libere nas permissões do site, no cadeado ao lado do endereço.' : 'Mostra o aviso mesmo com a aba em segundo plano.';
    $('notifBotao').hidden = !pode || p === 'denied';
    $('notifBotao').textContent = p === 'granted' ? 'Testar' : 'Ativar';
    $('cfgSom').checked = cfg.som;
    $('cfgHora').value = cfg.horaPadrao;
    const dias = cfg.ultimoBackup ? Math.floor((Date.now() - cfg.ultimoBackup) / 86400000) : -1;
    const ultimo = dias < 0 ? 'Você ainda não exportou um backup.' : dias === 0 ? 'Último backup: hoje.' : `Último backup: há ${plural(dias, 'dia', 'dias')}.`;
    $('backupEstado').textContent = Conta.estado.usuario ? `Seus lembretes também ficam na sua conta. ${ultimo}` : `Seus lembretes ficam só neste navegador. ${ultimo}`;
  }

  async function botaoNotificacao() {
    if (Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      toast(p === 'granted' ? 'Notificações ativadas.' : 'Notificações não permitidas.');
    } else {
      tocarSino();
      notificar('O.M.E.G.A.', 'É assim que seus lembretes vão aparecer.', 'omega-teste', () => {});
      toast('Aviso de teste enviado.');
    }
    desenharAjustes();
  }

  function exportar() {
    baixar(`omega-backup-${D.hoje()}.json`, 'application/json', JSON.stringify({ app: 'OMEGA', version: 2, exportedAt: new Date().toISOString(), reminders: est.itens, listas: est.listas }, null, 2));
    cfg.ultimoBackup = Date.now();
    salvarCfg();
    desenharAjustes();
    toast('Backup exportado.');
  }

  async function importar(arquivo) {
    let dados;
    try { dados = JSON.parse(await arquivo.text()); } catch { dados = null; }
    if (!dados || !Array.isArray(dados.reminders)) return toast('Este arquivo não é um backup do O.M.E.G.A.');
    const agora = Date.now();
    const itens = dados.reminders.map(D.normalizar).filter(Boolean).map(i => prepararAviso({ ...i, updatedAt: agora }));
    const listas = (Array.isArray(dados.listas) ? dados.listas : []).map(B.normalizarLista).filter(Boolean).map(l => ({ ...l, updatedAt: agora }));
    if (!itens.length && !listas.length) return toast('O backup está vazio.');
    const novos = itens.filter(i => !est.mapa.has(i.id)).length;
    const trocados = itens.length - novos;
    $('dlgAjustes').close();
    const ok = await confirmar({
      titulo: 'Importar backup', sim: 'Importar',
      texto: [novos ? `${plural(novos, 'lembrete será adicionado', 'lembretes serão adicionados')}.` : '', trocados ? `${plural(trocados, 'lembrete existente será substituído', 'lembretes existentes serão substituídos')} pela versão do backup.` : ''].filter(Boolean).join(' ') || `${plural(listas.length, 'lista será adicionada', 'listas serão adicionadas')}.`
    });
    if (ok && await mudar({ gravar: itens, listas })) toast(`${plural(itens.length, 'lembrete importado', 'lembretes importados')}.`);
  }

  function exportarIcs() {
    const itens = est.itens.filter(i => !i.done && i.date);
    if (!itens.length) return toast('Nenhum lembrete pendente com data para levar à agenda.');
    baixar('omega-agenda.ics', 'text/calendar', D.gerarIcs(itens, cfg.horaPadrao));
    toast('Arquivo baixado. Abra-o para incluir na sua agenda.');
  }

  /* ---------- Conta ---------- */

  const SITUACAO = {
    local: ['aparelho', 'Só neste aparelho', ''], fora: ['conta', 'Entrar na conta', ''],
    sincronizando: ['nuvem', 'Sincronizando', 'sincronizando'], emDia: ['nuvem', 'Sincronizado', 'emDia'],
    semRede: ['nuvem', 'Sem conexão', 'alerta'], falhou: ['nuvem', 'Falha ao sincronizar', 'alerta'], expirada: ['conta', 'Entre de novo', 'alerta']
  };

  function desenharConta() {
    const [ic, texto, classe] = SITUACAO[Conta.estado.situacao];
    $('abrirConta').replaceChildren(icone(ic), h('span', {}, texto), classe ? h('i', { class: `sinc ${classe}` }) : '');
  }

  let ctAba = 'entrar';

  function campoConta(id, rotulo, atributos) {
    return h('div', { class: 'campo' }, h('label', { for: id }, rotulo), h('input', { id, required: true, ...atributos }));
  }

  /* Mostra o erro no próprio formulário e trava o botão enquanto envia. */
  function aoEnviar(acao) {
    return async e => {
      e.preventDefault();
      const f = e.currentTarget;
      const botao = f.querySelector('[type=submit]');
      const erro = f.querySelector('.erro');
      erro.hidden = true;
      botao.disabled = true;
      try { await acao(f); } catch (x) {
        erro.textContent = x.message;
        erro.hidden = false;
      } finally { botao.disabled = false; }
    };
  }
  const valor = id => $(id).value;

  function desenharDlgConta() {
    const { usuario, servidor, situacao, pendentes } = Conta.estado;
    const corpo = $('contaCorpo');
    $('ctTitulo').textContent = usuario && situacao !== 'expirada' ? 'Sua conta' : 'Conta';

    if (!servidor && !usuario) {
      return corpo.replaceChildren(
        h('p', {}, 'Os lembretes estão guardados neste navegador, neste aparelho.'),
        h('p', { class: 'dica' }, 'Para ter conta e sincronizar entre aparelhos, o O.M.E.G.A. precisa ser aberto pelo servidor. O arquivo LEIA-ME explica como ligar.'));
    }

    if (!usuario || situacao === 'expirada') {
      const criar = ctAba === 'criar' && !usuario;
      const depois = async () => { ctAba = 'entrar'; await carregar(); desenhar(); $('dlgConta').close(); toast('Conta conectada. Seus lembretes estão sincronizados.'); };
      return corpo.replaceChildren(
        h('p', { class: 'dica' }, usuario ? `A sessão de ${usuario.email} terminou. Entre de novo para continuar sincronizando.` : 'Com uma conta, seus lembretes ficam guardados no servidor e aparecem em todos os seus aparelhos.'),
        usuario ? '' : h('div', { class: 'abas' }, [['entrar', 'Entrar'], ['criar', 'Criar conta']].map(([id, nome]) => h('button', { type: 'button', 'aria-pressed': String((ctAba === 'criar') === (id === 'criar')), onclick: () => { ctAba = id; desenharDlgConta(); } }, nome))),
        h('form', {
          class: 'conta-form', onsubmit: aoEnviar(async () => {
            const email = valor('ctEmail');
            const anterior = await Conta.contaAnterior(email);
            if (anterior) {
              const perda = Conta.estado.pendentes ? ` ${plural(Conta.estado.pendentes, 'alteração ainda não enviada será perdida', 'alterações ainda não enviadas serão perdidas')}.` : '';
              if (!await confirmar({ titulo: 'Trocar de conta', sim: 'Trocar de conta', texto: `Os lembretes de ${anterior.email} saem deste aparelho e continuam na conta dessa pessoa.${perda}` })) return;
            }
            if (criar) await Conta.criar({ nome: valor('ctNome'), email, senha: valor('ctSenha') }, !!anterior);
            else await Conta.entrar({ email, senha: valor('ctSenha') }, !!anterior);
            await depois();
          })
        },
          criar ? campoConta('ctNome', 'Nome', { maxlength: 60, autocomplete: 'name' }) : '',
          campoConta('ctEmail', 'E-mail', { type: 'email', maxlength: 200, autocomplete: 'username', value: usuario ? usuario.email : null }),
          campoConta('ctSenha', criar ? 'Senha (mínimo de 8 caracteres)' : 'Senha', { type: 'password', minlength: criar ? 8 : null, maxlength: 200, autocomplete: criar ? 'new-password' : 'current-password' }),
          h('p', { class: 'erro', role: 'alert', hidden: true }),
          h('button', { class: 'botao', type: 'submit' }, criar ? 'Criar conta' : 'Entrar')));
    }

    const agenda = usuario.agenda ? new URL(usuario.agenda, location.origin).href : '';
    const tentar = async fn => { try { await fn(); } catch (x) { toast(x.message); } desenharDlgConta(); };
    corpo.replaceChildren(
      h('section', { class: 'bloco' },
        h('div', { class: 'opcao' }, h('div', {}, h('strong', {}, usuario.nome), h('p', {}, usuario.email)),
          h('button', { class: 'botao fantasma', type: 'button', onclick: sair }, 'Sair')),
        h('div', { class: 'opcao' }, h('div', {}, h('strong', {}, SITUACAO[situacao][1]), h('p', {}, pendentes ? `${plural(pendentes, 'alteração aguardando', 'alterações aguardando')} envio.` : 'Tudo enviado para a sua conta.')),
          h('button', { class: 'botao fantasma', type: 'button', onclick: () => tentar(() => Conta.sincronizar()) }, 'Sincronizar agora'))),
      h('section', { class: 'bloco' },
        h('h3', {}, 'Agenda no celular'),
        h('p', { class: 'dica' }, 'Assine este endereço na agenda do celular ou no Google Agenda. Seus lembretes com data aparecem lá e se atualizam sozinhos.'),
        agenda
          ? [h('div', { class: 'endereco' }, h('input', { readonly: true, value: agenda, 'aria-label': 'Endereço da agenda', onfocus: e => e.target.select() }),
            h('button', { class: 'botao fantasma', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(agenda); toast('Endereço copiado.'); } catch { corpo.querySelector('.endereco input').select(); } } }, 'Copiar')),
            h('p', { class: 'dica' }, 'Quem tiver o endereço consegue ver seus lembretes com data.'),
            h('div', { class: 'botoes' }, h('button', { class: 'botao fantasma', type: 'button', onclick: () => tentar(() => Conta.ligarAgenda()) }, 'Trocar endereço'), h('button', { class: 'botao perigo', type: 'button', onclick: () => tentar(() => Conta.desligarAgenda()) }, 'Desligar'))]
          : h('div', { class: 'botoes' }, h('button', { class: 'botao fantasma', type: 'button', onclick: () => tentar(() => Conta.ligarAgenda()) }, icone('calendario'), 'Criar endereço'))),
      h('section', { class: 'bloco' },
        h('h3', {}, 'Trocar senha'),
        h('form', { class: 'conta-form', onsubmit: aoEnviar(async f => { await Conta.editar({ senhaAtual: valor('ctAtual'), novaSenha: valor('ctNova') }); f.reset(); toast('Senha trocada. Os outros aparelhos precisam entrar de novo.'); }) },
          h('input', { type: 'text', hidden: true, autocomplete: 'username', value: usuario.email }),
          h('div', { class: 'dupla' },
            campoConta('ctAtual', 'Senha atual', { type: 'password', maxlength: 200, autocomplete: 'current-password' }),
            campoConta('ctNova', 'Nova senha', { type: 'password', minlength: 8, maxlength: 200, autocomplete: 'new-password' })),
          h('p', { class: 'erro', role: 'alert', hidden: true }),
          h('div', { class: 'botoes' }, h('button', { class: 'botao fantasma', type: 'submit' }, 'Trocar senha')))),
      h('section', { class: 'bloco' },
        h('h3', {}, 'Excluir conta'),
        h('p', { class: 'dica' }, 'Apaga a conta e todos os lembretes do servidor e deste aparelho. Não dá para desfazer.'),
        h('form', {
          class: 'conta-form', onsubmit: aoEnviar(async () => {
            const senha = valor('ctExcluir');
            if (!await confirmar({ titulo: 'Excluir conta', sim: 'Excluir tudo', texto: 'A conta e todos os lembretes serão apagados para sempre. Exporte um backup antes se quiser guardar uma cópia.' })) return;
            await Conta.excluir(senha);
            await carregar(); desenhar(); $('dlgConta').close(); toast('Conta excluída.');
          })
        },
          campoConta('ctExcluir', 'Confirme sua senha', { type: 'password', maxlength: 200, autocomplete: 'current-password' }),
          h('p', { class: 'erro', role: 'alert', hidden: true }),
          h('div', { class: 'botoes' }, h('button', { class: 'botao perigo', type: 'submit' }, 'Excluir conta')))));
  }

  async function sair() {
    await Conta.sincronizar();
    const n = Conta.estado.pendentes;
    const texto = n ? `${plural(n, 'alteração não foi enviada e será perdida', 'alterações não foram enviadas e serão perdidas')}. Os demais lembretes continuam na conta.` : 'Os lembretes saem deste aparelho e continuam na sua conta.';
    if (!await confirmar({ titulo: 'Sair da conta', sim: 'Sair', texto })) return;
    try { await Conta.sair(); } catch (x) { return toast(x.message); }
    await carregar();
    desenhar();
    $('dlgConta').close();
    toast('Você saiu da conta.');
  }

  /* ---------- Ligações ---------- */

  function ligar() {
    opcoes($('edRepetir'), Object.entries(D.REPETICOES));
    opcoes($('edAviso'), D.ANTECEDENCIAS);
    $('ordem').value = cfg.ordem in ORDENS ? cfg.ordem : 'data';
    $('ordem').onchange = e => { cfg.ordem = e.target.value; salvarCfg(); desenhar(); };

    $('rapido').onsubmit = adicionarRapido;
    $('rapidoTexto').oninput = desenharLeitura;
    $('rapidoDetalhes').onclick = () => abrirEditor(null, { ...completar(lerFrase()), subtasks: [] });
    $('busca').oninput = e => { est.busca = e.target.value.trim() ? e.target.value : ''; desenhar(); };

    $('formEditor').onsubmit = salvarEditor;
    $('edSubBotao').onclick = incluirSub;
    $('edSub').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); incluirSub(); } };
    $('edData').onchange = desenharEdData;
    $('edApagar').onclick = () => { const i = edItem; $('dlgEditor').close(); apagar([est.mapa.get(i.id) || i]); };

    $('novaLista').onclick = () => abrirLista();
    $('formLista').onsubmit = salvarLista;
    $('lsApagar').onclick = apagarLista;

    $('abrirMenu').onclick = abrirLateral;
    $('veu').onclick = fecharLateral;
    $('abrirAjustes').onclick = () => { fecharLateral(); desenharAjustes(); $('dlgAjustes').showModal(); };
    $('abrirConta').onclick = () => { fecharLateral(); desenharDlgConta(); $('dlgConta').showModal(); };
    $('notifBotao').onclick = botaoNotificacao;
    $('cfgSom').onchange = e => { cfg.som = e.target.checked; salvarCfg(); if (cfg.som) tocarSino(); };
    $('cfgHora').onchange = e => { if (D.horaValida(e.target.value)) { cfg.horaPadrao = e.target.value; salvarCfg(); } };
    $('exportar').onclick = exportar;
    $('exportarIcs').onclick = exportarIcs;
    $('importar').onclick = () => $('arquivo').click();
    $('arquivo').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importar(f); };

    document.querySelectorAll('dialog').forEach(d => {
      d.querySelectorAll('[data-fechar]').forEach(b => { b.onclick = () => d.close(); });
      /* Clique fora fecha, menos onde há texto digitado que se perderia. */
      if (d.id === 'dlgAjustes') d.addEventListener('pointerdown', e => { if (e.target === d) d.close(); });
    });

    addEventListener('hashchange', lerHash);
    addEventListener('keydown', e => {
      if (e.key === 'Escape' && $('lateral').classList.contains('aberta')) { fecharLateral(); $('abrirMenu').focus(); return; }
      if (e.key === 'Escape' && e.target === $('busca')) { $('busca').value = ''; est.busca = ''; $('busca').blur(); desenhar(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]') || menuAberto) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); if ($('rapido').hidden) abrirEditor(); else $('rapidoTexto').focus(); }
      else if (e.key === '/') { e.preventDefault(); $('busca').focus(); }
      else if (e.key === '?') { e.preventDefault(); $('abrirAjustes').click(); }
      else if (/^[1-5]$/.test(e.key)) ir(VISTAS[Number(e.key) - 1][0]);
    });

    /* A cada meia volta do minuto: avisos, atrasos, relógio do painel e virada do dia. */
    let ultimoMinuto = '';
    setInterval(() => {
      verificarAvisos();
      const m = D.hoje() + D.horaDe(new Date());
      if (m !== ultimoMinuto) { ultimoMinuto = m; if (!menuAberto) desenhar(); }
    }, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { desenhar(); verificarAvisos(); } });
  }

  /* Quem instalou a versão antiga ainda tem o cache dela no navegador: remove o que ficou. */
  async function limparInstalacaoAntiga() {
    try {
      if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistrations) {
        const antigo = new URL('service-worker.js', document.baseURI).href;
        for (const r of await navigator.serviceWorker.getRegistrations()) {
          const w = r.active || r.waiting || r.installing;
          if (w && w.scriptURL === antigo) await r.unregister();
        }
      }
      if ('caches' in window) for (const k of await caches.keys()) if (k.startsWith('omega-reminders-')) await caches.delete(k);
    } catch { /* sem acesso a cache: nada a limpar */ }
  }

  async function iniciar() {
    limparInstalacaoAntiga();
    ligar();
    try {
      await B.abrir();
      await carregar();
    } catch (e) {
      console.error(e);
      $('titulo').textContent = 'Não foi possível abrir seus lembretes';
      $('resumo').textContent = 'Feche outras abas do O.M.E.G.A. e recarregue. Se continuar, confira se o navegador permite guardar dados deste site.';
      $('rapido').hidden = $('ferramentas').hidden = true;
      return;
    }
    lerHash();
    await Conta.iniciar({
      avisar: () => { desenharConta(); if ($('dlgConta').open && !$('dlgConta').contains(document.activeElement)) desenharDlgConta(); },
      aoReceber: async () => { await carregar(); desenhar(); canal && canal.postMessage('mudou'); },
      ajustar: prepararAviso
    });
    desenhar();
    verificarAvisos();
  }

  iniciar();
})();
