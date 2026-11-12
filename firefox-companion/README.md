# Firefox trusted automation (experimental)

The optional local companion connects WebBrain to Firefox WebDriver BiDi. Standard Firefox extension operation does not need it. Chrome continues to use its existing backend.

## Setup

Requires Node.js 22 or newer with the built-in WebSocket API, and a current Firefox. Tested on Firefox 155.0.1 on macOS. macOS and Linux installation is supported; Windows is not yet validated.

1. From this checkout, run `node firefox-companion/install.mjs`. This installs a native-messaging manifest and launcher for the current user. Keep the checkout and Node executable in their installed locations; rerun the installer after moving either.
2. Quit Firefox, then start it with remote automation enabled:

   - macOS: `/Applications/Firefox.app/Contents/MacOS/firefox --remote-debugging-port 9222`
   - Linux: `firefox --remote-debugging-port 9222`

   Use a separate profile if desired. An already running Firefox process may ignore startup flags. Keep the debugging endpoint on loopback; it grants browser control to local clients.
3. Load this branch's `src/firefox/manifest.json` from `about:debugging` → This Firefox → Load Temporary Add-on (or install a build containing these changes).
4. In WebBrain Settings → Bridge, enable **Firefox trusted automation**, keep the port at 9222 (or match your startup port), and select **Test connection**.
5. Use `/screenshot --full-page` to capture a complete web page, or start a new Act or Dev task. Connection failures fail the task rather than silently falling back. Ask mode does not open an automation run. Tasks can start on blank/internal tabs; document binding is deferred until authorized navigation reaches a web page.

The connection test checks the real BiDi session. It does not submit forms or send input. Disabling the setting or changing the port disconnects the helper; restart any active task afterward.

## First supported scope

- User-driven full-page PNG capture through `/screenshot --full-page`, including English/Turkish screenshot-only requests. It binds the current document independently of agent runs and does not change their ownership or handle dialogs. Navigation, layout/scroll changes, oversized pages and truncated captures fail explicitly. The capture covers the loaded document without scrolling to load more content. Large images use chunked native replies below Firefox's per-message limit. Capture-time privacy scans gate model attachment; an unscannable page can still be previewed/saved locally.
- Session connection through Firefox native messaging to loopback BiDi; no arbitrary protocol or script tool exposed to the model.
- Coordinate clicks preserve the validated CSS viewport point and recheck that point against the bound element before dispatch. Pre-dispatch validation failures retain `noDispatch:true`; transport failures and failures after input remain uncertain and unsafe to replay.
- Trusted clicks (`click`, `click_ax`), hover, text (`type_text`, `type_ax`, `set_field`), and existing supported `press_keys` keys/repeats. Native selects retain their existing semantic selection path. Drag/drop and dedicated iframe tools retain their existing implementations.
- Typing dispatches one character at a time, checking run ownership, deadline and focus before each step. Stop prevents the next step; a single already-dispatched character can still arrive. Newlines use a literal editing command, never Enter; single-line fields reject multiline payloads before clearing.
- Exact value readback after typing. `set_field` submits with Enter only after verification. An uncertain dispatch is not safe to repeat automatically.
- Active-run dialogs: acknowledge alerts; dismiss confirmations and prompts; stay on beforeunload unless an explicit navigate action is in progress. A Leave allowance is single use. This prevents prompts from hanging input without blanket approval of destructive confirmations. Idle tabs are not auto-handled. Pending dialog events are retained and handled when a task takes ownership; manually closed dialogs are discarded. Browser permission dialogs and arbitrary operating-system dialogs are outside this scope.
- Saved downloads (capability `saved_download`): `readSavedDownload` reads a completed download's bytes from the path the browser recorded for it, for an open run only. It must be a regular file, opened without following a link and bound to the file the check saw, that still has the recorded size and does not change while it is read, and at most about 24 MB, which is what a reply can carry within the 32 MiB native transfer limit. `upload_file({downloadId})` attaches those exact bytes. With an older companion, without trusted automation, or for a larger file (up to the 25 MB upload limit), the extension fetches the file again from its address and refuses bytes whose size differs from the saved file.
- Vision mode's point input (capability `point_input`, which `connect` reports): `click_at` (one left click) and `hover_at` at a whole-pixel CSS point of the run's top document, rechecked against the element the extension marked there. A drag, a wheel, a right, middle or repeated click and a point over an embedded frame or inside an open shadow root stay synthetic; a BiDi wheel scrolls only the window's selected tab. With an older companion, which reports no capability, all vision input stays synthetic.
- Uploads keep the existing WebBrain attachment/download/picker authorization. Bytes are written to a private temporary file, passed to `input.setFiles`, and the file input's name and size are checked. The input must be unique, enabled, and in the current document's light DOM. Attachment is not proof the site has uploaded or submitted the file. Arbitrary model-supplied filesystem paths are not accepted.

Target markers bind the extension-selected page element to a BiDi shared node. Duplicate or stale bindings fail. Existing permission, recipient, toolbar and dispatch guards run before target preparation. Native input rechecks connection, run ownership, and target visibility before dispatch. Page DOM is not a security boundary against a hostile page rearranging itself between validation and input; existing prompt-injection and action-authorization checks remain necessary.

The host stores temporary upload files only for its connection lifetime and deletes them on normal shutdown. A forced process kill can leave `webbrain-bidi-*` directories in the OS temporary directory. It does not log file bytes or typed text. Only the extension ID `webbrain@esokullu.com` is allowed to connect to the native host.

## Testing

- `npm run test:firefox-bidi`: deterministic screenshot transfer, document binding, privacy gating, cancellation, disconnection and dialog regressions (also in `npm test`).
- `npm run test:firefox-bidi:e2e`: starts an isolated headless Firefox profile and local fixture, exercises the production BiDi session, verifies full-page pixels, large image transfers, below-fold privacy geometry, PNG saving, `isTrusted`, dialog dismissal, exact typing, and uploaded bytes, then removes the profile. Set `FIREFOX_BINARY` if Firefox is not in the macOS default location. It also temporarily installs the packaged extension and exercises its content-script target preparation. The isolated test enables system access solely to inspect its extension Settings page; normal companion use does not need that flag. It does not install the native host in your normal browser profile.
- `npm run test:firefox-vision:e2e`: vision mode's content-script input in an isolated headless Firefox, then its trusted `click_at` and `hover_at` through this session on the element the content script marked. Set `FIREFOX_BINARY` as for the test above.

## Uninstall

Disable trusted automation in Settings and close active tasks. Remove `one.webbrain.bidi.json` and `webbrain-bidi` from:

- macOS: `~/Library/Application Support/Mozilla/NativeMessagingHosts/`
- Linux: `~/.mozilla/native-messaging-hosts/`

Restart Firefox without the remote-debugging flag when it is no longer needed.
