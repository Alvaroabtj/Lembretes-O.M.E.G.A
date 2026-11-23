'use strict';

/* Banco do servidor: SQLite embutido no Node (sem dependências). */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const LIMITE_REGISTROS = 10000;

function abrirBanco(arquivo) {
  if (arquivo !== ':memory:') fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS usuarios (
      id       TEXT PRIMARY KEY,
      email    TEXT NOT NULL UNIQUE,
      nome     TEXT NOT NULL,
      senha    TEXT NOT NULL,
      criado   INTEGER NOT NULL,
      rev      INTEGER NOT NULL DEFAULT 0,
      agenda   TEXT UNIQUE
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sessoes (
      token    TEXT PRIMARY KEY,
      usuario  TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      criada   INTEGER NOT NULL,
      expira   INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessoes_usuario ON sessoes(usuario);

    /* Lembretes e listas. 'alterado' decide conflitos; 'rev' diz o que cada aparelho ainda não viu. */
    CREATE TABLE IF NOT EXISTS registros (
      usuario  TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      tipo     TEXT NOT NULL CHECK (tipo IN ('lembrete', 'lista')),
      id       TEXT NOT NULL,
      dados    TEXT,
      apagado  INTEGER NOT NULL DEFAULT 0,
      alterado INTEGER NOT NULL,
      rev      INTEGER NOT NULL,
      PRIMARY KEY (usuario, tipo, id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS registros_rev ON registros(usuario, rev);
  `);

  const q = sql => db.prepare(sql);
  const s = {
    criarUsuario: q('INSERT INTO usuarios (id, email, nome, senha, criado) VALUES (?, ?, ?, ?, ?)'),
    porEmail: q('SELECT * FROM usuarios WHERE email = ?'),
    porId: q('SELECT * FROM usuarios WHERE id = ?'),
    porAgenda: q('SELECT * FROM usuarios WHERE agenda = ?'),
    trocarSenha: q('UPDATE usuarios SET senha = ? WHERE id = ?'),
    trocarNome: q('UPDATE usuarios SET nome = ? WHERE id = ?'),
    trocarAgenda: q('UPDATE usuarios SET agenda = ? WHERE id = ?'),
    trocarRev: q('UPDATE usuarios SET rev = ? WHERE id = ?'),
    apagarUsuario: q('DELETE FROM usuarios WHERE id = ?'),
    criarSessao: q('INSERT INTO sessoes (token, usuario, criada, expira) VALUES (?, ?, ?, ?)'),
    sessao: q('SELECT u.* FROM sessoes s JOIN usuarios u ON u.id = s.usuario WHERE s.token = ? AND s.expira > ?'),
    apagarSessao: q('DELETE FROM sessoes WHERE token = ?'),
    apagarSessoes: q('DELETE FROM sessoes WHERE usuario = ?'),
    limparSessoes: q('DELETE FROM sessoes WHERE expira <= ?'),
    registro: q('SELECT * FROM registros WHERE usuario = ? AND tipo = ? AND id = ?'),
    gravarRegistro: q(`INSERT INTO registros (usuario, tipo, id, dados, apagado, alterado, rev) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (usuario, tipo, id) DO UPDATE SET
        dados = excluded.dados, apagado = excluded.apagado, alterado = excluded.alterado, rev = excluded.rev`),
    desde: q('SELECT * FROM registros WHERE usuario = ? AND rev > ? ORDER BY rev LIMIT ?'),
    lembretes: q("SELECT dados FROM registros WHERE usuario = ? AND tipo = 'lembrete' AND apagado = 0"),
    contar: q('SELECT count(*) AS n FROM registros WHERE usuario = ? AND apagado = 0')
  };

  function transacao(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  const saida = x => ({
    tipo: x.tipo, id: x.id, alterado: x.alterado, apagado: !!x.apagado,
    dados: x.apagado ? null : JSON.parse(x.dados)
  });

  /**
   * Recebe as mudanças do aparelho e devolve o que ele ainda não viu.
   * Vence a alteração mais recente; quem perdeu recebe de volta a versão do servidor.
   */
  function sincronizar(usuario, desde, mudancas, pagina) {
    return transacao(() => {
      let rev = s.porId.get(usuario).rev;
      let total = s.contar.get(usuario).n;
      const gravadas = new Set();
      const perdidas = [];
      for (const m of mudancas) {
        const atual = s.registro.get(usuario, m.tipo, m.id);
        if (atual && atual.alterado >= m.alterado) {
          if (atual.alterado > m.alterado) perdidas.push(atual);
          else gravadas.add(`${m.tipo}:${m.id}:${atual.rev}`);
          continue;
        }
        const vivoAntes = atual && !atual.apagado ? 1 : 0;
        total += (m.apagado ? 0 : 1) - vivoAntes;
        if (!m.apagado && total > LIMITE_REGISTROS) throw Object.assign(new Error('limite'), { limite: LIMITE_REGISTROS });
        s.gravarRegistro.run(usuario, m.tipo, m.id, m.apagado ? null : JSON.stringify(m.dados), m.apagado ? 1 : 0, m.alterado, ++rev);
        gravadas.add(`${m.tipo}:${m.id}:${rev}`);
      }
      s.trocarRev.run(rev, usuario);

      const linhas = s.desde.all(usuario, desde, pagina + 1);
      const haMais = linhas.length > pagina;
      const pag = linhas.slice(0, pagina);
      const novas = pag.filter(x => !gravadas.has(`${x.tipo}:${x.id}:${x.rev}`));
      const naPagina = new Set(pag.map(x => `${x.tipo}:${x.id}`));
      const extras = perdidas.filter(x => !naPagina.has(`${x.tipo}:${x.id}`));
      return {
        rev: haMais ? pag[pag.length - 1].rev : rev,
        haMais,
        mudancas: [...novas, ...extras].map(saida)
      };
    });
  }

  return {
    s, sincronizar, transacao,
    lembretesDe: usuario => s.lembretes.all(usuario).map(x => JSON.parse(x.dados)),
    fechar: () => db.close()
  };
}

module.exports = { abrirBanco, LIMITE_REGISTROS };
