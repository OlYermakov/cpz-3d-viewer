import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { loadProject } from './cpz.js';
import { t, getLang, setLang, applyI18n } from './i18n.js';
import { objName, objColor } from './objtypes.js';

// Система координат сцени: X = Rechtswert (схід), Y = Hochwert (північ), Z = Höhe (вгору).
// Координати зсунуті до локального початку (центр плану, мінімальна висота) — для точності float32.

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 3) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(d));
const ptName = (p) => p.name || '—'; // вершини DXF не мають назв
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const FALLBACK_COLORS = [0xff5555, 0x55ff55, 0x5599ff, 0xffff55, 0xff55ff, 0x55ffff, 0xffaa33, 0xaa77ff];

const SNAP_LIMIT = 200000;

// «38 · Mauer oben» — номер Objektart і назва з каталогу (якщо є)
const layerLabel = (id) => { const n = objName(id); return n ? `${id} · ${n}` : String(id); };

const state = {
  model: null,
  showLines: true, showPoints: true, showLabels: false, showHeights: false, showTexts: true, showLtypes: true,
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

// Відступ «чубчика» iPhone зверху (env(safe-area-inset-top)) — для розміщення компаса на полотні
const safeProbe = document.createElement('div');
safeProbe.style.cssText = 'position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top)';
document.body.appendChild(safeProbe);
let safeTop = 0;

function resize() {
  safeTop = parseFloat(getComputedStyle(safeProbe).paddingTop) || 0;
  vw = viewport.clientWidth; vh = viewport.clientHeight;
  renderer.setSize(vw, vh, false);
  const dpr = window.devicePixelRatio;
  overlay.width = Math.round(vw * dpr); overlay.height = Math.round(vh * dpr);
  resolution.set(vw, vh);
  for (const m of lineMaterials) m.resolution.copy(resolution);
  persp.aspect = vw / vh; persp.updateProjectionMatrix();
  updateOrthoFrustum();
  if (state.model) updateStatus(); // текст рядка стану залежить від ширини (телефон / ПК)
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
  const span = M.fit.z1 - M.fit.z0;
  const t = span > 0 ? Math.min(1, Math.max(0, (z - M.fit.z0) / span)) : 0.5;
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
        color: base?.color ?? objColor(id) ?? FALLBACK_COLORS[layers.size % FALLBACK_COLORS.length],
        visible: base?.visible ?? true,
        width: base?.width ?? 1,
        lines: [], points: [], texts: [], nPts: 0,
      });
    }
    return layers.get(id);
  };

  const texts = project.texts ?? [];
  const all = [...project.points, ...project.lines.flatMap((l) => l.pts)];
  const xs = [], ys = [], zs = [];
  for (const p of [...all, ...texts]) { xs.push(p.x); ys.push(p.y); if (p.z != null && p.z !== 0) zs.push(p.z); }
  const hasRealZ = zs.length > 0;
  // Межі: повні (для інформації) і «стійкі» без 0,5 % крайніх значень — щоб одиничні об'єкти
  // далеко від креслення (рамка, легенда в нулі координат) не зменшували модель при «Вписати»
  const range = (arr) => {
    if (!arr.length) return { min: 0, max: 0, lo: 0, hi: 0 };
    const s = Float64Array.from(arr).sort(), k = arr.length > 200 ? Math.floor(arr.length * 0.005) : 0;
    return { min: s[0], max: s[s.length - 1], lo: s[k], hi: s[s.length - 1 - k] };
  };
  const rx = range(xs), ry = range(ys), rz = range(zs);
  const minX = rx.min, maxX = rx.max, minY = ry.min, maxY = ry.max, minZ = rz.min, maxZ = rz.max;
  const fit = { x0: rx.lo, x1: rx.hi, y0: ry.lo, y1: ry.hi, z0: rz.lo, z1: rz.hi };
  const origin = { x: Math.round((fit.x0 + fit.x1) / 2), y: Math.round((fit.y0 + fit.y1) / 2), z: fit.z0 };

  // Точка без висоти: висота відсутня або рівно 0 серед 3D-даних (напр. QuickLn у CAPLAN, підписи в DXF).
  const noZ = (p) => p.z == null || (hasRealZ && p.z === 0);
  for (const p of [...all, ...texts]) {
    p.noZ = noZ(p);
    p.lx = p.x - origin.x; p.ly = p.y - origin.y; p.lz = p.noZ ? 0 : p.z - origin.z;
  }

  for (const p of project.points) { const L = getLayer(p.layer); L.points.push(p); L.nPts++; }
  for (const x of texts) { const L = getLayer(x.layer); L.texts.push(x); }
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
    // DXF задає замкненість прапорцем; у CPZ замкнена лінія повторює першу точку
    line.closed ??= line.pts.length > 2 && !!line.pts[0].name && line.pts[0].name === line.pts.at(-1).name;
    L.lines.push(line); L.nPts += line.pts.length;
  }

  const layerList = [...layers.values()].sort((a, b) => (parseFloat(a.id) - parseFloat(b.id)) || a.id.localeCompare(b.id));
  return {
    name: project.name, header: project.header, sources: project.sources, format: project.format,
    layers, layerList, lines: project.lines, points: project.points, texts,
    origin, minX, maxX, minY, maxY, minZ, maxZ, zRange: maxZ - minZ, hasRealZ, fit,
    nPoints: project.points.length + project.lines.reduce((s, l) => s + l.pts.filter((p) => !p.nopick).length, 0),
    // Прив'язка до вершин ліній — лише для креслень до SNAP_LIMIT вершин: інакше індекс і проєкція
    // мільйонів вершин щокадру забирають гігабайти пам'яті й гальмують обертання
    snapVertices: project.lines.reduce((s, l) => s + l.pts.length, 0) <= SNAP_LIMIT,
  };
}

// Унікальні точки для вибору/підписів (одна точка може входити в кілька ліній).
let pickPts = [];

function disposeGroup(g) {
  g.traverse((o) => { o.geometry?.dispose(); if (o.material && o.material !== sharedDropMat) o.material.dispose(); });
  g.clear();
}
const sharedDropMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.35 });

// Власний колір об'єкта DXF з тією ж корекцією під фон, що й колір шару (кешується)
const entityColors = new Map();
function entityColor(rgb) {
  let c = entityColors.get(rgb);
  if (!c) { c = displayColor(rgb); entityColors.set(rgb, c); }
  return c;
}

// Штрихування полілінії за шаблоном типу лінії DXF (довжини в одиницях креслення:
// >0 штрих, <0 проміжок, 0 точка). Шаблон безперервний уздовж усієї полілінії, як у CAD.
// Повертає false, якщо шаблон надто дрібний для лінії — тоді вона малюється суцільною.
function pushDashed(line, own, vcolor, seg) {
  const pat = line.dash;
  const period = pat.reduce((s, v) => s + Math.abs(v), 0);
  if (!(period > 1e-9)) return false;
  const P = line.pts.map((p) => [p.lx, p.ly, p.lz]);
  let total = 0;
  for (let k = 1; k < P.length; k++) total += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1], P[k][2] - P[k - 1][2]);
  if (total / period > 2000 || total < period * 0.5) return false;
  const dot = period * 0.02;
  const lenOf = (i) => (pat[i] === 0 ? dot : Math.abs(pat[i]));
  let idx = 0, left = lenOf(0);
  for (let k = 1; k < P.length; k++) {
    const a = P[k - 1], b = P[k], L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (L === 0) continue;
    const ca = vcolor(line.pts[k - 1], own), cb = vcolor(line.pts[k], own);
    const at = (t) => [a[0] + (b[0] - a[0]) * t / L, a[1] + (b[1] - a[1]) * t / L, a[2] + (b[2] - a[2]) * t / L];
    const col = (t) => (ca === cb ? ca : ca.clone().lerp(cb, t / L));
    let t = 0;
    while (t < L - 1e-12) {
      const step = Math.min(left, L - t);
      if (pat[idx] >= 0) seg(at(t), at(t + step), col(t), col(t + step));
      t += step; left -= step;
      if (left <= 1e-12) { idx = (idx + 1) % pat.length; left = lenOf(idx); }
    }
  }
  return true;
}

// Тип лінії CAPLAN (src/linetypes.js): малюнок пера, що повторюється з періодом уздовж полілінії
// в плані; y — зсув ліворуч від напрямку лінії (подвійні лінії, зубці паркану). Висота
// інтерполюється вздовж ланки. Повертає false, якщо малюнок надто дрібний — лінія буде суцільною.
function pushPattern(line, own, vcolor, seg) {
  const { period, strokes } = line.lt;
  const P = line.pts, n = P.length;
  const cum = [0];
  for (let k = 1; k < n; k++) cum.push(cum[k - 1] + Math.hypot(P[k].lx - P[k - 1].lx, P[k].ly - P[k - 1].ly));
  const total = cum[n - 1];
  if (total < period * 0.5 || total / period > 5000) return false;
  const cols = P.map((p) => vcolor(p, own));
  // Ланка, на якій лежить відстань s (остання з cum[k] <= s)
  const segAt = (s) => {
    let lo = 0, hi = n - 2;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cum[m] <= s) lo = m; else hi = m - 1; }
    return lo;
  };
  const at = (k, s, off) => {
    const a = P[k], b = P[k + 1], L = cum[k + 1] - cum[k];
    const t = L > 0 ? (s - cum[k]) / L : 0;
    const dx = L > 0 ? (b.lx - a.lx) / L : 0, dy = L > 0 ? (b.ly - a.ly) / L : 0;
    const ca = cols[k], cb = cols[k + 1];
    return {
      p: [a.lx + (b.lx - a.lx) * t - dy * off, a.ly + (b.ly - a.ly) * t + dx * off, a.lz + (b.lz - a.lz) * t],
      c: ca === cb ? ca : ca.clone().lerp(cb, t),
    };
  };
  // Штрих від (s1, y1) до (s2, y2): ділиться у вершинах полілінії, щоб іти за її вигинами
  const stroke = (s1, y1, s2, y2) => {
    if (s1 > total || s2 > total) {
      if (s1 >= total && s2 >= total) return;
      const yT = y1 + (y2 - y1) * (total - s1) / (s2 - s1); // обрізання штриха на кінці лінії
      if (s1 > total) { s1 = total; y1 = yT; } else { s2 = total; y2 = yT; }
    }
    if (s1 === s2) {
      const k = segAt(s1), A = at(k, s1, y1), B = at(k, s2, y2);
      seg(A.p, B.p, A.c, B.c);
      return;
    }
    const lo = Math.min(s1, s2), hi = Math.max(s1, s2);
    const cuts = [s1];
    for (let k = 1; k < n - 1; k++) if (cum[k] > lo && cum[k] < hi) cuts.push(cum[k]);
    if (s1 > s2) cuts.sort((u, v) => v - u); else cuts.sort((u, v) => u - v);
    cuts.push(s2);
    const yAt = (s) => y1 + (y2 - y1) * (s - s1) / (s2 - s1);
    for (let i = 1; i < cuts.length; i++) {
      const sa = cuts[i - 1], sb = cuts[i], k = segAt((sa + sb) / 2);
      const A = at(k, sa, yAt(sa)), B = at(k, sb, yAt(sb));
      seg(A.p, B.p, A.c, B.c);
    }
  };
  for (let base = 0; base < total; base += period) {
    let prev = null;
    for (const [pen, x, y] of strokes) {
      if (pen === 1 && prev) stroke(base + prev[0], prev[1], base + x, y);
      prev = [x, y];
    }
  }
  // Вертикальні ланки (без довжини в плані) — суцільні
  for (let k = 1; k < n; k++) {
    if (cum[k] === cum[k - 1] && P[k].lz !== P[k - 1].lz) seg([P[k - 1].lx, P[k - 1].ly, P[k - 1].lz], [P[k].lx, P[k].ly, P[k].lz], cols[k - 1], cols[k]);
  }
  return true;
}

function rebuildScene() {
  disposeGroup(modelGroup);
  entityColors.clear(); // корекція кольорів залежить від теми
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
    L.css = '#' + baseColor.getHexString(); // колір текстів шару на оверлеї
    // Колір вершини: за висотою, або власний колір об'єкта DXF, або колір шару
    const ownColor = (rgb) => (rgb == null ? baseColor : entityColor(rgb));
    const vcolor = (p, own) => (heightMode ? (p.noZ ? gray : heightColor(p.z)) : own);

    // Кольори — у вершинах (кожен об'єкт DXF може мати свій колір), тому колір матеріалу білий
    const lineMat = new LineMaterial({
      color: 0xffffff,
      linewidth: state.lineWidth * Math.max(1, L.width),
      vertexColors: true,
      resolution,
    });
    lineMaterials.push(lineMat);

    const ptPos = [], ptCol = [];
    const pushPt = (p, line) => {
      // Вершини ліній DXF не малюються точками, але до них можна «прив'язатися» для вимірювання;
      // точки дуг/кіл/граней (nopick) — лише геометрія
      if (!p.vertex) {
        ptPos.push(p.lx, p.ly, p.lz);
        const c = vcolor(p, ownColor(p.color));
        ptCol.push(c.r, c.g, c.b);
      }
      // На дуже великих кресленнях вершини ліній не індексуються для прив'язки (див. SNAP_LIMIT)
      if (!p.nopick && (!p.vertex || M.snapVertices)) addPick(p, L, line);
    };

    // Усі лінії шару — одним об'єктом (відрізками): тисячі полілiній DXF без втрати швидкості
    const segPos = [], segCol = [];
    const seg = (a, b, ca, cb) => { segPos.push(a[0], a[1], a[2], b[0], b[1], b[2]); segCol.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b); };
    for (const line of L.lines) {
      if (line.is2D && !state.show2D) continue;
      line.pts.forEach((p) => pushPt(p, line));
      if (!state.showLines || line.pts.length < 2) continue;
      const own = ownColor(line.color);
      if (state.showLtypes && line.dash && pushDashed(line, own, vcolor, seg)) continue;
      if (state.showLtypes && line.lt && pushPattern(line, own, vcolor, seg)) continue;
      for (let k = 1; k < line.pts.length; k++) {
        const a = line.pts[k - 1], b = line.pts[k];
        seg([a.lx, a.ly, a.lz], [b.lx, b.ly, b.lz], vcolor(a, own), vcolor(b, own));
      }
    }
    if (segPos.length) {
      const geo = new LineSegmentsGeometry();
      geo.setPositions(segPos);
      geo.setColors(segCol);
      g.add(new LineSegments2(geo, lineMat));
    }
    for (const p of L.points) {
      if (p.noZ && !state.show2D) continue;
      pushPt(p, null);
    }

    if (ptPos.length && state.showPoints) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(ptPos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(ptCol, 3));
      const mat = new THREE.PointsMaterial({
        size: state.pointSize, sizeAttenuation: false, map: dotTexture, alphaTest: 0.5,
        color: 0xffffff, vertexColors: true,
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
  const span = Math.max(M.fit.x1 - M.fit.x0, M.fit.y1 - M.fit.y0, 1);
  const step = niceStep(span);
  const div = Math.min(400, Math.ceil((span * 1.4) / step / 2) * 2);
  const dark = state.theme === 'dark';
  grid = new THREE.GridHelper(div * step, div, dark ? 0x1d6f93 : 0x8cc4dc, dark ? 0x0f3a50 : 0xc4e0ec);
  grid.material.transparent = true;
  grid.material.opacity = dark ? 0.75 : 0.9;
  grid.rotation.x = Math.PI / 2; // XZ → XY
  // Вузли сітки на «круглих» координатах
  const cx = (M.fit.x0 + M.fit.x1) / 2, cy = (M.fit.y0 + M.fit.y1) / 2;
  grid.position.set(Math.round(cx / step) * step - M.origin.x, Math.round(cy / step) * step - M.origin.y, 0);
  grid.userData.step = step;
  scene.add(grid);
}

// ---------------------------------------------------------------- Камера

// Межі для «Вписати»: лише видимі шари, без 0,5 % крайніх точок (одиничні об'єкти далеко від креслення)
function modelBox() {
  const M = state.model;
  const fallback = new THREE.Box3(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 5));
  if (!M) return fallback;
  const xs = [], ys = [], zs = [];
  const take = (p) => { xs.push(p.lx); ys.push(p.ly); zs.push(p.lz); };
  // Уся геометрія видимих шарів (у т. ч. грані DGM, дуги), для великих креслень — з проріджуванням
  const vis = M.layerList.filter((L) => L.visible);
  const total = vis.reduce((s, L) => s + L.nPts + L.texts.length, 0);
  const step = Math.max(1, Math.ceil(total / 300000));
  let n = 0;
  const maybe = (p) => { if (n++ % step === 0 && !(p.noZ && !state.show2D)) take(p); };
  for (const L of vis) { L.points.forEach(maybe); L.texts.forEach(maybe); for (const l of L.lines) l.pts.forEach(maybe); }
  if (!xs.length) return fallback;
  const cut = (arr) => {
    const s = Float64Array.from(arr).sort(), k = arr.length > 200 ? Math.floor(arr.length * 0.005) : 0;
    return [s[k], s[s.length - 1 - k]];
  };
  const [x0, x1] = cut(xs), [y0, y1] = cut(ys), [z0, z1] = cut(zs);
  return new THREE.Box3(new THREE.Vector3(x0, y0, z0 * state.zScale), new THREE.Vector3(x1, y1, z1 * state.zScale));
}

const VIEW_DIRS = {
  top: [0, -1e-3, 1],
  front: [0, -1, 0.0001],
  side: [1, 0, 0.0001],
  iso: [-1, -1, 0.9],
};

// ---------------------------------------------------------------- Наближення без «зупинки»
// OrbitControls на кожен крок зуму (і швидкість зсуву) рахує від відстані до точки обертання, що лежить
// на центральному промені камери. Якщо ця точка близько, а об'єкти під курсором далеко, кроки стають
// мізерними — зум «гальмує й зупиняється». Тому перед кожним кроком зуму/зсуву точка обертання ставиться
// на тому ж центральному промені на глибині об'єктів під курсором: вигляд не змінюється, а крок завжди
// пропорційний справжній відстані до того, що наближаємо. Ближня площина відсікання стежить за відстанню.
let sceneR = 20;
const fwd = new THREE.Vector3();
const zoomRay = new THREE.Raycaster();
const zoomNdc = new THREE.Vector2();
const zoomPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const zoomHit = new THREE.Vector3();
const zoomTmp = new THREE.Vector3();

// Відстань від камери до об'єктів під точкою екрана (x, y у пікселях полотна)
function depthAt(x, y) {
  // найближча видима точка моделі в радіусі 40 px
  let best = null, bd = 40 * 40;
  for (const s of screenPts) { const d = (s.x - x) ** 2 + (s.y - y) ** 2; if (d < bd) { bd = d; best = s; } }
  if (best) return persp.position.distanceTo(zoomTmp.set(best.p.lx, best.p.ly, best.p.lz * state.zScale));
  // інакше — горизонтальна площина на середній висоті моделі
  const M = state.model;
  zoomPlane.constant = -(M.hasRealZ ? ((M.fit.z0 + M.fit.z1) / 2 - M.origin.z) * state.zScale : 0);
  zoomNdc.set((x / vw) * 2 - 1, -(y / vh) * 2 + 1);
  zoomRay.setFromCamera(zoomNdc, persp);
  if (zoomRay.ray.intersectPlane(zoomPlane, zoomHit)) {
    const d = zoomHit.distanceTo(persp.position);
    if (d < sceneR * 20) return d;
  }
  // інакше — глибина центру моделі вздовж погляду
  fwd.set(0, 0, -1).transformDirection(persp.matrixWorld);
  return Math.max(modelBox().getCenter(zoomTmp).sub(persp.position).dot(fwd), sceneR * 0.05);
}

function retargetAt(clientX, clientY) {
  if (camera !== persp || !state.model) return;
  const r = renderer.domElement.getBoundingClientRect();
  const depth = Math.max(depthAt(clientX - r.left, clientY - r.top), sceneR * 1e-4);
  fwd.set(0, 0, -1).transformDirection(persp.matrixWorld);
  controls.target.copy(persp.position).addScaledVector(fwd, depth);
}

function fitClipPlanes() {
  const d = persp.position.distanceTo(controls.target);
  const near = THREE.MathUtils.clamp(d * 0.01, sceneR * 1e-6, sceneR / 500);
  const far = d + sceneR * 100;
  if (Math.abs(near - persp.near) > persp.near * 0.05 || Math.abs(far - persp.far) > persp.far * 0.05) {
    persp.near = near; persp.far = far;
    persp.updateProjectionMatrix();
  }
}

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
  sceneR = r;
  persp.position.copy(c).addScaledVector(dir, d);
  fitClipPlanes();

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
    fitClipPlanes();
  }
  camera.lookAt(t);
  controls.object = camera;
  controls.update();
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

  // Підписи без накладання: сітка зайнятості спільна для текстів креслення й назв точок
  const cell = 6, cols = Math.ceil(vw / cell) + 1;
  const occ = new Uint8Array(cols * (Math.ceil(vh / cell) + 1));
  const halo = dark ? 'rgba(2,12,18,.85)' : 'rgba(240,248,252,.92)';
  const place = (text, x0, y0, w, h, fill) => {
    const c0 = Math.max(0, Math.floor(x0 / cell)), c1 = Math.floor((x0 + w) / cell);
    const r0 = Math.max(0, Math.floor(y0 / cell)), r1 = Math.floor((y0 + h) / cell);
    if (x0 + w < 0 || c1 >= cols || y0 < 0 || y0 + h > vh) return;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (occ[r * cols + c]) return;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) occ[r * cols + c] = 1;
    ctx.lineWidth = 3; ctx.strokeStyle = halo; ctx.strokeText(text, x0 + 2, y0 + h / 2);
    ctx.fillStyle = fill; ctx.fillText(text, x0 + 2, y0 + h / 2);
  };
  ctx.textBaseline = 'middle';

  // Тексти креслення (DXF): розмір за висотою тексту в кресленні, дрібні при віддаленні ховаються
  if (state.showTexts && state.model.texts.length) {
    let drawn = 0;
    for (const L of state.model.layerList) {
      if (!L.visible || !L.texts.length) continue;
      for (const tx of L.texts) {
        if (tx.noZ && !state.show2D) continue;
        const s = project(tx);
        if (!s || s.x < -200 || s.y < -50 || s.x > vw + 50 || s.y > vh + 50) continue;
        let px = 11;
        if (tx.h > 0) {
          const s2 = project({ lx: tx.lx + tx.h, ly: tx.ly, lz: tx.lz });
          px = s2 ? Math.hypot(s2.x - s.x, s2.y - s.y) : 0;
          if (px < 7) continue;
          px = Math.min(px, 22);
        }
        ctx.font = `${Math.round(px)}px "Segoe UI", system-ui, sans-serif`;
        const w = ctx.measureText(tx.text).width + 4;
        place(tx.text, s.x - 2, s.y - px, w, px + 2, tx.color == null ? L.css : '#' + entityColor(tx.color).getHexString());
        if (++drawn > 3000) break;
      }
    }
  }

  if ((state.showLabels || state.showHeights) && screenPts.length < 5000) {
    ctx.font = '11px "Segoe UI", system-ui, sans-serif';
    const sorted = [...screenPts].sort((a, b) => a.z - b.z);
    for (const s of sorted) {
      const parts = [];
      if (state.showLabels && s.p.name) parts.push(s.p.name);
      if (state.showHeights) parts.push(s.p.noZ ? '—' : s.p.z.toFixed(2));
      if (!parts.length) continue;
      const text = parts.join('  ');
      const w = ctx.measureText(text).width + 4, h = 13;
      place(text, s.x + 6, s.y - h / 2 - 6, w, h, dark ? '#bfe6f5' : '#0e3a52');
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

// Вертикальний центр верхньої панелі телефона в координатах сцени
function topBarY() {
  const b = $('btnMenu').getBoundingClientRect(), v = viewport.getBoundingClientRect();
  return b.height ? b.top - v.top + b.height / 2 : safeTop + 33;
}

function drawCompass(dark) {
  // На телефоні — компактно у верхньому правому куті (низ зайнятий панеллю інструментів)
  const small = isNarrow();
  const len = small ? 18 : 28;
  // На телефоні — на рівні верхньої панелі (центр кнопки меню), праворуч
  const cx = small ? vw - 44 : 56, cy = small ? topBarY() : vh - 84;
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
  return `<dt>${t('pt.name')}</dt><dd><b>${esc(ptName(p))}</b></dd>
    <dt>${t('pt.layer')}</dt><dd>${esc(layerLabel(p.layer))}</dd>
    <dt>Rechtswert (E)</dt><dd>${fmt(p.x, 4)}</dd>
    <dt>Hochwert (N)</dt><dd>${fmt(p.y, 4)}</dd>
    <dt>Höhe (H)</dt><dd>${p.noZ ? `<span class="muted">${t('pt.noHeight')}</span>` : fmt(p.z, 4)}</dd>
    ${p.code != null ? `<dt>W</dt><dd>${p.code}</dd>` : ''}
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
    if (!b) { info.innerHTML = `<div>A: <b>${esc(ptName(a))}</b></div><div class="muted">${act('m.second')}</div>`; return; }
    const m = measure(a, b);
    info.innerHTML = `<div style="margin-bottom:6px"><b>${esc(ptName(a))}</b> → <b>${esc(ptName(b))}</b></div>
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
    $('status').textContent = `${ptName(p)}   E ${fmt(p.x, 4)}   N ${fmt(p.y, 4)}   H ${p.noZ ? '—' : fmt(p.z, 4)}   ${t('st.layer')} ${layerLabel(p.layer)}${p.lines.length ? `   ${t('st.line')} ` + p.lines.map((l) => l.name).join(', ') : ''}`;
  } else if (state.measure && b) {
    const m = measure(a, b);
    $('status').textContent = `${ptName(a)} → ${ptName(b)}:  ${fmt(m.slope)} ${u}   ${t('m.horizShort')} ${fmt(m.horiz)} ${u}   ΔH ${Number.isNaN(m.dH) ? '—' : fmt(m.dH)} ${u}`;
  } else if (state.measure) {
    $('status').textContent = a ? `A: ${ptName(a)} — ${act('m.second')}` : act('m.two');
  } else if (state.model) {
    // На телефоні назва файлу вже є у верхній панелі
    const base = `${isNarrow() ? '' : `${state.model.name}  ·  `}${pickPts.length} ${t('st.points')}  ·  ${state.model.lines.length} ${t('st.lines')}`;
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
    ${M.format && M.format !== 'CPZ' ? `<dt>${t('fi.format')}</dt><dd>${esc(M.format)}</dd>` : ''}
    <dt>${t('fi.points')}</dt><dd>${M.nPoints} (${M.points.length} ${t('fi.standalone')})</dd>
    <dt>${t('fi.lines')}</dt><dd>${M.lines.length}</dd>
    ${M.texts.length ? `<dt>${t('fi.texts')}</dt><dd>${M.texts.length}</dd>` : ''}
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
    const name = objName(L.id);
    row.title = layerLabel(L.id);
    row.innerHTML = `<input type="checkbox" ${L.visible ? 'checked' : ''}><span class="sw" style="background:${c};color:${c}"></span>
      <span class="nm"><b>${esc(L.id)}</b>${name ? ` <span class="ln">${esc(name)}</span>` : ''}</span><span class="cnt">${L.lines.length ? `${L.lines.length} ${t('lay.lines')} · ` : ''}${L.nPts} ${t('lay.pts')}</span>`;
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
  // Читання DWG може тривати секунди (завантаження модуля, великі креслення) — показуємо, що йде робота
  const isDwg = inputs.some((f) => /\.dwg$/i.test(f.name));
  if (isDwg) showToast(t('loading.dwg'), 0);
  try {
    const project = await loadProject(inputs);
    if (isDwg) hideToast();
    state.model = buildModel(project);
    state.selected = null; state.measurePts = []; state.hover = null;
    viewport.classList.add('loaded');
    for (const id of ['secFile', 'secLayers', 'secView']) $(id).hidden = false;
    document.title = `${state.model.name} — CPZ 3D Viewer`;
    $('mTitle').textContent = state.model.name;
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
    // На телефоні панель з помилкою схована — дублюємо повідомлення поверх сцени
    showToast(e.message || String(e), 6000);
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

// Вікно «Про застосунок та інструкція» — по кліку на іконку в панелі
const DEVELOPER = 'Oleksii Yermakov';
const aboutEl = $('about');
let aboutReturnFocus = null;
function fillAbout() {
  // Дата збірки — окремим елементом: на телефоні вона прихована (CSS .about-date)
  $('aboutVer').innerHTML = `CPZ 3D Viewer · ${t('about.version')} ${__APP_VERSION__}<span class="about-date"> · ${__BUILD_DATE__}</span>`;
  $('aboutDev').innerHTML = `<span>${t('about.dev')}:</span> <b>${DEVELOPER}</b>`;
  $('aboutBody').innerHTML = t('about.html');
}
function setAbout(open) {
  if (open === !aboutEl.hidden) return;
  aboutEl.hidden = !open;
  if (open) {
    aboutReturnFocus = document.activeElement;
    fillAbout();
    $('aboutBody').scrollTop = 0;
    $('btnAboutClose').focus();
  } else {
    aboutReturnFocus?.focus?.();
  }
}
$('btnAbout').addEventListener('click', () => setAbout(true));
$('btnAbout2').addEventListener('click', () => setAbout(true));
$('btnAboutClose').addEventListener('click', () => setAbout(false));
aboutEl.addEventListener('click', (e) => { if (e.target === aboutEl) setAbout(false); });
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
    if (p && p !== state.selected) showToast(`${t('toast.pivot')} ${ptName(p)}`);
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
  for (const id of ['btnMeasure', 'mMeasure']) $(id).classList.toggle('on', on);
  updateInfo(); updateStatus(); requestRender();
}

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('btnMeasure').addEventListener('click', () => setMeasure(!state.measure));
$('btnClearInfo').addEventListener('click', () => { if (state.measure) setMeasure(false); state.selected = null; updateInfo(); updateStatus(); requestRender(); });
$('btnAllOn').addEventListener('click', () => { for (const L of state.model.layerList) setLayerVisible(L, true); syncLayerChecks(); });
$('btnAllOff').addEventListener('click', () => { for (const L of state.model.layerList) setLayerVisible(L, false); syncLayerChecks(); });
$('btnTheme').addEventListener('click', () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; applyTheme(); if (state.model) fillLayers(); });
$('btnShot').addEventListener('click', screenshot);

// Телефон: нижня панель інструментів і меню видів
const viewMenu = $('viewMenu');
const setViewMenu = (open) => { viewMenu.hidden = !open; $('mView').classList.toggle('on', open); };
$('mView').addEventListener('click', () => setViewMenu(viewMenu.hidden));
viewMenu.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setViewMenu(false)));
$('mFit').addEventListener('click', () => setView('fit'));
$('mMeasure').addEventListener('click', () => setMeasure(!state.measure));
$('mShot').addEventListener('click', screenshot);
$('mTitle').addEventListener('click', () => setSheet(true));
canvas.addEventListener('pointerdown', () => { if (!viewMenu.hidden) setViewMenu(false); });

// Точка обертання — на глибині об'єктів під курсором перед зумом (коліщатко), зсувом (ПКМ)
// і жестом двома пальцями; capture — щоб спрацювати раніше за OrbitControls
canvas.addEventListener('wheel', (e) => retargetAt(e.clientX, e.clientY), { capture: true, passive: true });
const touchPts = new Map();
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') touchPts.set(e.pointerId, e);
  else if (e.button === 2) retargetAt(e.clientX, e.clientY);
}, { capture: true });
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch' || !touchPts.has(e.pointerId)) return;
  touchPts.set(e.pointerId, e);
  if (touchPts.size === 2) {
    const [a, b] = [...touchPts.values()];
    retargetAt((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
  }
}, { capture: true });
for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, (e) => touchPts.delete(e.pointerId), { capture: true });

// Обертання навколо вибраної точки. OrbitControls обертає лише навколо своєї цілі (центру екрана),
// тому поки точку вибрано, обертання (ЛКМ / один палець) виконується тут: камера й ціль повертаються
// навколо точки — точка лишається нерухомою на екрані, без стрибка вигляду. Зум і зсув — як завжди.
const pivotDrag = { active: false, id: null, x: 0, y: 0 };
const pivotQ = new THREE.Quaternion(), pivotQ2 = new THREE.Quaternion();
const pivotP = new THREE.Vector3(), pivotRight = new THREE.Vector3(), pivotOff = new THREE.Vector3(), pivotFwd = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 0, 1);

function orbitAroundSelected(dx, dy) {
  const p = state.selected;
  if (!p) return;
  const h = renderer.domElement.clientHeight || 1;
  // Ті самі кути й напрямки, що в OrbitControls (2π на висоту полотна)
  const theta = (-2 * Math.PI * dx) / h, phi = (-2 * Math.PI * dy) / h;
  pivotP.set(p.lx, p.ly, p.lz * state.zScale);
  pivotRight.setFromMatrixColumn(camera.matrixWorld, 0);
  pivotQ2.setFromAxisAngle(pivotRight, phi);
  // не перевертати камеру через вертикаль
  pivotFwd.copy(controls.target).sub(camera.position).normalize().applyQuaternion(pivotQ2);
  if (Math.abs(pivotFwd.z) > 0.995) pivotQ2.identity();
  pivotQ.setFromAxisAngle(WORLD_UP, theta).multiply(pivotQ2);
  for (const v of [camera.position, controls.target]) {
    pivotOff.copy(v).sub(pivotP).applyQuaternion(pivotQ);
    v.copy(pivotP).add(pivotOff);
  }
  camera.lookAt(controls.target);
  controls.update();
  requestRender();
}

canvas.addEventListener('pointerdown', (e) => {
  const oneFinger = e.pointerType === 'touch' && touchPts.size === 1;
  const leftMouse = e.pointerType !== 'touch' && e.button === 0;
  if (!state.selected || !(leftMouse || oneFinger)) return;
  Object.assign(pivotDrag, { active: true, id: e.pointerId, x: e.clientX, y: e.clientY });
  controls.enableRotate = false; // обертання робимо самі; зсув/зум двома пальцями лишаються за OrbitControls
}, { capture: true });
canvas.addEventListener('pointermove', (e) => {
  if (!pivotDrag.active || e.pointerId !== pivotDrag.id) return;
  if (touchPts.size > 1) { pivotDrag.active = false; return; } // другий палець — це вже зум/зсув
  orbitAroundSelected(e.clientX - pivotDrag.x, e.clientY - pivotDrag.y);
  pivotDrag.x = e.clientX; pivotDrag.y = e.clientY;
}, { capture: true });
for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, () => {
  if (touchPts.size) return;
  pivotDrag.active = false;
  controls.enableRotate = true;
});

const bindCheck = (id, key, rebuild) => $(id).addEventListener('change', (e) => {
  state[key] = e.target.checked;
  if (rebuild === 'scene') rebuildScene(); else if (rebuild === 'grid') rebuildGrid();
  requestRender();
});
bindCheck('optLines', 'showLines', 'scene');
bindCheck('optPoints', 'showPoints', 'scene');
bindCheck('optLabels', 'showLabels');
bindCheck('optHeights', 'showHeights');
bindCheck('optTexts', 'showTexts');
bindCheck('optLtypes', 'showLtypes', 'scene');
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
  // Поки відкрите вікно «Про застосунок», клавіші не керують сценою; Esc закриває вікно
  if (!aboutEl.hidden) { if (e.key === 'Escape') { setAbout(false); e.preventDefault(); } return; }
  if (e.target.closest?.('input, select, textarea') && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  if (!state.model || e.ctrlKey || e.altKey || e.metaKey) return;
  // За фізичною клавішею (e.code), а не символом: з українською розкладкою O дає «щ», F — «а» тощо
  const k = e.key === 'Escape' ? 'Escape' : e.code.replace(/^(Key|Digit|Numpad)/, '');
  const map = { F: 'fit', T: 'top', 1: 'top', 2: 'front', 3: 'side', 4: 'iso' };
  if (map[k]) setView(map[k]);
  else if (k === 'O') { setOrtho(!state.ortho); showToast(t(state.ortho ? 'toast.orthoOn' : 'toast.orthoOff')); }
  else if (k === 'M') setMeasure(!state.measure);
  else if (k === 'N') toggleCheck('optLabels');
  else if (k === 'H') toggleCheck('optHeights');
  else if (k === 'Escape') { if (state.measure) setMeasure(false); state.selected = null; updateInfo(); updateStatus(); requestRender(); }
  else return;
  e.preventDefault();
});

// Коротке повідомлення поверх сцени (напр., про перемикання перспективи клавішею O)
let toastTimer = 0;
function showToast(text, ms = 1600) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(hideToast, ms); // ms = 0 — тримати, доки не викличуть hideToast
}
function hideToast() { clearTimeout(toastTimer); $('toast').classList.remove('show'); }

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
  if (camera === persp) fitClipPlanes();
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
  if (!aboutEl.hidden) fillAbout();
  updateStatus();
  requestRender(); // підпис сітки на полотні
}
document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => applyLang(b.dataset.lang)));

applyLang(getLang());
resize();
loop();

// Для автоматизованої перевірки / вбудовування: відкрити файл із масиву байтів.
window.cpzViewer = { open: (name, bytes) => openInputs([{ name, data: bytes }]), state, controls, get camera() { return camera; } };
