# Mode: latex — Tailor the user's LaTeX CV (source of truth)

The user's **`cv.tex` in the project root is the canonical resume** — their own LaTeX,
their own layout. This mode does NOT regenerate a CV from markdown. It duplicates
`cv.tex`, edits the copy in place to tailor it to a specific job, and compiles it to PDF.

> This is the only CV/PDF path in this setup. `cv.md`, the HTML template, and the
> markdown→PDF flow have been removed.

## Pipeline

1. Read `cv.tex` (the master resume — source of truth).
2. Read `config/profile.yml` for candidate identity (used for the output filename).
3. Get the JD if not already in context (text or URL).
4. Extract 15-20 keywords from the JD.
5. Detect the role archetype → adapt framing (see `modes/_profile.md`).
6. Copy `cv.tex` → `output/cv-{candidate}-{company}-{YYYY-MM-DD}.tex`.
7. **Edit the copy in place** (NEVER edit `cv.tex` itself):
   - Rewrite the Professional Summary, injecting JD keywords (rules below).
   - Reorder experience bullets so the most JD-relevant come first.
   - Reorder/select projects so the top 3-4 most relevant for the offer lead.
   - Inject JD vocabulary into existing achievements — reword, never invent.
8. Compile: `node generate-latex.mjs output/cv-{candidate}-{company}-{YYYY-MM-DD}.tex output/cv-{candidate}-{company}-{YYYY-MM-DD}.pdf`
9. Report: `.tex` path, `.pdf` path, file sizes, keyword coverage %, and any warnings from the validator.

**Requires:** `tectonic` (preferred — auto-downloads packages) or `pdflatex` (MiKTeX / TeX Live) on PATH.

## Ethical Rule #1 — NEVER invent skills (HARD RULE)

**The tailored CV must contain ZERO skills, tools, technologies, certifications, or
experience that are not already in the user's `cv.tex`.** Tailoring means *rewording
and reordering what is already there* using the JD's vocabulary — never adding new
claims.

- Do NOT add a tool/framework/language just because the JD asks for it.
- Do NOT inflate scope, seniority, metrics, or responsibilities.
- If the JD wants something the user doesn't have, leave it out — surface the gap to
  the user instead of papering over it on the resume.
- When in doubt, keep the user's original wording.

Why this matters: removing fabricated skills by hand afterward is painful and risky
(a missed one is a lie on a resume). Getting it right the first time is the whole point.

## Editing Rules (CRITICAL)

- **Never modify `cv.tex`.** Always work on the dated copy in `output/`.
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
- Distribute keywords naturally: the Professional Summary, the first bullet of each
  role, and (if present) the skills section.

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
reported as **warnings** — advisory ATS hints, not failures — so your own `cv.tex`
style compiles fine.

## If the user has no `cv.tex` yet

`templates/cv-template.tex` is a clean, ATS-friendly starting point (single column,
standard sections, Overleaf-compatible CTAN packages). Offer to seed `cv.tex` from it,
or to convert a CV they paste into a `.tex` resume — then this mode edits that going forward.
