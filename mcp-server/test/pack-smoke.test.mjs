/**
 * Release artifact smoke check for `@webbrain/mcp-server`.
 *
 * Packs the tarball exactly as `npm publish` would (`npm pack --ignore-scripts`
 * after `npm run build`), unpacks it in an isolated temp directory, and verifies:
 *   1. The packed `package.json` version (>= 0.1.2) matches `dist/index.js`
 *      McpServer metadata (no stale hardcoded `0.1.0`).
 *   2. The packed `dist/index.js`, `dist/bridge.js`, and `dist/pairing.js`
 *      include `pairing-key`, `pairing_challenge`, and `pairing_proof`.
 *   3. Running `<packed>/dist/index.js pairing-key` prints the key to stdout
 *      and exits 0 without starting the WebSocket bridge listener.
 *   4. The CLI invocations documented in `mcp-server/README.md` and
 *      `web/docs/mcp/index.html` stay aligned with the packed artifact.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function resolveNpmCliJs() {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && /\.[cm]?js$/i.test(fromEnv) && existsSync(fromEnv)) {
    return fromEnv;
  }
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(nodeDir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const dir of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    candidates.push(
      join(dir, "node_modules", "npm", "bin", "npm-cli.js"),
      join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    );
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `Unable to locate npm-cli.js (npm_execpath=${JSON.stringify(fromEnv)}, execPath=${process.execPath})`,
  );
}

test("packed @webbrain/mcp-server tarball matches pairing-key CLI, pairing protocol, and setup guide", (t) => {
  const scratchDir = mkdtempSync(join(tmpdir(), "webbrain-mcp-pack-"));
  t.after(() => rmSync(scratchDir, { recursive: true, force: true }));

  const npmCliJs = resolveNpmCliJs();
  const packOut = execFileSync(
    process.execPath,
    [npmCliJs, "pack", "--ignore-scripts", "--pack-destination", scratchDir],
    { cwd: packageDir, encoding: "utf8" },
  ).trim();
  const tarballName = packOut.split(/\r?\n/).pop()?.trim();
  assert.ok(tarballName && tarballName.endsWith(".tgz"), `unexpected npm pack output: ${packOut}`);
  const tarballPath = join(scratchDir, tarballName);
  assert.ok(existsSync(tarballPath), `missing packed tarball at ${tarballPath}`);

  execFileSync("tar", ["-xzf", tarballName], { cwd: scratchDir });
  const packedRoot = join(scratchDir, "package");
  assert.ok(existsSync(packedRoot), "tarball did not extract a package/ root");

  const sourcePkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const packedPkg = JSON.parse(readFileSync(join(packedRoot, "package.json"), "utf8"));
  assert.equal(packedPkg.name, "@webbrain/mcp-server");
  assert.equal(packedPkg.version, sourcePkg.version);
  assert.notEqual(packedPkg.version, "0.1.0", "release version must be newer than legacy unpaired 0.1.0");
  assert.equal(packedPkg.bin?.["webbrain-mcp"], "dist/index.js");

  const indexJs = readFileSync(join(packedRoot, "dist", "index.js"), "utf8");
  const bridgeJs = readFileSync(join(packedRoot, "dist", "bridge.js"), "utf8");
  const pairingJs = readFileSync(join(packedRoot, "dist", "pairing.js"), "utf8");

  assert.doesNotMatch(indexJs, /version:\s*["']0\.1\.0["']/, "dist/index.js must not hardcode stale 0.1.0 version");
  assert.match(indexJs, /process\.argv\[2\]\s*===\s*["']pairing-key["']/);
  assert.match(bridgeJs, /pairing_challenge/);
  assert.match(bridgeJs, /pairing_proof/);
  assert.match(pairingJs, /webbrain-bridge-pairing-v1:/);

  // Expose only the runtime dependencies declared in the packed package.json
  // inside the extracted package's node_modules so executing the extracted CLI
  // entry point tests the unpacked tarball in isolation from the repo checkout.
  const packedNodeModules = join(packedRoot, "node_modules");
  mkdirSync(packedNodeModules, { recursive: true });
  for (const dep of Object.keys(packedPkg.dependencies || {})) {
    const target = join(packageDir, "node_modules", ...dep.split("/"));
    const linkPath = join(packedNodeModules, ...dep.split("/"));
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  }

  // Execute the extracted CLI entry point (`packedRoot/dist/index.js`) with
  // `pairing-key` using an isolated key file.
  const keyFile = join(scratchDir, "home", ".webbrain", "bridge-key");
  const env = { ...process.env, WEBBRAIN_BRIDGE_KEY_FILE: keyFile };
  delete env.WEBBRAIN_BRIDGE_KEY;

  const packedBin = join(packedRoot, packedPkg.bin["webbrain-mcp"]);
  const cliRun = spawnSync(process.execPath, [packedBin, "pairing-key"], {
    cwd: packedRoot,
    env,
    input: "",
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(cliRun.status, 0, cliRun.stderr);
  const printedKey = cliRun.stdout.trim();
  assert.ok(printedKey.length >= 32, `expected generated pairing key, got: ${JSON.stringify(cliRun.stdout)}`);
  assert.equal(readFileSync(keyFile, "utf8").trim(), printedKey);
  assert.doesNotMatch(cliRun.stderr, /listening on/, "pairing-key must exit without starting the WebSocket listener");

  // Verify the README and website MCP guide stay aligned with the packed CLI surface
  // and document the source-checkout fallback if an older 0.1.0 package is encountered.
  const readme = readFileSync(join(packageDir, "README.md"), "utf8");
  const mcpGuide = readFileSync(join(repoRoot, "web", "docs", "mcp", "index.html"), "utf8");
  for (const doc of [readme, mcpGuide]) {
    assert.match(doc, /npx -y @webbrain\/mcp-server pairing-key/);
    assert.match(doc, /node dist\/index\.js pairing-key/);
    assert.match(doc, /0\.1\.2/);
  }
});
