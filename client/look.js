'use strict';
// ===========================================================================
//  D40 – Client: Aussehen wählen
//  Geschlecht, Hautton, Haarfarbe, Frisur, Bart. Während das Panel offen ist,
//  schaut die Kamera wie ein Spiegel auf die eigene Figur. Der Server prüft,
//  speichert und gibt das Aussehen an alle weiter.
// ===========================================================================

const lookUi = {
  btn: document.getElementById('look-btn'),
  panel: document.getElementById('look'),
  sex: document.getElementById('look-sex'),
  skin: document.getElementById('look-skin'),
  hair: document.getElementById('look-hair'),
  style: document.getElementById('look-style'),
  beard: document.getElementById('look-beard'),
  beardRow: document.getElementById('look-beard-row'),
  close: document.getElementById('look-close'),
};
const lookState = { open: false, cam: null };
const SKIN_NAMES = ['Sehr hell', 'Hell', 'Mittel', 'Dunkel', 'Sehr dunkel'];
const HAIR_NAMES = ['Schwarz', 'Dunkelbraun', 'Braun', 'Blond', 'Rot', 'Grau'];

const currentLook = () => normLook(me.look);

function sendLook(change) {
  const look = normLook({ ...currentLook(), ...change });
  sendMsg({ t: 'look', look });
}

function lookOption(label, pressed, onClick, swatch) {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('aria-pressed', String(pressed));
  if (swatch !== undefined) {
    b.className = 'swatch';
    b.style.background = `#${swatch.toString(16).padStart(6, '0')}`;
    b.setAttribute('aria-label', label);
    b.title = label;
  } else {
    b.textContent = label;
  }
  b.addEventListener('click', onClick);
  return b;
}

function renderLook() {
  const L = currentLook();
  for (const el of [lookUi.sex, lookUi.skin, lookUi.hair, lookUi.style, lookUi.beard]) clearEl(el);
  lookUi.sex.appendChild(lookOption('Mann', L.sex === 'm', () => sendLook({ sex: 'm' })));
  lookUi.sex.appendChild(lookOption('Frau', L.sex === 'f', () => sendLook({ sex: 'f' })));
  LOOK_SKIN.forEach((hex, i) => lookUi.skin.appendChild(lookOption(SKIN_NAMES[i], L.skin === i, () => sendLook({ skin: i }), hex)));
  LOOK_HAIR.forEach((hex, i) => lookUi.hair.appendChild(lookOption(HAIR_NAMES[i], L.hair === i, () => sendLook({ hair: i }), hex)));
  LOOK_STYLES[L.sex].forEach((name, i) => lookUi.style.appendChild(lookOption(name, L.style === i, () => sendLook({ style: i }))));
  lookUi.beard.appendChild(lookOption('Ohne', !L.beard, () => sendLook({ beard: 0 })));
  lookUi.beard.appendChild(lookOption('Mit', !!L.beard, () => sendLook({ beard: 1 })));
  lookUi.beardRow.hidden = L.sex !== 'm';
}

function openLook(open) {
  if (open === lookState.open) return;
  lookState.open = open;
  lookUi.panel.hidden = !open;
  document.body.classList.toggle('look-open', open);   // Joystick und Tastenleiste weg, damit nichts das Panel verdeckt
  if (me.model) me.model.userData.tag.visible = !open;
  if (open) {
    if (!hud.stats.hidden) toggleStats();
    toggleBag(false);
    closeChest();
    closeCraft();
    lookState.cam = { yaw: camYaw, pitch: camPitch, dist: camDist };
    camYaw = me.ry;                 // Kamera vor die Figur: ein Spiegel
    camPitch = 0.16;
    camDist = 4.2;
    renderLook();
  } else if (lookState.cam) {
    camYaw = lookState.cam.yaw;
    camPitch = lookState.cam.pitch;
    camDist = lookState.cam.dist;
    lookState.cam = null;
  }
}

// Vom Server bestätigt (net.js ruft das auf, wenn sich das eigene Aussehen ändert)
function onOwnLook() {
  if (!lookState.open) return;
  renderLook();
  if (me.model) me.model.userData.tag.visible = false;
}

lookUi.btn.addEventListener('click', () => openLook(true));
lookUi.close.addEventListener('click', () => openLook(false));
