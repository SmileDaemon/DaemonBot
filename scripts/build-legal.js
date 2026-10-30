/**
 * Turns TERMS.md and PRIVACY.md into panel/terms.html and panel/privacy.html,
 * styled like the panel, so the site links to its own pages instead of GitHub.
 * The Markdown files stay the only copy to edit: the pages are generated (and
 * git-ignored), by the publish workflow and whenever `npm run panel` starts.
 *
 *     npm run legal
 *
 * Handles only what the two documents use: #–### headings, paragraphs, "- "
 * lists, pipe tables, **bold**, *italic* and [links](url).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const PAGES = { 'TERMS.md': 'terms.html', 'PRIVACY.md': 'privacy.html' };

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(text) {
  return escape(text)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      if (PAGES[href]) return `<a href="${PAGES[href]}">${label}</a>`;
      return `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>');
}

const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function render(markdown) {
  const out = [];
  const lines = markdown.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (!line.trim()) {
      i++;
    } else if (heading) {
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      i++;
    } else if (line.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) items.push(`<li>${inline(lines[i++].slice(2))}</li>`);
      out.push(`<ul>${items.join('')}</ul>`);
    } else if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const [head, , ...body] = rows; // rows[1] is the |---| separator
      out.push(
        '<div class="table-wrap"><table>' +
          `<thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>` +
          `<tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>` +
          '</table></div>',
      );
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|- |\|)/.test(lines[i])) para.push(lines[i++].trim());
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }
  return out.join('\n');
}

function page(title, body) {
  return `<!doctype html>
<!-- Generated from ${title.file} by scripts/build-legal.js. Edit the Markdown, not this file. -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${escape(title.text)} · DaemonBot</title>
  <meta name="theme-color" content="#050805">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' fill='%23050805'/%3E%3Ctext x='16' y='22' font-size='15' text-anchor='middle' fill='%2339ff6e' font-family='monospace' font-weight='700'%3E%3E_%3C/text%3E%3C/svg%3E">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="topbar"><a class="brand" href="./">DaemonBot</a></header>
  <main class="legal">
${body}
  </main>
  <footer class="site-footer small muted">
    <a href="terms.html">Terms of Service</a>
    <span aria-hidden="true">·</span>
    <a href="privacy.html">Privacy Policy</a>
  </footer>
</body>
</html>
`;
}

export function buildLegal() {
  for (const [file, html] of Object.entries(PAGES)) {
    const markdown = readFileSync(join(ROOT, file), 'utf8');
    const text = markdown.match(/^#\s+(.*)$/m)?.[1].replace(/^DaemonBot\s+/, '') ?? file;
    writeFileSync(join(ROOT, 'panel', html), page({ file, text }, render(markdown)));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildLegal();
  console.log(`Wrote ${Object.values(PAGES).map((p) => `panel/${p}`).join(' and ')}`);
}
