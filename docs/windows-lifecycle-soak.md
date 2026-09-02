# Windows lifecycle soak

This runbook verifies that Flow reaches a quiescent boundary before it reports
terminal completion or cancellation. It supplements the three-iteration
`windows-latest` CI gate with a longer local run.

## Scope and architecture boundary

The current runtime executes against a caller-provided external/shared
directory. It now owns and drains its state, event, platform-event, and run-log
writers, and it terminates and reaps Agent and Script process trees before
acknowledging cancellation.

Flow does **not** yet provision managed workspaces. The confirmed future model
in `docs/zigma-workspace-integration.md` uses one managed Run workspace plus a
separate workspace for each writable Job attempt. Different Job workspaces may
execute in parallel, while integration into the Run workspace remains
serialized. Workspace snapshot, reconcile, and cleanup must wait for the
quiescence boundary tested here.

## Bounded CI gate

`pnpm run test:lifecycle` covers:

- failed child startup;
- small and large stdout/stderr streaming without protocol contamination;
- timeout and external cancellation through the same idempotent termination;
- a real Windows parent/grandchild tree killed with `taskkill /T /F`;
- deterministic cancellation acknowledgement and fail-fast settlement;
- parallel scheduler and full dogfood DAG completion;
- writer drain and temporary-directory teardown through the covered run paths.

CI runs this suite three consecutive times on `windows-latest`. Any failed test,
unhandled rejection, test timeout, or non-zero process exit fails the job.

## Extended local soak

Run from a clean checkout in PowerShell:

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck

$failures = 0
$process = Get-Process -Id $PID
$handlesBefore = $process.HandleCount

1..100 | ForEach-Object {
  pnpm run test:lifecycle -- --silent
  if ($LASTEXITCODE -ne 0) { $failures += 1 }
}

Start-Sleep -Seconds 5
$handlesAfter = (Get-Process -Id $PID).HandleCount
[pscustomobject]@{
  Iterations = 100
  Failures = $failures
  HandleDelta = $handlesAfter - $handlesBefore
}
```

In a second terminal, sample likely Flow-owned children during the run:

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -in @('node.exe', 'cmd.exe', 'conhost.exe') } |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine
```

## Pass/fail thresholds

The extended soak passes only when all of the following are true:

- 100/100 lifecycle iterations pass with zero unhandled rejections or timeouts;
- no test-created marker is written after cancellation acknowledgement;
- no child whose command line points at the soak checkout remains after the
  five-second cooldown;
- all test-created run directories are removed by their teardown;
- the controlling PowerShell process handle delta is at most 20 after cooldown;
- stdout/NDJSON assertions contain no diagnostics from `taskkill`, shells, or
  cleanup helpers.

Record the commit SHA, Windows version, Node and pnpm versions, start/end time,
iteration result, handle counts, and any surviving PID/command line. A failed
threshold is release-blocking; preserve the failing run directory and process
sample before retrying.
