# Page feedback monitor

Browser-backed chat, cloud, scheduled tasks and saved workflow replay automatically
monitor the run's tab and accessible frames in Chrome and Firefox. Switching the
active tab does not move the run. Standalone chat has no browser monitor.

User click, typing, selection, scrolling and navigation invalidate prepared
actions. After one second of inactivity, the runtime reads the current URL and
accessibility tree and continues the original task. Pointer gestures and IME
composition keep the gate closed until they finish. Main-frame navigation of
uncertain origin and top-level viewport changes also get the idle delay.
Automatic page activity (DOM updates in any frame, page-script focus, synthetic
input, unattributed scroll, child-frame resize or navigation, and same-document
route updates without user activity) does not extend it. A navigation close to
user input is attributed to the user but does not renew the user's activity
time. Stop interrupts the wait.
Window and visual-viewport size, zoom and offset changes invalidate prepared
coordinates. Top-level viewport activity waits for geometry to settle; embedded
frame size changes are page layout observations and do not extend the user gate.
A full-size, unzoomed visual viewport cannot pan by itself, so a sub-pixel
offset change with the same size, scale and DPR is the remainder of a
fractional layout scroll (Firefox reports it, Chromium does not). It is
reported as that scroll, with the document scroll's attribution, and counts as
scroll geometry in footprint comparisons, so both browsers treat a page's own
scrolling the same way.

`composerDeliveryMode` only controls typed chat messages (Queue/Steer). Automatic
page feedback uses its own bounded queue and cannot promote a queued message to
Steer or grant authorization. Enter and Alt+Enter retain their existing behavior.

## Observation and dispatch boundaries

- The document-start monitor handshakes with background using a run token and a
  document token. Background validates the actual sender's tab, frame, browser
  document identity when available and monotonic sequence. Full navigation
  invalidates the previous document and its frames.
  Run startup addresses every existing accessible frame and waits for its ready
  acknowledgement; cleanup sends the owning run token to all frames. Restricted
  frames do not prevent a run, and frame enumeration failures retain broadcast
  delivery.
  Firefox also registers the monitor and MAIN-world shadow hook at document end
  to cover inherited `about:blank`/`about:srcdoc` frames skipped at document start.
  This supplemental pass preserves an existing live monitor and its expectations.
- Native CDP/BiDi and content actions register their target, input operation and
  actual dispatch before changing the page. Target and native-event phase
  matching suppress their observed effects. CDP resolves the receiving document
  and target, including process-isolated iframes, before registering input in that
  frame. Expectations are finished in every frame touched by the action. Firefox
  companion checks the live document/revision again and renews its marker between
  a shortcut's modifier and letter, as well as before each later key. A different physical intervention
  breaks the expectation, including a later click on the same target. Uncertain
  effects remain `unknown`; `isTrusted` alone does not establish human origin.
- Chrome selector resolution checks a fence without claiming scroll during its
  asynchronous search or retries. Only a resolved node's actual `scrollIntoView`
  dispatch activates attribution, with a live page revision check in both open
  and closed shadow-root paths. Read-only selector queries do not arm scrolling.
- AX rect/field preparation and content/BiDi visibility helpers register the
  exact node immediately before each actual scroll. Multiple scrolled ancestors
  remain attributed within the operation; preparation scrolling never claims
  input events on the field. Pending feedback is propagated through scroll
  fallbacks rather than permitting an extra viewport mutation.
- Editable preparation separates owned scroll and focus from text input. The
  original document, editor, semantic owners and private values remain bound;
  only geometry and hit information produced by that synchronous preparation
  can be refreshed. Replacement editors, changed form or recipient state,
  later geometry changes and human intervention still require a new decision.
  Refusals report bounded predicate names instead of private values.
  A typing action's own single left press on its exact certified text field
  (Chrome's trusted contenteditable fallback clicks the editor once so that the
  browser, not a script, focuses it) is preparation of that typing too,
  together with its release when the release's native receiver is that field
  as well. The dispatch reply marks such a press or release
  `typingPreparation`. It does not use up the certificate, and it makes the
  operation keyboard-bound: from then on the field is compared with its
  certificate without the centre hit, because the page may answer the press by
  covering the pressed point. X draws its bold/italic bubble in a body-level
  layer exactly there, over the middle of the empty editor, while its timeline
  keeps updating. Every later step of a keyboard-bound operation focuses the
  field itself, and the receiver of its native input must be the field.
  Native keyboard input of any certified operation must name its receiver:
  input whose receiver could not be marked (no focused node, a frame without
  an active monitor, or a page that removed the revision fence) is refused as
  `target_unresolved`. When the receiver has focus in a child document (a
  page that moved focus into an iframe), the top document's monitor is asked
  about its operation before anything is sent. Such input is the operation's
  only when its certified target is the frame that has focus (or contains
  it), was not an editable host when certified (an editor's text never goes
  into a frame embedded in it), and still has the same certified semantics;
  otherwise it is refused (`receiver_frame_changed`). Later keys of the same
  action, such as `set_field`'s submit key,
  stay keyboard-bound under the same focus and receiver checks. The
  reselection before the text command keeps the certificate; when only the
  field's geometry moved meanwhile (a layout shift, not its semantics), the
  proof is rebased as for any certified decision. Genuine user input, a
  changed field, owner or reply scope, a replaced editor and an inert composer
  still stop the action before any text is sent. A press on another node, an
  activator inside the editor, a right, double or second press, a release over
  another node or any earlier input of the action is consequential as before.
  A focused text field whose centre is covered by something else (the bubble
  left by an earlier attempt) is certified `keyboardOnly`. Only keyboard input
  (`type_ax`, `set_field`, `type_text`, `type` and `press_keys`) may use such a
  certificate, and only while the field still has focus at the decision; a
  click on it is refused as `target_uncovered`. (Without this certificate such
  a field had none, and a click on it was judged by the legacy rules, which
  cannot see that the click would land on the cover.) Chrome's fallback then
  skips its press: `ax_prepare_field_for_trusted_type` reports whether the
  centre hit reaches the field without crossing an activator (`pressable`),
  whether what is there instead lies outside the field (`centreCovered`), and
  whether the field had the focus before that preparation (`focusedBefore`).
  Only a field that already had the focus and is covered from outside is not
  pressed; it is typed into through the same receiver checks. Any other field
  is pressed as before, and the monitor refuses a press whose receiver is not
  the field itself, such as a native control inside a ProseMirror editor.
  A recent owned scroll can reconcile one native subpixel visual-viewport
  notification within 200 ms when the original target, hit, rectangle, values,
  document scroll, full-size viewport, scale and DPR remain unchanged. This
  handles delayed browser rounding; larger, later, synthetic or unrelated
  viewport changes retain the normal invalidation path.
- Only genuine user input and top-level window/zoom changes invalidate
  certified decisions by themselves. Unknown DOM attribution, page focus,
  untrusted page events, non-user scrolling and frame resizes are still
  reported and still fence coordinates, scripts and legacy bindings; a
  certified action's private footprint decides whether it changed. The agent's
  own selector scroll and pointer hover refresh only the exact target's
  geometry proof (same node, semantics and hit node). A pure scroll or layout
  move before preparation keeps a ref/selector decision when the same node
  still receives the hit; geometry is exact from preparation to dispatch.
  Finishing an operation delivers its own pending page reactions before its
  tool returns. Trusted key and pointer presses during content-script
  operations are user input. A monitor whose run the background no longer
  owns stops observing.
- Native input also validates the actual receiving node against the private
  action certificate. Passive descendants can receive their owner's input;
  unrelated controls and nested activators, including shadow-root controls,
  cannot borrow an editor or button's authority. Held input can still be
  released, and the existing authorized Tab focus transition remains bound.
- A fully acknowledged Chrome native button click enters read-only effect
  observation. Page-owned focus restoration and rendering changes do not erase
  its delivery receipt. Unverified effects carry `effectVerificationPending`
  and cannot certify a remote save, publication or deletion. Lost input
  acknowledgements, interrupted authority and unresolved reads retain repeat
  locks; observing effects never sends a second click or clears queued feedback.
  The agent's own hover may move a certified native button by up to 8 px
  (lift, border or scale), also through a CSS transition or a page hover
  animation. Without sending input, the agent then samples that exact button
  read-only, at most 600 ms, until two consecutive samples have the same
  rectangle and the same hit node at its centre and no finite geometry
  transition is still running on it or an ancestor. The settled button is
  re-verified, the monitor fence refreshes its geometry proof only for the
  same node with identical semantics and hit, and it is pressed once at that
  settled centre. A button that keeps moving (including an infinite
  animation), a covering, hidden or replaced node, a changed document or
  route, a semantic change, a move beyond 8 px from the prepared centre, any
  user input or Stop during the wait refuses before input.
- Trusted CDP input is marked dispatched only at the transport boundary, after
  the receiving-node and page-feedback fences pass. A rejection before the
  protocol call means nothing was sent; any later failure means the input was
  delivered with an unknown outcome. Such input is never resent and never
  followed by a DOM, script or content-script fallback. This covers hover
  (from its first pointer move) and drag_drop and set_checked (from their
  press; the no-button move before a press is pointer preparation, as for a
  click). In Firefox, a trusted BiDi action is dispatched when its native
  request is posted after the preparation probe and page-feedback fence, and
  a content-script action when its message is sent; a refusal before either,
  a content-side fence or a companion refusal before input reports no
  dispatch. For `click_ax`, only the browser's missing-receiver error proves
  that the click was not delivered. A possibly delivered, unverified trusted
  click locks its exact document and ref for the rest of the task, including
  Continue and Retry; a verified effect or a new task releases it. Stop
  between a field write and its submit or Enter prevents the submit and
  reports the write as it happened.
- Meaningful visible content, control state, visibility and geometry changes are
  coalesced. Visible subtree identity changes invalidate targets even when the
  replacement has identical text and geometry. CSS animation and extension
  decoration are ignored. Extension UI roots register their actual node
  references in the isolated content-script world, preserved across monitor
  replacement; page-owned IDs and attributes cannot suppress observations.
  A MAIN-world attachment signal observes new open
  shadow roots on existing hosts before their initial rendering; shadow-root
  child-list mutations are also monitored. Inaccessible frames and closed shadow roots retain the
  existing browser-access limitations.
  Existing dialog/details `open` and subtree `inert` state changes are observed
  even when no children, classes or styles change.
- Event payloads contain bounded target identifiers and scroll positions, never
  typed keys, field values or selected text. The subsequent normal page read uses
  the existing untrusted-content and secret-handling rules.
- Feedback invalidates JEV preparations, remembered field identity and screenshot
  coordinates. It is consumed at existing model/tool boundaries after all tool
  results have matching messages. In-flight results remain; undispatched sibling
  calls receive explicit skipped results. Transport and local dispatch gates
  cover interventions during asynchronous preparation.
- Content and Firefox native preparation handshakes check the revision without
  claiming input events. Local dispatch and native markers activate expectations
  at the mutation boundary, preserving same-target intervention during preparation.
- Contenteditable fallback marks its cancellable `beforeinput` before emission.
  A native edit's repeated input phases are attributed only within the synchronous
  command and its target; cancelled gates retain their undispatched outcome, and
  user intervention during the settling wait prevents the remaining insertion.
- Both Chrome upload paths check feedback after preparation, immediately before
  attaching files. A skipped attachment retains its undispatched outcome.
- Firefox companion uploads register as input and place their native marker on
  the file input, preserving attribution when a different control holds focus.
- Runtime observations use nonce-delimited `page_feedback` untrusted data. They
  do not enter the trusted text-steering authorization path. Screenshots follow
  the current capture, vision-routing and budget policies.
- Passive main-frame DOM updates use a tool-specific freshness policy. Fresh
  reads, explicit navigation and read-only requests can proceed after refreshing
  observations, even when counters keep changing during the refresh. Mutating
  network requests, request replay, coordinates and arbitrary scripts retain
  strict invalidation. Model state binds the URL, document identity and steering
  revision before inference; human activity and unknown attribution still require
  a new decision. Explicit downloads normalize `url` and `urls` with the same
  precedence as their handler; both browser schemas also accept the singular
  URL and filename. Fresh PDF/capability reads and authorized generation,
  scheduling and window operations retain their own validation instead of
  being discarded for unrelated DOM updates.
- Focused social-media downloads bind the selected document, node, container and
  exact media asset before inference. The downloader validates that identity
  before fetching and again before saving. A replaced asset fails without a
  download; a bound attempt cannot fall back to another MSE or vision resource.
  A transparent backing image can bind to the same visible image painted by its
  immediate parent/sibling; the carrier, exact asset and rendered box must match.
  Binding comparison ignores object-key ordering introduced by browser API
  serialization, while preserving every key, value and array position.
  Missing capture yields a read-only `media_binding_unavailable` tool result;
  the model can inspect sources and choose an explicit URL. It does not attempt
  an unbound fetch/save or count optional capture failure as a page-change retry.
  Capture rechecks URL, document and steering identity after injection. When a
  browser omits document IDs, an active content-monitor acknowledgement must
  prove the same run/document token; a failed registration cannot verify media.
  Bulk and scrolling downloads keep their existing conservative behavior.
- Exact main-frame AX/selector actions can opt into passive revalidation on any
  HTTP(S) site. Immediately before each decision, the content monitor generates
  the current visible AX observation and captures private action footprints in
  the same synchronous task. The observation enters the model request; opaque
  tokens alone cross the monitor boundary. No private control values or files
  are added to feedback, traces or model arguments.
  The footprint binds the actual target and semantic ancestor identities,
  associated labels, recipient/entity headings in its owner, complete form and
  control/file state, exact target geometry/hit, document/base URL, viewport and
  intervention identity. Unrelated sibling text, counters, ancestor child counts
  and headings in another sidebar/entity do not invalidate an unchanged action.
  The old footprint is validated after the model response, during preparation,
  and again at local/native dispatch, including changes during each round trip.
  Focus-dependent typing and keyboard calls bind the exact focused element
  captured before inference. Repeated keys are attributed only within their
  synchronous dispatch; a page script moving focus cannot reuse a native typing
  guard for the next key. Preflight messages that sent no input preserve the
  original snapshot through native preparation. Submissions retain the existing
  authorization, form and recipient gates.
  Snapshots are bounded, expire after two minutes of DIV's own time and
  are discarded with the run. The background reports with each check how long
  it waited for the model's decision and for the user's answers to DIV's
  own cards (permission, submit and deletion confirmations, questions) since
  the capture (`modelHeldMs`, at most 30 minutes); that time does not age the
  snapshot, and page changes during it are judged as usual. A slow provider or
  a user reading a permission card for a minute no longer expires an unchanged
  target as "The browser changed during action preparation", with the same
  card shown again on every retry. Unavailable or ambiguous targets retain
  conservative validation. Coordinates,
  scripts, child-frame actions, human activity, navigation and unknown feedback
  retain strict fences. Without a private snapshot, legacy AX comparisons and
  native-submit restrictions remain in force.
  A target outside the snapshot's coverage returns `action_binding_unavailable`
  instead of claiming that the page changed. The old call stays undispatched.
  This holds while the page keeps updating: a response whose only obstacle is
  such a target is not discarded as stale (the same view would only be decided
  again); the call returns this answer itself, later calls of its batch are
  skipped, and it does not count toward the `page_unstable` budget. User input
  and any other changed target still supersede the response. A selector that
  names several elements, such as X's `[data-testid="tweetTextarea_0"]` for the
  dialog's composer and the hidden timeline composer behind it, is reported as
  `target_ambiguous` (`bindingFailure` in the result), with the instruction to
  use the observed element's ref. For a selector call, the rich-text toolbar
  preflight answers such a target the same way before it probes the target,
  so the answer is not replaced by a probe failure. That early check answers
  only such a target; every other outcome is left to the call's own
  validation, which runs again before dispatch.
  Chrome's preflight for `type_text` with a selector resolves the target
  through the trusted CDP resolver before the call is validated, and that
  resolver's scroll is fenced. While the page keeps updating by itself the
  fence refuses it, so selector typing is still refused there before anything
  is typed. The refusal says that the page changed while the target was being
  located and to type by the observed ref with `type_ax`; it is not retryable
  as the same call, and it no longer reports a resolver that could not attach
  (DevTools) unless attaching actually failed.
  The next normal decision prioritizes that target and receives a fresh bounded
  AX observation of its owner together with the new private footprint. Target
  selectors and labels retain their exact strings throughout validation and
  preparation; truncation cannot certify a different target.
- File discovery can prioritize up to eight exact input selectors in the next
  synchronous observation, before a large document exhausts the general scan.
  Hidden transport wrappers require a bounded visible widget with one file slot
  and one activation purpose; the actual input, widget, form, owner and document
  remain bound. The current observation pairs the selector with its visible
  widget as untrusted page data. Discovery never repairs or dispatches an old
  rejected call, opens a chooser, or grants upload permission.
- Native `summary` controls and authored click/tab-focus targets use the same
  observed owner and exact action footprint as native and ARIA buttons. Changed
  handler identity, disclosure state, target/owner identity and user intervention
  invalidate the original decision; ordinary wrappers do not become controls.
- Native navigation, header/banner and tab-list landmarks can own an action
  when their complete bounded local context was observed with that same
  decision. Transparent wrappers do not prevent the landmark from owning its
  controls. Account text, profile destinations, selected state and exact target
  objects remain bound. An unrelated hidden notification badge may remount
  under an unchanged authored name; a generic account label cannot conceal a
  different rendered account name. This rule uses semantic structure on every
  site, without URL or control-name exceptions.
- An item of an ARIA feed (an `article`, or `role="article"`, with its
  `aria-posinset` inside a `role="feed"`, as Mastodon and other social
  timelines mark each post) owns the controls inside it, like an entity with
  a heading. Its controls, author link and attributes stay bound with it, so a
  change to the clicked post invalidates the decision; changes in other items
  of the feed do not. An article outside a feed, or without its position in
  one, gains nothing from this rule. A `<time datetime>` element inside a bound
  control is bound by its `datetime` value rather than its rendered text, so a
  relative timestamp ticking over ("2 min" to "3 min") is not a change of
  context, while a changed `datetime` still is.
- An article the page offers as one item to assistive technology owns its
  controls the same way, without a feed position: an `article` or
  `role="article"` that can take focus (any valid `tabindex`), named by its own
  `aria-label` or a complete `aria-labelledby`, that links somewhere and holds
  no field or editor, with at most 64 controls. X marks each timeline post this
  way (`tabindex="0"`), and the post a status page shows (`tabindex="-1"`).
  Its labels, controls, images and attributes stay bound, so a change in
  another post keeps the decision, while the post's own counters changing, or
  its virtualized cell showing another post, invalidates it. X also names the
  timestamp link with the relative time ("17 hours ago"), and that name is
  bound as written, so when it ticks over the post's decision is no longer
  certified either. Unnamed, unfocusable or unlinked articles gain nothing from
  this rule.
- Inside an unnamed region, or outside any entity, the nearest focusable item
  the page names for assistive technology owns the controls inside it: an
  element in the tab order (`tabindex` 0 or more), with no role or
  `role="group"`, named by its own `aria-label` or a complete
  `aria-labelledby`, that links somewhere (its permalink or author), holds no
  field or editor, and stays within 256 elements and 64 controls. This is how
  Mastodon marks a post shown on its own page and each reply around it. The
  item's name, controls, images and attributes stay bound, so another post
  taking its place or a change to its own controls invalidates the decision,
  while changes in the replies around it do not. Forms, landmarks, toolbars,
  menus, grids, other entities, unnamed or unfocusable wrappers and items that
  link nowhere gain nothing from this rule.
- Noninteractive `aria-hidden` icon labels inside an exact control remain
  privately bound without requiring model-visible dialog identity from an AX
  hidden node. The bounded predicate is rechecked for every hidden descendant;
  handlers, interactive/recipient fields and explicitly referenced hidden
  name or purpose descriptions retain their normal identity checks.
- A noninteractive decorative SVG hit can normalize to the already bound
  control, so replacing its artwork does not replace the action. Interactive
  descendants, handler properties, recipient/action attributes, changed HTML
  wrappers, overlays and changed target/owner objects still invalidate the
  original decision. This does not grant a new control a certificate.
- An original target with an unverified owner context is distinct from a
  previously verified target that changed. The owned monitor's
  `target_context_unverified` diagnostic prioritizes a fresh bounded observation
  before a new model decision. It does not dispatch the old action or promote
  its unverified fingerprint. Five unsuccessful attempts end with
  `action_context_unverified`; real target, document and user changes keep their
  existing invalidation behavior.
- Its explicit Retry offers `action_monitoring_relaxed` for one accepted
  continuation on the same exact task and document. Only the background's
  authenticated monitor-state reply establishes the private grant. The retry
  captures the currently observed original control and checks its node,
  ancestor chain, parent/form, authored semantics, form destination, visibility
  and actionability at preparation and dispatch. Passive DOM counters may
  change; agent-owned focus/scroll and native input continuation remain allowed.
  Target changes, navigation, human intervention, corrections and completion
  expire the grant. Ordinary Continue cannot grant it. Failed startup restores
  a fresh recovery option; repeated delivery of one request follows one run.
  Permission, publication, recipient and duplicate-delivery checks remain
  active. The UI keeps one failure explanation and adds the explicit retry note.
- `calculate` is independent of passive DOM changes. A genuine arithmetic-only
  task can retain its terminal answer after an unavailable AX refresh only when
  an actual successful literal-result receipt still matches the current task,
  run and provider. Broader natural instructions also require current no-read,
  arithmetic/output-only planner metadata and conservative complete instruction
  and output-format checks. Browser work, sending, submission, scheduling,
  downloads, pending messages, ledgers, actions and verification debt prevent
  this retention. Stop and accepted corrections invalidate the receipt. No
  completion-verifier requirement is waived; unrecognized wording uses the
  ordinary completion path.
- Protected conversation attachments use the existing submission and recipient
  authorization. One explicit source is bound to one exact main-frame file input
  and its local composer. Hidden inputs retain structural identity, input
  metadata, file state and recipient context; visibility alone does not make
  an input unverifiable. The final recipient/node check and native file-list
  assignment run in the same content task. Chrome reads local bytes through a
  detached input in an isolated realm; protected uploads retain the 25MB cap.
  A changed source, input, owner, document or recipient blocks attachment.
  Communication loss after dispatch and a recipient change during an input
  handler produce an uncertain result without an automatic retry. Attaching a
  file does not establish that the website sent or received it.
- Generic chat recipients can use a unique contact-name button in the local
  conversation header above the composer's footer. Sidebar, message-history
  and toolbar buttons do not establish the recipient. The private dispatch
  proof binds the contact, header, pane and composer destination label so a
  same-name conversation replacement still invalidates the action.
  Pre-inference action capture uses the same isolated, read-only evidence and
  scopes editor/control state to that footer; unrelated history updates do not
  invalidate its certified actions.
  Existing recipient approvals survive trusted Continue within the same task
  and execution scope; independent tasks and changed scope clear them. Missing live
  identity, draft, baseline or dispatch proof produces a technical blocker;
  another approval question cannot repair missing evidence, and a question
  declared to be about the recipient is refused while such a blocker stands.
- When a send would reach recipients other than the ones the task named, and
  approval is the only thing missing (the plan authorizes sending, the body,
  baseline and dispatch binding are present), DIV asks the user on its
  own card: "Send to <recipients>?" with fixed choices (Send; on tasks with
  several recipients also "Send, and don't ask again in this task"; Don't
  send) and no free text. The card shows the recipients from the page probe
  and the names the request used. Send approves those recipients for the rest
  of the task and the guard runs again on a fresh observation before dispatch;
  a conversation that changed meanwhile is not sent to. Don't send blocks
  that send for the rest of the task without asking again. Stop cancels the
  card. Unattended scheduled runs are not asked and send nothing. The model
  is never told to obtain consent itself.
- A typed message that the task never named a recipient for, or never asked
  to send, gets the same card once its recipients, draft and baseline are
  verified. The card says why DIV is asking and shows the message text;
  the send keeps the reason `authorized_recipient_missing` until the user
  confirms. An attachment still needs a plan that authorizes sending one, and
  a send whose draft cannot be verified keeps its previous block. A
  correction sent while the card is open applies the correction; it is not
  treated as Stop. When the latest request says not to send the message
  ("draft it but don't send"), the send is refused without a card; a model
  reads that from the request in any language, and no answer means the card.
- A question the model asks itself never approves a recipient, whatever the
  user picks or types on it, in any language; the model is told that DIV
  confirms the recipient itself, and the send still gets DIV's card. No
  question or answer wording is read for consent. Icon-only attachment and
  picker launchers beside a chat composer, named by their icon's label or
  title, are composer utilities when a model reads that name, in any
  language, as only working on the draft; Like, Send, mixed, unread and
  unnamed icons stay guarded.
- A cancelled `beforeinput` handled by a native chat editor can receive an
  exact read-only draft certificate while its original operation, document,
  identity nodes, editor, focus and selection remain current. The certificate
  proves the draft's present value; it does not prove delivery, clear global
  mutation debt or authorize Enter or Send through an old snapshot. Every
  later dispatch retains its fresh observation and recipient checks. An
  uncertain send remains pending until actual delivery is verified or the
  user answers its exact app-owned reconciliation confirmation manually.
- A single explicit `done` candidate survives passive DOM updates before its
  tool batch. In Act mode it also survives automatic page activity, such as ad
  frames, page focus and unattributed scroll or DOM changes; user input,
  main-frame navigation and top-level viewport changes still supersede it. Ask
  answers keep their own scope classification. Once a `done` has executed
  (success, partial or failed), page feedback no longer reopens it; only an
  accepted correction can. Success still requires the completion verifier's
  fresh evidence; partial/failure outcomes remain incomplete. The summary does
  not establish success. Pending feedback after other batches is observed at the
  next step without discarding a completion-recovery turn.
- Under automatic-only feedback, reads, independent tools and targets whose
  private footprint revalidates proceed; legacy AX targets without a footprint
  proceed only for DOM changes. Coordinates, scripts and unbound actions stay
  fenced. An automatic child-document replacement unbinds only that frame.
- Research delegation is independent of the source page's DOM. Background updates
  during inference, refresh or preparation retain the proposed handoff. The handler
  still validates and consumes a one-use authorization for the exact approved
  prompt, scoped to its tab and conversation with a five-minute expiry. A suppressed
  proposal leaves the authorization unused, so a continuation can use it while
  valid. User intervention, main-frame navigation and top-level viewport changes
  still require a fresh decision; delegation keeps its state-changing accounting.
- An agent click explains a same-document route update in its own frame within
  three seconds when no user activity followed it; full-document navigation
  keeps the exact-URL rule.
- A same-document Back/Forward update (Chrome's `forward_back`, which a page's
  own `history.back()` also carries, with its destination entry's original
  transition type) first counts as user input. In Chrome, the frame's monitor,
  listening from document start, then says value-free whether the trusted
  Navigation API traversal to that exact URL was page-initiated
  (`userInitiated` false); a reading answers once, and only within a second of
  its traversal. A monitor injected later, even while the document is still
  loading, never certifies one. Confirmed within 500 ms, with no physical input
  or user-attributed update since, the user attribution is withdrawn: inside
  the click's three-second window the traversal is that click's effect;
  otherwise it is attributed like any page route update (the user's within two
  seconds of their input or during a held gesture, else unattributed). An
  update that follows while the reading is pending (a state restore) is not
  near-user because of it, and when the reading keeps the user attribution,
  nothing credited to the click meanwhile stands. Browser UI, a missing,
  consumed or late reading, browsers without the Navigation API, and Firefox
  (whose own Back/Forward reporting is unverified) keep it the user's. Stop
  does not wait for a reading; feedback being applied does, so it never
  delivers an emptied update. A `page_traversal_attribution` trace note
  records the outcome.
- After both input acknowledgements, a trusted native button's observation
  accepts a route update attributed to its own dispatch operation at or after
  the press (Mastodon's Reply pushes /publish; its composer goes back after
  posting). A new path or query the page pushed is a verified `url` effect. A
  hash-only change, and any route reached by Back/Forward (another frame's
  script can go back too), are tolerated without counting as proof: the press
  is delivered and awaits a fresh observation. Before input any route change
  still refuses, and the new route still invalidates the model state bound for
  the next decision.
- A run's app-owned observations, captures and recovery nudges are removed
  when it ends, so the next request observes the current page instead. Stop
  interrupts page capture and the refresh read.
- A read-only Ask answer survives the user's scrolling, selection and key or
  pointer activity; clicks, input, navigation and the DOM changes they cause
  still invalidate it.
- Five consecutive invalidations without dispatch/progress end the run
  with `page_unstable` and an explicit incomplete result. Invalidations count
  unless a genuine user event, steering or a run-mode change explains them;
  automatic churn and unknown attribution count. A recovery nudge is sent
  after two. Successful reads/actions reset this budget; a `done` receipt and
  its verifier reads do not. User intervention starts fresh. This also covers preparation/transport failures and text-format tool
  responses. App-owned feedback trees and captures are replaced by the latest
  observation, preserving user instructions and tool results instead of growing
  the prompt with repeated copies. Trace notes record disposition, reason,
  refresh time, stage, tool names, retention policies and retry streak without
  action arguments. `media_binding_capture` reports sanitized capture status,
  target-specific reason codes and bounded counts without URLs or page labels.
  `page_action_binding_capture` reports capture availability, bounded target
  count, focus eligibility and local capture time without tokens or field data.
  No warmup delay, heuristic DOM-location suppression or extra model call is
  required to distinguish irrelevant updates from changed action context.

## Workflow and notifications

An undispatched saved step is resolved again against the current scope and target.
Valid steps continue; scope/target failures enter the existing AI fallback with
the remaining workflow intent and latest wrapped observation. The step is not
counted complete. Three preparation retries bound repeated invalidation before
falling back; existing model and screenshot budgets still apply.

Main-frame navigation adds a plain-text, persisted chat note with a deduplication
ID. UI URLs omit credentials, query and fragment. Scheduled notes carry the owning
job ID and wait for that job's assistant bubble. Cloud updates expose only event
metadata and a generic navigation message, in both secret modes. Completion and
cancellation remove the monitor and its pending run state.

Click navigation correlation starts with matching page input, rather than the
preparation handshake. Proven undispatched actions release their navigation
marker. Notice IDs capture the consumed batch revision before the asynchronous
page read, so navigation arriving during that read keeps its own persisted note.
Navigation correlation stays within the dispatched frame; a child link explicitly
targeting the top frame can correlate that target without hiding sibling changes.
Firefox arms direct navigation after URL validation and the unsaved-changes probe,
immediately before the native transport or tab update.

## Verification

`npm run test:page-feedback` runs the controller/transport/workflow/cloud/scheduler
regressions and real Chromium/Firefox DOM fixtures. Fixtures exercise trusted
browser input, same-target intervention, same-shape subtree replacements, frames,
late shadow-root attachment and custom-element upgrades, window and
container scrolling, animation noise, cleanup/restart and persisted navigation
notes. Browser extension APIs are mocked in these fixtures; they are not a live
companion-session integration test.

Visibility regressions include fixed-size ancestors changing class or CSS custom
properties to reveal or hide non-interactive content past the layout sampling and
signature seed limits. An actual inherited-state attribute change on an oversized
subtree conservatively invalidates prepared actions, while keeping layout reads
bounded; identical assignments, known animations and owned indicators are filtered.
Tab and Shift+Tab focus movement also invalidate preparation without recording keys.
Native preparation fixtures
also exercise the real companion code across an asynchronous target lookup while
the user edits the same field.
Frame lifecycle regressions cover delayed child acknowledgements and inaccessible
frames. Browser fixtures also cover page-owned marker attributes and the real
extension indicators across monitor replacement.
Real CDP regressions pause selector resolution during runtime enablement, missing
target traversal and queued evaluation, then verify external scroll feedback and
the final dispatch fence. Open and closed shadow-root agent scrolling remain
attributed. Geometry fixtures also cover modal/details/inert transitions and
viewport resizing during coordinate preparation and after cancellation.
Preparation-scroll fixtures cover the real AX handlers, nested scroll containers,
same-field human typing and an intervening DOM change. Firefox frame fixtures
model the document-start omission, apply the manifest's document-end scripts,
and verify user/DOM/late-shadow feedback in blank and srcdoc frames while keeping
an existing monitor intact. These remain mocked extension registration fixtures.
Both manifests enable origin fallback for related data/blob documents in the
monitor and MAIN shadow-hook registrations. Fixtures model these registrations
and verify private-input, DOM and late-shadow feedback inside those documents.
Document and local-action tokens use cryptographic random bytes when the document
does not expose the secure-context-only randomUUID API.
Text signatures cover the whole non-editable text with a cached fixed-size
fingerprint, so middle/suffix edits and appends beyond the first 200 characters
invalidate prepared actions even when geometry stays fixed. Accessibility-state
regressions also cover aria-pressed-only toggle changes and their agent attribution.
Popover opening/closing is observed in document and open shadow roots before the
next dispatch task, after cancellable page handlers finish. The later toggle event
keeps the same action attribution; canceled openings and owned UI remain quiet.
Trusted gesture endings always release the owning frame's idle gate, including
pointer capture/release over extension-owned UI, without exposing that UI's target.

The monitor regressions are also included in `npm run test:runtime-lifecycle`.
