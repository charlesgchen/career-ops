# Mode: latex — Tailor the user's LaTeX CV (source of truth)

The user maintains **three base résumés, one per career track** — their own LaTeX,
their own layout. This mode picks the base that matches the role, duplicates it, edits
the copy to tailor it to a specific job, and compiles it to PDF. It NEVER edits a base
file directly and NEVER regenerates from markdown.

> This is the only CV/PDF path in this setup. `cv.md`, the HTML template, and the
> markdown→PDF flow have been removed.

## Base selection (do this FIRST)

The three bases are configured in `config/profile.yml → cv.bases`:

| Track | Default file | Use for roles like... |
|-------|--------------|------------------------|
| `ml` | `cv-ml.tex` | ML engineer, applied ML, MLOps, data-science modeling |
| `research` | `cv-research.tex` | research scientist, PhD/applied-research, publications-oriented (academic format) |
| `swe` | `cv-swe.tex` | software engineer, backend, platform, infra, full-stack |

1. Classify the role into one track from the JD (title + responsibilities + stack).
2. Pick the matching base from `cv.bases`.
3. **If the track is genuinely ambiguous** (e.g. "ML Software Engineer", "Research Engineer"),
   ASK the user which base to start from. Suggest the closest as the default
   (`cv.default_base` if you have no signal). Do not guess silently.
4. If the chosen base file does not exist, tell the user and offer to create it from
   `templates/cv-template.tex` or another base.

`{base}` below means the selected base file.

## Pipeline

1. Select `{base}` per the rules above. Read it (the master for this track — source of truth).
2. Read `config/profile.yml` for candidate identity (used for the output filename).
3. Get the JD if not already in context (text or URL).
4. Extract 15-20 keywords from the JD.
5. Detect the role archetype → adapt framing (see `modes/_profile.md`).
6. Copy `{base}` → `output/cv-{candidate}-{company}-{YYYY-MM-DD}.tex`.
7. **Edit the copy in place** (NEVER edit `{base}` itself). Tailoring is
   **reorder-first, reword-minimally** — ordering wins more relevance than paraphrasing:
   - **Reorder first, on every CV.** Move the most JD-relevant bullets to the top of each
     role; reorder Projects so the top 3-4 relevant ones lead; list JD-relevant tech first
     in the skills line. Apply this even when no wording changes.
   - **Reword only to inject a real JD keyword** the existing achievement already supports.
     If a bullet already covers its keywords, leave it byte-for-byte unchanged.
   - **Never despecify.** Don't replace a concrete, distinctive noun (product/system name,
     named tech, metric) with a vaguer phrase — specific beats generic.
   - **No filler.** Don't add empty intensifiers ("production", "scalable", "end-to-end",
     "cloud-deployed", etc.) unless the word is a literal JD keyword and true.
   - **Do NOT add a Professional Summary** (or objective/profile blurb). The user's bases have no summary section — never create one. Tailor by reordering and rewording existing content only.
   - Inject JD vocabulary into existing achievements — reword, never invent.
8. **ATS keyword audit (mandatory).** Before compiling, run the coverage audit in the
   "ATS Keyword Matching" section below: classify every JD keyword as covered / partial /
   gap, and realign each `partial` to the JD's exact term. Reordering alone is not enough —
   ATS matches literal tokens.
9. Compile: `node generate-latex.mjs output/cv-{candidate}-{company}-{YYYY-MM-DD}.tex output/cv-{candidate}-{company}-{YYYY-MM-DD}.pdf`
10. Report: which base was chosen (and why), `.tex` path, `.pdf` path, file sizes, keyword coverage % (with the covered / partial→aligned / gap breakdown), and any validator warnings.

**Requires:** `tectonic` (preferred — auto-downloads packages) or `pdflatex` (MiKTeX / TeX Live) on PATH.

## Ethical Rule #1 — NEVER invent skills (HARD RULE)

**The tailored CV must contain ZERO skills, tools, technologies, certifications, or
experience that are not already in the chosen base file (`{base}`).** Tailoring means
*rewording and reordering what is already there* using the JD's vocabulary — never
adding new claims. (And never pull content from a *different* base just because the JD
asks for it — if it's not in `{base}`, it's a gap, not a bullet.)

- Do NOT add a tool/framework/language just because the JD asks for it.
- Do NOT inflate scope, seniority, metrics, or responsibilities.
- If the JD wants something the user doesn't have, leave it out — surface the gap to
  the user instead of papering over it on the resume.
- When in doubt, keep the user's original wording.

Why this matters: removing fabricated skills by hand afterward is painful and risky
(a missed one is a lie on a resume). Getting it right the first time is the whole point.

## Editing Rules (CRITICAL)

- **Never modify a base file** (`cv-ml.tex` / `cv-research.tex` / `cv-swe.tex`). Always work on the dated copy in `output/`.
- **Preserve the user's LaTeX structure.** Keep their preamble, packages, custom
  commands, and section layout exactly as they wrote them. You are editing *content*
  (summary text, bullet order, bullet wording), not redesigning the document.
- **Only edit text inside the existing LaTeX commands.** Don't introduce new packages
  or restructure the document unless the user asks.
- Text you write must be valid LaTeX — escape special characters in any content you
  add or change (see table below). Do not escape LaTeX commands themselves.

## Keyword Injection Strategy (ethical — same as the old pdf rules)

- NEVER add skills, tools, or experience the candidate doesn't have.
- Only reformulate existing experience using the JD's vocabulary.
- Examples:
  - JD says "RAG pipelines" → reword "LLM workflows with retrieval" to "RAG pipeline design"
  - JD says "MLOps" → reword "observability, evals" to "MLOps and observability"
- Distribute keywords naturally: the first bullet of each role and (if present) the
  skills section. Do NOT add a summary section to carry keywords.

## ATS Keyword Matching (MANDATORY — run after reorder/reword, before compiling)

ATS parsers match **literal tokens, not meaning.** A bullet that describes the right
work in different words scores as a miss — so reordering and reading well to a human is
not enough. After tailoring, run an explicit coverage audit before you compile:

1. **Extract the JD's concrete keywords** (skills, tools, methods, named concepts) — the
   same 15-20 you pulled in pipeline step 4.
2. **Classify each against the current draft:**
   - **covered** — the exact term (or an unambiguous variant) already appears.
   - **partial** — the candidate's real experience supports it, but the résumé uses
     different vocabulary than the JD.
   - **gap** — no supporting experience in the selected base.
3. **For every `partial`, align the wording to the JD's exact term.** This is *required,
   not optional* — it is the same achievement relabeled with the scanner's vocabulary.
   Examples from real tailoring:
   - JD says "observability" + bullet says "audit/usage logging" → "...for observability
     and traceability of agent tool calls"
   - JD says "evaluation harness" + bullet says "evaluation pipeline" → "evaluation harness"
   - JD says "ETL" + bullet says "preprocessing with Spark" → "Spark ETL pipelines"
4. **Leave every `gap` off the résumé.** Never invent a skill, tool, or credential to hit
   a keyword. Surface gaps to the user for the cover letter, where prose can absorb the
   tokens truthfully ("built the equivalent from scratch, so {named tool} is a fast pickup").

This does **not** relax "reword minimally / never despecify / never invent" — it sharpens
the test for "this bullet already covers its keywords": the bar is whether the JD's *exact
term* appears, not whether a human-readable synonym does. Only realign vocabulary the
candidate's existing experience genuinely supports.

In the step 9 report, show the coverage audit as a short `covered / partial→aligned / gap`
breakdown so the user can see which keywords were matched and which were honestly left out.

## LaTeX Escaping (for content you add/change)

| Character | Escape |
|-----------|--------|
| `&` | `\&` |
| `%` | `\%` |
| `$` | `\$` |
| `#` | `\#` |
| `_` | `\_` |
| `{` | `\{` |
| `}` | `\}` |
| `~` | `\textasciitilde{}` |
| `^` | `\textasciicircum{}` |
| `\` | `\textbackslash{}` |
| `±` | `$\pm$` |
| `→` | `$\rightarrow$` |

**Exception:** Do NOT escape LaTeX commands (`\resumeItem`, `\textbf`, etc.) — only text.

**Exception for URLs:** Inside `\href{URL}{display}`, leave the URL (first arg) raw or
RFC 3986 percent-encoded; escape only the display text (second arg).

## Validator notes

`generate-latex.mjs` enforces only what affects compilation as **errors**
(`\begin{document}`/`\end{document}` present, no unresolved `{{PLACEHOLDERS}}`).
Section names, the bundled template's custom commands, and `\pdfgentounicode=1` are
reported as **warnings** — advisory ATS hints, not failures — so each base's own
style compiles fine.

## If a base file is missing

`templates/cv-template.tex` is a clean, ATS-friendly starting point (single column,
standard sections, Overleaf-compatible CTAN packages). If the user is missing a base
(e.g. no `cv-research.tex` yet), offer to seed it from the template, from another base,
or by converting a CV they paste — then this mode tailors from it going forward.

> **Cross-base consistency:** contact info and education should be identical across all
> three bases (see `cv.shared_fields` in profile.yml). `node cv-sync-check.mjs` warns if
> they drift. When you edit one base's shared block, apply the same edit to the others.
