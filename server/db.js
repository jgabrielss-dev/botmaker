const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

function resolveDataDir() {
  const candidates = [
    process.env.DATA_DIR,
    path.join(__dirname, '..', 'data'),
    path.join(os.tmpdir(), 'botmaker-data')
  ].filter(Boolean);

  const persistent = !!process.env.DATA_DIR;
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-test');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      if (process.env.DATA_DIR && dir !== process.env.DATA_DIR) {
        console.warn(`AVISO: DATA_DIR="${process.env.DATA_DIR}" nao esta gravavel. Usando ${dir}`);
        if (persistent) console.warn('AVISO: sem disco/volume persistente, os dados serao APAGADOS a cada reinicio.');
      }
      return dir;
    } catch (e) {
      console.warn(`AVISO: nao foi possivel usar "${dir}" (${e.code || e.message})`);
    }
  }
  throw new Error('Nenhum diretorio gravavel encontrado para o banco de dados');
}

const DATA_DIR = resolveDataDir();
console.log('Banco de dados em: ' + DATA_DIR);

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL UNIQUE,
  secret TEXT NOT NULL DEFAULT '',
  flow_id INTEGER,
  webhook_url TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT 'Fluxo',
  data TEXT NOT NULL DEFAULT '{"start":"","order":[],"nodes":{}}',
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  flow_id INTEGER,
  node_key TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  payment_id INTEGER,
  last_activity INTEGER NOT NULL DEFAULT 0,
  last_reminder INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(bot_id, chat_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  flow_id INTEGER,
  node_key TEXT DEFAULT '',
  mp_id TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  amount REAL NOT NULL DEFAULT 0,
  qr_code TEXT DEFAULT '',
  qr_base64 TEXT DEFAULT '',
  ticket_url TEXT DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(bot_id, chat_id)
);

/* Chats que o bot ja viu (para descobrir grupos/IDs sem digitar na mao). */
CREATE TABLE IF NOT EXISTS bot_chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(bot_id, chat_id)
);
`);

/* ---------- Migracoes leves (colunas novas em bancos ja existentes) ---------- */
function hasColumn(table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  } catch (e) {
    return false;
  }
}
function addColumn(table, column, ddl) {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumn('clients', 'first_name', "first_name TEXT NOT NULL DEFAULT ''");
addColumn('clients', 'last_name', "last_name TEXT NOT NULL DEFAULT ''");
addColumn('clients', 'username', "username TEXT NOT NULL DEFAULT ''");
addColumn('clients', 'last_seen', 'last_seen INTEGER NOT NULL DEFAULT 0');

db.DATA_DIR = DATA_DIR;
module.exports = db;
