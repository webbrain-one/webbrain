/**
 * Browser delegation tools for the user's real, already-authenticated session.
 *
 * Scope is task-level on purpose. WebBrain's permission gate lives in its agent
 * loop, not in individual tool dispatch, so exposing low-level primitives over
 * a socket would move the trust boundary out of the browser. Delegating a goal
 * keeps every approval prompt intact.
 */

import {
  BridgeError,
  TERMINAL_STATUSES,
  sharedBridge,
  type CloudSnapshot,
} from "../util/bridgeClient.js";
import { randomUUID } from "node:crypto";

export interface BrowserTaskArgs {
  task: string;
  mode?: "ask" | "act";
  timeout?: number;
  allowApiMutations?: boolean;
}

export interface BrowserTaskResult {
  ok: boolean;
  runId?: string;
  status?: string;
  needsUserInput?: boolean;
  promptKind?: string;
  options?: string[];
  question?: string;
  clarifyId?: string;
  stillRunning?: boolean;
  finalUrl?: string;
  text?: string;
  error?: string;
  hint?: string;
}

export interface BrowserConnectionResult {
  connected: boolean;
  listeningOn: string;
  hint?: string;
}

export interface BrowserRespondArgs {
  runId: string;
  clarifyId: string;
  answer: string;
  timeout?: number;
}

const POLL_INTERVAL_MS = 1_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function timeoutMs(value: number | undefined): number {
  return Math.min(Math.max(value ?? 180_000, 1), 3_600_000);
}

function bodyOf(snapshot: CloudSnapshot): string {
  if (snapshot.result !== undefined && snapshot.result !== null) {
    return typeof snapshot.result === "string"
      ? snapshot.result
      : JSON.stringify(snapshot.result, null, 2);
  }
  return snapshot.content || snapshot.summary || "";
}

const STRUCTURED_PROMPT_KINDS = ["permission", "submitConfirmation", "workflowHealing"] as const;

/**
 * An extension older than the `promptKind` protocol sends no discriminator at
 * all, and this plugin updates independently of the browser store listing, so
 * that skew is routine. Refusing those prompts would break every
 * human-in-the-loop gate until the extension caught up, so a *missing* kind
 * falls back to the payload shape the kind used to be inferred from. A kind
 * that is present but unrecognized is a genuinely newer gate this client cannot
 * render, and is still refused.
 */
function resolvePromptKind(pending: NonNullable<CloudSnapshot["pendingInput"]>): string {
  const declared = typeof pending.promptKind === "string" ? pending.promptKind.trim() : "";
  if (declared) return declared;
  for (const kind of STRUCTURED_PROMPT_KINDS) {
    const details = pending[kind];
    if (details && typeof details === "object") return kind;
  }
  return "clarify";
}

function resultOf(snapshot: CloudSnapshot, timedOut = false): BrowserTaskResult {
  if (snapshot.status === "needs_user_input") {
    const pending = snapshot.pendingInput ?? {};
    const promptKind = resolvePromptKind(pending);
    switch (promptKind) {
      case "clarify":
      case "permission":
      case "submitConfirmation":
      case "workflowHealing":
        break;
      default:
        return {
          ok: false,
          runId: snapshot.runId,
          status: snapshot.status,
          needsUserInput: true,
          promptKind,
          clarifyId: String(pending.clarifyId ?? pending.clarify_id ?? ""),
          error: `WebBrain returned unsupported prompt kind '${promptKind}'.`,
          hint: "Do not send a free-form answer. Update the client before calling browser_respond.",
        };
    }
    const options = Array.isArray(pending.options)
      ? pending.options.map(String).filter(Boolean)
      : undefined;
    return {
      ok: false,
      runId: snapshot.runId,
      status: snapshot.status,
      needsUserInput: true,
      promptKind,
      options,
      question: String(pending.question ?? "(no question text supplied)"),
      clarifyId: String(pending.clarifyId ?? pending.clarify_id ?? ""),
      hint:
        "WebBrain paused because a human decision is required. Ask the user this " +
        "question, then call browser_respond with this runId and clarifyId. Do not " +
        "guess on their behalf.",
    };
  }

  if (timedOut || !TERMINAL_STATUSES.has(snapshot.status)) {
    return {
      ok: false,
      runId: snapshot.runId,
      status: snapshot.status,
      stillRunning: true,
      hint:
        "The task is still running in the browser and was NOT cancelled. Call " +
        "browser_status with this runId to retrieve its progress or eventual result; " +
        "do not start a duplicate browser_task. Call browser_abort with this runId if " +
        "the user wants it stopped.",
    };
  }

  if (snapshot.status !== "completed") {
    return {
      ok: false,
      runId: snapshot.runId,
      status: snapshot.status,
      error: snapshot.error || `Run ended with status '${snapshot.status}'.`,
      finalUrl: snapshot.finalUrl,
    };
  }

  return {
    ok: true,
    runId: snapshot.runId,
    status: snapshot.status,
    finalUrl: snapshot.finalUrl,
    text: bodyOf(snapshot),
  };
}

async function waitForRun(
  runId: string,
  initial: CloudSnapshot,
  waitMs: number,
): Promise<{ snapshot: CloudSnapshot; timedOut: boolean }> {
  let snapshot = initial;
  if (TERMINAL_STATUSES.has(snapshot.status) || snapshot.status === "needs_user_input") {
    return { snapshot, timedOut: false };
  }

  const bridge = sharedBridge();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    let polled: CloudSnapshot | { runs: CloudSnapshot[] };
    try {
      polled = await bridge.request<CloudSnapshot | { runs: CloudSnapshot[] }>(
        "cloud_status",
        { runId },
        remainingMs,
      );
    } catch (error) {
      if (
        Date.now() >= deadline ||
        (error instanceof BridgeError &&
          (error.code === "COMMAND_TIMEOUT" || error.code === "COMMAND_INTERRUPTED"))
      ) {
        return { snapshot, timedOut: true };
      }
      throw error;
    }
    if ((polled as { runs?: CloudSnapshot[] }).runs) continue;
    snapshot = polled as CloudSnapshot;
    if (TERMINAL_STATUSES.has(snapshot.status) || snapshot.status === "needs_user_input") {
      return { snapshot, timedOut: false };
    }

    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  return { snapshot, timedOut: true };
}

async function ensureConnected(
  waitMs: number,
  deadline?: number,
): Promise<BrowserTaskResult | null> {
  const bridge = sharedBridge();
  await bridge.ensureStarted();
  const boundedWaitMs = deadline == null
    ? waitMs
    : Math.min(waitMs, Math.max(0, deadline - Date.now()));
  if (!bridge.isConnected() && boundedWaitMs > 0) {
    await bridge.waitForExtension(boundedWaitMs);
  }
  if (bridge.isConnected()) return null;
  return {
    ok: false,
    error: "WebBrain browser extension not connected.",
    hint: bridge.notConnectedMessage(),
  };
}

export async function browserTask(args: BrowserTaskArgs): Promise<BrowserTaskResult> {
  const bridge = sharedBridge();
  const mode = args.mode === "act" ? "act" : "ask";
  if (args.allowApiMutations && mode !== "act") {
    return {
      ok: false,
      error: "API mutation permission requires mode 'act'.",
      hint: "Use mode 'ask' without allowApiMutations for read-only work, or explicitly choose mode 'act'.",
    };
  }
  const waitMs = timeoutMs(args.timeout);
  const deadline = Date.now() + waitMs;
  const runId = `lm_${randomUUID()}`;

  try {
    const connectionError = await ensureConnected(2_000, deadline);
    if (connectionError) return connectionError;
    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: "Browser task timeout expired before cloud_run could be dispatched.",
        hint: "No browser run was started. Retry with a longer timeout after the extension connects.",
      };
    }

    const payload: Record<string, unknown> = { runId, task: args.task, mode };
    if (args.allowApiMutations) payload.apiMutationsAllowed = true;

    let started: CloudSnapshot;
    try {
      started = await bridge.request<CloudSnapshot>(
        "cloud_run",
        payload,
        Math.max(1, deadline - Date.now()),
      );
    } catch (error) {
      if (
        error instanceof BridgeError &&
        (error.code === "COMMAND_TIMEOUT" || error.code === "COMMAND_INTERRUPTED")
      ) {
        return resultOf({ runId, status: "running" }, true);
      }
      throw error;
    }
    const settled = await waitForRun(
      started.runId,
      started,
      Math.max(0, deadline - Date.now()),
    );
    return resultOf(settled.snapshot, settled.timedOut);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Check connectivity, or retrieve an existing run when a run ID is supplied. */
export async function browserStatus(
  runId?: string,
): Promise<BrowserConnectionResult | BrowserTaskResult> {
  const bridge = sharedBridge();
  try {
    await bridge.ensureStarted();
    if (!bridge.isConnected()) await bridge.waitForExtension(1_500);
  } catch (error) {
    const message =
      `Could not open the bridge listener: ${
        error instanceof Error ? error.message : String(error)
      }. Another process may already hold that port.`;
    return runId
      ? { ok: false, runId, error: message }
      : { connected: false, listeningOn: bridge.url, hint: message };
  }

  if (!bridge.isConnected()) {
    return runId
      ? {
          ok: false,
          runId,
          error: "WebBrain browser extension not connected.",
          hint: bridge.notConnectedMessage(),
        }
      : { connected: false, listeningOn: bridge.url, hint: bridge.notConnectedMessage() };
  }
  if (!runId) return { connected: true, listeningOn: bridge.url };

  try {
    const snapshot = await bridge.request<CloudSnapshot>("cloud_status", { runId });
    return resultOf(snapshot);
  } catch (error) {
    return {
      ok: false,
      runId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Forward a user's answer to a paused run, then wait for its next settled state. */
export async function browserRespond(args: BrowserRespondArgs): Promise<BrowserTaskResult> {
  const bridge = sharedBridge();
  const waitMs = timeoutMs(args.timeout);
  const deadline = Date.now() + waitMs;
  try {
    const connectionError = await ensureConnected(2_000, deadline);
    if (connectionError) return { ...connectionError, runId: args.runId };
    if (Date.now() >= deadline) {
      return {
        ok: false,
        runId: args.runId,
        error: "Browser response timeout expired before cloud_respond could be dispatched.",
        hint: "No answer was sent. Retry after the extension reconnects.",
      };
    }

    let resumed: CloudSnapshot;
    try {
      resumed = await bridge.request<CloudSnapshot>(
        "cloud_respond",
        {
          runId: args.runId,
          clarifyId: args.clarifyId,
          answer: args.answer,
        },
        Math.max(1, deadline - Date.now()),
      );
    } catch (error) {
      if (
        error instanceof BridgeError &&
        (error.code === "COMMAND_TIMEOUT" || error.code === "COMMAND_INTERRUPTED")
      ) {
        return resultOf({ runId: args.runId, status: "running" }, true);
      }
      throw error;
    }
    const settled = await waitForRun(
      args.runId,
      resumed,
      Math.max(0, deadline - Date.now()),
    );
    return resultOf(settled.snapshot, settled.timedOut);
  } catch (error) {
    return {
      ok: false,
      runId: args.runId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Stop a continuing run. Actions it already completed are not rolled back. */
export async function browserAbort(runId: string): Promise<BrowserTaskResult> {
  const bridge = sharedBridge();
  try {
    const connectionError = await ensureConnected(2_000);
    if (connectionError) return { ...connectionError, runId };

    const snapshot = await bridge.request<CloudSnapshot>("cloud_abort", { runId });
    return resultOf(snapshot);
  } catch (error) {
    return {
      ok: false,
      runId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
