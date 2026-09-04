#!/usr/bin/env node

// Stands in for the WebBrain extension so the MCP server can be driven without
// Chrome. Speaks the same frames as src/chrome/src/offscreen/cloud-bridge.js:
// the `hello` handshake, then canned replies to cloud_run / cloud_status /
// cloud_respond / cloud_abort. Anything else comes back as an error, which is
// how you check the server's failure path.
//
//   cd mcp-server && node scripts/fake-extension.mjs [ws-url]
//
// Defaults to ws://127.0.0.1:17374/extension. Start the server first
// (npm start), then this, then point your MCP client at the server.

import WebSocket from "ws";

const url = process.argv[2] || "ws://127.0.0.1:17374/extension";
const socket = new WebSocket(url);
let lastRunId = null;

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

socket.on("open", () => {
  log(`connected to ${url}`);
  socket.send(
    JSON.stringify({
      type: "hello",
      client: "webbrain-extension",
      protocolVersion: 2,
      capabilities: ["saved_workflows_v1", "run_modes_v1", "scheduled_jobs_v1"],
      status: { enabled: true },
    }),
  );
  log("hello sent");
});

socket.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    log("non-JSON frame:", raw.toString());
    return;
  }
  if (!msg.action) {
    log("<-", JSON.stringify(msg));
    return;
  }
  log(`<-${msg.action} id=${msg.id}`, JSON.stringify(msg.payload ?? {}));
  const reply = respond(msg);
  socket.send(JSON.stringify({ id: msg.id, ...reply }));
  log(
    `-> ${reply.ok ? "ok" : "err"} id=${msg.id}`,
    JSON.stringify(reply.result ?? reply.error),
  );
});

function respond(msg) {
  switch (msg.action) {
    case "cloud_run":
      lastRunId = `run_${Date.now()}`;
      return {
        ok: true,
        result: {
          runId: lastRunId,
          status: "running",
          mode: msg.payload?.mode === "act" ? "act" : "ask",
        },
      };
    case "cloud_status":
      return {
        ok: true,
        result: {
          runId: lastRunId,
          status: "completed",
          result: { summary: "fake run completed", finalUrl: "https://example.com/" },
        },
      };
    case "cloud_respond":
    case "cloud_abort":
      return { ok: true, result: {} };
    default:
      return { ok: false, error: `fake extension cannot handle '${msg.action}'` };
  }
}

socket.on("close", (code, reason) => {
  log(`closed code=${code} reason=${reason.toString() || "-"}`);
});
socket.on("error", (error) => {
  log("socket error:", error.message);
});
