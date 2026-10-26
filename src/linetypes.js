// Типи ліній CAPLAN для креслень CPZ. Тип лінії Objektart береться з каталогу (ObjType.DAT, поле 5
// «Linientyp»), а якщо там 0 («von Layer») — з налаштувань шару (Layer.DAT, поле 6).
// Малюнок типу описано в Linien.DAT рухами пера в сантиметрах аркуша:
//   [назва]  PERIOD=довжина періоду
//   p <перо 0|1> <x уздовж лінії> <y убік від лінії>   — 0: перемістити, 1: провести лінію
//   s …  символ на лінії,  h …  заливка — не відображаються
// Типи 1–6 вбудовані в CAPLAN і в файлах не описані: 1 — суцільна, 2–6 — звичайні для креслень
// малюнки (штрих, крапки, штрих-крапка тощо), можуть трохи відрізнятися від CAPLAN.
import layerText from '../catalog/Layer.DAT';
import linesText from '../catalog/Linien.DAT';
import catalogText from '../catalog/ObjType.DAT';

// Аркуш → місцевість: у 3D немає масштабу плану, береться типовий для зйомки 1:500 (1 см = 5 м)
const CM_TO_M = 5;

const rows = (text) => text.replace(/^﻿/, '').split(/\r?\n/).filter((r) => r.trim() && !r.startsWith('!'));

// Штрих / проміжок (см) → рухи пера: >0 штрих, <0 проміжок, 0 крапка
function fromDashes(dashes) {
  const strokes = [];
  let x = 0;
  for (const d of dashes) {
    const len = d === 0 ? 0.02 : Math.abs(d);
    if (d >= 0) strokes.push([0, x, 0], [1, x + len, 0]);
    x += len;
  }
  return { period: x, strokes };
}

const BUILTIN = {
  2: fromDashes([0.4, -0.15]), // штрихова
  3: fromDashes([0, -0.15]), // пунктир (крапки)
  4: fromDashes([0.5, -0.12, 0, -0.12]), // штрих-крапка
  5: fromDashes([0.5, -0.12, 0, -0.12, 0, -0.12]), // штрих-дві крапки
  6: fromDashes([0.8, -0.12, 0.15, -0.12]), // довгий і короткий штрих (осі)
};

function parseLinien(text) {
  const types = new Map();
  let cur = null, fill = false;
  for (const r of text.split(/\r?\n/)) {
    const s = r.trim();
    const head = s.match(/^\[(.+)\]$/);
    if (head) { cur = { period: 0, strokes: [] }; fill = false; types.set(head[1].trim(), cur); continue; }
    if (!cur) continue;
    if (s.startsWith('PERIOD=')) cur.period = parseFloat(s.slice(7)) || 0;
    else if (s[0] === 'h') fill = true; // контур заливки після «h» — не лінія
    else if (s[0] === 'p' && !fill) {
      const [, pen, x, y] = s.split(/\s+/).map(Number);
      cur.strokes.push([pen, x, y]);
    }
  }
  for (const [k, v] of types) if (!(v.period > 0) || !v.strokes.some((p) => p[0] === 1)) types.delete(k);
  return types;
}

const patterns = parseLinien(linesText);
for (const [k, v] of Object.entries(BUILTIN)) patterns.set(k, v);

// Шар → тип лінії (Layer.DAT: Name|RGB|Sichtbar|Stift|Drucken|Linienart|…)
const layerType = new Map();
for (const r of rows(layerText)) {
  const f = r.split('|').map((s) => s.trim());
  if (f[0]) layerType.set(f[0].toUpperCase(), f[5] ?? '');
}

// Objektart → тип лінії (ObjType.DAT: поле 5 — тип, поле 14 — шар)
const objType = new Map();
for (const r of rows(catalogText)) {
  const f = r.split('|').map((s) => s.trim());
  if (!f[0]) continue;
  const own = f[4] && f[4] !== '0' ? f[4] : '';
  objType.set(f[0], own || layerType.get((f[13] ?? '').toUpperCase()) || '');
}

const scaled = new Map();

/**
 * Малюнок типу лінії Objektart у метрах: { period, strokes: [[перо, x, y], …] }
 * або null для суцільної лінії.
 */
export function linePattern(objektart) {
  const name = objType.get(String(objektart));
  if (!name || name === '1') return null;
  if (scaled.has(name)) return scaled.get(name);
  const p = patterns.get(name);
  const res = p ? { name, period: p.period * CM_TO_M, strokes: p.strokes.map(([pen, x, y]) => [pen, x * CM_TO_M, y * CM_TO_M]) } : null;
  scaled.set(name, res);
  return res;
}
