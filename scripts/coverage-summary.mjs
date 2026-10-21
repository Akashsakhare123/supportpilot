// Combine the coverage-summary.json files written by `pnpm test:coverage` into one markdown table
// (coverage/SUMMARY.md, also printed; CI appends it to the job summary). Thresholds are enforced
// by jest / vitest themselves; this only reports.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suites = [
  ['API (integration tests)', 'apps/api/coverage/integration/coverage-summary.json'],
  ['Worker (unit + integration)', 'apps/worker/coverage/coverage-summary.json'],
  ['packages/ai (unit)', 'packages/ai/coverage/coverage-summary.json'],
  ['packages/shared (unit)', 'packages/shared/coverage/coverage-summary.json'],
];

const pct = (m) => `${m.pct.toFixed(1)}%`;
const rows = [];
for (const [name, file] of suites) {
  const full = path.join(root, file);
  if (!existsSync(full)) {
    rows.push(`| ${name} | not run | | | |`);
    continue;
  }
  const { total } = JSON.parse(readFileSync(full, 'utf8'));
  rows.push(
    `| ${name} | ${pct(total.lines)} | ${pct(total.statements)} | ${pct(total.functions)} | ${pct(total.branches)} |`,
  );
}

const markdown = [
  '# Coverage',
  '',
  'Target: at least 70% of lines overall and in every core service (enforced by the test runners).',
  '',
  '| Suite | Lines | Statements | Functions | Branches |',
  '|---|---|---|---|---|',
  ...rows,
  '',
].join('\n');
mkdirSync(path.join(root, 'coverage'), { recursive: true });
writeFileSync(path.join(root, 'coverage/SUMMARY.md'), markdown);
console.log(markdown);
