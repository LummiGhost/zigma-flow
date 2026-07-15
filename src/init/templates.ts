/**
 * Dynamic template generators for zigma-flow init.
 *
 * Only templates that require runtime information (tool version, project
 * detection results) live here. Static default workflow files are standalone
 * files under src/init/default-workflows/ and bundled to dist/default-workflows/.
 *
 * Reference: docs/prd.md §11 (skill pack manifest), §12 (workflow YAML), §16 (data dir).
 */

import { buildInstallCommand, buildScriptCommand } from "./detect.js";
import type { DetectionResult } from "./detect.js";

// ---------------------------------------------------------------------------
// config.json
// ---------------------------------------------------------------------------

export function configJsonTemplate(version: string): string {
  return JSON.stringify(
    {
      tool_version: version,
      agent: {
        backend: "claude-code",
        backends: {
          "claude-code": {
            command: "claude",
            args: ["-p"],
            timeout: 600000
          }
        }
      }
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// workflows/code-change.yml  (detection-parameterised)
// ---------------------------------------------------------------------------

export function codeChangeWorkflowYml(detection?: DetectionResult): string {
  // Determine build parameters from detection (or fallback defaults)
  const hasPackageJson = detection?.hasPackageJson ?? false;
  const pm = detection?.packageManager ?? "pnpm";
  const scripts = detection?.scripts ?? null;

  // Prepare script commands
  const cmd = (name: string) => buildScriptCommand(pm, name);

  // --- Static-check job ---
  let staticCheckRun: string | null;
  if (!hasPackageJson) {
    // Backward-compatible default: pnpm with all scripts
    staticCheckRun = "pnpm typecheck && pnpm lint";
  } else if (scripts!.typecheck && scripts!.lint) {
    staticCheckRun = `${cmd("typecheck")} && ${cmd("lint")}`;
  } else if (scripts!.typecheck) {
    staticCheckRun = cmd("typecheck");
  } else if (scripts!.lint) {
    staticCheckRun = cmd("lint");
  } else {
    staticCheckRun = null; // → agent step
  }

  // --- Unit-test job ---
  let unitTestRun: string | null;
  if (!hasPackageJson) {
    unitTestRun = "pnpm test:ci";
  } else if (scripts!.testCi) {
    unitTestRun = cmd("test:ci");
  } else if (scripts!.test) {
    unitTestRun = cmd("test");
  } else {
    unitTestRun = null; // → agent step
  }

  // --- Build job ---
  const hasBuild = hasPackageJson && scripts!.build;

  // --- Install-deps job (conditional on hasPackageJson) ---
  let installDepsJob = "";
  if (hasPackageJson) {
    const installCmd = buildInstallCommand(pm);
    installDepsJob = `
  install-deps:
    needs:
      - implement
    workspace:
      mode: writable
    steps:
      - id: install
        type: script
        run: "${installCmd}"
        env:
          CI: "true"
        on_failure: fail
`;
  }

  // --- Needs strings (install-deps prepended when applicable) ---
  const staticCheckNeeds = (() => {
    const deps: string[] = hasBuild ? ["build"] : ["implement"];
    if (hasPackageJson) deps.push("install-deps");
    return deps.map(d => `      - ${d}`).join("\n");
  })();

  const unitTestNeeds = (() => {
    const deps: string[] = ["implement"];
    if (hasPackageJson) deps.push("install-deps");
    return deps.map(d => `      - ${d}`).join("\n");
  })();

  // --- Header (through implement job) ---
  const header = `name: code-change
version: 0.6.0

on:
  manual:

inputs:
  task:
    type: string
    required: true

skills:
  code:
    uses: skill://zigma.code-change@1

permissions:
  contents: read
  edits: write
  commands: none
  workflow_state: none

jobs:
  intake:
    workspace:
      mode: read-only
    steps:
      - id: analyze
        type: agent
        prompt: intake
        with:
          task: "\${{ inputs.task }}"
        outputs:
          task_summary: {}
          scope: {}
          complexity_profile: {}
        expose:
          skills:
            - code

  code-map:
    needs:
      - intake
    workspace:
      mode: read-only
    steps:
      - id: map
        type: agent
        prompt: code-map
        with:
          task: "\${{ inputs.task }}"
        outputs:
          existing_files: {}
          new_files: {}
          test_files: {}
          modules: {}
          risk_areas: {}
          rationale: {}
        expose:
          skills:
            - code

  risk-scan:
    needs:
      - code-map
    workspace:
      mode: read-only
    steps:
      - id: validate-report
        type: script
        run: |
          node -e "process.exit(require('fs').existsSync(process.argv[1])?0:1)" -- jobs/code-map/attempts/1/steps/map/report.json
        on_failure: fail
      - id: validate-outputs
        type: script
        run: |
          node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf-8'));const m=['outputs','summary'].filter(f=>!(f in d));if(m.length){console.error('Missing:',m);process.exit(1)}" -- jobs/code-map/attempts/1/steps/map/report.json
        on_failure: fail

  plan:
    needs:
      - risk-scan
    workspace:
      mode: read-only
    steps:
      - id: plan
        type: agent
        prompt: plan
        with:
          task: "\${{ inputs.task }}"
        outputs:
          plan_summary: {}
          steps: {}
          risks: {}
          validation_commands: {}
          contracts_to_preserve: {}
          out_of_scope: {}
        returns:
          status:
            values:
              - ready
              - needs_architecture_design
              - blocked
        on_return:
          needs_architecture_design:
            activate_job: architecture-design
        expose:
          skills:
            - code

  architecture-design:
    activation: optional
    needs:
      - plan
    workspace:
      mode: read-only
    steps:
      - id: design
        type: agent
        prompt: architecture-design
        with:
          task: "\${{ inputs.task }}"
        expose:
          skills:
            - code

  implement:
    needs:
      - plan
      - architecture-design
    retry:
      max_attempts: 3
      on_exceeded:
        status: failed
    steps:
      - id: implement
        type: agent
        prompt: implement
        with:
          task: "\${{ inputs.task }}"
        outputs:
          summary: {}
          files_changed: {}
        expose:
          skills:
            - code
      - id: collect-diff
        type: script
        run: "git diff HEAD"
        env:
          CI: "true"
        on_failure: fail
`;

  // --- Build job (conditional) ---
  let buildJob = "";
  if (hasBuild) {
    buildJob = `
  build:
    needs:
      - implement
    workspace:
      mode: read-only
    steps:
      - id: build
        type: script
        run: "${cmd("build")}"
        env:
          CI: "true"
        on_failure: fail
`;
  }

  // --- Static-check job ---
  let staticCheckJob: string;
  if (staticCheckRun !== null) {
    staticCheckJob = `
  static-check:
    needs:
${staticCheckNeeds}
    workspace:
      mode: read-only
    steps:
      - id: check
        type: script
        run: "${staticCheckRun}"
        env:
          CI: "true"
        on_failure: fail
`;
  } else {
    staticCheckJob = `
  static-check:
    needs:
${staticCheckNeeds}
    workspace:
      mode: read-only
    steps:
      - id: check
        type: agent
        prompt: |
          No static check scripts (typecheck or lint) were found in your
          package.json. Consider adding them to improve code quality.
`;
  }

  // --- Unit-test job ---
  let unitTestJob: string;
  if (unitTestRun !== null) {
    unitTestJob = `
  unit-test:
    needs:
${unitTestNeeds}
    workspace:
      mode: read-only
    steps:
      - id: test
        type: script
        run: "${unitTestRun}"
        env:
          CI: "true"
        on_failure: fail
`;
  } else {
    unitTestJob = `
  unit-test:
    needs:
${unitTestNeeds}
    workspace:
      mode: read-only
    steps:
      - id: test
        type: agent
        prompt: |
          No test scripts (test or test:ci) were found in your package.json.
          Consider adding a test framework to run automated tests.
`;
  }

  // --- Footer (review through summarize) ---
  const footer = `
  review:
    needs:
      - static-check
      - unit-test
    workspace:
      mode: read-only
    steps:
      - id: review
        type: agent
        prompt: review
        with:
          task: "\${{ inputs.task }}"
        outputs:
          verdict: {}
          checked_files: {}
          checked_artifacts: {}
          validation_evidence: {}
          findings: {}
          accepted_risks: {}
          non_blocking_improvements: {}
        returns:
          status:
            values:
              - approved
              - rejected
              - needs_architecture_design
        on_return:
          rejected:
            retry_job: implement
          needs_architecture_design:
            activate_job: architecture-design
        expose:
          skills:
            - code

  gate-merge:
    activation: optional
    needs:
      - review
    steps:
      - id: gate-merge
        type: human
        prompt: |
          Review the implementation summary and approve before merging.
        instructions: |
          Use \`zigma-flow approve --job gate-merge\` to proceed,
          or \`zigma-flow reject --job gate-merge --comment "reason"\` to send back.
        approvers: []
        outputs:
          decision: human.decision
          comment: human.comment

  summarize:
    needs:
      - review
      - gate-merge
    workspace:
      mode: read-only
    steps:
      - id: summarize
        type: agent
        prompt: summarize
        with:
          task: "\${{ inputs.task }}"
        outputs:
          final_summary: {}
          remaining_risks: {}
          summary_artifact: {}
        required_artifacts:
          - summary.md
        expose:
          skills:
            - code
`;

  return header + installDepsJob + buildJob + staticCheckJob + unitTestJob + footer;
}
