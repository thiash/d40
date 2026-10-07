// D40 – Spielserver
// Schritt 2: Tiere, Kampf und Lernen durch Tun.
// Der Server ist autoritativ: Er prüft jede Bewegung und rechnet Treffer, Schaden,
// Ausweichen, Heilung, Attributzuwachs und K.O. selbst aus. Der Client zeigt nur an.
//
// Nachrichten (JSON, das Feld "t" ist der Typ):
//   Client → Server:  move {x,z,ry,c}  attack  cast {s}  weapon {w}  ping {ts}
//   Server → Client:  welcome join leave state correct pong gear
//                     spawn despawn attack cast hitE hitP you ko revive

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const TICK_RATE = 20;              // Welt-Takte pro Sekunde
const SPEED_TOLERANCE = 1.25;      // Spielraum für schwankende Verbindungen
const MOVE_BUDGET_CAP = 3;         // so viele Meter lassen sich höchstens "ansparen"
const TIMING_TOLERANCE = 0.9;      // Angriffe dürfen wegen Netzwerk-Schwankungen etwas früher kommen
const WATER_LEVEL = -3.2;          // wie im Client

const COMBAT = {
  reach: 2.6,              // Nahkampfreichweite in Metern
  cone: 1.4,               // Zielkegel: bis 80 Grad links und rechts der Blickrichtung
  baseCooldown: 900,       // ms zwischen zwei Angriffen bei Beweglichkeit 10
  minCooldown: 450,        // schneller geht es nie: doppeltes Grundtempo
  spellCooldown: 1500,     // ms zwischen zwei Zaubern
  dodgeCap: 0.55,          // höchstens 55 % Ausweichchance
  koShare: 0.10,           // bei 10 % Leben K.O. statt Tod
  reviveMs: 20000,         // so lange dauert die Erholung nach einem K.O.
  reviveShare: 0.5,        // danach mit halbem Leben wieder auf den Beinen
  safeMs: 10000,           // anschließend lassen Tiere einen kurz in Ruhe
  idleMs: 60000,           // nach einer Minute ohne Eingabe gibt es keinen Zuwachs
  regenDelayMs: 8000,      // so lange nach dem letzten Kampf beginnt die Erholung
  regenShare: 0.01,        // pro Sekunde 1 % der Lebenspunkte
  leash: 22,               // so weit verfolgen Tiere jemanden höchstens
};

// Waffengattungen: learn = Zuwachs pro Treffer, dmg = Anteil der Attribute am Schaden
const WEAPONS = {
  heavy:  { name: 'Schwert', range: COMBAT.reach, base: 4, learn: { str: 0.01 }, dmg: { str: 1 } },
  dagger: { name: 'Dolch', range: COMBAT.reach, base: 3,
            learn: { str: 0.005, agi: 0.005 }, dmg: { str: 0.5, agi: 0.5 } },
  bow:    { name: 'Bogen', range: 18, base: 3, learn: { agi: 0.01 }, dmg: { agi: 1 } },
};
const SPELLS = {
  int: { name: 'Intelligenzzauber', range: 14, cost: 5, base: 3, learn: { int: 0.01 }, dmg: { int: 1 } },
  wis: { name: 'Weisheitszauber', cost: 6, heal: true, learn: { wis: 0.01 } },
};
const ENEMY_KINDS = {
  hare: { name: 'Hase', hp: 20, dmg: 0, speed: 3.4, aggro: 0, flee: true, share: 0.45 },
  wolf: { name: 'Wolf', hp: 45, dmg: 6, speed: 3.8, aggro: 10, atkMs: 1200, share: 0.35 },
  boar: { name: 'Keiler', hp: 70, dmg: 9, speed: 3.0, aggro: 0, atkMs: 1500, share: 0.2 },
};

const RULES = {                    // geht beim Verbinden an den Client
  speed: 6,
  worldHalf: 95,
  spellCooldown: COMBAT.spellCooldown,
  reviveMs: COMBAT.reviveMs,
  weapons: Object.fromEntries(Object.entries(WEAPONS).map(([k, w]) => [k, w.name])),
  spells: Object.fromEntries(Object.entries(SPELLS).map(([k, s]) => [k, { name: s.name, cost: s.cost }])),
  enemies: Object.fromEntries(Object.entries(ENEMY_KINDS).map(([k, e]) => [k, e.name])),
};

const WORLD = { maxEnemies: 24 };  // Obergrenze für Tiere in der Testzone

const COLORS = [0xa8443a, 0x3f6e9e, 0x6f8f3a, 0xb98a2e, 0x6d4f8f, 0x2f8a80, 0x9e3f6e, 0x55636e];

// ---------------------------------------------------------------------------
// Formeln: was die Attribute bewirken
// ---------------------------------------------------------------------------
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const heightAt = (x, z) =>                       // dieselbe Landschaft wie im Client
  Math.sin(x * 0.045) * 2.2 + Math.cos(z * 0.05) * 1.8
  + Math.sin((x + z) * 0.11) * 0.7 + Math.cos((x - z) * 0.07) * 0.9 - 0.8;
const onLand = (x, z) => heightAt(x, z) > WATER_LEVEL + 0.4;

const freshAttrs = () => ({ str: 10, sta: 10, agi: 10, int: 10, wis: 10 });
const maxHp = (a) => Math.round(50 + a.sta * 5);                      // Ausdauer → Lebenspunkte
const maxMana = (a) => Math.round(20 + a.wis * 4);                    // Weisheit → Mana
const manaRegen = (a) => 1 + a.wis * 0.05;                            // Weisheit → Mana pro Sekunde
const healShare = (a) => 0.05 + Math.max(0, a.wis - 10) * 0.001;      // Weisheit → Heilkraft, Start 5 %
const dodgeChance = (a) => clamp((a.agi - 10) * 0.01, 0, COMBAT.dodgeCap);  // Beweglichkeit → Ausweichen
const attackCooldown = (a) =>                                         // Beweglichkeit → Angriffstempo
  Math.round(Math.max(COMBAT.minCooldown, COMBAT.baseCooldown * clamp(10 / a.agi, 0.5, 1)));

function damageOf(def, a) {                                           // Attribute → Schaden
  let d = def.base;
  for (const k in def.dmg) d += a[k] * def.dmg[k] * 0.5;
  return Math.max(1, Math.round(d));
}

// ---------------------------------------------------------------------------
// HTTP: liefert die Dateien aus dem Ordner client/ aus
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
};

function serveFile(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Ungültige Adresse');
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Nur Dateien innerhalb von client/ ausliefern, nie etwas darüber
  const filePath = path.resolve(CLIENT_DIR, '.' + pathname);
  if (!filePath.startsWith(CLIENT_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Kein Zugriff');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nicht gefunden');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Spielzustand und Versand
// ---------------------------------------------------------------------------
const players = new Map();         // id → Spieler
const enemies = new Map();         // id → Tier
let nextId = 1;
let nextEnemyId = 1;

function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, x: r2(p.x), z: r2(p.z), ry: r2(p.ry),
           hp: Math.round(p.hp), hpMax: p.hpMax, ko: p.ko, w: p.weapon };
}
function publicEnemy(e) {
  return { id: e.id, kind: e.kind, x: r2(e.x), z: r2(e.z), ry: r2(e.ry), hp: e.hp, hpMax: e.hpMax };
}
function selfView(p) {             // was nur der Spieler selbst über sich erfährt
  return {
    hp: Math.round(p.hp), hpMax: p.hpMax, mana: Math.floor(p.mana), manaMax: p.manaMax,
    a: { ...p.a }, weapon: p.weapon, ko: p.ko,
    cd: attackCooldown(p.a), dodge: Math.round(dodgeChance(p.a) * 100),
    heal: Math.round(healShare(p.a) * 1000) / 10,
  };
}

function send(p, msg) {
  if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(msg));
}
function broadcast(msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.id !== exceptId && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}
function sendSelf(p, extra) {
  const msg = { t: 'you', self: selfView(p) };
  if (p.ups.length) { msg.up = p.ups; p.ups = []; }   // Attribute, die einen ganzen Punkt geschafft haben
  if (extra) Object.assign(msg, extra);
  send(p, msg);
}
function log(text) {
  console.log(`[${new Date().toLocaleTimeString('de-DE')}] ${text}`);
}

// ---------------------------------------------------------------------------
// Verbindung eines Spielers
// ---------------------------------------------------------------------------
function onConnection(ws) {
  const id = nextId++;
  const angle = Math.random() * Math.PI * 2;
  const spawnDist = 2 + Math.random() * 4;
  const a = freshAttrs();
  const now = Date.now();
  const p = {
    id, ws,
    name: `Wanderer ${id}`,
    color: COLORS[(id - 1) % COLORS.length],
    x: Math.cos(angle) * spawnDist, z: Math.sin(angle) * spawnDist, ry: 0,
    a, hp: maxHp(a), hpMax: maxHp(a), mana: maxMana(a), manaMax: maxMana(a),
    weapon: 'heavy', ups: [],
    budget: MOVE_BUDGET_CAP, lastMoveAt: now, lastInputAt: now,
    lastAttackAt: 0, lastCastAt: 0, lastFightAt: 0,
    ko: false, koAt: 0, safeUntil: 0, autoTarget: null,
    corr: 0, dirty: false, alive: true,
  };
  players.set(id, p);

  send(p, {
    t: 'welcome',
    you: publicPlayer(p),
    self: selfView(p),
    players: [...players.values()].filter((o) => o.id !== id).map(publicPlayer),
    enemies: [...enemies.values()].map(publicEnemy),
    rules: RULES,
  });
  broadcast({ t: 'join', player: publicPlayer(p) }, id);
  log(`${p.name} betritt die Welt (${players.size} online)`);
  maintainEnemies();

  ws.on('pong', () => { p.alive = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'move': handleMove(p, msg); break;
      case 'attack': handleAttack(p); break;
      case 'cast': handleCast(p, msg); break;
      case 'weapon': handleWeapon(p, msg); break;
      case 'ping': if (Number.isFinite(msg.ts)) send(p, { t: 'pong', ts: msg.ts }); break;
    }
  });
  ws.on('close', () => {
    players.delete(id);
    for (const e of enemies.values()) if (e.target === id) e.target = null;
    broadcast({ t: 'leave', id });
    log(`${p.name} verlässt die Welt (${players.size} online)`);
  });
  ws.on('error', () => {});        // Fehler führen ohnehin zu 'close'
}

function handleMove(p, msg) {
  if (p.ko || msg.c !== p.corr) return;   // bewusstlos oder veraltete Nachricht
  const { x, z, ry } = msg;
  if (![x, z, ry].every(Number.isFinite)) return;

  // Bewegungsbudget: wächst mit der Zeit nach, jede Bewegung verbraucht davon.
  const now = Date.now();
  p.budget = Math.min(MOVE_BUDGET_CAP,
    p.budget + ((now - p.lastMoveAt) / 1000) * RULES.speed * SPEED_TOLERANCE);
  p.lastMoveAt = now;

  const d = Math.hypot(x - p.x, z - p.z);
  const outside = Math.abs(x) > RULES.worldHalf || Math.abs(z) > RULES.worldHalf;
  if (d > p.budget || outside) {
    p.corr++;
    send(p, { t: 'correct', n: p.corr, x: r2(p.x), z: r2(p.z) });
    return;
  }
  p.budget -= d;
  p.x = x; p.z = z; p.ry = ry;
  p.dirty = true;
  p.lastInputAt = now;
}

function handleWeapon(p, msg) {
  if (p.ko || !WEAPONS[msg.w]) return;
  p.weapon = msg.w;
  p.lastInputAt = Date.now();
  broadcast({ t: 'gear', id: p.id, w: p.weapon }, p.id);
  sendSelf(p);
}

// ---------------------------------------------------------------------------
// Lernen durch Tun: nur wer gerade selbst spielt, wird besser
// ---------------------------------------------------------------------------
function learn(p, gains) {
  if (Date.now() - p.lastInputAt > COMBAT.idleMs) return;
  for (const k in gains) {
    const before = Math.floor(p.a[k]);
    p.a[k] = r3(p.a[k] + gains[k]);
    if (Math.floor(p.a[k]) > before) p.ups.push(k);
  }
  const hpMax = maxHp(p.a), manaMax = maxMana(p.a);
  if (hpMax > p.hpMax) p.hp += hpMax - p.hpMax;          // mehr Ausdauer: sofort mehr Leben
  if (manaMax > p.manaMax) p.mana += manaMax - p.manaMax;
  p.hpMax = hpMax;
  p.manaMax = manaMax;
}

// ---------------------------------------------------------------------------
// Kampf: Spieler gegen Tier
// ---------------------------------------------------------------------------
function angleDiff(a, b) {
  const d = a - b;
  return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
}

// Nächstes Tier im Kegel vor dem Spieler – sonst das Tier, das ihn gerade angreift
function findTarget(p, range) {
  let best = null, bestD = range;
  for (const e of enemies.values()) {
    const d = dist(p, e);
    if (d > bestD) continue;
    if (d > 0.8 && angleDiff(Math.atan2(e.x - p.x, e.z - p.z), p.ry) > COMBAT.cone) continue;
    best = e;
    bestD = d;
  }
  if (!best) {
    const e = enemies.get(p.autoTarget);
    if (e && dist(p, e) <= range) best = e;
  }
  return best;
}

function hurtEnemy(e, p, dmg, w) {
  e.hp = Math.max(0, e.hp - dmg);
  if (!e.target) e.target = p.id;         // das Tier wehrt sich – oder flieht
  broadcast({ t: 'hitE', by: p.id, id: e.id, dmg, hp: e.hp, w });
  if (e.hp <= 0) {
    enemies.delete(e.id);
    broadcast({ t: 'despawn', id: e.id, by: p.id });
  }
}

// Ein Schlag oder Schuss mit der angelegten Waffe – von Hand oder als Gegenangriff
function strike(p, e, auto) {
  const def = WEAPONS[p.weapon];
  const now = Date.now();
  p.lastAttackAt = now;
  p.lastFightAt = now;
  broadcast({ t: 'attack', id: p.id, w: p.weapon, te: e ? e.id : 0, auto: auto ? 1 : 0 });
  if (!e) return;                          // ins Leere: kein Treffer, nichts gelernt
  learn(p, def.learn);
  hurtEnemy(e, p, damageOf(def, p.a), p.weapon);
  sendSelf(p);
}

function handleAttack(p) {
  if (p.ko) return;
  const now = Date.now();
  if (now - p.lastAttackAt < attackCooldown(p.a) * TIMING_TOLERANCE) return;
  p.lastInputAt = now;
  strike(p, findTarget(p, WEAPONS[p.weapon].range), false);
}

function handleCast(p, msg) {
  const def = SPELLS[msg.s];
  if (!def || p.ko) return;
  const now = Date.now();
  if (now - p.lastCastAt < COMBAT.spellCooldown * TIMING_TOLERANCE) return;
  p.lastInputAt = now;
  if (p.mana < def.cost) return sendSelf(p, { note: 'mana' });

  if (def.heal) {                          // Weisheitszauber: heilt nur, wenn Leben fehlt
    if (p.hp >= p.hpMax) return sendSelf(p, { note: 'full' });
    const amount = Math.min(p.hpMax - p.hp, Math.max(1, Math.round(p.hpMax * healShare(p.a))));
    p.mana -= def.cost;
    p.lastCastAt = now;
    p.hp += amount;
    learn(p, def.learn);
    p.dirty = true;
    broadcast({ t: 'cast', id: p.id, s: msg.s, te: 0 });
    return sendSelf(p, { heal: amount });
  }

  const e = findTarget(p, def.range);      // Intelligenzzauber: braucht ein Ziel
  if (!e) return sendSelf(p, { note: 'notarget' });   // kein Mana verbraucht
  p.mana -= def.cost;
  p.lastCastAt = now;
  p.lastFightAt = now;
  broadcast({ t: 'cast', id: p.id, s: msg.s, te: e.id });
  learn(p, def.learn);
  hurtEnemy(e, p, damageOf(def, p.a), msg.s);
  sendSelf(p);
}

// ---------------------------------------------------------------------------
// Kampf: Tier gegen Spieler – Ausweichen, Schaden, Ausdauer, K.O.
// ---------------------------------------------------------------------------
function enemyStrikes(e, p) {
  const def = ENEMY_KINDS[e.kind];
  const now = Date.now();
  p.lastFightAt = now;
  if (!enemies.has(p.autoTarget)) p.autoTarget = e.id;    // Gegenangriff vorbereiten

  if (Math.random() < dodgeChance(p.a)) {  // ausgewichen: kein Schaden, aber auch keine Ausdauer
    broadcast({ t: 'hitP', by: e.id, id: p.id, dmg: 0, hp: Math.round(p.hp), dodge: 1 });
    return;
  }
  p.hp -= def.dmg;
  learn(p, { sta: 0.01 });                 // Einstecken trainiert Ausdauer
  const koHp = Math.round(p.hpMax * COMBAT.koShare);
  const ko = p.hp <= koHp;
  if (ko) p.hp = Math.max(1, koHp);
  broadcast({ t: 'hitP', by: e.id, id: p.id, dmg: def.dmg, hp: Math.round(p.hp) });
  if (ko) knockOut(p, now);
  p.dirty = true;
  sendSelf(p);
}

function knockOut(p, now) {
  p.ko = true;
  p.koAt = now;
  p.autoTarget = null;
  for (const e of enemies.values()) {      // die Tiere lassen ab und ziehen weiter
    if (e.target !== p.id) continue;
    e.target = null;
    e.ry = Math.atan2(e.x - p.x, e.z - p.z);
    e.moving = true;
    e.wanderAt = now + 5000;
  }
  broadcast({ t: 'ko', id: p.id, ms: COMBAT.reviveMs });
  log(`${p.name} ist bewusstlos`);
}

function revive(p, now) {
  p.ko = false;
  p.hp = Math.max(p.hp, Math.round(p.hpMax * COMBAT.reviveShare));
  p.safeUntil = now + COMBAT.safeMs;
  p.dirty = true;
  broadcast({ t: 'revive', id: p.id, hp: Math.round(p.hp) });
  sendSelf(p);
}

// ---------------------------------------------------------------------------
// Tiere: Bestand halten, umherstreifen, angreifen, fliehen
// ---------------------------------------------------------------------------
function pickKind() {
  let r = Math.random();
  for (const k in ENEMY_KINDS) {
    r -= ENEMY_KINDS[k].share;
    if (r < 0) return k;
  }
  return 'hare';
}

function spawnEnemy(kind, x, z) {
  const def = ENEMY_KINDS[kind];
  if (x === undefined) {                   // freien Platz an Land suchen, nicht direkt neben Spielern
    let found = false;
    for (let i = 0; i < 12 && !found; i++) {
      const ang = Math.random() * Math.PI * 2, d = 18 + Math.random() * 64;
      x = clamp(Math.cos(ang) * d, -90, 90);
      z = clamp(Math.sin(ang) * d, -90, 90);
      found = onLand(x, z) && [...players.values()].every((p) => Math.hypot(p.x - x, p.z - z) > 14);
    }
    if (!found) return null;
  }
  const e = {
    id: nextEnemyId++, kind, x, z, ry: Math.random() * Math.PI * 2,
    hp: def.hp, hpMax: def.hp, target: null,
    lastAttackAt: 0, wanderAt: 0, moving: false, dirty: false,
  };
  enemies.set(e.id, e);
  broadcast({ t: 'spawn', e: publicEnemy(e) });
  return e;
}

function maintainEnemies() {               // Dichte richtet sich nach der Spielerzahl
  const want = Math.min(WORLD.maxEnemies, 8 + players.size * 4);
  for (let i = 0; i < 40 && enemies.size < want; i++) spawnEnemy(pickKind());
}

function moveEnemy(e, nx, nz, speed, dt) {
  const x = clamp(e.x + nx * speed * dt, -92, 92);
  const z = clamp(e.z + nz * speed * dt, -92, 92);
  e.ry = Math.atan2(nx, nz);
  e.dirty = true;
  if (!onLand(x, z)) return false;         // Tiere meiden das Wasser
  e.x = x;
  e.z = z;
  return true;
}

function stepEnemies(dt, now) {
  for (const e of enemies.values()) {
    const def = ENEMY_KINDS[e.kind];
    let p = e.target ? players.get(e.target) : null;
    if (p && (p.ko || dist(e, p) > COMBAT.leash || (def.flee && dist(e, p) > 16))) {
      e.target = null;
      p = null;
    }
    if (!p && def.aggro > 0) {             // Wölfe suchen sich selbst ein Ziel
      for (const q of players.values()) {
        if (q.ko || now < q.safeUntil || dist(e, q) > def.aggro) continue;
        e.target = q.id;
        p = q;
        break;
      }
    }

    if (p) {
      const dx = p.x - e.x, dz = p.z - e.z;
      const d = Math.hypot(dx, dz) || 0.001;
      if (def.flee) {
        moveEnemy(e, -dx / d, -dz / d, def.speed, dt);
      } else {
        if (d > 1.3) moveEnemy(e, dx / d, dz / d, def.speed, dt);
        else { e.ry = Math.atan2(dx, dz); e.dirty = true; }
        if (d <= 1.7 && now - e.lastAttackAt >= def.atkMs) {
          e.lastAttackAt = now;
          enemyStrikes(e, p);
        }
      }
    } else {
      if (now > e.wanderAt) {
        e.wanderAt = now + 2000 + Math.random() * 3000;
        e.ry = Math.random() * Math.PI * 2;
        e.moving = Math.random() < 0.6;
      }
      if (e.moving && !moveEnemy(e, Math.sin(e.ry), Math.cos(e.ry), def.speed * 0.35, dt)) {
        e.wanderAt = 0;                    // ans Wasser gestoßen: neue Richtung
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Spieler im Takt: Erholung nach K.O. und automatischer Gegenangriff
// ---------------------------------------------------------------------------
function stepPlayer(p, now) {
  if (p.ko) {
    if (now - p.koAt >= COMBAT.reviveMs) revive(p, now);
    return;
  }
  if (p.autoTarget === null) return;
  const e = enemies.get(p.autoTarget);
  if (!e || dist(p, e) > COMBAT.leash) {
    p.autoTarget = null;
    return;
  }
  if (dist(p, e) <= WEAPONS[p.weapon].range && now - p.lastAttackAt >= attackCooldown(p.a)) {
    strike(p, e, true);                    // ohne Eingabe – zählt deshalb nicht als Aktivität
  }
}

function regenTick() {                     // einmal pro Sekunde
  const now = Date.now();
  for (const p of players.values()) {
    if (p.ko) continue;
    let changed = false;
    if (p.mana < p.manaMax) {
      p.mana = Math.min(p.manaMax, p.mana + manaRegen(p.a));
      changed = true;
    }
    if (p.hp < p.hpMax && now - p.lastFightAt >= COMBAT.regenDelayMs) {
      p.hp = Math.min(p.hpMax, p.hp + Math.max(1, Math.round(p.hpMax * COMBAT.regenShare)));
      p.dirty = true;
      changed = true;
    }
    if (changed) sendSelf(p);
  }
}

let lastTick = Date.now();
function tick() {
  const now = Date.now();
  const dt = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;
  stepEnemies(dt, now);
  for (const p of players.values()) stepPlayer(p, now);

  const pc = [], ec = [];
  for (const p of players.values()) {
    if (!p.dirty) continue;
    pc.push([p.id, r2(p.x), r2(p.z), r2(p.ry), Math.round(p.hp), p.hpMax, p.ko ? 1 : 0]);
    p.dirty = false;
  }
  for (const e of enemies.values()) {
    if (!e.dirty) continue;
    ec.push([e.id, r2(e.x), r2(e.z), r2(e.ry)]);
    e.dirty = false;
  }
  if (pc.length || ec.length) broadcast({ t: 'state', p: pc, e: ec });
}

function checkAlive() {                    // abgerissene Verbindungen aufräumen
  for (const p of players.values()) {
    if (!p.alive) { p.ws.terminate(); continue; }
    p.alive = false;
    p.ws.ping();
  }
}

// ---------------------------------------------------------------------------
// Start und Stopp
// ---------------------------------------------------------------------------
let httpServer = null;
let wss = null;
let timers = [];

function start(port = Number(process.env.PORT) || 3000) {
  httpServer = http.createServer(serveFile);
  wss = new WebSocketServer({ server: httpServer, maxPayload: 4096 });
  wss.on('connection', onConnection);
  wss.on('error', () => {});               // Startfehler meldet listen() unten
  lastTick = Date.now();
  timers = [
    setInterval(tick, 1000 / TICK_RATE),
    setInterval(regenTick, 1000),
    setInterval(maintainEnemies, 5000),
    setInterval(checkAlive, 30000),
  ];
  maintainEnemies();
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, () => {
      log(`D40-Server läuft: http://localhost:${httpServer.address().port}`);
      resolve(httpServer.address().port);
    });
  });
}

function stop() {
  timers.forEach(clearInterval);
  for (const p of players.values()) p.ws.terminate();
  players.clear();
  enemies.clear();
  if (wss) wss.close();
  if (httpServer) httpServer.close();
}

if (require.main === module) {
  start().catch((err) => {
    if (err.code === 'EADDRINUSE') console.error('Der Port ist schon belegt. Läuft der Server bereits?');
    else console.error(err);
    process.exit(1);
  });
}

// Für die automatischen Tests
module.exports = {
  start, stop, players, enemies, spawnEnemy, COMBAT, WORLD, WEAPONS, SPELLS, ENEMY_KINDS,
  freshAttrs, maxHp, maxMana, manaRegen, healShare, attackCooldown, dodgeChance, damageOf, heightAt,
};
