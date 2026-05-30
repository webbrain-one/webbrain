#!/usr/bin/env node

import crypto from 'node:crypto';
import http from 'node:http';
import process from 'node:process';
import { readFileSync } from 'node:fs';

const DEFAULT_PORT = 17362;
const MCP_PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'webbrain-browser';
const ROOT_PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const SERVER_VERSION = ROOT_PACKAGE.version || '0.0.0';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const port = parsePort(process.env.WEBBRAIN_MCP_PORT, DEFAULT_PORT);
const host = process.env.WEBBRAIN_MCP_HOST || '127.0.0.1';
let hub;

const tools = [
  {
    name: 'webbrain_status',
    description: 'Show whether a real browser/profile is connected to the WebBrain MCP bridge.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: 'Optional browser connection id. Defaults to the newest connected browser.' },
      },
      required: [],
    },
  },
  {
    name: 'webbrain_list_tabs',
    description: 'List tabs from the connected real browser profile.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        currentWindow: { type: 'boolean', description: 'Only include tabs in the current browser window.' },
        activeOnly: { type: 'boolean', description: 'Only include active tabs.' },
        windowId: { type: 'number', description: 'Only include tabs from this browser window id.' },
      },
      required: [],
    },
  },
  {
    name: 'webbrain_active_tab',
    description: 'Return the active tab from the connected real browser profile.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'webbrain_tool_catalog',
    description: 'Return the WebBrain browser tool catalog exposed by the installed extension.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        mode: { type: 'string', enum: ['all', 'ask', 'act'], description: 'Tool set to return. Defaults to all.' },
      },
      required: [],
    },
  },
  {
    name: 'webbrain_chat',
    description: 'Ask the installed WebBrain extension to handle a browser task on the active tab or a specific tab. This uses the real browser profile and WebBrain agent loop.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        tabId: { type: 'number', description: 'Optional browser tab id. Defaults to the active tab.' },
        text: { type: 'string', description: 'Instruction for WebBrain.' },
        mode: { type: 'string', enum: ['ask', 'act'], description: 'ask is read-only; act can click/type/navigate with WebBrain permission prompts.' },
        apiMutationsAllowed: { type: 'boolean', description: 'Forward WebBrain /allow-api for this conversation. Use sparingly.' },
        includeUpdates: { type: 'boolean', description: 'Include detailed WebBrain tool updates in the MCP response. Defaults to false.' },
        timeoutMs: { type: 'number', description: 'Request timeout. Defaults to 300000 ms.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'webbrain_call_tool',
    description: 'Call one low-level WebBrain browser tool directly against the real browser tab. Direct calls are read-only by default; privileged actions require allowPrivilegedBrowserAction:true.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        tabId: { type: 'number', description: 'Optional browser tab id. Defaults to the active tab.' },
        name: { type: 'string', description: 'WebBrain tool name, such as get_accessibility_tree, read_page, click_ax, or set_field.' },
        args: { type: 'object', description: 'Arguments for the WebBrain tool.' },
        allowPrivilegedBrowserAction: {
          type: 'boolean',
          description: 'Required for calls that can affect browser state, local files, downloads, forms, navigation, or authenticated network data.',
        },
        includeAttachments: { type: 'boolean', description: 'Include raw image/document attachments such as screenshot data URLs. Defaults to false.' },
        includeUpdates: { type: 'boolean', description: 'Include detailed WebBrain tool updates in the MCP response. Defaults to false.' },
        timeoutMs: { type: 'number', description: 'Request timeout. Defaults to 120000 ms.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'webbrain_continue',
    description: 'Continue a WebBrain conversation that stopped at its step limit.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        tabId: { type: 'number' },
        mode: { type: 'string', enum: ['ask', 'act'] },
        includeUpdates: { type: 'boolean' },
        timeoutMs: { type: 'number', description: 'Request timeout. Defaults to 300000 ms.' },
      },
      required: [],
    },
  },
  {
    name: 'webbrain_abort',
    description: 'Abort a running WebBrain task for the active tab or a specific tab.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        tabId: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'webbrain_clear_conversation',
    description: 'Clear WebBrain conversation state for the active tab or a specific tab.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        tabId: { type: 'number' },
      },
      required: [],
    },
  },
];

const httpServer = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/status') {
    sendHttpJson(res, 200, {
      ok: true,
      server: { name: SERVER_NAME, version: SERVER_VERSION },
      mcp: { protocolVersion: MCP_PROTOCOL_VERSION },
      bridge: { host, port },
      browsers: hub.status(),
    });
    return;
  }
  sendHttpJson(res, 200, {
    ok: true,
    name: SERVER_NAME,
    message: 'WebBrain MCP bridge is running. Open the WebBrain extension in the browser profile you want agents to use.',
  });
});

httpServer.on('upgrade', (req, socket) => {
  if (!isBridgeUpgradeAllowed(req)) {
    rejectUpgrade(socket, 'HTTP/1.1 403 Forbidden');
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    rejectUpgrade(socket, 'HTTP/1.1 400 Bad Request');
    return;
  }

  const accept = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));

  hub.add(socket, req);
});

httpServer.on('error', (error) => {
  process.stderr.write(`[webbrain-mcp] bridge listen failed on ${host}:${port}: ${error.message}\n`);
});

async function handleMcpMessage(message, transport) {
  if (!message || message.jsonrpc !== '2.0') return;
  const { id, method, params = {} } = message;
  const isNotification = id === undefined || id === null;

  try {
    let result;
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: params.protocolVersion || MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        };
        break;
      case 'notifications/initialized':
        return;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools };
        break;
      case 'tools/call':
        result = await callMcpTool(params || {});
        break;
      default:
        if (!isNotification) {
          transport.send({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          });
        }
        return;
    }

    if (!isNotification) {
      transport.send({ jsonrpc: '2.0', id, result });
    }
  } catch (error) {
    if (!isNotification) {
      transport.send({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: error.message || String(error),
        },
      });
    }
  }
}

async function callMcpTool(params) {
  const name = String(params.name || '');
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};

  switch (name) {
    case 'webbrain_status':
      return toolResponse(await statusPayload(args));
    case 'webbrain_list_tabs':
      return toolResponse(await bridgeRequest(args.connectionId, 'list_tabs', args, timeout(args, 60000)));
    case 'webbrain_active_tab':
      return toolResponse(await bridgeRequest(args.connectionId, 'active_tab', args, timeout(args, 60000)));
    case 'webbrain_tool_catalog':
      return toolResponse(await bridgeRequest(args.connectionId, 'tool_catalog', args, timeout(args, 60000)));
    case 'webbrain_chat': {
      if (!String(args.text || '').trim()) return toolError('webbrain_chat requires text.');
      const result = await bridgeRequest(args.connectionId, 'chat', args, timeout(args, 300000));
      return toolResponse(maybeOmitUpdates(result, args));
    }
    case 'webbrain_call_tool': {
      if (!String(args.name || '').trim()) return toolError('webbrain_call_tool requires name.');
      const result = await bridgeRequest(args.connectionId, 'call_tool', args, timeout(args, 120000));
      const payload = maybeOmitUpdates(result, args);
      return payload?.result?.denied ? toolError(payload) : toolResponse(payload);
    }
    case 'webbrain_continue': {
      const result = await bridgeRequest(args.connectionId, 'continue', args, timeout(args, 300000));
      return toolResponse(maybeOmitUpdates(result, args));
    }
    case 'webbrain_abort':
      return toolResponse(await bridgeRequest(args.connectionId, 'abort', args, timeout(args, 60000)));
    case 'webbrain_clear_conversation':
      return toolResponse(await bridgeRequest(args.connectionId, 'clear_conversation', args, timeout(args, 60000)));
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

async function statusPayload(args) {
  const payload = {
    ok: true,
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    bridge: { host, port, url: `ws://${host}:${port}/webbrain` },
    browsers: hub.status(),
  };
  if (args.connectionId || hub.hasClients()) {
    try {
      payload.activeBrowser = await bridgeRequest(args.connectionId, 'status', args, timeout(args, 60000));
    } catch (error) {
      payload.activeBrowserError = error.message || String(error);
    }
  } else {
    payload.hint = 'No browser extension connected yet. Start this MCP server, then open/click WebBrain in the browser profile you want to control.';
  }
  return payload;
}

async function bridgeRequest(connectionId, action, args, timeoutMs) {
  const client = hub.get(connectionId);
  if (!client) {
    throw new Error('No WebBrain browser extension is connected. Start this MCP server, then open/click WebBrain in the target browser profile.');
  }
  return await client.request(action, args, timeoutMs);
}

function maybeOmitUpdates(result, args) {
  if (args.includeUpdates === true || !result || typeof result !== 'object') return result;
  if (!Array.isArray(result.updates)) return result;
  return {
    ...result,
    updatesOmitted: result.updates.length,
    updates: undefined,
  };
}

function toolResponse(value) {
  return {
    content: [{ type: 'text', text: stringify(value) }],
  };
}

function toolError(value) {
  return {
    isError: true,
    content: [{ type: 'text', text: typeof value === 'string' ? value : stringify(value) }],
  };
}

function stringify(value) {
  return JSON.stringify(value, null, 2);
}

function timeout(args, fallback) {
  const raw = Number(args.timeoutMs);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.max(1000, Math.min(30 * 60 * 1000, Math.round(raw)));
}

function parsePort(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return fallback;
  return parsed;
}

function sendHttpJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

function isBridgeUpgradeAllowed(req) {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (url.pathname !== '/webbrain') return false;
  const origin = String(req.headers.origin || '');
  return origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');
}

function rejectUpgrade(socket, statusLine) {
  try {
    socket.write(`${statusLine}\r\nConnection: close\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}

class BrowserHub {
  constructor() {
    this.clients = new Map();
    this.seq = 0;
    this.lastClientId = null;
  }

  add(socket, req) {
    const id = `browser_${++this.seq}`;
    const client = new BrowserClient(id, socket, req, () => {
      this.clients.delete(id);
      if (this.lastClientId === id) {
        this.lastClientId = Array.from(this.clients.keys()).at(-1) || null;
      }
    });
    this.clients.set(id, client);
    this.lastClientId = id;
    process.stderr.write(`[webbrain-mcp] browser connected: ${id}\n`);
  }

  hasClients() {
    return this.clients.size > 0;
  }

  get(id) {
    if (id) return this.clients.get(id) || null;
    if (this.lastClientId && this.clients.has(this.lastClientId)) return this.clients.get(this.lastClientId);
    return Array.from(this.clients.values()).at(-1) || null;
  }

  status() {
    return Array.from(this.clients.values()).map((client) => client.status());
  }
}

class BrowserClient {
  constructor(id, socket, req, onClose) {
    this.id = id;
    this.socket = socket;
    this.origin = String(req.headers.origin || '');
    this.remoteAddress = socket.remoteAddress || '';
    this.connectedAt = new Date().toISOString();
    this.lastSeenAt = this.connectedAt;
    this.hello = null;
    this.pending = new Map();
    this.seq = 0;
    this.buffer = Buffer.alloc(0);
    this.onClose = onClose;

    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.close(new Error('Browser bridge disconnected.')));
    socket.on('error', (error) => this.close(error));
  }

  status() {
    return {
      connectionId: this.id,
      origin: this.origin,
      remoteAddress: this.remoteAddress,
      connectedAt: this.connectedAt,
      lastSeenAt: this.lastSeenAt,
      browser: this.hello?.browser || null,
      extensionName: this.hello?.extensionName || null,
      extensionVersion: this.hello?.extensionVersion || null,
      capabilities: this.hello?.capabilities || [],
    };
  }

  request(action, params, timeoutMs) {
    if (this.socket.destroyed) return Promise.reject(new Error('Browser bridge socket is closed.'));
    const id = `req_${++this.seq}`;
    const message = { type: 'request', id, action, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for browser response to ${action}.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        updates: [],
      });
      this.send(message);
    });
  }

  send(message) {
    writeWebSocketFrame(this.socket, JSON.stringify(message));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const frame = readWebSocketFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.bytesRead);
      this.handleFrame(frame);
    }
  }

  handleFrame(frame) {
    this.lastSeenAt = new Date().toISOString();
    if (frame.opcode === 0x8) {
      this.socket.end();
      return;
    }
    if (frame.opcode === 0x9) {
      writeWebSocketFrame(this.socket, frame.payload, 0xA);
      return;
    }
    if (frame.opcode !== 0x1) return;

    let message;
    try {
      message = JSON.parse(frame.payload.toString('utf8'));
    } catch {
      return;
    }

    if (message.type === 'hello') {
      this.hello = message;
      return;
    }

    if (message.type === 'event' && message.requestId) {
      const pending = this.pending.get(message.requestId);
      if (pending) pending.updates.push(message);
      return;
    }

    if (message.type !== 'response') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(message.error.message || stringify(message.error)));
      return;
    }
    pending.resolve(message.result);
  }

  close(error) {
    for (const [id, pending] of this.pending) {
      pending.reject(error);
      this.pending.delete(id);
    }
    this.onClose?.();
  }
}

function readWebSocketFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame too large.');
    length = Number(bigLength);
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, bytesRead: offset + length };
}

function writeWebSocketFrame(socket, data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

class McpStdioTransport {
  constructor(input, output, onMessage) {
    this.input = input;
    this.output = output;
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
    input.on('data', (chunk) => this.onData(chunk));
    input.on('end', () => {
      httpServer.close();
    });
  }

  send(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.output.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.output.write(body);
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const parsed = this.tryReadMessage();
      if (!parsed) return;
      this.onMessage(parsed).catch((error) => {
        process.stderr.write(`[webbrain-mcp] MCP message error: ${error.message}\n`);
      });
    }
  }

  tryReadMessage() {
    const headerEnd = this.buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return null;
    const header = this.buffer.subarray(0, headerEnd).toString('utf8');
    const match = /^Content-Length:\s*(\d+)/im.exec(header);
    if (!match) {
      this.buffer = this.buffer.subarray(headerEnd + 4);
      return null;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (this.buffer.length < bodyEnd) return null;
    const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8');
    this.buffer = this.buffer.subarray(bodyEnd);
    return JSON.parse(body);
  }
}

hub = new BrowserHub();

httpServer.listen(port, host, () => {
  process.stderr.write(`[webbrain-mcp] bridge listening on ws://${host}:${port}/webbrain\n`);
});

const mcp = new McpStdioTransport(process.stdin, process.stdout, async (message) => {
  await handleMcpMessage(message, mcp);
});
