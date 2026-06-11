#!/usr/bin/env node
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import net from 'node:net';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MIN_CHARS = 500;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (compatible; career-ops/1.9; +https://github.com/santifer/career-ops)';

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fe80:/i,
];

function usage() {
  console.error('Usage: node batch/fetch-jd.mjs <url> <out-file> [--min-chars N] [--meta meta.json]');
}

function parseArgs(argv) {
  const [url, outFile, ...rest] = argv;
  if (!url || !outFile || url === '-h' || url === '--help') {
    usage();
    process.exit(url ? 0 : 2);
  }

  let minChars = DEFAULT_MIN_CHARS;
  let metaFile = '';
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--min-chars') {
      minChars = Number(rest[++i]);
    } else if (arg === '--meta') {
      metaFile = rest[++i] || '';
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!Number.isFinite(minChars) || minChars < 0) {
    throw new Error(`--min-chars must be a non-negative number (got ${minChars})`);
  }
  return { url, outFile, minChars, metaFile };
}

function assertPublicHttpUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new Error(`blocked private or local host: ${parsed.hostname}`);
  }
  if (net.isIP(host) && PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new Error(`blocked private IP: ${host}`);
  }
  return parsed;
}

async function fetchRaw(rawUrl, { accept = '*/*', timeoutMs = DEFAULT_TIMEOUT_MS, redirects = 0 } = {}) {
  const parsed = assertPublicHttpUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(parsed.href, {
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        accept,
        'user-agent': USER_AGENT,
      },
    });

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (redirects >= MAX_REDIRECTS) throw new Error(`too many redirects for ${rawUrl}`);
      const location = res.headers.get('location');
      if (!location) throw new Error(`redirect without Location header for ${rawUrl}`);
      return fetchRaw(new URL(location, parsed.href).href, { accept, timeoutMs, redirects: redirects + 1 });
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 180)}`);
    }
    return { text, finalUrl: parsed.href, contentType: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(rawUrl, opts = {}) {
  const { text } = await fetchRaw(rawUrl, { ...opts, accept: 'application/json,text/json,*/*' });
  return JSON.parse(text);
}

async function fetchText(rawUrl, opts = {}) {
  return await fetchRaw(rawUrl, { ...opts, accept: 'text/html,text/plain,text/markdown,*/*' });
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function htmlToText(html) {
  return normalizeText(
    decodeEntities(String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<\/(p|div|section|article|li|ul|ol|br|h[1-6]|tr|table)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ' '))
  );
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function compact(parts) {
  return normalizeText(parts.filter(Boolean).join('\n\n'));
}

function jsonText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return htmlToText(value);
  if (Array.isArray(value)) return compact(value.map(jsonText));
  if (typeof value === 'object') return compact(Object.values(value).map(jsonText));
  return String(value);
}

function result({ method, url, title = '', company = '', location = '', text }) {
  return {
    method,
    url,
    title: normalizeText(title),
    company: normalizeText(company),
    location: normalizeText(location),
    text: normalizeText(text),
  };
}

async function extractGreenhouse(parsed) {
  const parts = parsed.pathname.split('/').filter(Boolean);
  let board = '';
  let jobId = '';

  if (parsed.hostname === 'job-boards.greenhouse.io' || parsed.hostname === 'job-boards.eu.greenhouse.io') {
    board = parts[0] || '';
    const jobsIdx = parts.indexOf('jobs');
    jobId = jobsIdx >= 0 ? parts[jobsIdx + 1] || '' : '';
  } else if (parsed.hostname === 'boards.greenhouse.io') {
    board = parts[0] || '';
    const jobsIdx = parts.indexOf('jobs');
    jobId = jobsIdx >= 0 ? parts[jobsIdx + 1] || '' : '';
  }

  if (!board || !jobId) return null;
  const api = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}`;
  const job = await fetchJson(api);
  const location = job.location?.name || '';
  const text = compact([
    job.title,
    location && `Location: ${location}`,
    htmlToText(job.content || ''),
    jsonText(job.metadata),
  ]);
  return result({ method: 'greenhouse-api', url: parsed.href, title: job.title, location, text });
}

async function extractAshby(parsed) {
  if (parsed.hostname !== 'jobs.ashbyhq.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const org = parts[0] || '';
  const jobId = parts[1] || '';
  if (!org || !jobId) return null;

  const directUrls = [
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}/job/${encodeURIComponent(jobId)}?includeCompensation=true`,
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}/${encodeURIComponent(jobId)}?includeCompensation=true`,
  ];

  for (const api of directUrls) {
    try {
      const payload = await fetchJson(api, { timeoutMs: 30_000 });
      const job = payload.job || payload.jobPosting || payload;
      const text = ashbyJobText(job);
      if (text) {
        return result({
          method: 'ashby-job-api',
          url: parsed.href,
          title: job.title,
          company: job.companyName,
          location: job.location,
          text,
        });
      }
    } catch {}
  }

  const board = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`, { timeoutMs: 30_000 });
  const jobs = Array.isArray(board.jobs) ? board.jobs : [];
  const job = jobs.find((j) => String(j.jobUrl || '').includes(jobId) || String(j.id || '').includes(jobId));
  if (!job) throw new Error(`ashby: job ${jobId} not found on board ${org}`);
  return result({
    method: 'ashby-board-api',
    url: parsed.href,
    title: job.title,
    company: job.companyName,
    location: job.location,
    text: ashbyJobText(job),
  });
}

function ashbyJobText(job) {
  return compact([
    job?.title,
    job?.location && `Location: ${job.location}`,
    htmlToText(job?.descriptionHtml || job?.description || job?.jobDescriptionHtml || ''),
    jsonText(job?.compensation),
    jsonText(job?.fields),
    jsonText(job?.sections),
  ]);
}

async function extractLever(parsed) {
  if (parsed.hostname !== 'jobs.lever.co') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const company = parts[0] || '';
  const jobId = parts[1] || '';
  if (!company || !jobId) return null;
  const job = await fetchJson(`https://api.lever.co/v0/postings/${encodeURIComponent(company)}/${encodeURIComponent(jobId)}`);
  const lists = Array.isArray(job.lists)
    ? job.lists.map((list) => compact([list.text, htmlToText(list.content || '')]))
    : [];
  const location = job.categories?.location || '';
  const text = compact([
    job.text,
    location && `Location: ${location}`,
    job.categories?.team && `Team: ${job.categories.team}`,
    job.categories?.commitment && `Commitment: ${job.categories.commitment}`,
    htmlToText(job.description || job.descriptionPlain || ''),
    ...lists,
    htmlToText(job.additional || job.additionalPlain || ''),
  ]);
  return result({ method: 'lever-api', url: parsed.href, title: job.text, company, location, text });
}

async function extractWorkable(parsed) {
  if (parsed.hostname !== 'apply.workable.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const slug = parts[0] || '';
  const viewIdx = parts.indexOf('view');
  const jobId = viewIdx >= 0 ? parts[viewIdx + 1] || '' : '';
  if (!slug || !jobId) return null;
  const mdUrl = `https://apply.workable.com/${encodeURIComponent(slug)}/jobs/view/${encodeURIComponent(jobId)}.md`;
  const { text } = await fetchText(mdUrl);
  return result({ method: 'workable-markdown', url: parsed.href, company: slug, text });
}

async function extractSmartRecruiters(parsed) {
  if (parsed.hostname !== 'jobs.smartrecruiters.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const company = parts[0] || '';
  const postingPart = parts.at(-1) || '';
  const postingId = (postingPart.match(/^([A-Za-z0-9-]+)/)?.[1] || '').split('-')[0];
  if (!company || !postingId) return null;
  const job = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${encodeURIComponent(postingId)}`);
  const sections = job.jobAd?.sections || {};
  const location = job.location?.fullLocation || [job.location?.city, job.location?.region, job.location?.country].filter(Boolean).join(', ');
  const text = compact([
    job.name,
    location && `Location: ${location}`,
    htmlToText(sections.companyDescription || ''),
    htmlToText(sections.jobDescription || ''),
    htmlToText(sections.qualifications || ''),
    htmlToText(sections.additionalInformation || ''),
  ]);
  return result({ method: 'smartrecruiters-api', url: parsed.href, title: job.name, company, location, text });
}

function findJobPostingJsonLd(html) {
  const scripts = [...String(html || '').matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    try {
      const parsed = JSON.parse(decodeEntities(match[1]).trim());
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== 'object') continue;
        const type = item['@type'];
        if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return item;
        if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
      }
    } catch {}
  }
  return null;
}

function jsonLdLocation(location) {
  if (!location) return '';
  const locations = Array.isArray(location) ? location : [location];
  return locations.map((loc) => {
    const addr = loc?.address || {};
    return [addr.addressLocality, addr.addressRegion, addr.addressCountry, loc?.name]
      .filter(Boolean)
      .join(', ');
  }).filter(Boolean).join('; ');
}

async function extractGeneric(parsed) {
  const { text: html, finalUrl, contentType } = await fetchText(parsed.href);
  if (/json/i.test(contentType)) {
    const payload = JSON.parse(html);
    return result({ method: 'generic-json', url: finalUrl, text: jsonText(payload) });
  }

  const job = findJobPostingJsonLd(html);
  if (job) {
    const company = typeof job.hiringOrganization === 'object'
      ? job.hiringOrganization.name || ''
      : job.hiringOrganization || '';
    const location = jsonLdLocation(job.jobLocation);
    const text = compact([
      job.title,
      company && `Company: ${company}`,
      location && `Location: ${location}`,
      htmlToText(job.description || ''),
      jsonText(job.responsibilities),
      jsonText(job.qualifications),
      jsonText(job.skills),
      jsonText(job.baseSalary),
    ]);
    return result({ method: 'json-ld-jobposting', url: finalUrl, title: job.title, company, location, text });
  }

  return result({ method: 'generic-html', url: finalUrl, text: htmlToText(html) });
}

async function extract(rawUrl) {
  const parsed = assertPublicHttpUrl(rawUrl);
  const extractors = [
    extractGreenhouse,
    extractAshby,
    extractLever,
    extractWorkable,
    extractSmartRecruiters,
    extractGeneric,
  ];

  const errors = [];
  for (const extractor of extractors) {
    try {
      const extracted = await extractor(parsed);
      if (extracted?.text) return { extracted, errors };
    } catch (err) {
      errors.push(`${extractor.name}: ${err.message}`);
    }
  }
  throw new Error(errors.join(' | ') || 'no extractor matched');
}

function render(extracted) {
  return compact([
    `Source URL: ${extracted.url}`,
    `Extraction method: ${extracted.method}`,
    `Fetched at: ${new Date().toISOString()}`,
    extracted.title && `Title: ${extracted.title}`,
    extracted.company && `Company: ${extracted.company}`,
    extracted.location && `Location: ${extracted.location}`,
    '---',
    extracted.text,
  ]) + '\n';
}

async function writeFileEnsuringDir(file, text) {
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

async function main() {
  const { url, outFile, minChars, metaFile } = parseArgs(process.argv.slice(2));
  const { extracted, errors } = await extract(url);
  const rendered = render(extracted);
  if (extracted.text.length < minChars) {
    throw new Error(`extracted JD too short (${extracted.text.length} chars < ${minChars}) via ${extracted.method}`);
  }
  await writeFileEnsuringDir(outFile, rendered);
  if (metaFile) {
    await writeFileEnsuringDir(metaFile, JSON.stringify({
      url,
      method: extracted.method,
      title: extracted.title || null,
      company: extracted.company || null,
      location: extracted.location || null,
      chars: extracted.text.length,
      warnings: errors,
      fetched_at: new Date().toISOString(),
    }, null, 2) + '\n');
  }
  console.error(`JD fetched via ${extracted.method}: ${extracted.text.length} chars`);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
