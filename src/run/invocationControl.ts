/**
 * Cross-process invocation cancellation control.
 *
 * The owning `invoke` process advertises a loopback TCP endpoint in the run
 * directory. A separate `abort` CLI connects to that endpoint, requests
 * cancellation, and waits on the same socket until the owner has reaped child
 * processes and drained its writers. The control file is discovery metadata;
 * run state and events remain the authoritative workflow record.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import { FilesystemError, StateError } from "../utils/index.js";

const CONTROL_VERSION = 1;
const CONTROL_DIRECTORY = ".control";
const OWNER_FILENAME = "invoke-owner.json";
const LOOPBACK_HOST = "127.0.0.1";

interface ActiveInvocationRecord {
  version: typeof CONTROL_VERSION;
  phase: "active";
  runId: string;
  invocationId: string;
  pid: number;
  host: typeof LOOPBACK_HOST;
  port: number;
  token: string;
  startedAt: string;
}

interface QuiescentInvocationRecord {
  version: typeof CONTROL_VERSION;
  phase: "quiescent";
  runId: string;
  invocationId: string;
  pid: number;
  host: typeof LOOPBACK_HOST;
  port: number;
  token: string;
  startedAt: string;
  finishedAt: string;
  status: string;
  quiescent: boolean;
  cleanupErrors: string[];
}

type InvocationRecord = ActiveInvocationRecord | QuiescentInvocationRecord;

interface CancellationRequest {
  version: typeof CONTROL_VERSION;
  type: "cancel";
  requestId: string;
  runId: string;
  invocationId: string;
  token: string;
  reason: string;
}

export interface CancellationAcknowledgement {
  version: typeof CONTROL_VERSION;
  type: "cancel-ack";
  requestId: string;
  runId: string;
  invocationId: string;
  status: string;
  quiescent: boolean;
  cleanupErrors: string[];
}

export interface InvocationCancellationResult {
  kind: "no-owner" | "acknowledged";
  acknowledgement?: CancellationAcknowledgement;
}

export interface InvocationControlOwnerOptions {
  runDir: string;
  runId: string;
  onCancellation: (reason: string) => void;
}

interface PendingClient {
  request: CancellationRequest;
  socket: Socket;
}

function ownerPath(runDir: string): string {
  return join(runDir, CONTROL_DIRECTORY, OWNER_FILENAME);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === code;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isErrno(error, "ESRCH");
  }
}

async function readInvocationRecord(runDir: string): Promise<InvocationRecord | null> {
  let text: string;
  try {
    text = await readFile(ownerPath(runDir), "utf-8");
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return null;
    throw new FilesystemError(`Cannot read invoke control record in ${runDir}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw new FilesystemError(`Invoke control record is invalid JSON in ${runDir}`, { cause: error });
  }
  if (
    typeof parsed !== "object" || parsed === null ||
    (parsed as { version?: unknown }).version !== CONTROL_VERSION ||
    typeof (parsed as { phase?: unknown }).phase !== "string"
  ) {
    throw new FilesystemError(`Invoke control record is malformed in ${runDir}`);
  }
  return parsed as InvocationRecord;
}

async function replaceControlRecord(runDir: string, record: InvocationRecord): Promise<void> {
  const directory = join(runDir, CONTROL_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const target = ownerPath(runDir);
  const temporary = join(directory, `${OWNER_FILENAME}.tmp-${randomUUID()}`);
  await writeFile(temporary, `${JSON.stringify(record)}\n`, "utf-8");
  try {
    await rename(temporary, target);
  } catch (error: unknown) {
    try {
      await unlink(temporary);
    } catch {
      // Preserve the original replacement error.
    }
    throw new FilesystemError(`Cannot update invoke control record in ${runDir}`, { cause: error });
  }
}

async function acquireControlRecord(runDir: string, record: ActiveInvocationRecord): Promise<void> {
  const directory = join(runDir, CONTROL_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const path = ownerPath(runDir);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf-8");
      } finally {
        await handle.close();
      }
      return;
    } catch (error: unknown) {
      if (!isErrno(error, "EEXIST")) {
        throw new FilesystemError(`Cannot create invoke control record in ${runDir}`, { cause: error });
      }

      const current = await readInvocationRecord(runDir);
      if (current?.phase === "active" && isProcessAlive(current.pid)) {
        throw new StateError(
          `Run "${record.runId}" already has an active invoke owner (pid ${current.pid})`,
          { details: { runId: record.runId, ownerPid: current.pid } },
        );
      }
      try {
        await unlink(path);
      } catch (unlinkError: unknown) {
        if (!isErrno(unlinkError, "ENOENT")) {
          throw new FilesystemError(`Cannot replace stale invoke control record in ${runDir}`, {
            cause: unlinkError,
          });
        }
      }
    }
  }

  throw new StateError(`Could not acquire invoke ownership for run "${record.runId}"`);
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Invoke control server did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

export class InvocationControlOwner {
  private readonly pending = new Map<Socket, PendingClient>();
  private quiescentAck: Omit<CancellationAcknowledgement, "requestId"> | undefined;

  private constructor(
    private readonly runDir: string,
    private readonly record: ActiveInvocationRecord,
    private readonly server: Server,
  ) {}

  static async start(opts: InvocationControlOwnerOptions): Promise<InvocationControlOwner> {
    let owner: InvocationControlOwner | undefined;
    const server = createServer((socket) => owner?.accept(socket, opts.onCancellation));
    server.on("error", () => {
      // Listen failures are handled during start; later socket/server errors are
      // surfaced to clients or during teardown without becoming uncaught events.
    });

    let port: number;
    try {
      port = await listen(server);
    } catch (error: unknown) {
      throw new FilesystemError(`Cannot start invoke control server for run ${opts.runId}`, { cause: error });
    }

    const record: ActiveInvocationRecord = {
      version: CONTROL_VERSION,
      phase: "active",
      runId: opts.runId,
      invocationId: randomUUID(),
      pid: process.pid,
      host: LOOPBACK_HOST,
      port,
      token: randomBytes(32).toString("hex"),
      startedAt: new Date().toISOString(),
    };

    try {
      await acquireControlRecord(opts.runDir, record);
    } catch (error: unknown) {
      await closeServer(server).catch(() => {});
      throw error;
    }

    owner = new InvocationControlOwner(opts.runDir, record, server);
    return owner;
  }

  private accept(socket: Socket, onCancellation: (reason: string) => void): void {
    socket.setEncoding("utf-8");
    // A peer that connects but never sends a complete request must not be
    // able to hold the owning invoke process open during terminal teardown.
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("error", () => this.pending.delete(socket));
    socket.on("close", () => this.pending.delete(socket));

    let buffer = "";
    const onData = (chunk: string): void => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", onData);

      let request: CancellationRequest;
      try {
        request = JSON.parse(buffer.slice(0, newline)) as CancellationRequest;
      } catch {
        socket.end(`${JSON.stringify({ error: "invalid_json" })}\n`);
        return;
      }

      if (
        request.version !== CONTROL_VERSION || request.type !== "cancel" ||
        request.runId !== this.record.runId ||
        request.invocationId !== this.record.invocationId ||
        request.token !== this.record.token || typeof request.reason !== "string"
      ) {
        socket.end(`${JSON.stringify({ error: "invalid_request" })}\n`);
        return;
      }

      if (this.quiescentAck !== undefined) {
        socket.end(`${JSON.stringify({ ...this.quiescentAck, requestId: request.requestId })}\n`);
        return;
      }

      this.pending.set(socket, { request, socket });
      onCancellation(request.reason);
    };
    socket.on("data", onData);
  }

  /**
   * Publish the terminal acknowledgement and close the control server.
   * Call only after every child and writer owned by this invocation settled.
   */
  async acknowledgeQuiescence(
    status: string,
    cleanupErrors: readonly unknown[] = [],
  ): Promise<void> {
    const cleanupMessages = cleanupErrors.map((error) =>
      error instanceof Error ? error.message : String(error)
    );
    let recordError: unknown;
    try {
      // Persist before replying: a successful acknowledgement is discoverable
      // even when the abort peer disconnects immediately after receiving it.
      await replaceControlRecord(this.runDir, {
        ...this.record,
        phase: "quiescent",
        finishedAt: new Date().toISOString(),
        status,
        quiescent: cleanupMessages.length === 0,
        cleanupErrors: cleanupMessages,
      });
    } catch (error: unknown) {
      recordError = error;
      cleanupMessages.push(error instanceof Error ? error.message : String(error));
    }

    const baseAck: Omit<CancellationAcknowledgement, "requestId"> = {
      version: CONTROL_VERSION,
      type: "cancel-ack",
      runId: this.record.runId,
      invocationId: this.record.invocationId,
      status,
      quiescent: cleanupMessages.length === 0,
      cleanupErrors: cleanupMessages,
    };
    this.quiescentAck = baseAck;

    for (const { request, socket } of this.pending.values()) {
      socket.end(`${JSON.stringify({ ...baseAck, requestId: request.requestId })}\n`);
    }
    this.pending.clear();

    let closeError: unknown;
    try {
      await closeServer(this.server);
    } catch (error: unknown) {
      closeError = error;
    }
    if (recordError !== undefined || closeError !== undefined) {
      throw new AggregateError(
        [recordError, closeError].filter((error): error is unknown => error !== undefined),
        "Invoke control teardown failed",
        { cause: recordError ?? closeError },
      );
    }
  }
}

export async function requestInvocationCancellation(
  runDir: string,
  runId: string,
  reason: string,
  timeoutMs = 30_000,
): Promise<InvocationCancellationResult> {
  const record = await readInvocationRecord(runDir);
  if (record === null || record.phase !== "active") {
    return { kind: "no-owner" };
  }
  if (record.runId !== runId) {
    throw new StateError(`Invoke control owner run id mismatch in ${runDir}`);
  }

  const request: CancellationRequest = {
    version: CONTROL_VERSION,
    type: "cancel",
    requestId: randomUUID(),
    runId,
    invocationId: record.invocationId,
    token: record.token,
    reason,
  };

  const acknowledgement = await new Promise<CancellationAcknowledgement>((resolve, reject) => {
    const socket = createConnection({ host: record.host, port: record.port });
    let settled = false;
    let buffer = "";

    const finish = (error?: unknown, ack?: CancellationAcknowledgement): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve(ack!);
    };

    const timeout = setTimeout(() => {
      finish(new FilesystemError(
        `Timed out waiting ${timeoutMs}ms for invoke ${record.invocationId} to acknowledge quiescence`,
        { details: { runId, ownerPid: record.pid, timeoutMs } },
      ));
    }, timeoutMs);

    socket.setEncoding("utf-8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch (error: unknown) {
        finish(new FilesystemError("Invoke cancellation acknowledgement is invalid JSON", { cause: error }));
        return;
      }
      const ack = parsed as Partial<CancellationAcknowledgement>;
      if (
        ack.version !== CONTROL_VERSION || ack.type !== "cancel-ack" ||
        ack.requestId !== request.requestId || ack.runId !== runId ||
        ack.invocationId !== record.invocationId || typeof ack.quiescent !== "boolean"
      ) {
        finish(new FilesystemError("Invoke cancellation acknowledgement is malformed"));
        return;
      }
      finish(undefined, ack as CancellationAcknowledgement);
    });
    socket.once("error", (error) => {
      finish(new FilesystemError(`Cannot reach active invoke owner for run ${runId}`, {
        cause: error,
        details: { runId, ownerPid: record.pid },
      }));
    });
    socket.once("end", () => {
      if (!settled) {
        finish(new FilesystemError(`Invoke owner closed cancellation channel without acknowledgement for run ${runId}`));
      }
    });
  });

  if (!acknowledgement.quiescent) {
    throw new FilesystemError(`Invoke owner could not reach a quiescent boundary for run ${runId}`, {
      details: { cleanupErrors: acknowledgement.cleanupErrors },
    });
  }
  return { kind: "acknowledged", acknowledgement };
}
