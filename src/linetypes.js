// Типи ліній CAPLAN для креслень CPZ. Тип лінії Objektart береться з каталогу (ObjType.DAT, поле 5
// «Linientyp»), а якщо там 0 («von Layer») — з налаштувань шару (Layer.DAT, поле 6).
// Малюнок типу описано в Linien.DAT рухами пера в сантиметрах аркуша:
//   [назва]  PERIOD=довжина періоду
//   p <перо 0|1> <x уздовж лінії> <y убік від лінії>   — 0: перемістити, 1: провести лінію
//   s <x> <y> <–> <розмір> <поворот°> <номер символу>  — символ на лінії
//   h …  заливка — не відображається
// Стандартні типи 1–6 вбудовані в CAPLAN і в файлах не описані: довжини штрихів виміряно на
// зображенні з довідки CAPLAN (CAHLP4.CHM, «Linienmuster»; 40 пікселів = 1 см, як у типу 7 з Linien.DAT).
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
  2: fromDashes([0.05, -0.11]), // дрібний пунктир (крапки)
  3: fromDashes([0.1, -0.15]), // короткий штрих
  4: fromDashes([0.15, -0.2]), // штрих
  5: fromDashes([0.25, -0.1, 0.07, -0.1]), // штрих-крапка
  6: fromDashes([0.375, -0.15, 0.125, -0.15]), // довгий і короткий штрих (осі)
};

// Вбудовані символи CAPLAN, що трапляються в Linien.DAT, — у файлах їх немає, тому форму відтворено
// за зображенням типів 9, 12–16 у довідці. Координати в межах −0,5…0,5 (масштабуються розміром),
// рухи пера як у «p»: [перо, x, y].
const square = [[0, -0.5, -0.5], [1, 0.5, -0.5], [1, 0.5, 0.5], [1, -0.5, 0.5], [1, -0.5, -0.5]];
const filledSquare = [...square];
for (const y of [-0.25, 0, 0.25]) filledSquare.push([0, -0.5, y], [1, 0.5, y]);
// «Ω»: дуга, відкрита донизу, з «ніжками»
const omega = [[0, -0.45, -0.3]];
for (let i = 0; i <= 14; i++) {
  const a = ((230 - (i * 280) / 14) * Math.PI) / 180;
  omega.push([1, 0.35 * Math.cos(a), 0.05 + 0.35 * Math.sin(a)]);
}
omega.push([1, 0.45, -0.3]);
const SYMBOLS = {
  1: filledSquare,
  3: filledSquare,
  11: [[0, 0, -0.5], [1, 0.5, 0], [1, 0, 0.5], [1, -0.5, 0], [1, 0, -0.5]], // ромб (повернутий на −45° — квадрат)
  83: omega,
  97: [[0, 0.15, 1], [1, -0.2, 0.52], [1, 0.2, 0.48], [1, -0.15, 0]], // блискавка над лінією
};

// Символ на лінії → рухи пера в координатах малюнка (x уздовж, y убік)
function symbolStrokes(x, y, size, rot, no) {
  const shape = SYMBOLS[no];
  if (!shape || !(size > 0)) return [];
  const r = (rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return shape.map(([pen, u, v]) => [pen, x + (u * c - v * s) * size, y + (u * s + v * c) * size]);
}

function parseLinien(text) {
  const types = new Map();
  let cur = null, fill = false, pos = [0, 0];
  for (const r of text.split(/\r?\n/)) {
    const s = r.trim();
    const head = s.match(/^\[(.+)\]$/);
    if (head) { cur = { period: 0, strokes: [], len: 0 }; fill = false; types.set(head[1].trim(), cur); continue; }
    if (!cur) continue;
    if (s.startsWith('PERIOD=')) cur.period = parseFloat(s.slice(7)) || 0;
    else if (s[0] === 'h') fill = true; // контур заливки після «h» — не лінія
    else if (s[0] === 'p' && !fill) {
      const [, pen, x, y] = s.split(/\s+/).map(Number);
      cur.strokes.push([pen, x, y]);
      if (pen === 1) cur.len = Math.max(cur.len, x);
      pos = [x, y];
    } else if (s[0] === 's') {
      // Символ малюється окремо від лінії: після нього перо повертається туди, де було
      const [, x, y, , size, rot, no] = s.split(/\s+/).map(Number);
      const sym = symbolStrokes(x, y, size, rot, no);
      if (sym.length) cur.strokes.push(...sym, [0, pos[0], pos[1]]);
    }
  }
  // Малюнок повторюється з кроком, що дорівнює довжині його ліній, а не PERIOD: так у довідці CAPLAN
  // тип 8 (PERIOD=0.4, лінії до 0.3) — суцільна подвійна лінія з поперечками через 0,3 см
  for (const [k, v] of types) {
    if (v.len > 0) v.period = v.len;
    delete v.len;
    if (!(v.period > 0) || !v.strokes.some((p) => p[0] === 1)) types.delete(k);
  }
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
export const linePattern = (objektart) => namedPattern(objType.get(String(objektart)));

/** Малюнок типу лінії за назвою (номер 2–18 або назва з Linien.DAT) у метрах, або null. */
export function namedPattern(name) {
  if (!name || name === '1') return null;
  if (scaled.has(name)) return scaled.get(name);
  const p = patterns.get(name);
  const res = p ? { name, period: p.period * CM_TO_M, strokes: p.strokes.map(([pen, x, y]) => [pen, x * CM_TO_M, y * CM_TO_M]) } : null;
  scaled.set(name, res);
  return res;
}
