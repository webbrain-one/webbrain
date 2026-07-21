# Chrome Web Store release

Use the official Chrome Web Store API for the configured existing extension. This skill is opt-in and disabled by default because upload and publish are consequential release operations.

```webbrain-skill
{
  "summary": "Check, upload, and submit an existing Chrome Web Store item through trusted built-in release tools.",
  "modes": ["ask", "act"],
  "intents": ["chrome-web-store-release", "extension-publish"]
}
```

## Rules

- On `chrome.google.com/webstore/devconsole`, never retry DOM, accessibility-tree, script-injection, or debugger tools. Chrome protects that dashboard from extensions.
- Use `chrome_web_store_status` for current published, submitted, and upload state.
- Use `chrome_web_store_upload` only after the user has selected the intended ZIP in Settings → Skills. The tool never accepts a model-supplied local path or raw bytes.
- After uploading, call `chrome_web_store_status` and inspect the reported version/state before publishing.
- Use `chrome_web_store_publish` only when the user explicitly wants to submit the uploaded package for review. Leave `deploy_percentage` unset unless the user specified a rollout.
- `publish_type: "default"` publishes after approval. Use `"staged"` only when the user explicitly wants approval without automatic publication.
- Publishing uses `blockOnWarnings: true`. Report warnings instead of bypassing them.
- Never claim upload or submission succeeded from the request alone. Verify with `chrome_web_store_status` after every mutation.

OAuth tokens and package bytes remain in extension-local storage. Tool results expose only store responses and package metadata, never tokens or ZIP contents.
