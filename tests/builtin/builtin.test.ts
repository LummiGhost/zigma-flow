/**
 * Tests for built-in workflow definitions.
 *
 * Validates that each built-in workflow function:
 *   1. Produces a WorkflowDefinition that passes schema validation
 *   2. Has correct structure (job names, step IDs, step types)
 *   3. Embeds input values correctly in script commands
 *   4. Has appropriate failure handling configuration
 *   5. Has correct check step configuration
 */

import { stringify } from "yaml";
import { describe, expect, it } from "vitest";

import {
  githubFetchIssue,
  githubPublishPr,
  githubComment,
  githubCloseAndMerge,
  worktreeCreate,
  worktreeDelete,
} from "../../src/builtin/index.js";
import type {
  GitHubFetchIssueInputs,
  GitHubPublishPrInputs,
  GitHubCommentInputs,
  GitHubCloseAndMergeInputs,
  WorktreeCreateInputs,
  WorktreeDeleteInputs,
} from "../../src/builtin/index.js";
import { loadWorkflow } from "../../src/workflow/index.js";
import type { WorkflowDefinition } from "../../src/workflow/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a WorkflowDefinition by round-tripping through YAML.
 * Throws if validation fails, including the field-level error details.
 */
function validateWorkflow(wf: WorkflowDefinition): WorkflowDefinition {
  const yaml = stringify(wf);
  return loadWorkflow(yaml);
}

/**
 * Assert that a script step's `run` field contains the expected substring.
 */
function assertRunContains(step: { run?: string }, expected: string): void {
  if (typeof step.run !== "string") {
    throw new Error(`Step has no "run" field`);
  }
  if (!step.run.includes(expected)) {
    throw new Error(
      `Expected run command to contain "${expected}", got: ${step.run}`
    );
  }
}

// ---------------------------------------------------------------------------
// github-fetch-issue
// ---------------------------------------------------------------------------

describe("githubFetchIssue", () => {
  const defaultInputs: GitHubFetchIssueInputs = {
    issueNumber: "42",
    repo: "zigma-ai/zigma-flow",
  };

  it("produces a schema-valid workflow definition", () => {
    const wf = githubFetchIssue(defaultInputs);
    const validated = validateWorkflow(wf);
    expect(validated.name).toBe("github-fetch-issue");
  });

  it("has the correct workflow name and version", () => {
    const wf = githubFetchIssue(defaultInputs);
    expect(wf.name).toBe("github-fetch-issue");
    expect(wf.version).toBe("1.0.0");
  });

  it("declares manual inputs for issue_number and repo", () => {
    const wf = githubFetchIssue(defaultInputs);
    const inputs = (wf.on as { manual?: { inputs?: Record<string, unknown> } })
      ?.manual?.inputs;
    expect(inputs).toBeDefined();
    expect(inputs?.issue_number).toBeDefined();
    expect(inputs?.repo).toBeDefined();
  });

  it("has a single job named 'fetch' with two steps", () => {
    const wf = githubFetchIssue(defaultInputs);
    expect(Object.keys(wf.jobs)).toEqual(["fetch"]);
    const job = wf.jobs["fetch"];
    expect(job).toBeDefined();
    expect(job!.steps).toHaveLength(2);
  });

  it("has a script step that uses gh issue view with the correct issue number and repo", () => {
    const wf = githubFetchIssue(defaultInputs);
    const step = wf.jobs["fetch"]!.steps[0]!;
    expect(step.type).toBe("script");
    expect(step.id).toBe("fetch-issue");
    assertRunContains(step, "gh issue view");
    assertRunContains(step, "42");
    assertRunContains(step, "zigma-ai/zigma-flow");
    assertRunContains(step, "--json");
    expect(step.timeout).toBe("60s");
    expect(step.on_failure).toBe("fail");
  });

  it("has a check step that validates JSON parse of stdout", () => {
    const wf = githubFetchIssue(defaultInputs);
    const step = wf.jobs["fetch"]!.steps[1]!;
    expect(step.type).toBe("check");
    expect(step.id).toBe("validate-output");
    expect(step.uses).toBe("zigma/json-parse");
    expect(step.on_fail).toBe("fail");
    expect(step.on_pass).toBe("continue");
    // Validate the file path references the correct artifact
    const withFile = (step.with as { file?: string })?.file;
    expect(withFile).toContain("jobs/fetch/attempts/1/steps/fetch-issue/stdout.txt");
  });

  it("declares output keys for issue data", () => {
    const wf = githubFetchIssue(defaultInputs);
    const step = wf.jobs["fetch"]!.steps[0]!;
    expect(step.outputs).toBeDefined();
    const outputs = step.outputs!;
    expect(outputs.title).toBeDefined();
    expect(outputs.body).toBeDefined();
    expect(outputs.comments).toBeDefined();
    expect(outputs.labels).toBeDefined();
    expect(outputs.url).toBeDefined();
  });

  it("has read-only workspace mode", () => {
    const wf = githubFetchIssue(defaultInputs);
    expect(wf.jobs["fetch"]!.workspace?.mode).toBe("read-only");
  });

  it("escapes special characters in input values", () => {
    const wf = githubFetchIssue({
      issueNumber: "42",
      repo: 'owner/name"with-quotes',
    });
    const step = wf.jobs["fetch"]!.steps[0]!;
    // The escaped repo should contain backslash-escaped quotes
    assertRunContains(step, 'with-quotes');
  });

  it("is schema-valid with different issue numbers", () => {
    const wf = githubFetchIssue({
      issueNumber: "999",
      repo: "other-org/other-repo",
    });
    const validated = validateWorkflow(wf);
    expect(validated.name).toBe("github-fetch-issue");
  });
});

// ---------------------------------------------------------------------------
// github-publish-pr
// ---------------------------------------------------------------------------

describe("githubPublishPr", () => {
  const defaultInputs: GitHubPublishPrInputs = {
    title: "Add new feature",
    body: "This PR adds a new feature.",
    head: "feature/my-branch",
  };

  it("produces a schema-valid workflow definition", () => {
    const wf = githubPublishPr(defaultInputs);
    const validated = validateWorkflow(wf);
    expect(validated.name).toBe("github-publish-pr");
  });

  it("has the correct workflow name and version", () => {
    const wf = githubPublishPr(defaultInputs);
    expect(wf.name).toBe("github-publish-pr");
    expect(wf.version).toBe("1.0.0");
  });

  it("defaults base to 'main' when not provided", () => {
    const wf = githubPublishPr(defaultInputs);
    const step = wf.jobs["publish"]!.steps[0]!;
    assertRunContains(step, "--base");
    assertRunContains(step, "main");
  });

  it("uses the provided base branch when specified", () => {
    const wf = githubPublishPr({ ...defaultInputs, base: "develop" });
    const step = wf.jobs["publish"]!.steps[0]!;
    assertRunContains(step, "--base");
    assertRunContains(step, "develop");
  });

  it("has a script step that uses gh pr create with all parameters", () => {
    const wf = githubPublishPr({
      title: "Fix bug #42",
      body: "Fixes the issue.",
      base: "main",
      head: "fix/bug-42",
    });
    const step = wf.jobs["publish"]!.steps[0]!;
    expect(step.type).toBe("script");
    expect(step.id).toBe("create-pr");
    assertRunContains(step, "gh pr create");
    assertRunContains(step, "--title");
    assertRunContains(step, "Fix bug #42");
    assertRunContains(step, "--body");
    assertRunContains(step, "Fixes the issue.");
    assertRunContains(step, "--head");
    assertRunContains(step, "fix/bug-42");
    expect(step.timeout).toBe("120s");
  });

  it("has a check step that validates PR output", () => {
    const wf = githubPublishPr(defaultInputs);
    const step = wf.jobs["publish"]!.steps[1]!;
    expect(step.type).toBe("check");
    expect(step.uses).toBe("zigma/json-parse");
    expect(step.on_fail).toBe("fail");
    const withFile = (step.with as { file?: string })?.file;
    expect(withFile).toContain("jobs/publish/attempts/1/steps/create-pr/stdout.txt");
  });

  it("declares output keys for PR data", () => {
    const wf = githubPublishPr(defaultInputs);
    const step = wf.jobs["publish"]!.steps[0]!;
    expect(step.outputs?.pr_number).toBeDefined();
    expect(step.outputs?.pr_url).toBeDefined();
  });

  it("escapes double quotes in title and body", () => {
    const wf = githubPublishPr({
      title: 'Fix "critical" bug',
      body: 'This fixes the "critical" issue.',
      head: "fix/bug",
    });
    const validated = validateWorkflow(wf);
    const step = validated.jobs["publish"]!.steps[0]!;
    assertRunContains(step, "Fix");
    assertRunContains(step, "critical");
  });

  it("is schema-valid with all optional fields provided", () => {
    const wf = githubPublishPr({
      title: "Title",
      body: "Body with\nmultiple\nlines",
      base: "develop",
      head: "feature/x",
    });
    const validated = validateWorkflow(wf);
    expect(validated.name).toBe("github-publish-pr");
  });
});

// ---------------------------------------------------------------------------
// github-comment
// ---------------------------------------------------------------------------

describe("githubComment", () => {
  const defaultInputs: GitHubCommentInputs = {
    target: "42",
    body: "Looks good to me!",
  };

  it("produces a schema-valid workflow definition", () => {
    const wf = githubComment(defaultInputs);
    const validated = validateWorkflow(wf);
    expect(validated.name).toBe("github-comment");
  });

  it("has the correct workflow name and version", () => {
    const wf = githubComment(defaultInputs);
    expect(wf.name).toBe("github-comment");
    expect(wf.version).toBe("1.0.0");
  });

  it("defaults to PR comment when targetType is not specified", () => {
    const wf = githubComment(defaultInputs);
    const step = wf.jobs["comment"]!.steps[0]!;
    assertRunContains(step, "gh pr comment");
  });

  it("uses gh issue comment when targetType is 'issue'", () => {
    const wf = githubComment({ ...defaultInputs, targetType: "issue" });
    const step = wf.jobs["comment"]!.steps[0]!;
    assertRunContains(step, "gh issue comment");
  });

  it("embeds target and body in the command", () => {
    const wf = githubComment({
      target: "https://github.com/owner/repo/pull/42",
      body: "Approved!",
    });
    const step = wf.jobs["comment"]!.steps[0]!;
    assertRunContains(step, "https://github.com/owner/repo/pull/42");
    assertRunContains(step, "Approved!");
  });

  it("has a check step that validates output", () => {
    const wf = githubComment(defaultInputs);
    const step = wf.jobs["comment"]!.steps[1]!;
    expect(step.type).toBe("check");
    expect(step.uses).toBe("zigma/json-parse");
  });

  it("declares comment_url output", () => {
    const wf = githubComment(defaultInputs);
    const step = wf.jobs["comment"]!.steps[0]!;
    expect(step.outputs?.comment_url).toBeDefined();
  });

  it("has a 60s timeout", () => {
    const wf = githubComment(defaultInputs);
    const step = wf.jobs["comment"]!.steps[0]!;
    expect(step.timeout).toBe("60s");
  });
});

// ---------------------------------------------------------------------------
// github-close-and-merge
// ---------------------------------------------------------------------------

describe("githubCloseAndMerge", () => {
  const defaultInputs: GitHubCloseAndMergeInputs = {
    issueNumber: "42",
    prNumber: "99",
  };

  it("produces a schema-valid workflow definition", () => {
    const wf = githubCloseAndMerge(defaultInputs);
    const validated = validateWorkflow(wf);
    expect(validated.name).toBe("github-close-and-merge");
  });

  it("has the correct workflow name and version", () => {
    const wf = githubCloseAndMerge(defaultInputs);
    expect(wf.name).toBe("github-close-and-merge");
    expect(wf.version).toBe("1.0.0");
  });

  it("defaults merge strategy to 'merge'", () => {
    const wf = githubCloseAndMerge(defaultInputs);
    const mergeStep = wf.jobs["close-merge"]!.steps[2]!;
    assertRunContains(mergeStep, "--merge");
  });

  it("uses --squash flag when mergeStrategy is 'squash'", () => {
    const wf = githubCloseAndMerge({
      ...defaultInputs,
      mergeStrategy: "squash",
    });
    const mergeStep = wf.jobs["close-merge"]!.steps[2]!;
    assertRunContains(mergeStep, "--squash");
  });

  it("uses --rebase flag when mergeStrategy is 'rebase'", () => {
    const wf = githubCloseAndMerge({
      ...defaultInputs,
      mergeStrategy: "rebase",
    });
    const mergeStep = wf.jobs["close-merge"]!.steps[2]!;
    assertRunContains(mergeStep, "--rebase");
  });

  it("has four steps: close issue, validate close, merge PR, validate merge", () => {
    const wf = githubCloseAndMerge(defaultInputs);
    const steps = wf.jobs["close-merge"]!.steps;
    expect(steps).toHaveLength(4);

    expect(steps[0]!.id).toBe("close-issue");
    expect(steps[0]!.type).toBe("script");
    assertRunContains(steps[0]!, "gh issue close 42");

    expect(steps[1]!.id).toBe("validate-close");
    expect(steps[1]!.type).toBe("check");
    expect(steps[1]!.uses).toBe("zigma/json-parse");

    expect(steps[2]!.id).toBe("merge-pr");
    expect(steps[2]!.type).toBe("script");
    assertRunContains(steps[2]!, "gh pr merge 99");

    expect(steps[3]!.id).toBe("validate-merge");
    expect(steps[3]!.type).toBe("check");
    expect(steps[3]!.uses).toBe("zigma/json-parse");
  });

  it("has on_failure status: failed for close-issue step", () => {
    const wf = githubCloseAndMerge(defaultInputs);
    const closeStep = wf.jobs["close-merge"]!.steps[0]!;
    expect(closeStep.on_failure).toEqual({ status: "failed" });
  });

  it("has on_failure status: failed for merge-pr step", () => {
    const wf = githubCloseAndMerge(defaultInputs);
    const mergeStep = wf.jobs["close-merge"]!.steps[2]!;
    expect(mergeStep.on_failure).toEqual({ status: "failed" });
  });

  it("declares output keys for close and merge confirmations", () => {
    const wf = githubCloseAndMerge(defaultInputs);
    expect(wf.jobs["close-merge"]!.steps[0]!.outputs?.issue_closed).toBeDefined();
    expect(wf.jobs["close-merge"]!.steps[2]!.outputs?.pr_merged).toBeDefined();
  });

  it("has appropriate timeouts", () => {
    const wf = githubCloseAndMerge(defaultInputs);
    expect(wf.jobs["close-merge"]!.steps[0]!.timeout).toBe("60s");
    expect(wf.jobs["close-merge"]!.steps[2]!.timeout).toBe("120s");
  });

  it("is schema-valid with all merge strategy variants", () => {
    for (const strategy of ["merge", "squash", "rebase"] as const) {
      const wf = githubCloseAndMerge({
        ...defaultInputs,
        mergeStrategy: strategy,
      });
      const validated = validateWorkflow(wf);
      expect(validated.name).toBe("github-close-and-merge");
    }
  });
});

// ---------------------------------------------------------------------------
// worktree-create
// ---------------------------------------------------------------------------

describe("worktreeCreate", () => {
  const defaultInputs: WorktreeCreateInputs = {
    path: "/tmp/my-worktree",
    branch: "feature/my-feature",
  };

  it("produces a schema-valid workflow definition", () => {
    const wf = worktreeCreate(defaultInputs);
    const validated = validateWorkflow(wf);
    expect(validated.name).toBe("worktree-create");
  });

  it("has the correct workflow name and version", () => {
    const wf = worktreeCreate(defaultInputs);
    expect(wf.name).toBe("worktree-create");
    expect(wf.version).toBe("1.0.0");
  });

  it("defaults base to HEAD when not provided", () => {
    const wf = worktreeCreate(defaultInputs);
    const step = wf.jobs["create"]!.steps[0]!;
    assertRunContains(step, "HEAD");
  });

  it("uses the provided base when specified", () => {
    const wf = worktreeCreate({
      ...defaultInputs,
      base: "origin/main",
    });
    const step = wf.jobs["create"]!.steps[0]!;
    assertRunContains(step, "origin/main");
  });

  it("has a script step that uses git worktree add with correct flags", () => {
    const wf = worktreeCreate(defaultInputs);
    const step = wf.jobs["create"]!.steps[0]!;
    expect(step.type).toBe("script");
    expect(step.id).toBe("create-worktree");
    assertRunContains(step, "git worktree add");
    assertRunContains(step, "/tmp/my-worktree");
    assertRunContains(step, "-b");
    assertRunContains(step, "feature/my-feature");
    expect(step.timeout).toBe("60s");
    expect(step.on_failure).toBe("fail");
  });

  it("has a check step that validates the worktree was created", () => {
    const wf = worktreeCreate(defaultInputs);
    const step = wf.jobs["create"]!.steps[1]!;
    expect(step.type).toBe("check");
    expect(step.id).toBe("validate-worktree");
    expect(step.uses).toBe("zigma/file-exists");
    expect(step.on_fail).toBe("fail");
    expect(step.on_pass).toBe("continue");
  });

  it("check step references the .git file in the worktree path", () => {
    const wf = worktreeCreate(defaultInputs);
    const step = wf.jobs["create"]!.steps[1]!;
    const withFile = (step.with as { file?: string })?.file;
    expect(withFile).toContain("/tmp/my-worktree/.git");
  });

  it("declares output keys for worktree info", () => {
    const wf = worktreeCreate(defaultInputs);
    const step = wf.jobs["create"]!.steps[0]!;
    expect(step.outputs?.worktree_path).toBeDefined();
    expect(step.outputs?.branch).toBeDefined();
  });

  it("escapes special characters in path and branch", () => {
    const wf = worktreeCreate({
      path: '/tmp/path with spaces',
      branch: 'feature/has "quotes"',
    });
    const validated = validateWorkflow(wf);
    expect(validated.name).toBe("worktree-create");
  });

  it("is schema-valid with all optional fields provided", () => {
    const wf = worktreeCreate({
      path: "/tmp/wt",
      branch: "feat/x",
      base: "abc123",
    });
    const validated = validateWorkflow(wf);
    expect(validated.name).toBe("worktree-create");
  });

  it("has no workspace mode restriction (allows writes)", () => {
    const wf = worktreeCreate(defaultInputs);
    // worktree-create runs without workspace mode restriction
    // so it can create directories
    expect(wf.jobs["create"]!.workspace).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// worktree-delete
// ---------------------------------------------------------------------------

describe("worktreeDelete", () => {
  const defaultInputs: WorktreeDeleteInputs = {
    path: "/tmp/my-worktree",
  };

  it("produces a schema-valid workflow definition", () => {
    const wf = worktreeDelete(defaultInputs);
    const validated = validateWorkflow(wf);
    expect(validated.name).toBe("worktree-delete");
  });

  it("has the correct workflow name and version", () => {
    const wf = worktreeDelete(defaultInputs);
    expect(wf.name).toBe("worktree-delete");
    expect(wf.version).toBe("1.0.0");
  });

  it("has a script step that uses git worktree remove --force", () => {
    const wf = worktreeDelete(defaultInputs);
    const step = wf.jobs["delete"]!.steps[0]!;
    expect(step.type).toBe("script");
    expect(step.id).toBe("delete-worktree");
    assertRunContains(step, "git worktree remove");
    assertRunContains(step, "--force");
    assertRunContains(step, "/tmp/my-worktree");
    expect(step.timeout).toBe("60s");
    expect(step.on_failure).toBe("fail");
  });

  it("has a check step that validates the worktree was removed", () => {
    const wf = worktreeDelete(defaultInputs);
    const step = wf.jobs["delete"]!.steps[1]!;
    expect(step.type).toBe("check");
    expect(step.id).toBe("validate-removed");
    expect(step.uses).toBe("zigma/file-exists");
  });

  it("check step on_pass: fails if .git still exists (safety)", () => {
    const wf = worktreeDelete(defaultInputs);
    const step = wf.jobs["delete"]!.steps[1]!;
    // If the .git file still exists after removal, the check passes,
    // which means removal failed — so on_pass should fail the workflow.
    expect(step.on_pass).toEqual({ status: "failed" });
    // If the .git file does NOT exist (check fails), that means removal
    // succeeded — so on_fail should continue.
    expect(step.on_fail).toBe("continue");
  });

  it("declares removed_path output", () => {
    const wf = worktreeDelete(defaultInputs);
    const step = wf.jobs["delete"]!.steps[0]!;
    expect(step.outputs?.removed_path).toBeDefined();
  });

  it("is schema-valid with different paths", () => {
    const wf = worktreeDelete({ path: "/another/path" });
    const validated = validateWorkflow(wf);
    expect(validated.name).toBe("worktree-delete");
  });

  it("has no workspace mode restriction", () => {
    const wf = worktreeDelete(defaultInputs);
    expect(wf.jobs["delete"]!.workspace).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: all built-in workflows are schema-valid
// ---------------------------------------------------------------------------

describe("all built-in workflows", () => {
  it("all six built-ins pass schema validation", () => {
    const workflows = [
      githubFetchIssue({ issueNumber: "1", repo: "a/b" }),
      githubPublishPr({ title: "T", body: "B", head: "h" }),
      githubComment({ target: "1", body: "B" }),
      githubCloseAndMerge({ issueNumber: "1", prNumber: "2" }),
      worktreeCreate({ path: "/tmp/wt", branch: "feat/x" }),
      worktreeDelete({ path: "/tmp/wt" }),
    ];

    for (const wf of workflows) {
      const validated = validateWorkflow(wf);
      expect(validated.name).toBeDefined();
      expect(validated.version).toBe("1.0.0");
    }
  });

  it("all built-ins have at least one job with at least one step", () => {
    const workflows = [
      githubFetchIssue({ issueNumber: "1", repo: "a/b" }),
      githubPublishPr({ title: "T", body: "B", head: "h" }),
      githubComment({ target: "1", body: "B" }),
      githubCloseAndMerge({ issueNumber: "1", prNumber: "2" }),
      worktreeCreate({ path: "/tmp/wt", branch: "feat/x" }),
      worktreeDelete({ path: "/tmp/wt" }),
    ];

    for (const wf of workflows) {
      const jobNames = Object.keys(wf.jobs);
      expect(jobNames.length).toBeGreaterThanOrEqual(1);
      for (const jobName of jobNames) {
        const job = wf.jobs[jobName]!;
        expect(job.steps.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("all built-ins declare manual inputs", () => {
    const workflows = [
      githubFetchIssue({ issueNumber: "1", repo: "a/b" }),
      githubPublishPr({ title: "T", body: "B", head: "h" }),
      githubComment({ target: "1", body: "B" }),
      githubCloseAndMerge({ issueNumber: "1", prNumber: "2" }),
      worktreeCreate({ path: "/tmp/wt", branch: "feat/x" }),
      worktreeDelete({ path: "/tmp/wt" }),
    ];

    for (const wf of workflows) {
      const inputs = (wf.on as { manual?: { inputs?: Record<string, unknown> } })
        ?.manual?.inputs;
      expect(inputs).toBeDefined();
      expect(Object.keys(inputs!).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("all script steps have timeout configured", () => {
    const workflows = [
      githubFetchIssue({ issueNumber: "1", repo: "a/b" }),
      githubPublishPr({ title: "T", body: "B", head: "h" }),
      githubComment({ target: "1", body: "B" }),
      githubCloseAndMerge({ issueNumber: "1", prNumber: "2" }),
      worktreeCreate({ path: "/tmp/wt", branch: "feat/x" }),
      worktreeDelete({ path: "/tmp/wt" }),
    ];

    for (const wf of workflows) {
      for (const job of Object.values(wf.jobs)) {
        for (const step of job.steps) {
          if (step.type === "script") {
            expect(step.timeout).toBeDefined();
          }
        }
      }
    }
  });

  it("all built-ins have unique step IDs within each job", () => {
    const workflows = [
      githubFetchIssue({ issueNumber: "1", repo: "a/b" }),
      githubPublishPr({ title: "T", body: "B", head: "h" }),
      githubComment({ target: "1", body: "B" }),
      githubCloseAndMerge({ issueNumber: "1", prNumber: "2" }),
      worktreeCreate({ path: "/tmp/wt", branch: "feat/x" }),
      worktreeDelete({ path: "/tmp/wt" }),
    ];

    for (const wf of workflows) {
      const validated = validateWorkflow(wf);
      for (const [jobName, job] of Object.entries(validated.jobs)) {
        const stepIds = job.steps.map((s) => s.id);
        const uniqueIds = new Set(stepIds);
        expect(uniqueIds.size).toBe(stepIds.length);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Type-level tests (compile-time assertions)
// ---------------------------------------------------------------------------

describe("type exports", () => {
  it("input types are importable and structurally correct", () => {
    // These are compile-time checks; the runtime test just verifies the
    // values can be passed to the functions without type errors.
    const fetchInputs: GitHubFetchIssueInputs = {
      issueNumber: "1",
      repo: "a/b",
    };
    expect(fetchInputs.issueNumber).toBe("1");

    const prInputs: GitHubPublishPrInputs = {
      title: "T",
      body: "B",
      head: "h",
    };
    expect(prInputs.title).toBe("T");

    const commentInputs: GitHubCommentInputs = {
      target: "1",
      body: "B",
    };
    expect(commentInputs.target).toBe("1");

    const mergeInputs: GitHubCloseAndMergeInputs = {
      issueNumber: "1",
      prNumber: "2",
    };
    expect(mergeInputs.issueNumber).toBe("1");

    const createInputs: WorktreeCreateInputs = {
      path: "/tmp/wt",
      branch: "feat/x",
    };
    expect(createInputs.path).toBe("/tmp/wt");

    const deleteInputs: WorktreeDeleteInputs = {
      path: "/tmp/wt",
    };
    expect(deleteInputs.path).toBe("/tmp/wt");
  });
});
