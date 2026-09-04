#!/usr/bin/env node
/**
 * WebBrain MCP server.
 *
 * Gives any MCP client — Claude Code, Codex, Cursor, OpenClaw — the ability to
 * delegate a browser task to the user's REAL browser session: already logged
 * in, cookies present, MFA already passed. That session is the thing a headless
 * automation framework cannot reproduce, and it is the only reason this server
 * is interesting.
 *
 * Scope is deliberately coarse. We expose task delegation, not the ~50
 * low-level browser primitives, because:
 *   1. the permission gate lives in the extension's agent loop, not in
 *      `executeTool()`, so per-primitive access would bypass every safety
 *      property WebBrain advertises; and
 *   2. driving 50 primitives over a socket costs a round trip and a pile of
 *      tokens per click. Delegation is both safer and cheaper.
 *
 * stdout belongs to the MCP stdio transport. All logging goes to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { BridgeError, WebBrainBridge, type CloudSnapshot } from "./bridge.js";
import { bridgeUrl, config } from "./config.js";
import { abort, awaitSettled, describeSnapshot, getStatus, respond, startRun } from "./runs.js";

const bridge = new WebBrainBridge();

const server = new McpServer({
  name: "webbrain",
  version: "0.1.0",
});

type TextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const ok = (text: string): TextResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): TextResult => ({ content: [{ type: "text", text }], isError: true });

function toolError(error: unknown): TextResult {
  if (error instanceof BridgeError) return fail(error.message);
  return fail(error instanceof Error ? error.message : String(error));
}

server.registerTool(
  "webbrain_run",
  {
    title: "Run a browser task in the user's real session",
    description:
      "Delegate a web task to WebBrain running in the user's actual browser — already " +
      "signed in, with existing cookies and sessions. Use this when a task needs a page " +
      "the caller cannot reach: an authenticated dashboard, a webmail account, an admin " +
      "panel, a SaaS report behind SSO. Describe the goal in plain language, the way you " +
      "would to a colleague sharing the screen.\n\n" +
      "mode='ask' is read-only: it reads, extracts and summarises, and cannot click, type " +
      "or submit. mode='act' allows interaction, and the user is prompted in-browser to " +
      "approve consequential actions. Prefer 'ask' whenever you only need to read.\n\n" +
      "If the run stops with status 'needs_user_input', relay the question to the user and " +
      "answer with webbrain_respond — never guess on their behalf.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe(
          "The goal, in plain language. e.g. 'open the Stripe dashboard and list last " +
            "week's failed payments with amounts and customer emails'.",
        ),
      mode: z
        .enum(["ask", "act"])
        .default("ask")
        .describe(
          "'ask' is read-only and cannot modify the page. 'act' permits clicking, typing " +
            "and navigation, gated by in-browser approval. Default 'ask'.",
        ),
      tab_id: z
        .number()
        .int()
        .optional()
        .describe(
          "Target a specific browser tab. Omit to use the active tab, which is almost " +
            "always what you want.",
        ),
      allow_api_mutations: z
        .boolean()
        .default(false)
        .describe(
          "Lift WebBrain's UI-first rule so the agent may issue mutating HTTP requests " +
            "directly instead of clicking through the interface. Off by default and rarely " +
            "correct — the UI path is visible and stoppable. Only valid when mode is 'act'.",
        ),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .max(3600)
        .optional()
        .describe(
          "How long to wait before returning control. The run keeps going in the browser " +
            "past this point; poll webbrain_status to pick it back up.",
        ),
      wait: z
        .boolean()
        .default(true)
        .describe(
          "Wait for the run to settle. Set false to start it and return the run_id " +
            "immediately.",
        ),
    },
  },
  async ({ task, mode, tab_id, allow_api_mutations, timeout_seconds, wait }): Promise<TextResult> => {
    const timeoutMs = timeout_seconds ? timeout_seconds * 1000 : config.defaultRunTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const runId = `mcp_${randomUUID()}`;
    try {
      let started: CloudSnapshot;
      try {
        started = await startRun(
          bridge,
          {
            runId,
            task,
            mode,
            tabId: tab_id,
            apiMutationsAllowed: allow_api_mutations,
          },
          Math.max(1, deadline - Date.now()),
        );
      } catch (error) {
        if (
          error instanceof BridgeError &&
          (error.code === "COMMAND_TIMEOUT" || error.code === "COMMAND_INTERRUPTED")
        ) {
          return ok(describeSnapshot({ runId, status: "running" }, true));
        }
        throw error;
      }

      if (!wait) {
        return ok(
          `Started in the background.\n${describeSnapshot(started)}\n\n` +
            "Poll webbrain_status with this run_id for progress.",
        );
      }

      const { snapshot, timedOut } = await awaitSettled(bridge, started.runId, {
        timeoutMs: Math.max(0, deadline - Date.now()),
      });
      return ok(describeSnapshot(snapshot, timedOut));
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "webbrain_extract",
  {
    title: "Extract structured data from the user's real browser",
    description:
      "Read a page in the user's actual signed-in browser and return data that matches a " +
      "caller-supplied JSON Schema. This tool always uses WebBrain Ask mode, so it cannot " +
      "click, type, navigate or submit. Use it for authenticated reports, tables, account " +
      "details and other page data that should come back as predictable JSON rather than a " +
      "prose summary. Use webbrain_run instead when the task needs interaction.\n\n" +
      "If the run stops with status 'needs_user_input', relay the question to the user and " +
      "answer with webbrain_respond — never guess on their behalf.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe(
          "What to extract and any scope or filtering rules. Be explicit about the page, " +
            "time range, rows and fields the result should cover.",
        ),
      output_schema: z
        .record(z.unknown())
        .describe(
          "A JSON Schema object describing the exact result. Prefer an object root with " +
            "properties and required fields so the caller can rely on the returned shape.",
        ),
      tab_id: z
        .number()
        .int()
        .optional()
        .describe("Target a specific browser tab. Omit to use the active tab."),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .max(3600)
        .optional()
        .describe(
          "How long to wait before returning control. The extraction keeps running past " +
            "this point; poll webbrain_status with its run_id.",
        ),
      wait: z
        .boolean()
        .default(true)
        .describe(
          "Wait for the extraction to settle. Set false to start it and return the run_id " +
            "immediately.",
        ),
    },
  },
  async ({ task, output_schema, tab_id, timeout_seconds, wait }): Promise<TextResult> => {
    const timeoutMs = timeout_seconds ? timeout_seconds * 1000 : config.defaultRunTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    const runId = `mcp_${randomUUID()}`;
    try {
      let started: CloudSnapshot;
      try {
        started = await startRun(
          bridge,
          {
            runId,
            task,
            mode: "ask",
            tabId: tab_id,
            outputSchema: output_schema,
          },
          Math.max(1, deadline - Date.now()),
        );
      } catch (error) {
        if (
          error instanceof BridgeError &&
          (error.code === "COMMAND_TIMEOUT" || error.code === "COMMAND_INTERRUPTED")
        ) {
          return ok(describeSnapshot({ runId, status: "running" }, true));
        }
        throw error;
      }

      if (!wait) {
        return ok(
          `Structured extraction started in the background.\n${describeSnapshot(started)}\n\n` +
            "Poll webbrain_status with this run_id for progress.",
        );
      }

      const { snapshot, timedOut } = await awaitSettled(bridge, started.runId, {
        timeoutMs: Math.max(0, deadline - Date.now()),
      });
      return ok(describeSnapshot(snapshot, timedOut));
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "webbrain_status",
  {
    title: "Check a browser run",
    description:
      "Fetch the current state of a WebBrain run, including its result once finished. " +
      "Omit run_id to list every run this browser knows about.",
    inputSchema: {
      run_id: z
        .string()
        .optional()
        .describe("The run to inspect. Omit to list all runs."),
    },
  },
  async ({ run_id }): Promise<TextResult> => {
    try {
      const result = await getStatus(bridge, run_id);
      const runs = (result as { runs?: CloudSnapshot[] }).runs;
      if (runs) {
        if (!runs.length) return ok("No WebBrain runs on record.");
        return ok(
          runs
            .map((run) => `${run.runId}  ${run.status.padEnd(16)}  ${run.task ?? ""}`)
            .join("\n"),
        );
      }
      return ok(describeSnapshot(result as CloudSnapshot));
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "webbrain_respond",
  {
    title: "Answer a question from a browser run",
    description:
      "Supply the user's answer to a run sitting at status 'needs_user_input', then keep " +
      "waiting for it to settle. The answer must come from the user — WebBrain pauses " +
      "precisely because a human decision is required. For an ordinary clarification, pass " +
      "the user's answer verbatim. For a structured permission prompt, map the user's explicit " +
      "decision to the exact stable value shown by WebBrain: 'once', 'always', or 'deny'. Never " +
      "infer permission, and use 'always' only when the user explicitly requests a persistent grant. " +
      "Any other structured gate (form-submission confirmation, saved-workflow repair) lists its own " +
      "stable values on a 'decisions:' line — send one of those exactly, never a localized label.",
    inputSchema: {
      run_id: z.string().describe("The run that is waiting."),
      clarify_id: z.string().describe("The clarify_id reported alongside the question."),
      answer: z
        .string()
        .min(1)
        .describe(
          "For an ordinary clarification, the user's answer passed through verbatim. For a " +
            "permission prompt, the exact stable decision 'once', 'always', or 'deny' after the " +
            "user explicitly chooses it; a normal one-time approval maps to 'once'. For any other " +
            "structured gate, one of the exact values listed on its 'decisions:' line.",
        ),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .max(3600)
        .optional()
        .describe("How long to wait after answering before returning control."),
    },
  },
  async ({ run_id, clarify_id, answer, timeout_seconds }): Promise<TextResult> => {
    const timeoutMs = timeout_seconds ? timeout_seconds * 1000 : config.defaultRunTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    try {
      try {
        await respond(
          bridge,
          run_id,
          clarify_id,
          answer,
          Math.max(1, deadline - Date.now()),
        );
      } catch (error) {
        if (
          error instanceof BridgeError &&
          (error.code === "COMMAND_TIMEOUT" || error.code === "COMMAND_INTERRUPTED")
        ) {
          return ok(describeSnapshot({ runId: run_id, status: "running" }, true));
        }
        throw error;
      }
      const { snapshot, timedOut } = await awaitSettled(bridge, run_id, {
        timeoutMs: Math.max(0, deadline - Date.now()),
      });
      return ok(describeSnapshot(snapshot, timedOut));
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "webbrain_abort",
  {
    title: "Stop a browser run",
    description:
      "Halt a run that is going wrong or is no longer needed. Note that actions already " +
      "taken in the browser are not undone.",
    inputSchema: {
      run_id: z.string().describe("The run to stop."),
    },
  },
  async ({ run_id }): Promise<TextResult> => {
    try {
      const snapshot = await abort(bridge, run_id);
      return ok(describeSnapshot(snapshot));
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "webbrain_connection",
  {
    title: "Check the WebBrain browser connection",
    description:
      "Report whether a WebBrain extension is currently attached. Call this first when a " +
      "browser tool fails, so you can tell the user what to fix instead of retrying blindly.",
    inputSchema: {},
  },
  async (): Promise<TextResult> => {
    if (bridge.isConnected()) {
      const caps = bridge.capabilities();
      return ok(
        `Connected. Listening on ${bridgeUrl()}.` +
          (caps.length ? `\nExtension capabilities: ${caps.join(", ")}` : ""),
      );
    }
    return ok(
      `Not connected. Listening on ${bridgeUrl()}, but no extension has dialled in.\n\n` +
        "To connect: open a Chromium browser (Chrome, Edge, Brave), then in " +
        "WebBrain → Settings → General → Advanced → MCP set the URL to\n" +
        `  ${bridgeUrl()}\n` +
        "and enable it. The extension holds one bridge socket at a time, so this cannot " +
        "run at the same time as WebBrain Cloud on port 17373.\n\n" +
        "Firefox cannot host the bridge — that build has no offscreen document. If the " +
        "user is on Firefox, say so rather than suggesting settings changes.",
    );
  },
);

async function main(): Promise<void> {
  await bridge.start();

  // Give an already-open extension a bounded chance to reconnect before the
  // stdio server advertises browser tools. If this promise is discarded, the
  // grace period is illusory and the first tool call can race the reconnect.
  await bridge.waitForExtension(3_000);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[webbrain-mcp] ready on stdio");
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await bridge.stop().catch((error) => {
    console.error("[webbrain-mcp] shutdown error:", error);
  });
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// MCP hosts commonly stop stdio servers by closing the child's stdin rather
// than sending a signal. Without these handlers the WebSocket listener keeps
// the event loop alive and leaves port 17374 occupied by an orphan process.
process.stdin.once("end", () => void shutdown());
process.stdin.once("close", () => void shutdown());

main().catch((error) => {
  console.error("[webbrain-mcp] fatal:", error);
  process.exit(1);
});
