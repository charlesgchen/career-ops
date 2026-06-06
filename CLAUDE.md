# Career-Ops -- AI Job Search Pipeline

> **This is a personalized, trimmed setup.** Non-English language modes, the
> markdown→HTML→PDF flow, the Gemini eval engine, the Go dashboard, auto-updates, and
> open-source repo scaffolding have been removed. The CV source of truth is the user's
> three LaTeX **base résumés** (one per track: ML / research / SWE), tailored per job by the `latex` mode. Output is always English.

## Origin

This system was originally built by [santifer](https://santifer.io) to evaluate 740+ job offers and land a Head of Applied AI role. The archetypes, scoring logic, and proof point structure are customizable — they live in `modes/_profile.md` and `config/profile.yml`.

**It's designed to be made yours.** You (AI Agent) can edit the user's files directly. The user says "change the archetypes to data engineering roles" and you do it.

## Data Contract (CRITICAL)

There are two layers. Read `DATA_CONTRACT.md` for the full list.

**User Layer (personalization goes HERE):**
- `cv-ml.tex`, `cv-research.tex`, `cv-swe.tex`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`, `portals.yml`
- `data/*`, `reports/*`, `output/*`, `interview-prep/*`

**System Layer (logic, scripts, templates):**
- `modes/_shared.md`, `modes/oferta.md`, all other modes
- `CLAUDE.md`, `*.mjs` scripts, `templates/*`, `batch/*`

**THE RULE: When the user asks to customize anything (archetypes, narrative, negotiation scripts, proof points, location policy, comp targets), ALWAYS write to `modes/_profile.md` or `config/profile.yml`. NEVER edit `modes/_shared.md` for user-specific content.**

## Updates

Auto-updates are **disabled** in this setup (the update subsystem was removed). Do not look for or run any update checker. If the user ever wants to re-sync with upstream, they can do it manually from the GitHub repo.

## What is career-ops

AI-powered job search automation: pipeline tracking, offer evaluation, LaTeX CV tailoring, portal scanning, batch processing.

### Main Files

| File | Function |
|------|----------|
| `cv-ml.tex` / `cv-research.tex` / `cv-swe.tex` | The user's LaTeX base résumés (one per track) — canonical source of truth. See `cv.bases` in profile.yml |
| `data/applications.md` | Application tracker |
| `data/pipeline.md` | Inbox of pending URLs |
| `data/scan-history.tsv` | Scanner dedup history |
| `portals.yml` | Query and company config |
| `templates/cv-template.tex` | LaTeX/Overleaf starter template (only when a base résumé is missing) |
| `generate-latex.mjs` | LaTeX CV validator + tectonic/pdflatex compiler |
| `article-digest.md` | Compact proof points from portfolio (optional) |
| `interview-prep/story-bank.md` | Accumulated STAR+R stories across evaluations |
| `interview-prep/{company}-{role}.md` | Company-specific interview intel reports |
| `analyze-patterns.mjs` | Pattern analysis script (JSON output) |
| `followup-cadence.mjs` | Follow-up cadence calculator (JSON output) |
| `data/follow-ups.md` | Follow-up history tracker |
| `scan.mjs` | Zero-token portal scanner — hits Greenhouse/Ashby/Lever APIs directly, zero LLM cost |
| `check-liveness.mjs` | Job posting liveness checker |
| `liveness-core.mjs` | Shared liveness logic (expired signals win over generic Apply text) |
| `reports/` | Evaluation reports (format: `{###}-{company-slug}-{YYYY-MM-DD}.md`). Blocks A-F + G (Posting Legitimacy), plus `## Machine Summary` YAML. Header includes `**Legitimacy:** {tier}`. |

### First Run — Onboarding (IMPORTANT)

**Before doing ANYTHING else, check if the system is set up.** Run these checks silently every time a session starts:

1. Do the base résumés exist? (`cv-ml.tex`, `cv-research.tex`, `cv-swe.tex` — at least the tracks the user targets; see `config/profile.yml → cv.bases`)
2. Does `config/profile.yml` exist (not just profile.example.yml)?
3. Does `modes/_profile.md` exist (not just _profile.template.md)?
4. Does `portals.yml` exist (not just templates/portals.example.yml)?

If `modes/_profile.md` is missing, copy from `modes/_profile.template.md` silently. This is the user's customization file.

**If ANY of these is missing, enter onboarding mode.** Do NOT proceed with evaluations, scans, or any other mode until the basics are in place.

#### Step 1: CV (required)
This setup uses **three base résumés, one per career track**: `cv-ml.tex` (ML), `cv-research.tex` (research), `cv-swe.tex` (SWE). The `latex` mode picks the base matching each role and tailors a copy — it never edits a base directly.

If a base is missing, ask:
> "Let's set up your base résumés (one per track: ML / research / SWE). For each, you can:
> 1. Paste your `.tex` résumé and I'll save it as the base
> 2. Paste your current CV (any format) and I'll convert it to a clean `.tex`
> 3. Start from `templates/cv-template.tex` and fill it in together
>
> Which track do you want to set up first?"

Save each as `cv-{track}.tex` in the project root. Keep contact info and education identical across all three (the `latex` mode and `cv-sync-check.mjs` rely on that). You only need the tracks you actually target.

#### Step 2: Profile (required)
If `config/profile.yml` is missing, copy from `config/profile.example.yml` and then ask:
> "I need a few details to personalize the system:
> - Your full name and email
> - Your location and timezone
> - What roles are you targeting? (e.g., 'Senior Backend Engineer', 'AI Product Manager')
> - Your salary target range"

Fill in `config/profile.yml`. Store archetypes and targeting narrative in `modes/_profile.md` or `config/profile.yml`, not `modes/_shared.md`.

#### Step 3: Portals (recommended)
If `portals.yml` is missing:
> "I'll set up the job scanner with pre-configured companies. Want me to customize the search keywords for your target roles?"

Copy `templates/portals.example.yml` → `portals.yml`. If they gave target roles in Step 2, update `title_filter.positive` to match.

#### Step 4: Tracker
If `data/applications.md` doesn't exist, create it:
```markdown
# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
```

#### Step 5: Get to know the user (important for quality)

After the basics are set up, proactively ask for more context:

> "The system works much better when it knows you well. Can you tell me:
> - What makes you unique? Your 'superpower' other candidates don't have?
> - What kind of work excites you? What drains you?
> - Any deal-breakers? (e.g., no on-site, no startups under 20 people)
> - Your best professional achievement — the one you'd lead with in an interview
> - Any projects, articles, or case studies you've published?"

Store insights in `config/profile.yml` (narrative), `modes/_profile.md`, or `article-digest.md`.

**After every evaluation, learn.** If the user says "this score is too high" or "you missed that I have experience in X", update `modes/_profile.md`, `config/profile.yml`, or `article-digest.md`.

#### Step 6: Ready
Once all files exist, confirm:
> "You're all set! Paste a job URL to evaluate it, run `/career-ops scan` to search portals, or `/career-ops` to see all commands. Everything is customizable — just ask."

Then optionally offer a recurring scan via the `/loop` or `/schedule` skill if available.

### Personalization

When the user asks you to change archetypes, adjust scoring, add companies, or modify negotiation scripts -- do it directly.

**Common customization requests:**
- "Change the archetypes to [backend/frontend/data/devops] roles" → edit `modes/_profile.md` or `config/profile.yml`
- "Add these companies to my portals" → edit `portals.yml`
- "Update my profile" → edit `config/profile.yml`
- "Change the CV layout" → edit the relevant base résumé (`cv-ml/cv-research/cv-swe.tex`)
- "Adjust the scoring weights" → edit `modes/_profile.md` for user-specific weighting, or `modes/_shared.md` + `batch/batch-prompt.md` for shared defaults

### Language

This setup is **English-only**. Use the default `modes/` for all output. (Non-English mode packs were removed.)

### Skill Modes

| If the user... | Mode |
|----------------|------|
| Pastes JD or URL | auto-pipeline (evaluate + report + tracker) |
| Asks to evaluate offer | `oferta` |
| Asks to compare offers | `ofertas` |
| Wants LinkedIn outreach | `contacto` |
| Asks for company research | `deep` |
| Preps for interview at specific company | `interview-prep` |
| Wants to generate/tailor a CV (PDF) | `latex` |
| Evaluates a course/cert | `training` |
| Evaluates portfolio project | `project` |
| Asks about application status | `tracker` |
| Fills out application form | `apply` |
| Searches for new offers | `scan` |
| Processes pending URLs | `pipeline` |
| Batch processes offers | `batch` |
| Asks about rejection patterns or wants to improve targeting | `patterns` |
| Asks about follow-ups or application cadence | `followup` |

### CV Source of Truth

- The three base résumés in project root are canonical — one per track: `cv-ml.tex` (ML), `cv-research.tex` (research), `cv-swe.tex` (SWE). Mapping lives in `config/profile.yml → cv.bases`.
- The `latex` mode selects the base matching the role, duplicates it to `output/`, and tailors the copy per job — it NEVER edits a base directly and NEVER invents skills the user doesn't have (see `modes/latex.md`). For evaluation, read the base matching the role's track; consult the others for transferable experience.
- Keep contact info + education identical across bases (`cv.shared_fields`); `cv-sync-check.mjs` warns on drift.
- `article-digest.md` has detailed proof points (optional).
- **NEVER hardcode metrics** -- read them from these files at evaluation time.

---

## Ethical Use -- CRITICAL

**This system is designed for quality, not quantity.**

- **NEVER submit an application without the user reviewing it first.** Fill forms, draft answers, generate PDFs -- but always STOP before clicking Submit/Send/Apply.
- **NEVER invent skills, tools, or experience the user doesn't have** when tailoring the CV. Reword and reorder what's in the selected base résumé; never add new claims (and don't pull from a different base just because the JD asks).
- **Strongly discourage low-fit applications.** If a score is below 4.0/5, explicitly recommend against applying.
- **Quality over speed.** A well-targeted application to 5 companies beats a generic blast to 50.
- **Respect recruiters' time.** Every application a human reads costs someone's attention.

---

## Offer Verification -- MANDATORY

**NEVER trust WebSearch/WebFetch to verify if an offer is still active.** ALWAYS use Playwright:
1. `browser_navigate` to the URL
2. `browser_snapshot` to read content
3. Only footer/navbar without JD = closed. Title + description + Apply = active.

**Exception for batch workers (`claude -p`):** Playwright is not available in headless pipe mode. Use WebFetch as fallback and mark the report header with `**Verification:** unconfirmed (batch mode)`.

---

## Stack and Conventions

- Node.js (mjs modules), Playwright (scraping + liveness), YAML (config), LaTeX (CV), Markdown (data)
- Scripts in `.mjs`, configuration in YAML
- Output in `output/` (gitignored), Reports in `reports/`
- JDs in `jds/` (referenced as `local:jds/{file}` in pipeline.md)
- Batch in `batch/` (gitignored except scripts and prompt)
- Report numbering: sequential 3-digit zero-padded, max existing + 1
- **RULE: After each batch of evaluations, run `node merge-tracker.mjs`** to merge tracker additions and avoid duplications.
- **RULE: NEVER create new entries in applications.md if company+role already exists.** Update the existing entry.

### TSV Format for Tracker Additions

Write one TSV file per evaluation to `batch/tracker-additions/{num}-{company-slug}.tsv`. Single line, 9 tab-separated columns:

```
{num}\t{date}\t{company}\t{role}\t{status}\t{score}/5\t{pdf_emoji}\t[{num}](reports/{num}-{slug}-{date}.md)\t{note}
```

**Column order (IMPORTANT -- status BEFORE score):**
1. `num` -- sequential number (integer)
2. `date` -- YYYY-MM-DD
3. `company` -- short company name
4. `role` -- job title
5. `status` -- canonical status (e.g., `Evaluated`)
6. `score` -- format `X.X/5` (e.g., `4.2/5`)
7. `pdf` -- `✅` or `❌`
8. `report` -- markdown link, always written **root-relative**: `[num](reports/...)`
9. `notes` -- one-line summary

**Note:** In applications.md, score comes BEFORE status. The merge script handles this column swap automatically.

**Report link normalization:** The TSV always carries a **root-relative** `[num](reports/...)` link. `merge-tracker.mjs` rewrites it relative to the tracker file's own directory before writing it in — `../reports/...` when the tracker is at `data/applications.md`. Idempotent. To fix links in an existing tracker, run `node merge-tracker.mjs --migrate`.

### Pipeline Integrity

1. **NEVER edit applications.md to ADD new entries** -- Write TSV in `batch/tracker-additions/` and `merge-tracker.mjs` handles the merge.
2. **YES you can edit applications.md to UPDATE status/notes of existing entries.**
3. All reports MUST include `**URL:**` in the header (between Score and PDF). Include `**Legitimacy:** {tier}` (see Block G in `modes/oferta.md`).
4. All statuses MUST be canonical (see `templates/states.yml`).
5. Health check: `node verify-pipeline.mjs`
6. Normalize statuses: `node normalize-statuses.mjs`
7. Dedup: `node dedup-tracker.mjs`

### Canonical States (applications.md)

**Source of truth:** `templates/states.yml`

| State | When to use |
|-------|-------------|
| `Evaluated` | Report completed, pending decision |
| `Applied` | Application sent |
| `Responded` | Company responded |
| `Interview` | In interview process |
| `Offer` | Offer received |
| `Rejected` | Rejected by company |
| `Discarded` | Discarded by candidate or offer closed |
| `SKIP` | Doesn't fit, don't apply |

**RULES:**
- No markdown bold (`**`) in status field
- No dates in status field (use the date column)
- No extra text (use the notes column)
