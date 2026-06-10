<#
.SYNOPSIS
    PowerShell wrapper for batch/batch-runner.sh — runs the bash batch runner
    via Git Bash so you don't have to type the full Git Bash path.

.DESCRIPTION
    The batch runner is a bash script and cannot run natively in PowerShell.
    This wrapper locates Git Bash (NOT the broken WSL `bash.exe` launcher),
    then invokes batch/batch-runner.sh with every argument you pass through.

    All flags are forwarded verbatim, so usage matches the bash script:
        .\batch\run-batch.ps1 --dry-run
        .\batch\run-batch.ps1 --parallel 2
        .\batch\run-batch.ps1 --parallel 2 --model claude-sonnet-4-6
        .\batch\run-batch.ps1 --retry-failed

.NOTES
    Run from the repo root (C:\Users\charl\Documents\career-ops) or anywhere —
    the script resolves paths relative to its own location.
#>

$ErrorActionPreference = 'Stop'

# --- Locate Git Bash (avoid the WSL bash.exe in System32) ---
$candidates = @(
    'C:\Program Files\Git\bin\bash.exe',
    'C:\Program Files (x86)\Git\bin\bash.exe',
    "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
)
$gitBash = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $gitBash) {
    # Fall back to whatever `git` is on PATH and derive bash from it.
    $git = (Get-Command git -ErrorAction SilentlyContinue).Source
    if ($git) {
        $guess = Join-Path (Split-Path (Split-Path $git -Parent) -Parent) 'bin\bash.exe'
        if (Test-Path $guess) { $gitBash = $guess }
    }
}

if (-not $gitBash) {
    Write-Error "Git Bash not found. Install Git for Windows, or edit the `$candidates list in this script."
    exit 1
}

# --- Resolve the runner relative to this wrapper ---
$runner = Join-Path $PSScriptRoot 'batch-runner.sh'
if (-not (Test-Path $runner)) {
    Write-Error "batch-runner.sh not found next to this wrapper ($runner)."
    exit 1
}

# --- Forward all args to the bash runner ---
Write-Host "Using Git Bash: $gitBash" -ForegroundColor DarkGray
Write-Host "Running:        batch-runner.sh $($args -join ' ')" -ForegroundColor DarkGray
Write-Host ""

& $gitBash $runner @args
exit $LASTEXITCODE
