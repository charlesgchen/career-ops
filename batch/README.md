# Batch Processing

Process multiple job offers in parallel via headless workers. Each worker runs the full evaluation pipeline (A-G report + PDF when gated in + tracker line) autonomously. Claude remains the default worker; Codex is available with `--agent codex`.

## Quick Start

1. **Add offers** to `batch-input.tsv` (tab-separated: `id`, `url`, `source`, `notes`):

   ```tsv
   id	url	source	notes
   1	https://jobs.example.com/role-a	LinkedIn	
   2	https://greenhouse.io/company/role-b	Greenhouse	priority
   ```

2. **Dry run** to preview what will be processed:

   ```bash
   ./batch/batch-runner.sh --dry-run
   ```

3. **Run the batch**:

   ```bash
   ./batch/batch-runner.sh
   ```

   To run with Codex workers:

   ```bash
   ./batch/batch-runner.sh --agent codex
   ```

4. **Results** are automatically merged into `data/applications.md` and verified with `verify-pipeline.mjs` at the end of the run.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--agent NAME` | `claude` | Worker backend: `claude` or `codex` |
| `--parallel N` | `1` | Number of concurrent headless workers |
| `--dry-run` | off | Preview pending offers without processing |
| `--retry-failed` | off | Only retry offers marked as `failed` in state |
| `--start-from N` | `0` | Skip offers with ID below N |
| `--max-retries N` | `2` | Max retry attempts per offer before giving up |
| `--model NAME` | CLI default | Model passed through to the selected worker CLI |
| `--codex-effort E` | `medium` | Codex reasoning effort: `minimal`, `low`, `medium`, `high`, or `xhigh` |
| `--codex-no-search` | off | Disable Codex web search for workers |
| `--codex-no-network` | off | Disable Codex shell-command network access |
| `--no-prefetch-jd` | off | Skip local JD prefetching and let workers fetch/read the posting |
| `--refresh-jd` | off | Re-fetch JD text even when a cached copy exists |
| `--jd-min-chars N` | `500` | Minimum extracted text length accepted as a JD |

## Directory Layout

```
batch/
  batch-runner.sh          # Orchestrator script
  fetch-jd.mjs             # Local ATS/static HTML JD prefetcher
  batch-prompt.md          # Prompt template sent to each worker
  worker-result.schema.json # Structured final output contract for Codex workers
  batch-input.tsv          # Input offers (you create this)
  batch-state.tsv          # Processing state (auto-managed, resumable)
  jd-cache/                # Local pre-fetched JD text files (gitignored)
  logs/                    # Per-offer worker logs ({report_num}-{id}.log)
  tracker-additions/       # TSV lines produced by workers
    merged/                # TSVs already merged into applications.md
```

## How It Works

1. **batch-runner.sh** reads `batch-input.tsv` and `batch-state.tsv` to determine which offers need processing.
2. For each pending offer, it assigns a report number and pre-fetches JD text into `batch/jd-cache/{id}.txt` when possible.
3. It launches a headless worker with `batch-prompt.md` as the instruction prompt (placeholders like `{{URL}}`, `{{JD_FILE}}`, `{{REPORT_NUM}}` are resolved).
4. Each worker evaluates the offer, writes a report to `reports/`, generates a PDF to `output/`, and writes a tracker TSV to `tracker-additions/`.
5. After all workers finish, batch-runner calls `merge-tracker.mjs` to merge TSVs into `data/applications.md` and runs `verify-pipeline.mjs` to check integrity.

## Tracker Merge

Workers write one TSV per offer to `batch/tracker-additions/`. The merge script (`npm run merge`) handles:

- Deduplication by company + role fuzzy match and report number
- Column order conversion (TSV has status before score; applications.md has score before status)
- In-place updates when a re-evaluation scores higher than the existing entry
- Moving processed TSVs to `tracker-additions/merged/`

Run `npm run merge` manually if you need to merge outside of a batch run.

## Resumability

`batch-state.tsv` tracks the status of every offer (`pending`, `processing`, `completed`, `failed`). If the batch is interrupted, re-running `batch-runner.sh` picks up where it left off -- completed offers are skipped automatically.

Offer identity is the URL. When `pipeline-to-batch.mjs` regenerates `batch-input.tsv`, it reuses the same numeric ID for URLs already present in `batch-state.tsv` or the previous `batch-input.tsv`, and assigns new IDs above the current maximum. `batch-runner.sh` also validates that each input ID still points to the same URL before it launches workers, so stale regenerated input cannot be mistaken for completed work.

A PID-based lock file (`batch-runner.pid`) prevents concurrent batch runs. If a previous run crashed, the stale lock is detected and removed automatically.

## Prerequisites

- Your selected CLI in PATH: `claude` for `--agent claude`, or `codex` for `--agent codex`
- Node.js >= 18, Playwright chromium installed (`npm run doctor` to verify)
- `batch-input.tsv` with at least one offer
