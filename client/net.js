'use strict';
// ===========================================================================
//  D40 – Client, Teil 2 von 3: Spielzustand, Steuerung und Netzwerk
// ===========================================================================

// ---- Spielzustand ----
const me = {
  id: null, x: 0, z: 0, ry: 0, model: null, ko: false, koUntil: 0,
  // Werte, die nur der Server festlegt – bis zur Verbindung mit Startwerten gefüllt
  self: {
    hp: 100, hpMax: 100, mana: 60, manaMax: 60, weapon: 'heavy', ko: false,
    a: { str: 10, sta: 10, agi: 10, int: 10, wis: 10 }, cd: 900, dodge: 0, heal: 5,
  },
};
const others = new Map();           // id → { name, model, x, z, tx, tz, ry }
const creatures = new Map();        // id → { kind, model, x, z, tx, tz, ry, hp, hpMax }

let camYaw = 0, camPitch = 0.42, camDist = 9;
const camTarget = new THREE.Vector3();
const tmpV = new THREE.Vector3();

function setMe(name, color) {
  if (me.model) disposeCharacter(me.model);
  me.model = makeCharacter(color, name);
  me.model.position.set(me.x, groundY(me.x, me.z), me.z);
  me.model.rotation.y = me.ry;
  me.model.userData.ko = me.ko;
  setWeaponModel(me.model, me.self.weapon);
  camTarget.set(me.x, groundY(me.x, me.z) + 1.5, me.z);
}

function addOther(p) {
  if (p.id === me.id || others.has(p.id)) return;
  const model = makeCharacter(p.color, p.name);
  model.position.set(p.x, groundY(p.x, p.z), p.z);
  model.rotation.y = p.ry;
  model.userData.ko = !!p.ko;
  setWeaponModel(model, p.w || 'heavy');
  others.set(p.id, { name: p.name, model, x: p.x, z: p.z, tx: p.x, tz: p.z, ry: p.ry });
}

function removeOther(id) {
  const o = others.get(id);
  if (!o) return;
  disposeCharacter(o.model);
  others.delete(id);
}

function clearOthers() {
  [...others.keys()].forEach(removeOther);
}

function addCreature(e) {
  if (creatures.has(e.id)) return;
  const model = makeEnemy(e.kind);
  model.position.set(e.x, groundY(e.x, e.z), e.z);
  model.rotation.y = e.ry;
  const c = { id: e.id, kind: e.kind, model, x: e.x, z: e.z, tx: e.x, tz: e.z, ry: e.ry, hp: e.hp, hpMax: e.hpMax };
  creatures.set(e.id, c);
  updateCreatureBar(c);
}

function clearCreatures() {
  for (const c of creatures.values()) disposeEnemy(c.model);
  creatures.clear();
}

// Namensschilder neu zeichnen, sobald die Schrift geladen ist
if (document.fonts && document.fonts.load) {
  document.fonts.load('700 28px "Alegreya Sans"').then(() => {
    [me.model, ...[...others.values()].map((o) => o.model)]
      .filter(Boolean)
      .forEach((model) => drawTag(model.userData.tag));
  }).catch(() => {});
}

// ===========================================================================
//  Steuerung: Joystick links, Kamera rechts wischen, Tastatur und Maus am PC
// ===========================================================================
const input = { x: 0, y: 0 };       // Joystick: x = rechts, y = vorwärts (je -1 bis 1)
const keys = new Set();
const STICK_RADIUS = 52;
const pointer = { stick: null, stickX: 0, stickY: 0, cam: null, camX: 0, camY: 0 };

function moveStick(x, y) {
  let dx = x - pointer.stickX, dy = y - pointer.stickY;
  const d = Math.hypot(dx, dy);
  if (d > STICK_RADIUS) { dx *= STICK_RADIUS / d; dy *= STICK_RADIUS / d; }
  ui.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  const ix = dx / STICK_RADIUS, iy = -dy / STICK_RADIUS;
  const inDeadzone = Math.hypot(ix, iy) < 0.15;
  input.x = inDeadzone ? 0 : ix;
  input.y = inDeadzone ? 0 : iy;
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') document.body.classList.add('touch');
  const touchLike = e.pointerType !== 'mouse';
  if (touchLike && pointer.stick === null && e.clientX < window.innerWidth / 2) {
    pointer.stick = e.pointerId;    // Joystick erscheint dort, wo der Daumen landet
    pointer.stickX = e.clientX;
    pointer.stickY = e.clientY;
    ui.stick.classList.add('active');
    ui.stick.style.left = e.clientX + 'px';
    ui.stick.style.top = e.clientY + 'px';
    moveStick(e.clientX, e.clientY);
  } else if (pointer.cam === null) {
    pointer.cam = e.pointerId;
    pointer.camX = e.clientX;
    pointer.camY = e.clientY;
  } else {
    return;
  }
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId === pointer.stick) {
    moveStick(e.clientX, e.clientY);
  } else if (e.pointerId === pointer.cam) {
    camYaw -= (e.clientX - pointer.camX) * 0.006;
    camPitch = clamp(camPitch + (e.clientY - pointer.camY) * 0.004, 0.12, 1.15);
    pointer.camX = e.clientX;
    pointer.camY = e.clientY;
  }
});

function endPointer(e) {
  if (e.pointerId === pointer.stick) {
    pointer.stick = null;
    input.x = input.y = 0;
    ui.stick.classList.remove('active');
    ui.stick.style.left = ui.stick.style.top = '';
    ui.knob.style.transform = '';
  }
  if (e.pointerId === pointer.cam) pointer.cam = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camDist = clamp(camDist + e.deltaY * 0.01, 5, 16);
}, { passive: false });

// Tasten am PC – die Kampf-Funktionen stehen in combat.js
window.addEventListener('keydown', (e) => {
  // Beim Tippen in ein Feld oder während der Anmeldung steuert die Tastatur nicht das Spiel
  if (document.body.classList.contains('login-open')) return;
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  keys.add(e.code);
  if (e.code === 'Space') e.preventDefault();
  if (e.repeat) return;
  if (e.code === 'Space') attack();
  else if (e.code === 'KeyQ') cycleWeapon();
  else if (e.code === 'KeyE') castSpell('int');
  else if (e.code === 'KeyR') castSpell('wis');
  else if (e.code === 'KeyC') toggleStats();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());

// ===========================================================================
//  Netzwerk – WebSocket zum Spielserver
// ===========================================================================
const net = {
  ws: null, retry: 0, corr: 0, ping: null,
  sendTimer: 0, pingTimer: 0,
  sent: { x: Infinity, z: Infinity, ry: Infinity },
  persist: true,                    // speichert der Server dauerhaft?
  kicked: false,                    // an einem anderen Gerät angemeldet: nicht von selbst zurückholen
};

const isOnline = () => net.ws !== null && net.ws.readyState === WebSocket.OPEN && me.id !== null;

function sendMsg(msg) {
  if (net.ws && net.ws.readyState === WebSocket.OPEN) net.ws.send(JSON.stringify(msg));
}

function connect() {
  if (!/^https?:$/.test(location.protocol)) {
    setStatus('offline', 'Offline');
    log('Datei direkt geöffnet: Du spielst allein. Für Mehrspieler den Server mit npm start starten.');
    return;
  }
  setStatus('connecting', 'Verbinde…');
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  net.ws = ws;

  ws.addEventListener('open', () => { net.retry = 0; });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onMessage(msg);
  });
  ws.addEventListener('close', () => {
    if (net.ws !== ws) return;
    const wasOnline = me.id !== null;
    net.ws = null;
    net.ping = null;
    leaveGame();
    if (net.kicked) {               // woanders angemeldet: erst auf Wunsch zurück
      setStatus('offline', 'Abgemeldet');
      return;
    }
    login.setBusy(false);
    const wait = Math.min(1000 * 2 ** net.retry, 10000);
    net.retry++;
    setStatus('offline', `Getrennt, neuer Versuch in ${Math.round(wait / 1000)} s`);
    if (wasOnline) log('Verbindung zum Server verloren.');
    else if (net.retry === 1) log('Kein Server erreichbar. Starte ihn mit npm start.');
    setTimeout(connect, wait);
  });
}

// Spielwelt verlassen (Abmelden, woanders angemeldet, Verbindung weg)
function leaveGame() {
  me.id = null;
  clearOthers();
  clearCreatures();
  resetCombat();
}

// ===========================================================================
//  Anmeldung: Name und Passwort, danach merkt sich das Gerät einen Schlüssel
// ===========================================================================
const savedLogin = {                // im Browser gespeicherter Anmelde-Schlüssel (nie das Passwort)
  key: 'd40.token',
  get() { try { return localStorage.getItem(this.key); } catch { return null; } },
  set(t) { try { localStorage.setItem(this.key, t); } catch { /* privates Fenster: dann eben ohne */ } },
  clear() { try { localStorage.removeItem(this.key); } catch { /* egal */ } },
};

const login = {
  box: document.getElementById('login'),
  form: document.getElementById('login-form'),
  name: document.getElementById('login-name'),
  pass: document.getElementById('login-pass'),
  error: document.getElementById('login-error'),
  go: document.getElementById('login-go'),
  fresh: document.getElementById('login-new'),
  resume: document.getElementById('login-resume'),
  warn: document.getElementById('login-warn'),
  busy: false,

  show(text = '', opts = {}) {
    this.box.hidden = false;
    document.body.classList.add('login-open');
    this.error.textContent = text;
    this.error.classList.toggle('info', !!opts.info);
    this.resume.hidden = !opts.resume;
    this.warn.hidden = net.persist;
    this.setBusy(false);
    setStatus(isOnline() ? 'online' : (net.ws ? 'connecting' : 'offline'), net.kicked ? 'Abgemeldet' : 'Anmeldung');
    // Am PC gleich ins Feld springen; am Handy nicht, sonst klappt sofort die Tastatur auf
    if (window.matchMedia && window.matchMedia('(pointer: fine)').matches && this.name.focus) {
      (this.name.value ? this.pass : this.name).focus();
    }
  },
  hide() {
    this.box.hidden = true;
    document.body.classList.remove('login-open');
    this.pass.value = '';
    this.error.textContent = '';
  },
  setBusy(on) {
    this.busy = on;
    this.go.disabled = this.fresh.disabled = on;
    this.go.textContent = on ? 'Einen Moment …' : 'Anmelden';
  },
  submit(kind) {
    if (this.busy) return;
    const name = this.name.value.trim();
    const pass = this.pass.value;
    if (!name) return this.show('Bitte gib einen Namen ein.');
    if (!pass) return this.show('Bitte gib ein Passwort ein.');
    if (!net.ws || net.ws.readyState !== WebSocket.OPEN) {
      if (net.kicked) return resumeHere();          // nach "woanders angemeldet": einfach neu verbinden
      return this.show('Keine Verbindung zum Server. Es wird gleich neu versucht.');
    }
    this.error.textContent = '';
    this.setBusy(true);
    sendMsg({ t: kind, name, pass });
  },
};

login.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const kind = e.submitter && e.submitter.value === 'register' ? 'register' : 'login';
  login.submit(kind);
});
function resumeHere() {             // nach "woanders angemeldet" hier zurückholen
  net.kicked = false;
  login.hide();
  net.retry = 0;
  connect();
}
login.resume.addEventListener('click', resumeHere);

function onAuthMessage(msg) {
  switch (msg.t) {
    case 'hello': {                 // neue Verbindung: gemerkte Anmeldung nutzen oder Formular zeigen
      net.persist = msg.persist !== false;
      const token = savedLogin.get();
      if (token) {
        setStatus('connecting', 'Melde an …');
        login.setBusy(true);
        sendMsg({ t: 'resume', token });
      } else {
        login.show(login.error.textContent);
      }
      return true;
    }
    case 'auth':
      savedLogin.set(msg.token);
      login.hide();
      if (msg.fresh) log('Dein Charakter ist angelegt. Viel Glück in Althea!');
      if (!msg.persist) log('Achtung: Der Server speichert gerade nicht dauerhaft.');
      return true;
    case 'denied':
      if (msg.code === 'token') {   // gemerkte Anmeldung ungültig: neu anmelden
        savedLogin.clear();
        login.show('');
      } else {
        login.show(msg.text || 'Die Anmeldung hat nicht geklappt.');
      }
      return true;
    case 'kicked':
      net.kicked = true;
      leaveGame();
      login.show(msg.text, { resume: true });
      return true;
    case 'bye':                     // abgemeldet: Gerät vergisst den Schlüssel
      savedLogin.clear();
      leaveGame();
      login.show('Du hast dich abgemeldet.', { info: true });
      return true;
    case 'notice':
      log(msg.text);
      return true;
  }
  return false;
}

function logout() {
  if (!isOnline()) return;
  hud.stats.hidden = true;
  hud.statsBtn.setAttribute('aria-expanded', 'false');
  sendMsg({ t: 'logout' });
}

function onMessage(msg) {
  if (onAuthMessage(msg)) return;
  switch (msg.t) {
    case 'welcome': {
      Object.assign(RULES, msg.rules);
      const you = msg.you;
      me.id = you.id;
      me.x = you.x;
      me.z = you.z;
      me.ry = you.ry;
      me.self = msg.self;
      me.ko = !!msg.self.ko;
      net.corr = 0;
      net.sent = { x: Infinity, z: Infinity, ry: Infinity };
      setMe(you.name, you.color);
      clearOthers();
      msg.players.forEach(addOther);
      clearCreatures();
      msg.enemies.forEach(addCreature);
      refreshHud();
      log(`Willkommen, ${you.name}.`);
      break;
    }
    case 'join':
      addOther(msg.player);
      log(`${msg.player.name} ist da.`);
      break;
    case 'leave': {
      const o = others.get(msg.id);
      if (o) {
        log(`${o.name} ist gegangen.`);
        removeOther(msg.id);
      }
      break;
    }
    case 'state':
      for (const [id, x, z, ry, , , ko] of msg.p || []) {
        const o = others.get(id);
        if (!o) continue;
        o.tx = x; o.tz = z; o.ry = ry;
        o.model.userData.ko = ko === 1;
      }
      for (const [id, x, z, ry] of msg.e || []) {
        const c = creatures.get(id);
        if (c) { c.tx = x; c.tz = z; c.ry = ry; }
      }
      break;
    case 'gear': {
      const o = others.get(msg.id);
      if (o) setWeaponModel(o.model, msg.w);
      break;
    }
    case 'spawn':
      addCreature(msg.e);
      break;
    case 'despawn':
      killCreature(msg.id, msg.by);
      break;
    case 'correct':                 // Server hat eine Bewegung abgelehnt: zurück auf seine Position
      me.x = msg.x;
      me.z = msg.z;
      net.corr = msg.n;
      break;
    case 'pong':
      net.ping = Math.round(performance.now() - msg.ts);
      break;
    default:                        // attack, cast, hitE, hitP, you, ko, revive → combat.js
      onCombat(msg);
  }
  if (isOnline()) {
    setStatus('online', `${others.size + 1} Spieler online`, net.ping === null ? '' : `${net.ping} ms`);
  }
}

function updateNet(dt) {
  if (!isOnline()) return;
  net.sendTimer += dt;
  net.pingTimer += dt;
  if (net.sendTimer >= 1 / SEND_RATE && !me.ko) {
    net.sendTimer = 0;
    const s = net.sent;
    if (Math.abs(me.x - s.x) > 0.01 || Math.abs(me.z - s.z) > 0.01 || Math.abs(me.ry - s.ry) > 0.02) {
      sendMsg({ t: 'move', x: r2(me.x), z: r2(me.z), ry: r2(me.ry), c: net.corr });
      net.sent = { x: me.x, z: me.z, ry: me.ry };
    }
  }
  if (net.pingTimer >= 2) {
    net.pingTimer = 0;
    sendMsg({ t: 'ping', ts: performance.now() });
  }
}

// ===========================================================================
//  Bewegung: eigene Figur, Mitspieler, Tiere, Kamera
// ===========================================================================
function updateMe(dt) {
  if (me.ko) {                      // bewusstlos: keine Bewegung
    animateCharacter(me.model, me.x, me.z, me.ry, 0, dt);
    return;
  }
  let ix = input.x, iy = input.y;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) ix -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) ix += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) iy += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) iy -= 1;
  const mag = Math.hypot(ix, iy);
  if (mag > 1) { ix /= mag; iy /= mag; }
  const strength = Math.min(mag, 1);

  if (strength > 0.01) {
    // Richtung relativ zur Kamera in Weltkoordinaten umrechnen.
    // Der Client bewegt sich sofort (Vorhersage), der Server prüft hinterher.
    const sin = Math.sin(camYaw), cos = Math.cos(camYaw);
    const dx = cos * ix - sin * iy;
    const dz = -sin * ix - cos * iy;
    const lim = RULES.worldHalf;
    me.x = clamp(me.x + dx * RULES.speed * dt, -lim, lim);
    me.z = clamp(me.z + dz * RULES.speed * dt, -lim, lim);
    me.ry = Math.atan2(dx, dz);
  }
  animateCharacter(me.model, me.x, me.z, me.ry, strength * RULES.speed, dt);
}

function updateOthers(dt) {
  // Andere Spieler gleiten weich zu ihrer letzten bekannten Position
  const k = damp(12, dt);
  for (const o of others.values()) {
    const px = o.x, pz = o.z;
    o.x = lerp(o.x, o.tx, k);
    o.z = lerp(o.z, o.tz, k);
    const speed = Math.hypot(o.x - px, o.z - pz) / Math.max(dt, 0.001);
    animateCharacter(o.model, o.x, o.z, o.ry, speed, dt);
  }
}

function updateCreatures(dt) {
  const k = damp(10, dt);
  for (const c of creatures.values()) {
    const px = c.x, pz = c.z;
    c.x = lerp(c.x, c.tx, k);
    c.z = lerp(c.z, c.tz, k);
    const speed = Math.hypot(c.x - px, c.z - pz) / Math.max(dt, 0.001);
    animateEnemy(c.model, c.x, c.z, c.ry, speed, dt);
  }
}

function updateCamera(dt) {
  tmpV.set(me.x, groundY(me.x, me.z) + 1.5, me.z);
  camTarget.lerp(tmpV, damp(10, dt));
  const horizontal = Math.cos(camPitch) * camDist;
  camera.position.set(
    camTarget.x + Math.sin(camYaw) * horizontal,
    camTarget.y + Math.sin(camPitch) * camDist,
    camTarget.z + Math.cos(camYaw) * horizontal
  );
  const minY = Math.max(heightAt(camera.position.x, camera.position.z), WATER_LEVEL) + 0.8;
  if (camera.position.y < minY) camera.position.y = minY;   // Kamera bleibt über Boden und Wasser
  camera.lookAt(camTarget);
}
