---
name: software-project-retrospective
description: Run a structured retrospective for software R&D projects. Analyze goals, timeline, decisions, assumptions, bottlenecks, root causes, and improvement actions, then produce an evidence-based review.
argument-hint: [project_or_scope] [optional focus: delivery | quality | architecture | collaboration | process | incident]
---

# Software Project Retrospective

Use this skill when the user wants to review a completed or partially completed software project, milestone, sprint, release, incident, refactor, migration, or feature-delivery effort. This skill is for extracting lessons, finding root causes, evaluating decisions, and converting hindsight into concrete operating improvements.

## Objectives

Produce a retrospective that is:
1. Outcome-aware: compare actual results with original goals.
2. Evidence-based: prefer artifacts, commits, tickets, PRs, incidents, metrics, and dated decisions over vague memory.
3. Causally useful: separate symptoms, direct causes, contributing factors, and systemic causes.
4. Actionable: end with prioritized improvements, owners, and guardrails.
5. Reusable: generate outputs that can be pasted into docs, issue trackers, or follow-up planning.

## Core model

Integrate these lenses in this order:

1. Goal gap
   - What was the intended outcome?
   - What actually happened?
   - Which gaps matter most?

2. Timeline reconstruction
   - Rebuild key phases, decisions, incidents, delays, and turning points in chronological order.
   - Highlight when risk first became visible, not only when failure surfaced.

3. Decision review
   - Identify major choices in scope, architecture, staffing, sequencing, tooling, and release strategy.
   - For each, capture context, alternatives considered, rationale, and downstream effects.

4. Assumption audit
   - List assumptions that were implicitly or explicitly relied upon.
   - Mark each as validated, invalidated, partially true, or never tested.

5. Root cause drilling
   - For major failures or misses, use repeated why-analysis until reaching a process, design, communication, or system cause that can actually be changed.

6. System view
   - Check five dimensions: people, process, tools, information, organization.
   - Avoid reducing everything to individual performance.

7. Bottleneck analysis
   - Identify the dominant constraint at each major phase.
   - Distinguish the real constraint from noisy local inefficiencies.

8. Counterfactual review
   - Ask what would likely have changed if one key decision, assumption, or sequencing choice had been different.
   - Keep this disciplined and specific.

9. Signal review
   - Separate lagging indicators from leading indicators.
   - Determine which earlier signals should be monitored next time.

## Evidence collection order

Start from the strongest available evidence:
1. Project brief, spec, ADRs, RFCs, milestone definitions.
2. Issue tracker, task board, estimates, scope changes.
3. Git history, PRs, code review comments, release tags.
4. CI results, test failures, incident reports, telemetry, performance regressions.
5. Chat logs, meeting notes, informal discussion.
6. Participant recollection.

If evidence is missing, say so clearly and reduce confidence.

## Workflow

### Step 1: Define review scope
Establish:
- project name or milestone
- time range
- intended goals
- success criteria
- review depth
- focus area if the user has one

If the user gives no focus, default to a balanced review across delivery, quality, architecture, and collaboration.

### Step 2: Build an outcome summary
Produce a compact summary with:
- target outcomes
- actual outcomes
- delivery status
- quality status
- cost or effort status if known
- business or technical impact

### Step 3: Reconstruct the timeline
Create a chronological table with columns:
- date or phase
- event
- significance
- immediate consequence
- missed warning sign if any

### Step 4: Extract key decisions and assumptions
For each important decision, record:
- decision
- why it was made
- alternatives
- expected upside
- actual outcome
- retrospective judgment

For assumptions, record:
- assumption
- owner if inferable
- evidence status
- effect when wrong

### Step 5: Analyze failures, misses, and wins
Review both negative and positive deviations.
For each major miss:
- symptom
- direct cause
- contributing factors
- systemic cause
- prevention or mitigation

For each major win:
- why it worked
- whether it was repeatable
- what should be standardized

### Step 6: Map findings to system dimensions
Classify findings under:
- People
- Process
- Tools
- Information
- Organization

Also mark whether each finding is local or systemic.

### Step 7: Identify bottlenecks and early signals
Answer:
- What constrained throughput or quality the most?
- When did the constraint shift?
- Which leading indicators would have exposed the issue earlier?

### Step 8: Produce action plan
Convert findings into actions with this priority order:
1. Risk reduction
2. Throughput improvement
3. Quality improvement
4. Knowledge capture

Each action must include:
- action
- intended benefit
- priority: P0 / P1 / P2
- owner role
- trigger or deadline
- success metric

## Output format

Always produce these sections unless the user requests a shorter answer:

1. Executive summary
2. Project scorecard
3. Timeline of critical events
4. Key decisions review
5. Assumption audit
6. Root causes and systemic findings
7. Wins worth preserving
8. Bottlenecks and early warning signals
9. Action plan
10. Lessons to carry forward
11. Confidence and missing evidence

## Scoring rubric

When appropriate, score each area from 1 to 5 with short justification:
- Goal clarity
- Scope control
- Architecture fitness
- Delivery predictability
- Quality assurance
- Cross-functional communication
- Tooling and automation
- Risk management
- Learning capture

Do not average scores unless the user explicitly asks for a single numeric score.

## Review standards

Follow these rules:
- Prefer dated artifacts over memory.
- Distinguish facts, interpretations, and hypotheses.
- Call out uncertainty explicitly.
- Do not treat schedule slip alone as failure if scope or quality improved for good reason.
- Do not confuse successful firefighting with good planning.
- Do not blame individuals when the mechanism failed.
- Preserve strong practices, not only fixes.
- Keep recommendations few, specific, and enforceable.

## Heuristics by project type

### Feature delivery
Focus on scope control, requirement volatility, integration readiness, QA timing, and release strategy.

### Architecture or refactor
Focus on technical debt assumptions, migration sequencing, compatibility, rollback, and hidden coupling.

### Incident or outage
Focus on detection, blast radius, on-call readiness, observability, decision latency, and prevention layers.

### Platform or infrastructure
Focus on reliability, operability, internal adoption, documentation, and long-tail maintenance cost.

## Suggested prompts this skill handles well
- Review this release retrospectively using our PRs, issues, and incidents.
- Help me retro this sprint and tell me the real bottleneck.
- Analyze why this migration missed schedule and which assumptions failed.
- Run a blameless postmortem on this production issue.
- Summarize what this team should preserve, stop, and start doing.

## Default response behavior

When running this skill:
1. First summarize the review scope and available evidence.
2. Then reconstruct facts before judging.
3. Separate wins from failures.
4. End with a small number of concrete next actions.
5. If evidence is thin, provide a provisional retrospective and label it clearly.

## Compact mode

If the user asks for a brief output, compress the response into:
- one-paragraph summary
- top 5 findings
- top 3 actions
- missing evidence

## Final reminder

The purpose of this skill is organizational learning and better future execution. It should produce sharper judgment, earlier detection, and stronger operating mechanisms.
