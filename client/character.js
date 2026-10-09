'use strict';
// ===========================================================================
//  D40 – Client: Spielfiguren
//  Männlich oder weiblich, mit Skelett (Hüfte, Wirbelsäule, Brust, Hals, Kopf,
//  Schultern, Ellbogen, Hände, Knie, Füße), weichen Formen, Gesicht, Haaren,
//  Kleidung, Waffen in den Händen und einem Schatten am Boden.
//  Jeder Körperteil ist ein einziges Netz mit Farben je Eckpunkt – so bleibt die
//  Zahl der Zeichenaufrufe klein, auch auf dem Handy.
//  Blickrichtung der Figur: +z. Ihre rechte Seite: -x.
// ===========================================================================

// ---- Aussehen ----
const LOOK_SKIN = [0xf1d0b4, 0xdcae88, 0xc08a60, 0x93613f, 0x5f3d2a];
const LOOK_HAIR = [0x1d1814, 0x43291a, 0x7a4b28, 0xc9a35f, 0x8e3519, 0x9b968e];
const LOOK_STYLES = { m: ['Kurz', 'Zopf', 'Lang', 'Glatze', 'Strubbel'], f: ['Lang', 'Pferdeschwanz', 'Dutt', 'Bob', 'Zöpfe'] };
const LOOK_BEARDS = ['Ohne', 'Vollbart', 'Kinnbart', 'Stoppeln'];
const LOOK_BUILDS = ['Schlank', 'Normal', 'Kräftig'];
const LOOK_DEFAULT = { sex: 'm', skin: 1, hair: 1, style: 0, beard: 0, face: 0, build: 1 };

function normLook(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const int = (v, max, d) => (Number.isInteger(v) && v >= 0 && v <= max ? v : d);
  const sex = r.sex === 'f' ? 'f' : 'm';
  return {
    sex,
    skin: int(r.skin, LOOK_SKIN.length - 1, LOOK_DEFAULT.skin),
    hair: int(r.hair, LOOK_HAIR.length - 1, LOOK_DEFAULT.hair),
    style: int(r.style, 4, 0),
    beard: sex === 'm' ? int(r.beard, LOOK_BEARDS.length - 1, 0) : 0,
    face: int(r.face, 3, 0),
    build: int(r.build, LOOK_BUILDS.length - 1, 1),
  };
}

const CLOTH = {
  trousers: 0x3a332b,
  leather: 0x5b3c25,
  leatherDark: 0x3e281a,
  brass: 0xc29a45,
  lips: 0xa45a4c,
  white: 0xf4efe6,
  iris: 0x2f2a26,
};

// Ein Material für alle Figuren: die Farbe steckt in den Eckpunkten
const CHAR_MAT = new THREE.MeshPhongMaterial({
  vertexColors: true, shininess: 14, specular: 0x1c1a18, side: THREE.DoubleSide,
});
// Lichtsaum am Rand (hebt die Figur vom Hintergrund ab) und etwas wärmeres Umgebungslicht,
// damit Haut im Schatten nicht grünlich-grau wirkt
CHAR_MAT.onBeforeCompile = (shader) => {
  shader.fragmentShader = shader.fragmentShader.replace('#include <aomap_fragment>', `#include <aomap_fragment>
    {
      float rim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
      reflectedLight.indirectDiffuse *= vec3(1.07, 1.0, 0.93);
      reflectedLight.indirectDiffuse += diffuseColor.rgb * rim * vec3(0.32, 0.29, 0.24);
    }`);
};
const WEAPON_MATS = {
  steel:    new THREE.MeshPhongMaterial({ color: 0xc9d0d6, shininess: 70, specular: 0x8a8f94 }),
  iron:     new THREE.MeshPhongMaterial({ color: 0x5a636c, shininess: 45, specular: 0x50565c }),
  grip:     new THREE.MeshPhongMaterial({ color: 0x4a2f1c, shininess: 8 }),
  brass:    new THREE.MeshPhongMaterial({ color: 0xc29a45, shininess: 60, specular: 0x6a5530 }),
  wood:     new THREE.MeshPhongMaterial({ color: 0x8a6239, shininess: 20 }),
  darkwood: new THREE.MeshPhongMaterial({ color: 0x4a3420, shininess: 20 }),
  string:   new THREE.MeshBasicMaterial({ color: 0xe8dcc0 }),
  feather:  new THREE.MeshLambertMaterial({ color: 0xd8d0c0 }),
};
const SHADOW_MAT = new THREE.MeshBasicMaterial({
  color: 0x000000, transparent: true, opacity: 0.26, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});
const SHADOW_GEO = new THREE.CircleGeometry(0.42, 20).rotateX(-Math.PI / 2);

// ---------------------------------------------------------------------------
//  Formen
// ---------------------------------------------------------------------------
const V2 = (x, y) => new THREE.Vector2(x, y);
const gauss = (v, w) => Math.exp(-(v / w) * (v / w));
const sstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// weiches Maximum: rundet die Kante ab, an der zwei Flächen sich treffen
const smax = (a, b, k) => 0.5 * (a + b + Math.sqrt((a - b) * (a - b) + k * k));

// Lathe aus einem Profil [[radius, höhe], …], von unten nach oben; danach elliptisch skaliert
function lathe(profile, sx = 1, sz = 1, seg = 18) {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => V2(Math.max(r, 0.0001), y)), seg);
  g.scale(sx, 1, sz);
  g.computeVertexNormals();
  return g;
}

// Glied mit Muskelprofil: keys [[t, radius], …] mit t = 0 am Gelenk, 1 am Ende (y = -len)
function limbShape(len, keys, sx = 1, sz = 1, seg = 14, deform = null) {
  const pts = [];
  const r0 = keys[0][1], r1 = keys[keys.length - 1][1];
  for (let i = 0; i <= 3; i++) {                     // untere Rundung
    const a = -Math.PI / 2 + (i / 4) * (Math.PI / 2);
    pts.push([r1 * Math.cos(a), -len + r1 * Math.sin(a)]);
  }
  for (let i = keys.length - 1; i >= 0; i--) pts.push([keys[i][1], -keys[i][0] * len]);
  for (let i = 1; i <= 4; i++) {                     // obere Rundung
    const a = (i / 4) * (Math.PI / 2);
    pts.push([r0 * Math.cos(a), r0 * Math.sin(a)]);
  }
  const g = lathe(pts, sx, sz, seg);
  if (deform) {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const v = deform(pos.getX(i), pos.getY(i), pos.getZ(i), clamp(-pos.getY(i) / len, 0, 1));
      pos.setXYZ(i, v[0], v[1], v[2]);
    }
    g.computeVertexNormals();
  }
  return g;
}

// Zusätzliche Ringe an Farbkanten (Ärmel, Stiefel), damit die Kante scharf bleibt
function withCuts(keys, ts) {
  const out = keys.slice();
  for (const t of ts) {
    for (const e of [-0.006, 0.006]) {
      const tt = t + e;
      let i = 1;
      while (i < keys.length - 1 && keys[i][0] < tt) i++;
      const a = keys[i - 1], b = keys[i];
      out.push([tt, lerp(a[1], b[1], (tt - a[0]) / (b[0] - a[0]))]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// Glied mit gleichmäßiger Verjüngung (für Kleinteile)
function limbGeo(r1, r2, len, sx = 1, sz = 1, seg = 10) {
  return limbShape(len, [[0, r1], [1, r2]], sx, sz, seg);
}

function ellipsoid(rx, ry, rz, w = 12, h = 8) {
  const g = new THREE.SphereGeometry(1, w, h);
  g.scale(rx, ry, rz);
  g.computeVertexNormals();
  return g;
}

// Abgerundeter Quader (Superellipsoid)
function roundBox(rx, ry, rz, e = 3.2, w = 14, h = 10) {
  const g = new THREE.SphereGeometry(1, w, h);
  const pos = g.attributes.position;
  const f = (v) => Math.sign(v) * Math.pow(Math.abs(v), 2 / e);
  for (let i = 0; i < pos.count; i++) pos.setXYZ(i, f(pos.getX(i)) * rx, f(pos.getY(i)) * ry, f(pos.getZ(i)) * rz);
  g.computeVertexNormals();
  return g;
}

// Raster-Fläche: u läuft rundum (geschlossen), v von oben (0) nach unten (1).
// fn(u, v) liefert [x, y, z, farbe]. keep(a, b, c) kann Dreiecke weglassen.
function gridSurface(nu, nv, fn, keep = null) {
  const count = nu * (nv + 1);
  const position = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const c = new THREE.Color();
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i < nu; i++) {
      const o = j * nu + i;
      const p = fn(i / nu, j / nv);
      position[o * 3] = p[0]; position[o * 3 + 1] = p[1]; position[o * 3 + 2] = p[2];
      c.setHex(p[3]);
      color[o * 3] = c.r; color[o * 3 + 1] = c.g; color[o * 3 + 2] = c.b;
    }
  }
  const index = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * nu + i, b = j * nu + (i + 1) % nu;
      const cc = (j + 1) * nu + i, d = (j + 1) * nu + (i + 1) % nu;
      if (!keep || keep(a, cc, b)) index.push(a, cc, b);
      if (!keep || keep(b, cc, d)) index.push(b, cc, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

// Stützstellen gleichmäßig nach einer Dichte verteilen (mehr Punkte im Gesicht)
function warp(n, density) {
  const acc = [0];
  const steps = 400;
  for (let i = 1; i <= steps; i++) acc.push(acc[i - 1] + density((i - 0.5) / steps));
  const total = acc[steps];
  const out = [];
  for (let k = 0; k <= n; k++) {
    const target = (k / n) * total;
    let i = 1;
    while (i < steps && acc[i] < target) i++;
    const f = (target - acc[i - 1]) / Math.max(1e-9, acc[i] - acc[i - 1]);
    out.push((i - 1 + f) / steps);
  }
  return out;
}

// Linear zwischen Stützstellen [[x, y], …]
function piecewise(k, x) {
  if (x <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (x <= k[i][0]) return lerp(k[i - 1][1], k[i][1], smooth((x - k[i - 1][0]) / (k[i][0] - k[i - 1][0])));
  }
  return k[k.length - 1][1];
}

const M4 = () => new THREE.Matrix4();
function at(x, y, z, rx = 0, ry = 0, rz = 0, s = 1) {
  const m = M4();
  m.compose(new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(s, s, s));
  return m;
}

// Mehrere Formen zu einem Netz verschmelzen; Farbe fest, als Funktion des Orts
// oder (ohne Angabe) aus den Eckpunktfarben der Form selbst
function merge(parts) {
  const geos = parts.map((p) => {
    const g = p.geo.clone();
    if (p.m) g.applyMatrix4(p.m);
    if (p.deform) {
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const v = p.deform(pos.getX(i), pos.getY(i), pos.getZ(i));
        pos.setXYZ(i, v[0], v[1], v[2]);
      }
      g.computeVertexNormals();
    }
    return { g, color: p.color };
  });
  let total = 0, totalIdx = 0;
  for (const { g } of geos) {
    total += g.attributes.position.count;
    totalIdx += g.index ? g.index.count : g.attributes.position.count;
  }
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  const index = new (total > 65535 ? Uint32Array : Uint16Array)(totalIdx);
  const c = new THREE.Color();
  let o = 0, oi = 0;
  for (const { g, color: col } of geos) {
    const pos = g.attributes.position, nor = g.attributes.normal, own = g.attributes.color;
    const base = o;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      position[o * 3] = x; position[o * 3 + 1] = y; position[o * 3 + 2] = z;
      normal[o * 3] = nor.getX(i); normal[o * 3 + 1] = nor.getY(i); normal[o * 3 + 2] = nor.getZ(i);
      if (col === undefined && own) c.setRGB(own.getX(i), own.getY(i), own.getZ(i));
      else c.setHex(typeof col === 'function' ? col(x, y, z) : col);
      color[o * 3] = c.r; color[o * 3 + 1] = c.g; color[o * 3 + 2] = c.b;
      o++;
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) index[oi++] = base + g.index.getX(i);
    else for (let i = 0; i < pos.count; i++) index[oi++] = base + i;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  return out;
}

// Farbe abdunkeln oder aufhellen, und zwei Farben mischen
function shade(hex, f) {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * f));
  const b = Math.min(255, Math.round((hex & 255) * f));
  return (r << 16) | (g << 8) | b;
}
function mix(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const r = ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t;
  const g = ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t;
  const bl = (a & 255) + ((b & 255) - (a & 255)) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}

// ---------------------------------------------------------------------------
//  Kopf: modellierter Schädel statt Kugel.
//  Mitte des Kopfes = Augenhöhe. +z Gesicht, +y oben, x seitlich.
//  Grundform ist ein Superellipsoid (vorn flacher, hinten runder), darauf
//  werden Stirn, Brauenbogen, Augenhöhlen, Nase, Wangen, Mund, Kinn und
//  Kieferkante modelliert. Unten schneidet die Kieferunterseite weich ab.
// ---------------------------------------------------------------------------
// Grundmaße je Geschlecht. low staucht das Untergesicht (Nase, Mund) senkrecht –
// Frauengesichter wirken mit kürzerem Untergesicht, spitzerem Kinn, schmalem Kiefer
// und ohne Brauenwulst weiblicher (Augen–Mund ≈ 36 % der Gesichtslänge).
const FACE = {
  m: { s: 1, chinY: 0.124, low: 1, taper: 0.34, edge: 0.006, brow: 0.0085, socket: 0.016, nose: 1, bump: 0, alae: 1,
       upLip: 0.0042, lips: 0.85, chin: 1.0, chinW: 0.008, chinR: 0.019, jaw: 1, cheek: 1, bone: 1, maxilla: 0.012 },
  f: { s: 0.95, chinY: 0.111, low: 0.92, taper: 0.56, edge: 0.012, brow: 0, socket: 0.014, nose: 0.72, bump: 0, alae: 0.75,
       upLip: 0.0058, lips: 1.3, chin: 0.5, chinW: 0, chinR: 0.014, jaw: 0.2, cheek: 1.25, bone: 1.35, maxilla: 0.009 },
};
// Gesichtsvorlagen: Abweichungen von den Grundmaßen (Faktoren oder Zuschläge)
const LOOK_FACES = { m: ['Klassisch', 'Kantig', 'Weich', 'Markant'], f: ['Klassisch', 'Zart', 'Rund', 'Markant'] };
const FACE_PRESETS = {
  m: [
    {},
    { jaw: 1.7, chin: 1.25, chinW: 0.014, brow: 1.3, bone: 1.15, taper: 0.85, edge: 0.7 },
    { jaw: 0.55, cheek: 1.6, edge: 1.8, nose: 0.92, alae: 1.25, lips: 1.15, brow: 0.7, taper: 1.05 },
    { nose: 1.12, bump: 1, bone: 1.5, lips: 0.8, taper: 1.15, chin: 1.1, low: 1.03 },
  ],
  f: [
    {},
    { nose: 0.85, chin: 0.8, taper: 1.07, bone: 1.1, low: 0.97 },
    { cheek: 1.5, edge: 1.4, nose: 0.92, lips: 1.12, taper: 0.9, jaw: 1.5 },
    { nose: 1.12, bump: 0.6, bone: 1.45, lips: 0.92, taper: 1.04, chin: 1.15, low: 1.02 },
  ],
};
const EYE = { x: 0.0315, y: 0.0, r: 0.0118 };

function faceParams(sex, face) {
  const K = { ...FACE[sex] };
  const P = FACE_PRESETS[sex][face] || {};
  for (const k in P) {
    if (k === 'bump') K.bump = P.bump;
    else if (k === 'chinW') K.chinW = P.chinW;
    else K[k] *= P[k];
  }
  K.chinY *= P.low ? 0.5 + 0.5 * P.low : 1;
  return K;
}

function makeHead(sex, face) {
  const K = faceParams(sex, face);
  const s = K.s;
  const W = 0.0735, Ht = 0.118, Hb = 0.15, Df = 0.094, Db = 0.104;
  const nH = (dz) => 2.05 + 0.45 * sstep(-0.2, 0.5, dz);

  // Grundform in Richtung (dx, dy, dz): Strahl bis zur Fläche
  function base(dx, dy, dz) {
    const n = nH(dz);
    const ax = Math.abs(dx) / W, ay = Math.abs(dy) / (dy > 0 ? Ht : Hb), az = Math.abs(dz) / (dz > 0 ? Df : Db);
    // A·ρⁿ + B·ρ² = 1 (x und z haben denselben Exponenten) – mit dem Newton-Verfahren gelöst
    const A = Math.pow(ax, n) + Math.pow(az, n), Bq = ay * ay;
    let r = 1 / Math.max(1e-6, Math.sqrt(Math.pow(A, 2 / n) + Bq));
    for (let i = 0; i < 6; i++) {
      const rn = Math.pow(r, n - 1);
      const f = A * rn * r + Bq * r * r - 1, d = n * A * rn + 2 * Bq * r;
      r = Math.max(1e-4, r - f / d);
    }
    return [dx * r, dy * r, dz * r];
  }

  // Gesichtsrelief nach vorn (z) – in Kopfmaßen (ohne Skalierung)
  function relief(x, y) {
    const ax = Math.abs(x);
    const ly = y < 0 ? y / K.low : y;              // Untergesicht: Nase und Mund rücken näher an die Augen
    let d = 0;
    d += K.brow * gauss(y - 0.022, 0.011) * gauss(ax - 0.028, 0.026);            // Brauenbogen
    d += (K.brow ? 0.004 : 0.002) * gauss(y - 0.016, 0.01) * gauss(x, 0.012);     // Nasenwurzel
    d -= K.socket * gauss(y - EYE.y, 0.0165) * gauss(ax - EYE.x, 0.0175);          // Augenhöhlen
    // Nase: Rücken wird zur Spitze hin höher und breiter, darunter fällt sie steil ab
    let prof = 0, w = 0.008;
    if (ly <= 0.012 && ly >= -0.042) {
      const t = (0.012 - ly) / 0.054;
      prof = 0.0035 + 0.0275 * Math.pow(t, 1.35);
      w = 0.0068 + 0.0095 * t;
    } else if (ly < -0.042) {
      const t = clamp((-0.042 - ly) / 0.011, 0, 1);
      prof = lerp(0.031, 0.004, smooth(t));
      w = 0.0163 + 0.004 * t;
    }
    d += K.nose * prof * gauss(x, w);
    d += K.bump * 0.0045 * gauss(ly + 0.006, 0.008) * gauss(x, 0.0075);           // Höcker (Adlernase)
    d += 0.0085 * K.alae * gauss(ly + 0.046, 0.0075) * gauss(ax - 0.0165 * K.nose, 0.0068);   // Nasenflügel
    d += K.maxilla * gauss(ly + 0.07, 0.03) * gauss(x, 0.04);                    // Oberkiefer, Mundpartie
    d += K.upLip * K.lips * gauss(ly + 0.0638, 0.0052) * gauss(x, 0.02);          // Oberlippe
    d += 0.0052 * K.lips * gauss(ly + 0.0795, 0.0058) * gauss(x, 0.0175);         // Unterlippe
    d -= 0.0022 * gauss(ly + 0.0716, 0.0022) * gauss(x, 0.024);                   // Mundspalte
    d -= 0.0028 * gauss(ly + 0.0905, 0.0055) * gauss(x, 0.024);                   // Kinnfurche
    d += 0.022 * K.chin * gauss(y + K.chinY - 0.016, 0.016) * gauss(ax - K.chinW, K.chinR);   // Kinn
    d += 0.006 * K.cheek * gauss(y + 0.026, 0.026) * gauss(ax - 0.046, 0.02);     // Wangen
    d += 0.002 * gauss(ly + 0.058, 0.009) * gauss(ax - 0.028, 0.006);             // Mundwinkel-Wulst
    return d;
  }

  // Seitliches Relief (x, nach außen)
  function side(y, z) {
    let d = 0;
    d += 0.0055 * K.bone * gauss(y + 0.008, 0.016) * gauss(z - 0.046, 0.024);     // Wangenknochen
    d -= 0.004 * gauss(y - 0.04, 0.02) * gauss(z - 0.042, 0.03);                  // Schläfe
    d += 0.0075 * K.jaw * gauss(y + 0.078, 0.02) * gauss(z + 0.004, 0.028);       // Kieferwinkel
    d -= 0.002 * K.jaw * gauss(y + 0.05, 0.014) * gauss(z - 0.04, 0.02);          // Wange unter dem Knochen
    return d;
  }

  function point(dx, dy, dz) {
    let [x, y, z] = base(dx, dy, dz);
    // Unterkiefer läuft zum Kinn hin schmal zu
    const low = sstep(-0.03, -0.112, y);
    const front = sstep(-0.01, 0.07, z);
    x *= 1 - K.taper * low * (0.3 + 0.7 * front);
    // Kieferunterseite: weich abgeschnitten, vorn tief (Kinn), hinten hoch (Hals)
    const yu = lerp(-0.068, -K.chinY, sstep(-0.03, 0.074, z));
    y = smax(y, yu, K.edge);
    const wf = sstep(0.025, 0.07, z);
    if (wf > 0) z += wf * relief(x, y);
    x += Math.sign(x) * side(y, z);
    return [x * s, y * s, z * s];
  }

  // Fläche des Gesichts an (x, y) – zum Einpassen der Augen und Brauen
  function frontZ(x, y) {
    let lo = 0, hi = 0.2;
    const px = x / s, py = y / s;
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2;
      const n = nH(0.9);
      const v = Math.pow(Math.abs(px) / W, n) + (py / (py > 0 ? Ht : Hb)) ** 2 + Math.pow(m / Df, n);
      if (v > 1) hi = m; else lo = m;
    }
    return (lo + relief(px, py)) * s;
  }

  return { point, frontZ, s, W: W * s, Ht: Ht * s, Db: Db * s, K };
}

const HEAD_GRID = (() => {
  // dichter im Gesicht (vorn, um die Augenhöhe), lockerer am Hinterkopf
  const u = warp(96, (t) => { const a = Math.min(t, 1 - t); return 1 + 3.2 * gauss(a, 0.13); });
  const v = warp(64, (t) => 1 + 2.4 * gauss(t - 0.6, 0.17));
  return { u, v, nu: 96, nv: 64 };
})();
const HEAD_DIR = (u, v) => {
  const phi = u * Math.PI * 2, th = v * Math.PI;
  return [Math.sin(th) * Math.sin(phi), Math.cos(th), Math.sin(th) * Math.cos(phi)];
};
// Richtung aus Winkeln in Grad: phi um die Hochachse (0 vorn, + zur linken Seite der Figur), th von oben
const sph = (phi, th) => {
  const p = (phi * Math.PI) / 180, t = (th * Math.PI) / 180;
  return [Math.sin(t) * Math.sin(p), Math.cos(t), Math.sin(t) * Math.cos(p)];
};

// Haaransatz: Höhe über der Augenlinie je nach Winkel um den Kopf (0 = vorn).
// Etwas höher als zuvor – die Stirn ist ein Drittel des Gesichts.
const HAIRLINE = {
  m: [[0, 0.074], [0.5, 0.069], [0.95, 0.048], [1.22, 0.032], [1.36, -0.022], [1.5, -0.03], [1.6, 0.014], [1.95, 0.01], [2.25, -0.04], [2.65, -0.066], [Math.PI, -0.075]],
  f: [[0, 0.077], [0.5, 0.071], [0.95, 0.05], [1.22, 0.034], [1.38, 0.0], [1.5, -0.01], [1.62, 0.012], [1.95, 0.008], [2.25, -0.045], [2.65, -0.07], [Math.PI, -0.08]],
};

// Linie über den Winkel um den Kopf (0 = vorn, ±π hinten) als Tabelle – schnell abzufragen
function table(fn, n = 256) {
  const t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = fn((i / n) * Math.PI);
  const look = (arr) => (a) => {
    const f = Math.min(1, Math.abs(a) / Math.PI) * n;
    const i = Math.min(n - 1, Math.floor(f));
    return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
  };
  // Tiefst- und Höchstwert in einem Fenster von ±0,45 rad – damit weit entfernte Punkte schnell entschieden sind
  const w = Math.ceil((0.45 / Math.PI) * n);
  const lo = new Float32Array(n + 1), hi = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    let a = Infinity, b = -Infinity;
    for (let k = -w; k <= w; k++) {
      let j = i + k;
      if (j < 0) j = -j;
      if (j > n) j = 2 * n - j;
      a = Math.min(a, t[j]); b = Math.max(b, t[j]);
    }
    lo[i] = a; hi[i] = b;
  }
  const line = look(t);
  line.lo = look(lo);
  line.hi = look(hi);
  return line;
}

const HEAD_FN = {};
function headShape(sex, face) {
  const key = sex + face;
  if (!HEAD_FN[key]) HEAD_FN[key] = makeHead(sex, face);
  return HEAD_FN[key];
}

// Abstand eines Punkts zu einer Linie um den Kopf (Höhe je Winkel), quer zur Linie gemessen –
// so laufen auch steile Stellen (Koteletten, Schläfen) gleichmäßig weich aus
function lineDist(x, y, z, line, far = 0.04) {
  const phi = Math.atan2(x, z);
  if (line.lo) {                                   // weit über oder unter allen nahen Stellen der Linie
    if (y > line.hi(phi) + far) return far;
    if (y < line.lo(phi) - far) return -far;
  }
  const r = Math.max(0.03, Math.hypot(x, z));
  const l0 = line(phi);
  let best = Math.abs(y - l0);
  for (let k = 1; k <= 12; k++) {
    const da = k * 0.035;
    if (da * r > best) break;
    for (const sgn of [-1, 1]) {
      const d = Math.hypot(da * r, y - line(phi + sgn * da));
      if (d < best) best = d;
    }
  }
  return y >= l0 ? best : -best;
}

const HEAD_CACHE = new Map();
const SHAPE_CACHE = new Map();
function cached(key, fn) {
  if (!SHAPE_CACHE.has(key)) SHAPE_CACHE.set(key, fn());
  return SHAPE_CACHE.get(key);
}
function putColor(arr, i, hex) {
  arr[i * 3] = ((hex >> 16) & 255) / 255;
  arr[i * 3 + 1] = ((hex >> 8) & 255) / 255;
  arr[i * 3 + 2] = (hex & 255) / 255;
}
// Neue Geometrie mit denselben Eckpunkten, aber eigenen Farben
function withColors(g, col) {
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', g.attributes.position);
  out.setAttribute('normal', g.attributes.normal);
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(g.index);
  return out;
}
// Haarform färben: k = Deckung (0 Haut … 1 Haar), f = Helligkeit der Strähne
function recolor(shape, under, top, cover = 1) {
  const n = shape.k.length;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) putColor(col, i, mix(under, shade(top, shape.f[i]), shape.k[i] * cover));
  return withColors(shape.geo, col);
}
// Form der Kopfhaut (ohne Farben)
function headBase(sex, face, H) {
  return cached(`head|${sex}|${face}`, () => {
    const G = HEAD_GRID;
    return gridSurface(G.nu, G.nv, (u, v) => {
      const d = HEAD_DIR(G.u[Math.round(u * G.nu)], G.v[Math.round(v * G.nv)]);
      const p = H.point(d[0], d[1], d[2]);
      return [p[0], p[1], p[2], 0];
    });
  });
}
// Schicht über der Haut (Haare, Bart): an der Kopfform entlang nach außen versetzt.
// mask 0…1 bestimmt Dicke und Deckung; Dreiecke ohne Haar fallen weg.
// maskKey: die Maske hängt nur von Geschlecht und Frisur ab, nicht vom Gesicht – das Raster ist für
// alle Gesichter gleich. Sie wird deshalb einmal am Grundgesicht berechnet und wiederverwendet.
function maskFor(maskKey, sex, mask) {
  return cached(maskKey, () => {
    const H0 = headShape(sex, 0), b0 = headBase(sex, 0, H0), p0 = b0.attributes.position, s0 = H0.s;
    const m = new Float32Array(p0.count);
    for (let i = 0; i < p0.count; i++) m[i] = mask(p0.getX(i) / s0, p0.getY(i) / s0, p0.getZ(i) / s0);
    return m;
  });
}
function layerShape(base, s, mask, thick, maskKey, sex) {
  const G = HEAD_GRID;
  const hp = base.attributes.position, hn = base.attributes.normal;
  const n = hp.count;
  const m = maskKey ? maskFor(maskKey, sex, mask) : new Float32Array(n), f = new Float32Array(n);
  const g = gridSurface(G.nu, G.nv, (u, v) => {
    const i = Math.round(v * G.nv) * G.nu + Math.round(u * G.nu) % G.nu;
    const x = hp.getX(i), y = hp.getY(i), z = hp.getZ(i);
    const X = x / s, Y = y / s, Z = z / s;
    const k = maskKey ? m[i] : (m[i] = mask(X, Y, Z));
    const phi = Math.atan2(X, Z);
    // Strähnen, und zum Ansatz hin dunkler
    f[i] = (0.9 + 0.07 * Math.sin(phi * 61 + Y * 30) + 0.05 * Math.sin(phi * 23 - Y * 55)) * (0.8 + 0.2 * sstep(0.1, 0.7, k));
    const t = k > 0 ? 0.0004 + thick(X, Y, Z) * k * k : 0;
    return [x + hn.getX(i) * t, y + hn.getY(i) * t, z + hn.getZ(i) * t, 0];
  }, (a, b, c) => Math.min(m[a], m[b], m[c]) > 0.002);
  g.deleteAttribute('color');
  g.setAttribute('normal', new THREE.BufferAttribute(hn.array.slice(), 3));   // gleiche Beleuchtung wie die Haut darunter
  const k = m.map((v) => sstep(0.22, 0.85, v));     // Rand hautfarben, damit die Dreieckskante nicht auffällt
  return { geo: g, k, f };
}

// Haarbüschel: flaches, sich verjüngendes Band entlang eines Wegs über die Kopfhaut.
// way: Wegpunkte [phi, th, abstand] in Grad und Metern über der Haut. Die Büschel brechen
// die glatte Haarkappe auf – so liest sich die Frisur auch aus der Entfernung.
const HAIR_C0 = new THREE.Vector3(0, -0.01, -0.005);
function strandGeo(pts, w0, w1, flat, seg = 10, rad = 6) {
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = new THREE.TubeGeometry(curve, seg, 1, rad, false);
  const pos = g.attributes.position;
  const n = new THREE.Vector3(), d = new THREE.Vector3(), c = new THREE.Vector3();
  const ts = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.floor(i / (rad + 1)) / seg;
    ts[i] = t;
    curve.getPoint(t, c);
    n.copy(c).sub(HAIR_C0).normalize();
    d.set(pos.getX(i), pos.getY(i), pos.getZ(i)).sub(c);
    const along = d.dot(n);
    d.addScaledVector(n, -along);
    const w = lerp(w0, w1, Math.pow(t, 1.3));
    d.multiplyScalar(w).addScaledVector(n, along * w * flat);
    pos.setXYZ(i, c.x + d.x, c.y + d.y, c.z + d.z);
  }
  g.computeVertexNormals();
  return { g, ts };
}
function clumpShape(H, list) {
  const s = H.s;
  const geos = [], fs = [];
  let seed = 1;
  for (const cl of list) {
    const pts = cl.way.map(([phi, th, off]) => {
      const d = sph(phi, th);
      const p = H.point(d[0], d[1], d[2]);
      const v = new THREE.Vector3(p[0], p[1], p[2]);
      const nn = v.clone().sub(HAIR_C0.clone().multiplyScalar(s)).normalize();
      return v.addScaledVector(nn, off * s);
    });
    if (cl.end) pts.push(pts[pts.length - 1].clone().add(new THREE.Vector3(...cl.end).multiplyScalar(s)));
    const { g, ts } = strandGeo(pts, cl.w * s, cl.tip * cl.w * s, cl.flat);
    seed = (seed * 16807) % 2147483647;
    const lift = 0.94 + 0.12 * (seed / 2147483647);
    geos.push(g);
    for (const t of ts) fs.push((0.8 + 0.24 * Math.min(1, t * 1.6)) * lift);
  }
  const geo = merge(geos.map((g) => ({ geo: g, color: 0 })));
  geo.deleteAttribute('color');
  const f = Float32Array.from(fs);
  return { geo, f, k: new Float32Array(f.length).fill(1) };
}

// Zopf aus geflochtenen Gliedern entlang eines Wegs
function braidShape(pts, w) {
  const curve = new THREE.CatmullRomCurve3(pts);
  const geos = [], fs = [];
  const n = 9;
  const tan = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    curve.getPoint(t, p);
    curve.getTangent(t, tan);
    const r = w * (1 - 0.35 * t);
    const g = ellipsoid(r, r * 1.5, r * 0.9, 8, 6);
    g.rotateZ((i % 2 ? 1 : -1) * 0.45);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tan.clone().negate());
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q));
    g.translate(p.x, p.y, p.z);
    geos.push(g);
    for (let k = 0; k < g.attributes.position.count; k++) fs.push(0.9 + 0.1 * (i % 2));
  }
  const geo = merge(geos.map((g) => ({ geo: g, color: 0 })));
  geo.deleteAttribute('color');
  const f = Float32Array.from(fs);
  return { geo, f, k: new Float32Array(f.length).fill(1) };
}

// Büschel je Frisur. Wegpunkte: [phi, th, Abstand über der Haut]. Die Büschel liegen flach an
// und laufen spitz ins übrige Haar aus (letzter Wegpunkt knapp über der Haut, also unter der Haarkappe).
function hairClumps(sex, style) {
  const L = [];
  const add = (way, w, more = {}) => L.push({ way, w, tip: 0.3, flat: 0.5, ...more });
  if (sex === 'm') {
    if (style === 0) {                    // Kurz: Stirnhaare zur Seite gestrichen, oben locker
      for (let k = 0; k < 6; k++) { const p = -38 + k * 15; add([[p + 6, 12, 0.009], [p - 4, 27, 0.011], [p - 12, 41, 0.004]], 0.016); }
      for (let k = 0; k < 7; k++) { const p = 75 + k * 35; add([[p * 0.3, 8, 0.01], [p, 32, 0.01], [p + 8, 58, 0.004]], 0.018); }
    } else if (style === 1) {             // Zopf: straff nach hinten gekämmt
      for (let k = 0; k < 8; k++) { const p = -52 + k * 15; add([[p, 32, 0.003], [p * 0.6, 14, 0.01], [180 - p * 0.35, 30, 0.009], [180 - p * 0.15, 76, 0.004]], 0.015); }
    } else if (style === 2) {             // Lang: Mittelscheitel, Strähnen fallen nach hinten zu den Seiten
      for (let k = 0; k < 5; k++) for (const sd of [-1, 1]) { const p = 62 + k * 26; add([[sd * 3, 8 + k * 3, 0.011], [sd * p, 30, 0.012], [sd * (p + 8), 50, 0.003]], 0.019); }
    } else if (style === 4) {             // Strubbel: gestufte Büschel, nach vorn und oben gekämmt
      for (let k = 0; k < 18; k++) {
        const p = -70 + ((k * 53) % 260), th = 4 + ((k * 23) % 40);
        add([[p, Math.min(46, th + 18), 0.003], [p + 3, th + 7, 0.013], [p + 6, th - 3, 0.017]], 0.019, { tip: 0.22, flat: 0.6 });
      }
    }
  } else {
    if (style === 0) {                    // Lang: Seitenscheitel
      for (let k = 0; k < 4; k++) add([[22, 9 + k * 3, 0.012], [-25 - k * 10, 32, 0.013], [-60 - k * 9, 56, 0.004]], 0.019);
      for (let k = 0; k < 3; k++) add([[22, 11 + k * 3, 0.012], [55 + k * 10, 34, 0.013], [85 + k * 10, 58, 0.004]], 0.019);
      for (let k = 0; k < 5; k++) { const p = 115 + k * 30; add([[25, 12, 0.011], [p, 38, 0.013], [p + 4, 62, 0.004]], 0.021); }
    } else if (style === 1 || style === 2) {   // Pferdeschwanz, Dutt: nach hinten zusammengenommen
      const back = style === 1 ? 82 : 46;
      for (let k = 0; k < 9; k++) { const p = -60 + k * 15; add([[p, 33, 0.003], [p * 0.55, 16, 0.01], [180 - p * 0.3, 32, 0.01], [180 - p * 0.08, back, 0.006]], 0.016, { tip: 0.5 }); }
    } else if (style === 3) {             // Bob mit Pony
      for (let k = 0; k < 7; k++) { const p = -42 + k * 14; add([[p * 0.4, 10, 0.012], [p, 34, 0.015], [p * 1.04, 51, 0.009]], 0.018, { tip: 0.55, flat: 0.6 }); }
      for (let k = 0; k < 8; k++) { const p = 62 + k * 34; add([[p * 0.2, 8, 0.012], [p, 40, 0.014], [p, 66, 0.005]], 0.022); }
    } else if (style === 4) {             // Zöpfe: Mittelscheitel, nach hinten zu den Zöpfen
      for (let k = 0; k < 4; k++) for (const sd of [-1, 1]) { const p = 25 + k * 25; add([[sd * 2, 14 + k * 3, 0.009], [sd * (p + 20), 46, 0.01], [sd * (112 + k * 6), 92, 0.005]], 0.017); }
    }
  }
  return L;
}

// Kopf mit Gesicht, Haaren und Bart – Farben und Formen aus dem Aussehen
function buildHead(look, skin, hair) {
  const key = JSON.stringify(look);
  if (!HEAD_CACHE.has(key)) HEAD_CACHE.set(key, buildHeadNow(look, skin, hair));
  return HEAD_CACHE.get(key);
}
function buildHeadNow(look, skin, hair) {
  const female = look.sex === 'f';
  const fc = look.face;
  const H = headShape(look.sex, fc);
  const K = H.K;
  const s = H.s;
  const red = mix(skin, 0xc4524a, 0.24);
  const lipCol = female ? mix(skin, 0xb04452, 0.62) : mix(skin, 0x9a4f45, 0.4);
  const LY = (Y) => (Y < 0 ? Y / K.low : Y);

  // Hautfarbe: Gewichte (Durchblutung, Lippen, Mundspalte, Lidfalte, Schatten) hängen nur vom
  // Gesicht ab und werden einmal berechnet; der Hautton färbt dann nur noch ein.
  const base = headBase(look.sex, fc, H);
  const W = cached(`skinw|${look.sex}|${fc}`, () => {
    const pos = base.attributes.position;
    const w = new Float32Array(pos.count * 5);
    for (let i = 0; i < pos.count; i++) {
      const X = pos.getX(i) / s, Y = pos.getY(i) / s, Z = pos.getZ(i) / s, ax = Math.abs(X);
      let ao = 1, rd = 0, lip = 0, mouth = 0, crease = 0;
      if (Z < 0.01) {
        if (Y < -0.1) ao -= 0.16 * sstep(-0.1, -0.124, Y);
      } else {
        const ly = LY(Y);
        // durchblutete Stellen: Wangen, Nasenspitze, Kinn – wärmer, nicht grauer
        const r1 = 0.5 * gauss(ax - 0.046, 0.02) * gauss(Y + 0.028, 0.024);
        const r2 = 0.45 * gauss(X, 0.012) * gauss(ly + 0.04, 0.012);
        const r3 = 0.3 * gauss(X, 0.02) * gauss(Y + K.chinY - 0.018, 0.012);
        rd = 1 - (1 - r1) * (1 - r2) * (1 - r3);
        const up = (ax / 0.0235) ** 2 + ((ly + 0.065) / 0.0062) ** 2;
        const lo = (ax / 0.0195) ** 2 + ((ly + 0.0785) / 0.0072) ** 2;
        lip = 1 - sstep(0.6, 1.25, Math.min(up, lo));
        mouth = 0.85 * gauss(ly + 0.0716, 0.0016) * gauss(X, 0.021);
        crease = (female ? 0.45 : 0.3) * gauss(ax - EYE.x, 0.013) * gauss(Y - 0.0135, 0.0028);     // Lidfalte
        ao -= 0.1 * gauss(ax - EYE.x, 0.016) * gauss(Y - 0.004, 0.014);
        ao -= 0.35 * gauss(ax - 0.0085, 0.004) * gauss(ly + 0.0505, 0.0035);       // Nasenlöcher
        ao -= 0.12 * gauss(X, 0.012) * gauss(ly + 0.054, 0.004);
        ao -= 0.16 * sstep(-0.1, -0.124, Y) * (1 - sstep(0.03, 0.08, Z));          // unter dem Kiefer
      }
      w.set([rd, lip, mouth, crease, ao], i * 5);
    }
    return w;
  });
  const head = cached(`skin|${look.sex}|${fc}|${look.skin}`, () => {
    const n = W.length / 5;
    const col = new Float32Array(n * 3);
    const mouthCol = shade(lipCol, 0.45), creaseCol = shade(skin, 0.78);
    for (let i = 0; i < n; i++) {
      const o = i * 5;
      let c = mix(skin, red, W[o]);
      c = mix(c, lipCol, W[o + 1]);
      c = mix(c, mouthCol, W[o + 2]);
      c = mix(c, creaseCol, W[o + 3]);
      putColor(col, i, shade(c, W[o + 4]));
    }
    return withColors(base, col);
  });
  const parts = [{ geo: head }];
  const st = look.style;
  const longHair = female ? st === 0 : st === 2;
  const bob = female && st === 3;
  const bald = !female && st === 3;

  // Haarkappe (bei der Glatze nur ein Haarkranz an Seiten und Hinterkopf)
  const scalp = cached(`hair|${look.sex}|${fc}|${st}`, () => {
    const hl = HAIRLINE[look.sex];
    const scalpLine = table((a) => {
      const l = piecewise(hl, a);
      if (bald) return a < 1.25 ? 0.2 : l;
      return (longHair || bob) && a > 1.3 ? Math.min(l, -0.05) : l;     // lange Haare bedecken die Ohren
    });
    return layerShape(base, s,
      (x, y, z) => {
        let k = sstep(-0.006, 0.024, lineDist(x, y, z, scalpLine));
        if (bald) k *= 1 - sstep(0.018, 0.042, y);                       // oben kahl: Haarkranz
        return k;
      },
      (x, y, z) => {
        if (bald) return 0.0022;
        let t = (female ? 0.006 : 0.0045) + (female ? 0.011 : 0.0085) * sstep(-0.02, 0.1, y);
        if (longHair || bob) t += 0.004;
        if (!female && st === 0) t += 0.002 * sstep(0.04, 0.0, z);
        if (!female && st === 4) t += 0.003;
        return t;
      }, `hairmask|${look.sex}|${st}`, look.sex);
  });
  parts.push({ geo: recolor(scalp, skin, hair, bald ? 0.85 : 1) });

  // Haarbüschel
  const clumps = hairClumps(look.sex, st);
  if (clumps.length) parts.push({ geo: recolor(cached(`clumps|${look.sex}|${fc}|${st}`, () => clumpShape(H, clumps)), skin, hair) });

  // Bart: 1 Vollbart, 2 Kinnbart, 3 Stoppeln – die Lippen bleiben frei
  if (!female && look.beard) {
    const kind = look.beard;
    const beard = cached(`beard|${fc}|${kind}`, () => {
      const beardLine = table((a) => piecewise([[0, -0.051], [0.3, -0.049], [0.55, -0.056], [0.85, -0.042], [1.2, -0.022], [1.4, -0.006], [1.5, -0.01], [1.62, -0.07]], a));
      return layerShape(base, s,
        (x, y, z) => {
          if (y > 0.01) return 0;
          let k = sstep(0.006, -0.012, lineDist(x, y, z, beardLine));
          if (y < -0.064 && z > -0.03) k = Math.max(k, sstep(-0.064, -0.08, y) * sstep(-0.03, 0.0, z));   // unter dem Kiefer
          const ly = LY(y);
          const lips = (x / 0.027) ** 2 + ((ly + 0.0718) / 0.0118) ** 2;
          k *= sstep(0.85, 1.35, lips);
          if (kind === 2) k *= 1 - sstep(0.024, 0.034, Math.abs(x));      // nur um Mund und Kinn
          return k;
        },
        (x, y) => (kind === 3 ? 0.0009 : 0.004 + 0.0075 * sstep(-0.075, -0.125, y)), `beardmask|${kind}`, 'm');
    });
    parts.push({ geo: recolor(beard, skin, shade(hair, 0.92), kind === 3 ? 0.26 : 1) });
  }

  // Herabfallendes Haar: lang (bis über die Schultern) oder Bob (bis zum Kinn)
  if (longHair || bob) {
    const drape = cached(`drape|${look.sex}|${fc}|${bob ? 'bob' : 'lang'}`, () => {
      const end = bob ? -0.088 : female ? -0.215 : -0.135;
      const span = bob ? 0.95 : female ? 1.12 : 1.3;      // ab diesem Winkel (vorn = 0) beginnt der Vorhang
      const nu = 48, nv = 16;
      const pos = [], idx = [];
      const f = [];
      for (let j = 0; j <= nv; j++) {
        for (let i = 0; i <= nu; i++) {
          const phi = span + (i / nu) * (Math.PI * 2 - 2 * span);
          const t = j / nv;
          // ausgefranster Saum: Strähnen enden unterschiedlich lang
          const jag = (bob ? 0.006 : 0.016) * (Math.abs(Math.sin(phi * 7.5)) - 0.5 + 0.4 * Math.sin(phi * 3.1));
          const yRel = lerp(0.085, end + jag, t);
          const d = H.point(Math.sin(phi), Math.max(yRel, -0.06) / (yRel > 0 ? 0.1 : 0.12), Math.cos(phi));
          const r0 = Math.hypot(d[0], d[2]) / s;
          const below = sstep(-0.04, end, yRel);
          const ridge = 0.004 * Math.abs(Math.sin(phi * 9 + 0.5)) + 0.002 * Math.sin(phi * 21);
          const r = r0 + lerp(0.006, 0.013, sstep(0.085, 0.03, yRel)) + (bob ? 0.008 : 0.016) * below + ridge * (0.4 + below);
          let x = Math.sin(phi) * r, z = Math.cos(phi) * r;
          z -= (bob ? 0.004 : 0.012) * below;
          x *= 1 - (bob ? -0.04 : 0.08) * below;
          pos.push(x * s, yRel * s, z * s);
          f.push((0.86 + 0.08 * Math.sin(phi * 47 + t * 2) + 0.04 * Math.sin(phi * 19) + 0.08 * t) * (0.97 + 0.06 * Math.abs(Math.sin(phi * 9 + 0.5))));
        }
      }
      for (let j = 0; j < nv; j++) {
        for (let i = 0; i < nu; i++) {
          const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return { geo: g, f: Float32Array.from(f), k: new Float32Array(f.length).fill(1) };
    });
    parts.push({ geo: recolor(drape, skin, hair) });
    if (female && !bob) {        // zwei Strähnen vorn, die das Gesicht rahmen
      for (const sx of [-1, 1]) {
        parts.push({ geo: limbShape(0.17, [[0, 0.016], [0.5, 0.019], [1, 0.01]], 1.4, 0.8, 8), m: at(sx * 0.071 * s, 0.03 * s, 0.012 * s, 0.05, 0, sx * 0.05), color: shade(hair, 0.95) });
      }
    }
  }

  // Zöpfe: zwei geflochtene Zöpfe hinter den Ohren
  if (female && st === 4) {
    for (const sx of [-1, 1]) {
      const root = H.point(...sph(sx * 118, 100));
      const r = new THREE.Vector3(root[0], root[1], root[2]).add(new THREE.Vector3(sx * 0.008, 0, -0.006));
      const pts = [r, r.clone().add(new THREE.Vector3(sx * 0.012, -0.07, -0.015)), r.clone().add(new THREE.Vector3(sx * 0.018, -0.16, -0.012)), r.clone().add(new THREE.Vector3(sx * 0.016, -0.25, 0.0))];
      parts.push({ geo: recolor(cached(`braid|${fc}|${sx}`, () => braidShape(pts, 0.017 * s)), skin, hair) });
      const endP = pts[3];
      parts.push({ geo: new THREE.TorusGeometry(0.009 * s, 0.003 * s, 4, 10).rotateX(Math.PI / 2), m: at(endP.x, endP.y + 0.004, endP.z), color: CLOTH.leather });
      parts.push({ geo: ellipsoid(0.008 * s, 0.022 * s, 0.007 * s, 8, 6), m: at(endP.x, endP.y - 0.02 * s, endP.z), color: shade(hair, 1.04) });
    }
  }

  // Ohren: flache Muschel mit Mulde und Läppchen, leicht nach hinten geneigt
  for (const sx of [-1, 1]) {
    const c = H.point(sx, -0.13, -0.12);
    const ear = ellipsoid(0.0062, 0.028, 0.018, 12, 10);
    const pos = ear.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x > 0) x -= 0.0065 * gauss(y + 0.004, 0.013) * gauss(z - 0.002, 0.0095);   // Mulde
      if (y < -0.018) { x *= 1.3; z *= 0.85; }                                         // Läppchen
      pos.setXYZ(i, sx * x, y, z);
    }
    if (sx < 0) {
      const ix = ear.index;
      for (let i = 0; i < ix.count; i += 3) { const t = ix.getX(i); ix.setX(i, ix.getX(i + 2)); ix.setX(i + 2, t); }
    }
    ear.computeVertexNormals();
    const cx = c[0] + sx * 0.003 * s;
    parts.push({ geo: ear, m: at(cx - sx * 0.002 * s, c[1] + 0.004 * s, c[2] + 0.006 * s, 0, sx * 0.22, sx * 0.05, s),
      color: (x, y, z) => shade(mix(skin, red, 0.3), 1 - 0.18 * gauss(y - c[1] - 0.004 * s, 0.012) * gauss(z - c[2] - 0.006 * s, 0.009)) });
  }

  // Augenbrauen: Frau schmal, hoch und gebogen – Mann kräftig, gerade und tiefer
  for (const sx of [-1, 1]) {
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const x = 0.011 + 0.04 * t;
      const y = female
        ? 0.027 + 0.011 * Math.sin(Math.PI * Math.min(1, t * 1.2)) - 0.005 * t * t
        : 0.0235 + 0.0035 * Math.sin(Math.PI * Math.min(1, t * 1.15)) - 0.003 * t * t;
      pts.push(new THREE.Vector3(sx * x * s, y * s, H.frontZ(x * s, y * s) + 0.0006));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const g = new THREE.TubeGeometry(curve, 14, 1, 6, false);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const t = Math.floor(i / 7) / 14;
      const c = curve.getPoint(t);
      const w = (female ? 0.0026 : 0.005) * (1 - (female ? 0.6 : 0.45) * t) * s;
      const dx = pos.getX(i) - c.x, dy = pos.getY(i) - c.y, dz = pos.getZ(i) - c.z;
      pos.setXYZ(i, c.x + dx * w, c.y + dy * w * 0.85, c.z + dz * w * 0.22);
    }
    g.computeVertexNormals();
    parts.push({ geo: g, color: shade(hair, 0.88) });
  }

  // Unterlider: Rand auf Höhe des unteren Irisrands
  const ez = H.frontZ(EYE.x * s, EYE.y * s) - 0.0045 * s;
  const er = EYE.r * s * (female ? 1.04 : 1);
  for (const sx of [-1, 1]) {
    parts.push({ geo: new THREE.SphereGeometry(er * 1.07, 14, 5, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5),
      m: at(sx * EYE.x * s, EYE.y * s, ez, 0.47, 0, 0), color: (x, y) => (y > EYE.y * s - er * 0.52 ? shade(skin, female ? 0.72 : 0.85) : shade(skin, 0.94)) });
  }

  // Zopf (Mann), Pferdeschwanz, Dutt
  const extra = [];
  if (!female && st === 1) extra.push({ geo: limbShape(0.2, [[0, 0.028], [0.6, 0.024], [1, 0.016]], 1, 1, 10), color: (x, y, z) => shade(hair, 0.92 + 0.08 * Math.sin(Math.atan2(x, z) * 7 + y * 40)) }, { geo: new THREE.TorusGeometry(0.025, 0.006, 5, 10).rotateX(Math.PI / 2), m: at(0, -0.035, 0), color: CLOTH.leather });
  if (female && st === 1) extra.push({ geo: limbShape(0.26, [[0, 0.03], [0.3, 0.028], [0.75, 0.02], [1, 0.01]], 1, 0.85, 10), color: (x, y, z) => shade(hair, 0.92 + 0.08 * Math.sin(Math.atan2(x, z) * 7 + y * 40)) }, { geo: new THREE.TorusGeometry(0.027, 0.007, 5, 10).rotateX(Math.PI / 2), m: at(0, -0.035, 0), color: CLOTH.leather });
  if (female && st === 2) {
    parts.push({ geo: ellipsoid(0.052, 0.046, 0.044, 14, 10), m: at(0, 0.055 * s, -0.105 * s), color: (x, y, z) => shade(hair, 0.9 + 0.1 * Math.sin(Math.atan2(y - 0.05, x) * 9)) });
    parts.push({ geo: new THREE.TorusGeometry(0.04, 0.008, 5, 12), m: at(0, 0.05 * s, -0.082 * s, 0.35), color: CLOTH.leather });
  }

  return {
    head: merge(parts),
    tail: extra.length ? merge(extra) : null,
    H, ez, er,
  };
}

// Augen: ein Augapfel mit Iris, Pupille, Lidschatten und Glanzpunkt – zweimal verwendet,
// damit beide Augen sich bewegen können. Oberlider sind ein eigenes Netz (Blinzeln).
const IRIS = [0x4a3220, 0x6b4a2a, 0x3c5a6e, 0x51653a, 0x5f6670];
const EYE_MAT = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 90, specular: 0x9a9a9a, emissive: 0x141210 });
function eyeColor(look) {
  if (look.skin >= 3 || look.hair === 0) return IRIS[(look.face + look.hair) % 2];       // dunkel: braun
  return IRIS[(look.hair * 3 + look.skin + look.face * 2) % IRIS.length];
}
function buildEyes(look, s, er, skin) {
  const female = look.sex === 'f';
  const iris = eyeColor(look);
  const eye = merge([
    {
      geo: new THREE.SphereGeometry(er, 18, 14),
      color: (x, y, z) => {
        const d = Math.hypot(x, y);
        let c;
        if (z < er * 0.8) c = 0xe2d9cd;
        else if (d < er * 0.21) c = 0x0b0a09;
        else if (d < er * 0.44) c = mix(shade(iris, 1.3), shade(iris, 0.65), d / (er * 0.44));
        else if (d < er * 0.5) c = shade(iris, 0.45);
        else c = 0xe9e1d6;
        return shade(c, 1 - 0.35 * sstep(-0.05 * er, 0.6 * er, y));    // Schatten des Oberlids
      },
    },
    // Glanzpunkt oben außen auf der Hornhaut
    { geo: new THREE.SphereGeometry(er * 0.1, 6, 4), m: at(er * 0.22, er * 0.24, er * 0.97), color: 0xffffff },
  ]);
  const lash = female ? 0x15100d : 0x2e2219;
  const lids = merge([-1, 1].map((sx) => ({
    geo: new THREE.SphereGeometry(er * 1.09, 16, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
    m: at(sx * EYE.x * s, 0, 0),
    color: (x, y) => (y < er * (female ? 0.16 : 0.09) ? lash : shade(skin, female ? 0.9 : 0.96)),
  })));
  return { eye, lids };
}

// ---------------------------------------------------------------------------
//  Körpermaße – männlich und weiblich
//  torso: Querschnitte von der Taille (y = 0) bis zum Halsansatz:
//         [höhe, halbe Breite, Tiefe vorn, Tiefe hinten]
// ---------------------------------------------------------------------------
const BODY = {
  m: {
    hip: 1.005, waist: 0.10, chest: 0.25, neck: 0.25, head: 0.105,
    thigh: 0.47, shin: 0.45, upper: 0.30, fore: 0.27,
    shoulderX: 0.178, shoulderY: 0.183, legX: 0.096,
    neckR: 0.056, pelvisR: 0.158, hem: -0.17,
    torso: [[0.00, 0.150, 0.092, 0.084], [0.08, 0.152, 0.098, 0.08], [0.16, 0.163, 0.106, 0.084], [0.25, 0.183, 0.116, 0.093],
            [0.33, 0.193, 0.12, 0.099], [0.40, 0.197, 0.112, 0.1], [0.445, 0.183, 0.098, 0.094], [0.475, 0.13, 0.08, 0.084],
            [0.495, 0.074, 0.06, 0.062], [0.51, 0.058, 0.052, 0.054]],
    thighK: [[0, 0.097], [0.12, 0.1], [0.45, 0.088], [0.82, 0.067], [1, 0.063]],
    shinK: [[0, 0.063], [0.22, 0.066], [0.5, 0.056], [0.8, 0.043], [1, 0.04]],
    upperK: [[0, 0.054], [0.14, 0.058], [0.4, 0.051], [0.62, 0.05], [0.88, 0.043], [1, 0.042]],
    foreK: [[0, 0.044], [0.18, 0.049], [0.5, 0.041], [0.85, 0.031], [1, 0.03]],
    hand: 1.1,
  },
  f: {
    hip: 0.97, waist: 0.10, chest: 0.23, neck: 0.235, head: 0.106,
    thigh: 0.455, shin: 0.43, upper: 0.28, fore: 0.25,
    shoulderX: 0.152, shoulderY: 0.168, legX: 0.098,
    neckR: 0.043, pelvisR: 0.172, hem: -0.25,
    torso: [[0.00, 0.148, 0.088, 0.088], [0.07, 0.132, 0.082, 0.074], [0.13, 0.126, 0.082, 0.072], [0.22, 0.142, 0.09, 0.08],
            [0.30, 0.152, 0.094, 0.085], [0.37, 0.155, 0.09, 0.086], [0.41, 0.145, 0.082, 0.082], [0.44, 0.104, 0.066, 0.07],
            [0.458, 0.06, 0.05, 0.05], [0.47, 0.048, 0.044, 0.045]],
    thighK: [[0, 0.097], [0.12, 0.099], [0.45, 0.084], [0.82, 0.062], [1, 0.058]],
    shinK: [[0, 0.057], [0.22, 0.06], [0.5, 0.05], [0.8, 0.038], [1, 0.036]],
    upperK: [[0, 0.045], [0.14, 0.047], [0.4, 0.043], [0.62, 0.041], [0.88, 0.036], [1, 0.035]],
    foreK: [[0, 0.037], [0.18, 0.04], [0.5, 0.034], [0.85, 0.026], [1, 0.025]],
    hand: 0.96,
  },
};

// Statur: schlank, normal, kräftig – Rumpf breiter und tiefer, Glieder dicker
const HEAD_SCALE = 1.06;            // Kopf etwas größer als echt: auf dem iPad besser zu erkennen
function bodyDims(sex, build) {
  return cached(`dims|${sex}|${build}`, () => {
    const B0 = BODY[sex];
    const wide = [0.92, 1, 1.09][build], thick = [0.9, 1, 1.12][build];
    const r = (k) => k.map(([t, v]) => [t, v * thick]);
    return {
      ...B0,
      torso: B0.torso.map(([y, w, f, b]) => [y, w * wide, f * (1 + (wide - 1) * 0.9), b * (1 + (wide - 1) * 0.8)]),
      thighK: r(B0.thighK), shinK: r(B0.shinK), upperK: r(B0.upperK), foreK: r(B0.foreK),
      shoulderX: B0.shoulderX * (1 + (wide - 1) * 0.65), neckR: B0.neckR * (1 + (thick - 1) * 0.7),
      pelvisR: B0.pelvisR * (1 + (wide - 1) * 0.6), hand: B0.hand * (1 + (thick - 1) * 0.4),
    };
  });
}

// Rumpf aus Querschnitten (vorn flacher, an den Seiten kantiger als eine Ellipse)
// Form je Geschlecht; kind (0 Haut, 1 Borte, 2 Tunika) und f (Falten) je Eckpunkt zum Einfärben
function torsoShape(sex, build) {
  return cached(`torso|${sex}|${build}`, () => {
    const kind = [], fac = [];
    const geo = torsoGeo(bodyDims(sex, build), sex === 'f', kind, fac);
    geo.deleteAttribute('color');
    return { geo, kind, fac };
  });
}
function torsoColored(sex, build, tunic, skin) {
  const T = torsoShape(sex, build);
  const n = T.kind.length;
  const col = new Float32Array(n * 3);
  const dark = shade(tunic, 0.7);
  for (let i = 0; i < n; i++) putColor(col, i, T.kind[i] === 0 ? skin : T.kind[i] === 1 ? dark : shade(tunic, T.fac[i]));
  return withColors(T.geo, col);
}

function torsoGeo(B, female, kind, fac) {
  const K = B.torso;
  const top = K[K.length - 1][0];
  const col = (i) => K.map((k) => [k[0], k[i]]);
  const Wk = col(1), Fk = col(2), Bk = col(3);
  const n = 2.6;
  const v = warp(32, (t) => 1 + 1.5 * gauss(t, 0.18));      // oben (Schultern, Hals) dichter
  return gridSurface(44, 32, (uu, vv) => {
    const phi = uu * Math.PI * 2;
    const y = top * (1 - v[Math.round(vv * 32)]);
    const w = piecewise(Wk, y), f = piecewise(Fk, y), b = piecewise(Bk, y);
    const sn = Math.sin(phi), cs = Math.cos(phi);
    let x = w * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n);
    let z = (cs >= 0 ? f : b) * Math.sign(cs) * Math.pow(Math.abs(cs), 2 / n);
    const ax = Math.abs(x), fr = Math.max(0, cs), bk = Math.max(0, -cs);
    if (female) {
      // Brust: oben flach auslaufend, unten rund abgesetzt
      const dy = y - 0.272;
      const gy = gauss(dy, dy > 0 ? 0.07 : 0.038);
      z += 0.046 * gy * gauss(ax - 0.066, 0.042) * Math.pow(fr, 0.6);
    } else {
      z += 0.013 * gauss(y - 0.335, 0.05) * gauss(ax - 0.074, 0.05) * Math.pow(fr, 0.6);   // Brustmuskel
    }
    z -= 0.011 * gauss(y - 0.36, 0.07) * gauss(ax - 0.08, 0.05) * bk;            // Schulterblätter
    z += 0.006 * gauss(x, 0.012) * sstep(0.05, 0.3, y) * bk;                     // Wirbelsäulenrinne
    x += Math.sign(x) * 0.008 * gauss(y - 0.47, 0.025) * sstep(0.08, 0.13, ax);   // Trapezmuskel zur Schulter
    // Farbe: Tunika mit V-Ausschnitt, Saumborte, Falten unten, Seitennaht
    let k = 2;
    if (z > 0) {
      const vy = top - (female ? 0.03 : 0.022) + 0.5 * ax;
      if (y > vy + 0.005) k = 0;
      else if (y > vy - 0.005) k = 1;
    }
    kind.push(k);
    fac.push((1 - 0.06 * (0.5 + 0.5 * Math.sin(x * 75 + y * 6)) * (1 - sstep(0.12, 0.28, y))) * (1 - 0.1 * sstep(0.93, 0.99, Math.abs(sn))));
    return [x, y, z, 0];
  });
}

// Faust: Handrücken, eingerollte Finger mit Knöcheln, Daumen. Griff läuft entlang z.
// Für die rechte Hand: Handfläche zeigt nach +x (zum Körper).
function fistParts(skin, k) {
  const knuck = shade(skin, 0.93);
  const p = [
    { geo: roundBox(0.015 * k, 0.042 * k, 0.04 * k, 3), m: at(-0.006 * k, -0.046 * k, 0), color: skin },
    { geo: roundBox(0.019 * k, 0.017 * k, 0.041 * k, 2.6), m: at(0.0, -0.088 * k, 0.002 * k), color: skin },
    { geo: limbShape(0.05 * k, [[0, 0.012 * k], [1, 0.0095 * k]], 1, 1, 8), m: at(0.012 * k, -0.025 * k, 0.03 * k, -0.9, 0, 0.5), color: skin },
  ];
  for (let i = 0; i < 4; i++) {
    p.push({ geo: ellipsoid(0.0105 * k, 0.011 * k, 0.0095 * k, 8, 6), m: at(-0.014 * k, -0.08 * k, (0.028 - i * 0.019) * k), color: knuck });
  }
  return p;
}

// ---------------------------------------------------------------------------
//  Körperteile als Netze – zwischengespeichert je Aussehen und Kleidungsfarbe
// ---------------------------------------------------------------------------
const CHAR_GEO_CACHE = new Map();

function buildParts(look, tunicHex) {
  const key = JSON.stringify(look) + tunicHex;
  if (CHAR_GEO_CACHE.has(key)) return CHAR_GEO_CACHE.get(key);
  const B = bodyDims(look.sex, look.build);
  const bk = `${look.sex}|${look.build}`;
  const female = look.sex === 'f';
  const skin = LOOK_SKIN[look.skin];
  const hair = LOOK_HAIR[look.hair];
  const tunic = tunicHex;
  const tunicDark = shade(tunic, 0.72);
  const P = {};

  // Becken mit Rock der Tunika und Gürtel
  P.pelvis = cached(`pelvis|${bk}|${tunic}`, () => merge([
    { geo: lathe([[0.06, -0.13], [0.13, -0.10], [B.pelvisR, -0.03], [B.pelvisR * 0.98, 0.04], [0.15, 0.10]], 1.08, 0.74), color: CLOTH.trousers },
    { geo: lathe([[B.pelvisR * 1.36 + (female ? 0.05 : 0), B.hem], [B.pelvisR * 1.25, B.hem + 0.06],
                  [B.pelvisR * 1.12, -0.04], [0.16, 0.05], [0.155, 0.11]], 1.1, 0.8, 26),
      color: (x, y, z) => (y < B.hem + 0.025 ? tunicDark : shade(tunic, 1 - 0.08 * (0.5 + 0.5 * Math.sin(Math.atan2(x, z) * 9)))),
      deform: (x, y, z) => { const a = Math.atan2(x, z); const f = 1 + 0.03 * Math.sin(a * 9) * sstep(0.0, B.hem, y); return [x * f, y, z * f]; } },
    { geo: new THREE.TorusGeometry(0.162, 0.022, 6, 22).rotateX(Math.PI / 2), m: at(0, 0.075, 0), color: CLOTH.leather,
      deform: (x, y, z) => [x * 1.08, y, z * 0.78] },
    { geo: roundBox(0.03, 0.026, 0.01, 4, 8, 6), m: at(0, 0.075, 0.128), color: CLOTH.brass },
    { geo: roundBox(0.042, 0.05, 0.022, 3), m: at(-0.13, 0.03, 0.06, 0, -0.5), color: CLOTH.leatherDark },   // Gürteltasche
  ]));

  // Rumpf mit Tunika, Rucksack mit Deckenrolle und Riemen
  const torsoTop = B.torso[B.torso.length - 1][0];
  const strapY = female ? 0.43 : 0.465;
  P.torso = cached(`torso|${bk}|${skin}|${tunic}`, () => merge([
    { geo: torsoColored(look.sex, look.build, tunic, skin) },
    { geo: roundBox(0.15, 0.17, 0.065, 3.5), m: at(0, 0.27, -0.165), color: CLOTH.leather },
    { geo: roundBox(0.12, 0.06, 0.012, 3.5), m: at(0, 0.36, -0.096), color: CLOTH.leatherDark },
    { geo: new THREE.CylinderGeometry(0.06, 0.06, 0.36, 14).rotateZ(Math.PI / 2), m: at(0, 0.47, -0.17), color: (x) => (Math.abs(Math.abs(x) - 0.12) < 0.012 ? CLOTH.leatherDark : 0x6d6250) },
    // Schulterriemen über die Schultern nach hinten
    { geo: new THREE.TorusGeometry(0.08, 0.011, 5, 16, Math.PI), m: at(-0.105, strapY - 0.02, -0.03, 0, Math.PI / 2, 0), color: CLOTH.leatherDark },
    { geo: new THREE.TorusGeometry(0.08, 0.011, 5, 16, Math.PI), m: at(0.105, strapY - 0.02, -0.03, 0, Math.PI / 2, 0), color: CLOTH.leatherDark },
  ]));
  P.torsoTop = torsoTop;

  // Hals mit Kehlkopf (Mann) und Nackenmuskeln
  P.neck = cached(`neck|${bk}|${skin}`, () => merge([{ geo: limbShape(0.14, [[0, B.neckR], [0.6, B.neckR * 1.04], [1, B.neckR * 1.2]], 1.05, 1, 14,
    (x, y, z, t) => [x, y, z + (female ? 0 : 0.008 * gauss(t - 0.45, 0.12) * gauss(x, 0.012) * (z > 0 ? 1 : 0))]),
    m: at(0, 0.14, 0), color: skin }]));

  // Kopf, Haare, Augen
  const HD = buildHead(look, skin, hair);
  P.head = HD.head;
  P.tail = HD.tail;
  const E = cached(`eyes|${look.sex}|${look.face}|${look.skin}|${look.hair}`, () => buildEyes(look, HD.H.s, HD.er, skin));
  P.eye = E.eye;
  P.lids = E.lids;
  P.headInfo = { s: HD.H.s, ez: HD.ez, Ht: HD.H.Ht, Db: HD.H.Db };

  // Arme: Ärmel der Tunika, Haut, Armschiene aus Leder, Faust
  const sleeve = female ? -0.10 : -0.13;
  P.upper = cached(`upper|${bk}|${skin}|${tunic}`, () => merge([
    { geo: limbShape(B.upper, withCuts(B.upperK, [-sleeve / B.upper]), 1, 1, 14, (x, y, z, t) => [x * (1 + 0.04 * gauss(t - 0.15, 0.12)), y, z * (1 + (z > 0 ? 0.12 : 0.05) * gauss(t - 0.55, 0.2))]),
      color: (x, y) => (y > sleeve ? tunic : skin) },
    { geo: new THREE.TorusGeometry(B.upperK[2][1] * 1.06, 0.007, 4, 14).rotateX(Math.PI / 2), m: at(0, sleeve, 0), color: tunicDark },
  ]));
  P.fore = cached(`fore|${bk}|${skin}`, () => merge([{ geo: limbShape(B.fore, withCuts(B.foreK, [0.09 / B.fore, 1 - 0.02 / B.fore, 0.13 / B.fore, 1 - 0.035 / B.fore]), 1.12, 1, 14, (x, y, z, t) => [x, y, z * (1 + 0.1 * gauss(t - 0.2, 0.15)) * (1 - 0.15 * sstep(0.6, 1, t))]),
    color: (x, y) => (y < -0.09 && y > -B.fore + 0.02 ? (Math.abs(y + 0.13) < 0.006 || Math.abs(y + B.fore - 0.035) < 0.006 ? CLOTH.leatherDark : CLOTH.leather) : skin) }]));
  P.hand = cached(`hand|${bk}|${skin}`, () => merge(fistParts(skin, B.hand)));

  // Beine: Hose, Stiefel mit Stulpe, Fuß mit Sohle und Absatz
  P.thigh = cached(`thigh|${bk}`, () => merge([{ geo: limbShape(B.thigh, B.thighK, 1, 1, 14,
    (x, y, z, t) => [x * (1 + 0.04 * gauss(t - 0.3, 0.2)), y, z * (1 + (z > 0 ? 0.12 : 0.06) * gauss(t - 0.4, 0.25))]),
    color: (x, y) => shade(CLOTH.trousers, 1 - 0.07 * (0.5 + 0.5 * Math.sin(y * 70 + x * 20))) }]));
  const boot = -B.shin * 0.45;
  P.shin = cached(`shin|${bk}`, () => merge([
    { geo: limbShape(B.shin, withCuts(B.shinK, [0.45]), 1, 1, 14, (x, y, z, t) => [x * (1 + 0.1 * gauss(t - 0.28, 0.15)), y, z < 0 ? z * (1 + 0.3 * gauss(t - 0.28, 0.16)) : z]),
      color: (x, y) => (y < boot ? CLOTH.leather : CLOTH.trousers) },
    { geo: new THREE.TorusGeometry(B.shinK[2][1] * 1.16, 0.013, 5, 14).rotateX(Math.PI / 2), m: at(0, boot, 0), color: CLOTH.leatherDark,
      deform: (x, y, z) => [x, y, z < 0 ? z * 1.12 : z] },
  ]));
  const fk = female ? 0.9 : 1;
  P.foot = cached(`foot|${look.sex}`, () => merge([
    { geo: roundBox(0.046 * fk, 0.045, 0.118 * fk, 2.7), m: at(0, -0.02, 0.045), color: CLOTH.leather,
      deform: (x, y, z) => [x * (z > 0.1 ? 1 - 2 * (z - 0.1) : 1), Math.max(y - (z > 0.07 ? (z - 0.07) * 0.4 : 0), -0.052), z] },
    { geo: roundBox(0.05 * fk, 0.008, 0.122 * fk, 4), m: at(0, -0.058, 0.045), color: CLOTH.leatherDark },
    { geo: roundBox(0.04 * fk, 0.012, 0.03, 4), m: at(0, -0.062, -0.045), color: CLOTH.leatherDark },
  ]));

  // Köcher an der rechten Hüfte – nur sichtbar, wenn ein Bogen getragen wird
  P.quiver = cached('quiver', () => {
    const q = [
      { geo: limbShape(0.36, [[0, 0.036], [0.85, 0.032], [1, 0.03]], 1, 0.8, 12), m: at(0, 0.18, 0), color: (x, y) => (Math.abs(y - 0.12) < 0.012 || Math.abs(y + 0.1) < 0.012 ? CLOTH.leatherDark : CLOTH.leather) },
      { geo: new THREE.TorusGeometry(0.035, 0.007, 5, 14).rotateX(Math.PI / 2), m: at(0, 0.175, 0), color: CLOTH.leatherDark },
    ];
    for (let i = 0; i < 5; i++) {
      const ax = Math.cos(i * 1.3) * 0.014, az = Math.sin(i * 1.3) * 0.01, h = 0.23 + (i % 3) * 0.018;
      q.push({ geo: new THREE.CylinderGeometry(0.003, 0.003, 0.12, 4), m: at(ax, h - 0.05, az), color: 0x8a6239 });
      q.push({ geo: new THREE.BoxGeometry(0.022, 0.05, 0.002), m: at(ax, h, az, 0, i * 0.7, 0), color: i % 2 ? 0xe8e0d0 : 0x9e3a2e });
    }
    return merge(q);
  });

  CHAR_GEO_CACHE.set(key, P);
  return P;
}

// ---------------------------------------------------------------------------
//  Waffen – in Handkoordinaten: die Hand hängt nach -y, die Klinge zeigt nach +z
// ---------------------------------------------------------------------------
const WEAPON_GEO = (() => {
  const blade = (len, w) => {
    const g = new THREE.BoxGeometry(0.012, w, len);
    g.translate(0, 0, len / 2);
    return g;
  };
  const tip = (w) => new THREE.ConeGeometry(w / 2, w * 1.6, 4).rotateX(Math.PI / 2).rotateZ(Math.PI / 4).scale(0.3, 1, 1);
  // Bogen: Wurfarme entlang y, Griff in der Hand, Bauch nach vorn (+z), Sehne hinten
  const bowCurve = (h, b) => new THREE.CatmullRomCurve3([-1, -0.6, -0.25, 0, 0.25, 0.6, 1].map((t) =>
    new THREE.Vector3(0, h * t, b * (1 - t * t) - b + (Math.abs(t) > 0.85 ? 0.02 * (Math.abs(t) - 0.85) / 0.15 : 0))));
  return {
    grip: new THREE.CylinderGeometry(0.018, 0.018, 0.17, 8).rotateX(Math.PI / 2),
    pommel: new THREE.SphereGeometry(0.026, 8, 6),
    guard: new THREE.BoxGeometry(0.03, 0.2, 0.03),
    blade: blade(0.74, 0.05), bladeTip: tip(0.05),
    knifeGrip: new THREE.CylinderGeometry(0.015, 0.015, 0.11, 8).rotateX(Math.PI / 2),
    knifeGuard: new THREE.BoxGeometry(0.025, 0.11, 0.022),
    knife: blade(0.27, 0.036), knifeTip: tip(0.036),
    bow: new THREE.TubeGeometry(bowCurve(0.6, 0.11), 24, 0.014, 6),
    longbow: new THREE.TubeGeometry(bowCurve(0.75, 0.1), 28, 0.015, 6),
    bowGrip: new THREE.CylinderGeometry(0.02, 0.02, 0.12, 8),
    string: new THREE.CylinderGeometry(0.003, 0.003, 1, 4).translate(0, 0.5, 0),
    arrow: new THREE.CylinderGeometry(0.005, 0.005, 0.7, 5).translate(0, 0.35, 0),
    arrowHead: new THREE.ConeGeometry(0.012, 0.04, 4).translate(0, 0.72, 0),
    fletch: new THREE.BoxGeometry(0.03, 0.08, 0.002).translate(0, 0.06, 0),
  };
})();

function makeWeapon(kind) {
  const g = new THREE.Group();
  const add = (geo, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  const G = WEAPON_GEO, W = WEAPON_MATS;
  if (kind === 'heavy' || kind === 'iron_sword') {
    const steel = kind === 'heavy' ? W.steel : W.iron;
    add(G.grip, W.grip, 0, 0, 0);
    add(G.pommel, W.brass, 0, 0, -0.1);
    add(G.guard, kind === 'heavy' ? W.brass : W.iron, 0, 0, 0.095);
    add(G.blade, steel, 0, 0, 0.11);
    add(G.bladeTip, steel, 0, 0, 0.85 + 0.035);
    g.position.y = -0.06;
    g.rotation.x = 0.25;
  } else if (kind === 'dagger' || kind === 'iron_dagger') {
    const steel = kind === 'dagger' ? W.steel : W.iron;
    add(G.knifeGrip, W.grip, 0, 0, 0);
    add(G.knifeGuard, W.brass, 0, 0, 0.062);
    add(G.knife, steel, 0, 0, 0.073);
    add(G.knifeTip, steel, 0, 0, 0.343 + 0.025);
    g.position.y = -0.055;
    g.rotation.x = 0.2;
  } else {
    const long = kind === 'longbow';
    const h = long ? 0.75 : 0.6, b = long ? 0.1 : 0.11;
    add(long ? G.longbow : G.bow, long ? W.darkwood : W.wood);
    add(G.bowGrip, W.grip);
    const top = new THREE.Vector3(0, h, -b + 0.02);      // Enden der Wurfarme
    const bottom = new THREE.Vector3(0, -h, -b + 0.02);
    const s1 = add(G.string, W.string), s2 = add(G.string, W.string);
    const arrow = new THREE.Group();
    arrow.add(new THREE.Mesh(G.arrow, W.wood), new THREE.Mesh(G.arrowHead, W.iron), new THREE.Mesh(G.fletch, W.feather));
    arrow.visible = false;
    g.add(arrow);
    g.userData = { bow: true, top, bottom, rest: new THREE.Vector3(0, 0, -b + 0.02), s1, s2, arrow };
    g.position.y = -0.055;
    setStringTo(g, g.userData.rest);
  }
  return g;
}

const _dir = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
function stretch(mesh, a, b) {             // Zylinder der Länge 1 von a nach b legen
  _dir.subVectors(b, a);
  const len = _dir.length();
  mesh.position.copy(a);
  mesh.scale.set(1, Math.max(len, 0.001), 1);
  mesh.quaternion.setFromUnitVectors(_up, _dir.normalize());
}
function setStringTo(bow, nock) {
  const u = bow.userData;
  stretch(u.s1, u.top, nock);
  stretch(u.s2, u.bottom, nock);
}

// ---------------------------------------------------------------------------
//  Figur zusammensetzen
// ---------------------------------------------------------------------------
function makeCharacter(color, name, rawLook) {
  const look = normLook(rawLook);
  const B = bodyDims(look.sex, look.build);
  const P = buildParts(look, color);

  const root = new THREE.Group();
  const shadow = new THREE.Mesh(SHADOW_GEO, SHADOW_MAT);
  shadow.renderOrder = 1;
  root.add(shadow);
  const pose = new THREE.Group();          // kippt beim Fallen, wippt beim Laufen
  root.add(pose);

  const joint = (parent, x, y, z, geo) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    if (geo) g.add(new THREE.Mesh(geo, CHAR_MAT));
    parent.add(g);
    return g;
  };
  const hips = joint(pose, 0, B.hip, 0, P.pelvis);
  const spine = joint(hips, 0, B.waist, 0, null);
  const chest = joint(spine, 0, B.chest, 0, null);
  const torsoMesh = new THREE.Mesh(P.torso, CHAR_MAT);
  torsoMesh.position.y = -B.chest;              // Rumpf dreht mit der Brust
  chest.add(torsoMesh);
  const neck = joint(chest, 0, B.neck - 0.02, 0.01, P.neck);
  const HI = P.headInfo;
  const head = joint(neck, 0, B.head, 0.008, null);                        // Drehpunkt auf dem Hals
  const face = joint(head, 0, 0.066 * HI.s, 0.022 * HI.s, P.head);         // Kopfmitte = Augenhöhe
  face.scale.setScalar(HEAD_SCALE);
  const eyes = [-1, 1].map((sx) => {                                       // jedes Auge bewegt sich selbst
    const e = new THREE.Mesh(P.eye, EYE_MAT);
    e.position.set(sx * EYE.x * HI.s, EYE.y * HI.s, HI.ez);
    face.add(e);
    return e;
  });
  const lids = new THREE.Mesh(P.lids, CHAR_MAT);                           // Oberlider drehen um die Augenachse
  lids.position.set(0, EYE.y * HI.s, HI.ez);
  lids.rotation.x = LID_OPEN;
  face.add(lids);
  let tail = null;
  if (P.tail) {
    tail = joint(face, 0, (look.sex === 'f' ? 0.01 : -0.005) * HI.s, -HI.Db * 0.97, P.tail);
    tail.rotation.x = 0.5;
  }
  const arm = (side) => {                  // side: -1 rechts, +1 links
    const sh = joint(chest, side * B.shoulderX, B.shoulderY, -0.005, P.upper);
    const el = joint(sh, 0, -B.upper, 0, P.fore);
    const ha = joint(el, 0, -B.fore, 0, P.hand);
    if (side > 0) ha.scale.x = -1;          // linke Hand gespiegelt (Daumen innen)
    return { sh, el, ha };
  };
  const R = arm(-1), L = arm(1);
  const leg = (side) => {
    const th = joint(hips, side * B.legX, -0.02, 0, P.thigh);
    const kn = joint(th, 0, -B.thigh, 0, P.shin);
    const an = joint(kn, 0, -B.shin, 0, P.foot);
    return { th, kn, an };
  };
  const RL = leg(-1), LL = leg(1);
  const quiver = new THREE.Mesh(P.quiver, CHAR_MAT);
  quiver.position.set(-0.17 * (B.pelvisR / 0.158), -0.06, -0.075);
  quiver.rotation.set(-0.42, 0, -0.18);
  hips.add(quiver);

  // Waffen: Schwert und Dolch in der rechten Hand, Bogen in der linken
  const gear = {};
  for (const k of ['heavy', 'dagger', 'iron_sword', 'iron_dagger']) { gear[k] = makeWeapon(k); R.ha.add(gear[k]); }
  for (const k of ['bow', 'longbow']) { gear[k] = makeWeapon(k); L.ha.add(gear[k]); }

  const tag = makeNameTag(name);
  tag.position.y = B.hip + B.waist + B.chest + B.neck - 0.02 + B.head + 0.066 * HI.s + HI.Ht * HEAD_SCALE + 0.3;
  root.add(tag);

  root.userData = {
    look, tag, gear, shadow, quiver,
    j: { pose, hips, spine, chest, neck, head, face, eyes, lids, tail, R, L, RL, LL },
    w: 'heavy', walk: 0, amp: 0, run: 0, swing: -1, cast: -1, hurt: -1, ko: false, koT: 0,
    t: Math.random() * 100, blinkAt: 1 + Math.random() * 3, blink: -1,
    gaze: { x: 0, y: 0, tx: 0, ty: 0, next: 0 }, lastRy: null,
  };
  setWeaponModel(root, 'heavy');
  scene.add(root);
  return root;
}

function setWeaponModel(model, w) {
  const u = model.userData;
  if (!u.gear[w]) return;
  u.w = w;
  for (const k in u.gear) u.gear[k].visible = k === w;
  if (u.quiver) u.quiver.visible = isBow(w);
}

function disposeCharacter(root) {
  scene.remove(root);
  const u = root.userData;
  u.tag.material.map.dispose();
  u.tag.material.dispose();
}

// ---------------------------------------------------------------------------
//  Animation
// ---------------------------------------------------------------------------
const LID_OPEN = -0.36, LID_SHUT = 0.5;      // offen: Lid deckt die Iris oben knapp ab
const isBow = (w) => w === 'bow' || w === 'longbow';
const isDagger = (w) => w === 'dagger' || w === 'iron_dagger';
const SWING_TIME = (w) => (isDagger(w) ? 0.32 : isBow(w) ? 0.55 : 0.45);

// Hüllkurve: weich hinein, weich heraus
const env = (p, a = 0.12, b = 0.25) => (p < 0 ? 0 : smooth(clamp(p / a, 0, 1)) * smooth(clamp((1 - p) / b, 0, 1)));
// Stückweise Bewegung durch Schlüsselstellen [[p, wert], …]
function curve(p, k) {
  if (p <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (p <= k[i][0]) return lerp(k[i - 1][1], k[i][1], smooth((p - k[i - 1][0]) / (k[i][0] - k[i - 1][0])));
  }
  return k[k.length - 1][1];
}

const _hand = new THREE.Vector3();
const ARROW_AIM = new THREE.Vector3(0, 0, 0.2);
const _n = new THREE.Vector3();

function animateCharacter(model, x, z, ry, speed, dt) {
  const u = model.userData;
  const J = u.j;
  const look = u.look;
  u.t += dt;
  const t = u.t;
  model.position.set(x, groundY(x, z), z);
  model.rotation.y = lerpAngle(model.rotation.y, ry, damp(14, dt));

  // Schatten liegt flach auf dem Hang
  const e = 0.4;
  _n.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
  u.shadow.quaternion.setFromUnitVectors(_up, _n);
  u.shadow.position.y = Math.max(0, heightAt(x, z) - groundY(x, z)) + 0.02;
  u.shadow.visible = groundY(x, z) > WATER_LEVEL - 0.5;

  // Fortbewegung: Gehen bis ~2,5 m/s, darüber Laufen
  const target = !u.ko && speed > 0.3 ? 1 : 0;
  u.amp = lerp(u.amp, target, damp(9, dt));
  u.run = lerp(u.run, smooth(clamp((speed - 2.2) / 2.8, 0, 1)), damp(6, dt));
  if (speed > 0.3) u.walk += dt * (speed / (1.15 + 0.32 * speed)) * Math.PI * 2;
  const A = u.amp, Rn = u.run;
  const ph = u.walk;
  const sL = Math.sin(ph), cL = Math.cos(ph);

  // Bewusstlos: nach hinten fallen und liegen bleiben
  u.koT = lerp(u.koT, u.ko ? 1 : 0, damp(u.ko ? 5 : 3, dt));
  const down = smooth(clamp(u.koT, 0, 1));
  u.shadow.position.z = -0.85 * down;          // liegend: Schatten unter dem Körper
  u.shadow.scale.set(1 - 0.15 * down, 1, 1 + 1.1 * down);

  const idle = 1 - A;
  const breath = Math.sin(t * 1.7);

  // ---- Grundhaltung und Laufzyklus ----
  const thAmp = A * (0.42 + 0.38 * Rn);
  const leg = (L, phase, side) => {
    const s = Math.sin(phase), c = Math.cos(phase);
    const bend = Math.pow(Math.max(0, Math.cos(phase + 0.35)), 1.2);
    L.th.rotation.x = -s * thAmp - 0.03 * idle - 0.35 * down;
    L.th.rotation.z = side * (0.035 * idle + 0.02);
    L.kn.rotation.x = A * ((0.08 + 0.18 * Rn) + (0.55 + 0.95 * Rn) * bend) + 0.04 * idle + 0.75 * down;
    L.an.rotation.x = -(L.th.rotation.x + L.kn.rotation.x) * 0.55 + A * 0.18 * Math.max(0, c) - 0.25 * down;
    L.th.rotation.y = side * 0.04 * idle;
  };
  leg(J.LL, ph, 1);
  leg(J.RL, ph + Math.PI, -1);
  // Spielbein locker: Knie leicht gebeugt, Beine bleiben senkrecht trotz gekipptem Becken
  const relax = idle * (1 - down);
  J.RL.kn.rotation.x += 0.17 * relax;
  J.RL.th.rotation.x -= 0.07 * relax;
  J.RL.an.rotation.x -= 0.06 * relax;
  J.LL.th.rotation.z -= 0.045 * relax;
  J.RL.th.rotation.z -= 0.06 * relax;

  const bob = A * ((0.025 + 0.035 * Rn) * Math.cos(2 * ph) - 0.035 * Rn);
  J.pose.position.y = bob + 0.004 * breath * idle + down * 0.12;
  J.pose.rotation.x = -Math.PI / 2 * down;
  // Im Stand: Gewicht auf dem linken Bein (Kontrapost) – Becken links höher, Schultern gegengleich
  J.hips.position.x = (0.016 + 0.01 * Math.sin(t * 0.45)) * idle;
  J.hips.rotation.z = (0.045 + 0.02 * Math.sin(t * 0.45)) * idle + A * 0.04 * cL;
  J.hips.rotation.y = A * (0.12 + 0.06 * Rn) * sL;
  J.spine.rotation.x = A * (0.05 + 0.17 * Rn) + 0.015 * breath * idle;
  J.spine.rotation.y = -A * (0.1 + 0.06 * Rn) * sL;
  J.spine.rotation.z = -J.hips.rotation.z * 0.6;
  J.chest.rotation.z = -0.03 * idle;
  J.chest.rotation.x = 0.012 * breath;
  J.chest.rotation.y = -A * 0.12 * sL;
  J.neck.rotation.x = -J.spine.rotation.x * 0.55;
  J.neck.rotation.y = 0;                       // jede Bewegung setzt hier neu an – sonst dreht sich der Kopf auf Dauer weg
  J.neck.rotation.z = 0;
  J.head.rotation.y = 0.18 * Math.sin(t * 0.21) * Math.sin(t * 0.13) * idle + 0.35 * down;
  J.head.rotation.x = 0.04 * Math.sin(t * 0.3) * idle;

  // Arme pendeln gegengleich zu den Beinen; im Laufen angewinkelt
  const arAmp = A * (0.32 + 0.42 * Rn);
  const elbowBase = 0.14 + A * (0.25 + 1.05 * Rn);
  const armBase = (S, phaseSin, side) => {
    S.sh.rotation.x = phaseSin * arAmp + 0.02 * breath * idle;
    S.sh.rotation.z = side * (0.09 + 0.02 * breath * idle + 0.9 * down);
    S.sh.rotation.y = 0;
    S.el.rotation.x = -(elbowBase + A * 0.3 * Math.max(0, -phaseSin));
    S.el.rotation.y = 0;
    S.ha.rotation.set(0, 0, 0);
  };
  armBase(J.L, sL, 1);
  armBase(J.R, -sL, -1);

  // Waffe in Bereitschaft
  const w = u.w;
  if (isBow(w)) {
    J.L.el.rotation.x -= 0.2 * idle;
    J.L.ha.rotation.x = -(J.L.sh.rotation.x + J.L.el.rotation.x) * 0.9;
  } else {
    J.R.sh.rotation.x -= 0.12 * idle;
    J.R.el.rotation.x -= 0.35 * idle + 0.1;
  }

  // ---- Angriff ----
  if (u.swing >= 0) {
    u.swing += dt / SWING_TIME(w);
    if (u.swing >= 1) u.swing = -1;
  }
  const p = u.swing;
  const k = env(p, 0.1, 0.3);
  if (k > 0) {
    if (isBow(w)) {
      // Bogen heben, Sehne bis zur Wange ziehen, lösen
      const draw = env(p, 0.12, 0.3);
      J.chest.rotation.y = lerp(J.chest.rotation.y, -0.4, draw);
      J.neck.rotation.y = lerp(0, 0.38, draw);
      J.L.sh.rotation.x = lerp(J.L.sh.rotation.x, -1.52, draw);
      J.L.sh.rotation.y = lerp(0, 0.3, draw);
      J.L.sh.rotation.z = lerp(J.L.sh.rotation.z, 0.05, draw);
      J.L.el.rotation.x = lerp(J.L.el.rotation.x, -0.06, draw);
      J.L.ha.rotation.x = lerp(J.L.ha.rotation.x, 1.52, draw);
      // rechte Hand: 0 greift die Sehne, 1 Ankerpunkt an der Wange, 2 nach dem Lösen hinten
      const a = curve(p, [[0, 0], [0.14, 0], [0.45, 1], [0.6, 1], [0.7, 2], [1, 2]]);
      const P3 = [[-1.42, 0.12, -0.25], [-1.48, 0.62, -2.15], [-1.3, 0.95, -1.55]];
      const i0 = Math.min(1, Math.floor(a)), f = a - i0;
      const q = [0, 1, 2].map((n) => lerp(P3[i0][n], P3[i0 + 1][n], f));
      J.R.sh.rotation.x = lerp(J.R.sh.rotation.x, q[0], draw);
      J.R.sh.rotation.y = lerp(0, q[1], draw);
      J.R.sh.rotation.z = lerp(J.R.sh.rotation.z, -0.12, draw);
      J.R.el.rotation.x = lerp(J.R.el.rotation.x, q[2], draw);
    } else if (isDagger(w)) {
      // Kurzer Stich nach vorn
      const reach = curve(p, [[0, 0], [0.3, -0.4], [0.5, 1], [0.7, 1], [1, 0]]);
      J.chest.rotation.y += k * 0.4 * reach;
      J.spine.rotation.x += k * 0.12 * Math.max(0, reach);
      J.R.sh.rotation.x = lerp(J.R.sh.rotation.x, -0.55 - 0.95 * Math.max(0, reach), k);
      J.R.sh.rotation.z = lerp(J.R.sh.rotation.z, -0.12, k);
      J.R.el.rotation.x = lerp(J.R.el.rotation.x, -1.55 + 1.5 * Math.max(0, reach), k);
      J.L.sh.rotation.x = lerp(J.L.sh.rotation.x, 0.35, k * 0.6);
      const lunge = k * Math.max(0, reach);
      J.LL.th.rotation.x -= 0.32 * lunge;
      J.LL.kn.rotation.x += 0.3 * lunge;
      J.RL.th.rotation.x += 0.22 * lunge;
      J.pose.position.y -= 0.04 * lunge;
    } else {
      // Schwert: ausholen über die Schulter, Schlag schräg nach unten, zurück
      const arc = curve(p, [[0, 0], [0.35, -1], [0.5, 0.6], [0.6, 1], [1, 0.2]]);
      const wind = Math.max(0, -arc), strike = Math.max(0, arc);
      J.chest.rotation.y += k * (-0.55 * wind + 0.6 * strike);
      J.spine.rotation.x += k * (-0.08 * wind + 0.24 * strike);
      J.hips.rotation.y += k * (-0.22 * wind + 0.2 * strike);
      J.R.sh.rotation.x = lerp(J.R.sh.rotation.x, -2.7 * wind - 1.15 * strike, k);
      J.R.sh.rotation.z = lerp(J.R.sh.rotation.z, -0.55 * wind - 0.1 * strike, k);
      J.R.sh.rotation.y = lerp(0, 0.65 * strike, k);
      J.R.el.rotation.x = lerp(J.R.el.rotation.x, -1.6 * wind - 0.08 * strike, k);
      J.R.ha.rotation.x = lerp(0, -0.35 * wind + 0.35 * strike, k);
      J.pose.position.y -= k * 0.05 * strike;
      J.L.sh.rotation.x = lerp(J.L.sh.rotation.x, -0.3 * wind + 0.4 * strike, k);
      J.L.el.rotation.x = lerp(J.L.el.rotation.x, -0.7, k * 0.6);
      J.LL.th.rotation.x -= k * 0.25 * strike;
      J.LL.kn.rotation.x += k * 0.2 * strike;
      J.RL.th.rotation.x += k * 0.18 * strike;
    }
  }

  // ---- Zauber: linke Hand hebt sich offen nach vorn ----
  if (u.cast >= 0) {
    u.cast += dt / 0.6;
    if (u.cast >= 1) u.cast = -1;
  }
  const ck = env(u.cast, 0.25, 0.35);
  if (ck > 0) {
    J.L.sh.rotation.x = lerp(J.L.sh.rotation.x, -1.52, ck);
    J.L.sh.rotation.y = lerp(J.L.sh.rotation.y, -0.15, ck);
    J.L.sh.rotation.z = lerp(J.L.sh.rotation.z, 0.12, ck);
    J.L.el.rotation.x = lerp(J.L.el.rotation.x, -0.06, ck);
    J.L.ha.rotation.x = lerp(J.L.ha.rotation.x, -1.3, ck);
    J.chest.rotation.y += 0.22 * ck;
    J.spine.rotation.x += 0.05 * ck;
    J.neck.rotation.y -= 0.18 * ck;
  }

  // ---- Getroffen: kurzer Ruck nach hinten ----
  if (u.hurt >= 0) {
    u.hurt += dt / 0.35;
    if (u.hurt >= 1) u.hurt = -1;
  }
  const hk = env(u.hurt, 0.15, 0.7);
  if (hk > 0) {
    J.spine.rotation.x -= 0.22 * hk;
    J.neck.rotation.x -= 0.15 * hk;
    J.pose.position.y -= 0.03 * hk;
  }

  // ---- Blinzeln: unregelmäßig alle 2–7 s, und bei einer schnellen Drehung ----
  u.blinkAt -= dt;
  if (u.lastRy !== null && Math.abs(Math.atan2(Math.sin(ry - u.lastRy), Math.cos(ry - u.lastRy))) > 0.6 && u.blink < 0) u.blinkAt = 0;
  u.lastRy = ry;
  if (u.blinkAt <= 0) { u.blink = 0; u.blinkAt = 2 + Math.random() * 5; }
  if (u.blink >= 0) {
    u.blink += dt / 0.14;
    if (u.blink >= 1) u.blink = -1;
  }
  const shut = u.ko ? 1 : (u.blink >= 0 ? 1 - Math.abs(u.blink * 2 - 1) : 0);
  J.lids.rotation.x = LID_OPEN + (LID_SHUT - LID_OPEN) * shut;

  // ---- Blick: kleine, schnelle Sprünge, dazwischen ruhig ----
  const g = u.gaze;
  if (t >= g.next) {
    const amp = Math.min(0.3, -Math.log(1 - Math.random() * 0.95) * 0.1);
    const a = Math.random() * Math.PI * 2;
    g.tx = Math.cos(a) * amp + J.head.rotation.y * 0.6;
    g.ty = Math.sin(a) * amp * 0.55;
    if (Math.random() < 0.4) { g.tx *= 0.3; g.ty *= 0.3; }           // oft zurück geradeaus
    g.next = t + 0.5 + Math.random() * 2.5;
  }
  const gk = damp(38, dt);
  g.x = lerp(g.x, u.ko ? 0 : g.tx, gk);
  g.y = lerp(g.y, u.ko ? 0 : g.ty, gk);
  for (const e of J.eyes) { e.rotation.y = g.x; e.rotation.x = -g.y; }

  // ---- Zopf schwingt mit ----
  if (J.tail) {
    J.tail.rotation.x = 0.2 + A * (0.25 + 0.15 * Rn) + 0.1 * Math.cos(2 * ph) * A - J.spine.rotation.x * 0.5;
    J.tail.rotation.z = 0.16 * sL * A + 0.03 * Math.sin(t * 1.3) * idle;
  }

  // ---- Bogensehne folgt der rechten Hand ----
  const bow = u.gear[w];
  if (bow && bow.userData.bow) {
    const bu = bow.userData;
    const pull = isBow(w) && p >= 0 ? curve(p, [[0, 0], [0.15, 0.25], [0.45, 1], [0.6, 1], [0.64, 0], [1, 0]]) : 0;
    if (pull > 0.02) {
      model.updateMatrixWorld(true);
      J.R.ha.localToWorld(_hand.set(0, -0.06, 0));
      bow.worldToLocal(_hand);
      _hand.lerp(bu.rest, 1 - pull);
      setStringTo(bow, _hand);
      bu.arrow.visible = pull > 0.3;
      if (bu.arrow.visible) {
        stretch(bu.arrow, _hand, ARROW_AIM);
        bu.arrow.scale.set(1, 1, 1);
      }
    } else {
      setStringTo(bow, bu.rest);
      bu.arrow.visible = false;
    }
  }
}

// Kopfformen beider Geschlechter schon vorbereiten, solange das Anmeldefenster offen ist
for (const [sex, ms] of [['m', 400], ['f', 900]]) {
  setTimeout(() => {
    try { buildParts(normLook({ sex }), 0x777777); } catch (err) { /* nur Vorarbeit */ }
  }, ms);
}
