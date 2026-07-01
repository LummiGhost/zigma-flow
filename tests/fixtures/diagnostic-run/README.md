# diagnostic-run fixture

Static test fixture for `WF-V022-DIAGNOSTIC` (`events` and `artifacts`
commands).

Purpose:
- Provides a run directory with **8 events** across **2 jobs** (`intake`,
  `implement`) so `zigma-flow events --limit N` tests can slice a range
  larger than 3 and the "default limit 20" test can assert that all
  events are printed when the log is short.
- Provides **3 artifacts** across the same **2 jobs** so `zigma-flow
  artifacts --job <id>` can be tested with real filter matches (2
  artifacts under `intake`, 1 under `implement`).

Files:
- `state.json` — minimal RunState with two jobs (`intake` done,
  `implement` running, attempt 2).
- `events.jsonl` — 8 events, monotonically ordered ids `evt-001..evt-008`.
- `artifacts.jsonl` — 3 artifact metadata entries. Referenced files on
  disk are NOT included because the diagnostic commands do not stat
  artifact paths (only `verify-run` does that).

Do not mutate — tests copy this directory to a temp path before use.
