# Career-Ops (personalized build)

An AI-powered job search pipeline that runs on Claude Code: evaluate offers, tailor your
LaTeX résumé per job, scan portals, and track everything in one place.

> This is a trimmed, single-user build. Non-English language packs, the markdown→HTML→PDF
> flow, the Gemini eval engine, the Go dashboard, auto-updates, and open-source repo
> scaffolding have been removed. **Output is English. Your résumé is `cv.tex` (LaTeX).**
>
> Originally built by [santifer](https://santifer.io) ([upstream repo](https://github.com/santifer/career-ops)).

## What it does

- **Evaluates offers** with a structured A–F scoring system (10 weighted dimensions + posting legitimacy).
- **Tailors your CV** — duplicates your `cv.tex`, rewords/reorders it for the job, and compiles to PDF. **Never invents skills you don't have.**
- **Scans portals** directly via ATS APIs (Greenhouse, Ashby, Lever) — zero LLM cost.
- **Processes in batch** — evaluate many offers in parallel with headless workers.
- **Tracks everything** in `data/applications.md` with integrity checks (merge, dedup, normalize, verify).

> **This is a filter, not a spray-and-pray tool.** It recommends against applying to anything
> scoring below 4.0/5, and it never submits an application — you always review and decide.

## Quick start

```bash
# 1. Install
npm install
npx playwright install chromium      # offer liveness verification + scanning

# 2. Check setup
npm run doctor

# 3. Configure
cp config/profile.example.yml config/profile.yml   # edit with your details
cp templates/portals.example.yml portals.yml        # customize companies

# 4. Add your résumé
#    Put your LaTeX résumé as cv.tex in the project root (source of truth).
#    No .tex yet? Start from templates/cv-template.tex.

# 5. Use it
claude                                # open Claude Code here, then paste a job URL
```

**LaTeX compiler required for PDFs:** `tectonic` (recommended) or `pdflatex` (MiKTeX / TeX Live), or compile the generated `.tex` on [Overleaf](https://www.overleaf.com).

See [docs/SETUP.md](docs/SETUP.md) for the full guide.

## Usage

```
/career-ops                → Show all available commands
/career-ops {paste a JD}   → Full auto-pipeline (evaluate + tailored PDF + tracker)
/career-ops scan           → Scan portals for new offers
/career-ops latex          → Tailor cv.tex into a job-specific PDF
/career-ops batch          → Batch evaluate multiple offers
/career-ops tracker        → View application status
/career-ops apply          → Fill application forms with AI
/career-ops pipeline       → Process pending URLs
/career-ops contacto       → LinkedIn outreach message
/career-ops deep           → Deep company research
/career-ops training       → Evaluate a course/cert
/career-ops project        → Evaluate a portfolio project
```

Or just paste a job URL/description — career-ops auto-detects it and runs the full pipeline.

## How it works

```
You paste a job URL or description
        │
        ▼
  Archetype detection  → LLMOps / Agentic / PM / SA / FDE / Transformation
        │
        ▼
  A–F evaluation       → match, gaps, comp research, STAR stories  (reads cv.tex)
        │
   ┌────┼────┐
   ▼    ▼    ▼
 Report  PDF  Tracker
  .md   .pdf   .tsv     (PDF = tailored copy of cv.tex → LaTeX)
```

## CV tailoring (the LaTeX flow)

Your `cv.tex` is the canonical résumé. The `latex` mode:

1. Reads `cv.tex` (never edits it directly).
2. Copies it to `output/cv-{company}-{date}.tex`.
3. Edits the copy: rewords the summary, reorders bullets/projects, injects JD vocabulary into
   **existing** achievements — never adds skills you don't have.
4. Compiles via `node generate-latex.mjs <file.tex> <out.pdf>`.

The validator only fails on things that break compilation (`\begin/\end{document}`, unresolved
`{{placeholders}}`); section names and styling are advisory, so your own LaTeX layout works as-is.

## Pre-configured portals

The scanner ships with companies and search queries across Ashby, Greenhouse, Lever, Wellfound,
and Workable. Copy `templates/portals.example.yml` → `portals.yml` and customize
`title_filter.positive` for your target roles.

```bash
node scan.mjs                 # zero-token discovery
node scan.mjs --verify        # + Playwright liveness check (drops expired postings)
```

## Project structure

```
career-ops/
├── CLAUDE.md / AGENTS.md     # Agent instructions
├── cv.tex                    # Your LaTeX résumé (create this — source of truth)
├── article-digest.md         # Your proof points (optional)
├── config/profile.yml        # Your identity, targets, comp range
├── modes/                    # Skill modes (oferta, latex, scan, batch, ...)
│   ├── _shared.md            # Shared scoring/rules
│   └── _profile.md           # Your archetypes & narrative (customize)
├── templates/
│   ├── cv-template.tex       # LaTeX starter (only if no cv.tex yet)
│   ├── portals.example.yml   # Scanner config template
│   └── states.yml            # Canonical statuses
├── batch/                    # Headless batch worker prompt + runner
├── data/                     # Tracking data (gitignored)
├── reports/                  # Evaluation reports (gitignored)
├── output/                   # Generated CVs/PDFs (gitignored)
├── providers/                # ATS scan providers (Greenhouse/Ashby/Lever/...)
├── docs/                     # Setup, customization, architecture, scripts
└── examples/                 # Sample report & proof points
```

## Customization

The system is meant to be customized by Claude. Just ask:
- "Change the archetypes to backend engineering roles" → edits `modes/_profile.md`
- "Add these companies to portals" → edits `portals.yml`
- "Adjust the scoring weights" → edits `modes/_profile.md`

See [docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md).

## Disclaimer

Local, open-source tooling — not a hosted service. Your data stays on your machine and goes
only to the AI provider you choose. AI evaluations are recommendations, not truth, and models can
hallucinate — **always review AI-generated content before submitting anything.** Comply with the
ToS of any career portals you interact with. Provided under the [MIT License](LICENSE) "as is".
