# Native chat observation

`chat_observe` reads the active conversation as untrusted data. Generic chat
observation requires a conversation identity, an available composer and a
separate semantic transcript. Native adapters add specific, bounded DOM readers;
they do not authenticate, authorize messages or establish resolution evidence.

Telegram WebA and WebK main conversations with numeric peer routes have native
readers. WebA binds its header avatar's peer ID and transcript `data-list-key`
(`peer_-1_thread`) to the route; WebK additionally checks the native header,
composer and visible bubbles' raw peer IDs. Route-only changes during a recipient
switch fail until these agree. Other focused inputs such as chat search cannot
establish a native conversation. Topic and saved-dialog routes require a
topic-specific binding and currently fail native observation. Recognizing a
communication URL for planning does not verify a native transcript.

WebK also supports main-conversation `#@username` and `#/im?p=@username` routes
when one visible native profile independently binds that alias to the current
numeric peer. An ordinary chat uses its active right-hand profile. Saved Messages
uses the account's active native Settings self profile; its ordinary right-hand
profile does not supply the required username. The profile's exact native title
and active avatar must carry the same raw numeric peer as the current header,
composer and live transcript. Its unique native username row uses the
`mention_filled` icon (U+EAC1), rather than a translated label or a matching
display name. The alias is matched case-insensitively with an optional single
`@`; only ASCII letters, digits and underscores, at most 32 characters, are
accepted. This is a reader limit, not a username-creation rule.

Canonical identity remains `telegram:k:<numeric-peer>:0`. An alias route alone
never authorizes a send. Multiple eligible profiles or composers, hidden or
stale profiles, malformed raw peer/topic attributes and unrelated message peers
fail closed. The profile, title, avatar, username row and icon are pinned as
exact nodes through dispatch. Material replacement or change-and-return
invalidates an earlier certificate even when the final displayed text agrees;
a fresh native observation must establish a new binding. Native Settings cannot
certify a negative self peer, while an ordinary profile can bind its matching
negative numeric peer.

An unfocused, otherwise consistent native WebK chat with an unbound alias returns
`native_telegram_alias_binding_required` and read-only preparation guidance,
rather than a generic missing-chat error. Inspect the current native profile,
or the account's native Settings profile for Saved Messages, then observe again.
When an exact current native preparation control is available, the public
`nativeTelegramRepair` hint identifies `open_menu`, `open_self_settings` or
`open_profile` and a fresh accessibility reference. The control remains subject
to the private native-node, document, run and task checks; the hint cannot grant
permission to another toolbar item, composer or Send control.
This preparation does not expose a verified conversation or message transcript,
does not open UI automatically and grants no recipient authority. A localized
Saved Messages heading or `data-me-as-notes` flag cannot establish account
identity. Inconsistent native nodes or a focused search do not receive a
preparation certificate.

Cold read-only preparation can initialize its private owner only during the
current active pre-inference capture, with the original capture object, run,
document and human-intervention revisions still current. The actual click
handler carries the trusted owner, exact reference and one-use token into the
normal guarded dispatch. Public hints and model-supplied markers cannot replace
that private proof or authorize a send.

WebK permanently mounts a deletion pane with message-list classes. The reader
excludes only the native `.bubbles-remover-container >
.bubbles-remover.bubbles-inner` subtree from live transcript candidates. Two
actual live panes remain ambiguous, and a retired-only pane cannot substitute
for the live transcript. A deleted outgoing row that later changes to a sent
state cannot acknowledge a pending send.

The recipient guard reuses the same native peer and exact header/transcript
nodes, including WebK's ordinary `div.user-title`. An active conversation is
pinned to its canonical Telegram peer ID. An explicitly named recipient can
resolve through the verified visible header alias; later same-name peers cannot
inherit that task. A route/header update while the old transcript remains fails
both observation and dispatch. `test/native-telegram-recipient.mjs` exercises
startup pinning, repeated one-use dispatch, same-name peers, presentation changes
and ambiguous headers in Chromium and Firefox for both clients.

Generic guarded native Telegram sends bind completion verification to the exact
authored body, current canonical thread and a complete bounded pre-send message
ID baseline. A later `chat_observe` clears the latest send's obligation only
after a new confirmed outgoing with a higher native ID appears in that thread,
with an empty composer and no pending send or user-input gate. Old virtual rows,
other bodies, optimistic bubbles and unrelated later actions cannot satisfy it.
The independent read inside a successful `chat_send` verifies its own exact-thread
delivery; uncertain dispatch opens a verification obligation.
`test/chat-completion.mjs` covers the trusted evidence boundary and
`test/native-telegram-recipient.mjs` exercises the real guard, browser dispatch,
observer and Agent completion accounting together.

The native viewport must also be at its verified latest position: WebK requires
the native `scrolled-down` state and bottom geometry; WebA requires its newest
list-bottom marker, `with-bottom-snap` and bottom geometry. Historical views
return an exact `read_latest` pane reference for ordinary scoped scrolling and a
fresh observation. They cannot establish a send or acknowledge pending delivery.

One shared `mounted_native_id_floor` helper validates every mounted native ID
and current peer, then retains the numerically greatest 200 IDs. Empty or
media-only rows contribute to this floor without invented authored text; the
authored-message cache cannot lower it. Malformed, duplicate, foreign-peer or
pending rows leave the baseline incomplete. This certifies a latest mounted-ID
floor, not a complete history read.

The private one-use dispatch token retains that original baseline. Structured
`chat_send` additionally requires exact equality between its initial observation
and the actual recipient probe before creating or persisting pending state.
Changed, incomplete or wrong-thread baselines require a fresh observation;
preparation never silently raises or rebases the earlier send decision.

Structured `chat_send` keeps its nested field-write finalization separate from
its outer workflow result, while propagating actual dispatch ownership for Stop
and deadline accounting. A late native delivery retains its pre-send binding.
At `done`, a fresh exact native proof also satisfies the generic submit gate for
the current authorized task. A bounded receipt persists the task/run, canonical
thread, body SHA-256, confirmed message ID and latest action sequence; loading
that receipt never creates message authorization.

Each reader retains at most 200 native message rows. Authored text excludes time
and status metadata; equal text in separate native rows remains separate. An
incoming text edit has a stable content revision, allowing a new latest-message
edit to surface once. Outgoing text is observed only after the client's sent/read
state, so optimistic pending or failed bubbles cannot clear a pending send.
Attachment-only messages are not interpreted as authored text by these readers.

The long-chat kernel persists monotonic incoming and outgoing Telegram message
watermarks alongside its bounded recent ID cache. Old virtual rows remounted
after that cache expires cannot become new reply requests or fresh delivery
events. Each native pending send also persists the highest message ID observed
before dispatch; an older same-body row cannot clear an uncertain send after a
worker restart. The newest incoming message can still produce an edited
revision. Incoming messages held by a user-input gate remain unconsumed until
the gate clears. These numeric watermarks do not apply to opaque IDs from
generic observers or WhatsApp.

The DOM contracts were checked against official client source revisions:

- [Telegram WebA message markup](https://github.com/Ajaxy/telegram-tt/blob/28ffcf710b15571e5a2f7bb3bdce3fc90fc8ec80/src/components/middle/message/Message.tsx),
  [header avatar identity](https://github.com/Ajaxy/telegram-tt/blob/28ffcf710b15571e5a2f7bb3bdce3fc90fc8ec80/src/components/common/Avatar.tsx),
  [outgoing status](https://github.com/Ajaxy/telegram-tt/blob/28ffcf710b15571e5a2f7bb3bdce3fc90fc8ec80/src/components/common/MessageOutgoingStatus.tsx)
  and [hash routing](https://github.com/Ajaxy/telegram-tt/blob/28ffcf710b15571e5a2f7bb3bdce3fc90fc8ec80/src/util/routing.ts).
  The [transcript key](https://github.com/Ajaxy/telegram-tt/blob/28ffcf710b15571e5a2f7bb3bdce3fc90fc8ec80/src/components/middle/MessageList.tsx),
  [key format](https://github.com/Ajaxy/telegram-tt/blob/28ffcf710b15571e5a2f7bb3bdce3fc90fc8ec80/src/components/middle/helpers/messageListReserves.ts)
  and [transition states](https://github.com/Ajaxy/telegram-tt/blob/28ffcf710b15571e5a2f7bb3bdce3fc90fc8ec80/src/components/ui/Transition.tsx)
  also keep old inactive or animating content out of the current snapshot.
- [Telegram WebK bubbles and delivery transitions](https://github.com/morethanwords/tweb/blob/125a31da7665d5ee09ceb9c5de66e2615e3276b6/src/components/chat/bubbles.ts),
  [composer identity](https://github.com/morethanwords/tweb/blob/125a31da7665d5ee09ceb9c5de66e2615e3276b6/src/components/chat/input.ts)
  and [hash routing](https://github.com/morethanwords/tweb/blob/125a31da7665d5ee09ceb9c5de66e2615e3276b6/src/lib/appImManager.ts).
  The [native header](https://github.com/morethanwords/tweb/blob/125a31da7665d5ee09ceb9c5de66e2615e3276b6/src/components/chat/topbar.ts)
  contains an asynchronously populated `.user-title .peer-title[data-peer-id]`;
  that raw peer must agree with the composer and transcript. Native alias
  profile selectors were additionally grounded in sanitized current-client
  captures and the pinned [profile username row](https://github.com/morethanwords/tweb/blob/125a31da7665d5ee09ceb9c5de66e2615e3276b6/src/components/peerProfile.tsx#L735-L736),
  [own Settings profile](https://github.com/morethanwords/tweb/blob/125a31da7665d5ee09ceb9c5de66e2615e3276b6/src/components/sidebarLeft/tabs/settings.tsx#L364-L366)
  and [native icon definition](https://github.com/morethanwords/tweb/blob/125a31da7665d5ee09ceb9c5de66e2615e3276b6/src/icons.ts#L451).
  The same pinned [bubbles implementation](https://github.com/morethanwords/tweb/blob/125a31da7665d5ee09ceb9c5de66e2615e3276b6/src/components/chat/bubbles.ts#L1787-L1800)
  permanently constructs the retired pane, then
  [moves deleted bubbles into it](https://github.com/morethanwords/tweb/blob/125a31da7665d5ee09ceb9c5de66e2615e3276b6/src/components/chat/bubbles.ts#L4989-L4994).

`test/native-telegram-chat.mjs` runs both production observer copies and the
workflow kernel in isolated Chromium and Firefox documents whose requests are
intercepted. It covers self-chat-shaped markup, delivery transitions, repeated
text, edits, recipient switching, virtual rows, persisted restarts, native retired
panes and a simulated twelve-hour timeline. `test/native-telegram-recipient.mjs`
adds alias-profile binding and stale one-use dispatch regressions;
`test/native-telegram-alias-preparation.mjs` verifies cold unfocused preparation,
ordinary and Saved Messages guidance, fake editors, raw identity contradictions
and focused-search isolation. These are intercepted browser-engine regressions,
not evidence of a live authenticated Telegram conversation or full-history
coverage.

The current WhatsApp self-chat reader uses a sanitized structural snapshot of
the user's Web client, rather than older `.message-in`/`.message-out` selectors.
It requires the native `you-label`, one scoped title, one native composer and
one message panel. Message IDs are opaque and unordered. It accepts a single
unambiguous `selectable-text` body only after its status under `msg-meta`
reads as delivered or read, in any language ("Read", "Okundu" or "Gelesen",
read by a model: the `message_status` question); pending, unclear and unread
status labels remain unverified, and an unread one goes back to the agent to
be read before it observes again.
Nested native emoji and links remain part of their top-level authored body;
emoji text comes from `data-plain-text`, while unrelated image descriptions and
separate quoted bodies cannot become exact authored text.
Older rows while scrolled away from the live tail do not become new events or
delivery evidence.
`test/native-whatsapp-chat.mjs` verifies these limits, repeated bodies, pending
delivery, virtual history, account switching and twelve simulated hours in both
browser engines.

A native editor can handle a cancelled `beforeinput` event itself. An exact
readback can certify the resulting draft only while the original operation,
document, native identity nodes, editor, focus and selection remain current.
This proves draft presence, not delivery. Passive footer or sidebar changes do
not clear the monitor's mutation debt or revive an old action snapshot; a later
Enter or Send still requires a fresh observation and recipient binding.

Native one-to-one WhatsApp contacts use additional sanitized current-client
captures. The Agent must explicitly click the exact native contact-name control
and close its newly opened native Contact info drawer. Read-only observation
never opens that UI. Before canonical binding, it returns the exact app-owned
control reference for a fresh scoped accessibility read and guarded click. The
whole header, avatar and other toolbar controls remain blocked. The native
editor can have a generic placeholder and need not be focused or name the
recipient. A focused search or unrelated editor cannot become this observation.
The `open_contact` or `close_contact` hint identifies the exact current control;
the pointer itself grants no authority and does not establish canonical identity.
The normal page observation before inference also prioritizes this exact native
target using the private current owner and original node proof. It performs the
bounded scoped AX read before the model decides, so a correct current control
does not depend on a separate model AX call. This does not recertify a decision
after inference. The existing model, preparation, recipient and dispatch checks
still apply; Send, Escape and unrelated header controls acquire no exception.
A unique native subtitle must match the unchanged header,
and a separate unique native phone field supplies the canonical identity.
The subtitle must be plain text. Its only elements may be WhatsApp's own emoji
images (an `img` marked `.emoji`, `data-type="emoji"` or `data-plain-text`
whose text is emoji only), which the header and row titles also leave out of
their text; any other element or image fails. The
phone stays private; the public thread contains its bounded SHA-256 hash. The
selected sidebar row, main panel, header, title, composer and transcript must
remain the exact original nodes throughout. Pre-existing drawers, stale drawer
responses, same-name row recycling, selection changes and ambiguous phone fields
cannot bind a recipient. Contact names or opaque message IDs alone cannot do so.

A message action that the recipient probe blocks in a chat whose contact is not
confirmed yet carries the same exact reference (`nativeWhatsappRepairTarget`,
`open_contact` or `close_contact`), and the Agent names that control to the
model instead of telling it to re-read the page and retry. A row of WhatsApp's
own chat list, clicked on the row itself, opens another chat whatever the open
chat's state, and opens one with no chat open at all, without a model reading
the row's caption; the row's menu and other nested controls stay guarded. A run
checks one contact, for its anchor chat: the first chat it looks at, or, in a
request that names its recipient, the chat that is selected when the run arms
its check with the guarded contact-name click, so such a request can first open
the right chat. The probe reports that kind of request
(`namedRecipientSelection`); a request for the open chat itself, or a target
already pinned to a verified chat identity, never moves its anchor. Once a check
is armed, a later selection change spends it.

The drawer's close control is the named plain button that leads its header,
whatever language names it ("Close", "Kapat"): the header's one button, or,
where the header also holds actions after its title (a saved contact's drawer
reads Close, "Contact info", Edit), the one button before that title. A header
without one title, or with more than one button before it, offers none, and the
control must keep the name it had when the guarded click armed it.

Contact-drawer media loaders and the Close icon can update unrelated visual
content without changing identity. The original subtitle and phone nodes,
their exact values and the original native conversation pins must still match.
Mutation history rejects identity replacement and change-and-return, including a
transient conflicting phone or drawer. Canonical binding requires the shipped
guarded click to close that exact freshly captured drawer; page-driven removal,
ordinary unguarded clicks, hidden mounted panes and identity teardown do not
certify it.

A canonical conversation can still display older messages. Its successful
observation then includes `nativeChatReadRepair` with `phase: "read_latest"`,
the exact current transcript reference and `direction: "bottom"`. Read that
reference with `get_accessibility_tree`, use the ordinary `scroll` tool on the
same reference, then call `chat_observe` again. Observation never scrolls on its
own. An empty delta from a historical viewport is not evidence of waiting for a
new reply. The send baseline still requires the latest native viewport and the
unchanged mounted message tail; the pointer grants no send authority.

An incoming native tail plus its exact native sender field establishes a group
anchor. Subsequent rows without a tail need continuous agreement with that
anchor; isolated rows, an ambiguous own-name match and absent sender evidence
remain unknown. Outgoing verification requires a native status read as delivered,
exact authored text and a new opaque ID after the entire mounted pre-send
baseline in its original order. Every original baseline node, including the
live tail, must remain mounted. Lexicographic ID ordering, historical same-body
rows, remounts, reordered baselines and optimistic bubbles provide no receipt.

The private floor can survive an actual background-worker reboot on the same
document. A genuine continuation must retain the original task ID and provider
configuration digest, then establish a fresh native drawer binding to the same
canonical peer. Only the retained original node objects and exact private
document epoch can verify the late outgoing reply. A new task even with identical
wording, provider change, accepted correction, actual Stop, document loss or
removed/replaced baseline leaves the send uncertain and blocks a resend.
Production monitor Stop revokes the floor; an ignored stop from an older monitor
run cannot revoke a newer active run. Group chats and attachment-only messages
are outside this reader's proved contract.

`test/native-whatsapp-contact.mjs`, `test/whatsapp-chat-completion.mjs` and
`test/whatsapp-chat-restart.mjs` exercise these boundaries in both browser builds.
`test/whatsapp-chat-selection.mjs` covers the repair reference on a blocked
message action, chat-list navigation away from an unconfirmed chat, and which
requests may move the contact check, in both builds.
`test/whatsapp-native-bootstrap.mjs` adds 34 actual-Agent/browser checks for the
generic native composer, precise repair references and wrong or stale targets.
`test/whatsapp-drawer-identity.mjs` adds 56 paired production-reader/browser
checks for benign media and Close updates, exact guarded closure and identity,
owner, document and Stop invalidation. The retained earlier reader fails this
regression while the corrected reader passes; the older matrix evidence below
predates this drawer mutation correction.
`test/whatsapp-read-latest.mjs` adds 14 actual-Agent/browser checks for a real
246-pixel historical gap, zero dispatch before recovery, ordinary scoped
scrolling, one fresh verified delivery and stale Stop/provider/peer/document
refusal.
`test/whatsapp-read-preparation.mjs` adds 26 actual-Agent/monitor checks for
bounded observation before inference, all three native read phases, unchanged
guarded dispatch and Stop, provider, document and identity drift during capture.
The separate installed prepared-repair case passes in 10,025 ms with 45 unrelated
sidebar controls, 49 native rows and a genuine 247-pixel historical gap. Its
actual model-visible page snapshots contain the exact carrier, Close and
transcript references before each decision, with no separate model AX call for
those three controls. A wrong Send remains blocked; recovery produces one native
delivered reply, no pending send and successful live UI completion. Its before
source fails as an uncovered carrier with zero opens or sends. This uses an
owned local provider and intercepted native client, not an authenticated contact.
The installed-MV3 owned contact fixture also verifies generated delivery and
terminal success after a genuine same-task worker reboot. Its distinct actual
Stop/Continue case retains uncertainty and sends nothing again. The earlier
13-case matrix passed in 195,285 ms with all 601 extension/fixture source files
unchanged. Every case uses the native contact-name carrier and a generic composer
placeholder. The added bootstrap case refuses the whole header and Send before
canonical binding, then uses only the precise name and Close controls, delivers
one generated reply and finishes successfully. Its archived evidence is
`ci/artifacts/quality-audit-2026-10-07/whatsapp-contact-matrix-bootstrap-final-source/summary.json`.
That archive precedes the later native drawer presentation-change handling,
current-transcript scroll repair and exact pre-inference read preparation.
The prepared-repair 15-case matrix passed in 251,167 ms with all 601 extension/fixture
files unchanged. It includes the real native drawer visual-update sequence,
historical transcript recovery and the larger sidebar that omits the repair
controls from the ordinary bounded global snapshot. Its evidence is
`ci/artifacts/quality-audit-2026-10-07/whatsapp-contact-matrix-prepared-final-source/summary.json`.
After the later scheduler and foreground terminal-classification correction,
all 15 cases passed again in 225,636 ms with the same 601-file source-stability
scope. Its preserved evidence is
`ci/artifacts/quality-audit-2026-10-07/whatsapp-contact-matrix-scheduler-terminal-final-source/summary.json`.
These are intercepted native applications with a local provider; the matrix is
not a WhatsApp endurance test.

The later representative c8 matrix passed all 15 cases in 230,907 ms, retaining
601 stable source/fixture inputs and zero external messages. Its Stop/Continue
case preserves one genuine send, durable pending state and false success flags.
A preceding fixture failure advanced the fake provider on a generated read
that runtime feedback discarded. The fixture now consumes only its exact
current-phase `chat_observe` tool-call ID before advancing, with at most three
read-only retries; earlier results cannot substitute for the resumed read.
Delivery, Stop, uncertainty and completion assertions are unchanged. Evidence
is `ci/artifacts/quality-audit-2026-10-07/whatsapp-contact-matrix-attempt17-callid-c8/summary.json`;
the failed attempt remains under `whatsapp-contact-matrix-attempt17-failure`.
This correction changes no product code.

A separate snapshot11 installed MV3 soak passed a real wall-clock hour in
60 minutes 42.442 seconds, answering 59 fresh questions exactly once through
59 scheduled waits, two genuine worker restarts and Stop/Continue. Its final
live and raw stored journals both show successful completion with matching
request IDs, no pending send and no active jobs. All 602 loaded extension and
native-fixture source hashes remain unchanged. Evidence is
`ci/artifacts/quality-audit-2026-10-07/native-chat-soak-60min-final-source-snapshot11/summary.json`
and its adjacent source verification. This uses an owned local provider and
Telegram-shaped application; it establishes no authenticated service endurance
claim. This archive predates the follow-up editor and monitor corrections.
The earlier 60-minute 39.7-second proof and deliberately interrupted retakes
remain separately qualified in `docs/native-chat-durable-resume.md`.

The follow-up snapshot14 installed soak passed in 3,639,473 ms, answering
59 questions exactly once through 59 scheduled waits, two actual worker reboots,
Stop/Continue and 21 recorded context compactions under a 65,536-token Full
fixture budget. Stop settled in 1,154 ms with zero late sends. Both live and
independently read stored journals finish completed with both success flags,
matching request IDs, no pending outbound and zero active jobs. All 602
product/fixture inputs stayed unchanged through source verification at
15:13:59.504 UTC. Evidence is
`ci/artifacts/quality-audit-2026-10-07/native-chat-soak-60min-final-source-snapshot14/summary.json`
and its adjacent source verification. The loopback provider and Telegram-shaped
application do not establish authenticated service or vendor-tokenizer endurance.
The separate snapshot15 two-hour run failed final completion after 117/117
exact replies in 7,223,106 ms, despite two actual worker restarts, Stop/Continue
and all 602 source inputs remaining stable. More than 200 mounted native rows
incorrectly invalidated the bounded send-floor certificate; the latest verified
delivery then lacked a completion receipt. An unchanged installed three-minute
117-pair seeded reproduction confirms the same terminal failure. Its original
failed archives remain intact. A later source19 two-hour retake was deliberately
stopped after 25 minutes with 19/25 questions answered exactly once when an
isolated virtual-history false-acknowledgement reproduction exposed another
defect; that interruption is not a terminal pass.

The final latest-viewport, shared-floor and structured-send regressions pass
492 checks in `telegram-native-latest-required-final.log`, recorded by
`telegram-native-latest-final-proof.json` under the audit artifact directory.
The installed cold-preparation case passes in 5,917 ms with 600 source files
unchanged, one guarded read-only native click and zero message mutations. The
read-only task honestly ends partial with both success flags false because the
alias remains unbound. The five installed native chat paths pass with 26 exact
replies, ten completion judges, successful terminal completion and all 602
product/fixture inputs unchanged. Evidence is
`telegram-cold-preparation-preprobe-final/evidence.json` and
`native-chat-preprobe-final/summary.json`, with adjacent source verification.
These use owned local providers and native-shaped applications, not real user
services. The source20 120-minute run was deliberately interrupted after
23 minutes 54 seconds and 23 exact question/reply pairs, before the generic
question-restoration changes. Its 602 inputs remained stable; it is not a
terminal pass. Coverage attempt21 was also interrupted before those changes.
The source22 120-minute retake was deliberately interrupted after 16 minutes
41 seconds and 16 exact pairs, with 602 stable inputs, before the arithmetic
response corrections; coverage attempt23 was interrupted at the same boundary.
Complete source24 coverage, 120-minute endurance and current authenticated
retakes remain pending. Earlier archives establish only their recorded source
and scope.
Full default coverage
attempt17 ended in the fake-provider phase-accounting failure described above;
attempt18 passed the complete command from 15:47:11.639 through 16:06:23.954 UTC,
with 2,447/2,447 main tests, 60/60 security checks and the full native browser
and installed-MV3 matrices. All 17,526 captured product/test/package hashes
matched at qualification; evidence is `coverage-followup-attempt18-summary.json` under the
audit artifact directory. Node/V8 coverage is distinct from these browser
assertions. The later planner and native-chat product corrections require a fresh
complete command, and the passing earlier command does not establish a two-hour result.

A separate authenticated retake of the unchanged ordinary task also passes:
the exact contact carrier and Close are guarded and verified, literal text entry
is verified, the historical pane is scrolled to the latest messages, and one
native delivered outgoing message is independently confirmed with its exact
body hash and an empty composer. The accepted `done` and raw restored UI both
report success. Private evidence remains in
`auth-whatsapp-mom-prepared-corrected-private-results.json` and
`auth-whatsapp-mom-prepared-native-delivery-proof.json` under the audit
artifact directory; contact identity and transcript text are not published here.

Explicit ongoing conversation goals allow the agent to compose relevant replies
to the authorized recipient. Exact user-supplied bodies remain exact. Incoming
page text cannot extend the goal to another recipient, purchases or account
changes. The active thread, composer and recipient guard still apply to every
send, and OTP/payment/authentication/new-decision gates pause the workflow.

After independently verified delivery, an unfinished ongoing goal can use
`schedule_resume` for a durable 60–120 second wait. A fresh incoming message
preempts that wait; an uncertain outbound stays in observation and cannot be
sent twice. Completed one-message tasks can finish after verification.
For an uncertain dispatched send, `reconcile_pending_outbound:true` and the exact
public pending key only request an app-owned confirmation for that message.
Clearing it requires a one-use manual answer confirming that this exact message
was independently checked and was not delivered, with task, provider, run,
thread and pending-record ownership still current. Model flags, earlier prose,
automatic answers and timeouts cannot
approve it. Actual verified delivery can instead clear pending state through
ordinary `chat_observe`, without manual reconciliation.

A `chat_send` whose Enter never reached the page is not uncertain on a page
that empties its composer the moment it sends (Discord). When the
page-change fence refuses a key before Enter after the exact draft was
verified (`submissionBlockReason: 'page_feedback_pending'`), and a live read
finds that whole draft still in the same composer of the same conversation
with no new outgoing or unattributed copy, `chat_send` releases its pending
record and reports `chat_submit_not_dispatched` with `draftRetained: true`.
One guarded Enter then sends the draft. A changed draft, a sent copy, a
recipient refusal, a stopped run or another site keeps the record: a page
that keeps its text until the server answers could be mid-send. Telegram and
WhatsApp keep their private owned-draft lease for the same state, and a
direct `set_field` submit keeps its record for the card.

The confirmation card names the conversation as its page does, quoted on its
own line (`Conversation: “#announcements” on discord.com`), instead of
WebBrain's thread key, and states only what WebBrain reads: that a message
with the exact text is shown in the conversation, or else that the message
box contains it and no such message is shown. It never says whether the
message was delivered.

Permission and ordinary clarification cards can be recovered from the actual
live unanswered Agent entry after the panel reopens or its progress events have
been acknowledged. Recovery requires the same request, run, task, provider and
steering revision, and rechecks current state after asynchronous hydration.
Settled questions, Stop, a newer task and worker loss without a live entry cannot
revive an approval. Restoring a card neither answers it nor renews its timeout;
duplicate and in-flight answer cards remain suppressed.

An accepted mid-run correction settles an obsolete permission wait as
superseded and continues at the normal steering boundary. The earlier prompt
cannot record a grant or dispatch its action. This is generic UI recovery,
independent of native recipient or delivery proof. The 54 paired hydration
checks and 22 permission-steering checks use owned fixtures, not an authenticated
conversation (`test/pending-clarification-hydration.mjs` and
`test/permission-steering-wakeup.mjs`).

An authenticated source22 check restored the same unanswered permission card
after closing and reopening the native panel. A genuine public correction then
woke the old wait without a grant, and the old click returned no-dispatch.
That phase passed; the whole 300-second task failed. Two plain arithmetic
answers before any calculator call were discarded during passive page updates,
leading to a new unrelated click prompt. A separate first-main correction
computed the exact result, then discarded five plain replies and stopped as
page-unstable. These failures do not establish a successful arithmetic task or
native text entry. Content-free evidence is
`auth-telegram-source22-permission-steering-content-free-diagnosis.json`; the
native reopen records and first-main result remain in the private audit archive.

The source24 correction uses the calculator's shared lexer and bounded parser
to recognize one literal expression in the complete genuine arithmetic-only
task. Whitespace between unchanged tokens is allowed; split numbers, extra
inputs and mixed browser work are rejected. Before a tool result exists, an
empty-tool reply can survive passive DOM updates only to reach the normal
calculator nudge. It creates no receipt or completion evidence. After an actual
calculation, the current private receipt can preserve its plain response, but
an explicit `done` and the normal completion gate remain required. Owner,
task, provider, run, revision, Stop, hard feedback and action debts are checked
again after refresh awaits. The paired actual Agent chat/stream regressions
pass 124 checks, with 950 neighboring checks and independent source review;
`pure-calculation-before-tool-source-final.json` records this owned unit/protocol
proof. Current real-provider and authenticated UI outcomes remain pending.

Generic guarded click, Enter and submit-with-field sends also run the long-chat
kernel in the final action pipeline. Pending state reaches storage before page
dispatch and has a unique persisted owner. Pre-dispatch steering/Stop and proven
no-dispatch results clear it; uncertain dispatched results hold it across worker
restarts and block duplicates. New incoming questions and user-input gates must
be observed before replying. `test/chat-generic-dispatch.mjs` exercises these
actual batch ordering and cancellation boundaries in both builds.
The loop detector counts new kernel message IDs and exact native delivery IDs as
progress, while unchanged polling retains the existing recovery threshold.
`test/chat-goal-lifecycle.mjs` exercises real guarded Agent sends and content
dispatch on isolated semantic chat pages, including persist-before-schedule,
restored deltas, generated follow-up bodies, slow delivery, OTP and recipient
switch boundaries. It does not use a live model or authenticated contact.

`test/quality/native-chat-mv3.mjs` loads the real Chrome MV3 extension and exercises
the normal planner, background Agent, native content dispatch and every terminal
gate against a local intercepted Telegram-shaped conversation. A deterministic
provider answers six questions using generated bodies through structured,
generic, generic submit and draft-recovery paths; the semantic judge returns
uncertain to require native proof. A fifth path sends two identical replies
exactly once when a later question precedes the first reply's acknowledgement.
All paths complete without loop nudges. No authenticated service, real contact,
external message or account is used by that regression.
