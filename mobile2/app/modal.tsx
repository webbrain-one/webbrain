import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';

import { Text, View } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { useAgent } from '@/context/AgentContext';
import { DEFAULT_SETTINGS, type AgentSettings } from '@/agent/settings-store';

/**
 * Settings screen — presented as a modal from the Chat tab header.
 * Stores API key in expo-secure-store via AgentContext.saveSettings().
 */
export default function SettingsModal() {
  const { settings, saveSettings, settingsLoading } = useAgent();
  const isDark = (useColorScheme() ?? 'light') === 'dark';
  const [draft, setDraft] = useState<AgentSettings>(settings);
  const [saving, setSaving] = useState(false);

  // Pull in the freshly-loaded settings if the user opens this screen before
  // the initial load completes.
  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  async function onSave() {
    setSaving(true);
    try {
      await saveSettings(draft);
      router.back();
    } finally {
      setSaving(false);
    }
  }

  function onResetEndpoint() {
    setDraft((d) => ({ ...d, baseUrl: DEFAULT_SETTINGS.baseUrl, model: DEFAULT_SETTINGS.model }));
  }

  const fieldBg = isDark ? '#222' : '#f0f0f0';
  const fieldText = isDark ? '#fff' : '#000';
  const placeholder = isDark ? '#888' : '#999';

  if (settingsLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} keyboardDismissMode="interactive">
        <Text style={styles.title}>Settings</Text>

        <Text style={styles.label}>OpenAI API key</Text>
        <TextInput
          style={[styles.input, { backgroundColor: fieldBg, color: fieldText }]}
          value={draft.apiKey}
          onChangeText={(v) => setDraft({ ...draft, apiKey: v })}
          placeholder="sk-..."
          placeholderTextColor={placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Text style={styles.hint}>
          Stored encrypted on-device (Keychain on iOS, EncryptedSharedPreferences on Android).
          Never leaves your phone except to call the model.
        </Text>

        <Text style={styles.label}>Base URL</Text>
        <TextInput
          style={[styles.input, { backgroundColor: fieldBg, color: fieldText }]}
          value={draft.baseUrl}
          onChangeText={(v) => setDraft({ ...draft, baseUrl: v })}
          placeholder="https://api.openai.com/v1"
          placeholderTextColor={placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Text style={styles.hint}>
          Use any OpenAI-compatible endpoint: OpenRouter, LM Studio, Ollama, etc.
        </Text>

        <Text style={styles.label}>Model</Text>
        <TextInput
          style={[styles.input, { backgroundColor: fieldBg, color: fieldText }]}
          value={draft.model}
          onChangeText={(v) => setDraft({ ...draft, model: v })}
          placeholder="gpt-5.4-mini"
          placeholderTextColor={placeholder}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Pressable style={styles.linkButton} onPress={onResetEndpoint}>
          <Text style={styles.linkButtonText}>Reset endpoint &amp; model to defaults</Text>
        </Pressable>

        <RNView style={styles.actions}>
          <Pressable
            style={[styles.button, styles.buttonPrimary, saving && styles.buttonDisabled]}
            onPress={onSave}
            disabled={saving}>
            <Text style={styles.buttonPrimaryText}>{saving ? 'Saving…' : 'Save'}</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.buttonSecondary]} onPress={() => router.back()}>
            <Text>Cancel</Text>
          </Pressable>
        </RNView>
      </ScrollView>

      <StatusBar style={Platform.OS === 'ios' ? 'light' : 'auto'} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, gap: 8 },
  title: { fontSize: 22, fontWeight: 'bold', marginBottom: 8 },
  label: { fontSize: 14, fontWeight: '600', marginTop: 12 },
  input: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    fontSize: 15,
  },
  hint: { fontSize: 12, opacity: 0.6, marginTop: 4 },
  linkButton: { marginTop: 12, padding: 8, alignSelf: 'flex-start' },
  linkButtonText: { color: '#2f95dc', fontSize: 14 },
  actions: { flexDirection: 'row', gap: 12, marginTop: 24 },
  button: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 10,
  },
  buttonPrimary: { backgroundColor: '#2f95dc' },
  buttonPrimaryText: { color: '#fff', fontWeight: '600' },
  buttonSecondary: { backgroundColor: 'rgba(127,127,127,0.18)' },
  buttonDisabled: { opacity: 0.6 },
});
