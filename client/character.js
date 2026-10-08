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

// Lathe aus einem Profil [[radius, höhe], …], von unten nach oben; danach elliptisch skaliert
function lathe(profile, sx = 1, sz = 1, seg = 18) {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => V2(Math.max(r, 0.0001), y)), seg);
  g.scale(sx, 1, sz);
  g.computeVertexNormals();
  return g;
}

// Glied: oben eine Kugel mit r1 am Gelenk (y = 0), unten eine mit r2 bei y = -len
function limbGeo(r1, r2, len, sx = 1, sz = 1, seg = 10) {
  const pts = [];
  const n = 4;
  for (let i = 0; i <= n; i++) {                 // untere Halbkugel
    const a = -Math.PI / 2 + (i / n) * (Math.PI / 2);
    pts.push([r2 * Math.cos(a), -len + r2 * Math.sin(a)]);
  }
  for (let i = 0; i <= n; i++) {                 // obere Halbkugel
    const a = (i / n) * (Math.PI / 2);
    pts.push([r1 * Math.cos(a), r1 * Math.sin(a)]);
  }
  return lathe(pts, sx, sz, seg);
}

function ellipsoid(rx, ry, rz, w = 12, h = 8) {
  const g = new THREE.SphereGeometry(1, w, h);
  g.scale(rx, ry, rz);
  g.computeVertexNormals();
  return g;
}

// Ausschnitt einer Kugel (für Haare, Bart): phi um die Hochachse, theta von oben
function shell(r, phiStart, phiLen, thetaStart, thetaLen, w = 22, h = 12) {
  const g = new THREE.SphereGeometry(r, w, h, phiStart, phiLen, thetaStart, thetaLen);
  g.computeVertexNormals();
  return g;
}

const M4 = () => new THREE.Matrix4();
function at(x, y, z, rx = 0, ry = 0, rz = 0, s = 1) {
  const m = M4();
  m.compose(new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(s, s, s));
  return m;
}

// Mehrere Formen zu einem Netz verschmelzen; Farbe fest oder als Funktion des Orts
function merge(parts) {
  const geos = parts.map((p) => {
    let g = p.geo.clone();
    if (p.m) g.applyMatrix4(p.m);
    if (p.deform) {
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const v = p.deform(pos.getX(i), pos.getY(i), pos.getZ(i));
        pos.setXYZ(i, v[0], v[1], v[2]);
      }
      g.computeVertexNormals();            // noch mit gemeinsamen Eckpunkten: weiche Normalen
    }
    if (g.index) {
      const flat = g.toNonIndexed();
      g.dispose();
      g = flat;
    }
    return { g, color: p.color };
  });
  let total = 0;
  for (const { g } of geos) total += g.attributes.position.count;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  const c = new THREE.Color();
  let o = 0;
  for (const { g, color: col } of geos) {
    const pos = g.attributes.position, nor = g.attributes.normal;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      position[o * 3] = x; position[o * 3 + 1] = y; position[o * 3 + 2] = z;
      normal[o * 3] = nor.getX(i); normal[o * 3 + 1] = nor.getY(i); normal[o * 3 + 2] = nor.getZ(i);
      c.setHex(typeof col === 'function' ? col(x, y, z) : col);
      color[o * 3] = c.r; color[o * 3 + 1] = c.g; color[o * 3 + 2] = c.b;
      o++;
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.computeBoundingSphere();
  return out;
}

// Farbe leicht abdunkeln oder aufhellen (für Schattierungen in der Kleidung)
function shade(hex, f) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(f);
  return c.getHex();
}

// ---------------------------------------------------------------------------
//  Körpermaße – männlich und weiblich
// ---------------------------------------------------------------------------
const BODY = {
  m: {
    hip: 1.005, waist: 0.10, chest: 0.25, neck: 0.27, head: 0.09,
    thigh: 0.47, shin: 0.45, upper: 0.30, fore: 0.27,
    shoulderX: 0.19, shoulderY: 0.205, legX: 0.098,
    headR: 0.118, headSY: 1.12, jaw: 0.24, neckR: 0.055,
    torsoSX: 1.16, torsoSZ: 0.68, pelvisR: 0.158, hem: -0.17,
    thighR: [0.098, 0.066], shinR: [0.062, 0.04], upperR: [0.058, 0.044], foreR: [0.046, 0.034],
    torso: [[0.150, 0.00], [0.155, 0.07], [0.170, 0.15], [0.190, 0.25], [0.196, 0.33],
            [0.190, 0.40], [0.165, 0.455], [0.105, 0.50], [0.05, 0.525]],
  },
  f: {
    hip: 0.97, waist: 0.10, chest: 0.23, neck: 0.25, head: 0.085,
    thigh: 0.455, shin: 0.43, upper: 0.28, fore: 0.25,
    shoulderX: 0.163, shoulderY: 0.188, legX: 0.098,
    headR: 0.112, headSY: 1.12, jaw: 0.30, neckR: 0.045,
    torsoSX: 1.10, torsoSZ: 0.70, pelvisR: 0.172, hem: -0.25,
    thighR: [0.096, 0.06], shinR: [0.056, 0.036], upperR: [0.047, 0.036], foreR: [0.038, 0.029],
    torso: [[0.150, 0.00], [0.135, 0.07], [0.130, 0.13], [0.150, 0.22], [0.156, 0.30],
            [0.150, 0.37], [0.125, 0.43], [0.072, 0.475], [0.045, 0.49]],
  },
};

// ---------------------------------------------------------------------------
//  Körperteile als Netze – zwischengespeichert je Aussehen und Kleidungsfarbe
// ---------------------------------------------------------------------------
const CHAR_GEO_CACHE = new Map();

function headDeform(B) {
  // Schädel hinten voller, Kiefer schmaler, Kinn leicht vor
  return (x, y, z) => {
    const r = B.headR;
    const ny = y / (r * B.headSY);
    let nx = x, nz = z;
    if (ny < 0) {
      const k = Math.pow(-ny, 1.4);
      nx *= 1 - B.jaw * k;
      nz *= 1 - 0.10 * k;
      if (z > 0) nz += 0.012 * k;                // Kinn
    }
    if (z < 0) nz *= 1.08;                       // Hinterkopf
    return [nx, y, nz];
  };
}

// Brust und Schulterblätter als sanfte Wölbung der Rumpffläche
function chestShape(female) {
  const g = (v, m, w) => Math.exp(-Math.pow((v - m) / w, 2));
  return (x, y, z) => {
    if (z > 0) {
      const bust = female
        ? 0.05 * g(y, 0.275, 0.065) * g(Math.abs(x), 0.062, 0.05)
        : 0.016 * g(y, 0.31, 0.08) * g(Math.abs(x), 0.07, 0.07);
      return [x, y, z + bust * Math.min(1, z / 0.06)];
    }
    const blades = 0.012 * g(y, 0.36, 0.07) * g(Math.abs(x), 0.08, 0.06);
    return [x, y, z - blades * Math.min(1, -z / 0.06)];
  };
}

function buildParts(look, tunicHex) {
  const key = JSON.stringify(look) + tunicHex;
  if (CHAR_GEO_CACHE.has(key)) return CHAR_GEO_CACHE.get(key);
  const B = BODY[look.sex];
  const female = look.sex === 'f';
  const skin = LOOK_SKIN[look.skin];
  const skinDark = shade(skin, 0.86);
  const hair = LOOK_HAIR[look.hair];
  const tunic = tunicHex;
  const tunicDark = shade(tunic, 0.72);
  const P = {};

  // Becken mit Rock der Tunika und Gürtel
  P.pelvis = merge([
    { geo: lathe([[0.06, -0.13], [0.13, -0.10], [B.pelvisR, -0.03], [B.pelvisR * 0.98, 0.04], [0.15, 0.10]], 1.08, 0.74), color: CLOTH.trousers },
    { geo: lathe([[B.pelvisR * 1.36 + (female ? 0.05 : 0), B.hem], [B.pelvisR * 1.25, B.hem + 0.06],
                  [B.pelvisR * 1.12, -0.04], [0.16, 0.05], [0.155, 0.11]], 1.1, 0.8, 22),
      color: (x, y) => (y < B.hem + 0.025 ? tunicDark : tunic) },
    { geo: new THREE.TorusGeometry(0.162, 0.022, 5, 18).rotateX(Math.PI / 2), m: at(0, 0.075, 0), color: CLOTH.leather,
      deform: (x, y, z) => [x * 1.08, y, z * 0.78] },
    { geo: ellipsoid(0.03, 0.026, 0.012, 6, 4), m: at(0, 0.075, 0.128), color: CLOTH.brass },
    { geo: ellipsoid(0.04, 0.05, 0.022, 8, 6), m: at(-0.13, 0.03, 0.06, 0, -0.5), color: CLOTH.leatherDark },   // Gürteltasche
  ]);

  // Rumpf mit Tunika, Kragen, (Brust) und Rucksack mit Deckenrolle
  const torso = [
    { geo: lathe(B.torso, B.torsoSX, B.torsoSZ, 24), deform: chestShape(female), color: (x, y) => (y > B.torso[B.torso.length - 3][1] + 0.02 && Math.abs(x) < 0.07 ? skin : tunic) },
    { geo: new THREE.TorusGeometry(0.06, 0.016, 6, 16).rotateX(Math.PI / 2), m: at(0, B.torso[B.torso.length - 2][1] - 0.01, 0.006), color: tunicDark,
      deform: (x, y, z) => [x * 1.25, y, z * 1.1] },
    { geo: new THREE.BoxGeometry(0.30, 0.34, 0.13), m: at(0, 0.27, -0.19), color: CLOTH.leather },
    { geo: new THREE.BoxGeometry(0.24, 0.12, 0.02), m: at(0, 0.36, -0.115), color: CLOTH.leatherDark },
    { geo: new THREE.CylinderGeometry(0.06, 0.06, 0.36, 12).rotateZ(Math.PI / 2), m: at(0, 0.47, -0.19), color: 0x6d6250 },
    // Nacken und Schulteransatz: weicher Übergang vom Hals zu den Schultern
    { geo: ellipsoid(female ? 0.13 : 0.16, 0.055, 0.075), m: at(0, female ? 0.43 : 0.455, -0.012), color: tunic },
    // Schulterriemen des Rucksacks, über die Schultern nach hinten
    { geo: new THREE.TorusGeometry(0.075, 0.012, 5, 14, Math.PI), m: at(-0.105, female ? 0.42 : 0.445, -0.06, 0, Math.PI / 2, 0), color: CLOTH.leatherDark },
    { geo: new THREE.TorusGeometry(0.075, 0.012, 5, 14, Math.PI), m: at(0.105, female ? 0.42 : 0.445, -0.06, 0, Math.PI / 2, 0), color: CLOTH.leatherDark },
  ];
  P.torso = merge(torso);

  P.neck = merge([{ geo: limbGeo(B.neckR, B.neckR * 1.15, 0.12), m: at(0, 0.12, 0), color: skin }]);

  // Kopf: Schädel, Ohren, Nase, Lippen, Augenbrauen – Augen sind ein eigenes Netz (Blinzeln)
  const r = B.headR;
  const hd = headDeform(B);
  const head = [
    { geo: ellipsoid(r, r * B.headSY, r * 1.0, 22, 16), color: skin, deform: hd },
    { geo: ellipsoid(0.018, 0.034, 0.012, 8, 6), m: at(r * 0.97, 0.0, -0.005, 0, 0.3), color: skinDark },
    { geo: ellipsoid(0.018, 0.034, 0.012, 8, 6), m: at(-r * 0.97, 0.0, -0.005, 0, -0.3), color: skinDark },
    { geo: new THREE.ConeGeometry(0.019, 0.055, 8).rotateX(Math.PI / 2 + 0.35), m: at(0, -0.012, r * 0.93), color: skin },
    { geo: ellipsoid(0.017, 0.013, 0.014, 8, 6), m: at(0, -0.032, r * 1.0), color: skin },
    { geo: ellipsoid(0.032, female ? 0.009 : 0.007, 0.01, 10, 5), m: at(0, -0.068, r * 0.9), color: CLOTH.lips },
    { geo: new THREE.BoxGeometry(0.042, female ? 0.007 : 0.011, 0.012), m: at(-0.043, 0.045, r * 0.94, 0, 0.25, 0.10), color: hair },
    { geo: new THREE.BoxGeometry(0.042, female ? 0.007 : 0.011, 0.012), m: at(0.043, 0.045, r * 0.94, 0, -0.25, -0.10), color: hair },
  ];

  // Haare
  const capR = r * 1.07;
  const fit = (f, fz = f) => (x, y, z) => { const v = hd(x / f, (y * B.headSY) / f, z / f); return [v[0] * f, v[1] * f, v[2] * fz]; };
  const capDeform = fit(1.07);
  const cap = (back = -0.38, len = 0.52) => ({ geo: shell(capR, 0, Math.PI * 2, 0, Math.PI * len, 20, 9), m: at(0, 0.006, -0.004, back), color: hair, deform: capDeform });
  const tail = [];
  const s = look.style;
  if (!female) {
    head.push(cap(-0.42, 0.5));
    if (s === 2) head.push({ geo: new THREE.CylinderGeometry(r * 1.0, r * 1.08, 0.24, 18, 1, true, Math.PI / 2 - 0.25, Math.PI + 0.5), m: at(0, -0.07, -0.01), color: hair, deform: (x, y, z) => [x, y, z * 0.95] });
    if (s === 1) tail.push({ geo: limbGeo(0.03, 0.018, 0.2), color: hair }, { geo: new THREE.TorusGeometry(0.03, 0.009, 5, 10).rotateX(Math.PI / 2), color: CLOTH.leather });
    if (look.beard) {
      head.push({ geo: shell(r * 1.045, Math.PI / 2 - 1.55, 3.1, Math.PI * 0.69, Math.PI * 0.27, 18, 5), color: hair, deform: fit(1.045, 1.09) });
      head.push({ geo: ellipsoid(0.036, 0.009, 0.014, 8, 5), m: at(0, -0.052, r * 0.96, 0, 0, 0), color: hair });
    }
  } else {
    head.push(cap(-0.42, 0.55));
    if (s === 0) {
      head.push({ geo: new THREE.CylinderGeometry(r * 1.02, r * 1.2, 0.42, 20, 1, true, Math.PI / 2 - 0.35, Math.PI + 0.7), m: at(0, -0.17, -0.012), color: hair, deform: (x, y, z) => [x, y, z * 0.92] });
      head.push({ geo: ellipsoid(0.03, 0.12, 0.03, 8, 6), m: at(-r * 0.88, -0.08, 0.035, 0.1), color: hair });
      head.push({ geo: ellipsoid(0.03, 0.12, 0.03, 8, 6), m: at(r * 0.88, -0.08, 0.035, 0.1), color: hair });
    }
    if (s === 1) tail.push({ geo: limbGeo(0.038, 0.02, 0.3), color: hair }, { geo: new THREE.TorusGeometry(0.036, 0.01, 5, 10).rotateX(Math.PI / 2), color: CLOTH.leather });
    if (s === 2) {
      head.push({ geo: ellipsoid(0.068, 0.06, 0.06, 14, 10), m: at(0, 0.075, -0.115), color: hair });
      head.push({ geo: new THREE.TorusGeometry(0.05, 0.01, 5, 12), m: at(0, 0.06, -0.09, 0.6), color: CLOTH.leather });
    }
  }
  P.head = merge(head);
  P.tail = tail.length ? merge(tail) : null;

  // Augen: Weiß und Iris, beide in einem Netz
  P.eyes = merge([-1, 1].flatMap((sx) => [
    { geo: ellipsoid(0.019, 0.013, 0.01, 8, 6), m: at(sx * 0.041, 0.018, r * 0.905), color: CLOTH.white },
    { geo: ellipsoid(0.0095, 0.0095, 0.006, 6, 4), m: at(sx * 0.041, 0.018, r * 0.905 + 0.008), color: CLOTH.iris },
  ]));

  // Arme: Ärmel der Tunika, Haut, Armschiene aus Leder, Hand mit Daumen
  const sleeve = female ? -0.10 : -0.13;
  P.upper = merge([{ geo: limbGeo(B.upperR[0], B.upperR[1], B.upper), color: (x, y) => (y > sleeve ? tunic : skin) },
    { geo: new THREE.TorusGeometry(B.upperR[0] * 1.02, 0.008, 4, 12).rotateX(Math.PI / 2), m: at(0, sleeve, 0), color: tunicDark }]);
  P.fore = merge([{ geo: limbGeo(B.foreR[0], B.foreR[1], B.fore), color: (x, y) => (y < -0.09 && y > -B.fore + 0.02 ? CLOTH.leather : skin) }]);
  P.hand = merge([
    { geo: ellipsoid(female ? 0.032 : 0.036, 0.055, female ? 0.017 : 0.019, 10, 6), m: at(0, -0.05, 0.004), color: skin },
    { geo: limbGeo(0.011, 0.009, 0.045), m: at(0, -0.02, 0.02, -0.5, 0, 0), color: skin },
  ]);

  // Beine: Hose, Stiefel mit Stulpe, Fuß mit flacher Sohle
  P.thigh = merge([{ geo: limbGeo(B.thighR[0], B.thighR[1], B.thigh), color: CLOTH.trousers,
    deform: (x, y, z) => { const k = Math.exp(-Math.pow((y + B.thigh * 0.35) / (B.thigh * 0.3), 2)); return [x, y, z > 0 ? z * (1 + 0.15 * k) : z]; } }]);
  const boot = -B.shin * 0.45;
  P.shin = merge([
    { geo: limbGeo(B.shinR[0], B.shinR[1] * 1.12, B.shin), color: (x, y) => (y < boot ? CLOTH.leather : CLOTH.trousers),
      deform: (x, y, z) => { const k = Math.exp(-Math.pow((y + B.shin * 0.3) / (B.shin * 0.2), 2)); return [x * (1 + 0.12 * k), y, z < 0 ? z * (1 + 0.3 * k) : z]; } },
    { geo: new THREE.TorusGeometry(B.shinR[0] * 1.12, 0.012, 4, 12).rotateX(Math.PI / 2), m: at(0, boot, 0), color: CLOTH.leatherDark },
  ]);
  P.foot = merge([
    { geo: ellipsoid(female ? 0.045 : 0.052, 0.045, female ? 0.11 : 0.12, 12, 8), m: at(0, -0.02, 0.045), color: CLOTH.leather,
      deform: (x, y, z) => [x, Math.max(y, -0.052), z] },
    { geo: new THREE.BoxGeometry(female ? 0.085 : 0.1, 0.014, female ? 0.21 : 0.235), m: at(0, -0.058, 0.045), color: CLOTH.leatherDark },
  ]);

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
  const head = joint(neck, 0, B.head, 0.005, null);
  const face = joint(head, 0, B.headR * B.headSY * 0.95, 0.012, P.head);   // Kopfmitte
  const eyes = new THREE.Mesh(P.eyes, CHAR_MAT);
  face.add(eyes);
  let tail = null;
  if (P.tail) {
    tail = joint(face, 0, look.sex === 'f' ? 0.05 : 0.03, -B.headR * 1.02, P.tail);
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
  tag.position.y = B.hip + B.waist + B.chest + B.neck + B.head + B.headR * 2.3 + 0.32;
  root.add(tag);

  root.userData = {
    look, tag, gear, shadow,
    j: { pose, hips, spine, chest, neck, head, face, eyes, tail, R, L, RL, LL },
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
  J.eyes.scale.y = u.ko ? 0.12 : (u.blink >= 0 ? 0.12 + 0.88 * Math.abs(u.blink * 2 - 1) : 1);

  // ---- Zopf schwingt mit ----
  if (J.tail) {
    J.tail.rotation.x = 0.45 + A * (0.25 + 0.15 * Rn) + 0.1 * Math.cos(2 * ph) * A - J.spine.rotation.x * 0.5;
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
