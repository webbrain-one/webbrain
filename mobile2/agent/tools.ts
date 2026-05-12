/**
 * Tool definitions for the mobile WebBrain agent.
 *
 * v0 ships the minimum viable set:
 *   - get_accessibility_tree  → read the page (preferred)
 *   - click_ax                 → click by ref_id
 *   - type_ax                  → type into a focused/typeable element by ref_id
 *   - navigate                 → change the WebView URL
 *   - done                     → terminal: signal task complete with summary
 *
 * Schemas mirror src/chrome/src/agent/tools.js exactly so the same prompts
 * and conversation shapes work across desktop and mobile.
 */
import * as rpc from './webview-rpc';
import type { ToolSchema } from './openai';

export const AGENT_TOOLS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'get_accessibility_tree',
      description:
        'PREFERRED page-reading tool. Returns the page as a flat, indented text representation of its accessibility tree. Each kept node is one line of the form `role "accessible name" [ref_id] href="..." type="..." placeholder="..."`. Indentation shows hierarchy. ref_ids are STABLE across calls — re-use them in click_ax / type_ax.',
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['all', 'visible', 'interactive'],
            description:
              'Which nodes to include. "visible" (in-viewport, visible) is a good default for navigation. "interactive" shows only clickable/typeable things. "all" traverses the whole DOM.',
          },
          maxDepth: { type: 'number', description: 'Max tree depth (default 15 for "all", 10 otherwise).' },
          maxChars: { type: 'number', description: 'Hard char cap on the rendered tree.' },
          ref_id: { type: 'string', description: 'Optional anchor — return just this element and its subtree.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click_ax',
      description:
        'Click an element by its ref_id from get_accessibility_tree. Scrolls into view, focuses, then clicks. ref_ids are stable across calls.',
      parameters: {
        type: 'object',
        properties: {
          ref_id: { type: 'string', description: 'A ref_id from get_accessibility_tree, e.g. "ref_42".' },
        },
        required: ['ref_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type_ax',
      description:
        'Type text into a focusable input/textarea/contenteditable by its ref_id. Uses native value setters so React picks up the change.',
      parameters: {
        type: 'object',
        properties: {
          ref_id: { type: 'string', description: 'A ref_id from get_accessibility_tree.' },
          text: { type: 'string', description: 'Text to type.' },
          clear: { type: 'boolean', description: 'Clear existing content before typing (default false).' },
        },
        required: ['ref_id', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate the browser tab to a URL. Use this to start the task on a specific site.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute URL to navigate to.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description:
        'Signal the task is FULLY complete and return a short summary. Only call when you have actually accomplished the user request OR you have exhausted alternatives.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One- or two-sentence summary of what was accomplished.' },
        },
        required: ['summary'],
      },
    },
  },
];

/**
 * Out-of-band signal returned from `dispatchTool` when the agent calls
 * `done`. The agent loop watches for this and stops iterating.
 */
export type ToolResult =
  | { kind: 'value'; value: unknown }
  | { kind: 'done'; summary: string }
  | { kind: 'error'; error: string };

export type ToolDispatchDeps = {
  /** Replace the URL the WebView is loading. Returns when navigation begins. */
  navigate: (url: string) => Promise<void>;
};

/**
 * Execute one tool call. Returns the result the LLM should see (as a JSON
 * value), or a `done` sentinel that ends the loop, or an error string.
 */
export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  deps: ToolDispatchDeps,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'get_accessibility_tree': {
        const r = await rpc.call('get_accessibility_tree', args);
        return { kind: 'value', value: r };
      }
      case 'click_ax': {
        const r = await rpc.call('click_ax', args);
        return { kind: 'value', value: r };
      }
      case 'type_ax': {
        const r = await rpc.call('type_ax', args);
        return { kind: 'value', value: r };
      }
      case 'navigate': {
        const url = String(args.url || '');
        if (!url) return { kind: 'error', error: 'navigate requires a url argument' };
        await deps.navigate(url);
        // Give the WebView a beat to start loading. The next get_accessibility_tree
        // call will block on the page-script being ready anyway.
        await new Promise((r) => setTimeout(r, 800));
        return { kind: 'value', value: { success: true, url } };
      }
      case 'done': {
        const summary = String(args.summary || '');
        return { kind: 'done', summary };
      }
      default:
        return { kind: 'error', error: `Unknown tool: ${name}` };
    }
  } catch (e: unknown) {
    return { kind: 'error', error: e instanceof Error ? e.message : String(e) };
  }
}
