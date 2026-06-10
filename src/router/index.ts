/**
 * Router module — public type surface.
 *
 * Reference: docs/phases/p8-router-and-signals/workflows/wf-p8-router/01-cases-and-tests.md §10
 * WF-P8-ROUTER Step 2.
 */

import type { RouterAction } from "../workflow/index.js";

export interface RouterDecision {
  /** The matched case key (e.g. "approved", "rejected", "default"). */
  caseKey: string;
  /** The resolved RouterAction for that case. */
  action: RouterAction;
}

export type { RouterAction };
