// D40 – Spielserver
// Schritt 1: liefert den Client aus und synchronisiert alle Spieler in Echtzeit.
// Der Server ist autoritativ: Er prüft jede Bewegung, bevor er sie übernimmt.
//
// Nachrichten (JSON, das Feld "t" ist der Typ):
//   Client → Server:  move {x, z, ry, c}   attack   ping {ts}
//   Server → Client:  welcome  join  leave  state  attack  correct  pong

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const CLIENT_DIR = path.join(__dirname, '..', 'client');

const TICK_RATE = 20;              // Positions-Updates pro Sekunde an alle Clients
const RULES = {                    // wird beim Verbinden an den Client geschickt
  speed: 6,                        // Laufgeschwindigkeit in Metern pro Sekunde
  worldHalf: 95,                   // Spielfeld reicht von -95 bis +95 Meter
};
const SPEED_TOLERANCE = 1.25;      // Spielraum für schwankende Verbindungen
const MOVE_BUDGET_CAP = 3;         // so viele Meter lassen sich höchstens "ansparen"
const ATTACK_COOLDOWN_MS = 400;    // etwas kürzer als im Client, wegen Netzwerk-Schwankungen

// Kittelfarben, reihum vergeben
const COLORS = [0xa8443a, 0x3f6e9e, 0x6f8f3a, 0xb98a2e, 0x6d4f8f, 0x2f8a80, 0x9e3f6e, 0x55636e];

// ---------------------------------------------------------------------------
// HTTP: liefert die Dateien aus dem Ordner client/ aus
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

const httpServer = http.createServer((req, res) => {
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
});

// ---------------------------------------------------------------------------
// WebSocket: Echtzeit-Verbindung zu den Spielern
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer, maxPayload: 4096 });
const players = new Map();         // id → Spielerzustand
let nextId = 1;

const r2 = (v) => Math.round(v * 100) / 100;

function publicState(p) {
  return { id: p.id, name: p.name, color: p.color, x: r2(p.x), z: r2(p.z), ry: r2(p.ry) };
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

function log(text) {
  console.log(`[${new Date().toLocaleTimeString('de-DE')}] ${text}`);
}

wss.on('connection', (ws) => {
  const id = nextId++;
  const angle = Math.random() * Math.PI * 2;
  const spawnDist = 2 + Math.random() * 4;
  const p = {
    id,
    ws,
    name: `Wanderer ${id}`,
    color: COLORS[(id - 1) % COLORS.length],
    x: Math.cos(angle) * spawnDist,
    z: Math.sin(angle) * spawnDist,
    ry: 0,
    budget: MOVE_BUDGET_CAP,       // Strecke, die der Spieler gerade laufen darf
    lastMoveAt: Date.now(),
    lastAttackAt: 0,
    corr: 0,                       // zählt Korrekturen durch den Server
    dirty: false,                  // Position hat sich seit dem letzten Tick geändert
    alive: true,                   // für den Verbindungs-Check per Ping/Pong
  };
  players.set(id, p);

  send(p, {
    t: 'welcome',
    you: publicState(p),
    players: [...players.values()].filter((o) => o.id !== id).map(publicState),
    rules: RULES,
  });
  broadcast({ t: 'join', player: publicState(p) }, id);
  log(`${p.name} betritt die Welt (${players.size} online)`);

  ws.on('pong', () => { p.alive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'move': handleMove(p, msg); break;
      case 'attack': handleAttack(p); break;
      case 'ping': if (Number.isFinite(msg.ts)) send(p, { t: 'pong', ts: msg.ts }); break;
    }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ t: 'leave', id });
    log(`${p.name} verlässt die Welt (${players.size} online)`);
  });

  ws.on('error', () => {});        // Fehler führen ohnehin zu 'close'
});

function handleMove(p, msg) {
  if (msg.c !== p.corr) return;    // veraltete Nachricht von vor einer Korrektur
  const { x, z, ry } = msg;
  if (![x, z, ry].every(Number.isFinite)) return;

  // Bewegungsbudget: wächst mit der Zeit nach, jede Bewegung verbraucht davon.
  // So bleiben kurze Netzwerk-Ruckler erlaubt, Speedhacks aber nicht.
  const now = Date.now();
  p.budget = Math.min(
    MOVE_BUDGET_CAP,
    p.budget + ((now - p.lastMoveAt) / 1000) * RULES.speed * SPEED_TOLERANCE
  );
  p.lastMoveAt = now;

  const dist = Math.hypot(x - p.x, z - p.z);
  const outside = Math.abs(x) > RULES.worldHalf || Math.abs(z) > RULES.worldHalf;
  if (dist > p.budget || outside) {
    p.corr++;
    send(p, { t: 'correct', n: p.corr, x: r2(p.x), z: r2(p.z) });
    return;
  }

  p.budget -= dist;
  p.x = x;
  p.z = z;
  p.ry = ry;
  p.dirty = true;
}

function handleAttack(p) {
  const now = Date.now();
  if (now - p.lastAttackAt < ATTACK_COOLDOWN_MS) return;
  p.lastAttackAt = now;
  broadcast({ t: 'attack', id: p.id }, p.id);
  // Nächster Schritt: Hier berechnet der Server Treffer und Schaden.
}

// ---------------------------------------------------------------------------
// Spieltakt: geänderte Positionen an alle schicken
// ---------------------------------------------------------------------------
setInterval(() => {
  const changed = [];
  for (const p of players.values()) {
    if (!p.dirty) continue;
    changed.push([p.id, r2(p.x), r2(p.z), r2(p.ry)]);
    p.dirty = false;
  }
  if (changed.length) broadcast({ t: 'state', p: changed });
}, 1000 / TICK_RATE);

// Abgerissene Verbindungen aufräumen (alle 30 Sekunden ein Ping)
setInterval(() => {
  for (const p of players.values()) {
    if (!p.alive) { p.ws.terminate(); continue; }
    p.alive = false;
    p.ws.ping();
  }
}, 30000);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} ist schon belegt. Läuft der Server bereits in einem anderen Fenster?`);
    process.exit(1);
  }
  throw err;
});

httpServer.listen(PORT, () => {
  log(`D40-Server läuft: http://localhost:${PORT}`);
});
