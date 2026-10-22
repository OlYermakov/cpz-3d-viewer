// Каталог Objektart (catalog/ObjType.DAT з CAPLAN), вбудований у збірку як текст.
// Рядок: Objektart|Symbol|Größe|Drehung|Linientyp|Spline|Füllmuster|Faktor|Drehung|Farbe|Strichstärke|Kurz|Bedeutung|Layer|Attribute...
import catalogText from '../catalog/ObjType.DAT';
import translations from './objtypes-i18n.js';
import { getLang } from './i18n.js';

const bgrToRgb = (c) => ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff);

function parseObjType(text) {
  const map = new Map();
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith('!')) continue;
    const f = raw.split('|').map((s) => s.trim());
    const id = f[0];
    if (!id) continue;
    const de = f[12] ?? '';
    const color = parseInt(f[9], 10);
    map.set(id, {
      // Заглушки на кшталт «Objektart 86» або назва, що дорівнює номеру, — назви немає
      de: !de || de === id || /^Objektart\s/i.test(de) ? '' : de,
      color: Number.isFinite(color) && color >= 0 ? bgrToRgb(color) : null,
      layer: f[13] ?? '',
    });
  }
  return map;
}

const catalog = parseObjType(catalogText);

/** Назва Objektart поточною мовою ('' — якщо в каталозі немає назви). */
export function objName(id) {
  const e = catalog.get(String(id));
  if (!e?.de) return '';
  const lang = getLang();
  if (lang === 'de') return e.de;
  const tr = translations[e.de.toLowerCase()];
  return tr ? tr[lang === 'uk' ? 0 : 1] : e.de;
}

/** Колір Objektart з каталогу (RGB) або null, якщо «від шару». */
export const objColor = (id) => catalog.get(String(id))?.color ?? null;

export const catalogSize = catalog.size;
