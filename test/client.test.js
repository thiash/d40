'use strict';
// Lädt world.js, net.js, combat.js und die Spielschleife aus index.html in eine
// Sandbox mit Attrappen für Three.js und die Seite und spielt gegen den echten Server –
// von der Anmeldung über den Kampf bis zum Neustart des Servers.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const WS = require('ws');
const S = require('../server/index.js');

const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${!cond && extra ? '  (' + extra + ')' : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Alles-Attrappe für Three.js und Zeichenflächen: aufrufbar, erzeugbar, merkt sich Zuweisungen
function anything() {
  const store = Object.create(null);
  return new Proxy(function () {}, {
    get(t, k) {
      if (k === Symbol.toPrimitive || k === 'valueOf') return () => 0;
      if (k === 'toString') return () => '';
      if (k === 'then') return undefined;
      if (k === Symbol.iterator) return function* () {};
      if (!(k in store)) store[k] = anything();
      return store[k];
    },
    set(t, k, v) { store[k] = v; return true; },
    apply() { return anything(); },
    construct() { return anything(); },
  });
}

function makeEl(id, hidden = false) {
  const listeners = {};
  return {
    id, hidden, children: [], dataset: {}, attrs: {}, parentNode: null, offsetWidth: 0,
    textContent: '', innerHTML: '', width: 0, height: 0, className: '', value: '', disabled: false,
    tagName: 'DIV',
    style: { setProperty(k, v) { this[k] = v; } },
    classList: {
      set: new Set(),
      add(...c) { c.forEach((x) => this.set.add(x)); },
      remove(...c) { c.forEach((x) => this.set.delete(x)); },
      toggle(c, force) {
        const on = force === undefined ? !this.set.has(c) : !!force;
        if (on) this.set.add(c); else this.set.delete(c);
        return on;
      },
      contains(c) { return this.set.has(c); },
    },
    get firstChild() { return this.children[0] || null; },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    remove() {
      if (!this.parentNode) return;
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
    },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatch(t, ev = {}) { (listeners[t] || []).forEach((fn) => fn({ preventDefault() {}, detail: 1, ...ev })); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    setPointerCapture() {},
    focus() {},
    getContext() { return anything(); },
  };
}

(async () => {
  const origLog = console.log;
  console.log = (...args) => { if (!String(args[0]).startsWith('[')) origLog(...args); };   // Serverprotokoll ausblenden
  S.WORLD.maxEnemies = 0;                // nur Tiere, die der Test selbst hinstellt
  const port = await S.start(0);
  S.enemies.clear();

  const dir = path.join(__dirname, '..', 'client');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const inline = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

  const elements = {};
  for (const m of html.matchAll(/id="([^"]+)"[^>]*\shidden[\s>]/g)) elements[m[1]] = makeEl(m[1], true);
  const el = (id) => elements[id] || (elements[id] = makeEl(id));
  el('login-go').value = 'login';
  el('login-new').value = 'register';
  const storage = new Map();
  const winListeners = {};
  let fakeNow = 1000, rafFn = null, frameErr = null;
  const ctx = vm.createContext({
    THREE: anything(),
    document: {
      getElementById: el,
      createElement: (tag) => makeEl(tag),
      body: makeEl('body'),
      fonts: { load: () => Promise.resolve() },
    },
    window: {
      innerWidth: 800, innerHeight: 600, devicePixelRatio: 2,
      matchMedia: () => ({ matches: false }),
      addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    performance: { now: () => fakeNow },
    requestAnimationFrame: (fn) => { rafFn = fn; },
    location: { protocol: 'http:', host: `localhost:${port}` },
    WebSocket: WS, setTimeout, clearTimeout, console,
  });
  const ev = (code) => vm.runInContext(code, ctx);
  const run = (file) => vm.runInContext(fs.readFileSync(path.join(dir, file), 'utf8'), ctx, { filename: file });

  run('world.js');
  run('character.js');
  ev('var __logs = []; { const orig = log; log = function (t) { __logs.push(t); orig(t); }; }');
  run('net.js');
  run('combat.js');
  run('items.js');
  run('admin.js');
  run('look.js');
  vm.runInContext(inline, ctx, { filename: 'index.html' });

  async function pump(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      fakeNow += 16;
      try { rafFn(); } catch (err) { frameErr = frameErr || err; }
      await sleep(16);
    }
  }
  async function until(fn, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await pump(32);
    }
    return fn();
  }
  const logged = (text) => ev('__logs').includes(text);
  // Tiere still entfernen; die Besatzung der Festung bleibt (der Client kennt sie schon)
  const clearAnimals = () => { for (const [id, e] of S.enemies) if (!S.ENEMY_KINDS[e.kind].human) S.enemies.delete(id); };
  const loginOpen = () => el('login').hidden === false && ev("document.body.classList.contains('login-open')");
  const submit = (kind, name, pass) => {
    el('login-name').value = name;
    el('login-pass').value = pass;
    el('login-form').dispatch('submit', { submitter: el(kind === 'register' ? 'login-new' : 'login-go') });
  };
  const key = (code) => (winListeners.keydown || []).forEach((fn) => fn({ code, repeat: false, target: { tagName: 'CANVAS' }, preventDefault() {} }));

  // ---- Anmeldung ----
  ok('Anmeldeformular erscheint, wenn sich das Gerät niemanden gemerkt hat', await until(loginOpen));
  ok('Noch keine Spielfigur vor der Anmeldung', ev('me.id') === null && S.players.size === 0
    && el('status-text').textContent === 'Anmeldung');
  const atk0 = ev('lastAttack');
  key('Space');
  ok('Während der Anmeldung steuert die Tastatur nicht das Spiel', ev('lastAttack') === atk0 && !ev("keys.has('Space')"));
  submit('login', '', '');
  ok('Leerer Name: Hinweis', el('login-error').textContent === 'Bitte gib einen Namen ein.');
  submit('login', 'Ronja', 'geheim123');
  await until(() => /Neuen Charakter/.test(el('login-error').textContent));
  ok('Unbekannter Name: Hinweis auf den Knopf für neue Charaktere', /Neuen Charakter anlegen/.test(el('login-error').textContent)
    && !el('login-go').disabled);
  submit('register', 'Ronja', 'geheim123');
  ok('Während der Anfrage sind die Knöpfe gesperrt', el('login-go').disabled === true && el('login-go').textContent === 'Einen Moment …');
  await until(() => ev('me.id') !== null);
  const P = () => S.players.get(ev('me.id'));
  ok('Neuer Charakter: Formular verschwindet, Spiel beginnt', !loginOpen() && el('login').hidden === true
    && P() && P().name === 'Ronja' && logged('Willkommen, Ronja.') && logged('Dein Charakter ist angelegt. Viel Glück in Althea!'));
  ok('Das Gerät merkt sich einen Schlüssel, nie das Passwort', typeof storage.get('d40.token') === 'string'
    && storage.get('d40.token').length >= 40 && ![...storage.values()].some((v) => v.includes('geheim123'))
    && el('login-pass').value === '');
  ok('Hinweis, wenn der Server nicht dauerhaft speichert', logged('Achtung: Der Server speichert gerade nicht dauerhaft.')
    && el('login-warn').hidden === false);

  // ---- Werte und Statusleiste ----
  await pump(100);
  ok('Statusleiste: 1 Spieler online', el('status-text').textContent === '1 Spieler online');
  ok('Lebens- und Manaanzeige', el('hp-text').textContent === '100 / 100' && el('mana-text').textContent === '60 / 60'
    && el('hp-bar').style.width === '100%');
  ok('Waffenknopf zeigt das Schwert', el('weapon-label').textContent === 'Schwert' && el('weapon-icon').innerHTML.includes('path'));
  ok('Werte-Tafel mit Startwerten', ev('statRows.str.textContent') === '10,00' && ev('statRows.cd.textContent') === '0,90 s'
    && ev('statRows.heal.textContent') === '5 %');
  ok('Werte-Tafel zeigt die Summe aller Attribute', ev('statRows.sum.textContent') === '50,00');
  el('stats-btn').dispatch('click');
  ok('Werte-Tafel lässt sich öffnen', el('stats').hidden === false && el('stats-btn').attrs['aria-expanded'] === 'true');

  // ---- Schwert gegen Keiler ----
  P().ry = 0;
  const boar = S.spawnEnemy('boar', P().x, P().z + 1.5);
  await until(() => ev(`creatures.has(${boar.id})`));
  ok('Tier erscheint beim Client', ev(`creatures.has(${boar.id})`));
  el('attack').dispatch('pointerdown');
  await until(() => ev(`creatures.get(${boar.id}).hp`) < 70);
  ok('Treffer kommt an, Lebensbalken über dem Tier', ev(`creatures.get(${boar.id}).hp`) === 61
    && ev(`creatures.get(${boar.id}).model.userData.bar.visible`) === true);
  ok('Schadenszahl schwebt auf', ev('floaters.some((f) => f.t < 1)'));
  await until(() => ev('me.self.a.str') >= 10.01);
  const sumShown = ev('statRows.sum.textContent');
  const sumReal = ev('Object.values(me.self.a).reduce((s, v) => s + v, 0)').toFixed(2).replace('.', ',');
  ok('Stärke steigt in der Werte-Tafel auf 10,01, Summe wächst mit', ev('statRows.str.textContent') === '10,01'
    && sumShown === sumReal && sumShown !== '50,00', `${sumShown} statt ${sumReal}`);
  await until(() => ev('me.self.hp') < 100);
  ok('Keiler schlägt zurück: Leben sinkt, roter Rand blitzt',
    el('hp-text').textContent === `${ev('me.self.hp')} / ${ev('me.self.hpMax')}` && ev('me.self.hp') <= 91
    && el('hurt').classList.contains('on'));

  // ---- Waffenwechsel ----
  el('weapon').dispatch('pointerdown');
  ok('Waffenwechsel zeigt sofort den Dolch', el('weapon-label').textContent === 'Dolch'
    && ev('me.model.userData.gear.dagger.visible') === true && logged('Du ziehst den Dolch.'));
  await until(() => P().weapon === 'dagger');
  el('weapon').dispatch('pointerdown');
  await until(() => P().weapon === 'bow');
  await pump(200);
  ok('Weiter zum Bogen, ohne Zurückspringen', el('weapon-label').textContent === 'Bogen' && ev('me.self.weapon') === 'bow');

  // ---- Sieg ----
  boar.hp = 1;
  await until(() => !ev(`creatures.has(${boar.id})`), 4000);
  ok('Besiegtes Tier kippt um, Meldung', !ev(`creatures.has(${boar.id})`) && logged('Du hast einen Keiler besiegt.'));
  P().autoTarget = null;

  // ---- Intelligenzzauber und Heilung ----
  const boar2 = S.spawnEnemy('boar', P().x, P().z + 8);
  P().ry = 0;
  await until(() => ev(`creatures.has(${boar2.id})`));
  await pump(1600);
  el('spell').dispatch('pointerdown');
  await until(() => ev('me.self.a.int') >= 10.01, 3000);
  ok('Intelligenzzauber trifft, Intelligenz 10,01', ev('statRows.int.textContent') === '10,01' && ev('me.self.mana') < 60);
  S.enemies.delete(boar2.id);
  P().autoTarget = null;
  P().hp = 50;
  P().lastFightAt = Date.now();
  await pump(1600);
  el('heal').dispatch('pointerdown');
  await until(() => ev('me.self.a.wis') >= 10.01, 2500);
  ok('Heilung wirkt: Weisheit 10,01, Heilschimmer', ev('statRows.wis.textContent') === '10,01' && ev('glows.length') > 0);

  // ---- K.O. ----
  S.COMBAT.reviveMs = 1500;
  P().hp = 14;
  P().lastInputAt = Date.now();
  S.spawnEnemy('wolf', P().x, P().z + 1.2);
  await until(() => ev('me.ko') === true, 4000);
  ok('K.O. wird angezeigt', ev('me.ko') === true && el('ko').hidden === false && logged('Du bist bewusstlos.'));
  await until(() => ev('me.ko') === false, 4000);
  ok('Wieder auf den Beinen', ev('me.ko') === false && el('ko').hidden === true);
  clearAnimals();
  P().autoTarget = null;

  // ---- Schritt 4: Beute, Tasche, Last, Truhe ----
  const teleport = (x, z) => { P().x = x; P().z = z; ev(`me.x = ${x}; me.z = ${z}`); };
  const nudge = () => ev("sendMsg({ t: 'chest', op: 'open' })");   // weit weg: Server schickt die eigenen Werte
  const findBtn = (list, op, k) => {
    for (const row of el(list).children) for (const c of row.children || []) {
      if (c.dataset && c.dataset.op === op && c.dataset.k === k) return c;
    }
    return null;
  };
  teleport(15, 15);
  clearAnimals();
  for (const id of [...S.loots.keys()]) S.removeLoot(id, 0);   // Beute aus den Kämpfen weiter oben
  await pump(200);
  ok('Last-Anzeige unter Leben und Mana', el('load-text').textContent === '0,0 / 40' && el('load-bar').style.width === '0%');
  const pile = S.spawnLoot(15.8, 15, { wolf_pelt: 1, wolf_fang: 2 }, P().accountId);
  await until(() => ev(`lootPiles.has(${pile.id})`));
  await pump(100);
  ok('Beute erscheint als Sack, der Knopf zeigt „Aufheben“', ev(`lootPiles.get(${pile.id}).free`) === true
    && el('use').hidden === false && el('use-label').textContent === 'Aufheben');
  el('use').dispatch('pointerdown');
  await until(() => !ev(`lootPiles.has(${pile.id})`));
  await pump(100);
  ok('Aufgehoben: Meldung, Sack weg, Knopf weg', logged('Du hebst 1 Wolfsfell und 2 Wolfszähne auf.')
    && el('use').hidden === true);
  ok('Last steigt', el('load-text').textContent === '1,6 / 40' && el('load-bar').style.width === '4%');

  el('stats-btn').dispatch('click');
  el('bag-btn').dispatch('click');
  ok('Tasche öffnet sich, Werte-Tafel geht zu', el('bag').hidden === false && el('stats').hidden === true
    && el('bag-btn').attrs['aria-expanded'] === 'true');
  ok('Tasche zeigt Last und Inhalt', el('bag-load').textContent === `Last 1,6 / ${ev('fmtKg(me.self.cap)')} kg`
    && !!findBtn('bag-list', 'drop', 'wolf_pelt') && !!findBtn('bag-list', 'drop', 'wolf_fang'),
    `${el('bag-load').textContent} | ${el('bag-list').children.length} Zeilen | ${JSON.stringify(el('bag-list').children.map((r) => (r.children || []).map((c) => c.textContent)))}`);
  findBtn('bag-list', 'drop', 'wolf_fang').dispatch('click');
  await until(() => logged('Du legst 2 Wolfszähne ab.'));
  await pump(100);
  ok('Ablegen: Meldung, Gegenstand verschwindet aus der Tasche', logged('Du legst 2 Wolfszähne ab.')
    && !findBtn('bag-list', 'drop', 'wolf_fang') && ev('me.self.inv.wolf_fang') === undefined);
  ok('Abgelegtes liegt vor einem und lässt sich wieder aufheben', ev('lootPiles.size') === 1
    && el('use').hidden === false, `piles ${ev('lootPiles.size')} use.hidden ${el('use').hidden} me ${ev('me.x')},${ev('me.z')} srv ${P().x},${P().z} piles ${JSON.stringify([...S.loots.values()].map((l) => [l.x, l.z]))}`);
  await pump(400);                         // Doppeltipp-Sperre abwarten
  key('KeyF');
  await until(() => ev('me.self.inv.wolf_fang') === 2);
  ok('Taste F hebt auf', ev('me.self.inv.wolf_fang') === 2 && ev('lootPiles.size') === 0);
  key('KeyI');
  ok('Taste I schließt die Tasche', el('bag').hidden === true);

  const foreign = S.spawnLoot(15.5, 15, { meat: 1 }, 987654);
  await until(() => ev(`lootPiles.has(${foreign.id})`));
  await pump(100);
  ok('Fremde reservierte Beute: kein Knopf', ev(`lootPiles.get(${foreign.id}).free`) === false && el('use').hidden === true,
    `free ${ev(`lootPiles.get(${foreign.id}).free`)} use ${el('use').hidden} ${el('use-label').textContent} piles ${ev('lootPiles.size')}`);
  S.loots.delete(foreign.id);
  ev(`removePile(${foreign.id})`);

  P().inv = { boar_hide: 15 };
  nudge();
  await until(() => ev('me.self.spd') === 0.83);
  ok('Zu schwer: langsamer, Meldung, Balken färbt sich', logged('Du trägst schwer und wirst langsamer.')
    && el('load-bar').classList.contains('over') && el('load-text').textContent === '45,0 / 40');
  P().inv = { boar_hide: 25 };             // 75 kg: weit über dem Anderthalbfachen
  nudge();
  await until(() => ev('me.self.spd') === 0);
  const sx = ev('me.x'), sz = ev('me.z');
  ev("keys.add('KeyW')");
  await pump(300);
  ev("keys.delete('KeyW')");
  ok('Überladen: man kommt nicht vom Fleck', ev('me.x') === sx && ev('me.z') === sz
    && logged('Du trägst zu viel und kommst nicht mehr vom Fleck. Leg etwas ab.'), `${sx},${sz} -> ${ev('me.x')},${ev('me.z')} ${JSON.stringify(ev('__logs').slice(-5))}`);
  P().inv = { meat: 2 };
  nudge();
  await until(() => ev('me.self.spd') === 1);
  ok('Wieder leicht: Meldung', logged('Deine Last ist wieder gut zu tragen.'));
  ev("keys.add('KeyW')");
  await pump(200);
  ev("keys.delete('KeyW')");
  ok('Und man läuft wieder', Math.hypot(ev('me.x') - sx, ev('me.z') - sz) > 0.5);

  teleport(1, 0.5);
  await pump(150);
  ok('An der Truhe: Knopf „Truhe öffnen“', el('use').hidden === false && el('use-label').textContent === 'Truhe öffnen');
  el('use').dispatch('pointerdown');
  await until(() => el('chest').hidden === false);
  ok('Truhe öffnet sich, anfangs leer', el('chest').hidden === false && el('chest-list').children.length === 1
    && el('chest-list').children[0].textContent === 'Die Truhe ist leer.' && !!findBtn('chest-bag', 'store', 'meat'));
  findBtn('chest-bag', 'store', 'meat').dispatch('click');
  await until(() => !!findBtn('chest-list', 'take', 'meat'));
  ok('Einlagern: Fleisch wandert in die Truhe', !!findBtn('chest-list', 'take', 'meat') && P().chest.meat === 2
    && ev('me.self.inv.meat') === undefined);
  findBtn('chest-list', 'take', 'meat').dispatch('click');
  await until(() => ev('me.self.inv.meat') === 2);
  ok('Nehmen: zurück in die Tasche', ev('me.self.inv.meat') === 2 && !P().chest.meat);
  ok('Knopf heißt jetzt „Truhe schließen“', el('use-label').textContent === 'Truhe schließen');
  teleport(15, 15);
  await pump(150);
  ok('Weggehen schließt die Truhe', el('chest').hidden === true && el('use').hidden === true,
    `chest ${el('chest').hidden} use ${el('use').hidden} ${el('use-label').textContent} me ${ev('me.x')},${ev('me.z')} piles ${ev('lootPiles.size')}`);

  // ---- Schritt 5: Schmiede und Lagerfeuer ----
  teleport(-14, -8);
  await pump(150);
  ok('An der Schmiede: Knopf „Schmieden“', el('use').hidden === false && el('use-label').textContent === 'Schmieden');
  el('use').dispatch('pointerdown');
  await until(() => el('craft').hidden === false);
  ok('Schmiede-Menü: drei Rezepte, Titel „Schmiede“', el('craft-title').textContent === 'Schmiede'
    && el('craft-list').children.length === Object.keys(ev('RULES.craft')).length && el('craft-list').children.length === 3);
  const oldCraftMs = S.CRAFTING.ms;
  S.CRAFTING.ms = 300;
  P().inv = { ...P().inv, boar_hide: 3, boar_tusk: 2 };
  ev("sendMsg({ t: 'craft', r: 'iron_sword' })");
  await until(() => el('craft-progress').hidden === false);
  ok('Schmieden: Fortschrittsbalken erscheint, Knöpfe gesperrt', ev("__logs.some((l) => l.startsWith('Du schmiedest '))")
    && el('craft-list').children[0].children[2].disabled === true);
  await until(() => el('craft-progress').hidden === true);
  ok('Fertig: Balken weg, Schwert in der Tasche', ev('me.self.inv.iron_sword') === 1 && ev("__logs.some((l) => l.startsWith('Fertig!'))"));
  S.CRAFTING.ms = oldCraftMs;
  el('craft-close').dispatch('click');
  ok('Schmiede-Menü schließt sich', el('craft').hidden === true && el('use-label').textContent === 'Schmieden');
  teleport(14, -8);
  await pump(150);
  ok('Am Feuer: Knopf „Am Feuer“', el('use-label').textContent === 'Am Feuer');
  await pump(400);                 // der Knopf sperrt Doppeltipps kurz
  el('use').dispatch('pointerdown');
  await until(() => el('craft').hidden === false);
  ok('Lagerfeuer-Menü: Titel „Lagerfeuer“', el('craft-title').textContent === 'Lagerfeuer' && el('craft-list').children.length === 1);
  teleport(15, 15);
  await pump(150);
  ok('Weggehen schließt das Lagerfeuer-Menü', el('craft').hidden === true);

  ok('Verwaltung ist für normale Spieler verborgen', el('admin-btn').hidden === true && el('admin').hidden === true);
  // ---- Aussehen ----
  ok('Figur hat ein Aussehen', ev('me.model.userData.look.sex') === 'm' && ev('!!me.model.userData.j.head') === true);
  el('look-btn').dispatch('click');
  ok('Aussehen-Panel öffnet sich, die Kamera schaut auf die Figur', el('look').hidden === false && ev('camDist') === 3.4);
  el('look-sex').children[1].dispatch('click');
  await until(() => ev('me.look && me.look.sex') === 'f');
  ok('Frau gewählt: der Server bestätigt, die Figur wird neu gebaut', ev('me.model.userData.look.sex') === 'f' && P().look.sex === 'f');
  ok('Frisuren für Frauen, kein Bart', el('look-style').children[1].textContent === 'Pferdeschwanz' && el('look-beard-row').hidden === true);
  ok('Fünf Frisuren, vier Gesichter, drei Staturen', el('look-style').children.length === 5 && el('look-face').children.length === 4
    && el('look-build').children.length === 3 && el('look-face').children[1].textContent === 'Zart');
  await pump(300);                  // Aussehen höchstens viermal pro Sekunde
  el('look-build').children[2].dispatch('click');
  await until(() => ev('me.look && me.look.build') === 2);
  ok('Statur „Kräftig“ gewählt: der Server bestätigt', P().look.build === 2 && ev('me.model.userData.look.build') === 2);
  el('look-close').dispatch('click');
  ok('Fertig: Panel zu, Kamera zurück', el('look').hidden === true && ev('camDist') !== 3.4);
  ok('Gebäude blockieren im Client wie im Server', ev('inBuilding(-24, -16)') === true && ev('inBuilding(0, 0)') === false);
  ok('Client und Server kennen dieselben Gebäude, auch die Festung', JSON.stringify(ev('BUILDINGS')) === JSON.stringify(S.BUILDINGS));
  ok('Client und Server rechnen dieselbe Landschaft, samt eingeebneter Festung',
    [[0, 0], [25, -150], [40, -120], [-80, 60], [10, -98], [60, -170]].every(([x, z]) => Math.abs(ev(`heightAt(${x}, ${z})`) - S.heightAt(x, z)) < 1e-9));

  // ---- Festung: Besatzung erscheint erst in der Nähe als Figur, mit Farbe nach Schwierigkeit ----
  const humanCount = () => ev('[...creatures.values()].filter((c) => c.model.userData.human).length');
  const builtFoes = () => ev('[...creatures.values()].filter((c) => c.model.userData.fig).length');
  const built0 = builtFoes();
  ok('Besatzung der Festung ist bekannt, aus der Ferne aber noch nicht gebaut', humanCount() === S.POSTS.length && built0 < 3,
    `${humanCount()} Menschen, ${built0} gebaut`);
  const campAt = { x: S.CAMP.x + 14, z: S.CAMP.z + 16 };
  P().x = campAt.x; P().z = campAt.z; P().safeUntil = Date.now() + 60000;
  ev(`me.x = ${campAt.x}; me.z = ${campAt.z};`);
  await until(() => builtFoes() >= built0 + 5, 4000);
  ok('In der Nähe entstehen die Figuren, eine nach der anderen', builtFoes() >= built0 + 5 && builtFoes() < humanCount());
  const guardTone = ev("(() => { const c = [...creatures.values()].find((c) => c.kind === 'guard' && c.model.userData.fig); return c && c.model.userData.tone; })()");
  ok('Namensschild zeigt die Schwierigkeit (Anfänger: Wächter sind gefährlich)', guardTone === 'red', guardTone);
  ok('Einstufung: grau, wenn man nichts mehr lernt', ev("foeTone('guard', 300)") === 'grey' && ev("foeTone('guard', 170)") === 'green'
    && ev("foeTone('guard', 120)") === 'yellow');
  P().safeUntil = 0;
  P().hp = P().hpMax = 5000;
  P().x = S.CAMP.x + 4; P().z = S.CAMP.z + 10;       // in Schussweite der Späher
  ev(`me.x = ${S.CAMP.x + 4}; me.z = ${S.CAMP.z + 10};`);
  ok('Späher schießen sichtbar mit Pfeilen', await until(() => ev('shots.some((s) => s.target === me.model)'), 5000));
  P().x = 0; P().z = 3; P().safeUntil = Date.now() + 10000;
  P().hpMax = S.maxHp(P().a); P().hp = P().hpMax;
  P().autoTarget = null;
  ev('me.x = 0; me.z = 3;');
  await pump(600);

  // ---- Abmelden ----
  const before = { ...P().a };
  el('logout').dispatch('click');
  await until(loginOpen);
  ok('Abmelden: Formular mit freundlicher Meldung, Tafel zu', loginOpen() && el('login-error').textContent === 'Du hast dich abgemeldet.'
    && el('login-error').classList.contains('info') && el('stats').hidden === true);
  ok('Abmelden: Figur verschwunden, Schlüssel vergessen', ev('me.id') === null && S.players.size === 0 && !storage.has('d40.token'));
  submit('login', 'ronja', 'falsch99');
  await until(() => el('login-error').textContent === 'Das Passwort stimmt nicht.');
  ok('Falsches Passwort wird angezeigt', el('login-error').textContent === 'Das Passwort stimmt nicht.' && !el('login-error').classList.contains('info'));
  submit('login', 'ronja', 'geheim123');
  await until(() => ev('me.id') !== null);
  ok('Wieder angemeldet: alle Werte sind noch da', !loginOpen() && ev('me.self.a.str') === before.str
    && ev('me.self.a.int') === before.int && ev('me.self.weapon') === 'bow');

  // ---- Anmeldung an einem anderen Gerät ----
  const other = new WS(`ws://localhost:${port}`);
  other.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t === 'hello') other.send(JSON.stringify({ t: 'login', name: 'Ronja', pass: 'geheim123' }));
  });
  await until(loginOpen, 4000);
  ok('Woanders angemeldet: Hinweis und Knopf zum Zurückholen', /anderen Gerät/.test(el('login-error').textContent)
    && el('login-resume').hidden === false && ev('me.id') === null);
  await pump(2500);
  ok('Kein automatisches Zurückholen (sonst werfen sich die Geräte gegenseitig hinaus)', ev('net.ws') === null
    && S.players.size === 1 && other.readyState === WS.OPEN);
  const otherClosed = new Promise((r) => other.on('close', r));
  el('login-resume').dispatch('click');
  await until(() => ev('me.id') !== null, 4000);
  await otherClosed;
  ok('Hier weiterspielen: zurück im Spiel, das andere Gerät ist draußen', !loginOpen() && S.players.size === 1
    && P() && P().name === 'Ronja');

  // ---- Neustart des Servers (wie bei jedem Deploy auf Render) ----
  P().a.agi = 14.5;
  await S.stop();
  await until(() => ev('me.id') === null, 3000);
  ok('Server weg: Client räumt auf und meldet die Trennung', ev('creatures.size') === 0
    && /^Getrennt/.test(el('status-text').textContent));
  await S.start(port);
  await until(() => ev('me.id') !== null, 15000);
  ok('Nach dem Neustart: automatisch wieder angemeldet, ohne Formular', ev('me.id') !== null && !loginOpen());
  ok('Nach dem Neustart: Fortschritt erhalten', ev('me.self.a.agi') === 14.5 && ev('me.self.a.str') === before.str);

  // ---- Ungültiger gemerkter Schlüssel ----
  storage.set('d40.token', 'x'.repeat(43));
  await S.stop();
  await S.start(port);
  await until(loginOpen, 15000);
  ok('Ungültiger Schlüssel: zurück zum Formular, Schlüssel gelöscht', loginOpen() && !storage.has('d40.token')
    && el('login-error').textContent === '');

  await S.stop();
  await pump(300);
  ok('Keine Fehler in der Spielschleife', !frameErr, frameErr && frameErr.stack);

  console.log = origLog;
  const fails = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(results.join('\n'));
  console.log(`\nERGEBNIS: ${results.length - fails} PASS, ${fails} FAIL`);
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error('ABBRUCH:', err); process.exit(1); });

process.on('uncaughtException', (err) => { console.error('UNBEHANDELTER FEHLER:', err); process.exit(1); });
