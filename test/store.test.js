'use strict';
// Prüft den Datenbank-Speicher ohne echte Datenbank: Eine Attrappe spricht Neons
// HTTP-Protokoll (POST /sql) und spielt das Paket "pg" nach. Der echte Spielserver
// läuft dagegen – inklusive Neustart, Aussetzern und falschem Passwort.
const http = require('http');
const WebSocket = require('ws');
const S = require('../server/index.js');
const store = require('../server/store.js');

const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && extra ? '  (' + extra + ')' : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function safely(name, fn) {
  try { await fn(); } catch (err) { ok(name, false, err.stack); }
}

const SECRET = 'platzhalter_nur_fuer_tests';
const URL_ = `postgresql://neondb_owner:${SECRET}@ep-cool-river-a1b2c3d4.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`;

// ---------------------------------------------------------------------------
// Attrappe einer Postgres-Datenbank, die genau unsere Anweisungen versteht
// ---------------------------------------------------------------------------
function makeEngine() {
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const known = new Map();
  const db = { accounts: new Map(), chars: new Map(), sessions: new Map(), nextId: 1, schema: [], calls: 0 };
  const sqlErr = (message, code) => Object.assign(new Error(message), { sqlState: code });
  const one = (row) => [row];
  for (const s of store.SCHEMA) known.set(norm(s), () => { db.schema.push(norm(s).slice(0, 40)); return []; });
  const Q = store.SQL;
  known.set(norm(Q.ping), () => one({ ok: '1' }));
  known.set(norm(Q.cleanup), () => {
    for (const [h, s] of db.sessions) if (Date.now() - s.lastUsed > 60 * 86400000) db.sessions.delete(h);
    return [];
  });
  known.set(norm(Q.findAccount), ([key]) => {
    const a = db.accounts.get(key);
    return a ? one({ id: String(a.id), name: a.name, pass: a.pass }) : [];
  });
  known.set(norm(Q.createAccount), ([name, key, pass]) => {
    if (db.accounts.has(key)) return [];
    const id = db.nextId++;
    db.accounts.set(key, { id, name, pass });
    return one({ id: String(id) });
  });
  known.set(norm(Q.touchAccount), () => []);
  known.set(norm(Q.loadCharacter), ([id]) => (db.chars.has(id) ? one({ data: db.chars.get(id) }) : []));
  known.set(norm(Q.saveCharacter), ([id, json]) => {
    try { JSON.parse(json); } catch { throw sqlErr('invalid input syntax for type json', '22P02'); }
    db.chars.set(id, json);
    return [];
  });
  known.set(norm(Q.createSession), ([hash, id]) => {
    if (db.sessions.has(hash)) throw sqlErr('duplicate key value violates unique constraint', '23505');
    db.sessions.set(hash, { id, lastUsed: Date.now() });
    return [];
  });
  known.set(norm(Q.findSession), ([hash]) => {
    const s = db.sessions.get(hash);
    if (!s || Date.now() - s.lastUsed > 60 * 86400000) return [];
    const a = [...db.accounts.values()].find((x) => String(x.id) === String(s.id));
    return a ? one({ id: String(a.id), name: a.name }) : [];
  });
  known.set(norm(Q.touchSession), ([hash]) => {
    const s = db.sessions.get(hash);
    if (s) s.lastUsed = Date.now();
    return [];
  });
  known.set(norm(Q.deleteSession), ([hash]) => { db.sessions.delete(hash); return []; });

  db.exec = (sql, params) => {
    db.calls++;
    const fn = known.get(norm(sql));
    if (!fn) throw sqlErr(`syntax error at or near "${norm(sql).slice(0, 20)}"`, '42601');
    const wanted = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    if (params.length !== wanted) throw sqlErr(`bind message supplies ${params.length} parameters, but statement requires ${wanted}`, '08P01');
    if (!params.every((p) => p === null || typeof p === 'string')) throw sqlErr('parameter must be text', '22023');
    return fn(params);
  };
  return db;
}

// Neons HTTP-Schnittstelle nachgebaut: prüft Kopfzeilen und antwortet im Array-Modus mit Text-Werten
function startFakeNeon(engine) {
  const fake = { engine, failNext: 0, down: false, reject: null, objectMode: false, requests: 0, badHeaders: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      fake.requests++;
      const reply = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const h = req.headers;
      if (req.method !== 'POST' || req.url !== '/sql' || h['neon-connection-string'] !== URL_
          || h['neon-raw-text-output'] !== 'true' || h['neon-array-mode'] !== 'true'
          || !/application\/json/.test(h['content-type'] || '')) {
        fake.badHeaders.push(`${req.method} ${req.url}`);
        return reply(400, { message: 'bad request' });
      }
      if (fake.down) return reply(500, { message: 'compute unavailable' });
      if (fake.failNext > 0) { fake.failNext--; return reply(503, { message: 'temporarily unavailable' }); }
      if (fake.reject) return reply(400, fake.reject);
      let q;
      try { q = JSON.parse(body); } catch { return reply(400, { message: 'invalid json' }); }
      try {
        const rows = engine.exec(q.query, q.params || []);
        const names = rows.length ? Object.keys(rows[0]) : [];
        reply(200, {
          command: 'OK', rowCount: rows.length,
          fields: names.map((name) => ({ name, dataTypeID: 25 })),
          rows: fake.objectMode ? rows : rows.map((r) => names.map((n) => r[n])),
          rowAsArray: !fake.objectMode,
        });
      } catch (err) {
        reply(400, { message: err.message, code: err.sqlState });
      }
    });
  });
  return new Promise((resolve) => server.listen(0, () => {
    fake.port = server.address().port;
    fake.endpoint = `http://localhost:${fake.port}/sql`;
    fake.close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
    resolve(fake);
  }));
}

// Das Paket "pg" nachgebaut – arbeitet auf derselben Attrappe
function fakePg(engine, mode = 'ok') {
  const seen = { configs: [] };
  class Pool {
    constructor(cfg) { seen.configs.push(cfg); }
    on() {}
    async query(sql, params) {
      if (mode === 'tls') throw Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
      try {
        return { rows: engine.exec(sql, params) };
      } catch (err) {
        throw Object.assign(new Error(err.message), { code: err.sqlState });
      }
    }
    async end() {}
  }
  return { Pool, seen };
}

// Kleiner Spiel-Client
class Client {
  constructor(port, auth) {
    this.msgs = [];
    this.waiters = [];
    this.ws = new WebSocket(`ws://localhost:${port}`);
    this.closed = new Promise((r) => this.ws.on('close', r));
    this.ws.on('message', (d) => {
      const m = JSON.parse(d);
      this.msgs.push(m);
      if (m.t === 'hello' && auth) this.ws.send(JSON.stringify(auth));
      if (m.t === 'auth') this.token = m.token;
      if (m.t === 'welcome') this.welcome = m;
      this.waiters = this.waiters.filter((w) => !w(m));
    });
  }
  waitFor(pred, ms = 5000) {
    const found = this.msgs.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Zeitüberschreitung')), ms);
      this.waiters.push((m) => { if (pred(m)) { clearTimeout(t); resolve(m); return true; } return false; });
    });
  }
  answer() { return this.waitFor((m) => m.t === 'welcome' || m.t === 'denied'); }
  get p() { return this.welcome && S.players.get(this.welcome.you.id); }
}

function getJson(port, path) {
  return new Promise((resolve) => {
    http.get({ host: 'localhost', port, path }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

(async () => {
  const origLog = console.log;
  console.log = (...args) => { if (!String(args[0]).startsWith('[')) origLog(...args); };   // Serverprotokoll ausblenden
  S.WORLD.maxEnemies = 0;

  // ---- Bausteine ----
  ok('HTTP-Adresse wird wie bei Neon gebildet',
    store.httpEndpoint(URL_) === 'https://api.eu-central-1.aws.neon.tech/sql'
    && store.httpEndpoint('postgresql://u:p@ep-x-pooler.us-east-2.aws.neon.tech/db') === 'https://api.us-east-2.aws.neon.tech/sql');
  const pu = new URL(store.pgUrl(URL_));
  ok('pg bekommt die Adresse mit SSL, aber ohne channel_binding',
    pu.searchParams.get('sslmode') === 'require' && !pu.searchParams.has('channel_binding') && pu.password === SECRET);
  ok('Fehlt sslmode, wird es ergänzt', new URL(store.pgUrl('postgresql://u:p@h.example/db')).searchParams.get('sslmode') === 'require');

  const st1 = store.createStore('');
  const st2 = store.createStore(`psql '${URL_}'\n`);
  const st3 = store.createStore('hier steht Quatsch');
  ok('Ohne DATABASE_URL: Arbeitsspeicher', st1.kind === 'memory' && !st1.persistent && !st1.configError);
  ok('Mitkopiertes "psql \'…\'" wird abgeschnitten', st2 instanceof store.SqlStore && st2.url === URL_);
  ok('Unbrauchbare DATABASE_URL: Arbeitsspeicher mit Hinweis', st3.kind === 'memory' && /keine gültige/.test(st3.configError)
    && st3.status().state === 'error');

  ok('Namen mit Umlauten und Bindestrich sind erlaubt', store.checkName('Jörg-Ölf').ok && store.checkName('Anna  Lena').name === 'Anna Lena');
  ok('Namen: Ziffer vorn, zu lang oder doppelter Bindestrich sind verboten',
    !store.checkName('1Tom').ok && !store.checkName('Abcdefghijklmnopq').ok && !store.checkName('Ab--cd').ok);
  ok('Passwort: 6 bis 72 Zeichen', !store.checkPassword('12345').ok && store.checkPassword('123456').ok && !store.checkPassword('x'.repeat(73)).ok);
  const h1 = await store.hashPassword('Mondlicht');
  const h2 = await store.hashPassword('Mondlicht');
  ok('Passwort-Hash: jedes Mal mit neuem Salz', h1 !== h2 && h1.startsWith('scrypt$16384$8$1$'));
  ok('Passwortprüfung: richtig, falsch, kaputt',
    (await store.verifyPassword('Mondlicht', h1)) && !(await store.verifyPassword('mondlicht', h1))
    && !(await store.verifyPassword('Mondlicht', 'scrypt$kaputt')) && !(await store.verifyPassword('Mondlicht', null)));

  // ---- Spielserver mit Datenbank über Neon-HTTP ----
  const engine = makeEngine();
  const fake = await startFakeNeon(engine);
  let db = new store.SqlStore(URL_, { pg: null, endpoint: fake.endpoint });
  let port = await S.start(0, { store: db });
  let mira = null, token = null;

  await safely('Anlegen über Neon-HTTP', async () => {
    ok('Beim Start keine Datenbank-Anfrage: Neon darf schlafen', fake.requests === 0);
    mira = new Client(port, { t: 'register', name: 'Mira', pass: 'Sternenstaub' });
    const hello = await mira.waitFor((m) => m.t === 'hello');
    ok('Begrüßung meldet dauerhaftes Speichern', hello.persist === true);
    const r = await mira.answer();
    ok('Neuer Charakter über die HTTP-Schnittstelle', r.t === 'welcome' && r.you.name === 'Mira', JSON.stringify(r));
    ok('Kopfzeilen und Adresse entsprechen Neons Protokoll', fake.badHeaders.length === 0, fake.badHeaders.join(', '));
    ok('Tabellen und Spalten werden angelegt', engine.schema.length === 6);
    await sleep(150);
    const acc = engine.accounts.get('mira');
    ok('Konto und Charakter liegen in der Datenbank', acc && acc.pass.startsWith('scrypt$') && engine.chars.has(String(acc.id)));
    token = mira.token;
  });

  await safely('Neustart', async () => {
    mira.p.a.str = 17.5;
    mira.p.a.agi = 12.25;
    mira.p.x = -12.5;
    mira.p.weapon = 'bow';
    await S.stop();
    const saved = JSON.parse(engine.chars.get(String(engine.accounts.get('mira').id)));
    ok('Vor dem Neustart ist alles gespeichert', saved.a.str === 17.5 && saved.x === -12.5 && saved.w === 'bow', JSON.stringify(saved));

    db = new store.SqlStore(URL_, { pg: null, endpoint: fake.endpoint });   // ganz frischer Server
    port = await S.start(0, { store: db });
    const back = new Client(port, { t: 'resume', token });
    const r = await back.answer();
    ok('Nach dem Neustart: Gerät meldet sich mit dem Schlüssel wieder an', r.t === 'welcome' && r.you.name === 'Mira');
    ok('Nach dem Neustart: Werte, Ort und Waffe sind erhalten', r.self.a.str === 17.5 && r.self.a.agi === 12.25
      && r.you.x === -12.5 && r.self.weapon === 'bow');
    back.ws.close();
    await back.closed;
    const pw = new Client(port, { t: 'login', name: 'mira', pass: 'Sternenstaub' });
    const r2 = await pw.answer();
    ok('Nach dem Neustart: Anmeldung mit Passwort', r2.t === 'welcome' && r2.self.a.str === 17.5);
    mira = pw;
  });

  await safely('Aussetzer', async () => {
    fake.failNext = 1;
    mira.p.a.int = 14.5;
    await S.saveAll();
    const saved = JSON.parse(engine.chars.get(String(engine.accounts.get('mira').id)));
    ok('Kurzer Aussetzer (503): neuer Versuch klappt', saved.a.int === 14.5);

    fake.down = true;
    const c = new Client(port, { t: 'login', name: 'Mira', pass: 'Sternenstaub' });
    const r = await c.answer();
    ok('Datenbank weg: verständliche Meldung statt Absturz', r.t === 'denied' && r.code === 'db' && /Datenbank/.test(r.text));
    const st = await getJson(port, '/status');
    ok('/status zeigt den Fehler', st && st.datenbank.zustand === 'Fehler' && /500|compute/.test(st.datenbank.fehler), JSON.stringify(st));
    mira.p.a.wis = 19.5;
    await S.saveAll();
    ok('Spiel läuft trotz Speicherfehler weiter', S.players.size === 1 && mira.ws.readyState === WebSocket.OPEN);
    fake.down = false;
    await S.saveAll();
    const saved2 = JSON.parse(engine.chars.get(String(engine.accounts.get('mira').id)));
    ok('Danach wird das Versäumte nachgeholt', saved2.a.wis === 19.5);
    const c2 = new Client(port, { t: 'login', name: 'Mira', pass: 'Sternenstaub' });
    const r2 = await c2.answer();
    ok('Danach klappt die Anmeldung wieder', r2.t === 'welcome');
    mira = c2;
    c.ws.close();
  });

  await safely('Antwort ohne Array-Modus', async () => {
    fake.objectMode = true;
    mira.p.a.sta = 15.25;
    await S.saveAll();
    const c = new Client(port, { t: 'resume', token: mira.token });
    const r = await c.answer();
    ok('Zeilen als Objekte werden ebenfalls verstanden', r.t === 'welcome' && r.self.a.sta === 15.25);
    fake.objectMode = false;
    mira = c;
  });
  await S.stop();

  await safely('Falsches Passwort in der Adresse', async () => {
    fake.reject = { message: `password authentication failed for user "neondb_owner" (${SECRET})`, code: '28P01' };
    const bad = new store.SqlStore(URL_, { pg: null, endpoint: fake.endpoint });
    const p2 = await S.start(0, { store: bad });
    const st = await getJson(p2, '/status');
    const text = JSON.stringify(st);
    ok('/status nennt den Grund', /password authentication failed/.test(st.datenbank.fehler) && /28P01/.test(st.datenbank.fehler), text);
    ok('Das Datenbank-Passwort taucht nirgends auf', !text.includes(SECRET) && text.includes('***'));
    const c = new Client(p2, { t: 'register', name: 'Lumi', pass: 'geheim123' });
    const r = await c.answer();
    ok('Anmeldung meldet das Problem freundlich', r.t === 'denied' && r.code === 'db' && !JSON.stringify(r).includes(SECRET));
    fake.reject = null;
    await S.stop();
  });

  // ---- Weg über das Paket "pg" ----
  await safely('pg', async () => {
    const pgFake = fakePg(engine);
    const viaPg = new store.SqlStore(URL_, { pg: pgFake, endpoint: fake.endpoint });
    const p3 = await S.start(0, { store: viaPg });
    const req0 = fake.requests;
    const c = new Client(p3, { t: 'login', name: 'Mira', pass: 'Sternenstaub' });
    const r = await c.answer();
    ok('Ist "pg" installiert, wird es benutzt', r.t === 'welcome' && viaPg.status().kind === 'pg' && fake.requests === req0);
    const cfg = pgFake.seen.configs[0];
    ok('pg bekommt Adresse, Verbindungsgrenze und Leerlauf-Ende',
      cfg && !cfg.connectionString.includes('channel_binding') && cfg.max === 3 && cfg.idleTimeoutMillis === 10000);
    ok('Über pg sind dieselben Werte da', r.self.a.str === 17.5 && r.self.a.sta === 15.25);
    await S.stop();

    const tlsFake = fakePg(engine, 'tls');
    const fallback = new store.SqlStore(URL_, { pg: tlsFake, endpoint: fake.endpoint });
    const p4 = await S.start(0, { store: fallback });
    const c2 = new Client(p4, { t: 'login', name: 'Mira', pass: 'Sternenstaub' });
    const r2 = await c2.answer();
    ok('Klappt pg nicht, springt Neon-HTTP ein', r2.t === 'welcome' && fallback.status().kind === 'Neon-HTTP');
    await S.stop();
  });

  await fake.close();
  console.log = origLog;
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log(`\nERGEBNIS: ${results.length - fails} PASS, ${fails} FAIL`);
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error('ABBRUCH:', err); process.exit(1); });
