// Capture the four dashboard views of a built site as README screenshots.
//
//   node tools/capture.mjs [dist-dir] [chrome-path]
//
// <dist-dir> defaults to dist/ and must already hold dashboard/ + data.js
// (run `node main.ts` first). Screenshots land in docs/ at 1440x900 PNG.
// The views are the dashboard's own deep links: board, signals, ETF
// flows, indices. Chrome is the puppeteer chrome-headless-shell when no
// path is given (the system chromium refuses headless use here).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

function findChrome() {
  const cache = join(homedir(), '.cache', 'puppeteer', 'chrome-headless-shell');
  if (existsSync(cache)) {
    for (const build of readdirSync(cache).sort().reverse()) {
      const bin = join(cache, build, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (existsSync(bin)) return bin;
    }
  }
  throw new Error('chrome-headless-shell not found under ~/.cache/puppeteer; pass a chrome path as argv[3]');
}

const distDir = resolve(process.argv[2] ?? 'dist');
const chrome = process.argv[3] ?? process.env.CHROME_PATH ?? findChrome();
const docsDir = resolve('docs');
mkdirSync(docsDir, { recursive: true });

const page = `file://${join(distDir, 'dashboard', 'index.html')}`;
const views = [
  { file: 'view-board.png', url: page },
  { file: 'view-signals.png', url: `${page}#tab=signals` },
  { file: 'view-etf.png', url: `${page}#tab=etf` },
  { file: 'view-indices.png', url: `${page}#tab=indices` },
];

for (const view of views) {
  const png = join(docsDir, view.file);
  execFileSync(chrome, [
    '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--window-size=1440,900',
    '--virtual-time-budget=9000', `--screenshot=${png}`, view.url,
  ], { stdio: 'inherit' });
  if (!existsSync(png)) throw new Error(`chrome wrote no screenshot for ${view.url}`);
  process.stdout.write(`${view.file}: ${statSync(png).size} bytes\n`);
}
process.stdout.write(`captured ${views.length} screenshots into ${docsDir}\n`);
