# Subagent Playbooks

这些模板用于主管 agent 下发任务。通过 Claude Code 的 `Agent` 工具（`subagent_type: general-purpose`）委派。把真实路径、阶段名称、工作流名称、验收标准替换进去；不要把自己的结论提前泄露给 subagent。

## General Rules

- 每个 subagent 只拿到完成当前任务所需的最小上下文。
- 每个 subagent 都要明确输出文件路径和完成定义。
- 要求 subagent 列出修改的文件与未解决问题。
- 主管只等待结果，不替 subagent 做中间分析。

## 1. Research Prompt

```text
You are assisting as a research agent for phase "<phase-name>".

Context:
- Phase plan: <path>
- Research topic: <topic>
- Decision to support: <decision>
- Constraints: <constraints>

Task:
1. Evaluate candidate options.
2. Validate feasibility with concrete evidence from the codebase, docs, or experiments.
3. Write a research report to <output-path>.
4. End with a clear recommendation, rejected options, risks, and implementation implications.

Do not edit the phase plan directly.
```

## 2. Cases And Tests Prompt

```text
Support the workflow "<workflow-name>" for phase "<phase-name>".

Inputs:
- Frozen phase plan: <path>
- Workflow folder: <path>
- Acceptance criteria: <criteria>
- Relevant design specs (if any): <e.g. docs/architecture.md §4, docs/mvp-contracts.md §8>
- UX expectations document (if user-facing): <path or "not provided">

Task:
0. Declare the slice boundary FIRST, before enumerating anything else:
   - Slice name:
   - Single bounded context this slice belongs to:
   - List of user tasks to be covered ("用户可完成…") — maximum 3. If the workflow scope implies more than 3 user tasks, STOP and report back that the workflow needs to be split into sub-slices. Do not proceed until the supervisor confirms the split.
   - Planned test files — maximum 2. If a single whole-page test file would be needed, STOP and propose a split test structure first.

1. Enumerate functional points and use cases.
   - If this is a user-facing workflow, at least one acceptance criterion must start with "用户可完成…" and map to a concrete test or manual verification step.
   - Base the UX flow on the UX expectations document if provided; if not provided, note this as a risk.
2. If relevant design specs are provided, output a Spec Compliance Matrix:
   - List every MUST/SHALL clause from the spec sections.
   - For each clause, mark its status: "已纳入本工作流" / "计划外（技术债 TD-xxx）" / "规范不适用".
   - Do NOT leave any MUST/SHALL clause without a status — unmarked clauses are treated as gaps.
   - If the total clause count exceeds 15, report back that the slice is too large and needs splitting.
3. Write the cases-and-tests document to <workflow-doc-path>.
4. Add or update unit tests that cover the documented cases.
5. Report touched files, uncovered gaps, and any blockers.

Do not implement product behavior beyond what is needed for tests.
```

## 3. Architecture Review Prompt (Step 1 → Step 2 gate)

Run this prompt as the **supervisor** (not delegated to a subagent) before dispatching a Step 2 implementation subagent. Write the result to `<workflow-id>/01-step1-architecture-review-<date>.md`.

```text
Review the Step 1 cases-and-tests document for workflow "<workflow-name>" before Step 2 implementation begins.

Inputs:
- Step 1 document: <path>
- Phase architecture constraints: <path to architecture doc or plan>
- Bounded context map: <path to bounded context map or equivalent>

Task:
For each item below, mark it PASS or FAIL and describe the finding:

1. Module responsibility
   PASS: Each planned module has exactly one responsibility.
   FAIL: Any module plan stacks list + form + test + browse + preview or similar multi-concern bundles.

2. State layering
   PASS: The document distinguishes at minimum: UI interaction state, draft view model, domain command result, runtime cache.
   FAIL: The document does not separate these, or all state is described as a single "page state".

3. Test boundary
   PASS: The test plan has per-module test files; no single whole-page test file covers all cases.
   FAIL: The test plan calls for a single large test file to cover all use cases.

4. Domain command mapping
   PASS: Every user-visible action is mapped to a named domain command in its declared bounded context.
   FAIL: Any user action is described as "calls API" or "updates state" without a bounded context and command name.

5. Cross-workflow coupling
   PASS: Any component shared with other workflows is planned as an independent slice with its own Step 1.
   FAIL: A shared component is planned to be implemented in the same Step 2 as the workbench shell.

Verdict: PASS (all 5 pass) or FAIL (any item fails).

If FAIL: list the required Step 1 revisions. Do not dispatch a Step 2 subagent until a revised Step 1 is re-reviewed and passes.
If PASS: write the review record and proceed to dispatch Step 2.
```

## 4. Implementation Prompt

```text
Implement the workflow "<workflow-name>" for phase "<phase-name>".

Inputs:
- Frozen phase plan: <path>
- Cases-and-tests document: <path>
- Architecture review record: <path>
- Existing tests and codebase context

Task:
1. Complete the workflow implementation.
2. Make the relevant tests pass.
3. Before writing the implementation report, run the minimum gate package for this workflow:
   - typecheck
   - lint
   - relevant test suite
   All gates must be green. Do NOT leave any red gate for Step 3 to discover.
4. If a Spec Compliance Matrix was produced in Step 1, verify that every clause marked "已纳入本工作流" is now implemented. Any clause that could not be completed must be registered as a technical debt item (with clause reference and reason) in the implementation report.
5. If this is a user-facing workflow, produce at least one screenshot (temporary preview or test-based) of the rendered UI and include the path in the implementation report. This screenshot is for the supervisor's design conformance review before Step 3 begins.
6. Post the implementation report as a **comment on the active PR** for this workflow. Do NOT write it to a markdown file or create a separate PR. Use the template format from `references/output-templates.md` §5.
7. The comment must summarize delivered scope, deferred scope, technical debt registered, risks, and touched files.
```

## 5. Workflow Acceptance Prompt

```text
Review the workflow "<workflow-name>" for phase "<phase-name>".

Inputs:
- Frozen plan: <path>
- Cases-and-tests document: <path>
- Implementation report: <path>
- Acceptance criteria: <criteria>
- Is this a user-facing workflow: Yes / No

Task:
1. Validate the workflow strictly against the acceptance criteria.
2. If a Spec Compliance Matrix exists in the cases-and-tests document, verify every clause marked "已纳入本工作流" is truly implemented. Any unimplemented mandatory clause is a blocking finding.
3. If this is a user-facing workflow, perform a Usability Minimum Check:
   - For each "用户可完成…" acceptance criterion, provide a test screenshot or manual verification screenshot.
   - Compare the UI against the relevant design spec (as specified in the phase plan).
   - If visual structure, flow logic, or missing states show clear deviations from the spec, mark the criterion as Fail. Passing automated tests does NOT substitute for this check.
4. Review relevant tests, code, and reports.
5. Post the acceptance report as a **comment on the active PR** for this workflow. Do NOT write it to a markdown file or create a separate PR. Use the template format from `references/output-templates.md` §6.
6. The comment must conclude with Pass or Fail and list every blocking issue.

Do not fix the implementation.
```

## 6. Rework Prompt

```text
Rework the workflow "<workflow-name>" for phase "<phase-name>" after a failed acceptance.

Inputs:
- Latest acceptance report: <path>
- Frozen phase plan: <path>
- Cases-and-tests document: <path>

Task:
1. Fix only the issues needed to satisfy the failed acceptance.
2. Preserve prior PR comment reports. Post a new rework/implementation report as a **comment on the active PR**. Do NOT write it to a markdown file or create a separate PR. Use the template format from `references/output-templates.md` §5.
3. The comment must explain what changed and which findings are now resolved.
```

## 7. Final Repair Prompt

```text
Execute a phase-level repair for "<phase-name>" after final acceptance failed.

Inputs:
- Final acceptance report: <path>
- Repair plan: <path>
- Relevant workflow artifacts

Task:
1. Implement the approved repair scope.
2. Update affected tests and docs.
3. Post the repair report as a **comment on the active PR**. Do NOT write it to a markdown file or create a separate PR. Use the template format from `references/output-templates.md` §5.
4. Call out any remaining blockers or risks in the comment.
```

## 8. Spec Deviation Scan Prompt

当某条工作流或总验收被人工审阅驳回时，在创建新补充工作流之前先运行此扫描。

```text
Run a complete spec deviation scan for phase "<phase-name>".

Inputs:
- Current implementation entry points: <list of key source paths>
- Design specs to scan against: <e.g. docs/architecture.md, docs/mvp-contracts.md §8>
- Existing workflow docs: <paths>

Task:
1. For each design spec listed, extract all MUST/SHALL/强制性 clauses.
2. For each clause, inspect the current implementation and determine:
   - Implemented and conforming
   - Implemented but non-conforming (describe the gap)
   - Not implemented
   - Not applicable to current phase scope
3. Produce a deviation matrix table with columns: Clause ID | Spec source | Clause summary | Implementation status | Gap description | Severity (High/Med/Low) | Blocks phase close?
4. Summarize the total count by status.
5. List all High-severity and blocking deviations explicitly in the executive summary.

Do not fix anything. Write the scan report to `docs/phases/<phase-slug>/workflows/<wf>/spec-deviation-scan.md` — this is a design analysis artifact and stays in the repository as a markdown file.
```
