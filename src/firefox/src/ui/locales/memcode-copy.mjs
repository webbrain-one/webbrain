// Isolated copy for the optional integration. Untranslated locales use English
// fallback without changing the exhaustive core locale dictionaries.
export const memcodeEnglish = {
  'st.memcode.heading': 'MemCode cross-device recall (optional)',
  'st.memcode.desc': 'Local WebBrain memory stays the default. Connect your MemCode account with OAuth, then separately enable read-only recall. Search queries and matching memories go to MemCode and your configured LLM provider. Nothing is uploaded automatically. OAuth tokens stay in this browser profile in local storage and are not included in settings exports.',
  'st.memcode.read.label': 'Enable MemCode recall',
  'st.memcode.read.desc': 'Allow the agent to search your connected MemCode account using read-only OAuth scope. Results are untrusted data; this integration cannot write remote memory.',
  'st.memcode.connect': 'Connect MemCode',
  'st.memcode.disconnect': 'Disconnect',
  'st.memcode.connected': 'Connected to MemCode account {account}. Recall remains off until enabled above.',
  'st.memcode.active': 'MemCode recall is enabled for account {account}.',
  'st.memcode.disconnected': 'Not connected. No MemCode requests are made.',
  'st.memcode.error': 'MemCode connection failed: {error}',
  'st.memcode.revocation_warning': 'Local credentials were removed, but MemCode could not confirm remote revocation. Revoke this client in your MemCode account if needed.',
};
