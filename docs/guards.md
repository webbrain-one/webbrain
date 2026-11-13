# Guards

A guard is WebBrain code, not the user, that refuses, defers or stops a tool
call, a write, a submit or a completion. Every guard is registered in
`src/*/src/agent/guard-policy.js` with a class and what it does when it knows
the action is wrong (`onDecided`) and when it cannot tell (`onCannotDecide`):
`block`, `ask` or `advise`. The file is shared verbatim by both builds.

## Enforce action guards

Settings → Advanced → **Enforce action guards** is on by default in Chrome and Firefox. Each run reads the switch when it starts. Switching it off gives the model control over browser actions such as sending, retrying, deleting and publishing. A Send click, Enter or `chat_send` can then reach the visible chat without WebBrain checking the recipient or blocking a possible duplicate. Only an observed delivery receipt confirms delivery.

**Lean mode** independently controls how much of its work the model verifies itself. **Strict checks** controls how quality checks handle uncertainty while enforcement is on. Site permissions, explicit submit confirmation, browser access restrictions, Stop and run budgets apply with either setting. Scheduled jobs still reconcile an interrupted action before automatic replay, and managed bots still use the remote service’s action reservations.

The trace records this preference as `enforce_action_guards`. The guarded WhatsApp flow accepts a full international number starting with `+` or `00` and asks for the country code when given only a local number.

## The policy with enforcement on

- **Only the hard list refuses.** Five classes may refuse an action outright:
  the wrong recipient (`recipient`), deleting data (`deletion`), spending
  money (`money`), credentials (`credentials`), and publishing or sending
  something the user did not ask for (`unrequested_publication`). When a hard
  guard cannot decide, it asks the user on WebBrain's own card where one
  exists (`ask`), and refuses otherwise. A hard guard asks even when it knows
  only where the owner chose a card over a refusal (`test/guard-policy.mjs`
  lists them): `credential-not-provided` asks before typing a sign-in
  password the user never gave, because the places it reads are not all the
  places a user can give one (a test form's documented login, a password kept
  where WebBrain does not look). A wrong refusal then costs one click instead
  of a stuck run, and a guessed password is still never typed unasked.
- **Everything else advises.** Verification, exact readback, evidence and
  completion checks are `quality` guards. They tell the model about the
  problem instead of stopping it:
  - A tool call goes through, and its result starts with
    `guardAdvisories: [{ guard, note }]`, so a truncated result keeps them. A
    note is dropped when another check then refuses the call, because nothing
    went through.
  - A completion guard refuses a `done` or a plain final once per run, and
    that refusal is its note. Each guard gets its own: when two apply, the
    second is checked once the first has advised. The next completion a guard
    would refuse is accepted, and the final answer ends with one line,
    "WebBrain could not verify everything: …" (at most four items). An
    exact table delivered from its `data_ref` stays the complete JSON its
    contract promises: the line goes beside it, as a warning and as the
    done result's `completionCaveat`.
  - A completion accepted over a guard that knows the claim is wrong (the
    completion judge's "not done", an unauthorized mutation, missing, failed
    or unfinished progress rows, unread pages of a whole thread the user
    asked for, text that went into a formatting toolbar, an exact table that
    can no longer be delivered, a field read back as another value than was
    written to it, an arithmetic result claimed before the calculator ran, or
    a requested video that is short, unjoined or undelivered)
    ends the run as `partial`, not `success`, whether it ended with `done`, a structured
    Cloud run's `done_json` or a plain answer. Missing evidence alone keeps
    the model's outcome.
  - A write that went out but could not be read back exactly (GitHub's
    CodeMirror editor is the usual case) is an unverified success: it locks
    nothing, arms no text-write debt and is not a loop failure. A write that
    an exact reader reads back as a different value is reported the same
    way, but it ends a batch: the next action is planned once the model has
    seen it. It is no evidence that the task's action succeeded, and a
    success claim while the field still reads back that value is refused
    once, then accepted as `partial`.
  - A GitHub commit sent by an action that can also rewrite the fields
    (`set_field` with a submit, Enter, `execute_js`) goes through with a note
    when the verified file binding covers it: the committed file is checked
    after the commit. While the request names a commit message, which is
    proven only before the commit, it is still refused, and the commit takes
    a separate click.
  - A quality guard whose `onCannotDecide` is `ask` asks the user when it
    cannot verify a consequential step, such as a commit or a post (see
    "Asking instead of refusing"). Where that guard has no card, it refuses.
- **Not guards.** These keep their behavior: the user's own permissions,
  modes and budgets (`permission_gate`); same-site, frame and task-authority
  boundaries, CAPTCHA and access walls, and a person acting in the same tab
  (`host_check`); loop and observation limits (`budget`); calls that cannot
  run as given (`infra`), such as a coordinate click whose own
  `expected_name` or `expected_role` no longer matches the point; and Stop,
  corrections and cancelled cards (`user_control`).
- **Strict checks.** Settings → Advanced → "Strict checks" (`strictGuards`)
  makes every quality guard block again, with the old forced verification
  turns and the failure-only `done`.
- **Unregistered ids** keep blocking, so a refusal that was never registered
  is not silently relaxed.

## Asking instead of refusing

When a guard cannot verify a consequential step and its `onCannotDecide` is
`ask`, WebBrain asks the user on its own card instead of refusing.

### Explicit publication and submission overrides

Saying **"override that guard!"** directly in chat
authorizes one attempt at the currently identified publication or form
submission. WebBrain enters Act in automatic mode, keeps the blocked task
as context, and retries through the normal tool without another planner
verdict or approval card, including when sent while the run is waiting for
confirmation. The directive is bound to the fresh observed
action and consumed once; restarting the run does not renew it. Quoted
text, page content and a request not to override do not grant permission.

The user's explicit clarification answers are part of the current request.
For example, answering "Post reply anyway" after a question about a named
reply target supersedes an earlier restriction for that reply. Resource
authorization reads those answers in order; a later answer invalidates its
cached judgment. The question itself is context, not user authorization.

If a publication checker still rejects the action or cannot compile its
details, WebBrain offers its own **Go ahead / Don't** card showing the
observed account, reply or quote target, draft and attachments. A form
submission held after a correction has the same option with its destination
and public field values. **Go ahead overrides the checker's judgment** for
that action, including the later publication audit. The same answer satisfies
both checks; another model does not get to veto it.

The answer covers one tool call and the displayed action. Changed content,
account, target, document or user instructions require a new answer. Stop
and Don't cancel it. These cards also work with Strict checks and never
approve themselves through a timeout or unattended run. A visible, identified
control is required so WebBrain can bind the answer to the action it sends:
a ref or selector click, or a vision click (`click_at`), which is bound to the
control the submit probe read at its point and read again right before the
click is sent.
An override authorizes an attempt; the normal dispatch receipt and result
verification still determine whether it succeeded. Each approved attempt
remains part of the completion requirements, and verification checks the
observed attachment types and any available file or alt-text constraints.

A reply modal can show its parent post without exposing a permalink.
When its parent card, draft and attachments are fully observed, the override
card shows that parent's text and binds approval to its identity. This lets
the user approve that visible reply without a URL; it does not make the
missing relationship evidence count as verified publication.

- **The card.** A question ("Commit this on github.com?"), why the step could
  not be verified, and what the page shows now: the editor or composer text,
  plain text, at most about 1,500 characters. That text is page content: the
  side panel renders it with `textContent` only, and it never reaches the
  model. When there is nothing to show, the card says to check the page.
- **Answers.** Two fixed values, "Go ahead" (`once`) and "Don't" (`deny`). A
  "Go ahead" covers one tool call and the content the user saw: every check
  that call runs sees it, and it is spent when the call ends, sent or not, so
  the next attempt (a repeated commit or post included) asks again. Changed
  content is asked about again, and a declined step with the same content is
  not. The content is checked again right before the step is sent, after any
  later submit or permission card: if it changed while a card waited, the
  step is refused there and the next attempt asks. When the checks after a
  "Go ahead" reach another guard's question about the same action, that card
  is asked in turn and the first answer stands.
- **Timeout.** A quality guard's card follows Settings → Budgets: the clarify
  timeout (Off waits, Instant answers at once) and "When a question times
  out" (`finish` goes ahead, `safe` does not). A hard-class card never times
  out and never goes ahead on its own, like the recipient and deletion cards.
- **Unattended scheduled runs** cannot show a card: a quality guard follows
  the timeout policy at once, a hard-class guard refuses.
- **Authority.** A timeout, Instant or unattended answer is WebBrain's, not the
  user's: it is never recorded as task authority or memory.
- **Strict checks.** Quality guards keep their refusal and show no quality card.
  An identified publication can still use the explicit publication override.
  Hard-class asks apply in both modes, because they replace a dead end with
  the user's explicit decision.
- **After `once`.** The tool result carries a note for the model. A commit or
  post made this way is marked `publishesUnverifiedContent: true` on its submit
  receipt; the checks after the submit (GitHub's committed raw-file check, the
  published-post check) stay the authority. A `clickax-task-click-lock` answer
  covers one click that is actually sent: the target's lock is released only
  as that click is dispatched, so a correction, Stop or refusal before it
  keeps the lock, and the next click on the target asks again.

| Guard | Asks when | The card shows |
|---|---|---|
| `github-commit-evidence-binding` | The file editor was replaced but could not be read back exactly (CodeMirror), and path, branch and commit message bind | The editor's text |
| `github-commit-split-write-required` | A script, Enter or `set_field` submit that may or may not commit, when a commit click would be allowed and the request names no commit message (one is proven only before the commit) | The editor's text |
| `social-publication-draft-quality` | The X/Bluesky draft's text does not read back as requested or could not be read, when the user asked to publish (the publication audit still runs). Other mismatches use the hard publication override when the composer is fully observed | The composer's text |
| `steer-prior-submission-target-unresolved` | After a correction, a submit-capable control the probe could not identify | Nothing (check the page) |
| `clickax-task-click-lock` (hard, Chrome) | An earlier trusted click on the same target may have landed and was never verified | Nothing (check the page) |
| `social-publication-authorization-guard` (hard) | A publication's authorization, contract, preflight or audit refuses an identified draft | Account, reply/quote target, draft and attachments |
| `steer-post-correction-commit-guard` (hard) | A form submission after a correction cannot pass the resource authorization checks, or its resource cannot be resolved | Destination and public field values |
| `credential-not-provided` (hard, asks when it knows) | Text the model chose for a sign-in password field is not a password the user gave | The text masked (its first character and a dot for each other one; only dots under four characters), or nothing with strict secret handling |
| `click-duplicate-submit` (hard) | A text click repeats a commit or publish caption clicked on the same URL within 45 seconds | The control's caption |
| `deletion-guard-refusal` (hard) | A Delete or Remove control sits outside one identifiable record (toolbar, bulk, selection) | Nothing (check the page); the buttons are Delete / Don't delete |
| `deletion-guard-refusal` (hard, on the deletion card) | After a correction, an identified item that an earlier attempt may already have deleted | The item, as on any deletion card |
| `steer-prior-submission-unreconciled` (hard) | After a correction, a write WebBrain sends itself: an API mutation or `chrome_web_store_publish` | The request: method and address, and the body it sends (for a `fetch_url` replay with no body of its own, the captured body) unless strict secret handling is on; a replay `fetch_url` would refuse gets no card |
| `recipient-guard-refusal` (hard) | A text send whose recipient the page does not name, with a readable draft | The draft |

### Hard-class asks for dead ends

The last five rows, and the vision click, exist because a refusal there ended
the run where the user could have settled it by looking at the page. Each of
these cards is hard: it never times out, never goes ahead on its own, and an
unattended run or a caller without a card channel is refused at once. One
answer covers one tool call.

- **Vision clicks.** The publication and submission override card is offered
  for a vision click as it is for a ref or selector click. A different control
  at the point when the click is sent is refused
  (`resource_changed_before_dispatch`), and the next attempt asks again.
- **A form commit whose resource cannot be resolved** (`resource_unresolved`
  after a correction) gets the override card. Typing "override that guard!"
  already covered this case; the card was not offered.
- **A repeated commit or publish click.** The first click may or may not have
  taken effect, and WebBrain cannot tell. "Go ahead" lets that one click
  through and records it again, so a third click asks again. The click
  handler keeps its own check for callers without a card. No model argument
  lets a repeat through: the `_allowResubmit` argument the refusal used to
  name was never accepted by the click schema.
- **A Delete or Remove control outside one record.** The control is
  identified, its items are not, so the card names no item and says to check
  the page. The answer covers one click on that control in that document. The
  site's own confirmation dialog is asked about separately when its button is
  not bound to a record either.
- **An item an earlier attempt may already have deleted.** It is identified,
  so it goes to the deletion card with its own reason. The answer holds for
  that item for the rest of the task, like any answer on that card.
- **A write WebBrain sends itself after a correction.** No page read can show
  whether an API request repeats the earlier submission, so it used to be
  refused for the rest of the task. One answer covers one call with exactly
  those arguments; each further write asks again.
- **A message whose recipient the page does not name**
  (`recipient_identity_unavailable`). The user can see who the conversation
  is with. "Go ahead" covers that one send: the page binds it to the composer
  and the draft the user saw, and a recipient that becomes readable before
  dispatch stops it. It is asked only for a text send from the tool batch.
  `chat_send`, uploads, an unreadable draft, and sends through a script, frame
  click or drag still refuse.

### The sign-in password card

`credential-not-provided` pauses a model's `set_field`, `type_ax`,
`type_text` or `iframe_type` before anything is typed and asks "Type this
into a sign-in password field on {host}?", saying the text is not a password
the user gave in this conversation, their profile or their saved notes.
{host} is the field's own site: the tab's for the top frame, a subframe's
own for a field in a frame (`_credentialTargetHost`), so a sign-in iframe
from another origin is named by its host, and an answer kept for the page
does not cover it. A frame at `about:blank` or `about:srcdoc` has the site of
the frame above it, and the top frame's comes from the tab's address by the
same rule. Without a frame from the preflight, the guard asks each frame for
the field on its own, and the frame that holds it names the site. A write
the dispatch sends to another field than the one the preflight resolved
(Chrome's focused `type_text` whose field lost focus types into the field
focused now, and a `type_text` selector the preflight did not pin types into
its current match) is checked again against that field before it types, and
a `type_text` with no selector against the field it types into (in Firefox
the field the last click focused, when focus has since gone to the page or to
that field's own component). A field
whose site cannot be read (a `data:` frame, a frame that is gone, a top page
at `about:blank` or `data:`, a selector that names a sign-in field in two
frames) is refused without a card. The
buttons are **Type it** (`once`) and **Don't type it** (`deny`), numbered like
the other cards. Like the submit confirmation card, which shows a password
field's value as `[password redacted]`, it never shows the text in full. A
Cloud run's update log, which replaces typed text with `[redacted typed
text]`, still holds the masked preview of a card it relays.

- **Type it.** The call runs again through the same typing-target preflight,
  outside the action deadline the card waited beside, and types only while
  its target is still the field and site the card named (the field's tag,
  name, id, autocomplete and labels, and its frame). A changed target types
  nothing (`credential_field_changed`, retryable). The text then counts as
  given on that site for the rest of the run, so the same text there does not
  ask again; other text, another site (another frame's included) or a new
  run asks again. The result carries a note that the user approved it on
  the card.
- **Don't type it.** Nothing is typed, and the result is the refusal the
  model already knew (`credential_not_provided`, `noDispatch`,
  `retryable: false`), saying the user declined: ask for the credentials or
  end the run as partial. The same text on that site in the same run is
  refused without another card. The card has no countdown; a timeout answer
  posted for it anyway counts as Don't type it.
- **Stop or a correction** cancels the card like any other card.
- **Who can answer.** The card never times out. The side panel shows it, and
  a scheduled run persists it so a reopened panel restores it. Cloud runs
  report it as `needs_user_input` with `promptKind`
  `unverifiedStepConfirmation`, and the MCP server relays it with
  `allowed_answers: once, deny` and the masked text in `structured_prompt`;
  the caller answers with `cloud_respond` / `webbrain_respond`, or cancels the
  run. An unattended scheduled run, or a caller without a card channel,
  cannot ask, so it refuses at once and does not wait.
- **Strict checks and lean mode** keep the card: the guard is hard-class.
  Saved workflow replays are not checked, and page text is never a source.

Code: `_promptUnverifiedStepConfirmation` and `_resolveUnverifiedStepConfirmation`
in `agent.js`, `agent/unverified-step.js` (shared by the agent, scheduler
persistence and restored cards), and the `unverifiedStepConfirmation` branch
of `renderClarifyCard` in `ui/sidepanel.js`. The asks for dead ends:
`_publicationGuardOverrideRequest`, `_duplicateSubmitClickAsk`,
`_unboundDeletionAsk`, `_priorSubmissionWriteAsk` and
`_unreadableRecipientStepKey` in `agent.js`. The sign-in password card:
`_unprovidedCredentialBlock`, `_approvedCredentialTargetBlock`,
`_retargetedCredentialBlock` and `_resolveCredentialConfirmation` in
`agent.js`, called from the tool batch
after the call's action pipeline returns. Tests: `test/guard-ask-cards.mjs`
and `test/credential-not-provided.mjs`.

## What still refuses, and why

| Class | Guards | Why |
|---|---|---|
| `recipient` | `chat-send-recipient-guards`, `native-chat-receipt-not-durable`, `preparation-timeout-recipient-preflight`, `recipient-active-conversation-pin`, `recipient-dispatch-binding-revalidate`, `recipient-guard-refusal`, `recipient-mismatch-confirm-card`, `schedule-resume-chat-state-not-durable`, `social-preflight-context-mismatch` | A message to the wrong person cannot be taken back. A resumed run without a durable receipt would send a delivered message again. |
| `deletion` | `deletion-confirm-card`, `deletion-guard-refusal`, `preparation-timeout-submit-preflight`, `truncated-preview-replacement`, `unsaved-changes-data-loss` | Deleted data, including a field value replaced by its own shortened preview, is gone. |
| `money` | `captcha-paid-solve-protection` | A paid solve spends the user's balance. |
| `credentials` | `chat-user-input-required`, `credential-not-provided`, `otp-mailbox-scope`, `strict-secret-credential-handling` | One-time codes, passwords and payment details are the user's to enter. A guessed sign-in can lock the account or count as an unauthorized attempt. `credential-not-provided` checks an existing account's password field: autocomplete `current-password`, a field naming the current password, and any lone password field (one not marked as a new or repeated password, a key or token, or a field of a form that creates an account; `new-password` does not mark a form's only password field as new when the form signs in, as forms that stop autofill that way do; a second password field of its form counts only beside a field naming the account or a "Log in" button, as a sign-in's PIN does), with or without sign-in evidence (a field naming the account, a "Sign in", "Next", "Verify" or "Confirm" button, a sign-in label), except one that names a network's key such as a Wi-Fi password (not a "Network password"); a field in a web component counts with the form around the component. It checks the text against what the user gave: their messages, attached files, clarify answers, the WebBrain profile, memory notes they wrote (not auto-captured ones), MemCode recall and passwords WebBrain set for an account it created on the same site (`docs/security-model.md`). Text from none of those is typed only after the user's "Type it" on WebBrain's card ("The sign-in password card" above). |
| `unrequested_publication` | `bot-memory-reservation`, `click-duplicate-submit`, `clickax-task-click-lock`, `consequential-durability-checkpoint`, `github-conditional-commit-unbound`, `recipient-guard-unrequested-send`, `sched-reconciliation-required`, `social-api-publication-route`, `social-publication-audit`, `social-publication-authorization-guard`, `steer-post-correction-commit-guard`, `steer-prior-submission-unreconciled` | A post, commit, submit or send the user did not ask for, or a second copy of one that may already have gone out, is public or hard to undo. |

A guard listed here still refuses in every case that "Hard-class asks for
dead ends" above does not name: a decided case (a duplicate, a request that
forbids the action), an action WebBrain cannot identify (a script, a key
press, an unfinished probe), a storage failure, and any run where nobody can
answer a card.

After a correction, `steer-post-correction-commit-guard` and
`steer-prior-submission-unreconciled` hold a post, commit or submit until
WebBrain has matched what the attempt before the correction did, or the
user explicitly approves that identified action on the override card. A deletion
is not held to that, because it cannot repeat that attempt: the latest
request, or the user on WebBrain's deletion card, decides which item goes. A
Mastodon post is one WebBrain cannot match after the fact (the home timeline
shows it, not a page of its own), and "now delete it" used to be refused on
every click there.

A public composer carries no recipient. X's compose routes (posts, articles
and their drafts under `/compose/`) match the generic mail-and-chat rule,
which reads any `/compose/` route as a recipient surface. The probe's
geometry rule then read the Post control beside the composer as a send, and
with no identity to read, every Post click was refused as
`recipient_identity_unavailable`. An adapter's `messaging.publicComposer` now
marks the route's policy `publicComposer`, and an ordinary control there (a
click, Enter, a field submit, an upload) is not checked against a recipient in
live runs or saved workflow replay: the submission and publication checks
decide what is published. A script, frame click or drag is still refused on
the route, since nothing binds what it does on the page, and a send already
bound to a recipient keeps its check.

A deletion stays bound to the item's text, with each `<time datetime>`
element read as its datetime rather than as the relative time it shows.
Mastodon's "8 min" turning into "9 min" while the user decides on the deletion
card is the same post, but edited text or another datetime is not. Before
this, the check after the card refused such a deletion as `resource_changed`,
on every retry.

The `permission_gate`, `host_check`, `budget`, `infra` and `user_control`
entries in the registry document checks that are not guards; they are listed
there so the registry covers every refusal.

## Adding a guard

1. Prefer not to. Fix the routing, the prompt or the adapter first, and
   check that the problem is not a reader that cannot see what the page
   shows (the CodeMirror readback was one).
2. Register the id in `guard-policy.js` with its `class`, `family`,
   `decides`, `onDecided`, `onCannotDecide` and a one-line `summary`. A check
   that only lacks evidence is `quality`, whatever it protects.
3. Declare `mustNotBlock: 'test/<file>.mjs#<test name>'`: a test of a
   legitimate task the guard must let through. Write it first; it is the
   guard's false-positive budget.
4. Route the decision through the agent's helpers: `_guardAdvisesFor` for a
   note on a tool call, `_guardRefusesOnce` for a completion,
   `_guardOutcome` for anything else. Test the default and Strict checks.

`test/guard-policy.mjs` enforces this: the registry's shape, that only the
hard list refuses, that every id the code names is registered, `mustNotBlock`
for every guard added after the registry (the 158 that existed then are
grandfathered, and that list only shrinks), and a ceiling on completion
refusals (`blockedDone: true`) per build.
