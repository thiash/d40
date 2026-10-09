# D40

Ein Browser-MMORPG für Smartphones, inspiriert von »Die vierte Offenbarung« (D4O).
Low-Poly-3D mit Three.js, Echtzeit-Mehrspieler über WebSockets, Server in Node.js.

## Stand: Schritt 4 – Beute, Tasche und Truhe

- **Schritt 1:** Mehrere Spieler sehen sich gegenseitig, der Server prüft jede Bewegung.
- **Schritt 2:** Tiere (Hase, Wolf, Keiler), Kampf mit Schwert, Dolch, Bogen und zwei Zaubern,
  Lernen durch Tun, Ausweichen, K.O. statt Tod.
- **Schritt 3:** Anmeldung mit Name und Passwort, beim ersten Mal entsteht der Charakter.
  Das Gerät merkt sich die Anmeldung. Gespeichert werden Ort, Attribute, Leben, Mana und
  Waffe – alle 30 Sekunden, beim Verlassen und vor jedem Neustart des Servers.
  Die Werte-Tafel zeigt die Summe aller Attribute (Grundlage der späteren Wiedergeburts-Quest).
- **Schritt 4:** Besiegte Tiere lassen Beute fallen (Fell, Schwarte, Zähne, Hauer, Wildfleisch).
  Sie liegt als Sack am Boden und gehört 30 Sekunden lang nur dem Sieger, danach jedem.
  Alles hat ein Gewicht. Die Tragkraft kommt zu ⅔ aus Stärke und zu ⅓ aus Ausdauer
  (40 kg bei Startwerten, ohne Obergrenze). Wer mehr trägt, wird langsamer, ab dem
  Anderthalbfachen geht nichts mehr. Abgelegtes gehört sofort allen. In der Mitte des
  Startplatzes steht eine Truhe, die jeder Charakter für sich nutzt – ihr Inhalt
  übersteht später auch die Wiedergeburt. Tasche und Truhe werden gespeichert.
- **Dorf:** In der Schmiede entstehen aus Beute neue Waffen (Eisenschwert, Eisendolch,
  Langbogen). Schmieden dauert drei Sekunden; wer sich vorher entfernt, bricht ab und
  behält seine Zutaten. Am Lagerfeuer wird Wildfleisch gegrillt – gegrillt heilt es doppelt.

### Figuren

Die Gestaltung folgt einer Recherche zu The 4th Coming (Die 4. Offenbarung), vergleichbaren
Online-Rollenspielen und Spielermeinungen aus Foren: Spieler wollen sich unterscheiden
(„alle sahen gleich aus“ war die Kritik am Original), Gesichter sollen lebendig statt
puppenhaft wirken, und die Figur muss auch aus der Entfernung auf dem Tablet lesbar sein.

- **Kopf** modelliert statt rund: Stirn, Brauenbogen, Augenhöhlen, Nase, Wangenknochen,
  Lippen, Kinn, Kieferkante. Frauen: kein Brauenwulst, kürzeres Untergesicht, spitzeres
  Kinn, schmaler Kiefer. Je Geschlecht vier Gesichter (Mann: Klassisch, Kantig, Weich,
  Markant; Frau: Klassisch, Zart, Rund, Markant). Der Kopf ist 6 % größer als echt.
- **Augen**: Iris in fünf Farben, Pupille, Glanzpunkt, Lidschatten; das Oberlid deckt die
  Iris oben knapp ab (sonst wirkt der Blick starr). Kleine Blicksprünge, Blinzeln alle
  2–7 Sekunden und bei schnellen Drehungen.
- **Haare** als Kappe entlang der Kopfform mit dunklerem Ansatz, darauf Strähnen-Büschel für
  eine lebendige Silhouette. Mann: Kurz, Zopf, Lang, Glatze (Haarkranz), Strubbel. Frau:
  Lang, Pferdeschwanz, Dutt, Bob, Zöpfe. Bart: Ohne, Vollbart, Kinnbart, Stoppeln.
- **Körper** mit Muskelformen, Statur Schlank/Normal/Kräftig, etwas größere Hände; im Stand
  ruht das Gewicht auf einem Bein. Fünf Hauttöne, sechs Haarfarben. Ein Lichtsaum am Rand
  hebt die Figur vom Hintergrund ab. Wer einen Bogen trägt, hat einen Köcher an der Hüfte.

Das Geschlecht wählt man beim Anlegen, alles andere unter **Werte → Aussehen ändern**. Der
Server prüft und speichert das Aussehen und gibt es an alle weiter.

Bewegungen: Atmen und Gewicht verlagern im Stand, Gehen und Rennen (fließend je nach Tempo),
Schwerthieb mit Ausholen über die Schulter, Dolchstich mit Ausfallschritt, Bogen spannen mit
Pfeil und Sehne an der Hand, Zauber mit offener Hand, kurzer Ruck bei Treffern, Fallen bei
Bewusstlosigkeit. Schwert und Dolch liegen in der rechten Hand, der Bogen in der linken.

## Steuerung

- Handy: Joystick links, rechts wischen dreht die Kamera, Knöpfe rechts für Angriff,
  Waffe, Zauber und Heilen. Steht man bei Beute oder an der Truhe, erscheint darüber
  der Knopf „Aufheben“ bzw. „Truhe öffnen“. Oben rechts öffnen „Tasche“ und „Werte“
  ihre Tafeln, in der Werte-Tafel steht der Abmelde-Knopf.
- PC: WASD laufen, Maus ziehen dreht die Kamera, Mausrad zoomt,
  Leertaste angreifen, Q Waffe, E Zauber, R heilen, F aufheben / Truhe, I Tasche, C Werte.

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

## Administrator

Die Verwaltung erscheint oben rechts, wenn ein Charakter Administrator ist. Admins bestimmt
die Umgebungsvariable `ADMIN_NAMES` (bei Render unter **Environment**), mit Komma getrennte
Charakternamen, zum Beispiel `Creator`. Gleichgültig ob Groß- oder Kleinschreibung.
Den Charakter legt man ganz normal im Spiel an. Wird der Name aus der Liste entfernt,
verliert er die Rechte beim nächsten Anmelden.

Jede Verwaltungs-Aktion (Gegenstand geben, sperren, sichtbar/unsichtbar) steht im
Protokoll. Es liegt in der Datenbank (Tabelle `d40_admin_log`) und bleibt über Neustarts
erhalten; die Verwaltung zeigt die letzten 50 Einträge.

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
Kampf, Lernen, Anmeldung, Speichern, Neustart, Datenbank-Aussetzer, Beute, Gewicht und Truhe.
Eine echte Datenbank ist dafür nicht nötig.

## Projektstruktur

```
client/index.html   Aussehen, Bedienelemente, Anmeldeformular, Spielschleife
client/world.js     Welt, Landschaft, Namensschilder, Tiere, Beutesäcke und Truhe
client/character.js Spielfiguren: Körper, Gesicht, Haare, Kleidung, Waffen, Animation
client/look.js      Aussehen wählen
client/net.js       Steuerung, Netzwerk und Anmeldung
client/combat.js    Kampf, Anzeigen, Werte-Tafel, Effekte
client/items.js     Beute, Tasche, Truhe, Last-Anzeige
server/index.js     Spielserver: Anmeldung, Bewegung, Kampf, Tiere, Beute, Truhe, Speichertakt
server/store.js     Speicher: Konten, Charaktere, Passwörter (scrypt), Datenbank
test/               Automatische Tests für Server, Datenbank und Client
```
