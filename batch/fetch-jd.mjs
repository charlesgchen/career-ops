#!/usr/bin/env node
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import net from 'node:net';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MIN_CHARS = 500;
const CACHE_SCHEMA_VERSION = 2;
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

async function fetchRaw(rawUrl, { accept = '*/*', timeoutMs = DEFAULT_TIMEOUT_MS, redirects = 0, headers = {} } = {}) {
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
        ...headers,
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

function wordSet(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) || []);
}

function countMatches(text, patterns) {
  const lower = String(text || '').toLowerCase();
  return patterns.reduce((count, pattern) => count + (pattern.test(lower) ? 1 : 0), 0);
}

const JOB_SIGNAL_PATTERNS = [
  /\bresponsibilit(y|ies)\b/,
  /\b(requirements?|qualifications?)\b/,
  /\bminimum qualifications?\b|\bpreferred qualifications?\b/,
  /\bwhat you('ll| will| would)? do\b|\byou will\b|\bin this role\b/,
  /\babout the (role|team|job|position)\b/,
  /\bskills?\b|\bexperience\b|\btechnolog(y|ies)\b/,
  /\bsoftware\b|\bdeveloper\b|\bengineer\b|\bmachine learning\b|\bdata scientist\b|\bcloud\b/,
  /\bintern(ship)?\b|\bco-?op\b|\bstudent\b|\bnew grad\b/,
  /\blocation\b|\bremote\b|\bhybrid\b|\bonsite\b/,
  /\bcompensation\b|\bsalary\b|\bhourly\b|\bpay range\b/,
  /\bjob (requisition|id)\b|\brequisition id\b/,
];

const SHELL_NOISE_PATTERNS = [
  /\benable javascript\b|\brequires javascript\b/,
  /\bsearch jobs\b|\bjob search\b|\bsearch results\b/,
  /\bsign in\b|\blogin\b|\bcreate account\b|\bcandidate home\b/,
  /\bjob alerts?\b|\btalent community\b|\bsimilar jobs\b/,
  /\bprivacy policy\b|\bcookie(s| policy)?\b|\bterms of use\b/,
  /\bpowered by workday\b|\bworkday\b/,
  /\baccess denied\b|\bcaptcha\b|\bunsupported browser\b/,
];

function qualityProblem(extracted) {
  const text = extracted?.text || '';
  const combined = compact([extracted?.title, extracted?.company, extracted?.location, text]);
  const uniqueWords = wordSet(text).size;
  const signalScore = countMatches(combined, JOB_SIGNAL_PATTERNS);
  const shellScore = countMatches(text, SHELL_NOISE_PATTERNS);
  const genericHtml = extracted?.method === 'generic-html';

  if (uniqueWords < (genericHtml ? 120 : 50)) {
    return `too few unique words (${uniqueWords})`;
  }
  if (signalScore < (genericHtml ? 4 : 3)) {
    return `too few job-description signals (${signalScore})`;
  }
  if (/enable javascript|requires javascript|unsupported browser|access denied|captcha/i.test(text) && signalScore < 6) {
    return 'looks like an app shell or blocked page';
  }
  if (genericHtml && shellScore >= 4 && signalScore < 6) {
    return `generic HTML looks like site chrome (${shellScore} shell signals, ${signalScore} JD signals)`;
  }
  return '';
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

function locationText(location) {
  if (!location) return '';
  if (typeof location === 'string') return location;
  return compact([
    location.city,
    location.state || location.province,
    location.country || location.addressCountry,
  ]);
}

async function extractBambooHR(parsed) {
  if (!/\.bamboohr\.com$/i.test(parsed.hostname)) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const careersIdx = parts.indexOf('careers');
  const jobId = careersIdx >= 0 ? parts[careersIdx + 1] || '' : '';
  if (!jobId || !/^\d+$/.test(jobId)) return null;

  const payload = await fetchJson(`${parsed.origin}/careers/${encodeURIComponent(jobId)}/detail`, { timeoutMs: 30_000 });
  const job = payload.result?.jobOpening || payload.jobOpening || payload.result || payload;
  const location = locationText(job.location) || locationText(job.atsLocation);
  const text = compact([
    job.jobOpeningName,
    job.departmentLabel && `Department: ${job.departmentLabel}`,
    job.employmentStatusLabel && `Employment status: ${job.employmentStatusLabel}`,
    location && `Location: ${location}`,
    job.datePosted && `Posted: ${job.datePosted}`,
    job.minimumExperience && `Minimum experience: ${job.minimumExperience}`,
    htmlToText(job.description || ''),
    jsonText(job.compensation),
  ]);

  return result({
    method: 'bamboohr-detail-api',
    url: parsed.href,
    title: job.jobOpeningName,
    company: parsed.hostname.split('.')[0],
    location,
    text,
  });
}

function workdayInfo(parsed) {
  const hostMatch = parsed.hostname.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/i);
  if (!hostMatch) return null;

  const parts = parsed.pathname.split('/').filter(Boolean);
  const jobIdx = parts.indexOf('job');
  if (jobIdx <= 0 || jobIdx >= parts.length - 1) return null;

  const tenant = hostMatch[1];
  const site = parts[jobIdx - 1];
  const jobPath = parts.slice(jobIdx + 1).map((part) => encodeURIComponent(decodeURIComponent(part))).join('/');
  if (!tenant || !site || !jobPath) return null;
  return { tenant, site, jobPath };
}

async function extractWorkday(parsed) {
  const info = workdayInfo(parsed);
  if (!info) return null;

  const api = `https://${parsed.hostname}/wday/cxs/${encodeURIComponent(info.tenant)}/${encodeURIComponent(info.site)}/job/${info.jobPath}`;
  const payload = await fetchJson(api, { timeoutMs: 30_000 });
  const posting = payload.jobPostingInfo || payload;
  const organization = payload.hiringOrganization || posting.hiringOrganization || {};
  const company = organization.name || organization.organizationName || '';
  const location = compact([
    posting.location,
    posting.primaryLocation,
    posting.locationsText,
    jsonText(posting.additionalLocations),
  ]);
  const text = compact([
    posting.title,
    company && `Company: ${company}`,
    location && `Location: ${location}`,
    posting.jobReqId && `Job requisition: ${posting.jobReqId}`,
    posting.timeType && `Time type: ${posting.timeType}`,
    posting.workerSubType && `Worker subtype: ${posting.workerSubType}`,
    htmlToText(posting.jobDescription || posting.jobDescriptionAsText || posting.description || ''),
    jsonText(posting.qualifications),
    jsonText(posting.responsibilities),
    jsonText(posting.skills),
  ]);

  return result({
    method: 'workday-cxs-api',
    url: parsed.href,
    title: posting.title,
    company,
    location,
    text,
  });
}

function oracleHcmInfo(parsed) {
  if (!/\.oraclecloud\.com$/i.test(parsed.hostname)) return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  const candidateIdx = parts.indexOf('CandidateExperience');
  const sitesIdx = parts.indexOf('sites');
  const jobIdx = parts.indexOf('job');
  if (candidateIdx < 0 || sitesIdx < 0 || jobIdx < 0) return null;

  const lang = parts[candidateIdx + 1] || '';
  const site = parts[sitesIdx + 1] || '';
  const jobId = parts[jobIdx + 1] || '';
  if (!lang || !site || !jobId) return null;
  return { lang, site, jobId };
}

async function extractOracleHcm(parsed) {
  const info = oracleHcmInfo(parsed);
  if (!info) return null;

  const finder = `ById;Id=${encodeURIComponent(`"${info.jobId}"`)},siteNumber=${encodeURIComponent(info.site)}`;
  const api = `${parsed.origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=${finder}`;
  const payload = await fetchJson(api, {
    timeoutMs: 30_000,
    headers: { 'Ora-Irc-Language': info.lang },
  });
  const job = payload.items?.[0];
  if (!job) throw new Error(`oracle hcm: job ${info.jobId} not found on site ${info.site}`);

  const secondaryLocations = Array.isArray(job.secondaryLocations)
    ? job.secondaryLocations.map((loc) => loc.Name || loc.LocationName || loc.locationName)
    : [];
  const location = compact([job.PrimaryLocation, ...secondaryLocations, locationText(job.workLocation)]);
  const company = job.LegalEmployer || job.Organization || job.BusinessUnit || '';
  const text = compact([
    job.Title,
    company && `Company: ${company}`,
    location && `Location: ${location}`,
    job.RequisitionType && `Requisition type: ${job.RequisitionType}`,
    job.RequisitionId && `Requisition ID: ${job.RequisitionId}`,
    job.JobSchedule && `Schedule: ${job.JobSchedule}`,
    job.WorkerType && `Worker type: ${job.WorkerType}`,
    job.JobType && `Job type: ${job.JobType}`,
    htmlToText(job.ShortDescriptionStr || ''),
    htmlToText(job.ExternalDescriptionStr || ''),
    htmlToText(job.ExternalResponsibilitiesStr || ''),
    htmlToText(job.ExternalQualificationsStr || ''),
    htmlToText(job.CorporateDescriptionStr || ''),
    htmlToText(job.OrganizationDescriptionStr || ''),
    jsonText(job.skills),
  ]);

  return result({
    method: 'oracle-hcm-api',
    url: parsed.href,
    title: job.Title,
    company,
    location,
    text,
  });
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
    extractBambooHR,
    extractWorkday,
    extractOracleHcm,
    extractGeneric,
  ];

  const errors = [];
  for (const extractor of extractors) {
    try {
      const extracted = await extractor(parsed);
      if (extracted?.text) {
        const problem = qualityProblem(extracted);
        if (problem) {
          errors.push(`${extractor.name}: rejected ${extracted.method}: ${problem}`);
          continue;
        }
        return { extracted, errors };
      }
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
      cache_schema: CACHE_SCHEMA_VERSION,
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
