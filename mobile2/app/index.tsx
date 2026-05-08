import FontAwesome from '@expo/vector-icons/FontAwesome';
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { Link } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View as RNView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

import { Text, View } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';
import { useAgent } from '@/context/AgentContext';
import { PAGE_SCRIPT } from '@/agent/inject';

export default function HomeScreen() {
  const {
    url,
    setUrl,
    working,
    messages,
    sendMessage,
    registerWebView,
    onWebViewMessage,
  } = useAgent();
  const isDark = (useColorScheme() ?? 'light') === 'dark';
  const insets = useSafeAreaInsets();

  // Browser state
  const [draftUrl, setDraftUrl] = useState(url);
  const [loading, setLoading] = useState(false);
  const [urlFocused, setUrlFocused] = useState(false);
  const webRef = useRef<WebView>(null);
  const urlInputRef = useRef<TextInput>(null);

  // Chat state
  const [chatDraft, setChatDraft] = useState('');
  const sheetRef = useRef<BottomSheet>(null);
  const scrollRef = useRef<any>(null);

  // Two snap points: peek (just the input bar) and expanded.
  const snapPoints = useMemo(() => ['12%', '92%'], []);

  useEffect(() => {
    registerWebView(webRef.current);
    return () => registerWebView(null);
  }, [registerWebView]);

  useEffect(() => {
    setDraftUrl(url);
  }, [url]);

  useEffect(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd?.({ animated: true });
    });
  }, [messages.length, working]);

  function go() {
    let u = draftUrl.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    setUrl(u);
    setDraftUrl(u);
    Keyboard.dismiss();
  }

  function clearUrl() {
    setDraftUrl('');
    urlInputRef.current?.focus();
  }

  function handleMessage(event: WebViewMessageEvent) {
    onWebViewMessage(event.nativeEvent.data);
  }

  function onSendChat() {
    const text = chatDraft.trim();
    if (!text) return;
    sendMessage(text);
    setChatDraft('');
  }

  // Backdrop fades in only when the sheet is expanded; tapping it collapses
  // the sheet back to peek.
  const renderBackdrop = useCallback(
    (p: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...p}
        appearsOnIndex={1}
        disappearsOnIndex={0}
        pressBehavior="collapse"
      />
    ),
    [],
  );

  const fieldBg = isDark ? '#222' : '#f0f0f0';
  const fieldText = isDark ? '#fff' : '#000';
  const placeholderColor = isDark ? '#888' : '#999';
  const sheetBg = isDark ? '#0a0a0a' : '#f2f2f7';
  const sheetHandleColor = isDark ? '#444' : '#bbb';
  const inputBarBg = isDark ? '#1c1c1e' : '#ffffff';
  const inputFieldBg = isDark ? '#2c2c2e' : '#e5e5ea';
  const borderColor = isDark ? '#2a2a2c' : '#d1d1d6';
  const canSendChat = !!chatDraft.trim() && !working;

  return (
    <View style={styles.root}>
      {/* Top URL bar over the browser. */}
      <RNView
        style={[
          styles.urlBar,
          {
            paddingTop: insets.top + 6,
            backgroundColor: isDark ? '#000' : '#fff',
            borderBottomColor: isDark ? '#1f1f1f' : '#e5e5ea',
          },
        ]}>
        <RNView style={[styles.urlInputWrap, { backgroundColor: fieldBg }]}>
          <TextInput
            ref={urlInputRef}
            style={[styles.urlInput, { color: fieldText }]}
            value={draftUrl}
            onChangeText={setDraftUrl}
            onFocus={() => setUrlFocused(true)}
            onBlur={() => setUrlFocused(false)}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onSubmitEditing={go}
            placeholder="https://…"
            placeholderTextColor={placeholderColor}
            returnKeyType="go"
            selectTextOnFocus
          />
          {draftUrl.length > 0 && (
            <Pressable
              style={styles.clearButton}
              onPress={clearUrl}
              hitSlop={8}
              accessibilityLabel="Clear URL">
              <Text style={[styles.clearButtonText, { color: isDark ? '#bbb' : '#666' }]}>×</Text>
            </Pressable>
          )}
        </RNView>
        {urlFocused && (
          <Pressable onPress={() => Keyboard.dismiss()} hitSlop={6}>
            <Text style={styles.doneButtonText}>Done</Text>
          </Pressable>
        )}
        <Pressable style={styles.goButton} onPress={go}>
          <Text style={styles.goButtonText}>Go</Text>
        </Pressable>
        <Link href="/modal" asChild>
          <Pressable style={styles.gear} hitSlop={10} accessibilityLabel="Settings">
            {({ pressed }) => (
              <FontAwesome
                name="cog"
                size={18}
                color={isDark ? '#fff' : '#000'}
                style={{ opacity: pressed ? 0.4 : 0.7 }}
              />
            )}
          </Pressable>
        </Link>
      </RNView>

      {(loading || working) && <ActivityIndicator style={styles.spinner} />}

      <WebView
        ref={webRef}
        source={{ uri: url }}
        style={styles.webview}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        onNavigationStateChange={(navState) => setDraftUrl(navState.url)}
        onMessage={handleMessage}
        injectedJavaScriptBeforeContentLoaded={PAGE_SCRIPT}
        injectedJavaScript={PAGE_SCRIPT}
        javaScriptEnabled
        domStorageEnabled
        thirdPartyCookiesEnabled
      />

      <BottomSheet
        ref={sheetRef}
        index={0}
        snapPoints={snapPoints}
        keyboardBehavior="extend"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        backdropComponent={renderBackdrop}
        backgroundStyle={{ backgroundColor: sheetBg }}
        handleIndicatorStyle={{ backgroundColor: sheetHandleColor }}>
        <RNView style={styles.sheetInner}>
          <BottomSheetScrollView
            ref={scrollRef as any}
            contentContainerStyle={styles.messagesContent}
            keyboardDismissMode="interactive">
            {messages.length === 0 && (
              <RNView style={styles.empty}>
                <Text style={styles.emptyTitle}>WebBrain Mobile</Text>
                <Text style={styles.emptyHint}>
                  Ask the agent to do something. Tap the gear in the URL bar to add your API key first.
                </Text>
              </RNView>
            )}
            {messages.map((m) => {
              if (m.role === 'tool') {
                return (
                  <RNView key={m.id} style={styles.toolRow}>
                    <Text style={[styles.toolText, !m.ok && styles.toolTextError]}>
                      {m.ok ? '·' : '⚠'} {m.label}
                    </Text>
                  </RNView>
                );
              }
              return (
                <RNView
                  key={m.id}
                  style={[
                    styles.bubble,
                    m.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant,
                  ]}>
                  <Text style={m.role === 'user' ? styles.userText : undefined}>{m.content}</Text>
                </RNView>
              );
            })}
            {working && (
              <RNView style={[styles.bubble, styles.bubbleAssistant]}>
                <Text style={styles.workingText}>working…</Text>
              </RNView>
            )}
          </BottomSheetScrollView>

          <RNView
            style={[
              styles.inputRow,
              {
                backgroundColor: inputBarBg,
                borderTopColor: borderColor,
              },
            ]}>
            <BottomSheetTextInput
              style={[
                styles.input,
                {
                  color: isDark ? '#fff' : '#000',
                  backgroundColor: inputFieldBg,
                },
              ]}
              value={chatDraft}
              onChangeText={setChatDraft}
              placeholder="Ask WebBrain to do something…"
              placeholderTextColor={placeholderColor}
              multiline
              editable={!working}
            />
            <Pressable
              style={[styles.sendButton, !canSendChat && styles.sendButtonDisabled]}
              onPress={onSendChat}
              disabled={!canSendChat}
              accessibilityLabel="Send">
              <FontAwesome name="arrow-up" size={16} color="#fff" />
            </Pressable>
          </RNView>
        </RNView>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  urlBar: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingBottom: 8,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  urlInputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 18,
    paddingRight: 4,
  },
  urlInput: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  clearButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
  },
  clearButtonText: { fontSize: 18, lineHeight: 20, fontWeight: '600' },
  doneButtonText: {
    color: '#2f95dc',
    fontSize: 15,
    fontWeight: '600',
    paddingHorizontal: 4,
  },
  goButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: '#2f95dc',
  },
  goButtonText: { color: '#fff', fontWeight: '600' },
  gear: { width: 32, alignItems: 'center', justifyContent: 'center' },
  spinner: { paddingVertical: 4 },
  webview: { flex: 1 },
  sheetInner: { flex: 1 },
  messagesContent: { padding: 12, gap: 8, paddingBottom: 4 },
  empty: { alignItems: 'center', marginTop: 16, gap: 8 },
  emptyTitle: { fontSize: 22, fontWeight: 'bold' },
  emptyHint: {
    fontSize: 14,
    opacity: 0.6,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  bubble: { padding: 10, borderRadius: 12, maxWidth: '85%' },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: '#2f95dc' },
  bubbleAssistant: { alignSelf: 'flex-start', backgroundColor: 'rgba(127,127,127,0.18)' },
  userText: { color: '#fff' },
  workingText: { fontStyle: 'italic', opacity: 0.7 },
  toolRow: { paddingVertical: 2, paddingHorizontal: 4 },
  toolText: {
    fontSize: 12,
    opacity: 0.55,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  toolTextError: { color: '#d33', opacity: 0.85 },
  inputRow: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 10,
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
  },
  sendButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#2f95dc',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  sendButtonDisabled: { opacity: 0.35 },
});
