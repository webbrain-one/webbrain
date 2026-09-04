import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import WebSocket from "ws";

import {
  browserAbort,
  browserRespond,
  browserStatus,
  browserTask,
} from "../dist/tools/browserTask.js";
import { main } from "../dist/index.js";
import { sharedBridge } from "../dist/util/bridgeClient.js";

let socket;
let toolsProvider;
const received = [];

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

function reply(message, result) {
  socket.send(JSON.stringify({ id: message.id, ok: true, result }));
}

before(async () => {
  process.env.WEBBRAIN_BRIDGE_PORT = String(await freePort());
  process.env.WEBBRAIN_COMMAND_TIMEOUT_MS = "50";
  const context = {
    withToolsProvider(provider) {
      toolsProvider = provider;
      return context;
    },
  };
  await main(context);

  const bridge = sharedBridge();

  socket = new WebSocket(bridge.url);
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    received.push(message);

    if (message.action === "cloud_run") {
      if (message.payload.task === "disconnect initial response") {
        socket.terminate();
        return;
      }
      if (message.payload.task === "unsupported prompt") {
        reply(message, {
          runId: "unsupported-run",
          status: "needs_user_input",
          pendingInput: { promptKind: "futureGate", question: "Choose.", clarifyId: "future-1" },
        });
        return;
      }
      if (message.payload.task === "legacy prompt") {
        reply(message, {
          runId: "legacy-run",
          status: "needs_user_input",
          pendingInput: {
            permission: { capability: "send_message", host: "example.com" },
            question: "Allow it?",
            clarifyId: "legacy-1",
            options: ["once", "always", "deny"],
          },
        });
        return;
      }
      if (message.payload.task === "stall initial response") return;
      if (message.payload.task === "stall status response") {
        reply(message, { runId: "stalled-run", status: "running" });
        return;
      }
      reply(message, {
        runId: "clarify-run",
        status: "needs_user_input",
        pendingInput: { promptKind: "clarify", question: "Which account?", clarifyId: "clarify-1" },
      });
      return;
    }
    if (message.action === "cloud_respond") {
      reply(message, { runId: message.payload.runId, status: "running" });
      return;
    }
    if (message.action === "cloud_abort") {
      reply(message, {
        runId: message.payload.runId,
        status: "aborted",
        error: "Abort requested.",
      });
      return;
    }
    if (message.action === "cloud_status") {
      if (message.payload.runId === "stalled-run") return;
      reply(message, {
        runId: message.payload.runId,
        status: "completed",
        result: `result for ${message.payload.runId}`,
      });
    }
  });
  await once(socket, "open");
  socket.send(JSON.stringify({ type: "hello", client: "webbrain-extension" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
});

after(async () => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.close();
    await once(socket, "close");
  }
  await sharedBridge().stop();
});

test("plugin initialization starts the bridge and registers browser recovery tools", async () => {
  assert.equal(typeof toolsProvider, "function");
  const tools = await toolsProvider();
  const names = tools.map((registeredTool) => registeredTool.name);
  assert.ok(names.includes("browser_status"));
  assert.ok(names.includes("browser_respond"));
  assert.ok(names.includes("browser_abort"));
  assert.equal(sharedBridge().isConnected(), true);
});

test("browser_status polls an existing run and returns its result", async () => {
  const result = await browserStatus("finished-run");
  assert.equal(result.ok, true);
  assert.equal(result.runId, "finished-run");
  assert.equal(result.status, "completed");
  assert.equal(result.text, "result for finished-run");
});

test("browser_task tells the model how to answer a paused run", async () => {
  const result = await browserTask({ task: "Open the requested account", timeout: 5_000 });
  assert.equal(result.needsUserInput, true);
  assert.equal(result.runId, "clarify-run");
  assert.equal(result.clarifyId, "clarify-1");
  assert.match(result.hint, /browser_respond/);
});

test("browser_task rejects an unknown prompt kind instead of treating it as free text", async () => {
  const result = await browserTask({ task: "unsupported prompt", timeout: 5_000 });
  assert.equal(result.needsUserInput, true);
  assert.equal(result.promptKind, "futureGate");
  assert.match(result.error, /unsupported prompt kind/);
  assert.match(result.hint, /Do not send a free-form answer/);
});

test("browser_task still relays a prompt from an extension older than promptKind", async () => {
  const result = await browserTask({ task: "legacy prompt", timeout: 5_000 });
  assert.equal(result.needsUserInput, true);
  assert.equal(result.promptKind, "permission");
  assert.equal(result.question, "Allow it?");
  assert.equal(result.clarifyId, "legacy-1");
  assert.deepEqual(result.options, ["once", "always", "deny"]);
  assert.equal(result.error, undefined);
});

test("browser_task rejects API mutation permission in ask mode before dispatch", async () => {
  const before = received.filter((message) => message.action === "cloud_run").length;
  const result = await browserTask({
    task: "read the page",
    mode: "ask",
    allowApiMutations: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /requires mode 'act'/);
  const after = received.filter((message) => message.action === "cloud_run").length;
  assert.equal(after, before);
});

test("browser_respond forwards IDs and the user's answer, then returns completion", async () => {
  const result = await browserRespond({
    runId: "clarify-run",
    clarifyId: "clarify-1",
    answer: "The work account",
    timeout: 5_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, "result for clarify-run");
  const response = received.find((message) => message.action === "cloud_respond");
  assert.deepEqual(response.payload, {
    runId: "clarify-run",
    clarifyId: "clarify-1",
    answer: "The work account",
  });
});

test("browser_task bounds a stalled status request by its run timeout", async () => {
  const startedAt = Date.now();
  const result = await browserTask({ task: "stall status response", timeout: 5_000 });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.stillRunning, true);
  assert.equal(result.runId, "stalled-run");
  assert.ok(elapsedMs < 1_500, `command timeout lost the run for ${elapsedMs}ms`);
});

test("browser_task honors a timeout below five seconds", async () => {
  const statusRequestsBefore = received.filter(
    (message) => message.action === "cloud_status" && message.payload.runId === "stalled-run",
  ).length;
  const startedAt = Date.now();
  const result = await browserTask({ task: "stall status response", timeout: 100 });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.stillRunning, true);
  assert.equal(result.runId, "stalled-run");
  const statusRequestsAfter = received.filter(
    (message) => message.action === "cloud_status" && message.payload.runId === "stalled-run",
  ).length;
  assert.equal(statusRequestsAfter, statusRequestsBefore + 1);
  assert.ok(elapsedMs < 500, `100ms timeout was stretched to ${elapsedMs}ms`);
});

test("browser_task preserves its generated run ID when the initial response stalls", async () => {
  const startedAt = Date.now();
  const result = await browserTask({ task: "stall initial response", timeout: 5_000 });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.stillRunning, true);
  assert.match(result.runId, /^lm_/);
  const request = received.find(
    (message) =>
      message.action === "cloud_run" && message.payload.task === "stall initial response",
  );
  assert.equal(request.payload.runId, result.runId);
  assert.ok(elapsedMs < 500, `initial command timeout took ${elapsedMs}ms`);
});

test("browser_abort forwards the continuing run ID", async () => {
  const result = await browserAbort("stalled-run");
  assert.equal(result.runId, "stalled-run");
  assert.equal(result.status, "aborted");

  const abort = received.find((message) => message.action === "cloud_abort");
  assert.deepEqual(abort.payload, { runId: "stalled-run" });
});

test("a web-page origin cannot replace the connected extension", async () => {
  const page = new WebSocket(sharedBridge().url, {
    headers: { Origin: "https://attacker.example" },
  });
  let receivedCommands = 0;
  page.on("message", () => {
    receivedCommands += 1;
  });
  await once(page, "close");

  assert.equal(sharedBridge().isConnected(), true);
  const result = await browserStatus("origin-safe-run");
  assert.equal(result.ok, true);
  assert.equal(result.runId, "origin-safe-run");
  assert.equal(receivedCommands, 0);
});

test("browser_task preserves its generated run ID when the start socket disconnects", async () => {
  const result = await browserTask({ task: "disconnect initial response", timeout: 5_000 });

  assert.equal(result.stillRunning, true);
  assert.match(result.runId, /^lm_/);
  const request = received.find(
    (message) =>
      message.action === "cloud_run" && message.payload.task === "disconnect initial response",
  );
  assert.equal(request.payload.runId, result.runId);
});

test("a replacement socket receives nothing until it sends a valid hello", async () => {
  const rogue = new WebSocket(sharedBridge().url);
  let receivedCommands = 0;
  rogue.on("message", () => {
    receivedCommands += 1;
  });
  await once(rogue, "open");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sharedBridge().isConnected(), false);
  const taskStartedAt = Date.now();
  const task = await browserTask({ task: "wait for extension", timeout: 100 });
  const taskElapsedMs = Date.now() - taskStartedAt;
  assert.equal(task.ok, false);
  assert.match(task.error, /not connected/i);
  assert.ok(taskElapsedMs < 500, `100ms task connection wait took ${taskElapsedMs}ms`);

  const respondStartedAt = Date.now();
  const response = await browserRespond({
    runId: "paused-run",
    clarifyId: "clarify-1",
    answer: "yes",
    timeout: 100,
  });
  const respondElapsedMs = Date.now() - respondStartedAt;
  assert.equal(response.ok, false);
  assert.equal(response.runId, "paused-run");
  assert.match(response.error, /not connected/i);
  assert.ok(respondElapsedMs < 500, `100ms response connection wait took ${respondElapsedMs}ms`);

  await assert.rejects(
    () => sharedBridge().request("cloud_run", { task: "private task", mode: "ask" }),
    /No WebBrain browser extension is connected/,
  );
  assert.equal(receivedCommands, 0);

  rogue.close();
  await once(rogue, "close");
});
