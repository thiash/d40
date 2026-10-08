'use strict';
// ===========================================================================
//  D40 – Client, Teil 5: Verwaltung der Administrator-Figur
//  Nur sichtbar, wenn der Server das Kennzeichen geschickt hat. Der Server prüft jede Aktion.
// ===========================================================================

const adminUi = {
  btn: document.getElementById('admin-btn'),
  panel: document.getElementById('admin'),
  name: document.getElementById('admin-name'),
  search: document.getElementById('admin-search'),
  logBtn: document.getElementById('admin-log-btn'),
  results: document.getElementById('admin-results'),
  item: document.getElementById('admin-item'),
  n: document.getElementById('admin-n'),
  give: document.getElementById('admin-give'),
  ban: document.getElementById('admin-ban'),
  vis: document.getElementById('admin-vis'),
  note: document.getElementById('admin-note'),
  close: document.getElementById('admin-close'),
};
const adminState = { picked: '', pickedBanned: false, filled: false };

function adminOpen(open) {
  if (open) {
    if (!adminState.filled) fillAdminItems();
    toggleBag(false);
    closeChest();
    closeCraft();
    if (!hud.stats.hidden) toggleStats();
  }
  adminUi.panel.hidden = !open;
  if (open) document.body.classList.add('chest-open');
  else if (!itemState.chestOpen && !itemState.craftMode) document.body.classList.remove('chest-open');
  refreshAdmin();
}

function fillAdminItems() {
  adminState.filled = true;
  for (const k of Object.keys(RULES.items)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = RULES.items[k].name;
    adminUi.item.appendChild(o);
  }
}

function refreshAdmin() {
  const self = me.self || {};
  adminUi.btn.hidden = !self.admin;
  if (!self.admin && !adminUi.panel.hidden) adminOpen(false);
  adminUi.vis.textContent = self.hidden ? 'Sichtbar machen' : 'Unsichtbar machen';
  adminUi.ban.textContent = adminState.pickedBanned ? 'Entsperren' : 'Sperren';
}

function sendAdmin(op, extra = {}) {
  sendMsg({ t: 'admin', op, ...extra });
}

function renderAdminResults(list) {
  clearEl(adminUi.results);
  if (!list.length) {
    adminUi.results.appendChild(emptyNote('Niemand gefunden.'));
    return;
  }
  for (const r of list) {
    const row = document.createElement('div');
    row.className = 'item';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = r.name;
    const status = document.createElement('span');
    status.className = 'kg';
    status.textContent = [r.online ? 'online' : 'offline', r.banned ? 'gesperrt' : ''].filter(Boolean).join(', ');
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.textContent = 'Auswählen';
    pick.addEventListener('click', () => {
      adminUi.name.value = r.name;
      adminState.picked = r.name;
      adminState.pickedBanned = !!r.banned;
      adminUi.note.textContent = `Ausgewählt: ${r.name}`;
      refreshAdmin();
    });
    row.appendChild(name);
    row.appendChild(status);
    row.appendChild(pick);
    adminUi.results.appendChild(row);
  }
}

// Antworten des Servers auf Verwaltungs-Befehle
function renderAdminLog(entries) {
  clearEl(adminUi.results);
  if (!entries.length) {
    adminUi.results.appendChild(emptyNote('Noch keine Aktionen seit dem letzten Neustart des Servers.'));
    return;
  }
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'item';
    const text = document.createElement('span');
    text.className = 'name';
    text.textContent = e.text;
    const when = document.createElement('span');
    when.className = 'kg';
    when.textContent = new Date(e.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    row.appendChild(text);
    row.appendChild(when);
    adminUi.results.appendChild(row);
  }
}

function onAdminMessage(msg) {
  if (msg.op === 'search') {
    renderAdminResults(msg.results || []);
    return true;
  }
  if (msg.op === 'log') {
    renderAdminLog(msg.entries || []);
    return true;
  }
  adminUi.note.textContent = msg.text || '';
  if (msg.text) log(msg.text);
  if (msg.op === 'ban' && msg.ok) {
    adminState.pickedBanned = !!msg.banned;
  }
  if (msg.op === 'visible' && msg.ok && me.self) {
    me.self.hidden = !!msg.hidden;
  }
  refreshAdmin();
  return true;
}

adminUi.btn.addEventListener('click', () => adminOpen(adminUi.panel.hidden));
adminUi.close.addEventListener('click', () => adminOpen(false));
adminUi.search.addEventListener('click', () => sendAdmin('search', { name: adminUi.name.value }));
adminUi.logBtn.addEventListener('click', () => sendAdmin('log'));
adminUi.give.addEventListener('click', () => {
  const n = Math.floor(Number(adminUi.n.value));
  if (!(n >= 1)) { adminUi.note.textContent = 'Bitte eine Anzahl von 1 oder mehr eingeben.'; return; }
  sendAdmin('give', { name: adminUi.name.value, k: adminUi.item.value, n });
});
adminUi.ban.addEventListener('click', () => {
  if (!adminUi.name.value.trim()) { adminUi.note.textContent = 'Wähle zuerst einen Spieler aus.'; return; }
  sendAdmin('ban', { name: adminUi.name.value, on: !adminState.pickedBanned });
});
adminUi.vis.addEventListener('click', () => sendAdmin('visible', { on: !!(me.self && me.self.hidden) }));
