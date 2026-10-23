# Guards

A guard is DIV code, not the user, that refuses, defers or stops a tool
call, a write, a submit or a completion. Every guard is registered in
`src/*/src/agent/guard-policy.js` with a class and what it does when it knows
the action is wrong (`onDecided`) and when it cannot tell (`onCannotDecide`):
`block`, `ask` or `advise`. The file is shared verbatim by both builds.

## The policy

- **Only the hard list refuses.** Five classes may refuse an action outright:
  the wrong recipient (`recipient`), deleting data (`deletion`), spending
  money (`money`), credentials (`credentials`), and publishing or sending
  something the user did not ask for (`unrequested_publication`). When a hard
  guard cannot decide, it asks the user on DIV's own card where one
  exists (`ask`), and refuses otherwise.
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
    "DIV could not verify everything: …" (at most four items). An
    exact table delivered from its `data_ref` stays the complete JSON its
    contract promises: the line goes beside it, as a warning and as the
    done result's `completionCaveat`.
  - A completion accepted over a guard that knows the claim is wrong (the
    completion judge's "not done", an unauthorized mutation, missing, failed
    or unfinished progress rows, unread pages of a whole thread the user
    asked for, text that went into a formatting toolbar, an exact table that
    can no longer be delivered, a field read back as another value than was
    written to it, an arithmetic result claimed before the calculator ran)
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
`ask`, DIV asks the user on its own card instead of refusing.

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
- **Authority.** A timeout, Instant or unattended answer is DIV's, not the
  user's: it is never recorded as task authority or memory.
- **Strict checks.** Quality guards keep their refusal and show no card.
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
| `social-publication-draft-quality` | The X/Bluesky draft's text does not read back as requested or could not be read, when the user asked to publish (the publication audit still runs). Media that does not match and a composer that was not read completely still refuse: the card shows only the text | The composer's text |
| `steer-prior-submission-target-unresolved` | After a correction, a submit-capable control the probe could not identify | Nothing (check the page) |
| `clickax-task-click-lock` (hard, Chrome) | An earlier trusted click on the same target may have landed and was never verified | Nothing (check the page) |

Code: `_promptUnverifiedStepConfirmation` and `_resolveUnverifiedStepConfirmation`
in `agent.js`, `agent/unverified-step.js` (shared by the agent, scheduler
persistence and restored cards), and the `unverifiedStepConfirmation` branch
of `renderClarifyCard` in `ui/sidepanel.js`. Tests: `test/guard-ask-cards.mjs`.

## What still refuses, and why

| Class | Guards | Why |
|---|---|---|
| `recipient` | `chat-send-recipient-guards`, `native-chat-receipt-not-durable`, `preparation-timeout-recipient-preflight`, `recipient-active-conversation-pin`, `recipient-dispatch-binding-revalidate`, `recipient-guard-refusal`, `recipient-mismatch-confirm-card`, `schedule-resume-chat-state-not-durable`, `social-preflight-context-mismatch` | A message to the wrong person cannot be taken back. A resumed run without a durable receipt would send a delivered message again. |
| `deletion` | `deletion-confirm-card`, `deletion-guard-refusal`, `preparation-timeout-submit-preflight`, `truncated-preview-replacement`, `unsaved-changes-data-loss` | Deleted data, including a field value replaced by its own shortened preview, is gone. |
| `money` | `captcha-paid-solve-protection` | A paid solve spends the user's balance. |
| `credentials` | `chat-user-input-required`, `otp-mailbox-scope`, `strict-secret-credential-handling` | One-time codes, passwords and payment details are the user's to enter. |
| `unrequested_publication` | `bot-memory-reservation`, `click-duplicate-submit`, `clickax-task-click-lock`, `consequential-durability-checkpoint`, `github-conditional-commit-unbound`, `recipient-guard-unrequested-send`, `sched-reconciliation-required`, `social-api-publication-route`, `social-publication-audit`, `social-publication-authorization-guard`, `steer-post-correction-commit-guard`, `steer-prior-submission-unreconciled` | A post, commit, submit or send the user did not ask for, or a second copy of one that may already have gone out, is public or hard to undo. |

After a correction, `steer-post-correction-commit-guard` and
`steer-prior-submission-unreconciled` hold a post, commit or submit until
DIV has matched what the attempt before the correction did. A deletion
is not held to that, because it cannot repeat that attempt: the latest
request, or the user on DIV's deletion card, decides which item goes. A
Mastodon post is one DIV cannot match after the fact (the home timeline
shows it, not a page of its own), and "now delete it" used to be refused on
every click there.

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
