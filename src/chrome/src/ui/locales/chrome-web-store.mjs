// Shared English fallback for the opt-in release integration. Keeping these
// specialized developer terms consistent avoids mistranslating OAuth/API
// identifiers while preserving complete locale dictionaries.
export default {
  'st.skills.cws.heading': 'Chrome Web Store release setup',
  'st.skills.cws.desc_html': 'These settings appear only while the packaged release skill is enabled. Create a Google Cloud OAuth <strong>Web application</strong>, enable the Chrome Web Store API, and register <code>http://localhost:1457/auth/callback</code> as an authorized redirect URI. Credentials, tokens, and ZIP bytes stay in extension-local storage and are never included in model prompts or traces.',
  'st.skills.cws.publisher_id': 'Publisher ID',
  'st.skills.cws.item_id': 'Item ID (32-character extension ID)',
  'st.skills.cws.oauth_client_id': 'Google OAuth client ID',
  'st.skills.cws.oauth_client_secret': 'Google OAuth client secret',
  'st.skills.cws.redirect_help': 'Authorized redirect URI: http://localhost:1457/auth/callback',
  'st.skills.cws.save': 'Save setup',
  'st.skills.cws.connect': 'Connect Google',
  'st.skills.cws.signout': 'Disconnect',
  'st.skills.cws.saved': 'Chrome Web Store setup saved locally.',
  'st.skills.cws.connected': 'Google OAuth is connected for Chrome Web Store access.',
  'st.skills.cws.disconnected': 'Google OAuth is not connected.',
  'st.skills.cws.signed_out': 'Google OAuth tokens removed.',
  'st.skills.cws.connect_failed': 'Could not connect Google OAuth.',
  'st.skills.cws.package': 'Release package (.zip)',
  'st.skills.cws.package_empty': 'No release ZIP selected.',
  'st.skills.cws.package_selected': '{name} · {size} KB · stored locally',
  'st.skills.cws.package_ready': 'Release ZIP is ready for the trusted upload tool.',
  'st.skills.cws.clear_package': 'Clear selected ZIP',
  'st.skills.cws.package_cleared': 'Selected release ZIP removed from local storage.',
  'st.skills.cws.package_zip_only': 'Choose a .zip release package.',
  'st.skills.cws.package_too_large': 'The ZIP must be between 1 byte and 100 MB.',
};
