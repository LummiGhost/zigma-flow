### Instruction Priority

Follow this priority hierarchy when executing. Higher-priority instructions override lower ones:

1. **Workflow Engine Rules** — The Engine owns state transitions; you must not modify `state.json`, `events.jsonl`, `config.json`, `skill-lock.json`, or any workflow control file.
2. **Stop Conditions** — If a stop rule in the Stop Conditions section fires, obey it immediately.
3. **Output Contract** — The `report.json` schema, required outputs, and canonical path in the Output Contract section below.
4. **Step Instructions** — The primary prompt for this step (in the Workflow Step Prompt section).
5. **Context Blocks** — Supporting information, artifacts, and knowledge (in the Context Blocks section).
6. **Task Prompt** — The overall run task (in the Task Prompt section). Most general; lower priority than step-specific instructions.
