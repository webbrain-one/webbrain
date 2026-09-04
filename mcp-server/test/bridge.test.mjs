/**
 * Bridge round-trip tests.
 *
 * These stand up the real listener and connect a fake extension that speaks the
 * exact frame shapes `src/chrome/src/offscreen/cloud-bridge.js` emits. If the
 * extension's wire format changes, these fail — which is the point.
 *
 * Run: node test/bridge.test.mjs   (after `npm run build`)
 */

import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";

process.env.WEBBRAIN_BRIDGE_PORT = process.env.WEBBRAIN_BRIDGE_PORT || "17399";
process.env.WEBBRAIN_COMMAND_TIMEOUT_MS = "2000";
process.env.WEBBRAIN_POLL_INTERVAL_MS = "20";

const { WebBrainBridge, BridgeError, TERMINAL_STATUSES } = await import("../dist/bridge.js");
const { bridgeUrl } = await import("../dist/config.js");
const { awaitSettled, describeSnapshot } = await import("../dist/runs.js");

/** Minimal stand-in for the extension's offscreen bridge client. */
function fakeExtension(url, handler, { client = "webbrain-extension" } = {}) {
  const socket = new WebSocket(url);
  socket.on("open", () => {
    socket.send(
      JSON.stringify({
        type: "hello",
        client,
        protocolVersion: 2,
        capabilities: ["saved_workflows_v1", "run_modes_v1", "scheduled_jobs_v1"],
        status: { enabled: true },
      }),
    );
  });
  socket.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    if (!msg.action) return;
    const reply = await handler(msg);
    socket.send(JSON.stringify({ id: msg.id, ...reply }));
  });
  return socket;
}

test("handshake, command correlation, and payload shape", async () => {
  const bridge = new WebBrainBridge();
  await bridge.start();

  const seen = [];
  const ext = fakeExtension(bridgeUrl(), (msg) => {
    seen.push(msg);
    return {
      ok: true,
      result: { runId: "run_1", status: "running", mode: msg.payload.mode, task: msg.payload.task },
    };
  });

  assert.equal(await bridge.waitForExtension(3000), true, "extension should complete handshake");
  assert.deepEqual(bridge.capabilities(), [
    "saved_workflows_v1",
    "run_modes_v1",
    "scheduled_jobs_v1",
  ]);

  const result = await bridge.request("cloud_run", { task: "read this page", mode: "ask" });
  assert.equal(result.runId, "run_1");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, "cloud_run");
  // cloud-runs.js reads `task` and `mode` off the spread payload.
  assert.equal(seen[0].payload.task, "read this page");
  assert.equal(seen[0].payload.mode, "ask");
  assert.equal(typeof seen[0].id, "number");

  ext.close();
  await bridge.stop();
});

test("concurrent commands resolve to their own replies", async () => {
  const bridge = new WebBrainBridge();
  await bridge.start();

  const ext = fakeExtension(bridgeUrl(), async (msg) => {
    // Answer out of order on purpose: correlation must be by id, not arrival.
    const delay = msg.payload.task === "slow" ? 120 : 10;
    await new Promise((r) => setTimeout(r, delay));
    return { ok: true, result: { runId: msg.payload.task, status: "running" } };
  });
  await bridge.waitForExtension(3000);

  const [slow, quick] = await Promise.all([
    bridge.request("cloud_run", { task: "slow", mode: "ask" }),
    bridge.request("cloud_run", { task: "quick", mode: "ask" }),
  ]);
  assert.equal(slow.runId, "slow");
  assert.equal(quick.runId, "quick");

  ext.close();
  await bridge.stop();
});

test("extension errors surface as BridgeError with status", async () => {
  const bridge = new WebBrainBridge();
  await bridge.start();

  const ext = fakeExtension(bridgeUrl(), () => ({
    ok: false,
    error: "Cloud run `mode` must be `ask` or `act`.",
    status: 400,
  }));
  await bridge.waitForExtension(3000);

  await assert.rejects(
    () => bridge.request("cloud_run", { task: "x", mode: "sideways" }),
    (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.status, 400);
      assert.match(error.message, /must be `ask` or `act`/);
      return true;
    },
  );

  ext.close();
  await bridge.stop();
});

test("no extension attached produces an actionable message", async () => {
  const bridge = new WebBrainBridge();
  await bridge.start();

  await assert.rejects(
    () => bridge.request("cloud_status", {}),
    (error) => {
      assert.ok(error instanceof BridgeError);
      assert.match(error.message, /No WebBrain extension is connected/);
      assert.match(error.message, /MCP/);
      return true;
    },
  );

  await bridge.stop();
});

test("a client that is not the extension is rejected", async () => {
  const bridge = new WebBrainBridge();
  await bridge.start();

  const rogue = fakeExtension(bridgeUrl(), () => ({ ok: true, result: {} }), {
    client: "definitely-not-webbrain",
  });
  const closed = new Promise((resolve) => rogue.on("close", resolve));
  await closed;
  assert.equal(bridge.isConnected(), false, "rogue client must not be treated as the extension");

  await bridge.stop();
});

test("a web-page origin cannot replace the connected extension", async () => {
  const bridge = new WebBrainBridge();
  await bridge.start();

  const extension = fakeExtension(bridgeUrl(), (msg) => ({
    ok: true,
    result: { runId: msg.payload.runId || "safe-run", status: "running" },
  }));
  await bridge.waitForExtension(3000);

  const page = new WebSocket(bridgeUrl(), {
    headers: { Origin: "https://attacker.example" },
  });
  let receivedCommands = 0;
  page.on("message", () => {
    receivedCommands += 1;
  });
  await new Promise((resolve) => page.on("close", resolve));

  assert.equal(bridge.isConnected(), true, "page origin replaced the extension socket");
  const result = await bridge.request("cloud_run", {
    runId: "origin-safe-run",
    task: "private task",
    mode: "ask",
  });
  assert.equal(result.runId, "origin-safe-run");
  assert.equal(receivedCommands, 0, "page origin received a task frame");

  extension.close();
  await bridge.stop();
});

test("a new socket cannot inherit an earlier extension handshake", async () => {
  const bridge = new WebBrainBridge();
  await bridge.start();

  const extension = fakeExtension(bridgeUrl(), () => ({ ok: true, result: {} }));
  await bridge.waitForExtension(3000);
  assert.equal(bridge.isConnected(), true);

  const rogue = new WebSocket(bridgeUrl());
  let receivedCommands = 0;
  rogue.on("message", () => {
    receivedCommands += 1;
  });
  await new Promise((resolve) => rogue.on("open", resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(bridge.isConnected(), false, "the replacement socket has not sent hello");
  await assert.rejects(
    () => bridge.request("cloud_run", { task: "private task", mode: "ask" }),
    /No WebBrain extension is connected/,
  );
  assert.equal(receivedCommands, 0, "an unverified socket must not receive task frames");

  rogue.close();
  extension.close();
  await bridge.stop();
});

test("disconnect mid-command rejects rather than hanging", async () => {
  const bridge = new WebBrainBridge();
  await bridge.start();

  const ext = fakeExtension(bridgeUrl(), async () => {
    // Never replies; the socket dies underneath the pending request.
    await new Promise(() => {});
  });
  await bridge.waitForExtension(3000);

  const pending = bridge.request("cloud_run", { task: "x", mode: "ask" });
  setTimeout(() => ext.terminate(), 60);

  await assert.rejects(
    pending,
    (error) => {
      assert.match(error.message, /disconnected mid-command/);
      assert.equal(error.code, "COMMAND_INTERRUPTED");
      return true;
    },
  );
  await bridge.stop();
});

test("awaitSettled polls to a terminal status", async () => {
  const bridge = new WebBrainBridge();
  await bridge.start();

  let polls = 0;
  const ext = fakeExtension(bridgeUrl(), (msg) => {
    if (msg.action !== "cloud_status") return { ok: true, result: {} };
    polls += 1;
    return {
      ok: true,
      result:
        polls < 3
          ? { runId: "r", status: "running" }
          : { runId: "r", status: "completed", content: "42 open invoices", finalUrl: "https://x/y" },
    };
  });
  await bridge.waitForExtension(3000);

  const { snapshot, timedOut } = await awaitSettled(bridge, "r", { timeoutMs: 4000 });
  assert.equal(timedOut, false);
  assert.equal(snapshot.status, "completed");
  assert.ok(TERMINAL_STATUSES.has(snapshot.status));

  const text = describeSnapshot(snapshot);
  assert.match(text, /42 open invoices/);
  assert.match(text, /final_url: https:\/\/x\/y/);

  ext.close();
  await bridge.stop();
});

test("awaitSettled stops on needs_user_input and surfaces clarify_id", async () => {
  const bridge = new WebBrainBridge();
  await bridge.start();

  const ext = fakeExtension(bridgeUrl(), (msg) => {
    if (msg.action !== "cloud_status") return { ok: true, result: {} };
    return {
      ok: true,
      result: {
        runId: "r",
        status: "needs_user_input",
        pendingInput: {
          promptKind: "permission",
          permission: { capability: "send_message", host: "example.com" },
          clarifyId: "c_42",
          question: "Which account should I use?",
          options: ["once", "always", "deny"],
        },
      },
    };
  });
  await bridge.waitForExtension(3000);

  const { snapshot } = await awaitSettled(bridge, "r", { timeoutMs: 4000 });
  assert.equal(snapshot.status, "needs_user_input");

  const text = describeSnapshot(snapshot);
  assert.match(text, /clarify_id: c_42/);
  assert.match(text, /prompt_kind: permission/);
  assert.match(text, /allowed_answers: once, always, deny/);
  assert.match(text, /Which account should I use\?/);
  assert.match(text, /Do not invent an answer/);

  ext.close();
  await bridge.stop();
});

test("describeSnapshot refuses unknown prompt kinds instead of presenting free text", () => {
  const text = describeSnapshot({
    runId: "r",
    status: "needs_user_input",
    pendingInput: { promptKind: "futureGate", clarifyId: "c", question: "Choose." },
  });
  assert.match(text, /prompt_kind: futureGate/);
  assert.match(text, /unsupported by this client/);
  assert.doesNotMatch(text, /Relay this to the user/);
  assert.doesNotMatch(text, /Choose\./);
});

test("describeSnapshot still relays prompts from an extension older than promptKind", () => {
  const clarify = describeSnapshot({
    runId: "r",
    status: "needs_user_input",
    pendingInput: { clarifyId: "c", question: "Which account?", options: ["work", "personal"] },
  });
  assert.match(clarify, /prompt_kind: clarify/);
  assert.match(clarify, /suggested_answers: work, personal/);
  assert.match(clarify, /Which account\?/);
  assert.match(clarify, /Relay this to the user/);

  const permission = describeSnapshot({
    runId: "r",
    status: "needs_user_input",
    pendingInput: {
      clarifyId: "c",
      permission: { capability: "send_message", host: "example.com" },
      question: "Allow it?",
      options: ["once", "always", "deny"],
    },
  });
  assert.match(permission, /prompt_kind: permission/);
  assert.match(permission, /allowed_answers: once, always, deny/);
  assert.match(permission, /Relay this to the user/);
});

test("describeSnapshot lists workflow healing candidates as answerable", () => {
  const text = describeSnapshot({
    runId: "r",
    status: "needs_user_input",
    pendingInput: {
      promptKind: "workflowHealing",
      clarifyId: "c",
      workflowHealing: {
        candidates: [{ id: "candidate_0", target: "#a" }, { id: "candidate_1", target: "#b" }],
      },
      question: "Choose a replacement target.",
      options: ["deny"],
    },
  });
  assert.match(text, /allowed_answers: candidate_0, candidate_1, deny/);
});

test("awaitSettled reports a timeout without aborting the run", async () => {
  const bridge = new WebBrainBridge();
  await bridge.start();

  const actions = [];
  const ext = fakeExtension(bridgeUrl(), (msg) => {
    actions.push(msg.action);
    return { ok: true, result: { runId: "r", status: "running" } };
  });
  await bridge.waitForExtension(3000);

  const { snapshot, timedOut } = await awaitSettled(bridge, "r", { timeoutMs: 150 });
  assert.equal(timedOut, true);
  assert.equal(snapshot.status, "running");
  assert.ok(!actions.includes("cloud_abort"), "a timeout must never abort the user's run");
  assert.match(describeSnapshot(snapshot, true), /still running/);

  ext.close();
  await bridge.stop();
});
