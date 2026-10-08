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
const LOOK_STYLES = { m: ['Kurz', 'Zopf', 'Lang'], f: ['Lang', 'Pferdeschwanz', 'Dutt'] };
const LOOK_DEFAULT = { sex: 'm', skin: 1, hair: 1, style: 0, beard: 0 };

function normLook(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const int = (v, max, d) => (Number.isInteger(v) && v >= 0 && v <= max ? v : d);
  const sex = r.sex === 'f' ? 'f' : 'm';
  return {
    sex,
    skin: int(r.skin, LOOK_SKIN.length - 1, LOOK_DEFAULT.skin),
    hair: int(r.hair, LOOK_HAIR.length - 1, LOOK_DEFAULT.hair),
    style: int(r.style, 2, 0),
    beard: sex === 'm' ? int(r.beard, 1, 0) : 0,
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
const FACE = {
  m: { s: 1, chinY: 0.124, taper: 0.34, edge: 0.006, brow: 0.0085, socket: 0.016, nose: 1, alae: 1, lips: 0.85, chin: 1.0, chinW: 0.007, jaw: 1, cheek: 1, maxilla: 0.012 },
  f: { s: 0.95, taper: 0.56, edge: 0.012, brow: 0.003, socket: 0.014, nose: 0.72, alae: 0.75, lips: 1.3, chin: 0.55, chinW: 0.002, jaw: 0.2, cheek: 1.35, maxilla: 0.009, chinY: 0.11 },
};
const EYE = { x: 0.0315, y: 0.0, r: 0.0118 };

function makeHead(sex) {
  const K = FACE[sex];
  const s = K.s;
  const W = 0.0735, Ht = 0.118, Hb = 0.15, Df = 0.094, Db = 0.104;
  const nH = (dz) => 2.05 + 0.45 * sstep(-0.2, 0.5, dz);

  // Grundform in Richtung (dx, dy, dz): Strahl bis zur Fläche
  function base(dx, dy, dz) {
    const n = nH(dz);
    const ax = Math.abs(dx) / W, ay = Math.abs(dy) / (dy > 0 ? Ht : Hb), az = Math.abs(dz) / (dz > 0 ? Df : Db);
    let lo = 0, hi = 0.4;
    for (let i = 0; i < 17; i++) {
      const m = (lo + hi) / 2;
      if (Math.pow(m * ax, n) + (m * ay) * (m * ay) + Math.pow(m * az, n) > 1) hi = m; else lo = m;
    }
    return [dx * lo, dy * lo, dz * lo];
  }

  // Gesichtsrelief nach vorn (z) – in Kopfmaßen (ohne Skalierung)
  function relief(x, y) {
    const ax = Math.abs(x);
    let d = 0;
    d += K.brow * gauss(y - 0.022, 0.011) * gauss(ax - 0.028, 0.026);            // Brauenbogen
    d += 0.004 * gauss(y - 0.016, 0.01) * gauss(x, 0.012);                         // Nasenwurzel
    d -= K.socket * gauss(y - EYE.y, 0.0165) * gauss(ax - EYE.x, 0.0175);          // Augenhöhlen
    // Nase: Rücken wird zur Spitze hin höher und breiter, darunter fällt sie steil ab
    let prof = 0, w = 0.008;
    if (y <= 0.012 && y >= -0.042) {
      const t = (0.012 - y) / 0.054;
      prof = 0.0035 + 0.0275 * Math.pow(t, 1.35);
      w = 0.0068 + 0.0095 * t;
    } else if (y < -0.042) {
      const t = clamp((-0.042 - y) / 0.011, 0, 1);
      prof = lerp(0.031, 0.004, smooth(t));
      w = 0.0163 + 0.004 * t;
    }
    d += K.nose * prof * gauss(x, w);
    d += 0.0085 * K.alae * gauss(y + 0.046, 0.0075) * gauss(ax - 0.0165 * K.nose, 0.0068);   // Nasenflügel
    d += K.maxilla * gauss(y + 0.07, 0.03) * gauss(x, 0.04);                     // Oberkiefer, Mundpartie
    d += 0.0042 * K.lips * gauss(y + 0.0638, 0.0052) * gauss(x, 0.02);            // Oberlippe
    d += 0.0052 * K.lips * gauss(y + 0.0795, 0.0058) * gauss(x, 0.0175);          // Unterlippe
    d -= 0.0022 * gauss(y + 0.0716, 0.0022) * gauss(x, 0.024);                    // Mundspalte
    d -= 0.0028 * gauss(y + 0.0905, 0.0055) * gauss(x, 0.024);                    // Kinnfurche
    d += 0.022 * K.chin * gauss(y + K.chinY - 0.016, 0.016) * gauss(ax - K.chinW, 0.019);   // Kinn
    d += 0.006 * K.cheek * gauss(y + 0.026, 0.026) * gauss(ax - 0.046, 0.02);     // Wangen
    d += 0.002 * gauss(y + 0.058, 0.009) * gauss(ax - 0.028, 0.006);              // Mundwinkel-Wulst
    return d;
  }

  // Seitliches Relief (x, nach außen)
  function side(y, z) {
    let d = 0;
    d += 0.0055 * K.cheek * gauss(y + 0.008, 0.016) * gauss(z - 0.046, 0.024);    // Wangenknochen
    d -= 0.004 * gauss(y - 0.04, 0.02) * gauss(z - 0.042, 0.03);                  // Schläfe
    d += 0.0075 * K.jaw * gauss(y + 0.078, 0.02) * gauss(z + 0.004, 0.028);       // Kieferwinkel
    d -= 0.002 * K.jaw * gauss(y + 0.05, 0.014) * gauss(z - 0.04, 0.02);         // Wange unter dem Knochen
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
    // Relief
    const wf = sstep(0.025, 0.07, z);
    z += wf * relief(x, y);
    x += Math.sign(x) * side(y, z);
    return [x * s, y * s, z * s];
  }

  // Fläche des Gesichts an (x, y) – zum Einpassen der Augen
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

// Haaransatz: Höhe über der Augenlinie je nach Winkel um den Kopf (0 = vorn)
const HAIRLINE = {
  m: [[0, 0.062], [0.5, 0.058], [0.95, 0.042], [1.22, 0.03], [1.36, -0.022], [1.5, -0.03], [1.6, 0.014], [1.95, 0.01], [2.25, -0.04], [2.65, -0.066], [Math.PI, -0.075]],
  f: [[0, 0.064], [0.5, 0.06], [0.95, 0.045], [1.22, 0.032], [1.38, 0.0], [1.5, -0.01], [1.62, 0.012], [1.95, 0.008], [2.25, -0.045], [2.65, -0.07], [Math.PI, -0.08]],
};

// Linie über den Winkel um den Kopf (0 = vorn, ±π hinten) als Tabelle – schnell abzufragen
function table(fn, n = 256) {
  const t = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) t[i] = fn((i / n) * Math.PI);
  return (a) => {
    const f = Math.min(1, Math.abs(a) / Math.PI) * n;
    const i = Math.min(n - 1, Math.floor(f));
    return t[i] + (t[i + 1] - t[i]) * (f - i);
  };
}

const HEAD_PTS = {};
const HEAD_FN = {};
function headShape(sex) {
  if (!HEAD_FN[sex]) HEAD_FN[sex] = makeHead(sex);
  return HEAD_FN[sex];
}
function headPoints(sex, H) {
  if (!HEAD_PTS[sex]) {
    const G = HEAD_GRID, out = [];
    for (let j = 0; j <= G.nv; j++) {
      for (let i = 0; i < G.nu; i++) {
        const d = HEAD_DIR(G.u[i], G.v[j]);
        out.push(H.point(d[0], d[1], d[2]));
      }
    }
    HEAD_PTS[sex] = out;
  }
  return HEAD_PTS[sex];
}

// Abstand eines Punkts zu einer Linie um den Kopf (Höhe je Winkel), quer zur Linie gemessen –
// so laufen auch steile Stellen (Koteletten, Schläfen) gleichmäßig weich aus
function lineDist(x, y, z, line) {
  const phi = Math.atan2(x, z);
  const r = Math.max(0.03, Math.hypot(x, z));
  const l0 = line(phi);
  let best = Math.abs(y - l0);
  // kürzester Abstand zu Nachbarstellen der Linie (Bogenlänge auf dem Kopf)
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

// Kopf mit Gesicht, Haaren und Bart – Farben und Formen aus dem Aussehen
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
function recolor(shape, under, top) {
  const n = shape.k.length;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) putColor(col, i, mix(under, shade(top, shape.f[i]), shape.k[i]));
  return withColors(shape.geo, col);
}
// Form der Kopfhaut je Geschlecht (ohne Farben)
function headBase(sex, H) {
  return cached(`head|${sex}`, () => {
    const pts = headPoints(sex, H), G = HEAD_GRID;
    return gridSurface(G.nu, G.nv, (u, v) => {
      const p = pts[Math.round(v * G.nv) * G.nu + Math.round(u * G.nu)];
      return [p[0], p[1], p[2], 0];
    });
  });
}
// Schicht über der Haut (Haare, Bart): an der Kopfform entlang nach außen versetzt.
// mask 0…1 bestimmt Dicke und Deckung; Dreiecke ohne Haar fallen weg.
function layerShape(base, s, mask, thick) {
  const G = HEAD_GRID;
  const hp = base.attributes.position, hn = base.attributes.normal;
  const n = hp.count;
  const m = new Float32Array(n), f = new Float32Array(n);
  const g = gridSurface(G.nu, G.nv, (u, v) => {
    const i = Math.round(v * G.nv) * G.nu + Math.round(u * G.nu) % G.nu;
    const x = hp.getX(i), y = hp.getY(i), z = hp.getZ(i);
    const X = x / s, Y = y / s, Z = z / s;
    const k = mask(X, Y, Z);
    m[i] = k;
    const phi = Math.atan2(X, Z);
    f[i] = 0.9 + 0.07 * Math.sin(phi * 61 + Y * 30) + 0.05 * Math.sin(phi * 23 - Y * 55);   // Strähnen
    const t = k > 0 ? 0.0004 + thick(X, Y, Z) * k * k : 0;
    return [x + hn.getX(i) * t, y + hn.getY(i) * t, z + hn.getZ(i) * t, 0];
  }, (a, b, c) => Math.min(m[a], m[b], m[c]) > 0.002);
  g.deleteAttribute('color');
  g.setAttribute('normal', new THREE.BufferAttribute(hn.array.slice(), 3));   // gleiche Beleuchtung wie die Haut darunter
  const k = m.map((v) => sstep(0.22, 0.85, v));     // Rand hautfarben, damit die Dreieckskante nicht auffällt
  return { geo: g, k, f };
}
function buildHead(look, skin, hair) {
  const key = JSON.stringify(look);
  if (!HEAD_CACHE.has(key)) HEAD_CACHE.set(key, buildHeadNow(look, skin, hair));
  return HEAD_CACHE.get(key);
}
function buildHeadNow(look, skin, hair) {
  const H = headShape(look.sex);
  const female = look.sex === 'f';
  const s = H.s;
  const G = HEAD_GRID;
  const red = mix(skin, 0xc4524a, 0.22);
  const lipCol = female ? mix(skin, 0xb04452, 0.62) : mix(skin, 0x9a4f45, 0.4);

  const skinColor = (x, y, z) => {
    const X = x / s, Y = y / s, ax = Math.abs(X);
    if (z / s < 0.01) return Y < -0.1 ? shade(skin, 1 - 0.16 * sstep(-0.1, -0.124, Y)) : skin;   // Hinterkopf: nichts zu malen
    let c = skin;
    c = mix(c, red, 0.5 * gauss(ax - 0.046, 0.02) * gauss(Y + 0.028, 0.024));    // Wangen
    c = mix(c, red, 0.45 * gauss(X, 0.012) * gauss(Y + 0.04, 0.012));             // Nasenspitze
    // Lippen
    const up = (ax / 0.0235) ** 2 + ((Y + 0.065) / 0.0062) ** 2;
    const lo = (ax / 0.0195) ** 2 + ((Y + 0.0785) / 0.0072) ** 2;
    c = mix(c, lipCol, 1 - sstep(0.6, 1.25, Math.min(up, lo)));
    c = mix(c, shade(lipCol, 0.45), 0.85 * gauss(Y + 0.0716, 0.0016) * gauss(X, 0.021));   // Mundspalte
    // Schatten: Augenhöhle, unter der Nase, unter dem Kinn
    let ao = 1;
    ao -= 0.1 * gauss(ax - EYE.x, 0.016) * gauss(Y - 0.004, 0.014);
    ao -= 0.35 * gauss(ax - 0.0085, 0.004) * gauss(Y + 0.0505, 0.0035);          // Nasenlöcher
    ao -= 0.12 * gauss(X, 0.012) * gauss(Y + 0.054, 0.004);
    ao -= 0.16 * sstep(-0.1, -0.124, Y) * (1 - sstep(0.03, 0.08, z / s));         // unter dem Kiefer
    return shade(c, ao);
  };

  // Kopfhaut: Form je Geschlecht, Farbe je Hautton – beides zwischengespeichert
  const base = headBase(look.sex, H);
  const head = cached(`skin|${look.sex}|${look.skin}`, () => {
    const pos = base.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) putColor(col, i, skinColor(pos.getX(i), pos.getY(i), pos.getZ(i)));
    return withColors(base, col);
  });
  const parts = [{ geo: head }];
  const st = look.style;
  const longHair = female ? st === 0 : st === 2;

  // Haare auf dem Kopf
  const scalp = cached(`hair|${look.sex}|${st}`, () => {
    const hl = HAIRLINE[look.sex];
    const scalpLine = table((a) => {
      const l = piecewise(hl, a);
      return longHair && a > 1.3 ? Math.min(l, -0.05) : l;               // lange Haare bedecken die Ohren
    });
    return layerShape(base, s,
      (x, y, z) => sstep(-0.006, 0.024, lineDist(x, y, z, scalpLine)),
      (x, y, z) => {
        let t = (female ? 0.006 : 0.0045) + (female ? 0.011 : 0.0085) * sstep(-0.02, 0.1, y);
        if (longHair) t += 0.004;
        if (!female && st === 0) t += 0.002 * sstep(0.04, 0.0, z);          // kurz: oben etwas voller
        if (female) t *= 1 - 0.3 * gauss(x - 0.016, 0.005) * sstep(0.06, 0.1, y) * sstep(-0.03, 0.03, z);   // Scheitel
        return t;
      });
  });
  parts.push({ geo: recolor(scalp, skin, hair) });

  // Bart: Kinn, Kiefer, Oberlippe – Lippen bleiben frei
  if (!female && look.beard) {
    const beard = cached('beard', () => {
      const beardLine = table((a) => piecewise([[0, -0.051], [0.3, -0.049], [0.55, -0.056], [0.85, -0.042], [1.2, -0.022], [1.4, -0.006], [1.5, -0.01], [1.62, -0.07]], a));
      return layerShape(base, s,
        (x, y, z) => {
          if (y > 0.01) return 0;
          let k = sstep(0.006, -0.012, lineDist(x, y, z, beardLine));
          if (y < -0.064 && z > -0.03) k = Math.max(k, sstep(-0.064, -0.08, y) * sstep(-0.03, 0.0, z));   // unter dem Kiefer
          const lips = (x / 0.027) ** 2 + ((y + 0.0718) / 0.0118) ** 2;
          return k * sstep(0.85, 1.35, lips);
        },
        (x, y) => 0.004 + 0.0075 * sstep(-0.075, -0.125, y));
    });
    parts.push({ geo: recolor(beard, skin, shade(hair, 0.92)) });
  }

  // Lange Haare fallen hinten und seitlich herab
  if (longHair) {
    const drape = cached(`drape|${look.sex}`, () => {
      const end = female ? -0.215 : -0.135;
      const span = female ? 1.12 : 1.3;                  // ab diesem Winkel (vorn = 0) beginnt der Vorhang
      const nu = 40, nv = 16;
      const pos = [], idx = [];
      const f = [];
      for (let j = 0; j <= nv; j++) {
        for (let i = 0; i <= nu; i++) {
          const phi = span + (i / nu) * (Math.PI * 2 - 2 * span);
          const t = j / nv;
          const yRel = lerp(0.085, end, t);
          const d = H.point(Math.sin(phi), Math.max(yRel, -0.06) / (yRel > 0 ? 0.1 : 0.12), Math.cos(phi));   // Kopfhaut in dieser Richtung
          const r0 = Math.hypot(d[0], d[2]) / s;
          const below = sstep(-0.04, end, yRel);
          const r = r0 + lerp(0.006, 0.013, sstep(0.085, 0.03, yRel)) + 0.016 * below + 0.003 * Math.sin(phi * 13 + t * 3) * below;
          let x = Math.sin(phi) * r, z = Math.cos(phi) * r;
          z -= 0.012 * below;
          x *= 1 - 0.08 * below;
          pos.push(x * s, yRel * s, z * s);
          f.push(0.88 + 0.08 * Math.sin(phi * 47 + t * 2) + 0.04 * Math.sin(phi * 19) + 0.06 * t);
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
    if (female) {        // zwei Strähnen vorn, die das Gesicht rahmen
      for (const sx of [-1, 1]) {
        parts.push({ geo: limbShape(0.17, [[0, 0.016], [0.5, 0.019], [1, 0.012]], 1.4, 0.8, 8), m: at(sx * 0.071 * s, 0.03 * s, 0.012 * s, 0.05, 0, sx * 0.05), color: shade(hair, 0.95) });
      }
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
    if (sx < 0) {                                   // gespiegelt: Dreiecke umdrehen
      const ix = ear.index;
      for (let i = 0; i < ix.count; i += 3) { const t = ix.getX(i); ix.setX(i, ix.getX(i + 2)); ix.setX(i + 2, t); }
    }
    ear.computeVertexNormals();
    const cx = c[0] + sx * 0.003 * s;
    parts.push({ geo: ear, m: at(cx - sx * 0.002 * s, c[1] + 0.004 * s, c[2] + 0.006 * s, 0, sx * 0.22, sx * 0.05, s),
      color: (x, y, z) => shade(mix(skin, red, 0.2), 1 - 0.18 * gauss(y - c[1] - 0.004 * s, 0.012) * gauss(z - c[2] - 0.006 * s, 0.009)) });
  }

  // Augenbrauen: flacher, sich verjüngender Strang entlang des Brauenbogens
  for (const sx of [-1, 1]) {
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const x = 0.011 + 0.04 * t;
      const y = 0.0235 + (female ? 0.01 : 0.0055) * Math.sin(Math.PI * Math.min(1, t * 1.15)) - (female ? 0.001 : 0) - 0.004 * t * t;
      pts.push(new THREE.Vector3(sx * x * s, y * s, H.frontZ(x * s, y * s) + 0.0006));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const g = new THREE.TubeGeometry(curve, 14, 1, 6, false);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      // Rohr zu einem flachen Band machen: Dicke nach innen kräftig, außen fein
      const t = Math.floor(i / 7) / 14;
      const c = curve.getPoint(t);
      const w = (female ? 0.0028 : 0.0046) * (1 - 0.55 * t) * s;
      const dx = pos.getX(i) - c.x, dy = pos.getY(i) - c.y, dz = pos.getZ(i) - c.z;
      pos.setXYZ(i, c.x + dx * w, c.y + dy * w * 0.85, c.z + dz * w * 0.22);
    }
    g.computeVertexNormals();
    parts.push({ geo: g, color: shade(hair, 0.9) });
  }

  // Unterlider: schließen die Augen unten ab
  const ez = H.frontZ(EYE.x * s, EYE.y * s) - 0.0045 * s;
  const er = EYE.r * s * (female ? 1.05 : 1);
  for (const sx of [-1, 1]) {
    parts.push({ geo: new THREE.SphereGeometry(er * 1.07, 14, 5, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5),
      m: at(sx * EYE.x * s, EYE.y * s, ez, 0.4, 0, 0), color: shade(skin, 0.94) });
  }

  // Zopf und Dutt
  const extra = [];
  if (!female && st === 1) extra.push({ geo: limbShape(0.2, [[0, 0.028], [0.6, 0.024], [1, 0.016]], 1, 1, 10), color: hair }, { geo: new THREE.TorusGeometry(0.025, 0.006, 5, 10).rotateX(Math.PI / 2), m: at(0, -0.035, 0), color: CLOTH.leather });
  if (female && st === 1) extra.push({ geo: limbShape(0.26, [[0, 0.03], [0.3, 0.028], [0.75, 0.02], [1, 0.01]], 1, 0.85, 10), color: (x, y, z) => shade(hair, 0.92 + 0.08 * Math.sin(Math.atan2(x, z) * 7 + y * 40)) }, { geo: new THREE.TorusGeometry(0.027, 0.007, 5, 10).rotateX(Math.PI / 2), m: at(0, -0.035, 0), color: CLOTH.leather });
  if (female && st === 2) {
    parts.push({ geo: ellipsoid(0.052, 0.046, 0.044, 14, 10), m: at(0, 0.055 * s, -0.105 * s), color: (x, y, z) => shade(hair, 0.92 + 0.08 * Math.sin(Math.atan2(y - 0.05, x) * 9)) });
    parts.push({ geo: new THREE.TorusGeometry(0.04, 0.008, 5, 12), m: at(0, 0.05 * s, -0.082 * s, 0.35), color: CLOTH.leather });
  }

  return {
    head: merge(parts),
    tail: extra.length ? merge(extra) : null,
    H, ez, er,
  };
}
const Z_FRONT = (z, s) => z / s > 0.04;

// Augen: Augapfel mit Iris und Pupille; Oberlider sind ein eigenes Netz (Blinzeln)
const EYE_MAT = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 90, specular: 0x9a9a9a });
function buildEyes(s, ez, er, skin, female) {
  const iris = 0x4a3220;
  const eyes = merge([-1, 1].map((sx) => {
    const cx = sx * EYE.x * s, cy = EYE.y * s;
    return {
      geo: new THREE.SphereGeometry(er, 16, 12), m: at(cx, cy, ez),
      color: (x, y, z) => {
        const d = Math.hypot(x - cx, y - cy);
        if (z < ez + er * 0.8) return 0xe6ddd2;
        if (d < er * 0.21) return 0x0b0a09;
        if (d < er * 0.44) return mix(shade(iris, 1.25), shade(iris, 0.6), d / (er * 0.44));
        if (d < er * 0.5) return 0x2a1d14;
        return 0xe9e1d6;
      },
    };
  }));
  // Oberlid: obere Halbschale, dreht sich um die Augenachse nach unten
  const lash = female ? 0x1a1310 : 0x2e2219;
  const lids = merge([-1, 1].map((sx) => ({
    geo: new THREE.SphereGeometry(er * 1.09, 16, 6, 0, Math.PI * 2, 0, Math.PI * 0.5),
    m: at(sx * EYE.x * s, 0, 0),
    color: (x, y) => (y < er * (female ? 0.13 : 0.08) ? lash : shade(skin, female ? 0.9 : 0.96)),
  })));
  return { eyes, lids };
}

// ---------------------------------------------------------------------------
//  Körpermaße – männlich und weiblich
//  torso: Querschnitte von der Taille (y = 0) bis zum Halsansatz:
//         [höhe, halbe Breite, Tiefe vorn, Tiefe hinten]
// ---------------------------------------------------------------------------
const BODY = {
  m: {
    hip: 1.005, waist: 0.10, chest: 0.25, neck: 0.25, head: 0.098,
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
    hand: 1,
  },
  f: {
    hip: 0.97, waist: 0.10, chest: 0.23, neck: 0.235, head: 0.092,
    thigh: 0.455, shin: 0.43, upper: 0.28, fore: 0.25,
    shoulderX: 0.152, shoulderY: 0.168, legX: 0.098,
    neckR: 0.046, pelvisR: 0.172, hem: -0.25,
    torso: [[0.00, 0.148, 0.088, 0.088], [0.07, 0.132, 0.082, 0.074], [0.13, 0.126, 0.082, 0.072], [0.22, 0.142, 0.09, 0.08],
            [0.30, 0.152, 0.094, 0.085], [0.37, 0.155, 0.09, 0.086], [0.41, 0.145, 0.082, 0.082], [0.44, 0.104, 0.066, 0.07],
            [0.458, 0.06, 0.05, 0.05], [0.47, 0.048, 0.044, 0.045]],
    thighK: [[0, 0.097], [0.12, 0.099], [0.45, 0.084], [0.82, 0.062], [1, 0.058]],
    shinK: [[0, 0.057], [0.22, 0.06], [0.5, 0.05], [0.8, 0.038], [1, 0.036]],
    upperK: [[0, 0.045], [0.14, 0.047], [0.4, 0.043], [0.62, 0.041], [0.88, 0.036], [1, 0.035]],
    foreK: [[0, 0.037], [0.18, 0.04], [0.5, 0.034], [0.85, 0.026], [1, 0.025]],
    hand: 0.88,
  },
};

// Rumpf aus Querschnitten (vorn flacher, an den Seiten kantiger als eine Ellipse)
// Form je Geschlecht; kind (0 Haut, 1 Borte, 2 Tunika) und f (Falten) je Eckpunkt zum Einfärben
function torsoShape(sex) {
  return cached(`torso|${sex}`, () => {
    const kind = [], fac = [];
    const geo = torsoGeo(BODY[sex], sex === 'f', kind, fac);
    geo.deleteAttribute('color');
    return { geo, kind, fac };
  });
}
function torsoColored(sex, tunic, skin) {
  const T = torsoShape(sex);
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
  const B = BODY[look.sex];
  const female = look.sex === 'f';
  const skin = LOOK_SKIN[look.skin];
  const hair = LOOK_HAIR[look.hair];
  const tunic = tunicHex;
  const tunicDark = shade(tunic, 0.72);
  const P = {};

  // Becken mit Rock der Tunika und Gürtel
  P.pelvis = cached(`pelvis|${look.sex}|${tunic}`, () => merge([
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
  P.torso = cached(`torso|${look.sex}|${skin}|${tunic}`, () => merge([
    { geo: torsoColored(look.sex, tunic, skin) },
    { geo: roundBox(0.15, 0.17, 0.065, 3.5), m: at(0, 0.27, -0.165), color: CLOTH.leather },
    { geo: roundBox(0.12, 0.06, 0.012, 3.5), m: at(0, 0.36, -0.096), color: CLOTH.leatherDark },
    { geo: new THREE.CylinderGeometry(0.06, 0.06, 0.36, 14).rotateZ(Math.PI / 2), m: at(0, 0.47, -0.17), color: (x) => (Math.abs(Math.abs(x) - 0.12) < 0.012 ? CLOTH.leatherDark : 0x6d6250) },
    // Schulterriemen über die Schultern nach hinten
    { geo: new THREE.TorusGeometry(0.08, 0.011, 5, 16, Math.PI), m: at(-0.105, strapY - 0.02, -0.03, 0, Math.PI / 2, 0), color: CLOTH.leatherDark },
    { geo: new THREE.TorusGeometry(0.08, 0.011, 5, 16, Math.PI), m: at(0.105, strapY - 0.02, -0.03, 0, Math.PI / 2, 0), color: CLOTH.leatherDark },
  ]));
  P.torsoTop = torsoTop;

  // Hals mit Kehlkopf (Mann) und Nackenmuskeln
  P.neck = cached(`neck|${look.sex}|${skin}`, () => merge([{ geo: limbShape(0.14, [[0, B.neckR], [0.6, B.neckR * 1.04], [1, B.neckR * 1.2]], 1.05, 1, 14,
    (x, y, z, t) => [x, y, z + (female ? 0 : 0.008 * gauss(t - 0.45, 0.12) * gauss(x, 0.012) * (z > 0 ? 1 : 0))]),
    m: at(0, 0.14, 0), color: skin }]));

  // Kopf, Haare, Augen
  const HD = buildHead(look, skin, hair);
  P.head = HD.head;
  P.tail = HD.tail;
  const E = cached(`eyes|${look.sex}|${look.skin}`, () => buildEyes(HD.H.s, HD.ez, HD.er, skin, female));
  P.eyes = E.eyes;
  P.lids = E.lids;
  P.headInfo = { s: HD.H.s, ez: HD.ez, Ht: HD.H.Ht, Db: HD.H.Db };

  // Arme: Ärmel der Tunika, Haut, Armschiene aus Leder, Faust
  const sleeve = female ? -0.10 : -0.13;
  P.upper = cached(`upper|${look.sex}|${skin}|${tunic}`, () => merge([
    { geo: limbShape(B.upper, withCuts(B.upperK, [-sleeve / B.upper]), 1, 1, 14, (x, y, z, t) => [x * (1 + 0.04 * gauss(t - 0.15, 0.12)), y, z * (1 + (z > 0 ? 0.12 : 0.05) * gauss(t - 0.55, 0.2))]),
      color: (x, y) => (y > sleeve ? tunic : skin) },
    { geo: new THREE.TorusGeometry(B.upperK[2][1] * 1.06, 0.007, 4, 14).rotateX(Math.PI / 2), m: at(0, sleeve, 0), color: tunicDark },
  ]));
  P.fore = cached(`fore|${look.sex}|${skin}`, () => merge([{ geo: limbShape(B.fore, withCuts(B.foreK, [0.09 / B.fore, 1 - 0.02 / B.fore, 0.13 / B.fore, 1 - 0.035 / B.fore]), 1.12, 1, 14, (x, y, z, t) => [x, y, z * (1 + 0.1 * gauss(t - 0.2, 0.15)) * (1 - 0.15 * sstep(0.6, 1, t))]),
    color: (x, y) => (y < -0.09 && y > -B.fore + 0.02 ? (Math.abs(y + 0.13) < 0.006 || Math.abs(y + B.fore - 0.035) < 0.006 ? CLOTH.leatherDark : CLOTH.leather) : skin) }]));
  P.hand = cached(`hand|${look.sex}|${skin}`, () => merge(fistParts(skin, B.hand)));

  // Beine: Hose, Stiefel mit Stulpe, Fuß mit Sohle und Absatz
  P.thigh = cached(`thigh|${look.sex}`, () => merge([{ geo: limbShape(B.thigh, B.thighK, 1, 1, 14,
    (x, y, z, t) => [x * (1 + 0.04 * gauss(t - 0.3, 0.2)), y, z * (1 + (z > 0 ? 0.12 : 0.06) * gauss(t - 0.4, 0.25))]),
    color: (x, y) => shade(CLOTH.trousers, 1 - 0.07 * (0.5 + 0.5 * Math.sin(y * 70 + x * 20))) }]));
  const boot = -B.shin * 0.45;
  P.shin = cached(`shin|${look.sex}`, () => merge([
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
  const B = BODY[look.sex];
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
  const eyes = new THREE.Mesh(P.eyes, EYE_MAT);
  face.add(eyes);
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

  // Waffen: Schwert und Dolch in der rechten Hand, Bogen in der linken
  const gear = {};
  for (const k of ['heavy', 'dagger', 'iron_sword', 'iron_dagger']) { gear[k] = makeWeapon(k); R.ha.add(gear[k]); }
  for (const k of ['bow', 'longbow']) { gear[k] = makeWeapon(k); L.ha.add(gear[k]); }

  const tag = makeNameTag(name);
  tag.position.y = B.hip + B.waist + B.chest + B.neck - 0.02 + B.head + 0.066 * HI.s + HI.Ht + 0.3;
  root.add(tag);

  root.userData = {
    look, tag, gear, shadow,
    j: { pose, hips, spine, chest, neck, head, face, eyes, lids, tail, R, L, RL, LL },
    w: 'heavy', walk: 0, amp: 0, run: 0, swing: -1, cast: -1, hurt: -1, ko: false, koT: 0,
    t: Math.random() * 100, blinkAt: 1 + Math.random() * 3, blink: -1,
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
const LID_OPEN = -0.22, LID_SHUT = 0.55;
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

  const bob = A * ((0.025 + 0.035 * Rn) * Math.cos(2 * ph) - 0.035 * Rn);
  J.pose.position.y = bob + 0.004 * breath * idle + down * 0.12;
  J.pose.rotation.x = -Math.PI / 2 * down;
  J.hips.position.x = 0.012 * Math.sin(t * 0.45) * idle;
  J.hips.rotation.z = 0.025 * Math.sin(t * 0.45) * idle + A * 0.04 * cL;
  J.hips.rotation.y = A * (0.12 + 0.06 * Rn) * sL;
  J.spine.rotation.x = A * (0.05 + 0.17 * Rn) + 0.015 * breath * idle;
  J.spine.rotation.y = -A * (0.1 + 0.06 * Rn) * sL;
  J.spine.rotation.z = -J.hips.rotation.z * 0.6;
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

  // ---- Blinzeln ----
  u.blinkAt -= dt;
  if (u.blinkAt <= 0) { u.blink = 0; u.blinkAt = 2.2 + Math.random() * 3.5; }
  if (u.blink >= 0) {
    u.blink += dt / 0.14;
    if (u.blink >= 1) u.blink = -1;
  }
  const shut = u.ko ? 1 : (u.blink >= 0 ? 1 - Math.abs(u.blink * 2 - 1) : 0);
  J.lids.rotation.x = LID_OPEN + (LID_SHUT - LID_OPEN) * shut;

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
setTimeout(() => {
  try {
    for (const sex of ['m', 'f']) buildParts(normLook({ sex }), 0x777777);
  } catch (err) { /* nur Vorarbeit */ }
}, 400);
