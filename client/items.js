'use strict';
// ===========================================================================
//  D40 – Client, Teil 4 von 4: Beute, Tasche und Truhe
//  Der Server entscheidet, wer was bekommt. Hier wird nur angezeigt und gefragt.
// ===========================================================================

const lootPiles = new Map();        // id → { model, x, z, items, mine, freeAt, free }
const chestModel = makeChest(RULES.chest.x, RULES.chest.z);
makeVillage();

const itemsUi = {
  use: document.getElementById('use'),
  useLabel: document.getElementById('use-label'),
  bagBtn: document.getElementById('bag-btn'),
  bag: document.getElementById('bag'),
  bagLoad: document.getElementById('bag-load'),
  bagBar: document.getElementById('bag-bar'),
  bagList: document.getElementById('bag-list'),
  chest: document.getElementById('chest'),
  chestList: document.getElementById('chest-list'),
  chestBag: document.getElementById('chest-bag'),
  chestLoad: document.getElementById('chest-load'),
  chestClose: document.getElementById('chest-close'),
  loadBar: document.getElementById('load-bar'),
  loadText: document.getElementById('load-text'),
  craft: document.getElementById('craft'),
  craftTitle: document.getElementById('craft-title'),
  craftNote: document.getElementById('craft-note'),
  craftList: document.getElementById('craft-list'),
  craftClose: document.getElementById('craft-close'),
};

const itemState = {
  target: null,                     // was der Knopf gerade tut: { kind: 'loot', pile } oder { kind: 'chest' }
  useBlockedUntil: 0,               // kurz sperren, damit ein Doppeltipp nicht zweimal schickt
  chestOpen: false,
  craftMode: '',                    // '' | 'forge' | 'fire': welches Menü gerade offen ist
  chestItems: {},
  bagKey: '',                       // zuletzt gezeichneter Inhalt, um unnötiges Neuzeichnen zu sparen
  chestKey: '',
  craftKey: '',
  spd: 1,                           // zuletzt bekanntes Tempo – für Meldungen beim Überladen
};

// ---- Namen und Gewichte ----
const fmtKg = (v) => (Math.round(v * 10) / 10).toFixed(1).replace('.', ',');
function itemLabel(k, n) {
  const it = RULES.items[k];
  if (!it) return `${n} ${k}`;
  return `${n} ${n === 1 ? it.name : it.plural}`;
}
function listItems(items) {
  const parts = Object.keys(items).map((k) => itemLabel(k, items[k]));
  if (parts.length <= 1) return parts[0] || 'nichts';
  return `${parts.slice(0, -1).join(', ')} und ${parts[parts.length - 1]}`;
}
function sortedKeys(items) {        // immer in der Reihenfolge des Katalogs
  const order = Object.keys(RULES.items);
  return Object.keys(items).filter((k) => items[k] > 0)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
function clearEl(el) {
  while (el.firstChild) el.firstChild.remove();
}

// ===========================================================================
//  Beute am Boden
// ===========================================================================
function addPile(l) {
  if (lootPiles.has(l.id)) return;
  const pile = {
    id: l.id, model: makeLoot(), x: l.x, z: l.z, items: l.items,
    mine: !!l.mine, freeAt: performance.now() + (l.res || 0), free: null,
  };
  lootPiles.set(l.id, pile);
  animateLoot(pile.model, pile.x, pile.z, 0);
}

function canTake(pile) {
  return pile.mine || performance.now() >= pile.freeAt;
}

function removePile(id) {
  const pile = lootPiles.get(id);
  if (!pile) return;
  disposeLoot(pile.model);
  lootPiles.delete(id);
}

function clearPiles() {
  [...lootPiles.keys()].forEach(removePile);
}

// ===========================================================================
//  Der Knopf „Aufheben“ / „Truhe“: zeigt sich, wenn etwas in Reichweite ist
// ===========================================================================
function findTarget() {
  if (!isOnline() || me.ko) return null;
  let best = null, bestD = RULES.lootReach - 0.15;   // etwas Abstand zur Grenze des Servers
  for (const pile of lootPiles.values()) {
    if (!pile.free) continue;
    const d = Math.hypot(pile.x - me.x, pile.z - me.z);
    if (d <= bestD) { best = { kind: 'loot', pile }; bestD = d; }
  }
  if (best) return best;
  const near = (p) => Math.hypot(p.x - me.x, p.z - me.z);
  if (near(RULES.chest) <= RULES.chest.reach - 0.15) return { kind: 'chest' };
  if (near(RULES.forge) <= RULES.forge.reach - 0.15) return { kind: 'forge' };
  if (near(RULES.fire) <= RULES.fire.reach - 0.15) return { kind: 'fire' };
  return null;
}

function setTarget(t) {
  let label = '';
  if (t) {
    if (t.kind === 'loot') label = 'Aufheben';
    else if (t.kind === 'forge') label = itemState.craftMode === 'forge' ? 'Schließen' : 'Schmieden';
    else if (t.kind === 'fire') label = itemState.craftMode === 'fire' ? 'Schließen' : 'Am Feuer';
    else label = itemState.chestOpen ? 'Truhe schließen' : 'Truhe öffnen';
  }
  itemState.target = t;
  if (itemsUi.useLabel.textContent !== label) itemsUi.useLabel.textContent = label;
  itemsUi.use.hidden = !t;
}

function useNearest() {
  const t = itemState.target;
  const now = performance.now();
  if (!t || now < itemState.useBlockedUntil) return;
  itemState.useBlockedUntil = now + 350;
  if (t.kind === 'loot') sendMsg({ t: 'pick', id: t.pile.id });
  else if (t.kind === 'forge' || t.kind === 'fire') {
    if (itemState.craftMode === t.kind) closeCraft();
    else openCraft(t.kind);
  }
  else if (itemState.chestOpen) closeChest();
  else sendMsg({ t: 'chest', op: 'open' });
}

// ===========================================================================
//  Schmiede und Lagerfeuer: ein gemeinsames Menü
// ===========================================================================
const CRAFT_HINT = {
  forge: 'Zutaten kommen aus deiner Tasche. Geschmiedete Waffen trägst du bei dir.',
  fire: 'Rohes Fleisch wird am Feuer gegrillt. Gegrilltes heilt doppelt so viel.',
};

function openCraft(mode) {
  if (itemState.craftMode === mode) return;
  closeChest();
  toggleBag(false);
  if (!hud.stats.hidden) toggleStats();
  itemState.craftMode = mode;
  itemsUi.craft.hidden = false;
  document.body.classList.add('chest-open');
  renderCraft(true);
}

function closeCraft() {
  if (!itemState.craftMode) return;
  itemState.craftMode = '';
  itemsUi.craft.hidden = true;
  if (!itemState.chestOpen) document.body.classList.remove('chest-open');
  setTarget(itemState.target);      // Knopf-Beschriftung zurücksetzen
}

function craftButton(label, onClick, enabled = true) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.disabled = !enabled;
  btn.addEventListener('click', onClick);
  return btn;
}

function renderCraft(force) {
  if (!itemState.craftMode) return;
  const inv = me.self.inv || {};
  const mode = itemState.craftMode;
  const key = mode + JSON.stringify(inv);
  if (!force && key === itemState.craftKey) return;
  itemState.craftKey = key;
  itemsUi.craftTitle.textContent = mode === 'forge' ? 'Schmiede' : 'Lagerfeuer';
  itemsUi.craftNote.textContent = CRAFT_HINT[mode];
  clearEl(itemsUi.craftList);

  if (mode === 'forge') {
    for (const r of Object.keys(RULES.craft)) {
      const cost = RULES.craft[r];
      const row = document.createElement('div');
      row.className = 'item';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = RULES.weapons[r] || (RULES.items[r] ? RULES.items[r].name : r);
      const costText = document.createElement('span');
      costText.className = 'cost';
      costText.textContent = listItems(cost);
      const ok = Object.keys(cost).every((k) => (inv[k] || 0) >= cost[k]);
      row.appendChild(name);
      row.appendChild(costText);
      row.appendChild(craftButton('Schmieden', () => sendMsg({ t: 'craft', r }), ok));
      itemsUi.craftList.appendChild(row);
    }
  } else {
    const meat = inv.meat || 0;
    const row = document.createElement('div');
    row.className = 'item';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${meat} × Wildfleisch`;
    const info = document.createElement('span');
    info.className = 'cost';
    info.textContent = 'roh';
    row.appendChild(name);
    row.appendChild(info);
    row.appendChild(craftButton('Eins grillen', () => sendMsg({ t: 'cook', k: 'meat', n: 1 }), meat > 0));
    row.appendChild(craftButton('Alle grillen', () => sendMsg({ t: 'cook', k: 'meat' }), meat > 0));
    itemsUi.craftList.appendChild(row);
  }
}

// Zusatzknopf in einer Tasche-Zeile (Essen, Anlegen)
function addRowButton(row, label, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  row.insertBefore(btn, row.lastChild);
}

// ===========================================================================
//  Tasche
// ===========================================================================
function toggleBag(force) {
  const open = force === undefined ? itemsUi.bag.hidden : !!force;
  if (open && !hud.stats.hidden) toggleStats();   // nur eine Tafel zur Zeit
  itemsUi.bag.hidden = !open;
  itemsUi.bagBtn.setAttribute('aria-expanded', String(open));
  if (open) renderBag(true);
}

function itemRow(k, n, op, label) {
  const row = document.createElement('div');
  row.className = 'item';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = `${n} × ${RULES.items[k] ? RULES.items[k].name : k}`;
  const weight = document.createElement('span');
  weight.className = 'kg';
  weight.textContent = `${fmtKg((RULES.items[k] ? RULES.items[k].kg : 0) * n)} kg`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.dataset.op = op;
  btn.dataset.k = k;
  btn.addEventListener('click', () => itemAction(op, k));
  row.appendChild(name);
  row.appendChild(weight);
  row.appendChild(btn);
  return row;
}

function itemAction(op, k) {
  if (op === 'drop') sendMsg({ t: 'drop', k });
  else if (op === 'eat') sendMsg({ t: 'eat', k });
  else if (op === 'wield') sendMsg({ t: 'weapon', w: k });
  else sendMsg({ t: 'chest', op, k });
}

function emptyNote(text) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  return p;
}

function loadLine() {
  const s = me.self;
  return `${fmtKg(s.load || 0)} / ${fmtKg(s.cap || 0)} kg`;
}

function renderBag(force) {
  const s = me.self;
  const key = JSON.stringify(s.inv || {}) + (s.cap || 0);
  if (!force && (itemsUi.bag.hidden || key === itemState.bagKey)) return;
  itemState.bagKey = key;
  itemsUi.bagLoad.textContent = `Last ${loadLine()}`;
  itemsUi.bagBar.style.width = `${Math.round(clamp((s.load || 0) / Math.max(s.cap || 1, 1), 0, 1) * 100)}%`;
  itemsUi.bagBar.classList.toggle('over', (s.spd ?? 1) < 1);
  clearEl(itemsUi.bagList);
  const keys = sortedKeys(s.inv || {});
  if (!keys.length) itemsUi.bagList.appendChild(emptyNote('Deine Tasche ist leer. Besiegte Tiere lassen Beute fallen.'));
  for (const k of keys) {
    const row = itemRow(k, s.inv[k], 'drop', 'Ablegen');
    if (RULES.food[k]) addRowButton(row, 'Essen', () => itemAction('eat', k));
    if (RULES.weapons[k]) addRowButton(row, 'Anlegen', () => itemAction('wield', k));   // geschmiedete Waffe
    itemsUi.bagList.appendChild(row);
  }
}

// Last-Balken unter Leben und Mana
function refreshLoad() {
  const s = me.self;
  const cap = s.cap || 0, load = s.load || 0;
  itemsUi.loadBar.style.width = `${Math.round(clamp(load / Math.max(cap, 1), 0, 1) * 100)}%`;
  itemsUi.loadBar.classList.toggle('over', (s.spd ?? 1) < 1);
  itemsUi.loadText.textContent = `${fmtKg(load)} / ${Math.round(cap)}`;
  renderBag(false);
  renderChest(false);
  renderCraft(false);
}

// ===========================================================================
//  Truhe
// ===========================================================================
function openChest(items) {
  itemState.chestItems = items || {};
  if (!itemState.chestOpen) {
    itemState.chestOpen = true;
    closeCraft();
    toggleBag(false);
    if (!hud.stats.hidden) toggleStats();
    itemsUi.chest.hidden = false;
    document.body.classList.add('chest-open');
  }
  renderChest(true);
}

function closeChest() {
  if (!itemState.chestOpen) return;
  itemState.chestOpen = false;
  itemsUi.chest.hidden = true;
  if (!itemState.craftMode) document.body.classList.remove('chest-open');
}

function renderChest(force) {
  if (!itemState.chestOpen) return;
  const inv = me.self.inv || {}, chest = itemState.chestItems;
  const key = JSON.stringify(inv) + JSON.stringify(chest);
  if (!force && key === itemState.chestKey) return;
  itemState.chestKey = key;
  itemsUi.chestLoad.textContent = `In deiner Tasche · ${loadLine()}`;
  clearEl(itemsUi.chestList);
  clearEl(itemsUi.chestBag);
  const inChest = sortedKeys(chest), inBag = sortedKeys(inv);
  if (!inChest.length) itemsUi.chestList.appendChild(emptyNote('Die Truhe ist leer.'));
  for (const k of inChest) itemsUi.chestList.appendChild(itemRow(k, chest[k], 'take', 'Nehmen'));
  if (!inBag.length) itemsUi.chestBag.appendChild(emptyNote('Nichts zum Einlagern.'));
  for (const k of inBag) itemsUi.chestBag.appendChild(itemRow(k, inv[k], 'store', 'Einlagern'));
}

// ===========================================================================
//  Nachrichten vom Server
// ===========================================================================
function onItemMessage(msg) {
  switch (msg.t) {
    case 'loot': addPile(msg.l); return true;
    case 'unloot': removePile(msg.id); return true;
    case 'chest': openChest(msg.items); return true;
  }
  return false;
}

// Zusätze in "you": Aufgehobenes, Abgelegtes, Hinweise, Tempo bei Überlast
function onItemNotes(msg) {
  if (msg.got) log(`Du hebst ${listItems(msg.got)} auf.`);
  if (msg.dropped) log(`Du legst ${listItems(msg.dropped)} ab.`);
  switch (msg.note) {
    case 'far': log('Das ist zu weit weg.'); break;
    case 'gone': log('Die Beute ist schon weg.'); break;
    case 'reserved': log(`Diese Beute gehört noch ${msg.wait} Sekunden dem Sieger.`); break;
    case 'chestfar': log('Die Truhe ist zu weit weg.'); closeChest(); break;
    case 'forgefar': log('Die Schmiede ist zu weit weg.'); closeCraft(); break;
    case 'firefar': log('Das Lagerfeuer ist zu weit weg.'); closeCraft(); break;
    case 'missing': log('Dir fehlen die Zutaten.'); break;
  }
  if (msg.crafted) log(`Du schmiedest ${listItems(msg.crafted)}.`);
  if (msg.cooked) log(`Du grillst ${listItems(msg.cooked)}.`);
  if (msg.ate) log(msg.ate === 'grilled_meat' ? 'Du isst das gegrillte Fleisch.' : 'Du isst das rohe Fleisch. Besser wäre es gegrillt.');
  const spd = msg.self.spd ?? 1;
  if (spd !== itemState.spd) {
    if (spd === 0) log('Du trägst zu viel und kommst nicht mehr vom Fleck. Leg etwas ab.');
    else if (spd < 1 && itemState.spd === 1) log('Du trägst schwer und wirst langsamer.');
    else if (spd === 1) log('Deine Last ist wieder gut zu tragen.');
    itemState.spd = spd;
  }
}

function resetItems() {             // Abmelden oder Verbindung weg
  clearPiles();
  closeChest();
  closeCraft();
  toggleBag(false);
  setTarget(null);
  itemState.spd = 1;
}

// ===========================================================================
//  Im Takt der Spielschleife
// ===========================================================================
function updateItems(dt) {
  if (typeof refreshAdmin === 'function') refreshAdmin();
  for (const pile of lootPiles.values()) {
    animateLoot(pile.model, pile.x, pile.z, dt);
    const free = canTake(pile);
    if (free !== pile.free) {
      pile.free = free;
      setLootFree(pile.model, free);
    }
  }
  if (itemState.chestOpen
      && (me.ko || !isOnline() || Math.hypot(RULES.chest.x - me.x, RULES.chest.z - me.z) > RULES.chest.reach + 0.5)) {
    closeChest();                   // weggegangen: Truhe zu
  }
  if (itemState.craftMode) {
    const at = RULES[itemState.craftMode];
    if (me.ko || !isOnline() || Math.hypot(at.x - me.x, at.z - me.z) > at.reach + 0.5) closeCraft();
  }
  animateVillage(performance.now() / 1000);
  const t = findTarget();
  const old = itemState.target;
  const same = (!t && !old) || (t && old && t.kind === old.kind && (t.kind !== 'loot' || t.pile === old.pile));
  if (!same || (t && t.kind !== 'loot')) setTarget(t);
}

// ---- Bedienung ----
function bindTap(btn, fn) {
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); });
  btn.addEventListener('click', (e) => { if (e.detail === 0) fn(); });   // Enter-Taste
}
bindTap(itemsUi.use, useNearest);
itemsUi.bagBtn.addEventListener('click', () => toggleBag());
itemsUi.chestClose.addEventListener('click', closeChest);
itemsUi.craftClose.addEventListener('click', closeCraft);
