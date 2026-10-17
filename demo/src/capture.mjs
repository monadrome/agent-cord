// 逐帧捕获：把 window.__setTime(t) 的每一帧写成 PNG
//   node src/capture.mjs              全量 4200 帧 → frames/%05d.png
//   SMOKE=1 node src/capture.mjs      关键时刻抽样 → smoke/
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PAGE_URL = 'file://' + path.join(HERE, 'index.html');

const FPS = 30;
const TOTAL = 4200;                       // 140.0s
const SMOKE = process.env.SMOKE === '1';
const CONC = Math.max(1, Number(process.env.CONC || 7));
const SMOKE_TIMES = [
  0, 2, 5, 12, 22, 32, 37, 45, 62, 70, 77, 93, 112, 118, 123, 126.5, 132, 139.5
];

const outDir = path.join(ROOT, SMOKE ? 'smoke' : 'frames');
const errors = [];
let aborted = false;

function frameName(i) {
  return String(i).padStart(5, '0') + '.png';
}

async function openPage(ctx, tag) {
  const page = await ctx.newPage();
  page.on('console', m => {
    if (m.type() === 'error') errors.push(`[${tag}] console.error: ${m.text()}`);
  });
  page.on('pageerror', e => {
    errors.push(`[${tag}] pageerror: ${e.message}`);
  });
  page.on('requestfailed', r => {
    errors.push(`[${tag}] requestfailed: ${r.url()} ${r.failure()?.errorText || ''}`);
  });
  await page.goto(PAGE_URL, { waitUntil: 'load' });
  await page.waitForFunction('typeof window.__setTime === "function"', null, { timeout: 30000 });
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  if (bg !== 'rgb(11, 14, 19)') errors.push(`[${tag}] unexpected body background: ${bg}`);
  return page;
}

async function shoot(page, t, file) {
  await page.evaluate(tt => window.__setTime(tt), t);
  await page.screenshot({ path: file, type: 'png' });
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: 'dark'
  });

  const t0 = Date.now();
  if (SMOKE) {
    const page = await openPage(ctx, 'smoke');
    for (const t of SMOKE_TIMES) {
      const i = Math.round(t * FPS);
      const file = path.join(outDir, frameName(i));
      await shoot(page, t, file);
      console.log(`smoke t=${t}s -> ${path.relative(ROOT, file)}`);
    }
    await browser.close();
    if (errors.length) failWith(errors);
    console.log(`smoke done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  const workers = [];
  const per = Math.ceil(TOTAL / CONC);
  const counts = [];
  for (let w = 0; w < CONC; w++) {
    const from = w * per;
    const to = Math.min(TOTAL - 1, from + per - 1);
    if (from > to) break;
    counts.push(to - from + 1);
    workers.push((async () => {
      const page = await openPage(ctx, 'w' + w);
      let n = 0;
      for (let i = from; i <= to; i++) {
        if (aborted) break;
        if (errors.length) { aborted = true; break; }
        await shoot(page, i / FPS, path.join(outDir, frameName(i)));
        n++;
        if (n % 200 === 0) console.log(`  w${w}: ${n}/${to - from + 1} (frame ${i})`);
      }
      await page.close();
      return n;
    })());
  }
  const done = await Promise.all(workers);
  await browser.close();

  if (errors.length) failWith(errors);
  const total = done.reduce((a, b) => a + b, 0);
  console.log(`frames written: ${total} (expected ${TOTAL}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (total !== TOTAL) {
    console.error('ERROR: frame count mismatch');
    process.exit(1);
  }
}

function failWith(errs) {
  console.error(`ERROR: ${errs.length} page error(s):`);
  for (const e of errs.slice(0, 20)) console.error('  ' + e);
  process.exit(1);
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
