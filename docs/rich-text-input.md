# Rich-text input

DraftJS is a React rich-text editor. Its application document owns the rendered
text nodes, so inserting an HTML wrapper or replacing `textContent` can corrupt
the editor or show the same text twice while the saved document differs.

The October 11 regression came from `50c8d73ad`, which moved `type_ax` and
`set_field` from trusted input to generic HTML insertion for editors that were
not recognized as ProseMirror. DraftJS reached that path. Its old test fixture
rebuilt the DOM on input, masking the conflict with React-owned document nodes.

DIV identifies managed editors by their editor markup, independently of the
site: DraftJS, ProseMirror, Slate, Lexical, Quill, CKEditor, TinyMCE and CodeMirror.
These editors bypass generic HTML insertion and DOM replacement. Chrome uses
ref-bound browser input; iframe preparation and verification stay in the original
frame. Legacy iframe setters refuse managed editors instead of changing their DOM.

DraftJS multiline edits use its public plain-text paste handling. A single paste
lets the editor create its own document blocks, preserving blank lines and literal
markup without sending Enter or changing the system clipboard. Both replacement
and append require exact full-document readback in the original element and scope.
Cancelled, ignored, changed or unavailable results never trigger a second write.
Focus preparation and the paste use the existing task-bound monitor fences;
the internal AX paste route shares `type_ax` input ownership.

Firefox trusted automation uses the same strict DraftJS and ProseMirror document
readers before and after input, including empty caret placeholders and paragraph
boundaries. ProseMirror text uses one public plain-text paste into the pinned
selection, so a replacement does not briefly clear the draft and disable sibling
controls before inserting its new value. Empty clears use one native deletion.
The original editor, document, root, selection and task fences remain required.
Without a supported transport, DIV leaves the draft intact and explains how
to enable trusted automation. Chrome canonicalizes CRLF and CR to LF before its
single native insertion, preventing carriage returns from becoming extra spaces.

When the browser blocks Enter after verifying a draft, that draft proof is
retained separately from submission. A pending chat send still requires fresh
observation and its existing reconciliation flow before another mutation; the
typed value alone cannot certify delivery or authorize an automatic resend.
Explicit Chrome native-chat clears retain an empty-caret receipt only after
both the trusted browser delete and a private content receipt certify the same
editor, document and conversation. Synthetic input, changed ownership and
authored or generic line-break nodes cannot grant that empty state.

Regression tests use the actual React/DraftJS libraries and compare application
EditorState, rendered document blocks and saved POST data. They cover replacement,
append, clear, multiline text, Unicode, literal markup, iframe ownership and lost
responses. Additional fixtures check that managed editors cannot reach legacy DOM
setters and that ordinary editors preserve their exact text and formatting.

Input transport and action ownership are separate checks. A visible editor can
still be rejected before typing if its surrounding composer has no verified
owner. X's inline home composer exposed this second gap: it has no form or dialog,
and binding the whole home timeline would make unrelated feed updates invalidate
every action. DIV instead binds the local native editor, publishing control,
audience and matching local/navigation account links. It observes those identities
before a decision and rechecks them before dispatch; feed counters stay outside
the composer. Focus that reveals new audience controls requires a fresh observation.

The shared ownership check also supports explicitly named forms, sections and
regions without a heading, using complete local label and control coverage.
Bounded owners bind visible image resources as well as text and controls,
so an unnamed account avatar can change neither silently nor outside observation.
Those images are exposed as value-free visual inventory; their sources stay in
the private comparison. An arbitrary toolbar or unnamed container does not gain
an owner merely because it contains an editor.

Bluesky regression fixtures use real ProseMirror EditorView/EditorState and the
composer schema, clipboard parser, placeholder and native controls from
social-app commit `46d98dd457a197cee8502863b420222508f29fa6`. They compare the
application document and saved request with exact replacement, append, multiline,
Windows line endings, Unicode, whitespace and empty-clear requests in both
browsers. They cover a dialog and generic named form, region, section and headed
main boundaries. Installed Chrome extension tests also run the complete X and
Bluesky typing, local publication and fresh completion-proof flow. These are
owned local fixtures; no live account is used or posted to.

Chrome replacement selection is checked independently of ProseMirror's paragraph
text reader, so headings, lists and blockquotes can also be replaced. Full native
selection must cover empty blocks and inline atoms as well as text; an intercepted
partial selection leaves the original application document intact.

A write whose text went out but whose settled value cannot be confirmed is
reported, not locked. Editors without a document reader are read back through
`innerText`, the rendered layout: GitHub's CodeMirror shows every blank line
twice and omits off-screen lines, so a correct file never reads back exactly.
By default such a write returns `success: true`, `unverifiedWrite: true`
(`verified: false` when the readback differs) and a note in `guardAdvisories`;
`readbackExact: false` marks the rendered-text fallback. Later writes to that editor are not refused,
the loop detector does not count the write as a failure, and a browser batch
continues. Editor proofs are still dropped, so a commit or publication gate never
treats the write as verified; the agent keeps a non-blocking record for those
gates (`_unverifiedTextWriteRecord`). `set_field({submit: true})` still withholds
its Enter for an unverified value and says so (`submitSkipped: 'value_unverified'`).
Settings → Advanced → Strict checks restores the failure result, the text-write
debt and its readback-only recovery lock (see `test/guard-advisory-writes.mjs`).

When context verification or repeated page changes prevent the next action,
the task shows a specific explanation and Give up / Retry choices. Retry keeps
completed progress and verifies the current page again using the normal checks.

Run the focused suite with:

```sh
node --test test/rich-text-frameworks.mjs test/cdp-managed-text-selection.mjs test/firefox-rich-text-readback.mjs test/draftjs-text.mjs test/iframe-preparation-focus.mjs test/contenteditable-literal.mjs test/contenteditable-beforeinput.mjs
npm run test:composer-context
```
