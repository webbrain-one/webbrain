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
import { createHmac } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";

const PAIRING_KEY = "bridge-test-pairing-key-0123456789";
process.env.WEBBRAIN_BRIDGE_PORT = process.env.WEBBRAIN_BRIDGE_PORT || "17399";
process.env.WEBBRAIN_COMMAND_TIMEOUT_MS = "2000";
process.env.WEBBRAIN_POLL_INTERVAL_MS = "20";
process.env.WEBBRAIN_BRIDGE_KEY = PAIRING_KEY;

const { WebBrainBridge, BridgeError, TERMINAL_STATUSES } = await import("../dist/bridge.js");
const { bridgeUrl } = await import("../dist/config.js");
const { awaitSettled, describeSnapshot } = await import("../dist/runs.js");

/** Computed independently of dist/pairing.js so a drift in either side fails here. */
function proofFor(key, nonce) {
  return createHmac("sha256", key).update(`webbrain-bridge-pairing-v1:${nonce}`).digest("hex");
}

/**
 * Minimal stand-in for the extension's offscreen bridge client. `key: null`
 * models an extension that cannot answer the pairing challenge.
 */
function fakeExtension(url, handler, { client = "webbrain-extension", key = PAIRING_KEY, hello = true } = {}) {
  const socket = new WebSocket(url);
  socket.frames = [];
  socket.on("open", () => {
    if (!hello) return;
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
    socket.frames.push(msg);
    if (msg.type === "pairing_challenge" || msg.type === "auth_challenge") {
      if (key !== null) {
        socket.send(JSON.stringify({ type: "pairing_proof", scheme: msg.scheme, proof: proofFor(key, msg.nonce) }));
      }
      return;
    }
    if (!msg.action) return;
    const reply = await handler(msg);
    socket.send(JSON.stringify({ id: msg.id, ...reply }));
  });
  return socket;
}

function closeInfo(socket) {
  return once(socket, "close").then(([code, reason]) => ({ code, reason: reason.toString() }));
}

test("handshake, command correlation, and payload shape", async (t) => {
  const bridge = new WebBrainBridge();
  t.after(() => bridge.stop());
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

test("concurrent commands resolve to their own replies", async (t) => {
  const bridge = new WebBrainBridge();
  t.after(() => bridge.stop());
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

test("extension errors surface as BridgeError with status", async (t) => {
  const bridge = new WebBrainBridge();
  t.after(() => bridge.stop());
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

test("no extension attached produces an actionable message", async (t) => {
  const bridge = new WebBrainBridge();
  t.after(() => bridge.stop());
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

test("a client that is not the extension is rejected", async (t) => {
  const bridge = new WebBrainBridge();
  t.after(() => bridge.stop());
  await bridge.start();

  const rogue = fakeExtension(bridgeUrl(), () => ({ ok: true, result: {} }), {
    client: "definitely-not-webbrain",
  });
  const closed = new Promise((resolve) => rogue.on("close", resolve));
  await closed;
  assert.equal(bridge.isConnected(), false, "rogue client must not be treated as the extension");

  await bridge.stop();
});

test("a web-page origin cannot replace the connected extension", async (t) => {
  const bridge = new WebBrainBridge();
  t.after(() => bridge.stop());
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

test("a local process claiming to be the extension cannot replace the paired extension", async (t) => {
  const bridge = new WebBrainBridge({ pairingTimeoutMs: 200 });
  t.after(() => bridge.stop());
  await bridge.start();

  const extension = fakeExtension(bridgeUrl(), (msg) => ({
    ok: true,
    result: { runId: msg.payload.runId, status: "running" },
  }));
  await bridge.waitForExtension(3000);
  assert.equal(bridge.isConnected(), true);

  // Origin-less native client with a perfect hello but no pairing proof.
  const rogue = fakeExtension(bridgeUrl(), () => ({ ok: true, result: { runId: "forged" } }), { key: null });
  const rogueClosed = closeInfo(rogue);
  await once(rogue, "open");
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(bridge.isConnected(), true, "an unpaired hello displaced the extension");
  const result = await bridge.request("cloud_run", { runId: "still-private", task: "private task", mode: "ask" });
  assert.equal(result.runId, "still-private", "the paired extension must keep answering");
  assert.deepEqual(rogue.frames.map((frame) => frame.type), ["pairing_challenge"], "an unpaired socket must only see the challenge");

  const { code, reason } = await rogueClosed;
  assert.equal(code, 4001);
  assert.match(reason, /Pairing required/);
  assert.equal(bridge.isConnected(), true);

  extension.close();
  await bridge.stop();
});

test("a wrong pairing proof is refused without touching the paired extension", async (t) => {
  const bridge = new WebBrainBridge();
  t.after(() => bridge.stop());
  await bridge.start();

  const extension = fakeExtension(bridgeUrl(), () => ({ ok: true, result: { runId: "safe", status: "running" } }));
  await bridge.waitForExtension(3000);

  const rogue = fakeExtension(bridgeUrl(), () => ({ ok: true, result: {} }), { key: "a-guessed-pairing-key-000000" });
  const { code, reason } = await closeInfo(rogue);
  assert.equal(code, 4001);
  assert.equal(reason, "Pairing key mismatch");
  assert.deepEqual(rogue.frames.map((frame) => frame.type), ["pairing_challenge"]);

  assert.equal(bridge.isConnected(), true);
  assert.equal((await bridge.request("cloud_status", { runId: "safe" })).runId, "safe");

  extension.close();
  await bridge.stop();
});

test("a pairing proof cannot be replayed on another socket", async (t) => {
  const bridge = new WebBrainBridge();
  t.after(() => bridge.stop());
  await bridge.start();

  const first = fakeExtension(bridgeUrl(), () => ({ ok: true, result: {} }));
  await bridge.waitForExtension(3000);
  const recordedNonce = first.frames[0].nonce;
  const recordedProof = proofFor(PAIRING_KEY, recordedNonce);
  first.close();
  await once(first, "close");

  const replay = new WebSocket(bridgeUrl());
  const replayClosed = closeInfo(replay);
  const [challengeRaw] = await once(replay, "message");
  const challenge = JSON.parse(challengeRaw.toString());
  assert.notEqual(challenge.nonce, recordedNonce, "every socket needs a fresh nonce");
  replay.send(JSON.stringify({ type: "hello", client: "webbrain-extension", protocolVersion: 2, capabilities: [] }));
  replay.send(JSON.stringify({ type: "auth", scheme: challenge.scheme, proof: recordedProof }));
  assert.equal((await replayClosed).code, 4001);
  assert.equal(bridge.isConnected(), false);

  await bridge.stop();
});

test("the pairing key never crosses the socket and pairing works in either frame order", async (t) => {
  const bridge = new WebBrainBridge();
  t.after(() => bridge.stop());
  await bridge.start();

  // Proof before hello: the bridge must wait for both before trusting the socket.
  const socket = new WebSocket(bridgeUrl());
  const seen = [];
  socket.on("message", (raw) => {
    const text = raw.toString();
    seen.push(text);
    const msg = JSON.parse(text);
    if (msg.type === "pairing_challenge" || msg.type === "auth_challenge") {
      socket.send(JSON.stringify({ type: "pairing_proof", scheme: msg.scheme, proof: proofFor(PAIRING_KEY, msg.nonce) }));
      setTimeout(() => {
        assert.equal(bridge.isConnected(), false, "a proof without hello must not be enough");
        socket.send(JSON.stringify({ type: "hello", client: "webbrain-extension", protocolVersion: 2, capabilities: [] }));
      }, 30);
      return;
    }
    if (msg.action) socket.send(JSON.stringify({ id: msg.id, ok: true, result: { runId: "r", status: "running" } }));
  });
  assert.equal(await bridge.waitForExtension(3000), true);
  await bridge.request("cloud_status", { runId: "r" });

  assert.equal(JSON.parse(seen[0]).scheme, "hmac-sha256-v1");
  for (const frame of seen) assert.equal(frame.includes(PAIRING_KEY), false, "the key must never be sent");

  socket.close();
  await bridge.stop();
});

test("a paired reconnect supersedes the previous extension socket", async (t) => {
  const bridge = new WebBrainBridge();
  t.after(() => bridge.stop());
  await bridge.start();

  const first = fakeExtension(bridgeUrl(), () => ({ ok: true, result: { runId: "first" } }));
  await bridge.waitForExtension(3000);
  const firstClosed = closeInfo(first);

  const second = fakeExtension(bridgeUrl(), () => ({ ok: true, result: { runId: "second" } }));
  assert.equal((await firstClosed).code, 1000);
  assert.equal(bridge.isConnected(), true);
  assert.equal((await bridge.request("cloud_status", {})).runId, "second");

  second.close();
  await bridge.stop();
});

test("a pairing key shorter than 16 characters is refused at start", async () => {
  const bridge = new WebBrainBridge({ pairingKey: "short" });
  await assert.rejects(() => bridge.start(), /at least 16 characters/);
  await bridge.stop();
});

test("disconnect mid-command rejects rather than hanging", async (t) => {
  const bridge = new WebBrainBridge();
  t.after(() => bridge.stop());
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

test("awaitSettled polls to a terminal status", async (t) => {
  const bridge = new WebBrainBridge();
  t.after(() => bridge.stop());
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

test("awaitSettled stops on needs_user_input and surfaces clarify_id", async (t) => {
  const bridge = new WebBrainBridge();
  t.after(() => bridge.stop());
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

test("awaitSettled reports a timeout without aborting the run", async (t) => {
  const bridge = new WebBrainBridge();
  t.after(() => bridge.stop());
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

test("describeSnapshot relays WebBrain's confirmation cards with their decisions", () => {
  const recipient = describeSnapshot({
    runId: "r",
    status: "needs_user_input",
    pendingInput: {
      promptKind: "recipientConfirmation",
      clarifyId: "recipient_1",
      recipientConfirmation: { recipients: [{ identity: "@someone" }], host: "x.com" },
      question: "Send to @someone?",
      options: ["once", "deny"],
    },
  });
  assert.match(recipient, /prompt_kind: recipientConfirmation/);
  assert.match(recipient, /allowed_answers: once, deny/);
  assert.match(recipient, /structured_prompt: .*@someone/);
  assert.match(recipient, /question: Send to @someone\?/);
  assert.doesNotMatch(recipient, /unsupported by this client/);

  // Older extensions omit promptKind; the payload key identifies the card.
  const video = describeSnapshot({
    runId: "r",
    status: "needs_user_input",
    pendingInput: {
      clarifyId: "video_1",
      videoLengthConfirmation: { estimatedSeconds: 90, maxSeconds: 60 },
      question: "Generate a 1:00 version instead?",
      options: ["once", "deny"],
    },
  });
  assert.match(video, /prompt_kind: video_length/);
  assert.match(video, /question: Generate a 1:00 version instead\?/);
});

test("describeSnapshot gives clarify options exactly and says when WebBrain answers itself", () => {
  const text = describeSnapshot({
    runId: "r",
    status: "needs_user_input",
    pendingInput: {
      promptKind: "clarify",
      clarifyId: "c",
      question: "Which reply?",
      options: ["Yes, post it", "No"],
      deadlineTs: 1700000000000,
    },
  });
  assert.match(text, /suggested_answers: Yes, post it, No/);
  assert.match(text, /answer_options: \["Yes, post it","No"\]/);
  assert.match(text, /deadline_ts: 1700000000000/);
  assert.doesNotMatch(text, /require_explicit_answer/);

  const explicit = describeSnapshot({
    runId: "r",
    status: "needs_user_input",
    pendingInput: { promptKind: "clarify", clarifyId: "c", question: "Share this?", requireExplicitAnswer: true },
  });
  assert.match(explicit, /require_explicit_answer: true/);
});
