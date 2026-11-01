// Осі CAPLAN (файл *.A у CPZ): трасування в плані (Hz) і градієнта (Gr). Рядки з полями фіксованої
// ширини (числа можуть злипатися, тому ділимо за позиціями, а не за пробілами):
//   <Achsname> 00 <Achsname>                                                   — початок осі
//   <Achsname> 31|35  Rechtswert Hochwert RiWi A-Station A-Krumm*1000 E-Krumm*1000 Länge  — елемент у плані
//   <Achsname> 41     A-Höhe     E-Höhe   –    A-Station A-Krumm*1000 E-Krumm*1000 Länge  — елемент градієнти
// Елемент у плані — пряма (кривина 0), дуга (стала кривина) або клотоїда (кривина змінюється лінійно).
// RiWi — дирекційний кут у гонах (від півночі за годинниковою стрілкою); додатна кривина — поворот праворуч.

const W = [14, 14, 12, 12, 14, 14, 12]; // ширини полів після коду типу
const GON = Math.PI / 200;

function fields(line, from) {
  const out = [];
  let p = from;
  for (const w of W) { out.push(parseFloat(line.slice(p, p + w))); p += w; }
  return out;
}

export function parseA(text) {
  const axes = new Map();
  const get = (name) => {
    if (!axes.has(name)) axes.set(name, { name, hz: [], gr: [] });
    return axes.get(name);
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('!')) continue;
    const m = line.match(/^(.*?\S)\s+(\d\d)(?=\s|$)/);
    if (!m) continue;
    const [, name, type] = m;
    if (type === '00') { get(name); continue; }
    const [a, b, riwi, st, kA, kE, len] = fields(line, m[0].length);
    if (!(len >= 0)) continue;
    if (type[0] === '3') get(name).hz.push({ type, x: a, y: b, t: riwi * GON, st, kA: kA / 1000, kE: kE / 1000, len });
    else if (type[0] === '4') get(name).gr.push({ h0: a, h1: b, st, len });
  }
  const list = [...axes.values()].filter((ax) => ax.hz.length);
  // Запобіжник від помилок у даних: якщо зміна напрямку за кривиною не збігається з напрямком
  // наступного елемента (трапляється, напр., кривина 5 на прямій), береться стала кривина,
  // узгоджена з обома напрямками
  for (const ax of list) {
    for (let i = 0; i + 1 < ax.hz.length; i++) {
      const e = ax.hz[i], n = ax.hz[i + 1];
      if (!(e.len > 0)) continue;
      let dt = n.t - e.t;
      dt -= 2 * Math.PI * Math.round(dt / (2 * Math.PI));
      if (Math.abs(dt - ((e.kA + e.kE) / 2) * e.len) > 0.01) { e.kA = e.kE = dt / e.len; e.type = '31'; }
    }
  }
  return list;
}

// Висота осі за станцією з градієнти (лінійно в межах елемента); null — немає градієнти
function heightAt(gr, st) {
  for (const g of gr) {
    if (st >= g.st - 1e-6 && st <= g.st + g.len + 1e-6) return g.len > 0 ? g.h0 + (g.h1 - g.h0) * (st - g.st) / g.len : g.h0;
  }
  return null;
}

/**
 * Точки осі в плані з кроком ≤ step м: [{x, y, z, st}]. Висота — з градієнти; якщо станції
 * градієнти не перетинаються зі станціями плану, але довжини збігаються, градієнта зсувається
 * на різницю початкових станцій (у CAPLAN буває план від 0 і градієнта від фактичного кілометражу).
 */
export function axisPoints(ax, step = 2) {
  const pts = [];
  const hz0 = ax.hz[0].st, last = ax.hz.at(-1), hz1 = last.st + last.len;
  let shift = 0;
  if (ax.gr.length) {
    const g0 = ax.gr[0].st, g1 = ax.gr.at(-1).st + ax.gr.at(-1).len;
    if (g1 < hz0 || g0 > hz1) shift = g0 - hz0;
  }
  for (const e of ax.hz) {
    const n = Math.max(1, Math.ceil(e.len / step));
    const ds = e.len / n, L = e.len, dk = e.kE - e.kA;
    // Напрямок = початковий + інтеграл кривини. 31 — клотоїда (кривина лінійна),
    // 35 — крива Блосса (кривина kA + Δk·(3u² − 2u³), u = s/L)
    const dir = e.type === '35'
      ? (s) => { const u = L > 0 ? s / L : 0; return e.t + e.kA * s + dk * L * (u ** 3 - u ** 4 / 2); }
      : (s) => e.t + e.kA * s + (L > 0 ? (dk * s * s) / (2 * L) : 0);
    let x = e.x, y = e.y;
    const push = (s) => pts.push({ x, y, z: heightAt(ax.gr, e.st + s + shift), st: e.st + s });
    if (!pts.length || Math.hypot(pts.at(-1).x - x, pts.at(-1).y - y) > 1e-3) push(0);
    for (let i = 0; i < n; i++) {
      // Сімпсон для напрямку на кроці: точно для прямих і дуг, з малою похибкою для клотоїд
      const s0 = i * ds, sm = s0 + ds / 2, s1 = s0 + ds;
      const sx = (Math.sin(dir(s0)) + 4 * Math.sin(dir(sm)) + Math.sin(dir(s1))) / 6;
      const sy = (Math.cos(dir(s0)) + 4 * Math.cos(dir(sm)) + Math.cos(dir(s1))) / 6;
      x += sx * ds; y += sy * ds;
      push(s1);
    }
  }
  return pts;
}
