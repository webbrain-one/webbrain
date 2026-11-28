import { fileURLToPath } from 'node:url';
import * as mcpClient from '@deepseek-ai/dsh-mcp-client';

export const name = 'webbrain-local';
export const inject = mcpClient.inject;

export async function apply(ctx) {
  await mcpClient.apply(ctx, mcpClient.Config({
    serverName: 'webbrain',
    transport: 'stdio',
    command: 'node',
    args: [fileURLToPath(import.meta.resolve('@webbrain/mcp-server'))],
    // Leave room for WebBrain's five-minute default wait and the stdio round trip.
    toolCallTimeoutMs: 330_000,
  }));
}
