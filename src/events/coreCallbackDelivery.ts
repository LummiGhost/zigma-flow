import type { FlowCoreCallbackEnvelopeV1 } from "./platformEvent.js";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type CallbackFetch = typeof fetch;

export interface CoreCallbackDeliveryOptions {
  fetcher?: CallbackFetch;
  attempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

interface CoreCallbackCursorV1 {
  contractVersion: 1;
  callbackCorrelationId: string;
  lastEventId: string;
  lastSequence: number;
}

const CURSOR_FILE = "core-callback-delivery.json";

export async function readCoreCallbackCursor(runDir: string, callbackCorrelationId: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(join(runDir, CURSOR_FILE), "utf-8")) as Partial<CoreCallbackCursorV1>;
    if (parsed.contractVersion !== 1 || parsed.callbackCorrelationId !== callbackCorrelationId
      || !Number.isInteger(parsed.lastSequence) || (parsed.lastSequence ?? -1) < 0) {
      throw new Error("Core callback delivery cursor is invalid or belongs to another correlation identity");
    }
    return parsed.lastSequence!;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }
}

export async function writeCoreCallbackCursor(
  runDir: string,
  envelope: FlowCoreCallbackEnvelopeV1,
): Promise<void> {
  const path = join(runDir, CURSOR_FILE);
  const temporaryPath = `${path}.tmp-${process.pid}`;
  const cursor: CoreCallbackCursorV1 = {
    contractVersion: 1,
    callbackCorrelationId: envelope.callbackCorrelationId,
    lastEventId: envelope.eventId,
    lastSequence: envelope.sequence,
  };
  await writeFile(temporaryPath, `${JSON.stringify(cursor)}\n`, "utf-8");
  await rename(temporaryPath, path);
}

export function coreCallbackEndpoint(coreCallbackUrl: string, flowRunId: string): string {
  const base = new URL(coreCallbackUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new TypeError("coreCallbackUrl must use http or https");
  }
  if (base.username || base.password) {
    throw new TypeError("coreCallbackUrl must not contain credentials");
  }
  const basePath = base.pathname.replace(/\/$/, "");
  base.pathname = `${basePath}/flow-runs/${encodeURIComponent(flowRunId)}/events`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

export async function deliverCoreCallback(
  coreCallbackUrl: string,
  envelope: FlowCoreCallbackEnvelopeV1,
  options: CoreCallbackDeliveryOptions = {},
): Promise<void> {
  const endpoint = coreCallbackEndpoint(coreCallbackUrl, envelope.flowRunId);
  const fetcher = options.fetcher ?? fetch;
  const attempts = Math.max(1, options.attempts ?? 3);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 100);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return;
      const bodyText = await response.text().catch(() => "");
      lastError = new Error(
        `Core callback returned HTTP ${response.status}${bodyText.trim() !== "" ? `: ${bodyText.trim().slice(0, 1_000)}` : ""}`,
      );
    } catch (error: unknown) {
      lastError = error;
    }

    if (attempt < attempts && retryDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }

  throw new Error(
    `Core callback delivery failed after ${attempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError },
  );
}
