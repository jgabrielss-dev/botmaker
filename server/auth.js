const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 dias
const GENERATED_FILE = path.join(db.DATA_DIR, 'admin-password.txt');

/* remove aspas e espaços que costumam sobrar ao colar a senha no Railway */
function clean(pw) {
  let s = String(pw == null ? '' : pw).trim();
  if ((s.startsWith('"') && s.endsWith('"') && s.length > 1) || (s.startsWith("'") && s.endsWith("'") && s.length > 1)) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/* Se ADMIN_PASSWORD nao estiver definida, gera uma senha aleatoria na primeira
   execucao e guarda em DATA_DIR/admin-password.txt (em vez de usar "admin").
   Assim o painel nunca fica com senha padrao conhecida. */
let generatedCache = null;
function generatedPassword() {
  if (generatedCache) return generatedCache;
  try {
    const existing = fs.readFileSync(GENERATED_FILE, 'utf8').trim();
    if (existing) {
      generatedCache = existing;
      return generatedCache;
    }
  } catch (e) {
    /* ainda nao existe: sera criada abaixo */
  }
  const pw = crypto.randomBytes(18).toString('base64url');
  generatedCache = pw;
  try {
    fs.mkdirSync(db.DATA_DIR, { recursive: true });
    fs.writeFileSync(GENERATED_FILE, pw + '\n', { mode: 0o600 });
  } catch (e) {
    console.warn('AVISO: nao consegui gravar a senha gerada em ' + GENERATED_FILE + ': ' + e.message);
  }
  return pw;
}

function usingGeneratedPassword() {
  const raw = process.env.ADMIN_PASSWORD;
  return raw === undefined || raw === '';
}

function expectedPassword() {
  const raw = process.env.ADMIN_PASSWORD;
  if (raw === undefined || raw === '') return generatedPassword();
  return clean(raw);
}

function passwordIssues() {
  const raw = process.env.ADMIN_PASSWORD;
  if (!raw) return [];
  const out = [];
  if (raw !== raw.trim()) out.push('espaços sobrando');
  if (/^["'].*["']$/.test(raw.trim())) out.push('aspas');
  if (/[\r\n]/.test(raw)) out.push('quebra de linha');
  if (/^\[cole aqui\]$/i.test(raw.trim())) out.push('está com o texto de exemplo [cole aqui]');
  return out;
}

function sha256(v) {
  return crypto.createHash('sha256').update(String(v)).digest();
}

function login(password) {
  if (!password) return null;
  // comparacao em tempo constante (compara hashes de tamanho fixo)
  if (!crypto.timingSafeEqual(sha256(clean(password)), sha256(expectedPassword()))) return null;
  cleanupSessions();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, created_at) VALUES (?, ?)').run(token, Date.now());
  return token;
}

function valid(token) {
  if (!token) return false;
  const row = db.prepare('SELECT created_at FROM sessions WHERE token = ?').get(token);
  if (!row) return false;
  if (Date.now() - row.created_at > SESSION_TTL) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return false;
  }
  return true;
}

function logout(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token || '');
}

function cleanupSessions() {
  try {
    db.prepare('DELETE FROM sessions WHERE created_at < ?').run(Date.now() - SESSION_TTL);
  } catch (e) {
    /* nao deixa a limpeza derrubar o login */
  }
}

/* Decodifica sem estourar em cookie malformado (ex.: "sid=%E0%A4%A"). */
function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch (e) {
    return v;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = safeDecode(p.slice(i + 1).trim());
  });
  return out;
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  if (valid(cookies.sid)) return next();
  res.status(401).json({ error: 'Sessão expirada, entre novamente' });
}

module.exports = {
  login,
  logout,
  valid,
  requireAuth,
  parseCookies,
  passwordIssues,
  expectedPassword,
  usingGeneratedPassword,
  generatedPassword,
  cleanupSessions,
  SESSION_TTL
};
