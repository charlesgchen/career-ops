#!/usr/bin/env node
/**
 * pipeline-to-batch.mjs — Convert data/pipeline.md → batch/batch-input.tsv
 *
 * Reads the pending (`- [ ]`) items from the pipeline inbox and emits the
 * 4-column TSV (id, url, source, notes) that batch/batch-runner.sh consumes.
 * Skips already-processed (`- [x]`) and errored (`- [!]`) items. Tracks the
 * current `### --- Country ---` header so it lands in the notes column.
 *
 * Run: node pipeline-to-batch.mjs                      (write batch/batch-input.tsv)
 *      node pipeline-to-batch.mjs --dry-run            (print TSV to stdout, write nothing)
 *      node pipeline-to-batch.mjs --country Canada,France
 *      node pipeline-to-batch.mjs --include Cohere,Palantir
 *      node pipeline-to-batch.mjs --exclude Tesla      (drop the Tesla intern dupes)
 *      node pipeline-to-batch.mjs --limit 10
 *      node pipeline-to-batch.mjs --no-dedupe          (keep duplicate URLs)
 *      node pipeline-to-batch.mjs --in data/pipeline.md --out batch/batch-input.tsv
 *      node pipeline-to-batch.mjs --state batch/batch-state.tsv
 *
 * Filters combine with AND. --include/--exclude/--country match
 * case-insensitively as substrings against company / role / country.
 *
 * IDs are stable by URL: existing reservations in batch-state.tsv and the
 * previous batch-input.tsv are reused, and new postings get IDs above the
 * current maximum. This keeps batch-runner resumability from mistaking a new
 * posting for an old completed one after batch-input.tsv is regenerated.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));

// --- CLI args ---
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const NO_DEDUPE = argv.includes('--no-dedupe');

function flagValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null;
}
function csvFlag(name) {
  const v = flagValue(name);
  return v ? v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
}
function resolvePath(p, fallback) {
  const val = p || fallback;
  return isAbsolute(val) ? val : join(CAREER_OPS, val);
}

const IN_FILE = resolvePath(flagValue('--in'), 'data/pipeline.md');
const OUT_FILE = resolvePath(flagValue('--out'), 'batch/batch-input.tsv');
const STATE_FILE = resolvePath(flagValue('--state'), 'batch/batch-state.tsv');
const COUNTRIES = csvFlag('--country');
const INCLUDE = csvFlag('--include');
const EXCLUDE = csvFlag('--exclude');
const LIMIT = flagValue('--limit') ? parseInt(flagValue('--limit'), 10) : Infinity;

// --- Stable ID allocation ---
function parseIdUrlReservations(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const id = Number.parseInt(cols[0], 10);
    const url = (cols[1] || '').trim();
    if (Number.isInteger(id) && id > 0 && /^https?:\/\//i.test(url)) {
      rows.push({ id, url, file });
    }
  }
  return rows;
}

function createIdAllocator(files) {
  const idByUrl = new Map();
  const urlById = new Map();
  const conflicts = [];
  let maxId = 0;

  for (const file of files) {
    for (const { id, url } of parseIdUrlReservations(file)) {
      maxId = Math.max(maxId, id);

      const reservedUrl = urlById.get(id);
      if (reservedUrl && reservedUrl !== url) {
        conflicts.push(`${file}: id ${id} is already reserved for ${reservedUrl}, ignoring conflicting URL ${url}`);
        continue;
      }

      const reservedId = idByUrl.get(url);
      if (reservedId && reservedId !== id) {
        conflicts.push(`${file}: URL ${url} is already reserved as id ${reservedId}, ignoring conflicting id ${id}`);
        continue;
      }

      urlById.set(id, url);
      idByUrl.set(url, id);
    }
  }

  let nextId = maxId + 1;
  function allocate(url) {
    const existing = idByUrl.get(url);
    if (existing) return existing;

    while (urlById.has(nextId)) nextId++;
    const id = nextId++;
    idByUrl.set(url, id);
    urlById.set(id, url);
    return id;
  }

  return { allocate, conflicts };
}

// --- Source detection from URL host ---
function detectSource(url) {
  const map = [
    [/greenhouse\.io/i, 'Greenhouse'],
    [/ashbyhq\.com/i, 'Ashby'],
    [/lever\.co/i, 'Lever'],
    [/myworkdayjobs\.com/i, 'Workday'],
    [/oraclecloud\.com/i, 'Oracle'],
    [/icims\.com/i, 'iCIMS'],
    [/workable\.com/i, 'Workable'],
    [/bamboohr\.com/i, 'BambooHR'],
    [/lifeattiktok\.com/i, 'TikTok'],
    [/tesla\.com/i, 'Tesla'],
    [/jobs\.ea\.com/i, 'EA'],
    [/scandit\.com/i, 'Scandit'],
    [/sumup\.com/i, 'SumUp'],
    [/zipline\.com/i, 'Zipline'],
  ];
  for (const [re, name] of map) if (re.test(url)) return name;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Unknown';
  }
}

// --- Parse pipeline.md ---
if (!existsSync(IN_FILE)) {
  console.error(`ERROR: input not found: ${IN_FILE}`);
  process.exit(1);
}

const lines = readFileSync(IN_FILE, 'utf8').split(/\r?\n/);
const countryHeader = /^#{2,}\s*-{2,}\s*(.+?)\s*-{2,}\s*$/; // ### --- Country ---
const pendingItem = /^-\s*\[ \]\s+(.+)$/; // only unchecked items
const idAllocator = createIdAllocator([STATE_FILE, OUT_FILE]);

let currentCountry = '';
const records = [];
const seenUrls = new Set();

for (const raw of lines) {
  const line = raw.trim();

  const ch = line.match(countryHeader);
  if (ch) {
    currentCountry = ch[1].trim();
    continue;
  }

  const pi = line.match(pendingItem);
  if (!pi) continue; // skips - [x] / - [!] / prose

  // content: "<url> | <company> | <role>"  (company/role optional)
  const parts = pi[1].split('|').map((s) => s.trim());
  const url = parts[0];
  if (!url || !/^https?:\/\//i.test(url)) continue;
  const company = parts[1] || '';
  const role = parts.slice(2).join(' | ') || '';

  if (!NO_DEDUPE && seenUrls.has(url)) continue;
  seenUrls.add(url);

  // Filters (AND). Match against country + company + role.
  const haystack = `${currentCountry} ${company} ${role}`.toLowerCase();
  if (COUNTRIES.length && !COUNTRIES.some((c) => currentCountry.toLowerCase().includes(c))) continue;
  if (INCLUDE.length && !INCLUDE.some((t) => haystack.includes(t))) continue;
  if (EXCLUDE.length && EXCLUDE.some((t) => haystack.includes(t))) continue;

  const noteParts = [currentCountry, company, role].filter(Boolean);
  const notes = noteParts.join(' | ').replace(/\t/g, ' ').trim();

  records.push({ id: idAllocator.allocate(url), url, source: detectSource(url), notes });
  if (records.length >= LIMIT) break;
}

// --- Emit TSV ---
const header = 'id\turl\tsource\tnotes';
const rows = records.map((r) => `${r.id}\t${r.url}\t${r.source}\t${r.notes}`);
const tsv = [header, ...rows].join('\n') + '\n';

for (const conflict of idAllocator.conflicts) {
  console.error(`WARN: ${conflict}`);
}

if (DRY_RUN) {
  process.stdout.write(tsv);
  console.error(`\n# dry-run: ${records.length} offer(s) — nothing written`);
} else {
  writeFileSync(OUT_FILE, tsv, 'utf8');
  console.error(`Wrote ${records.length} offer(s) → ${OUT_FILE}`);
}
