# Setup Guide

## Prerequisites

- Claude Code or Codex installed and configured
- Node.js 18+ (for utility scripts and portal scanning)
- A LaTeX compiler for CV PDFs: [tectonic](https://tectonic-typesetting.github.io) (recommended) or `pdflatex` via [MiKTeX](https://miktex.org/) (Windows) / TeX Live. (Or skip local install and compile `.tex` files on [Overleaf](https://www.overleaf.com).)

## Quick Start

### 1. Install dependencies

```bash
npm install
npx playwright install chromium   # Used for offer liveness verification + scanning
```

### 2. Configure your profile

```bash
cp config/profile.example.yml config/profile.yml
```

Edit `config/profile.yml` with your details: name, email, target roles, narrative, proof points.

### 3. Add your CVs (LaTeX base résumés)

Put your résumés in the project root, one per track: `cv-ml.tex`, `cv-research.tex`, `cv-swe.tex`. **These are the canonical source of truth** — the `latex` mode picks the base matching each role, duplicates it, and tailors the copy (it never edits a base directly, and never invents skills you don't have). The track→file mapping lives in `config/profile.yml → cv.bases`.

Keep contact info + education identical across the three. You only need the tracks you actually target. Missing one? Start from `templates/cv-template.tex` or paste a CV and have the agent convert it.

(Optional) Create `article-digest.md` with proof points from your portfolio.

### 4. Configure portals

```bash
cp templates/portals.example.yml portals.yml
```

Edit `portals.yml`:
- Update `title_filter.positive` with keywords matching your target roles
- Add companies you want to track
- Customize `search_queries`

### 5. Start using

Open your agent CLI in this directory:

```bash
claude   # or codex
```

Then paste a job offer URL or description. Career-ops will evaluate it, generate a report, tailor the matching base résumé into a PDF, and track it.

## Available Commands

| Action | How |
|--------|-----|
| Evaluate an offer | Paste a URL or JD text |
| Search for offers | `/career-ops scan` |
| Process pending URLs | `/career-ops pipeline` |
| Tailor your CV (PDF) | `/career-ops latex` |
| Batch evaluate | `/career-ops batch` |
| Check tracker status | `/career-ops tracker` |
| Fill application form | `/career-ops apply` |

## Verify Setup

```bash
node doctor.mjs              # Full prerequisite checklist
node cv-sync-check.mjs       # Check configuration
node verify-pipeline.mjs     # Check pipeline integrity
```
