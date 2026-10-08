#!/usr/bin/env node
'use strict';
// Gibt einem Konto Administrator-Rechte, oder nimmt sie mit --weg wieder weg.
// Läuft nur auf deinem Rechner, mit der Datenbank-Adresse aus DATABASE_URL, z. B.:
//   DATABASE_URL="postgresql://…" node server/make-admin.js Mira
//   DATABASE_URL="postgresql://…" node server/make-admin.js Mira --weg
const { createStore, checkName } = require('./store');

const [, , rawName, flag] = process.argv;
const n = checkName(rawName || '');
if (!n.ok) {
  console.error(n.error || 'Bitte einen Namen angeben: node server/make-admin.js <Name>');
  process.exit(1);
}
(async () => {
  const db = createStore(process.env.DATABASE_URL);
  if (db.configError) {
    console.error(db.configError);
    process.exit(1);
  }
  const acc = await db.findAccount(n.key);
  if (!acc) {
    console.error(`Den Spieler „${n.name}“ gibt es nicht. Lege ihn zuerst im Spiel an.`);
    process.exit(1);
  }
  const admin = flag !== '--weg';
  await db.setAccountFlags(n.key, { admin });
  console.log(`${acc.name} ist jetzt ${admin ? 'Administrator' : 'kein Administrator mehr'}.`);
  process.exit(0);
})().catch((err) => {
  console.error('Fehlgeschlagen:', (err && err.message) || err);
  process.exit(1);
});
