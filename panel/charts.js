// Small SVG charts: no library, colors from the stylesheet.
import { esc, num } from './util.js';

const PAD = { top: 10, right: 8, bottom: 26, left: 40 };

function niceMax(value) {
  if (value <= 5) return 5;
  const mag = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * mag >= value) return step * mag;
  return 10 * mag;
}

const shortDay = (day) => {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
};

/**
 * series: [{ name, values: number[] }]  (one or two)
 * labels: the x values (days, YYYY-MM-DD)
 * type:   'bar' | 'line'
 */
export function chart({ labels, series, type = 'bar', minZero = true, wide = false }) {
  // Narrow cards get a narrower drawing, so the axis text stays readable when scaled down.
  const W = wide ? 760 : 400;
  const H = wide ? 240 : 220;
  const all = series.flatMap((s) => s.values.filter((v) => v != null));
  if (!all.length || all.every((v) => v === 0)) return '<div class="empty">Nothing recorded yet.</div>';

  const lo = minZero ? 0 : Math.min(...all);
  const hi = niceMax(Math.max(...all) - lo) + lo;
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i) => PAD.left + (labels.length === 1 ? iw / 2 : (i * iw) / (labels.length - 1));
  const y = (v) => PAD.top + ih - ((v - lo) / (hi - lo || 1)) * ih;

  let svg = '';
  for (let t = 0; t <= 4; t++) {
    const v = lo + ((hi - lo) * t) / 4;
    svg += `<line class="grid-line" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text class="axis" x="${PAD.left - 6}" y="${y(v) + 4}" text-anchor="end">${num(Math.round(v))}</text>`;
  }
  const every = Math.ceil(labels.length / (wide ? 10 : 5));
  labels.forEach((label, i) => {
    const last = i === labels.length - 1;
    // The last day is always labeled; the regular label before it is dropped if they'd collide.
    if ((i % every === 0 && !(labels.length - 1 - i < every * 0.6 && !last)) || last) {
      const lx = type === 'bar' ? PAD.left + (i + 0.5) * (iw / labels.length) : x(i);
      svg += `<text class="axis" x="${lx}" y="${H - 6}" text-anchor="middle">${esc(shortDay(label))}</text>`;
    }
  });

  if (type === 'bar') {
    const slot = iw / labels.length;
    const bw = Math.max(Math.min((slot * 0.8) / series.length, 28), 1);
    series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        if (!v) return;
        const bx = PAD.left + i * slot + (slot - bw * series.length) / 2 + si * bw;
        svg += `<rect class="s${si + 1}" x="${bx}" y="${y(v)}" width="${bw}" height="${y(lo) - y(v)}" rx="2"><title>${esc(labels[i])}: ${num(v)} ${esc(s.name)}</title></rect>`;
      });
    });
  } else {
    series.forEach((s, si) => {
      const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean);
      if (!pts.length) return;
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join('');
      if (series.length === 1 && minZero) svg += `<path class="area s${si + 1}" d="${d}L${pts.at(-1)[0]},${y(lo)}L${pts[0][0]},${y(lo)}Z"/>`;
      svg += `<path class="line s${si + 1}" d="${d}"/>`;
      s.values.forEach((v, i) => {
        if (v != null) svg += `<circle class="s${si + 1}" cx="${x(i)}" cy="${y(v)}" r="3"><title>${esc(labels[i])}: ${num(v)} ${esc(s.name)}</title></circle>`;
      });
    });
  }

  const legend = series.length > 1
    ? `<div class="legend">${series.map((s, i) => `<span style="--c: var(--chart-${i + 1})">${esc(s.name)}</span>`).join('')}</div>`
    : '';
  return `${legend}<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(', '))}">${svg}</svg></div>`;
}

/** A ranked table with a bar behind each value. rows: [[label, value]] */
export function rankTable(rows, { label = 'Name', value = 'Count', format = num, limit = 10 } = {}) {
  if (!rows.length) return '<div class="empty">Nothing recorded yet.</div>';
  const top = rows.slice(0, limit);
  const max = Math.max(...top.map((r) => r[1])) || 1;
  return `<div class="table-wrap"><table><thead><tr><th>${esc(label)}</th><th class="num">${esc(value)}</th></tr></thead><tbody>${top
    .map(([name, v]) => `<tr><td class="bar-cell"><span class="bar" style="width:${(v / max) * 100}%"></span>${esc(name)}</td><td class="num">${esc(format(v))}</td></tr>`)
    .join('')}</tbody></table></div>`;
}
