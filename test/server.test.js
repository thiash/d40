'use strict';
// Integrationstest für Schritt 2 und 3: startet den echten Server und spielt mit echten Clients.
const http = require('http');
const WebSocket = require('ws');
const S = require('../server/index.js');

const results = [];
const ok = (name, cond, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? '  (' + extra + ')' : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let testNames = 0;
class Client {
  // auth: wie sich der Client nach "hello" anmeldet – Standard: neuer Charakter mit eigenem Namen
  constructor(port, auth, headers) {
    this.msgs = [];
    this.waiters = [];
    this.auth = auth === undefined ? { t: 'register', name: `Tester${++testNames}`, pass: 'geheim123' } : auth;
    this.ws = new WebSocket(`ws://localhost:${port}`, headers ? { headers } : undefined);
    this.closed = new Promise((resolve) => this.ws.on('close', (code) => resolve(code)));
    this.ws.on('message', (d) => {
      const m = JSON.parse(d);
      this.msgs.push(m);
      if (m.t === 'hello' && this.auth) this.send(this.auth);
      if (m.t === 'auth') this.token = m.token;
      if (m.t === 'welcome') { this.id = m.you.id; this.self = m.self; this.welcome = m; }
      if (m.t === 'you') this.self = m.self;
      this.waiters = this.waiters.filter((w) => !w(m));
    });
  }
  ready() { return this.waitFor((m) => m.t === 'welcome', 3000, 0); }
  send(o) { this.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); }
  mark() { return this.msgs.length; }
  waitFor(pred, ms = 3000, from = this.msgs.length) {
    for (let i = from; i < this.msgs.length; i++) if (pred(this.msgs[i])) return Promise.resolve(this.msgs[i]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Zeitüberschreitung')), ms);
      this.waiters.push((m) => { if (pred(m)) { clearTimeout(t); resolve(m); return true; } return false; });
    });
  }
  count(pred, from) { return this.msgs.slice(from).filter(pred).length; }
  get p() { return S.players.get(this.id); }
}

async function safely(name, fn) {
  try { await fn(); } catch (err) { ok(name, false, err.message); }
}

// Tier direkt vor einen Spieler stellen (Blickrichtung ry = 0 heißt: nach +z)
function placeInFront(c, kind, d) {
  const p = c.p;
  p.ry = 0;
  return S.spawnEnemy(kind, p.x, p.z + d);
}

function get(port, urlPath) {
  return new Promise((resolve) => {
    http.get({ host: 'localhost', port, path: urlPath }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', () => resolve(0));
  });
}

(async () => {
  const origLog = console.log;
  console.log = (...args) => { if (!String(args[0]).startsWith('[')) origLog(...args); };   // Serverprotokoll ausblenden
  const port = await S.start(0);

  // ---- HTTP ----
  ok('HTTP liefert die Startseite', (await get(port, '/')) === 200);
  ok('HTTP sperrt Pfade außerhalb von client/', [403, 404].includes(await get(port, '/../server/index.js')));

  // ---- Willkommen ----
  const a = new Client(port);
  await a.ready();
  ok('Willkommen mit eigenen Werten', a.self && a.self.hp === 100 && a.self.mana === 60);
  ok('Alle Attribute starten bei 10', Object.values(a.self.a).every((v) => v === 10));
  ok('Angriffstempo 900 ms, Ausweichen 0 %, Heilung 5 %', a.self.cd === 900 && a.self.dodge === 0 && a.self.heal === 5);
  ok('Regeln enthalten Waffen und Zauber', a.welcome.rules.weapons.bow === 'Bogen' && a.welcome.rules.spells.wis.cost === 6);
  ok('Tiere sind da', a.welcome.enemies.length >= 8, `${a.welcome.enemies.length} Tiere`);
  ok('Alle Tiere stehen an Land', [...S.enemies.values()].every((e) => S.heightAt(e.x, e.z) > -2.8));

  // Ab jetzt keine zufälligen Tiere mehr, damit die Prüfungen eindeutig bleiben
  S.WORLD.maxEnemies = 0;
  S.enemies.clear();

  // ---- Angriff ins Leere ----
  await safely('Angriff ins Leere', async () => {
    const from = a.mark();
    a.send({ t: 'attack' });
    const m = await a.waitFor((x) => x.t === 'attack' && x.id === a.id, 2000, from);
    await sleep(150);
    ok('Angriff ins Leere: kein Ziel, nichts gelernt', m.te === 0 && a.p.a.str === 10);
  });

  // ---- Schwert gegen Keiler ----
  await safely('Schwert', async () => {
    await sleep(950);
    const boar = placeInFront(a, 'boar', 1.5);
    const from = a.mark();
    a.send({ t: 'attack' });
    const hit = await a.waitFor((x) => x.t === 'hitE' && x.id === boar.id, 2000, from);
    ok('Schwerttreffer macht 9 Schaden', hit.dmg === 9 && hit.hp === 61, `dmg ${hit.dmg}, hp ${hit.hp}`);
    await a.waitFor((x) => x.t === 'you' && x.self.a.str === 10.01, 2000, from);
    ok('Treffer gibt 0,01 Stärke', a.self.a.str === 10.01);

    const from2 = a.mark();
    a.send({ t: 'attack' });
    await sleep(250);
    ok('Abklingzeit wird vom Server durchgesetzt', a.count((x) => x.t === 'attack' && x.id === a.id && !x.auto, from2) === 0);

    const back = await a.waitFor((x) => x.t === 'hitP' && x.id === a.id, 3000, from);
    ok('Keiler schlägt zurück (9 Schaden)', back.dmg === 9 && back.hp === 91, `hp ${back.hp}`);
    await a.waitFor((x) => x.t === 'you' && x.self.a.sta === 10.01, 2000, from);
    ok('Eingesteckter Treffer gibt 0,01 Ausdauer', a.self.a.sta === 10.01);
    const auto = await a.waitFor((x) => x.t === 'attack' && x.id === a.id && x.auto === 1, 3000, from);
    ok('Automatischer Gegenangriff trifft den Keiler', auto.te === boar.id);

    boar.hp = 3;
    const from3 = a.mark();
    const gone = await a.waitFor((x) => x.t === 'despawn' && x.id === boar.id, 3000, from3);
    ok('Besiegtes Tier verschwindet', gone.by === a.id && !S.enemies.has(boar.id));
  });

  // ---- Dolch ----
  await safely('Dolch', async () => {
    let from = a.mark();
    a.send({ t: 'weapon', w: 'dagger' });
    await a.waitFor((x) => x.t === 'you' && x.self.weapon === 'dagger', 2000, from);
    ok('Waffenwechsel auf Dolch', a.p.weapon === 'dagger');
    await sleep(950);
    const str0 = a.p.a.str, agi0 = a.p.a.agi;
    const hare = placeInFront(a, 'hare', 1.2);
    from = a.mark();
    a.send({ t: 'attack' });
    const hit = await a.waitFor((x) => x.t === 'hitE' && x.id === hare.id, 2000, from);
    await sleep(100);
    ok('Dolch: halber Schaden aus beiden Werten', hit.dmg === 8, `dmg ${hit.dmg}`);
    ok('Dolch: je 0,005 Stärke und Beweglichkeit',
      Math.abs(a.p.a.str - str0 - 0.005) < 1e-9 && Math.abs(a.p.a.agi - agi0 - 0.005) < 1e-9);
    await sleep(600);
    ok('Hase flieht, statt anzugreifen', S.enemies.has(hare.id)
      && Math.hypot(hare.x - a.p.x, hare.z - a.p.z) > 1.5);
    S.enemies.delete(hare.id);
  });

  // ---- Bogen ----
  await safely('Bogen', async () => {
    let from = a.mark();
    a.send({ t: 'weapon', w: 'bow' });
    await a.waitFor((x) => x.t === 'you' && x.self.weapon === 'bow', 2000, from);
    await sleep(950);
    const agi0 = a.p.a.agi;
    const boar = placeInFront(a, 'boar', 10);
    from = a.mark();
    a.send({ t: 'attack' });
    const m = await a.waitFor((x) => x.t === 'attack' && x.id === a.id, 2000, from);
    const hit = await a.waitFor((x) => x.t === 'hitE' && x.id === boar.id, 2000, from);
    await sleep(100);
    ok('Bogen trifft auf 10 m', m.te === boar.id && hit.w === 'bow');
    ok('Bogen gibt 0,01 Beweglichkeit', Math.abs(a.p.a.agi - agi0 - 0.01) < 1e-9);
    S.enemies.delete(boar.id);
    await sleep(950);
    const behind = S.spawnEnemy('boar', a.p.x, a.p.z - 6);
    from = a.mark();
    a.send({ t: 'attack' });
    const m2 = await a.waitFor((x) => x.t === 'attack' && x.id === a.id, 2000, from);
    ok('Ziele hinter dem Rücken werden nicht getroffen', m2.te === 0);
    S.enemies.delete(behind.id);
  });

  // ---- Intelligenzzauber ----
  await safely('Intelligenzzauber', async () => {
    let from = a.mark();
    a.send({ t: 'cast', s: 'int' });
    const none = await a.waitFor((x) => x.t === 'you' && x.note, 2000, from);
    ok('Zauber ohne Ziel kostet kein Mana', none.note === 'notarget' && a.p.mana === 60, `mana ${a.p.mana}`);
    await sleep(1400);
    const boar = placeInFront(a, 'boar', 8);
    const int0 = a.p.a.int;
    from = a.mark();
    a.send({ t: 'cast', s: 'int' });
    const hit = await a.waitFor((x) => x.t === 'hitE' && x.id === boar.id, 2000, from);
    const you = await a.waitFor((x) => x.t === 'you' && x.self.a.int > int0, 2000, from);
    ok('Intelligenzzauber trifft (8 Schaden)', hit.dmg === 8 && hit.w === 'int', `dmg ${hit.dmg}`);
    ok('Zauber kostet 5 Mana', you.self.mana === 55, `mana ${you.self.mana}`);
    ok('Zauber gibt 0,01 Intelligenz', Math.abs(you.self.a.int - int0 - 0.01) < 1e-9);
    S.enemies.delete(boar.id);
    a.p.autoTarget = null;
  });

  // ---- Weisheitszauber ----
  await safely('Heilung', async () => {
    await sleep(1600);
    a.p.hp = a.p.hpMax;
    let from = a.mark();
    a.send({ t: 'cast', s: 'wis' });
    const full = await a.waitFor((x) => x.t === 'you' && x.note, 2000, from);
    ok('Heilen bei vollem Leben: keine Wirkung, nichts gelernt', full.note === 'full' && a.p.a.wis === 10);
    a.p.hp = 50;
    a.p.lastFightAt = Date.now();
    const mana0 = a.p.mana;
    from = a.mark();
    a.send({ t: 'cast', s: 'wis' });
    const healed = await a.waitFor((x) => x.t === 'you' && x.heal, 2000, from);
    const hpMax = a.p.hpMax;
    ok('Heilung um 5 % der maximalen Lebenspunkte', healed.heal === Math.round(hpMax * 0.05) && a.p.hp === 50 + healed.heal,
      `+${healed.heal} bei ${hpMax}`);
    ok('Heilung kostet 6 Mana und gibt 0,01 Weisheit', healed.self.mana === Math.floor(mana0 - 6) && healed.self.a.wis === 10.01,
      `mana ${mana0} -> ${healed.self.mana}`);
    from = a.mark();
    a.send({ t: 'cast', s: 'wis' });
    await sleep(300);
    ok('Zauber-Abklingzeit wird durchgesetzt', a.count((x) => x.t === 'you' && x.heal, from) === 0);
    await sleep(1300);
    a.p.mana = 2;
    from = a.mark();
    a.send({ t: 'cast', s: 'wis' });
    const nm = await a.waitFor((x) => x.t === 'you' && x.note, 2000, from);
    ok('Ohne Mana kein Zauber', nm.note === 'mana');
    a.p.mana = a.p.manaMax;
  });

  // ---- Ganzer Punkt erreicht ----
  await safely('Ganzer Punkt', async () => {
    let from = a.mark();
    a.send({ t: 'weapon', w: 'heavy' });
    await a.waitFor((x) => x.t === 'you' && x.self.weapon === 'heavy', 2000, from);
    await sleep(950);
    a.p.a.str = 10.995;
    const boar = placeInFront(a, 'boar', 1.5);
    from = a.mark();
    a.send({ t: 'attack' });
    const up = await a.waitFor((x) => x.t === 'you' && x.up, 2000, from);
    ok('Meldung, wenn ein Attribut einen ganzen Punkt erreicht', up.up.includes('str') && up.self.a.str === 11.005);
    S.enemies.delete(boar.id);
    a.p.autoTarget = null;
  });

  // ---- Ausweichen ----
  await safely('Ausweichen', async () => {
    await sleep(300);
    a.p.a.agi = 70;
    a.p.hp = a.p.hpMax = 5000;
    a.p.lastInputAt = Date.now();
    const old = S.ENEMY_KINDS.wolf.atkMs;
    S.ENEMY_KINDS.wolf.atkMs = 60;
    const sta0 = a.p.a.sta;
    const wolf = placeInFront(a, 'wolf', 1.2);
    wolf.hp = 100000;
    const from = a.mark();
    await sleep(2500);
    S.enemies.delete(wolf.id);
    S.ENEMY_KINDS.wolf.atkMs = old;
    const hits = a.msgs.slice(from).filter((x) => x.t === 'hitP' && x.id === a.id);
    const dodged = hits.filter((x) => x.dodge).length, taken = hits.length - dodged;
    const rate = dodged / hits.length;
    ok('Ausweichen bei 55 % Deckel', hits.length > 20 && rate > 0.35 && rate < 0.75, `${dodged} von ${hits.length}`);
    ok('Ausweichen gibt keine Ausdauer, nur echte Treffer', Math.abs(a.p.a.sta - sta0 - taken * 0.01) < 1e-6,
      `+${(a.p.a.sta - sta0).toFixed(3)} bei ${taken} Treffern`);
    ok('Ausgewichene Schläge machen keinen Schaden', hits.filter((x) => x.dodge).every((x) => x.dmg === 0));
    a.p.a.agi = 10;
    a.p.hpMax = S.maxHp(a.p.a);
    a.p.hp = a.p.hpMax;
    a.p.autoTarget = null;
  });

  // ---- Untätig: kein Zuwachs ----
  await safely('Untätig', async () => {
    a.p.lastInputAt = Date.now() - 61000;
    const str0 = a.p.a.str, sta0 = a.p.a.sta;
    const boar = placeInFront(a, 'boar', 1.2);
    boar.target = a.id;
    const from = a.mark();
    await a.waitFor((x) => x.t === 'hitP' && x.id === a.id && !x.dodge, 3000, from);
    await a.waitFor((x) => x.t === 'attack' && x.id === a.id && x.auto === 1 && x.te === boar.id, 3000, from);
    await sleep(100);
    ok('Wer nichts tut, lernt nichts – auch nicht im Gegenangriff', a.p.a.str === str0 && a.p.a.sta === sta0);
    S.enemies.delete(boar.id);
    a.p.autoTarget = null;
    a.p.hp = a.p.hpMax;
    a.p.lastInputAt = Date.now();
  });

  // ---- K.O. und Erholung ----
  const b = new Client(port);
  await b.ready();
  await safely('K.O.', async () => {
    const oldRevive = S.COMBAT.reviveMs;
    S.COMBAT.reviveMs = 1500;
    b.p.safeUntil = Date.now() + 60000;
    a.p.hp = 14;
    a.p.lastInputAt = Date.now();
    const wolf = placeInFront(a, 'wolf', 1.2);
    wolf.lastAttackAt = 0;
    const from = a.mark(), fromB = b.mark();
    await a.waitFor((x) => x.t === 'ko' && x.id === a.id, 3000, from);
    await sleep(50);
    ok('Bei 10 % Leben K.O. statt Tod', a.p.ko && a.p.hp === Math.round(a.p.hpMax * 0.1), `hp ${a.p.hp}`);
    ok('Das Tier lässt ab', wolf.target === null);
    ok('Der Mitspieler sieht das K.O.', !!(await b.waitFor((x) => x.t === 'ko' && x.id === a.id, 1000, fromB)));
    const x0 = a.p.x;
    a.send({ t: 'move', x: x0 + 1, z: a.p.z, ry: 0, c: a.p.corr });
    a.send({ t: 'attack' });
    await sleep(200);
    ok('Bewusstlos: keine Bewegung, kein Angriff', a.p.x === x0
      && a.count((x) => x.t === 'attack' && x.id === a.id, from) === 0);
    const rv = await a.waitFor((x) => x.t === 'revive' && x.id === a.id, 3000, from);
    ok('Nach der Erholung mit halbem Leben zurück', !a.p.ko && rv.hp === Math.round(a.p.hpMax * 0.5), `hp ${rv.hp}`);
    wolf.x = a.p.x; wolf.z = a.p.z + 3;
    await sleep(500);
    ok('Kurze Schonfrist: Tiere greifen nicht sofort wieder an', wolf.target === null);
    S.enemies.delete(wolf.id);
    S.COMBAT.reviveMs = oldRevive;
  });

  // ---- Regeneration ----
  await safely('Regeneration', async () => {
    a.p.hp = 50;
    a.p.mana = 10;
    a.p.lastFightAt = 0;
    const from = a.mark();
    await a.waitFor((x) => x.t === 'you' && x.self.hp > 50, 2500, from);
    ok('Leben erholt sich außerhalb des Kampfes (1 % pro Sekunde)', a.self.hp === 51, `hp ${a.self.hp}`);
    ok('Mana lädt langsam nach (1,5 pro Sekunde)', a.self.mana === 11, `mana ${a.self.mana}`);
    a.p.lastFightAt = Date.now();
    const hp0 = a.p.hp;
    await sleep(1200);
    ok('Kurz nach einem Kampf keine Erholung', a.p.hp === hp0);
  });

  // ---- Zweiter Spieler sieht alles ----
  await safely('Mitspieler', async () => {
    let fromB = b.mark();
    a.send({ t: 'weapon', w: 'bow' });
    const g = await b.waitFor((x) => x.t === 'gear' && x.id === a.id, 2000, fromB);
    ok('Mitspieler sieht den Waffenwechsel', g.w === 'bow');
    await sleep(950);
    const boar = placeInFront(a, 'boar', 6);
    fromB = b.mark();
    a.send({ t: 'attack' });
    const h = await b.waitFor((x) => x.t === 'hitE' && x.by === a.id, 2000, fromB);
    ok('Mitspieler sieht den Treffer', h.id === boar.id);
    S.enemies.delete(boar.id);
  });

  // ---- Robustheit ----
  await safely('Robustheit', async () => {
    a.send('das ist kein JSON');
    a.send({ t: 'cast', s: 'gibtesnicht' });
    a.send({ t: 'weapon', w: 'kanone' });
    a.send({ t: 'move', x: 'a', z: null, ry: 0, c: a.p.corr });
    await sleep(200);
    ok('Server übersteht Müll-Nachrichten', a.ws.readyState === WebSocket.OPEN && a.p.weapon === 'bow');
    const from = a.mark();
    a.send({ t: 'move', x: a.p.x + 40, z: a.p.z, ry: 0, c: a.p.corr });
    const c = await a.waitFor((x) => x.t === 'correct', 2000, from);
    ok('Teleport wird weiterhin korrigiert', c.n === a.p.corr);
  });

  await safely('Verlassen', async () => {
    const boar = S.spawnEnemy('boar', 50, 50);
    boar.target = b.id;
    const from = a.mark();
    b.ws.close();
    const lv = await a.waitFor((x) => x.t === 'leave' && x.id === b.id, 2000, from);
    await sleep(100);
    ok('Abmeldung wird gemeldet, Tiere vergessen den Spieler', !!lv && boar.target === null);
  });

  // =========================================================================
  //  Schritt 4: Beute, Tasche mit Gewicht, Truhe
  // =========================================================================
  const f = new Client(port);
  const o = new Client(port);
  await f.ready();
  await o.ready();
  const you = (c, from, pred = () => true) => c.waitFor((m) => m.t === 'you' && pred(m), 3000, from);
  const nudge = async (c, pred) => {        // bringt den Server dazu, die eigenen Werte zu schicken
    const from = c.mark();
    const x = c.p.x;
    c.p.x = 50;
    c.send({ t: 'chest', op: 'open' });
    const m = await you(c, from, pred);
    c.p.x = x;
    return m;
  };

  await safely('Tragkraft', async () => {
    ok('Tragkraft: 40 kg bei Stärke und Ausdauer 10', S.carryCap({ str: 10, sta: 10 }) === 40 && f.self.cap === 40
      && f.self.load === 0 && f.self.spd === 1 && Object.keys(f.self.inv).length === 0);
    ok('Tragkraft: Stärke zählt doppelt so viel wie Ausdauer',
      S.carryCap({ str: 13, sta: 10 }) === 48 && S.carryCap({ str: 10, sta: 13 }) === 44);
    ok('Tempo: bis zur Tragkraft voll, darüber langsamer, ab 1,5-fach Stillstand',
      S.loadFactor(40, 40) === 1 && S.loadFactor(45, 40) === 0.83 && S.loadFactor(59.9, 40) > 0.29
      && S.loadFactor(60, 40) === 0);
    ok('Laufen: Beweglichkeit 10 ist normal, 20 schneller, 40 bleibt bei +20 %',
      S.moveSpeedBonus({ agi: 10 }) === 1 && Math.abs(S.moveSpeedBonus({ agi: 20 }) - 1.1) < 1e-9
      && S.moveSpeedBonus({ agi: 40 }) === 1.2 && S.moveSpeedBonus({ agi: 5 }) === 1);
    ok('Laufen: Der Client erhält das Tempo als mv', f.self.mv === 1);
  });

  let loot = null;
  await safely('Beute fällt', async () => {
    S.WORLD.maxEnemies = 0;
    await sleep(950);
    const boar = placeInFront(f, 'boar', 1.5);
    boar.hp = 1;
    const from = f.mark(), fromO = o.mark();
    f.send({ t: 'attack' });
    const m = await f.waitFor((x) => x.t === 'loot', 3000, from);
    loot = m.l;
    const keys = Object.keys(loot.items);
    ok('Besiegtes Tier lässt Beute am Boden liegen', Math.abs(loot.x - boar.x) < 0.01 && Math.abs(loot.z - boar.z) < 0.01
      && keys.length > 0 && keys.every((k) => S.DROPS.boar.some((d) => d.k === k)), JSON.stringify(loot.items));
    ok('Für den Sieger reserviert', loot.mine === true && loot.res > 29000);
    const mo = await o.waitFor((x) => x.t === 'loot' && x.l.id === loot.id, 2000, fromO);
    ok('Andere sehen sie, aber sie gehört ihnen noch nicht', mo.l.mine === false && mo.l.res > 29000);
  });

  await safely('Aufheben', async () => {
    o.p.x = loot.x; o.p.z = loot.z;
    let from = o.mark();
    o.send({ t: 'pick', id: loot.id });
    const r = await you(o, from, (m) => m.note);
    ok('Fremde Beute: erst nach Ablauf der Reservierung', r.note === 'reserved' && r.wait >= 29 && S.loots.has(loot.id));
    const fx = f.p.x;
    f.p.x = loot.x + 10;
    from = f.mark();
    f.send({ t: 'pick', id: loot.id });
    const far = await you(f, from, (m) => m.note);
    ok('Zu weit weg: nichts passiert', far.note === 'far' && S.loots.has(loot.id));
    f.p.x = fx;
    from = f.mark();
    const fromO = o.mark();
    f.send({ t: 'pick', id: loot.id });
    const got = await you(f, from, (m) => m.got);
    ok('Aufgehoben: alles landet in der Tasche', JSON.stringify(got.got) === JSON.stringify(loot.items)
      && JSON.stringify(got.self.inv) === JSON.stringify(loot.items) && !S.loots.has(loot.id));
    ok('Gewicht wird mitgezählt', got.self.load === S.weightOf(loot.items) && got.self.load > 0);
    const un = await o.waitFor((x) => x.t === 'unloot' && x.id === loot.id, 2000, fromO);
    ok('Alle sehen, dass die Beute weg ist', un.by === f.id);
    from = f.mark();
    f.send({ t: 'pick', id: loot.id });
    const gone = await you(f, from, (m) => m.note);
    ok('Zweimal aufheben geht nicht', gone.note === 'gone');
  });

  await safely('Reservierung läuft ab', async () => {
    const old = S.LOOT.reserveMs;
    S.LOOT.reserveMs = 50;
    const l = S.spawnLoot(o.p.x, o.p.z, { wolf_fang: 2 }, f.p.accountId);
    S.LOOT.reserveMs = old;
    await sleep(120);
    const from = o.mark();
    o.send({ t: 'pick', id: l.id });
    const r = await you(o, from, (m) => m.got || m.note);
    ok('Nach Ablauf darf jeder die Beute nehmen', !!r.got && o.p.inv.wolf_fang === 2);
  });

  await safely('Ablegen', async () => {
    f.p.inv = { meat: 3, wolf_fang: 1 };
    const n0 = S.loots.size;
    f.send({ t: 'drop', k: 'gold', n: 1 });
    f.send({ t: 'drop', k: 'meat', n: 9 });
    f.send({ t: 'drop', k: 'meat', n: -1 });
    f.send({ t: 'drop', k: '__proto__' });
    await sleep(150);
    ok('Unsinnige Mengen und unbekannte Dinge werden nicht abgelegt', S.loots.size === n0 && f.p.inv.meat === 3);
    let from = f.mark();
    const fromO = o.mark();
    f.send({ t: 'drop', k: 'meat', n: 2 });
    f.send({ t: 'drop', k: 'wolf_fang' });     // zu schnell hinterher: wird verworfen
    const d = await you(f, from, (m) => m.dropped);
    await sleep(150);
    ok('Ablegen: Teil eines Stapels', d.dropped.meat === 2 && f.p.inv.meat === 1 && f.p.inv.wolf_fang === 1
      && S.loots.size === n0 + 1);
    const lm = await o.waitFor((x) => x.t === 'loot' && x.l.items.meat === 2, 2000, fromO);
    ok('Abgelegtes gehört sofort allen', lm.l.mine === false && lm.l.res === 0);
    await sleep(350);
    from = f.mark();
    f.send({ t: 'drop', k: 'wolf_fang' });
    await you(f, from, (m) => m.dropped);
    ok('Ohne Anzahl: der ganze Stapel', f.p.inv.wolf_fang === undefined);
    o.p.x = lm.l.x; o.p.z = lm.l.z;
    from = o.mark();
    o.send({ t: 'pick', id: lm.l.id });
    await you(o, from, (m) => m.got);
    ok('Ein anderer kann es aufheben', o.p.inv.meat === 2);
  });

  await safely('Zu schwer', async () => {
    f.p.inv = { boar_hide: 15 };            // 45 kg bei 40 kg Tragkraft
    let m = await nudge(f);
    ok('Über der Tragkraft: langsamer', m.self.load === 45 && m.self.spd === 0.83);
    f.p.inv = { boar_hide: 20 };            // 60 kg: anderthalbfach
    m = await nudge(f);
    ok('Ab dem Anderthalbfachen: Stillstand', m.self.spd === 0);
    await sleep(400);
    const from = f.mark();
    f.send({ t: 'move', x: f.p.x + 0.3, z: f.p.z, ry: 0, c: f.p.corr });
    const c = await f.waitFor((x) => x.t === 'correct', 2000, from);
    ok('Server lässt Überladene nicht laufen', !!c);
    f.p.inv = { boar_hide: 15 };
    f.p.budget = 0;
    f.p.lastMoveAt = Date.now();
    await sleep(500);                       // reicht bei vollem Tempo für 3,75 m, bei 0,825 für gut 3 m
    const x0 = f.p.x;
    const from2 = f.mark();
    f.send({ t: 'move', x: x0 + 2.4, z: f.p.z, ry: 0, c: f.p.corr });
    await sleep(150);
    ok('Langsamer heißt: weniger Weg pro Zeit', f.p.x === x0 + 2.4 && !f.count((x) => x.t === 'correct', from2));
    f.p.x = x0;
    f.p.inv = {};
  });

  await safely('Truhe', async () => {
    f.p.x = 20; f.p.z = 20;
    let from = f.mark();
    f.send({ t: 'chest', op: 'open' });
    const far = await you(f, from, (m) => m.note);
    ok('Truhe nur aus der Nähe', far.note === 'chestfar');
    f.p.x = 1; f.p.z = 1;
    f.p.inv = { meat: 3, wolf_pelt: 1 };
    from = f.mark();
    f.send({ t: 'chest', op: 'open' });
    const open = await f.waitFor((x) => x.t === 'chest', 2000, from);
    ok('Truhe öffnet sich, anfangs leer', Object.keys(open.items).length === 0);
    from = f.mark();
    f.send({ t: 'chest', op: 'store', k: 'meat' });
    let ch = await f.waitFor((x) => x.t === 'chest', 2000, from);
    ok('Einlagern: ganzer Stapel in die Truhe', ch.items.meat === 3 && f.p.inv.meat === undefined && f.p.inv.wolf_pelt === 1);
    from = f.mark();
    f.send({ t: 'chest', op: 'take', k: 'meat', n: 1 });
    ch = await f.waitFor((x) => x.t === 'chest', 2000, from);
    ok('Herausnehmen: auch einzeln', ch.items.meat === 2 && f.p.inv.meat === 1);
    f.send({ t: 'chest', op: 'take', k: 'boar_hide' });
    f.send({ t: 'chest', op: 'steal', k: 'meat' });
    f.send({ t: 'chest', op: 'store', k: 'meat', n: 5 });
    await sleep(150);
    ok('Unsinnige Truhen-Befehle ändern nichts', f.p.chest.meat === 2 && f.p.inv.meat === 1 && !f.p.chest.boar_hide);
    ok('Jeder hat seine eigene Truhe', Object.keys(o.p.chest).length === 0);
  });

  await safely('Tasche und Truhe bleiben gespeichert', async () => {
    const token = f.token;
    f.ws.close();
    await f.closed;
    await sleep(100);
    const f2 = new Client(port, { t: 'resume', token });
    await f2.ready();
    ok('Nach dem Wiederkommen: Tasche noch da', f2.self.inv.meat === 1 && f2.self.inv.wolf_pelt === 1);
    f2.p.x = 0.5; f2.p.z = 0.5;
    const from = f2.mark();
    f2.send({ t: 'chest', op: 'open' });
    const ch = await f2.waitFor((x) => x.t === 'chest', 2000, from);
    ok('Nach dem Wiederkommen: Truhe noch da', ch.items.meat === 2);
    f2.ws.close();
  });

  await safely('Beute zerfällt', async () => {
    const l = S.spawnLoot(30, 30, { meat: 1 }, null);
    l.expiresAt = Date.now();
    const from = o.mark();
    const un = await o.waitFor((x) => x.t === 'unloot' && x.id === l.id, 2500, from);
    ok('Liegengelassene Beute zerfällt', !!un && !S.loots.has(l.id));
    const oldMax = S.LOOT.maxPiles;
    S.loots.clear();
    S.LOOT.maxPiles = 3;
    const first = S.spawnLoot(31, 31, { meat: 1 }, null);
    for (let i = 0; i < 3; i++) S.spawnLoot(31, 31, { meat: 1 }, null);
    ok('Höchstens so viele Haufen wie erlaubt, der älteste zuerst weg', S.loots.size === 3 && !S.loots.has(first.id));
    S.LOOT.maxPiles = oldMax;
    const n = new Client(port);
    await n.ready();
    ok('Wer neu dazukommt, sieht die liegende Beute', n.welcome.loots.length === 3 && n.welcome.rules.items.meat.kg === 0.5);
    n.ws.close();
    o.ws.close();
    S.loots.clear();
  });

  await safely('Kaputte Gegenstände im Speicher', async () => {
    const st = S.getStore();
    const id = await st.createAccount('Kramer', 'kramer', await require('../server/store').hashPassword('geheim123'));
    await st.saveCharacter(id, { inv: { meat: 2.5, wolf_fang: 3, gold: 9, boar_tusk: -1 }, chest: [1, 2] });
    const c = new Client(port, { t: 'login', name: 'Kramer', pass: 'geheim123' });
    await c.ready();
    ok('Nur gültige Gegenstände in ganzen Zahlen werden übernommen',
      JSON.stringify(c.self.inv) === '{"wolf_fang":3}' && Object.keys(c.p.chest).length === 0, JSON.stringify(c.self.inv));
    c.ws.close();
  });

  // =========================================================================
  //  Schritt 3: Anmeldung und Speichern (Speicher im Arbeitsspeicher)
  // =========================================================================
  const store = S.getStore();
  const answer = (c, from) => c.waitFor((m) => m.t === 'welcome' || m.t === 'denied', 4000, from);
  const getJson = (urlPath) => new Promise((resolve) => {
    http.get({ host: 'localhost', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });

  await safely('Vor der Anmeldung', async () => {
    const c = new Client(port, null);
    const hello = await c.waitFor((m) => m.t === 'hello', 2000, 0);
    ok('Begrüßung meldet: ohne Datenbank kein dauerhaftes Speichern', hello.persist === false);
    const n0 = S.players.size;
    c.send({ t: 'attack' });
    c.send({ t: 'move', x: 1, z: 1, ry: 0, c: 0 });
    c.send({ t: 'weapon', w: 'bow' });
    await sleep(200);
    ok('Ohne Anmeldung keine Spielfigur und keine Spielzüge', S.players.size === n0 && !c.count((m) => m.t === 'welcome', 0));
    let from = c.mark();
    c.send({ t: 'register', name: 'ab', pass: 'geheim123' });
    let r = await answer(c, from);
    ok('Zu kurzer Name wird abgelehnt', r.t === 'denied' && r.code === 'name', r.text);
    from = c.mark();
    c.send({ t: 'register', name: 'Böse<script>', pass: 'geheim123' });
    r = await answer(c, from);
    ok('Sonderzeichen im Namen werden abgelehnt', r.t === 'denied' && r.code === 'name');
    from = c.mark();
    c.send({ t: 'register', name: 'Wache', pass: 'geheim123' });
    r = await answer(c, from);
    ok('Reservierte Namen sind gesperrt', r.t === 'denied' && r.code === 'name' && /reserviert/.test(r.text));
    from = c.mark();
    c.send({ t: 'register', name: 'Kara', pass: '123' });
    r = await answer(c, from);
    ok('Zu kurzes Passwort wird abgelehnt', r.t === 'denied' && r.code === 'pass');
    from = c.mark();
    c.send({ t: 'login', name: 'Niemandda', pass: 'geheim123' });
    r = await answer(c, from);
    ok('Unbekannter Name: Hinweis auf neuen Charakter', r.t === 'denied' && r.code === 'unknown' && /Neuen Charakter/.test(r.text));
    c.ws.close();
  });

  let kara = null, karaAccount = 0;
  await safely('Neuer Charakter', async () => {
    kara = new Client(port, { t: 'register', name: '  Kara  Wolf ', pass: 'geheim123' });
    await kara.ready();
    const auth = kara.msgs.find((m) => m.t === 'auth');
    karaAccount = kara.p.accountId;
    ok('Neuer Charakter: Name bereinigt, Schlüssel fürs Gerät', auth && auth.fresh === true && auth.name === 'Kara Wolf'
      && typeof auth.token === 'string' && auth.token.length >= 40 && kara.welcome.you.name === 'Kara Wolf');
    await sleep(100);
    ok('Neuer Charakter wird sofort gespeichert', !!(await store.loadCharacter(karaAccount)));
    const acc = await store.findAccount('kara wolf');
    ok('Passwort liegt nur gehasht vor', acc && acc.pass.startsWith('scrypt$') && !acc.pass.includes('geheim123'));
  });

  await safely('Falsche Anmeldungen', async () => {
    const c = new Client(port, { t: 'login', name: 'KARA WOLF', pass: 'falsch123' });
    const r = await answer(c, 0);
    ok('Falsches Passwort wird abgelehnt (Groß- und Kleinschreibung egal)', r.t === 'denied' && r.code === 'pass');
    const from = c.mark();
    c.send({ t: 'register', name: 'kara wolf', pass: 'anderes12' });
    const r2 = await answer(c, from);
    ok('Vergebener Name kann nicht neu angelegt werden', r2.t === 'denied' && r2.code === 'taken');
    ok('Kara ist weiter im Spiel', S.players.has(kara.id));
    c.ws.close();
  });

  await safely('Zweites Gerät', async () => {
    kara.p.a.str = 12.34;
    kara.p.x = 7.5;
    const k2 = new Client(port, { t: 'login', name: 'kara wolf', pass: 'geheim123' });
    await k2.ready();
    const kicked = await kara.waitFor((m) => m.t === 'kicked', 2000, 0);
    const code = await kara.closed;
    ok('Altes Gerät wird abgemeldet und erfährt warum', !!kicked && code === 4001 && /anderen Gerät/.test(kicked.text));
    ok('Neues Gerät übernimmt den aktuellen Zustand', k2.self.a.str === 12.34 && k2.welcome.you.x === 7.5);
    ok('Der Charakter ist nur einmal in der Welt', [...S.players.values()].filter((q) => q.accountId === karaAccount).length === 1);
    kara = k2;
  });

  await safely('Speichern beim Verlassen', async () => {
    kara.p.a.int = 13.37;
    kara.p.x = 3.25;
    kara.p.z = -4.5;
    kara.p.weapon = 'dagger';
    kara.ws.close();
    await kara.closed;
    await sleep(100);
    await S.saveAll();
    const saved = await store.loadCharacter(karaAccount);
    ok('Beim Verlassen wird gespeichert', saved && saved.a.int === 13.37 && saved.x === 3.25 && saved.z === -4.5 && saved.w === 'dagger',
      JSON.stringify(saved));
    const token = kara.token;
    const k3 = new Client(port, { t: 'resume', token });
    await k3.ready();
    ok('Gemerkter Schlüssel meldet ohne Passwort wieder an', k3.welcome.you.name === 'Kara Wolf');
    ok('Werte, Ort und Waffe sind wieder da', k3.self.a.int === 13.37 && k3.welcome.you.x === 3.25
      && k3.welcome.you.z === -4.5 && k3.self.weapon === 'dagger');
    const auth = k3.msgs.find((m) => m.t === 'auth');
    ok('Wiederanmeldung ist kein neuer Charakter', auth && auth.fresh === false);
    kara = k3;
    const bad = new Client(port, { t: 'resume', token: 'x'.repeat(43) });
    const r = await answer(bad, 0);
    ok('Unbekannter Schlüssel wird abgelehnt', r.t === 'denied' && r.code === 'token');
    bad.ws.close();
  });

  await safely('Regelmäßiges Speichern', async () => {
    let writes = 0;
    const orig = store.saveCharacter;
    store.saveCharacter = async (...args) => { writes++; return orig.apply(store, args); };
    await S.saveAll();
    const w0 = writes;
    kara.p.a.wis = 11.11;
    await S.saveAll();
    const saved = await store.loadCharacter(karaAccount);
    ok('Geänderte Werte werden gespeichert', writes === w0 + 1 && saved.a.wis === 11.11);
    await S.saveAll();
    ok('Ohne Änderung wird nichts geschrieben', writes === w0 + 1);
    store.saveCharacter = orig;
  });

  await safely('Abmelden', async () => {
    const token = kara.token;
    const from = kara.mark();
    kara.send({ t: 'logout' });
    await kara.waitFor((m) => m.t === 'bye', 2000, from);
    await sleep(100);
    ok('Abmelden: Figur verlässt die Welt, Verbindung bleibt offen', !S.players.has(kara.id) && kara.ws.readyState === WebSocket.OPEN);
    const c = new Client(port, { t: 'resume', token });
    const r = await answer(c, 0);
    ok('Nach dem Abmelden gilt der alte Schlüssel nicht mehr', r.t === 'denied' && r.code === 'token');
    c.ws.close();
    const from2 = kara.mark();
    kara.send({ t: 'login', name: 'Kara Wolf', pass: 'geheim123' });
    const w = await kara.waitFor((m) => m.t === 'welcome', 3000, from2);
    kara.id = w.you.id;
    ok('Auf derselben Verbindung neu anmelden', S.players.has(w.you.id) && w.self.a.wis === 11.11);
  });

  await safely('Bewusstlos abgemeldet', async () => {
    const oldRevive = S.COMBAT.reviveMs;
    S.COMBAT.reviveMs = 800;
    kara.p.hp = 5;
    kara.ws.close();
    await kara.closed;
    await sleep(100);
    const k4 = new Client(port, { t: 'login', name: 'Kara Wolf', pass: 'geheim123' });
    await k4.ready();
    ok('Wer bewusstlos geht, wacht nicht schneller auf', k4.self.ko === true && k4.welcome.you.ko === true);
    const rv = await k4.waitFor((m) => m.t === 'revive' && m.id === k4.id, 3000, 0);
    ok('Erholung läuft danach normal', rv.hp === Math.round(k4.p.hpMax * 0.5));
    S.COMBAT.reviveMs = oldRevive;
    kara = k4;
  });

  await safely('Kaputte Speicherdaten', async () => {
    const id = await store.createAccount('Fehlerfee', 'fehlerfee', await require('../server/store').hashPassword('geheim123'));
    await store.saveCharacter(id, { x: 'a', z: 9999, hp: null, mana: -5, w: 'kanone', a: { str: 'viel', agi: 15.5 } });
    const c = new Client(port, { t: 'login', name: 'Fehlerfee', pass: 'geheim123' });
    await c.ready();
    const p = c.p;
    ok('Ungültige Werte werden durch sichere ersetzt', Math.hypot(p.x, p.z) <= 6.01 && p.weapon === 'heavy'
      && p.a.str === 10 && p.a.agi === 15.5 && p.hp === p.hpMax && p.mana === 0, JSON.stringify(S.snapshot(p)));
    c.ws.close();
  });

  await safely('Grenzen', async () => {
    const oldFails = S.LIMITS.maxFails;
    S.LIMITS.maxFails = 3;
    const ip = { 'x-forwarded-for': '198.51.100.1, 203.0.113.7, 10.9.8.7' };   // vorletzte zählt: die letzte ist Renders Proxy
    const c = new Client(port, null, ip);
    await c.waitFor((m) => m.t === 'hello', 2000, 0);
    for (let i = 0; i < 3; i++) {
      const from = c.mark();
      c.send({ t: 'login', name: 'Kara Wolf', pass: `rate${i}falsch` });
      await answer(c, from);
    }
    const from = c.mark();
    c.send({ t: 'login', name: 'Kara Wolf', pass: 'geheim123' });
    const r = await answer(c, from);
    ok('Nach zu vielen Fehlversuchen wird gebremst', r.t === 'denied' && r.code === 'slow');
    const faker = new Client(port, { t: 'login', name: 'Kara Wolf', pass: 'geheim123' },
      { 'x-forwarded-for': '1.2.3.4, 203.0.113.7, 10.9.8.7' });
    const rf = await answer(faker, 0);
    ok('Ein vorgetäuschter Eintrag vorn umgeht die Bremse nicht', rf.t === 'denied' && rf.code === 'slow');
    faker.ws.close();
    const other = new Client(port, { t: 'login', name: 'Fehlerfee', pass: 'geheim123' }, { 'x-forwarded-for': '10.9.8.6' });
    const r2 = await answer(other, 0);
    ok('Andere Adressen sind davon nicht betroffen', r2.t === 'welcome');
    S.LIMITS.maxFails = oldFails;
    const oldNew = S.LIMITS.maxNew;
    S.LIMITS.maxNew = 1;
    const n1 = new Client(port, { t: 'register', name: 'Erstling', pass: 'geheim123' }, { 'x-forwarded-for': '10.1.1.1' });
    await n1.ready();
    const n2 = new Client(port, { t: 'register', name: 'Zweitling', pass: 'geheim123' }, { 'x-forwarded-for': '10.1.1.1' });
    const r3 = await answer(n2, 0);
    ok('Massenhaft neue Charaktere werden gebremst', r3.t === 'denied' && r3.code === 'slow');
    S.LIMITS.maxNew = oldNew;
    [c, other, n1, n2].forEach((x) => x.ws.close());
  });

  await safely('Schmiede, Feuer und Essen', async () => {
    const reply = (msg, pred) => {
      const from = a.mark();
      a.send(msg);
      return a.waitFor((x) => x.t === 'you' && pred(x), 2000, from);
    };
    a.p.x = 50; a.p.z = 50;
    a.p.inv = { boar_hide: 3, boar_tusk: 2 };
    let m = await reply({ t: 'craft', r: 'iron_sword' }, (x) => x.note);
    ok('Schmiede nur aus der Nähe', m.note === 'forgefar' && a.p.inv.boar_hide === 3);
    a.p.x = S.FORGE.x; a.p.z = S.FORGE.z;
    m = await reply({ t: 'craft', r: 'iron_sword' }, (x) => x.crafted);
    ok('Schwert schmieden: Zutaten weg, Schwert in der Tasche',
      m.crafted.iron_sword === 1 && a.p.inv.iron_sword === 1 && !a.p.inv.boar_hide && !a.p.inv.boar_tusk);
    m = await reply({ t: 'craft', r: 'longbow' }, (x) => x.note);
    ok('Ohne Zutaten nichts schmieden', m.note === 'missing' && !a.p.inv.longbow);
    a.send({ t: 'craft', r: 'constructor' });
    await sleep(100);
    ok('Unbekannte Rezepte werden abgewiesen', !Object.prototype.hasOwnProperty.call(a.p.inv, 'constructor'));
    m = await reply({ t: 'weapon', w: 'iron_sword' }, (x) => x.self && x.self.weapon === 'iron_sword');
    ok('Geschmiedete Waffe anlegen, solange man sie hat', a.p.weapon === 'iron_sword');
    a.send({ t: 'weapon', w: 'constructor' });
    await sleep(100);
    ok('Unbekannte Waffennamen werden abgewiesen', a.p.weapon === 'iron_sword');
    await sleep(400);
    m = await reply({ t: 'drop', k: 'iron_sword' }, (x) => x.dropped);
    ok('Abgelegt: man kämpft wieder mit der Startwaffe', a.p.weapon === 'heavy' && !a.p.inv.iron_sword);
    await sleep(400);
    a.p.inv = { meat: 2 };
    a.p.x = 50; a.p.z = 50;
    m = await reply({ t: 'cook', k: 'meat', n: 1 }, (x) => x.note);
    ok('Grillen nur am Feuer', m.note === 'firefar' && a.p.inv.meat === 2);
    a.p.x = S.FIRE.x; a.p.z = S.FIRE.z;
    m = await reply({ t: 'cook', k: 'meat', n: 1 }, (x) => x.cooked);
    ok('Am Feuer: aus einem rohen wird ein gegrilltes Fleisch',
      m.cooked.grilled_meat === 1 && a.p.inv.meat === 1 && a.p.inv.grilled_meat === 1);
    a.p.hp = 20;
    m = await reply({ t: 'eat', k: 'meat' }, (x) => x.ate);
    ok('Rohes Fleisch heilt 15', m.heal === 15 && a.p.hp === 35 && !a.p.inv.meat);
    m = await reply({ t: 'eat', k: 'grilled_meat' }, (x) => x.ate);
    ok('Gegrilltes Fleisch heilt 30', m.heal === 30 && a.p.hp === 65);
    a.p.hp = a.p.hpMax;
    a.p.inv.grilled_meat = 1;
    m = await reply({ t: 'eat', k: 'grilled_meat' }, (x) => x.note);
    ok('Voll geheilt: nichts wird verbraucht', m.note === 'full' && a.p.inv.grilled_meat === 1);
    a.p.inv = {};
  });

  await safely('Gebäude sind Hindernisse', async () => {
    ok('Haus und Schmiede sind Hindernisse, die Straße nicht',
      S.inBuilding(-24, -16) && S.inBuilding(S.FORGE.x, S.FORGE.z) && !S.inBuilding(0, 0) && !S.inBuilding(-20, -16));
    a.p.x = -21.5; a.p.z = -16;                      // vor der Hauswand
    a.p.budget = 3; a.p.lastMoveAt = Date.now();
    const from = a.mark();
    a.send({ t: 'move', x: -22.6, z: -16, ry: 0, c: a.p.corr });   // hinein in die Wand
    const c = await a.waitFor((x) => x.t === 'correct', 2000, from);
    ok('Server lässt niemanden durch die Mauer laufen', !!c && a.p.x === -21.5);
  });

  await safely('Administrator-Figur', async () => {
    const oldEnv = process.env.ADMIN_NAMES;
    process.env.ADMIN_NAMES = ' Creator , Mira';
    ok('ADMIN_NAMES: Namen aus der Umgebung zählen, ohne Groß- und Kleinschreibung', S.isEnvAdmin('creator') && S.isEnvAdmin('MIRA') && !S.isEnvAdmin('Tester1'));
    process.env.ADMIN_NAMES = oldEnv;
    a.p.admin = true;                                // Kennzeichen wie vom Skript gesetzt
    a.p.inv = {};
    let from = a.mark();
    a.send({ t: 'admin', op: 'give', name: a.p.name, k: 'meat', n: 3 });
    let r = await a.waitFor((x) => x.t === 'admin' && x.op === 'give', 2000, from);
    ok('Gegenstand geben: kommt an', r.ok === true && a.p.inv.meat === 3, JSON.stringify(r));
    from = a.mark();
    a.send({ t: 'admin', op: 'give', name: a.p.name, k: 'nichts', n: 1 });
    r = await a.waitFor((x) => x.t === 'admin' && x.op === 'give', 2000, from);
    ok('Unbekannter Gegenstand wird abgelehnt', r.ok === false && !a.p.inv.nichts);
    from = a.mark();
    a.send({ t: 'admin', op: 'search', name: a.p.name.slice(0, 3) });
    r = await a.waitFor((x) => x.t === 'admin' && x.op === 'search', 2000, from);
    ok('Spieler suchen findet den eigenen Namen', r.results.some((q) => q.name === a.p.name && q.online === true));
    from = a.mark();
    a.send({ t: 'admin', op: 'ban', name: a.p.name, on: true });
    r = await a.waitFor((x) => x.t === 'admin' && x.op === 'ban', 2000, from);
    ok('Sich selbst sperren geht nicht', r.ok === false && a.p.ws.readyState === 1);
    from = a.mark();
    a.send({ t: 'admin', op: 'visible', on: false });
    r = await a.waitFor((x) => x.t === 'admin' && x.op === 'visible', 2000, from);
    ok('Unsichtbar schalten', r.ok === true && a.p.hidden === true);
    from = a.mark();
    a.send({ t: 'admin', op: 'visible', on: true });
    r = await a.waitFor((x) => x.t === 'admin' && x.op === 'visible', 2000, from);
    ok('Wieder sichtbar schalten', r.ok === true && a.p.hidden === false);
    await S.getStore().createAccount('Testopfer', 'testopfer', 'x');
    from = a.mark();
    a.send({ t: 'admin', op: 'ban', name: 'Testopfer', on: true });
    r = await a.waitFor((x) => x.t === 'admin' && x.op === 'ban', 2000, from);
    const opfer = await S.getStore().findAccount('testopfer');
    ok('Sperren speichert das Kennzeichen', r.ok === true && opfer.banned === true);
    from = a.mark();
    a.send({ t: 'admin', op: 'log' });
    const lg = await a.waitFor((x) => x.t === 'admin' && x.op === 'log', 2000, from);
    ok('Protokoll zeigt die Aktionen, neueste zuerst', lg.entries.length >= 4 && /sperrt Testopfer/.test(lg.entries[0].text)
      && lg.entries.some((e) => /gibt/.test(e.text)) && lg.entries[0].by === a.p.name);
    a.p.admin = false;
    from = a.mark();
    a.send({ t: 'admin', op: 'give', name: a.p.name, k: 'meat', n: 1 });
    await sleep(150);
    ok('Ohne Kennzeichen keine Verwaltung', a.p.inv.meat === 3 && a.count((x) => x.t === 'admin', from) === 0);
  });

  await safely('Aussehen', async () => {
    const oldNew = S.LIMITS.maxNew;
    S.LIMITS.maxNew = 1000;
    const lina = new Client(port, { t: 'register', name: 'Lina', pass: 'geheim123', look: { sex: 'f', skin: 3, hair: 4, style: 2, beard: 1 } });
    const w = await lina.ready();
    S.LIMITS.maxNew = oldNew;
    ok('Neue Figur: gewähltes Aussehen kommt an, Frauen ohne Bart',
      w.you.look.sex === 'f' && w.you.look.skin === 3 && w.you.look.hair === 4 && w.you.look.style === 2 && w.you.look.beard === 0, JSON.stringify(w.you.look));
    const join = await a.waitFor((x) => x.t === 'join' && x.player.name === 'Lina', 2000, 0);
    ok('Andere sehen das Aussehen beim Betreten', join.player.look.sex === 'f' && join.player.look.hair === 4);
    let from = a.mark();
    lina.send({ t: 'look', look: { sex: 'm', skin: 9, hair: 2, style: 1, beard: 1 } });
    const lk = await a.waitFor((x) => x.t === 'look' && x.id === lina.id, 2000, from);
    ok('Aussehen ändern: geprüft und an alle weitergegeben',
      lk.look.sex === 'm' && lk.look.skin === 1 && lk.look.hair === 2 && lk.look.style === 1 && lk.look.beard === 1, JSON.stringify(lk.look));
    ok('Aussehen wird mit dem Charakter gespeichert', S.snapshot(lina.p).look.sex === 'm' && S.snapshot(lina.p).look.beard === 1);
    lina.send({ t: 'look', look: { sex: 'f' } });            // gleich danach: gedrosselt
    await sleep(120);
    ok('Zu schnelle Änderungen werden ignoriert', lina.p.look.sex === 'm');
    ok('Unsinniges Aussehen wird zum Standard', JSON.stringify(S.normLook('quatsch')) === JSON.stringify({ sex: 'm', skin: 1, hair: 1, style: 0, beard: 0 }));
    lina.ws.close();
  });

  await safely('Statusseite', async () => {
    const st = await getJson('/status');
    ok('/status zeigt den Speicherweg ohne Geheimnisse', st && /Arbeitsspeicher/.test(st.speichern)
      && st.datenbank.zustand === 'bereit' && typeof st.spieler === 'number', JSON.stringify(st));
  });

  await safely('Speichern beim Beenden', async () => {
    kara.p.a.sta = 20.5;
    const aAccount = a.p.accountId;
    a.p.a.agi = 33.33;
    await S.stop();
    const k = await store.loadCharacter(karaAccount);
    const ac = await store.loadCharacter(aAccount);
    ok('Vor dem Beenden werden alle Spieler gespeichert', k.a.sta === 20.5 && ac.a.agi === 33.33);
  });

  console.log = origLog;
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log(`\nERGEBNIS: ${results.length - fails} PASS, ${fails} FAIL`);
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
