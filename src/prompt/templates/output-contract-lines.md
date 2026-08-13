The Engine supplies the workflow-derived output schema directly to the Agent CLI
and writes the structured response to:

  `{{reportPath}}`

This is the canonical step artifact path. Writing to another location will cause the Engine to reject the report.
This is a runtime artifact file. The Engine owns all state transitions.

### Required Outputs

{{requiredOutputsLines}}

### Required Artifacts

{{requiredArtifactsLines}}

### Allowed Signals

{{allowedSignalsLines}}{{signalTableSection}}
### Artifact Rules

{{artifactRulesLines}}
{{outputsSchemaSection}}{{artifactPolicySection}}{{signalPolicySection}}{{returnStatusSection}}{{artifactReferenceSchemaSection}}
### Report Schema

The native Agent CLI schema enforces `report.json` with these required top-level fields:

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
