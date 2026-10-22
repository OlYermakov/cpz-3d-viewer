// Читання DXF (ASCII) у ту саму структуру проєкту, що й CPZ: { cp: {layers}, points, lines, texts }.
// Підтримка: LINE, LWPOLYLINE, POLYLINE (2D/3D, polyface, mesh), POINT, ARC, CIRCLE, ELLIPSE, SPLINE,
// 3DFACE, SOLID/TRACE (контури), TEXT, MTEXT, ATTRIB, INSERT/MINSERT (блоки з вкладеністю), DIMENSION.
// Об'єкти простору аркуша (67=1) і невидимі (60=1) пропускаються. Колір — за шаром.

import { t } from './i18n.js';

// ---------------------------------------------------------------- Кодування

/** Декодує байти DXF з урахуванням $ACADVER і $DWGCODEPAGE (AC1021+ — UTF-8, раніше — ANSI-кодова сторінка). */
export function decodeDXF(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  if (head.startsWith('AutoCAD Binary DXF')) throw new Error(t('e.binaryDxf'));
  const probe = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 200000)));
  const ver = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d+)/.exec(probe)?.[1] ?? '';
  const cp = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/.exec(probe)?.[1] ?? '';
  let enc = 'windows-1252';
  if (ver >= 'AC1021') enc = 'utf-8';
  else if (/^ANSI_(\d+)$/i.test(cp)) enc = `windows-${cp.slice(5)}`;
  else if (/^DOS866$/i.test(cp)) enc = 'ibm866';
  let text;
  try { text = new TextDecoder(enc).decode(bytes); } catch { text = new TextDecoder('windows-1252').decode(bytes); }
  return { text, version: ver };
}

// ---------------------------------------------------------------- Кольори AutoCAD (ACI)

const ACI_BASE = [0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0];
const ACI_GRAY = [0x333333, 0x505050, 0x696969, 0x828282, 0xbebebe, 0xffffff];

export function aciToRgb(i) {
  i = Math.abs(i);
  if (i < 10) return ACI_BASE[i] ?? 0xffffff;
  if (i >= 250) return ACI_GRAY[i - 250] ?? 0xffffff;
  // 10–249: 24 відтінки по 15°, у кожному 5 рівнів яскравості × (насичений / блідий)
  const h = Math.floor((i - 10) / 10) * 15, k = (i - 10) % 10;
  const v = [1, 1, 0.65, 0.65, 0.5, 0.5, 0.3, 0.3, 0.15, 0.15][k], s = k % 2 ? 0.5 : 1;
  const f = (n) => { const kk = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(kk, 4 - kk, 1)); };
  return (Math.round(f(5) * 255) << 16) | (Math.round(f(3) * 255) << 8) | Math.round(f(1) * 255);
}

// ---------------------------------------------------------------- Токенізація

/** Розбиває DXF на сутності: [{ type, g: [[code, value], ...] }] у межах секцій. */
function tokenize(text) {
  const lines = text.split(/\r?\n/);
  const sections = {};
  let sec = null, cur = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    const val = lines[i + 1];
    if (Number.isNaN(code)) continue;
    if (code === 0) {
      const type = val.trim();
      if (type === 'SECTION') { sec = null; cur = null; continue; }
      if (type === 'ENDSEC') { sec = null; cur = null; continue; }
      if (type === 'EOF') break;
      if (sec) { cur = { type, g: [] }; sections[sec].push(cur); }
      continue;
    }
    if (code === 2 && !sec && !cur) { sec = val.trim(); sections[sec] = []; continue; }
    // HEADER — пари «змінна (9) / значення» без сутностей
    if (sec === 'HEADER') { sections.HEADER.push([code, val.trim()]); continue; }
    // Числа в DXF часто вирівняні пробілами ("     1"); текст (1, 3) не обрізаємо зліва
    if (cur) cur.g.push([code, code === 1 || code === 3 ? val.trimEnd() : val.trim()]);
  }
  return sections;
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const get = (e, code, def) => { for (const [c, v] of e.g) if (c === code) return v; return def; };
const getN = (e, code, def = 0) => { const v = get(e, code); return v === undefined ? def : num(v); };
const pt = (e, c = 10) => [getN(e, c), getN(e, c + 10), getN(e, c + 20)];

// ---------------------------------------------------------------- Перетворення координат блоків

const IDENTITY = (p) => p;

function insertTransform(parent, base, pos, sx, sy, sz, rotDeg) {
  const r = (rotDeg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return (p) => {
    const x = (p[0] - base[0]) * sx, y = (p[1] - base[1]) * sy, z = (p[2] - base[2]) * sz;
    return parent([pos[0] + x * c - y * s, pos[1] + x * s + y * c, pos[2] + z]);
  };
}

// ---------------------------------------------------------------- Розбір

const ARC_STEP = (5 * Math.PI) / 180;

function arcPoints(cx, cy, z, r, a0, a1) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(4, Math.ceil(sweep / ARC_STEP));
  const out = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (sweep * i) / n; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]); }
  return out;
}

// Дуга між двома вершинами полілінії за «bulge» (tg чверті кута)
function bulgePoints(p1, p2, bulge) {
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1], chord = Math.hypot(dx, dy);
  if (!bulge || chord === 0) return [];
  const theta = 4 * Math.atan(bulge), r = chord / (2 * Math.sin(theta / 2));
  const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
  const d = r * Math.cos(theta / 2);
  const cx = mx - (dy / chord) * d, cy = my + (dx / chord) * d;
  const a0 = Math.atan2(p1[1] - cy, p1[0] - cx);
  const n = Math.max(2, Math.ceil(Math.abs(theta) / ARC_STEP));
  const out = [];
  for (let i = 1; i < n; i++) {
    const a = a0 + (theta * i) / n;
    out.push([cx + Math.abs(r) * Math.cos(a), cy + Math.abs(r) * Math.sin(a), p1[2] + ((p2[2] - p1[2]) * i) / n]);
  }
  return out;
}

function cleanMText(s) {
  return s
    .replace(/\\P/g, ' ')
    .replace(/\\[ACcFfHhLlOoQqTtWwKk][^;\\]*;?/g, '')
    .replace(/\\S([^;]*);/g, (_, f) => f.replace(/[#^]/, '/'))
    .replace(/\\~/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\\\\/g, '\\')
    .trim();
}
const decodeUnicode = (s) => s
  .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±');

export function parseDXF(text) {
  const S = tokenize(text);
  if (!S.ENTITIES) throw new Error(t('e.noData'));

  // Глобальний масштаб типів ліній ($LTSCALE)
  const hdr = S.HEADER ?? [];
  let ltScale = 1;
  for (let k = 0; k < hdr.length; k++) {
    if (hdr[k][0] === 9 && hdr[k][1] === '$LTSCALE') { const v = hdr.slice(k + 1, k + 4).find((p) => p[0] === 40); if (v) ltScale = num(v[1]) || 1; }
  }

  // Типи ліній: шаблон — довжини елементів (49): >0 штрих, <0 проміжок, 0 точка
  const ltypes = new Map();
  for (const e of S.TABLES ?? []) {
    if (e.type !== 'LTYPE') continue;
    const name = get(e, 2, '').trim().toUpperCase();
    const pattern = e.g.filter(([c]) => c === 49).map(([, v]) => num(v));
    if (name && pattern.length >= 2 && pattern.some((v) => v < 0)) ltypes.set(name, pattern);
  }

  // Шари
  const layers = new Map();
  for (const e of S.TABLES ?? []) {
    if (e.type !== 'LAYER') continue;
    const name = get(e, 2, '').trim();
    if (!name) continue;
    const aci = getN(e, 62, 7), flags = getN(e, 70, 0), tc = get(e, 420);
    const lw = getN(e, 370, -3);
    layers.set(name, {
      id: name,
      color: tc !== undefined ? parseInt(tc, 10) & 0xffffff : aciToRgb(aci),
      visible: aci >= 0 && !(flags & 1),
      width: lw >= 50 ? 2 : 1,
      ltype: get(e, 6, '').trim().toUpperCase(),
    });
  }

  // Колір і тип лінії сутності з урахуванням «за шаром» (256 / BYLAYER) і «за блоком» (0 / BYBLOCK).
  // color: RGB або null (= колір шару); lt: назва типу лінії ('' — суцільна).
  function styleOf(e, layer, parent) {
    let color = null;
    const tc = get(e, 420), aci = get(e, 62);
    if (tc !== undefined) color = parseInt(tc, 10) & 0xffffff;
    else if (aci !== undefined) {
      const a = parseInt(aci, 10);
      if (a === 0) color = parent.color;
      else if (a > 0 && a < 256) color = aciToRgb(a);
    }
    let lt = (get(e, 6, 'BYLAYER') || 'BYLAYER').trim().toUpperCase();
    if (lt === 'BYBLOCK') lt = parent.lt;
    else if (lt === 'BYLAYER') lt = layers.get(layer)?.ltype ?? '';
    return { color, lt, ltk: getN(e, 48, 1) || 1 };
  }
  // Шаблон штрихів у одиницях креслення: $LTSCALE × масштаб сутності × масштаб вставки блоку
  const dashOf = (st, scale) => {
    const pat = st.lt && st.lt !== 'CONTINUOUS' ? ltypes.get(st.lt) : null;
    return pat ? pat.map((v) => v * ltScale * st.ltk * scale) : null;
  };

  // Блоки: BLOCK … ENDBLK
  const blocks = new Map();
  let blk = null;
  for (const e of S.BLOCKS ?? []) {
    if (e.type === 'BLOCK') { blk = { name: get(e, 2, '').trim(), base: pt(e), ents: [] }; blocks.set(blk.name, blk); }
    else if (e.type === 'ENDBLK') blk = null;
    else if (blk) blk.ents.push(e);
  }

  const out = { points: [], lines: [], texts: [] };
  let nLine = 0;

  // Стиль поточної сутності (колір / штрихи) — встановлюється перед обробкою кожної сутності
  let sty = { color: null, dash: null };
  const vtx = (p, layer, extra) => ({ name: '', code: null, x: p[0], y: p[1], z: p[2], layer, attrs: [], color: sty.color, ...extra });
  const addLine = (type, handle, layer, pts, { closed = false, pick = true } = {}) => {
    if (pts.length < 2) return;
    const v = pts.map((p) => vtx(p, layer, pick ? { vertex: true } : { vertex: true, nopick: true }));
    if (closed) v.push({ ...v[0] });
    out.lines.push({ name: `${type} ${handle || ++nLine}`, layer, attrs: [], pts: v, closed, color: sty.color, dash: sty.dash });
  };
  const addText = (s, p, layer, h) => { s = decodeUnicode(s).trim(); if (s) out.texts.push({ text: s, x: p[0], y: p[1], z: p[2], layer, h, color: sty.color }); };

  // Обхід списку сутностей (головний або вміст блоку) з перетворенням координат;
  // parent — колір і тип лінії вставки блоку для «за блоком»
  function walk(ents, T, parentLayer, scale, depth, parent = { color: null, lt: '' }) {
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (get(e, 67) === '1' || get(e, 60) === '1') {
        // пропускаємо разом із вершинами/атрибутами
        if (e.type === 'POLYLINE' || (e.type === 'INSERT' && get(e, 66) === '1')) while (i + 1 < ents.length && ents[++i].type !== 'SEQEND');
        continue;
      }
      let layer = (get(e, 8, '0') || '0').trim();
      if (layer === '0' && parentLayer) layer = parentLayer;
      const h = get(e, 5, '').trim();
      const P = (c) => T(pt(e, c));
      const st = styleOf(e, layer, parent);
      sty = { color: st.color, dash: dashOf(st, scale) };

      switch (e.type) {
        case 'LINE':
          addLine('LINE', h, layer, [P(10), P(11)]);
          break;

        case 'POINT': {
          const p = P(10);
          out.points.push(vtx(p, layer));
          break;
        }

        case 'LWPOLYLINE': {
          const elev = getN(e, 38), closed = getN(e, 70) & 1;
          const raw = []; let last = null;
          for (const [c, v] of e.g) {
            if (c === 10) { last = [num(v), 0, elev, 0]; raw.push(last); }
            else if (c === 20 && last) last[1] = num(v);
            else if (c === 42 && last) last[3] = num(v);
          }
          const pts = [];
          raw.forEach((r, k) => {
            pts.push(T(r));
            const nx = raw[k + 1] ?? (closed ? raw[0] : null);
            if (nx && r[3]) for (const q of bulgePoints(r, nx, r[3])) pts.push(T(q));
          });
          addLine('LWPOLYLINE', h, layer, pts, { closed });
          break;
        }

        case 'POLYLINE': {
          const flags = getN(e, 70), closed = flags & 1, elev = getN(e, 30);
          const verts = [];
          while (i + 1 < ents.length && ents[i + 1].type === 'VERTEX') verts.push(ents[++i]);
          if (i + 1 < ents.length && ents[i + 1].type === 'SEQEND') i++;
          if (flags & 64) {
            // Polyface: вершини-координати і грані з індексами
            const coords = verts.filter((v) => getN(v, 70) & 64).map((v) => T(pt(v)));
            for (const f of verts.filter((v) => (getN(v, 70) & 128) && !(getN(v, 70) & 64))) {
              const idx = [71, 72, 73, 74].map((c) => Math.abs(getN(f, c))).filter((n) => n > 0 && n <= coords.length);
              if (idx.length >= 2) addLine('POLYFACE', h, layer, idx.map((n) => coords[n - 1]), { closed: true, pick: false });
            }
          } else if (flags & 16) {
            // 3D-сітка M×N: рядки та стовпці
            const m = getN(e, 71), n = getN(e, 72), coords = verts.map((v) => T(pt(v)));
            for (let a = 0; a < m; a++) addLine('MESH', h, layer, coords.slice(a * n, a * n + n), { pick: false });
            for (let b = 0; b < n; b++) addLine('MESH', h, layer, Array.from({ length: m }, (_, a) => coords[a * n + b]).filter(Boolean), { pick: false });
          } else {
            const is3D = flags & 8;
            const raw = verts.map((v) => { const p = pt(v); if (!is3D) p[2] = elev || p[2]; return [...p, getN(v, 42)]; });
            const pts = [];
            raw.forEach((r, k) => {
              pts.push(T(r));
              const nx = raw[k + 1] ?? (closed ? raw[0] : null);
              if (nx && r[3]) for (const q of bulgePoints(r, nx, r[3])) pts.push(T(q));
            });
            addLine(is3D ? 'POLYLINE3D' : 'POLYLINE', h, layer, pts, { closed });
          }
          break;
        }

        case 'ARC':
        case 'CIRCLE': {
          const c = pt(e), r = getN(e, 40);
          const a0 = e.type === 'ARC' ? (getN(e, 50) * Math.PI) / 180 : 0;
          const a1 = e.type === 'ARC' ? (getN(e, 51) * Math.PI) / 180 : Math.PI * 2;
          if (r > 0) addLine(e.type, h, layer, arcPoints(c[0], c[1], c[2], r, a0, a1).map(T), { pick: false });
          break;
        }

        case 'ELLIPSE': {
          const c = pt(e), ax = pt(e, 11), ratio = getN(e, 40, 1);
          let p0 = getN(e, 41, 0), p1 = getN(e, 42, Math.PI * 2);
          if (p1 <= p0) p1 += Math.PI * 2;
          const n = Math.max(8, Math.ceil((p1 - p0) / ARC_STEP)), pts = [];
          for (let k = 0; k <= n; k++) {
            const a = p0 + ((p1 - p0) * k) / n, ca = Math.cos(a), sa = Math.sin(a) * ratio;
            pts.push(T([c[0] + ax[0] * ca - ax[1] * sa, c[1] + ax[1] * ca + ax[0] * sa, c[2] + ax[2] * ca]));
          }
          addLine('ELLIPSE', h, layer, pts, { pick: false });
          break;
        }

        case 'SPLINE': {
          // Наближення: через точки підгонки (11) або керувальні точки (10)
          const fit = [], ctrl = [];
          let cur = null;
          for (const [c, v] of e.g) {
            if (c === 10 || c === 11) { cur = [num(v), 0, 0]; (c === 10 ? ctrl : fit).push(cur); }
            else if ((c === 20 || c === 21) && cur) cur[1] = num(v);
            else if ((c === 30 || c === 31) && cur) cur[2] = num(v);
          }
          addLine('SPLINE', h, layer, (fit.length >= 2 ? fit : ctrl).map(T), { closed: getN(e, 70) & 1, pick: false });
          break;
        }

        case '3DFACE': {
          const q = [P(10), P(11), P(12), P(13)];
          const same = q[3].every((v, k) => v === q[2][k]);
          addLine('3DFACE', h, layer, same ? q.slice(0, 3) : q, { closed: true, pick: false });
          break;
        }

        case 'SOLID':
        case 'TRACE': {
          const q = [P(10), P(11), P(13), P(12)];
          addLine(e.type, h, layer, q, { closed: true, pick: false });
          break;
        }

        case 'TEXT': {
          const aligned = getN(e, 72) || getN(e, 73);
          addText(get(e, 1, ''), aligned ? P(11) : P(10), layer, getN(e, 40, 1) * scale);
          break;
        }

        case 'MTEXT': {
          let s = '';
          for (const [c, v] of e.g) if (c === 3 || c === 1) s += v;
          addText(cleanMText(s), P(10), layer, getN(e, 40, 1) * scale);
          break;
        }

        case 'INSERT':
        case 'DIMENSION': {
          const b = blocks.get(get(e, 2, '').trim());
          // Атрибути блоку (номер точки тощо)
          const attribs = [];
          if (e.type === 'INSERT' && get(e, 66) === '1') {
            while (i + 1 < ents.length && ents[i + 1].type === 'ATTRIB') attribs.push(ents[++i]);
            if (i + 1 < ents.length && ents[i + 1].type === 'SEQEND') i++;
          }
          // Для вмісту блоку «за блоком» = колір/тип лінії цієї вставки (а «за шаром» вставки — колір її шару)
          const own = { color: st.color ?? layers.get(layer)?.color ?? null, lt: st.lt };
          const mine = sty;
          if (e.type === 'DIMENSION') {
            if (b && depth < 10) walk(b.ents, T, layer, scale, depth + 1, own);
            sty = mine;
            break;
          }
          const pos = pt(e), sx = getN(e, 41, 1), sy = getN(e, 42, 1), sz = getN(e, 43, 1), rot = getN(e, 50);
          const cols = Math.max(1, getN(e, 70, 1)), rows = Math.max(1, getN(e, 71, 1));
          const dc = getN(e, 44), dr = getN(e, 45);
          for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
            const off = [pos[0] + c * dc, pos[1] + r * dr, pos[2]];
            if (b && depth < 10) walk(b.ents, insertTransform(T, b.base, off, sx, sy, sz, rot), layer, scale * Math.abs(sx), depth + 1, own);
          }
          sty = mine; // відновити стиль вставки після обходу вмісту блоку
          // Точка вставки — як точка зйомки; назва з першого непорожнього атрибута
          const vals = attribs.filter((a) => !(getN(a, 70) & 1)).map((a) => ({ tag: get(a, 2, '').trim(), val: decodeUnicode(get(a, 1, '')).trim() })).filter((a) => a.val);
          if (depth === 0) {
            out.points.push(vtx(T(pos), layer, {
              name: vals[0]?.val ?? '',
              attrs: [`Block: ${get(e, 2, '').trim()}`, ...vals.slice(1).map((a) => `${a.tag}=${a.val}`)],
            }));
          }
          for (const a of attribs) {
            if (getN(a, 70) & 1) continue;
            const aligned = getN(a, 72) || getN(a, 74);
            const aLayer = (get(a, 8, layer) || layer).trim();
            sty = { color: styleOf(a, aLayer, own).color, dash: null };
            addText(get(a, 1, ''), T(aligned ? pt(a, 11) : pt(a, 10)), aLayer, getN(a, 40, 1) * scale);
          }
          sty = mine;
          break;
        }

        default:
          break; // HATCH, IMAGE, VIEWPORT, WIPEOUT… — не відображаємо
      }
    }
  }

  walk(S.ENTITIES, IDENTITY, null, 1, 0);
  if (!out.points.length && !out.lines.length && !out.texts.length) throw new Error(t('e.noData'));
  return { cp: { layers }, ...out };
}
