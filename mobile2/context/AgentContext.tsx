/**
 * AgentContext — shared state between the Chat tab, Browser tab, and Settings.
 *
 * Owns:
 *   - Chat history (assistant + user + tool-action breadcrumbs).
 *   - `working` flag (drives the Browser tab's blink animation).
 *   - Current URL the WebView is loading.
 *   - Settings (apiKey, baseUrl, model) loaded from expo-secure-store.
 *   - The WebView ref (registered by the Browser tab on mount). Tools
 *     dispatch through this via `agent/webview-rpc`.
 *
 * The agent loop lives in `agent/agent.ts`; this context is the orchestration
 * seam that wires user intent (sendMessage) to (LLM provider + tool dispatch).
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type WebView from 'react-native-webview';

import { runAgent, type AgentEvent } from '@/agent/agent';
import { OpenAIProvider, type ChatMessage as ApiMessage } from '@/agent/openai';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings as persistSettings,
  type AgentSettings,
} from '@/agent/settings-store';
import * as rpc from '@/agent/webview-rpc';

/**
 * UI message — what the chat list renders. Distinct from the API-shape
 * messages we send to the LLM (those carry tool_calls / tool_call_id).
 */
export type ChatMessage =
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'assistant'; content: string }
  | { id: string; role: 'tool'; label: string; ok: boolean };

type AgentState = {
  messages: ChatMessage[];
  working: boolean;
  url: string;
  setUrl: (url: string) => void;
  sendMessage: (text: string) => void;

  // settings
  settings: AgentSettings;
  settingsLoading: boolean;
  saveSettings: (s: AgentSettings) => Promise<void>;

  // webview wiring (called by the Browser tab)
  registerWebView: (ref: WebView | null) => void;
  onWebViewMessage: (raw: string) => void;
};

const AgentContext = createContext<AgentState | null>(null);

let nextMsgId = 1;
const newId = () => String(nextMsgId++);

export function AgentProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [working, setWorking] = useState(false);
  const [url, setUrl] = useState('https://www.google.com');
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_SETTINGS);
  const [settingsLoading, setSettingsLoading] = useState(true);

  // Maintain the API-shape conversation history alongside the UI messages.
  // The agent loop appends to it and we keep it across turns so follow-ups
  // have context.
  const apiHistory = useRef<ApiMessage[]>([]);

  // Load persisted settings on mount.
  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await loadSettings();
      if (!alive) return;
      setSettings(s);
      setSettingsLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const saveSettingsCb = useCallback(async (s: AgentSettings) => {
    await persistSettings(s);
    setSettings(s);
  }, []);

  const appendMessage = useCallback((m: ChatMessage) => {
    setMessages((prev) => [...prev, m]);
  }, []);

  const navigate = useCallback(async (newUrl: string) => {
    setUrl(newUrl);
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      appendMessage({ id: newId(), role: 'user', content: trimmed });

      if (!settings.apiKey) {
        appendMessage({
          id: newId(),
          role: 'assistant',
          content: 'No API key set. Open Settings (gear icon) and add an OpenAI-compatible API key.',
        });
        return;
      }

      setWorking(true);
      try {
        const provider = new OpenAIProvider({
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl,
          model: settings.model,
        });

        // Best-effort page meta — ignore failures (e.g. WebView not yet ready).
        let pageMeta: { url: string; title: string } | null = null;
        try {
          const r = (await rpc.call<{ url: string; title: string }>('get_page_meta')) || null;
          pageMeta = r;
        } catch {
          pageMeta = { url, title: '' };
        }

        const onEvent = (e: AgentEvent) => {
          switch (e.type) {
            case 'tool_call':
              appendMessage({
                id: newId(),
                role: 'tool',
                label: `${e.name}(${shortArgs(e.args)})`,
                ok: true,
              });
              break;
            case 'tool_result':
              // Only show errors as their own line; success replies are
              // implicit from the tool_call line above. Keeps chat readable.
              if (!e.ok) {
                appendMessage({
                  id: newId(),
                  role: 'tool',
                  label: `${e.name} failed: ${e.preview}`,
                  ok: false,
                });
              }
              break;
            case 'text':
              appendMessage({ id: newId(), role: 'assistant', content: e.content });
              break;
            case 'done':
              appendMessage({
                id: newId(),
                role: 'assistant',
                content: e.summary || 'Done.',
              });
              break;
            case 'error':
              appendMessage({
                id: newId(),
                role: 'assistant',
                content: `Error: ${e.message}`,
              });
              break;
          }
        };

        const updatedHistory = await runAgent({
          provider,
          history: apiHistory.current,
          userText: trimmed,
          pageMeta,
          deps: { navigate },
          onEvent,
        });
        apiHistory.current = updatedHistory;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        appendMessage({ id: newId(), role: 'assistant', content: `Error: ${msg}` });
      } finally {
        setWorking(false);
      }
    },
    [settings, url, navigate, appendMessage],
  );

  const registerWebView = useCallback((ref: WebView | null) => {
    rpc.registerWebView(ref);
  }, []);

  const onWebViewMessage = useCallback((raw: string) => {
    rpc.handleWebViewMessage(raw);
  }, []);

  return (
    <AgentContext.Provider
      value={{
        messages,
        working,
        url,
        setUrl,
        sendMessage,
        settings,
        settingsLoading,
        saveSettings: saveSettingsCb,
        registerWebView,
        onWebViewMessage,
      }}>
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent() {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgent must be used inside AgentProvider');
  return ctx;
}

function shortArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      const trimmed = s.length > 40 ? s.slice(0, 40) + '…' : s;
      return `${k}: ${trimmed}`;
    })
    .join(', ');
  return entries.length > 80 ? entries.slice(0, 80) + '…' : entries;
}
