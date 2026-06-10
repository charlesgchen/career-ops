# Architecture

## System Overview

```
                    ┌─────────────────────────────────┐
                    │         AI Coding CLI Agent      │
                    │   (reads AGENTS.md + modes/*.md) │
                    └──────────┬──────────────────────┘
                               │
            ┌──────────────────┼──────────────────────┐
            │                  │                       │
     ┌──────▼──────┐   ┌──────▼──────┐   ┌───────────▼────────┐
     │ Single Eval  │   │ Portal Scan │   │   Batch Process    │
     │ (auto-pipe)  │   │  (scan.md)  │   │   (batch-runner)   │
     └──────┬──────┘   └──────┬──────┘   └───────────┬────────┘
            │                  │                       │
            │           ┌──────▼──────┐          ┌────▼─────┐
            │           │ pipeline.md │          │ N workers│
            │           │ (URL inbox) │          │ (headless)
            │           └─────────────┘          └────┬─────┘
            │                                          │
     ┌──────▼──────────────────────────────────────────▼──────┐
     │                    Output Pipeline                      │
     │  ┌──────────┐  ┌────────────┐  ┌───────────────────┐  │
     │  │ Report.md│  │ PDF (base   │  │ Tracker TSV       │  │
     │  │ (A-G eval)│  │ .tex→LaTeX) │  │ (merge-tracker)  │  │
     │  └──────────┘  └────────────┘  └───────────────────┘  │
     └────────────────────────────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  data/applications.md │
                    │  (canonical tracker)  │
                    └──────────────────────┘
```

## Evaluation Flow (Single Offer)

1. **Input**: User pastes JD text or URL
2. **Extract**: Playwright or available web/search tools extract JD from URL
3. **Classify**: Detect archetype (1 of 6 types)
4. **Evaluate**: 7 blocks (A-G):
   - A: Role summary
   - B: CV match (gaps + mitigation)
   - C: Level strategy
   - D: Comp research (web/search tools)
   - E: CV personalization plan
   - F: Interview prep (STAR stories)
   - G: Posting legitimacy
5. **Score**: Weighted average across 10 dimensions (1-5)
6. **Report**: Save as `reports/{num}-{company}-{date}.md`
7. **PDF**: Pick the base résumé for the role's track, tailor it, and compile to PDF (`modes/latex.md` → `generate-latex.mjs`)
8. **Track**: Write TSV to `batch/tracker-additions/`, auto-merged

## Batch Processing

The batch system processes multiple offers in parallel:

```
batch-input.tsv    →  batch-runner.sh  →  N × headless CLI workers
(id, url, source)     (orchestrator)       (self-contained prompt)
                           │
                    batch-state.tsv
                    (tracks progress)
```

Each worker is a headless CLI instance. The bundled `batch-runner.sh` invokes `claude -p` by default, or `codex exec` when run with `--agent codex`. Workers produce:
- Report .md
- PDF (tailored from the matching base résumé, if a LaTeX compiler is available)
- Tracker TSV line

The orchestrator manages parallelism, state, retries, and resume.

## Data Flow

```
cv-{ml,research,swe}.tex →  Evaluation context + tailoring source of truth (per track)
article-digest.md        →  Proof points for matching
config/profile.yml       →  Candidate identity + cv.bases track mapping
portals.yml              →  Scanner configuration
templates/states.yml     →  Canonical status values
templates/cv-template.tex →  LaTeX starter (only when a base is missing)
```

## File Naming Conventions

- Reports: `{###}-{company-slug}-{YYYY-MM-DD}.md` (3-digit zero-padded)
- PDFs: `cv-candidate-{company-slug}-{YYYY-MM-DD}.pdf`
- Tracker TSVs: `batch/tracker-additions/{id}.tsv`

## Pipeline Integrity

Scripts maintain data consistency:

| Script | Purpose |
|--------|---------|
| `merge-tracker.mjs` | Merges batch TSV additions into applications.md |
| `verify-pipeline.mjs` | Health check: statuses, duplicates, links |
| `dedup-tracker.mjs` | Removes duplicate entries by company+role |
| `normalize-statuses.mjs` | Maps status aliases to canonical values |
| `cv-sync-check.mjs` | Validates setup consistency |
