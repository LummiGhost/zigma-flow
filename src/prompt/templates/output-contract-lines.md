Write your report to:

  `{{reportPath}}`

This is the canonical step artifact path. Writing to any other location will cause the Engine to reject the report.
This is a runtime artifact file. Writing it does not modify workflow state or repository code; the Engine reads it and owns all state transitions.

### Required Outputs

{{requiredOutputsLines}}

### Required Artifacts

{{requiredArtifactsLines}}

### Allowed Signals

{{allowedSignalsLines}}

### Artifact Rules

{{artifactRulesLines}}
{{outputsSchemaSection}}{{artifactPolicySection}}{{signalPolicySection}}
### Report Schema

The file must be valid JSON with exactly these required top-level fields:

```json
{
  "outputs": {},
  "artifacts": [],
  "signals": [],
  "summary": ""
}
```

- `"outputs"`: current step output values.
- `"artifacts"`: artifact references for large outputs.
- `"signals"`: structured workflow-change requests from the allowed list above.
- `"summary"`: short execution summary.

{{stopRequirement}}
