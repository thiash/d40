'use strict';
// ===========================================================================
//  D40 – Speicher: Konten, Charaktere und Anmeldungen
//
//  Ohne DATABASE_URL liegt alles nur im Arbeitsspeicher. Zum Testen reicht das,
//  aber nach einem Neustart des Servers ist alles weg.
//  Mit DATABASE_URL (Postgres, zum Beispiel bei Neon) bleibt alles erhalten.
//  Zur Datenbank gibt es zwei Wege, der erste, der funktioniert, wird benutzt:
//    1. das Paket "pg", der übliche Postgres-Treiber, falls es installiert ist
//    2. Neons HTTP-Schnittstelle über fetch, die ganz ohne Zusatzpaket auskommt
//
//  Passwörter werden nie im Klartext gespeichert, sondern mit scrypt gehasht.
//  Auch die Anmelde-Schlüssel, die sich ein Gerät merkt, liegen nur gehasht vor.
// ===========================================================================

const crypto = require('crypto');

const SESSION_DAYS = 60;                     // so lange merkt sich ein Gerät die Anmeldung
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function log(text) {
  console.log(`[${new Date().toLocaleTimeString('de-DE')}] ${text}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Passwörter und Anmelde-Schlüssel
// ---------------------------------------------------------------------------
function scryptAsync(pass, salt, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pass, salt, opts.keylen, { N: opts.N, r: opts.r, p: opts.p }, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
}

// Ergebnis: "scrypt$N$r$p$salz$hash" – die Parameter stehen dabei, damit sie
// sich später erhöhen lassen, ohne alte Passwörter ungültig zu machen.
async function hashPassword(pass) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(pass.normalize('NFC'), salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(pass, stored) {
  if (typeof pass !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const want = Buffer.from(parts[5], 'base64');
  if (!want.length) return false;
  try {
    const got = await scryptAsync(pass.normalize('NFC'), salt, { N, r, p, keylen: want.length });
    return crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// ---------------------------------------------------------------------------
// Name und Passwort prüfen
// ---------------------------------------------------------------------------
const LETTER = 'A-Za-zÄÖÜäöüß';
const NAME_RE = new RegExp(`^[${LETTER}][${LETTER}0-9]*(?:[ -][${LETTER}0-9]+)*$`);
const RESERVED = new Set([
  'admin', 'administrator', 'system', 'server', 'moderator', 'mod', 'gm', 'support',
  'wache', 'stadtwache', 'niemand', 'd40', 'claude', 'anthropic',
]);

function checkName(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'Bitte gib einen Namen ein.' };
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 16) return { ok: false, error: 'Der Name braucht 3 bis 16 Zeichen.' };
  if (!NAME_RE.test(name)) {
    return { ok: false, error: 'Erlaubt sind Buchstaben, Ziffern, Leerzeichen und Bindestriche. Am Anfang steht ein Buchstabe.' };
  }
  const key = name.toLowerCase();
  if (RESERVED.has(key)) return { ok: false, error: 'Dieser Name ist reserviert. Wähle einen anderen.' };
  return { ok: true, name, key };
}

function checkPassword(raw) {
  if (typeof raw !== 'string' || raw.length < 6) return { ok: false, error: 'Das Passwort braucht mindestens 6 Zeichen.' };
  if (raw.length > 72) return { ok: false, error: 'Das Passwort darf höchstens 72 Zeichen haben.' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Speicher im Arbeitsspeicher – ohne Datenbank, geht beim Neustart verloren
// ---------------------------------------------------------------------------
class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.persistent = false;
    this.configError = null;
    this.accounts = new Map();               // name_key → { id, name, pass }
    this.characters = new Map();             // id → JSON-Text
    this.sessions = new Map();               // token_hash → { id, lastUsed }
    this.nextId = 1;
  }
  async init() {}
  async findAccount(key) {
    const a = this.accounts.get(key);
    return a ? { ...a } : null;
  }
  async createAccount(name, key, pass) {
    if (this.accounts.has(key)) return null;
    const id = this.nextId++;
    this.accounts.set(key, { id, name, pass });
    return id;
  }
  async loadCharacter(id) {
    const json = this.characters.get(id);
    return json ? JSON.parse(json) : null;
  }
  async saveCharacter(id, data) {
    this.characters.set(id, JSON.stringify(data));
  }
  async createSession(tokenHash, id) {
    this.sessions.set(tokenHash, { id, lastUsed: Date.now() });
  }
  async findSession(tokenHash) {
    const s = this.sessions.get(tokenHash);
    if (!s) return null;
    if (Date.now() - s.lastUsed > SESSION_DAYS * 86400000) {
      this.sessions.delete(tokenHash);
      return null;
    }
    s.lastUsed = Date.now();
    for (const a of this.accounts.values()) if (a.id === s.id) return { id: a.id, name: a.name };
    return null;
  }
  async deleteSession(tokenHash) {
    this.sessions.delete(tokenHash);
  }
  describe(err) {
    return (err && err.message) || String(err);
  }
  status() {
    return { kind: 'memory', persistent: false, state: this.configError ? 'error' : 'ready', error: this.configError };
  }
}

// ---------------------------------------------------------------------------
// Postgres – Tabellen und Abfragen
// Jede Anweisung einzeln: Abfragen mit Parametern erlauben keine Mehrfach-Befehle.
// Alle Spalten kommen als Text zurück (::text), damit beide Wege gleich aussehen.
// Zahlen-Parameter werden ausdrücklich umgewandelt (::bigint), denn je nach Weg
// kommen alle Parameter als Text an.
// ---------------------------------------------------------------------------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS d40_accounts (
     id BIGSERIAL PRIMARY KEY,
     name TEXT NOT NULL,
     name_key TEXT NOT NULL UNIQUE,
     pass TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_login TIMESTAMPTZ
   )`,
  `CREATE TABLE IF NOT EXISTS d40_characters (
     account_id BIGINT PRIMARY KEY REFERENCES d40_accounts (id) ON DELETE CASCADE,
     data JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS d40_sessions (
     token_hash TEXT PRIMARY KEY,
     account_id BIGINT NOT NULL REFERENCES d40_accounts (id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_used TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  'CREATE INDEX IF NOT EXISTS d40_sessions_account ON d40_sessions (account_id)',
];

const SQL = {
  ping: 'SELECT 1 AS ok',
  cleanup: `DELETE FROM d40_sessions WHERE last_used < now() - interval '${SESSION_DAYS} days'`,
  findAccount: 'SELECT id::text AS id, name, pass FROM d40_accounts WHERE name_key = $1',
  createAccount: 'INSERT INTO d40_accounts (name, name_key, pass) VALUES ($1, $2, $3) '
    + 'ON CONFLICT (name_key) DO NOTHING RETURNING id::text AS id',
  touchAccount: 'UPDATE d40_accounts SET last_login = now() WHERE id = $1::bigint',
  loadCharacter: 'SELECT data::text AS data FROM d40_characters WHERE account_id = $1::bigint',
  saveCharacter: 'INSERT INTO d40_characters (account_id, data, updated_at) VALUES ($1::bigint, $2::jsonb, now()) '
    + 'ON CONFLICT (account_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
  createSession: 'INSERT INTO d40_sessions (token_hash, account_id) VALUES ($1, $2::bigint)',
  findSession: 'SELECT a.id::text AS id, a.name FROM d40_sessions s JOIN d40_accounts a ON a.id = s.account_id '
    + `WHERE s.token_hash = $1 AND s.last_used > now() - interval '${SESSION_DAYS} days'`,
  touchSession: 'UPDATE d40_sessions SET last_used = now() WHERE token_hash = $1',
  deleteSession: 'DELETE FROM d40_sessions WHERE token_hash = $1',
};

function toParam(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function transient(err, yes) {               // vorübergehender Fehler: einmal neu versuchen lohnt sich
  err.transient = yes;
  return err;
}

async function withRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!err || !err.transient) throw err;
    await sleep(800);
    return fn();
  }
}

// Weg 1: das Paket "pg"
function loadPg() {
  try {
    return require('pg');
  } catch {
    return null;
  }
}

function pgUrl(url) {
  const u = new URL(url);
  u.searchParams.delete('channel_binding');  // verlangt nur der Client, Neon braucht es nicht
  if (!u.searchParams.has('sslmode')) u.searchParams.set('sslmode', 'require');
  return u.toString();
}

function pgDriver(pg, url) {
  const pool = new pg.Pool({
    connectionString: pgUrl(url),
    max: 3,
    idleTimeoutMillis: 10000,                // ungenutzte Verbindungen schließen, damit Neon einschlafen kann
    connectionTimeoutMillis: 15000,
    allowExitOnIdle: true,
  });
  pool.on('error', () => {});                // abgerissene Leerlauf-Verbindungen: die nächste Abfrage baut neu auf
  return {
    name: 'pg',
    async query(sql, params) {
      try {
        const res = await pool.query(sql, params);
        return res.rows;
      } catch (err) {
        const state = typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) ? err.code : null;
        throw transient(err, !state || state.startsWith('08') || state === '57P01' || state === '57P03');
      }
    },
    close: () => pool.end().catch(() => {}),
  };
}

// Weg 2: Neons HTTP-Schnittstelle. Aus ep-name.region.aws.neon.tech wird
// api.region.aws.neon.tech/sql – genau so macht es Neons eigener Treiber.
function httpEndpoint(url) {
  const host = new URL(url).hostname;
  return `https://${host.replace(/^[^.]+\./, 'api.')}/sql`;
}

function httpDriver(url, opts = {}) {
  const endpoint = opts.endpoint || httpEndpoint(url);
  const timeoutMs = opts.timeoutMs || 15000;
  return {
    name: 'Neon-HTTP',
    endpoint,
    async query(sql, params) {
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Neon-Connection-String': url,
            'Neon-Raw-Text-Output': 'true',
            'Neon-Array-Mode': 'true',
          },
          body: JSON.stringify({ query: sql, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const why = (err.cause && (err.cause.code || err.cause.message)) || err.name || err.message;
        throw transient(new Error(`Netzwerkfehler (${why})`), true);
      }
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* keine JSON-Antwort */ }
      if (!res.ok) {
        const err = new Error(body && body.message ? body.message : `HTTP ${res.status}: ${text.slice(0, 120)}`);
        if (body && body.code) err.code = body.code;
        throw transient(err, res.status >= 500 || res.status === 429);
      }
      if (!body || typeof body !== 'object') throw new Error('Unerwartete Antwort der Datenbank');
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const names = Array.isArray(body.fields) ? body.fields.map((f) => f.name) : [];
      return rows.map((row) => (Array.isArray(row)
        ? Object.fromEntries(row.map((v, i) => [names[i] || String(i), v]))
        : row));
    },
    close: async () => {},
  };
}

// Geheimnisse aus Fehlermeldungen entfernen: weder die Adresse noch das Passwort
// dürfen in Protokollen oder auf der Statusseite auftauchen.
function secretsOf(url) {
  const out = [url];
  try {
    const u = new URL(url);
    if (u.password) out.push(u.password, decodeURIComponent(u.password));
  } catch { /* egal */ }
  return out.filter((s) => s && s.length >= 4);
}

class SqlStore {
  constructor(url, opts = {}) {
    this.url = url;
    this.opts = opts;
    this.kind = 'postgres';
    this.persistent = true;
    this.driver = null;
    this.ready = null;
    this.lastError = null;
    this.secrets = secretsOf(url);
  }

  describe(err) {
    let text = (err && err.message) || String(err);
    if (err && err.code && !text.includes(err.code)) text += ` [${err.code}]`;
    for (const s of this.secrets) text = text.split(s).join('***');
    return text.slice(0, 240);
  }

  // Verbindet erst bei Bedarf: Solange niemand spielt, darf die Datenbank schlafen.
  init() {
    if (!this.ready) {
      this.ready = this.connect().catch((err) => {
        this.ready = null;                   // beim nächsten Mal neu versuchen
        this.lastError = this.describe(err);
        throw err;
      });
    }
    return this.ready;
  }

  async connect() {
    if (this.driver) {                       // ein früherer Versuch scheiterte nach dem Verbinden
      await this.driver.close();
      this.driver = null;
    }
    const makers = [];
    const pg = this.opts.pg !== undefined ? this.opts.pg : loadPg();
    if (pg) makers.push(() => pgDriver(pg, this.url));
    makers.push(() => httpDriver(this.url, this.opts));
    const problems = [];
    for (const make of makers) {
      let d = null;
      try {
        d = make();
        await withRetry(() => d.query(SQL.ping, []));
        this.driver = d;
        break;
      } catch (err) {
        problems.push(`${d ? d.name : 'Treiber'}: ${this.describe(err)}`);
        log(`Datenbank über ${problems[problems.length - 1]}`);
        if (d) await d.close();
      }
    }
    if (!this.driver) throw new Error(problems.join(' | '));
    for (const sql of SCHEMA) await this.run(sql);
    await this.run(SQL.cleanup);
    this.lastError = null;
    log(`Datenbank bereit (über ${this.driver.name})`);
  }

  async q(sql, params = []) {
    await this.init();
    return this.run(sql, params);
  }

  async run(sql, params = []) {              // ohne auf init() zu warten – sonst blockiert sich connect() selbst
    try {
      const rows = await withRetry(() => this.driver.query(sql, params.map(toParam)));
      this.lastError = null;
      return rows;
    } catch (err) {
      this.lastError = this.describe(err);
      throw err;
    }
  }

  async findAccount(key) {
    const [row] = await this.q(SQL.findAccount, [key]);
    return row ? { id: Number(row.id), name: row.name, pass: row.pass } : null;
  }
  async createAccount(name, key, pass) {
    const [row] = await this.q(SQL.createAccount, [name, key, pass]);
    return row ? Number(row.id) : null;
  }
  async touchAccount(id) {
    await this.q(SQL.touchAccount, [id]);
  }
  async loadCharacter(id) {
    const [row] = await this.q(SQL.loadCharacter, [id]);
    if (!row || row.data === null || row.data === undefined) return null;
    return typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  }
  async saveCharacter(id, data) {
    await this.q(SQL.saveCharacter, [id, JSON.stringify(data)]);
  }
  async createSession(tokenHash, id) {
    await this.q(SQL.createSession, [tokenHash, id]);
  }
  async findSession(tokenHash) {
    const [row] = await this.q(SQL.findSession, [tokenHash]);
    if (!row) return null;
    await this.q(SQL.touchSession, [tokenHash]);   // gilt ab jetzt wieder volle 60 Tage
    return { id: Number(row.id), name: row.name };
  }
  async deleteSession(tokenHash) {
    await this.q(SQL.deleteSession, [tokenHash]);
  }

  status() {
    let state = 'idle';                      // noch nicht verbunden – niemand hat bisher gespielt
    if (this.lastError) state = 'error';
    else if (this.driver) state = 'ready';
    return { kind: this.driver ? this.driver.name : 'postgres', persistent: true, state, error: this.lastError };
  }
}

// ---------------------------------------------------------------------------
// Passenden Speicher wählen
// Aus Neons Verbindungsdialog wird manchmal mehr kopiert als nur die Adresse,
// zum Beispiel "psql '…'". Deshalb wird die Adresse aus dem Text herausgesucht.
// ---------------------------------------------------------------------------
function createStore(raw, opts = {}) {
  if (!raw || !String(raw).trim()) return new MemoryStore();
  const m = String(raw).match(/postgres(?:ql)?:\/\/[^\s'"]+/);
  let url = m ? m[0] : null;
  if (url) {
    try { new URL(url); } catch { url = null; }
  }
  if (!url) {
    const s = new MemoryStore();
    s.configError = 'DATABASE_URL enthält keine gültige postgresql://-Adresse. Gespeichert wird nur im Arbeitsspeicher.';
    log(s.configError);
    return s;
  }
  return new SqlStore(url, opts);
}

module.exports = {
  createStore, MemoryStore, SqlStore, SQL, SCHEMA, SESSION_DAYS,
  hashPassword, verifyPassword, newToken, hashToken, checkName, checkPassword,
  httpEndpoint, httpDriver, pgDriver, pgUrl, toParam,
};
