/**
 * LM Studio plugin entry — registers web-fetching tools plus, when the
 * WebBrain browser extension is attached, real browser delegation.
 *
 * Two tiers, deliberately:
 *   - `fetch_url` / `research_url` are pure Node HTTP. They need nothing
 *     installed and work forever, but they have no cookies, no session and
 *     no JavaScript — anything behind a login is invisible to them.
 *   - `browser_task` hands a goal to the WebBrain extension running in the
 *     user's own signed-in browser. It degrades with a clear, actionable
 *     message when no extension is connected rather than failing opaquely.
 *
 * Tool implementations live in `./tools/*.ts` as pure functions so
 * they stay portable across SDK API changes. Only the `main(ctx)`
 * glue here couples to `@lmstudio/sdk`. If a future SDK release
 * shifts the registration shape (the SDK is still marked
 * `@experimental` for plugin support as of 1.5.x), update this
 * file's contents — `tools/*` and `util/*` should keep compiling
 * unchanged.
 *
 * The pattern matches the `PluginContext` interface exported by
 * `@lmstudio/sdk`: a chained builder where you call
 * `ctx.withToolsProvider(...)` (and friends) once per plugin
 * capability you want to register. The host calls `main(ctx)` once
 * at plugin load time.
 */

import { tool } from "@lmstudio/sdk";
import type { PluginContext } from "@lmstudio/sdk";
import { z } from "zod";
import { fetchUrl } from "./tools/fetchUrl.js";
import { researchUrl } from "./tools/researchUrl.js";
import {
  browserAbort,
  browserRespond,
  browserStatus,
  browserTask,
} from "./tools/browserTask.js";
import { sharedBridge } from "./util/bridgeClient.js";

const fetchUrlTool = tool({
  name: "fetch_url",
  description:
    "Fetch a URL and return its content. Auto-detects content type: " +
    "JSON is pretty-printed, HTML is stripped to readable text with the " +
    "page's <title>, plain text is returned verbatim, binary is summarised. " +
    "Use this when the user gives you a specific URL or when you need raw " +
    "content from a known endpoint. For 'find me information about X', " +
    "prefer research_url instead — it pulls the article body, not the " +
    "navigation chrome.",
  parameters: {
    url: z
      .string()
      .url()
      .describe("Absolute http(s) URL to fetch."),
    method: z
      .string()
      .optional()
      .describe("HTTP method. Defaults to GET."),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe("Extra request headers."),
    body: z
      .string()
      .optional()
      .describe("Request body for non-GET methods."),
    timeout: z
      .number()
      .optional()
      .describe("Request timeout in ms (default 30000, max 120000)."),
    maxChars: z
      .number()
      .optional()
      .describe(
        "Maximum characters returned in the main text/json field after compaction. Defaults: 8000 for text/html, 16000 for JSON. Hard cap 50000.",
      ),
    compact: z
      .boolean()
      .optional()
      .describe(
        "Compact long text/json with a head/middle/tail extractive pass. Defaults to true. Set false for head-only truncation.",
      ),
    allowPrivate: z
      .boolean()
      .optional()
      .describe(
        "Allow targets that resolve to RFC1918 / loopback / link-local " +
          "addresses (localhost, 192.168.*, 10.*, 172.16-31.*, " +
          "169.254.*, fe80::*, fc00::/7). Off by default to keep the " +
          "model out of cloud-metadata services and the user's intranet.",
      ),
  },
  implementation: async ({ url, method, headers, body, timeout, allowPrivate, maxChars, compact }) => {
    const result = await fetchUrl({
      url,
      method,
      headers,
      body,
      timeout,
      allowPrivate,
      maxChars,
      compact,
    });
    // The implementation contract returns whatever string the LLM
    // should see in the tool result. JSON-stringify so the model gets
    // stable, parseable structure rather than a `[object Object]`.
    return JSON.stringify(result, null, 2);
  },
});

const researchUrlTool = tool({
  name: "research_url",
  description:
    "Fetch a URL and return its readable article body, biased toward " +
    "the <main>/<article> region with header/nav/footer/aside removed. " +
    "Best for 'tell me what this page says' on news sites, blog posts, " +
    "GitHub READMEs, Wikipedia, docs sites. Pure HTTP, no JS execution: " +
    "single-page apps that hydrate from JSON will return near-empty text — " +
    "if you see {spaSuspected:true} in the result, the page needs a real " +
    "browser to render and this plugin can't help.",
  parameters: {
    url: z
      .string()
      .url()
      .describe("Absolute http(s) URL to research."),
    timeout: z
      .number()
      .optional()
      .describe("Request timeout in ms (default 30000, max 120000)."),
    maxChars: z
      .number()
      .optional()
      .describe(
        "Maximum characters returned in the article text after compaction. Default 16000, hard cap 60000.",
      ),
    compact: z
      .boolean()
      .optional()
      .describe(
        "Compact long article text with a head/middle/tail extractive pass. Defaults to true. Set false for head-only truncation.",
      ),
    allowPrivate: z
      .boolean()
      .optional()
      .describe(
        "Allow targets that resolve to RFC1918 / loopback / link-local. " +
          "Off by default.",
      ),
  },
  implementation: async ({ url, timeout, allowPrivate, maxChars, compact }) => {
    const result = await researchUrl({ url, timeout, allowPrivate, maxChars, compact });
    return JSON.stringify(result, null, 2);
  },
});

const browserTaskTool = tool({
  name: "browser_task",
  description:
    "Run a task in the user's REAL browser — already signed in, with their " +
    "existing cookies and sessions. Use this whenever a page needs " +
    "authentication or renders client-side: an email inbox, an admin panel, a " +
    "SaaS dashboard behind SSO, a single-page app. fetch_url and research_url " +
    "cannot see any of those; they are plain HTTP with no session.\n\n" +
    "Describe the goal in plain language, as you would to a colleague sharing " +
    "their screen. mode='ask' is read-only and cannot click, type or submit — " +
    "prefer it whenever you only need to read. mode='act' allows interaction, " +
    "and the user approves consequential actions in the browser.\n\n" +
    "If a task keeps running, poll browser_status with its runId. If it needs user " +
    "input, ask the user and forward their answer with browser_respond. If the user " +
    "wants a continuing run stopped, call browser_abort.\n\n" +
    "Requires the WebBrain extension (https://webbrain.one) on a Chromium browser " +
    "(Chrome, Edge, Brave), pointed at this plugin's bridge. Firefox cannot host the " +
    "bridge. If it is not connected the tool returns a hint explaining exactly what to " +
    "do — relay that to the user rather than retrying.",
  parameters: {
    task: z
      .string()
      .describe(
        "The goal in plain language, e.g. 'open my Gmail and list unread " +
          "messages from this week with sender and subject'.",
      ),
    mode: z
      .enum(["ask", "act"])
      .optional()
      .describe(
        "'ask' (default) is read-only. 'act' permits clicking, typing and " +
          "navigation, gated by in-browser approval prompts.",
      ),
    timeout: z
      .number()
      .int()
      .positive()
      .max(3_600_000)
      .optional()
      .describe(
        "How long to wait in ms before handing control back. Default 180000. " +
          "Minimum 1, maximum 3600000. The run continues in the browser past " +
          "this point; it is not cancelled.",
      ),
    allowApiMutations: z
      .boolean()
      .optional()
      .describe(
        "Lift WebBrain's UI-first rule so it may issue mutating HTTP requests " +
          "directly instead of clicking through the visible interface. Off by " +
          "default and rarely correct. Only valid when mode is 'act'.",
      ),
  },
  implementation: async ({ task, mode, timeout, allowApiMutations }) => {
    const result = await browserTask({ task, mode, timeout, allowApiMutations });
    return JSON.stringify(result, null, 2);
  },
});

const browserStatusTool = tool({
  name: "browser_status",
  description:
    "With no runId, check whether the WebBrain extension is connected to this plugin. " +
    "With a runId returned by browser_task or browser_respond, retrieve that run's " +
    "current progress or final result. Poll the existing run instead of starting a " +
    "duplicate task after a timeout.",
  parameters: {
    runId: z
      .string()
      .optional()
      .describe("Existing browser run to inspect. Omit for connection status only."),
  },
  implementation: async ({ runId }) =>
    JSON.stringify(await browserStatus(runId), null, 2),
});

const browserRespondTool = tool({
  name: "browser_respond",
  description:
    "Answer a question from a browser run whose status is needs_user_input, then wait " +
    "for the run to continue. The answer must come from the user; never invent it. Use " +
    "the runId and clarifyId returned by browser_task or browser_status. When that result " +
    "carries a `decisions` list, the pause is a structured gate (permission, form submission, " +
    "saved-workflow repair): send exactly one of those values, never a localized label, " +
    "because the extension fails closed on an unknown decision.",
  parameters: {
    runId: z.string().min(1).describe("The browser run waiting for an answer."),
    clarifyId: z.string().min(1).describe("The pending clarification to answer."),
    answer: z
      .string()
      .min(1)
      .describe(
        "The user's answer, forwarded verbatim — or, when the pause reported a `decisions` " +
          "list, exactly one of those stable values.",
      ),
    timeout: z
      .number()
      .optional()
      .describe(
        "How long to wait in ms after answering. Default 180000. The run continues " +
          "after a timeout and can be polled with browser_status.",
      ),
  },
  implementation: async ({ runId, clarifyId, answer, timeout }) =>
    JSON.stringify(await browserRespond({ runId, clarifyId, answer, timeout }), null, 2),
});

const browserAbortTool = tool({
  name: "browser_abort",
  description:
    "Stop a browser run that is still running, waiting for input, or no longer needed. " +
    "Use the runId returned by browser_task, browser_status, or browser_respond. Actions " +
    "already completed in the browser are not undone.",
  parameters: {
    runId: z.string().min(1).describe("The continuing browser run to stop."),
  },
  implementation: async ({ runId }) =>
    JSON.stringify(await browserAbort(runId), null, 2),
});

/**
 * Plugin entry point. LM Studio's plugin runner calls this once at
 * load time with a `PluginContext` builder. We register the tools
 * via the chained `withToolsProvider(...)` API; the callback is
 * invoked any time the host needs a fresh list of tools (e.g. when
 * settings change).
 *
 * The browser tools are always advertised, even with no extension attached.
 * Hiding them would make the model believe the capability does not exist;
 * offering them with an actionable failure message lets it tell the user how
 * to turn the capability on.
 */
export async function main(ctx: PluginContext): Promise<void> {
  // Open the listener while the plugin initializes. The extension reconnects
  // with exponential backoff, so deferring this until the first browser tool
  // call can leave a correctly configured user waiting up to 30 seconds.
  // Listener failure must not take down the pure-HTTP tools.
  try {
    await sharedBridge().ensureStarted();
  } catch (error) {
    console.error(
      "[webbrain-lmstudio] browser bridge listener could not start:",
      error instanceof Error ? error.message : String(error),
    );
  }

  ctx.withToolsProvider(async () => [
    fetchUrlTool,
    researchUrlTool,
    browserTaskTool,
    browserStatusTool,
    browserRespondTool,
    browserAbortTool,
  ]);
}

// Some plugin loaders look at the default export instead of `main`.
// Re-export so either entry path works.
export default main;
