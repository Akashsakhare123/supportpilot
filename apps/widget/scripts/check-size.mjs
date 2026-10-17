// Fails the build when dist/widget.js grows beyond the gzip budget (client sites load it).
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUDGET = Number(process.env.WIDGET_MAX_GZIP_BYTES ?? 61_440); // 60 KB
const bundle = readFileSync(new URL('../dist/widget.js', import.meta.url));
const size = gzipSync(bundle, { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`widget.js: ${kb(bundle.length)} raw, ${kb(size)} gzipped (budget ${kb(BUDGET)})`);
if (size > BUDGET) {
  console.error('widget.js is over its size budget');
  process.exit(1);
}
