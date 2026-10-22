// Читання файлів CAPLAN (Cremer):
//   *.CPZ — ZIP-архів проєкту;
//   *.CP  — файл проєкту (DATA=, LAYER=, ZOOM=, VIEW=...);
//   *.L / *.KOR — точки та лінії:
//       "<Назва> <W> <Rechtswert> <Hochwert> [<Höhe>] |<Objektart>|<Атрибути>..."  — точка
//       "<Назва лінії>                                |<Objektart>|..."            — початок лінії
//     Точки після заголовка лінії належать цій лінії до наступного заголовка.

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
  if (eocd < 0) throw new Error('Файл не є ZIP-архівом (CPZ)');

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== SIG_CEN) throw new Error('Пошкоджений каталог ZIP');
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
    if (flags & 1) throw new Error(`Файл «${name}» в архіві зашифрований`);
    if (dv.getUint32(loc, true) !== SIG_LOC) throw new Error('Пошкоджений ZIP-архів');
    const start = loc + 30 + dv.getUint16(loc + 26, true) + dv.getUint16(loc + 28, true);
    const raw = bytes.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error(`Непідтримуваний метод стиснення ${method} («${name}»)`);
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

export function parseL(text) {
  const out = { header: [], points: [], lines: [] };
  let cur = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) { cur = null; continue; }
    if (rawLine.trimStart().startsWith('!')) {
      const c = rawLine.replace(/^\s*!\s?/, '').trim();
      if (c && !/^-+$/.test(c)) out.header.push(c);
      continue;
    }
    const bar = rawLine.indexOf('|');
    const main = bar >= 0 ? rawLine.slice(0, bar) : rawLine;
    const attrs = bar >= 0 ? rawLine.slice(bar + 1).split('|').map((s) => s.trim()) : [];
    const layer = attrs[0] || '0';
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
      (cur ? cur.pts : out.points).push(p);
    } else {
      const name = main.trim();
      if (!name) continue;
      cur = { name, layer, attrs: attrs.slice(1), pts: [] };
      out.lines.push(cur);
    }
  }
  return out;
}

// ---------------------------------------------------------------- Завантаження набору файлів

const SKIP_EXT = new Set(['jpg', 'jpeg', 'png', 'bmp', 'gif', 'tif', 'tiff', 'db', 'pdf', 'dxf', 'dwg', 'zip']);
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

  const project = { name, cp: null, header: [], points: [], lines: [], sources: [] };
  for (const e of entries) {
    const x = ext(e.name);
    if (SKIP_EXT.has(x)) continue;
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
  if (!project.sources.length) throw new Error('У файлі не знайдено точок або ліній (очікується .L / .KOR всередині CPZ)');
  return project;
}
