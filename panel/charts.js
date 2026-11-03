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

const DAY = 86_400_000;

/** "Jan 5 – Jan 11, 2025" for a bucket that covers several days. */
const span = (day, length) => {
  const fmt = (ms, year) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(year && { year: 'numeric' }), timeZone: 'UTC' });
  const start = Date.parse(day);
  return `${fmt(start)} – ${fmt(start + (length - 1) * DAY, true)}`;
};

/**
 * series: [{ name, values: number[] }]  (one or two)
 * labels: the x values (days, YYYY-MM-DD), each the first day of its bucket
 * spans:  how many days each bucket covers (default 1 each); wider buckets are drawn wider, and their
 *         values are read as an average per day
 * type:   'bar' | 'line'
 */
export function chart({ labels, series, spans, type = 'bar', minZero = true, wide = false }) {
  // Narrow cards get a narrower drawing, so the axis text stays readable when scaled down.
  const W = wide ? 760 : 400;
  const H = wide ? 240 : 220;
  const all = series.flatMap((s) => s.values.filter((v) => v != null));
  if (!all.length || all.every((v) => v === 0)) return '<div class="empty">Nothing recorded yet.</div>';

  const lo = minZero ? 0 : Math.min(...all);
  const hi = niceMax(Math.max(...all) - lo) + lo;
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const y = (v) => PAD.top + ih - ((v - lo) / (hi - lo || 1)) * ih;
  // Each bucket's share of the width, in days: its left edge and its width.
  const widths = spans ?? labels.map(() => 1);
  const total = widths.reduce((a, b) => a + b, 0);
  const starts = widths.map((_, i) => widths.slice(0, i).reduce((a, b) => a + b, 0));
  const uniform = widths.every((w) => w === 1);
  const left = (i) => PAD.left + (starts[i] / total) * iw;
  const slotW = (i) => (widths[i] / total) * iw;
  const mid = (i) => left(i) + slotW(i) / 2;
  const x = (i) => (uniform ? PAD.left + (labels.length === 1 ? iw / 2 : (i * iw) / (labels.length - 1)) : mid(i));
  const tip = (i, v, name) =>
    widths[i] > 1 ? `${span(labels[i], widths[i])}: ${num(v)} ${name}${name === 'members' ? ' on average' : ' a day on average'}` : `${labels[i]}: ${num(v)} ${name}`;

  let svg = '';
  for (let t = 0; t <= 4; t++) {
    const v = lo + ((hi - lo) * t) / 4;
    svg += `<line class="grid-line" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text class="axis" x="${PAD.left - 6}" y="${y(v) + 4}" text-anchor="end">${num(Math.round(v))}</text>`;
  }
  const labelX = (i) => (type === 'bar' ? mid(i) : x(i));
  // Rolled-up stretches go back years, so their labels carry the year.
  const labelText = (label) => (uniform ? shortDay(label) : `${shortDay(label)}/${label.slice(2, 4)}`);
  if (uniform) {
    const every = Math.ceil(labels.length / (wide ? 10 : 5));
    labels.forEach((label, i) => {
      const last = i === labels.length - 1;
      // The last day is always labeled; the regular label before it is dropped if they'd collide.
      if ((i % every === 0 && !(labels.length - 1 - i < every * 0.6 && !last)) || last) {
        svg += `<text class="axis" x="${labelX(i)}" y="${H - 6}" text-anchor="middle">${esc(labelText(label))}</text>`;
      }
    });
  } else {
    // Buckets differ in width, so labels are spaced by distance instead of by count.
    const gap = iw / (wide ? 9 : 4.5);
    const lastX = labelX(labels.length - 1);
    let prev = -Infinity;
    labels.forEach((label, i) => {
      const last = i === labels.length - 1;
      const lx = labelX(i);
      if (last || (lx - prev >= gap && lastX - lx >= gap * 0.75)) {
        svg += `<text class="axis" x="${lx}" y="${H - 6}" text-anchor="middle">${esc(labelText(label))}</text>`;
        prev = lx;
      }
    });
  }

  if (type === 'bar') {
    const unit = iw / total; // one day's width
    series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        if (!v) return;
        const slot = slotW(i);
        // A rolled bucket keeps a one-day gap like the daily bars, instead of growing its gap with its width.
        const bw = Math.max(Math.min((slot - unit * 0.2) / series.length, uniform ? 28 : Infinity), 1);
        const bx = left(i) + (slot - bw * series.length) / 2 + si * bw;
        svg += `<rect class="s${si + 1}${widths[i] > 1 ? ' rolled' : ''}" x="${bx}" y="${y(v)}" width="${bw}" height="${y(lo) - y(v)}" rx="2"><title>${esc(tip(i, v, s.name))}</title></rect>`;
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
        if (v != null) svg += `<circle class="s${si + 1}" cx="${x(i)}" cy="${y(v)}" r="3"><title>${esc(tip(i, v, s.name))}</title></circle>`;
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
