#!/usr/bin/env node

/**
 * cv-sync-check.mjs — Validates that the career-ops setup is consistent.
 *
 * Checks:
 * 1. Base résumés (cv-ml/cv-research/cv-swe.tex) exist + shared fields don't drift
 * 2. config/profile.yml exists and has required fields
 * 3. No hardcoded metrics in _shared.md or batch/batch-prompt.md
 * 4. article-digest.md freshness (if exists)
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = __dirname;

const warnings = [];
const errors = [];

// 1. Check base résumés exist (one per career track) and don't drift on shared fields.
const CV_BASES = ['cv-ml.tex', 'cv-research.tex', 'cv-swe.tex'];
const presentBases = [];
for (const base of CV_BASES) {
  const p = join(projectRoot, base);
  if (!existsSync(p)) continue;
  presentBases.push(base);
  const content = readFileSync(p, 'utf-8');
  if (content.trim().length < 100) {
    warnings.push(`${base} seems too short. Make sure it contains your full CV.`);
  }
}
if (presentBases.length === 0) {
  errors.push(`No base résumés found. Create your LaTeX bases in the project root: ${CV_BASES.join(', ')}.`);
} else {
  for (const base of CV_BASES) {
    if (!presentBases.includes(base)) {
      warnings.push(`${base} not found. Create it (copy another base or templates/cv-template.tex) if you target that track.`);
    }
  }
  // Drift guard: contact email should be identical across bases (cv.shared_fields).
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const emails = new Map();
  for (const base of presentBases) {
    const m = readFileSync(join(projectRoot, base), 'utf-8').match(emailRe);
    if (m) emails.set(base, m[0].toLowerCase());
  }
  const distinct = new Set(emails.values());
  if (distinct.size > 1) {
    const detail = [...emails.entries()].map(([b, e]) => `${b}=${e}`).join(', ');
    warnings.push(`Contact email differs across base résumés (${detail}). Keep shared fields in sync.`);
  }
}

// 2. Check profile.yml exists
const profilePath = join(projectRoot, 'config', 'profile.yml');
if (!existsSync(profilePath)) {
  errors.push('config/profile.yml not found. Copy from config/profile.example.yml and fill in your details.');
} else {
  const profileContent = readFileSync(profilePath, 'utf-8');
  const requiredFields = ['full_name', 'email', 'location'];
  for (const field of requiredFields) {
    if (!profileContent.includes(field) || profileContent.includes(`"Jane Smith"`)) {
      warnings.push(`config/profile.yml may still have example data. Check field: ${field}`);
      break;
    }
  }
}

// 3. Check for hardcoded metrics in prompt files
const filesToCheck = [
  { path: join(projectRoot, 'modes', '_shared.md'), name: '_shared.md' },
  { path: join(projectRoot, 'batch', 'batch-prompt.md'), name: 'batch-prompt.md' },
];

// Pattern: numbers that look like hardcoded metrics (e.g., "170+ hours", "90% self-service")
const metricPattern = /\b\d{2,4}\+?\s*(hours?|%|evals?|layers?|tests?|fields?|bases?)\b/gi;

for (const { path, name } of filesToCheck) {
  if (!existsSync(path)) continue;
  const content = readFileSync(path, 'utf-8');

  // Skip lines that are clearly instructions (contain "NEVER hardcode" etc.)
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('NEVER hardcode') || line.includes('NUNCA hardcode') || line.startsWith('#') || line.startsWith('<!--')) continue;
    const matches = line.match(metricPattern);
    if (matches) {
      warnings.push(`${name}:${i + 1} — Possible hardcoded metric: "${matches[0]}". Should this be read from a base résumé/article-digest.md?`);
    }
  }
}

// 4. Check article-digest.md freshness
const digestPath = join(projectRoot, 'article-digest.md');
if (existsSync(digestPath)) {
  const stats = statSync(digestPath);
  const daysSinceModified = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24);
  if (daysSinceModified > 30) {
    warnings.push(`article-digest.md is ${Math.round(daysSinceModified)} days old. Consider updating if your projects have new metrics.`);
  }
}

// Output results
console.log('\n=== career-ops sync check ===\n');

if (errors.length === 0 && warnings.length === 0) {
  console.log('All checks passed.');
} else {
  if (errors.length > 0) {
    console.log(`ERRORS (${errors.length}):`);
    errors.forEach(e => console.log(`  ERROR: ${e}`));
  }
  if (warnings.length > 0) {
    console.log(`\nWARNINGS (${warnings.length}):`);
    warnings.forEach(w => console.log(`  WARN: ${w}`));
  }
}

console.log('');
process.exit(errors.length > 0 ? 1 : 0);
