// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Simplify / Pitt CSC community internship feed.
//
// Source: https://github.com/SimplifyJobs/Summer2026-Internships
// One JSON file holds every season (Summer/Fall/Winter/Spring), tagged via
// the `terms` field, updated daily. Each listing carries the REAL apply URL
// (direct to the company ATS) plus `active` / `is_visible` / `date_posted`,
// so we can drop dead and stale postings without a Playwright pass.
//
// Not URL-detectable like an ATS board — it's a single aggregated feed, so it
// requires an explicit `provider: simplify-internships` entry in portals.yml.
//
// Entry fields (all optional):
//   feed:         override feed URL (must stay on raw.githubusercontent.com)
//   max_age_days: drop postings older than N days by date_posted. Default 14.
//                 Set 0 to disable the freshness filter.
//   countries:    restrict by country, e.g. ["US", "CA"]. Omit for worldwide.
//                 Only US + CA are recognized; "Remote" always passes when set.
//   terms:        restrict by season, e.g. ["Fall 2026"]. Omit for all seasons.
//   exclude_terms: drop a posting if it carries ANY of these seasons, even when
//                 it also matches `terms`. Use to hard-exclude a season that
//                 multi-season listings would otherwise sneak in via `terms`.
//   block_companies: drop any posting whose company_name matches (case-insensitive
//                 substring) one of these. The feed aggregates thousands of
//                 companies, so this is how you keep specific ones out entirely.

const DEFAULT_FEED =
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json';

// SSRF guard — the feed (and any fork override) must live on GitHub raw.
const ALLOWED_FEED_HOST = 'raw.githubusercontent.com';

function assertFeedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`simplify-internships: invalid feed URL: ${url}`);
  }
  if (parsed.protocol !== 'https:')
    throw new Error(`simplify-internships: feed URL must use HTTPS: ${url}`);
  if (parsed.hostname !== ALLOWED_FEED_HOST)
    throw new Error(`simplify-internships: untrusted feed host "${parsed.hostname}" — must be ${ALLOWED_FEED_HOST}`);
  return url;
}

// ── US / Canada classification ──────────────────────────────────────
// Locations are free-text city strings ("NYC", "Brookfield, IL", "Toronto, ON",
// "Florida", "London, UK"). We tag a string as US / CA / REMOTE / OTHER using,
// in order: a remote marker, well-known bare city shorthands, full state /
// province names (substring), then the trailing 2-letter state / province code.

const US_CODES = new Set(
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '),
);
const CA_CODES = new Set('ON QC BC AB MB SK NS NB NL PE NT YT NU'.split(' '));

const US_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
  'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
  'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire',
  'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia',
  'wisconsin', 'wyoming', 'district of columbia', 'united states', 'u.s.a', 'usa',
];
const CA_NAMES = [
  'ontario', 'quebec', 'british columbia', 'alberta', 'manitoba', 'saskatchewan',
  'nova scotia', 'new brunswick', 'newfoundland', 'prince edward island',
  'northwest territories', 'yukon', 'nunavut', 'canada',
];
const US_CITIES = new Set(['nyc', 'sf', 'la', 'dc']);
const CA_CITIES = new Set(['toronto', 'vancouver', 'montreal', 'ottawa', 'waterloo', 'calgary']);

/** @returns {'US'|'CA'|'REMOTE'|'OTHER'} */
function classifyLocation(loc) {
  const s = String(loc || '').toLowerCase().trim();
  if (!s) return 'OTHER';
  if (/remote/.test(s)) return 'REMOTE';
  if (US_CITIES.has(s)) return 'US';
  if (CA_CITIES.has(s)) return 'CA';
  for (const n of CA_NAMES) if (s.includes(n)) return 'CA';
  for (const n of US_NAMES) if (s.includes(n)) return 'US';
  const last = (s.split(',').pop() || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (CA_CODES.has(last)) return 'CA';
  if (US_CODES.has(last)) return 'US';
  return 'OTHER';
}

/** @type {Provider} */
export default {
  id: 'simplify-internships',

  // No detect() — this is an aggregated feed, not a per-company ATS board.
  // Wire it up with an explicit `provider: simplify-internships` entry.

  async fetch(entry, ctx) {
    const feedUrl = assertFeedUrl(entry.feed || DEFAULT_FEED);

    const maxAgeDays = Number.isFinite(entry.max_age_days) ? entry.max_age_days : 14;
    const cutoff = maxAgeDays > 0 ? Date.now() / 1000 - maxAgeDays * 86400 : 0;

    const wantTerms = (Array.isArray(entry.terms) ? entry.terms : [])
      .map(t => String(t).toLowerCase());
    const excludeTerms = (Array.isArray(entry.exclude_terms) ? entry.exclude_terms : [])
      .map(t => String(t).toLowerCase());
    const wantCountries = (Array.isArray(entry.countries) ? entry.countries : [])
      .map(c => String(c).toUpperCase());
    const blockCompanies = (Array.isArray(entry.block_companies) ? entry.block_companies : [])
      .map(c => String(c).toLowerCase().trim())
      .filter(Boolean);

    // redirect:'error' keeps the final host pinned to the allowlist above.
    const list = await ctx.fetchJson(feedUrl, { redirect: 'error' });
    if (!Array.isArray(list)) {
      throw new Error('simplify-internships: feed did not return a JSON array');
    }

    const out = [];
    for (const j of list) {
      if (!j || !j.active || !j.is_visible || !j.url) continue;

      const company = String(j.company_name || '');
      if (blockCompanies.length > 0) {
        const lc = company.toLowerCase();
        if (blockCompanies.some(b => lc.includes(b))) continue;
      }

      if (cutoff > 0) {
        if (typeof j.date_posted !== 'number' || j.date_posted < cutoff) continue;
      }

      if (wantTerms.length > 0 || excludeTerms.length > 0) {
        const terms = (Array.isArray(j.terms) ? j.terms : []).map(t => String(t).toLowerCase());
        // Hard exclusion wins over inclusion: a multi-season posting that carries
        // an excluded season is dropped even if it also matches `terms`.
        if (excludeTerms.length > 0 && terms.some(t => excludeTerms.includes(t))) continue;
        if (wantTerms.length > 0 && !terms.some(t => wantTerms.includes(t))) continue;
      }

      const locations = Array.isArray(j.locations) ? j.locations : [];
      if (wantCountries.length > 0) {
        const ok = locations.some(l => {
          const tag = classifyLocation(l);
          return tag === 'REMOTE' || wantCountries.includes(tag);
        });
        if (!ok) continue;
      }

      out.push({
        title: String(j.title || ''),
        url: String(j.url),
        company,
        location: locations.join(', '),
      });
    }
    return out;
  },
};
