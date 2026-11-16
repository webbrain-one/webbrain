/**
 * Pairing tests: key storage, the `pairing-key` command, and an end-to-end run
 * of the extension's real bridge code (Chrome offscreen page and Firefox
 * background module) against this server.
 *
 * Run: node --test test/pairing.test.mjs   (after `npm run build`)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import WebSocket from "ws";

const allocator = createServer();
allocator.listen(0, "127.0.0.1");
await once(allocator, "listening");
process.env.WEBBRAIN_BRIDGE_PORT = String(allocator.address().port);
process.env.WEBBRAIN_COMMAND_TIMEOUT_MS = "2000";
allocator.close();
await once(allocator, "close");

const { WebBrainBridge } = await import("../dist/bridge.js");
const { bridgeUrl } = await import("../dist/config.js");
const { defaultPairingKeyFile, loadPairingKey, pairingProof } = await import("../dist/pairing.js");
const { createCloudBridge } = await import("../../src/firefox/src/cloud-bridge.js");

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const KEY = "end-to-end-pairing-key-0123456789";

function tempKeyFile(t) {
  const dir = mkdtempSync(join(tmpdir(), "webbrain-pairing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "nested", "bridge-key");
}

async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the proof matches the vector the extension and LM Studio tests also check", () => {
  assert.equal(
    pairingProof("webbrain-pairing-test-vector-key", "fixed-nonce-for-cross-checks"),
    "5d2a446bcc1734f26d8b94e20d3329a07fb2513aa6d036f47f687065d33c55da",
  );
});

test("the key file is created once with owner-only permissions and then reused", (t) => {
  const file = tempKeyFile(t);
  const first = loadPairingKey({ WEBBRAIN_BRIDGE_KEY_FILE: file });
  assert.equal(first.source, file);
  assert.ok(first.key.length >= 32);
  assert.equal(readFileSync(file, "utf8").trim(), first.key);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);

  const second = loadPairingKey({ WEBBRAIN_BRIDGE_KEY_FILE: file });
  assert.equal(second.key, first.key, "a restart must not invalidate the pairing");
  assert.match(defaultPairingKeyFile(), /[\\/]\.webbrain[\\/]bridge-key$/);
});

test("WEBBRAIN_BRIDGE_KEY overrides the file and short keys are refused", (t) => {
  const file = tempKeyFile(t);
  const fromEnv = loadPairingKey({ WEBBRAIN_BRIDGE_KEY: `  ${KEY}\n`, WEBBRAIN_BRIDGE_KEY_FILE: file });
  assert.deepEqual(fromEnv, { key: KEY, source: "WEBBRAIN_BRIDGE_KEY" });
  assert.throws(() => statSync(file), /ENOENT/, "an explicit key must not create a key file");

  assert.throws(() => loadPairingKey({ WEBBRAIN_BRIDGE_KEY: "too-short" }), /at least 16 characters/);
  loadPairingKey({ WEBBRAIN_BRIDGE_KEY_FILE: file });
  writeFileSync(file, "tiny\n");
  assert.throws(() => loadPairingKey({ WEBBRAIN_BRIDGE_KEY_FILE: file }), /at least 16 characters/);
});

test("`webbrain-mcp pairing-key` prints the stored key without starting the bridge", (t) => {
  const file = tempKeyFile(t);
  const { key } = loadPairingKey({ WEBBRAIN_BRIDGE_KEY_FILE: file });
  const env = { ...process.env, WEBBRAIN_BRIDGE_KEY_FILE: file };
  delete env.WEBBRAIN_BRIDGE_KEY;
  const run = spawnSync(process.execPath, ["dist/index.js", "pairing-key"], {
    cwd: packageDir,
    env,
    input: "",
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `${key}\n`);
  assert.doesNotMatch(run.stderr, /listening on/);
});

/** The Chrome offscreen bridge, run as the browser would run it. */
function chromeExtension(dispatch) {
  const source = readFileSync(new URL("../../src/chrome/src/offscreen/cloud-bridge.js", import.meta.url), "utf8");
  let listener;
  vm.runInNewContext(source, {
    URL,
    WebSocket,
    TextEncoder,
    crypto: globalThis.crypto,
    navigator: { userAgent: "Mozilla/5.0 Chrome/126.0.1", platform: "test" },
    chrome: { runtime: { onMessage: { addListener: (cb) => { listener = cb; } }, sendMessage: dispatch } },
    setTimeout,
    clearTimeout,
  });
  const call = (msg) => {
    let out;
    listener(msg, null, (value) => { out = value; });
    return out;
  };
  return {
    start: (identity) => call({ type: "cloud-bridge-start", url: bridgeUrl(), ...identity }),
    stop: () => call({ type: "cloud-bridge-stop" }),
    status: () => call({ type: "cloud-bridge-status" }),
  };
}

function firefoxExtension(dispatch) {
  const bridge = createCloudBridge({ dispatch, WebSocketImpl: WebSocket, nav: { userAgent: "Firefox/140.0", platform: "test" } });
  return { start: (identity) => bridge.start({ url: bridgeUrl(), ...identity }), stop: bridge.stop, status: bridge.status };
}

for (const [label, makeExtension] of [["chrome", chromeExtension], ["firefox", firefoxExtension]]) {
  test(`${label}: the real extension pairs with the MCP server and runs commands`, async (t) => {
    const bridge = new WebBrainBridge({ pairingKey: KEY });
    t.after(() => bridge.stop());
    await bridge.start();
    const calls = [];
    const extension = makeExtension(async (msg) => {
      calls.push(msg);
      return { runId: msg.runId, status: "running" };
    });
    t.after(() => extension.stop());

    extension.start({ pairingKey: KEY });
    assert.equal(await bridge.waitForExtension(3000), true);
    const result = await bridge.request("cloud_status", { runId: `${label}-run` });
    assert.equal(result.runId, `${label}-run`);
    assert.equal(calls.length, 1);
    assert.equal(JSON.stringify(extension.status()).includes(KEY), false, "status must not expose the key");
  });

  test(`${label}: a wrong pairing key is refused and the extension stops retrying`, async (t) => {
    const bridge = new WebBrainBridge({ pairingKey: KEY });
    t.after(() => bridge.stop());
    await bridge.start();
    const extension = makeExtension(async () => ({}));
    t.after(() => extension.stop());

    extension.start({ pairingKey: "not-the-servers-pairing-key" });
    await until(() => extension.status().approval === "rejected");
    assert.equal(extension.status().lastError, "Pairing key mismatch");
    assert.equal(bridge.isConnected(), false);
    await new Promise((resolve) => setTimeout(resolve, 700)); // first reconnect backoff is 500 ms
    assert.equal(extension.status().readyState, null, "a refused pairing must not reconnect in a loop");
    assert.equal(bridge.isConnected(), false);
  });

  test(`${label}: an extension without a pairing key is told to add one`, async (t) => {
    const bridge = new WebBrainBridge({ pairingKey: KEY });
    t.after(() => bridge.stop());
    await bridge.start();
    const extension = makeExtension(async () => ({}));
    t.after(() => extension.stop());

    extension.start({});
    await until(() => extension.status().approval === "rejected");
    assert.match(extension.status().lastError, /requires a pairing key/);
    assert.equal(bridge.isConnected(), false);

    // Pasting the key restarts the bridge with a changed identity and pairs.
    extension.start({ pairingKey: KEY });
    assert.equal(await bridge.waitForExtension(3000), true);
  });
}
