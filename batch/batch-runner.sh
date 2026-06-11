#!/usr/bin/env bash
set -euo pipefail

# career-ops batch runner — standalone orchestrator for headless AI workers
# Reads batch-input.tsv, delegates each offer to a Claude or Codex worker,
# tracks state in batch-state.tsv for resumability.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BATCH_DIR="$SCRIPT_DIR"
INPUT_FILE="$BATCH_DIR/batch-input.tsv"
STATE_FILE="$BATCH_DIR/batch-state.tsv"
PROMPT_FILE="$BATCH_DIR/batch-prompt.md"
RESULT_SCHEMA_FILE="$BATCH_DIR/worker-result.schema.json"
JD_FETCHER_FILE="$BATCH_DIR/fetch-jd.mjs"
JD_CACHE_DIR="$BATCH_DIR/jd-cache"
LOGS_DIR="$BATCH_DIR/logs"
TRACKER_DIR="$BATCH_DIR/tracker-additions"
REPORTS_DIR="$PROJECT_DIR/reports"
APPLICATIONS_FILE="$PROJECT_DIR/data/applications.md"
LOCK_FILE="$BATCH_DIR/batch-runner.pid"
STATE_LOCK_DIR="$BATCH_DIR/.batch-state.lock"
STATE_LOCK_PID_FILE="$STATE_LOCK_DIR/pid"
STATE_LOCK_TIMEOUT_SECONDS=30
MAIN_PID="${BASHPID:-$$}"

# Defaults
PARALLEL=1
DRY_RUN=false
RETRY_FAILED=false
START_FROM=0
MAX_RETRIES=2
MIN_SCORE=0
LIMIT=0  # 0 = no cap; otherwise process only the first N pending offers
AGENT="${CAREER_OPS_AGENT:-claude}" # claude | codex
MODEL=""  # empty = let the selected CLI use its default
CODEX_SANDBOX="workspace-write"
CODEX_APPROVAL="never"
CODEX_SEARCH=true
CODEX_NETWORK=true
PREFETCH_JD=true
REFRESH_JD=false
JD_MIN_CHARS=500

usage() {
  cat <<'USAGE'
career-ops batch runner — process job offers in batch via headless workers
Defaults to Claude for backward compatibility; pass --agent codex to use Codex.

Usage: batch-runner.sh [OPTIONS]

Options:
  --agent NAME         Worker backend: claude or codex (default: claude)
  --parallel N         Number of parallel workers (default: 1)
  --dry-run            Show what would be processed, don't execute
  --retry-failed       Only retry offers marked as "failed" in state
  --start-from N       Start from offer ID N (skip earlier IDs)
  --limit N            Process only the first N pending offers, then stop
                       (alias: --top N; default: 0 = no cap). Processed offers
                       are marked completed, so the next run picks up the rest.
  --max-retries N      Max retry attempts per offer (default: 2)
  --min-score N        Skip PDF/tracker for offers scoring below N (default: 0 = off)
  --model NAME         Model passed through to the selected CLI
  --codex-sandbox M    Codex sandbox mode (default: workspace-write)
  --codex-approval P   Codex approval policy (default: never)
  --codex-no-search    Disable Codex web search
  --codex-no-network   Disable network access for Codex shell commands
  --no-prefetch-jd     Do not prefetch JD text before launching workers
  --refresh-jd         Re-fetch JD text even when a cached file exists
  --jd-min-chars N     Minimum extracted JD length to accept (default: 500)
  -h, --help           Show this help

Files:
  batch-input.tsv      Input offers (id, url, source, notes)
  batch-state.tsv      Processing state (auto-managed)
  batch-prompt.md      Prompt template for workers
  logs/                Per-offer logs
  tracker-additions/   Tracker lines for post-batch merge

Examples:
  # Dry run to see pending offers
  ./batch-runner.sh --dry-run

  # Process all pending
  ./batch-runner.sh

  # Process with Codex workers
  ./batch-runner.sh --agent codex --parallel 2

  # Retry only failed offers
  ./batch-runner.sh --retry-failed

  # Process 2 at a time starting from ID 10
  ./batch-runner.sh --parallel 2 --start-from 10

  # Process only the top 5 pending offers, then stop
  ./batch-runner.sh --limit 5
USAGE
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent) AGENT="$2"; shift 2 ;;
    --parallel) PARALLEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --retry-failed) RETRY_FAILED=true; shift ;;
    --start-from) START_FROM="$2"; shift 2 ;;
    --limit|--top) LIMIT="$2"; shift 2 ;;
    --max-retries) MAX_RETRIES="$2"; shift 2 ;;
    --min-score) MIN_SCORE="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --codex-sandbox) CODEX_SANDBOX="$2"; shift 2 ;;
    --codex-approval) CODEX_APPROVAL="$2"; shift 2 ;;
    --codex-no-search) CODEX_SEARCH=false; shift ;;
    --codex-no-network) CODEX_NETWORK=false; shift ;;
    --no-prefetch-jd) PREFETCH_JD=false; shift ;;
    --refresh-jd) REFRESH_JD=true; shift ;;
    --jd-min-chars) JD_MIN_CHARS="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# Validate --limit/--top: must be a non-negative integer (0 = no cap)
if [[ ! "$LIMIT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --limit/--top must be a non-negative integer (got '$LIMIT')."
  exit 1
fi
if [[ ! "$JD_MIN_CHARS" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --jd-min-chars must be a non-negative integer (got '$JD_MIN_CHARS')."
  exit 1
fi

# Lock file to prevent double execution
acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$LOCK_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "ERROR: Another batch-runner is already running (PID $old_pid)"
      echo "If this is stale, remove $LOCK_FILE"
      exit 1
    else
      echo "WARN: Stale lock file found (PID $old_pid not running). Removing."
      rm -f "$LOCK_FILE"
    fi
  fi
  echo "$MAIN_PID" > "$LOCK_FILE"
}

release_lock() {
  if [[ "${BASHPID:-$$}" != "$MAIN_PID" ]]; then
    return
  fi
  rm -f "$LOCK_FILE"
}

trap release_lock EXIT

# Validate prerequisites
check_prerequisites() {
  if [[ ! -f "$INPUT_FILE" ]]; then
    echo "ERROR: $INPUT_FILE not found. Add offers first."
    exit 1
  fi

  if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "ERROR: $PROMPT_FILE not found."
    exit 1
  fi
  if [[ "$PREFETCH_JD" == "true" && ! -f "$JD_FETCHER_FILE" ]]; then
    echo "ERROR: $JD_FETCHER_FILE not found."
    exit 1
  fi

  case "$AGENT" in
    claude)
      if ! command -v claude &>/dev/null; then
        echo "ERROR: 'claude' CLI not found in PATH."
        exit 1
      fi
      ;;
    codex)
      if ! command -v codex &>/dev/null; then
        echo "ERROR: 'codex' CLI not found in PATH."
        exit 1
      fi
      if [[ ! -f "$RESULT_SCHEMA_FILE" ]]; then
        echo "ERROR: $RESULT_SCHEMA_FILE not found."
        exit 1
      fi
      ;;
    *)
      echo "ERROR: unknown --agent '$AGENT' (expected: claude or codex)."
      exit 1
      ;;
  esac

  mkdir -p "$LOGS_DIR" "$TRACKER_DIR" "$REPORTS_DIR" "$JD_CACHE_DIR"
}

# Initialize state file if it doesn't exist
init_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    printf 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' > "$STATE_FILE"
  fi
}

acquire_state_lock() {
  local waited=0
  local max_waits=$((STATE_LOCK_TIMEOUT_SECONDS * 10))

  while true; do
    if mkdir "$STATE_LOCK_DIR" 2>/dev/null; then
      if printf '%s\n' "${BASHPID:-$$}" > "$STATE_LOCK_PID_FILE"; then
        return 0
      fi
      rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
      rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
      echo "ERROR: Failed to initialize state lock metadata at $STATE_LOCK_DIR"
      return 1
    fi

    if [[ ! -d "$STATE_LOCK_DIR" ]]; then
      echo "ERROR: Failed to create state lock directory $STATE_LOCK_DIR"
      return 1
    fi

    if [[ -f "$STATE_LOCK_PID_FILE" ]]; then
      local lock_pid
      lock_pid=$(cat "$STATE_LOCK_PID_FILE" 2>/dev/null || true)
      if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -f "$STATE_LOCK_PID_FILE"
        if rmdir "$STATE_LOCK_DIR" 2>/dev/null; then
          echo "WARN: Recovered stale state lock (PID $lock_pid not running)."
          continue
        fi
      fi
    fi

    if (( waited >= max_waits )); then
      echo "ERROR: Timed out waiting for state lock at $STATE_LOCK_DIR"
      echo "If no batch-runner worker is active, remove the stale lock directory."
      return 1
    fi

    sleep 0.1
    ((waited += 1))
  done
}

release_state_lock() {
  rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
  rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
}

run_with_state_lock() {
  acquire_state_lock || return $?

  local status=0
  if "$@"; then
    status=0
  else
    status=$?
  fi

  release_state_lock
  return "$status"
}

# Get status of an offer from state file
get_status() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "none"
    return
  fi
  local status
  status=$(awk -F'\t' -v id="$id" '$1 == id { print $3 }' "$STATE_FILE")
  echo "${status:-none}"
}

# Get retry count for an offer
get_retries() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "0"
    return
  fi
  local retries
  retries=$(awk -F'\t' -v id="$id" '$1 == id { print $9 }' "$STATE_FILE")
  echo "${retries:-0}"
}

get_error() {
  local id="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo ""
    return
  fi
  local error
  error=$(awk -F'\t' -v id="$id" '$1 == id { print $8 }' "$STATE_FILE")
  echo "${error:-}"
}

is_runner_cli_error() {
  local error="$1"
  [[ "$error" == *"Usage: codex exec"* || "$error" == *"unexpected argument"* ]]
}

# Calculate next report number.
# Caller must hold STATE_LOCK_DIR while this runs.
next_report_num_unlocked() {
  local max_num=0
  if [[ -d "$REPORTS_DIR" ]]; then
    for f in "$REPORTS_DIR"/*.md; do
      [[ -f "$f" ]] || continue
      local basename
      basename=$(basename "$f")
      local num="${basename%%-*}"
      num=$((10#$num)) # Remove leading zeros for arithmetic
      if (( num > max_num )); then
        max_num=$num
      fi
    done
  fi
  # Also check state file for assigned report numbers
  if [[ -f "$STATE_FILE" ]]; then
    while IFS=$'\t' read -r _ _ _ _ _ rnum _ _ _; do
      [[ "$rnum" == "report_num" || "$rnum" == "-" || -z "$rnum" ]] && continue
      local n=$((10#$rnum))
      if (( n > max_num )); then
        max_num=$n
      fi
    done < "$STATE_FILE"
  fi
  printf '%03d' $((max_num + 1))
}

# Update or insert state for an offer.
# Caller must hold STATE_LOCK_DIR while this runs.
update_state_unlocked() {
  local id="$1" url="$2" status="$3" started="$4" completed="$5" report_num="$6" score="$7" error="$8" retries="$9"

  if [[ ! -f "$STATE_FILE" ]]; then
    init_state
  fi

  local tmp="$STATE_FILE.tmp"
  local found=false

  # Write header
  head -1 "$STATE_FILE" > "$tmp"

  # Process existing lines
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries; do
    [[ "$sid" == "id" ]] && continue  # skip header
    if [[ "$sid" == "$id" ]]; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
      found=true
    else
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$sid" "$surl" "$sstatus" "$sstarted" "$scompleted" "$sreport" "$sscore" "$serror" "$sretries" >> "$tmp"
    fi
  done < "$STATE_FILE"

  if [[ "$found" == "false" ]]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
  fi

  mv "$tmp" "$STATE_FILE"
}

update_state() {
  run_with_state_lock update_state_unlocked "$@"
}

reserve_report_num_unlocked() {
  local id="$1" url="$2" started="$3" retries="$4"

  # Reuse a report number already assigned to this offer (e.g. on retry) so a
  # retry doesn't orphan the prior report or churn the numbering. Only reserve
  # a fresh number when the offer has never been assigned one.
  local report_num=""
  if [[ -f "$STATE_FILE" ]]; then
    report_num=$(awk -F'\t' -v id="$id" '$1 == id { print $6 }' "$STATE_FILE")
  fi
  if [[ ! "$report_num" =~ ^[0-9]+$ ]]; then
    report_num=""
    if ! report_num=$(next_report_num_unlocked); then
      report_num=""
    fi
  fi

  if [[ -n "$report_num" ]]; then
    update_state_unlocked "$id" "$url" "processing" "$started" "-" "$report_num" "-" "-" "$retries"
  fi

  printf '%s\n' "$report_num"
}

reserve_report_num() {
  run_with_state_lock reserve_report_num_unlocked "$@"
}

json_field() {
  local file="$1" field="$2"
  [[ -s "$file" ]] || return 0

  node -e '
const fs = require("fs");
const [file, field] = process.argv.slice(1);
try {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const value = data[field];
  if (value !== undefined && value !== null) process.stdout.write(String(value));
} catch {}
' "$file" "$field" 2>/dev/null || true
}

extract_score() {
  local result_file="$1" log_file="$2"
  local score

  score=$(json_field "$result_file" score)
  if [[ -n "$score" ]]; then
    printf '%s\n' "$score"
    return
  fi

  sed -nE 's/.*"score":[[:space:]]*([0-9.]+).*/\1/p' "$log_file" 2>/dev/null | head -1 || true
}

run_claude_worker() {
  local prompt="$1" resolved_prompt="$2" log_file="$3"

  # Model defaults to the Claude Max subscription default unless --model was
  # passed. Building the command in an array keeps quoting safe regardless.
  local -a claude_args=(-p --dangerously-skip-permissions)
  if [[ -n "$MODEL" ]]; then
    claude_args+=(--model "$MODEL")
  fi
  claude_args+=(--append-system-prompt-file "$resolved_prompt" "$prompt")

  claude "${claude_args[@]}" > "$log_file" 2>&1
}

run_codex_worker() {
  local prompt="$1" resolved_prompt="$2" log_file="$3" result_file="$4"
  local full_prompt="$BATCH_DIR/.codex-prompt-${BASHPID:-$$}.md"
  local codex_project_dir codex_schema_file codex_result_file
  codex_project_dir=$(path_for_prompt "$PROJECT_DIR")
  codex_schema_file=$(path_for_prompt "$RESULT_SCHEMA_FILE")
  codex_result_file=$(path_for_prompt "$result_file")

  {
    printf '%s\n\n' '# System instructions'
    cat "$resolved_prompt"
    printf '%s\n\n' '---'
    printf '%s\n' '# Invocation'
    printf '%s\n' "$prompt"
  } > "$full_prompt"

  local -a codex_args=()

  if [[ "$CODEX_SEARCH" == "true" ]]; then
    codex_args+=(--search)
  fi
  codex_args+=(--ask-for-approval "$CODEX_APPROVAL")

  codex_args+=(
    exec
    -C "$codex_project_dir"
    --sandbox "$CODEX_SANDBOX"
    --ephemeral
    --output-schema "$codex_schema_file"
    --output-last-message "$codex_result_file"
    --color never
  )

  if [[ "$CODEX_NETWORK" == "true" && "$CODEX_SANDBOX" == "workspace-write" ]]; then
    codex_args+=(-c 'sandbox_workspace_write.network_access=true')
  fi
  if [[ -n "$MODEL" ]]; then
    codex_args+=(--model "$MODEL")
  fi

  local status=0
  codex "${codex_args[@]}" - < "$full_prompt" > "$log_file" 2>&1 || status=$?
  rm -f "$full_prompt"
  return "$status"
}

run_worker() {
  local prompt="$1" resolved_prompt="$2" log_file="$3" result_file="$4"

  case "$AGENT" in
    claude) run_claude_worker "$prompt" "$resolved_prompt" "$log_file" ;;
    codex) run_codex_worker "$prompt" "$resolved_prompt" "$log_file" "$result_file" ;;
  esac
}

path_for_prompt() {
  local path="$1"
  if command -v cygpath &>/dev/null; then
    cygpath -w "$path" 2>/dev/null || printf '%s\n' "$path"
  else
    printf '%s\n' "$path"
  fi
}

file_char_count() {
  local file="$1"
  [[ -f "$file" ]] || { echo 0; return; }
  node -e '
const fs = require("fs");
const file = process.argv[1];
try {
  process.stdout.write(String(fs.readFileSync(file, "utf8").trim().length));
} catch {
  process.stdout.write("0");
}
' "$file" 2>/dev/null || echo 0
}

prefetch_jd() {
  local url="$1" jd_file="$2" meta_file="$3" prefetch_log="$4"

  if [[ "$PREFETCH_JD" != "true" ]]; then
    return 0
  fi

  local existing_chars=0
  existing_chars=$(file_char_count "$jd_file")
  if [[ "$REFRESH_JD" != "true" && "$existing_chars" =~ ^[0-9]+$ && "$existing_chars" -ge "$JD_MIN_CHARS" ]]; then
    echo "    JD cache hit ($existing_chars chars)"
    return 0
  fi

  local tmp_file="$jd_file.tmp"
  rm -f "$tmp_file"

  if node "$JD_FETCHER_FILE" "$url" "$tmp_file" --min-chars "$JD_MIN_CHARS" --meta "$meta_file" > "$prefetch_log" 2>&1; then
    mv "$tmp_file" "$jd_file"
    local chars
    chars=$(file_char_count "$jd_file")
    echo "    JD prefetched ($chars chars)"
    return 0
  fi

  local reason
  reason=$(tail -3 "$prefetch_log" 2>/dev/null | tr '\t\n' '  ' | cut -c1-220)
  echo "    WARN: JD prefetch failed; worker will fall back to web tools (${reason:-unknown error})"
  rm -f "$tmp_file"
  if [[ ! -e "$jd_file" ]]; then
    : > "$jd_file"
  fi
  return 0
}

# Process a single offer
process_offer() {
  local id="$1" url="$2" source="$3" notes="$4"

  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local retries
  retries=$(get_retries "$id")
  local report_num
  report_num=$(reserve_report_num "$id" "$url" "$started_at" "$retries")
  local date
  date=$(date +%Y-%m-%d)
  local jd_file="$JD_CACHE_DIR/${id}.txt"
  local jd_meta_file="$JD_CACHE_DIR/${id}.meta.json"

  echo "--- Processing offer #$id: $url (report $report_num, attempt $((retries + 1)))"

  local log_file="$LOGS_DIR/${report_num}-${id}.log"
  local result_file="$LOGS_DIR/${report_num}-${id}.result.json"
  local prefetch_log="$LOGS_DIR/${report_num}-${id}.prefetch.log"

  prefetch_jd "$url" "$jd_file" "$jd_meta_file" "$prefetch_log"
  local prompt_jd_file
  prompt_jd_file=$(path_for_prompt "$jd_file")

  # Build the prompt with placeholders replaced
  local prompt
  prompt="Process this job offer. Run the full pipeline: A-G evaluation + report .md + PDF if it passes the threshold + tracker line."
  prompt="$prompt URL: $url"
  prompt="$prompt JD file: $prompt_jd_file"
  prompt="$prompt Report number: $report_num"
  prompt="$prompt Date: $date"
  prompt="$prompt Batch ID: $id"

  # Prepare system prompt with placeholders resolved
  local resolved_prompt="$BATCH_DIR/.resolved-prompt-${id}.md"
  # Escape sed delimiter characters in variables to prevent substitution breakage
  local esc_url esc_jd_file esc_report_num esc_date esc_id
  esc_url="${url//\\/\\\\}"
  esc_url="${esc_url//|/\\|}"
  esc_jd_file="${prompt_jd_file//\\/\\\\}"
  esc_jd_file="${esc_jd_file//|/\\|}"
  esc_report_num="${report_num//|/\\|}"
  esc_date="${date//|/\\|}"
  esc_id="${id//|/\\|}"
  sed \
    -e "s|{{URL}}|${esc_url}|g" \
    -e "s|{{JD_FILE}}|${esc_jd_file}|g" \
    -e "s|{{REPORT_NUM}}|${esc_report_num}|g" \
    -e "s|{{DATE}}|${esc_date}|g" \
    -e "s|{{ID}}|${esc_id}|g" \
    "$PROMPT_FILE" > "$resolved_prompt"

  local exit_code=0
  run_worker "$prompt" "$resolved_prompt" "$log_file" "$result_file" || exit_code=$?

  # Cleanup resolved prompt
  rm -f "$resolved_prompt"

  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  if [[ $exit_code -eq 0 ]]; then
    # Try to extract score from worker output
    local score="-"
    local score_match worker_status worker_error
    worker_status=$(json_field "$result_file" status)
    worker_error=$(json_field "$result_file" error)
    worker_error="${worker_error//$'\t'/ }"
    worker_error="${worker_error//$'\n'/ }"
    score_match=$(extract_score "$result_file" "$log_file")

    if [[ "$worker_status" == "failed" ]]; then
      retries=$((retries + 1))
      update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "${worker_error:-worker reported failure}" "$retries"
      echo "    ❌ Failed (worker reported failure)"
      return 0
    fi

    if [[ -n "$score_match" ]]; then
      score="$score_match"
    fi

    if [[ "$worker_status" == "skipped" ]]; then
      update_state "$id" "$url" "skipped" "$started_at" "$completed_at" "$report_num" "$score" "${worker_error:-worker reported skipped}" "$retries"
      echo "    ⏭️  Skipped (worker reported skipped, score: $score)"
      return 0
    fi

    # A real evaluation MUST have written a report file (Step 3 of the prompt).
    # If the worker exited 0 but produced no report — e.g. a transient CLI or
    # session-limit error like "Execution error" — treat it as a failure so it
    # retries, instead of being marked completed and skipped on every later run.
    local report_glob=("$REPORTS_DIR/${report_num}-"*.md)
    if [[ ! -e "${report_glob[0]}" ]]; then
      retries=$((retries + 1))
      local empty_err
      empty_err=$(tail -3 "$log_file" 2>/dev/null | tr '\t\n' '  ' | cut -c1-200)
      update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "${empty_err:-exited 0 but wrote no report}" "$retries"
      echo "    ❌ Failed (exit 0 but no report written — likely transient/session-limit error)"
      return 0
    fi

    # Check min-score gate
    if [[ "$score" != "-" && -n "$score" ]] && (( $(echo "$MIN_SCORE > 0" | bc -l) )); then
      if (( $(echo "$score < $MIN_SCORE" | bc -l) )); then
        update_state "$id" "$url" "skipped" "$started_at" "$completed_at" "$report_num" "$score" "below-min-score" "$retries"
        echo "    ⏭️  Skipped (score: $score < min-score: $MIN_SCORE)"
        return 0
      fi
    fi

    update_state "$id" "$url" "completed" "$started_at" "$completed_at" "$report_num" "$score" "-" "$retries"
    echo "    ✅ Completed (score: $score, report: $report_num)"
  else
    retries=$((retries + 1))
    local error_msg
    error_msg=$(tail -5 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "Unknown error (exit code $exit_code)")
    update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "$error_msg" "$retries"
    echo "    ❌ Failed (attempt $retries, exit code $exit_code)"
  fi
}

# Merge tracker additions into applications.md
merge_tracker() {
  echo ""
  echo "=== Merging tracker additions ==="
  node "$PROJECT_DIR/merge-tracker.mjs"
  echo ""
  echo "=== Verifying pipeline integrity ==="
  node "$PROJECT_DIR/verify-pipeline.mjs" || echo "⚠️  Verification found issues (see above)"
}

# Print summary
print_summary() {
  echo ""
  echo "=== Batch Summary ==="

  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found."
    return
  fi

  local total=0 completed=0 failed=0 pending=0
  local score_sum=0 score_count=0

  while IFS=$'\t' read -r sid _ sstatus _ _ _ sscore _ _; do
    [[ "$sid" == "id" ]] && continue
    total=$((total + 1))
    case "$sstatus" in
      completed) completed=$((completed + 1))
        if [[ "$sscore" != "-" && -n "$sscore" ]]; then
          score_sum=$(echo "$score_sum + $sscore" | bc 2>/dev/null || echo "$score_sum")
          score_count=$((score_count + 1))
        fi
        ;;
      failed) failed=$((failed + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done < "$STATE_FILE"

  echo "Total: $total | Completed: $completed | Failed: $failed | Pending: $pending"

  if (( score_count > 0 )); then
    local avg
    avg=$(echo "scale=1; $score_sum / $score_count" | bc 2>/dev/null || echo "N/A")
    echo "Average score: $avg/5 ($score_count scored)"
  fi
}

# Main
main() {
  check_prerequisites

  if [[ "$DRY_RUN" == "false" ]]; then
    acquire_lock
  fi

  init_state

  # Count input offers (skip header, ignore blank lines)
  local total_input
  total_input=$(tail -n +2 "$INPUT_FILE" | grep -c '[^[:space:]]' 2>/dev/null || true)
  total_input="${total_input:-0}"

  if (( total_input == 0 )); then
    echo "No offers in $INPUT_FILE. Add offers first."
    exit 0
  fi

  echo "=== career-ops batch runner ==="
  echo "Agent: $AGENT | Parallel: $PARALLEL | Max retries: $MAX_RETRIES"
  echo "JD prefetch: $PREFETCH_JD | JD min chars: $JD_MIN_CHARS | Refresh JD: $REFRESH_JD"
  echo "Input: $total_input offers"
  echo ""

  # Build list of offers to process
  local -a pending_ids=()
  local -a pending_urls=()
  local -a pending_sources=()
  local -a pending_notes=()

  while IFS=$'\t' read -r id url source notes; do
    [[ "$id" == "id" ]] && continue  # skip header
    [[ -z "$id" || -z "$url" ]] && continue

    # Guard against non-numeric id values
    [[ "$id" =~ ^[0-9]+$ ]] || continue

    # Skip if before start-from
    if (( id < START_FROM )); then
      continue
    fi

    local status
    status=$(get_status "$id")

    if [[ "$RETRY_FAILED" == "true" ]]; then
      # Only process failed offers
      if [[ "$status" != "failed" ]]; then
        continue
      fi
      # Check retry limit
      local retries
      retries=$(get_retries "$id")
      if (( retries >= MAX_RETRIES )); then
        local error
        error=$(get_error "$id")
        if is_runner_cli_error "$error"; then
          echo "WARN #$id: retrying previous runner/CLI argument failure despite max retries"
        else
          echo "SKIP #$id: max retries ($MAX_RETRIES) reached"
          continue
        fi
      fi
    else
      # Skip completed offers
      if [[ "$status" == "completed" ]]; then
        continue
      fi
      # Skip failed offers that hit retry limit (unless --retry-failed)
      if [[ "$status" == "failed" ]]; then
        local retries
        retries=$(get_retries "$id")
        if (( retries >= MAX_RETRIES )); then
          local error
          error=$(get_error "$id")
          if is_runner_cli_error "$error"; then
            echo "WARN #$id: retrying previous runner/CLI argument failure despite max retries"
          else
            echo "SKIP #$id: failed and max retries reached (use --retry-failed to force)"
            continue
          fi
        fi
      fi
    fi

    pending_ids+=("$id")
    pending_urls+=("$url")
    pending_sources+=("$source")
    pending_notes+=("$notes")
  done < "$INPUT_FILE"

  # Apply --limit/--top: keep only the first N pending offers (input order).
  # The dropped offers stay untouched in state, so the next run processes them.
  if (( LIMIT > 0 && ${#pending_ids[@]} > LIMIT )); then
    echo "Limiting to top $LIMIT of ${#pending_ids[@]} pending offers (input order)."
    pending_ids=("${pending_ids[@]:0:LIMIT}")
    pending_urls=("${pending_urls[@]:0:LIMIT}")
    pending_sources=("${pending_sources[@]:0:LIMIT}")
    pending_notes=("${pending_notes[@]:0:LIMIT}")
  fi

  local pending_count=${#pending_ids[@]}

  if (( pending_count == 0 )); then
    echo "No offers to process."
    print_summary
    exit 0
  fi

  echo "Pending: $pending_count offers"
  echo ""

  # Dry run: just list
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "=== DRY RUN (no processing) ==="
    for i in "${!pending_ids[@]}"; do
      local status
      status=$(get_status "${pending_ids[$i]}")
      echo "  #${pending_ids[$i]}: ${pending_urls[$i]} [${pending_sources[$i]}] (status: $status)"
    done
    echo ""
    echo "Would process $pending_count offers"
    exit 0
  fi

  # Process offers
  if (( PARALLEL <= 1 )); then
    # Sequential processing
    for i in "${!pending_ids[@]}"; do
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}"
    done
  else
    # Parallel processing with job control
    local running=0
    local -a pids=()
    local -a pid_ids=()

    for i in "${!pending_ids[@]}"; do
      # Wait if we're at parallel limit
      while (( running >= PARALLEL )); do
        # Wait for any child to finish
        for j in "${!pids[@]}"; do
          if ! kill -0 "${pids[$j]}" 2>/dev/null; then
            wait "${pids[$j]}" 2>/dev/null || true
            unset 'pids[j]'
            unset 'pid_ids[j]'
            running=$((running - 1))
          fi
        done
        # Compact arrays
        pids=("${pids[@]}")
        pid_ids=("${pid_ids[@]}")
        sleep 1
      done

      # Launch worker in background
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}" &
      pids+=($!)
      pid_ids+=("${pending_ids[$i]}")
      running=$((running + 1))
    done

    # Wait for remaining workers
    for pid in "${pids[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi

  # Merge tracker additions
  merge_tracker

  # Print summary
  print_summary
}

main "$@"
