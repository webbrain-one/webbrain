# Changelog

All notable changes to WebBrain are documented in this file.

This changelog was generated from the repository Git history and release tags. Versions without a Git tag are inferred from version-bump commits and the current `package.json` / browser manifest versions.

## [Unreleased]

### Fixed
- When the model provider rate-limits WebBrain (HTTP 429, or Anthropic's 529 "overloaded"), the step is now waited out and retried up to three times (about 5, 15 and 30 seconds, or longer if the provider asks), also when the limit arrives in the middle of a response, as OpenRouter and WebBrain Cloud report it, and for Anthropic (including Vertex), Azure OpenAI, AWS Bedrock and llama.cpp, whose limits ended Act runs at once. An answer you already saw part of is never generated again. A message such as "Rate limit exceeded" is no longer mistaken for an over-long conversation, so WebBrain no longer trims your conversation and asks you to start a new one. Older context is trimmed only when one request alone exceeds the provider's per-minute token limit, and then right away and only once; if the provider does not state its limit, one shortened retry is tried, and the conversation is shortened only if that retry succeeds. Each wait is lengthened at random by up to 20% so several runs do not retry at the same moment, and never comes sooner than the provider asks. An OpenAI "insufficient_quota" billing error now fails at once instead of being retried, and traces label rate limits as rate limiting even when the message mentions a quota.
- The local vision fallback now also runs when an OpenAI-compatible provider such as Ollama or LM Studio rejects a screenshot as unsupported. The rejection's status was read from the wrong field, so the fallback never started.
- Chat sites: a message is no longer sent to whoever's chat is open just because an e-mail address appears in that chat's earlier messages. When a chat showed no contact name at the top, WebBrain took such an address for the recipient; now it stops and says it cannot tell who the chat is with. An address shown in the conversation's own header, as in help-desk and CRM conversations, still identifies the recipient, while an address in the header's pinned text does not, and mail compose windows read their To, Cc and Bcc addresses as before. In Google Chat inside Gmail, an address mentioned in the chat is never taken as the recipient either: WebBrain stops before sending there, since nothing on the page reliably tells the chat's name from the names in its messages, while a Gmail compose window open over the Chat view still sends to its To, Cc and Bcc addresses.
- Long text fields: WebBrain no longer replaces a field's text with the shortened copy it was shown, such as the first 60 characters followed by "...", which deleted everything after that point. The write is refused before anything is typed, also in embedded frames, and WebBrain is told to read the full text first. Complete new text and additions are typed as before, and a field whose own text contains a "[… truncated …]" note, such as a pasted log, can still be edited.
- Choosing an option in a dropdown: the hint now suggests pressing the down arrow and then Enter, one key at a time, which the key tool supports, instead of typing the option's first letter in a form the key tool always rejects.
- Reading Google pages while signed in: your Google account's name, e-mail address and profile photo from Google's account button are no longer shown to the AI, in the page structure, click, hover, drag and scroll results, element and link lists, text-click candidates, covering-overlay messages, page media or screenshot element lists. The button is still there, called "Google account", and the signed-out "Sign in" link keeps its name. Account links that belong to the page itself, such as on your Google Account pages or in a security-alert e-mail, and e-mail addresses on the page, such as a business's contact address, are unchanged.
- Progress list: a row can no longer be marked as acted on when the click or typing behind it was blocked and never sent; the agent is told to retry, or to check the page and record what it shows. Actions that really happened before you corrected the task mid-run, or in an earlier run, still count.
- Collecting details from a list of named people or pages without changing anything can now finish successfully. Before, each item demanded a page-changing action that a read-only task never makes.
- Repeated tasks such as following 40 listed profiles no longer show each profile twice on the progress list: clicks WebBrain records itself now fill the planned rows.
- When the model calls a tool it no longer has, such as the retired screenshot tool, or click in Ask mode, it is told what to use instead (inspect_viewport, or asking you to type /screenshot --full-page), and repeated attempts stop the run after ten tries without hiding a genuinely stuck step. Missing tool arguments are now named as missing.
- When a task needs a value or a choice from you, the agent now asks with a question card and carries on after your answer, instead of ending the task and treating your reply as a new request.
- With Research escalation turned off, a question about who should receive a message, or a request to switch recipient, was refused as invalid before it reached you. It now works whether or not Research escalation is on.
- With Research escalation on, Ask mode was told to ask clarifying questions with a tool it does not have, so those questions failed. Ask now puts a missing detail, such as dates or a budget, into its answer.
- After a question timed out, your next message could end at the first blocked step with "Please answer it and try again", with nothing left to answer. WebBrain now asks the question again first; an answer picked automatically after a timeout still never counts as your decision.
- Scheduling a task now says which page it runs on and how often it repeats in plain units ("every 30 days"). An interval of 28 to 31 days is described as fixed, not monthly, since it drifts against calendar dates, and a requested time more than 7 days away is reported as over the limit instead of quietly being scheduled earlier.
- A scheduled task, recurring or one-time, no longer schedules itself again when it runs, for example a recurring task whose instructions say "every 5 minutes" or a reminder such as "In 30 minutes, remind me to take the pizza out", and no longer fails because it did not. A one-time task can still set up a new schedule when it explicitly asks for one, such as "on Monday at 9, start an hourly check".
- A recurring scheduled task now pauses, with the reason shown, when a run ends with a question only you can answer, or after three failed runs with no successful run in between, instead of running again and again. Resuming a task you paused keeps its next run time, or runs it about a minute later if that time has passed; tasks WebBrain paused restart their interval when you resume them, and paused tasks no longer show a "Next" time.
- When WebBrain reads another page in the background, it now says so accurately: a quick fetch opens no tab, a full-page read may briefly show a temporary tab in the tab strip that closes by itself, and your current tab never changes. Requests to open or show a page are steered to real navigation.
- Shared runs and diagnostics keep their internal IDs intact. The WebBrain Cloud privacy filter sometimes masked an ID whose timestamp looked like a payment card number, which broke the links between a run's records, including tool calls from local models. New IDs use a compact timestamp; existing IDs keep working.
- "Summarize this page" now keeps reading long pages to the end before summarizing, and says which part it covered if it had to stop early.
- The navigation tool's description now says correctly that a page's "Leave site?" warning may be confirmed automatically and that not every unsaved edit is detected, so the agent saves work first when it needs it.
- When a task ends, a sidebar search box that names itself only by its placeholder, such as Mastodon's with its icon-only button, no longer counts as a form left unsent and no longer blocks finishing twice. A model reads what the field is for, in any language; a box holding typed text, a comment or message box, or a people picker still counts.
- Strict secret handling: a password or code WebBrain filled into a sensitive field, including one typed into the focused field or an embedded frame, no longer ends up in the agent's scratchpad or progress list, which are sent with every later request and saved with the conversation. It is replaced with "[redacted credential]", also in notes written before it was typed, after the browser restarts the extension's background worker (including on captcha-protected logins), and under password-like field names, while fields such as page_token, token_count or secretary, the app's own notes, file names and download ids are left alone, and a private Cloud result keeps the password it generated. A short numeric PIN, and a secret you only typed into chat and never had filled into a field, are not recognized.

## [40.8.0] - 2026-10-16

### Added
- `browser_batch` runs predictable browser actions in order in one model round trip on Chrome and Firefox. Mid allows up to 6 actions and Full up to 10; Dev inherits its provider tier. Each action keeps its normal permission and verification checks, and failures or submits stop the remaining work for a fresh turn. A final page read can follow navigation. Ask and Compact keep their existing tool surface; an internal `browserBatchEnabled` switch disables batching.

### Fixed
- Verified `type_text` writes now carry their exact clear/append value into the same batch's original field certificates, allowing later known fields to run without accepting unrelated page changes.
- Evaluation payloads place batch guidance immediately after the base Act prompt, matching production ordering before Dev guidance, site adapters, and loaded skills while preserving frozen snapshots.
- Build batch guidance from the current tab's run provider, and grade proposed batches only after the complete wrapper and all child arguments pass production validation against the evaluated tool surface.
- Browser batches use the run's selected provider tier for action limits and continuation rules, and wait briefly for delayed navigation before deciding whether another child can run. Navigation that remains unsettled stops the remaining actions for verification.
- Keep each retained browser batch result inside its original untrusted-content boundaries when trimming context. Rejected batches no longer overwrite a native sibling's execution receipt when its call ID resembles a generated batch child ID.
- Mastodon: deleting your own post no longer stops at Mastodon's "Delete post?" confirmation. WebBrain opened the post's "…" menu and chose Delete, and the confirmation that its own click opened was refused as "not inside one identifiable record". When the menu entry was clicked no model had read its caption yet, so WebBrain had not tied the confirmation to the post, and while the confirmation is open Mastodon makes the rest of the page inert, which WebBrain read as the post and your account being hidden. Mastodon's dangerous entries on your own post now count as its deletion by page structure, the post and your account behind the confirmation still count, and Mastodon's own confirm button is recognized in windows narrower than 1175 px, where Mastodon shows no composer beside the timeline. A confirmation that WebBrain's click did not open, another account's post, and anything inert without Mastodon's confirmation open still bind nothing. With Mastodon's confirmation turned off, the dangerous entry is checked as the deletion itself even before its caption is read.
- Ask mode: an answer being written no longer disappears and starts over when you use the page meanwhile. In a WhatsApp trace, typing a draft and clicking in the chat while the answer was written threw the answer away twice and wrote it again each time, and the answer that finally stayed, written after you stopped, was the shortest. Scrolling, selecting, clicking and typing on the page, and the page's changes from them, now leave the answer as it is: it is about the page as you asked about it, and the run ends without waiting for you to stop typing. Navigating the page to another address still starts the answer over.
- Posting on another site after a correction: after a Mastodon post, "ok now on X" no longer leaves WebBrain going back and forth between the two sites, typing the X post again each time. It counted X as the same platform as Mastodon, because it reads account names only on X and Bluesky, and asked to find the Mastodon post on X itself, which can never happen. The site a post was made on now names its platform when no account name was read, and a post on another site goes ahead once a page has been read since the correction, provided the task made no earlier post on that site. What the task attempted is saved with the conversation, and just before each action that may post or submit something, so this still holds when the task continues after WebBrain restarted, and a post already sent on X under the correction is not sent again by a later run of the task. When the task did post on that site before, or WebBrain has no full record of its earlier attempts, it stops once and says so, instead of searching for a post it cannot find. A search, a settings save or consent click on X, a click that sent nothing or a form the page rejected is not such a post; a click that Stop interrupted after it was sent counts. On the other hosts and clients of X and Bluesky, such as X Pro, whose Post buttons WebBrain does not recognize, anything sent that may have been a post counts as one, so a post from X Pro is not repeated on x.com; this includes a Post button whose caption no model read in time, which looked like a harmless button, while Enter in the post editor there edits the draft and is not a post. If that record cannot be saved just before a possible post on X or Bluesky, the post is not sent and WebBrain says why, as it already does when a run's recovery checkpoint cannot be saved. x.com and twitter.com are one platform.
- Chrome: a page's "Leave site?" prompt no longer waits for you when WebBrain navigates away during a task that started on a page the debugger cannot attach to, such as chrome://extensions, or whose debugger connection dropped. WebBrain arms its dialog handling again at the next debugger attach and around each of its own navigations, and answers Leave for its own navigation as it already did on other runs. If you cancel the debugger, prompts stay yours to answer. Firefox offers extensions no way to answer these prompts.
- Chat sites such as WhatsApp: a request that points at the open chat instead of naming the person, such as "send some test messages to this one" or "message this user", now sends there instead of asking "which contact, and what text?". The planner never sees the page, and its rules counted only words like "reply here" as the open chat, so it asked the same question every time without reading the page. WebBrain still reads the open chat's header itself and binds every send to that one contact, and stops if no single chat is open. The planner is also told it cannot see the page, no longer reads a note about a screenshot it is never given, and leaves the wording of described messages, such as test messages or a thank-you, to the agent. One request can now cover the open chat and someone named besides it, as in "test messages here, then thank Rustem Bey": the open chat needs no confirmation, the reviewed plan shows the named person, and that person is confirmed once on WebBrain's card before the first send to them. Words that refer back to someone named earlier still mean that person, and on mail sites the people named besides "reply here" are handled as before. On WhatsApp, where a contact is confirmed through its contact drawer, one run still confirms only one chat's contact, so the second chat of such a request needs a request of its own; the agent is now told so, instead of being sent to re-read the page and retry.
- A subscription, registration or sign-in wall in front of a news article is now recognized in any language, by a model reading the wall's text once, instead of only when it used English phrases such as "Subscribe to continue reading". A Turkish "Okumaya devam etmek için abone olun" overlay now keeps WebBrain from reading the article hidden behind it, as an English one did, while an offer to subscribe beside text you can still read is not taken for a wall. A wall inside the article is found also after a long preview, and everything after the wall's text stays withheld; the preview before it stays readable, except the short passage just before the wall's text. If a page cannot be read again after its wall was recognized, the read fails rather than return what the wall hides. A wall whose number changes on every read, such as a countdown, stays a wall while its new text is read, and needs no more readings once two of its numbers were read as the wall, while a count that stops being a wall when its number changes reads as what it is once read; a wall whose other text keeps changing makes the read fail rather than leak, and the agent may read the page once more in case the wall went away.
- A dialog asking you to prove you are human now pauses the run's page actions in any language, not only when it says "Security verification", "Verify you are human" or another English phrase. Its title is read by a model once, the decision model first; LinkedIn's Turkish "Güvenlik doğrulaması" now counts, while a cookie notice or a form dialog does not. A dialog naming a CAPTCHA product still counts without any reading. A title no model can answer stops nothing and is asked about again only after half a minute, so page actions do not each wait for it.
- Finding a verification email: the service the code is for is now matched by its name or web address alone, with no English words such as "code" or "verification" set aside, so the search treats the same request in every language alike. The tool now asks the model for only the service's name or domain.
- An AWS WAF puzzle page ("Let's confirm you are human" in English) is now recognized in any language, by AWS's own puzzle script on its interstitial page, instead of by its English heading. Before, the same page in another language was not recognized as a CAPTCHA unless its widget was found, and a page running only AWS's silent check is still not taken for a puzzle.
- Editing a file on GitHub in another interface language: the "Commit changes…" button that only opens the commit dialog is now recognized by its closing ellipsis or by the dialog it names, in any language, instead of by the English words, so a Polish "Zatwierdź zmiany…" is treated like the English one. A commit message field beside the button is recognized by GitHub's own field id instead of its English label, so a button next to one keeps the full commit checks in every language.
- Resolving GitHub review conversations: which buttons resolve a conversation is now read by a model in any language, instead of matched against their names in about ten languages. A Polish "Rozwiąż wątek" now counts as a conversation still to resolve. A page whose buttons no model could read yet is not taken for a pull request with nothing left to resolve.
- Editing a video's details (YouTube Studio) and publishing posts, releases or content: which field of the saved page holds the title, description, visibility or another detail you asked for is now read by a model in any language, instead of being looked up in a list of field names in about 14 languages. A Polish "Tytuł (wymagany)" or "Opis" now counts as the title or description, so a correct save is recognized as finished, while a saved value that differs from the one you asked for, or two fields both read as the title, still is not. The labels are read when the task finishes, beside the page's status messages rather than after them, and only for fields read after the save.
- File uploads in forms and release pages: whether the page shows your file as uploaded is now read by a model in any language, instead of looking for words such as "uploaded" or "eklendi". A Polish "cover.pdf · 96 KB · przesłano" now proves the upload, and a line saying the upload failed no longer counts as proof.
- Following accounts from a list: on Mastodon, whether an account is already followed, whether the page asks for your own server, and which server your request calls your own are now read by a model in any language, not only in English and Turkish. A German "Gefolgt" now counts as followed, and the follow on a TikTok, Threads or Medium profile is no longer held back waiting for a Mastodon followed state. A click on "Takip et ayşe" or another label in any language is now recorded on the progress list when a model reads it as the run's action, for the row it names.
- Search boxes in any language now share the single approval a search gets, instead of asking again for every search. A German site's box under "Suche" or a Turkish "Ara" button counts as a search when the page marks the form as a search, the field's keyboard says search, or a model reads the button as only searching; the English word "Search" in a label no longer decides it either way. Forms that send data, ask for a password or card, or post elsewhere keep their own approval.
- Forms: which field of a form you named in your request, and the value you gave it, is now read by a model in any language instead of by matching words. A request in Turkish such as "ön yazımı ekle" now matches an English form's "Cover letter (optional)", so its value counts as entered and the optional field can no longer be skipped. Before, words in different languages never matched, so the form could not be completed, and a field you asked for could be left empty.
- Gmail: the recipient check no longer fails outright when the compose window shows a field such as the subject or a typed address. A coding error, present since version 37, made the check fail there, and the send was refused.
- Chat and mail sites: which row of a message a field is, whether a message was sent by you, and whether a sent message was delivered are now read by a model in any language, as button names already are. A Turkish webmail's "Alıcı" and "Bilgi" fields count as To and Cc, Gmail address chips under a Turkish "Gizli" row count as Bcc, a chat message labelled "Siz: …" counts as yours, and a WhatsApp message whose status reads "Okundu" counts as delivered; before, only English labels did, and a Cc field was not checked at all. Discord names a channel or contact from its selected sidebar link in any language, and WhatsApp's contact panel closes through its one header button whatever it is called, so the WhatsApp contact check no longer stops at a Turkish "Kapat". Texts a check reaches only after reading the first ones, such as the recipient rows behind a send button, are read within the same check. A text no model could read yet is taken the cautious way: a field holds no recipient, a message is nobody's in particular, and a status is not delivered.
- Chat and mail sites: whether a clicked button could send a message is now read by a model in any language, instead of matched against word lists in about a dozen languages. A Polish "Wyślij" with no message box open is held for the recipient check like "Send" was, a "Dodaj zdjęcie" (add photo) button beside the message box is no longer taken for a send, a Turkish Gmail "Yanıtla" opens the reply like "Reply" does, Turkish LinkedIn's "Gönderi başlatın" opens a new post like "Start a post", and a chat header's call or "more" button in any language is no longer mistaken for the contact's name. Each name is read once, mostly while the main model is still deciding. A button name no model could read is held like one that could send, and the same click can be tried again once it is read.
- What a clicked button does is decided by a model's reading of its caption, in any language, right before the click, no longer by word lists in about 13 languages. A Hungarian "Törlés" or Swedish "Radera" button now gets the same deletion check as "Delete" or "Sil" did; "Delete all" in any language gets no single record; "Remove filter" style buttons, composer tools and close buttons stay ordinary. A new caption is read once, by the decision model first, and while the main model decides on a page the decision model already reads that page's button captions, so most clicks wait for nothing. If no model can read a caption, the button is treated as an ordinary one, as any language outside the old lists always was. A menu button whose name reads as publishing still gets the publication checks, a button whose name reads as deleting is never taken for a draft edit, and replaying a saved workflow asks no main model for these readings.
- Chrome: when a click on a plain page element shows no effect, WebBrain clicks it once more with a real mouse click only if a model, reading the element's name in any language, does not see it sending, buying, deleting, liking, following or downloading something. The word lists in 17 languages that decided this are gone: "Fiók törlése" or "Radera konto" are now kept from a second click like "Delete account" was, while names like "Order history" or "Share price" are no longer treated as actions. A name the model cannot read keeps the retry, as any unlisted name did before.
- A click on a button of a Mastodon post shown on its own page, such as its "…" menu, or on a reply around it, is no longer thrown away and asked for again because the page or a reply changed while WebBrain was deciding. A post the page names as one item for screen readers now owns its own buttons, as posts in a timeline already do, while a change to that post, or another post taking its place, still stops the click.
- When a task ends, a search box with an "Ara", "Suchen" or "Buscar" button no longer counts as a form left unsent. Whether such a button only searches is read by the model in any language, instead of looking for the English words "search", "filter" or "go", which also matched words like "Google".
- A click on a Mastodon post, or on any timeline that marks each post as an item of a feed, is no longer thrown away and asked for again because another post's time or content changed while WebBrain was deciding. Each post now owns its own buttons, and a timestamp ticking over ("2 dk" to "3 dk") is not a change. A change to the clicked post itself, such as its author or its own buttons, still stops the click.
- What a clicked button does is now read by a model in any language, instead of being matched against an English word list. A form's "Kaydet", "Devam" or "送信" is now checked for a validation error like "Save" or "Continue" was, and a quick second click on "Gönder" or "Pagar" is held as a possible duplicate like "Send" or "Pay" was, while "Ekle" or "Filtrele" stays repeatable. Each caption is read once and only after a click that page structure does not already explain, so ordinary clicks get no extra wait. The duplicate-click guard, which the security notes listed as missing in Firefox, works the same in both builds.
- Finishing a task no longer waits long on a slow model. The decision model decides when it is sure; when it answers but is not sure, the active model's second look now has eight seconds in all instead of up to ten seconds for each of two looks, and a look that could not finish in the time left is not started. When the decision model is off or unavailable, the active model keeps its full checks. The active model's reading of the page's status messages at that point is bounded to six seconds. Traces now show where a finished task spent its time and what each verification attempt decided, without any page or model text.
- Deleting your own Mastodon post through its "…" menu works again on current Mastodon (4.4): the menu fades in a moment after the click, so WebBrain lost track of which post it belonged to and refused "Delete" ("Sil" on a Turkish server) as not belonging to any post. The menu the agent's own click opens is now kept for up to three seconds while it appears, and the menu on a post's own page counts as that post's, since Mastodon draws it beside the post rather than inside it.
- Deleting an item through its own "…" or "More" menu now works on sites that open that menu elsewhere in the page without linking it to its button, as many apps do. The menu the agent's own click opened, alone and within three seconds, belongs to that item, even while it fades in or opens inside a window already on the page. Before, Delete in such a menu was refused as belonging to no item. A menu opened by a script, by another item's button, or together with a second menu still borrows nothing, and the request still has to name the item or you confirm it on the card.
- Preserve exact editor identity and private values through owned focus and scroll preparation, while permitting the resulting geometry changes.
- Bind native input to the certified receiving control, allowing passive descendants while rejecting unrelated or nested activators.
- Preserve acknowledged click delivery through page rendering and focus restoration, with separate pending effect verification and repeat protection.
- Separate ordinary control preparation from publication and deletion checks, and reconcile prior submissions before newly authorized work after a correction.
- Report bounded action-preparation rejection predicates without exposing field values.
- Keep earlier submission receipts for reconciliation while requiring current-task receipts for completion.
- Restore native Mastodon record, menu and confirmation ownership without counting confirmation preparation as deletion.
- Show plain-language final answers when a runtime check ends a run, without brackets or internal terms; the exact diagnostic stays in verbose rows and traces.
- Render Markdown blockquotes in chat, and publish the rendered text of a quoted draft instead of literal `>` markers.
- Page monitor: harmless page activity (typeahead renders, counters, page focus, re-dispatched events, large re-renders) no longer vetoes certified multi-key input or selector clicks; the agent's own scroll and hover and pure layout shifts no longer refuse clicks; user keys and clicks during the agent's typing are attributed to the user; orphaned monitors stop; removed web components are no longer retained during a run.
- Page feedback: automatic page activity no longer discards revalidatable decisions, finished Act answers or the page_unstable budget; idle waits are no longer starved by automatic navigations; SPA route changes after agent clicks no longer cost an idle wait; stale feedback no longer leaks into the next run; Stop no longer waits for page capture; Ask answers survive user scrolling and selection.
- Finished answers no longer reopen or loop when the page changes after completion; Stop no longer sends queued messages or corrections automatically (they stay queued, marked as paused); corrections apply immediately instead of after the current model response; planner history no longer shows browser observations as user messages; Chrome keeps the local vision fallback when the page updates.
- Stop also pauses right-click menu and selection-shortcut requests made before or during the stopped task. They no longer start on their own afterwards, including after reopening the panel or in another panel; they wait in the queue, marked as paused, until you send or delete them.
- Clicks, keys and text are never sent twice when the browser loses an acknowledgement after delivery; they are reported as sent with an unknown outcome. Continue and Retry no longer repeat an unconfirmed trusted click. Stopping while a field is being filled no longer submits it. Buttons that lift or change border on hover can be clicked.
- Firefox: a page's own fractional scrolling is no longer treated as a window or zoom change, so it no longer invalidates certified decisions where Chrome keeps them; real resizes, zoom and user scrolling still do.
- A Delete or Remove you ask for on an ordinary row without its own link (a cart item, a mail row, a table row) is no longer always refused. It proceeds when your latest request asks for the deletion and names that row by a word only that row shows, including the confirmation dialog the click opens. The same row is never deleted twice; toolbar and bulk deletions, menus without a linked button, and posts with a permalink keep their previous checks.
- Asking to delete such a row in your own words now works: inflected Turkish words ("mavi tişörtü kaldır" for "Mavi Tişört", "faturayı sil"), Turkish capital I and ı, English, German, Spanish and French plurals, and Chinese, Japanese and Korean requests written without spaces ("删除蓝色T恤", "このメモを削除"). The row must still be the one your request names more clearly than the rows around it, so a word two rows share, a different but similar word ("elma" is not "elmas"), or one shared character never selects it.
- Ordinary controls (filter chips, folder links, menus, tabs, toggles, draft attachment and media removal, composer tools) work before and after a correction; X and Bluesky no longer reject them as unidentified publication actions. After a correction, identical resubmissions are reported as already done, a corrected in-place save or a requested post on another platform is allowed once the earlier result is known, and requests to remove characters or hashtags are no longer treated as deleting the post. A submit-probe exception that left real publish controls unresolved is fixed.
- A correction sent while a run is working is no longer lost when the extension background restarts before the run uses it. The resumed run applies it first, once, in the order it was sent; if the run does not resume, the correction returns to the queue marked as paused, as after Stop. Clearing the conversation or closing the tab discards it.
- Buttons that animate when the pointer reaches them (a hover lift, scale or border transition) are no longer refused once before working: the click waits up to 0.6 seconds, without sending anything, until the button stops moving, then presses it once at its new centre. A button that keeps moving, is covered or replaced, or any input or Stop during that wait still cancels the click. Hover, drag and drop, and checkbox actions refused before any input are reported as not sent.
- Sending a message to someone whose name differs from your request (you asked for "gamze", the open chat is "Gamze Çömlekçi") no longer ends in "Send blocked by safety guard". WebBrain asks you once on its own card, "Send to Gamze Çömlekçi?" with Send and Don't send, and sends only after you click Send; Don't send stops that send for the rest of the task. The card shows the person the open conversation actually has, reads the same in every language, and does not depend on how the model words a question. A question the model asks itself no longer approves a send, whatever you pick or type on it; before, a reply that refused or corrected ("No, not Gamze Çömlekçi", "Cancel all") could authorize the send. Firefox now behaves like Chrome. Attachment and emoji buttons next to a chat box (Instagram's "Add Photo or Video") are no longer treated as Send buttons.
- Deleting something your request does not point to exactly ("remove the first item", or a post you describe without its link) no longer ends in a refusal that no answer could fix. WebBrain asks on its own card, "Delete this item on <site>?", showing the item as the page shows it and the site's own confirmation question when there is one, and deletes it only after you click Delete, including through that site confirmation; Don't delete keeps it, and you are not asked about it again in the same task. Toolbar, bulk and repeated deletions are still refused.
- Whether your request asks to delete an item, whether a correction asks to delete the earlier post first, and whether you said not to send a message are now read by a model in any language, instead of by word lists in a few languages. The decision model answers when it is turned on in settings; otherwise the active model answers and must quote your request. When neither is sure, WebBrain asks you on its card or does nothing; a request that says not to delete or send something is refused without a card.
- The text of a direct message you ask WebBrain to send on X is now read from your request by the model, in any language, instead of being cut out by lists of command verbs, negations and conjunctions. A long message is copied exactly from your request between the first and last words the model quotes, so it is no longer shortened to an excerpt.
- Replying "devam et", "続けて", "merci" or any other short "continue" or "thanks" while a task is under way in Act mode now keeps that task, its progress list and its approved plan, in any language; before, only a list of English words did. A model reads short replies once when they arrive; anything it is not sure about is treated as a new request, as before.
- Asking to go through an Instagram carousel from the last slide to the first now works in any language; before, only a few English and Turkish words did, and a request that merely contained the word "reverse" (for example in a caption it asked to record) scanned backwards.
- The note "Future upvotes and moderation outcomes remain unverified" after a published post now appears whenever your request expected votes or posts not being removed, in any language, and no longer appears just because a request mentions upvotes. The model that checks the finished task answers this in the same check, so it never adds a call.
- A final answer that only says it "explained" or "confirmed" something, or only describes what it will do next, is now caught in any language and sent back for the real answer. The model that checks the finished task reads the summary in the same check; in Ask mode a model reads a short answer before it is shown, and a failed or partial Act result is read the same way. A failed result that wrongly blames Ask or read-only mode in an Act run gets the same mode correction as before, in any language. Before, only English phrases were caught.
- Typing "take a screenshot" (or its Turkish form) no longer turns your message into /screenshot by matching those words. The message goes to WebBrain's model like any other request, in any language; /screenshot is still the instant way to capture the page into the chat.
- A follow-up such as "just give me the 15 hotel names" is no longer turned into a fixed hotel plan by matching English or Turkish words. The planner reads the narrowing in any language, and the plan you review is the one that runs; an edited plan takes its expected items only from its own expected-items line.
- Accounts you leave out of a GitHub follow task ("everyone except alice") are now read from your request by the intent model in any language, instead of by an English "except" parser. Ledger rows saved by older WebBrain versions are reused for a task only when that task's classified intent covers them, instead of when its English words matched.
- A message your request did not clearly ask to send, or did not say who should get, is no longer blocked with an instruction to ask you that no answer could satisfy. The same "Send to …?" card now shows the message text and why WebBrain is asking. A correction you send while either card is open now applies the correction instead of stopping the run.
- A request that only asks for arithmetic ("calculate 12 * 7 + 0.5 and report the exact result", or a mid-run "new task: calculate ...") is now recognized in any language by a model reading it, instead of by an English grammar with a few Turkish, German and French words; a request worded differently, or written in Chinese or Japanese, used to run as an ordinary browser task. When the request also says how the answer must end (a marker or code), the model writes that down with the text copied exactly from your request; any other required format is checked by the model that checks the finished task.
- A collected value that only says it is missing ("unknown", "bilinmiyor", "不明", "—") no longer lets a list of expected items count as complete, in any language: a model reads the short required values once when the task reports success. Before, only a few English words were caught.
- Progress lists and requested workflow fields take only WebBrain's own action and field names, which the models are given. A model that writes another word for an action ("scrape", "collect emails") is told the names to use, like a wrong status, instead of English synonyms being mapped and other words silently ignored.
- Page wording in other languages no longer changes what WebBrain does in these places, because they now read the page's structure instead of English words: Gmail result counting reads "1–50 de 2.345", "51–100 из 175" or "第 1-50 封，共 2,345 封" by their numbers; an Instagram carousel's slide count is read from the shape of its labels ("Diapositiva 3 de 16", "3/16"), and its Next button, when needed, by a model in any language; a carousel that goes back and forth is caught by the slide numbers it reaches, whatever its buttons say; ChatGPT research is checked for log-in, stop and send through ChatGPT's own markers; and when a long page is trimmed for the model, the buttons beside a text box (a Send in any language) are kept first.
- Success and error messages a site shows after you submit, save or send something are now read by a model in any language, instead of by English words. A form that stays on screen after "Başvurunuz alındı" or "Votre demande a été enregistrée" now counts as submitted once the message is read as success; a message read as an error keeps the submission unverified; and a validation alert in any language ("Lütfen geçerli bir telefon numarası girin.") now stops a rejected submit, while one the site marks as an error stops it unless it is read as success. Confirmations that finish site tasks (a form submitted, changes saved, a draft saved, a message sent, review threads resolved) are read the same way. Each short text is read once and remembered, and nothing is read unless a submission still needs that proof.
- The model that checks a finished task now sees the latest read of each page the run read recently, so a page the task depended on earlier (its rules, a source) is no longer dropped because it was not written in English.

## [40.3.0] - 2026-10-12

### Changed
- Record the version published under tag `v40.3.0`; subsequent development changes are listed under Unreleased.

## [40.2.2] - 2026-10-12

### Changed
- Record the then-current development version from `package.json` and both browser manifests; this entry does not certify a published release.

### Fixed
- Retain conversation-only Ask replies through automatic iframe changes, with bounded retries for page-dependent answers and prompt cancellation for mid-run corrections.
- Recover discovered hidden file inputs through their visible widgets, and certify native disclosure and authored interactive controls without weakening target or user-intervention checks.
- Verify saved releases, generated message drafts and metadata edits against task-bound evidence and exact fresh readback; preserve completed submission progress in failure messages.

## [40.2.0] - Unreleased

### Summary

- General DOM monitoring repairs prevent decorative icons, passive updates and acknowledged agent preparation from incorrectly invalidating unchanged controls, while retaining checks for real target or user changes.
- Mid-run task changes, Stop, durable chat recovery, Telegram/WhatsApp observation, recipient ownership and completion receipts are covered by causal and installed-browser regressions.
- File download/upload ownership, literal editor input, exact calculation and complete literal table delivery are repaired across Chrome and Firefox.
- The original audit passed 9,765 Node/main cases and all 21 installed browser stages; coverage was 65.16% lines/statements, 78.74% branches and 87.25% functions. The Codex review follow-up additionally passed 72 focused, 155 neighbouring and 2,450 main regression cases. Both browser builds passed.
- Real-account two-hour endurance remains unverified. The first fresh PR CodeQL findings check flagged 32 changed-code alerts (31 high, one medium); the comparison and directly related QA fixture repair are recorded in the appendix. This entry records the proposed release; the audited runtime remains 40.0.8.

The complete dated audit, including earlier failures, tracked effects and verification limits, is copied in the [40.2.0 appendix at the end of this changelog](#appendix-4020-quality-audit). A standalone copy is available in [the audit report](docs/quality-audit-2026-10-07.md).

### Added
- Added bounded exact decimal arithmetic through a read-only `calculate` tool.
- Added native Telegram observation and delivery verification, with isolated installed-extension regression tests for generated conversations.
- Added native WhatsApp one-to-one contact observation and opaque-ID delivery proof from a freshly verified contact drawer and retained pre-send transcript nodes.
- Added a full-suite Node coverage command and optional live-model browser checks.

### Fixed
- Share concurrent cold UI snapshot reads so service-worker restart and continuation cannot discard saved events or progress; preserve clear/new-run invalidation.
- Reject injected URL parameters in the disposable workflow QA server without changing valid fixtures or weakening replay checks.
- Keep Enter-dispatch uncertainty truthful when reusing an owned chat draft, without weakening pending-send or duplicate-send guards.
- Preserve exact native commit acknowledgement provenance for independent completion reconciliation after interrupted observation.
- Bind planner reference-history repair to the current task, permit at most one verified replan, and recheck Stop/steering authority.
- Execute one-use native chat read preparation through guarded tools, retire stale preparation when tasks change, and report unscheduled partial endings truthfully in all 23 UI languages.
- Preserve complete table JSON, literal Unicode and row order through fresh source verification, terminal delivery, persistence and cold UI replay; reject oversized complete output before issuing a reference.
- Correct privacy/default-sharing disclosures across 22 localized landing pages, and retain the website JSON script-boundary hardening tests.
- Matched spreadsheet services and social image upgrades against parsed URL hosts and supported paths, preventing unrelated path or query text from selecting a service or changing an image URL.
- Replaced ambiguous grouped-recipient and bulletin-comment matching with bounded linear parsing, preserving recipient role, negation and content checks.
- Made the bundled BitGPU XML tool parser consume complete blocks in order and treat declared arguments as own data properties; generation template preprocessing now avoids repeated whitespace backtracking.
- Bound hidden file uploads to a fully observed native section and its distinct visible purpose, distinguishing repeated Upload controls without site-specific rules.
- Preserved a verified native chat draft when explicit submission is blocked before Enter; a fresh observation and new model-approved send can submit the same owned draft once, while actual or ambiguous submissions remain pending.
- Bound complete native navigation, banner and tab-list contexts across all sites, preserving unchanged actions during unrelated passive updates while retaining account, target and user-intervention checks.
- Preserved the bound action when a noninteractive decorative SVG hit is replaced, while rejecting changed controls, handlers, recipients and overlays.
- Distinguished an initially unverified action context from an actual page change, retaining bounded fresh-observation recovery without dispatching an uncertified action.
- Kept hidden noninteractive icon labels out of model-visible dialog identity while preserving target semantics, handler checks and harmless navigation badge updates.
- Recovered native Telegram username routes through exact numeric peer evidence and narrowly guarded read-only menu, Settings and profile preparation.
- Initialized cold native read-only preparation only inside the current private capture and preserved its one-use proof through actual guarded dispatch.
- Required a verified latest Telegram viewport and one shared highest-200 mounted native ID floor, including media-only rows; refused changed observation-to-probe baselines before persisting or dispatching a structured send.
- Restored supported native chat tools in the full planner catalog and kept literal calculation independent of passive page updates.
- Accepted completion of a current, exclusive arithmetic task from its actual owned calculation result, while preserving mixed-task, pending-action and Stop checks.
- Matched arithmetic expressions through the calculator's shared lexer and bounded parser, allowing whitespace between exact tokens while rejecting split numbers, changed inputs and mixed tasks.
- Retained plain responses for a current arithmetic-only task during passive page updates so normal recovery can demand the actual `calculate` call and explicit `done`; plain text never creates calculation evidence or success.
- Kept exclusive arithmetic tasks on `calculate` and `done`, projecting `done` alone after the current calculation receipt so unrelated browser actions cannot derail completion.
- Verified explicit arithmetic completion against the actual owned result and recognized output requirements; unsupported formats retain the ordinary evaluator with bounded calculation evidence.
- Rechecked original task, provider, receipt, run and document ownership across completion awaits and errors, and kept incorrect result or marker summaries repairable without creating browser verification debt.
- Allowed positively resolved ordinary social UI controls for current nonpublication tasks without weakening Send/Publish contracts.
- Verified native Chrome contenteditable clear-and-replace operations through an exact temporary deletion receipt while preserving authored line breaks and user-intervention checks.
- Restored native WhatsApp contact verification for generic, unfocused composers and supplied exact contact-name and Close references for fresh accessibility reads and guarded identity repair.
- Preserved native WhatsApp identity through unrelated contact-drawer media and Close-icon updates, while requiring unchanged original identity nodes and a guarded native Close receipt.
- Explained historical WhatsApp message views with an exact message-pane reference for scoped scrolling and fresh observation before sending.
- Prioritized exact private WhatsApp repair targets in the normal accessibility observation before inference, avoiding an extra model read for a current native contact-name control, captured Close button or historical message pane.
- Kept manual and queued messages bound to their original tab and draft across asynchronous work.
- Preserved accepted mid-run corrections through terminal recovery, and kept Stop ahead of pending corrections.
- Restored current unanswered permission and clarification cards after acknowledged progress or panel reopening, with live request, task and provider ownership checks.
- Woke obsolete permission waits when a mid-run correction is accepted, without granting the earlier permission or dispatching its action.
- Made startup cancellation, browser action deadlines, and persisted tool batches reliable.
- Verified the submitted form and fresh acknowledgements without letting unrelated live counters invalidate successful completion.
- Preserved completed bulk-work progress across Continue and retried only unfinished items.
- Preserved literal multiline rich text, and fenced iframe preparation and dispatch against Stop and intervening user edits.
- Replaced session-changing PDF HEAD probes with document-owned MIME evidence.
- Kept shortcut key releases inside the shortcut even when submitting closes it before keyup.
- Persisted native chat delivery and message watermarks to prevent duplicate replies and stale delivery replay after worker restarts.
- Kept nested chat sends, ordinary guarded sends and terminal completion evidence consistent.
- Removed false chat loop warnings, bounded repeated unchanged page retries, and made recovery text processing linear.
- Kept trusted task anchors separate from injected page context and guarded malformed cloud bridge messages.
- Bound MemCode connections, refreshes and late recall results to the current account and opt-in state.
- Fixed strict planner schema compatibility and kept protocol repairs separate from the genuine user task.
- Kept chained chat-resume alarms distinct from their running predecessor, and restored fresh native delivery proof after worker restart.
- Counted generic chat submissions from exact fresh native delivery receipts and reconciled only the matching single-conversation reply ledger.
- Recognized Mastodon's rendered decorative privacy icons while retaining hidden-control and document ownership checks.
- Shared provider message projection and kept private resume metadata out of external request payloads.
- Re-read the exact accessibility subtree across model decisions so offscreen controls remain safely targetable.
- Preserved native chat empty-editor receipts without discarding authored line breaks, and kept nested blocked-send recovery instructions intact.
- Made same-peer observation echoes idempotent without resetting pending delivery state.
- Exposed rendered native dropdown actions below the viewport while preserving dispatch ownership checks.
- Retained exact native commit ownership through an explicit same-origin verification navigation and a fresh independent verdict.
- Kept delayed chat delivery receipts attached to their original question when a new question needs the same reply body.
- Preserved the latest unread tool result through context compaction, including its complete tool-call group and task authority.
- Checked ancestor visibility for native confirmation actions, and excluded invisible duplicate modals and primary buttons from their ownership checks.
- Left bounded output room for thinking models to produce the independent completion verdict.
- Captured verification navigation at native document commit so delayed content-script readiness cannot discard the original action proof.
- Included the actual tool schemas in first-request context sizing and corrected the onboarding context-window guidance.
- Recognized the configured active provider during onboarding, kept stale local scans from replacing it, and made “Skip for now” actionable when no local model is found.
- Awaited local onboarding persistence before focusing the composer.
- Recovered saved workflow targets from native AX attributes without selecting a reused ID that contradicts the recorded field name.
- Settled watch checkpoints from matching fresh independent completion evidence and rechecked Stop and accepted corrections after terminal persistence.
- Preserved literal editor line breaks and rejected incomplete native DraftJS reads.
- Bound complete read-only dialog labels while rejecting nested clickable or focusable identity displays.
- Removed stale “running” wording from the static plan-approval note.
- Required a one-use user answer before reconciling an uncertain outgoing message, with exact pending-record, task, provider and conversation ownership checks.
- Recovered an extension-owned Chrome debugger after a service-worker restart, while rejecting foreign ownership, permission failures and late replies after detach or Stop.
- Preserved one-to-one WhatsApp send evidence only across the same genuine task, provider, account and document; Stop, a new task and lost transcript evidence retain an uncertain send without resending.
- Verified exact native page-handled drafts independently of unrelated DOM updates, while preserving stale-action refusal and pinning the original chat identity nodes.
- Persisted exact scheduled completion outcomes before snapshot cloning, and kept late terminal or restored UI events from overwriting a resumed or newer task.
- Classified completion and notifications against the latest accepted task correction, preserving earlier events in history while preventing an old success or error from replacing the corrected task's result.

## [40.1.1] - 2026-10-11

### Changed
- fix(ci): patch-release meta test covers sharded pipeline
- fix(ci): release-workflow meta test covers sharded suite
- ci: compose npm test from shards, fixtures on tail job
- fix(web): drop Multilingual UI feature card from homepage
- ci: shard Build and Package tests across parallel jobs
- Add last update date to prompt injection defense
- fix(web): align homepage tests and locales with current landing structure
- fix(release): promote Unreleased changelog draft instead of failing
- fix(cloud-runs): keep tab reserved through video flush cleanup
- 40.1.0
- feat(web): optimize homepage section ordering and presentation
- 40.0.9
- fix: share cold UI snapshot reads across concurrent callers
- docs: add fresh PR scan results to the 40.2.0 audit
- test: constrain workflow fixtures and record PR scan findings
- fix: harden browser workflows and document 40.2.0 audit
- feat(runtime): merge cloud execution recovery, private results, and tool fixes
- Add explainer visuals 10-12 and modernize SafeSocial as 13
- Fix empty assistant reply bubbles
- Fix cross-site editor and dialog verification
- version up
- added tests
- version up
- Bump extension version to 40.0.6
- Fix repeated message approvals and chat dispatch
- version up
- Fix browser action progress during passive page updates
- agent: track finite collection read progress
- Fix photo downloads rejected by passive page updates
- Prevent browser feedback from starving agent progress
- Fix completion retries during passive page updates
- version up
- bugfixes
- 40.0.1
- icon change
- changes
- docs: add 40.0.0 changelog
- Bound child frame gestures and guard iframe clicks
- Attribute agent-driven window resizes
- Refresh workflow page before AI fallback
- Attribute local synthetic clicks to agent dispatch
- Prepare Firefox BiDi target frame monitor
- Close page feedback review gaps
- Fix keyboard activation feedback attribution
- track form and accessibility navigation changes
- track form validation bypass changes
- fix page feedback frame and state monitoring
- Fence Firefox fallback uploads against stale page feedback
- version up
- fix page feedback for base and animated changes
- fix page feedback for GET forms and stylesheets
- fix redirect correlation and bounded page monitoring
- observe submitter form association changes
- attribute local form events and shadow focus
- attribute capture scroll and correlate click navigation
- cover all form state and hidden native labels
- observe form submission method changes
- fence WebMCP dispatch after page feedback
- fix remaining page feedback monitor review findings
- Fence accessibility focus and BiDi dispatch
- Observe accessible-name relationship changes
- Track editable text and field metadata changes
- Guard CDP click fallbacks against page feedback
- Fix native hover attribution and guarded JS evaluation
- Fix stale page feedback dispatch races
- Fix page feedback dispatch fencing
- fix page feedback review findings
- fix page monitor review findings
- avoid idle waits on automatic scroll events
- track shadow text and select state changes
- fix fenced iframe click monitoring
- fix layout and recovery monitoring feedback
- align monitor tests with page dispatch timing
- fix page feedback review findings
- fix: monitor popovers and release gestures over owned UI
- fix: observe full text and aria-pressed state changes
- fix: monitor focus movement and large related-frame changes
- fix: attribute preparation scrolls and recover empty Firefox frames
- fix: fence selector scrolling and observe viewport state
- fix: attribute contenteditable gate and synchronous native edits
- fix: await frame monitors and register owned decorations
- fix: defer input attribution until actual dispatch
- fix: scope navigation correlation to dispatched frames
- fix: attribute native uploads to the Firefox file input
- fix: correlate navigation with dispatched page actions
- test: cover explicit queue shortcut after main update
- fix: monitor subtree replacements and late shadow roots
- feat: monitor browser changes during agent runs

## [40.0.8] - 2026-10-07

### Added
- Added upstream regression coverage for trusted field preparation and dialog control labels.

## [40.0.7] - 2026-10-07

### Fixed
- Tightened passive page feedback for dialogs, external control labels and tool-free responses.
- Distinguished unchanged trusted editor preparation from an uncertain dispatched text write.

## [40.0.6] - 2026-10-07

### Fixed
- Preserved recipient approval across Continue and reported missing draft or delivery evidence as a technical blocker instead of repeatedly asking for the same approval.
- Updated WhatsApp composer, outgoing message, and recipient-bound dispatch checks for the current web client.

## [40.0.5] - 2026-10-07

### Fixed
- Kept browser actions progressing when unrelated page updates arrive during observation and dispatch.
- Tracked finite collection reads so previously unseen ranges advance the task without allowing repeated reads to reset progress.
- Preserved photo download bindings across harmless page updates and prevented browser feedback from starving task progress.
- Retried task completion safely when passive page updates arrive.

## [40.0.2] - 2026-10-07

### Fixed
- Improved recovery and progress tracking after the page feedback monitoring rollout.

## [40.0.1] - 2026-10-07

### Changed
- Updated the release artwork and refreshed the 40.0.0 release materials.

## [40.0.0] - 2026-10-07

### Added
- Added page feedback monitoring across forms, navigation, frames, accessibility state, and browser automation, with consent based trace snapshots for GitHub feedback drafts.
- Added decision model verification for task completion using fresh, run scoped page evidence and safer handling of cost limits in scheduled jobs.
- Added Ling 3.1 Flash planner benchmarks and a historical planner comparison panel for Ling and Nex.

### Changed
- Improved recovery from rate limited browser inference without replaying completed tool actions.
- Improved Firefox BiDi and CDP action attribution, stale page feedback fencing, and WebMCP registration recovery.
- Added a Turkish README translation and refreshed planner benchmark materials.

### Fixed
- Fixed page feedback attribution and monitoring for keyboard actions, shadow DOM, forms, redirects, stylesheets, frames, and animated page changes.
- Fixed completion evidence freshness and scope so unrelated or stale page changes cannot satisfy a run.

## [39.2.2] - 2026-10-10

### Changed
- test(feedback): wait safely for asynchronous submission result
- fix(captcha): resolve Firefox bridge script from extension root
- fix(captcha): persist bridge registration across restarts
- fix(captcha): scope callback bridge to enabled providers

## [39.2.1] - 2026-10-10

### Changed
- chore: bump version to 39.2.0
- fix(captcha): preserve callback completion and retries
- feat(providers): add Claude Sonnet 5.5 and Haiku 5.5 support to Anthropic provider
- docs(faq): localize subscription-unrecognized, emergency-box and offline-licensing in all locales
- docs(faq): add paid-but-asks-again subscription entry, promote workflow-editor to locale sources

## [39.2.0] - 2026-10-10

### Fixed
- Preserve CAPTCHA completion callbacks for widgets rendered during page load in Chrome and Firefox.
- Prevent callback retries from replaying response-field events or replacing a successful field application.
- Install the Firefox callback bridge in the detected inherited-origin descendant frame.

## [39.1.4] - 2026-10-09

### Changed
- Complete release locale coverage and requested local provider label
- Remove retired CAPTCHA locale keys required by release checks
- Match local WebGPU bundle to its native runtime factory
- Pin renamed d1 browser decision package
- Use service-worker-safe imports and guarded local decision diagnostics
- Add opt-in pinned FP32 local decision provider
- feat(providers): support custom titles and unlimited duplicates
- Exclude mutable accounting metadata from feedback snapshots
- Freeze feedback traces when the rating prompt opens
- Publish Ling 3.0 Flash VL budget vision benchmark and raw results
- Attach feedback traces to GitHub drafts with explicit consent
- Bound rejected WebMCP registration retries and explain DOM recovery
- Add Ling and Nex historical planner panel and prepare matched vision replay
- fix(agent): propagate completion cost stops to scheduled jobs
- Add Ling 3.1 Flash planner benchmark and blog comparison
- fix(agent): isolate completion evidence to the active run
- fix(agent): scope completion freshness to shared evidence
- fix(agent): fingerprint complete UTF-16 document text
- fix(agent): verify moving visual evidence with fresh AX
- fix(agent): preserve completion fallback and evidence freshness
- feat(agent): verify completion with decision models and fresh evidence
- Recover rate-limited browser inference without replaying tools
- Consume final-step steering before terminating a run
- Reset superseded skills before steering reauthorization
- Hide unconfigured media generation tools and guidance
- Skip superseded planner recommendations and allow form-free image previews
- Preserve recovery task hashes and recognize localized LinkedIn previews
- Preserve steering through emergency trims and initial responses
- version up
- build(deps): bump @modelcontextprotocol/sdk in /mcp-server
- Fix media service-worker imports and support OpenRouter videos
- Fix steering reauthorization and LinkedIn message inspection
- version up
- Add OpenRouter and Comfy media providers
- Add Turkish README translation for WebBrain
- version up
- fix: accept successful fal.ai generation as completion evidence
- fix: honor GPT-6.1 and Opus 5.5 contracts
- feat: add GPT-6.1 Sol and Claude Opus 5.5
- Unify bridge controls in Bridge tab with preset pills, queue shortcut, and full localization
- Translate composer delivery setting in all locales
- Simplify steering controls and add default delivery setting
- chore: release v39.0.0
- build(deps): bump multidict
- build(deps): bump multidict
- build(deps): bump proxy-addr
- build(deps): bump proxy-addr from 2.0.7 to 2.0.8 in /mcp-server
- Add optional steering to active chat runs
- Benchmark Ling 3.0 Flash VL against Nex-N2.5 and MiniMax M3
- fix: harden fal.ai media generation
- chore: uncomment the .gitignore
- fix: match source-inspection regexes in chrome background.js
- feat: add fal.ai generative media tool to the assistant

## [39.2.0-preview] - 2026-10-07

### Added
- Added generative media creation with fal.ai, OpenRouter, and Comfy providers, including video support and safer provider handling.
- Added optional MemCode OAuth recall and controls for steering active runs, including queued follow-ups and localized Bridge settings.
- Added GPT-6.1 Sol and Claude Opus 5.5 provider support, plus Ling and Nex planner comparison tools.

### Changed
- Improved completion verification with fresh page evidence, run-scoped results, and clearer handling of cost limits in scheduled jobs.
- Improved steering recovery and authorization, including final-step corrections and LinkedIn message inspection.
- Updated Turkish documentation and refreshed media and planner benchmark materials.

### Fixed
- Fixed media generation tool visibility when providers are not configured and corrected service-worker imports for media providers.
- Improved recovery from superseded planner recommendations and recognition of localized LinkedIn previews.

## [39.0.0] - 2026-10-06

### Added
- Added optional steering for active chat runs. While a run is active, Send / Enter queues follow-ups per tab and Steer / Alt+Enter sends a correction to that same run; queued messages also have a Steer action. Corrections are accepted from the chat panel only for the matching run request ID, consumed as user messages at model/tool boundaries, skip the remaining tool calls in the current batch, preserve mode and permission checks, disable the JEV fast-path once steering is accepted, and requeue via journal event if the run ends first.
- Added frozen Ling 3.0 Flash VL benchmark against Nex-N2.5 and MiniMax M3, with comparison blog post, verification artifacts, and reporting script (`test/llm/report-ling30-comparison.mjs`).
- Added `chat_steer` background handling, steering toasts/queue UI, `sp.steer.*` locales across all languages, and `test/chat-steering.mjs` + `test/chat-steering-ui.mjs` coverage wired into `test:runtime-lifecycle` and new `test:chat-steering`.

### Changed
- Extended the social publication contract and audit prompts with chronological `steering_messageN` sources so later corrections or cancellations supersede the initiating request and earlier revisions.
- Documented active-run steering in `docs/architecture.md`.
- Bumped `proxy-addr` 2.0.7 → 2.0.8 in `/mcp-server` and `multidict` 6.7.1 → 6.9.1 in docs vision-model sources.

## [38.0.15] - 2026-10-05

### Changed
- Include separately approved reductions in quota reassessment
- Document the approved fifty-cent Compass transition rollout
- Clarify completed UTC weeks in quota rollout validation
- Keep response-only quota stops unsuccessful through replay
- Refresh pending social claims from the check status action
- Verify Mastodon instances before forwarding public media URLs
- Complete quota validation and harden fixture locale coverage
- Fix reviewed quota recovery and browser test failures
- Support Bluesky and Mastodon public media downloads via FreeSkillz
- Add mirrored Compass quota recovery and social claim flows
- docs: translate workflow editor FAQ
- docs: link workflow editor from FAQ
- Fix text click guard target parity
- fix(cloud-runs): address PR 3138 review - keepalive, resume envelope, delay clamp, success wins, strict URL docs
- Announce SafeSocial on Google Play
- Run release fixtures and finish portable browser test support
- feat(providers): add Freebuff2API integration
- Keep Cloud continuations tracked and report actual completion outcomes
- Address review regressions in text targeting and LinkedIn guards
- Preserve guarded key dispatch and portable browser regression checks
- Fix composer detection and eligible text click preference

## [38.0.14] - 2026-10-04

### Changed
- Fix /btw fork orphaned tools, reload reset, and prompt loss
- docs: add 38.1.0 changelog
- Fork /btw conversations
- Fix /btw window coordination
- Fix /btw prompt forwarding and handoff recovery
- Add /btw side conversation command
- feat(memory): add opt-in MemCode OAuth recall

## [38.1.0] - 2026-10-04

### Added
- Added `/btw` side conversations, including prompt forwarding, handoff recovery, independent window coordination, and the ability to fork a conversation.
- Added opt-in Cloud Bridge browser registration and approval, with documented security controls and Firefox bridge support.
- Added OpenRouter capability overrides for native tool use and vision, including support for the auto-only Muse Spark tool-choice mode.
- Added opt-in MemCode OAuth recall.

### Changed
- Isolated keyed Cloud conversations and reset task roots independently to prevent cross-conversation state leakage.
- Kept Muse Spark classifier reasoning within output budgets.
- Updated browser billing recovery notices and their regression coverage.
- Added full-page Firefox screenshots through BiDi and refreshed the Chrome and Firefox store listing drafts.

## [38.0.13] - 2026-10-01

### Changed
- version up
- fix(captcha): align provider contracts and recover interrupted signup
- Share opt-in provider diagnostic traces
- fix(captcha): ignore empty callback placeholders when applying solutions
- up
- fix(traces): assemble full exports outside runtime messaging
- fix(captcha): recover successive challenges and export full traces
- Canonicalize tool-arg loop keys so key order cannot dodge the limit
- up
- bugfix
- up
- bugfixes
- version up
- fix(captcha): deliver callbacks and recover solve state
- Document CMS API-first coverage in the French and Chinese skills guides
- Stop rejected actions from looping forever before dispatch

## [38.0.1] - 2026-09-30

### Changed
- chore: bump version 37.0.1 → 38.0.0
- Use Sanity HTTP publish identity and preserve document revision guards
- Narrow CMS adapter injection to supported editor routes
- Tighten CMS prompt budgets and verify per-run skill reset
- Add conditional API-first content skills for nine CMS platforms
- Fix Compact WordPress API guidance and REST route loop detection
- Add API-first WordPress content skill and editor fallback guidance
- Retire stale CAPTCHA documents consistently across recovery paths
- Handle expired CAPTCHA answers without trapping completion
- docs: minor wording tweak in trace-format-compatibility
- Fix CAPTCHA answer recovery and provider fallback validation
- build(deps): bump fast-uri
- build(deps): bump the uv group across 1 directory with 4 updates
- Recover paid native CAPTCHA answers after chat clear
- Preserve DataDome and FunCaptcha sessions and GeeTest modes
- Match Lemin API hosts before native fallback
- Bind hCaptcha User-Agent to target frame and Tencent script
- Preserve Yidun and reCAPTCHA endpoints in fallback
- Match Alibaba verification metadata before fallback
- Keep native CAPTCHA dispatch across chat clears and validate array payloads
- Preserve hCaptcha cookies and GeeTest service identity in fallback
- Compare reCAPTCHA session cookies before fallback
- Guard NoneCap token injection by browser User-Agent
- Persist native CAPTCHA dispatch locks before provider calls
- Match recognition constraints across CAPTCHA fallbacks
- Preserve paid CAPTCHA answers across worker restarts
- Retire stale CAPTCHA gates and validate Cloudflare fallbacks
- Match FunCaptcha fallback service hosts
- Infer hCaptcha Enterprise from explicit rqdata
- Validate CAPTCHA instruction aliases and child frame freshness
- Reject undocumented nested CAPTCHA parameters
- Match TSPD snapshots and reCAPTCHA v3 fallback scores
- Match CAPTCHA fallback instructions and visibility
- Gate CAPTCHA application and match fallback proxy identity
- Retire stale CAPTCHA documents and validate fallback User-Agent
- Fix CAPTCHA answer retention and v2 fallback identity
- Retire stale CAPTCHA answers and correct Enterprise rqdata guidance
- Require complete CAPTCHA fallback identifiers and preserve falsy answers
- Match text challenge questions before paid CAPTCHA fallback
- Bind native CAPTCHA fallbacks to observed media and frame URLs
- Keep native CAPTCHA answers available until first mutation
- Align CAPTCHA tool documentation with mode availability
- Keep recoverable CAPTCHA application failures pending
- fix: observe field-only Discord embeds
- Retain native CAPTCHA dispatch history across document restores
- fix: support transcript-bound Discord threads
- Bind native CAPTCHA fallback and replay to observed challenges
- fix: verify Discord sends against authored text
- Fix CAPTCHA routing, answer application, and provider validation
- fix: validate Discord guild transcript route
- fix: bind Discord DM and send evidence
- Integrate documented CAPTCHA provider catalogs and weighted solving
- fix: capture Discord polls and bound send reconciliation
- fix: allow new Discord DMs to bind safely
- fix: reconcile delayed Discord observations safely
- fix: allow Discord management on message links
- fix: handle Discord permalinks and global avatars
- fix: recognize Discord direct-message conversations
- fix: restore Discord navigation and durable delivery evidence
- fix: preserve unknown Discord identity on DM routes
- fix: support Discord guild avatars and account settings
- fix: recognize localized Discord settings and rail
- fix: classify Discord avatars and dialogs structurally
- fix: verify Discord sends without name identity
- Address Discord observation review feedback
- Fix Discord management guard and chat observation

## [38.0.0] - 2026-09-30

### Added

- Added API-first content skills for nine CMS platforms: Contentful, Drupal, Ghost, Joomla, Sanity, Shopify, Strapi, Webflow, and Wix. On Mid and Full they load through the skill catalog only when the task needs them, then prefer the platform's own API for existing content and fall back to the editor when authentication, permissions, or Secret Handling rule the API out. All nine files and the adapter module are byte-identical across Chrome and Firefox.
- Added a WordPress REST API skill covering posts, pages, REST-enabled custom types, and taxonomy. It reuses existing record IDs, creates content as a draft, and publishes that same record only when asked; a missing `/allow-api` grant is requested once, and Ask mode cannot write.
- Added NopeCHA and NoneCap as CAPTCHA fallback providers, bringing the catalog to seven. Each has its own key, enable toggle, weight, balance check, and localized Settings controls, and both serve the hCaptcha families.
- Added a documented native CAPTCHA method catalog audited against each provider's official API reference, with per-provider coverage and documentation links in Settings.
- Added a Discord management guard so Discord sends verify the active recipient the way other messaging sites already do.
- Added the `cookies` permission to the Chrome and Firefox manifests, used to match a native CAPTCHA challenge against the session that created it.

### Changed

- Narrowed CMS adapter injection to supported editor routes. Site adapters now supply short conditional notes instead of loading a skill, and a generic admin or Studio path needs observed CMS evidence before a recipe is offered.
- Tightened the CMS prompt budgets and verified that each run resets its skill state, so a CMS recipe cannot leak into a later task.
- Sanity publishing now uses the HTTP publish identity and keeps document revision guards, so a stale draft is not silently overwritten.
- Corrected the Compact WordPress API guidance and added REST route loop detection, so a repeating request is reported instead of retried.
- Refreshed the CAPTCHA tool documentation to match what each tier actually has: `get_captcha_capabilities`, `solve_captcha`, and `apply_captcha_solution` are Act/Dev Mid and Full tools, while Ask and Compact request manual completion.
- Documented the CAPTCHA data flow in the privacy guide, including all seven providers, what a fallback sends, and that the browser cookie jar is not exported automatically.
- Corrected the trace-format compatibility wording and updated the skills documentation, including the French and Simplified Chinese translations.

### Fixed

- Paid CAPTCHA answers now survive chat clears, document restores, and worker restarts. Dispatch locks persist before the provider call, dispatch history is retained, and an answer stays available until the first mutation.
- Stale CAPTCHA documents and gates are retired consistently across every recovery path, and an expired answer no longer traps completion: the gate flips to manual-required instead of hanging the run.
- A recoverable CAPTCHA application failure stays pending for a retry rather than ending the run, and falsy answers are no longer dropped.
- Hardened native CAPTCHA fallback matching. A fallback now requires complete identifiers, binds to the observed frame, media, and proxy identity, checks instruction aliases, challenge visibility, child-frame freshness, reCAPTCHA session cookies, and the browser User-Agent, and rejects undocumented nested parameters. DataDome, FunCaptcha, GeeTest, Yidun, Alibaba, Lemin, TSPD snapshots, reCAPTCHA v3 scores, and text challenges are recognized before a paid solve, and hCaptcha Enterprise is inferred from an explicit `rqdata`.
- Fixed a full pass of Discord observation and delivery evidence: direct messages, permalinks, message links, new DM binds, polls, field-only embeds, transcript-bound threads, guild avatars, localized settings and rail, and structurally classified avatars and dialogs are all recognized. Sends are verified against the authored text rather than a display name, the guild transcript route is validated, unknown identities are preserved instead of overwritten, and delayed observations reconcile safely.
- Restored Discord navigation and durable delivery evidence.

### Tests

- Added CAPTCHA coverage for the hCaptcha providers, native providers, application UI, runtime policy, and weighted fallback, and registered the new files in `npm test`.
- Added a Discord guard suite covering the observation and delivery paths, registered in the main test run.
- Added CMS API-first coverage with browser smoke fixtures and nine CMS LLM scenarios.
- Kept every mirrored Chrome and Firefox change paired on both sides.

## [37.0.1] - 2026-09-29

### Changed
- Link workflow editor from workflow docs
- Remove WebBrain Cloud footer link
- Hide WebBrain Cloud homepage panel
- Keep catalog icon guidance SVG-only
- Use official ODS product logo
- Guide WordPress editor recovery and preserve post type
- Add ODS local provider support
- Update discord-setup.md
- Delete docs/memcode-memory-proposal.md
- Update memcode-memory-proposal.md
- test: align packaging checks with current rendering
- Fix cloud clarification timeout state and deadline updates
- fix: match imported workflow save state
- fix: validate normalized workflow locators
- fix: measure canonical workflow import size
- fix: consume rejected saves and reserve import headroom
- fix: block downloads after rejected blur edits
- Add weighted CAPTCHA fallback across five providers
- fix: stop shortcut save after invalid edits
- fix: require at least one workflow step
- fix: flag workflows that cannot be imported
- test: isolate social submission gate fixture
- fix: enforce workflow editor importer constraints
- docs: add 37.0.0 changelog entry
- fix: make workflow editor import-safe
- build(deps): bump ip-address
- 37
- feat: link workflow editor from slash help
- feat: add 2Captcha fallback provider
- feat: add offline workflow editor
- fix: reject invisible Unicode clarification options
- fix: allow visible format characters in clarify options
- fix: center horizontal scroll targets clear of side rails
- fix: distinguish pinned and unstuck sticky controls
- fix: preserve scroll for visible fixed-surface controls
- fix: reject braille blank safe-first options
- fix: mark ancestor pseudo-element covers as occluded
- fix: fail closed for malformed safe-first options
- fix: reject ancestor hits for trusted click fallback
- fix: reject invisible safe-first options
- fix: clear targets covered by unclassified fixed overlays
- fix: bind safe-first to the declared first option
- fix: clear floating fixed bars above covered targets
- fix: detect ARIA toolbars and ignore modal-open page state
- fix: clear stacked docked bars during interactions
- fix: reject blank safe-first options
- fix: bound visible layer metadata in page reads
- fix: hoist nested modal surfaces only once
- fix: preserve timeout guard across safe-first clarifications
- fix: preserve docked controls and correct obstruction scroll
- fix: keep timed-out sensitive choices unconfirmed
- fix: expose layered surfaces alongside page text
- fix: accept affirmative clarify timeout with safe_first flag
- fix: handle clipped scrollers and shadow host occlusion
- fix: handle overlapping content elements and docked headers (#3085)
- fix: preserve text in mixed image clipboard payloads
- fix: avoid duplicate clipboard images from files+items union
- feat: paste images into chat from clipboard
- Route managed Cloud captcha solving through broker
- Report encrypted vault counts for storage stats
- Delete README.es.md
- Revise README.es.md for improved organization
- Add Osaurus provider support
- docs: propose opt-in MemCode memory architecture
- Benchmark Spark X2.5 and MiniCPM5 Compact routing
- Add GPT-6 Sol and Astra compatibility
- Mark GPT-6 Luna Pro vision-capable
- Wait for WebMCP preference before scheduled runs
- Add GPT-6 Luna Pro compatibility
- Clarify French WebMCP opt-out disclosure
- fix: fail closed WebMCP hydration
- feat: enable WebMCP by default
- Preserve list continuation after empty bullet markers
- Stop Markdown list scans at HTML blocks
- Preserve nested Markdown fences in final assistant renders
- Keep trailing blank outside quoted Markdown fences
- Reprocess fences after Markdown container boundaries
- Scan quoted Markdown list continuations
- Handle empty ordered markers and thematic lines
- Respect lazy ordered Markdown continuations
- Bound lazy Markdown list scans
- Scan lazy Markdown list continuations
- Scope cached Markdown list continuations
- Cache Markdown list continuations
- Avoid duplicate Markdown list padding
- Retain nested Markdown list indentation
- Track innermost Markdown list padding
- Detect nested empty Markdown list items
- Track Markdown list continuation columns
- Preserve tabbed Markdown list padding
- Handle whitespace-only Markdown list items
- Limit Markdown ordered list markers
- Preserve Markdown quote continuation prefixes
- Respect mixed Markdown quote boundaries
- End Markdown quotes at blank boundaries
- Honor implicit Markdown list padding
- Preserve streamed alternate Markdown fences
- Respect nested Markdown container indentation
- Handle empty Markdown list fence containers
- Honor visual Markdown list padding
- Preserve indented Markdown list snippets
- Parse nested Markdown list containers
- Limit Markdown fence recovery to streams
- Align Markdown fences in quoted tabs
- Handle nested tabbed list fences
- Validate nested Markdown fence closures
- Index nested Markdown fence closers
- Scan complete alternate Markdown fences
- Bound alternate Markdown fence nesting
- Validate nested Markdown fence indentation
- Cache list-free Markdown fence regions
- Preserve list fences in Markdown wrappers
- Strip Markdown fence indentation from code
- Preserve Markdown fence boundary newlines
- Support wide list quote fences
- Preserve longer nested Markdown fences
- Find indented Markdown fence continuations
- Scan Markdown fence blank lines once
- Handle Markdown fence container whitespace
- Avoid copying Markdown fence prefixes
- Track Markdown fence container indentation
- Preserve quoted fence boundaries
- Cache Markdown fence container boundaries
- Avoid backtracking in fence container parsing
- Parse nested Markdown fence containers
- Reprocess fences after container boundaries
- Preserve fenced blocks across final renders
- Use streaming state for nested Markdown fences
- End unfinished fences at container boundaries
- Retain list context for indented fences
- Support continuation list code fences
- Bound nested fence lookahead
- Distinguish streamed and completed nested fences
- Keep unmatched nested fences from consuming prose
- Separate history fence info strings
- Handle tab-indented list code fences
- Reject over-indented list fence closers
- Handle variable fence container indentation
- Harden Markdown fence container handling
- Preserve Markdown fence containers
- Potential fix for pull request finding 'CodeQL / Bad HTML filtering regexp'
- Fix nested Markdown code fence rendering
- Update LICENSE to reflect current licensing terms
- docs: sync zh-CN and fr README license ending with README.md
- Update licensing details in README.fr.md
- Update license statement in README.md
- fix: address recipient guard review findings
- feat(sidepanel): chime when a clarification/permission card appears
- feat(adapters): generic-first recipient guard on any site
- fix(agent): fail-open recipient guard, user-granted send authorization, silent-reply recovery, screenshot budget
- fix(content): prove non-sends in recipient probe, reliable text-click locator, content-script self-heal, candidate cache
- [ImgBot] Optimize images
- Respect hidden assigned slots in click candidates
- Fix _hasVisibleBox shadow host aria-hidden traversal
- Support X group DM recipient binding
- Stabilize X message history baselines
- Harden message metadata and X history proofs
- Recognize localized LinkedIn post controls
- Accept settled empty X conversations
- Scope message and public-post guards
- Require settled X message history
- Recover route-local X DM body commands
- Bind approved X DM bodies in workflow metadata
- Resolve named X message recipients to observed handles
- Fix social click guards and verify X message delivery
- Refine SafeSocial explainer copy
- Add SafeSocial 36.8.0 blog and visual
- test: publish compact model benchmark artifacts
- Add WebBrain Cloud section strip

## [37.0.0] - 2026-09-29

### Added

- Added clipboard image paste to the chat composer in Chrome and Firefox, reusing the attachment pipeline so size limits, preview chips, and per-tab binding behave exactly like drag-and-drop.
- Added 2Captcha as an independent fallback captcha provider with its own key, balance check, and localized Settings controls; a solve falls through to the next eligible provider before any token is injected.
- Added Osaurus as a default-on local provider card with its own icon, model listing, and documentation.
- Added GPT-6 Luna Pro, Sol, and Astra compatibility across context windows, temperature handling, streaming, and vision detection.
- Added a structured `safe_first` contract to the clarify tool, so a waited timeout applies the declared first option instead of halting the run with a misleading authorization message.
- Added a side-panel chime when a clarification or permission card appears, honoring the existing notification sound setting.
- Enabled experimental WebMCP by default with an opt-out in Settings, and refreshed the privacy, security, and translated documentation to match.
- Added Spark-X2.5 and MiniCPM5 compact-routing benchmark runs, the 15-model comparison write-up, and the published result artifacts with a replay harness.
- Added an opt-in MemCode memory architecture proposal to the docs.
- Added a WebBrain Cloud section to the landing page across every localized site.
- Armed recipient verification on any site rather than only Gmail, LinkedIn, and Douyin, with mail-like and chat-like surfaces selecting which verification shape applies.
- Added X group DM recipient binding alongside the existing X direct-message workflow, which binds approved bodies to workflow metadata and verifies delivery.

### Changed

- Routed WebBrain Cloud managed captcha solving through the broker and reported configured provider, memory record, and profile counts with each encrypted vault upload, so the authenticated admin stats page no longer needs to open a vault.
- Made scheduled runs wait for the WebMCP preference before they start, and left WebMCP closed when its preference cannot be hydrated.
- Trimmed the LICENSE to current terms, aligned the READMEs with it, and removed the Spanish README.
- Made the recipient guard fail open: only a confident send classification reaches verification, and a bound recipient clarification authorizes the address observed on the page instead of looping.
- Made screenshot capture repetition-aware within a burst of actions, so an eight-click turn costs roughly two screenshots and two vision calls instead of eight.
- Refreshed provider and flag artwork and slimmed the largest icon assets.

### Fixed

- Stopped overlapping content elements and docked headers from blocking interaction. Fixed and sticky insets are detected, targets scroll clear of side rails, the perimeter is sampled when the center point is occluded, `pointer-events: none` wrappers no longer swallow clicks, the accessibility tree reports occlusion and hoists modern component overlays, and the loop detector names the obstruction instead of retrying blindly.
- Hardened `safe_first` clarifications. Blank, Braille-blank, invisible, and format-only options are rejected, `safe_first` stays bound to the declared first option, a malformed option list fails closed, and a safe-first timeout no longer clears an earlier blocked clarification. Recipient binding and research escalation stay human-only after a timeout.
- Corrected layered surface reads. Visible layers are now exposed alongside page text with bounded metadata, nested modal surfaces are hoisted once, ancestor pseudo-element covers and ancestor hits count as occluded, shadow hosts respect `aria-hidden`, and hidden assigned slots no longer become click candidates.
- Preserved scroll position for visible fixed and pinned sticky controls, and told pinned elements apart from unstuck ones.
- Verified X direct-message delivery against a settled history baseline and the same canonical handle, including group conversations, and recognized localized LinkedIn post controls without loosening the private-message guards.
- Proved non-sends in the recipient probe, read typed and chipified addresses on any site, and made text clicks resolve reliably. A cached candidate list removes a full DOM walk per click, and the content script self-heals after an extension reload.
- Forced one re-injection and a precise stale-script error for silent content-action replies instead of closing the channel.
- Preserved nested code fences, list containers, quotes, and tabbed blocks through streaming and final Markdown renders, including fences inside lists, alternate fence lengths, empty markers, and quoted continuations.
- Stopped duplicate images when a clipboard populates both the files and items collections, and kept the text when a paste carries text and an image together.

### Tests

- Added captcha provider, captcha Settings UI, Cloud broker, and profile-sync stats coverage.
- Added mirrored Chrome and Firefox regressions for occlusion, docked insets, scroll clearance, layered surface reads, and `safe_first` clarification timeouts, keeping the two implementations byte-identical where they are paired.
- Added local DOM fixtures for the X direct-message workflow and for LinkedIn public-post controls.
- Added nested Markdown fence, list, and quote rendering tests, plus a replay harness for the compact model benchmark artifacts.

## [36.8.0] - 2026-09-20

### Added

- Added the SafeSocial Instagram classifier and settings export support for Chrome and Firefox.
- Added opt-in Jev classifiers and guarded experimental browser decisions.
- Added the TypeSafe System One scheduler judge to Assistive Models.

### Changed

- Moved Jev into Assistive Models and refreshed the related Settings guidance.
- Improved Jev verification and fast browser flows, including automatic-screenshot handoffs and event-driven observation wakeups in Chrome and Firefox.
- Kept multimodal requests out of Jev fast decisions and verification hints internal.
- Allowed the LinkedIn post composer to open through its safety checks.
- Kept the proofreading shortcut label concise and hardened selected-text proofreading boundaries.

### Fixed

- Stopped Jev safely on malformed classifier responses and invalid fallbacks.
- Improved Jev navigation completion, transient skips, superseded verification reconciliation, and benchmark code construction.
- Fixed Mail.tm mailbox reuse guidance.
- Kept Settings tab labels on a single line.

### Tests

- Added SafeSocial extension and UI coverage.
- Added Jev fixtures, workflows, benchmarks, scheduler tests, and mirrored Chrome/Firefox browser regressions.
- Added selected-text proofreading, social-publication contract, accessibility-tree, browser-event, and lifecycle coverage.

## [36.7.0] - 2026-09-17

### Added

- Added drag-and-drop attachment support, including Markdown files, to the side panel.
- Added localized, human-readable tool-action labels with distinct labels for screenshots, frame listings, downloads, research, WebMCP discovery, Gmail actions, and shadow DOM queries.

### Changed

- Improved activity labels and refreshed them after transcript restoration, locale changes, and progress updates.
- Kept URLs, credentials, tokens, OAuth codes, signatures, and typed secrets out of stored and displayed activity labels.

### Fixed

- Expanded URL redaction to cover nested URLs, userinfo, credentials, sensitive path tokens, encoded parameter names, protocol-relative URLs, and URLs without query markers.
- Failed closed when nested URL redaction exceeded its supported depth.
- Correctly marked interrupted and aborted terminal steps as failed.
- Restored friendly action labels when a step fails.
- Trimmed URLs before redacting embedded userinfo.

### Tests

- Added and updated activity-label, URL-redaction, lifecycle, attachment drop, and accessibility-tree benchmark coverage.
- Updated lifecycle harnesses and research URL expectations for the generic, privacy-preserving labels.

## [36.6.2] - 2026-09-16

### Changed
- 36.6.1
- feat(providers): add NEAR AI Cloud
- Create Spanish README for WebBrain project
- Delete README.es-ES.md
- Update license section in README.md

## [36.6.0] - 2026-09-15

### Changed

- Strict secret handling is now disabled by default.
- Softened homepage testimonial portraits in dark mode.

### Fixed

- Scoped social API publication guards to prevent unauthorized or out-of-scope publication writes.

## [36.5.0] - 2026-09-15

### Added

- Added support for editing custom skills.
- Added native browser dialog handling for Chrome and Firefox.
- Added homepage social-proof testimonials.

### Changed

- Enabled strict secret mode by default and updated localized descriptions.
- Built-in skill edits now create forks, while edited skills are reparsed and default skill removals are recorded.

### Fixed

- Fail closed when strict secrets cannot be hydrated.
- Dismiss unapproved browser dialogs and authorize navigation-related **Leave** decisions only for dispatched history navigation.
- Improved debugger attachment cancellation, teardown, retry behavior, and stale-session handling.
- Preserved newer browser sessions when late attachment cancellations complete.

### Tests

- Added browser-dialog and agent-lifecycle coverage, including navigation authorization and debugger attachment cancellation scenarios.

## [36.4.0] - 2026-09-15

### Added

- Added phonr.xyz integration as a skill.

## [36.3.2] - 2026-09-15

### Changed
- bugfix
- 36.3.0
- fix(research): retain model text before local search rewrites
- fix(providers): honor native consent and preserve raw completions
- fix(firefox): expose Compass share transport
- fix(providers): omit complete text values containing attachment URLs
- fix(providers): fully redact SVG and purge shares on revocation
- fix(providers): strip non-base64 attachment data URLs
- fix(providers): redact wrapped base64 in shared generations
- fix(providers): scrub short serialized base64 research payloads
- fix(providers): address codex round 10 - per-send consent, canonical URIs, done rawSummary
- fix(providers): address codex round 9 - share raw provider completion, not appended notices
- fix(providers): address codex round 8 - instance-keyed share consent
- fix(providers): address codex round 7 - schedule_resume status, revoke-purge before flush
- fix(providers): address codex round 6 - scrub binary in tool_calls args and metadata
- fix(providers): address codex round 5 - bare-base64 scrub, response scrub, wrapper-aware caps
- fix(providers): address codex round 4 - tail-preserving truncation, length-agnostic scrub, localized consent
- fix(providers): address codex round 3 - exact share request, data-uri scrub, trailing-only strip
- fix(providers): address codex review - honest copy, model-facing share request, provider-completion gate
- fix(providers): harden research share capture
- feat(providers): add voluntary share queries for research toggle and outbox

## [36.3.0] - 2026-09-15

### Added

- Added a voluntary, per-provider "share queries for research" toggle, gated by an opt-in confirmation, with a durable outbox that ships complete generations (request, response, attribution) to the WebBrain Compass improvement endpoint and retries delivery on subsequent runs. The toggle is never offered for the WebBrain Compass provider itself.

## [36.2.0] - 2026-09-14

### Added

- Added a dedicated DeepSeek provider with preserved router capabilities.
- Enabled API mutations, observer, memory, and PDF viewer defaults in Chrome and Firefox.
- Added structured Ask-to-Act handoff signaling and improved native-thinking detection.
- Added localized enabled-API defaults across supported languages.

### Changed

- Require HTTPS for non-loopback API endpoints to protect bearer credentials; loopback endpoints remain available over HTTP.
- Improved WebGPU provider fallback, transfer prioritization, runtime cleanup, and Settings synchronization.
- Updated retry and Act handoff buttons to use the subscribe secondary style.
- Refined batch invalidation to track the first pass transition.

### Fixed

- Validate memory-learning and PDF viewer preferences.
- Reject malformed API preferences during startup and live updates.
- Preserve observer and API mutation opt-outs when storage operations fail.
- Clear v1 fixture completion state after later edits or failures.
- Fail v2 episodes when trailing batch actions error after a terminal state.
- Hardened batch execution, launch fences, Fara schema handling, pilot authorization, and budget persistence.
- Preserve controllable retained WebGPU transfers in Apocalypse Mode and release runtimes during automatic fallback.
- Preserve WebGPU tool-result identity and await cache removal before provider fallback.
- Corrected WebGPU fallback behavior after model edits, removal, device loss, or stale persisted selections.
- Explicitly authorize held-out calculation submissions and refreshed the v2 handoff manifest.

### Tests

- Expanded lifecycle, fixture, batch-action, handoff, authorization, preference-validation, and WebGPU fallback coverage.
- Added and refreshed compact-model benchmark artifacts and re-frozen v2 manifest verification.

## [36.1.0] - 2026-09-14

### Added

- Added site adapters for bol, Otto, Willhaben, Tokopedia, Jumia, Kilimall, Careem, Talabat, Mercari, Yahoo! JAPAN, Naver, Yandex Market, OLX, and Despegar.
- Added coverage for Wildberries, Avito, VK, Noon, Swiggy, IRCTC, Paytm, and Snapdeal.
- Added Spanish (Spain) documentation in `README.es-ES.md`.
- Added OpenCode Go session support.

### Changed

- Expanded adapter routing across Europe, Southeast Asia, Africa, MENA, East Asia, CIS, India, and Latin America in Chrome and Firefox.
- Updated permission documentation, including notification and HTTP permission mappings.
- Updated minor-release automation with the current model version, revised temperature settings, and Playwright Chromium installation.

### Fixed

- Fixed OpenCode Go requests not sending the `x-opencode-session` header.
- Improved LinkedIn contact-dialog detection and navigation safety, including shadow DOM and active-modal handling.
- Fixed mobile storefront and login-host coverage for Tokopedia and VK.
- Corrected Paytm and Tatkal adapter safety handling.
- Documented Tatkal Aadhaar authentication requirements.

### Tests

- Expanded adapter, LinkedIn navigation, social publication, and minor-release workflow coverage.
- Added and updated compact-model benchmark artifacts and release workflow test coverage.

## [36.0.4] - 2026-09-10

### Changed
- fix: bind Bluesky detail cards when the route names the author by DID
- 36.0.3
- fixes
- 36.0.2
- fix: verify Bluesky publication details safely

## [36.0.1] - 2026-09-09

### Changed
- Install Playwright Chromium in workflow
- fix: harden run recovery and cancellation for v36.0.0
- 35.0.2
- fix: recover Bluesky composer verification and editing
- bugfix with chat watch
- test: add live social publication benchmark
- fix: recover social publication clicks after clarification
- chore: release v35.0.0
- test(docs): fix extended catalog fixtures and built-in table after adding pollinations
- fix(pollinations): use resolvable vision-capable suggestions, drop zeroed cost rates
- Fix social submission preflight and activation key matching
- Update README to acknowledge contributors
- Handle social link previews and repeated publication payloads
- Scope social publication guards and defer intent compilation
- fix(social-publish): verify reply parents from observed threads
- fix: allow verified LinkedIn navigation through recipient guard
- fix(social-publish): canonicalize reply resource identity
- fix(social-publish): bind inline replies to the active thread
- Add Pollinations AI provider
- refactor(social-publish): use selected-provider intent contracts
- fix(social-publish): verify permalinks opened after XHR publish
- fix(social-publish): preserve join controls in exact bodies
- fix(social-publish): multilingual past verbs, narrative then-continuation
- fix(social-publish): exact NFC bodies through link verification
- fix(social-publish): past-tense verbs never bind destinations
- fix(social-publish): checkpoint verified post on rebind, rawValue exact body
- fix(social-publish): govern scope exit by verb command, not prefixes
- fix(social-publish): modal command prefix, and-if fallback
- fix(social-publish): polite command prefix exits body scope
- fix(social-publish): with-conjunctions, but-if fallback
- fix(social-publish): NFC exact body, alongside, sentence fallback, modal narrative, hyphen verbs
- chore(deps): bump hono
- fix(content): preserve native Tieba controls
- fix(social-publish): proper-name scope, polite requests, plus ellipsis
- fix(social-publish): scope alternatives to commands, unless-then fallback
- fix(social-publish): excerpt restore, imperative metadata, does-not-work fallback
- fix: expose Tieba reply publish control
- feat: expand Baidu Tieba interaction adapter
- fix(social-publish): colon scope, metadata shape, standalone fallbacks
- fix(social-publish): colon scope, metadata shape, standalone fallbacks
- fix(social-publish): metadata body stops and pronoun fallbacks
- fix(agent): match Tieba account handoffs
- fix(social-publish): paired bounds, colon discovery, leading fallbacks
- fix(social-publish): absolute format maxima and oxford-comma bodies
- fix(social-publish): per-destination bodies and punctuated alternatives
- fix(social-publish): keep numeric-alt images out of emoji filter
- fix(social-publish): untargeted alt text scoped to images
- 审查：加固百度贴吧点赞控件识别
- fix(social-publish): governed body breaks, and-ellipsis counts, fallback punctuation
- fix(social-publish): publish-verb body scope and in-addition-to grammar
- fix(social-publish): contrastive scope split and failing-that fallback
- 适配：补充百度贴吧点赞控件识别
- fix(social-publish): punctuated bodies, along-with grammar and destinations
- fix(social-publish): multiline bodies, together-with grammar, plus destinations
- fix(social-publish): verb-bearing exclusions and per-clause format negation
- fix(social-publish): sole-target mismatch, max-qualifier negation, repeated format counts
- fix(social-publish): exclude negated format nouns from media intent
- fix(social-publish): carry destination-first bodies and fallback alternatives
- fix(social-publish): accept except-for exclusions and scope format maxima
- fix(social-publish): retain positive and forbidden media
- fix(social-publish): cover alternative and postfix qualifiers
- fix(social-publish): scope live and enumerated choices
- fix(social-publish): preserve scoped media conjuncts
- fix(social-publish): allocate unrestricted media slots
- fix(social-publish): retain per-format media bounds
- fix(social-publish): preserve scoped publication clauses
- fix(social-publish): preserve conjunctive format counts
- fix(social-publish): preserve ranged media choices
- fix(social-publish): harden media constraint verification
- fix(social-publish): enforce exclusions and GIF typing
- fix(adapters): consolidate Bluesky workflow
- fix(social-publish): preserve exclusions and URL choices
- fix(social-publish): enforce typed media branches
- fix(social-publish): support alternative bridges and bare ranges
- fix(social-publish): retain sequence and one-of choices
- fix(social-publish): reject neither destinations
- fix(social-publish): preserve ranged target intent
- fix(social-publish): preserve complete media branches
- fix(social-publish): scope media count alternatives
- fix(social-publish): evaluate typed media alternatives
- fix(social-publish): bind nested media intent
- fix(social-publish): scope negation and range alternatives
- fix(social-publish): tighten media alternative evidence
- fix(social-publish): preserve polarity and bounded media
- fix(social-publish): scope destination and file alternatives
- fix(social-publish): retain named attachment alternatives
- fix(social-publish): preserve destination and alt alternatives
- fix(social-publish): scope bodies and count alternatives
- fix(social-publish): enforce attachment set metadata
- fix(social-publish): make alt parsing linear
- fix(social-publish): verify optional media and alt text
- fix(social-publish): tighten destination and media evidence
- test: publish compact model benchmark artifacts
- fix(social-publish): placeholder x, stale upload provenance, upper-bound attachments
- web: remove Qwen3.5-9B from compact comparison
- fix(agent): decode branch entities once
- web: remove Chrome/Firefox rows from Browser AI Plugins comparison
- fix(agent): bind social evidence per destination
- test(llm): publish compact routing benchmark comparison
- fix(agent): require complete social publication evidence
- fix(agent): shared commit-field identity, kind-consistent refresh
- fix(agent): multi-line commit messages via summary plus body
- fix(agent): retain AX scope across conversation clears
- fix(agent): select-aware no-ops, cookie-authenticated branch attribution
- fix(agent): BOM-preserving blob hash, commit branch attribution
- fix(agent): cross-locator distinctness, exact-scope file verification
- fix(agent): verify GIF subtype and read singular articles as exact counts
- fix(agent): read reply commands as publication intent
- refactor(agent): hoist attachment-parsing regexes to module scope
- fix(agent): proven no-ops for empty appends
- fix(agent): split target lists around finished quoted attachment names
- fix(agent): keep filename conjunctions whole and honor minimum attachment counts
- test: cover PDF handler tab routing in the Chrome e2e
- fix: recognize our own PDF handler tabs without a HEAD probe
- test(vision): add WebBrain VL-2 and VL-3 benchmark outputs
- fix(agent): accept list modifiers in platform coordination, support media disjunctions, and treat media-only phrases as generic
- fix: bound the data URL metadata walk in tab-chat persistence
- fix(agent): verify distinct attachment targets, exempt content links, and coordinate multi-platform publish
- fix(agent): reject source platforms after leading non-social destinations
- fix(agent): honor negated media types in mixed constraints and reject platforms as report topics
- 测试：覆盖 PDF handler 的 HEAD 探测路由
- 修复：补齐 PDF handler 的 read_page 自动路由
- fix(agent): reject source-only platforms, preserve leading destinations across clauses, and honor negative attachments
- fix(agent): include multilingual conjunctions in coordinated publication target scans
- fix: harden large tab-chat image persistence
- fix(agent): support coordinated payload clauses and skip clock colons in body extraction
- fix(agent): pair quotation delimiters and support nested quotation styles in _maskQuotedPayload
- fix(agent): recognize Portuguese 'no' destination preposition
- fix(agent): restrict per-type attachment counts to generic phrases and fix delimiter character class
- fix(agent): scan full clause before explicit social URLs and fix multi-embed exclusion predicate
- fix(agent): match social destination across full masked clause and skip incidental command colons
- fix(agent): prefer authored body anchors and prioritize colon-introduced task bodies
- fix(agent): enforce exact media counts and types for explicit attachment requirements
- fix(agent): recognize 'without' as publication negation when governing publish verbs
- fix(agent): match specific attachment names without substring collisions and require each media type for mixed requests
- fix(agent): bind published URLs to occurrence order and support multilingual task body extraction
- fix(agent): keep authored post permalinks and recognize Korean generic attachments
- fix(agent): capture selector identity for uncertain writes
- fix(agent): parse conjunction attachments, preserve nested quote bodies, and guard noun shares and negated composer routes
- fix(agent): preserve incomplete publication metadata, ignore embedded numbers in attachment names, and scope URL publication clauses
- fix(chat): unwedge the support-chat workflow after a failed or proven-undelivered send
- fix(agent): scope coordinating negation, support article media counts, and refine body parsing
- fix(agent): support rich attachment counts, GIF video compatibility, and un-truncated plan payloads
- fix(agent): carry negation across coordinated publish verbs and resolve CodeQL alert
- fix(agent): preserve mutation debt across conversation clears
- fix(agent): reject negated publication commands and parse quantified generic attachments
- fix(agent): enforce full authored post equality, unambiguous links, and read-intent noun guards
- fix(agent): tighten social attachment evidence, premium body comparison, and retweet routing
- fix(agent): bfcache debt retention, shared refresh identity
- fix(agent): revalidate refreshed element identity
- fix(agent): exact focused readback recovery with field identity
- fix(chat): land review fixes on top of the Copilot workflow review
- fix(agent): verbatim message digest, terminal path rawValue
- fix(agent): byte-exact Git paths from ingestion
- fix(agent): pass resolved navigation links in commit gate
- fix(chat): address Copilot workflow review
- test(webmcp): isolate tool execution error page-error expectation to Chrome < 152
- fix(agent): align generic submit nudge with merged recovery assertions
- fix(agent): verify post media attachments and support unspaced CJK destinations
- fix(agent): live scope on minted proofs, canonical URL on token agreement
- fix(chrome): retry PDF.js import, derive viewer path, guard double response
- Withdraw the same-origin completion fallback entirely
- fix(agent): shared editor identity, locale-independent structure
- fix(guard): validate recipient semantics on displayed question regardless of declared purpose
- fix(guard): require messaging authorization for recipient consent and preserve role negation
- fix(guard): preserve negation across comma-delimited parentheticals
- fix(guard): reject conflicting role authorizations for the same recipient
- fix(guard): bound English delimiters with word boundaries before parsing recipient roles
- fix(gmail): match replacements to compatible observed slots and count only top-level thread containers
- fix(recipient-guard): reject negated delivery-role phrases in user clarification answers
- fix(recipient-guard): apply grouped role labels across coordinate recipient lists
- fix(recipient-guard): scope role labels to intended recipients and preserve roles on identity replacement
- Require a submit-correlated destination, and drop the Bluesky workflow job
- fix(recipient-guard): authorize recipient role changes strictly from user answer
- fix(gmail-guard): preserve Gmail display aliases for recipient clarification matching
- fix(gmail-guard): return independently observed Gmail candidates on expected recipient mismatch
- fix(recipient-guard): preserve authorized recipient roles when rebinding message recipients
- fix(planner): preserve complete_thread for singular email wording when summary or full exchange is required
- fix(agent): avoid truncating multi-recipient clarification answers
- fix(agent): support CJK word segmentation and expose recipient clarify purposes
- fix(agent): enforce distinct recipient clarification matching and scope
- Address review: restrict recipient clarify to messaging plans and verify single-message threads
- Accept single-page-app publish evidence and stop leaving a file chooser open
- Address PR #343 review findings on message recipient guard
- Fix Gmail draft-reply deadlock between the send and read guards
- chore: add mobile/ to .gitignore
- fix(chat): disclose bounded workflow deltas
- fix(chat): close workflow design review gaps
- humanized
- Add Compact benchmark result artifacts and correct baseline delta
- Add Compass Tiny benchmark and blog post
- fix(agent): editor-specific commit identity, selector distinctness escape
- Address Codex review: IPv6 URL bracketing, Range support, localize HF label
- fix(agent): element-derived refresh locator for focused proofs
- fix(agent): forward contentEditable in bound focused typing
- hf footer link added
- fix(agent): live scope before mutation debt, first-token bootstrap
- fix(chrome): harden PDF host readiness, sender gate, and handler URLs
- docs(chrome): explain PDF base64 overhead
- fix(agent): collision-resistant commit message check, evidence-first slash scope
- fix(chat): correct message ordering, thread binding, and send guards
- fix(agent): revalidate focused proofs via stable selectors pre-submit
- fix(agent): exclude authored links from alias proof and localize bare destinations
- fix(agent): focused commit proofs, continued task tokens, focused live scope
- fix(agent): require publish words to command, not name content
- fix(chrome): harden offscreen PDF extraction
- fix(chrome): parse PDFs in offscreen document
- test(webmcp): accept protocol-only tool errors
- fix(chat): restore state with resident conversations
- feat(chat): make resume scheduling durable
- feat(chat): persist support workflow state
- feat(chat): expose guarded observe and send tools
- feat(chat): add active conversation observation
- feat(chat): add durable support chat state kernel
- fix(agent): make publication intent work in the scripts tasks are written in
- fix(agent): gate feed destinations on publication language in any tongue
- fix(agent): pass clicks on resolved editable fields
- fix(agent): scope social body evidence to authored text and widen URL trimming
- fix(agent): evidence-gated scope, live document debt check
- fix(agent): tie social destinations to intent and keep balanced URLs intact
- fix(agent): mint task token before tracing, require nonempty match
- fix: honor native PDF handler opt-in
- fix(agent): repair the injected completion probe and social publish evidence
- fix(agent): verified writes exempt from mutation debt
- fix(agent): task-bound proofs without tracing, verify changed files
- fix(agent): verify form-less social publish and destination-only rebinds
- fix: correct PDF page rotation, text-layer scaling, and page tracking
- fix(agent): scope proofs to run, recover firefox selector debt
- fix(agent): handle social publish edge cases
- fix: complete PDF viewer review remediation
- fix(agent): gate compound submits, localize commit-dialog detection
- fix(agent): resolve commit scope by content, record readback exactness
- fix(agent): bind social proof to publisher
- fix(agent): preserve mutation debt across route changes, bind recovery to same field
- fix(agent): verify social publication completion
- fix: address PDF viewer review nits
- fix(agent): fail closed on inconclusive GitHub commit detection
- fix(agent): harden text mutation verification
- fix: harden PDF selection gesture, tab scope, and large-PDF rendering
- fix: harden PDF OCR trust and Firefox fetching
- fix: harden PDF fallback and OCR lifecycle
- feat: gate the PDF viewer behind an opt-in setting
- feat: add cross-browser PDF viewer fallback
- feat: add OCR fallback for scanned PDF pages
- fix(trace): preserve max_steps in traces after step-limit handoff
- feat: support embedded PDFs in the WebBrain viewer
- feat: add navigation controls to the PDF viewer
- feat: route top-level PDFs through a selectable WebBrain viewer
- fix: preserve selection restoration across early exits
- fix: infer prompt kind from payload shape when the discriminator is absent
- Keep Stop during the step-limit handoff a cancellation
- Address step-limit recovery review findings
- Finalize runs at the agent step limit
- Add explicit prompt kinds to browser bridges
- Initial plan
- fix(mcp): cover submit and workflow-healing gates, not just permission
- fix: strip the restoration marker and unbreak page-scope matching
- fix: clarify MCP permission decisions
- fix: restore page context after selection scope

## [36.0.0] - 2026-09-09

### Fixed
- Required a durable recovery checkpoint before sending consequential browser actions. Storage failures stop the run before dispatch; uncertain action results retain their checkpoint instead of being treated as safely replayable.
- Made cancellation persist for the lifetime of a run and propagate through provider requests and page-action deadlines. Stop during setup, nested publication checks, or streaming no longer disappears before the owning run can observe it; scheduled cancellation, pause, and deletion also invalidate in-flight startup.
- Completed outstanding tool results before saving cancellation, preserving completed responses and distinguishing uncertain actions from calls that were never dispatched. Subsequent model requests now retain valid tool-call history in both normal and streaming runs.
- Preserved uncertain text-write evidence when Stop or a closed response channel interrupts page messaging, including saved workflows. Late replies cannot erase the readback requirement or repeat the write.
- Rearmed resumed scheduled-task alarms that fired while a cancelled previous attempt was still releasing the job, without reviving paused, cancelled, or deleted jobs.
- Stopped automatic replay of interrupted scheduled tasks that may already have changed external state. These jobs retain their action evidence and require reconciliation before another attempt; interrupted read-only work can still retry.
- Fixed rapid tab switching so stale background responses cannot replace the latest selected conversation or route its next message to the wrong tab.
- Preserved rich-text editor structure when inserting text in Firefox and Chrome content-script fallbacks. Editing now honors cancellation before changing the document, uses native insertion, and verifies settled content without flattening links, formatting, or mentions.
- Blocked unverified network redirects before following them, including page-source and API replay paths, so final-URL validation cannot occur after a disallowed destination has already been contacted.
- Added cancellation, idle deadlines, and reader cleanup to provider streams. Bounded fetched text by bytes and time before JSON/HTML processing.
- Preserved successful, cancelled, and failed terminal outcomes on the final allowed agent step instead of replacing them with a step-limit event and an incorrect Continue button.

### Tests
- Added Chrome/Firefox regressions for cancellation, durable action checkpoints, scheduled recovery, tab-switch races, streaming cleanup, network response limits, and final-step outcomes, plus native Chromium/Firefox rich-text editing checks.

## [35.0.0] - 2026-09-09

### Added
- Added a cross-browser WebBrain PDF viewer fallback. Top-level and embedded PDFs can be routed through a selectable WebBrain viewer with page-navigation controls; scanned pages get an OCR fallback, and the feature is gated behind an opt-in setting (native PDF-handler opt-in is honored). Chrome parses PDFs in an offscreen document, retries the PDF.js import, and recognizes the extension's own handler tabs without a HEAD probe; Firefox adds hardened OCR trust and fallback/lifecycle handling. PDF `read_page` requests are auto-routed to the viewer, with page rotation, text-layer scaling, and page tracking corrected.
- Added a durable, safe support-chat workflow. A state kernel persists support workflow state, exposes guarded observe and send tools for active conversations, makes resume scheduling durable, and discloses bounded workflow deltas; a failed or proven-undelivered send no longer wedges the workflow, and resident conversations restore state.
- Added the Pollinations AI provider, with resolvable, vision-capable model suggestions.
- Expanded the Baidu Tieba interaction adapter with reply publish controls and native first-floor and reply-level like, favorite, follow, share, and `more` actions.
- Added explicit prompt kinds to the browser bridges (MCP server and LM Studio plugin), inferred from payload shape when the discriminator is absent.
- Published a WebBrain Compass Tiny comparison benchmark and blog post with routing benchmark artifacts, plus WebBrain VL-2 and VL-3 vision benchmark outputs (web).

### Changed
- Updated the README to acknowledge contributors.
- Removed Qwen3.5-9B from the compact-model comparison and the Chrome/Firefox rows from the Browser AI Plugins comparison (web).
- Bumped the MCP server's `hono` dependency.

### Fixed
- Hardened social publication across the board: publication intent parsing (multilingual conjunctions and prepositions, per-clause and per-destination bodies, exact NFC bodies through link verification, proper-name and colon scope), media intent (typed, negative, and alternative attachments; per-format bounds; exclusions; GIF typing), destination handling (source-only platform rejection, coordinated multi-platform publish, reply-resource canonicalization and thread binding), and terminal evidence (verified posts, permalink verification after XHR publish, single-page-app publish evidence, shared commit-field identity, byte-exact Git paths, multi-line commit messages). Scope exit is governed by verb commands rather than prefixes.
- Fixed message recipient-guard roles: authorized recipient role changes come strictly from user clarification, negation and conflicting role authorizations are rejected, grouped role labels apply across coordinate recipient lists, Gmail display aliases are preserved for clarification matching, and verified LinkedIn navigation is allowed through the recipient guard.
- Fixed a Gmail draft-reply deadlock between the send and read guards, limited result counting to top-level thread containers, matched replacements to compatible observed slots, and fell back to independently observed candidates on expected-recipient mismatch.
- Finalized the run at the agent step limit with a context-only terminal handoff exposing `done(outcome: "partial" | "failed")`; Stop during the handoff is a cancellation; traces preserve `max_steps` as the end status and carry the delivered outcome separately; the same-origin completion fallback was withdrawn entirely.
- Fixed MCP permission decisions to cover submit and workflow-healing gates rather than permission alone.
- Preserved selection scope and page-context restoration across early exits and stripped the restoration marker from page-scope matching.
- Hardened tab-chat persistence for large images (bounded data-URL metadata walk).
- Hardened PDF handler host readiness, sender gate, handler URLs, double-response guard, large-PDF rendering and selection gesture scope, OCR trust, and fallback viewer lifecycle.

### Tests
- Added `test:pdf-read`, `test:pdf-selection`, and `test:social-contract` (plus a DOM variant) suites; covered PDF handler tab routing in the Chrome e2e and isolated the tool-execution error-page expectation to Chrome < 152.
- Updated extended-catalog fixtures and the built-in model table after adding Pollinations, and published compact benchmark comparison artifacts plus VL-2/VL-3 vision outputs.
- Expanded selection-scope-restoration coverage across early exits and accept protocol-only tool errors in webmcp tests.

## [34.1.6] - 2026-09-04

### Changed
- Packaged the current extension fixes for browser stores.

## [34.1.4] - 2026-09-03

### Changed
- ui: use a globe for the language switcher and group the header prefs
- ui: make the sidepanel language switcher a plain header icon
- version up
- build(deps): bump the npm_and_yarn group across 1 directory with 2 updates

## [34.1.2] - 2026-09-02

### Changed
- Return only known fields from a failed OTP open
- Fail closed on ungated OTP opens and Gmail list routes
- fix: abort source-bound helper tabs when sidebar Stop is pressed
- Gate OTP message opens and complete reads
- Reject Gmail search listings as messages
- Harden OTP mailbox message matching
- Add skill-gated OTP mailbox reader
- fix: give Ask mode a read-only fallback for tab requests
- test/llm: report inapplicable scenarios as skipped, not errors
- test/llm: validate goldens per declared surface, not a union
- fix: reserve retired tab-tool names; score /screenshot for case 065
- docs(test/llm): stop hardcoding a tool count that rots
- test/llm: update benchmark goldens for removed tab tools
- Remove browser tab management tools
- dist: rebuild submission zips for v34.1.1
- chore: release v34.1.1
- docs: added

## [34.1.1] - 2026-09-02

### Changed
- docs: added
- dist: rebuild submission zips for v34.1.0
- chore: release v34.1.0
- 34.0.0
- fix: migrate stored Compass provider label
- fix: keep Compass name unlocalized
- feat: rename managed provider to WebBrain Compass
- feat(sidepanel): refine empty conversation state
- feat(sidepanel): consolidate conversation controls
- fix(opencode): scope Zen migrations and model normalization
- Improve selected-text localization and run details
- fix(ui): correct zoom compensation in sidepanel scale
- fix(opencode): Zen muse-spark-1.2-contributor-free Responses routing
- fix(ui): address review findings on sidepanel scale controls
- Verify the booking that was paid for, and the values a form was given
- Group custom ARIA radios, and stop counting readonly controls
- Settle window-based evidence after the window is recorded
- Carry a consumed form upload across Continue, and require a real activator
- Reread a form after an upload, and name the video on every YouTube route
- Bind every transcript window to its video, and resolve requested labels first
- Let the last diff window close coverage, and keep in-place wizard rows
- Close the diff from a root read only, and stop counting disabled controls
- fix(ui): render scale only after persist and compensate zoom width
- Close the diff only from an exhaustive reader, in its own coordinates
- Treat an unanswered field classifier as inconclusive, and read the whole diff
- Carry transcript and release-asset evidence across Continue
- Scope thread coverage and drafts, state native optionality, archive iframe steps
- fix(i18n): translate sidepanel scale labels
- fix(ui): harden sidepanel scale behavior
- Keep visually replaced native controls in the form inventory
- Bind deferred replies to their thread, tighten label matching, keep ids stable
- Chain transcript windows, prove empty comments, bound collections
- feat(ui): add configurable scale shortcuts
- feat(ui): add sidepanel scale controls
- feat(ui): persist sidepanel scale preference
- feat(ui): add sidepanel scale model
- Bind each job's evidence to its own resource and stop trusting bare rows
- Read the count tool's real fields, check transcript coverage, allow empty sets
- Invalidate the mutated iframe, and give every non-submit job a contract
- Fail prepare-only jobs that submit, and hold read jobs to their contract
- Keep hidden file inputs and match requested fields on content words
- Keep page-text lines and let iframe-only inventories verify their submit
- Keep finished wizard steps, thread replies, and hidden iframe fields honest
- Pin open-thread drafts, read localized resolve controls, drop hidden fields
- Bind form confirmations to their form and keep requested optional rows
- Rebuild paginated inventories on page one and keep body line structure
- Match requested send bodies and bind release assets to their release
- Hand draft addressees to the guard and rebuild branched form inventories
- Bind draft addressees and let an empty thread inventory finish
- Keep short-frame iframe rows and bind drafts to authorized field values
- Verify Gmail drafts and subjects, and page large iframe inventories
- Re-route the site workflow after substantive plan steps edits
- Preserve form inventory on submit, exact publish payload, and 16 Gmail recipients
- Refresh form inventories after value mutations in workflow tests.
- Stale form inventories after successful value-driven mutations.
- Resolve Gmail inline-reply recipients from the enclosing reply container.
- Bind simulated workflow evidence to the current task key in tests.
- Bind publish success to requested payload and allow empty thread inventories.
- Keep live workflow contracts after plan wording edits.
- Escape AX inventory values before quoting them.
- fix: restore Ask-streaming copy in 10 locales after mojibake
- Stop inferring optional fields and keep lone failed frames incomplete.
- Clamp card-wide max output tokens to the selected model's ceiling.
- test: guard zh Ask-streaming copy against mojibake regression
- fix: restore Chinese Ask streaming copy
- Localize max output tokens setting label
- Use cost-aware OpenAI context default
- Configure OpenAI and Anthropic model limits
- Make provider model limits configurable
- Tighten metadata readback and iframe completeness after review.
- Tighten Compact workflow contract under the brief-length budget.
- Shrink Compact workflow prompts and stop evidence false positives.
- Bound form-workflow inventory to a v1 evidence kernel.
- Keep runtime notices out of the execution task binding
- fix: require exhaustive workflow evidence
- fix: bind fulfillment to dispatched records
- fix: verify consumed uploads after observation
- Bind recipient clarifications to send tasks
- fix: retain post-action workflow evidence
- Preserve clarified tasks across restart
- Distinguish runtime blockers from task results
- fix: bind workflow evidence to live controls
- Preserve repeated clarification context
- Keep clarification answers bound to tasks
- fix: close iframe inventory gaps
- fix: bind workflow completion to exact outcomes
- Keep WebBrain Cloud observation checkpoints advisory
- Harden execution task authority
- fix: enforce complete workflow reconciliation
- fix: bind workflow targets to exact evidence
- fix: preserve workflow inventory coverage
- fix: bind exact messaging and publish targets
- fix: defer scoped workflow evidence
- fix: enforce reachable workflow evidence
- fix: handle asynchronous workflow evidence
- fix: bind terminal workflow evidence
- fix: stabilize workflow reconciliation
- fix: complete adapter form inventories
- dist: rebuild submission zips for v33.6.0
- chore: release v33.6.0
- Restore default compact activity history
- Encode Exacto as an OpenRouter model variant
- fix: address adapter workflow review findings
- Preserve OpenRouter model variants when routing
- Sync routing after loaded model selection
- Add OpenRouter routing variant controls
- p1 fixes
- feat: add DeepSeek provider support and update compatibility handling
- feat: add report-driven adapter workflows
- Allow honest exit after failed verification
- Preserve honest completion when verification is unavailable
- Harden scoped completion observations
- Coordinate completion recovery with runtime gates
- Keep forced completion active through validation
- Keep completion recovery scope across retries
- Fix background-tab completion verification
- Fix post-navigation completion recovery
- Add DeepSeek V4 Flash Vision benchmark post
- version 33.5.0
- Localize activity status messages
- Improve agent activity status display
- dist: rebuild submission zips for v33.4.1
- chore: release v33.4.1
- Fix selected-text chat actions
- Update social proof artwork
- Fix attention favicon flashing on dynamic sites
- dist: rebuild submission zips for v33.4.0
- chore: release v33.4.0
- Bind recurring planner notices to latest run
- Fix scheduled planner fallback notice race
- Fix planner fallback notice placement
- Keep MCP naming consistent across docs
- version up
- fix: keep shadow_dom_query selector guard on the real code
- fix: preserve selector no-click proof
- fix: make iframe marker cleanup nonblocking
- fix: defer iframe dispatch marking
- fix: keep focus-only iframe expiry retryable
- fix: release expired fallback gestures
- fix: stop late fallback page mutations
- fix: release fallback keys after deadline
- fix: guard fallback input dispatch deadlines
- fix: recheck deadlines after click validation
- fix: stop expired accessibility clicks
- fix: carry deadlines into page mutations
- fix: prevent actions after page deadlines
- Add Qwen3.8 and GLM-5.3 Flash benchmarks
- fix: reject late page mutations
- fix: guard queued selector focus
- fix: prevent late selector focus
- fix: link coordinate reconciliation deadlines
- fix: release timed-out CDP key presses
- fix: bound Firefox file upload injection
- fix: bound Chrome file upload actions
- fix: close preflight review gaps
- fix: bound pre-dispatch page probes
- Fix top-edge selection shortcut fallback
- fix: bound pending toolbar probes
- fix(ui): reflow selected-text scope banner
- fix: bound preflight and validation pipeline
- Refine selected-text chat shortcut
- fix: bound primary Chrome click pipeline
- fix: cancel late dispatch pipelines
- fix: stop late clear and classify click timeouts
- fix: bound early CDP action pipelines
- fix: bound action observation pipelines
- fix: bound click progress snapshots
- fix(agent): secure Gmail result counting
- fix: cancel expired trusted mouse press
- fix: cancel timed-out action recovery
- fix: bound trusted field recovery
- fix(agent): narrow search-field unsaved exemption
- fix: bound coordinate click reconciliation
- fix(agent): distinguish Gmail probe failures from page bounds
- ui: compact sidebar header actions
- fix: bound post-dispatch action completion
- fix(agent): harden Gmail result counting and coordinate clicks
- fix: cover accessibility clicks with action deadlines
- fix: recover stalled page actions
- dist: rebuild submission zips for v33.3.0
- chore: release v33.3.0
- feat(selection): add immediate broader context option
- docs: remove Product Hunt link from readme
- refactor(selection): simplify grounding controls
- fix(ui): refine scope and provider guidance
- Add EasyCLIProxy subscription guide
- fix(ui): add Unsloth provider icon
- version up
- version up
- fix(trace): preserve private workflow compilation
- docs(chat): scope trace privacy claims precisely
- fix(chat): reject busy scope restore races
- fix(chat): disable scope restore while busy
- fix(chat): describe selection scope recovery accurately
- fix(chat): disclose full selection scope restore
- fix(chat): describe selection scope recovery accurately
- fix(chat): disclose full selection scope restore
- fix(chat): disclose full selection scope restore
- docs(trace): clarify metadata-only retention
- fix(chat): bound safe selection dialogue context
- fix(unsloth): list only resident models
- fix(chat): bound safe selection dialogue context
- fix(chat): bound safe selection dialogue context
- fix(chat): bound safe selection dialogue context
- docs(chat): clarify selection trace privacy and verification
- docs(chat): wrap scope trace note
- docs(chat): verify selection context contract
- fix(chat): offer scope recovery for strict selections
- fix(chat): explain selection reference recovery
- feat(chat): expose selection context controls
- fix(chat): preserve safe dialogue across selections
- fix(trace): preserve redacted outcome metadata
- feat(providers): add Unsloth Studio integration
- Migrate stored catalog vision flags when the default model did not change.
- Enable vision on catalog defaults whose models already match the detector.
- Avoid rewriting unchanged provider snapshots on every load.
- Persist migrated provider snapshots when Settings is not saved.
- Migrate stored context windows with untouched default models.
- Migrate untouched stored provider defaults and enable StepFun vision.
- Update router and local open-source model lists to current API IDs.
- Update cloud provider model lists to current API IDs.
- fix: avoid 64 MiB sendResponse limit in /record slashcommand
- Add step-limit edge case test for completion recovery
- Fix step-limit edge case: emit partial when recovery exhausts budget
- Relax completion recovery: 2 retry turns and 12k output cap
- feat(trace): enforce metadata-only default privacy
- Add Muse Glimmer benchmarks and blog post
- fix(trace): preserve stats when repairing interrupted runs
- Bound structured completion recovery
- Rename Chromium bridge setting to MCP
- Version up
- fix: scope YouTube loop recommendation
- feat: add YouTube video loop suggestion
- docs: expand MCP client integrations
- test(trace): close OTLP contract coverage gaps
- test(trace): cover OTLP collector contract
- fix(trace): complete session export compatibility
- feat(trace): export conversation trace bundles
- fix(trace): harden OTLP compatibility normalization
- feat(trace): add session-aware OTLP export compatibility
- dist: rebuild submission zips for v33.2.1
- chore: release v33.2.1
- fix: keep ordinary clarification independent of research
- fix: diagnose empty model responses
- dist: rebuild submission zips for v33.2.0
- chore: release v33.2.0
- fix: read release context via jq --rawfile in AI changelog step
- dist: rebuild submission zips for v33.1.7
- chore: release v33.1.7
- fix(settings): treat seeded local API key sentinels as empty
- dist: rebuild submission zips for v33.1.6
- chore: release v33.1.6
- feat(trace): add session lineage navigation
- feat(providers): support optional local API keys
- mark tech post
- Version up
- feat(web): use real brand icons on homepage
- Version up
- fix: survive background throttling in completion attention flash
- fix(progress): require identity agreement for hydration batch merges
- fix: blink favicon itself on completion attention flash
- fix(progress): preserve canonical collected fields during hydration repair
- feat(trace): add session statistics aggregation
- Preserve capped trace request metadata
- Keep trace markers past lossless cap
- Retry unaccepted claimed prompts
- Retry prompts after cleanup failures
- Count escaped trace result bytes
- Clamp lossless traces by UTF-8 bytes
- Preserve newer lossless byte totals
- Persist lossless event totals atomically
- Skip migrated lossless rescans
- Serialize trace run finalization
- Rotate failed-clear recovery tokens
- Guard failed-clear scope recovery
- Migrate trace totals before cap checks
- Refresh migrated active trace totals
- Serialize aggregate lossless scans
- Serialize lossless byte migration
- Migrate lossless trace byte totals
- Requeue attachments after failed clears
- Suppress recovered follower cancellation errors
- Settle failed-clear recovery queues
- Restore cache before durable rollback
- Cancel only active run followers
- Wait for followers before plan recovery
- Drain prompts after reset clears
- Preserve lossless cache on clear failure
- Preserve prompts created during conversation clears
- Revalidate queued prompt drain targets
- fix(progress): strip action prefixes before colon delimiters
- Preserve screenshots when clears fail
- Honor clear cancellation after state replay
- fix: persist explicit success verdicts for scheduled Ask runs
- Recover active runs after failed clears
- fix: classify successful scheduled Ask runs for badge styling
- fix: pair badge fallback with a system notification
- Rollback conversation clears on scheduler failure
- fix: flash scheduled runs that require clarification
- fix(progress): harden auto identity checks in ledger reconciliation
- fix: reject billing terminals in Ask badge classification
- Make conversation clear storage atomic
- more test vision results
- fix: use exact done predicate for Act badges and cover all run paths
- test: track vision benchmark results and stop ignoring test/vision/results
- blog: compare six budget Qwen vision models on OpenRouter
- blog: compare six budget Qwen vision models on OpenRouter
- Make failed conversation clears recoverable
- fix: preserve run outcome in background flashes and export flash setting
- Clear durable prompts within conversation reset
- fix: own all attention flashes in the background lifecycle
- Reconcile repeated-item progress placeholders
- Keep reset queues stopped after partial clear
- fix: trigger scheduled flashes from the background
- Prevent stale run adoption after clear
- fix: clean cancelled screenshot recovery
- fix: clear focused-window badges without volatile tracking
- fix: scope queue drains and SSE heartbeats
- fix: address sixth review round on completion tab flash
- fix: preserve prompt and route identity
- fix: address fifth review round on completion tab flash
- fix: close conversation clear state races
- fix: address fourth review round on completion tab flash
- fix: resume queues after failed conversation clear
- fix: address third review round on completion tab flash
- fix: guard restored-run clear races
- fix: address second review round on completion tab flash
- fix: preserve typing identity through load completion
- fix(trace): close trajectory rows for unlisted terminal end statuses
- fix: harden issue 300 edge cases
- fix: address review notes on completion tab flash
- feat: flash finished tab when user switched away
- Fix Gmail complete-thread read loops
- feat(trace): add step trajectory table
- highlights
- google featured
- dist: rebuild submission zips for v33.1.1
- chore: release v33.1.1
- 33.1.0
- Add WebBrain VL 2 benchmark blog posts
- webbrain-vl-2-450m
- fix(trace): gate lossless eviction on a cached total and scan all runs
- fix(trace): redact recovery_code in JSON exports and refresh lossless tier pins
- fix(trace): close repair races and bound the stale-run scan
- fix(trace): protect runs with recent durable activity
- fix(trace): scan stale runs once when traces opens
- fix(trace): repair runs interrupted by service-worker eviction
- fix(trace): evict oldest lossless runs within budget
- fix(trace): redact lossless JSON exports and serialize recovery
- Count the Emergency Box among the Apocalypse Mode essentials
- Sign the Apocalypse Mode pages with the WebBrain mark
- Add the WebBrain logo to the Traces header
- added logo to settings and history.html
- Restore the Apocalypse Mode nuclear emoji at its source and fix two broken tests
- footer tightened
- cosmetic changes
- Fix Cloud runtime outbox delivery
- Add durable terminal runtime outbox
- docs: fix vision benchmark GitHub link
- test: add vision benchmark and model comparison
- fix(trace): address lossless tier review findings
- fix(trace): preserve lifecycle event integrity
- feat(trace): opt-in lossless recording tier sharing the event pipeline
- feat(trace): turn/step boundary events with structured failure codes
- fix(trace): preserve derived run lineage
- feat(trace): plumb parent lineage from cloud_run and replay entry points
- feat(trace): add session lineage fields and DB v2 lookup indexes
- feat(trace): add event model with run-level format version and tolerant read path
- refactor(ui): share schedule message reconciliation
- fix(ui): reconcile schedule confirmations
- fix(ui): deduplicate scheduled job messages
- dist: rebuild submission zips for v33.0.8
- chore: release v33.0.8
- fix: resume vision downloads and organize settings
- fix: require vision cache marker and isolate queued worker deadlines
- fix: verify local vision cache and abort timed-out remote vision
- fix: preflight mixed attachments and preserve queued vision stop
- dist: rebuild submission zips for v33.0.7
- chore: release v33.0.7
- feat: make research escalation explicit opt-in
- fix: reject staged screenshots without vision route
- fix: make screenshot vision explicit and bounded
- fix: close research escalation consent races
- fix: bound actionable discovery resets
- fix: preserve progress at observation limit
- fix: keep long ChatGPT research answers as valid JSON
- fix: ignore null research mappings and abort closed source tabs
- fix: keep research mapping out of ordinary side-panel tabs
- fix: stop research wait when the ChatGPT tab closes
- fix: cancel research wait when ChatGPT helper tab closes
- fix: treat ChatGPT stop-button test id as generating
- fix: keep research Stop on the source run
- dist: rebuild submission zips for v33.0.6
- chore: release v33.0.6
- fix: recheck ChatGPT origin before research submit
- dist: rebuild submission zips for v33.0.5
- chore: release v33.0.5
- fix: prevent duplicate extension manifests
- fix: expose research consent in ask mode
- feat: add consent-gated research escalation
- dist: rebuild submission zips for v33.0.4
- chore: release v33.0.4
- dist: rebuild submission zips for v33.0.3
- chore: release v33.0.3
- test: keep Wikipedia translation assertion with its call
- fix(offline): skip personal non-English tasks and prefer the selected source language
- fix(offline): keep prior-turn language for Wikipedia follow-ups
- dist: rebuild submission zips for v33.0.2
- chore: release v33.0.2
- fix(offline): detect Wikipedia language from the original direct query
- fix(offline): skip disabled Wikipedia translation and disambiguate shared scripts
- Keep Clarify open while typing
- fix(offline): detect Wikipedia translation language from the resolved query
- Handle streamed WebBrain quota limits
- fix(offline): disambiguate Han queries and reject non-string translations
- Address WebBrain Plus review feedback
- fix(offline): tighten multilingual Wikipedia retrieval routing
- web: add an Apocalypse Mode video popup under Install WebBrain
- Add WebBrain Plus upgrade prompt
- fix(offline): restore script-based query language hints
- dist: rebuild submission zips for v33.0.1
- chore: release v33.0.1
- test: allow GPL licensing checks after version bumps
- Improve multilingual offline Wikipedia retrieval
- web: make the Downloads FAQ a full-block link and publish the GPL 33 note
- fix(chrome): stop sibling status polls from migrating Bonsai
- fix(chrome): keep Emergency Box open when switching Minimal and Basic
- test: update WebGPU text model label expectations
- fix(settings): serialize model-load saves
- fix(settings): ignore stale model list responses
- fix(ui): name Minimal and Basic as text models in download boxes
- fix(apocalypse): deduplicate corpus download starts
- fix(offline-rag): keep emergency text pack status stable during extraction
- fix(chrome): preserve CDP lifecycle ownership
- fix(oauth): deduplicate subscription token refreshes
- fix(chrome): make debugger teardown race-safe
- test(chrome): cover debugger cleanup on run errors
- fix(chrome): release debugger sessions after runs

## [34.1.0] - 2026-09-01

### Added
- Refined the sidepanel empty conversation state and consolidated conversation controls.

### Changed
- Renamed the managed provider to **WebBrain Compass** (branding update).
- Updated Compass provider label migration to match the new Compass naming.
- Kept Compass name unlocalized to preserve consistent display across locales.

### Fixed
- Scoped Zen migrations and model normalization to avoid unintended side effects.
- Improved selected-text localization and run details.

### Tests
- Updated/added LLM/vision benchmark fixtures and snapshots used by the test suite (including OpenRouter-related scenarios).

## [33.6.0] - 2026-08-28

### Added
- Added OpenRouter routing variant controls, including support for encoding **Exacto** as an OpenRouter model variant
- Added WebBrain Compass Tiny v2.1 (`webbrain-one/webbrain-compass-tiny-v2.1`, ~1.87 GB) with a 32k context window as the sole exposed Chromium WebGPU text model
- Added runtime support for LFM2.5 text/VL and Nanbeige ONNX exports in the underlying WebGPU worker

### Changed
- Restored the **default compact activity history** behavior
- Restored the Chromium WebGPU text provider in Settings and the normal chat provider picker with direct download controls and standalone operation outside Apocalypse Mode
- Preserved OpenRouter model variants when routing, and synced routing after loaded model selection (Chrome + Firefox)
- Updated provider compatibility handling for DeepSeek support

### Fixed
- Fixed LFM2.5-VL downloads selecting FP32 artifacts, failing to mount the
  corresponding external ONNX data, and probing LiquidAI's nonexistent legacy
  processor filename; retries now discard obsolete wrong-precision cache
  entries before fetching the intended FP16-encoder/Q4-decoder files
- Improved completion recovery behavior around verification availability:
  - Allowed honest exit after failed verification
  - Preserved honest completion when verification is unavailable
  - Hardened scoped completion observations and recovery across retries
  - Fixed background-tab completion verification and post-navigation completion recovery

### Tests
- Added/updated OpenRouter routing and DeepSeek-related benchmark fixtures/snapshots (including DeepSeek V4 Flash Vision)

## [33.5.0] - 2026-08-27

### Added
- Added versioned site-workflow contracts for high-evidence GitHub, Product Hunt, Microsoft Forms, Gmail, LinkedIn, YouTube, 12306, Douyin, NaukriGulf, Greenhouse, and Workday tasks (Chrome + Firefox)
- Added semantic planner routing through app-owned `site_job` IDs and content-free adapter/job/revision trace metadata
- Added content-free `adapter_match` trace metadata for notes-only and structured adapters, plus live-UI-verified AdSense and SofaScore guidance without promoting either to a workflow contract

### Changed
- Redesigned the sidebar loading and thinking UI with clearer live activity updates and a toggleable compact activity history (Chrome + Firefox)
- Localized the new activity statuses and improved screen-reader announcements across all supported languages
- Tightened selected site-workflow completion: live-URL binding survives trusted continuation only on the same adapter/job, the executor receives the app-owned stages/evidence contract, submission success needs job-bound terminal evidence (including paid/ticket-issued transaction state and recipient-bound sent confirmation), and ledger-backed workflows need exact reconciliation against an app-owned inventory rather than model-created rows
- Bounded form-workflow inventory v1: exhaustive root reads must not be depth-truncated on includable descendants, skipped required rows cannot prove success (optional `required: false` rows may skip), and checkbox/Next actions stale completeness until a fresh root read

### Fixed
- Compact selected-workflow prompts now inject a brief execution contract and a shorter `progress_update.workflowReconciliation` schema; Mid/Full keep the full contract
- YouTube `update-metadata` verification matches AX-truncated values via prefix plus `value_len`/`value_fp` after the same NFKC normalization used by verification, and values that equal the accessible name
- AX inventory `value=` tokens escape backslash then quote, and inventory readback restores the app-owned string
- Unknown metadata field names no longer discard the rest of the requirement list, but discarded classifier fields keep saved-state verification incomplete; playlist plural aliases are recognized
- Form inventory emits `required=` only for explicit native/`aria-required` state, ignores decorative DOM depth, and omits erroring/empty third-party frames only when another frame already inventoried form controls; a lone failed cross-origin application frame stays incomplete
- Reviewed plan wording edits re-resolve the live site-workflow contract instead of dropping it, and ARIA `searchbox` controls enter the form inventory
- GitHub, LinkedIn, and Douyin publish success now requires the classifier-bound tag, title, notes, body, or visibility on the published resource, not only a re-observed URL
- A complete empty GitHub `resolve-review-threads` inventory can reconcile as a no-op when no unresolved threads exist
- Gmail inline thread replies resolve To/Cc/Bcc chips from the enclosing reply container when the composer is not inside a dialog or form
- Successful `type_ax`, `set_field`, and `iframe_type` mutations stale a complete form inventory so value-driven branching cannot reconcile against the prior snapshot
- Form workflow reconciliation completeness is preserved across final submit actions so post-submit confirmation navigation can complete successfully
- Publication workflow field verification checks exact resource lines and blocks instead of unanchored substrings
- The Gmail recipient probe returns up to 16 candidates to match the schema and guard capacity

## [33.4.1] - 2026-08-27

### Changed
- Fix selected-text chat actions
- Update social proof artwork
- Fix attention favicon flashing on dynamic sites

## [33.4.0] - 2026-08-27

### Added
- Added Qwen3.8 and GLM-5.3 Flash benchmarks (OpenRouter) to the benchmark suite

### Changed
- Kept MCP naming consistent across docs (Chrome + Firefox)

### Fixed
- Fixed scheduled planner fallback notice timing issues (race + placement), improving reliability of fallback guidance
- Bound recurring planner notices to the latest run to prevent stale notices from showing
- Hardened planner fallback and action pipelines against late mutations:
  - Prevented actions after page deadlines
  - Released fallback keys after deadline
  - Stopped late fallback page mutations and expired fallback gestures
  - Guarded fallback input dispatch deadlines and rechecked deadlines after click validation
- Improved iframe marker cleanup and dispatch timing to avoid blocking and late dispatch behavior
- Fixed focus/selector handling by preventing queued selector focus and late selector focus
- Bounded Firefox and Chrome file upload injection actions to avoid runaway retries
- Fixed CDP key press release after timeout
- Preserved selector “no-click proof” behavior and ensured selector guard logic stays on the real code
- Fixed top-edge selection shortcut fallback behavior
- Fixed planner fallback gestures and accessibility click expiry handling
- Kept MCP naming consistent across docs (Chrome + Firefox)

### Tests
- Added/updated benchmark fixtures and result snapshots for Qwen3.8 Flash and GLM-5.3 Flash (OpenRouter)

## [33.3.0] - 2026-08-26

### Added
- Immediate broader context option for selection (Chrome + Firefox)

### Changed
- Simplified selection grounding controls and refined scope/provider guidance
- Updated selection context controls to improve how selection scope is exposed and recovered
- Added EasyCLIProxy subscription guide
- Added Unsloth provider icon and improved Unsloth model listing (resident models only)

### Fixed
- Preserved private workflow compilation during trace handling
- Prevented selection scope restore races by rejecting busy restore and disabling scope restore while busy
- Improved selection scope recovery messaging and disclosure of full selection scope restore
- Bounded safe selection dialogue context to avoid over-expanding selection context
- Preserved redacted outcome metadata in traces
- Fixed trace privacy/retention messaging and clarified metadata-only retention
- Fixed busy scope restore race conditions in chat selection context continuity

### Tests
- Added/updated vision benchmark fixtures and expectations used by the test suite

## [33.2.1] - 2026-08-23

### Changed
- fix: keep ordinary clarification independent of research
- fix: diagnose empty model responses

## [33.2.0] - 2026-08-23

### Added
- Session lineage navigation in Traces (Chrome + Firefox)

### Changed
- Support optional local API keys for providers (Chrome + Firefox)
- Improve release-context handling in the AI changelog step (prevents missing/incorrect context during release generation)

### Fixed
- Treat seeded local API key sentinels as empty (Chrome + Firefox)

### Tests
- Added/updated vision benchmark fixtures and expectations used by the test suite

## [33.1.7] - 2026-08-23

### Changed
- fix(settings): treat seeded local API key sentinels as empty
- feat(trace): add session lineage navigation
- feat(providers): support optional local API keys

## [33.1.6] - 2026-08-23

### Changed
- mark tech post
- Version up
- feat(web): use real brand icons on homepage
- Version up
- fix: survive background throttling in completion attention flash
- fix(progress): require identity agreement for hydration batch merges
- fix: blink favicon itself on completion attention flash
- fix(progress): preserve canonical collected fields during hydration repair
- feat(trace): add session statistics aggregation
- Preserve capped trace request metadata
- Keep trace markers past lossless cap
- Retry unaccepted claimed prompts
- Retry prompts after cleanup failures
- Count escaped trace result bytes
- Clamp lossless traces by UTF-8 bytes
- Preserve newer lossless byte totals
- Persist lossless event totals atomically
- Skip migrated lossless rescans
- Serialize trace run finalization
- Rotate failed-clear recovery tokens
- Guard failed-clear scope recovery
- Migrate trace totals before cap checks
- Refresh migrated active trace totals
- Serialize aggregate lossless scans
- Serialize lossless byte migration
- Migrate lossless trace byte totals
- Requeue attachments after failed clears
- Suppress recovered follower cancellation errors
- Settle failed-clear recovery queues
- Restore cache before durable rollback
- Cancel only active run followers
- Wait for followers before plan recovery
- Drain prompts after reset clears
- Preserve lossless cache on clear failure
- Preserve prompts created during conversation clears
- Revalidate queued prompt drain targets
- fix(progress): strip action prefixes before colon delimiters
- Preserve screenshots when clears fail
- Honor clear cancellation after state replay
- fix: persist explicit success verdicts for scheduled Ask runs
- Recover active runs after failed clears
- fix: classify successful scheduled Ask runs for badge styling
- fix: pair badge fallback with a system notification
- Rollback conversation clears on scheduler failure
- fix: flash scheduled runs that require clarification
- fix(progress): harden auto identity checks in ledger reconciliation
- fix: reject billing terminals in Ask badge classification
- Make conversation clear storage atomic
- more test vision results
- fix: use exact done predicate for Act badges and cover all run paths
- test: track vision benchmark results and stop ignoring test/vision/results
- blog: compare six budget Qwen vision models on OpenRouter
- blog: compare six budget Qwen vision models on OpenRouter
- Make failed conversation clears recoverable
- fix: preserve run outcome in background flashes and export flash setting
- Clear durable prompts within conversation reset
- fix: own all attention flashes in the background lifecycle
- Reconcile repeated-item progress placeholders
- Keep reset queues stopped after partial clear
- fix: trigger scheduled flashes from the background
- Prevent stale run adoption after clear
- fix: clean cancelled screenshot recovery
- fix: clear focused-window badges without volatile tracking
- fix: scope queue drains and SSE heartbeats
- fix: address sixth review round on completion tab flash
- fix: preserve prompt and route identity
- fix: address fifth review round on completion tab flash
- fix: close conversation clear state races
- fix: address fourth review round on completion tab flash
- fix: resume queues after failed conversation clear
- fix: address third review round on completion tab flash
- fix: guard restored-run clear races
- fix: address second review round on completion tab flash
- fix: preserve typing identity through load completion
- fix(trace): close trajectory rows for unlisted terminal end statuses
- fix: harden issue 300 edge cases
- fix: address review notes on completion tab flash
- feat: flash finished tab when user switched away
- Fix Gmail complete-thread read loops
- feat(trace): add step trajectory table
- highlights
- google featured

## [33.1.1] - 2026-08-22

### Changed
- Reconcile planner expected-item placeholders with classifier and concrete progress rows, preserving one ordered canonical row per repeated-task target across Chrome, Firefox, and restored sessions.
- 33.1.0
- Add WebBrain VL 2 benchmark blog posts
- webbrain-vl-2-450m
- fix(trace): gate lossless eviction on a cached total and scan all runs
- fix(trace): redact recovery_code in JSON exports and refresh lossless tier pins
- fix(trace): close repair races and bound the stale-run scan
- fix(trace): protect runs with recent durable activity
- fix(trace): scan stale runs once when traces opens
- fix(trace): repair runs interrupted by service-worker eviction
- fix(trace): evict oldest lossless runs within budget
- fix(trace): redact lossless JSON exports and serialize recovery
- Count the Emergency Box among the Apocalypse Mode essentials
- Sign the Apocalypse Mode pages with the WebBrain mark
- Add the WebBrain logo to the Traces header
- added logo to settings and history.html
- Restore the Apocalypse Mode nuclear emoji at its source and fix two broken tests
- footer tightened
- cosmetic changes
- Fix Cloud runtime outbox delivery
- Add durable terminal runtime outbox
- docs: fix vision benchmark GitHub link
- test: add vision benchmark and model comparison
- fix(trace): address lossless tier review findings
- fix(trace): preserve lifecycle event integrity
- feat(trace): opt-in lossless recording tier sharing the event pipeline
- feat(trace): turn/step boundary events with structured failure codes
- fix(trace): preserve derived run lineage
- feat(trace): plumb parent lineage from cloud_run and replay entry points
- feat(trace): add session lineage fields and DB v2 lookup indexes
- feat(trace): add event model with run-level format version and tolerant read path
- refactor(ui): share schedule message reconciliation
- fix(ui): reconcile schedule confirmations
- fix(ui): deduplicate scheduled job messages

## [33.1.0] - 2026-08-22

### Changed
- Switched to WebBrain VL 2 450M as the local vision fallback.

## [33.0.8] - 2026-08-20

### Changed
- Changed the Chrome local vision fallback to the fine-tuned `webbrain-one/webbrain-vl-2-450M-onnx` release, with renewed opt-in consent and a versioned ready marker so older caches cannot be mistaken for the new model.
- Added a consent-gated, durable WebBrain Compass terminal-runtime outbox so executed terminal tool results survive provider-trace export gaps and can be joined through stable de-identified references.
- fix: resume vision downloads and organize settings
- fix: require vision cache marker and isolate queued worker deadlines
- fix: verify local vision cache and abort timed-out remote vision
- fix: preflight mixed attachments and preserve queued vision stop
- fix: reject staged screenshots without vision route
- fix: make screenshot vision explicit and bounded

## [33.0.7] - 2026-08-20

### Changed
- feat: make research escalation explicit opt-in
- fix: close research escalation consent races
- fix: bound actionable discovery resets
- fix: preserve progress at observation limit
- fix: keep long ChatGPT research answers as valid JSON
- fix: ignore null research mappings and abort closed source tabs
- fix: keep research mapping out of ordinary side-panel tabs
- fix: stop research wait when the ChatGPT tab closes
- fix: cancel research wait when ChatGPT helper tab closes
- fix: treat ChatGPT stop-button test id as generating
- fix: keep research Stop on the source run
- fix: recheck ChatGPT origin before research submit
- fix: expose research consent in ask mode
- feat: add consent-gated research escalation

## [33.0.6] - 2026-08-20

### Changed
- Packaged the current extension fixes for browser stores.

## [33.0.5] - 2026-08-20

### Changed
- fix: prevent duplicate extension manifests

## [33.0.4] - 2026-08-20

### Changed
- Packaged the current extension fixes for browser stores.

## [33.0.3] - 2026-08-20

### Changed
- test: keep Wikipedia translation assertion with its call
- fix(offline): skip personal non-English tasks and prefer the selected source language
- fix(offline): keep prior-turn language for Wikipedia follow-ups
- fix(offline): detect Wikipedia language from the original direct query
- fix(offline): skip disabled Wikipedia translation and disambiguate shared scripts
- fix(offline): detect Wikipedia translation language from the resolved query
- fix(offline): disambiguate Han queries and reject non-string translations
- fix(offline): tighten multilingual Wikipedia retrieval routing
- fix(offline): restore script-based query language hints
- Improve multilingual offline Wikipedia retrieval

## [33.0.2] - 2026-08-20

### Changed
- Keep Clarify open while typing
- Handle streamed WebBrain quota limits
- Address WebBrain Plus review feedback
- web: add an Apocalypse Mode video popup under Install WebBrain
- Add WebBrain Plus upgrade prompt

## [33.0.1] - 2026-08-20

### Changed
- test: allow GPL licensing checks after version bumps
- web: make the Downloads FAQ a full-block link and publish the GPL 33 note
- fix(chrome): stop sibling status polls from migrating Bonsai
- fix(chrome): keep Emergency Box open when switching Minimal and Basic
- test: update WebGPU text model label expectations
- fix(settings): serialize model-load saves
- fix(settings): ignore stale model list responses
- fix(ui): name Minimal and Basic as text models in download boxes
- fix(apocalypse): deduplicate corpus download starts
- dist: rebuild submission zips for v33.0.0
- fix(offline-rag): keep emergency text pack status stable during extraction
- release: prepare WebBrain 33.0.0
- fix(chrome): preserve CDP lifecycle ownership
- fix(oauth): deduplicate subscription token refreshes
- build(release): package Bonsai resume fix
- fix(chrome): validate resumed Bonsai downloads
- fix(onboarding): keep Skip gated when provider scan fails
- fix(chrome): make debugger teardown race-safe
- test(chrome): cover debugger cleanup on run errors
- fix(onboarding): localize install showcase headlines
- build(release): regenerate 32.2.3 packages
- fix(chrome): release debugger sessions after runs
- fix(offline-rag): address follow-up Xapian review
- fix(onboarding): restore cloud status after a privacy retry
- fix: use integer schema for bounded tree size
- fix(browser): skip capture-ended notify on recorder start failure
- fix(onboarding): keep privacy choice consistent and announced
- fix: coordinate offline download ownership
- fix(offline-rag): address Xapian review findings
- fix(onboarding): acknowledge privacy provider reload
- fix(onboarding): gate skip on provider scan
- fix(chrome): rearm queued download work
- fix(chrome): complete Bonsai review follow-ups
- fix(release): address GPL packaging review
- fix(chrome): address Bonsai download review feedback
- fix(onboarding): await privacy choice before skip
- fix(browser): clean up capture resource lifecycles
- feat(onboarding): showcase WebBrain features on install
- docs: resolve Chinese offline RAG conflict
- Run Apocalypse archive downloads offscreen
- fix(release): publish GPL corresponding source
- fix(ui): keep relative time wording explicit
- fix(ui): preserve message info scrollability
- fix(ui): freeze opened message timestamps
- fix(ui): show relative message timestamps
- bugfix
- Stop 40GB Wikipedia downloads stalling on OPFS createWritable.
- Fix Basic (Bonsai) cache.put failing on chrome-extension URLs.
- Speed up large Wikipedia archive downloads without breaking resume.
- Show LFM2.5 and Bonsai beside Minimal/Basic without extra i18n keys.
- Add Minimal/Basic model-name strings to every Apocalypse locale.
- Persist Bonsai weights before marking Basic ready.
- Rename Apocalypse text presets to Minimal and Basic.
- Expect Basic in the uncached WebGPU selection error.
- Show Basic/Pro text presets and keep download progress visible.
- Fix Bonsai 27B download hitting Transformers.js config.json.
- Keep Apocalypse kit CSS identical across Chrome and Firefox.
- Add Bonsai 27B as an opt-in Chrome WebGPU text model.
- feat(offline-rag): turn on the vendored Xapian full-text worker
- vendor xapian/libzim wasm runtime built from source
- fix(build): survive the wasm-opt crash on the final Wasm link
- fix(build): explain the WSL integration switch when docker is missing
- docs(build): lead with the WSL work tree for the clock-skew fix
- fix(build): detect Docker mount clock skew before it aborts the build
- fix(offline-rag): stop claiming a running download is already verified
- fix(offline-rag): register the build:zim-xapian npm script
- docs(offline-rag): correct the archive tier description and warn on manual imports
- feat(offline-rag): register the Xapian provider behind the bundled flag
- feat(offline-rag): reproducible source build and worker driver for the Xapian runtime
- feat(offline-rag): record the GPL approval and detect ZIM full-text indexes

## [33.0.0] - 2026-08-20

### Changed
- License WebBrain 33.0.0 and later under GPL-3.0-or-later because the distributed extension bundles and integrates the GPL-licensed Xapian/libzim WebAssembly runtime; releases before 33.0.0 remain MIT-licensed.
- Remove baked-in copy from onboarding-only screenshots so localized HTML captions do not overlap the artwork; Chrome Web Store screenshots remain separate and unchanged.
- Increase the size and contrast of the `Alt+Shift+W` onboarding shortcut hint.

## [32.2.3] - 2026-08-19

### Changed
- feat(offline-rag): keep adult CPR off baby queries and measure it
- fix(offline-rag): keep the field guide when encyclopedia passages outrank it
- fix(offline-rag): stop discarding the Wikipedia article that answers the question
- feat(offline-rag): recover misspelled, inflected, and suffixed queries
- Add hover tooltip on Edge card for Mac/Linux users

## [32.2.2] - 2026-08-18

### Changed
- dist: rebuild submission zips for v32.2.1
- chore(vendor): drop the unreachable ONNX jsep runtime
- feat(offline-rag): answer with a labelled caveat when offline evidence misses
- style update
- fix(offline-rag): manage the answer engine on Apocalypse Mode
- fix(offline-rag): restore answer-engine readiness on Emergency Box
- added emergency box pdf source linking
- docs: add remote downloads and data sources documentation with flowchart diagram
- fix(offline-rag): search health topics, not leftover stopwords
- fix(ui): render markdown tables in skill previews and chat history
- Revert "fix(ui): render markdown tables in skill previews and chat history"
- fix(ui): render markdown tables in skill previews and chat history
- feat(offline-rag): emergency download system with semantic runtime
- fix(offline-rag): fix progress percentage calculation in apocalypse-mode emergency text pack card
- fix(offline-rag): fix data-i18n keys for emergency corpus and semantic model descriptions in apocalypse-mode.html
- fix(offline-rag): publish Emergency Pack & Semantic Model download state to shared download tracker in apocalypse-mode
- fix(offline-rag): keep offline answer engine readiness box hidden in standalone chat when apocalypse button is clicked
- fix(offline-rag): remove redundant Open Emergency Box link from readiness section on apocalypse-mode.html
- feat(offline-rag): show Emergency text pack and Multilingual semantic model cards in apocalypse-mode.html
- feat(offline-rag): auto-download emergency corpus and semantic model, protect files, and hide offline answer engine
- Replace apocalypse mode indicator dot with ☢️ nuclear waste emoji
- added apocalypse mode visual
- updated numbers
- style update
- updated changelog
- version up
- fix(ui): respect IME composition in composer
- fix(offline-rag): resolve PR 280 review findings and standalone chat routing
- fix(ui): keep markdown tables after headings and in history
- ask webbrain a question bubble opacity 0.8 + bugfix
- made ask webbrain a question work
- fix(ui): render markdown tables
- docs: add offline RAG documentation and FAQ entries
- fix(ui): harden selection quote follow-up action
- feat: offline RAG with emergency corpus, retrieval, and reranking
- Stop treating editor arrows and current-slide labels as carousel failures.
- fix(ui): keep Escape run semantics
- fix(ui): harden selection action lifecycle
- fix(ui): clear stale selection actions on send
- fix(ui): keep answer selection action usable
- fix(ui): preserve selection action lifecycle
- fix(ui): position answer selection action before repaint
- feat(ui): quote selected answers for follow-up questions
- instagram carousel findings fixed
- trigger merge re-check
- fix(apocalypse): ignore stale PDF search results
- fix(ui): ignore stale list refreshes
- fix apocalypse downloads and readiness showcase
- fix(apocalypse): validate resumed PDF ranges
- fix(anthropic): yield done when replay fails mid-stream instead of throwing
- test(apocalypse): reflect hidden Wikipedia callout
- fix(settings): list built-in provider default models
- fix(providers): keep routed o-series on legacy contract
- add basic/full kit downloads, built-in communication reader, size estimates, and i18n translations
- fix(anthropic): preserve thinking content across turns
- hide Offline Wikipedia box in apocalypse mode
- restore apocalypse-comm from backup
- fix(content): observe final submit cancellation state
- fix(content): observe final submit cancellation state
- add apocalypse comm pages and update docs
- fix(agent): verify same-URL history traversal
- fix(providers): scope routed contract detection by provider
- fix(providers): classify routed reasoning model contracts by provider
- feat(providers): add OrcaRouter
- apocalypse mode documented in english and chinese
- style up apocalypse mode
- fix(content): use one set_field submit path
- fix(providers): keep routed GPT-5 Pro token contract
- test(agent): exercise scaled click loop path
- fix(providers): omit unset models for every local config
- fix(content): require observed submits for set_field
- fix(content): keep the Enter trio and submit natively only when the page did not handle Enter
- fix(providers): bound the reasoning-contract regex and share it with settings
- fix(i18n): localize the window permission verb and harden the prompt fallback
- fix(providers): require a model for local servers that need one, omit for LM Studio
- fix(azure): stop guessing the wire contract from the deployment name
- test(agent): pin image-space coord-click bucketing under screenshot downscaling
- Release 32.1.0 with blank provider duplicates
- Polish message info metadata
- Fix provider duplicate lifecycle
- Keep offline Wikipedia library reachable
- Restore complete Wikipedia library management
- Guard Wikipedia history navigation races
- Fix message info streaming and accessibility
- Refine homepage AI story and section flow
- fix(message-info): propagate streamed finish reasons and expose a semantic info toggle
- Keep small Wikipedia images compact
- Render offline equations and showcase Apocalypse Mode
- Harden Apocalypse offline answers
- fix(azure): use max_completion_tokens and omit temperature for reasoning deployments
- Build localized Apocalypse offline library
- feat(/print): extract executePrintSlashCommand helper and add behavioral tests
- fix(message-info): pass endedAt through synthesized run_complete on restore
- fix(duplicate-provider): address Copilot review comments
- Fail closed on alternate message composers
- Resolve recipient follow-ups and nested controls
- Stop unsafe messaging workflow replay
- Bind all recipient sends to final dispatch
- Bind recipient verification to message dispatch
- Allow verified conversation retargeting
- Distinguish chat composer from navigation controls
- Block uploads on protected messaging routes
- Require recipient-specific header evidence
- Harden direct-message recipient verification
- Fix FAQ search icon alignment
- Localize FAQ accessibility labels
- Validate FAQ language routes
- Move FAQ into multilingual docs
- Fix resumable large download cancellation
- Scope the compare base to chrome source and port-specific firefox code
- feat: expand Apocalypse Mode for offline use
- fix: avoid misleading message metadata
- feat: show message info on click
- Add duplicate provider configurations
- Preserve selection scope for /print
- Add /print slash command
- Rearm Apocalypse downloads after cancellation
- Rebuild optimized archive artifacts
- Optimize offline archive storage and lookup
- Rebuild offline download artifacts
- Harden resumable offline downloads
- Rebuild artifacts after upstream merge
- Rebuild ZIM matching artifacts
- Make ZIM matching locale independent
- Rebuild Apocalypse polling artifacts
- Keep Apocalypse polling and lookup responsive
- Rebuild ZIM title lookup artifacts
- Cover combined ZIM title capitalization
- Rebuild Apocalypse keepalive artifacts
- Keep Apocalypse workers and imports race-safe
- Handle LFM directional scroll aliases
- Parse LFM2.5 native tool calls
- Document Apocalypse archive tiers
- Limit WebGPU presets to LFM2.5
- Rebuild Apocalypse streaming artifacts
- Stream Apocalypse pieces within one wake
- Clarify Apocalypse update and import behavior
- Default WebGPU to compact prompts
- Fix WebGPU download conflict handling
- Rebuild Apocalypse retry artifacts
- Preserve Apocalypse retries and redirect aliases
- Add LFM2.5 WebGPU reasoning preset
- Rebuild Apocalypse failure artifacts
- Keep Apocalypse failure lifecycle progressing
- Rebuild Apocalypse control artifacts
- Harden Apocalypse title lookup and controls
- Rebuild Apocalypse scheduling artifacts
- Keep Apocalypse download scheduling race-safe
- Rebuild download retry review artifacts
- Harden Apocalypse download retries
- Add Ternary Bonsai WebGPU preset
- Rebuild schedule recovery artifacts
- Restore Apocalypse schedules safely
- Add Gemma WebGPU preset
- Rebuild catalog tier review artifacts
- Expose all Apocalypse catalog tiers
- Use flag-only language picker trigger
- Rebuild WebGPU progress review artifacts
- Filter WebGPU vision download progress
- Rebuild search race review artifacts
- Guard Apocalypse search error state
- Rebuild Apocalypse review artifacts
- Fix Apocalypse completion races
- Scope WebGPU transfer state by model
- Rebuild 32.0.0 store archives
- Fix Apocalypse archive lifecycle races
- Add selectable WebGPU models
- Keep Ling WebGPU session options mutable
- Reduce Ling WebGPU buffer pressure
- feat: complete Apocalypse Mode offline setup
- Fix Ling WebGPU inference failures
- Add managed Ling model downloads
- fix: align Firefox minimum version
- Keep WebGPU state out of profile sync
- version update
- fix: close Apocalypse Mode lifecycle races
- fix: harden Apocalypse Mode archive lifecycle
- feat: rework offline Wikipedia as Apocalypse Mode
- fix: keep Wikipedia cache provenance coherent
- fix: preserve rich Wikipedia cache records
- feat: add offline Wikipedia retrieval
- Add endpoint-free WebGPU local provider
- Remove DOM handling explanation from README
- Keep the explicit translation exception in the brief rendering
- Trim the response-language policy prompt cost
- Anchor fallback language on continuation
- blog: show shipped WebGPU vision in WebBrain 31
- Persist continuation language policy
- Preserve language across continuations
- Reject empty deliverable language policies
- Fail closed on incomplete language policy
- Preserve request language without planner
- Fix response language policy

## [32.2.1] - 2026-08-18

### Added
- Added comprehensive offline remote downloads and data sources documentation (`docs/remote-downloads.md`).

### Fixed
- Fixed Emergency text pack and multilingual semantic search model download state broadcasting to the shared download tracker in Apocalypse Mode.
- Fixed progress calculation and display sync on the Emergency text pack card.
- Fixed data-i18n translation keys for corpus and semantic model descriptions.

## [32.2.0] - 2026-08-18

### Added
- Added a "Ask WebBrain a Question" bubble with improved opacity and lifecycle handling.
- Added markdown table rendering for assistant responses, preserving tables after headings and across conversation history.
- Added Apocalypse Mode basic and full kit downloads with a built-in communication reader, size estimates, and i18n translations.

### Changed
- Improved Instagram carousel handling by no longer treating editor arrows and current-slide labels as carousel failures.

### Fixed
- Fixed markdown tables being removed after headings and in conversation history.
- Fixed offline RAG PR review findings and standalone chat routing.
- Fixed selection quote follow-up action lifecycle and hardening.
- Fixed stale selection actions being cleared on send.
- Fixed answer selection action positioning and lifecycle preservation.
- Fixed Escape key run semantics.
- Fixed Anthropic thinking content preservation across turns and graceful handling when replay fails mid-stream.
- Fixed built-in provider default model listing in settings.
- Fixed OpenAI o-series routed provider legacy contract handling.
- Fixed Apocalypse Mode PDF range validation and stale search result handling.
- Fixed stale list refresh handling.
- Fixed Apocalypse Mode downloads and readiness showcase.
- Fixed SPA same-url navigation history handling.

### Tests
- Added offline RAG documentation and FAQ entries.

## [32.1.1] - 2026-08-18

### Added
- Added offline RAG support with emergency corpus, SQLite FTS5 search, multilingual semantic reranking, and local text citation readers.
- Added selection quote follow-up action for Ask WebBrain.

### Fixed
- Fixed offline RAG lifecycle recovery, SQLite SAH pool database cleanup on cancellation, and multilingual emergency query routing.

### Tests
- Added test coverage for offline RAG emergency corpus recovery, lock bypass, and multilingual query detection.

## [32.1.0] - 2026-08-16

### Added
- Added a `/print` slash command that prints either the current page or the user's active selection without losing the selected scope.
- Added independently configurable duplicate provider cards in Settings, with one additional instance per eligible provider and preserved provider-specific behavior across Chrome and Firefox.
- Added click-to-reveal message metadata, including system-timezone sent times and verbose model completion details.

### Changed
- Refined the homepage story and Apocalypse Mode showcase, including offline equation rendering and more compact handling of small Wikipedia images.

### Fixed
- Duplicate provider cards now open completely blank instead of copying credentials, endpoints, models, costs, compatibility overrides, or other settings from the source provider; suggestion-backed model controls also remain visibly blank until configured.
- Kept duplicate-provider creation, removal, draft preservation, active-provider fallback, reload validation, and local model/vision behavior independent and reliable.
- Improved message metadata accuracy, streaming/restoration behavior, keyboard accessibility, compact one-line presentation, and local-timezone formatting without a separate info icon.
- Kept the offline Wikipedia library reachable from Apocalypse Mode and hardened archive history navigation and offline answer generation.

### Tests
- Added mirrored Chrome and Firefox regressions for blank provider duplication, duplicate lifecycle behavior, message metadata rendering and keyboard operation, `/print` selection handling, and Apocalypse Mode reliability.

## [32.0.0] - 2026-08-14

### Added
- Added opt-in Apocalypse Mode for downloading or importing Wikipedia Kiwix/ZIM archives and searching them locally when the built-in Wikipedia skill cannot reach its online source.
- Added an on-device archive manager, available from the ☢ Apocalypse Mode link beside Support in the Settings header, with expanded language choices, full-text archives with an optional images toggle, background download progress, storage estimates, update checks, removal controls, and reauthorization for external archive files.
- Added browser-native ZIM parsing and search, including Zstandard-compressed clusters, without uploading archive contents.
- On supported Chromium browsers, enabling Apocalypse Mode now enables and downloads the local LFM2.5-VL vision fallback automatically, with persistent progress shown on the management page.
- Localized the Apocalypse Mode interface across all supported Chrome and Firefox locales.

### Fixed
- Prevented direct-message sends on protected messaging routes unless the planner carries the user-authorized recipient and a read-only pre-dispatch probe verifies one unique, exact active-conversation header identity. Pronoun follow-ups resolve to a named recipient only from unique authentic prior-user context, otherwise they clarify; generic pronouns never silently mean the open thread. Active-conversation requests are pinned to that identity before any page tool runs; ordinary conversation text never counts as recipient evidence, structurally verified search/navigation fields stay distinct from composer submission, and alternate or ambiguous editable composers plus unresolved or distant controls and dispatch paths that cannot bind to the verified recipient—including attachment injection that may auto-send—fail closed. Structurally verified conversation rows in the separate left rail remain selectable so the agent can recover from an initially wrong thread, while nested row actions and their span/SVG descendants remain blocked; verified Enter sends are limited to one keypress. Send-capable field edits, clicks, accessibility clicks, and Enter presses carry a one-use action/composer/identity binding that is revalidated at the actual click or key dispatch point; protected accessibility clicks never issue a second no-progress fallback click. Saved workflows that could dispatch on a protected messaging route stop before replay and direct the user to a normal Act task, where fresh structured recipient authorization is available. The first enforced adapter is Douyin chat, with Chrome/Firefox parity.
- Isolated browser-managed archive storage per download so reinstalling the same archive cannot corrupt another record.
- Required explicit Apocalypse Mode opt-in before catalog or Metalink network access.
- Made stale-import recovery generation-safe and preserved partial data while a live importer may still be writing.
- Added explicit permission recovery for external ZIM files after browser restarts and prevented automatic retries while authorization is required.
- Removed unbounded alarm retries after unexpected archive-download failures.
- Routed local vision progress through the service worker, probed WebGPU before automatic selection, restored the prior vision provider after automatic preload failures, preserved later local-vision opt-outs, and refreshed the Settings controls after cross-tab changes.

### Tests
- Added planner, adapter-routing, active-conversation pinning, recipient-normalization, exact-match, mismatch, missing-authorization, inconclusive-probe, alternate-dispatch, and non-message regressions for the direct-message recipient guard in both browser builds.
- Added mirrored Chrome and Firefox regression coverage for ZIM validation and search, archive downloads and imports, opt-in network gates, recovery races, external-file permissions, and retry behavior.

## [31.0.1] - 2026-08-14

### Changed
- blog: announce WebGPU vision and correct EXL3 date
- i18n: localize local vision fallback
- dist: rebuild submission zips for v31.0.0
- fix: use visual local vision health probe
- docs: add 31.0.0 changelog
- version up
- dist: rebuild extension packages
- fix: make local vision probe reliable
- dist: rebuild extension packages
- fix: harden WebGPU vision lifecycle
- improvements
- Retry quantized WebGPU map failures with fp16 before aborting
- Skip WASM fallback for quantized WebGPU models
- Retry WebGPU unaligned-access failures with fp16 dtype
- Reset WebGPU mode when WASM kernel init fails
- Improve WebGPU fallback errors and switch default ONNX model to Gemma
- Add robust fallback for WebGPU buffer map failures
- Handle WebGPU OrtRun buffer download/CPU data failures with retry mode
- Fix WebGPU CPU tensor access error in worker pipeline
- 9.0.2
- 9.0.0
- WebGPU: keep outputs on GPU to avoid mapAsync OOM
- title change
- WebGPU: move inference to a dedicated Worker + upgrade to Qwen 3.5 0.8B
- WebGPU: disable wasm-cache for chrome-extension scheme
- WebGPU: address PR #66 codex review (tool-call streaming + cache key)
- WebGPU: enable cross-origin isolation for SharedArrayBuffer
- WebGPU: force .jsep wasm variant so WebGPU EP actually engages
- WebGPU: surface fallback-adapter / no-GPU case in Test Connection
- WebGPU: document fp16 fallback when q4f16 kernel overflows
- WebGPU: switch default dtype from q4 to q4f16
- WebGPU: vendor asyncify WASM variant for CPU fallback ops
- WebGPU: vendor onnxruntime-common, patch second bare specifier
- WebGPU: vendor UNMINIFIED builds (Web Store policy + readability)
- WebGPU: fix bare-specifier import (vendor ort.webgpu.bundle, patch specifier)
- version up
- Vendor @huggingface/transformers 4.2.0 (WebGPU + ONNX runtime)
- WebGPU: download progress indicator
- Update offscreen.html
- chore: bump version 7.3.1 → 7.4.0
- WebGPU + ONNX provider (Qwen 3 0.6B, in-browser, no server needed)

## [31.0.0] - 2026-08-14

### Added
- Added a one-click, Chrome-only in-browser vision fallback powered by WebGPU, using LiquidAI's LFM2.5-VL-450M ONNX model as a dedicated screenshot-description sidecar rather than a general planning provider.

## [30.0.7] - 2026-08-14

### Changed
- fix(memory): validate extraction confidence defaults
- fix(actions): preserve Messenger thread routes
- fix(session): recompute recent boundary after filtering
- 30.0.6
- docs: explain page context reduction
- Default extraction confidence to 1 when the model omits it
- Reject lookalike commerce hosts and short-link DM paths
- Drop tool results orphaned by assistant compaction in session snapshots
- Clarify the non-finite overflow comment per review feedback
- Fix clipped plan review steps
- Reject non-finite numbers in cloud output schema validation
- Added Product Hunt

### Fixed
- Keep ordinary and forced-recovery answers in the trusted user-request language while allowing explicit translation targets, user-edited plan targets, multilingual deliverables, and source-faithful quotations to use their requested languages.
- Shrink the response-language instruction on ordinary turns from about 150 tokens to about 40, stop repeating it in the `done` tool schema when the system prompt already carries it, and keep an explicitly empty planner deliverable list instead of discarding it as malformed. Translation, multilingual, approved-plan-override, and forced-delivery turns keep the full wording.

## [30.0.5] - 2026-08-13

### Changed
- bugfixes
- Handle nested opaque iframe origins
- Fix agent safety and reliability regressions
- removed unnecessary files

## [30.0.3] - 2026-08-13

### Changed
- feat: add local OpenAI-compatible proxy provider
- fix: recognize localized Gmail expansion controls
- Preserve hidden prompts for restored retries
- Fix thread actions and anchored pagination

## [30.0.2] - 2026-08-13

### Changed
- Packaged the current extension fixes for browser stores.

## [30.0.1] - 2026-08-12

### Changed
- fix: disambiguate nested Gmail label routes
- fix: reject Gmail list routes with hex names
- fix: bind tree pagination to content revisions
- fix: require fresh Gmail root metadata
- Update contributor count in webstore explainer
- fix: reject Gmail list routes for thread reads
- fix: polish standalone window UX
- feat: add standalone Ask window
- Fix Gmail thread read completeness
- Polish selection shortcut actions
- fix: isolate standalone chat context
- fix: require verified download completion
- 29.0.3
- updated numbers
- Fix #466: Expand sidepanel into standalone window
- Fix #2752: Derive planner download completion requirements without prose heuristics
- fix: preserve legacy click dispatch behavior
- refactor: reconcile screenshot clicks through semantic AX targets
- fix: constrain general knowledge to custom selections
- fix(planner): require structured download completion evidence
- feat: add general knowledge selection scope
- feat: resolve visual targets to semantic refs

## [30.0.0] - 2026-08-12

### Changed
- Expanded the side panel into a standalone window.

## [29.0.2] - 2026-08-12

### Changed
- dist: rebuild submission zips for v29.0.1
- fix: make store submission code reviewable

## [29.0.1] - 2026-08-11

### Changed
- dist: rebuild submission zips for v29.0.0
- fix: refine settings control order
- docs: add 29.0.0 changelog
- 29.0.0
- Clean up settings organization

## [29.0.0] - 2026-08-12

### Changed
- Reorganized Settings to surface frequently used controls and group advanced options more clearly.

## [28.2.3] - 2026-08-11

### Changed
- Add active provider filter

## [28.2.2] - 2026-08-11

### Changed
- fix streaming multipart offscreen uploads
- fix transcription runtime fallback transport
- fix chrome multipart offscreen fallback
- fix multimodal provider validation
- Fix anchored accessibility pagination
- Reset protected gallery state after URL reads
- Fix planner retry error handling
- Handle protected Chrome Web Store pages
- Fix planner provider compatibility and Act fallback

## [28.2.1] - 2026-08-11

### Changed
- version up
- fix: hide localized context menu instructions
- blog: publish EXL3 + SparkInfer on Blackwell lite post
- blog: add EXL3 + SparkInfer on Blackwell lite post (scheduled)
- Apply suggestions from code review
- feat: localize selection shortcuts
- fix: dedupe run progress replay gaps
- test(memory): cover newly formed memory cues
- style(memory): animate the Firefox memory cue
- feat(memory): render the Firefox memory cue
- feat(memory): notify the Firefox side panel
- feat(memory): mirror new-memory tracking in Firefox
- style(memory): animate the Chrome memory cue
- feat(memory): render the Chrome memory cue
- feat(memory): notify the Chrome side panel
- feat(memory): track newly formed memories

## [28.2.0] - 2026-08-11

### Changed
- Localized the selection shortcut and native context-menu items across all 23 supported interface languages in Chrome and Firefox, including action names, translation targets, status messages, right-to-left layout, and live language changes.
- Localized shortcut-generated prompts so responses follow the active interface language without exposing model-only language instructions in the visible conversation.

### Fixed
- Smoothed the effects of bounded run memory by showing a replay-gap notice only once per run, even as acknowledged event boundaries advance, while continuing to restore completed output after side-panel reconnects.

## [28.1.5] - 2026-08-11

### Changed
- fix: defer download intent normalization
- fix: recover planner localization and download intent
- test(onboarding): cover install guide transition
- fix(onboarding): advance Firefox install guide
- fix(onboarding): advance Chromium install guide

## [28.1.4] - 2026-08-11

### Changed
- version up
- fix: harden runtime mode recovery and trace diagnostics
- Apply suggestions from code review
- fix: localize Cloud Sync settings

## [28.1.2] - 2026-08-11

### Changed
- fix: preserve rich-text editor appends

## [28.1.1] - 2026-08-11

### Changed
- version up
- fix: enforce complete thread read coverage
- Fix restored compact tool details
- fix: honor complete thread read intent
- fix: require complete thread reads
- 28
- ci: make cloud smoke manual-only
- fix: toggle vision for custom local providers
- fix: detect vision for custom local providers
- fix: preserve local model capability identity
- feat: detect vision support for local providers
- Fix Ollama vision slash toggle
- Detect Ollama vision capabilities
- fix: address post-merge review findings
- feat: harden coupon domain refresh
- fix: call window.focus() before inputEl.focus() for focus-input command
- fix: use storage.onChanged for command dispatch instead of runtime.sendMessage
- docs: correct tab grouping visibility model
- fix(firefox): change focus-input shortcut from Ctrl+Slash to Ctrl+Period
- fix(firefox): add browser-level keyboard shortcuts via commands API
- test: preserve runner line endings
- test: cover automatic tab grouping opt-out
- feat(settings): add Firefox tab grouping preference
- feat(i18n): add zh Firefox tab grouping labels
- feat(i18n): add vi Firefox tab grouping labels
- feat(i18n): add uk Firefox tab grouping labels
- feat(i18n): add tr Firefox tab grouping labels
- feat(i18n): add tl Firefox tab grouping labels
- feat(i18n): add th Firefox tab grouping labels
- feat(i18n): add ru Firefox tab grouping labels
- feat(i18n): add pt Firefox tab grouping labels
- feat(i18n): add pl Firefox tab grouping labels
- feat(i18n): add nl Firefox tab grouping labels
- feat(i18n): add ms Firefox tab grouping labels
- feat(i18n): add ko Firefox tab grouping labels
- feat(i18n): add ja Firefox tab grouping labels
- feat(i18n): add id Firefox tab grouping labels
- feat(i18n): add hi Firefox tab grouping labels
- feat(i18n): add he Firefox tab grouping labels
- feat(i18n): add fr Firefox tab grouping labels
- feat(i18n): add fa Firefox tab grouping labels
- feat(i18n): add es Firefox tab grouping labels
- feat(i18n): add en Firefox tab grouping labels
- feat(i18n): add de Firefox tab grouping labels
- feat(i18n): add bn Firefox tab grouping labels
- feat(i18n): add ar Firefox tab grouping labels
- feat(settings): add Firefox tab grouping preference
- feat(settings): add Firefox tab grouping preference
- feat(settings): honor Firefox tab grouping preference
- feat(settings): honor Firefox tab grouping preference
- feat(settings): honor Firefox tab grouping preference
- feat(i18n): add zh tab grouping labels
- feat(i18n): add vi tab grouping labels
- feat(i18n): add uk tab grouping labels
- feat(i18n): add tr tab grouping labels
- feat(i18n): add tl tab grouping labels
- feat(i18n): add th tab grouping labels
- feat(i18n): add ru tab grouping labels
- feat(i18n): add pt tab grouping labels
- feat(i18n): add pl tab grouping labels
- feat(i18n): add nl tab grouping labels
- feat(i18n): add ms tab grouping labels
- feat(i18n): add ko tab grouping labels
- feat(i18n): add ja tab grouping labels
- feat(i18n): add id tab grouping labels
- feat(i18n): add hi tab grouping labels
- feat(i18n): add he tab grouping labels
- feat(i18n): add French tab grouping labels
- feat(i18n): add Persian tab grouping labels
- feat(i18n): localize Chrome tab grouping preference
- feat(settings): add Chrome tab grouping preference
- feat(settings): update Chrome agent tab grouping
- feat(settings): add tab grouping opt-out
- test: cover pinduoduo adapter
- agent: mirror pinduoduo adapter in firefox
- agent: add adapter for pinduoduo
- test: preserve run.js line endings
- ci: keep patch release changelog in sync
- test: cover patch release changelog ordering
- docs: backfill patch release changelog
- fix(captcha): serialize Cloudflare gate hydration
- fix(captcha): ignore unrelated response tokens
- fix(captcha): make English matcher additive
- fix(captcha): revalidate cleared token state
- fix(captcha): retire post-solve read inference
- fix(captcha): detect Cloudflare challenge pages
- ux improvements
- feat: generate coupon merchant coverage
- feat: add verified coupon code action
- documentation enhanced

## [28.1.0] - 2026-08-11

### Fixed
- Required complete communication-thread requests to read every page or expanded message before finishing, with multilingual intent handling and deterministic recovery across Chrome and Firefox.
- Restored compact tool-step **Details** controls after side-panel transcripts reload, including synchronized accessible expanded state in both browser builds.

### Tests
- Added mirrored coverage for complete-thread classification and pagination, premature-completion guards, bounded read windows, trace metadata, and restored compact detail toggles.

## [27.1.5] - 2026-08-08

### Changed
- Updated the LM Studio plugin for the current browser-delegation protocol.
- Added model-bound vision capability detection for llama.cpp, LM Studio, and LocalAI, with Auto / Force on / Off settings and fail-closed Chrome/Firefox request routing.

### Fixed
- Hid empty assistant placeholders until response content is ready to render.

## [27.1.4] - 2026-08-08

### Fixed
- Kept timed-out plan reviews visible and added an explicit retry path.

## [27.1.3] - 2026-08-08

### Fixed
- Corrected assistant response bubble width in the side panel.

## [27.1.2] - 2026-08-08

### Changed
- Expanded MCP setup and usage documentation.

### Fixed
- Reported API-mutation grants in the transcript and removed stale authorization presentation.

## [27.1.1] - 2026-08-08

### Changed
- Hardened CI integration and release security checks for the 27.1 series.

## [27.1.0] - 2026-08-08

### Added
- Added a value-free teacher mode (`/teach --start <name>` / `/teach --end`) that records a user's demonstrated clicks, field completions, checkbox/radio toggles, Enter submissions, and navigations into a tab-scoped session. The capture code never reads field values — only semantic identity — and every field action becomes a runtime parameter at the capture boundary. The session persists across navigation and compiles into the same `webbrain-workflow/1` format as successful runs. Automated runs are blocked while a teacher session is active for a tab.
- Added an interactive saved workflow manager (`/workflow`) to list, run, rename, export, and delete saved workflows in Chrome and Firefox.
- Added user-approved workflow locator healing: when a saved workflow target no longer matches uniquely, up to five independently replayable semantic candidates are presented for explicit single-selection. Approved replacements are applied atomically against the workflow's previous `updatedAt` value, so a concurrent edit wins instead of being overwritten; concurrent edits, unattended answers, and duplicate candidates can never authorize a healing.
- Added a WebBrain MCP server introduction blog post covering setup for Claude Code, OpenCode, Codex, and Cursor, the loopback security model, and how WebBrain MCP differs from headless browser tools.

### Changed
- Excluded WebBrain Compass from per-run cost limits and metered dedicated vision provider costs separately, so vision-heavy WebBrain Compass work does not count against the local/router cost allowance (Chrome and Firefox parity).
- Merged Cloud Bridge (MCP/LM Studio browser delegation) settings into Settings → General → Advanced → Cloud bridge, with synchronized setup guidance and the three bridge ports (MCP `17374`, LM Studio `17375`, WebBrain Cloud `17373`).
- Hardened screenshot and attachment handling: staged screenshots persist durably until delivery is confirmed at every call site, the per-turn screenshot budget charges only when a model actually receives the capture (vision description or attachment), redaction binds to capture time and scopes to rendered frames, and a child frame URL that cannot identify exactly one descriptor fails closed instead of risking mis-paired redaction regions.
- Did not stage a full-page screenshot when the capture-time privacy scan cannot prepare redaction geometry; the capture now reports `redactionUnavailable`, explains the blocker, and skips staging while still rendering the preview and save button (Chrome only).
- Removed the sticky API mutation badge from the Chrome and Firefox side panels. The `/allow-api` override now confirms once in the transcript instead of as a persistent composer badge.
- Passed trace run options through both Chrome and Firefox builds at startup.
- Allowed automatic i18n for AMO links and updated slash-command documentation across locales.

### Fixed
- Stopped sending automatic screenshots to text-only Ollama models by resolving the selected model's native `/api/show` vision capability before each run, with model- and case-sensitive-endpoint-bound caching, cancellable three-second metadata reads, legacy metadata fallbacks, live localized Auto / Force on / Off status, and Chrome/Firefox parity.
- Fixed a screenshot redaction fail-open path: the deferred full-page redaction now refuses the send when the snapshot had regions but `_redactScreenshotDataUrl` returned the bytes unchanged.
- Fixed `mergeRedactionFrameRegions` to return `null` under `requireCompleteFrameCoverage` when an object/embed subdocument or unpaired child frame has no DOM descriptor, instead of reporting the snapshot as complete.
- Fixed `loadStagedScreenshots` and `clearStagedScreenshots` to enumerate keys per-tab instead of reading all of `storage.local`, preventing 16 MB record churn on tab switch and reconnect.
- Fixed `consumePendingAttachmentsForTab` to key on `stagedAttachmentId` instead of object identity, preventing stale chips from wedging the composer after a rejection reconciled from storage.
- Fixed `reconcilePersistedStagedScreenshots` to only delete durable pixels on confirmed inclusion, preserving the user's only copy when delivery fails through a torn-down service worker.
- Fixed teacher submit capture and workflow cleanup to retain workflow claims and prevent stale submissions from clearing run claims prematurely.
- Preserved screenshots and attachments through terminal delivery, reconnect, and workflow replay, including cancelled-before-validation and unknown-delivery cases.

### Tests
- Added mirrored Chrome/Firefox coverage for teacher mode: value-free demonstration capture, session store normalization, automated-run rejection, Enter-as-submit semantics, and cross-browser slash-command wiring.
- Added mirrored coverage for the saved workflow manager, user-approved locator healing, atomic healing persistence with concurrent-update rejection, and workflow run-claim lifecycle.
- Added mirrored coverage for screenshot redaction fail-closed behavior, staged attachment recovery, viewport budget charging, full-page capture refusals, Cloud Bridge settings placement, and the WebBrain Compass cost-limit exclusion.
- Updated `test/run.js` with the API badge removal assertions and the sidepanel authorization state checks.

## [27.0.0] - 2026-08-07

### Added
- Added the WebBrain MCP server so Claude Code, Codex, Cursor, OpenClaw, and other MCP clients can delegate Ask or Act tasks to an already-authenticated Chromium session through the local browser bridge, with tools for connection checks, status polling, clarification responses, and aborting runs.
- Updated the LM Studio plugin with the same authenticated-browser delegation through `browser_task`, `browser_status`, `browser_respond`, and `browser_abort`, while retaining its standalone `fetch_url` and `research_url` tools.
- Added a default-off persistent setting for API mutations and strict JSON Schema output support for WebBrain Cloud runs.

### Changed
- Hardened local bridge task handling across MCP and LM Studio with bounded command and run deadlines, resumable status polling, disconnect recovery, explicit run aborts, and actionable connection diagnostics.
- Improved Act follow-up routing and planner continuity so completed-step summaries remain available to later turns, and localized tool-completion status labels across Chrome and Firefox.

### Fixed
- Kept Ask-mode bridge runs read-only, rejected web-page WebSocket origins, preserved active runs across bridge disconnects, and prevented temporary API authorization or timeout state from leaking into later requests.
- Tightened WebBrain Cloud structured-output validation, secret redaction, public-URL handling, scheduled-job scoping, and run-ID generation without discarding valid schema-shaped results.
- Made iframe form automation fail closed on ambiguous targets and improved promoted-frame navigation, submission, and persisted-value verification in Chrome and Firefox.

### Tests
- Added MCP and LM Studio bridge suites covering connection handshakes, concurrent commands, polling, timeouts, clarification, aborts, disconnect recovery, and clean shutdown.
- Expanded WebBrain Cloud smoke scenarios and mirrored Chrome/Firefox regressions for structured output, privacy boundaries, iframe recovery, Act follow-ups, and localized completion states.

## [26.2.0] - 2026-08-06

### Changed
- Repaired minor release workflow ordering to ensure consistent build/publish sequencing.
- Rebuilt distribution zips for Chrome/Edge/Firefox to match the corrected release workflow.

### Fixed
- Fixed minor release workflow ordering issues that could lead to out-of-order release artifacts.

### Tests
- Updated `test/run.js` to align with the corrected minor release workflow behavior.

## [26.1.0] - 2026-08-05

### Added
- Added a Chrome and Firefox rich-text editor safety system that identifies formatting controls before text entry, uses visual confirmation when available, and requires a corrected, verified editor-body edit before a run can complete.

### Changed
- Unified toolbar classification across content scripts, DevTools Protocol targeting, iframe dispatch, and recovery so the same control is judged consistently through navigation and extension reinjection.
- Bounded safety captures within the configured per-turn screenshot budget while reserving the first guarded edit for structural or visual inspection.

### Fixed
- Prevented ordinary toolbar searches, compact composers, trusted focused fields, and labelled controls from being mistaken for formatting targets without supporting editor evidence.
- Kept recovery obligations attached to the correct editor, route, and frame across rerenders and navigation while preserving distinct live sibling frames.
- Failed closed on ambiguous cross-frame responses, conflicting geometry claims, and page-owned classifier substitutions without stranding a run in unrecoverable toolbar debt.

### Tests
- Expanded mirrored Chrome/Firefox regression and vision-probe coverage for toolbar variants, shadow DOM, nested iframes, navigation, screenshot limits, recovery deduplication, and verified corrected edits.

## [26.0.11] - 2026-08-05

### Changed
- Routed advice and drafting follow-ups through response-only handling when trusted conversation context is sufficient, even while Act mode is selected.
- Closed built-in tool schemas and made the runtime mode authoritative during execute tasks.
- Kept Turkish deasciification opt-in and instruction-only, with skill instructions loadable only from the enabled catalog after explicit conversion intent.
- Bounded Chrome and Firefox conversation, chat, and run-replay session snapshots so live work can continue safely when recovery persistence is unavailable.

### Fixed
- Rejected undeclared tool arguments and mixed click targets before dispatch with structured `invalid_tool_arguments` / `noDispatch` results.
- Suppressed planner-shaped JSON beside tool calls, retried planner-shaped terminals once, and replaced raw execute-protocol failures with a user-facing unverified-completion message.
- Prevented unknown required form values from being represented by empty focus, clear, or write actions.
- Normalized nested and object-shaped failures before UI, trace, and dedupe handling so `[object Object]` is never rendered.
- Made assistant-message Copy controls idempotent, added a localized **Copy message** label, and collapsed rejected `done` retries into one visible diagnostic row.
- Preserved acknowledged replay boundaries without false warnings while deduplicating genuine discarded-event gaps per request.
- Retried quota failures with compact snapshots, marked unrecoverable runs non-durable, warned once, and prevented consequential action replay after connection loss without deleting other tab/session data.

### Tests
- Added mirrored Chrome/Firefox coverage for closed schemas, disabled skill arguments, Act/planner enforcement, nested errors, Copy deduplication, replay boundaries, multi-tab quota exhaustion, attachment/screenshot compaction, and fail-closed reconnect durability.


## [26.0.10] - 2026-08-04

### Added
- Added a rich-text toolbar safety preflight that stops the agent from typing document text into an editor's formatting controls (font size, font family, style preset, colour, link). The target is scored structurally, confirmed against an annotated screenshot where a vision model is available, and blocked before dispatch; the run cannot report success until the edit is redone in the editor body and verified.

### Changed
- Text-entry tools now report verification as a positive proof only. `type_text`, `set_field`, and `iframe_type` mark an edit `verified` when the field's final value proves it landed and stay silent otherwise, instead of reporting an unproven edit as refuted. Masked inputs, `maxlength` truncation, framework-reformatted fields, and whitespace-normalising rich-text bodies no longer register as failed actions.
- `iframe_type` now binds its dispatch to a single resolved frame when a toolbar recovery is pending, and reports the candidate frame URLs so a `urlFilter` can disambiguate them. Ordinary calls keep the previous all-frames behaviour, so pages with repeated same-origin frames continue to work unchanged.
- Moved the toolbar heuristic into one shared module used by both browser builds and by the DevTools Protocol probe, so an element scores the same whichever dispatch route reaches it.

### Fixed
- Fixed the toolbar preflight taking a screenshot that was then discarded, which cost an extra capture and vision call on every guarded edit.
- Fixed the toolbar preflight treating `[role="toolbar"]` ancestry as evidence on its own. An ordinary labelled field in an app toolbar scored high enough to escalate, so with no vision model available the guard blocked prose typed into it and held the run open on a recovery that could never be discharged. A control now also needs a formatting label, a numeric preset value, or a toolbar whose editor body resolves.
- Fixed the append verification rescanning a field's full contents at every candidate position with arbitrary-precision arithmetic, which could stall a page holding a large rich-text document.
- Fixed the cross-frame geometry handshake accepting whichever frame answered first; a second frame claiming the same exchange now fails it closed.
- Fixed toolbar classifier screenshots escaping the per-turn screenshot budget. They now share the cap with the captures the model sees, so the number you configure bounds the vision spend. The first safety capture of a turn is still reserved, so a low cap degrades the check to structural scoring rather than blinding it on the first guarded edit, and both the reserved capture and the fall-back are surfaced.
- Fixed a navigation during an open toolbar recovery stranding the debt without the state that discharges it, which left the guard inactive for the rest of the run while completion stayed blocked and no corrected edit could clear it. An editor whose only recovery handle was a page-scoped ref now carries across as unknown-target recovery instead of being dropped.
- Fixed selector preflights trusting a page-owned toolbar-classifier global; the DevTools Protocol path now captures only the packaged classifier and fails closed when that source cannot be loaded.
- Fixed navigation and extension-recovery paths duplicating one semantic editor obligation or reinjecting `content.js` without its toolbar classifier. Child-frame scope survives navigation while live sibling frames remain distinct.

### Tests
- Added mirrored Chrome/Firefox coverage for the verification contract, the `iframe_type` fallback, the toolbar heuristic's false positives, and the recovery contract, and pinned the heuristic to a single implementation across both builds and the DevTools Protocol probe.
- Added mirrored Chrome/Firefox coverage for the debt and state maps agreeing across a navigation, in both directions: an obligation that loses its ref stays dischargeable, and a debt nothing can discharge is dropped with its state.

## [26.0.0] - 2026-07-26

### Added
- Added non-blocking local browser runs: regular Chrome and Firefox tasks stay pinned to their original tab without activating it or stealing window focus, while `/foreground [prompt]` provides a one-run compatibility escape hatch for sites that must render visually in the foreground.
- Added offline converters for exported traces in Agent Trajectory Interchange Format (ATIF) and OpenTelemetry Protocol (OTLP), with documentation and regression coverage.
- Added an accessible in-panel **New conversation** confirmation that works when Vivaldi Web Panels suppress native browser dialogs.

### Changed
- Rebuilt CAPTCHA handling around frame-aware challenge detection and targeted response injection for reCAPTCHA, hCaptcha, and Turnstile, including branded-dialog and ancestor-loader recognition, cross-frame verification, manual-completion recovery, explicit gate abandonment, and fail-closed handling for ambiguous or conflicting candidates.
- Isolated selected-text context from independent, scheduled, cloud, and saved-workflow runs while preserving grounded follow-ups, attachments, compaction, and shortcuts within the originating selection conversation.
- Extended the rapid duplicate-submit guard to Firefox and made acknowledged resubmits re-arm the protection window in both browsers.
- Refreshed and reorganized the English, French, and Chinese documentation, landing-page demos, language ordering, and agent/skills/slash-command references.
- Polished the floating chat-navigation control, linked Settings title behavior, full-screen recording status, and slash-command keyboard actions.
- Extracted shared loop-detection, image-budget, and text tool-call parsing helpers without changing their browser parity.

### Fixed
- Rejected blank Chrome full-page captures, improved background screenshot compatibility, and verified inactive Firefox tabs before declaring a run complete.
- Fixed CapSolver key migration so valid saved `CAP-` keys enable solving consistently while malformed keys remain disabled.
- Fixed selection-scoped history, workflow, attachment, and navigation paths that could leak context into unrelated runs.
- Fixed CAPTCHA frame visibility, challenge correlation, response-field targeting, token fallback, and recovery after redirects or manual completion.
- Fixed the full-screen recording message so it matches whether the recording indicator is actually visible.

### Tests
- Added mirrored Chrome/Firefox regression coverage for background runs, inactive-tab capture, CAPTCHA gating and injection, selection-scope isolation, duplicate-submit protection, trace conversion, and the updated UI flows.

## [25.9.0] - 2026-07-25

### Added
- Added 76 new LLM providers (icons, docs, and README updates across English, French, and Chinese) alongside interactive Ask-mode streaming support for the expanded provider list.
- Added a `/watch` slash command with conditional scheduler polling, alerts on distinct successful events, dedupe-aware helper-tab cleanup, transient-failure tolerance, and locale/docs coverage.
- Added reCAPTCHA Enterprise support to the Chrome CapSolver agent tool, including v3/Enterprise widget and script detection across DOM, URL, and iframe paths, an `isEnterprise` schema field, and clearer parameter-vs-dispatch error triage.
- Restyled sidepanel tabs in Chrome and Firefox, with resize and RTL layout fixes.
- Published workflow export/import format documentation.

### Changed
- Centralized text sanitization and shared UI utilities and standardized provider message logic across Chrome and Firefox, including a Firefox utils dedup follow-up.
- Hardened interactive Ask streaming: traced the streaming run lifecycle, preserved trace ordering, redacted JSON-shaped streaming secrets, and fixed duplicate normalized streamed answers.
- Hardened chat/run clearing and cancellation: kept the composer locked while clearing, bounded unavailable stop-state probes, waited for stopped/local/direct run followers before clearing, suppressed updates from cleared runs, guarded the Stop fallback and stopped runs until a terminal state, scoped New Chat aborts to their originating tab, discarded queued prompts before clearing, stopped active runs before starting new chats, and cancelled schedules once active runs settle.
- Added WebBrain Compass interface strings and microphone permission messages to all locales, refreshed the evroc provider icon and provider counts, and updated Discord links and added a Chinese community section to the docs sidebars.
- Disabled the mode-pill animation for `prefers-reduced-motion`.

### Fixed
- Fixed detached side panel window routing in Chrome.
- Recovered workflow replay from a start-scope mismatch.
- Parsed action parameters with `URL.searchParams` to preserve decoded characters.
- Preserved pending upload evidence and fixed `find_text` selection verification and advancement.
- Fixed store submission automation.

### Tests
- Added mirrored Chrome/Firefox coverage for CapSolver Enterprise version/edition/action detection and error triage, `/watch` polling and dedupe behavior, and the centralized UI/text-sanitization utilities.

## [25.8.0] - 2026-07-23

### Added
- Added Inkling planner benchmark (OpenRouter default, Chrome thinkingmachines/inkling frozen fixtures) and published the corresponding benchmark docs/blog page.

### Changed
- Improved sidepanel UI polish for picker controls and the language menu.
- Added new UI locales for **de** and **nl**, including flag assets, and updated locale ordering/initialization to match expected dropdown behavior in both **Chrome and Firefox**.
- Updated provider/model documentation and synced docs with recent streaming requirements (including explicit Mistral stream usage guidance).
- Enabled Ask streaming behavior updates across providers while aligning provider-specific streaming/usage expectations.
- Rebuilt distribution zips for Chrome/Edge/Firefox.

### Fixed
- Fixed locale dropdown initialization and ordering issues (including missing locale pieces for **nl**/**de**).
- Avoided retrying terminal Ask stream errors to prevent incorrect fallback behavior.
- Corrected provider streaming usage handling for Mistral Ask (ensuring required usage/stream events are used as documented).
- Preserved provider-specific streaming compatibility rules (e.g., keeping Alibaba Ask non-streaming where required).

### Tests
- Added Inkling planner benchmark result fixtures to the test suite (Chrome thinkingmachines/inkling frozen set).

## [25.7.12] - 2026-07-23

### Changed
- Expanded interactive Ask streaming from GPT-5.6 to documented streaming- and function-calling-capable official OpenAI models, while keeping GPT-5.5 Pro and other unsupported variants non-streaming.
- Routed Responses-only GPT-5 Pro variants through the Responses API and retained Chat Completions streaming for other supported OpenAI models.
- Enabled interactive Ask streaming for Anthropic, Azure OpenAI, Gemini, DeepSeek, xAI, Mistral, Nvidia NIM, Groq, Together AI, Fireworks, z.ai, OpenRouter, WebBrain Compass, llama.cpp, Ollama, LM Studio, Jan, vLLM, SGLang, and LocalAI with provider-specific terminal-event validation.
- Generalized the Advanced streaming control and made safe transport/protocol fallback silent: the affected generation retries non-streaming once, then streaming stays disabled for the rest of that run.

### Fixed
- Treat premature official OpenAI Chat Completions stream EOF as an interrupted generation, clearing partial text and retrying once through the non-streaming path.
- Normalized GPT-5 Pro reasoning effort to its supported `high` value.
- Propagated explicit Chat Completions, Anthropic, and Azure in-stream API error events instead of accepting a later terminal sentinel as success; HTTP/API errors never trigger the silent fallback.
- Rejected OpenAI-compatible and Azure streams that finish with `content_filter`, clearing any partial text instead of persisting a filtered response or retrying it non-streaming.
- Added the documented `gpt-5.2-chat-latest` model to official OpenAI Ask streaming capability detection.
- Hardened llama.cpp streaming with readable-body, malformed-frame, explicit-error, usage, reasoning, and terminal `[DONE]` handling before enabling its silent non-streaming fallback.
- Added z.ai's required `tool_stream` request option for streaming generations that expose agent tools.
- Preserved Groq token usage delivered in the provider-specific `x_groq` streaming envelope.
- Rejected z.ai streams that finish with `sensitive`, `network_error`, or `model_context_window_exceeded` instead of persisting partial output as a successful response.
- Kept Alibaba Cloud Ask calls non-streaming because DashScope rejects its required `tools` payload when `stream: true`.
- Requested Mistral streaming usage events explicitly so interactive Ask turns remain included in cloud cost allowances.
- Preserved in-progress streamed Markdown across side-panel/sidebar closes, reloads, and reconnects in Chrome and Firefox.
- Rebuilt restored streams from the background-owned UI journal without duplicating deltas, losing Markdown structure, or leaving an unfinished stream in its incremental render state.

### Tests
- Added mirrored Chrome/Firefox coverage for OpenAI streaming capability detection, GPT-5.4 Pro routing, Chat Completions completion sentinels, and transport fallback.
- Added mirrored capability, terminal-event, malformed-frame, explicit-error, content-filter, and silent one-time fallback coverage for the newly enabled providers.
- Added mirrored regression coverage for persisted streamed text, reconnect replay, restored finalization, and journal size limits.

## [25.7.11] - 2026-07-23

### Fixed
- Ranked provider Settings search results by exact provider name/ID, then prefix, then substring matches while preserving the configured provider order for ties.

### Tests
- Added Chrome and Firefox provider-search ranking coverage.

## [25.7.10] - 2026-07-23

### Fixed
- Rendered streamed assistant output as Markdown while deltas arrive and finalized the same message when the terminal response is received.
- Replaced rejected or corrected streamed terminal content instead of appending a duplicate response.
- Finalized restored streamed responses consistently after reconnect.

## [25.7.9] - 2026-07-23

### Changed
- Refined reading-first navigation so new questions remain visible while long responses grow, explicit reader positions are preserved, and restored chats return to the latest turn.
- Added floating **Follow response**, **Jump to latest**, and **Back to question** controls for clipped long replies.

### Fixed
- Kept Continue bars, plan/clarification prompts, store-review prompts, new questions, and slash-command output visible when they require attention.
- Resumed live follow after an explicit jump to the response edge without overriding deliberate reading positions.

## [25.7.8] - 2026-07-23

### Added
- Added reading-first navigation for long replies across Ask, Act, and Dev modes in Chrome and Firefox.

### Removed
- Removed the packaged Chrome Web Store release skill, its privileged upload/publish routing, setup UI, dashboard adapter, protected-page exception, and previously seeded local skill records.

### Fixed
- Kept blocking prompts and slash-command output visible without losing live follow when a run resumes.
- Kept the navigation control available whenever response content extends below the viewport.

### Tests
- Added mirrored long-reply navigation, localization, restored-turn, and instant auto-follow regression coverage.

## [25.7.6] - 2026-07-22

### Added
- Added portable saved workflow JSON export and import commands with Chrome and Firefox parity.

### Changed
- Updated the official OpenAI model picker to list current dated model variants.
- Portable workflow imports are normalized, size-bounded, assigned fresh local identity, and rejected when unsafe or over the saved-workflow limits.

### Tests
- Added mirrored portable workflow parsing, file transfer, redaction, fresh-identity, and account-limit coverage.

## [25.7.0] - 2026-07-22

### Added
- Added safe saved workflow schema and UI support for saving and managing traced runs (Chrome and Firefox parity).

### Changed
- Updated workflow replay to use the new safe saved workflow schema, improving reliability and reducing brittle replay behavior (Chrome and Firefox parity).
- Updated documentation for privacy/data flow and security model to reflect saved workflow/replay behavior.

### Fixed
- Guarded workflow replay by page scope to prevent cross-page/brittle replays.
- Rejected brittle selector replay during saved workflow replay to avoid incorrect actions.
- Improved workflow replay safety by replaying saved actions in a more controlled manner.
- Closed workflow gaps for save, replay, and telemetry to ensure consistent end-to-end behavior (Chrome and Firefox parity).

### Tests
- Updated test runner (`test/run.js`) to align with the saved workflow/replay changes.

## [25.6.0] - 2026-07-22

### Added
- Added Ask-only OpenAI Responses streaming for interactive Ask-mode chats (Chrome and Firefox parity).

### Changed
- Updated planner benchmark coverage by adding Nanbeige 4.2 planner benchmark results to the repo.

### Fixed
- Improved structured plan review/editor stability by preserving editor scroll position across input and keeping step editing scroll stable (Chrome and Firefox parity).

### Tests
- Added Nanbeige 4.2 planner benchmark fixtures/results to the test suite.

## [25.5.0] - 2026-07-22

### Added
- Added a default-on Advanced setting to disable OpenAI Ask response streaming immediately and return new chats to the established non-streaming provider path.
- Improved plan review with structured, in-place editing (Chrome and Firefox parity).

### Changed
- Official OpenAI Responses calls now stream visible text for interactive Ask-mode chats while retaining the detached `chat_start` lifecycle, reconnect journal, and image/text attachment handling.
- Tool calls and assistant-history persistence remain buffered until `response.completed`; Act, Dev, scheduled, cloud, and Continue runs remain on `provider.chat()`.
- Drag-and-drop reordering of planner steps.
- Hardened mixed plan editor modes to keep editing behavior consistent.
- Preserved multiline plan step edits during editing and review flows.
- Preserved collapsed raw plan approvals through review.
- Preserved raw plan edits after review.
- Stripped canonical plan tool suffixes for cleaner plan tool display.

### Fixed
- Interrupted OpenAI Ask transports now clear their partial visible text, open a per-run circuit breaker, and retry through `provider.chat()` without accepting incomplete tool calls or persisting an incomplete assistant turn; terminal HTTP, API, and `response.incomplete` errors propagate without a duplicate fallback request.
- Live Ask text deltas remain immediate while durable reconnect snapshots are coalesced on a short trailing interval, avoiding a full journal clone and `storage.session` write for every SSE chunk; terminal updates and tool checkpoints still flush immediately.
- Fixed plan review scroll behavior and the run label during plan review/editing.
- Kept plan step editing scroll stable while interacting with the editor.
- Captured plan editor scroll before input to prevent scroll jumps.

### Tests
- Added mirrored Chrome/Firefox coverage for streaming scope, attachment delivery, terminal tool-call gating, coalesced reconnect persistence, detached lifecycle wiring, the kill switch, and transport-only non-streaming fallback.
- Updated test runner (`test/run.js`) to align with the new plan editor/review behaviors.

## [25.4.2] - 2026-07-22

### Added
- Added a default-disabled packaged Chrome Web Store release skill with trusted status, ZIP upload, and publish tools backed by the official v2 API in Chrome and Firefox.
- Added skill-scoped setup for user-owned Google OAuth credentials, publisher/item IDs, and an explicitly selected local release ZIP.

### Changed
- Added a Chrome Web Store dashboard adapter that routes enabled runs to the release skill instead of protected DOM controls.

### Fixed
- Added an always-on Chrome protected-page guard for the Chrome Web Store Developer Dashboard so DOM tools fail immediately and non-retryably instead of entering wait/read retry loops.

### Security
- Kept OAuth tokens and release ZIP bytes in extension-local storage and out of model prompts, tool arguments, traces, and tool results; upload and publish remain behind consequential-action permission and submission gates.

## [25.4.0] - 2026-07-21

### Added
- Added round-trip automatic progress policy to improve completion reliability across the full submit → completion → evidence loop.

### Changed
- Updated OpenAI model invocation to use `gpt-5.4-nano-2026-03-17` with `max_completion_tokens`.
- Preserved reviewed submit requirements across continuations to keep validation consistent when a run resumes.
- Hardened submit completion evidence requirements (including final-form completion evidence) to reduce false positives.
- Improved submit-state reconciliation by carrying submit verification across continuations and reconciling from screenshot URLs.
- Updated Chrome and Firefox builds to reflect the above completion/submit policy changes for parity.

### Fixed
- Prevented completion guard loops and stopped stale calls after completion-page blocks.
- Tightened completion success evidence to avoid accepting incomplete or uncertain outcomes.
- Improved handling of validation failures so they remain blocking for completion.
- Fixed CI/release robustness issues related to changelog prompt parsing and release-context substitution.

### Tests
- Added/expanded CI grading and E2E coverage to diagnose Gnippets HTTP failures and validate cloud E2E control requests.
- Added CI robustness improvements for unattended runs (disabling action prompts) and tightened grading inputs (e.g., accepting camelCase final URLs in CI grading).

## [25.3.0] - 2026-07-21

### Added
- Added initial release note scaffolding for WebBrain.

### Changed
- Updated OpenAI model usage to **gpt-5.4-nano-2026-03-17** and switched to `max_completion_tokens` for completion limits.
- Switched WebBrain Compass provider integration from **GitHub Models** to direct **OpenAI API** calls (using `OPENAI_SECRET` via curl), improving consistency across providers.
- Updated Chrome and Firefox builds to reflect the provider/model changes and associated configuration/UI updates.

### Fixed
- Resolved model-parameter compatibility issues by ensuring `max_completion_tokens` is used where required (avoids deprecated `max_tokens` errors).
- Corrected prior provider model ID handling during the transition away from GitHub Models.
- Improved release/changelog generation robustness by avoiding YAML parsing issues in the release prompt pipeline.

### Tests
- Added/expanded CI grading and E2E infrastructure coverage to better diagnose HTTP failures and validate cloud E2E control requests.
- Added CI robustness improvements for unattended runs (disabling action prompts) and tightened grading inputs (e.g., accepting camelCase final URLs).

## [25.2.0] - 2026-07-21

### Added

### Changed

### Fixed

### Tests
- Comprehensive test suite established for validating core functionality and browser compatibility.

## [25.0.0] - 2026-07-19

### Added
- Added runtime completion invariants in Chrome and Firefox that track consequential actions, require a fresh successful observation before accepting a success claim, and preserve verification obligations across batched calls, trusted continuations, restored runs, and scheduled tasks.
- Added localized permission education after repeated action prompts, with an onboarding note and a safe action that inserts `/dangerously-skip-permissions` for the specific pending prompt without overwriting an existing draft.
- Added a permanent, fully localized **Tweet about WebBrain** recommended action that opens X's visible composer, publishes reviewed language-specific copy without asking the model to write or translate it, then verifies and reports the post URL when available.

### Changed
- Action runs now reject plan-only, empty-step, promise-only, and premature terminal replies and continue into execution; explicitly requested plans and Markdown plus honest structured blockers remain valid results.
- Completion enforcement now distinguishes real dispatch from preflight failures, accepts only model-visible state observations, self-verifies successful scheduler writes, and preserves the intended Compact Dev and managed-cloud execution boundaries.

### Fixed
- Prevented stale tool calls from running after a rejected `done`, cleared rejected streamed plan text before recovery, preserved terminal obligation and session metadata, and rejected stale or same-batch completion evidence.
- Repaired high-confidence double-escaped assistant Markdown returned by OpenAI-compatible backends without rewriting legitimate code, paths, or escape-sequence examples.
- Hardened accessibility actions with document- and SPA-route-scoped refs, fresh-target and visibility checks, canonical accessible names, iframe dispatch tracking, and safer guarded-click progress detection, preventing stale clicks and false agent stops.
- Made `set_field` wait for controlled and rich-text editors to settle and require an exact normalized readback before submitting; failed sensitive-field readbacks no longer expose typed values.
- Corrected false completion blocks for denied, skipped, or pre-dispatch actions; pre-existing targets; input and CAPTCHA preflight failures; screenshots not visible to the model; observed non-success outcomes; and self-verified scheduled tasks.

### Tests
- Expanded mirrored Chrome and Firefox regression coverage for plan-to-execution handoffs, completion-invariant state and recovery, permission education and tab scoping, assistant-text repair, accessibility refs and field verification, and exact localized WebBrain post copy.

## [24.4.0] - 2026-07-18

### Changed
- Add guarded CDP click fallback + full screenshot bugfix

## [24.3.1] - 2026-07-18

### Changed
- Chrome `click_ax` stays synthetic-first and may issue one guarded CDP trusted-click fallback only after no observable progress on safe generic targets (visibility, hit-test, interactive-descendant, form/download/mutating/stateful exclusions).
- Trusted-click progress proof ignores whole-page text churn and blur-only focus loss; safety vetoes skip automatic retry without rewriting working clicks to failure.

### Fixed
- Removed invalid CDP `Input.enable` usage; trusted mouse events dispatch directly.
- Observation windows for fallback candidates poll progressively so slower SPA handlers can still prove progress before a second click.

### Tests
- Added unit and fixture coverage for eligibility gates, one-shot fallback accounting, network/beacon vetoes, and post-CDP target-state verification.

## [24.3.0] - 2026-07-17

### Changed
- Replaced the first-install fake toolbar walkthrough with a real **Open Side Panel** action in Chromium and **Open Sidebar** action in Firefox.
- Added an accessible Chromium first-open coachmark that points to the browser's actual side-panel pin, mirrors its arrow for left-side layouts such as Vivaldi, and clearly distinguishes that pin from the toolbar icon it adds.
- Kept Firefox guidance aligned with its native Extensions menu and refreshed the install flow across all 16 supported locales.
- Report the browser-resolved absolute path after WebBrain screenshots, recordings, transcripts, and run captures finish saving, including configured subfolders and uniquified filenames.

### Fixed
- Removed non-interactive toolbar and extension-menu illustrations that looked clickable but could not complete setup.
- Sequenced the Chromium pin coachmark before the existing model and safety onboarding so first-time setup has one clear action at a time.
- Kept keyboard focus inside the pin coachmark while it is open and added an explicit **Skip this step** exit so first-run setup cannot strand the user.
- Prevented early install-page clicks from disappearing, kept first-open tabs in the normal WebBrain panel group, and replaced premature success styling with browser-specific recovery guidance.

### Tests
- Added Chrome and Firefox coverage for real panel opening, first-install coachmark state, modal focus handling, explicit dismissal paths, left/right arrow layout, native Firefox wording, responsive behavior, reduced motion, and locale parity.

## [24.2.0] - 2026-07-17

### Changed
- Add Kimi provider support

## [24.1.0] - 2026-07-16

### Changed
- import/export configs

## [24.0.2] - 2026-07-16

### Added
- Added `/export --config` to download a portable JSON snapshot of settings and `/import <json>` or `/import --file` to restore one in Chrome and Firefox.
- Included provider, vision, transcription, and CAPTCHA API keys in configuration snapshots, with an explicit plaintext-secret warning before export and import.

### Changed
- Limited configuration snapshots to settings-backed state, excluding device-bound sync identifiers and tokens, conversations, traces, jobs, and usage counters.

### Tests
- Added mirrored coverage for configuration schema completeness, round trips, validation failures, file selection, slash-command routing, and background import/export handlers.

## [24.0.1] - 2026-07-16

### Added
- Added hidden trailing `/record [--save-as <filename>]` and `/screenshot [--save-as <filename>]` prompt suffixes. Recording now wraps a Chrome run and saves automatically; screenshot capture saves timestamped or custom-named before/after PNGs in Chrome and Firefox. The suffixes remain intentionally absent from `/help` and autocomplete.

### Fixed
- Kept agent-created reference tabs in the background so Chrome and Firefox runs remain visibly attached to their original tab.
- Detected Firefox-protected Mozilla domains before blocked DOM or network reads, used one active-tab screenshot fallback where possible, and stopped equivalent non-retryable attempts instead of looping.
- Treated Responses streams that end without `response.completed` as incomplete instead of persisting partial output as a successful turn.
- Preserved unsaved custom request-body JSON drafts across provider search, filtering, and card re-renders, including temporarily invalid JSON while editing.
- Re-activate the originating run tab before the after screenshot when a run opens another tab.
- Restored Mozilla Add-ons developer adapter matching after the hostname-hardening matcher rename.
- Rebuilt the Chrome, Edge, and Firefox 24.0.1 archives from the final source tree.

### Tests
- Added regression coverage for background tab ownership, Firefox restricted-domain handling, bounded read retries, premature Responses stream termination, and compatibility JSON draft persistence.
- Added mirrored parser, filename sanitization, lifecycle ordering, Downloads saving, Chrome recorder identity, and Firefox unsupported-recording coverage for hidden run capture.

## [24.0.0] - 2026-07-16

### Added
- First-class **GPT-5.6** support for official OpenAI: default model `gpt-5.6-terra`, UI suggestions for Terra / Sol / Luna, and a **1,050,000**-token context window for the `gpt-5.6*` family.
- Official OpenAI GPT-5.6 routes through the **Responses API** (`/v1/responses`) with encrypted reasoning replay (`response_items`), function-call conversion, streaming, and usage normalization. Older models and custom/proxy base URLs stay on Chat Completions.
- **Advanced model compatibility** settings on every provider card: preset (Auto / OpenAI / Qwen / DeepSeek / OpenRouter / Custom), reasoning effort, system vs developer role, max-token field, and safe custom request-body JSON.
- Shared `provider-compatibility.js` layer (Chrome + Firefox) that maps roles, token fields, reasoning knobs, and merges protected extra body fields for OpenAI-compatible, Azure OpenAI, and llama.cpp request builders.
- Documented the release in `WHATS_NEW_IN_V24.md` at the repository root.

### Changed
- OpenAI-compatible request building is centralized so compatibility presets apply consistently without mutating stored chat history.
- OpenAI default cost metadata migrates safely when upgrading from earlier shipped defaults.

### Tests
- Added / retained coverage for Responses routing, reasoning replay, streaming, provider-compatibility merges, GPT-5.6 context windows, and default-model migration.

## [23.3.6] - 2026-07-15

### Added
- Added a default-on **Help Improve WebBrain** control at the bottom of the visible Settings → General area in Chrome and Firefox. WebBrain Compass requests now send the current choice as `X-WebBrain-Help-Improve: 1` or `0`; local-model and bring-your-own API requests never receive that header.

### Changed
- Updated the public privacy policy and developer data-flow documentation to disclose selected WebBrain Compass interaction retention and model-improvement use, the future-interaction opt-out, a 12-month raw-data limit, and a five-year limit for de-identified datasets.
- Added opaque per-conversation WebBrain Compass session grouping across main, planner, compaction, intent, memory, and vision generations, with permanent opt-out tainting and no collection metadata on local or bring-your-own providers.
- Added encrypted, compressed, text-and-tool-only Cloud improvement storage with image omission, authenticated session browsing, de-identified JSONL export, 12-month pruning, and isolated OpenRouter logging/no-logging key routing.

### Tests
- Added mirrored coverage for the default-on UI, persistence and live provider reload, Cloud-only request headers, locale completeness, and privacy-policy retention language.

## [23.3.3] - 2026-07-15

### Changed
- Clarify timeout slider semantics: **0 = Instant** (always auto-select the first option), **1–1200s = wait then auto-select**, and **above 1200s (slider max / Off) = wait indefinitely**. Existing stored `0` (old Off) migrates once to Off.
- Instant clarify auto-selects use `source=auto` and tell the agent to continue (intentional unattended policy, e.g. headless); only waited `source=timeout` keeps the non-confirmation warning.

### Tests
- Updated Chrome and Firefox clarify-timeout coverage for Instant / Off slider endpoints, one-shot semantics migration, and Instant vs waited-timeout agent notes.

## [23.3.2] - 2026-07-15

### Added
- Added a configurable clarify auto-timeout (default 60s, 0–1200s under Settings → General → Advanced) for Chrome and Firefox. Unanswered `clarify` prompts auto-select the first option (or a timeout marker when options are empty); permission and form-submit confirmations stay untimed.

### Changed
- Documented that timeout auto-selects are not real user confirmations in the `clarify` tool schema and system prompts, and kept timeout answers out of user-memory extraction.

### Fixed
- Cleared scheduled-job `needs_user_input` / `pendingClarify` on clarify auto-timeout without replaying a start-of-run `running` event that could orphan the original assistant bubble.
- Restarted clarify countdown metadata after sidepanel restore/rebind so closed panels do not leave stale open cards.

### Tests
- Added Chrome and Firefox regression coverage for clarify timeout settings, schema/prompt guidance, scheduler wait-state cleanup, restore countdown metadata, and memory exclusion of timeout sources.

## [23.3.1] - 2026-07-15

### Changed
- Added bounded canonical semantic intents to the shared on-demand skill catalog so the planner and `load_skill` can route multilingual requests without literal keyword matching or an extra embedding call.
- Let approved Act plans activate validated skill IDs before execution, with Dev inheriting Act-compatible skills, Ask limited to explicitly compatible skills, and Compact remaining skill-free.
- Added recording and exporting WebBrain versions to new traces, conversation Markdown, trace Markdown, and Traces-page JSON while labeling legacy recording versions unavailable.

### Fixed
- Redirected single-media browser download attempts to an eligible inactive FreeSkillz skill, including exact-permalink discovery on feeds and profiles, while preserving browser fallback only after a real server failure or unavailable skill.
- Prevented the agent path from saving split or unverifiably muxed MSE audio/video buffers or presenting ffmpeg and login advice as a successful result.

### Tests
- Added Chrome and Firefox coverage for intent normalization and catalog isolation, planner activation and rejection, multilingual routing metadata, inactive-skill redirects, strict MSE refusal, and versioned current and legacy exports.

## [23.3.0] - 2026-07-15

### Changed
- Load browser skills on demand

## [23.2.2] - 2026-07-15

### Changed
- Made enabled skills available on demand: Mid/Full Ask, Act, and Dev runs receive a small eligible name/summary catalog, full instructions and compatible tools load only for the current relevant run, and Compact exposes no skill surface.
- Added optional prompt-stripped `webbrain-skill` metadata for capped summaries and explicit Ask/Act compatibility while preserving existing skill storage and `webbrain-tools` manifests.

### Fixed
- Replaced ambiguous Content-Disposition filename matching in Chrome and Firefox public-media downloads with a bounded single-pass parameter parser that preserves RFC 5987 precedence and fails closed on malformed quoted values.

### Tests
- Added mirrored coverage for skill catalog eligibility, activation isolation and reset, strict-secret ordering, recommended-action preactivation, and adversarial Content-Disposition filename parsing.

## [23.2.0] - 2026-07-14

### Added
- Added an opt-in packaged Litterbox temporary file-share skill for Chrome and Firefox, available from Settings with explicit `clarify` confirmation, public-link and absolute-expiry warnings, blocked-file preflight checks, browser-specific upload limits, and visible provider attribution. Uploads go through the Litterbox page with `upload_file`, so no `/allow-api` override is needed and file bytes never reach the LLM provider.
- Added opt-in Open-Meteo weather and Open Library book-search skills for Chrome and Firefox. The read-only, no-key integrations clarify ambiguous locations, keep metric and imperial weather units consistent, limit catalog responses, treat provider data as untrusted, and show visible source attribution.
- Added disabled-by-default Together AI and Fireworks OpenAI-compatible router providers for Chrome and Firefox, including Settings fields, suggested models, configurable endpoints, API-key links, and streaming-usage support.

### Changed
- Classified Together AI and Fireworks consistently as router providers and migrated older saved category values without dropping stored credentials.

### Fixed
- Prevented host-page capture listeners from intercepting keyboard input inside the selection shortcut by loading its containment handler at `document_start` and isolating keydown, keypress, and keyup events.
- Kept the selected text visibly highlighted while the selection menu is open, bounded the overlay to 200 visible rectangles, and cleared highlights when the menu closes or is dismissed.

### Tests
- Added packaged-skill catalog and Litterbox safety, privacy-disclosure, upload-flow, browser-limit, and expiry coverage.
- Added Chrome and Firefox coverage for Open-Meteo units and tool manifests, Open Library search and attribution, Together AI and Fireworks provider defaults and migrations, and selection-shortcut keyboard containment and bounded highlights.

## [23.1.2] - 2026-07-14

### Added
- Added universal `<command> --help` support for slash commands, returning the selected command's usage, description, and available options directly in chat.
- Published the WebMCP integration blog post.

### Fixed
- Made Enter accept highlighted slash-command flag completions such as `/schedule --list` without prematurely executing the parent `/schedule` command.
- Restored intentional localized formatting in trusted composer toasts while keeping dynamic error text escaped.

### Tests
- Added Chrome and Firefox regression coverage for command-specific help, flag autocomplete ordering and completion, invalid mixed help flags, and trusted toast rendering.

## [23.1.0] - 2026-07-14

### Added
- Added `/export --traces` in Chrome and Firefox to download the current conversation's recorded planner turns, assistant prose, and tool calls as privacy-scrubbed Markdown while keeping `/export` messages-only.
- Added safe syntax highlighting for fenced Markdown code blocks in both side panels across JavaScript, CSS, markup, JSON, Python, shell, SQL, YAML, and C-like languages.
- Published the NVIDIA GLM-5.2 planner benchmark blog and complete frozen, Full, Mid, and Compact 100-case result sets.

### Changed
- Consolidated overlapping slash commands around canonical commands and flags, including `/schedule --list`, `/scratchpad --append` / `--clear`, `/memory --add` / `--forget`, `/screenshot --full-page`, `/record --full-screen` / `--transcribe`, and `/export --traces`, with flag-aware help and autocomplete.
- Changed Mail.tm inbox waits to perform one immediate check and use scheduled resumes for later checks instead of polling inside an active run.

### Fixed
- Sequenced and coalesced managed Chrome cloud-run updates while applying size limits, image omission, and sensitive-key redaction to persisted and live text-delta data.
- Guided Chrome and Firefox Gmail draft replacement through one clearing `set_field` call followed by verification, avoiding fragile click-and-keyboard clearing flows.
- Brought non-English Chrome and Firefox slash-command help and permission copy to parity with the English command lists and keyboard shortcuts.
- Corrected the GLM-5.2 benchmark result links.

### Tests
- Expanded regression coverage for trace export privacy and ordering, canonical slash-command flags, Markdown highlighting, scheduled inbox waits, Gmail draft replacement, locale parity, and managed cloud update sequencing and scrubbing.

## [23.0.4] - 2026-07-13

### Added
- Added an opt-in packaged Mail.tm disposable email skill for Chrome and Firefox, available from Settings with explicit confirmation, honest session-retention guidance, automatic account cleanup, and visible provider attribution.
- Added nine Chrome Dev-mode tools for reversible CSS/DOM experiments and page diagnosis: `inject_css`, `remove_injected_css`, `patch_element`, `revert_patch`, CDP-backed `execute_js`, `read_console`, `inspect_network_requests`, `inspect_event_listeners`, and `highlight_element`.

### Fixed
- Stopped Chrome Dev diagnostic handlers, buffers, and their Runtime/Log/Network CDP domains when leaving Dev mode, and enabled the same capture lifecycle for streaming runs.
- Bounded Chrome `execute_js` evaluation to 15 seconds, made CSS undo handles unique and document-bound, and canonicalized structured element patch names before recording reversible state.
- Propagated Chrome CDP callback failures from `chrome.runtime.lastError`, so timed-out or rejected `execute_js` evaluations report failure instead of an empty successful result.
- Redacted common API, subscription, access, auth, and client key header-name variants before Dev network diagnostics enter the in-memory buffer.
- Blocked `javascript:` form actions in structured element patches and permission-gated event-listener inspection and element highlighting because both briefly mutate live DOM.
- Disabled diagnostics on every tracked Dev tab when leaving panel-wide Dev mode, cleaned up exact injected CSS across navigation races, and followed open-shadow hosts when inspecting ancestor event listeners.

### Tests
- Added packaged-skill catalog, opt-in Settings, and Mail.tm safety/API cleanup coverage.
- Added Dev-only exposure, bounded CDP execution, diagnostic lifecycle, sensitive-header redaction, document-safe CSS undo, canonical element patching, permission classification, and state-change coverage for the new Chrome Dev toolkit.

## [23.0.2] - 2026-07-13

### Added
- Added `upload_file` tool support for Firefox WebBrain extension, including sidepanel-based user file picker flow and `downloadId` re-fetch flow with 25MB file size limit.
- Added a selection shortcut for Chrome and Firefox with Summarize, Explain, Quiz me, Proofread, Translate, and custom WebBrain prompts.
- Expanded the native selection context menu with matching preset actions, translation languages, and direct side-panel access.
- Added a persistent setting to hide or restore the floating selection shortcut.
- Added the managed cloud-browser bridge for API-driven run, status, abort, active-tab control, and validated structured results.

### Changed
- Simplified the selection shortcut to a compact purple question-mark icon.
- Added direct Chrome, Firefox, and Edge store links to the English, French, and Chinese README introductions.

### Tests
- Added prompt-safety, browser-specific delivery, duplicate-submission, viewport, keyboard, persistence, translation, and screenshot-suppression coverage.

## [23.0.0] - 2026-07-12

### Added
- Added subscription resume action, including scheduled resume task detection, mode sync before resume, and render subscription actions for restored runs.

### Changed
- Injected trusted runtime clock into agent runs for reliable scheduling.
- Kept runtime context out of planner history and stripped runtime context from derived task state.
- Preserved mode for subscription error resumes.

## [22.4.0] - 2026-07-11

### Changed
- Open Local screenshot PII redaction before vision

## [22.3.0] - 2026-07-10

### Changed
- fast suggested actions

## [22.2.3] - 2026-07-10

### Added
- Added Azure OpenAI and AWS Bedrock (Converse) providers in Chrome and Firefox, including Settings fields, provider manager wiring, docs, and regression coverage.
- Added encrypted profile sync for providers, profile settings, memory, and auxiliary providers, with email auth, local password unlock, merge recovery, reset, and change-password controls.
- Added Hebrew app localization and refreshed localized app and website copy.
- Added GitHub funding metadata and refreshed the WebBrain logo, store listing, banner, favicon, social-card, and website image assets.

### Changed
- Updated local model setup guidance and provider context-window detection for llama.cpp, Ollama, and LM Studio so live runtime windows can replace defaults while respecting manual overrides.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, architecture docs, and rebuilt Chrome, Edge, and Firefox release archives for 22.2.3.

### Fixed
- Fixed local model context-window detection, including stale detection writes and over-reported windows from loaded local backends.
- Hardened encrypted profile sync around disabled edits, vault KDF reuse, lock and logout flows, legacy sync migration, and remote apply conflicts.

### Tests
- Expanded regression coverage for Azure OpenAI, AWS Bedrock, encrypted profile sync, sync recovery and consent flows, local context-window detection, Hebrew localization, and refreshed logo assets.

## [22.1.2] - 2026-07-10

### Added
- Added search to the providers list.
- Added local user memory for Chrome and Firefox, including `/remember`, `/show-memory`, `/forget-memory`, Settings/Profile management, bounded prompt injection, JSON export/import, and opt-in post-turn auto-learning.

## [21.7.0] - 2026-07-08

### Changed
- remove claude subscription, add huggingface inferencing

## [21.6.0] - 2026-07-08

### Changed
- added history

## [21.5.0] - 2026-07-05

### Changed
- planner ux improved

## [21.4.0] - 2026-07-05

### Changed
- Gate form submissions behind fresh confirmation

## [21.3.0] - 2026-07-05

### Changed
- Add sidepanel slash output retry UX

## [21.2.0] - 2026-07-05

### Changed
- Add in-chat store review prompt (Chrome + Firefox)

## [21.1.0] - 2026-07-05

### Changed
- Suppress duplicate assistant prose during tool calls

## [21.0.0] - 2026-07-05

### Added
- Added Dev Mode.

## [20.7.0] - 2026-07-05

### Changed
- clear convo warning message added

## [20.6.0] - 2026-07-05

### Changed
- Guarded scheduled resumes with the progress ledger so resumed runs can preserve and surface task progress before continuing.

## [20.5.5] - 2026-07-04

### Changed
- UX refinements: shortened the Chrome and Firefox Act-mode warning banner across all app locales to focus on the risk notice.
- Removed the verbose tool-log button from the Chrome and Firefox sidepanel header to reduce clutter; verbose mode remains available from Settings and the `/verbose` slash command.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.5.5.

## [20.5.2] - 2026-07-04

### Changed
- Reduced the Chrome and Firefox sidepanel composer plus and microphone button hit areas from 32px to 28px while keeping the icon size and send button unchanged.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.5.2.

### Fixed
- Completed missing Chrome and Firefox UI locale strings for attachments, microphone controls, queued composer messages, progress-ledger output, recording copy, and voice-input settings.
- Completed localized website share and footer social labels for Mastodon and Bluesky across the generated locale pages.
- Synced localized busy-run slash-command notices so every app locale lists `/check-progress` as an immediate command alongside the other allowed commands.

### Tests
- Updated Chrome and Firefox regression coverage for the busy-run slash-command notice and verified the full test suite plus prompt-injection corpus.

## [20.5.0] - 2026-07-04

### Added
- Added `/check-progress` in Chrome and Firefox so users can show the current tab's progress ledger from the slash-command menu, including session details, row counts, and the ledger rows.

### Changed
- Raised JSON, TXT, and CSV text attachment uploads from 512 KB to 5 MB in Chrome and Firefox while keeping injected file text bounded to the active provider's remaining context.
- Budgeted text attachments against the pruned prompt and reserved overhead, splitting available context across multiple attachments and marking truncated files as partial content when only the beginning can fit.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.5.0.

### Tests
- Updated Chrome and Firefox regression coverage for 5 MB text-attachment caps, provider-context truncation, late text uploads in long chats, and partial-content notices that omit over-budget tail text.

## [20.4.1] - 2026-07-04

### Changed
- Moved the sidepanel pills to the middle of the sidepanel.

## [20.4.0] - 2026-07-03

### Changed
- mastodon hardening, and  broader agent hardening around progress-ledger safety and malformed tool-call arguments

## [20.3.0] - 2026-07-03

### Changed
- new feature: accept text attachments in the sidepanel

## [20.2.0] - 2026-07-03

### Added
- Added `/dangerously-skip-permissions` in Chrome and Firefox so users can disable permission prompts directly from the side panel without opening Settings.
- Kept `/dangerously-skip-permissions` available during active runs and have it resolve any pending permission prompt for the initiating tab with a one-time allow so the blocked run can continue immediately.
- Added the Star History embed to the website so visitors can inspect WebBrain repository star growth from the homepage.

### Changed
- Updated slash-command help, autocomplete, busy-run notices, and localized warning copy for the new permission-skipping command.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.2.0.

### Tests
- Added Chrome and Firefox regression coverage for the new slash command, out-of-band busy-run availability, storage-backed permission gate disabling, active permission prompt resolution, localized busy notices, and website Star History rendering.

## [20.1.0] - 2026-07-03

### Changed
- Raised the built-in WebBrain Compass provider context window to 1,000,000 tokens in Chrome and Firefox, while migrating stored legacy 256k configs forward without dropping saved API keys.
- Scaled the agent's soft context character and message budgets from the active provider token budget, so 1M-context providers no longer compact at the legacy 80k-character or 50-message limits.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.1.0.

### Tests
- Added Chrome and Firefox regression coverage for the WebBrain Compass 1M default, legacy context-window migration, adaptive character/message context budgets, and large-window conversations avoiding premature compaction.

## [20.0.0] - 2026-07-03

### Added
- Added Chrome-only `/record-full-screen` as a slash-only screen/window recording flow that uses the offscreen recorder's `getDisplayMedia()` picker and records without the live WebBrain recording banner.
- Added double-Escape recording stop handling on Chrome WebBrain/browser surfaces, with hidden recordings covered by a background-owned 2-hour safety cap.
- Added `--transcribe` for `/record` and `/record-full-screen` so user-driven recordings can still save a Whisper transcript after stop.

### Changed
- Removed model-callable `record_tab` and `stop_recording`; recording is now user-driven through `/record`, `/record-full-screen`, optional `--transcribe`, browser stop controls, or double Escape.
- Reserved retired recording tool names in Chrome and Firefox so custom skills cannot reintroduce them, and updated agent prompts to point users to slash commands instead of tools.
- Changed Plan before Act to default unset storage to `try` while preserving explicit `off`.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 20.0.0.

### Fixed
- Kept Firefox from advertising `/record-full-screen` while returning a clear unsupported message if the command is typed manually.

### Tests
- Added Chrome and Firefox regression coverage for recording tool removal, retired-name/custom-skill blocking, slash parser ordering, Chrome-only full-screen recording, hidden full-screen recording UI, double-Escape stop routing, and Plan-before-Act default `try`.

## [19.3.0] - 2026-07-02

### Added
- Added Chrome and Firefox side-panel microphone dictation controls with per-browser permission handling, interim transcript cleanup, and clear disabled states when speech recognition is unavailable or turned off.
- Added Chrome and Firefox side-panel file attachments for images, PDFs, JSON, and text files, including attachment preview chips, remove controls, tab-scoped pending attachments, and send-button gating while file reads are still in flight.

### Fixed
- Fixed attachment rejection handling so unsupported attachments are restored to the correct tab without scraping assistant text, while uploaded user attachments carry an explicit untrusted-content boundary before being sent to the model.
- Fixed Chrome microphone denial handling so the mic icon returns to its idle state and permission-denied state does not spam repeated system messages.
- Fixed Anthropic Claude Opus 4.8 requests by omitting unsupported non-default `temperature` parameters while keeping temperature for Claude Sonnet 4.6.

### Tests
- Added Chrome and Firefox regression coverage for tab-scoped attachment state, pending-read send gating, rejected-attachment restoration, text-attachment size limits, uploaded image/document boundaries, microphone icon reset, and Anthropic Opus 4.8 temperature handling.

## [19.2.0] - 2026-07-02

### Added
- Added a Chrome and Firefox side-panel message queue so normal composer messages sent while WebBrain is busy are kept per tab, shown above the composer, and can be edited or deleted before they run.

### Changed
- Kept `/help`, `/show-scratchpad`, `/list-schedules`, `/screenshot`, `/export`, and `/verbose` available as immediate slash commands during active runs while other slash commands show the queued-message busy notice.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 19.2.0.

### Fixed
- Fixed queued-message editing so pressing ArrowUp in an empty composer pulls the latest queued message back into the composer before it runs.

### Tests
- Added Chrome and Firefox regression coverage for busy-run message queueing, queued-message edit/delete controls, per-tab queue draining, safe busy slash commands, and localized busy notices.

## [19.1.0] - 2026-07-02

### Added
- Added Ollama launch handoff integration for Chrome and Firefox so `webbrain.one/launch/ollama` links can configure the local Ollama provider, activate it, and carry over the selected model, loopback `/v1` base URL, and context window.

### Changed
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 19.1.0.

### Tests
- Added Chrome and Firefox regression coverage for Ollama launch handoff validation, loopback URL restrictions, provider activation, and launch-page content-script behavior.

## [19.0.11] - 2026-07-02

### Changed
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 19.0.11.

### Fixed
- Fixed Settings -> Providers -> Load Models for local providers so loaded models appear in a centered picker dialog without replacing an existing model value until the user chooses one.
- Replaced raw HTML 404 model-list errors with the concise local-server status when a local model server is not running.
- Guarded repeated model-load completions so an already-open loaded-model dialog is not reopened.

### Tests
- Added Chrome and Firefox regression coverage for loaded-model dialog rendering, localized dialog copy, stale option clearing, concise HTML 404 handling, centered dialog styling, and repeated dialog-open handling.

## [19.0.0] - 2026-07-01

### Added
- Added the new Skills infrastructure for Chrome and Firefox: Settings -> Skills can import trusted skill text or HTTPS skill URLs, store enabled skills in browser local storage, append enabled skill instructions to the agent system prompt, and show/remove declared skill tools.
- Added `webbrain-tools` manifest support so enabled skills can declare runtime tools without hard-coding them into the static tool table. Skills can expose read-only HTTPS GET/POST tools and Act-only `httpDownloadJob` tools with create, poll, file, and cleanup endpoints.
- Added a bundled FreeSkillz.xyz skill, enabled by default and removable from Settings -> Skills, with `read_youtube_transcript`, `resolve_public_media`, and `download_public_media` for public YouTube transcripts and public social/media URLs.
- Added skill-aware tool hydration before provider setup and scheduled runs so imported and packaged skill tools are available consistently in normal and resumed agent sessions.

### Changed
- Updated README, adding-a-tool, architecture, privacy/data-flow, prompt-injection, security-model, and browser architecture docs for custom skills, skill tool trust boundaries, bundled FreeSkillz behavior, and the removal of the stale root extension manifest.
- Updated release metadata, Settings subtitle versions, Chrome / Firefox manifests, package versions, and browser architecture docs for 19.0.0.
- Kept skill HTTP requests cookie-free with `credentials: "omit"`, nested provider payloads under untrusted result data, and documented that importing or keeping a skill enabled is the trust decision for its declared HTTPS endpoint.

### Fixed
- Hardened skill imports and skill tool calls against unsafe endpoints, oversized imports, opaque or cross-origin redirects, blocked local/internal destinations, and provider fields such as `done`, `_attachImage`, or `_attachDocument` escaping into internal tool-result control fields.
- Hardened download-job skill tools so they are Act-only by default, stay behind the normal Downloads permission gate, handle pending browser downloads without prematurely deleting provider jobs, clean up provider jobs on early failures, validate file/final URLs, reject file redirects and non-2xx file responses, and support GET-only file endpoints without requiring HEAD.
- Reworked skill media saving to avoid cookie-bearing browser downloads against provider domains by fetching files with omitted credentials, validating the response URL before saving, and capping cookie-free data-URL saves at 25 MiB so large media fails cleanly instead of buffering unbounded data in the service worker.
- Required explicit URLs for read-only public media resolution so broad social-media allowlists do not silently send the active tab URL to FreeSkillz from Ask mode.

### Tests
- Added Chrome and Firefox regression coverage for skill import/storage limits, packaged-skill seeding and refresh, Settings -> Skills UI behavior, scheduled-run skill hydration, runtime skill tool schemas, Ask/Act/Compact mode filtering, untrusted skill result wrapping, endpoint and redirect validation, and skill response trimming.
- Added FreeSkillz transcript/media coverage for supported URL allowlists, public media resolve requirements, download-job lifecycle, pending cleanup, unsafe final URLs, blocked redirects, failed file requests, GET-only file endpoints, cookie-free file fetches, and oversized media rejection.

## [18.3.0] - 2026-06-29

### Changed
- Deleted the stale root `manifest.json` and updated Chrome setup docs, version bumping, and release workflows to use `src/chrome/manifest.json` and `src/firefox/manifest.json` as the only extension manifests.

## [18.2.0] - 2026-06-28

### Changed
- edge store preparations

## [18.1.0] - 2026-06-28

### Changed
- Added: Tune context compaction thresholds

## [18.0.4] - 2026-06-27

### Fixed
- Prevented stale repeated `fetch_url` loop entries from hard-stopping the agent after it switches to a different tool, such as falling back from failed API calls to `click_ax`.
- Collapsed repeated failed mutating API calls in one assistant batch into a single failed API strategy for loop detection, while keeping `/allow-api` as the required opt-in for API mutations.
- Reasserted the active viewport glow after tab reloads during a running task so the visual run indicator comes back when the content script reloads.

### Tests
- Added Chrome and Firefox regression coverage for stale URL-tool loop pivots, failed API mutation batches, and active viewport glow reassertion after reload.

## [18.0.3] - 2026-06-27

### Changed
- Replaced the Plan before Act checkbox with Planner modes: Try planning by default, Strict planning for fail-closed approval, and Off.
- Made Try planning continue into Act mode without a pinned plan when the planner cannot produce valid structured JSON, so the default planner path no longer cancels the task on planner-format failure.
- Preserved legacy planner storage by mapping unset storage to Try planning, legacy `false` to Off, and legacy `true` to Strict planning.

### Tests
- Added Chrome and Firefox regression coverage for planner mode defaults, legacy migration behavior, try-mode fallback, and strict-mode fail-closed cancellation.

## [18.0.2] - 2026-06-27

### Added
- Added bulk API mutation pattern detection for Chrome and Firefox so repeated successful same-action clicks, such as following many GitHub stargazers, can surface matching background API request shapes before the agent spends one LLM turn per button.

### Changed
- Kept mutating `fetch_url` calls behind the `/allow-api` slash command, including a hard fail-closed path for POST, PUT, PATCH, and DELETE when API mutations have not been explicitly enabled for the conversation.

### Tests
- Added Chrome and Firefox regression coverage for bulk API mutation hints, `/allow-api` hint state, and blocking mutating `fetch_url` calls until `/allow-api` is enabled.

## [18.0.0] - 2026-06-27

### Added
- Added `go_back` and `go_forward` tools for Chrome and Firefox so Act mode can use browser history directly instead of relying on CSP-sensitive page JavaScript.
- Added Plan before Act as a default-on planning gate, including structured planner parsing, a side-panel plan review card, approved-plan scratchpad pinning, scheduled-run auto-approval, and planner trace/provider metadata.
- Added a background API request observer for Chrome and Firefox that detects repeated click-triggered XHR/fetch requests and suggests the matching `fetch_url` method when the UI loop is stuck.

### Changed
- Kept API shortcut detection method-aware for GET, POST, PUT, PATCH, DELETE, and other observed methods while leaving mutating replay decisions to the existing `/allow-api` and UI-vs-API policy.
- Updated README, architecture, adding-a-tool, privacy, prompt-injection, and security docs alongside release metadata, Settings subtitle versions, Chrome / Firefox manifests, and package versions for 18.0.0.

### Fixed
- Fixed Chrome history URL normalization so query-string and hash-only history transitions are treated as real back/forward navigation changes, matching Firefox.
- Prevented API shortcut detection from counting one captured request across multiple overlapping click windows.
- Removed unused planner helper/style code left behind during review cleanup.

### Tests
- Added regression coverage for history navigation tool exposure, permission mapping, URL normalization parity, planner parsing/review/scratchpad/scheduling/trace behavior, API shortcut matching, request-reuse prevention, and prompt-injection corpus parity.

## [17.8.0] - 2026-06-27

### Added
- Added completion confetti for successful Chrome and Firefox tasks, with a Settings toggle and localized labels so users can turn off the celebratory finish.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.8.0.

### Fixed
- Fixed side-panel tab race issues by queueing tab-switch updates during restore and preventing stale flushes from writing to the wrong tab conversation.
- Scoped accepted completion and success-confetti updates to the active tab so finished tasks do not trigger stale success UI in another tab.

### Tests
- Added regression coverage for completion confetti settings and rendering, accepted completion gating, and tab-switch restore / flush races.

## [17.7.0] - 2026-06-26

### Added
- Added `/clear-scratchpad` in the Chrome and Firefox side panels so users can clear the current conversation scratchpad from slash-command autocomplete and help.
- Added Cloudflare Workers AI to the provider list with the OpenAI-compatible Workers AI endpoint, default model `@cf/zai-org/glm-5.2`, and a 262k-token context window.

### Changed
- Translated the `/clear-scratchpad` label, help text, and cleared-state message across all supported locales.
- Classified OpenRouter, Cloudflare Workers AI, Nvidia NIM, and Groq under the Router provider bucket in Chrome and Firefox settings.
- Added a dedicated Cloudflare account ID field and URL validation so the Workers AI provider substitutes the account into the API base URL before testing or chatting.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.7.0.

### Fixed
- Migrated saved OpenRouter, Cloudflare Workers AI, Nvidia NIM, and Groq provider categories to Router so upgraded installs do not keep older Cloud filter state.

### Tests
- Added regression coverage for the synchronous scratchpad clear path, locale coverage for `/clear-scratchpad`, Cloudflare defaults, context-window inference, and the Router provider bucket.

## [17.6.0] - 2026-06-26

### Added
- Added a copy button to `/show-scratchpad` output in the Chrome and Firefox side panels so users can copy just the scratchpad contents.
- Added WebBrain blog coverage and benchmark result files for raw LFM 2.5 230M and 350M on the frozen 100-case browser-agent planner harness.

### Changed
- Updated the tiny LFM benchmark conclusion and refreshed release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.6.0.

## [17.5.0] - 2026-06-26

### Added
- Added async out-of-band slash-command handling in the Chrome and Firefox side panels, allowing `/help`, `/show-scratchpad`, `/list-schedules`, `/screenshot`, `/export`, and `/verbose` to run while WebBrain is busy.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.5.0.

### Fixed
- Preserved drafts and autocomplete/send-button state when users try slash commands during active runs, with a localized busy notice for commands that need to wait.

## [17.4.0] - 2026-06-25

### Added
- Added `/edit-scratchpad <text>` in the Chrome and Firefox side panels so users can append notes to the current conversation scratchpad from slash-command autocomplete and help.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.4.0.

## [17.3.0] - 2026-06-24

### Fixed
- Replaced the Firefox extension toolbar/sidebar icon PNGs with the Chrome brain artwork and refreshed the packaged Firefox archive so Firefox no longer shows the old purple round icon.

## [17.2.0] - 2026-06-24

### Added
- Added XML-style raw tool-call parsing for Chrome and Firefox so local/chat-template models that emit `<tool_call><function=...><parameter=...>` output can execute tools instead of returning raw markup.
- Added a WebBrain Compass billing panel in Chrome and Firefox settings with device-bound Stripe account links, localized account copy, and expanded WebBrain Compass provider notes for subscription, billing, and privacy links.
- Added Polish UI locale support for the Chrome and Firefox settings/payment flows.

### Changed
- Updated WebBrain Compass `/subscribe` URLs and 402 allowance messages to include the device GUID as Stripe `client_reference_id`, and made the subscribe page require a device-bound link before redirecting to checkout.
- Reworded the subscribe fallback page to tell users with outdated extension links to update the browser plugin.
- Documented the newer slash commands in the English, French, and Chinese README files.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.2.0.

### Fixed
- Purged legacy `auth.webbrain.one` token, email, and default-model storage during settings startup now that WebBrain Compass billing is device-GUID based.
- Firefox side-panel message bubbles now expose copy buttons on user messages, with styling that remains legible on accent-colored bubbles.
- Suppressed streamed raw tool-call text before rendered tool steps, so fallback tool calls do not linger as assistant text.

### Tests
- Added regression coverage for XML-style tool-call parsing/execution and raw tool-call stream suppression in Chrome and Firefox.

## [17.1.0] - 2026-06-24

### Added
- Introduced a better payment UI for WebBrain Compass: the quota-exceeded error now surfaces a Subscribe button that links users directly to upgrade their plan, with the button persisting and rebinding across chat restores.

### Changed
- Translated the Subscribe button strings into all supported locales.

## [17.0.0] - 2026-06-23

### Changed
- Updated provider placeholder models in Chrome and Firefox settings to reflect newer model options.
- Marked conversation export as completed in the README roadmap and noted that conversation import is not planned.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 17.0.0.

### Removed
- Removed Chrome `execute_js` tool dispatch support so Chrome only exposes and dispatches the advertised tool set.

### Fixed
- Hardened Chrome and Firefox side-panel tab state so async slash commands, suggested actions, scheduled actions, restored controls, tab-chat saves, and pending tab switches stay scoped to the initiating tab instead of updating stale panels.
- Made settings and side-panel provider activation/status updates handle async failures, stale checks, invalid stored provider IDs, unsupported stored providers, and persisted preference changes more reliably.
- Improved context-menu prompt persistence and retry handling so prompts survive storage races, pending tab switches, failed tab switches, abort timeouts, and concurrent deferred writes without replaying stale content.
- Stabilized trace rendering, trace export downloads, side-panel export downloads, Chrome offscreen proxy recovery, and Chrome tab-chat persistence after clears.
- Scoped allow-api state to tab conversations and cleared Firefox transient tab state on reset.

### Security
- Escaped dynamic system messages and trace-viewer attribute data, rendered verbose tool names as text, avoided selector interpolation in settings tabs, rejected unknown provider updates, and validated stored provider IDs before use.

### Tests
- Added regression coverage for side-panel tab scoping, settings/provider async status handling, context-menu prompt queuing and retries, scheduled action tab isolation, export/download stability, provider validation, trace rendering, and Chrome advertised-tool dispatch.

## [16.0.0] - 2026-06-23

### Added
- Added Chrome and Firefox context-menu integration: right-click selected page text and choose "Ask WebBrain about this" to open the WebBrain panel and submit the selection as untrusted page content.

### Changed
- Marked keyboard shortcuts and context menu integration as completed in the README roadmap.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 16.0.0.

### Fixed
- Context-menu prompts now survive service-worker and panel timing races until the chat request is accepted, then clear only after the background receives the request so prompts are neither lost before submission nor replayed after panel reopen.
- Context-menu prompts are now queued while a run is processing or when they target another tab, drain after Continue finishes or the matching tab becomes active, and are discarded on navigation or tab close so stale selections are not submitted against the wrong page.

### Tests
- Added Chrome + Firefox side-panel regression coverage to ensure queued context-menu prompts drain after Continue clears the processing state.

## [15.6.0] - 2026-06-23

### Changed
- Filled 22 missing UI locale keys across all 13 supported non-English locales in both Chrome and Firefox.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.6.0.

### Fixed
- Agent-created scheduled current-tab tasks on HTTP(S) pages now persist as URL targets, so scheduled runs can navigate back to the original page instead of failing after the tab changes.
- Legacy agent-created current-tab scheduled tasks now migrate to URL targets during alarm restoration while preserving their scheduled alarms.

### Tests
- Added Chrome + Firefox scheduler coverage for agent-created current-tab URL target normalization, legacy scheduled-task migration on restore, and navigated scheduled task completion.

## [15.5.0] - 2026-06-23

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.5.0.

## [15.4.0] - 2026-06-23

### Added
- Chrome now registers `Alt+Shift+W` as the default extension keyboard shortcut for opening the WebBrain panel.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.4.0.

## [15.3.0] - 2026-06-23

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.3.0.
- Scheduled-job busy retries now stagger same-target queued runs so simultaneous alarms do not keep retrying at the same instant.

### Fixed
- Scheduled resume and task creation now dedupes near-identical live jobs within a two-minute window, returning the existing job instead of creating duplicate alarms.
- Startup alarm restoration now coalesces stored near-duplicate scheduled jobs by keeping the earliest matching live job and cancelling later duplicates.

### Tests
- Added Chrome + Firefox scheduler coverage for duplicate resume/task creation, duplicate-window boundaries, staggered busy retries, and restore-time duplicate coalescing.

## [15.2.2] - 2026-06-23

### Fixed
- Scheduled recurring tasks can now start immediately when their first run is due now.

## [15.2.1] - 2026-06-23

### Changed
- Max Agent Steps settings copy now explains that the `∞` slider position means unlimited steps in every supported Chrome and Firefox locale.
- `/schedule` now accepts `0` minutes for standalone scheduled tasks, treating it as "start now" while keeping nonzero future delays at the existing one-minute minimum.

### Fixed
- Max Agent Steps now treats the Settings slider maximum (`200`) as the unlimited sentinel instead of a finite cap, migrates stale stored `200+` values to `maxAgentSteps: 0`, and keeps the continue bar from displaying unlimited (`0`) as the default step count.

### Tests
- Added regression coverage to ensure `0`, `200`, and values above `200` remain unlimited in both browser builds, and that all max-step locale descriptions mention the `∞` setting.
- Added scheduler coverage for zero-delay tasks and the `/schedule` composer accepting an immediate relative delay.

## [15.2.0] - 2026-06-22

### Added
- Jan, vLLM, and SGLang as built-in local providers (Chrome + Firefox). All three use OpenAI-compatible `/v1` endpoints (Jan on port 1337, vLLM on port 8000, SGLang on port 30000), support model listing via `/v1/models`, accept an optional API key for auth-enabled servers, and default to enabled with vision on and a 16 K context window.

### Changed
- Onboarding local-model detection copy now lists Jan, vLLM, and SGLang alongside LM Studio, Ollama, and llama.cpp.
- LLM request-timeout settings description and provider info panel updated to cover all six local backends.
- Updated documentation (README, architecture docs, providers guide) to reflect the expanded local-provider lineup.

### Tests
- Added coverage for `categoryFor` and `listProviderModels` with Jan, vLLM, and SGLang — including auth header forwarding and model-list deduplication — and for `_defaultConfigs` asserting all three new providers are present, enabled, local-categorized, and localhost-defaulted.

## [15.1.1] - 2026-06-22

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.1.1.

## [15.1.0] - 2026-06-22

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.1.0.
- Updated README and architecture docs to describe WebBrain Compass 1.0 as the default managed cloud option and document the scheduled-task system.
- Refreshed release artwork and regenerated packaged Chrome / Firefox submission archives.

### Fixed
- Firefox indexed click and typing actions now resolve against the same full interactive-element ordering shown to the agent, keeping click-by-index and type-by-index stable.
- Firefox indexed actions now handle shadow DOM controls, blocking modal/native dialogs, non-modal dialogs, inert or hidden background controls, stale editable focus, and disabled text inputs more reliably.
- Chrome and Firefox side panels now surface a clear error when the background script returns no response, and avoid dereferencing missing response content while rendering assistant messages.

### Tests
- Added regression coverage for Firefox shadow-DOM indexed clicks and typing, modal and non-modal dialog indexing, disabled/stale editable fallbacks, and missing side-panel background responses.

## [15.0.0] - 2026-06-22

### Added
- Added a Chrome `/record` slash command that starts current-tab recording directly from the side panel with video and microphone capture, plus matching Chrome autocomplete and `/help` text.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 15.0.0.

### Fixed
- Tightened `/record` slash parsing so longer words beginning with `/record` are not treated as recording commands, surfaced recording startup and microphone-capture failures in the Chrome side panel, and made manually typed `/record` in Firefox report that tab recording is unsupported without advertising it in Firefox slash autocomplete or help.

## [14.2.2] - 2026-06-22

### Changed
- Lowered the `schedule_resume` minimum delay from 60 seconds to 30 seconds in Chrome and Firefox, matching the packaged Chrome alarms floor while keeping standalone scheduled tasks at the existing 60-second minimum, and expanded the maximum scheduling window from 1 day to 7 days.
- Completed scheduled-job cards in the side panel now disappear after 15 seconds unless the user clicks the card to keep it visible.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 14.2.2.

### Tests
- Updated scheduler and side-panel coverage for the shorter 30-second `schedule_resume` delay, seven-day maximum scheduling window, and completed-card auto-hide behavior.

## [14.2.0] - 2026-06-21

### Added
- Slash command autocomplete in the Chrome and Firefox side panels, with keyboard navigation, Tab / Enter completion, Escape dismissal, mouse selection, and accessible listbox metadata for all supported slash commands.

### Changed
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and package versions for 14.2.0.
- Completed missing translations for all 13 supported languages (Arabic, Spanish, French, Indonesian, Japanese, Korean, Malay, Russian, Thai, Tagalog, Turkish, Ukrainian, Chinese Simplified) across Chrome and Firefox locale files, covering scheduled-task UI strings, scratchpad panel, schedule form, permission verb, tool labels, and settings toggles added in 14.1.0.

### Tests
- Added static Chrome + Firefox coverage to keep the slash command parser and autocomplete command list in sync.



## [14.1.0] - 2026-06-21

### Added
- Scheduled agent work for Chrome and Firefox: `schedule_resume` durably pauses a blocked run and resumes it later in the same tab / conversation, while `schedule_task` creates one-shot or recurring future tasks backed by browser alarms and persisted job state.
- Side panel schedule controls, including `/schedule`, `/list-schedules`, `/show-scratchpad`, an active scheduled-job strip, and Run now / Pause / Resume / Cancel / Delete actions for scheduled jobs.
- Settings toggles for enabling scheduled tasks and requiring confirmation before unattended scheduled runs perform consequential actions.

### Security
- Added a `schedule` permission-gate capability so scheduled future work is treated as a consequential action, with unattended scheduled runs defaulting to confirmation before clicks, typing, navigation, downloads, uploads, recording, or other gated actions.

### Changed
- Full and mid Act-mode prompts now describe the scheduling tools and when they may be used; compact Act mode still forbids scheduling and tells the agent to ask the user to re-invoke WebBrain for external waits.
- Updated release metadata, Settings subtitle versions, architecture docs, Chrome / Firefox manifests, and required `alarms` permissions for 14.1.0.

### Fixed
- Anchor clicks now correctly classify same-page anchors, anchors resolved through `<base href>`, and popup-style placeholder / hash anchors, preventing successful in-page jumps or popup triggers from being reported as failed or stale clicks.

### Tests
- Added Chrome + Firefox coverage for scheduler validation, busy-tab queuing, stale resume / task targets, recurring next-run calculation, scheduled clarifications, tool exposure by prompt tier, schedule slash commands, scratchpad reads, and schedule capability gating.

## [14.0.5] - 2026-06-20

### Changed
- Updated Anthropic defaults and context-window inference for `claude-opus-4-8`.
- Updated release metadata, Settings subtitle versions, architecture docs, and Chrome / Firefox submission archives for 14.0.5.

### Fixed
- Provider Settings numeric fields now preserve valid zero cost estimates while continuing to reject invalid or negative numeric values.

## [14.0.4] - 2026-06-19

### Added
- Suggested actions in the side panel can now be minimized and restored in both Chrome and Firefox. The collapsed preference is saved, so users can reclaim chat space once and keep it that way across panel reloads.

### Changed
- Tightened the Suggested actions panel spacing, chevron control, and action chips to reduce vertical space used above the chat input.
- Updated release metadata, Settings subtitle versions, architecture docs, and Chrome / Firefox manifests for 14.0.4.

## [14.0.0] - 2026-06-18

### Changed
- WebBrain Compass is now the default provider for new WebBrain configurations.
- Updated release metadata, Settings subtitle versions, architecture docs, and Chrome / Firefox manifests for 14.0.0.

### Fixed
- Context compaction now treats screenshots as a bounded vision-token cost and uses a short post-compaction cooldown, preventing screenshot-heavy Chrome and Firefox runs from compacting again on every step.
- Text clicks now ignore hidden ARIA option / menu / tree items and no longer treat editable input values as click labels, preventing collapsed or virtualized options and filter boxes from being selected as false matches.
- Firefox scroll-retry text clicks now reuse the same visibility and editable-value filtering as the primary matcher.

## [13.1.0] - 2026-06-17

### Changed
- Website header GitHub controls now use the star pill as the single repository link, removing the duplicate GitHub CTA across localized website pages.
- Updated release metadata, Settings subtitle versions, architecture docs, and Chrome / Firefox submission archives for 13.1.0.

## [13.0.1] - 2026-06-12

### Fixed
- Screenshot capture now mechanically detects near-blank frames and retries after 500ms, 1000ms, and 1500ms before handing the image to a vision model (Chrome + Firefox). This helps recover from compositor / lazy-load races on media-heavy pages such as Instagram, where the DOM already contains content but the first viewport capture can be all white or all black.

### Changed
- Screenshot probes now include image counts, and screenshot results/traces include `blankFrameRetry` metadata when a blank-frame retry path ran.

### Tests
- Added Chrome + Firefox unit coverage for blank-frame retry gating, successful recovery, and the no-content/no-retry case.

## [13.0.0] - 2026-06-10

### Added
- Downloads now auto-pin to the scratchpad (Chrome + Firefox): every `download_files`, `download_resource_from_page`, `stop_recording` (Chrome), and `download_social_media` success appends a durable `[auto] Downloaded … (downloadId N)` line to the pinned scratchpad, so the file's handle survives context compaction even when the model never calls `scratchpad_write` itself. This closes a failure mode where, on long runs, the saved path fell out of the verbatim context window after older tool results were summarized away and the model invented a wrong upload path (e.g. `/Users/Shared/…`). Pinning is centralized in the tool-execution loop so all download-producing tools are covered uniformly; `download_social_media`, which exposes no per-file id, degrades to a `list_downloads` pointer rather than an invented id.
- `download_files` now resolves and returns each file's local path and completion state in its own result (previously only `list_downloads` carried the path), so the handle is available the moment the download finishes.
- `upload_file` now accepts a `downloadId` as an alternative to `filePath` (Chrome): it resolves the real on-disk path internally, so the model can attach a previously downloaded file by its small integer id without recalling the path. `read_downloaded_file` already accepted a `downloadId`.
- Test coverage (in `test/run.js`) for auto-pin survival across a real context compaction, id-only pinning across the download tools, the `download_social_media` → `list_downloads` fallback, and the `download_files` summary-digest behavior.

### Security
- The auto-pin note is id-only by design: it records the `downloadId` (not attacker-controllable) and no page-derived filename at all, keeping the Content-Disposition-settable basename out of the durable, attended-to scratchpad. This is a prompt-injection boundary — a hostile filename such as `ignore previous instructions and …` must never be persisted as trusted text that outlives the untrusted-content wrapper; the human filename remains recoverable via `list_downloads`. The `download_files` summary digest likewise echoes only the integer `downloadId`s and never the filename, so a malicious `Content-Disposition` header cannot smuggle page text into the trusted trim summary.

### Changed
- Act-mode scratchpad guidance updated: download paths are pinned automatically and files are attached/read by `downloadId`, so the model no longer hand-pins paths or re-downloads to "get the path back".

## [12.0.0] - 2026-06-01

### Added
- "Use your subscription" OAuth (PKCE) sign-in for subscription-backed providers (Chrome + Firefox): OpenAI (ChatGPT) and Google Gemini. OpenAI borrows the Codex CLI's first-party `client_id` (same pattern as the existing Claude flow); Gemini stays honest, requiring the user to register and enter their own Google Cloud OAuth `client_id`. Clients send no headers that impersonate a vendor's first-party CLI, and the settings UI surfaces a disclaimer on every borrowed-client card noting it may be revoked by the vendor at any time.
- Context-aware recommended actions: the agent surfaces actionable recommendations tailored to the current page and runs them directly in Act mode.

### Changed
- Recording recommendation is now hidden on Firefox where it does not apply.

### Fixed
- Social media downloads now focus on the active media: extensionless media URLs get correct video filenames, visible-crop filename extensions are fixed, a visible-media crop fallback was added, main-mode videos are ordered before posters, and focused HTTP / blob video downloads are preferred and preserved.
- Recorder Stop reliably ends stuck or orphaned recordings, with cleared / already-stopped stop results handled and forced-clear stop failures surfaced in the side panel.
- Fixed 6 bugs across the Chrome and Firefox builds.

## [11.0.0] - 2026-05-31

### Added
- Cloud cost allowance controls: per-session spending limits for metered cloud providers. Set a maximum dollar allowance in Settings; spend is estimated from provider-reported token usage (falling back to token counts when usage metadata is absent) multiplied by per-model pricing. Anthropic and Gemini stream usage metadata is now forwarded for accurate accounting, reported zero-cost usage is honored, and local / IPv6 / "cloud-card" local endpoints are treated as unmetered.
- Token-aware automatic context compaction (Chrome + Firefox): the agent now summarizes older turns once the running input-token count crosses ~75% of the active model's context window — not just the legacy 50-message / 80k-char heuristics — and re-checks on every agent-loop iteration so long autonomous runs compact mid-flight. When it compacts, the side panel shows an inline "Context automatically compacted" separator. Providers expose an approximate `contextWindow` (category-aware default: 16k for local backends, 128k for cloud/router; overridable via `config.contextWindow`). Compaction preserves the pinned original user task and never splits an assistant/tool-call pair across the summary boundary; Firefox now digests tool results into the summary at parity with Chrome. Onboarding, README, and the website now recommend a ≥16k context window for local models (8k works with Compact mode).
- `click` progress snapshots now report the affected form control's state (checked / disabled / selected index / `aria-*`) alongside its label and position, so the model and recorded traces can verify the effect of an interaction.
- Test coverage (in `test/run.js`) for trace-driven agent interaction and for untrusted wrapping of `click` / `type_text` results.

### Security
- `click` and `type_text` tool results are now wrapped as untrusted content, so page-derived text returned by an interaction cannot be interpreted as model instructions.

### Changed
- Cloud cost totals are serialized to avoid update races, and stream-usage options are gated by provider support.

### Fixed
- Fixed trace-driven agent interaction issues in the session recorder/replay path (agent loop, tool dispatch, and recorder host).
- Next-prompt size is now projected from reported tokens plus observed conversation growth rather than the model maximum, improving compaction timing.

## [10.0.0] - 2026-05-30

### Added
- Deterministic capability-by-origin permission gate for consequential agent actions, with per-host Allow once / Always / Deny grants.
- Site Permissions settings tab for reviewing and revoking saved capability grants.
- Localized structured permission card across Chrome and Firefox, replacing the previous free-text permission parser.
- Act-mode risk banner that appears when the permission gate is disabled.
- Localized onboarding safety warnings and local-LLM setup flow, including auto-detection for local providers.
- Apple Store site adapter.
- Firefox support for compact Act prompts, including compact tool schema routing and provider opt-in.

### Security
- Wrapped page-derived tool results and model-visible context as untrusted data across page reads, screenshots/OCR, hover/list-download results, PDF passthrough, download-family results, `done` verification fields, and scratchpad-adjacent context.
- Added prompt-injection defense documentation and tests covering the permission gate, untrusted-content registry, and capability classification exhaustiveness.
- Gated outbound GET egress, screenshot-to-disk, `read_pdf({url})`, `record_tab`, resource downloads, iframe actions by frame host, and `set_field({submit})` as both type and click.
- Scoped one-time permission grants to the tab/run and made `/allow-api` waive only mutation egress, not GET-based exfiltration.
- Sanitized page title/URL and PDF title metadata before inserting them into trusted context notes.
- Failed closed when iframe or target hosts cannot be identified for permission checks.

### Changed
- Improved nested-pane scroll targeting, with pane fallback when window scrolling cannot move and editable fields skipped as scroll containers.
- Permission card choices now dismiss immediately, and the Settings permissions list live-refreshes after changes.
- Firefox cached system prompts now refresh on conversation reuse so provider compact/full prompt changes stay aligned with the active tool schema.
- Compact-mode tool allowlists are enforced for both text-parsed and structured tool calls in Firefox.
- Documentation now describes Firefox compact-prompt support and current security/privacy behavior accurately.

### Fixed
- Fixed mobile hero mockup overflow and narrow navbar sizing.
- Fixed Firefox download-card wrapping.
- Fixed permission-option click handling so exact options are checked before negation parsing.
- Fixed legacy scroll fallback guard and stale scroll-origin behavior.
- Fixed docs accuracy issues and updated the maintainer security contact.

## [8.8.0] - 2026-05-28

### Added
- Cream/coffee light theme for the marketing website with a sun/moon toggle in the nav (PR #84). Default follows `prefers-color-scheme`; the choice is persisted in `localStorage`.
- Cream/coffee light theme for the extension's side panel and Settings page in both Chrome and Firefox builds (PR #85). Default follows `prefers-color-scheme`; Settings → General → Appearance offers System / Light / Dark.
- New `src/<browser>/src/ui/theme.js` module owning theme state, with `localStorage` mirroring `(chrome|browser).storage.local` so the FOUC bootstrap can read synchronously and other extension pages stay in sync.
- Self-hosted MP4 of the demo video on the marketing site, replacing the previous external embed.

### Changed
- Demo section label and subtitle restored on the marketing site for consistency with the other sections.
- Theme toggle is hidden on narrow nav layouts (≤375px) to keep the header within its side padding; `prefers-color-scheme` still picks the right theme on mobile.

### Fixed
- Settings appearance picker now stays in sync when the theme is changed from another Settings tab or the side panel. The local `currentThemeMode` closure and the `<select>` value are updated from `storage.onChanged`, so a subsequent OS-theme flip no longer overrides an explicit user choice.
- Theme bootstrap moved out of an inline `<script>` and into `theme-bootstrap.js` (a parser-blocking classic script in `<head>`) so it actually runs under MV3's `script-src 'self'` CSP — the inline version was silently blocked and visitors saw a dark flash on first paint.

## [8.7.0] - 2026-05-28

### Added
- Settings tab "Display" renamed to "General" across all 14 locales to reflect its broader scope.
- Settings subtitle no longer says "display preferences" — translated to "preferences" in every locale.

### Documentation
- README provider table expanded from 4 to 14 entries with default models per provider.
- README "What's New" section replaced with a one-line pointer to CHANGELOG.md to prevent the drift that left it stuck at 6.1.0.
- CHANGELOG backfilled with entries for 8.2.1, 8.2.2, 8.3.0, 8.4.0, and 8.5.0.

## [8.6.0] - 2026-05-28

### Added
- Slash commands beyond `/allow-api`: `/help`, `/compact`, `/reset`, `/screenshot`, `/export`, `/profile`, `/vision` (PR #82). Type `/help` in the side panel to see the list.

### Fixed
- System messages now bypass `formatMarkdown` so HTML (e.g. the `<img>` from `/screenshot`, the `<strong>` in `/allow-api` confirmations) renders instead of showing as escaped text.

### Changed
- Ollama default model placeholder is now empty (matching llama.cpp and LM Studio) instead of hardcoding `llama3.1`.

## [8.5.0] - 2026-05-28

### Fixed
- Comprehensive bug audit covering 65+ fixes across Chrome and Firefox builds.
- Preserved run-guard state on conversation clear so an in-flight agent run can still be stopped cleanly.
- Extended PDF read timeout through the response body phase, not just the connection phase.

## [8.4.0] - 2026-05-27

### Changed
- Merged `download_file` into `download_files` so a single tool handles both single-URL and array cases (max 3 concurrent).
- Compact-mode tool allowlist is now scoped to Act mode only; Ask mode keeps the full tool surface even when compact prompts are enabled.

### Fixed
- Suppressed stale-click warnings on editable targets (e.g. contenteditable Medium editors) where the click is intentional.
- `downloadFiles` now passes the user-supplied filename through to the download instead of falling back to the URL slug.
- Compact-mode allowlist is now enforced on text-parsed tool calls too, not only structured tool calls.
- `solve_captcha` is now part of the compact tool set so it stays available in compact mode.

## [8.3.0] - 2026-05-27

### Changed
- Compact mode is now fully opt-in: it never auto-enables based on model size heuristics. Users must check the box per-provider in Settings.

### Documentation
- Clarified in README and settings copy that compact mode is opt-in only and not auto-enabled.

## [8.2.2] - 2026-05-26

### Fixed
- Restricted deasciifier loading to `lang: "tr-deasciify"` so the ~175KB pattern table isn't pulled in for non-Turkish typing.
- Loaded the deasciifier in the content-script isolated world to avoid leaking globals into page scripts.

## [8.2.1] - 2026-05-26

### Fixed
- Patch release for deasciification edge cases discovered shortly after 8.2.0.

## [8.2.0] - 2026-05-26

### Added
- Added Turkish deasciification support via `lang: "tr-deasciify"` parameter on `type_text`, `type_ax`, and `set_field` tools. Converts ASCII Turkish (e.g. "calisma") to proper characters ("çalışma") before typing. Pattern table (~175KB) lazy-loaded on first use.

### Removed
- Removed `execute_js` from Chrome MV3 tool schema. The tool was already blocked by MV3's CSP (`new Function()` always throws EvalError). The agent now uses fine-grained tools (`read_page`, `click`, `type_text`, `scroll`, etc.) directly. Firefox MV2 retains `execute_js`.

## [8.1.0] - 2026-05-26

### Added
- Added first-launch onboarding wizard: a 3-step walkthrough covering what WebBrain does, Act mode safety warnings, and LLM provider setup.
- Added MiniMax and Alibaba Cloud (Qwen) as new cloud providers.
- Added model suggestion dropdowns for all cloud providers with a "Custom..." option for free-form entry.

### Changed
- Settings page now opens on the Providers tab by default.
- Updated model suggestions and placeholders across all cloud providers to current models.
- Hidden the Claude Pro/Max subscription provider card until OAuth flow is fixed.

## [8.0.0] - 2026-05-25

### Added
- Added `hover`, `drag_drop`, and `wait_for_stable` agent tools.
- Added 27 new site adapters and the initial sheets-mode foundation.
- Added spreadsheet A1-reference handling improvements, including absolute references and quote-aware sheet/range parsing.
- Added a configurable LLM request timeout setting with a 10–600 second range.
- Added Multimodal settings updates, including a renamed Multimodal tab and a new Transcription section.
- Added auto-save behavior for SocialMediaDownloader / MSE captures.

### Changed
- Flipped local-provider defaults: vision is enabled by default and compact prompts are disabled by default.
- Increased the default LLM request timeout to 120 seconds.
- Updated non-English locale labels for compact prompt settings.
- Extracted and reused Firefox `fetchWithTimeout` handling for Anthropic and llama.cpp requests.

### Fixed
- Fixed stale-index failures by surfacing fresh element enumeration.
- Fixed `execute_js` regressions and retained Firefox MV2-compatible `unsafe-eval` CSP behavior.
- Fixed adapter ordering and a `drag_drop` scroll race.
- Fixed `wait_for_stable` MAIN-world network counting.
- Fixed A1 parsing edge cases, including row validation and reversed whole-column / whole-row ranges.

## [7.3.5] - 2026-05-24

### Added
- Added LLM comparison materials, benchmark blog content, and additional scenarios.
- Added project governance documentation.

### Changed
- Increased the default maximum agent steps from 60 to 130.

### Fixed
- Included post-7.3.3 bug fixes and content-index diagnostics.

## [7.3.4] - 2026-05-23

### Fixed
- Included maintenance bug fixes following `v7.3.3`.

## [7.3.3] - 2026-05-23

### Fixed
- Fixed Firefox clarify-flow behavior.

## [7.3.2] - 2026-05-21

### Added
- Added tab recording support: tab capture, microphone capture, Web Audio mixing, and WebM download.
- Added Whisper transcription and agent summarization handoff for recordings.
- Added prompt-driven recording start with screenshot save support.
- Documented tab recorder architecture.

### Changed
- Removed the recorder toolbar Stop button in favor of the existing page banner stop control.

### Fixed
- Fixed corrupted WebM output by stripping codecs from the data URL.
- Fixed OpenAI transcription HTTP 415 errors by tagging blobs as `audio/webm`.
- Added friendlier transcription errors when a picker targets a chat-only server.
- Fixed stuck clarify responses by routing through `sendToBackground`.

## [7.3.1] - 2026-05-21

### Added
- Added local model loading for LM Studio and llama.cpp.
- Added NVIDIA and Groq provider options.
- Regenerated store promotional assets around the brain icon and added marquee artwork.

### Changed
- Updated provider links, website copy, and store iconography.
- Scoped Chrome side panel behavior to opt-in tabs to prevent new-tab leakage.
- Scoped `agent_update` broadcasts to the originating tab.

### Fixed
- Fixed CAPTCHA URL-string sitekey fallback and added friendlier demo-rejection handling.
- Included web and extension bug fixes prior to the `v7.3.1` tag.

## [7.3.0] - 2026-05-20

### Added
- Added provider filters and collapsible provider cards.
- Added four additional cloud providers.
- Added opt-in CapSolver integration for CAPTCHA solving.
- Surfaced CAPTCHA solver and provider constellation updates on the website and localized pages.

### Changed
- Show configured models in collapsed provider headers.
- Preserve unsaved provider edits across filter and collapse re-renders.

### Fixed
- Tightened reCAPTCHA detection and cleaned CAPTCHA balance display strings.

## [7.2.1] - 2026-05-20

### Changed
- Stopped emitting the loose credential note to small models.

## [7.2.0] - 2026-05-20

### Added
- Added credential redaction support.
- Added a clarify tool.
- Added a WordPress site adapter.
- Added opt-in strict credential handling mode.

### Changed
- Made credential handling loose by default, while keeping stricter behavior available by opt-in.

## [7.1.0] - 2026-05-17

### Added
- Added SocialMediaDownloader v4.
- Added release-mode support to the version bump script with release-boundary tagging.
- Added 9 localization languages: Russian, Ukrainian, Arabic, Japanese, Korean, Indonesian, Thai, Malay, and Tagalog.
- Added RTL support and website language navigation updates.

### Fixed
- Fixed current page context handling in chat turns.
- Fixed tool behavior from GPT-4o trace review, including honest counts, gallery filtering, and article extraction.
- Improved scrolling in `overflow:hidden` panes when the document itself is unscrollable.

## [7.0.0] - 2026-05-12

### Added
- Added larger fetch limits, prompt nudges, trace conversation grouping, step-limit summaries, and cost surfacing.
- Added URL-family thrashing detection and empty-output recovery.
- Added multilingual FAQ content for dry-run roadmap status.
- Added an npm-runnable version bump tool.

### Changed
- Removed the mobile app from the main repository.
- Improved AX-tree fallback for composers.
- Rebuilt submission zips for v7.0.0.

### Fixed
- Fixed sidepanel XSS exposure.
- Hardened agent `fetch_url` behavior against SSRF.
- Clarified that the agent cannot schedule, sleep, or check back later.

## [6.1.0] - 2026-05-04

### Added
- Added native PDF reading with `read_pdf` and Claude PDF passthrough.
- Added Claude Pro/Max subscription provider support via OAuth.
- Added OpenAI OAuth subscription provider support.
- Added LM Studio web-fetching tools (`fetch_url` and `research_url`).
- Added LM Studio plugin publishing and related FAQ updates.
- Added mobile-app experiments, including Expo scaffolding, chat/browser tabs, agent loop, OpenAI provider, and AX-tree tools.
- Added blog and documentation updates for vision-model shootouts and PDF support.

### Changed
- Simplified website header navigation.
- Mentioned PDF support in website and README tool documentation.

### Fixed
- Hardened the LM Studio plugin against SSRF and added streaming response caps.
- Fixed PDF reader credentialed fetch and content-type-aware tab detection.
- Restored subscription-provider default merging and CORS opt-in behavior.
- Fixed Chrome side-panel action-click race by keeping the side panel always enabled.
- Preserved intermediate reasoning across steps in verbose mode.

## [6.0.1] - 2026-05-04

### Added
- Added Firefox parity for the agent visual indicator and tab grouping.
- Added cross-platform extension zip build tooling.

### Changed
- Scoped Chrome sidebar visibility to a per-window WebBrain tab group.
- Stopped adopting user-owned tab groups.
- Lowered Act mode temperature.
- Refreshed documentation for the 5.x release line.

### Fixed
- Added an on-page agent visual indicator with border and Stop button.

## [5.1.0] - 2026-04-29

### Added
- Added an Ollama model picker and guidance for 403 origin-block behavior.
- Added press release links and website sharing/footer updates.
- Added additional tests for model reasoning-suppression kwargs.
- Added blog content for vision-model comparisons.

### Changed
- Rebuilt extension zips for v5.1.0.
- Updated README and web assets.

### Fixed
- Fixed NVIDIA NIM integration issues.
- Fixed math visual bugs and improved pagination.
- Fixed web traces issues.

## [5.0.0] - 2026-04-24

### Added
- Added localized landing pages for Spanish, French, Turkish, and Chinese.
- Added language dropdowns across localized web pages.
- Added plugin internationalization.

### Changed
- Improved website presentation.
- Added token-conscious screenshot handling with resizing and iterative JPEG compression.

### Fixed
- Added test coverage for image budget math.

## [4.2.1] - 2026-04-21

### Added
- Added `.one` suffix branding to the web side-panel header.
- Added FAQ guidance for recommended vision models and vLLM configuration.

### Changed
- Updated demo video URLs and documentation around `/allow-api` and v4.2 behavior.

## [4.2.0] - 2026-04-20

### Added
- Added agent scratchpad tooling.
- Added preservation of tool-result digests in summaries.
- Added profile features.

### Fixed
- Fixed vision-model checkbox behavior and settings issues.

## [4.1.0] - 2026-04-20

### Changed
- Improved settings UI.

### Fixed
- Fixed tab grouping issues.
- Fixed screenshot-related bugs.

## [4.0.1] - 2026-04-19

### Fixed
- Fixed overlay-related issues and added tests.

## [4.0.0] - 2026-04-19

### Added
- Added optional dedicated vision model support for screenshot reads.
- Added vision model connection testing.
- Added tab grouping to keep WebBrain tabs near the current context.

### Changed
- Stripped chain-of-thought output from vision model responses.
- Preserved newlines in user bubbles.
- Updated architecture documentation.

## [3.6.8] - 2026-04-15

### Added
- Added test scenarios.
- Added math-related improvements.
- Added Firefox accessibility-tree support.

### Changed
- Improved browser install cards and Chrome Web Store linking.
- Updated Chrome and Firefox Act prompts for form verification and CAPTCHA handoff.
- Improved mobile demo video handling.

## [2.2.0] - 2026-04-12

### Added
- Added agent robustness guardrails.
- Added auto-scroll behavior.
- Added type validation and done verification.

### Fixed
- Fixed click loops.

## [2.0.0] - 2026-04-11

### Changed
- Rebuilt release zips with clean ZipInfo attributes.

## [1.9.2] - 2026-04-11

### Changed
- Made the agent more persistent.

### Fixed
- Fixed deep verbose trigger behavior.

## [1.9.1] - 2026-04-11

### Fixed
- Fixed fallback parsing for `call:toolName{}` format with quote tokens.

## [1.6.2] - 2026-04-08

### Added
- Added `/allow-api` per-conversation override and documentation.

## [1.6.1] - 2026-04-08

### Changed
- Clarified prompting so UI actions and `fetch_url` reading behavior are distinguished.

## [1.6.0] - 2026-04-08

### Added
- Added background fetch support.
- Added hidden-tab research tooling.
- Added download tools.

## [1.5.10] - 2026-04-08

### Added
- Added viewport-filtered interactive elements.
- Added index-instability warnings.

## [1.5.9] - 2026-04-08

### Added
- Added screenshot annotations.
- Added unintended-navigation detection.

## [1.5.8] - 2026-04-08

### Added
- Added click-by-visible-text support to avoid selector guessing for buttons.

## [1.5.7] - 2026-04-08

### Added
- Added `type_text` into the focused element without requiring a selector.

## [1.5.6] - 2026-04-08

### Added
- Added cross-origin iframe support so the agent can act in embedded flows such as Stripe.

## [1.5.5] - 2026-04-08

### Fixed
- Omitted temperature for GPT-5 and o-series models that only support the default value.

## [1.5.4] - 2026-04-08

### Fixed
- Added coordinate-click loop detection.
- Fixed OpenAI `max_completion_tokens` handling.

## [1.5.3] - 2026-04-08

### Added
- Added FAQ entry updates.

### Changed
- Improved header UI cleanup.

### Fixed
- Added active-tab guards.

## [1.5.2] - 2026-04-08

### Changed
- Reverted the Act mode toast back to a one-time-per-install `confirm()` dialog.

## [1.5.1] - 2026-04-08

### Fixed
- Fixed coordinate-click device-pixel-ratio mismatch.
- Preferred selectors where available.

## [1.5.0] - 2026-04-08

### Changed
- Included seven quality improvements.

### Fixed
- Fixed settings bugs.

## [1.4.0] - 2026-04-08

### Added
- Added site adapters.
- Added a non-blocking Act mode hint.

## [1.3.0] - 2026-04-08

### Added
- Added loop detection with a soft nudge followed by hard stop for stuck agents.

## [1.2.2] - 2026-04-08

### Changed
- Taught the agent that it operates inside the user's authenticated browser.

## [1.2.1] - 2026-04-08

### Changed
- Seeded the first prompt with URL and screenshot context.
- Improved Firefox parity.

### Fixed
- Fixed Continue button behavior.

## [1.2.0] - 2026-04-08

### Added
- Added SPA navigation detection.
- Added auto-screenshot mode.
- Added vision support.

## [1.1.6] - 2026-04-08

### Changed
- Increased the default agent maximum steps from 25 to 60.

## [1.1.5] - 2026-04-08

### Changed
- Routed click and type actions through CDP with selector-resolution retries.

## [1.1.4] - 2026-04-08

### Changed
- Updated the default OpenAI model to GPT-5.

## [1.1.3] - 2026-04-08

### Added
- Added LM Studio as a built-in local provider.

## [1.1.2] - 2026-04-08

### Fixed
- Fixed a manifest load error by restoring `side_panel.default_path`.

## [1.1.1] - 2026-04-08

### Fixed
- Persisted agent conversation state across service worker restarts.

## [1.1.0] - 2026-04-08

### Added
- Added robust CDP click/type behavior with shadow DOM support.
- Added per-tab sidebar behavior.
- Added persistent chats.

## [0.9.3] - 2026-04-06

### Changed
- Removed the old Firefox v0.9.0 zip artifact.

## [0.9.0] - 2026-04-06

### Changed
- Removed the website section from the README.

## [0.7.0] - 2026-04-06

### Added
- Added Firefox support documentation to the README.

## Appendix: 40.2.0 quality audit

### WebBrain quality audit — 2026-10-07 onward

Publication note for the proposed 40.2.0 release: this is the complete dated audit, with personal-contact/draft identifiers generalized and local evidence links rendered as archive references. Raw traces, credentials, screenshots and private receipt archives remain local and are not included in Git. Historical references to uncommitted changes, source revisions and line numbers describe their recorded snapshots. The isolated regression sources are included; run `npm run test:coverage` to reproduce the default suite. This documentation entry does not publish a release or change the tested 40.0.8 runtime version.

Updated 2026-10-11 (Europe/Istanbul). The user's latest instruction authorizes fixing the already established open defects and directly related findings encountered while fixing them. It supersedes the earlier report-only freeze. No new broad defect search is being conducted. The historical failed tests, live traces and HOLD results below remain preserved; they are not relabelled as passes for the new code.

#### October 11 authorized fixes and current validation

The current working tree includes the following paired Chrome/Firefox fixes. They are general workflow, ownership, completion and data-delivery changes; none is a special-case patch for one Bluesky button or one test account.

| Established problem | Resulting behavior | Focused evidence |
| --- | --- | --- |
| Reused chat drafts reported an uncertain Enter submission as not uncertain | Public dispatch and uncertainty reflect the actual submission; pending-send and duplicate-send protections remain | 10/10 causal regression cases; 215/215 related cases |
| Native commit acknowledgement lost completion provenance after an interrupted observation | Exact acknowledged dispatch provenance survives for independent read-only reconciliation; acknowledgement alone still cannot prove a remote effect | 110/110 related checks; 16/16 installed historical editor, deletion and navigation cases |
| Planner reference history contaminated the current task with a previous arithmetic goal | A fresh, task-bound alignment check permits at most one replan, with normal non-execution routing and cancellation/steering checks | 308/308 related checks; 102/102 planner cases |
| Native chat pane/alias repair instructions could be ignored and a finished partial run promised an unscheduled continuation | App-owned one-use read preparation runs through ordinary guarded tools; partial/failed unscheduled chat endings state that the run ended, in all 23 UI languages | 84/84 current actual-loop cases; 246/246 related chat/steering cases; 291/291 earlier related cases |
| Complete table answers sampled rows and changed literal Unicode | Native table projection preserves document order and literal strings, issues a task-owned reference, and rereads the source before complete JSON delivery | 32/32 paired schema/native browser tests; all 172 literal rows checked through ordinary Agent extraction and terminal batch |
| Privacy text implied settings/default data behavior inconsistent with the product | 22 localized landing pages disclose local/cloud choices, default eligible-data sharing and its Settings opt-out | All 22 pages generated; 9/9 web build tests |

The table repair also closes directly related presentation defects. Verified JSON bypasses display-text repair, progress-ledger prose, partial-chat prose and the publication disclaimer; ordinary prose summaries retain those notices. Partial/failed exact-table endings still expose truthful runEnded/autoResumeScheduled flags. Complete JSON is explicitly limited to the existing 30,000-character terminal capacity, including escaping; oversized results fail before a complete reference is issued. The native scan remains bounded to 10,000 rows and 2,000,000 cell characters. Complete table JSON within the delivery bound survives tight persistence and cold replay unchanged. The journal's 64/64 tests passed; recognition changes formatting retention only, never success or execution authority. A late awaited chat-model refresh now rechecks the original document/thread authority before repair scroll or identity-click dispatch; its whole-file causal result was 70/78 before and 78/78 after. Before the final task-ownership correction, the combined table, native browser, chat-repair and journal files passed **174/174**, without skips or cancellations. The final ownership-related chat/steering run below passed 246/246.

The final ordinary unfiltered **npm.cmd run test:coverage completed with exit 0** at 2026-10-11 01:47:53 UTC. It passed **9,765/9,765 Node/main cases** (7,315 Node cases across 23 groups plus 2,450 main cases), with no failures, skips or cancellations, plus 14 UI checks, 80 custom recipient checks and the separate 60-case security corpus. All 21 installed browser stages and all 54 selected fresh siblings passed, including the complete 15-case WhatsApp matrix. Selection restoration and the offline relevance benchmark also completed; measured relevance remains 55.4% at rank 1, 87.5% at rank 5 and MRR 0.685, with 21 top-five misses. Full-chain C8 coverage is **65.16% lines/statements, 78.74% branches and 87.25% functions**; 518 authored entries are inventoried and 106 remain uncovered. All 18,077 source/test/package inputs and authority stayed stable, all 1,182 current product files match the frozen source map, and complete before/after archive inventories (946/951 files) verify byte-for-byte. Post-test shipping parity separately matches all 603 Chrome and 579 Firefox source/build files. Independent finite full7 review is CLEAN: all 54 fresh siblings, 1,897 archived files, raw counters, coverage inventory and source/authority joins match the saved evidence. This qualifies the current default isolated suite, build and measured coverage; it does not qualify a real-model user-Chrome task, two-hour conversation endurance or a new GitHub scan of uncommitted changes. The earlier aborted/failed invocations below remain preserved with their original results. Final full-suite terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-consolidated-full-coverage-final7-20261011-3dfe863b-f8fa-437c-84de-891f51ae7164/terminal.json`), complete current stage/coverage/archive qualification (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-consolidated-full-coverage-final7-20261011-3dfe863b-f8fa-437c-84de-891f51ae7164/finite-full7-coverage-qualified-readonly.json`).

The current whole **15/15 installed WhatsApp matrix passed** once in 222.312 seconds with zero external messages. Both latest-read variants consume exactly one app-owned AX/scroll/observation sequence, with one actual scroll and a certified skipped model scroll counted separately in the prepared variant. Existing one-reply, one-submission, native delivery receipt, pending-null, successful completion, Stop, steering, peer switch, floor and restart assertions remain. All 18,077 source/test/package inputs, 1,182 products and authority stayed stable. The fixture manifest retains 147 of 148 original assertion lines verbatim; only model-proposal counting became actual-execution counting, with stricter ownership/phase checks added. This qualifies the isolated 15-case matrix; it is not an authenticated-account, endurance or full coverage claim. The final current-source CI command also passed its 14 scenarios and cloud capture with the same complete stable maps. Independent matrix closure review is CLEAN. The ordinary unfiltered full6 coverage invocation naturally closed with exit 1: all 7,315 Node tests across 23 groups, 14 UI checks, 80 custom recipient checks and all 21 installed stages passed, including all matrix siblings. The 2,450-case main file then returned 2,448 passes and two failures: its English/Turkish trust-rail expectation still required the inaccurate old no-telemetry claim, and its static done-summary matcher still required the old unconditional display-repair line. Independent bounded source review confirms both are obsolete test contracts, with all raw semantic gates and current verified-data-reference authority intact. Only those three exact expectation strings in test/run.js changed; every other byte and assertion is retained and the inverse is verified. The ordinary whole main file then passed 2,450/2,450 once with all 18,077 source entries, 1,182 products and authority stable. Current whole-main receipt (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-current-terminal-privacy-main-green-3e761337-0c0e-4cfe-ada4-0b1eaf183bc3/terminal.json`). Independent exact-edit and whole-main closure review is CLEAN. The distinct ordinary unfiltered full7 capture subsequently closed with exit 0 and passed the complete default chain, as recorded above, with product/test/package inputs frozen. Full7 invocation (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-consolidated-full-coverage-final7-20261011-3dfe863b-f8fa-437c-84de-891f51ae7164/invocation.json`). Source/product/authority maps were stable throughout full6; all 836 before and 946 after archived files and exact filesets verify. Its coverage 65.12% lines/statements, 78.67% branches and 87.25% functions is partial because restoration, benchmark and security tails were not reached. Preserved failed full6 terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-consolidated-full-coverage-final6-20261011-d8aa6c5d-c4e6-4376-9ed8-13538ad2491f/terminal.json`), finite stages, archives and exact two causes (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-consolidated-full-coverage-final6-20261011-d8aa6c5d-c4e6-4376-9ed8-13538ad2491f/finite-failed-full6-stages-archives-and-main-causes-readonly.json`), reversible three-string main fixture manifest (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-current-terminal-privacy-main-fixture-9421f1ef-0513-479b-b321-8cfeb824958b/recorded-current-contract-edits.json`). Qualified matrix and reversible fixture proof (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-whatsapp-current-contract-full-matrix-ebea9539-d0bf-4a30-a3af-759b666313a9/fixture-and-full-matrix-qualified-v2.json`), final V2 fixture manifest (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-whatsapp-latest-repair-current-contract-fixture-fd8d2556-90f3-47e0-8b6e-76674588285e/recorded-current-contract-edits-v2.json`), current final CI terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-final-current-ci-80889a4c-1943-4860-b0c7-8ce3edbacf73/terminal.json`).

The ordinary unfiltered `npm.cmd run test:coverage` final3 attempt closed with exit 1 after **7,011/7,011 Node tests**, 14 UI checks and 80 recipient/upload checks passed. Installed full-form stage 1 submitted exactly once through 97 passive counter ticks. Installed mid-run stage 2 exposed a directly related task-ownership defect: after accepted task replacement, a stale private chat-read repair synthesized a skipped result for the first revised calculation, causing two calculation proposals/results instead of one. Only one original native observation and one actual calculation dispatch occurred; no chat mutation occurred. The exact-one fixture is unchanged. Paired Agent now retires private read preparation at applied steering and checks the private record's current ownership, document/thread, original signal, age and unused state before all three preemption paths. Stale admission only clears the pending repair, preserving same-task once history and pending-send receipts. The related paired chat/steering files passed **246/246**, including six new ordinary-batch task-replacement and stale-document cases. Stages 3–21 and later default tails were not reached by the preserved failed invocation. All 18,077 source/test/package inputs and 1,182 product files stayed stable during that invocation. Coverage **40.91% lines/statements, 69.97% branches and 57.70% functions** is partial, not a full-suite qualification. Preserved failed terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-consolidated-full-coverage-final3-20261011-4908d171-cd2b-4c50-b17b-60d1553ce52e/terminal.json`), independent saved cause evidence (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-consolidated-full-coverage-final3-20261011-4908d171-cd2b-4c50-b17b-60d1553ce52e/finite-failed-coverage-and-stage2-cause-readonly.json`), 246-case related log (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-stale-read-repair-final-related.log`).

After the ownership correction, the unchanged installed mid-run fixture passed once: two original task requests, one original native read, exactly one revised calculation proposal/result, then done; revised calls and results are exactly `calculate, done`. Both live and persisted success flags are true, discarded old proposal IDs remain absent, and mutation counters remain zero. Complete source/product maps and authority remained stable. Qualified focused stage 2 receipt (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-focused-installed-midrun-after-repair-20261011-ef5af229-8562-481f-9b44-ee9ad3201137/focused-stage2-qualified.json`). The distinct ordinary unfiltered final4 coverage run closed with exit 1 after all 7,017 Node tests, 14 UI checks and 80 recipient/upload checks passed. Installed stages 1 and 2 passed; stage 3 retained its original native read but failed the older one-read count after app-owned alias preparation produced three reads and two private read-only click acknowledgements. Menu opening occurred once, mutation counters were zero, and both success flags remained false. A separate evidence-only focused RED retained every original assertion and captured exact `open_menu` → `open_self_settings` → already-consumed Settings phase/ref transitions. Two distinct first-use private bindings, unchanged owner, stable monitor UUID and separate AX document token, plus identical native URL/epoch/peer/empty composer establish a legitimate bounded recovery. The diagnostic cross-namespace document comparison remained false in that preserved RED and is corrected in the fixture comparator; it is not a production document-mismatch finding. Independent review concurred with exact three-read/two-control assertions, preserving one menu opening, zero mutations and false success flags. Stages 4–21 and default tails were not reached. All source/product bytes and authority remained stable. Its 40.91% line/statement, 69.99% branch and 57.72% function coverage is partial. Preserved failed final4 terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-consolidated-full-coverage-final4-20261011-7f650cab-572c-4a1c-9879-a1601fe8d2f5/terminal.json`). Preserved diagnostic RED (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-cold-native-repair-contract-focused-red-88fdb996-5d9f-4c7c-97a3-67a990d0a5e9/terminal.json`).

The final cold-start fixture passed once after the test-only current-contract update. It asserts exactly three observations and two distinct, once-used private controls, stable AX and monitor namespaces separately, identical native document/peer/empty composer, the first original observation retained, stale model proposals not dispatched, one menu opening, zero mutations and false completion flags. Of the original 18 assertion code-lines, 16 remain verbatim; only the exact read/control counts changed, with stricter phase/reference/ownership assertions added. Provider outcomes and product code were unchanged. All 18,077 inputs, 1,182 products and authority remained stable during execution. Qualified focused stage 3 receipt (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-cold-native-repair-contract-focused-green-87a9c75a-e93e-46df-8b9f-fd1e85b2919b/focused-stage3-qualified.json`), reversible fixture/assertion manifest (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-cold-native-repair-current-contract-fixture-f053a177-7879-4e22-817e-62f328eb84df/recorded-current-contract-edits.json`). The fresh ordinary unfiltered final5 coverage run closed with exit 1 after all 7,017 Node tests, 14 UI checks, 80 recipient/upload checks and installed stages 1–5 passed. Stage 6 WhatsApp matrix passed its first two cases, then its native_scroll_latest fake provider asserted that its last result must still be get_accessibility_tree. The recorded app-owned sequence had already completed the exact issued-pane AX read, one bottom scroll and a fresh same-thread observation of two current incoming messages with no remaining repair hint. The obsolete model handoff failed before any send; no reply, Enter, send-button click or pending clear occurred. The final V2 fixture consumes only this exact already-executed recovery and counts the one actual recorded scroll, distinguishing the certified skipped model proposal, while preserving every delivery, pending-send, one-submission and completion requirement. The remaining 12 matrix cases and installed stages 7–21 were not reached. Complete source/product maps and authority remained stable. Coverage 40.91% lines/statements, 69.99% branches and 57.72% functions remains partial. Preserved failed final5 terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-consolidated-full-coverage-final5-20261011-bc1a60b4-fe03-461e-bbdd-3b9e474bd876/terminal.json`), sealed stage6 cause and complete archive review (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-consolidated-full-coverage-final5-20261011-bc1a60b4-fe03-461e-bbdd-3b9e474bd876/finite-failed-coverage-and-stage6-cause-readonly.json`).

Two earlier October 11 attempts were explicitly aborted for related table presentation corrections, with their stable source maps and outputs retained; neither is a full-suite pass or a test-failure qualification. Current standalone release checks passed: DOM fixtures 283/283, CI 14 scenarios plus cloud capture, web build 9/9 and the 22-page landing build. No tests or package scripts were removed or disabled. The latest normal `npm.cmd run build:all` passed with complete matching source/build inventories: **603 Chrome and 579 Firefox files**, all 1,182 pairs byte-identical and source/package/lock/protected script hashes stable. This is build evidence, not a loaded-user-runtime claim.

Focused evidence: table/chat/journal 174-case log before the last ownership correction (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-final-table-chat-journal-green.log`), current paired normal build receipt (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-final-normal-build-05dfd144-31b9-4887-a5ab-e980cc64f9e5/receipt.json`), chat submission causal proof (local evidence: `ci/artifacts/quality-audit-2026-10-07/chat-send-submission-outcome-fix-f2c144c3-8b6d-432a-a11f-29f19e6fdc40/proof.json`), completion historical regression receipt (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-completion-fixes-historical-20261011-1/validation-final.json`), chat ownership await-boundary proof (local evidence: `ci/artifacts/quality-audit-2026-10-07/owned-chat-read-repair-await-boundary-9d8b3593-498e-43a6-8a1c-9552d0fc5950/proof.json`), CI log (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-20261011-ci.log`), unstarted real-model replay closure (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-live-table-actual-kfix_ac2f9e920e2a4bc681ad7cf211e80605/closed-without-submission.json`).

The new real-model table replay was not submitted. Computer Use stopped because it could not confidently determine the current Windows Chrome URL. No alternate control route was attempted. Its observer remained unarmed and its owned local fixture listener was closed. Accordingly, the isolated native browser/ordinary Agent tests qualify code behavior; they do not establish that the new code has completed a real-model task in the user's loaded Chrome. The previous two-hour Telegram producer remains HOLD before the timed phase, with zero timed questions/replies; it was not restarted or claimed as a pass.

Final authenticated read-only GitHub verification at 2026-10-11 01:46:15 UTC still shows 77 open high-severity Code Scanning alerts, all on scanned main commit `6da190593be3990dceb83396fb42b9e779ef9f1e`. A fresh remote-main lookup returns that same commit. Final read-only alert/main receipt (local evidence: `ci/artifacts/quality-audit-2026-10-07/known-fixes-final-code-scanning-readonly-828f199c-9dd9-4b2a-a793-1365ff17495b/receipt.json`). The earlier per-alert review records 36 locally addressed/mitigated findings and 41 conditional trust cases. GitHub has not scanned these uncommitted fixes, and no alert was dismissed or closed. [GitHub Code Scanning](https://github.com/esokullu/webbrain/security/code-scanning).

No new account, external message, post, channel or avatar change was made in this repair turn. The earlier authorized avatar change was to **Vatansever Cephe**, channel **UCVB3sGJ6VIKsYN4W2SeTMgQ**. The originally supplied UC2nx channel remained inaccessible and unchanged. Existing owned QA accounts and the Telegram producer's once guard remain tracked in the historical evidence below. Nothing has been staged, committed, pushed, released or deployed.

#### Historical validation through Source71

Statements below about a report-only freeze, unapplied candidates, current Source71, open code defects or earlier coverage failures describe the historical audit state. The October 11 fix and validation section above supersedes that state; all old trace evidence retains its original qualification.

The branch is `codex/quality-audit-2026-10-07`. HEAD and remote main remain `6da190593be3990dceb83396fb42b9e779ef9f1e`, verified by read-only upstream lookup on October 10. Nothing has been staged, committed, pushed, released or deployed. The original index, protected `check-seventeen.mjs`, package script contract and user changes are preserved.

ProductSource71/RepositorySnapshot79 is the latest applied and normally built snapshot. Four reviewed files changed: the Chrome CDP client, paired page monitors and the native preparation ownership fixture. Native no-button movement can remain preparation while its acknowledgment is pending; a privately guarded selector scroll can precede it without pretending that a real button press occurred. Existing complete target/action checks remain, and real-input history survives finish and later fences. The exact same159-test file reproduced five passive-preparation failures plus the parent on Source70 (153 passed) and passed159/159 on the candidate, with no skips, cancellations, filters or retries. One historical held-counter refusal leaf was intentionally amended; all original bytes outside that leaf remain. Root and an independent reviewer verified all18 byte regions before application. Normal build exited zero with all602 Chrome and578 Firefox build files matching source bytes; all18,074 recorded inputs and original authority remained stable. Ordinary unfiltered full C8 execution9 exited1 at installed stage12 after stages1–11 passed. All6,882 Node cases,14 UI checks and80 recipient-upload checks passed; the full suite is not qualified. Source71 has now been normally reloaded and bound to the user Chrome runtime; the current native mid-run replacement independently passed; owned-bot bootstrap failed without a send and real120 was not started.

Source71 four-file application (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-reviewed-pointer-preparation-actual-045f3043-6e92-455e-a471-a693d855e46e/actual-application.json`), Source71 normal paired build (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-normal-build-only-actual-26a7d036-5145-4f61-b071-67baeb0825df/result.json`), independent physical application/build review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-application-and-normal-build-independent-recent-readonly.json`), same-file causal evidence (local evidence: `ci/artifacts/quality-audit-2026-10-07/native-pointer-preparation-phase-candidate/proof-final-v9.json`), independent candidate review (local evidence: `ci/artifacts/quality-audit-2026-10-07/native-pointer-preparation-phase-independent-historical-readonly-final-v9.json`), execution9 failed terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-isolated-normal-coverage-before-real120-execution9-actual-bdc4e8c0-d121-48b0-a7a9-1d539af67201/terminal.json`).

Source71/Repository79 C8 execution9 ran from17:37:29.438 to17:56:32.294UTC. The formerly failing full form submitted exactly once while159 passive counter ticks occurred. The complete15-case WhatsApp matrix, saved-byte and file-accept upload checks, and20-row Stop/Continue workflow also passed. Stage12 stopped in the first rich-editor case of the literal/frame fixture: its native Save click was acknowledged, but subsequent observation reported a nonretryable unknown outcome. Actual isolated evidence contains one application save and matching authorized, persisted and rendered body SHA256; the fake provider stopped on the uncertain tool result before independently reconciling that receipt. The provider treats every tool error as fatal, including this exact read-only recovery instruction; a narrow fixture-only reconciliation is prepared but remains unapplied under the user constraint. The nested frame and Trusted Types cases were not reached. Later nine installed stages and main/security tails were not reached by this C8 invocation. All18,074 input bytes and authority stayed unchanged. Coverage40.66% lines/statements,69.45% branches and57.32% functions is partial and does not qualify the full suite. The failed result and original stage outputs are preserved; no unchanged retry is running. An independent review verified1,672 preserved files (822 before and850 after), fresh stage outcomes and exact source/authority stability. Later installed stages were checked through separate ordinary diagnostics, each stopping on its first failure; these cannot turn the failed C8 invocation into a pass.

Independent execution9 review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-isolated-c8-execution9-independent-historical-readonly.json`).

The separate ordinary installed-tail diagnostic passed stage13 (publication) and failed stage14 (deletion), with stages15–21 not reached by that invocation. Only one actual owned DELETE occurred; a subsequent resource read returned404 and a fresh profile showed no post. The independent completion judge returned succeeded. However, the fully acknowledged native confirmation click had an interrupted-observation unknown result, so semantic submission tracking omitted its dispatch record. Completion consequently treated the unrelated persistent composer as an unverified relevant form and restricted success. The deterministic provider also ignored the current tool schema and repeatedly emitted done(success), ending with invalid arguments. This is a WebBrain completion/provenance mismatch plus non-adaptive fake-provider recovery; neither is being changed under the latest user constraint. All source/authority bytes remained unchanged;46 archived files preserve the separate diagnostic.

Separate tail13–21 review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-isolated-installed-tail13-21-actual-review-historical.json`).

Root normally reloaded Source71 in the user Chrome session after verifying21 idle tabs and zero active jobs. The previous Main8215 closed, new Main8307 has timeOrigin1791655714556, and bot148 was refreshed normally. Actual served30 module hashes plus a separate same-epoch Scheduler hash match all corresponding source/build bytes. The pure physical verifier confirmed all1,180 product and18,074 repository inputs, with602 Chrome/578 Firefox files and unchanged before/after Main identity. An independent reviewer confirmed the runtime binding. It establishes loaded-source correspondence; task success is separately measured.

Actual Source71 runtime binding (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-main8307-source-proof-actual-89524793-1835-4e02-aef9-477e352781b3.json`).

The separate later diagnostics reproduce the same completion/provenance false negative in stages16 (first dropdown-menu case),17 (deletion followed by navigation), and18 (first delayed semantic-navigation case). Each genuinely deleted the owned fixture item once and reached current404/profile absence with a positive judge, but interrupted native readback left submission provenance missing. Stages14/16 fake providers ignored the restricted tool schema; stages17/18 ended normally with partial. Stage15 anchored-action passed, including zero foreign menu clicks. Matrix siblings not reached remain untested. No outcomes or source/model/default-fixture behavior were changed.

Stage14 causal diagnosis (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-native-deletion-completion-mismatch-readonly-diagnosis.json`), stage16 causal note (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-dropdown-menu-completion-mismatch-readonly-note.json`), separate15–21 review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-isolated-installed-tail15-21-actual-review-historical.json`), separate17–21 review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-isolated-installed-tail17-21-actual-review-historical.json`), separate18–21 review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-isolated-installed-tail18-21-actual-review-historical.json`).

Later installed stages19–21 passed separately once: four workflow cases, three media-upload cases and worker restart/ownership checks. Stage21 recorded two attempted external requests, both route-aborted, and zero external messages. Separate normal main/security tails passed2,450/2,450 main checks, Chrome/Firefox selection restoration, offline benchmark existing floors and60/60 security corpus cases. Benchmark retains21 top-five misses across168 queries/251 passages (55.4%R1,87.5%R5,MRR0.685). One QA runner initially stopped before the benchmark because that script was intentionally outside the18,074-input map; the error remains preserved, the script was separately pinned, and already-passed main/restoration checks were not repeated. All four normal commands ran once and current product/source/index/protected authority stayed unchanged. These passes do not relabel failed full C8 execution9 or the failed deletion/completion cases.

Separate installed19–21 review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-isolated-installed-tail19-21-actual-review-historical.json`), separate main/security tail review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-separate-main-security-tail-independent-historical-readonly.json`).

Current Source71 native task replacement passed independently in17.787 seconds (18:20:33.505–18:20:51.292UTC). Root physically entered the270-character own-bot inspection task, then197-character replacement with Alt+Enter after an actual MAIN thinking event. Exactly one revision applied, zero old tools executed, and calculate returned86419752308641975230.125 before a separate normal done. Live and persisted status both show successful completion. Before/after native reads retain the same bot document, only Start message6672 and an empty editor. One original Return/one correction Alt+Return and zero public business requests are independently pinned. The raw observer/input passed:false fields remain intact; the qualified result adds independent evidence. Root callback result assignment failed after both inputs and exclusive ledger writing; the written ledger was read without retry. Accepted RPC timestamp/original MAIN response ordering and protected Saved Messages drafts are not separately qualified.

Current native replacement (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-native-midrun-attempt1-root-qualified-actual-94194c47-b2ed-4f9e-b885-2dd0b0c5b7b1.json`), independent native replacement review (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-native-midrun-attempt1-independent-recent-readonly.json`), independent loaded-source review (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-main8307-source-binding-independent-historical-readonly.json`).

The current owned-bot bootstrap ran once for27.050 seconds, with the newly authored task anchor preserved. The freshly generated approved plan combined the previous arithmetic goal with the new bootstrap marker; that marker did not exist in prior messages. This is observed new planner wrong-goal/history contamination, amplified by confidence0.99 automatic approval. The main model followed that plan and first tried done(success) with the old arithmetic answer plus the new marker, which the completion judge correctly rejected. It then ignored the exact native alias-repair instruction (read and open the current profile), placed the issued profile ref in rebind_thread_key, repeated chat_observe and ended failed with the old arithmetic answer. Source resets of steering/current task and retirement of the earlier approved plan were retained; stale privileged steering state is not established. Exact raw planner provider request/response was not retained, so precise model causation or prompt weighting remains an inference. There were zero chat_send calls, zero physical submissions and no new native bot message; the same native document remains Start-only with empty composer. Failed evidence and private raw responses are preserved. No planner/model/product repairs, retry, API delivery receipt or real120 controller were attempted. Full C8 PASS was an earlier scheduling preference, not a bootstrap/controller guard; actual bootstrap success remains the unfulfilled prerequisite for the legacy strict real120 route. The distinct normally submitted UI test has separate prospective ownership and receipt checks.

Current bot bootstrap failure (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-bot148-bootstrap-public-safe-actual-ba410f89-303c-4469-97fe-a5ff6170684a.json`), report-only bootstrap diagnostic (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-bot148-bootstrap-report-only-diagnostic-actual-4eae5bd6-dacb-406d-a22d-d511dc5e0100.json`), independent wrong-goal planner diagnosis (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-bot-wrong-goal-report-only-diagnosis-historical.json`).

Current Source71 WhatsApp self-chat read-only testing independently qualified one native Return, one fresh chat_observe with empty rebind/pending keys and reconciliation disabled, then a separate normal done. Actual saved tool results show current self thread dom:whatsapp:self:c14943a7, available empty composer, no pending outbound and done=true/outcome=success; the exact completion decision is llm/succeeded, vision, openai/gpt-5.4-mini. Both live and stored successfulDone/runSucceeded are true. Native Return acknowledgment to run_complete took27.220 seconds. Before/after native reads retain the same document, epoch, self header, newline editor digest and three mounted message IDs at the latest viewport. After was captured296.021 seconds after run_complete, so this proves snapshot preservation, not an immediate terminal or full-history trace. No messages were sent. The raw observer passed:false/protocol:false fields are preserved: the QA observer missed the stored untrusted_page_content wrapper and omitted the positive succeeded enum. Root and an independent reviewer separately decoded the exact paired wrappers and verified the original fields without changing the executed observer or rerunning the task. This qualifies current read-only identity/observation/completion only, with31 served hashes and1,180/18,074 source/build inputs bound; no delivery, endurance or full C8 claim.

Current WhatsApp Root qualification (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-whatsapp-self-readonly-root-qualified-actual-9dbce3a9-c1a7-4121-baf5-6b919502ee4e.json`), independent WhatsApp review (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-whatsapp-self-readonly-independent-recent-readonly.json`), preserved raw observer (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-whatsapp-self-observer-terminal-actual-101a8a7d-962f-41c4-bfba-641082084c20.json`).

Source70/RepositorySnapshot78 is prior evidence. Seven reviewed files changed: paired Agent/Scheduler implementations, appended lifecycle regressions and two existing download/upload fixtures. The normal build exited zero with exact602/578 parity. Ordinary unfiltered full C8 execution8 exited1 at the first installed form test, despite all6,849 Node,14 UI and80 recipient-upload checks passing. This failure remains preserved.

Source69/Repository77 remains prior evidence. Repository77 changed only the installed download fixture. Its general arithmetic-task replacement classifier recognizes a complete explicit replacement instruction and narrowly negative chat restrictions, after the existing planner read-scope and deliverable gates. It adds no receipt, permission or completion evidence. The whole same-source regression reproduced six failures (392/398 passed) before the repair and passed398/398 afterward, preserving prior tests and no-receipt negatives. The actual Source69 user-Chrome runtime served30 matching modules and was physically bound to the complete1,180-product/18,074-input maps. Its actual native mid-run task replacement passed; this does not establish Source70 loaded execution or endurance.

Source70 seven-file application (local evidence: `ci/artifacts/quality-audit-2026-10-07/product70-repository78-reviewed-scheduling-and-fixtures-actual-6f04bc8e-383d-41b0-8bc0-3eda2cb77666/actual-application.json`), Source70 normal paired build (local evidence: `ci/artifacts/quality-audit-2026-10-07/product70-repository78-normal-build-only-actual-146cf2a6-7546-423e-aba0-09a724ecc284/result.json`), independent physical application/build review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product70-repository78-application-and-normal-build-independent-recent-readonly.json`).

Source68 remains prior evidence. RepositorySnapshot75 additionally applied one fixture-only verification phase correction; all1,180 product files stayed unchanged from the Source68/Repository74 normal build. Its two-file repair keeps app-owned contact read-repair actions on the existing private content path even when the Close control is a native BUTTON. The corrected paired ownership fixture passed28/28; its same-source baseline failed the new Chrome leaf and its parent. Normal `npm.cmd run build:all` exited zero, all602 Chrome and578 Firefox files matched their source bytes, and18,074 recorded inputs and original authority remained stable. The complete isolated installed WhatsApp contact matrix passed15/15 in227.345 seconds, with603 source files stable and zero external messages. This qualifies the controlled matrix, not an authenticated WhatsApp account or endurance.

Source67 remains separate prior evidence: the applied installed full-form submitted exactly once while99 passive counter updates occurred; its normally reloaded runtime had30 served hashes bound to the complete1,180-file source/build maps, and native download615 preserved the exact requested filename and PNG bytes. Source67 C8 execution4 exited1 at installed WhatsApp stage6 after stages1–5 passed. The prior normal Source68 user-Chrome reload and Main8205 were verified:30 served hashes match source/build bytes and the full1,180-product/18,074-input maps, with unchanged document identity and authority. This is runtime binding, not successful task execution. Full C8 execution5 exited1; the real120-minute run has not started.

Source66/Repository70 ordinary unfiltered core validation remains separate prior evidence:40 planner,98 URL/recipient security,117 default network/download lifecycle and2,450 main checks passed. Repository71/72 only corrected two existing test fixtures; its1,180 product files and normal build bytes were reverified unchanged. These results are not relabelled as Source67.

Source68 actual contact-routing application (local evidence: `ci/artifacts/quality-audit-2026-10-07/product68-repository74-reviewed-contact-routing-source-only-actual-1ef5bfb9-0b25-4e7a-ab45-e5c7aa17da08/actual-application.json`), independent application and security review (local evidence: `ci/artifacts/quality-audit-2026-10-07/code-scanning-product68-repository74-current-local-reconciliation-independent-historical-readonly.json`), Source68 normal paired build (local evidence: `ci/artifacts/quality-audit-2026-10-07/product68-repository74-normal-build-only-actual-ca63221d-25d9-4e0b-9eca-5c8fd27d5da7/result.json`), independent build review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product68-repository74-normal-build-independent-recent-readonly.json`), derived build-bound product map (local evidence: `ci/artifacts/quality-audit-2026-10-07/product68-repository74-derived-build-bound-product1180-map-readonly.json`), complete installed WhatsApp matrix (local evidence: `ci/artifacts/quality-audit-2026-10-07/product68-repository74-whatsapp-contact-matrix-actual/summary.json`). The derived map is not a served/runtime proof.

Applied pointer preparation repair (local evidence: `ci/artifacts/quality-audit-2026-10-07/product67-repository73-reviewed-pointer-completion-source-only-actual-9eb5a286-e6e6-4103-844f-12d8b06e7162/actual-application.json`), Source67 normal paired build (local evidence: `ci/artifacts/quality-audit-2026-10-07/product67-repository73-normal-build-only-actual-c6c611f7-9daf-4b8f-bdc0-0c49ff437bca/result.json`), independent two-file review (local evidence: `ci/artifacts/quality-audit-2026-10-07/native-button-pointer-operation-independent-historical-readonly-final-v2.json`).

Prior Source66 ordinary core (local evidence: `ci/artifacts/quality-audit-2026-10-07/product66-repository70-ordinary-core-actual-a96a213a-0534-42fe-bf89-64cd28d9d1a3/result.json`), normal paired build (local evidence: `ci/artifacts/quality-audit-2026-10-07/product66-repository70-normal-build-only-actual-2a4bbc88-4dbf-44d4-a82f-85902ceb7d9d/result.json`), independent validation (local evidence: `ci/artifacts/quality-audit-2026-10-07/product66-repository70-ordinary-core-and-normal-build-independent-recent-readonly.json`).

Source65 affected page-feedback validation remains separate historical evidence: 2,446 Node checks, 36 WhatsApp Node checks and 80 recipient-upload browser checks passed. Its native draft-recovery run passed 108 Node and five installed cases with zero external messages. These were not rerun or relabelled as Source66.

The last complete coverage qualification remains historical Product45/Repository49: 6,706 Node cases, 2,448 main checks, 60 security checks and all 21 installed stages passed. Coverage across 514 authored files was 64.99% for lines/statements, 78.44% for branches and 87.10% for functions. These percentages remain historical. The first Source66/Repository70 normal coverage command exited1 with four obsolete fake-model prose response failures. Its nine completed Node groups totalled 4,500 cases, 4,496 passed and four failed, with no skips or cancellations; none of the 21 installed stages was reached. Partial coverage was 37.73% lines/statements, 67.34% branches and 56.19% functions across 516 authored files and cannot qualify the whole suite. Only the fake model response was updated to the existing strict `final_text` envelope, preserving all 164 assertion-containing lines. The whole lifecycle file then passed 80/80. Execution2 on Repository71 passed 6,713 of 6,714 Node cases plus 14 separate UI lifecycle checks; it stopped before installed stages because an iframe fixture read the previous preparation reply before an asynchronous dispatch callback. That failure occurred before the production fallback or its scrolling checks ran. Repository72 replaces a fixed 150ms setup delay with observed DOM feedback and awaits the actual prepare/dispatch callbacks, retaining all 325 assertion lines and adding two readiness assertions. Execution3 passed all 6,750 Node cases, 14 UI lifecycle checks and 80 recipient-upload browser checks, including the corrected iframe leaf. It then failed the first installed full-form stage: no submission occurred after native-button reprobe rejected preparation. Later 20 installed stages and remaining main/security stages were not reached. Partial coverage was 40.52% lines/statements, 69.29% branches and 57.07% functions; no current whole-suite success is claimed. A capture-only ordinary reproduction and a separate C8-wrapped reproduction both submitted exactly once and passed, with matching native preparation fields; the initial failure did not record those fields, so its exact cause remains under investigation.

Historical complete coverage (local evidence: `ci/artifacts/quality-audit-2026-10-07/product45-repository49-normal-coverage-execution2-actual-97db1f11-20de-48a1-9fab-48a6c745e40d/observed-summary.json`).

Source68/Repository74 full C8 execution5 ran the ordinary unfiltered command from14:13:04.559 to14:21:30.755UTC. Node totals were6,729:6,727 passed and two failed (one Firefox leaf and its parent), with14 separate UI checks passed and zero skips/cancellations. The custom recipient80, all21 installed stages and main/security tails were not reached. All18,074 inputs and original authority remained stable. Partial coverage is40.47% lines/statements,69.06% branches and57.06% functions; it does not qualify the whole suite. The failing test injected physical type-and-Backspace before confirming native30ms verification had reached the later80ms stage; production correctly refused unverified rich-text. Repository75 holds only that actual outer callback after its real80ms delay, performs real keyboard input, then releases once. The unfiltered whole candidate passed58/58 across Chrome and Firefox, retaining all80 original assertion-containing lines and all1,180 product bytes. Complete coverage after this fixture correction remains unfinished.

Prior Source68 loaded runtime (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product68-repository74-main8205-source-proof-actual.json`), independent runtime binding (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product68-repository74-main8205-source-binding-independent-historical-readonly.json`), execution5 failed terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/product68-repository74-isolated-normal-coverage-before-real120-execution5-actual-bf47c764-f2ce-4a29-ab56-f3b0e1451cce/terminal.json`), independent execution5 review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product68-repository74-isolated-c8-execution5-independent-historical-readonly.json`), whole fixture58/58 (local evidence: `ci/artifacts/quality-audit-2026-10-07/native-draft-outer-verification-fixture-candidate/whole-file-root-actual.json`), independent fixture review (local evidence: `ci/artifacts/quality-audit-2026-10-07/native-draft-outer-verification-fixture-candidate/whole-file-root-independent-historical-readonly.json`), actual fixture-only application (local evidence: `ci/artifacts/quality-audit-2026-10-07/product68-repository75-reviewed-fixture-only-actual-e9bfea81-a10d-4974-b09e-19058d61b562/actual-application.json`).

Source69/Repository76 ordinary unfiltered C8 execution6 ran from14:55:28.736 to15:10:15.772UTC and exited1. All6,773 Node cases in11 groups passed, with14 separate UI and80 recipient-upload checks passed and zero skips/cancellations. Installed stages1–7 passed, including the complete15-case WhatsApp matrix; stage8 download-upload failed and the later13 installed stages plus main/security tails were not reached. All18,074 input bytes and authority remained stable. Partial coverage is40.56% lines/statements,69.32% branches and57.13% functions; whole-suite coverage remains unfinished. The failing fixture searches Chrome DownloadItem.url for the original HTTP URL, whereas current staged downloads use a local blob and return the original URL alongside downloadId. This stale predicate cannot identify the native download; the failed run did not retain its browser download rows, so actual successful bytes/upload are not inferred. Repository77 applies the fixture-only receipt/ID correlation repair. The same current Source69 standalone baseline reproduced the exact missing-download assertion; the candidate passed with two native receipt-bound downloads, exact68-byte PNG and611-byte PDF contents/MIME, one remote GET per asset, one exact PDF upload and normal successful completion. All14 original assertion calls remain, with14 added checks and six complete byte inverses. This fixture does not assert saved basename. Root applied only this one fixture, preserving all1,180 product files and every other recorded input/authority. Normal build on Repository77 exited zero with exact602/578 source/build parity.

Repository77 ordinary unfiltered C8 execution7 ran from15:30:37.206 to15:45:46.636UTC and exited1. All6,773 Node,14 UI and80 recipient-upload checks passed, followed by installed stages1–8. The corrected stage8 verified two actual native downloads with exact PNG/PDF bytes and MIME, one PDF upload and normal completion. Stage9 failed the same obsolete native DownloadItem URL predicate in the saved-byte fixture; later12 installed stages and main/security tails were not reached. The whole18,074-input map and authority stayed unchanged. Partial coverage remains40.56% lines/statements,69.32% branches and57.13% functions, without a whole-suite qualification. The remaining saved-byte and upload-accept fixtures were subsequently checked together; the failed stage9 did not preserve sufficient native rows to infer its byte assertions passed.

Execution7 actual failed terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/product69-repository77-isolated-normal-coverage-before-real120-execution7-actual-0191e7e6-bce0-404f-a3e5-7410ed34ad70/terminal.json`), independent execution7 review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product69-repository77-isolated-c8-execution7-independent-historical-readonly.json`).

Source70/Repository78 full C8 execution8 exited1. All6,849 Node cases in11 groups,14 UI checks and80 recipient-upload checks passed, with no skips or cancellations. Installed stage1 failed: the unchanged native Submit button was prepared successfully, but later preparation reported a page-feedback change and no form submission occurred. Stages2–21 and the main/security tails were not reached. Partial coverage is40.61% lines/statements,69.47% branches and57.27% functions; it does not qualify the full suite. This historical recurrence was investigated as a general preparation-timing defect; the unchanged failed result remains preserved. A capture-only isolated diagnostic reproduced initial native preparation success followed by reprobe failure; its first local-veto log was read from the wrong JavaScript world and is not clause-level evidence. A separate corrected ISOLATED reader reproduced the failure and captured one existing beforeLocalDispatch refusal: model binding was invalid with a pending DOM change classified unknown, while layout, prepared binding, user input and local/current/prepared revision remained unchanged. All original production inputs and authority stayed unchanged; the copied monitor differs only by diagnostics inserted after an existing veto is selected. This is a disposable headless form test, not an authenticated account run. The controlled held-pointer-ACK regression and narrow preparation-phase repair were reviewed and applied in Source71 before the latest no-fix instruction. Source71 full C8 subsequently passed this form and failed at stage12, as recorded above.

Execution8 failed terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/product70-repository78-isolated-normal-coverage-before-real120-execution8-actual-4552cd4a-6f69-4d8d-a76f-cbb6f0505cfb/terminal.json`), independent execution8 review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product70-repository78-isolated-c8-execution8-independent-historical-readonly.json`), first preserved diagnostic (local evidence: `ci/artifacts/quality-audit-2026-10-07/source70-native-local-preparation-veto-capture-actual-85902406-3864-45f7-85cf-4b0af71916d1/result.json`), corrected isolated-world veto (local evidence: `ci/artifacts/quality-audit-2026-10-07/source70-native-local-preparation-veto-capture-actual-a65c8537-d62f-4937-8f4c-850868d80e22/evidence/local-veto-log.json`), independent corrected diagnostic review (local evidence: `ci/artifacts/quality-audit-2026-10-07/source70-native-local-preparation-veto-capture-independent-historical-readonly.json`).

Standalone fixture proof (local evidence: `ci/artifacts/quality-audit-2026-10-07/staged-download-owned-id-fixture-candidate/candidate-proof-final.json`), actual fixture-only application (local evidence: `ci/artifacts/quality-audit-2026-10-07/product69-repository77-reviewed-download-fixture-only-actual-9a5ba887-b3a5-4df3-9010-a54e85f5bdb1/actual-application.json`), Repository77 normal build (local evidence: `ci/artifacts/quality-audit-2026-10-07/product69-repository77-normal-build-only-actual-5822b175-e885-4016-9873-ba16c5b6c278/result.json`).

Source69 actual application (local evidence: `ci/artifacts/quality-audit-2026-10-07/product69-repository76-reviewed-calculation-replacement-only-actual-97b4facc-ee38-4bef-91da-57f9cc3224f3/actual-application.json`), 398/398 same-source regression (local evidence: `ci/artifacts/quality-audit-2026-10-07/explicit-calculation-replacement-candidate/revision3/root-whole-literal-execution/green-terminal-actual.json`), independent classifier review (local evidence: `ci/artifacts/quality-audit-2026-10-07/explicit-calculation-replacement-independent-historical-readonly-revision3.json`), normal build (local evidence: `ci/artifacts/quality-audit-2026-10-07/product69-repository76-normal-build-only-actual-1714c726-b31a-4c82-bbab-894566dbef36/result.json`), actual loaded runtime (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product69-repository76-main8215-source-proof-actual.json`), independent loaded-code review (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product69-repository76-main8215-source-binding-independent-historical-readonly.json`), execution6 failed terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/product69-repository76-isolated-normal-coverage-before-real120-execution6-actual-8b8a8bc7-aa19-4589-b0ee-94171e1d82ee/terminal.json`), independent execution6 review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product69-repository76-isolated-c8-execution6-independent-historical-readonly.json`).

#### General repairs

The DOM monitor repairs apply across control families and websites. Existing regressions cover decorative SVG changes, unchanged native controls, app-owned preparation and acknowledged native input amid unrelated rendering changes. Source70 full C8 exposed a remaining false refusal when a passive counter changes while preparatory pointer movement is awaiting its native acknowledgment. Source71 repairs that interval for an exact existing model-bound operation and privately distinguishes its selector pre-scroll from consequential input. The159-case same-file causal comparison passes, including unchanged ordinary buttons and field focus, immediate unreported private-value drift, prior finished input, native wheel, concurrent input and forged public phase arguments. Queued unknown feedback during selector scrolling itself remains conservative; this repair never clears it. Material target, document, recipient, task, frame and human-input changes still invalidate stale authority. Source65 closes an exactly owned, fully acknowledged native press/release operation before read-only network settling; unknown or blocked dispatch does not gain that completion authority. There is no Bluesky-button exception. Current full C8 execution9 failed. Source71 loaded user-Chrome binding, current native task replacement and current WhatsApp self read-only completion are separately qualified; Telegram bootstrap and real-account endurance remain unqualified.

Other applied repairs cover mid-run task corrections, exact calculation completion, current-run output evidence, owned draft recovery before Enter, pending delivery retention, numeric native message floors, scheduler/lifecycle recovery, provider schema handling, and generic file-input ownership/chooser handoff. Localized planner display text no longer becomes executable authority. Earlier failed attempts remain preserved.

A general scheduling cancellation race is repaired in Source70. Agent tools could create a new durable job and alarm after Stop or accepted task replacement during asynchronous tab lookup, conversation persistence or the scheduler storage queue. The repair captures the original run/task owner and serializes new-job persistence, alarm creation and exact-new-job cancellation within the existing queue. Early alarms wait for this commit or rollback before tab setup. If both cancellation persistence and alarm clearing fail, a private hold on only the newly created job blocks waiting and later alarms and manual Run now in that manager; uncertainty remains explicit. An acknowledged cancellation/delete releases the hold. Previously valid duplicate jobs and direct UI scheduling remain covered. The initial146-test causal checkpoint reproduced56 failures on Source69 and passed after its candidate; delivered-alarm regressions then reproduced four more failures before the barrier, and the final combined-cleanup cases reproduced four failures on frozen V4 (152/156) before V5 passed156/156, with no skips or cancellations. All original46,425 test bytes and164 assertion-containing lines remain, plus the earlier new regressions. Root and an independent reviewer checked all51 exact byte regions and closed causal evidence before application. If all durable cleanup operations fail and the worker restarts, durable cancellation cannot be guaranteed; this is explicitly reported rather than silently retried. These isolated checks do not qualify loaded Source70 execution or real120.

Frozen final scheduling regression proof (local evidence: `ci/artifacts/quality-audit-2026-10-07/scheduled-creation-cancellation-candidate/candidate-proof-final-v5.json`), Root independent candidate review (local evidence: `ci/artifacts/quality-audit-2026-10-07/scheduled-creation-cancellation-final-v5-root-independent-readonly-review.json`), independent final candidate review (local evidence: `ci/artifacts/quality-audit-2026-10-07/scheduled-creation-cancellation-independent-historical-readonly-final-v5.json`).

Authenticated generic downloads now validate every literal redirect destination before contacting it, refuse private literal destinations and return cross-origin destinations for a fresh normal permission decision. Chrome saves only the staged local blob after the authenticated stream is bounded and written to disk. Stop releases the in-progress stage. DNS resolution/private DNS rebinding is still outside this literal URL check, and full Firefox authenticated native transport remains unqualified.

A real Chrome regression in Source65 changed the requested filename `wb_qa_download_20261010.png` to a blob UUID despite correct PNG bytes. Source66 applies the general repair: remove the global Chrome filename listener and resolve known filenames before each native download. Empty preferences preserve the requested name; invalid paths remain native errors. A related Stop boundary now checks the actual linked run signal after the asynchronous filename preference read for screenshot, full-page screenshot and crop; cancelled crop cannot fall through to a different downloader. The existing default network test import is retained. Isolated naming validation passed19/19; production Stop tests first reproduced three unwanted saves and then passed. Applied-source default network117 and main2,450 checks passed. The Source67 user-browser retest passed: exactly one download, ID615, saved the requested `wb_qa_download_20261010.png`; actual disk bytes were258,958,512×512, SHA256 `505f8b0e6603b308bed4e7796a5cedb5783611f84828ac10e75bec09142fbf38`. Both live/stored success flags were true, with15.422 seconds elapsed and zero Root business inputs after native submission.

Real filename failure (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product65-repository69-main-native-download614-actual.json`), applied filename and Stop patch (local evidence: `ci/artifacts/quality-audit-2026-10-07/product66-repository70-reviewed-filename-routing-source-only-actual-aebd09ca-6385-4cc0-b510-27a9b6c0afe0/actual-application.json`), independent final patch review (local evidence: `ci/artifacts/quality-audit-2026-10-07/download-filename-linked-stop-final11-independent-historical-readonly.json`).

#### Practical results

| Flow | Evidence and limits |
|---|---|
| Native download filename | Source67 normal user-Chrome Act passed with download615 and the exact requested filename. Actual PNG bytes, both success flags and one physical submission were independently verified; earlier UUID failure remains preserved. |
| Exact calculation | Source65 used actual calculate and done tools, returned `69135802476913580247.125`, and finished in 13.237 seconds with live and stored success both true. |
| Native mid-run task change | Current Source71 independently passed in17.787 seconds with one correction, zero old tool actions, exact arithmetic and separate normal done; current before/after bot native snapshots match. Historical Source69 owned-bot retake passed its native completion checks in19.501 seconds. One original Return and one correction Alt+Return were physically entered; correction applied once after actual MAIN thinking, and only calculate then separate done executed. Both live and stored successfulDone/runSucceeded flags were true, the exact result matched, and the observer closed without a pending run. Fresh read-only native evidence confirmed the same bot document, empty editor, Start6672 only and zero new messages. Loaded source proof was fresh at input and completion. This qualifies this owned-bot replacement; accepted-RPC timestamp, original MAIN payload ordering and separate Saved Messages draft preservation are not independently claimed. An earlier Source69 attempt missed the Root bridge deadline before correction; collector/post-input setup errors were also preserved, without repeating business inputs. The prior Source68 actual retest failed: the one native correction was applied at revision1, zero superseded tool actions occurred and one actual calculation returned the exact `86419752308641975230.125`, but first done incorrectly entered LLM verification and both terminal success flags were false. An unwanted later chat_observe was refused by the normal recipient binding guard. A fresh native bot read confirmed only the original Start6672, empty editor and zero bootstrap bodies. Source69 applies the general task-classification repair and passed the actual retake; this prior product failure remains preserved. Source61 passed: an in-flight Telegram inspection was replaced by calculation, with revision1, zero superseded tool actions, correct arithmetic, separate done, both success flags true and preserved foreign [protected draft content] drafts. The Source65 retake did not start a WebBrain request because Root's asynchronous window focus raced physical input. One accidental QA self-message was deleted; both [protected draft content] drafts and original video4082 were independently verified unchanged afterward. This is an unqualified Root input attempt, not a product pass or failure. |
| YouTube avatar | Source57 completed the exact canonical avatar prompt on Vatansever Cephe, `UCVB3sGJ6VIKsYN4W2SeTMgQ`, including product Publish and both success flags true. A fresh native reload verified the brain avatar persisted and Publish was disabled. The originally supplied UC2 channel was inaccessible and was not modified; no new channel was created. This is historical live evidence, not a Source65 retake. |
| WhatsApp | Current Source71 own-self read-only observation independently qualified in27.220 seconds: one native Return, one chat_observe and separate successful done, both success flags and matching native snapshots; no sends. Raw QA observer false fields and its wrapper/enum measurement defects are preserved and separately explained. Source71 isolated contact matrix passed15/15; earlier Source68 evidence is retained. Two historical self messages and one explicitly authorized personal-contact message remain tracked. No current two-hour WhatsApp run or new delivery proof is qualified. |
| Telegram owned bot | One QA bot exists and was started once. No bootstrap body has yet been delivered or independently verified. The real 120-minute run has not started. Earlier failures were before physical Enter and retained as failures. |
| Long local chat | A historical isolated two-hour native-chat fixture covered restarts, compaction and Stop/Continue. It is not authenticated Telegram or WhatsApp endurance. |
| Firefox | Paired source/build and fixtures are qualified. Optional Firefox148 BiDi never reached trusted interaction because native tab creation timed out even without the extension. |

Source65 calculation (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product65-repository69-main-native-calculate-actual.json`), Source65 Root focus error and verified cleanup (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product65-repository69-root-focus-race-and-saved-cleanup-actual.json`). Detailed earlier attempts remain in the preserved chronological reports and their exact traces; passing newer evidence does not relabel old failures.

#### GitHub Code Scanning

The earlier authenticated read-only GET completed on October10 at18:41UTC against current Source71/Repository79 and contained115 alerts:77 open,38 fixed and none dismissed; all77 open findings are high severity. Raw alerts and analyses are byte-identical to the prior authenticated Source66 capture. The latest main analyses use CodeQL2.27.2 against6da190593be3990dceb83396fb42b9e779ef9f1e, with69 JavaScript/TypeScript findings, eight Python findings and zero Actions findings, with no analysis errors. These refer to committed code and do not scan or qualify the uncommitted repairs. All77 open findings retain per-alert review:36 locally addressed/mitigated cases and41 conditional trust cases. No remote alert was dismissed or closed by this audit.

Source66 local comparison completed for all 77 findings and 80 named supporting files, with two stable reads and no missing or ambiguous inherited anchors. That historical Source66/Repository72 independent reconciliation joined all 77 alert IDs to its fresh remote capture and rehashed all 80 pins twice against Repository72, plus an additional Firefox staging mirror. Alert states, rules, messages, locations and reported commits were unchanged; only newer analyses and the CodeQL version changed. This preserves the prior 36/41 dispositions; matching code anchors alone does not close a vulnerability. Direct review of the new authenticated download sink verified the per-hop literal URL restrictions and retained the DNS/SameSite/Firefox limitations. The Repository71 and Repository72 test fixture corrections change no product or named security source bytes. Coverage, loaded-user-runtime, bootstrap and endurance remain separately unqualified in the security record. The download repair does not automatically close unrelated plain-text decoder, research-link metadata, serializer, vendor or conditional HTML trust findings.

Source66 per-alert source comparison (local evidence: `ci/artifacts/quality-audit-2026-10-07/code-scanning-product66-repository70-local77-actual.json`), direct authenticated download sink review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product65-repository69-authenticated-download-sink-readonly-note.json`). The private web page's earlier404 response was not interpreted as zero findings; authenticated `gh api` access is available.

Saved authenticated capture (local evidence: `ci/artifacts/quality-audit-2026-10-07/code-scanning-final-repository72-20261010T125456340Z-009be199/code-scanning-final-capture-manifest.json`), prior Source69 per-alert reconciliation (local evidence: `ci/artifacts/quality-audit-2026-10-07/code-scanning-product69-repository76-current-local-reconciliation-independent-historical-readonly.json`), current Source70 local application/security reconciliation (local evidence: `ci/artifacts/quality-audit-2026-10-07/code-scanning-product70-repository78-current-local-and-application-independent-historical-readonly.json`).

The Source70 independent local review rehashed the inherited80 supporting files plus both Scheduler implementations twice. All37 alert-referenced files,104 inherited support anchors and48 contexts remain stable; all77 saved remote IDs remain mapped. The four new product changes add no recipient exception or permission grant. The same36 local mitigation/41 conditional dispositions remain explicit, alongside the scheduler restart and DNS/SameSite/Firefox limits. This historical local reconciliation is superseded by the final Source71 authenticated GET and independent77-ID join below; real-account endurance was not achieved.

The Source71 current local/application reconciliation (local evidence: `ci/artifacts/quality-audit-2026-10-07/code-scanning-product71-repository79-current-local-and-application-independent-historical-readonly.json`) and final authenticated independent reconciliation (local evidence: `ci/artifacts/quality-audit-2026-10-07/code-scanning-final-product71-repository79-independent-historical-readonly.json`) join the exact77 open IDs to the fresh remote capture and rehash83 current named/support pins twice (80 inherited files, both Scheduler implementations and CDP). All37 alert-referenced files,104 support lines and48 contexts remain bound. State/rule/path/location/commit are unchanged. The36 local mitigation/41 conditional dispositions remain explicit, alongside DNS/rebinding, privileged authored/system HTML trust, SameSite/referrer and full Firefox transport limits. The four-file preparation-phase change adds no sink, recipient grant, completion proof or unknown-feedback clearing. Remote scans cover committed main; normal source binding, selected live checks and separate60-case security PASS do not constitute remote closure or full C8/endurance qualification.

Final authenticated capture (local evidence: `ci/artifacts/quality-audit-2026-10-07/code-scanning-final-repository79-20261010T184126293Z-14381bb5/code-scanning-final-capture-manifest.json`).

[GitHub Code Scanning](https://github.com/esokullu/webbrain/security/code-scanning).

#### Historical scope and tracked effects

Historical analysis covered 33 reports, 20 prioritized families and 4,657 traces across 208 journeys. These were analyzed and linked to regressions; they were not all replayed live against original recipients.

- Only the YouTube channel Vatansever Cephe was changed.
- Retained Telegram bot: `wb_quality_20261009_2312_bot`; one manual Start, zero verified bootstrap deliveries so far. Credentials are outside Git.
- Retained Bluesky QA account: `webbrainqa1008.bsky.social`; no posts, DMs, likes or follows.
- Retained Mastoturk QA account: `webbrain_qa_20261007`; ten QA posts were deleted and deletion verified.
- WhatsApp: two historical self messages and one authorized personal-contact message; no other real-person DMs.
- Source65 accidentally created one QA Saved Messages self-message during Root setup, then deleted it and restored the protected draft. No message was sent to another recipient.
- Download615 is retained as `wb_qa_download_20261010.png` in the local Downloads directory, with the exact requested name and verified canonical PNG bytes.
- Download614 is retained as the UUID-named 512×512 PNG, 258,958 bytes, SHA256 `505f8b0e6603b308bed4e7796a5cedb5783611f84828ac10e75bec09142fbf38`.
- The temporary trace-access credential was revoked; the user's original credential was not revoked.

The intermittent full-form failure was reproduced again in an ordinary installed run with capture-only diagnostics: initial native preparation succeeded, but the read-only reprobe returned `pageFeedbackPending` before any button press. A neutral regression reproduced how the dispatched, unfinished preparation movement can make a later unrelated counter update become unknown feedback. Source67 closes only the acknowledged preparation movement before reprobe and retains the original private model certificate. The first reproduction did not record the exact mutation timing inside its108ms preparation interval; that limitation remains explicit. The126/126 candidate checks cover passive updates after completion and retain queued unknown feedback during a held ACK, lost ACK, private field changes, replaced target objects, point changes, trusted human input, stale owner/document, Stop and steering. A real content deadline refusal now retains its error instead of claiming that the button changed. The applied installed form passed. Execution4 then passed all6,763 Node cases,14 UI checks,80 recipient-upload browser checks and installed stages1–5, but failed stage6 on WhatsApp contact identity after an acknowledged native Close. The remaining15 installed stages and main/security tail were not reached. A separate ordinary positive diagnostic repeated the same canonical-contact failure with zero messages. Source68 applies the private contact read-preparation routing repair; its complete isolated15-case matrix now passes. This scoped result does not relabel the failed Source67 coverage command or qualify full C8 execution5.

The current report-only verification pass is closed. Separate remaining installed/main/security diagnostics, current WhatsApp self read-only testing, final authenticated Code Scanning reconciliation and temporary tracing cleanup completed with their actual outcomes preserved. Source71 normal full C8 execution9 failed and was not repeated unchanged; the held stage12 fake-provider candidate remains unapplied. The newly generated wrong-goal Telegram plan and the general native-completion false negatives remain open product/model findings under the latest no-fix instruction. Native task replacement and WhatsApp own-self read-only completion passed. The one current owned-bot bootstrap failed without any chat_send or physical Enter, so real120 prerequisites were not met and no120-minute real-account run started. Historical controlled soaks cannot qualify real-account endurance. The quality goal remains unmet; this report does not claim a bug-free release.

Temporary tracing was restored after explicit idle checks on all16 open HTTP tabs and zero active jobs. Only losslessTrace and tracingEnabled were removed, matching the saved originally-absent baseline; every other local setting retained an identical digest and key count. Current QA observers/listeners are closed. The exact active identity of the Root-created Main8307 was verified, then that sole temporary tab was closed with one native Ctrl+W; user/unknown tabs were retained. Chrome was left on the completed WhatsApp own-self task. Owned Main cleanup (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-main8307-native-close-actual-4256487d-c809-42fa-8e8d-efca5812f799.json`). Actual tracing restoration (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-temporary-tracing-restored-actual-f8bc5afb-bc4b-4adb-a89f-a6c9968e65c6.json`). Final read-only upstream check still returned main6da190593be3990dceb83396fb42b9e779ef9f1e; local HEAD matches. Original index SHA7b96d37839cac8822737c3741404636980138a1b729bd9174492901a9ba24e46, package/lock and protected authority remain unchanged. No staging, commit, push, reset or stash was performed.

Source69 actual native completion qualification (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product69-repository76-bot148-native-midrun-retake2-root-qualified-actual.json`), Source69 raw observer (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product69-repository76-bot148-native-midrun-retake2-observer-terminal-actual.json`), independent native qualification (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product69-repository76-bot148-native-midrun-retake2-independent-historical-readonly.json`), preserved Source68 native failure (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product68-repository74-bot148-native-midrun-observer-terminal-actual.json`), native input record (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product68-repository74-bot148-native-midrun-input-actual.json`), fresh bot state after failure (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product68-repository74-bot148-native-after-midrun-readonly-actual.json`).

Source67 user-runtime binding (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product67-repository73-main8199-source-proof-actual.json`), actual native filename success (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product67-repository73-main8199-native-download615-actual.json`), independent download615 filename and disk-byte verification (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product67-repository73-main8199-native-download615-independent-historical-readonly.json`), execution4 raw failed terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/product67-repository73-isolated-normal-coverage-before-real120-execution4-actual-82e6bf20-05c2-4956-9b42-e1d0f8a59063/terminal.json`).

Historical Source68/Source69 security work: Source68 local review rehashed all80 named/support pins plus the Firefox staging mirror twice and bound the exact two-file application. All37 alert-referenced files,77 saved remote alert IDs and104 inherited support lines retain current anchors. The contact-routing repair adds no sink, permission grant, recipient exception or waiver of unknown feedback. The saved authenticated capture remains115 alerts:77 open and38 fixed; it was captured against Source66/Repository72 and committed main, with no new GET or remote closure claimed for Source68. The36 local mitigations/41 conditional dispositions, DNS resolution and Firefox transport limits remain explicit. Source69 independently reconciled all77 saved alert IDs and80 supporting pins twice; only the paired classifier support files changed. All37 alert-referenced files and104 supporting source anchors remain stable. The new grammar introduces no sink, authority grant or receipt waiver, preserving the36/41 dispositions and stated DNS/SameSite/Firefox/privileged authored-HTML trust limits. Source69 loaded runtime and actual owned-bot mid-run completion are verified; C8 execution6 failed at the stale download fixture. Bootstrap, real120 and overall END qualification remain separate and unfinished. No new authenticated GET or remote closure is claimed for Source69.

#### Additional report-only scope closure — October 10

A requirement-by-requirement audit found20 ordinary default commands after the runtime-lifecycle group and before node test/run.js that had not run on Source71. The failed C8 invocation stopped inside runtime-lifecycle; the separately passed main/restoration/benchmark/security tail did not include these20 commands. All20 have now run once, unchanged, through two disjoint ordinary diagnostics: original commands1–9 passed,10 failed, and previously unstarted11–20 passed. No failed command was repeated. This is19 passing commands and one failing command; raw Node summaries total298 cases,296 passed and two failed, with zero skips/cancellations. Custom PDF, accessibility/UI, toolbar and attachment assertions are separate from those Node totals. Both runs preserve all18,074 inputs, all1,180 physical source/build pairs, original authority and separately pinned support files. The default suite and full C8 still fail.

Both failures are in test/cloud-run-outcomes.mjs:131. That test extracts _scheduleAutoProgressResume and calls it on a fake receiver that lacks _scheduleCreationContext. The current real Agent defines that helper in both browsers. TypeError occurs before the cloud/native routing assertions, so this establishes an obsolete extracted-test dependency, not a reproduced production Cloud scheduling failure. The default test remains unchanged under the report-only constraint. Profile sync2/2 and MemCode recall3/3 now pass their whole offline test files; real sync/OAuth, user preference recall and large grounded extraction remain separate missing qualifications.

First10 raw result (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-unreached-default-tail-actual-a6159b69-b692-483b-9671-23ba727a2cac/result.json`), first10 independent causal review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-default-tail-first10-independent-recent-readonly-4b02de0e-6e9e-4525-9984-cb56381b36bc.json`), remaining10 raw result (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-unreached-remaining-default-tail-actual-a11261e6-a850-446f-a93f-c385530977d4/result.json`), remaining10 independent review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-default-tail-remaining10-independent-recent-readonly-b9889d20-e95e-444e-a225-d2fd7137114b.json`).

The unchanged optional installed Watch test now passes current Source71 in160.391 seconds. Five actual automatic alarms have intervals31.422,39.861,33.112 and40.910 seconds. The baseline causes no acknowledgment; release11 and release12 are each acknowledged once; actual worker stop/restart discards its globals and preserves the prior event; duplicate acknowledgment is suppressed. Stop removes the owned helper/alarm and permits zero late mutations. Three subsequent failure checks retain their baseline and stop terminally with helper/alarm cleanup and no revival. The model and local application are fixtures; the MV3 scheduler, alarms, native actions and worker restart are real. There are no external messages/accounts. This is controlled scheduler qualification, not real-account endurance. The raw wrapper qualified:false remains unchanged; the actual assertion evidence and independent review establish the narrow pass separately.

Current Watch terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-optional-watch-actual-40f974d6-71e3-4048-aeaa-c63c48e80e8f/terminal.json`), current Watch actual evidence (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-optional-watch-actual-40f974d6-71e3-4048-aeaa-c63c48e80e8f/watch-artifacts/evidence.json`), independent current Watch review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-optional-watch-independent-historical-readonly.json`).

The unchanged optional WebMCP test also passes once in a disposable Chrome154.0.8037.97 context with extension40.0.8. Actual CDP discovers, invokes, rejects and removes tools (three added/three removed); current Agent/CDP assertions exercise feature/mode gates, paginated and cross-frame catalogs, forged metadata refusal, invocation failures and stale IDs. Source/build/authority remain exact, and the historical355-byte log is retained byte-for-byte. The test does not attach to user Chrome or use accounts/providers. It does not establish runtime default settings, a global network firewall or packet census, all-site success, remote security closure or full C8 qualification.

Current WebMCP terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-optional-webmcp-actual-d7a6e0dd-2d5f-4c5e-8392-f489d2a6b7de/terminal.json`), unchanged-command actual output (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-optional-webmcp-actual-d7a6e0dd-2d5f-4c5e-8392-f489d2a6b7de/run.log`), independent current WebMCP review (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-optional-webmcp-independent-recent-readonly-acd5473d-c649-4ad0-9535-8a4ceb30b454.json`).

A new static disclosure finding remains report-only: web/index.html3797/3842 makes blanket no-telemetry/zero-leakage claims, while privacy documentation and the default Compass configuration describe enabled Help Improve collection and operational metadata. Client config, provider manager, settings and request-header code agree on default-on Compass Help Improve. This is a marketing/disclosure inconsistency; no undisclosed exfiltration or actual server retention was reproduced. Local/BYO sharing has a separate default-off policy. No marketing text, settings, provider/model behavior or product/default test was changed. Pinned disclosure finding (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-advertised-privacy-claim-default-compass-report-only-77b2dc3f-2afc-4891-aae2-22ed2cfb9bf8.json`).

The17-row advertised-feature matrix and independent historical requirement audit preserve the original scope. The4657 analyzed checkpoints,208 journeys,20 failure families and27 schema replays do not establish that every historical journey was executed again. The new default-tail and optional passes add bounded current evidence; the failed C8, general completion/provenance failures, wrong-goal Telegram plan and missing real Telegram/WhatsApp hours remain unresolved. No product/model/default-fixture repair was applied during this continuation. Existing accounts, messages, avatar and cleanup ledgers above remain the effect record; these new tests created no accounts or user messages.

Final advertised-feature matrix (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-advertised-runtime-claims-readonly-final-matrix-5ec5d160-6bd7-44d2-bd4d-228568bf97ba.json`), original-scope historical gap audit (local evidence: `ci/artifacts/quality-audit-2026-10-07/product71-repository79-original-scope-historical-replay-gap-independent-historical-readonly.json`).


#### Source71 real-model large-table extraction and separate follow-up — report-only

After the user manually opened the extension Main page, Root re-established safe Chrome access and verified extension40.0.8,31 served module hashes, all18,074 repository inputs, all1,180 source/build pairs, and authority pins. The owned static loopback page contained172 inventory rows in shuffled document order plus a separate distractor table. The frozen oracle was outside the served directory and never exposed to the model. Root submitted each of the following two distinct questions once through the normal Ask composer and native Return, with no launch RPC, repair prompt, model/provider change or retry of the first extraction.

| Actual question | Delivered result | Qualification |
| --- | --- | --- |
| Extract every inventory row and preserve all four fields exactly |20 of172 rows,152 missing; numeric columns correct for the20 returned rows; every literal changed U+00B5 µ to U+0575 յ;0 fully correct rows;10.075s |**FAIL.** The response was the first20 rows in document order, with no duplicate or distractor rows. Stored Ask state was completed/runSucceeded=true; the requested all-row extraction was unmet. |
| A new question for10 specified IDs outside that prefix, in the same conversation |0 requested rows; candid inability to verify the values;2.999s;0 dispatched tool calls |**No data delivered.** No values were fabricated. This is a separate post-terminal question with its own task/request/run, not Continue, mid-run steering, a repaired first answer or an endurance test. |

The first run dispatched get_accessibility_tree(page1,maxChars12000), inspect_viewport and done. The full2,081-character incorrect JSON was already present in done.args.summary and matched the public terminal, stored finalContent and captured assistant text;13 public events were contiguous. The wrong glyph therefore predates display. The follow-up had50 contiguous public events and a complete241-character limitation response.

The source review shows that generic Ask success checks a nonempty response without listed runtime errors; it does not validate arbitrary table row coverage or exact literal correctness. Normal Ask retains conditional reading tools. The complete provider-facing request, actual tool schema/options, full AX response and hasMore/error fields were not captured, so the exact upstream cause of the20-row window and glyph substitution, and the follow-up reason for dispatching no tools, remain unproven. The known extract_data budget was not an actual cause in this run because no extract_data call occurred.

Public run_complete omits the stored success flags. The passive observer coerced those absent fields to false, while the later matching Ask journal/state reported runSucceeded=true. Both raw representations remain intact; successfulDone=false is recorded and is not required for Ask. The observer host was a separate Main realm, so exactTaskMatched=false and the SDK supplied no separate native action acknowledgment; ownership is supported by the exact task SHA/native-input ledger, owned tab, request/run and source identity, not a host-DOM user-message match.

Source and build hashes, index, protected helper and authority remained unchanged after both questions. The owned table1858378353 and Main1858378344 were independently read back as absent; both passive listeners were removed and the local server stopped. Unknown tab1858378339 was retained and the temporary readback console closed. No account, recipient, webpage setting, upload or message was changed in this scope. The latest read-only upstream lookup returned6da190593be3990dceb83396fb42b9e779ef9f1e; an explicit metadata erratum withdraws an unrecorded exact lookup second.

Evidence: Root actual closure (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-large-table-actual-99c94c87-fdfb-4bb7-bcc4-ded0be1529eb/root-closed-qualification.json`), all172-row gold comparison (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-large-table-actual-99c94c87-fdfb-4bb7-bcc4-ded0be1529eb/gold-comparison.json`), distinct follow-up outcome (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-large-table-actual-99c94c87-fdfb-4bb7-bcc4-ded0be1529eb/followup-outcome.json`), independent original-failure peer (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-large172-independent-historical-readonly.json`), independent follow-up/source/cleanup peer (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-large172-followup-and-cleanup-independent-historical-readonly.json`), source-level causal review (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-large172-and-followup-source-causal-readonly.json`), source preservation (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-large-table-actual-99c94c87-fdfb-4bb7-bcc4-ded0be1529eb/source-after-verification.json`), timestamp qualification correction (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-large-table-actual-99c94c87-fdfb-4bb7-bcc4-ded0be1529eb/remote-timestamp-qualification-correction.json`), and server/tab/listener cleanup (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-large-table-actual-99c94c87-fdfb-4bb7-bcc4-ded0be1529eb/fixture-server-closed.json`).

These are newly reproduced product/model deliverable failures, left unchanged under the current user constraint. They do not qualify a full C8 pass, every historical journey, hours of Telegram/WhatsApp chat, or a bug-free product.


#### Native Telegram delivery after normal New chat — current Source71, no fixes

A materially distinct ordinary Act test passed after the normal New chat confirmation cleared only tab1858378148's WebBrain QA history. Telegram's bot conversation and prior `/start` remained intact. A scoped native baseline independently bound numeric bot[owned QA bot ID], the current header/composer, document3769C03B16953F8758C7562703F0DF1F and epoch1791655714151.8. The composer was empty and only delivered `/start` ID6672 was mounted. New chat did not privately reset the agent or remove the old bootstrap driver's once key. The older failed wrong-goal run stays preserved and failed.

Root entered one366-character task through the actual Act sidebar and submitted one normal Return. The new request was `req_1858378148_1791663591541_buz2pv`, run `run_1791663592090_nqh6z3`, conversation `conv_1858378148_1791663591543_uzsapnflb2gl`. It completed after67.624s from the request timestamp, or67.725s from native Return completion. All96 public events were contiguous. The model dispatched17 public tools; the exact authorized body appeared in both of its two `chat_send` calls. The stored normal completion flags were both true.

Recovery was rough: two initial observations refused an unbound username route. The model followed the exact native profile repair, then tried generic controls and put the QA nonce in Telegram's search field. A click reported “Browser changed during action preparation.” The first send reported that the exact owned draft was verified but Enter was not dispatched. A pending-key observation followed; the second send reported that no new matching outgoing bubble had yet been observed. The model observed again and finished successfully, with no additional send after that uncertain result.

The independent native after-snapshot was captured28.941s after the terminal event. It retained the original document/epoch/numeric peer, latest viewport and empty composer. Its strict mounted window contained only `/start` ID6672 and one new delivered outgoing ID6679. That new message exactly matched the87-character authorized body, SHA `59c71693867de761720e91f9067940e8502fa8d8f8dd24fddca4fde407a063b5`; no second matching body was present. This supports one observed native delivery, not a measured total physical submission count or all-history coverage. The inactive Main observer could not match the submitting sidebar's user DOM; the exact Root task/hash/one-Return ledger and new owned request provide the task binding.

The official recorder had128 metadata events and18 recorded LLM requests/responses. Its tool arguments/results and provider wire were not recorded; tracing settings were not changed. Existing diagnostic notes show that all six `intervention_or_document` decisions retained documentMatches/currentRun/stateCurrent/sameDocument=true. Unknown same-document navigation or scroll can produce that generic classification. These notes do not prove human intervention or document replacement. The failed click was pre-dispatch, with zero trusted inputs and no synthetic dispatch. The exact veto operand, affected DOM targets and navigation URLs were not retained, so a specific false-positive monitor bug remains unproven. No Root content inputs occurred between native task Return and terminal completion.

At the original capture, internal pendingOutbound and retained document debt were NOT_EXPOSED. The later persisted-evidence section supersedes the pending/count limitation only. The first pending-key observation's `reconcile_pending_outbound:true` alone proves neither clearing nor bypass: current source also has a read-only branch for a privately known pre-Enter draft that retains pending state. Neither this single delivery nor both normal success flags qualifies the old strict bootstrap contract or a real120-minute run. No endurance controller was started. This test does not classify the previous wrong-goal failure as fixed.

Both source captures and all1180 source/build pairs matched the full18074-input Source71/Repository79 map before and after. HEAD/main/index/protected/package authority stayed unchanged. No product, model or default-test repair was applied. Only the originally reviewed c53a9cae/c4b2c850 QA definitions were invoked; later rewritten preparations were excluded. The original digest reader has a possible peer-switch race between its guarded reads; no actual switch or foreign draft read was established, and this result does not certify that reader across a conversation switch. Withdrawn QA metadata projections/filename guesses are separately corrected in the case directory.

Cleanup removed the listener and Root reader/preparation/raw-event globals, closed Root's DevTools Console, cleared the nonce search and closed the search/profile panels. Unknown Main8339 was retained, with one inert nonconfigurable resolved observation handle remaining in document memory. No new account, tab, bot API call, credential read or other-person message occurred in this case. The authorized QA bot message6679 is intentionally retained and tracked. Saved Messages' pre-existing protected draft was not edited.

Independent delivery/source review also completed in text. The attempt to write its new exclusive QA JSON receipt was automatically rejected as “blocked by policy”, without further explanation. No file was created and the rejected write was not retried. The linked independent review below covers invoked assets and the saved baseline only, rather than a new saved delivery certification.

Evidence: sealed one-delivery result (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-telegram-fresh-chat-actual-6d07ab12-5b78-4986-8e4a-c3616a232dd7/root-one-native-delivery-closure.json`), public terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-telegram-fresh-chat-actual-6d07ab12-5b78-4986-8e4a-c3616a232dd7/public-observation-terminal-actual.json`), same-document native after (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-telegram-fresh-chat-actual-6d07ab12-5b78-4986-8e4a-c3616a232dd7/native-after-actual.json`), exact diagnostic notes (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-telegram-fresh-chat-actual-6d07ab12-5b78-4986-8e4a-c3616a232dd7/official-exact-owned-run-diagnostic-notes-actual.json`), independent invoked-asset/baseline review (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-telegram-fresh-chat-actual-invoked-assets-independent-historical-readonly.json`), cleanup and retained effects (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-telegram-fresh-chat-actual-6d07ab12-5b78-4986-8e4a-c3616a232dd7/native-cleanup-and-effects-final.json`).

#### Persisted Telegram evidence and shared send-result inconsistency — report-only

On October10 at20:43–21:03UTC, Root read only the owned tab's official session keys agentConv:1858378148 and runUi:1858378148, paired with the public run state. The persisted, compacted39-message conversation retained eight intact relevant assistant/tool pairs. The genuine366-character user task, resume-task ID and delivery receipt match the original request, exact87-character body and native message6679. The original case files and recorder remain unchanged; this later evidence strengthens that single existing delivery.

The unchanged inert protocol dcccfe9c verifies two chat_send calls/results, one explicit submissionDispatched:false plus submissionOutcomeUnknown:false, and one later nested submissionDispatched:true. Its repair protocol passed. This is the contract's Enter-dispatch count; it is not a trusted hardware-keystroke measurement. A final same-thread observation verified the exact outgoing body, empty composer and pending:false. The saved current pendingOutbound field is explicitly null; stored and live completion flags are both true. Blanket absence of private editor-debt records remains unproven.

Root then made one bounded getMe → getWebhookInfo → getUpdates chain. All three returned200; identity matched the owned bot and the webhook was empty. The complete responses were saved privately before receipt inspection. Only one owner/private-chat update was present: update781136474, API message2, exact body SHA59c716…, server20:20:58UTC. That server timestamp numerically lies between the local native task timestamps20:19:51.312–20:20:59.165UTC, but the clocks were not calibrated contemporaneously. A later one-off unauthenticated HEAD (redirects disabled) measured HTTP Date approximately12.4 seconds ahead of the local Node/Chrome clocks. Numerical interval membership therefore does not establish chronological task-window containment; the exact body and owned identity joins remain valid. Native message6679 and API message2 are separate identifiers. No offset, allowed_updates, acknowledgement, retry or API message send was issued. Omitting offset avoids advancing the acknowledgement cursor; omitting allowed_updates preserves the existing filter. [Telegram Bot API](https://core.telegram.org/bots/api#getupdates).

A shared source-supported result bug is now confirmed in _sendChatWorkflow. On the second attempt the already verified draft needed no new draft dispatch, so nested dispatch.dispatched was false and success was true, while submissionDispatched was true and nested outcomeUnknown was true. The public dispatched flag correctly became true through success, but the unverified-delivery outcomeUnknown calculation used only draft dispatched/noDispatch and became false. The same calculation appears in the failed-read branch. It therefore reports an unverified Enter submission as not uncertain when an owned draft is reused. This is common chat-workflow logic, with no website-specific condition in the faulty calculation. No duplicate or unsafe actual retry was observed here: pending state remained and the model resolved delivery through observation. No repair was applied under the user's current constraint. [shared result calculation](src/chrome/src/agent/agent.js) (recorded line 25671).

Fresh read-only checks again matched all18074 recorded inputs,1180 source/build pairs and31 Chrome-served files to Source71/Repository79. HEAD and remote main remained6da1905; the index and protected script contract remained unchanged. A prospective baseline hashed40 explicit provider/execution keys without exporting values or writing settings. It does not retroactively prove provider settings unchanged in the original task. Both scheduling keys were absent, which the actual scheduler interprets as enabled and confirmation required, rather than disabled. [scheduler defaults](src/chrome/src/agent/scheduler.js) (recorded line 663).

The old literal bootstrap sealer and old controller were not invoked. Their original configuration still references retired tab7253, has a null root-proof path, and lacks the new typed bindings. Its scenario-specific body/prefix and15-minute API-inspection window also do not match this late receipt. The unchanged endurance core accepts a separately qualified body hash, but every ownership, source, prospective settings, pending, submission and receipt requirement must remain intact. A separate normal-UI long-session preparation was later submitted once; its timed question/reply phase did not start. The prior wrong-goal bug and exact monitor veto operand remain unresolved. See the final preparation closure below.

This diagnostic added zero tasks, messages or accounts. It read the owned credential privately for the finite API chain; the credential was never printed and its Root memory reference was cleared afterward. Private metadata, ledger and old once reservations were not changed. The existing QA bot message6679 remains the only new retained message from the previous case. Historical and Recent independently reviewed the saved evidence in text; no new peer receipt file was written.

Evidence: enhanced one-message closure (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-session-dispatch-proof-actual-80d3d761-a04a-4c74-9b74-573bd4bf2f81/root-enhanced-one-message-closure.json`), persisted tagged results (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-session-dispatch-proof-actual-80d3d761-a04a-4c74-9b74-573bd4bf2f81/owned-tagged-tool-results.json`), unchanged protocol evaluation (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-session-dispatch-proof-actual-80d3d761-a04a-4c74-9b74-573bd4bf2f81/unchanged-protocol-evaluation.json`), genuine task/receipt binding (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-session-dispatch-proof-actual-80d3d761-a04a-4c74-9b74-573bd4bf2f81/genuine-task-receipt-binding.json`), independent API receipt (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-session-dispatch-proof-actual-80d3d761-a04a-4c74-9b74-573bd4bf2f81/independent-api-receipt-proof.json`), fresh native identity (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-session-dispatch-proof-actual-80d3d761-a04a-4c74-9b74-573bd4bf2f81/current-native-readonly.json`), prospective settings baseline (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-session-dispatch-proof-actual-80d3d761-a04a-4c74-9b74-573bd4bf2f81/prospective-execution-settings-baseline.json`), explicit scheduler presence (local evidence: `ci/artifacts/quality-audit-2026-10-07/auth-product71-repository79-owned-session-dispatch-proof-actual-80d3d761-a04a-4c74-9b74-573bd4bf2f81/prospective-scheduler-setting-presence.json`).


#### Final distinct normal-UI Telegram preparation — HOLD before timed phase

Root submitted one new ordinary1082-character Act task through the actual sidebar after normal New chat. The exact native Return occurred at21:41:46.610–21:41:46.739UTC on October10. The authored request is req_1858378148_1791668506837_341fua, conversation conv_1858378148_1791668506840_cnzezw2sclmq and run run_1791668507501_6w6dbz, with genuine resume_task_b7a6c13e-7e43-42fa-aa32-cc39e2d65a9b. This was a distinct public-UI preparation, not a rerun or forged seal for the older strict bootstrap. No business/scheduler RPC, private Agent invocation or conversation-state write was used by Root.

The producer stopped HOLD before startedAt was assigned:0 questions,0 replies, no END notice, no Bot API send, no getUpdates, no offset change and no uncertain API write. Only getMe and getWebhookInfo were called, once each, both200. The lifetime once guard remains retained; this producer will not be restarted to bypass its stop. This is neither a timed two-hour pass nor a timed two-hour failure.

A separate model trajectory weakness is established. The successful chat_observe issued an exact read_latest repair: read the accessibility tree for pane ref_44433172736041, scroll that pane to bottom, then observe. The model instead read the global tree and clicked the pane twice. Both clicks were refused with native_telegram_latest_required. It then called done(partial), promising continuation when the composer became ready, without a schedule_resume call. Raw and live state independently ended completed with runSucceeded=false and successfulDone=false, zero owned jobs and zero owned alarms. No chat_send occurred. The scoped required-pane accessibility read and bottom-scroll were never issued. This is a model instruction-following and unscheduled-continuation finding, left unchanged under the user constraint.

The producer's HOLD was independently triggered by a successful generic anchor click lacking the app-private native read-repair marker. The anchor was the owned numeric bot route, but its result was verified:false/trusted:false with unchanged URL and scroll. This supports a conservative fixture stop, not proof of unsafe recipient interaction. The later native snapshot reports latest:true; it does not recover the earlier refused action's geometry or native end marker. A false latest/page-monitor predicate and its exact cause therefore remain unproven. No model/provider/tool workaround was applied to make the test pass.

Cleanup was independently read back. The producer exited normally and closed the local bridge; the passive collector removed its listener and timer, and only an inert once descriptor remains. DevTools closed, unknown Main8339 was retained, and no product run or owned scheduled job/alarm remains. The owned bot still contains exactly the previously observed /start native6672 and earlier87-character QA message native6679, with empty composer and no native pending message. No new account, bot message, webpage setting or other-person message was created by this preparation. Provider/settings hash6334e5f0b2a6c6e50b0476e94dc065f58a583df94b22f3612c2382ccb93602eb stayed identical; the whole private editor-debt map remains NOT_EXPOSED.

All18,074 source inputs, authority/index/protected files,1,180 physical Chrome/Firefox source/build pairs and31 actually served module hashes stayed identical before and after. No new product/model/default-fixture change, build or test rerun occurred. Both independent reviewers confirmed the finite public trajectory and the model/measurement distinction in text; no new peer receipt file is claimed.

Evidence: Root closed qualification (local evidence: `ci/artifacts/quality-audit-2026-10-07/owned-telegram-distinct-normal-ui-real120-PREPARED-87a8c77d4a30ec5a2d4a/root-closed-qualification.json`), actual repair and model calls (local evidence: `ci/artifacts/quality-audit-2026-10-07/owned-telegram-distinct-normal-ui-real120-PREPARED-87a8c77d4a30ec5a2d4a/actual-owned-repair-and-model-actions.json`), producer terminal (local evidence: `ci/artifacts/quality-audit-2026-10-07/owned-telegram-distinct-normal-ui-real120-PREPARED-87a8c77d4a30ec5a2d4a/producer-terminal-summary.json`), native after-snapshot (local evidence: `ci/artifacts/quality-audit-2026-10-07/owned-telegram-distinct-normal-ui-real120-PREPARED-87a8c77d4a30ec5a2d4a/native-after-actual.json`), stored/live/jobs/settings cleanup (local evidence: `ci/artifacts/quality-audit-2026-10-07/owned-telegram-distinct-normal-ui-real120-PREPARED-87a8c77d4a30ec5a2d4a/public-jobs-settings-after-actual.json`), and collector cleanup (local evidence: `ci/artifacts/quality-audit-2026-10-07/owned-telegram-distinct-normal-ui-real120-PREPARED-87a8c77d4a30ec5a2d4a/collector-cleanup-actual.json`).

#### Last read-only upstream and Code Scanning confirmation

The final saved alerts/analyses reads confirm115 alerts:77 open, all high severity,38 fixed and none dismissed. All115 reviewed state/rule/message/location/commit fields match the18:41UTC capture. Latest main CodeQL2.27.2 analyses still cover6da190593be3990dceb83396fb42b9e779ef9f1e with69 JavaScript/TypeScript,8 Python and0 Actions findings and no analysis errors; a separate read-only upstream lookup confirms the same main commit. The prior per-alert Source71 reconciliation therefore remains applicable:36 locally addressed/mitigated findings and41 conditional trust cases, with unchanged source bytes. These dispositions do not close remote vulnerabilities. GitHub has not scanned the uncommitted repairs; no alert was dismissed or closed and no GitHub write occurred.

Final saved security summary (local evidence: `ci/artifacts/quality-audit-2026-10-07/owned-telegram-distinct-normal-ui-real120-PREPARED-87a8c77d4a30ec5a2d4a/final-github-code-scanning-summary.json`) retains exact private raw-file pins and sanitized alert locations. The remote source is [GitHub Code Scanning](https://github.com/esokullu/webbrain/security/code-scanning). The complete C8/default suite, real-account endurance and bug-free objective remain unqualified. Newly established product/model defects are reported without fixes as requested.

#### Publication and first fresh PR CodeQL review — October 11

The fixes and public audit were committed as `50c8d73ad54190e61b1a7255e11af792ff42adf3`, pushed to `codex/quality-fixes-40.2.0`, and submitted as [PR #408](https://github.com/esokullu/webbrain/pull/408). The commit contains 391 reviewed files. All 29 excluded local files remain unchanged; private traces, credentials, account files and receipt archives were not committed. The 40.2.0 changelog entry remains Unreleased and the tested product runtime remains 40.0.8. A publication-only blank-line whitespace cleanup in the trusted preparation regression was independently rerun: **159/159 passed**, with no skips or cancellations.

On the exact PR head `50c8d73a`, Website Check and WebMCP E2E passed. All three CodeQL analysis jobs also completed successfully, using CodeQL 2.27.2 without analysis errors. The separate [CodeQL findings check](https://github.com/esokullu/webbrain/runs/114367191053) **failed**, reporting **32 alerts in changed code: 31 high and one medium**. Analysis execution success is not a clean findings result.

The authenticated PR-head analyses use `refs/pull/408/head`, not main or the synthetic merge commit. JavaScript/TypeScript analysis 1930333320 reports 60 results; Python analysis 1930324174 and Actions analysis 1930323569 report zero. The current PR-ref alert inventory contains **60 open alerts, 59 high and one medium**. Main still contains **77 open high-severity alerts**. Forty-five numeric alert IDs persist from main; 32 main IDs are absent from this PR result and 15 IDs appear only on the PR ref. These are scan comparisons, not remote closure or exploit-safety claims. No alert was dismissed or waived.

The bounded comparison covered the 32 changed-code annotations against the earlier 77-finding review. **Nineteen annotations reproduce previously reviewed semantic findings and 13 are newly flagged test/harness conditions.** Thirteen of the 19 retain their conditional trust assessment; two are website text-decoder paths whose final JSON script serialization encodes HTML-significant characters, and four are previously hardened report-rendering paths using escaped labels and finite/numeric cells. This does not grant those files a blanket security qualification.

The two new numeric product IDs, #241/#242, reproduce old #24/#31 at the paired AX option-value formatter. The option text/value formatting block and flagged quote-escaping source line are byte-identical to main; that source-line SHA-256 remains `fb4830809d4764fa0df9a2cf249c0406c39a231ddbc13145b733674b11c1cc8b`. Private formatter-origin tracking changed, and the scanner reidentified the existing representation warning. The AX text-ambiguity condition remains documented; this comparison does not fix or dismiss it.

The contextual review retains the following explicit limits:

- XML/article/network decoders produce readable text; they are not general HTML sanitizers. Recipient display normalization and CSS-selector fallback do not establish HTML safety.
- The JavaScript-scheme predicate participates in native anchor classification followed by URL/document checks; it is not a general safe-URL policy. Authored system HTML in the side panel remains a privileged trust boundary.
- WhatsApp fixture identity restoration writes character data. Script-extraction/replacement regexes operate on controlled checked-in fixtures and can require maintenance when templates change; they are not general HTML parsers.
- The `--only` filters intentionally accept regular expressions from the local test operator. The fake completion predicate is not production URL authorization. The dropdown probe uses fixed fixture markup; its current input origin is part of the assessment.
- The report-rendering and website-builder dispositions follow the final escaped/serialized sink, not an assumption that intermediate decoded text is sanitized.

One newly flagged condition exposed a concrete injection path in the disposable loopback workflow QA server: URL query values were interpolated into HTML and inline JavaScript, and `JSON.stringify` alone did not protect the script boundary. The follow-up restricts generation to the five existing fixture presets and mode to normal/uncertain, returning canonical constant literals. Invalid values receive a static 400 JSON response without reflection. Valid workflow fixtures retain their prior markup and replay semantics. This is a test-server boundary repair; no public-product or real-account compromise was established.

The whole installed workflow test completed once with exit 0 at 2026-10-11 02:28:34 UTC. **All five cases passed**, including six once-navigated malicious/unknown query browser/server checks and the original four workflow replay, Stop and uncertainty cases. All 34 original assertion-containing lines are retained. All 12 valid preset/default HTML combinations remain byte-identical. The 1,182 product files, fixture, package, lock and index stayed stable during execution; provider fallback requests and external calls were zero. The fixture SHA-256 is `02766f9c98ea758197586c49e213ca5ec85bb54c4c4b1901e714da3f41eab87c`. Local proof: `ci/artifacts/quality-audit-2026-10-07/publication-workflow-fixture-injection-fix-4d8e4c59-82d3-4f15-b0fc-27dbf4eac751/fix-proof-final.json`, SHA-256 `1cb662d4da3ccd38428a1398bb44dbfcb4ab6e73ba71861d031b0c976895fe43`.

This follow-up changes the workflow fixture and audit documentation only. The previously completed unfiltered C8 run and its coverage percentages remain dated evidence for the frozen audited product; they are not relabelled as a new full-suite run after the fixture edit. The initial PR-head security failure remains recorded. Further remote checks may run on the follow-up commit, and their actual results must be reported separately. Real-account two-hour endurance and the bug-free objective remain unqualified.

#### PR #408 Codex review follow-up — October 11

Codex's first review, on `50c8d73a`, identified concurrent cold UI snapshot reads cancelling one another. An `agent_run_state` read overlapping `beginContinuationRunUiSnapshot` after a service-worker restart could make the continuation treat a saved journal as absent and discard its progress and events. The correction is general and applies to both Chrome and Firefox.

`getRunUiSnapshot` now shares one in-flight storage read per tab. Starting a new journal or clearing a conversation still invalidates that read; a late result respects a newer live journal and cannot resurrect cleared state. A failed shared read releases its slot so a later read can retry. Only the paired snapshot-reader functions changed in shipping code.

Meaningful regression proof: with the added tests and original code, **64/72 passed and eight failed**; after the fix, **72/72 passed**, with no skips or cancellations. The cold continuation reproduction previously replaced persisted sequence 2 with sequence 0. It now preserves sequence 2, acknowledged sequence 1 and the retained event, then appends sequence 3. The tests also cover both original read completion orders, shared-read failure/retry and the existing clear/new-run fences.

Validation on the corrected source:

- `node --test test/run-ui-scheduled-lifecycle.mjs`: **72 passed**.
- Ten neighbouring persistence, startup, continuation, transport, CDP restart/clear and assistant UI test files: **155 passed**, with no failures, skips or cancellations.
- `node test/run.js`: **2,450 passed, zero failed**.
- Normal `npm run build:all`: both browser builds passed; all 1,182 source/build files matched.
- Syntax and whitespace checks passed. Main remained `6da190593be3990dceb83396fb42b9e779ef9f1e`, with no new upstream commits or merge conflicts. The 29 unrelated local files were preserved.

The full 9,765-case coverage run above belongs to the original audited source, before this follow-up. It was not rerun for this focused change. These results do not add a real-account endurance or fresh model-reliability claim. Runtime version remains 40.0.8.

Local evidence: `ci/artifacts/quality-audit-2026-10-07/pr408-cold-run-ui-snapshot-7f40172c-9f97-48e2-bdf7-6d22bf10069f/green-result.json` (SHA-256 `5f1f32a8e5a650dda11171f861dc8787981be3db90b01ff0e36b7a587e1a437f`) and the neighbouring/main logs under `ci/artifacts/pr408-review-cycle/`. Private artifacts are not published.

The completed scan of the preceding exact head `fa49ffef` now confirms workflow fixture alert **#234 fixed**. Its PR inventory contains 59 open alerts and one fixed alert among the same 60 IDs; no new alert IDs appeared. JavaScript analysis returned 59 findings without analysis errors, while Python and Actions returned zero. The separate findings check still reports **31 changed-code annotations: 30 high and one medium**.

The bounded review finds no additional confirmed actionable regression in the 18 test/report/builder annotations: current paths use text-node assignment, escaped or numeric output, HTML-safe JSON serialization, trusted fixture parsing or intentional operator-authored CLI regexes. The 13 shipping annotations retain their inherited conditional trust/fidelity assessments; their flagged statements are also present on main, but that comparison does not close vulnerabilities. No findings were dismissed or waived, and this is not a security-clean claim.

This correction requires a fresh Codex review. Merge readiness must use that review and the resulting head's checks; the earlier review and scan do not qualify a later revision.
