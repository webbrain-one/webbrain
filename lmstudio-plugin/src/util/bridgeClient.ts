/**
 * Bridge client — talks to the WebBrain browser extension.
 *
 * The extension cannot listen on a socket (Manifest V3 has no such API), so
 * `src/chrome/src/offscreen/cloud-bridge.js` dials OUT from an offscreen
 * document and we host the listener. Every command is initiated here and
 * answered by the browser.
 *
 * Wire protocol:
 *   us -> extension   {type:'pairing_challenge', scheme, nonce}       (on connect)
 *   extension -> us   {type:'hello', client, protocolVersion, capabilities, status}
 *   extension -> us   {type:'pairing_proof', scheme, proof}           (either order)
 *   us -> extension   {id, action, payload}
 *   extension -> us   {id, ok:true, result} | {id, ok:false, error, status?}
 *
 * A socket stays a candidate until it has sent both a valid hello and the
 * pairing proof (see pairing.ts). Candidates never receive commands and never
 * displace the connected extension.
 *
 * This is deliberately a standalone copy of the same ~150 lines that live in
 * `mcp-server/src/bridge.ts`. The two are separately published artifacts — this
 * one goes to LM Studio's registry, that one to npm — and coupling them through
 * a shared package would drag the whole monorepo into both installs. If you
 * change the protocol, change both.
 *
 * Default port is 17375: WebBrain Cloud owns 17373 and the MCP server owns
 * 17374. The extension holds exactly ONE bridge socket, so only one of the
 * three can be attached at a time.
 */

import { WebSocketServer, type WebSocket } from "ws";
import {
  PAIRING_CLOSE_CODE,
  PAIRING_SCHEME,
  loadPairingKey,
  newPairingNonce,
  validatePairingKey,
  verifyPairingProof,
} from "./pairing";

export type BridgeAction = "cloud_run" | "cloud_status" | "cloud_respond" | "cloud_abort";

export interface CloudSnapshot {
  runId: string;
  status:
    | "running"
    | "needs_user_input"
    | "aborting"
    | "completed"
    | "failed"
    | "aborted";
  mode?: "ask" | "act";
  task?: string;
  pendingInput?: {
    promptKind?: string;
    clarifyId?: string;
    clarify_id?: string;
    question?: string;
    options?: unknown[];
    [key: string]: unknown;
  } | null;
  result?: unknown;
  summary?: string;
  content?: string;
  finalUrl?: string;
  error?: string;
  [key: string]: unknown;
}

export const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);

export class BridgeError extends Error {
  readonly status?: number;
  readonly code?: "COMMAND_TIMEOUT" | "COMMAND_INTERRUPTED";
  constructor(
    message: string,
    status?: number,
    code?: "COMMAND_TIMEOUT" | "COMMAND_INTERRUPTED",
  ) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A socket that connected but has not yet proved it holds the pairing key. */
interface Candidate {
  nonce: string;
  hello: boolean;
  paired: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export interface BridgeOptions {
  port?: number;
  path?: string;
  commandTimeoutMs?: number;
  /** Pairing key supplied by the host. Defaults to loadPairingKey(). */
  pairingKey?: string;
  /** How long a new socket may take to send hello and pair before it is closed. */
  pairingTimeoutMs?: number;
}

function isAllowedBridgeOrigin(origin: string | string[] | undefined): boolean {
  if (origin == null) return true;
  if (Array.isArray(origin)) return false;
  try {
    const protocol = new URL(origin).protocol;
    return protocol === "chrome-extension:" || protocol === "moz-extension:";
  } catch {
    return false;
  }
}

export class BridgeClient {
  private wss: WebSocketServer | null = null;
  /** The paired extension. Only set once a socket has sent hello and paired. */
  private socket: WebSocket | null = null;
  private candidates = new Map<WebSocket, Candidate>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private waiters: Array<() => void> = [];
  private pairingKey = "";
  private pairingSource = "";

  readonly port: number;
  readonly path: string;
  readonly commandTimeoutMs: number;
  private readonly pairingTimeoutMs: number;
  private readonly configuredPairingKey: string | undefined;

  constructor(options: BridgeOptions = {}) {
    this.port = options.port ?? Number(process.env.WEBBRAIN_BRIDGE_PORT ?? 17375);
    this.path = options.path ?? (process.env.WEBBRAIN_BRIDGE_PATH || "/extension");
    this.commandTimeoutMs =
      options.commandTimeoutMs ?? Number(process.env.WEBBRAIN_COMMAND_TIMEOUT_MS ?? 30_000);
    this.pairingTimeoutMs = options.pairingTimeoutMs ?? 10_000;
    this.configuredPairingKey = options.pairingKey;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}${this.path}`;
  }

  /** Idempotent — safe to call before every tool invocation. */
  async ensureStarted(): Promise<void> {
    if (this.wss) return;

    // Resolve the key before binding: without it every socket would be refused.
    if (this.configuredPairingKey !== undefined) {
      this.pairingKey = validatePairingKey(this.configuredPairingKey, "The pairing key");
      this.pairingSource = "the plugin configuration";
    } else {
      const loaded = loadPairingKey();
      this.pairingKey = loaded.key;
      this.pairingSource = loaded.source;
    }

    await new Promise<void>((resolve, reject) => {
      // Loopback only. Anything that can reach this port can drive the user's
      // logged-in browser, so it must never bind a routable interface.
      const wss = new WebSocketServer({ host: "127.0.0.1", port: this.port }, () => resolve());
      wss.on("error", (error) => {
        if (this.wss === wss && !wss.address()) this.wss = null;
        reject(error);
      });
      this.wss = wss;
    });

    this.wss!.on("connection", (socket, request) => {
      if (!isAllowedBridgeOrigin(request.headers.origin)) {
        socket.close(1008, "Untrusted Origin");
        return;
      }
      if (!(request.url || "").startsWith(this.path)) {
        socket.close(1008, "Unexpected path");
        return;
      }
      // The new socket is only a candidate. The connected extension keeps
      // working until the candidate pairs, and is never touched if it fails.
      const candidate: Candidate = {
        nonce: newPairingNonce(),
        hello: false,
        paired: false,
        timer: setTimeout(() => {
          this.rejectCandidate(
            socket,
            candidate.hello
              ? "Pairing required: update WebBrain and paste the pairing key under Settings → Bridge"
              : "Handshake timeout",
          );
        }, this.pairingTimeoutMs),
      };
      this.candidates.set(socket, candidate);

      socket.on("message", (raw) => this.handleMessage(socket, raw.toString()));
      socket.on("close", () => {
        const unpaired = this.candidates.get(socket);
        if (unpaired) {
          clearTimeout(unpaired.timer);
          this.candidates.delete(socket);
          return;
        }
        if (this.socket !== socket) return;
        this.socket = null;
        this.failAllPending(
          new BridgeError(
            "WebBrain extension disconnected mid-command.",
            undefined,
            "COMMAND_INTERRUPTED",
          ),
        );
      });
      socket.on("error", () => {
        /* close handler does the cleanup */
      });

      try {
        socket.send(JSON.stringify({ type: "pairing_challenge", scheme: PAIRING_SCHEME, nonce: candidate.nonce }));
      } catch {
        /* the close handler drops the candidate */
      }
    });
  }

  private rejectCandidate(socket: WebSocket, reason: string, code = PAIRING_CLOSE_CODE): void {
    const candidate = this.candidates.get(socket);
    if (candidate) clearTimeout(candidate.timer);
    this.candidates.delete(socket);
    try {
      socket.close(code, reason);
    } catch {
      /* already gone */
    }
  }

  private handleCandidateMessage(socket: WebSocket, candidate: Candidate, msg: Record<string, unknown>): void {
    if (msg.type === "hello") {
      if (msg.client !== "webbrain-extension") {
        this.rejectCandidate(socket, "Unknown client", 1008);
        return;
      }
      candidate.hello = true;
    } else if (msg.type === "pairing_proof" || msg.type === "auth") {
      if (msg.scheme !== PAIRING_SCHEME || !verifyPairingProof(this.pairingKey, candidate.nonce, msg.proof)) {
        this.rejectCandidate(socket, "Pairing key mismatch");
        return;
      }
      candidate.paired = true;
    } else {
      // Candidates are never sent commands, so anything else is noise.
      return;
    }
    if (!candidate.paired || !candidate.hello) return;

    // Paired: promote it. Latest paired connection wins.
    clearTimeout(candidate.timer);
    this.candidates.delete(socket);
    const previous = this.socket;
    if (previous) {
      this.socket = null;
      this.failAllPending(
        new BridgeError(
          "WebBrain extension connection was superseded.",
          undefined,
          "COMMAND_INTERRUPTED",
        ),
      );
      try {
        previous.close(1000, "Superseded");
      } catch {
        /* already gone */
      }
    }
    this.socket = socket;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  private handleMessage(socket: WebSocket, data: string): void {
    const candidate = this.candidates.get(socket);
    if (!candidate && this.socket !== socket) return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (candidate) {
      this.handleCandidateMessage(socket, candidate, msg);
      return;
    }

    const id = typeof msg.id === "number" ? msg.id : null;
    if (id == null) return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);

    if (msg.ok === false) {
      entry.reject(
        new BridgeError(
          String(msg.error || "Unknown bridge error"),
          typeof msg.status === "number" ? msg.status : undefined,
        ),
      );
      return;
    }
    entry.resolve(msg.result);
  }

  private failAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  waitForExtension(timeoutMs: number): Promise<boolean> {
    if (this.isConnected()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve(false);
      }, timeoutMs);
      const wake = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.waiters.push(wake);
    });
  }

  notConnectedMessage(): string {
    return (
      "No WebBrain browser extension is connected, so browser tools are unavailable. " +
      `This plugin is listening on ${this.url}. To connect: install the WebBrain ` +
      "extension (https://webbrain.one) in Chromium or Firefox, open it, then set WebBrain → Settings → Bridge to " +
      `${this.url}, paste the pairing key from ${this.pairingSource || "~/.webbrain/bridge-key"} ` +
      "into Pairing key, and enable it. Ask the user to copy the key themselves; never request " +
      "it in chat. Older WebBrain versions without a Pairing key field must be " +
      "updated first. The extension holds one bridge at a time, so it " +
      "cannot also be pointed at WebBrain Cloud (17373) or the MCP server (17374). " +
      "fetch_url and research_url keep working everywhere, with or without the extension."
    );
  }

  async request<T = unknown>(
    action: BridgeAction,
    payload: Record<string, unknown> = {},
    timeoutMs = this.commandTimeoutMs,
  ): Promise<T> {
    await this.ensureStarted();
    const socket = this.socket;
    if (!socket || !this.isConnected()) {
      throw new BridgeError(this.notConnectedMessage());
    }

    const id = this.nextId++;
    const frame = JSON.stringify({ id, action, payload });
    const responseTimeoutMs = Math.max(1, Math.min(this.commandTimeoutMs, timeoutMs));

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError(
            `WebBrain did not answer '${action}' within ${responseTimeoutMs}ms.`,
            undefined,
            "COMMAND_TIMEOUT",
          ),
        );
      }, responseTimeoutMs);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });

      try {
        socket.send(frame);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new BridgeError(
            `Failed to send '${action}': ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });
  }

  async stop(): Promise<void> {
    this.failAllPending(new BridgeError("Bridge shutting down."));
    for (const [candidate, state] of this.candidates) {
      clearTimeout(state.timer);
      try {
        candidate.close(1001, "Shutting down");
      } catch {
        /* ignore */
      }
    }
    this.candidates.clear();
    if (this.socket) {
      try {
        this.socket.close(1001, "Shutting down");
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }
  }
}

/** Process-wide singleton: one listener per plugin process, not per tool call. */
let shared: BridgeClient | null = null;
export function sharedBridge(): BridgeClient {
  if (!shared) shared = new BridgeClient();
  return shared;
}
