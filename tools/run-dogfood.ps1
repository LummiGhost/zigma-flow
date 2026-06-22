# Zigma Flow DogFood Automation Script
# =====================================
# Runs the full code-change workflow end-to-end, capturing artifacts for review.
#
# Backend: Claude Code (DeepSeek via deepseek_api.psm1)
# --permission-mode bypassPermissions to prevent blocking
#
# Artifacts captured:
#   - Agent step: prompt.md, prompt-packet/*, report.json
#   - Auto (script/check) step: stdout.txt, stderr.txt, result.json, check-result.json
# All artifacts copied to <TempStepsDir>/<label>/ for review

param(
    [string]$RunId = "20260622-0002",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$ProjectDir = "D:\zigma\zigma-flow"
$TempStepsDir = "$ProjectDir\docs\temp\dogfood-20260622-prompt-opt\steps"
$RunDir = "$ProjectDir\.zigma-flow\runs\$RunId"

function Write-Phase { param([string]$Msg) Write-Host "`n===[ $Msg ]===" -ForegroundColor Cyan }
function Write-Step  { param([string]$Msg) Write-Host "`n--[ $Msg ]--" -ForegroundColor Yellow }
function Write-Ok    { param([string]$Msg) Write-Host $Msg -ForegroundColor Green }
function Write-Warn  { param([string]$Msg) Write-Host "WARN: $Msg" -ForegroundColor DarkYellow }
function Write-Fail  { param([string]$Msg) Write-Host "FAIL: $Msg" -ForegroundColor Red }

New-Item -ItemType Directory -Force -Path $TempStepsDir | Out-Null

# ---- Copy step artifacts to temp dir ----------------------------------------

function Copy-StepArtifacts {
    param([string]$JobId, [string]$Label, [int]$Attempt = 1)

    $dest = "$TempStepsDir\$Label"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null

    # Top-level prompt mirror
    $mirror = "$RunDir\current-step.md"
    if (Test-Path $mirror) {
        Copy-Item $mirror "$dest\prompt.md" -Force
        Write-Ok "  prompt  -> $dest\prompt.md"
    }

    # Prompt-packet block files
    $packetBase = "$RunDir\jobs\$JobId\attempts\$Attempt\steps"
    if (Test-Path $packetBase) {
        $packetDest = "$dest\prompt-packet"
        New-Item -ItemType Directory -Force -Path $packetDest | Out-Null
        Get-ChildItem -Recurse $packetBase | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
            $rel = $_.FullName.Substring($packetBase.Length + 1)
            $target = "$packetDest\$rel"
            New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
            Copy-Item $_.FullName $target -Force
        }
        Write-Ok "  packet  -> $packetDest"
    }
}

function Copy-StepReport {
    param([string]$JobId, [string]$StepId, [string]$Label, [int]$Attempt = 1)

    $src = "$RunDir\jobs\$JobId\attempts\$Attempt\steps\$StepId\report.json"
    if (Test-Path $src) {
        $dest = "$TempStepsDir\$Label\report.json"
        Copy-Item $src $dest -Force
        Write-Ok "  report  -> $dest"
    } else {
        Write-Warn "report.json not found at: $src"
    }
}

# Copy script/check step artifacts (stdout, stderr, result, check-result)
# into the temp steps directory under the provided label.
function Copy-AutoStepArtifacts {
    param(
        [string]$JobId,
        [string]$StepId,
        [string]$Label,
        [int]$Attempt = 1
    )

    $dest = "$TempStepsDir\$Label"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null

    $stepDir = "$RunDir\jobs\$JobId\attempts\$Attempt\steps\$StepId"
    if (-not (Test-Path $stepDir)) {
        Write-Warn "  auto step dir not found: $stepDir"
        return
    }

    $any = $false
    foreach ($file in @("stdout.txt", "stderr.txt", "result.json", "check-result.json")) {
        $src = "$stepDir\$file"
        if (Test-Path $src) {
            Copy-Item $src "$dest\$file" -Force
            Write-Ok "  $file -> $dest\$file"
            $any = $true
        }
    }

    # Also copy the step directory contents (any additional artifacts)
    Get-ChildItem $stepDir | Where-Object { -not $_.PSIsContainer -and $_.Name -notin @("stdout.txt", "stderr.txt", "result.json", "check-result.json") } | ForEach-Object {
        Copy-Item $_.FullName "$dest\$($_.Name)" -Force
        Write-Ok "  $($_.Name) -> $dest\$($_.Name)"
        $any = $true
    }

    if (-not $any) {
        Write-Warn "  no artifacts found for auto step $JobId/$StepId"
    }
}

# ---- Run zigma-flow CLI commands --------------------------------------------

function Invoke-Cli {
    param([string[]]$CliArgs)
    & node dist/cli.js @CliArgs
    if ($LASTEXITCODE -ne 0) {
        throw "CLI failed (exit $LASTEXITCODE): node dist/cli.js $($CliArgs -join ' ')"
    }
}

# ---- Agent step: prompt -> copy -> claude -> next ---------------------------

function Invoke-AgentStep {
    param(
        [string]$JobId,
        [string]$StepId,
        [string]$Label,
        [int]$Attempt = 1
    )

    Write-Step "AGENT  $Label : $JobId/$StepId"

    # 1. Generate prompt (skip if job is already in running state)
    $statusLines = & node dist/cli.js status $RunId 2>&1
    $jobLine = $statusLines | Select-String "^\s+$JobId\s+(\w+)"
    $currentStatus = if ($jobLine) { $jobLine.Matches[0].Groups[1].Value } else { "unknown" }

    if ($DryRun) {
        Write-Warn "[DryRun] Skipping prompt generation and claude invocation (no state mutation)"
        return
    }

    if ($currentStatus -eq "running") {
        Write-Host "  Job $JobId already running — reusing existing prompt" -ForegroundColor DarkYellow
    } else {
        Invoke-Cli "prompt", "--job", $JobId
    }

    # 2. Copy artifacts to temp dir (before claude runs)
    Copy-StepArtifacts -JobId $JobId -Label $Label -Attempt $Attempt

    # 3. Switch to DeepSeek model
    Import-Module -Name C:\Users\eadder\.claude\deepseek_api.psm1 -Force
    Write-Host "  Model: $env:ANTHROPIC_MODEL  URL: $env:ANTHROPIC_BASE_URL" -ForegroundColor DarkGray

    # 4. Call Claude Code with the generated prompt
    $promptFile = "$RunDir\current-step.md"
    $promptContent = Get-Content $promptFile -Raw

    Write-Host "  Calling claude --permission-mode bypassPermissions..." -ForegroundColor Cyan
    $null | claude --permission-mode bypassPermissions -p $promptContent

    # 5. Advance the workflow
    Invoke-Cli "next", "--job", $JobId

    # 6. Copy report.json
    Copy-StepReport -JobId $JobId -StepId $StepId -Label $Label -Attempt $Attempt
}

# ---- Script/check step: step ------------------------------------------------

function Invoke-AutoStep {
    param(
        [string]$JobId,
        [string]$StepId,
        [string]$Label,
        [int]$Attempt = 1
    )

    Write-Step "AUTO   $Label : $JobId/$StepId"
    Invoke-Cli "step", "--job", $JobId

    # Copy stdout, stderr, result, and check-result artifacts to temp dir
    Copy-AutoStepArtifacts -JobId $JobId -StepId $StepId -Label $Label -Attempt $Attempt
}

# ---- Check job status -------------------------------------------------------

function Get-JobStatus {
    param([string]$JobId)

    $lines = & node dist/cli.js status $RunId 2>&1
    $match = $lines | Select-String "^\s+$JobId\s+(\w+)"
    if ($match) { return $match.Matches[0].Groups[1].Value }
    return "unknown"
}

# =============================================================================
# Main execution
# =============================================================================

Write-Phase "DogFood Run: $RunId"
Write-Host "Task: Optimize prompt module - external template files" -ForegroundColor White
Write-Host "Temp: $TempStepsDir" -ForegroundColor DarkGray
if ($DryRun) { Write-Warn "DRY RUN - Claude Code will not be called" }

# 1. intake
Invoke-AgentStep -JobId "intake"  -StepId "analyze"  -Label "01-intake"

# 2. code-map
Invoke-AgentStep -JobId "code-map" -StepId "map"      -Label "02-code-map"

# 3. risk-scan (auto check)
Invoke-AutoStep  -JobId "risk-scan" -StepId "validate-report" -Label "03-risk-scan"

# 4. plan
Invoke-AgentStep -JobId "plan"    -StepId "plan"      -Label "04-plan"

# 4b. architecture-design (optional — only if plan emits signal)
$adStatus = Get-JobStatus -JobId "architecture-design"
if ($adStatus -eq "ready") {
    Write-Warn "architecture-design activated — running optional step"
    Invoke-AgentStep -JobId "architecture-design" -StepId "design" -Label "04b-arch-design"
}

# 5a. implement (agent step)
Invoke-AgentStep -JobId "implement" -StepId "implement" -Label "05a-implement"

# 5b. implement/collect-diff (auto script)
Invoke-AutoStep  -JobId "implement" -StepId "collect-diff" -Label "05b-collect-diff"

# 6. static-check (auto script)
Invoke-AutoStep  -JobId "static-check" -StepId "check" -Label "06a-static-check"

# 7. unit-test (auto script)
Invoke-AutoStep  -JobId "unit-test" -StepId "test" -Label "06b-unit-test"

# 8. review
Invoke-AgentStep -JobId "review"   -StepId "review"   -Label "07-review"

# 9. summarize
Invoke-AgentStep -JobId "summarize" -StepId "summarize" -Label "08-summarize"

Write-Phase "Workflow complete"
& node dist/cli.js status $RunId
Write-Ok "`nStep artifacts: $TempStepsDir"

# List auto step artifact folders for easy reference
Write-Host "`nAuto step artifacts:" -ForegroundColor Cyan
foreach ($label in @("03-risk-scan", "05b-collect-diff", "06a-static-check", "06b-unit-test")) {
    $dir = "$TempStepsDir\$label"
    if (Test-Path $dir) {
        $files = (Get-ChildItem $dir | ForEach-Object { $_.Name }) -join ", "
        Write-Host "  $label/ : $files" -ForegroundColor DarkGray
    }
}
