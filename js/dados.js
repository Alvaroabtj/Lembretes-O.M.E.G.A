/* O.M.E.G.A. — dados: datas, modelo do lembrete, repetição e agenda. Usado no site e no servidor. */
(function (raiz) {
  'use strict';

  /* ---------- Datas (sempre no fuso do aparelho, em AAAA-MM-DD) ---------- */

  const dois = n => String(n).padStart(2, '0');
  const isoDe = d => `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
  const horaDe = d => `${dois(d.getHours())}:${dois(d.getMinutes())}`;

  function deIso(iso, hora) {
    const [a, m, d] = iso.split('-').map(Number);
    const [h, min] = (hora || '00:00').split(':').map(Number);
    return new Date(a, m - 1, d, h, min);
  }

  const hoje = () => isoDe(new Date());

  function somaDias(iso, n) {
    const d = deIso(iso);
    d.setDate(d.getDate() + n);
    return isoDe(d);
  }

  /* diaAncora mantém "todo dia 31" no dia 31 mesmo depois de passar por fevereiro. */
  function somaMeses(iso, n, diaAncora) {
    const d = deIso(iso);
    const alvo = diaAncora || d.getDate();
    const base = new Date(d.getFullYear(), d.getMonth() + n, 1);
    const ultimo = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
    base.setDate(Math.min(alvo, ultimo));
    return isoDe(base);
  }

  function diasEntre(a, b) {
    const [x, y] = [a, b].map(i => { const d = deIso(i); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); });
    return Math.round((y - x) / 86400000);
  }

  function dataValida(iso) {
    return /^\d{4}-\d{2}-\d{2}$/.test(iso || '') && isoDe(deIso(iso)) === iso;
  }

  const horaValida = h => /^([01]\d|2[0-3]):[0-5]\d$/.test(h || '');

  /* ---------- Modelo ---------- */

  const PRIORIDADES = { high: 'Alta', medium: 'Média', low: 'Baixa' };
  const REPETICOES = {
    none: 'Não repete', daily: 'Todo dia', weekdays: 'Dias úteis',
    weekly: 'Toda semana', monthly: 'Todo mês', yearly: 'Todo ano'
  };
  /* Pares (minutos, rótulo) na ordem em que aparecem na lista. -1 desliga o aviso. */
  const ANTECEDENCIAS = [
    [0, 'Na hora'], [5, '5 min antes'], [10, '10 min antes'], [30, '30 min antes'],
    [60, '1 hora antes'], [1440, '1 dia antes'], [-1, 'Sem aviso']
  ];

  function novoId() {
    if (raiz.crypto && raiz.crypto.randomUUID) return raiz.crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  const texto = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);
  const instante = v => (Number.isFinite(v) ? v : 0);

  /* Aceita lembretes da versão 1 e qualquer arquivo importado; devolve sempre um registro completo. */
  function normalizar(x) {
    if (!x || typeof x !== 'object') return null;
    const titulo = texto(x.title, 100).trim();
    const id = typeof x.id === 'string' && x.id ? x.id.slice(0, 80) : '';
    if (!titulo || !id) return null;
    const date = dataValida(x.date) ? x.date : '';
    const lead = Number(x.lead);
    return {
      id,
      title: titulo,
      description: texto(x.description, 1000),
      date,
      time: date && horaValida(x.time) ? x.time : '',
      priority: Object.hasOwn(PRIORIDADES, x.priority) ? x.priority : 'medium',
      category: texto(x.category, 80),
      repeat: date && Object.hasOwn(REPETICOES, x.repeat) ? x.repeat : 'none',
      repeatDay: Number.isInteger(x.repeatDay) && x.repeatDay >= 1 && x.repeatDay <= 31 ? x.repeatDay : 0,
      lead: ANTECEDENCIAS.some(([m]) => m === lead) ? lead : 0,
      pinned: !!x.pinned,
      subtasks: (Array.isArray(x.subtasks) ? x.subtasks : []).slice(0, 50)
        .map(s => ({ id: texto(s && s.id, 80) || novoId(), text: texto(s && s.text, 120).trim(), done: !!(s && s.done) }))
        .filter(s => s.text),
      done: !!x.done,
      createdAt: instante(x.createdAt) || Date.now(),
      updatedAt: instante(x.updatedAt) || Date.now(),
      completedAt: x.done ? instante(x.completedAt) || instante(x.updatedAt) || Date.now() : 0,
      notifiedFor: texto(x.notifiedFor, 40),
      snoozeUntil: instante(x.snoozeUntil),
      nextId: texto(x.nextId, 80)
    };
  }

  function proximaData(item, hojeIso) {
    if (!item.date || item.repeat === 'none') return '';
    const dia = item.repeatDay || deIso(item.date).getDate();
    let d = item.date;
    for (let i = 0; i < 5000; i++) {
      if (item.repeat === 'daily') d = somaDias(d, 1);
      else if (item.repeat === 'weekdays') { do d = somaDias(d, 1); while ([0, 6].includes(deIso(d).getDay())); }
      else if (item.repeat === 'weekly') d = somaDias(d, 7);
      else if (item.repeat === 'monthly') d = somaMeses(d, 1, dia);
      else d = somaMeses(d, 12, dia);
      if (d >= hojeIso) break;
    }
    return d;
  }

  /* Ao concluir um lembrete que repete, esta é a próxima ocorrência. O id sai da data para que
   dois aparelhos que concluam o mesmo lembrete sem internet não criem duas cópias. */
  function proximaOcorrencia(item, hojeIso) {
    const date = proximaData(item, hojeIso || hoje());
    if (!date) return null;
    return normalizar({
      ...item, id: `${item.id.split('~')[0].slice(0, 60)}~${date}`, date, done: false, completedAt: 0, notifiedFor: '', snoozeUntil: 0, nextId: '',
      repeatDay: item.repeatDay || deIso(item.date).getDate(),
      createdAt: Date.now(), updatedAt: Date.now(),
      subtasks: item.subtasks.map(s => ({ ...s, id: novoId(), done: false }))
    });
  }

  function vencido(item, agora) {
    if (item.done || !item.date) return false;
    const n = agora || new Date();
    const h = isoDe(n);
    if (item.date !== h) return item.date < h;
    return !!item.time && item.time < horaDe(n);
  }

  /* Instante do aviso em ms, ou 0 se não houver. */
  function momentoDoAviso(item, horaPadrao) {
    if (item.done || !item.date || item.lead === -1) return 0;
    if (item.snoozeUntil) return item.snoozeUntil;
    return deIso(item.date, item.time || horaPadrao || '09:00').getTime() - item.lead * 60000;
  }

  /* ---------- Agenda (.ics) ---------- */

  function escaparIcs(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
  }

  /* O formato limita cada linha a 75 bytes; a continuação começa com espaço. */
  function dobrarLinha(linha) {
    const cod = new TextEncoder();
    const saida = [];
    let atual = '', bytes = 0;
    for (const c of linha) {
      const n = cod.encode(c).length;
      if (bytes + n > 74) { saida.push(atual); atual = ' '; bytes = 1; }
      atual += c;
      bytes += n;
    }
    saida.push(atual);
    return saida.join('\r\n');
  }

  function gerarIcs(itens, horaPadrao) {
    const compacta = iso => iso.replace(/-/g, '');
    const carimbo = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
    const regra = i => ({
      daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'FREQ=WEEKLY',
      monthly: 'FREQ=MONTHLY', yearly: 'FREQ=YEARLY'
    }[i.repeat]);
    const l = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//O.M.E.G.A.//Lembretes//PT-BR', 'CALSCALE:GREGORIAN'];
    for (const i of itens) {
      if (!i.date) continue;
      l.push('BEGIN:VEVENT', `UID:${escaparIcs(i.id)}@omega-lembretes`, `DTSTAMP:${carimbo}`);
      if (i.time) {
        const fim = new Date(deIso(i.date, i.time).getTime() + 30 * 60000);
        l.push(`DTSTART:${compacta(i.date)}T${i.time.replace(':', '')}00`,
          `DTEND:${compacta(isoDe(fim))}T${horaDe(fim).replace(':', '')}00`);
      } else {
        l.push(`DTSTART;VALUE=DATE:${compacta(i.date)}`, `DTEND;VALUE=DATE:${compacta(somaDias(i.date, 1))}`);
      }
      if (regra(i)) l.push(`RRULE:${regra(i)}`);
      l.push(`SUMMARY:${escaparIcs(i.title)}`);
      const corpo = [i.description, ...i.subtasks.map(s => `- ${s.text}`)].filter(Boolean).join('\n');
      if (corpo) l.push(`DESCRIPTION:${escaparIcs(corpo)}`);
      if (i.lead !== -1) {
        /* Sem horário, o evento começa à meia-noite; o aviso é deslocado até a hora padrão. */
        let min = -i.lead;
        if (!i.time) { const [h, m] = (horaPadrao || '09:00').split(':').map(Number); min += h * 60 + m; }
        l.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escaparIcs(i.title)}`,
          `TRIGGER:${min < 0 ? '-' : ''}PT${Math.abs(min)}M`, 'END:VALARM');
      }
      l.push('END:VEVENT');
    }
    l.push('END:VCALENDAR');
    return l.map(dobrarLinha).join('\r\n') + '\r\n';
  }

  const api = {
    dois, isoDe, deIso, horaDe, hoje, somaDias, somaMeses, diasEntre, dataValida, horaValida,
    PRIORIDADES, REPETICOES, ANTECEDENCIAS, novoId, normalizar, proximaData, proximaOcorrencia,
    vencido, momentoDoAviso, gerarIcs
  };
  raiz.OmegaDados = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
