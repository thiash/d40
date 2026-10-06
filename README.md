# D40

Ein Browser-MMORPG für Smartphones, inspiriert von »Die vierte Offenbarung« (D4O).
Low-Poly-3D mit Three.js, Echtzeit-Mehrspieler über WebSockets, Server in Node.js.

## Stand: Schritt 1 – Client und Server sprechen miteinander

- Mehrere Spieler sehen sich gegenseitig laufen und angreifen.
- Der Server ist autoritativ und prüft jede Bewegung (Schutz vor Speedhacks).
- Handy: Joystick links, rechts wischen dreht die Kamera, Siegel-Button greift an.
- PC: WASD laufen, Maus ziehen dreht die Kamera, Mausrad zoomt, Leertaste greift an.

## Starten

### Am eigenen Rechner (Node.js 18 oder neuer)

```bash
npm install
npm start
```

Dann im Browser `http://localhost:3000` öffnen. Zum Testen einfach ein zweites
Fenster öffnen – jedes Fenster ist ein eigener Spieler.
Ein Handy im selben WLAN erreicht das Spiel über `http://<IP-deines-Rechners>:3000`.

### Ohne Installation: GitHub Codespaces

1. Im Repository auf **Code → Codespaces → Create codespace on main**.
2. Im Terminal unten `npm install` und danach `npm start` eingeben.
3. Beim Hinweis zu Port 3000 auf **Open in Browser** klicken.
4. Damit andere mitspielen können: im Reiter **Ports** die Sichtbarkeit von
   Port 3000 auf **Public** stellen und den Link teilen.

## Projektstruktur

```
client/index.html   Spiel im Browser: Welt, Figuren, Steuerung, Netzwerk
server/index.js     Spielserver: liefert den Client aus, WebSocket, Bewegungsprüfung
```

## Nächste Schritte

- Gegner in der Testzone, Kampf mit Schadensberechnung auf dem Server
- Datenbank für Charaktere und Gegenstände
- Attribut-Training nach dem Prinzip »Learning by Doing«
