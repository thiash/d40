'use strict';
// ===========================================================================
//  D40 – Client, Teil 1 von 4: Grundgerüst, Welt, Figuren, Tiere, Beute und Truhe
//  Reihenfolge der Dateien: world.js → net.js → combat.js → items.js (siehe index.html)
// ===========================================================================

// ---- Regeln (der Server schickt beim Verbinden seine eigenen Werte) ----
// Gebäude sind feste Hindernisse (der Server prüft dieselbe Liste)
const BUILDINGS = [
  { x: -14, z: -8, w: 4, d: 3.4, h: 2.4, kind: 'forge' },
  { x: -24, z: -16, w: 3, d: 2.6, h: 2.2, kind: 'house' },
  { x: 10, z: -20, w: 2.6, d: 2.4, h: 2, kind: 'house' },
];
const BUILDING_PAD = 0.35;          // Abstand, den die Spielfigur zu Mauern hält
const inBuilding = (x, z) => BUILDINGS.some((b) =>
  Math.abs(x - b.x) < b.w / 2 + BUILDING_PAD && Math.abs(z - b.z) < b.d / 2 + BUILDING_PAD);

const RULES = {
  speed: 6, worldHalf: 95, spellCooldown: 1500, reviveMs: 20000,
  buildings: BUILDINGS,
  weapons: { heavy: 'Schwert', dagger: 'Dolch', bow: 'Bogen' },
  spells: { int: { name: 'Intelligenzzauber', cost: 5 }, wis: { name: 'Weisheitszauber', cost: 6 } },
  enemies: { hare: 'Hase', wolf: 'Wolf', boar: 'Keiler' },
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
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 300);

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
  return Math.sin(x * 0.045) * 2.2 + Math.cos(z * 0.05) * 1.8
       + Math.sin((x + z) * 0.11) * 0.7 + Math.cos((x - z) * 0.07) * 0.9 - 0.8;
}
// Im Wasser treibt man an der Oberfläche – ein Vorgeschmack aufs Schwimmen
const groundY = (x, z) => Math.max(heightAt(x, z), WATER_LEVEL - 1.1);

function flat(geo) {                // Low-Poly-Look: jede Fläche bekommt ihre eigene Normale
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

function buildTerrain() {
  const geo = new THREE.PlaneGeometry(220, 220, 88, 88);
  geo.rotateX(-Math.PI / 2);
  const p0 = geo.attributes.position;
  for (let i = 0; i < p0.count; i++) p0.setY(i, heightAt(p0.getX(i), p0.getZ(i)));

  const g = flat(geo);
  const pos = g.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 3) {
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const v = rand() * 0.05;
    let c;
    if (y < WATER_LEVEL + 0.5) c = [0.74 + v, 0.66 + v, 0.46 + v];      // Ufer
    else if (y > 3.2)          c = [0.52 + v, 0.6 + v, 0.31 + v];       // trockene Kuppen
    else                       c = [0.31 + v, 0.52 + v, 0.24 + v];      // Wiese
    for (let k = 0; k < 3; k++) colors.set(c, (i + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true })));

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(220, 220),
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

  for (let i = 0; i < 260; i++) {
    const x = (rand() * 2 - 1) * 108;
    const z = (rand() * 2 - 1) * 108;
    const kind = rand() < 0.22 ? 'rock' : rand() < 0.65 ? 'pine' : 'crown';
    const k = 0.7 + rand() * 0.7;
    const turn = rand() * Math.PI * 2;
    const y = heightAt(x, z);
    if (Math.hypot(x, z) < 14 || y < WATER_LEVEL + 0.6) continue;  // Lichtung am Start, nichts im Wasser
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
  ctx.fillStyle = '#ece3cc';
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
}

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
const VILLAGE = { flame: null };

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
}

function animateVillage(t) {               // Flamme flackert
  if (!VILLAGE.flame) return;
  const s = 1 + Math.sin(t * 9) * 0.08 + Math.sin(t * 23) * 0.04;
  VILLAGE.flame.scale.set(1, s, 1);
}
