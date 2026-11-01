// Читання файлів CAPLAN (Cremer):
//   *.CPZ — ZIP-архів проєкту;
//   *.CP  — файл проєкту (DATA=, LAYER=, ZOOM=, VIEW=...);
//   *.L / *.KOR — точки та лінії:
//       "<Назва> <W> <Rechtswert> <Hochwert> [<Höhe>] |<Objektart>|<Атрибути>..."  — точка
//       "<Назва лінії>                                |<Objektart>|..."            — початок лінії
//     Точки після заголовка лінії належать цій лінії до наступного заголовка.

import { t } from './i18n.js';
import { decodeDXF, parseDXF, parseSections } from './dxf.js';
import { readDWG, dwgVersion } from './dwg.js';
import { linePattern } from './linetypes.js';

// ---------------------------------------------------------------- ZIP

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

export function isZip(bytes) {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
}

export async function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(t('e.notZip'));

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== SIG_CEN) throw new Error(t('e.badDir'));
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const loc = dv.getUint32(p + 42, true);
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'windows-1252').decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error(t('e.encrypted', { name }));
    if (dv.getUint32(loc, true) !== SIG_LOC) throw new Error(t('e.badZip'));
    const start = loc + 30 + dv.getUint16(loc + 26, true) + dv.getUint16(loc + 28, true);
    const raw = bytes.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(t('e.method', { m: method, name }));
    files.push({ name, data });
  }
  return files;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes); // CAPLAN пише ANSI (ISO-8859-1/CP1252)
  }
}

// ---------------------------------------------------------------- CP (проєкт)

// Колір у CAPLAN зберігається як Windows COLORREF (0x00BBGGRR).
const bgrToRgb = (c) => ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff);

export function parseCP(text) {
  const res = { data: [], layers: new Map(), zoom: null, keys: {} };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('!')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toUpperCase();
    const val = line.slice(eq + 1).trim();
    const f = val.split('|');
    if (key === 'LAYER') {
      const id = f[0].trim();
      res.layers.set(id, {
        id,
        color: bgrToRgb(parseInt(f[1], 10) || 0),
        visible: f[2] === undefined || f[2].trim() !== '0',
        width: parseFloat(f[3]) || 1,
      });
    } else if (key === 'DATA') {
      res.data = f.map((s) => s.trim()).filter(Boolean);
    } else if (key === 'ZOOM') {
      res.zoom = { x: parseFloat(f[0]), y: parseFloat(f[1]), sx: parseFloat(f[2]), sy: parseFloat(f[3]) };
    } else {
      res.keys[key] = val;
    }
  }
  return res;
}

// ---------------------------------------------------------------- L / KOR (точки та лінії)

const NUM = '([-+]?\\d+(?:\\.\\d*)?)';
const POINT_RE = new RegExp(`^\\s*(.*?\\S)\\s+(\\d+)\\s+${NUM}\\s+${NUM}(?:\\s+${NUM})?\\s*$`);
// Дуга між двома точками лінії: рядок після точки "0  <радіус>  <ознака 1|0>  ."
const ARC_RE = new RegExp(`^\\s*0\\s+${NUM}\\s+${NUM}(?:\\s+\\S+)?\\s*$`);

// Проміжні вершини дуги від a до b. Знак радіуса — напрямок: + за годинниковою стрілкою, − проти;
// ознака 1 — більша з двох можливих дуг, 0 — менша (як у SVG). Перевірено на колах CAPLAN (дві дуги
// A→B з ознакою 1 і B→A з 0, з додатним і від'ємним радіусом): центр збігається з виміряною
// точкою центру кришки / шахти. Висота змінюється лінійно від a до b.
function arcVertices(a, b, r, flag) {
  const dx = b.x - a.x, dy = b.y - a.y, c = Math.hypot(dx, dy);
  const cw = r > 0;
  r = Math.abs(r);
  if (!(c > 1e-9) || !(r > 0)) return [];
  // Центр ліворуч від a→b для великої дуги за годинниковою і малої проти; інакше праворуч
  const h = Math.sqrt(Math.max(0, r * r - (c / 2) ** 2)) * ((flag ? 1 : 0) === (cw ? 1 : 0) ? 1 : -1);
  const cx = (a.x + b.x) / 2 - (dy / c) * h, cy = (a.y + b.y) / 2 + (dx / c) * h;
  const a0 = Math.atan2(a.y - cy, a.x - cx);
  let sweep = Math.atan2(b.y - cy, b.x - cx) - a0;
  if (cw) while (sweep >= 0) sweep -= 2 * Math.PI; // за годинниковою: кут зменшується
  else while (sweep <= 0) sweep += 2 * Math.PI;
  const n = Math.max(2, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * 48));
  const out = [];
  for (let i = 1; i < n; i++) {
    const t = i / n, ang = a0 + sweep * t;
    const z = a.z != null && b.z != null ? a.z + (b.z - a.z) * t : (a.z ?? b.z);
    out.push({ name: '', code: null, x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang), z, layer: a.layer, attrs: [], vertex: true, nopick: true });
  }
  return out;
}

export function parseL(text) {
  const out = { header: [], points: [], lines: [] };
  let cur = null, arc = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) { cur = null; arc = null; continue; }
    if (rawLine.trimStart().startsWith('!')) {
      const c = rawLine.replace(/^\s*!\s?/, '').trim();
      if (c && !/^-+$/.test(c)) out.header.push(c);
      continue;
    }
    const bar = rawLine.indexOf('|');
    const main = bar >= 0 ? rawLine.slice(0, bar) : rawLine;
    const attrs = bar >= 0 ? rawLine.slice(bar + 1).split('|').map((s) => s.trim()) : [];
    const layer = attrs[0] || '0';
    const am = cur && cur.pts.length ? main.match(ARC_RE) : null;
    if (am) { arc = { r: +am[1], flag: +am[2] }; continue; }
    const m = main.match(POINT_RE);
    if (m) {
      const p = {
        name: m[1].trim(),
        code: +m[2],
        x: +m[3], // Rechtswert (схід)
        y: +m[4], // Hochwert (північ)
        z: m[5] !== undefined ? +m[5] : null, // Höhe
        layer,
        attrs: attrs.slice(1),
      };
      if (cur && arc) cur.pts.push(...arcVertices(cur.pts[cur.pts.length - 1], p, arc.r, arc.flag));
      arc = null;
      (cur ? cur.pts : out.points).push(p);
    } else {
      arc = null;
      const name = main.trim();
      if (!name) continue;
      // lt — тип лінії CAPLAN за Objektart (null — суцільна)
      cur = { name, layer, attrs: attrs.slice(1), pts: [], lt: linePattern(layer) };
      out.lines.push(cur);
    }
  }
  // Заголовки без точок (або рядки інших форматів, схожі на заголовок) — не лінії
  out.lines = out.lines.filter((l) => l.pts.length);
  return out;
}

// ---------------------------------------------------------------- Завантаження набору файлів

// .A — осі (трасування: прямі, дуги, клотоїди) — поки не відображаються
const SKIP_EXT = new Set(['jpg', 'jpeg', 'png', 'bmp', 'gif', 'tif', 'tiff', 'db', 'pdf', 'zip', 'a']);
const ext = (n) => (n.includes('.') ? n.split('.').pop().toLowerCase() : '');

/**
 * @param {{name: string, data: Uint8Array}[]} inputs — файли, вибрані користувачем
 * @returns {Promise<{name, cp, header, points, lines, sources}>}
 */
export async function loadProject(inputs) {
  const entries = [];
  let name = null;
  for (const f of inputs) {
    if (ext(f.name) === 'cpz' || isZip(f.data)) {
      name ??= f.name.replace(/\.[^.]+$/, '');
      for (const e of await readZip(f.data)) entries.push(e);
    } else {
      entries.push(f);
    }
  }

  const project = { name, cp: null, header: [], points: [], lines: [], texts: [], sources: [], format: 'CPZ' };
  // Креслення DXF/DWG (однакова модель): шари доповнюють шари з .CP, якщо файли відкрито разом.
  // Без push(...масив): великі DWG дають сотні тисяч об'єктів, а це переповнює стек аргументів.
  const addDrawing = (d, fileName, format) => {
    project.cp ??= { layers: new Map() };
    for (const [k, v] of d.cp.layers) if (!project.cp.layers.has(k)) project.cp.layers.set(k, v);
    project.points = project.points.concat(d.points);
    project.lines = project.lines.concat(d.lines);
    project.texts = project.texts.concat(d.texts);
    project.sources.push(fileName);
    project.format = format;
    project.name ??= fileName.replace(/\.[^.]+$/, '');
  };
  for (const e of entries) {
    const x = ext(e.name);
    if (SKIP_EXT.has(x)) continue;
    if (x === 'dxf') {
      const { text, version } = decodeDXF(e.data);
      addDrawing(parseDXF(text), e.name, `DXF ${version}`.trim());
      continue;
    }
    if (x === 'dwg') {
      addDrawing(parseSections(await readDWG(e.data)), e.name, `DWG ${dwgVersion(e.data)}`.trim());
      continue;
    }
    const text = decodeText(e.data);
    if (x === 'cp') {
      project.cp = parseCP(text);
      project.name ??= e.name.replace(/\.[^.]+$/, '');
      continue;
    }
    const d = parseL(text);
    if (!d.points.length && !d.lines.length) continue;
    project.header.push(...d.header);
    project.points.push(...d.points);
    project.lines.push(...d.lines);
    project.sources.push(e.name);
    project.name ??= e.name.replace(/\.[^.]+$/, '');
  }
  if (!project.sources.length) throw new Error(t('e.noData'));
  return project;
}
