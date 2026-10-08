'use strict';
// ===========================================================================
//  D40 – Client, Teil 3 von 3: Kampf, Anzeigen und Effekte
//  Der Server entscheidet über Treffer, Schaden und Lernen. Hier wird nur
//  eingegeben und angezeigt.
// ===========================================================================

const WEAPON_ORDER = ['heavy', 'dagger', 'bow'];
const ATTR_NAMES = { str: 'Stärke', sta: 'Ausdauer', agi: 'Beweglichkeit', int: 'Intelligenz', wis: 'Weisheit' };
const DEFEATED = { hare: 'einen Hasen', wolf: 'einen Wolf', boar: 'einen Keiler' };
const DRAW = {
  heavy: 'Du ziehst das Schwert.',
  dagger: 'Du ziehst den Dolch.',
  bow: 'Du nimmst den Bogen zur Hand.',
};
const ICONS = {
  heavy: '<path d="M8 16 L19.5 4.5"/><path d="M5.5 13.5 L10.5 18.5"/><path d="M8 16 L4.5 19.5"/>',
  dagger: '<path d="M12 3 L14.2 9.5 L12 15 L9.8 9.5 Z"/><path d="M8 15 H16"/><path d="M12 15 V21"/>',
  bow: '<path d="M8 3 Q20 12 8 21"/><path d="M8 3 V21"/><path d="M4 12 H17"/><path d="M14 9 L17 12 L14 15"/>',
};

const hud = {
  hpBar: document.getElementById('hp-bar'),
  hpText: document.getElementById('hp-text'),
  manaBar: document.getElementById('mana-bar'),
  manaText: document.getElementById('mana-text'),
  weapon: document.getElementById('weapon'),
  weaponIcon: document.getElementById('weapon-icon'),
  weaponLabel: document.getElementById('weapon-label'),
  spell: document.getElementById('spell'),
  heal: document.getElementById('heal'),
  statsBtn: document.getElementById('stats-btn'),
  stats: document.getElementById('stats'),
  statsList: document.getElementById('stats-list'),
  ko: document.getElementById('ko'),
  koText: document.getElementById('ko-text'),
  hurt: document.getElementById('hurt'),
};

// ---- Werte-Tafel: fünf Attribute, ihre Summe, darunter was sie bewirken ----
// Die Summe zählt später für die Wiedergeburts-Quest.
const statRows = {};
for (const [key, label] of [
  ...Object.entries(ATTR_NAMES), ['sum', 'Summe'],
  ['cd', 'Angriffstempo'], ['dodge', 'Ausweichen'], ['heal', 'Heilung'],
]) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  hud.statsList.appendChild(dt);
  hud.statsList.appendChild(dd);
  statRows[key] = dd;
}

const fmt = (v) => v.toFixed(2).replace('.', ',');
const pct = (v, max) => `${Math.round(clamp(v / Math.max(max, 1), 0, 1) * 100)}%`;
let shownWeapon = null;

function refreshHud() {
  const s = me.self;
  hud.hpBar.style.width = pct(s.hp, s.hpMax);
  hud.hpText.textContent = `${s.hp} / ${s.hpMax}`;
  hud.manaBar.style.width = pct(s.mana, s.manaMax);
  hud.manaText.textContent = `${s.mana} / ${s.manaMax}`;
  if (shownWeapon !== s.weapon) {
    shownWeapon = s.weapon;
    hud.weaponIcon.innerHTML = ICONS[s.weapon] || ICONS.heavy;
    hud.weaponLabel.textContent = RULES.weapons[s.weapon] || s.weapon;
  }
  hud.spell.classList.toggle('low', s.mana < RULES.spells.int.cost);
  hud.heal.classList.toggle('low', s.mana < RULES.spells.wis.cost);
  let sum = 0;
  for (const k in ATTR_NAMES) {
    statRows[k].textContent = fmt(s.a[k]);
    sum += s.a[k];
  }
  statRows.sum.textContent = fmt(sum);
  statRows.cd.textContent = `${fmt(s.cd / 1000)} s`;
  statRows.dodge.textContent = `${s.dodge} %`;
  statRows.heal.textContent = `${String(s.heal).replace('.', ',')} %`;
  document.body.classList.toggle('is-ko', me.ko);
}

function toggleStats() {
  const open = hud.stats.hidden;
  hud.stats.hidden = !open;
  hud.statsBtn.setAttribute('aria-expanded', String(open));
}

// ===========================================================================
//  Eingaben: Angriff, Zauber, Waffenwechsel
// ===========================================================================
let lastAttack = -Infinity;
let lastCast = -Infinity;
let pendingWeapon = null, pendingAt = 0;

function restartRing(btn, ms) {      // Abklingring zeigt, wann es wieder geht
  btn.style.setProperty('--cd', `${ms}ms`);
  btn.classList.remove('cool');
  void btn.offsetWidth;             // Animation neu starten
  btn.classList.add('cool');
}

function attack() {
  if (me.ko) return;
  const now = performance.now();
  if (now - lastAttack < me.self.cd) return;
  lastAttack = now;
  me.model.userData.swing = 0;
  restartRing(ui.attack, me.self.cd);
  sendMsg({ t: 'attack' });
}

function castSpell(s) {
  const spell = RULES.spells[s];
  if (me.ko || !spell) return;
  const now = performance.now();
  if (now - lastCast < RULES.spellCooldown) return;
  if (me.self.mana < spell.cost) { log('Nicht genug Mana.'); return; }
  if (s === 'wis' && me.self.hp >= me.self.hpMax) { log('Du bist unverletzt.'); return; }
  lastCast = now;
  me.model.userData.cast = 0;
  restartRing(s === 'int' ? hud.spell : hud.heal, RULES.spellCooldown);
  sendMsg({ t: 'cast', s });
}

function cycleWeapon() {
  if (me.ko) return;
  const next = WEAPON_ORDER[(WEAPON_ORDER.indexOf(me.self.weapon) + 1) % WEAPON_ORDER.length];
  me.self.weapon = next;            // sofort zeigen, der Server bestätigt gleich
  pendingWeapon = next;
  pendingAt = performance.now();
  setWeaponModel(me.model, next);
  refreshHud();
  log(DRAW[next]);
  sendMsg({ t: 'weapon', w: next });
}

function bindButton(btn, fn) {
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); });
  btn.addEventListener('click', (e) => { if (e.detail === 0) fn(); });   // Enter-Taste
}
bindButton(ui.attack, attack);
bindButton(hud.weapon, cycleWeapon);
bindButton(hud.spell, () => castSpell('int'));
bindButton(hud.heal, () => castSpell('wis'));
hud.statsBtn.addEventListener('click', toggleStats);
document.getElementById('logout').addEventListener('click', logout);

// ===========================================================================
//  Nachrichten vom Server
// ===========================================================================
function actorModel(id) {
  if (id === me.id) return me.model;
  const o = others.get(id);
  return o ? o.model : null;
}

function onCombat(msg) {
  switch (msg.t) {
    case 'attack': {
      const model = actorModel(msg.id);
      if (!model) break;
      if (msg.id !== me.id || msg.auto) model.userData.swing = 0;   // eigene Schläge laufen schon
      if (msg.id === me.id && msg.auto) {
        lastAttack = performance.now();
        restartRing(ui.attack, me.self.cd);
      }
      if (msg.w === 'bow' && msg.te) shoot('arrow', model, msg.te);
      break;
    }
    case 'cast': {
      const model = actorModel(msg.id);
      if (!model) break;
      if (msg.id !== me.id) model.userData.cast = 0;
      if (msg.s === 'int' && msg.te) shoot('fire', model, msg.te);
      if (msg.s === 'wis') healGlow(model);
      break;
    }
    case 'hitE': {
      const c = creatures.get(msg.id);
      if (!c) break;
      c.hp = msg.hp;
      updateCreatureBar(c);
      floatText(c.model, String(msg.dmg), msg.by === me.id ? '#f6e7c4' : '#cfc6ad', 1.3);
      break;
    }
    case 'hitP': {
      const c = creatures.get(msg.by);
      if (c) c.model.userData.lunge = 0;
      if (msg.id === me.id) {
        me.self.hp = msg.hp;
        if (!msg.dodge) flashHurt();
        refreshHud();
      }
      const model = actorModel(msg.id);
      if (msg.dodge) floatText(model, 'Ausgewichen', '#bfe3f0', 2.3);
      else floatText(model, `−${msg.dmg}`, '#ff8a70', 2.3);
      break;
    }
    case 'you':
      onYou(msg);
      break;
    case 'ko':
      setKo(msg.id, true, msg.ms);
      break;
    case 'revive':
      setKo(msg.id, false);
      break;
  }
}

function onYou(msg) {
  const s = msg.self;
  if (pendingWeapon) {               // eine ältere Nachricht soll den Wechsel nicht zurückdrehen
    if (s.weapon === pendingWeapon || performance.now() - pendingAt > 1500) pendingWeapon = null;
    else s.weapon = pendingWeapon;
  }
  me.self = s;
  if (me.model && me.model.userData.w !== s.weapon) setWeaponModel(me.model, s.weapon);
  if (msg.up) for (const k of msg.up) log(`Deine ${ATTR_NAMES[k]} steigt auf ${Math.floor(s.a[k])}.`);
  if (msg.heal) floatText(me.model, `+${msg.heal}`, '#9fe08a', 2.3);
  if (msg.note === 'mana') log('Nicht genug Mana.');
  if (msg.note === 'full') log('Du bist unverletzt.');
  if (msg.note === 'notarget') {     // kein Ziel: der Zauber war umsonst, sofort wieder bereit
    log('Kein Ziel in Reichweite.');
    lastCast = -Infinity;
    hud.spell.classList.remove('cool');
  }
  refreshHud();
}

function setKo(id, on, ms) {
  const model = actorModel(id);
  if (model) model.userData.ko = on;
  if (id === me.id) {
    me.ko = on;
    me.koUntil = on ? performance.now() + (ms || RULES.reviveMs) : 0;
    hud.ko.hidden = !on;
    log(on ? 'Du bist bewusstlos.' : 'Du kommst wieder zu dir.');
    refreshHud();
  } else if (on) {
    const o = others.get(id);
    if (o) log(`${o.name} ist bewusstlos.`);
  }
}

function resetCombat() {             // nach einem Verbindungsabbruch
  me.ko = false;
  me.koUntil = 0;
  if (me.model) me.model.userData.ko = false;
  hud.ko.hidden = true;
  refreshHud();
}

function updateCreatureBar(c) {
  const bar = c.model.userData.bar;
  bar.visible = c.hp < c.hpMax;
  if (bar.visible) drawBar(bar, c.hp / c.hpMax);
}

const dying = [];
function killCreature(id, by) {
  const c = creatures.get(id);
  if (!c) return;
  creatures.delete(id);
  c.model.userData.bar.visible = false;
  dying.push({ model: c.model, t: 0 });
  if (by === me.id) log(`Du hast ${DEFEATED[c.kind] || 'ein Tier'} besiegt.`);
}

// ===========================================================================
//  Effekte: Schadenszahlen, Pfeile, Feuer, Heilschimmer, rote Ränder
// ===========================================================================
const floaters = [];
function floatText(model, text, color, height) {
  if (!model) return;
  let f = floaters.find((x) => x.t >= 1);
  if (!f) {
    if (floaters.length >= 24) {
      f = floaters.reduce((a, b) => (a.t > b.t ? a : b));
    } else {
      const cv = document.createElement('canvas');
      cv.width = 192;
      cv.height = 48;
      const material = new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, depthTest: false,
      });
      f = { sprite: new THREE.Sprite(material), cv, t: 1, y0: 0 };
      f.sprite.scale.set(1.9, 0.48, 1);
      scene.add(f.sprite);
      floaters.push(f);
    }
  }
  const ctx = f.cv.getContext('2d');
  ctx.clearRect(0, 0, 192, 48);
  ctx.font = '700 30px "Alegreya Sans", "Trebuchet MS", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(20, 28, 22, 0.85)';
  ctx.strokeText(text, 96, 25);
  ctx.fillStyle = color;
  ctx.fillText(text, 96, 25);
  f.sprite.material.map.needsUpdate = true;
  f.sprite.material.opacity = 1;
  f.y0 = model.position.y + height;
  f.sprite.position.set(model.position.x + (Math.random() - 0.5) * 0.6, f.y0, model.position.z);
  f.sprite.visible = true;
  f.t = 0;
}

const SHOT_GEO = {
  arrow: new THREE.BoxGeometry(0.04, 0.04, 0.7),
  fire: flat(new THREE.IcosahedronGeometry(0.2, 0)),
};
const SHOT_MAT = {
  arrow: new THREE.MeshLambertMaterial({ color: 0x5a3d22 }),
  fire: new THREE.MeshBasicMaterial({ color: 0xff8a3d }),
};
const shots = [];
const shotEnd = new THREE.Vector3();
function shoot(kind, fromModel, targetId) {
  const c = creatures.get(targetId);
  if (!c) return;
  const mesh = new THREE.Mesh(SHOT_GEO[kind], SHOT_MAT[kind]);
  const from = new THREE.Vector3(fromModel.position.x, fromModel.position.y + 1.4, fromModel.position.z);
  mesh.position.copy(from);
  scene.add(mesh);
  const speed = kind === 'arrow' ? 32 : 16;
  shots.push({ mesh, from, target: c.model, t: 0, dur: Math.max(0.12, from.distanceTo(c.model.position) / speed) });
}

const GLOW_GEO = new THREE.TorusGeometry(0.6, 0.05, 4, 18).rotateX(Math.PI / 2);
const glows = [];
function healGlow(model) {
  const mesh = new THREE.Mesh(GLOW_GEO, new THREE.MeshBasicMaterial({ color: 0x9fe08a, transparent: true }));
  scene.add(mesh);
  glows.push({ mesh, model, t: 0 });
}

function flashHurt() {
  hud.hurt.classList.remove('on');
  void hud.hurt.offsetWidth;
  hud.hurt.classList.add('on');
}

function updateFx(dt) {
  for (const f of floaters) {
    if (f.t >= 1) continue;
    f.t = Math.min(1, f.t + dt / 1.1);
    f.sprite.position.y = f.y0 + f.t * 1.1;
    f.sprite.material.opacity = 1 - smooth(Math.max(0, (f.t - 0.5) / 0.5));
    if (f.t >= 1) f.sprite.visible = false;
  }
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i];
    s.t = Math.min(1, s.t + dt / s.dur);
    const p = s.target.position;
    shotEnd.set(p.x, p.y + 0.5, p.z);
    s.mesh.position.lerpVectors(s.from, shotEnd, s.t);
    s.mesh.lookAt(shotEnd);
    if (s.t >= 1) { scene.remove(s.mesh); shots.splice(i, 1); }
  }
  for (let i = glows.length - 1; i >= 0; i--) {
    const g = glows[i];
    g.t = Math.min(1, g.t + dt / 0.8);
    const p = g.model.position;
    g.mesh.position.set(p.x, p.y + 0.1 + g.t * 1.9, p.z);
    g.mesh.material.opacity = 1 - g.t;
    if (g.t >= 1) { scene.remove(g.mesh); g.mesh.material.dispose(); glows.splice(i, 1); }
  }
  for (let i = dying.length - 1; i >= 0; i--) {   // besiegte Tiere kippen um und versinken
    const d = dying[i];
    d.t += dt;
    d.model.rotation.z = smooth(Math.min(1, d.t / 0.45)) * Math.PI / 2;
    if (d.t > 0.9) d.model.position.y -= dt * 0.9;
    if (d.t > 1.8) { disposeEnemy(d.model); dying.splice(i, 1); }
  }
  if (me.ko) {
    const left = Math.ceil((me.koUntil - performance.now()) / 1000);
    const text = left > 0 ? `Du kommst in ${left} s wieder zu dir.` : 'Du kommst gleich wieder zu dir.';
    if (hud.koText.textContent !== text) hud.koText.textContent = text;
  }
}

refreshHud();
