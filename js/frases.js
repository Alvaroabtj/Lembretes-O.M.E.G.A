/* O.M.E.G.A. — entende frases como "Pagar internet todo dia 10 às 9h #casa !alta". */
(function (raiz) {
  'use strict';

  const D = raiz.OmegaDados || (typeof require !== 'undefined' && require('./dados.js'));

  /* Marca um trecho já entendido. Não é espaço, então uma regra não "pula" por cima dele. */
  const USADO = '\u0001';

  /* Minúsculas e sem acento, mantendo o mesmo comprimento (os índices valem nos dois textos). */
  const dobrar = s => s.split('').map(c => (c.normalize('NFD').charAt(0).toLowerCase().charAt(0)) || c).join('');

  const SEMANA = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
  const MESES = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
  const NUMEROS = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, quinze: 15, vinte: 20, trinta: 30 };
  const DIAS = Object.keys(SEMANA).join('|');
  const NUM = `\\d{1,3}|${Object.keys(NUMEROS).join('|')}`;
  const NOME_MES = 'janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez';

  function proximoDiaDaSemana(hoje, dia, incluiHoje) {
    const dif = (dia - D.deIso(hoje).getDay() + 7) % 7;
    return D.somaDias(hoje, dif || (incluiHoje ? 0 : 7));
  }

  /* Próximo "dia N" a partir de hoje; pula meses que não têm esse dia. */
  function proximoDiaDoMes(hoje, dia) {
    if (dia < 1 || dia > 31) return '';
    for (let i = 0; i < 12; i++) {
      const iso = D.somaMeses(hoje.slice(0, 8) + '01', i, dia);
      if (D.deIso(iso).getDate() === dia && iso >= hoje) return iso;
    }
    return '';
  }

  function dataCheia(hoje, dia, mes, ano) {
    if (ano && ano < 100) ano += 2000;
    let a = ano || Number(hoje.slice(0, 4));
    let iso = `${a}-${D.dois(mes)}-${D.dois(dia)}`;
    if (!ano && D.dataValida(iso) && iso < hoje) iso = `${++a}-${D.dois(mes)}-${D.dois(dia)}`;
    return D.dataValida(iso) ? iso : '';
  }

  /**
   * ignorar: tipos que a pessoa descartou clicando na etiqueta
   * ('categoria' | 'prioridade' | 'repetir' | 'data' | 'hora').
   */
  function interpretar(entrada, agora, ignorar) {
    agora = agora || new Date();
    ignorar = ignorar || new Set();
    const hoje = D.isoDe(agora);
    let original = String(entrada || '').normalize('NFC');
    let texto = dobrar(original);
    const r = { title: '', date: '', time: '', priority: '', category: '', repeat: '', repeatDay: 0 };

    function tentar(tipo, regra, acao) {
      if (ignorar.has(tipo)) return false;
      const m = regra.exec(texto);
      if (!m || acao(m) === false) return false;
      const fim = m.index + m[0].length;
      const tampa = USADO.repeat(m[0].length);
      original = original.slice(0, m.index) + tampa + original.slice(fim);
      texto = texto.slice(0, m.index) + tampa + texto.slice(fim);
      return true;
    }
    const primeira = (tipo, regras) => regras.some(([regra, acao]) => tentar(tipo, regra, acao));

    /* Lista: #casa */
    tentar('categoria', /(?:^|\s)#([a-z0-9_-]{1,30})/, m => {
      const ini = m.index + m[0].indexOf('#') + 1;
      r.category = original.slice(ini, ini + m[1].length).replace(/_/g, ' ');
    });

    /* Prioridade: !alta, !media, !baixa, !1, !2, !3 */
    tentar('prioridade', /(?:^|\s)!(alta|media|baixa|[123])(?![a-z0-9])/, m => {
      r.priority = { alta: 'high', 1: 'high', media: 'medium', 2: 'medium', baixa: 'low', 3: 'low' }[m[1]];
    });

    /* Repetição */
    primeira('repetir', [
      [/\b(?:em |no )?(?:todo|cada) dia util\b|\b(?:nos |em )?(?:todos os )?dias uteis\b|\bde segunda a sexta\b/, () => {
        r.repeat = 'weekdays';
        let d = hoje;
        while ([0, 6].includes(D.deIso(d).getDay())) d = D.somaDias(d, 1);
        r.date = d;
      }],
      [/\btodo (?:o )?dia (\d{1,2})\b(?![:\/])/, m => {
        const d = proximoDiaDoMes(hoje, Number(m[1]));
        if (!d) return false;
        r.repeat = 'monthly'; r.date = d; r.repeatDay = Number(m[1]);
      }],
      [new RegExp(`\\btod[oa]s? (?:as |os |a |o )?(${DIAS})s?(?:[- ]feiras?)?\\b`), m => {
        r.repeat = 'weekly'; r.date = proximoDiaDaSemana(hoje, SEMANA[m[1]], true);
      }],
      [/\b(?:todo (?:o )?(?:santo )?dia|todos os dias|diariamente)\b/, () => { r.repeat = 'daily'; }],
      [/\b(?:toda (?:a )?semana|todas as semanas|semanalmente)\b/, () => { r.repeat = 'weekly'; }],
      [/\b(?:todo (?:o )?mes|todos os meses|mensalmente)\b/, () => { r.repeat = 'monthly'; }],
      [/\b(?:todo (?:o )?ano|todos os anos|anualmente)\b/, () => { r.repeat = 'yearly'; }]
    ]);

    /* Prazo relativo: "daqui a 2 horas", "em 3 dias" */
    let relativoComHora = false;
    tentar('data', new RegExp(`\\b(?:daqui a|daqui|em|dentro de) (${NUM}) ?(minutos?|mins?|horas?|hrs?|h|dias?|semanas?|mes(?:es)?|anos?)\\b`), m => {
      const n = Number(m[1]) || NUMEROS[m[1]];
      const u = m[2];
      if (!n) return false;
      if (/^(min|h)/.test(u)) {
        if (ignorar.has('hora')) return false;
        const alvo = new Date(agora.getTime() + n * (u[0] === 'h' ? 3600000 : 60000));
        r.date = D.isoDe(alvo);
        r.time = D.horaDe(alvo);
        relativoComHora = true;
      } else if (u.startsWith('dia')) r.date = D.somaDias(hoje, n);
      else if (u.startsWith('sem')) r.date = D.somaDias(hoje, n * 7);
      else if (u.startsWith('mes')) r.date = D.somaMeses(hoje, n);
      else r.date = D.somaMeses(hoje, n * 12);
    });

    /* Data */
    const ordinal = ' (?:via|vias|parte|vez|fase|etapa|opcao|chance|dose|mao|edicao|temporada|aula|prova|rodada)\\b';
    if (!relativoComHora) primeira('data', [
      [/\b(?:(?:para|pra) )?depois de amanha\b/, () => { r.date = D.somaDias(hoje, 2); }],
      [/\b(?:(?:para|pra|de|ate) )?amanha\b/, () => { r.date = D.somaDias(hoje, 1); }],
      [/\b(?:(?:para|pra|de|ate) )?hoje\b/, () => { r.date = hoje; }],
      [/\b(?:na |pra |para a )?(?:proxima semana|semana que vem)\b/, () => { r.date = proximoDiaDaSemana(hoje, 1, false); }],
      [/\b(?:no |pro |para o )?(?:proximo mes|mes que vem)\b/, () => { r.date = D.somaMeses(hoje, 1); }],
      [/\b(?:em |no dia |dia |ate |ate o dia )?(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d\/])/, m => {
        const d = dataCheia(hoje, Number(m[1]), Number(m[2]), Number(m[3]) || 0);
        if (!d) return false;
        r.date = d;
      }],
      [new RegExp(`\\b(?:no dia |dia |em |ate )?(\\d{1,2})(?:o|º)? de (${NOME_MES})\\b(?: de (\\d{4}))?`), m => {
        const d = dataCheia(hoje, Number(m[1]), MESES[m[2].slice(0, 3)], Number(m[3]) || 0);
        if (!d) return false;
        r.date = d;
      }],
      [/\b(?:(?:no|para o|pro|ate o|ate) )?dia (\d{1,2})\b(?!:)/, m => {
        const d = proximoDiaDoMes(hoje, Number(m[1]));
        if (!d) return false;
        r.date = d;
      }],
      [new RegExp(`\\b(?:(?:para|pra|ate) )?(?:a |o |na |no |nesta |neste |nessa |nesse |esta |este |essa |esse )?(?:proxim[oa] )?(${DIAS})(?:[- ]feira)?\\b(?!${ordinal})(?: que vem)?`), m => {
        r.date = proximoDiaDaSemana(hoje, SEMANA[m[1]], false);
      }]
    ]);

    /* Horário */
    const hora = (h, min) => {
      h = Number(h); min = Number(min) || 0;
      if (h === 24 && !min) h = 0;
      if (h > 23 || min > 59) return false;
      r.time = `${D.dois(h)}:${D.dois(min)}`;
    };
    const craseEm = i => /[àÀ]/.test(original.charAt(i));
    if (!relativoComHora) primeira('hora', [
      [/\b(?:(?:ao?|as) )?meio[- ]dia\b/, () => hora(12)],
      [/\b(?:a )?meia[- ]noite\b/, () => hora(0)],
      [/\b(?:(?:as|das|pelas|a partir das) )?(\d{1,2})(?:(?::|h)(\d{2})| ?hs?| horas)?(?:min)? (?:da|de) (manha|tarde|noite|madrugada)\b/, m => {
        const tarde = m[3] === 'tarde' || m[3] === 'noite';
        const h = Number(m[1]);
        return hora(tarde && h < 12 ? h + 12 : h, m[2]);
      }],
      [/\b(?:(?:as|das|pelas|a partir das) )?(\d{1,2})(?::|h)(\d{2})(?:min|h)?\b/, m => hora(m[1], m[2])],
      [/\b(?:(?:as|das|pelas|a partir das) )?(\d{1,2}) ?hs?\b/, m => hora(m[1])],
      [/\bas (\d{1,2}) horas\b/, m => hora(m[1])],
      [/\bas (\d{1,2})\b/, m => (craseEm(m.index) ? hora(m[1]) : false)],
      [/\b(?:de|pela) manha\b/, () => hora(9)],
      [/\b(?:a|pela) tarde\b/, m => (craseEm(m.index) || m[0][0] === 'p' ? hora(14) : false)],
      [/\b(?:a|pela) noite\b/, m => (craseEm(m.index) || m[0][0] === 'p' ? hora(20) : false)]
    ]);

    /* Completa o que faltou */
    const agoraHora = D.horaDe(agora);
    if (r.time && !r.date) r.date = r.time > agoraHora ? hoje : D.somaDias(hoje, 1);
    if (r.repeat && !r.date) r.date = hoje;
    if (r.repeat === 'weekly' && r.time && r.date === hoje && r.time <= agoraHora) r.date = D.somaDias(r.date, 7);
    if (r.repeat === 'weekdays' && r.time && r.date === hoje && r.time <= agoraHora) {
      do r.date = D.somaDias(r.date, 1); while ([0, 6].includes(D.deIso(r.date).getDay()));
    }

    /* O que sobrou é o título; preposições soltas no fim saem junto com o que foi entendido. */
    const entendeuNoFim = /\u0001\s*$/.test(original);
    let titulo = original.replace(/\u0001+/g, ' ').replace(/\s+/g, ' ').trim();
    if (entendeuNoFim) titulo = titulo.replace(/(?:[\s,;-]+(?:às|as|em|no|na|para|pra|de|até|dia|e))+$/i, '');
    titulo = titulo.replace(/^[\s,;-]+|[\s,;-]+$/g, '').replace(/\s+([,;.])/g, '$1');
    r.title = titulo.slice(0, 100);
    return r;
  }

  const api = { interpretar, dobrar };
  raiz.OmegaFrases = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
