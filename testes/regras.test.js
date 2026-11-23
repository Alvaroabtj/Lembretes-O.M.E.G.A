'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/dados.js');
const { interpretar } = require('../js/frases.js');

const agora = new Date(2026, 10, 23, 15, 0); // segunda, 23/11/2026, 15h

/* frase => [título, data, hora, prioridade, lista, repetição] */
const FRASES = [
  ['Pagar internet todo dia 10 às 9h #casa !alta', 'Pagar internet|2026-12-10|09:00|high|casa|monthly'],
  ['Reunião amanhã 14h30', 'Reunião|2026-11-24|14:30|||'],
  ['Ligar para o João às 9', 'Ligar para o João|2026-11-24|09:00|||'],
  ['Ligar para o João às 18', 'Ligar para o João|2026-11-23|18:00|||'],
  ['Academia toda segunda 7h', 'Academia|2026-11-30|07:00|||weekly'],
  ['Academia toda segunda 19h', 'Academia|2026-11-23|19:00|||weekly'],
  ['Tomar remédio todo dia 8h', 'Tomar remédio|2026-11-24|08:00|||daily'],
  ['Emitir segunda via do boleto', 'Emitir segunda via do boleto|||||'],
  ['Dentista sexta-feira 10:15', 'Dentista|2026-11-27|10:15|||'],
  ['Entregar relatório dia 15/12', 'Entregar relatório|2026-12-15||||'],
  ['Aniversário da Ana 3 de março todo ano', 'Aniversário da Ana|2027-03-03||||yearly'],
  ['Tirar o bolo em 40 minutos', 'Tirar o bolo|2026-11-23|15:40|||'],
  ['Renovar seguro daqui a 2 semanas', 'Renovar seguro|2026-12-07||||'],
  ['Consulta depois de amanhã às 3 da tarde', 'Consulta|2026-11-25|15:00|||'],
  ['Cinema hoje à noite', 'Cinema|2026-11-23|20:00|||'],
  ['Bater ponto dias úteis 8:00', 'Bater ponto|2026-11-24|08:00|||weekdays'],
  ['Comprar 2 maçãs', 'Comprar 2 maçãs|||||'],
  ['Ler as 9 páginas', 'Ler as 9 páginas|||||'],
  ['Pagar cartão dia 31', 'Pagar cartão|2026-12-31||||'],
  ['Almoço meio-dia', 'Almoço|2026-11-24|12:00|||'],
  ['Prova 30/02', 'Prova 30/02|||||'],
  ['🎂 Bolo amanhã 10h', '🎂 Bolo|2026-11-24|10:00|||'],
  ['Sábado churrasco', 'churrasco|2026-11-28||||'],
  ['Revisar contrato até sexta', 'Revisar contrato|2026-11-27||||'],
  ['Café da manhã com a equipe quinta', 'Café da manhã com a equipe|2026-11-26||||'],
  ['#trabalho enviar nota !2 mês que vem', 'enviar nota|2026-12-23||medium|trabalho|']
];

for (const [frase, esperado] of FRASES) {
  test(`frase: ${frase}`, () => {
    const r = interpretar(frase, agora);
    assert.equal([r.title, r.date, r.time, r.priority, r.category, r.repeat].join('|'), esperado);
  });
}

test('etiqueta descartada volta a ser texto', () => {
  const r = interpretar('Dormir 8h por noite', agora, new Set(['hora']));
  assert.deepEqual([r.title, r.time, r.date], ['Dormir 8h por noite', '', '']);
});

const item = extra => D.normalizar({ id: 'a', title: 't', date: '2027-01-31', ...extra });

test('repetição', () => {
  const fev = D.proximaOcorrencia(item({ repeat: 'monthly' }), '2027-01-31');
  assert.equal(fev.date, '2027-02-28');
  assert.equal(D.proximaOcorrencia(fev, '2027-02-28').date, '2027-03-31');
  assert.equal(D.proximaOcorrencia(item({ date: '2026-11-20', repeat: 'daily' }), '2026-11-23').date, '2026-11-23');
  assert.equal(D.proximaOcorrencia(item({ date: '2026-11-27', repeat: 'weekdays' }), '2026-11-27').date, '2026-11-30');
  assert.equal(D.proximaOcorrencia(item({ date: '2028-02-29', repeat: 'yearly' }), '2028-02-29').date, '2029-02-28');
  assert.equal(D.proximaOcorrencia(item({}), '2027-01-31'), null);
});

test('lembretes da versão 1 continuam válidos', () => {
  const v1 = { id: '1', title: 'Antigo', description: '', date: '2026-01-02', time: '08:00', priority: 'high', done: true, createdAt: 5, updatedAt: 9 };
  const n = D.normalizar(v1);
  assert.deepEqual([n.title, n.priority, n.done, n.completedAt, n.repeat], ['Antigo', 'high', true, 9, 'none']);
});

test('arquivo importado não injeta nada fora do modelo', () => {
  const n = D.normalizar({ id: '1', title: 'x', priority: '<img onerror=1>', repeat: '__proto__', lead: 'x', date: '2026-99-99', time: '10:00', extra: 1 });
  assert.deepEqual([n.priority, n.repeat, n.lead, n.date, n.time, n.extra], ['medium', 'none', 0, '', '', undefined]);
});

test('agenda: linhas de até 75 bytes e texto escapado', () => {
  const ics = D.gerarIcs([item({ title: 'Reunião; com vírgula, e um título bem comprido: ação, coração, opção e mais ação', time: '23:50', lead: 10 })]);
  for (const l of ics.split('\r\n')) assert.ok(Buffer.byteLength(l) <= 75, l);
  assert.ok(ics.includes('SUMMARY:Reunião\\; com vírgula\\,'));
  assert.match(ics, /DTEND:20270201T002000/);
  assert.match(ics, /TRIGGER:-PT10M/);
});
