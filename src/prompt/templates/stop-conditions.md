### Stop Conditions

The following conditions must stop execution immediately:

1. **Step Complete**: After writing `report.json`, STOP. Do not begin the next step.
2. **Ambiguous Instructions**: If the step prompt is unclear or contradictory, request clarification via a signal and STOP.
3. **Permission Violation**: If asked to do something outside the allowed actions in the matrix above, report the violation and STOP.
4. **Missing Evidence**: If asked to verify or review but no evidence is provided, note the missing evidence and STOP.
