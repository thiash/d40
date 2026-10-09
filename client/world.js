'use strict';
// ===========================================================================
//  D40 – Client, Teil 1 von 4: Grundgerüst, Welt, Figuren, Tiere, Beute und Truhe
//  Reihenfolge der Dateien: world.js → net.js → combat.js → items.js (siehe index.html)
// ===========================================================================

// ---- Regeln (der Server schickt beim Verbinden seine eigenen Werte) ----
// Festung Grauwacht im Norden und der Vorposten am Weg – dieselben Zahlen wie im Server
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
// Gebäude sind feste Hindernisse (der Server prüft dieselbe Liste)
const BUILDINGS = [
  { x: -14, z: -8, w: 4, d: 3.4, h: 2.4, kind: 'forge' },
  { x: -24, z: -16, w: 3, d: 2.6, h: 2.2, kind: 'house' },
  { x: 10, z: -20, w: 2.6, d: 2.4, h: 2, kind: 'house' },
  ...fortBuildings(),
];
const BUILDING_PAD = 0.35;          // Abstand, den die Spielfigur zu Mauern hält
const inBuilding = (x, z) => BUILDINGS.some((b) =>
  Math.abs(x - b.x) < b.w / 2 + BUILDING_PAD && Math.abs(z - b.z) < b.d / 2 + BUILDING_PAD);
// Der Weg vom Dorf zum Tor der Festung (nur Färbung des Bodens)
const ROAD = [[2, -14], [16, -30], [24, -55], [26, -90], [25, -127], [25, -152]];

const RULES = {
  speed: 6, worldHalf: 200, spellCooldown: 1500, reviveMs: 20000,
  buildings: BUILDINGS,
  weapons: { heavy: 'Schwert', dagger: 'Dolch', bow: 'Bogen' },
  spells: { int: { name: 'Intelligenzzauber', cost: 5 }, wis: { name: 'Weisheitszauber', cost: 6 } },
  enemies: { hare: { name: 'Hase' }, wolf: { name: 'Wolf' }, boar: { name: 'Keiler' } },
  learn: { fade: 25, goal: 300 },
  items: {}, lootReach: 2.6, chest: { x: 0, z: 0, reach: 3 },
  craft: {}, food: {}, forge: { x: -14, z: -8, reach: 3 }, fire: { x: 14, z: -8, reach: 3 },
};
const WATER_LEVEL = -3.2;
const SEND_RATE = 15;               // Bewegungs-Updates pro Sekunde an den Server

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const r2 = (v) => Math.round(v * 100) / 100;
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);   // Glätten, unabhängig von der Bildrate
function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// ---- Oberfläche ----
const ui = {
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  ping: document.getElementById('ping'),
  log: document.getElementById('log'),
  stick: document.getElementById('stick'),
  knob: document.getElementById('knob'),
  attack: document.getElementById('attack'),
};
if (window.matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');

function setStatus(state, text, ping = '') {
  ui.status.dataset.state = state;
  ui.statusText.textContent = text;
  ui.ping.textContent = ping;
}

function log(text) {
  const line = document.createElement('div');
  line.className = 'line';
  line.textContent = text;
  ui.log.appendChild(line);
  while (ui.log.children.length > 4) ui.log.firstChild.remove();
  setTimeout(() => line.classList.add('out'), 4500);
  setTimeout(() => line.remove(), 5200);
}

if (typeof THREE === 'undefined') {
  setStatus('offline', 'Three.js nicht geladen. Internetverbindung prüfen.');
  throw new Error('Three.js fehlt');
}

// ---- Renderer, Szene, Licht ----
const canvas = document.getElementById('game');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (err) {
  setStatus('offline', 'Dieses Gerät unterstützt kein WebGL.');
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

const scene = new THREE.Scene();
const SKY = 0xa9cfe0;
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 45, 140);
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 160);

// Keine Echtzeitschatten: Himmels- und Sonnenlicht reichen für den Low-Poly-Look
scene.add(new THREE.HemisphereLight(0xfff1d6, 0x4b5d33, 0.95));
const sun = new THREE.DirectionalLight(0xfff6e5, 0.75);
sun.position.set(40, 60, 25);
scene.add(sun);

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ===========================================================================
//  Welt – deterministisch erzeugt, damit alle Spieler dieselbe Welt sehen
// ===========================================================================
function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(4040);

function heightAt(x, z) {             // der Server kennt dieselbe Formel
  const n = Math.sin(x * 0.045) * 2.2 + Math.cos(z * 0.05) * 1.8
          + Math.sin((x + z) * 0.11) * 0.7 + Math.cos((x - z) * 0.07) * 0.9 - 0.8;
  const d = Math.hypot(x - FORT.x, z - FORT.z);  // um die Festung ist der Boden eingeebnet
  if (d >= FORT.blend) return n;
  const t = d <= FORT.flat ? 1 : (FORT.blend - d) / (FORT.blend - FORT.flat);
  return n + (FORT.y - n) * t * t * (3 - 2 * t);
}
// Abstand zum Weg (für Bodenfarbe und Bäume)
function roadDist(x, z) {
  let best = Infinity;
  for (let i = 0; i < ROAD.length - 1; i++) {
    const [ax, az] = ROAD[i], [bx, bz] = ROAD[i + 1];
    const dx = bx - ax, dz = bz - az;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}
const inFortYard = (x, z, pad = 0) => Math.abs(x - FORT.x) < FORT.half + pad && Math.abs(z - FORT.z) < FORT.half + pad;
// Im Wasser treibt man an der Oberfläche – ein Vorgeschmack aufs Schwimmen
const groundY = (x, z) => Math.max(heightAt(x, z), WATER_LEVEL - 1.1);

function flat(geo) {                // Low-Poly-Look: jede Fläche bekommt ihre eigene Normale
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

const TERRAIN = 420;                  // Kantenlänge des Geländes in Metern (Welt ±200 plus Rand)
function buildTerrain() {
  const geo = new THREE.PlaneGeometry(TERRAIN, TERRAIN, 168, 168);
  geo.rotateX(-Math.PI / 2);
  const p0 = geo.attributes.position;
  for (let i = 0; i < p0.count; i++) p0.setY(i, heightAt(p0.getX(i), p0.getZ(i)));

  const g = flat(geo);
  const pos = g.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 3) {
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    const v = rand() * 0.05;
    let c;
    if (y < WATER_LEVEL + 0.5)       c = [0.74 + v, 0.66 + v, 0.46 + v];      // Ufer
    else if (inFortYard(cx, cz))     c = [0.5 + v, 0.47 + v, 0.41 + v];       // gestampfter Burghof
    else if (roadDist(cx, cz) < 1.9) c = [0.56 + v, 0.46 + v, 0.31 + v];      // Weg zur Festung
    else if (Math.hypot(cx - CAMP.x, cz - CAMP.z) < 8.5) c = [0.45 + v, 0.46 + v, 0.27 + v];   // zertretenes Gras am Lager
    else if (y > 3.2)                c = [0.52 + v, 0.6 + v, 0.31 + v];       // trockene Kuppen
    else                             c = [0.31 + v, 0.52 + v, 0.24 + v];      // Wiese
    for (let k = 0; k < 3; k++) colors.set(c, (i + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true })));

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(TERRAIN, TERRAIN),
    new THREE.MeshLambertMaterial({ color: 0x3f8fb5, transparent: true, opacity: 0.75 })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_LEVEL;
  scene.add(water);
}

// Bäume und Felsen als Instanzen: ein Draw-Call pro Sorte, egal wie viele
function buildNature() {
  const geos = {
    trunk: flat(new THREE.CylinderGeometry(0.16, 0.24, 1.4, 5).translate(0, 0.7, 0)),
    pine:  flat(new THREE.ConeGeometry(1.15, 2.8, 6).translate(0, 2.6, 0)),
    crown: flat(new THREE.IcosahedronGeometry(1.25, 0).translate(0, 2.5, 0)),
    rock:  flat(new THREE.DodecahedronGeometry(0.7, 0)),
  };
  const mats = {
    trunk: new THREE.MeshLambertMaterial({ color: 0x6b4a2f }),
    pine:  new THREE.MeshLambertMaterial({ color: 0x2f5d3a }),
    crown: new THREE.MeshLambertMaterial({ color: 0x4f8a3c }),
    rock:  new THREE.MeshLambertMaterial({ color: 0x8a8f8c }),
  };
  const lists = { pine: [], crown: [], rock: [] };
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < 950; i++) {
    const x = (rand() * 2 - 1) * (TERRAIN / 2 - 4);
    const z = (rand() * 2 - 1) * (TERRAIN / 2 - 4);
    const kind = rand() < 0.22 ? 'rock' : rand() < 0.65 ? 'pine' : 'crown';
    const k = 0.7 + rand() * 0.7;
    const turn = rand() * Math.PI * 2;
    const y = heightAt(x, z);
    if (Math.hypot(x, z) < 14 || y < WATER_LEVEL + 0.6) continue;  // Lichtung am Start, nichts im Wasser
    // Freie Sicht auf die Festung, freier Weg und ein freies Lager
    if (Math.hypot(x - FORT.x, z - FORT.z) < FORT.flat + 6 || roadDist(x, z) < 4
        || Math.hypot(x - CAMP.x, z - CAMP.z) < 13 || inBuilding(x, z)) continue;
    q.setFromAxisAngle(up, turn);
    s.set(k, kind === 'rock' ? k * 0.7 : k, k);
    m.compose(p.set(x, y - 0.1, z), q, s);
    lists[kind].push(m.clone());
  }

  const add = (geo, mat, list) => {
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((mx, i) => mesh.setMatrixAt(i, mx));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;     // in dieser Three.js-Version nötig, sonst verschwinden Instanzen
    scene.add(mesh);
  };
  add(geos.trunk, mats.trunk, lists.pine.concat(lists.crown));
  add(geos.pine, mats.pine, lists.pine);
  add(geos.crown, mats.crown, lists.crown);
  add(geos.rock, mats.rock, lists.rock);
}

buildTerrain();
buildNature();

// ===========================================================================
//  Namensschilder (die Figuren selbst stehen in character.js)
// ===========================================================================
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTag(sprite) {
  const text = sprite.userData.text;
  const cv = sprite.material.map.image;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.font = '700 28px "Alegreya Sans", "Trebuchet MS", sans-serif';
  const w = Math.min(248, ctx.measureText(text).width + 34);
  ctx.fillStyle = 'rgba(31, 43, 34, 0.72)';
  roundRectPath(ctx, 128 - w / 2, 13, w, 38, 19);
  ctx.fill();
  ctx.fillStyle = sprite.userData.color || '#ece3cc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 33);
  sprite.material.map.needsUpdate = true;
}

function makeNameTag(text) {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 64;
  const material = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.4, 0.6, 1);
  sprite.position.y = 2.6;
  sprite.userData.text = text;
  drawTag(sprite);
  return sprite;
}

// ===========================================================================
//  Tiere – einfache Low-Poly-Formen aus Kästen und Kegeln
// ===========================================================================
const box = (w, h, d) => flat(new THREE.BoxGeometry(w, h, d));
const limb = (r, len) => flat(new THREE.CylinderGeometry(r, r * 0.8, len, 5).translate(0, -len / 2, 0));

const BEAST_GEO = {
  hareBody: flat(new THREE.IcosahedronGeometry(0.22, 0).scale(1, 0.85, 1.35)),
  hareHead: flat(new THREE.IcosahedronGeometry(0.13, 0)),
  ear:      box(0.05, 0.24, 0.03),
  puff:     flat(new THREE.IcosahedronGeometry(0.07, 0)),
  hareLeg:  limb(0.035, 0.16),
  hareHind: limb(0.05, 0.18),
  wolfBody: box(0.42, 0.4, 1.0),
  wolfHead: box(0.3, 0.28, 0.34),
  snout:    box(0.16, 0.13, 0.22),
  wolfEar:  flat(new THREE.ConeGeometry(0.07, 0.16, 4)),
  tail:     flat(new THREE.CylinderGeometry(0.06, 0.03, 0.5, 5)),
  wolfLeg:  limb(0.06, 0.5),
  boarBody: box(0.62, 0.6, 1.1),
  boarHead: box(0.42, 0.4, 0.42),
  boarNose: box(0.24, 0.2, 0.14),
  tusk:     flat(new THREE.ConeGeometry(0.035, 0.16, 4)),
  ridge:    box(0.12, 0.12, 0.8),
  boarLeg:  limb(0.08, 0.38),
};
const BEAST_MATS = {
  hare:  new THREE.MeshLambertMaterial({ color: 0x9a7b5a }),
  white: new THREE.MeshLambertMaterial({ color: 0xe8e2d4 }),
  wolf:  new THREE.MeshLambertMaterial({ color: 0x77716a }),
  dark:  new THREE.MeshLambertMaterial({ color: 0x4d4945 }),
  boar:  new THREE.MeshLambertMaterial({ color: 0x4a3a2e }),
  nose:  new THREE.MeshLambertMaterial({ color: 0x8a6a5a }),
};

function makeEnemy(kind) {
  const def = RULES.enemies[kind];
  if (def && def.human) return makeFoe(kind);
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const add = (geo, mat, x, y, z, tilt = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.x = tilt;
    body.add(m);
    return m;
  };
  const leg = (geo, mat, x, y, z) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.add(new THREE.Mesh(geo, mat));
    body.add(g);
    return g;
  };
  const G = BEAST_GEO, M = BEAST_MATS;
  let legs, barY;

  if (kind === 'wolf') {
    add(G.wolfBody, M.wolf, 0, 0.7, 0);
    add(G.wolfHead, M.wolf, 0, 0.86, 0.62);
    add(G.snout, M.dark, 0, 0.8, 0.86);
    add(G.wolfEar, M.dark, -0.09, 1.06, 0.56);
    add(G.wolfEar, M.dark, 0.09, 1.06, 0.56);
    add(G.tail, M.dark, 0, 0.76, -0.62, -0.9);
    legs = [[-0.14, 0.34], [0.14, 0.34], [-0.14, -0.34], [0.14, -0.34]]
      .map(([x, z]) => leg(G.wolfLeg, M.wolf, x, 0.5, z));
    barY = 1.5;
  } else if (kind === 'boar') {
    add(G.boarBody, M.boar, 0, 0.68, 0);
    add(G.boarHead, M.boar, 0, 0.66, 0.72);
    add(G.boarNose, M.nose, 0, 0.58, 0.96);
    add(G.tusk, M.white, -0.12, 0.62, 0.95);
    add(G.tusk, M.white, 0.12, 0.62, 0.95);
    add(G.ridge, M.dark, 0, 1.02, -0.05);
    legs = [[-0.2, 0.36], [0.2, 0.36], [-0.2, -0.36], [0.2, -0.36]]
      .map(([x, z]) => leg(G.boarLeg, M.boar, x, 0.38, z));
    barY = 1.45;
  } else {                            // Hase
    add(G.hareBody, M.hare, 0, 0.27, 0);
    add(G.hareHead, M.hare, 0, 0.42, 0.26);
    add(G.ear, M.hare, -0.05, 0.62, 0.2, -0.3);
    add(G.ear, M.hare, 0.05, 0.62, 0.2, -0.3);
    add(G.puff, M.white, 0, 0.3, -0.3);
    legs = [
      leg(G.hareLeg, M.hare, -0.08, 0.16, 0.14), leg(G.hareLeg, M.hare, 0.08, 0.16, 0.14),
      leg(G.hareHind, M.hare, -0.11, 0.18, -0.12), leg(G.hareHind, M.hare, 0.11, 0.18, -0.12),
    ];
    barY = 0.95;
  }

  const bar = makeBar();
  bar.position.y = barY;
  bar.visible = false;
  root.add(bar);
  root.userData = { body, legs, bar, kind, walk: 0, amp: 0, lunge: -1 };
  scene.add(root);
  return root;
}

// Lebensbalken über verletzten Tieren
function makeBar() {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 20;
  const material = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.1, 0.17, 1);
  return sprite;
}

function drawBar(sprite, share) {
  const cv = sprite.material.map.image;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = 'rgba(31, 43, 34, 0.8)';
  roundRectPath(ctx, 2, 2, 124, 16, 8);
  ctx.fill();
  if (share > 0) {
    ctx.fillStyle = '#c8493d';
    roundRectPath(ctx, 5, 5, Math.max(10, 118 * share), 10, 5);
    ctx.fill();
  }
  sprite.material.map.needsUpdate = true;
}

function animateEnemy(model, x, z, ry, speed, dt) {
  const u = model.userData;
  model.position.set(x, groundY(x, z), z);
  model.rotation.y = lerpAngle(model.rotation.y, ry, damp(10, dt));
  const target = speed > 0.2 ? Math.min(speed / 4, 1) : 0;
  u.amp = lerp(u.amp, target, damp(8, dt));
  if (target > 0) u.walk += dt * (6 + speed * 2.2);
  const s = Math.sin(u.walk) * 0.7 * u.amp;
  u.legs[0].rotation.x = s;          // diagonale Beinpaare schwingen gemeinsam
  u.legs[3].rotation.x = s;
  u.legs[1].rotation.x = -s;
  u.legs[2].rotation.x = -s;

  let lunge = 0;                      // beim Zubeißen schnellt der Körper nach vorn
  if (u.lunge >= 0) {
    u.lunge += dt / 0.35;
    if (u.lunge >= 1) u.lunge = -1;
    else lunge = Math.sin(u.lunge * Math.PI) * 0.35;
  }
  u.body.position.z = lunge;
  u.body.position.y = Math.abs(s) * 0.07;
}

function disposeEnemy(model) {
  scene.remove(model);
  model.userData.bar.material.map.dispose();
  model.userData.bar.material.dispose();
  if (model.userData.fig) disposeCharacter(model.userData.fig);
}

// Menschen (Besatzung der Festung): zuerst nur ein Platzhalter mit Lebensbalken.
// Die eigentliche Figur entsteht erst, wenn man in die Nähe kommt (net.js) – das spart
// beim Betreten der Welt Rechenzeit, die Festung liegt ja weit vom Startplatz entfernt.
function makeFoe(kind) {
  const root = new THREE.Group();
  const bar = makeBar();
  bar.position.y = 2.35;
  bar.visible = false;
  root.add(bar);
  root.userData = { bar, kind, human: true, fig: null, lunge: -1, tone: null };
  scene.add(root);
  return root;
}

// Schwierigkeit eines Gegners für den Spieler – färbt das Namensschild:
// grau = man lernt nichts mehr, grün = leicht, gelb = passend, rot = gefährlich
function foeTone(kind, sum) {
  const def = RULES.enemies[kind];
  if (!def || !def.teach) return 'yellow';
  if (sum >= def.teach + RULES.learn.fade) return 'grey';
  if (sum >= def.teach - 30) return 'green';
  if (sum >= def.teach - 90) return 'yellow';
  return 'red';
}
const TONE_COLORS = { grey: '#b9b4a8', green: '#9fe08a', yellow: '#f2d36b', red: '#ff8a70' };

// ===========================================================================
//  Gegenstände in der Welt: Beutesäcke am Boden und die Truhe am Startplatz
// ===========================================================================
const ITEM_GEO = {
  sack:  flat(new THREE.IcosahedronGeometry(0.26, 0).scale(1, 0.8, 1).translate(0, 0.2, 0)),
  neck:  flat(new THREE.CylinderGeometry(0.06, 0.1, 0.12, 5).translate(0, 0.43, 0)),
  tie:   flat(new THREE.TorusGeometry(0.07, 0.025, 3, 6).rotateX(Math.PI / 2).translate(0, 0.4, 0)),
  chest: box(1.1, 0.55, 0.7).translate(0, 0.28, 0),
  lid:   box(1.14, 0.22, 0.74).translate(0, 0.66, 0),
  band:  box(0.08, 0.8, 0.76).translate(0, 0.4, 0),
  lock:  box(0.16, 0.18, 0.06).translate(0, 0.5, 0.38),
};
const ITEM_MATS = {
  sack:  new THREE.MeshLambertMaterial({ color: 0xa8865a }),
  neck:  new THREE.MeshLambertMaterial({ color: 0x8e6f48 }),
  free:  new THREE.MeshLambertMaterial({ color: 0xd9b24a, emissive: 0x4a3a10 }),   // darf man nehmen
  held:  new THREE.MeshLambertMaterial({ color: 0x7d7a74 }),                       // gehört noch jemand anderem
  wood:  new THREE.MeshLambertMaterial({ color: 0x6e4a2c }),
  brass: new THREE.MeshLambertMaterial({ color: 0xc9a24a }),
};

function makeLoot() {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(ITEM_GEO.sack, ITEM_MATS.sack));
  root.add(new THREE.Mesh(ITEM_GEO.neck, ITEM_MATS.neck));
  const tie = new THREE.Mesh(ITEM_GEO.tie, ITEM_MATS.held);
  root.add(tie);
  root.userData = { tie, t: Math.random() * 6 };
  scene.add(root);
  return root;
}

function setLootFree(model, free) {         // goldene Schnur: darf ich nehmen
  model.userData.tie.material = free ? ITEM_MATS.free : ITEM_MATS.held;
}

function animateLoot(model, x, z, dt) {     // sanftes Wippen, damit man Beute im Gras sieht
  const u = model.userData;
  u.t += dt * 2.2;
  model.position.set(x, groundY(x, z) + 0.03 + Math.max(0, Math.sin(u.t)) * 0.06, z);
  model.rotation.y = u.t * 0.25;
}

function disposeLoot(model) {
  scene.remove(model);
}

function makeChest(x, z) {
  const root = new THREE.Group();
  const add = (geo, mat, dx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.x = dx;
    root.add(m);
  };
  add(ITEM_GEO.chest, ITEM_MATS.wood);
  add(ITEM_GEO.lid, ITEM_MATS.wood);
  add(ITEM_GEO.band, ITEM_MATS.brass, -0.38);
  add(ITEM_GEO.band, ITEM_MATS.brass, 0.38);
  add(ITEM_GEO.lock, ITEM_MATS.brass);
  root.position.set(x, groundY(x, z) - 0.02, z);
  root.rotation.y = 0.35;
  scene.add(root);
  return root;
}

// ---- Dorf neben dem Startplatz: Schmiede, Lagerfeuer, zwei Häuser (nur Kulisse) ----
const VM = {
  stone: new THREE.MeshLambertMaterial({ color: 0x8b8377 }),
  wall:  new THREE.MeshLambertMaterial({ color: 0xa88a62 }),
  roof:  new THREE.MeshLambertMaterial({ color: 0x5b3a2a, side: THREE.DoubleSide }),
  dark:  new THREE.MeshLambertMaterial({ color: 0x2e2a27 }),
  ember: new THREE.MeshLambertMaterial({ color: 0xff7a2a, emissive: 0xff5a10 }),
  wood:  new THREE.MeshLambertMaterial({ color: 0x6e4a2c }),
};
const VILLAGE = { flame: null, flames: [] };

// Eine Gruppe auf dem Boden, deren Teile relativ zu ihrem Ursprung stehen
function place(x, z, angle = 0) {
  const g = new THREE.Group();
  g.position.set(x, groundY(x, z) - 0.02, z);
  g.rotation.y = angle;
  scene.add(g);
  return g;
}
function part(g, geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  g.add(m);
  return m;
}
// Walmdach: vier Dachflächen, die auf den Mauerkanten aufsitzen und leicht überstehen
function roofGeo(w, d, ht) {
  const ow = w / 2 + 0.12, od = d / 2 + 0.12;
  const c = [[-ow, 0, -od], [ow, 0, -od], [ow, 0, od], [-ow, 0, od]];
  const apex = [0, ht, 0];
  const pos = [];
  for (let i = 0; i < 4; i++) pos.push(...c[i], ...c[(i + 1) % 4], ...apex);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
function buildHouse(b) {
  const g = place(b.x, b.z, 0);
  part(g, box(b.w, b.h, b.d), b.kind === 'forge' ? VM.stone : VM.wall, 0, b.h / 2, 0);
  part(g, roofGeo(b.w, b.d, 1.3), VM.roof, 0, b.h, 0);
  return g;
}

function makeVillage() {
  // Schmiede: Mauern, Dach, Esse mit Glut, Amboss und Schornstein
  const forge = buildHouse(BUILDINGS[0]);
  part(forge, box(1.0, 0.8, 0.25), VM.ember, 0.9, 0.9, BUILDINGS[0].d / 2 + 0.05);   // Esse vorne
  part(forge, box(0.6, 0.5, 0.4), VM.dark, -1.0, 0.25, BUILDINGS[0].d / 2 + 0.6);    // Amboss davor
  part(forge, box(0.4, 1.0, 0.4), VM.stone, 1.3, 2.9, -0.9);                         // Schornstein

  // Lagerfeuer: Steinkranz, Holz, flackernde Flamme
  const fire = place(RULES.fire.x, RULES.fire.z, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    part(fire, new THREE.DodecahedronGeometry(0.22, 0), VM.stone, Math.cos(a) * 0.85, 0.1, Math.sin(a) * 0.85);
  }
  part(fire, box(1.1, 0.16, 0.18), VM.wood, 0, 0.12, 0).rotation.y = 0.7;
  part(fire, box(1.1, 0.16, 0.18), VM.wood, 0, 0.14, 0).rotation.y = -0.7;
  VILLAGE.flame = part(fire, new THREE.ConeGeometry(0.35, 0.9, 5), VM.ember, 0, 0.6, 0);

  buildHouse(BUILDINGS[1]);
  buildHouse(BUILDINGS[2]);
  makeFortress();
  makeSignpost();
}

// ===========================================================================
//  Festung Grauwacht und Vorposten – je Material ein verschmolzenes Netz
// ===========================================================================
// Viele Teile zu einem Netz mit Eckpunktfarben verschmelzen: ein Zeichenaufruf statt hunderter.
// jitter: jede Fläche bekommt eine leicht andere Helligkeit (Mauersteine, Holz)
function mergeColored(parts) {
  let n = 0;
  const geos = parts.map((p) => {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    if (p.m) g.applyMatrix4(p.m);
    n += g.attributes.position.count;
    return g;
  });
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  const c = new THREE.Color();
  geos.forEach((g, i) => {
    const a = g.attributes.position;
    pos.set(a.array, o * 3);
    c.setHex(parts[i].color);
    const jit = parts[i].jitter || 0;
    for (let v = 0; v < a.count; v += 6) {
      const f = 1 + (rand() - 0.5) * jit;
      for (let k = v; k < Math.min(v + 6, a.count); k++) {
        col[(o + k) * 3] = c.r * f;
        col[(o + k) * 3 + 1] = c.g * f;
        col[(o + k) * 3 + 2] = c.b * f;
      }
    }
    o += a.count;
    g.dispose();
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}
const mxAt = (x, y, z, ry = 0, rx = 0, rz = 0) =>
  new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')).setPosition(x, y, z);
const FORT_MAT = new THREE.MeshLambertMaterial({ vertexColors: true });
const CLOTH_MAT = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
const STONE = 0x8f897d, STONE_DARK = 0x6f6a61, TIMBER = 0x6b4a2e, PLANK = 0x8a6a45, SLATE = 0x4a4e57;

// Zinnen: kleine Mauerzähne entlang einer Kante von (ax, az) nach (bx, bz) in Höhe y
function merlons(list, ax, az, bx, bz, y, depth) {
  const len = Math.hypot(bx - ax, bz - az), ang = Math.atan2(bx - ax, bz - az);
  const count = Math.max(1, Math.floor(len / 1.3));
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    list.push({ geo: new THREE.BoxGeometry(depth, 0.75, 0.65), m: mxAt(ax + (bx - ax) * t, y + 0.37, az + (bz - az) * t, ang), color: STONE, jitter: 0.12 });
  }
}
// Zeltform: Dachfirst entlang z, Stoff bis zum Boden
function tentGeo(w, d, h) {
  const hw = w / 2, hd = d / 2;
  const v = [
    [-hw, 0, -hd], [0, h, -hd], [0, h, hd], [-hw, 0, -hd], [0, h, hd], [-hw, 0, hd],     // linke Bahn
    [hw, 0, -hd], [0, h, hd], [0, h, -hd], [hw, 0, -hd], [hw, 0, hd], [0, h, hd],        // rechte Bahn
    [-hw, 0, -hd], [hw, 0, -hd], [0, h, -hd],                                              // Rückwand
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v.flat(), 3));
  return g;
}

function makeFortress() {
  const stone = [], wood = [], cloth = [];
  const y0 = FORT.y - 0.02;
  for (const b of BUILDINGS) {
    if (b.kind === 'house' || b.kind === 'forge') continue;
    const by = groundY(b.x, b.z) - 0.02;
    if (b.kind === 'wall' || b.kind === 'tower' || b.kind === 'gatetower' || b.kind === 'keep') {
      // Mauerkörper reicht etwas in den Boden, damit an Hängen keine Lücke bleibt
      stone.push({ geo: new THREE.BoxGeometry(b.w, b.h + 0.6, b.d), m: mxAt(b.x, by + (b.h - 0.6) / 2, b.z), color: STONE, jitter: 0.1 });
      stone.push({ geo: new THREE.BoxGeometry(b.w + 0.24, 0.5, b.d + 0.24), m: mxAt(b.x, by + 0.15, b.z), color: STONE_DARK, jitter: 0.08 });   // Sockel
      const top = by + b.h;
      const hw = b.w / 2, hd = b.d / 2;
      if (b.kind === 'wall') {                 // Zinnen auf der Außenseite
        const alongX = b.w > b.d;
        if (alongX) {
          const outZ = b.z + Math.sign(b.z - FORT.z) * (hd - 0.25);
          merlons(stone, b.x - hw + 0.3, outZ, b.x + hw - 0.3, outZ, top, 0.45);
        } else {
          const outX = b.x + Math.sign(b.x - FORT.x) * (hw - 0.25);
          merlons(stone, outX, b.z - hd + 0.3, outX, b.z + hd - 0.3, top, 0.45);
        }
      } else {                                 // Türme: Kranz rundum und ein Gesims
        stone.push({ geo: new THREE.BoxGeometry(b.w + 0.5, 0.45, b.d + 0.5), m: mxAt(b.x, top - 0.1, b.z), color: STONE_DARK, jitter: 0.08 });
        const e = 0.1;
        merlons(stone, b.x - hw - e, b.z - hd - e, b.x + hw + e, b.z - hd - e, top + 0.12, 0.45);
        merlons(stone, b.x - hw - e, b.z + hd + e, b.x + hw + e, b.z + hd + e, top + 0.12, 0.45);
        merlons(stone, b.x - hw - e, b.z - hd + 0.6, b.x - hw - e, b.z + hd - 0.6, top + 0.12, 0.45);
        merlons(stone, b.x + hw + e, b.z - hd + 0.6, b.x + hw + e, b.z + hd - 0.6, top + 0.12, 0.45);
        // Schießscharten: schmale dunkle Schlitze
        for (const sx of [-1, 1]) {
          stone.push({ geo: new THREE.BoxGeometry(0.16, 0.9, 0.05), m: mxAt(b.x + sx * hw * 0.45, by + b.h * 0.62, b.z + hd + 0.01), color: 0x23211e });
          stone.push({ geo: new THREE.BoxGeometry(0.05, 0.9, 0.16), m: mxAt(b.x + hw + 0.01, by + b.h * 0.62, b.z + sx * hd * 0.45), color: 0x23211e });
          stone.push({ geo: new THREE.BoxGeometry(0.05, 0.9, 0.16), m: mxAt(b.x - hw - 0.01, by + b.h * 0.62, b.z + sx * hd * 0.45), color: 0x23211e });
        }
      }
      if (b.kind === 'keep') {                 // Tor zum Bergfried, Fenster, Fahnenmast
        wood.push({ geo: new THREE.BoxGeometry(2.0, 2.8, 0.12), m: mxAt(b.x, by + 1.4, b.z + hd + 0.04), color: 0x3d2a1a, jitter: 0.1 });
        stone.push({ geo: new THREE.BoxGeometry(2.6, 0.4, 0.3), m: mxAt(b.x, by + 3.0, b.z + hd + 0.1), color: STONE_DARK });
        for (const fx of [-3.2, 3.2]) stone.push({ geo: new THREE.BoxGeometry(0.7, 1.1, 0.06), m: mxAt(b.x + fx, by + 5.6, b.z + hd + 0.02), color: 0x23211e });
        wood.push({ geo: new THREE.CylinderGeometry(0.07, 0.09, 4, 6), m: mxAt(b.x + 3.5, top + 2.2, b.z - 2.5), color: TIMBER });
        cloth.push({ geo: new THREE.PlaneGeometry(1.9, 1.15, 4, 1), m: mxAt(b.x + 3.5 + 0.95, top + 3.55, b.z - 2.5), color: 0x7a1f24 });
      }
      continue;
    }
    if (b.kind === 'barracks') {               // Fachwerk: Holzwände, Schieferdach
      wood.push({ geo: new THREE.BoxGeometry(b.w, b.h, b.d), m: mxAt(b.x, by + b.h / 2, b.z), color: PLANK, jitter: 0.14 });
      for (const t of [-0.5, 0, 0.5]) wood.push({ geo: new THREE.BoxGeometry(b.w + 0.06, 0.16, 0.16), m: mxAt(b.x, by + b.h * (0.5 + t * 0.9), b.z + b.d / 2 + 0.02), color: TIMBER });
      const roof = roofGeo(b.w, b.d, 1.6);
      const rp = roof.attributes.position;               // Dreiecke umdrehen: Außenseite nach oben
      for (let i = 0; i < rp.count; i += 3) {
        const x1 = rp.getX(i + 1), y1 = rp.getY(i + 1), z1 = rp.getZ(i + 1);
        rp.setXYZ(i + 1, rp.getX(i + 2), rp.getY(i + 2), rp.getZ(i + 2));
        rp.setXYZ(i + 2, x1, y1, z1);
      }
      stone.push({ geo: roof, m: mxAt(b.x, by + b.h, b.z), color: SLATE, jitter: 0.1 });
      const dx = Math.sign(FORT.x - b.x);       // Tür zum Hof hin
      wood.push({ geo: new THREE.BoxGeometry(0.08, 1.9, 1.1), m: mxAt(b.x + dx * (b.w / 2 + 0.03), by + 0.95, b.z), color: 0x3d2a1a });
      continue;
    }
    if (b.kind === 'tent') {
      const along = b.d >= b.w;
      cloth.push({ geo: tentGeo(along ? b.w : b.d, along ? b.d : b.w, b.h), m: mxAt(b.x, by, b.z, along ? 0 : Math.PI / 2), color: 0xb9a57c });
      wood.push({ geo: new THREE.CylinderGeometry(0.05, 0.05, b.h + 0.3, 5), m: mxAt(b.x + (along ? 0 : b.w / 2), by + (b.h + 0.3) / 2, b.z + (along ? b.d / 2 : 0)), color: TIMBER });
    }
  }

  // Torbogen über der Durchfahrt (man geht darunter durch) und offene Torflügel
  const gz = FORT.z + FORT.half, gx = FORT.x, hg = FORT.gate / 2;
  stone.push({ geo: new THREE.BoxGeometry(FORT.gate + 0.4, 1.4, FORT.wall + 0.3), m: mxAt(gx, y0 + 4.5, gz), color: STONE, jitter: 0.1 });
  merlons(stone, gx - hg, gz + FORT.wall / 2 - 0.2, gx + hg, gz + FORT.wall / 2 - 0.2, y0 + 5.2, 0.45);
  for (const sx of [-1, 1]) {
    wood.push({ geo: new THREE.BoxGeometry(hg - 0.1, 3.6, 0.16), m: mxAt(gx + sx * (hg - 0.35), y0 + 1.8, gz - 1.6, sx * 1.35), color: 0x4f3622, jitter: 0.12 });
    stone.push({ geo: new THREE.BoxGeometry(0.5, 1.0, 0.5), m: mxAt(gx + sx * (hg + 3.2), y0 + 0.5, gz + 2.6), color: STONE_DARK });   // Feuerschalen-Sockel
  }
  // Fahnen an den Tortürmen
  for (const sx of [-1, 1]) {
    const tx = gx + sx * (hg + 1.4);
    wood.push({ geo: new THREE.CylinderGeometry(0.05, 0.06, 2.4, 6), m: mxAt(tx, y0 + 6 + 1.2, gz), color: TIMBER });
    cloth.push({ geo: new THREE.PlaneGeometry(1.3, 0.8, 3, 1), m: mxAt(tx + sx * 0.65, y0 + 6 + 2.0, gz, 0), color: 0x3b3f46 });
  }
  // Lager: Waffenständer, Kisten, Fässer, Banner
  const cy = (x, z) => groundY(x, z) - 0.02;
  wood.push({ geo: new THREE.BoxGeometry(2.2, 0.12, 0.12), m: mxAt(CAMP.x + 4, cy(CAMP.x + 4, CAMP.z + 1) + 1.0, CAMP.z + 1), color: TIMBER });
  for (const t of [-1, 1]) wood.push({ geo: new THREE.BoxGeometry(0.12, 1.1, 0.12), m: mxAt(CAMP.x + 4 + t * 1.0, cy(CAMP.x + 4, CAMP.z + 1) + 0.55, CAMP.z + 1), color: TIMBER });
  for (const [dx, dz, s] of [[-6, 3, 0.7], [-5.3, 3.8, 0.55], [6.5, -1, 0.65]]) {
    wood.push({ geo: new THREE.BoxGeometry(s, s, s), m: mxAt(CAMP.x + dx, cy(CAMP.x + dx, CAMP.z + dz) + s / 2, CAMP.z + dz, dx), color: PLANK, jitter: 0.15 });
  }
  wood.push({ geo: new THREE.CylinderGeometry(0.06, 0.07, 3.2, 6), m: mxAt(CAMP.x + 1.5, cy(CAMP.x + 1.5, CAMP.z - 6) + 1.6, CAMP.z - 6), color: TIMBER });
  cloth.push({ geo: new THREE.PlaneGeometry(0.8, 1.4, 1, 3), m: mxAt(CAMP.x + 1.5, cy(CAMP.x + 1.5, CAMP.z - 6) + 2.4, CAMP.z - 6 + 0.06), color: 0x3b3f46 });

  scene.add(new THREE.Mesh(mergeColored(stone), FORT_MAT));
  scene.add(new THREE.Mesh(mergeColored(wood), FORT_MAT));
  scene.add(new THREE.Mesh(mergeColored(cloth), CLOTH_MAT));

  // Feuer: Lagerfeuer am Vorposten und zwei Feuerschalen vor dem Tor
  const flame = (x, y, z, s) => {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.3 * s, 0.8 * s, 5), VM.ember);
    f.position.set(x, y + 0.4 * s, z);
    scene.add(f);
    VILLAGE.flames.push(f);
  };
  const fx = CAMP.x + 0.5, fz = CAMP.z + 0.5;
  const fire = place(fx, fz, 0);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    part(fire, new THREE.DodecahedronGeometry(0.2, 0), VM.stone, Math.cos(a) * 0.75, 0.1, Math.sin(a) * 0.75);
  }
  flame(fx, groundY(fx, fz), fz, 1);
  for (const sx of [-1, 1]) flame(gx + sx * (hg + 3.2), y0 + 1.0, gz + 2.6, 0.8);
}

// Wegweiser am Dorfrand: zeigt den Weg nach Norden zur Festung
function makeSignpost() {
  const x = 4.5, z = -15;
  const g = place(x, z, -0.5);
  part(g, new THREE.CylinderGeometry(0.07, 0.09, 2.2, 6), VM.wood, 0, 1.1, 0);
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#8a6a45';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#2b1d12';
  ctx.font = '700 30px "Alegreya Sans", "Trebuchet MS", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Grauwacht ▲', 128, 34);
  const board = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.38, 0.06), [
    VM.wood, VM.wood, VM.wood, VM.wood,
    new THREE.MeshLambertMaterial({ map: new THREE.CanvasTexture(cv) }),
    new THREE.MeshLambertMaterial({ map: new THREE.CanvasTexture(cv) }),
  ]);
  board.position.set(0.45, 1.85, 0);
  g.add(board);
}

function animateVillage(t) {               // Flammen flackern
  if (!VILLAGE.flame) return;
  const s = 1 + Math.sin(t * 9) * 0.08 + Math.sin(t * 23) * 0.04;
  VILLAGE.flame.scale.set(1, s, 1);
  VILLAGE.flames.forEach((f, i) => f.scale.set(1, 1 + Math.sin(t * 9 + i * 2.1) * 0.08 + Math.sin(t * 21 + i) * 0.04, 1));
}
