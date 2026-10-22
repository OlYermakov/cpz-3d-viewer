import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { loadProject } from './cpz.js';
import { t, getLang, setLang, applyI18n } from './i18n.js';

// Система координат сцени: X = Rechtswert (схід), Y = Hochwert (північ), Z = Höhe (вгору).
// Координати зсунуті до локального початку (центр плану, мінімальна висота) — для точності float32.

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 3) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(d));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const FALLBACK_COLORS = [0xff5555, 0x55ff55, 0x5599ff, 0xffff55, 0xff55ff, 0x55ffff, 0xffaa33, 0xaa77ff];

const state = {
  model: null,
  showLines: true, showPoints: true, showLabels: false, showHeights: false,
  showGrid: true, show2D: true, showDrop: false,
  colorMode: 'layer', zScale: 1, lineWidth: 2, pointSize: 6,
  theme: 'dark', ortho: false, measure: false,
  hover: null, selected: null, measurePts: [],
};

// ---------------------------------------------------------------- Three.js

const viewport = $('viewport');
// Прозорий фон: крізь сцену видно градієнтне сяйво вікна (див. #viewport у index.html).
const renderer = new THREE.WebGLRenderer({ canvas: $('gl'), antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // телефони з DPR 3+ — без зайвого навантаження
renderer.setClearColor(0x000000, 0);
const isTouch = matchMedia('(pointer: coarse)').matches;
const isNarrow = () => vw < 760;
const overlay = $('overlay');
const ctx = overlay.getContext('2d');

const scene = new THREE.Scene();
const modelGroup = new THREE.Group();
scene.add(modelGroup);
let grid = null;

const persp = new THREE.PerspectiveCamera(45, 1, 0.01, 1e6);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1e6);
for (const c of [persp, ortho]) { c.up.set(0, 0, 1); c.position.set(-30, -30, 30); }
let camera = persp;
let orthoHalfH = 20;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.15;
controls.screenSpacePanning = true;
controls.zoomToCursor = true;
controls.addEventListener('change', requestRender);

const lineMaterials = [];
const resolution = new THREE.Vector2(1, 1);
let vw = 1, vh = 1;
let needsRender = true;
function requestRender() { needsRender = true; }

const dotTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.beginPath(); g.arc(32, 32, 28, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

function resize() {
  vw = viewport.clientWidth; vh = viewport.clientHeight;
  renderer.setSize(vw, vh, false);
  const dpr = window.devicePixelRatio;
  overlay.width = Math.round(vw * dpr); overlay.height = Math.round(vh * dpr);
  resolution.set(vw, vh);
  for (const m of lineMaterials) m.resolution.copy(resolution);
  persp.aspect = vw / vh; persp.updateProjectionMatrix();
  updateOrthoFrustum();
  requestRender();
}
function updateOrthoFrustum() {
  const a = vw / vh;
  ortho.left = -orthoHalfH * a; ortho.right = orthoHalfH * a;
  ortho.top = orthoHalfH; ortho.bottom = -orthoHalfH;
  ortho.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $('btnTheme').textContent = t(state.theme === 'dark' ? 'theme.light' : 'theme.dark');
  if (state.model) rebuildScene();
  requestRender();
}

// Колір шару, скоригований під фон (чорний шар CAPLAN на темному фоні — світло-сірий, і навпаки).
function displayColor(rgb) {
  const c = new THREE.Color(rgb);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  if (state.theme === 'dark' && lum < 0.18) return new THREE.Color(0xd4eef8);
  if (state.theme === 'light' && lum > 0.8) return new THREE.Color(0x163444);
  return c;
}

function heightColor(z) {
  const M = state.model;
  const t = M.zRange > 0 ? (z - M.minZ) / M.zRange : 0.5;
  return new THREE.Color().setHSL(0.66 * (1 - t), 0.85, state.theme === 'dark' ? 0.55 : 0.45);
}

// ---------------------------------------------------------------- Модель

function buildModel(project) {
  const cpLayers = project.cp?.layers ?? new Map();
  const layers = new Map();
  const getLayer = (id) => {
    if (!layers.has(id)) {
      const base = cpLayers.get(id);
      layers.set(id, {
        id,
        color: base?.color ?? FALLBACK_COLORS[layers.size % FALLBACK_COLORS.length],
        visible: base?.visible ?? true,
        width: base?.width ?? 1,
        lines: [], points: [], nPts: 0,
      });
    }
    return layers.get(id);
  };

  const all = [...project.points, ...project.lines.flatMap((l) => l.pts)];
  const realZ = all.filter((p) => p.z != null && p.z !== 0).map((p) => p.z);
  const hasRealZ = realZ.length > 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of all) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const minZ = hasRealZ ? Math.min(...realZ) : 0;
  const maxZ = hasRealZ ? Math.max(...realZ) : 0;
  const origin = { x: Math.round((minX + maxX) / 2), y: Math.round((minY + maxY) / 2), z: minZ };

  // Точка без висоти: висота відсутня або рівно 0 серед 3D-даних (напр. QuickLn у CAPLAN).
  const noZ = (p) => p.z == null || (hasRealZ && p.z === 0);
  for (const p of all) {
    p.noZ = noZ(p);
    p.lx = p.x - origin.x; p.ly = p.y - origin.y; p.lz = p.noZ ? 0 : p.z - origin.z;
  }

  for (const p of project.points) { const L = getLayer(p.layer); L.points.push(p); L.nPts++; }
  for (const line of project.lines) {
    const L = getLayer(line.layer);
    line.is2D = line.pts.every((p) => p.noZ);
    let l2 = 0, l3 = 0;
    for (let i = 1; i < line.pts.length; i++) {
      const a = line.pts[i - 1], b = line.pts[i];
      const h = Math.hypot(b.x - a.x, b.y - a.y);
      l2 += h;
      l3 += a.noZ || b.noZ ? NaN : Math.hypot(h, b.z - a.z);
    }
    line.len2D = l2; line.len3D = l3;
    line.closed = line.pts.length > 2 && line.pts[0].name === line.pts.at(-1).name;
    L.lines.push(line); L.nPts += line.pts.length;
  }

  const layerList = [...layers.values()].sort((a, b) => (parseFloat(a.id) - parseFloat(b.id)) || a.id.localeCompare(b.id));
  return {
    name: project.name, header: project.header, sources: project.sources,
    layers, layerList, lines: project.lines, points: project.points,
    origin, minX, maxX, minY, maxY, minZ, maxZ, zRange: maxZ - minZ, hasRealZ,
    nPoints: all.length,
  };
}

// Унікальні точки для вибору/підписів (одна точка може входити в кілька ліній).
let pickPts = [];

function disposeGroup(g) {
  g.traverse((o) => { o.geometry?.dispose(); if (o.material && o.material !== sharedDropMat) o.material.dispose(); });
  g.clear();
}
const sharedDropMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.35 });

function rebuildScene() {
  disposeGroup(modelGroup);
  lineMaterials.length = 0;
  const M = state.model;
  if (!M) return;
  const heightMode = state.colorMode === 'height';
  const gray = new THREE.Color(0x888888);
  const pickMap = new Map();
  const dropPos = [];

  const addPick = (p, L, line) => {
    const key = `${p.name}|${p.x}|${p.y}|${p.z}`;
    let pp = pickMap.get(key);
    if (!pp) { pp = { ...p, layerObj: L, lines: [] }; pickMap.set(key, pp); if (!p.noZ) dropPos.push(p.lx, p.ly, p.lz, p.lx, p.ly, 0); }
    if (line && !pp.lines.includes(line)) pp.lines.push(line);
  };

  for (const L of M.layerList) {
    const g = new THREE.Group();
    g.visible = L.visible;
    L.group = g;
    modelGroup.add(g);
    const baseColor = displayColor(L.color);
    const vcolor = (p) => (p.noZ ? gray : heightColor(p.z));

    const lineMat = new LineMaterial({
      color: heightMode ? 0xffffff : baseColor,
      linewidth: state.lineWidth * Math.max(1, L.width),
      vertexColors: heightMode,
      resolution,
    });
    lineMaterials.push(lineMat);

    const ptPos = [], ptCol = [];
    const pushPt = (p, line) => {
      ptPos.push(p.lx, p.ly, p.lz);
      if (heightMode) { const c = vcolor(p); ptCol.push(c.r, c.g, c.b); }
      addPick(p, L, line);
    };

    for (const line of L.lines) {
      if (line.is2D && !state.show2D) continue;
      const pos = [], cols = [];
      for (const p of line.pts) {
        pos.push(p.lx, p.ly, p.lz);
        if (heightMode) { const c = vcolor(p); cols.push(c.r, c.g, c.b); }
        pushPt(p, line);
      }
      if (line.pts.length >= 2 && state.showLines) {
        const geo = new LineGeometry();
        geo.setPositions(pos);
        if (heightMode) geo.setColors(cols);
        const obj = new Line2(geo, lineMat);
        obj.computeLineDistances();
        g.add(obj);
      }
    }
    for (const p of L.points) {
      if (p.noZ && !state.show2D) continue;
      pushPt(p, null);
    }

    if (ptPos.length && state.showPoints) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(ptPos, 3));
      if (heightMode) geo.setAttribute('color', new THREE.Float32BufferAttribute(ptCol, 3));
      const mat = new THREE.PointsMaterial({
        size: state.pointSize, sizeAttenuation: false, map: dotTexture, alphaTest: 0.5,
        color: heightMode ? 0xffffff : baseColor, vertexColors: heightMode,
      });
      g.add(new THREE.Points(geo, mat));
    }
  }

  if (state.showDrop && dropPos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(dropPos, 3));
    sharedDropMat.color.set(state.theme === 'dark' ? 0x8899aa : 0x667788);
    modelGroup.add(new THREE.LineSegments(geo, sharedDropMat));
  }

  pickPts = [...pickMap.values()];
  modelGroup.scale.z = state.zScale;
  // Посилання на вибрані точки після перебудови
  const relink = (p) => (p ? pickMap.get(`${p.name}|${p.x}|${p.y}|${p.z}`) ?? null : null);
  state.selected = relink(state.selected);
  state.measurePts = state.measurePts.map(relink).filter(Boolean);
  state.hover = null;
  rebuildGrid();
  requestRender();
}

function niceStep(span) {
  const raw = span / 10;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw);
}

function rebuildGrid() {
  if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); grid = null; }
  const M = state.model;
  if (!M || !state.showGrid) return;
  const span = Math.max(M.maxX - M.minX, M.maxY - M.minY, 1);
  const step = niceStep(span);
  const div = Math.ceil((span * 1.4) / step / 2) * 2;
  const dark = state.theme === 'dark';
  grid = new THREE.GridHelper(div * step, div, dark ? 0x1d6f93 : 0x8cc4dc, dark ? 0x0f3a50 : 0xc4e0ec);
  grid.material.transparent = true;
  grid.material.opacity = dark ? 0.75 : 0.9;
  grid.rotation.x = Math.PI / 2; // XZ → XY
  // Вузли сітки на «круглих» координатах
  const cx = (M.minX + M.maxX) / 2, cy = (M.minY + M.maxY) / 2;
  grid.position.set(Math.round(cx / step) * step - M.origin.x, Math.round(cy / step) * step - M.origin.y, 0);
  grid.userData.step = step;
  scene.add(grid);
}

// ---------------------------------------------------------------- Камера

function modelBox() {
  const b = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const p of pickPts) b.expandByPoint(v.set(p.lx, p.ly, p.lz * state.zScale));
  if (b.isEmpty()) b.set(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 5));
  return b;
}

const VIEW_DIRS = {
  top: [0, -1e-3, 1],
  front: [0, -1, 0.0001],
  side: [1, 0, 0.0001],
  iso: [-1, -1, 0.9],
};

function setView(name) {
  const dir = name === 'fit'
    ? camera.position.clone().sub(controls.target).normalize()
    : new THREE.Vector3(...VIEW_DIRS[name]).normalize();
  const box = modelBox();
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
  const narrow = Math.min(1, vw / vh); // у вузькому вікні обмежує ширина, а не висота
  controls.target.copy(c);

  const d = (r / Math.sin(THREE.MathUtils.degToRad(persp.fov / 2)) / narrow) * 1.05;
  persp.position.copy(c).addScaledVector(dir, d);
  persp.near = r / 500; persp.far = r * 500;
  persp.updateProjectionMatrix();

  orthoHalfH = (r / narrow) * 1.05;
  ortho.zoom = 1;
  ortho.position.copy(c).addScaledVector(dir, r * 4);
  ortho.near = r / 500; ortho.far = r * 50;
  updateOrthoFrustum();

  camera.lookAt(c);
  controls.update();
  requestRender();
}

function setOrtho(on) {
  if (on === state.ortho) return;
  state.ortho = on;
  const t = controls.target;
  const dir = camera.position.clone().sub(t).normalize();
  const halfFov = Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
  if (on) {
    const d = persp.position.distanceTo(t);
    orthoHalfH = d * halfFov;
    ortho.zoom = 1;
    const r = Math.max(modelBox().getSize(new THREE.Vector3()).length() / 2, 1);
    ortho.position.copy(t).addScaledVector(dir, Math.max(d, r * 4));
    ortho.near = r / 500; ortho.far = Math.max(d, r * 4) + r * 50;
    updateOrthoFrustum();
    camera = ortho;
  } else {
    const d = orthoHalfH / ortho.zoom / halfFov;
    persp.position.copy(t).addScaledVector(dir, d);
    camera = persp;
  }
  camera.lookAt(t);
  controls.object = camera;
  controls.update();
  $('btnOrtho').classList.toggle('on', on);
  requestRender();
}

// ---------------------------------------------------------------- Оверлей: підписи, вибір, вимірювання, компас

let screenPts = [];
const tmpV = new THREE.Vector3();

function project(p) {
  tmpV.set(p.lx, p.ly, p.lz * state.zScale).project(camera);
  if (tmpV.z < -1 || tmpV.z > 1) return null;
  return { x: (tmpV.x + 1) / 2 * vw, y: (1 - tmpV.y) / 2 * vh, z: tmpV.z };
}

function drawOverlay() {
  const dpr = window.devicePixelRatio;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vw, vh);
  screenPts = [];
  if (!state.model) return;
  const dark = state.theme === 'dark';

  for (const p of pickPts) {
    if (!p.layerObj.visible) continue;
    const s = project(p);
    if (!s || s.x < -50 || s.y < -50 || s.x > vw + 50 || s.y > vh + 50) continue;
    screenPts.push({ p, ...s });
  }

  // Підписи (без накладання: сітка зайнятості)
  if ((state.showLabels || state.showHeights) && screenPts.length < 5000) {
    ctx.font = '11px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const cell = 6, cols = Math.ceil(vw / cell) + 1;
    const occ = new Uint8Array(cols * (Math.ceil(vh / cell) + 1));
    const sorted = [...screenPts].sort((a, b) => a.z - b.z);
    for (const s of sorted) {
      const parts = [];
      if (state.showLabels) parts.push(s.p.name);
      if (state.showHeights) parts.push(s.p.noZ ? '—' : s.p.z.toFixed(2));
      const text = parts.join('  ');
      const w = ctx.measureText(text).width + 4, h = 13;
      const x0 = s.x + 6, y0 = s.y - h / 2 - 6;
      const c0 = Math.max(0, Math.floor(x0 / cell)), c1 = Math.floor((x0 + w) / cell);
      const r0 = Math.max(0, Math.floor(y0 / cell)), r1 = Math.floor((y0 + h) / cell);
      if (c1 >= cols || y0 + h > vh) continue;
      let free = true;
      for (let r = r0; r <= r1 && free; r++) for (let c = c0; c <= c1; c++) if (occ[r * cols + c]) { free = false; break; }
      if (!free) continue;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) occ[r * cols + c] = 1;
      ctx.lineWidth = 3;
      ctx.strokeStyle = dark ? 'rgba(2,12,18,.85)' : 'rgba(240,248,252,.92)';
      ctx.strokeText(text, x0 + 2, y0 + h / 2);
      ctx.fillStyle = dark ? '#bfe6f5' : '#0e3a52';
      ctx.fillText(text, x0 + 2, y0 + h / 2);
    }
  }

  const glowRing = (p, color, r = 7) => {
    const s = project(p);
    if (!s) return null;
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
    ctx.restore();
    return s;
  };
  const MEASURE = dark ? '#8fe6ff' : '#0b8fc8';

  // Вимірювання
  const mp = state.measurePts.map((p) => ({ p, s: glowRing(p, MEASURE, 8) }));
  if (mp.length === 2 && mp[0].s && mp[1].s) {
    const [a, b] = mp.map((m) => m.s);
    ctx.save();
    ctx.shadowColor = MEASURE; ctx.shadowBlur = 10;
    ctx.setLineDash([7, 5]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.lineWidth = 2; ctx.strokeStyle = MEASURE; ctx.stroke();
    ctx.restore();
    const m = measure(mp[0].p, mp[1].p);
    const text = `${fmt(m.slope)} ${t('m')}`;
    ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
    const tw = ctx.measureText(text).width;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    pill(mx - tw / 2 - 10, my - 11, tw + 20, 22, dark);
    ctx.fillStyle = dark ? '#d9f6ff' : '#0b3a52'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, mx, my + 0.5);
    ctx.textAlign = 'start';
  }
  if (state.selected) glowRing(state.selected, dark ? '#2cc2f2' : '#0a7fc0', 8);
  if (state.hover) glowRing(state.hover, dark ? '#e4f6ff' : '#0b2635', 6);

  drawCompass(dark);
}

// Скляна «пігулка» в стилі інтерфейсу
function pill(x, y, w, h, dark) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, dark ? 'rgba(22,120,170,.55)' : 'rgba(255,255,255,.92)');
  g.addColorStop(1, dark ? 'rgba(3,22,36,.85)' : 'rgba(215,236,246,.92)');
  ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2);
  ctx.fillStyle = g; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = dark ? 'rgba(140,220,255,.35)' : 'rgba(20,120,170,.25)'; ctx.stroke();
}

function drawCompass(dark) {
  // На телефоні — компактніше й вище, над рядком стану
  const small = isNarrow();
  const len = small ? 20 : 28;
  const cx = small ? 44 : 56, cy = vh - (small ? 118 : 84);
  const m = camera.matrixWorldInverse;
  const axes = [
    { v: new THREE.Vector3(1, 0, 0), c: dark ? '#ff8a96' : '#d9475a', t: 'E' },
    { v: new THREE.Vector3(0, 1, 0), c: dark ? '#7ef0c2' : '#14a372', t: 'N' },
    { v: new THREE.Vector3(0, 0, 1), c: dark ? '#5fd6ff' : '#0a8fd0', t: 'H' },
  ];
  const g = ctx.createRadialGradient(cx - 10, cy - 14, 4, cx, cy, len + 14);
  g.addColorStop(0, dark ? 'rgba(30,140,190,.45)' : 'rgba(255,255,255,.95)');
  g.addColorStop(1, dark ? 'rgba(3,20,32,.8)' : 'rgba(210,233,244,.9)');
  ctx.beginPath(); ctx.arc(cx, cy, len + 14, 0, Math.PI * 2);
  ctx.fillStyle = g; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = dark ? 'rgba(140,220,255,.3)' : 'rgba(20,120,170,.25)'; ctx.stroke();
  ctx.font = 'bold 11px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const a of axes) {
    const d = a.v.transformDirection(m);
    a.d = d;
  }
  axes.sort((a, b) => a.d.z - b.d.z);
  for (const a of axes) {
    const x = cx + a.d.x * len, y = cy - a.d.y * len;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y);
    ctx.lineWidth = 2.5; ctx.strokeStyle = a.c; ctx.stroke();
    ctx.fillStyle = a.c;
    ctx.fillText(a.t, cx + a.d.x * (len + 8), cy - a.d.y * (len + 8));
  }
  ctx.textAlign = 'start';
  if (grid && state.showGrid) {
    ctx.font = '11px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = dark ? '#7fa6b8' : '#557a8c';
    ctx.textAlign = 'center';
    ctx.fillText(t('grid', { s: grid.userData.step }), cx, cy + len + 28);
    ctx.textAlign = 'start';
  }
}

function pickAt(x, y, radius = 12) {
  let best = null, bestD = radius * radius;
  for (const s of screenPts) {
    const d = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d < bestD - 4 || (best && Math.abs(d - bestD) <= 4 && s.z < best.z)) { best = s; bestD = d; }
  }
  return best?.p ?? null;
}

// ---------------------------------------------------------------- Інформація та вимірювання

function measure(a, b) {
  const dE = b.x - a.x, dN = b.y - a.y;
  const horiz = Math.hypot(dE, dN);
  const has = !a.noZ && !b.noZ;
  const dH = has ? b.z - a.z : NaN;
  let az = Math.atan2(dE, dN) * 180 / Math.PI;
  if (az < 0) az += 360;
  return { dE, dN, horiz, dH, slope: has ? Math.hypot(horiz, dH) : horiz, az, gon: az / 0.9, grade: has && horiz > 0 ? dH / horiz * 100 : NaN };
}

function pointRows(p) {
  return `<dt>${t('pt.name')}</dt><dd><b>${esc(p.name)}</b></dd>
    <dt>${t('pt.layer')}</dt><dd>${esc(p.layer)}</dd>
    <dt>Rechtswert (E)</dt><dd>${fmt(p.x, 4)}</dd>
    <dt>Hochwert (N)</dt><dd>${fmt(p.y, 4)}</dd>
    <dt>Höhe (H)</dt><dd>${p.noZ ? `<span class="muted">${t('pt.noHeight')}</span>` : fmt(p.z, 4)}</dd>
    <dt>W</dt><dd>${p.code}</dd>
    ${p.attrs?.filter(Boolean).length ? `<dt>${t('pt.attrs')}</dt><dd>${esc(p.attrs.filter(Boolean).join(' | '))}</dd>` : ''}`;
}

// Підказки вимірювання: «клікніть» для миші, «торкніться» для дотику
const act = (key) => t(`${key}.${isTouch ? 'tap' : 'click'}`);

function updateInfo() {
  const sec = $('secInfo'), info = $('info');
  const u = t('m');
  if (state.measure) {
    sec.hidden = false;
    $('infoTitle').textContent = t('sec.measure');
    const [a, b] = state.measurePts;
    if (!a) { info.innerHTML = `<div class="muted">${act('m.first')}</div>`; return; }
    if (!b) { info.innerHTML = `<div>A: <b>${esc(a.name)}</b></div><div class="muted">${act('m.second')}</div>`; return; }
    const m = measure(a, b);
    info.innerHTML = `<div style="margin-bottom:6px"><b>${esc(a.name)}</b> → <b>${esc(b.name)}</b></div>
      <div class="res">${fmt(m.slope)} ${u}</div>
      <dl class="kv" style="margin-top:6px">
        <dt>${t('m.slope')}</dt><dd>${fmt(m.slope)} ${u}</dd>
        <dt>${t('m.horiz')}</dt><dd>${fmt(m.horiz)} ${u}</dd>
        <dt>${t('m.dh')}</dt><dd>${Number.isNaN(m.dH) ? '—' : (m.dH >= 0 ? '+' : '') + fmt(m.dH)} ${u}</dd>
        <dt>${t('m.grade')}</dt><dd>${Number.isNaN(m.grade) ? '—' : fmt(m.grade, 2) + ' %'}</dd>
        <dt>ΔE / ΔN</dt><dd>${fmt(m.dE)} / ${fmt(m.dN)}</dd>
        <dt>${t('m.az')}</dt><dd>${fmt(m.az, 4)}° · ${fmt(m.gon, 4)} gon</dd>
      </dl>`;
    return;
  }
  const p = state.selected;
  if (!p) { sec.hidden = true; return; }
  sec.hidden = false;
  $('infoTitle').textContent = t('sec.point');
  const lines = p.lines.map((l) => `<div style="margin-top:6px"><b>${esc(l.name)}</b> <span class="muted">(${l.pts.length} ${t('line.pts')}${l.closed ? ', ' + t('line.closed') : ''}${l.is2D ? ', 2D' : ''})</span><br>
      <span class="muted">${t('line.length')}:</span> ${fmt(l.len2D)} ${u} (${t('line.plan')})${Number.isNaN(l.len3D) ? '' : ` · ${fmt(l.len3D)} ${u} (3D)`}</div>`).join('');
  info.innerHTML = `<dl class="kv">${pointRows(p)}</dl>${lines ? `<div style="margin-top:4px" class="muted">${t('line.lines')}</div>${lines}` : ''}`;
}

// Рядок стану: точка під курсором, інакше вибрана точка / результат вимірювання
// (на телефоні наведення немає, тож це основне місце для координат).
function updateStatus() {
  const p = state.hover ?? (state.measure ? null : state.selected);
  const [a, b] = state.measurePts;
  const u = t('m');
  if (p) {
    $('status').textContent = `${p.name}   E ${fmt(p.x, 4)}   N ${fmt(p.y, 4)}   H ${p.noZ ? '—' : fmt(p.z, 4)}   ${t('st.layer')} ${p.layer}${p.lines.length ? `   ${t('st.line')} ` + p.lines.map((l) => l.name).join(', ') : ''}`;
  } else if (state.measure && b) {
    const m = measure(a, b);
    $('status').textContent = `${a.name} → ${b.name}:  ${fmt(m.slope)} ${u}   ${t('m.horizShort')} ${fmt(m.horiz)} ${u}   ΔH ${Number.isNaN(m.dH) ? '—' : fmt(m.dH)} ${u}`;
  } else if (state.measure) {
    $('status').textContent = a ? `A: ${a.name} — ${act('m.second')}` : act('m.two');
  } else if (state.model) {
    const base = `${state.model.name}  ·  ${pickPts.length} ${t('st.points')}  ·  ${state.model.lines.length} ${t('st.lines')}`;
    $('status').textContent = `${base}  ·  ${t(isTouch ? 'st.tap' : 'st.mouse')}`;
  }
}

// ---------------------------------------------------------------- Бокова панель

function fillFileInfo() {
  const M = state.model;
  const gen = M.header.find((h) => /CAPLAN/i.test(h)) ?? '';
  $('fileInfo').innerHTML = `
    <dt>${t('fi.project')}</dt><dd><b>${esc(M.name)}</b></dd>
    ${gen ? `<dt>${t('fi.created')}</dt><dd>${esc(gen.replace(/^Folgende Daten wurden von\s*/i, '').replace(/\s*erzeugt\.?$/i, ''))}</dd>` : ''}
    <dt>${t('fi.files')}</dt><dd>${esc(M.sources.join(', '))}</dd>
    <dt>${t('fi.points')}</dt><dd>${M.nPoints} (${M.points.length} ${t('fi.standalone')})</dd>
    <dt>${t('fi.lines')}</dt><dd>${M.lines.length}</dd>
    <dt>${t('fi.layers')}</dt><dd>${M.layerList.length}</dd>
    <dt>E</dt><dd>${fmt(M.minX, 2)} … ${fmt(M.maxX, 2)}</dd>
    <dt>N</dt><dd>${fmt(M.minY, 2)} … ${fmt(M.maxY, 2)}</dd>
    <dt>H</dt><dd>${M.hasRealZ ? `${fmt(M.minZ, 2)} … ${fmt(M.maxZ, 2)}` : '—'}</dd>
    <dt>${t('fi.size')}</dt><dd>${fmt(M.maxX - M.minX, 1)} × ${fmt(M.maxY - M.minY, 1)} × ${fmt(M.zRange, 1)} ${t('m')}</dd>`;
}

function fillLayers() {
  const box = $('layers');
  box.innerHTML = '';
  for (const L of state.model.layerList) {
    const row = document.createElement('label');
    row.className = 'layer';
    const c = '#' + displayColor(L.color).getHexString();
    row.innerHTML = `<input type="checkbox" ${L.visible ? 'checked' : ''}><span class="sw" style="background:${c};color:${c}"></span>
      <span class="nm">${esc(L.id)}</span><span class="cnt">${L.lines.length ? `${L.lines.length} ${t('lay.lines')} · ` : ''}${L.nPts} ${t('lay.pts')}</span>`;
    const cb = row.querySelector('input');
    cb.addEventListener('change', () => setLayerVisible(L, cb.checked));
    row.addEventListener('dblclick', (e) => {
      e.preventDefault();
      for (const o of state.model.layerList) setLayerVisible(o, o === L);
      syncLayerChecks();
    });
    L.checkbox = cb;
    box.appendChild(row);
  }
}
function setLayerVisible(L, v) {
  L.visible = v;
  if (L.group) L.group.visible = v;
  if (state.hover && !state.hover.layerObj.visible) state.hover = null;
  requestRender();
}
function syncLayerChecks() { for (const L of state.model.layerList) L.checkbox.checked = L.visible; }

// ---------------------------------------------------------------- Завантаження

async function openInputs(inputs) {
  $('loadErr').textContent = '';
  try {
    const project = await loadProject(inputs);
    state.model = buildModel(project);
    state.selected = null; state.measurePts = []; state.hover = null;
    viewport.classList.add('loaded');
    for (const id of ['secFile', 'secLayers', 'secView']) $(id).hidden = false;
    document.title = `${state.model.name} — CPZ 3D Viewer`;
    fillFileInfo();
    fillLayers();
    rebuildScene();
    setView('iso');
    updateInfo();
    updateStatus();
    setSheet(false);
  } catch (e) {
    console.error(e);
    $('loadErr').textContent = e.message || String(e);
  }
}

async function openFileList(files) {
  const inputs = await Promise.all([...files].map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
  if (inputs.length) await openInputs(inputs);
}

$('btnOpen').addEventListener('click', () => $('fileInput').click());
$('btnOpen2').addEventListener('click', () => $('fileInput').click());
// Android/iOS не знають MIME-типу .cpz і з фільтром робили б файл неактивним у виборі
if (isTouch) $('fileInput').removeAttribute('accept');

// Висувна панель на телефоні
const setSheet = (open) => document.body.classList.toggle('sheet-open', open);
$('btnMenu').addEventListener('click', () => setSheet(!document.body.classList.contains('sheet-open')));
$('btnCloseSheet').addEventListener('click', () => setSheet(false));
$('scrim').addEventListener('click', () => setSheet(false));
$('fileInput').addEventListener('change', (e) => { openFileList(e.target.files); e.target.value = ''; });

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) viewport.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; viewport.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  viewport.classList.remove('dragging');
  if (e.dataTransfer?.files?.length) openFileList(e.dataTransfer.files);
});

// ---------------------------------------------------------------- Взаємодія

const canvas = renderer.domElement;
let downPos = null;
canvas.addEventListener('pointerdown', (e) => { downPos = { x: e.clientX, y: e.clientY, b: e.button }; });
canvas.addEventListener('pointerup', (e) => {
  if (!downPos || downPos.b !== 0 || Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 4) { downPos = null; return; }
  downPos = null;
  const r = canvas.getBoundingClientRect();
  const p = pickAt(e.clientX - r.left, e.clientY - r.top, e.pointerType === 'touch' ? 26 : 12);
  if (state.measure) {
    if (!p) return;
    if (state.measurePts.length >= 2) state.measurePts = [];
    state.measurePts.push(p);
  } else {
    state.selected = p;
  }
  updateInfo();
  updateStatus();
  requestRender();
});
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons || e.pointerType === 'touch') return;
  const r = canvas.getBoundingClientRect();
  const p = pickAt(e.clientX - r.left, e.clientY - r.top);
  if (p !== state.hover) {
    state.hover = p;
    canvas.style.cursor = p ? 'pointer' : '';
    updateStatus();
    requestRender();
  }
});
canvas.addEventListener('pointerleave', () => { if (state.hover) { state.hover = null; updateStatus(); requestRender(); } });

function setMeasure(on) {
  state.measure = on;
  state.measurePts = [];
  $('btnMeasure').classList.toggle('on', on);
  updateInfo(); updateStatus(); requestRender();
}

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('btnOrtho').addEventListener('click', () => setOrtho(!state.ortho));
$('btnMeasure').addEventListener('click', () => setMeasure(!state.measure));
$('btnClearInfo').addEventListener('click', () => { if (state.measure) setMeasure(false); state.selected = null; updateInfo(); updateStatus(); requestRender(); });
$('btnAllOn').addEventListener('click', () => { for (const L of state.model.layerList) setLayerVisible(L, true); syncLayerChecks(); });
$('btnAllOff').addEventListener('click', () => { for (const L of state.model.layerList) setLayerVisible(L, false); syncLayerChecks(); });
$('btnTheme').addEventListener('click', () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; applyTheme(); if (state.model) fillLayers(); });
$('btnShot').addEventListener('click', screenshot);

const bindCheck = (id, key, rebuild) => $(id).addEventListener('change', (e) => {
  state[key] = e.target.checked;
  if (rebuild === 'scene') rebuildScene(); else if (rebuild === 'grid') rebuildGrid();
  requestRender();
});
bindCheck('optLines', 'showLines', 'scene');
bindCheck('optPoints', 'showPoints', 'scene');
bindCheck('optLabels', 'showLabels');
bindCheck('optHeights', 'showHeights');
bindCheck('optGrid', 'showGrid', 'grid');
bindCheck('opt2D', 'show2D', 'scene');
bindCheck('optDrop', 'showDrop', 'scene');
$('optColor').addEventListener('change', (e) => { state.colorMode = e.target.value; rebuildScene(); });
$('optZ').addEventListener('input', (e) => {
  state.zScale = +e.target.value; $('valZ').textContent = state.zScale;
  modelGroup.scale.z = state.zScale; requestRender();
});
$('optLW').addEventListener('input', (e) => {
  state.lineWidth = +e.target.value; $('valLW').textContent = state.lineWidth;
  state.model?.layerList.forEach((L, i) => { if (lineMaterials[i]) lineMaterials[i].linewidth = state.lineWidth * Math.max(1, L.width); });
  requestRender();
});
$('optPS').addEventListener('input', (e) => {
  state.pointSize = +e.target.value; $('valPS').textContent = state.pointSize;
  modelGroup.traverse((o) => { if (o.isPoints) o.material.size = state.pointSize; });
  requestRender();
});

function toggleCheck(id) { const el = $(id); el.checked = !el.checked; el.dispatchEvent(new Event('change')); }

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  if (!state.model || e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key.toLowerCase();
  const map = { f: 'fit', t: 'top', 1: 'top', 2: 'front', 3: 'side', 4: 'iso' };
  if (map[k]) setView(map[k]);
  else if (k === 'o') setOrtho(!state.ortho);
  else if (k === 'm') setMeasure(!state.measure);
  else if (k === 'n') toggleCheck('optLabels');
  else if (k === 'h') toggleCheck('optHeights');
  else if (k === 'escape') { if (state.measure) setMeasure(false); state.selected = null; updateInfo(); updateStatus(); requestRender(); }
  else return;
  e.preventDefault();
});

function screenshot() {
  renderer.render(scene, camera);
  drawOverlay();
  const c = document.createElement('canvas');
  c.width = renderer.domElement.width; c.height = renderer.domElement.height;
  const g = c.getContext('2d');
  // Фон сцени прозорий — підкладаємо фон, як у вікні (темна тема — градієнт, світла — суцільний)
  let bg = '#f4f9fb';
  if (state.theme === 'dark') {
    bg = g.createRadialGradient(c.width * 0.7, 0, 0, c.width * 0.7, 0, Math.max(c.width, c.height));
    bg.addColorStop(0, '#0b3550');
    bg.addColorStop(0.6, '#03141c');
    bg.addColorStop(1, '#010507');
  }
  g.fillStyle = bg;
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(renderer.domElement, 0, 0);
  g.drawImage(overlay, 0, 0, c.width, c.height);
  c.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.model?.name ?? 'cpz'}_3d.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

// ---------------------------------------------------------------- Цикл рендерингу

function loop() {
  requestAnimationFrame(loop);
  controls.update();
  if (!needsRender) return;
  needsRender = false;
  renderer.render(scene, camera);
  drawOverlay();
}

// ---------------------------------------------------------------- Мова інтерфейсу

function applyLang(l) {
  setLang(l);
  applyI18n();
  for (const b of document.querySelectorAll('[data-lang]')) b.classList.toggle('on', b.dataset.lang === getLang());
  applyTheme(); // текст кнопки теми
  if (state.model) { fillFileInfo(); fillLayers(); updateInfo(); }
  updateStatus();
  requestRender(); // підпис сітки на полотні
}
document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => applyLang(b.dataset.lang)));

applyLang(getLang());
resize();
loop();

// Для автоматизованої перевірки / вбудовування: відкрити файл із масиву байтів.
window.cpzViewer = { open: (name, bytes) => openInputs([{ name, data: bytes }]), state };
