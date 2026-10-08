# D40

Ein Browser-MMORPG für Smartphones, inspiriert von »Die vierte Offenbarung« (D4O).
Low-Poly-3D mit Three.js, Echtzeit-Mehrspieler über WebSockets, Server in Node.js.

## Stand: Schritt 3 – Anmeldung und Speichern

- **Schritt 1:** Mehrere Spieler sehen sich gegenseitig, der Server prüft jede Bewegung.
- **Schritt 2:** Tiere (Hase, Wolf, Keiler), Kampf mit Schwert, Dolch, Bogen und zwei Zaubern,
  Lernen durch Tun, Ausweichen, K.O. statt Tod.
- **Schritt 3:** Anmeldung mit Name und Passwort, beim ersten Mal entsteht der Charakter.
  Das Gerät merkt sich die Anmeldung. Gespeichert werden Ort, Attribute, Leben, Mana und
  Waffe – alle 30 Sekunden, beim Verlassen und vor jedem Neustart des Servers.
  Die Werte-Tafel zeigt die Summe aller Attribute (Grundlage der späteren Wiedergeburts-Quest).

## Steuerung

- Handy: Joystick links, rechts wischen dreht die Kamera, Knöpfe rechts für Angriff,
  Waffe, Zauber und Heilen. „Werte“ oben rechts öffnet die Tafel mit dem Abmelde-Knopf.
- PC: WASD laufen, Maus ziehen dreht die Kamera, Mausrad zoomt,
  Leertaste angreifen, Q Waffe, E Zauber, R heilen, C Werte.

## Betrieb (Render und Neon)

Das Spiel läuft auf **Render** (Build `npm install`, Start `npm start`).
Gespeichert wird in einer Postgres-Datenbank bei **Neon**. Beide arbeiten zusammen:
Render führt den Server aus, Neon ist sein Gedächtnis.

Der Server liest die Adresse der Datenbank aus der Umgebungsvariable `DATABASE_URL`
(bei Render unter **Environment**). Die Adresse enthält das Datenbank-Passwort:
Sie gehört nie ins Repository und in keinen Chat.

Ohne `DATABASE_URL` läuft das Spiel trotzdem, speichert aber nur im Arbeitsspeicher –
nach einem Neustart ist alles weg. Ein zusätzliches Paket ist nicht nötig: Der Server
spricht Neon über dessen HTTP-Schnittstelle an.

Ob das Speichern funktioniert, zeigt die Seite **/status**
(zum Beispiel `https://<dein-dienst>.onrender.com/status`).

## Starten am eigenen Rechner (Node.js 18 oder neuer)

```bash
npm install
npm start
```

Dann im Browser `http://localhost:3000` öffnen.

Zum Testen mit mehreren Spielern braucht jeder Spieler einen eigenen Charakter.
Das Gerät merkt sich die Anmeldung pro Browser. Ein zweiter Tab im selben Browser
meldet denselben Charakter an und wirft den ersten hinaus. Für einen zweiten Spieler
dient deshalb ein privates Fenster oder ein anderer Browser mit einem anderen Namen.

## Tests

```bash
npm test
```

Startet den echten Server und spielt mit echten und simulierten Clients durch:
Kampf, Lernen, Anmeldung, Speichern, Neustart und Datenbank-Aussetzer.
Eine echte Datenbank ist dafür nicht nötig.

## Projektstruktur

```
client/index.html   Aussehen, Bedienelemente, Anmeldeformular, Spielschleife
client/world.js     Welt, Landschaft, Figuren und Tiere
client/net.js       Steuerung, Netzwerk und Anmeldung
client/combat.js    Kampf, Anzeigen, Werte-Tafel, Effekte
server/index.js     Spielserver: Anmeldung, Bewegung, Kampf, Tiere, Speichertakt
server/store.js     Speicher: Konten, Charaktere, Passwörter (scrypt), Datenbank
test/               Automatische Tests für Server, Datenbank und Client
```
