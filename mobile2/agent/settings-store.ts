/**
 * Persistent settings: API key, base URL, model.
 *
 * On native: backed by expo-secure-store (encrypted Keychain on iOS,
 * EncryptedSharedPreferences on Android — appropriate for an API key).
 * On web (Expo web target): falls back to localStorage so settings
 * persistence still works in dev.
 */
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export type AgentSettings = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export const DEFAULT_SETTINGS: AgentSettings = {
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.4-mini',
};

const KEYS = {
  apiKey: 'wb_api_key',
  baseUrl: 'wb_base_url',
  model: 'wb_model',
} as const;

async function read(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  }
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function write(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch {}
    return;
  }
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {}
}

export async function loadSettings(): Promise<AgentSettings> {
  const [apiKey, baseUrl, model] = await Promise.all([
    read(KEYS.apiKey),
    read(KEYS.baseUrl),
    read(KEYS.model),
  ]);
  return {
    apiKey: apiKey ?? DEFAULT_SETTINGS.apiKey,
    baseUrl: baseUrl || DEFAULT_SETTINGS.baseUrl,
    model: model || DEFAULT_SETTINGS.model,
  };
}

export async function saveSettings(s: AgentSettings): Promise<void> {
  await Promise.all([
    write(KEYS.apiKey, s.apiKey),
    write(KEYS.baseUrl, s.baseUrl),
    write(KEYS.model, s.model),
  ]);
}
