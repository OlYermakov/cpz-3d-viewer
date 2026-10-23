// Фоновий потік читання DWG (LibreDWG, WebAssembly). Отримує байти файлу, повертає креслення
// у вигляді секцій із записами DXF ({ type, g: [[код, значення], …] }) — їх обробляє той самий
// код, що й файли DXF (src/dxf.js: кольори, типи ліній, блоки, атрибути).
// Для кожного файлу створюється новий потік і новий екземпляр модуля: після помилки
// всередині WebAssembly модуль може лишитися пошкодженим, тож повторно його не використовуємо.
import { LibreDwg, Dwg_File_Type } from '@mlightcad/libredwg-web';

const DEG = 180 / Math.PI; // LibreDWG повертає кути в радіанах, DXF — у градусах

// Числові значення передаються числами, а не рядками: у великих DWG мільйони координат,
// рядки на кшталт "3465956.615453982" займали б у рази більше пам'яті (парсер приймає обидва варіанти)
const s = (v) => Number(v ?? 0) || 0;
const xyz = (g, c, p) => { if (p) g.push([c, s(p.x)], [c + 10, s(p.y)], [c + 20, s(p.z ?? 0)]); };
// Нормаль площини об'єкта (210/220/230); нульовий вектор у LibreDWG означає «за замовчуванням» (0,0,1)
const extr = (g, d) => {
  if (d && (Math.abs(d.x) > 1e-12 || Math.abs(d.y) > 1e-12 || d.z < 0)) g.push([210, s(d.x)], [220, s(d.y)], [230, s(d.z)]);
};

// Спільні властивості сутності: шар, дескриптор, колір, тип лінії, масштаб типу, простір аркуша
function common(e) {
  const g = [[8, String(e.layer || '0')], [5, String(e.handle ?? '')]];
  extr(g, e.extrusionDirection);
  if (e.colorIndex !== undefined) g.push([62, s(e.colorIndex)]);
  else if (e.color !== undefined) g.push([420, s(e.color)]);
  if (e.lineType) g.push([6, e.lineType]);
  if (e.lineTypeScale) g.push([48, s(e.lineTypeScale)]);
  if (e.isInPaperSpace) g.push([67, '1']);
  if (e.isVisible === false) g.push([60, '1']);
  return g;
}

function textBase(g, t) {
  g.push([1, t.text ?? '']);
  xyz(g, 10, t.startPoint);
  xyz(g, 11, t.endPoint);
  g.push([40, s(t.textHeight)], [72, s(t.halign)], [73, s(t.valign)]);
}

// Одна сутність DWG → один або кілька записів DXF (POLYLINE + VERTEX… + SEQEND, INSERT + ATTRIB…)
function convert(e, out) {
  const g = common(e);
  switch (e.type) {
    case 'LINE': xyz(g, 10, e.startPoint); xyz(g, 11, e.endPoint); break;
    case 'POINT': xyz(g, 10, e.position); break;
    case 'CIRCLE': xyz(g, 10, e.center); g.push([40, s(e.radius)]); break;
    case 'ARC':
      xyz(g, 10, e.center);
      g.push([40, s(e.radius)], [50, s(e.startAngle * DEG)], [51, s(e.endAngle * DEG)]);
      break;
    case 'ELLIPSE':
      xyz(g, 10, e.center); xyz(g, 11, e.majorAxisEndPoint);
      g.push([40, s(e.axisRatio)], [41, s(e.startAngle)], [42, s(e.endAngle)]);
      break;
    case 'LWPOLYLINE':
      g.push([38, s(e.elevation)], [70, s(e.flag)]);
      for (const v of e.vertices ?? []) g.push([10, s(v.x)], [20, s(v.y)], [42, s(v.bulge)]);
      break;
    case 'POLYLINE2D':
    case 'POLYLINE3D': {
      const is3D = e.type === 'POLYLINE3D';
      g.push([70, s((e.flag ?? 0) | (is3D ? 8 : 0))], [30, s(e.elevation ?? 0)]);
      out.push({ type: 'POLYLINE', g });
      for (const v of e.vertices ?? []) {
        out.push({ type: 'VERTEX', g: [[8, e.layer || '0'], [10, s(v.x)], [20, s(v.y)], [30, s(v.z ?? 0)], [42, s(v.bulge ?? 0)], [70, s(is3D ? 32 : 0)]] });
      }
      out.push({ type: 'SEQEND', g: [] });
      return;
    }
    case 'SPLINE':
      g.push([70, s(e.flag)]);
      for (const p of e.controlPoints ?? []) xyz(g, 10, p);
      for (const p of e.fitPoints ?? []) xyz(g, 11, p);
      break;
    case '3DFACE':
      xyz(g, 10, e.corner1); xyz(g, 11, e.corner2); xyz(g, 12, e.corner3); xyz(g, 13, e.corner4 ?? e.corner3);
      break;
    case 'SOLID':
    case 'TRACE':
      xyz(g, 10, e.corner1); xyz(g, 11, e.corner2); xyz(g, 12, e.corner3); xyz(g, 13, e.corner4 ?? e.corner3);
      break;
    case 'TEXT': textBase(g, e); break;
    case 'MTEXT': g.push([1, e.text ?? '']); xyz(g, 10, e.insertionPoint); g.push([40, s(e.textHeight)]); break;
    case 'DIMENSION': g.push([2, e.name ?? '']); break;
    case 'INSERT': {
      g.push([2, e.name ?? '']);
      xyz(g, 10, e.insertionPoint);
      g.push([41, s(e.xScale ?? 1)], [42, s(e.yScale ?? 1)], [43, s(e.zScale ?? 1)], [50, s((e.rotation ?? 0) * DEG)]);
      g.push([70, s(e.columnCount || 1)], [71, s(e.rowCount || 1)], [44, s(e.columnSpacing ?? 0)], [45, s(e.rowSpacing ?? 0)]);
      const attribs = e.attribs ?? [];
      if (attribs.length) g.push([66, '1']);
      out.push({ type: 'INSERT', g });
      if (attribs.length) {
        for (const a of attribs) {
          const ag = common(a);
          if (!a.extrusionDirection) extr(ag, a.text?.extrusionDirection);
          ag.push([2, a.tag ?? ''], [70, s(a.flags)]);
          textBase(ag, a.text ?? {});
          xyz(ag, 11, a.alignmentPoint);
          out.push({ type: 'ATTRIB', g: ag });
        }
        out.push({ type: 'SEQEND', g: [] });
      }
      return;
    }
    default:
      return; // HATCH, IMAGE, VIEWPORT, ACAD_PROXY_ENTITY… — не відображаються (як і в DXF)
  }
  out.push({ type: e.type, g });
}

function toSections(db) {
  const HEADER = [[9, '$LTSCALE'], [40, s(db.header?.LTSCALE ?? 1)]];
  const TABLES = [];
  for (const l of db.tables.LAYER.entries) {
    // Колір шару: індекс палітри 1–255 або точний RGB; вимкнений шар — від'ємний індекс (як у DXF)
    const ci = l.colorIndex >= 1 && l.colorIndex <= 255 ? l.colorIndex : 7;
    const g = [[2, l.name], [70, s(l.frozen ? 1 : 0)], [6, l.lineType ?? ''], [370, s(l.lineweight ?? -3)]];
    if (l.colorIndex >= 1 && l.colorIndex <= 255) g.push([62, s(l.off ? -ci : ci)]);
    else { g.push([62, s(l.off ? -7 : 7)]); if (l.color !== undefined) g.push([420, s(l.color)]); }
    TABLES.push({ type: 'LAYER', g });
  }
  for (const lt of db.tables.LTYPE.entries) {
    TABLES.push({ type: 'LTYPE', g: [[2, lt.name], ...(lt.pattern ?? []).map((p) => [49, s(p.elementLength)])] });
  }
  const BLOCKS = [];
  for (const b of db.tables.BLOCK_RECORD.entries) {
    if (/^\*(model|paper)_space/i.test(b.name)) continue; // вміст простору моделі — у db.entities
    const bg = [[2, b.name]];
    xyz(bg, 10, b.basePoint);
    BLOCKS.push({ type: 'BLOCK', g: bg });
    for (const e of b.entities ?? []) convert(e, BLOCKS);
    BLOCKS.push({ type: 'ENDBLK', g: [] });
  }
  const ENTITIES = [];
  for (const e of db.entities) convert(e, ENTITIES);
  return { HEADER, TABLES, BLOCKS, ENTITIES };
}

self.onmessage = async (ev) => {
  const { bytes, wasmDir } = ev.data;
  try {
    const lib = await LibreDwg.create(wasmDir);
    const dwg = lib.dwg_read_data(bytes, Dwg_File_Type.DWG);
    if (!dwg) throw new Error('read');
    const db = lib.convert(dwg);
    lib.dwg_free(dwg);
    self.postMessage({ ok: true, sections: toSections(db) });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) });
  }
};
