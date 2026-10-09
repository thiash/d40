// D40 – Spielserver
// Schritt 4: Beute, Tasche mit Gewicht und Truhe.
// Davor: Anmeldung und Speichern (3), Tiere, Kampf, Lernen durch Tun (2).
// Der Server ist autoritativ: Er prüft jede Bewegung und rechnet Treffer, Schaden,
// Ausweichen, Heilung, Attributzuwachs und K.O. selbst aus. Der Client zeigt nur an.
// Wer spielen will, meldet sich mit Name und Passwort an. Charaktere werden alle
// 30 Sekunden, beim Verlassen und vor einem Neustart des Servers gespeichert.
//
// Nachrichten (JSON, das Feld "t" ist der Typ):
//   Vor der Anmeldung:
//     Server → Client:  hello {persist}
//     Client → Server:  register {name,pass}  login {name,pass}  resume {token}
//     Server → Client:  auth {token,name,fresh}  denied {code,text}
//   Im Spiel:
//     Client → Server:  move {x,z,ry,c}  attack  cast {s}  weapon {w}  ping {ts}  logout
//                       pick {id}  drop {k,n}  chest {op,k,n}  craft {r}  cook {k,n}  eat {k}
//     Server → Client:  welcome join leave state correct pong gear
//                       spawn despawn attack cast hitE hitP you ko revive
//                       loot {l}  unloot {id,by}  chest {items}
//                       kicked (woanders angemeldet)  bye (abgemeldet)  notice

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const {
  createStore, hashPassword, verifyPassword, newToken, hashToken, checkName, checkPassword,
} = require('./store');

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const SAVE = { everyMs: 30000, flushMs: 8000 };   // Speichertakt; so lange wird vor dem Beenden gewartet
const LIMITS = {                   // Schutz vor Passwort-Raten und Massen-Anmeldungen, je Internetadresse
  failWindowMs: 10 * 60 * 1000, maxFails: 8,
  newWindowMs: 60 * 60 * 1000, maxNew: 6,
};
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
  // Geschmiedet: nur mit dem Gegenstand in der Tasche angelegt
  iron_sword:  { name: 'Eisenschwert', range: COMBAT.reach, base: 6, learn: { str: 0.01 }, dmg: { str: 1.4 }, crafted: true },
  iron_dagger: { name: 'Eisendolch', range: COMBAT.reach, base: 4.5, learn: { str: 0.005, agi: 0.005 }, dmg: { str: 0.7, agi: 0.7 }, crafted: true },
  longbow:     { name: 'Langbogen', range: 22, base: 4.5, learn: { agi: 0.01 }, dmg: { agi: 1.4 }, crafted: true },
};
const SPELLS = {
  int: { name: 'Intelligenzzauber', range: 14, cost: 5, base: 3, learn: { int: 0.01 }, dmg: { int: 1 } },
  wis: { name: 'Weisheitszauber', cost: 6, heal: true, learn: { wis: 0.01 } },
};
// Gegner. teach = bis zu dieser Attributsumme lernt man an ihnen voll, danach immer weniger
// (siehe LEARN). mul = so viel schneller lernt man an ihnen als an Tieren.
// Menschen (human) stehen auf festen Wachposten, kehren dorthin zurück und rufen Kameraden zu Hilfe.
// range = Fernkampf (Pfeil oder Feuer), sonst Nahkampf. gear: Helm (0–3) und Schild fürs Aussehen.
const ENEMY_KINDS = {
  hare: { name: 'Hase', hp: 20, dmg: 0, speed: 3.4, aggro: 0, flee: true, share: 0.45, teach: 70 },
  wolf: { name: 'Wolf', hp: 45, dmg: 6, speed: 3.8, aggro: 10, atkMs: 1200, share: 0.35, teach: 95 },
  boar: { name: 'Keiler', hp: 70, dmg: 9, speed: 3.0, aggro: 0, atkMs: 1500, share: 0.2, teach: 105 },
  // Besatzung der Festung Grauwacht
  scout:   { name: 'Späher', human: true, w: 'bow', range: 13, shot: 'arrow', hp: 460, dmg: 26, speed: 3.6,
             aggro: 12, atkMs: 1900, teach: 150, mul: 1.5, respawnMs: 60000, gear: { helmet: 0, tunic: 0x4f5a35 } },
  guard:   { name: 'Wächter', human: true, w: 'heavy', hp: 750, dmg: 25, speed: 3.4,
             aggro: 9, atkMs: 1500, teach: 185, mul: 1.75, respawnMs: 70000, gear: { helmet: 1, shield: 1, tunic: 0x58626e } },
  merc:    { name: 'Söldner', human: true, w: 'iron_dagger', hp: 950, dmg: 22, speed: 4.0,
             aggro: 9, atkMs: 1000, teach: 220, mul: 2, respawnMs: 75000, gear: { helmet: 0, tunic: 0x6e2f2a } },
  mage:    { name: 'Kampfmagier', human: true, w: 'staff', range: 12, shot: 'fire', hp: 720, dmg: 50, speed: 3.2,
             aggro: 11, atkMs: 2000, teach: 250, mul: 2.25, respawnMs: 80000, gear: { helmet: 0, tunic: 0x4a3566 } },
  veteran: { name: 'Veteran', human: true, w: 'iron_sword', hp: 1600, dmg: 44, speed: 3.6,
             aggro: 9, atkMs: 1400, teach: 285, mul: 2.5, respawnMs: 90000, gear: { helmet: 2, shield: 1, tunic: 0x2e3238 } },
  captain: { name: 'Hauptmann', human: true, w: 'iron_sword', hp: 4200, dmg: 48, speed: 3.8,
             aggro: 10, atkMs: 1300, teach: 340, mul: 3, respawnMs: 240000, gear: { helmet: 3, shield: 1, tunic: 0x7a1f24 } },
};
// Lernen hängt vom Gegner ab: Bis zu seiner Stufe (teach) voll, in den nächsten 25 Punkten
// der Attributsumme immer weniger, danach nichts mehr. Ziel für die Wiedergeburt: Summe 300.
const LEARN = { fade: 25, goal: 300, recentMs: 30000, weakNoteMs: 60000 };
const HUMAN = {
  reach: 1.9,              // Nahkampfreichweite der Menschen
  leash: 26,               // so weit vom Posten verfolgen sie jemanden höchstens
  help: 6,                 // in diesem Umkreis eilen Kameraden zu Hilfe
  roam: 3.5,               // so weit entfernen sie sich ohne Ziel vom Posten
  returnMs: 15000,         // wer so lange nicht heimfindet (Mauer im Weg), steht danach einfach wieder dort
};

// Gegenstände: Gewicht in kg. "plural" für Meldungen wie "2 Wolfszähne".
const ITEMS = {
  hare_pelt: { name: 'Hasenfell', plural: 'Hasenfelle', kg: 0.3 },
  wolf_pelt: { name: 'Wolfsfell', plural: 'Wolfsfelle', kg: 1.5 },
  boar_hide: { name: 'Keilerschwarte', plural: 'Keilerschwarten', kg: 3 },
  wolf_fang: { name: 'Wolfszahn', plural: 'Wolfszähne', kg: 0.05 },
  boar_tusk: { name: 'Keilerhauer', plural: 'Keilerhauer', kg: 0.3 },
  meat:      { name: 'Wildfleisch', plural: 'Wildfleisch', kg: 0.5 },
  grilled_meat: { name: 'Gegrilltes Fleisch', plural: 'Gegrilltes Fleisch', kg: 0.4 },
  ration:    { name: 'Proviant', plural: 'Proviant', kg: 0.4 },
  // Geschmiedete Waffen: zugleich Gegenstand (man trägt sie) und Waffenname
  iron_sword:  { name: 'Eisenschwert', plural: 'Eisenschwerter', kg: 2.5 },
  iron_dagger: { name: 'Eisendolch', plural: 'Eisendolche', kg: 0.8 },
  longbow:     { name: 'Langbogen', plural: 'Langbogen', kg: 1.2 },
};
// Rezepte: was die Schmiede aus Tasche-Gegenständen macht
const CRAFT = {
  iron_sword:  { cost: { boar_hide: 3, boar_tusk: 2 } },
  iron_dagger: { cost: { wolf_pelt: 2, wolf_fang: 2 } },
  longbow:     { cost: { hare_pelt: 2, boar_tusk: 1, wolf_fang: 1 } },
};
// Nahrung: wie viele Lebenspunkte sie heilt
const FOOD = { meat: { heal: 15 }, grilled_meat: { heal: 30 }, ration: { heal: 60 } };
const FORGE = { x: -14, z: -8, reach: 3 };    // Schmiede im Dorf neben dem Startplatz
const CRAFTING = { ms: 3000 };                // so lange dauert das Schmieden einer Waffe
const FIRE = { x: 14, z: -8, reach: 3 };      // Lagerfeuer zum Grillen
// Festung Grauwacht im Norden: Mauergeviert mit Tor im Süden, Türme, Bergfried, Unterkünfte.
// Davor ein Vorposten am Weg. Dieselben Zahlen stehen im Client (world.js).
const FORT = { x: 25, z: -150, half: 22, wall: 1.6, gate: 7, y: 1.2, flat: 36, blend: 56 };
const CAMP = { x: 10, z: -98 };
function fortBuildings() {
  const { x, z, half, wall, gate } = FORT;
  const side = 2 * half + wall;
  const seg = half + wall / 2 - gate / 2;           // Länge eines Mauerstücks neben dem Tor
  return [
    { x, z: z - half, w: side, d: wall, h: 4.5, kind: 'wall' },                       // Nordmauer
    { x: x - half, z, w: wall, d: side, h: 4.5, kind: 'wall' },                       // Westmauer
    { x: x + half, z, w: wall, d: side, h: 4.5, kind: 'wall' },                       // Ostmauer
    { x: x - half - wall / 2 + seg / 2, z: z + half, w: seg, d: wall, h: 4.5, kind: 'wall' },   // Südmauer links vom Tor
    { x: x + half + wall / 2 - seg / 2, z: z + half, w: seg, d: wall, h: 4.5, kind: 'wall' },   // Südmauer rechts vom Tor
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) =>
      ({ x: x + sx * half, z: z + sz * half, w: 4.4, d: 4.4, h: 7, kind: 'tower' })),
    ...[-1, 1].map((s) => ({ x: x + s * (gate / 2 + 1.4), z: z + half, w: 2.8, d: 2.8, h: 6, kind: 'gatetower' })),
    { x, z: z - 11, w: 11, d: 9, h: 8.5, kind: 'keep' },                              // Bergfried
    { x: x - 13.5, z: z + 1, w: 5, d: 10, h: 3, kind: 'barracks' },                   // Unterkünfte
    { x: x + 13.5, z: z + 1, w: 5, d: 10, h: 3, kind: 'barracks' },
    { x: CAMP.x - 5, z: CAMP.z - 3, w: 2.6, d: 3, h: 1.9, kind: 'tent' },             // Zelte des Vorpostens
    { x: CAMP.x + 4.5, z: CAMP.z - 4, w: 2.6, d: 3, h: 1.9, kind: 'tent' },
    { x: CAMP.x - 1, z: CAMP.z + 5, w: 3, d: 2.6, h: 1.9, kind: 'tent' },
  ];
}
// Gebäude sind feste Hindernisse – dieselbe Liste wie im Client (world.js)
const BUILDINGS = [
  { x: FORGE.x, z: FORGE.z, w: 4, d: 3.4, h: 2.4, kind: 'forge' },
  { x: -24, z: -16, w: 3, d: 2.6, h: 2.2, kind: 'house' },
  { x: 10, z: -20, w: 2.6, d: 2.4, h: 2, kind: 'house' },
  ...fortBuildings(),
];
const BUILDING_PAD = 0.35;
const inBuilding = (x, z) => BUILDINGS.some((b) =>
  Math.abs(x - b.x) < b.w / 2 + BUILDING_PAD && Math.abs(z - b.z) < b.d / 2 + BUILDING_PAD);
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
// Was ein besiegtes Tier fallen lässt: Chance p, Anzahl zwischen n[0] und n[1]
const DROPS = {
  hare: [{ k: 'hare_pelt', p: 0.8, n: [1, 1] }, { k: 'meat', p: 0.6, n: [1, 1] }],
  wolf: [{ k: 'wolf_pelt', p: 0.7, n: [1, 1] }, { k: 'wolf_fang', p: 0.6, n: [1, 2] }, { k: 'meat', p: 0.4, n: [1, 1] }],
  boar: [{ k: 'boar_hide', p: 0.75, n: [1, 1] }, { k: 'boar_tusk', p: 0.5, n: [1, 2] }, { k: 'meat', p: 0.8, n: [1, 3] }],
  // Menschen tragen Proviant bei sich, manchmal lassen sie ihre Waffe fallen
  scout:   [{ k: 'ration', p: 0.5, n: [1, 1] }, { k: 'longbow', p: 0.06, n: [1, 1] }],
  guard:   [{ k: 'ration', p: 0.5, n: [1, 1] }, { k: 'iron_sword', p: 0.05, n: [1, 1] }],
  merc:    [{ k: 'ration', p: 0.55, n: [1, 1] }, { k: 'iron_dagger', p: 0.08, n: [1, 1] }],
  mage:    [{ k: 'ration', p: 0.6, n: [1, 2] }],
  veteran: [{ k: 'ration', p: 0.7, n: [1, 2] }, { k: 'iron_sword', p: 0.12, n: [1, 1] }],
  captain: [{ k: 'ration', p: 1, n: [2, 4] }, { k: 'iron_sword', p: 0.5, n: [1, 1] }, { k: 'longbow', p: 0.5, n: [1, 1] }],
};
// Wachposten der Festung: dort stehen die Menschen und dorthin kehren sie zurück.
// ry = Blickrichtung (0 = nach Süden, zum Weg hin)
function fortPosts() {
  const { x, z } = FORT;
  const c = CAMP;
  return [
    // Vorposten am Weg
    { kind: 'scout', x: c.x + 1, z: c.z - 1, ry: 0.3 },
    { kind: 'scout', x: c.x + 7, z: c.z + 2, ry: 0.6 },
    { kind: 'guard', x: c.x - 3, z: c.z + 1, ry: 0.2 },
    { kind: 'guard', x: c.x + 3, z: c.z + 6, ry: 0.4 },
    { kind: 'scout', x: c.x - 7, z: c.z + 3, ry: -0.2 },
    // Vor dem Tor
    { kind: 'guard', x: x - 4, z: z + 26, ry: 0 },
    { kind: 'guard', x: x + 4, z: z + 26, ry: 0 },
    { kind: 'scout', x: x - 10, z: z + 27, ry: 0 },
    // Vorhof hinter dem Tor
    { kind: 'merc', x: x - 5, z: z + 15, ry: 0 },
    { kind: 'merc', x: x + 5, z: z + 15, ry: 0 },
    { kind: 'guard', x: x - 8, z: z + 9, ry: 0.3 },
    { kind: 'merc', x: x + 8, z: z + 9, ry: -0.3 },
    { kind: 'scout', x: x - 17, z: z + 16, ry: 0.5 },
    { kind: 'scout', x: x + 17, z: z + 16, ry: -0.5 },
    // Innenhof vor dem Bergfried
    { kind: 'mage', x: x - 9, z: z - 4, ry: 0.4 },
    { kind: 'mage', x: x + 9, z: z - 4, ry: -0.4 },
    { kind: 'veteran', x: x - 5, z: z + 1, ry: 0 },
    { kind: 'veteran', x: x + 5, z: z + 1, ry: 0 },
    { kind: 'veteran', x: x - 15, z: z - 12, ry: 0.8 },
    { kind: 'veteran', x: x + 15, z: z - 12, ry: -0.8 },
    { kind: 'captain', x, z: z - 4.5, ry: 0 },
  ].map((p) => ({ ...p, enemyId: null, deadAt: 0 }));
}
const POSTS = fortPosts();
// Reiseziele der Administratoren zum Testen
const ADMIN_TRAVEL = {
  start: { x: 0, z: 3, name: 'am Startplatz' },
  camp: { x: CAMP.x + 14, z: CAMP.z + 16, name: 'vor dem Vorposten' },
  fort: { x: FORT.x, z: FORT.z + FORT.half + 16, name: 'vor dem Tor der Festung' },
};
const LOOT = {
  reach: 2.6,              // so nah muss man an Beute oder Truhe heran
  reserveMs: 30000,        // so lange gehört die Beute nur dem Sieger
  expireMs: 180000,        // danach zerfällt sie
  maxPiles: 200,           // mehr Haufen liegen nie gleichzeitig in der Welt
  dropGapMs: 300,          // Ablegen höchstens alle 0,3 Sekunden
  maxStack: 99999,
};
const CHEST = { x: 0, z: 0, reach: 3 };   // die Truhe in der Mitte des Startplatzes
const CARRY = { perPoint: 4, slowFrom: 1, stopAt: 1.5, minFactor: 0.3 };

const RULES = {                    // geht beim Verbinden an den Client
  speed: 6,
  worldHalf: 200,
  spellCooldown: COMBAT.spellCooldown,
  reviveMs: COMBAT.reviveMs,
  weapons: Object.fromEntries(Object.entries(WEAPONS).map(([k, w]) => [k, w.name])),
  craft: Object.fromEntries(Object.entries(CRAFT).map(([k, r]) => [k, r.cost])),
  food: FOOD, forge: FORGE, fire: FIRE, buildings: BUILDINGS, craftMs: CRAFTING.ms,
  spells: Object.fromEntries(Object.entries(SPELLS).map(([k, s]) => [k, { name: s.name, cost: s.cost }])),
  enemies: Object.fromEntries(Object.entries(ENEMY_KINDS).map(([k, e]) => [k, {
    name: e.name, teach: e.teach, human: !!e.human, w: e.w || null, shot: e.shot || null, gear: e.gear || null,
  }])),
  learn: { fade: LEARN.fade, goal: LEARN.goal },
  fort: FORT, camp: CAMP,
  items: ITEMS,
  lootReach: LOOT.reach,
  chest: CHEST,
};

const WORLD = { maxEnemies: 24, posts: true };  // Obergrenze für Tiere; posts = Festung besetzt

// Aussehen der Figur – dieselben Grenzen wie im Client (character.js)
const LOOK_LIMITS = { skin: 4, hair: 5, style: 4, beard: 3, face: 3, build: 2 };
function normLook(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const int = (v, max, d) => (Number.isInteger(v) && v >= 0 && v <= max ? v : d);
  const sex = r.sex === 'f' ? 'f' : 'm';
  return {
    sex,
    skin: int(r.skin, LOOK_LIMITS.skin, 1),
    hair: int(r.hair, LOOK_LIMITS.hair, 1),
    style: int(r.style, LOOK_LIMITS.style, 0),
    beard: sex === 'm' ? int(r.beard, LOOK_LIMITS.beard, 0) : 0,
    face: int(r.face, LOOK_LIMITS.face, 0),
    build: int(r.build, LOOK_LIMITS.build, 1),
  };
}
const LOOK_GAP_MS = 250;           // Aussehen höchstens viermal pro Sekunde ändern

const COLORS = [0xa8443a, 0x3f6e9e, 0x6f8f3a, 0xb98a2e, 0x6d4f8f, 0x2f8a80, 0x9e3f6e, 0x55636e];

// ---------------------------------------------------------------------------
// Formeln: was die Attribute bewirken
// ---------------------------------------------------------------------------
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
// Dieselbe Landschaft wie im Client. Um die Festung ist der Boden eingeebnet.
function heightAt(x, z) {
  const n = Math.sin(x * 0.045) * 2.2 + Math.cos(z * 0.05) * 1.8
    + Math.sin((x + z) * 0.11) * 0.7 + Math.cos((x - z) * 0.07) * 0.9 - 0.8;
  const d = Math.hypot(x - FORT.x, z - FORT.z);
  if (d >= FORT.blend) return n;
  const t = d <= FORT.flat ? 1 : (FORT.blend - d) / (FORT.blend - FORT.flat);
  return n + (FORT.y - n) * t * t * (3 - 2 * t);
}
const onLand = (x, z) => heightAt(x, z) > WATER_LEVEL + 0.4;

const freshAttrs = () => ({ str: 10, sta: 10, agi: 10, int: 10, wis: 10 });
const maxHp = (a) => Math.round(50 + a.sta * 5);                      // Ausdauer → Lebenspunkte
const maxMana = (a) => Math.round(20 + a.wis * 4);                    // Weisheit → Mana
const manaRegen = (a) => 1 + a.wis * 0.05;                            // Weisheit → Mana pro Sekunde
const healShare = (a) => 0.05 + Math.max(0, a.wis - 10) * 0.001;      // Weisheit → Heilkraft, Start 5 %
const dodgeChance = (a) => clamp((a.agi - 10) * 0.01, 0, COMBAT.dodgeCap);  // Beweglichkeit → Ausweichen
const attackCooldown = (a) =>                                         // Beweglichkeit → Angriffstempo
  Math.round(Math.max(COMBAT.minCooldown, COMBAT.baseCooldown * clamp(10 / a.agi, 0.5, 1)));
// Beweglichkeit → Laufgeschwindigkeit: +1 % je Punkt über 10, höchstens +20 % (ab 30)
const moveSpeedBonus = (a) => clamp(1 + (a.agi - 10) * 0.01, 1, 1.2);
// Stärke (2/3) und Ausdauer (1/3) → Tragkraft in kg, ohne Obergrenze
const carryCap = (a) => Math.round(CARRY.perPoint * (a.str * 2 / 3 + a.sta / 3) * 10) / 10;
const isItem = (k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(ITEMS, k);
function weightOf(items) {
  let kg = 0;
  for (const k in items) if (isItem(k)) kg += ITEMS[k].kg * items[k];
  return Math.round(kg * 100) / 100;
}
// Bis zur Tragkraft volles Tempo, darüber immer langsamer, ab dem Anderthalbfachen Stillstand
function loadFactor(load, cap) {
  if (load <= cap * CARRY.slowFrom) return 1;
  if (load >= cap * CARRY.stopAt) return 0;
  const over = (load - cap * CARRY.slowFrom) / (cap * (CARRY.stopAt - CARRY.slowFrom));
  return Math.round((1 - over * (1 - CARRY.minFactor)) * 100) / 100;
}
// Gespeicherte oder empfangene Gegenstände prüfen: nur bekannte Arten, ganze Zahlen
function cleanItems(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of Object.keys(raw)) {
    const n = raw[k];
    if (isItem(k) && Number.isInteger(n) && n > 0) out[k] = Math.min(n, LOOT.maxStack);
  }
  return out;
}
// Darf man diese Waffe anlegen? Geschmiedete nur, wenn man sie gerade bei sich trägt
function weaponOk(w, inv) {
  if (!own(WEAPONS, w)) return false;
  return !WEAPONS[w].crafted || (inv[w] || 0) > 0;
}
function addItems(into, items) {
  for (const k in items) into[k] = Math.min((into[k] || 0) + items[k], LOOT.maxStack);
}

function damageOf(def, a) {                                           // Attribute → Schaden
  let d = def.base;
  for (const k in def.dmg) d += a[k] * def.dmg[k] * 0.5;
  return Math.max(1, Math.round(d));
}

const attrSum = (a) => a.str + a.sta + a.agi + a.int + a.wis;
// Wie viel man an einem Gegner noch lernt: 0 = nichts mehr, sonst Faktor auf den Zuwachs
function learnFactor(sum, def) {
  if (!def || !def.teach) return 1;
  return clamp(1 - (sum - def.teach) / LEARN.fade, 0, 1) * (def.mul || 1);
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

function handleHttp(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Ungültige Adresse');
  }
  if (pathname === '/status') return serveStatus(res);
  serveFile(pathname, res);
}

// /status zeigt im Browser, ob das Speichern funktioniert – ohne Geheimnisse.
const STATE_NAMES = { ready: 'bereit', idle: 'noch nicht verbunden', error: 'Fehler' };
async function serveStatus(res) {
  let timer;
  try {
    await Promise.race([db.init(), new Promise((_, reject) => { timer = setTimeout(reject, 10000); })]);
  } catch { /* der Fehler steht gleich in status() */ }
  clearTimeout(timer);
  const s = db.status();
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    spieler: players.size,
    speichern: s.persistent ? 'dauerhaft in der Datenbank' : 'nur im Arbeitsspeicher (keine Datenbank eingerichtet)',
    datenbank: { weg: s.kind, zustand: STATE_NAMES[s.state] || s.state, fehler: s.error || null },
  }, null, 2));
}

function serveFile(pathname, res) {
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
const players = new Map();         // id → Spieler (nur angemeldete, in der Welt)
const enemies = new Map();         // id → Tier
const conns = new Set();           // alle offenen Verbindungen, auch vor der Anmeldung
const pendingSaves = new Map();    // Konto → letzter Speichervorgang nach dem Verlassen
const failsByIp = new Map();       // Internetadresse → Zeitpunkte falscher Anmeldungen
const newByIp = new Map();         // Internetadresse → Zeitpunkte neuer Charaktere
const loots = new Map();           // id → Beutehaufen am Boden
let db = createStore(process.env.DATABASE_URL);
let nextId = 1;
let nextEnemyId = 1;
let nextLootId = 1;
let stopping = false;

function publicPlayer(p) {
  return { id: p.id, name: p.name, color: p.color, look: p.look, x: r2(p.x), z: r2(p.z), ry: r2(p.ry),
           hp: Math.round(p.hp), hpMax: p.hpMax, ko: p.ko, w: p.weapon };
}
function publicEnemy(e) {
  const o = { id: e.id, kind: e.kind, x: r2(e.x), z: r2(e.z), ry: r2(e.ry), hp: e.hp, hpMax: e.hpMax };
  if (e.look) o.look = e.look;
  return o;
}
// Beutehaufen, wie ihn ein bestimmter Spieler sieht: mine = er hat das Tier besiegt,
// res = so viele Millisekunden ist die Beute noch für den Sieger reserviert
function publicLoot(l, viewer) {
  return { id: l.id, x: r2(l.x), z: r2(l.z), items: { ...l.items },
           mine: l.ownerAcc !== null && viewer.accountId === l.ownerAcc,
           res: Math.max(0, l.reservedUntil - Date.now()) };
}
function selfView(p) {             // was nur der Spieler selbst über sich erfährt
  const load = weightOf(p.inv), cap = carryCap(p.a);
  return {
    hp: Math.round(p.hp), hpMax: p.hpMax, mana: Math.floor(p.mana), manaMax: p.manaMax,
    a: { ...p.a }, weapon: p.weapon, ko: p.ko,
    cd: attackCooldown(p.a), dodge: Math.round(dodgeChance(p.a) * 100),
    heal: Math.round(healShare(p.a) * 1000) / 10,
    inv: { ...p.inv }, load, cap, spd: loadFactor(load, cap), mv: moveSpeedBonus(p.a),
    admin: !!p.admin, hidden: !!p.hidden,
  };
}

function sendWs(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function send(p, msg) {
  sendWs(p.ws, msg);
}
function broadcast(msg, exceptId) {
  const data = JSON.stringify(msg);
  // Handlungen einer unsichtbaren Figur erfährt nur sie selbst
  const src = msg.id !== undefined ? players.get(msg.id) : null;
  const quiet = !!(src && src.hidden);
  for (const p of players.values()) {
    if (quiet && p.id !== src.id) continue;
    if (p.id !== exceptId && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}
function sendSelf(p, extra) {
  const msg = { t: 'you', self: selfView(p) };
  if (p.ups.length) { msg.up = p.ups; p.ups = []; }   // Attribute, die einen ganzen Punkt geschafft haben
  if (p.weak) { msg.weak = p.weak; p.weak = null; }   // an dieser Gegnerart lernt man nichts mehr
  if (extra) Object.assign(msg, extra);
  send(p, msg);
}
function log(text) {
  console.log(`[${new Date().toLocaleTimeString('de-DE')}] ${text}`);
}

// ---------------------------------------------------------------------------
// Verbindung: erst anmelden, dann spielen
// ---------------------------------------------------------------------------
function clientIp(req) {
  // Hinter Render steht ein Proxy, der seine eigene Adresse ans Ende von X-Forwarded-For anhängt.
  // Der Spieler steht also vor dem letzten Eintrag. Alles weiter vorn kann ein Spieler selbst
  // mitschicken und zählt deshalb nicht. Gäbe es nur einen Eintrag, ist es die Adresse des Spielers.
  const fwd = req && req.headers && req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') {
    const parts = fwd.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) return parts[parts.length - 2];
    if (parts.length === 1) return parts[0];
  }
  return (req && req.socket && req.socket.remoteAddress) || '?';
}

function onConnection(ws, req) {
  const conn = { ws, ip: clientIp(req), player: null, busy: false, alive: true, closed: false };
  conns.add(conn);
  sendWs(ws, { t: 'hello', persist: db.persistent });

  ws.on('pong', () => { conn.alive = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const p = conn.player;
    if (!p) {                      // noch nicht angemeldet: nur Anmeldung und Ping
      if (msg.t === 'ping' && Number.isFinite(msg.ts)) sendWs(ws, { t: 'pong', ts: msg.ts });
      else handleAuth(conn, msg);
      return;
    }
    switch (msg.t) {
      case 'move': handleMove(p, msg); break;
      case 'attack': handleAttack(p); break;
      case 'cast': handleCast(p, msg); break;
      case 'weapon': handleWeapon(p, msg); break;
      case 'ping': if (Number.isFinite(msg.ts)) send(p, { t: 'pong', ts: msg.ts }); break;
      case 'logout': handleLogout(p); break;
      case 'pick': handlePick(p, msg); break;
      case 'drop': handleDrop(p, msg); break;
      case 'chest': handleChest(p, msg); break;
      case 'admin': handleAdmin(p, msg).catch((err) => log(`Verwaltung: ${err.message}`)); break;
      case 'craft': handleCraft(p, msg); break;
      case 'cook': handleCook(p, msg); break;
      case 'eat': handleEat(p, msg); break;
      case 'look': handleLook(p, msg); break;
    }
  });
  ws.on('close', () => {
    conn.closed = true;
    conns.delete(conn);
    if (conn.player) leaveWorld(conn.player);
  });
  ws.on('error', () => {});        // Fehler führen ohnehin zu 'close'
}

// ---------------------------------------------------------------------------
// Anmeldung: neuer Charakter, Name und Passwort, oder gemerkter Schlüssel
// ---------------------------------------------------------------------------
function recent(map, ip, windowMs) {
  const now = Date.now();
  const list = (map.get(ip) || []).filter((t) => now - t < windowMs);
  if (list.length) map.set(ip, list); else map.delete(ip);
  return list;
}
function note(map, ip) {
  const list = map.get(ip) || [];
  list.push(Date.now());
  map.set(ip, list);
}
function deny(code, text) {
  return Object.assign(new Error(text), { deny: true, code });
}

async function handleAuth(conn, msg) {
  if (!['register', 'login', 'resume'].includes(msg.t) || conn.busy || stopping) return;
  if (msg.t !== 'resume' && recent(failsByIp, conn.ip, LIMITS.failWindowMs).length >= LIMITS.maxFails) {
    return sendWs(conn.ws, { t: 'denied', code: 'slow', text: 'Zu viele Fehlversuche. Warte ein paar Minuten.' });
  }
  conn.busy = true;
  try {
    let account, token, fresh = false;
    if (msg.t === 'resume') {
      if (typeof msg.token !== 'string' || msg.token.length < 20 || msg.token.length > 100) {
        throw deny('token', 'Bitte melde dich neu an.');
      }
      account = await db.findSession(hashToken(msg.token));
      if (!account) throw deny('token', 'Bitte melde dich neu an.');
      if (account.banned) throw deny('banned', 'Dieses Konto ist gesperrt.');
      token = msg.token;
    } else {
      const n = checkName(msg.name);
      if (!n.ok) throw deny('name', n.error);
      const pw = checkPassword(msg.pass);
      if (!pw.ok) throw deny('pass', pw.error);
      let acc = await db.findAccount(n.key);
      if (msg.t === 'register' && !acc) {
        if (recent(newByIp, conn.ip, LIMITS.newWindowMs).length >= LIMITS.maxNew) {
          throw deny('slow', 'Von hier wurden gerade viele Charaktere angelegt. Versuch es später noch einmal.');
        }
        const id = await db.createAccount(n.name, n.key, await hashPassword(msg.pass));
        if (id !== null) {
          acc = { id, name: n.name };
          fresh = true;
          note(newByIp, conn.ip);
          log(`Neuer Charakter: ${n.name}`);
        } else {
          acc = await db.findAccount(n.key);   // im selben Augenblick von jemand anderem vergeben
        }
      }
      if (!acc) {
        note(failsByIp, conn.ip);
        throw deny('unknown', `Einen Charakter „${n.name}“ gibt es noch nicht. Tippe auf „Neuen Charakter anlegen“.`);
      }
      if (!fresh && !(await verifyPassword(msg.pass, acc.pass))) {
        note(failsByIp, conn.ip);
        if (msg.t === 'register') throw deny('taken', `Den Namen „${n.name}“ gibt es schon. Wähle einen anderen.`);
        throw deny('pass', 'Das Passwort stimmt nicht.');
      }
      if (acc.banned) throw deny('banned', 'Dieses Konto ist gesperrt.');
      account = { id: acc.id, name: acc.name, admin: !!acc.admin };
      if (fresh) account.look = normLook(msg.look);   // beim Anlegen gewählt
      token = newToken();
      await db.createSession(hashToken(token), account.id);
      if (db.touchAccount) db.touchAccount(account.id).catch(() => {});
    }
    if (!conn.closed && !stopping) await enterWorld(conn, account, token, fresh);
  } catch (err) {
    if (err.deny) {
      sendWs(conn.ws, { t: 'denied', code: err.code, text: err.message });
    } else {
      log(`Anmeldung fehlgeschlagen: ${db.describe(err)}`);
      sendWs(conn.ws, {
        t: 'denied', code: 'db',
        text: 'Die Datenbank antwortet gerade nicht. Versuch es gleich noch einmal.',
        detail: db.status().error,
      });
    }
  } finally {
    conn.busy = false;
  }
}

// ---------------------------------------------------------------------------
// Administrator-Figur: Suchen, Gegenstand geben, Sperren, Sichtbarkeit.
// Jede Aktion prüft hier das Kennzeichen des Servers – die Oberfläche entscheidet nichts.
// ---------------------------------------------------------------------------
// Verwaltungs-Protokoll: dauerhaft in der Datenbank. Die letzten Einträge liegen
// zusätzlich im Arbeitsspeicher – falls die Datenbank gerade nicht antwortet.
const adminLog = [];
function adminRecord(by, text) {
  adminLog.push({ at: new Date().toISOString(), by, text });
  if (adminLog.length > 50) adminLog.shift();
  log(`Verwaltung: ${text}`);
  db.addAdminLog(by, text).catch((err) => log(`Protokoll nicht gespeichert: ${db.describe(err)}`));
}

async function handleAdmin(p, msg) {
  if (!p.admin) return;
  const reply = (ok, text, extra = {}) => send(p, { t: 'admin', op: msg.op, ok, text, ...extra });
  const who = typeof msg.name === 'string' ? msg.name.trim().replace(/\s+/g, ' ').slice(0, 16) : '';
  const key = who.toLowerCase();
  const isOnline = (id) => [...players.values()].some((q) => q.accountId === id);

  if (msg.op === 'log') {
    let entries;
    try {
      entries = await db.listAdminLog(50);
    } catch (err) {
      log(`Protokoll nicht gelesen: ${db.describe(err)}`);
      entries = adminLog.slice().reverse();
    }
    return send(p, { t: 'admin', op: 'log', ok: true, entries });
  }

  if (msg.op === 'search') {
    const rows = await db.searchAccounts(key);
    const results = rows.map((r) => ({ name: r.name, banned: !!r.banned, online: isOnline(r.id) }));
    return send(p, { t: 'admin', op: 'search', ok: true, results });
  }

  if (msg.op === 'visible') {
    const show = msg.on === true;
    if (show === !p.hidden) return reply(true, show ? 'Du bist schon sichtbar.' : 'Du bist schon unsichtbar.', { hidden: p.hidden });
    if (show) {
      p.hidden = false;
      p.dirty = true;
      broadcast({ t: 'join', player: publicPlayer(p) }, p.id);
    } else {
      broadcast({ t: 'leave', id: p.id }, p.id);   // zuerst gehen, dann unsichtbar
      p.hidden = true;
    }
    adminRecord(p.name, `${p.name} ist jetzt ${show ? 'sichtbar' : 'unsichtbar'}`);
    return reply(true, show ? 'Du bist wieder sichtbar.' : 'Du bist jetzt unsichtbar.', { hidden: p.hidden });
  }

  // Zum Testen, nur für die eigene Figur: Reisen und Attributsumme festlegen
  if (msg.op === 'travel') {
    const spot = own(ADMIN_TRAVEL, msg.to) ? ADMIN_TRAVEL[msg.to] : null;
    if (!spot || p.ko) return reply(false, 'Dorthin geht es gerade nicht.');
    p.x = spot.x;
    p.z = spot.z;
    p.budget = MOVE_BUDGET_CAP;
    p.corr++;
    p.dirty = true;
    p.lastInputAt = Date.now();
    send(p, { t: 'correct', n: p.corr, x: r2(p.x), z: r2(p.z) });
    adminRecord(p.name, `${p.name} reist: ${spot.name}`);
    return reply(true, `Du bist jetzt: ${spot.name}.`);
  }
  if (msg.op === 'attrs') {
    const sum = msg.sum;
    if (!Number.isInteger(sum) || sum < 50 || sum > 600) return reply(false, 'Die Summe muss zwischen 50 und 600 liegen.');
    const now = attrSum(p.a);                 // Verhältnis der Attribute bleibt erhalten
    for (const k in p.a) p.a[k] = r3(Math.max(1, (p.a[k] / now) * sum));
    p.hpMax = maxHp(p.a);
    p.manaMax = maxMana(p.a);
    p.hp = p.hpMax;
    p.mana = p.manaMax;
    p.dirty = true;
    sendSelf(p);
    adminRecord(p.name, `${p.name} setzt die eigene Attributsumme auf ${sum}`);
    return reply(true, `Deine Attributsumme ist jetzt ${Math.round(attrSum(p.a))}.`);
  }

  const acc = who ? await db.findAccount(key) : null;
  if (!acc) return reply(false, `Den Spieler „${who}“ gibt es nicht.`);

  if (msg.op === 'give') {
    const k = msg.k, n = msg.n;
    if (!isItem(k) || !Number.isInteger(n) || n < 1 || n > 9999) return reply(false, 'Gegenstand oder Anzahl stimmt nicht.');
    const online = onlineAs(acc.id);
    if (online) {
      addItems(online.inv, { [k]: n });
      online.dirty = true;
      sendSelf(online, { got: { [k]: n } });
    } else {
      const data = await db.loadCharacter(acc.id);
      if (!data) return reply(false, `${acc.name} hat noch keine Figur.`);
      const inv = cleanItems(data.inv);
      addItems(inv, { [k]: n });
      data.inv = inv;
      await db.saveCharacter(acc.id, data);
    }
    adminRecord(p.name, `${p.name} gibt ${acc.name} ${n} × ${k}`);
    return reply(true, `${n} × ${ITEMS[k].name} an ${acc.name} gegeben.`);
  }

  if (msg.op === 'ban') {
    const on = msg.on === true;
    if (acc.id === p.accountId) return reply(false, 'Du kannst dein eigenes Konto nicht sperren.');
    await db.setAccountFlags(key, { banned: on });
    if (on) {
      const online = onlineAs(acc.id);
      if (online) {
        send(online, { t: 'kicked', text: 'Dein Konto ist gesperrt.' });
        online.conn.player = null;
        leaveWorld(online, { save: true });
        online.ws.close(4003, 'banned');
      }
    }
    adminRecord(p.name, `${p.name} ${on ? 'sperrt' : 'entsperrt'} ${acc.name}`);
    return reply(true, on ? `${acc.name} ist gesperrt.` : `${acc.name} ist wieder frei.`, { name: acc.name, banned: on });
  }
}

// ---------------------------------------------------------------------------
// Welt betreten und verlassen
// ---------------------------------------------------------------------------
const onlineAs = (accountId) => [...players.values()].find((q) => q.accountId === accountId);

async function enterWorld(conn, account, token, fresh) {
  let data = null;
  if (!onlineAs(account.id)) {
    await pendingSaves.get(account.id);    // gerade erst gegangen: erst fertig speichern, dann laden
    data = await db.loadCharacter(account.id);
  }
  if (conn.closed || stopping) return;

  // Ist der Charakter noch (oder inzwischen) im Spiel, übernimmt die neue Anmeldung
  // seinen aktuellen Zustand – der ist frischer als der zuletzt gespeicherte.
  const old = onlineAs(account.id);
  if (old) {
    data = snapshot(old);
    send(old, { t: 'kicked', text: 'Du hast dich an einem anderen Gerät angemeldet.' });
    old.conn.player = null;
    leaveWorld(old, { save: false });
    old.ws.close(4001, 'elsewhere');
  }

  const p = createPlayer(conn, account, data);
  if (old) {
    p.savedJson = old.savedJson;
    p.saveChain = old.saveChain;
  } else if (data) {
    p.savedJson = JSON.stringify(snapshot(p));
  }
  p.tokenHash = hashToken(token);
  conn.player = p;
  players.set(p.id, p);

  send(p, { t: 'auth', token, name: p.name, fresh, persist: db.persistent });
  send(p, {
    t: 'welcome',
    you: publicPlayer(p),
    self: selfView(p),
    players: [...players.values()].filter((o) => o.id !== p.id && !o.hidden).map(publicPlayer),
    enemies: [...enemies.values()].map(publicEnemy),
    loots: [...loots.values()].map((l) => publicLoot(l, p)),
    rules: RULES,
  });
  if (!p.hidden) broadcast({ t: 'join', player: publicPlayer(p) }, p.id);
  log(`${p.name} betritt die Welt (${players.size} online)`);
  maintainEnemies();
  if (!p.savedJson) savePlayer(p);           // neuer Charakter: sofort festhalten
}

// Gespeicherte Werte übernehmen, aber nichts ungeprüft glauben
// Admin-Namen aus der Umgebungsvariable ADMIN_NAMES (Komma-getrennt), z. B. in Render eingetragen
function isEnvAdmin(name) {
  return (process.env.ADMIN_NAMES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .includes(String(name).toLowerCase());
}

function createPlayer(conn, account, data) {
  const now = Date.now();
  const d = data && typeof data === 'object' ? data : {};
  const a = freshAttrs();
  if (d.a && typeof d.a === 'object') {
    for (const k in a) if (Number.isFinite(d.a[k])) a[k] = clamp(r3(d.a[k]), 1, 100000);
  }
  let x = d.x, z = d.z;
  const inside = (v) => Number.isFinite(v) && Math.abs(v) <= RULES.worldHalf;
  if (!inside(x) || !inside(z)) {           // keine gültige Position: am Startplatz erscheinen
    const angle = Math.random() * Math.PI * 2, spawnDist = 2 + Math.random() * 4;
    x = Math.cos(angle) * spawnDist;
    z = Math.sin(angle) * spawnDist;
  }
  const hpMax = maxHp(a), manaMax = maxMana(a);
  const p = {
    id: nextId++, accountId: account.id, conn, ws: conn.ws,
    name: account.name,
    look: normLook(d.look !== undefined ? d.look : account.look), lastLookAt: 0, crafting: null,
    color: COLORS[(account.id - 1) % COLORS.length],
    x, z, ry: Number.isFinite(d.ry) ? d.ry : 0,
    a, hpMax, manaMax,
    hp: Number.isFinite(d.hp) ? clamp(Math.round(d.hp), 1, hpMax) : hpMax,
    mana: Number.isFinite(d.mana) ? clamp(d.mana, 0, manaMax) : manaMax,
    weapon: weaponOk(d.w, cleanItems(d.inv)) ? d.w : 'heavy', ups: [],
    inv: cleanItems(d.inv), chest: cleanItems(d.chest), lastDropAt: 0,
    budget: MOVE_BUDGET_CAP, lastMoveAt: now, lastInputAt: now,
    lastAttackAt: 0, lastCastAt: 0, lastFightAt: 0,
    ko: false, koAt: 0, safeUntil: 0, autoTarget: null,
    foe: null, foeAt: 0, weakAt: {}, weak: null,   // zuletzt bekämpfte Gegnerart; wann "zu schwach" gemeldet wurde
    corr: 0, dirty: false,
    savedJson: null, saveChain: Promise.resolve(), tokenHash: null, left: false,
    admin: !!account.admin || isEnvAdmin(account.name), hidden: false,
  };
  // Bewusstlos abgemeldet: Die Erholung beginnt von vorn – Abmelden ist keine Abkürzung.
  if (p.hp <= Math.round(hpMax * COMBAT.koShare)) {
    p.ko = true;
    p.koAt = now;
  }
  return p;
}

// Was dauerhaft gespeichert wird
function snapshot(p) {
  return {
    v: 2, x: r2(p.x), z: r2(p.z), ry: r2(p.ry),
    hp: Math.round(p.hp), mana: Math.floor(p.mana), w: p.weapon,
    a: { str: p.a.str, sta: p.a.sta, agi: p.a.agi, int: p.a.int, wis: p.a.wis },
    inv: { ...p.inv }, chest: { ...p.chest }, look: { ...p.look },
  };
}

// Speichert nur, wenn sich etwas geändert hat – und immer der Reihe nach.
function savePlayer(p) {
  p.saveChain = p.saveChain.then(async () => {
    const data = snapshot(p);
    const json = JSON.stringify(data);
    if (json === p.savedJson) return;
    try {
      await db.saveCharacter(p.accountId, data);
      p.savedJson = json;
    } catch (err) {
      log(`Speichern von ${p.name} fehlgeschlagen: ${db.describe(err)}`);
    }
  });
  return p.saveChain;
}

function saveAll() {
  return Promise.all([...[...players.values()].map(savePlayer), ...pendingSaves.values()]);
}

function leaveWorld(p, opts = {}) {
  if (p.left) return;
  p.left = true;
  players.delete(p.id);
  for (const e of enemies.values()) if (e.target === p.id) e.target = null;
  if (!p.hidden) broadcast({ t: 'leave', id: p.id });
  log(`${p.name} verlässt die Welt (${players.size} online)`);
  if (opts.save === false) return;
  const pr = savePlayer(p);
  pendingSaves.set(p.accountId, pr);
  pr.then(() => { if (pendingSaves.get(p.accountId) === pr) pendingSaves.delete(p.accountId); });
}

// Abmelden: Das Gerät vergisst den Schlüssel, die Verbindung bleibt für eine neue Anmeldung offen.
async function handleLogout(p) {
  const conn = p.conn;
  conn.player = null;
  leaveWorld(p);
  try {
    if (p.tokenHash) await db.deleteSession(p.tokenHash);
  } catch (err) {
    log(`Abmelden: Schlüssel nicht gelöscht: ${db.describe(err)}`);
  }
  sendWs(conn.ws, { t: 'bye' });
}

function handleMove(p, msg) {
  if (p.ko || msg.c !== p.corr) return;   // bewusstlos oder veraltete Nachricht
  const { x, z, ry } = msg;
  if (![x, z, ry].every(Number.isFinite)) return;

  // Bewegungsbudget: wächst mit der Zeit nach, jede Bewegung verbraucht davon.
  // Wer zu viel trägt, bekommt weniger Budget – bei Überlast gar keins.
  const now = Date.now();
  const factor = loadFactor(weightOf(p.inv), carryCap(p.a));
  p.budget = Math.min(MOVE_BUDGET_CAP * factor,
    p.budget + ((now - p.lastMoveAt) / 1000) * RULES.speed * moveSpeedBonus(p.a) * factor * SPEED_TOLERANCE);
  p.lastMoveAt = now;

  const d = Math.hypot(x - p.x, z - p.z);
  const outside = Math.abs(x) > RULES.worldHalf || Math.abs(z) > RULES.worldHalf;
  if (d > p.budget || outside || inBuilding(x, z)) {     // durch Mauern geht niemand
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
  if (p.ko || !weaponOk(msg.w, p.inv)) return;
  p.weapon = msg.w;
  p.lastInputAt = Date.now();
  broadcast({ t: 'gear', id: p.id, w: p.weapon }, p.id);
  sendSelf(p);
}

// ---------------------------------------------------------------------------
// Lernen durch Tun: nur wer gerade selbst spielt, wird besser
// ---------------------------------------------------------------------------
// kind: an welcher Gegnerart gelernt wird – je stärker der Gegner, desto mehr und desto länger
function learn(p, gains, kind) {
  const now = Date.now();
  if (now - p.lastInputAt > COMBAT.idleMs) return;
  if (kind && ENEMY_KINDS[kind]) {
    p.foe = kind;
    p.foeAt = now;
  } else {                                  // Heilen: zählt wie der letzte Gegner, sonst wie ein Hase
    kind = p.foe && now - p.foeAt < LEARN.recentMs ? p.foe : 'hare';
  }
  const f = learnFactor(attrSum(p.a), ENEMY_KINDS[kind]);
  if (f <= 0) {                             // nichts mehr zu lernen: höchstens einmal pro Minute sagen
    if (!(now - (p.weakAt[kind] || 0) < LEARN.weakNoteMs)) {
      p.weakAt[kind] = now;
      p.weak = kind;
    }
    return;
  }
  for (const k in gains) {
    const before = Math.floor(p.a[k]);
    p.a[k] = r3(p.a[k] + gains[k] * f);
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
    if (e.returning) continue;             // auf dem Rückweg zum Posten nicht angreifbar
    const d = dist(p, e);
    if (d > bestD) continue;
    if (d > 0.8 && angleDiff(Math.atan2(e.x - p.x, e.z - p.z), p.ry) > COMBAT.cone) continue;
    best = e;
    bestD = d;
  }
  if (!best) {
    const e = enemies.get(p.autoTarget);
    if (e && !e.returning && dist(p, e) <= range) best = e;
  }
  return best;
}

function hurtEnemy(e, p, dmg, w) {
  e.hp = Math.max(0, e.hp - dmg);
  if (!e.target && !e.returning) {         // das Tier wehrt sich – oder flieht; Menschen rufen Hilfe
    e.target = p.id;
    if (ENEMY_KINDS[e.kind].human) callHelp(e, p);
  }
  broadcast({ t: 'hitE', by: p.id, id: e.id, dmg, hp: e.hp, w });
  if (e.hp <= 0) {
    enemies.delete(e.id);
    if (e.post) { e.post.enemyId = null; e.post.deadAt = Date.now(); }   // Posten wird später neu besetzt
    broadcast({ t: 'despawn', id: e.id, by: p.id });
    const items = rollDrops(e.kind);
    if (Object.keys(items).length) spawnLoot(e.x, e.z, items, p.accountId);
  }
}

// Kameraden in der Nähe, die gerade niemanden bekämpfen, greifen mit an
function callHelp(e, p) {
  for (const o of enemies.values()) {
    if (o === e || o.target || o.returning || !ENEMY_KINDS[o.kind].human) continue;
    if (dist(o, e) <= HUMAN.help) o.target = p.id;
  }
}

// ---------------------------------------------------------------------------
// Beute, Tasche und Truhe
// ---------------------------------------------------------------------------
function rollDrops(kind) {
  const items = {};
  for (const d of DROPS[kind] || []) {
    if (Math.random() >= d.p) continue;
    items[d.k] = d.n[0] + Math.floor(Math.random() * (d.n[1] - d.n[0] + 1));
  }
  if (!Object.keys(items).length && DROPS[kind]) items[DROPS[kind][0].k] = 1;   // nie ganz leer
  return items;
}

function spawnLoot(x, z, items, ownerAcc) {
  while (loots.size >= LOOT.maxPiles) removeLoot(loots.keys().next().value, 0);   // der älteste zerfällt
  const now = Date.now();
  const l = {
    id: nextLootId++, x, z, items, ownerAcc: ownerAcc === undefined ? null : ownerAcc,
    reservedUntil: ownerAcc === undefined || ownerAcc === null ? 0 : now + LOOT.reserveMs,
    expiresAt: now + LOOT.expireMs,
  };
  loots.set(l.id, l);
  for (const q of players.values()) send(q, { t: 'loot', l: publicLoot(l, q) });
  return l;
}

function removeLoot(id, by) {
  if (!loots.delete(id)) return;
  broadcast({ t: 'unloot', id, by });
}

function expireLoot() {                    // einmal pro Sekunde
  const now = Date.now();
  for (const l of [...loots.values()]) if (now >= l.expiresAt) removeLoot(l.id, 0);
}

function handlePick(p, msg) {
  if (p.ko) return;
  p.lastInputAt = Date.now();
  const l = loots.get(msg.id);
  if (!l) return sendSelf(p, { note: 'gone' });
  if (dist(p, l) > LOOT.reach) return sendSelf(p, { note: 'far' });
  const wait = l.reservedUntil - Date.now();
  if (wait > 0 && l.ownerAcc !== p.accountId) return sendSelf(p, { note: 'reserved', wait: Math.ceil(wait / 1000) });
  addItems(p.inv, l.items);
  removeLoot(l.id, p.id);
  sendSelf(p, { got: l.items });           // auch über der Tragkraft: dann wird man eben langsam
}

// k = Gegenstand, n = Anzahl (ohne n: der ganze Stapel)
function takeCount(from, msg) {
  if (!isItem(msg.k) || !from[msg.k]) return 0;
  const have = from[msg.k];
  if (msg.n === undefined) return have;
  return Number.isInteger(msg.n) && msg.n > 0 && msg.n <= have ? msg.n : 0;   // mehr als vorhanden: nichts
}
function moveItem(from, to, k, n) {
  from[k] -= n;
  if (from[k] <= 0) delete from[k];
  if (to) to[k] = Math.min((to[k] || 0) + n, LOOT.maxStack);
}

function handleDrop(p, msg) {
  if (p.ko) return;
  const now = Date.now();
  if (now - p.lastDropAt < LOOT.dropGapMs) return;
  const n = takeCount(p.inv, msg);
  if (!n) return;
  p.lastDropAt = now;
  p.lastInputAt = now;
  moveItem(p.inv, null, msg.k, n);
  spawnLoot(p.x, p.z, { [msg.k]: n }, null);   // abgelegt: gehört sofort allen
  unequipGone(p);
  sendSelf(p, { dropped: { [msg.k]: n } });
}

// Wer seine geschmiedete Waffe ablegt oder einlagert, kämpft wieder mit der Startwaffe
function unequipGone(p) {
  if (!weaponOk(p.weapon, p.inv) && own(WEAPONS, p.weapon) && WEAPONS[p.weapon].crafted) {
    p.weapon = 'heavy';
    broadcast({ t: 'gear', id: p.id, w: p.weapon }, p.id);
  }
}

// Schmiede: ein Rezept, Zutaten aus der Tasche
// Schmieden dauert ein paar Sekunden. Die Zutaten gehen erst am Ende weg –
// wer vorher weggeht, umfällt oder sich abmeldet, verliert nichts.
function hasCost(p, r) {
  const cost = CRAFT[r].cost;
  for (const k in cost) if ((p.inv[k] || 0) < cost[k]) return false;
  return true;
}
function handleCraft(p, msg) {
  if (p.ko || !own(CRAFT, msg.r)) return;
  const now = Date.now();
  p.lastInputAt = now;
  if (p.crafting) return sendSelf(p, { note: 'busy' });
  if (dist(p, FORGE) > FORGE.reach) return sendSelf(p, { note: 'forgefar' });
  if (!hasCost(p, msg.r)) return sendSelf(p, { note: 'missing' });
  p.crafting = { r: msg.r, until: now + CRAFTING.ms };
  sendSelf(p, { crafting: { r: msg.r, ms: CRAFTING.ms } });
}
function stepCraft(p, now) {
  const c = p.crafting;
  if (!c) return;
  if (p.ko || dist(p, FORGE) > FORGE.reach) {
    p.crafting = null;
    return sendSelf(p, { craftStop: c.r });
  }
  if (now < c.until) return;
  p.crafting = null;
  if (!hasCost(p, c.r)) return sendSelf(p, { craftStop: c.r, note: 'missing' });   // inzwischen abgelegt
  const cost = CRAFT[c.r].cost;
  for (const k in cost) moveItem(p.inv, null, k, cost[k]);
  addItems(p.inv, { [c.r]: 1 });
  p.dirty = true;
  sendSelf(p, { crafted: { [c.r]: 1 } });
}

// Lagerfeuer: rohes Fleisch wird zu gegrilltem (n oder ganzer Stapel)
function handleCook(p, msg) {
  if (p.ko || msg.k !== 'meat') return;
  p.lastInputAt = Date.now();
  if (dist(p, FIRE) > FIRE.reach) return sendSelf(p, { note: 'firefar' });
  const n = takeCount(p.inv, msg);
  if (!n) return;
  moveItem(p.inv, null, 'meat', n);
  addItems(p.inv, { grilled_meat: n });
  sendSelf(p, { cooked: { grilled_meat: n } });
}

// Aussehen ändern: geprüft, gespeichert, an alle weitergegeben
function handleLook(p, msg) {
  const now = Date.now();
  if (now - p.lastLookAt < LOOK_GAP_MS) return;
  p.lastLookAt = now;
  p.lastInputAt = now;
  const look = normLook(msg.look);
  if (JSON.stringify(look) === JSON.stringify(p.look)) return;
  p.look = look;
  broadcast({ t: 'look', id: p.id, look });
}

// Essen heilt, überall; rohes Fleisch weniger als gegrilltes
function handleEat(p, msg) {
  if (p.ko || !own(FOOD, msg.k) || !p.inv[msg.k]) return;
  p.lastInputAt = Date.now();
  if (p.hp >= p.hpMax) return sendSelf(p, { note: 'full' });
  moveItem(p.inv, null, msg.k, 1);
  const amount = Math.min(p.hpMax - p.hp, FOOD[msg.k].heal);
  p.hp += amount;
  p.dirty = true;
  sendSelf(p, { ate: msg.k, heal: amount });
}

// op: open (Inhalt zeigen), store (aus der Tasche hinein), take (heraus in die Tasche)
function handleChest(p, msg) {
  if (p.ko || !['open', 'store', 'take'].includes(msg.op)) return;
  p.lastInputAt = Date.now();
  if (dist(p, CHEST) > CHEST.reach) return sendSelf(p, { note: 'chestfar' });
  if (msg.op === 'store' || msg.op === 'take') {
    const [from, to] = msg.op === 'store' ? [p.inv, p.chest] : [p.chest, p.inv];
    const n = takeCount(from, msg);
    if (!n) return;
    moveItem(from, to, msg.k, n);
    if (msg.op === 'store') unequipGone(p);
    sendSelf(p);
  }
  send(p, { t: 'chest', items: { ...p.chest } });
}

// Ein Schlag oder Schuss mit der angelegten Waffe – von Hand oder als Gegenangriff
function strike(p, e, auto) {
  const def = WEAPONS[p.weapon];
  const now = Date.now();
  p.lastAttackAt = now;
  p.lastFightAt = now;
  broadcast({ t: 'attack', id: p.id, w: p.weapon, te: e ? e.id : 0, auto: auto ? 1 : 0 });
  if (!e) return;                          // ins Leere: kein Treffer, nichts gelernt
  learn(p, def.learn, e.kind);
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
  learn(p, def.learn, e.kind);
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

  const shot = def.shot ? { r: def.shot } : {};   // Fernkampf: der Client zeigt Pfeil oder Feuer
  if (Math.random() < dodgeChance(p.a)) {  // ausgewichen: kein Schaden, aber auch keine Ausdauer
    broadcast({ t: 'hitP', by: e.id, id: p.id, dmg: 0, hp: Math.round(p.hp), dodge: 1, ...shot });
    return;
  }
  p.hp -= def.dmg;
  learn(p, { sta: 0.01 }, e.kind);         // Einstecken trainiert Ausdauer
  const koHp = Math.round(p.hpMax * COMBAT.koShare);
  const ko = p.hp <= koHp;
  if (ko) p.hp = Math.max(1, koHp);
  broadcast({ t: 'hitP', by: e.id, id: p.id, dmg: def.dmg, hp: Math.round(p.hp), ...shot });
  if (ko) knockOut(p, now);
  p.dirty = true;
  sendSelf(p);
}

function knockOut(p, now) {
  p.ko = true;
  p.koAt = now;
  p.autoTarget = null;
  for (const e of enemies.values()) {      // die Gegner lassen ab: Tiere ziehen weiter, Menschen gehen zurück
    if (e.target !== p.id) continue;
    e.target = null;
    if (ENEMY_KINDS[e.kind].human) {
      e.returning = true;
      continue;
    }
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
    if (!ENEMY_KINDS[k].share) continue;
    r -= ENEMY_KINDS[k].share;
    if (r < 0) return k;
  }
  return 'hare';
}

// Gesichter der Festungsbesatzung: eine feste Auswahl, damit der Client nicht für jeden
// Gegner einen neuen Kopf formen muss (das kostet auf dem iPad spürbar Zeit)
const ENEMY_LOOKS = [
  { sex: 'm', skin: 1, hair: 0, style: 0, beard: 1, face: 1, build: 2 },
  { sex: 'm', skin: 2, hair: 1, style: 3, beard: 3, face: 3, build: 2 },
  { sex: 'm', skin: 0, hair: 3, style: 4, beard: 2, face: 0, build: 1 },
  { sex: 'm', skin: 3, hair: 0, style: 1, beard: 0, face: 2, build: 1 },
  { sex: 'm', skin: 1, hair: 4, style: 2, beard: 1, face: 3, build: 2 },
  { sex: 'm', skin: 4, hair: 0, style: 3, beard: 0, face: 1, build: 1 },
  { sex: 'f', skin: 1, hair: 2, style: 1, beard: 0, face: 0, build: 1 },
  { sex: 'f', skin: 0, hair: 4, style: 4, beard: 0, face: 3, build: 1 },
  { sex: 'f', skin: 3, hair: 0, style: 2, beard: 0, face: 1, build: 0 },
  { sex: 'm', skin: 2, hair: 5, style: 0, beard: 1, face: 2, build: 2 },
];
const CAPTAIN_LOOK = { sex: 'm', skin: 1, hair: 5, style: 1, beard: 1, face: 3, build: 2 };
function enemyLook(kind) {
  if (kind === 'captain') return { ...CAPTAIN_LOOK };
  return { ...ENEMY_LOOKS[Math.floor(Math.random() * ENEMY_LOOKS.length)] };
}

function spawnEnemy(kind, x, z, post) {
  const def = ENEMY_KINDS[kind];
  if (x === undefined) {                   // freien Platz an Land suchen, nicht direkt neben Spielern
    let found = false;
    for (let i = 0; i < 12 && !found; i++) {
      const ang = Math.random() * Math.PI * 2, d = 18 + Math.random() * 64;
      x = clamp(Math.cos(ang) * d, -90, 90);
      z = clamp(Math.sin(ang) * d, -90, 90);
      found = onLand(x, z) && !inBuilding(x, z)
        && [...players.values()].every((p) => Math.hypot(p.x - x, p.z - z) > 14);
    }
    if (!found) return null;
  }
  const e = {
    id: nextEnemyId++, kind, x, z, ry: post ? post.ry : Math.random() * Math.PI * 2,
    hp: def.hp, hpMax: def.hp, target: null,
    lastAttackAt: 0, wanderAt: 0, moving: false, dirty: false,
  };
  if (def.human) {
    e.look = enemyLook(kind);
    e.post = post || { x, z, ry: e.ry, enemyId: null, deadAt: 0 };   // ohne Posten: wo er erscheint
    e.post.enemyId = e.id;
    e.returning = false;
    e.goal = null;                         // Ziel beim Umhergehen am Posten
  }
  enemies.set(e.id, e);
  broadcast({ t: 'spawn', e: publicEnemy(e) });
  return e;
}

function maintainEnemies() {               // Dichte richtet sich nach der Spielerzahl
  let animals = 0;
  for (const e of enemies.values()) if (!ENEMY_KINDS[e.kind].human) animals++;
  const want = Math.min(WORLD.maxEnemies, 8 + players.size * 4);
  for (let i = 0; i < 40 && animals < want; i++) if (spawnEnemy(pickKind())) animals++;
}

// Wachposten neu besetzen: nach der Wartezeit, aber nie vor den Augen eines Spielers direkt daneben
function maintainPosts() {
  if (!WORLD.posts) return;
  const now = Date.now();
  for (const post of POSTS) {
    if (post.enemyId !== null && enemies.has(post.enemyId)) continue;
    if (post.enemyId !== null) { post.enemyId = null; post.deadAt = 0; }   // verschwunden, nicht besiegt
    if (now - post.deadAt < ENEMY_KINDS[post.kind].respawnMs) continue;
    if ([...players.values()].some((p) => Math.hypot(p.x - post.x, p.z - post.z) < 6)) continue;
    spawnEnemy(post.kind, post.x, post.z, post);
  }
}

// Ein Schritt in Richtung (nx, nz). An Mauern gleitet man entlang wie die Spieler.
function moveEnemy(e, nx, nz, speed, dt) {
  const lim = RULES.worldHalf - 3;
  const x = clamp(e.x + nx * speed * dt, -lim, lim);
  const z = clamp(e.z + nz * speed * dt, -lim, lim);
  e.ry = Math.atan2(nx, nz);
  e.dirty = true;
  const free = (px, pz) => onLand(px, pz) && !inBuilding(px, pz);   // Wasser und Mauern meiden
  if (free(x, z)) { e.x = x; e.z = z; return true; }
  if (Math.abs(nx) > 0.2 && free(x, e.z)) { e.x = x; return true; }
  if (Math.abs(nz) > 0.2 && free(e.x, z)) { e.z = z; return true; }
  return false;
}

// Wer kommt als Ziel in Frage? Nicht bewusstlos, nicht frisch erholt, nicht unsichtbar –
// und Menschen greifen niemanden an, der ihnen weit überlegen ist (an ihnen nichts mehr lernt).
function canAggro(e, def, q, now) {
  if (q.ko || q.hidden || now < q.safeUntil || dist(e, q) > def.aggro) return false;
  if (!def.human) return true;
  return learnFactor(attrSum(q.a), def) > 0
    && Math.hypot(q.x - e.post.x, q.z - e.post.z) < HUMAN.leash - 2;
}

function stepEnemies(dt, now) {
  for (const e of enemies.values()) {
    const def = ENEMY_KINDS[e.kind];
    if (def.human) { stepHuman(e, def, dt, now); continue; }
    let p = e.target ? players.get(e.target) : null;
    if (p && (p.ko || dist(e, p) > COMBAT.leash || (def.flee && dist(e, p) > 16))) {
      e.target = null;
      p = null;
    }
    if (!p && def.aggro > 0) {             // Wölfe suchen sich selbst ein Ziel
      for (const q of players.values()) {
        if (!canAggro(e, def, q, now)) continue;
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

// Menschen im Kampf drängen sich nicht auf einen Fleck: wer zu nah an einem anderen steht,
// weicht seitlich aus (der Blick bleibt beim Ziel)
function spread(e, dt) {
  let sx = 0, sz = 0;
  for (const o of enemies.values()) {
    if (o === e) continue;
    const dx = e.x - o.x, dz = e.z - o.z, d = Math.hypot(dx, dz);
    if (d > 0.001 && d < 1.0) { sx += (dx / d) * (1.0 - d); sz += (dz / d) * (1.0 - d); }
  }
  const m = Math.hypot(sx, sz);
  if (m > 0.001) moveEnemy(e, sx / m, sz / m, Math.min(2, m * 6), dt);
}

// Menschen: am Posten wachen, Eindringlinge stellen, Kameraden helfen, nicht zu weit verfolgen.
// Wer zu weit vom Posten weggelockt wird, kehrt um, ist auf dem Rückweg nicht angreifbar
// und steht zu Hause wieder mit vollem Leben.
function stepHuman(e, def, dt, now) {
  const home = e.post;
  const toHome = Math.hypot(home.x - e.x, home.z - e.z);
  let p = e.target ? players.get(e.target) : null;
  if (e.target && (!p || p.ko || toHome > HUMAN.leash
      || Math.hypot(p.x - home.x, p.z - home.z) > HUMAN.leash + 8)) {
    e.target = null;
    p = null;
    e.returning = true;
  }

  if (e.returning) {
    if (!e.returnAt) e.returnAt = now;
    const stuck = now - e.returnAt > HUMAN.returnMs;
    if (toHome > 0.5 && !stuck && moveEnemy(e, (home.x - e.x) / toHome, (home.z - e.z) / toHome, def.speed * 1.2, dt)) return;
    if (toHome > 0.5) { e.x = home.x; e.z = home.z; }   // an einer Mauer hängen geblieben: zurück auf den Posten
    e.returning = false;                    // angekommen: wieder auf Wache
    e.returnAt = 0;
    e.hp = e.hpMax;
    e.ry = home.ry;
    e.dirty = true;
    broadcast({ t: 'hitE', by: 0, id: e.id, dmg: 0, hp: e.hp, heal: 1 });
    return;
  }

  if (!p) {                                 // Wache halten: Umgebung im Blick
    for (const q of players.values()) {
      if (!canAggro(e, def, q, now)) continue;
      e.target = q.id;
      p = q;
      callHelp(e, q);
      break;
    }
  }

  if (p) {
    const dx = p.x - e.x, dz = p.z - e.z;
    const d = Math.hypot(dx, dz) || 0.001;
    const reach = def.range || HUMAN.reach;
    const stop = def.range ? def.range * 0.85 : 1.4;
    if (d > stop) moveEnemy(e, dx / d, dz / d, def.speed, dt);
    spread(e, dt);
    e.ry = Math.atan2(dx, dz);
    e.dirty = true;
    if (d <= reach && now - e.lastAttackAt >= def.atkMs) {
      e.lastAttackAt = now;
      e.ry = Math.atan2(dx, dz);
      enemyStrikes(e, p);
    }
    return;
  }

  // Ohne Ziel: Schützen und der Hauptmann stehen still, die anderen gehen ein paar Schritte auf und ab
  if (def.range || e.kind === 'captain') {
    if (toHome > 0.5) moveEnemy(e, (home.x - e.x) / toHome, (home.z - e.z) / toHome, def.speed * 0.5, dt);
    else if (Math.abs(e.ry - home.ry) > 0.01) { e.ry = home.ry; e.dirty = true; }
    return;
  }
  if (now > e.wanderAt) {
    e.wanderAt = now + 4000 + Math.random() * 5000;
    if (Math.random() < 0.5) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * HUMAN.roam;
      e.goal = { x: home.x + Math.cos(a) * r, z: home.z + Math.sin(a) * r };
    } else {
      e.goal = { x: home.x, z: home.z };
    }
  }
  if (e.goal) {
    const gx = e.goal.x - e.x, gz = e.goal.z - e.z, gd = Math.hypot(gx, gz);
    if (gd < 0.3 || !moveEnemy(e, gx / gd, gz / gd, def.speed * 0.3, dt)) {
      e.goal = null;
      if (Math.hypot(home.x - e.x, home.z - e.z) < 0.6) { e.ry = home.ry; e.dirty = true; }
    }
  }
}

// ---------------------------------------------------------------------------
// Spieler im Takt: Erholung nach K.O. und automatischer Gegenangriff
// ---------------------------------------------------------------------------
function stepPlayer(p, now) {
  stepCraft(p, now);
  if (p.ko) {
    if (now - p.koAt >= COMBAT.reviveMs) revive(p, now);
    return;
  }
  if (p.autoTarget === null) return;
  const e = enemies.get(p.autoTarget);
  if (!e || e.returning || dist(p, e) > COMBAT.leash) {
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
    if (!p.dirty || p.hidden) continue;
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

function checkAlive() {                    // abgerissene Verbindungen aufräumen, auch vor der Anmeldung
  for (const c of conns) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    c.ws.ping();
  }
}

// ---------------------------------------------------------------------------
// Start und Stopp
// ---------------------------------------------------------------------------
let httpServer = null;
let wss = null;
let timers = [];

function start(port = Number(process.env.PORT) || 3000, opts = {}) {
  if (opts.store) db = opts.store;
  stopping = false;
  httpServer = http.createServer(handleHttp);
  wss = new WebSocketServer({ server: httpServer, maxPayload: 4096 });
  wss.on('connection', onConnection);
  wss.on('error', () => {});               // Startfehler meldet listen() unten
  lastTick = Date.now();
  timers = [
    setInterval(tick, 1000 / TICK_RATE),
    setInterval(regenTick, 1000),
    setInterval(expireLoot, 1000),
    setInterval(maintainEnemies, 5000),
    setInterval(maintainPosts, 2000),
    setInterval(checkAlive, 30000),
    setInterval(() => { for (const p of players.values()) savePlayer(p); }, SAVE.everyMs),
  ];
  for (const post of POSTS) { post.enemyId = null; post.deadAt = 0; }
  maintainEnemies();
  maintainPosts();
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, () => {
      log(`D40-Server läuft: http://localhost:${httpServer.address().port}`);
      log(db.persistent
        ? 'Speichern: dauerhaft in der Datenbank (DATABASE_URL)'
        : 'Speichern: nur im Arbeitsspeicher – ohne DATABASE_URL ist nach einem Neustart alles weg');
      resolve(httpServer.address().port);
    });
  });
}

// Beenden: erst alle Spieler speichern, dann die Verbindungen schließen.
async function stop() {
  stopping = true;
  timers.forEach(clearInterval);
  timers = [];
  let timer;
  await Promise.race([
    Promise.allSettled([saveAll()]),
    new Promise((resolve) => { timer = setTimeout(resolve, SAVE.flushMs); }),
  ]);
  clearTimeout(timer);
  for (const c of conns) {
    c.player = null;
    c.ws.terminate();
  }
  conns.clear();
  players.clear();
  enemies.clear();
  loots.clear();
  pendingSaves.clear();
  failsByIp.clear();
  newByIp.clear();
  const closing = [];
  if (wss) closing.push(new Promise((resolve) => wss.close(() => resolve())));
  if (httpServer) {
    if (httpServer.closeAllConnections) httpServer.closeAllConnections();
    closing.push(new Promise((resolve) => httpServer.close(() => resolve())));
  }
  wss = null;
  httpServer = null;
  await Promise.all(closing);
}

if (require.main === module) {
  start().catch((err) => {
    if (err.code === 'EADDRINUSE') console.error('Der Port ist schon belegt. Läuft der Server bereits?');
    else console.error(err);
    process.exit(1);
  });
  // Render beendet den Server bei jedem neuen Deploy mit SIGTERM: vorher alles speichern.
  let quitting = false;
  const quit = (signal) => {
    if (quitting) return;
    quitting = true;
    log(`${signal} erhalten: speichere alle Spieler und beende den Server …`);
    broadcast({ t: 'notice', text: 'Der Server startet neu. Dein Fortschritt ist gespeichert.' });
    stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGTERM', () => quit('SIGTERM'));
  process.on('SIGINT', () => quit('SIGINT'));
}

// Für die automatischen Tests
module.exports = {
  start, stop, saveAll, players, enemies, conns, loots, spawnEnemy, spawnLoot, removeLoot, snapshot,
  COMBAT, WORLD, WEAPONS, SPELLS, ENEMY_KINDS, LEARN, HUMAN, POSTS, FORT, CAMP, learnFactor, attrSum, maintainPosts, onLand, SAVE, LIMITS, ITEMS, DROPS, LOOT, CHEST, CARRY, normLook, moveSpeedBonus, CRAFT, CRAFTING, FOOD, FORGE, FIRE, weaponOk, BUILDINGS, inBuilding, isEnvAdmin,
  carryCap, weightOf, loadFactor, rollDrops,
  freshAttrs, maxHp, maxMana, manaRegen, healShare, attackCooldown, dodgeChance, damageOf, heightAt,
  getStore: () => db,
};
