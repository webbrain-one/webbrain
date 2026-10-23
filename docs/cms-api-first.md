# CMS content through existing APIs

The nine `cms-*` packaged skills are DIV instructions, not Codex skills or
plugins. They operate on existing content models. They do not create schemas,
install plugins/themes, change settings/roles, grant app access, handle commerce
data, send newsletters, publish whole sites or deploy front-ends.

## Routing and loading

`agent/skills.js` registers the packages and seeds them as defaults through the
existing background loader. Settings removals write `defaultSkillsRemoved`;
startup introduces missing new defaults while respecting these tombstones and
the existing 20-skill capacity. Refresh updates only installed bundled records.
No new seeding marker, storage format or preactivation mechanism is needed.

Mid/Full receive names, short summaries and semantic intents in the catalog;
`load_skill`/approved planner selection activates the relevant recipe. Long
service instructions are absent until activation. Compact's skill system is
unchanged. `cms-adapters.js` supplies short conditional notes through the existing
adapter injection path and makes no skill-tool call. Matching supports standard
CMS-specific self-hosted paths and hosted admin domains. Generic `/admin`,
`/administrator`, `/studio` and `/desk` paths do not inject CMS notes. Webflow's
shared root hosts match only `/dashboard` and `/design/<site>` routes; hosted
`*.design.webflow.com` editors also match, while marketing/template pages do not.
Arbitrarily relocated editors are not automatically detected by this URL-only
matcher: the model can identify them from subsequent UI/API evidence, use the
narrow shared CMS rule, and in Mid/Full select the appropriate catalog entry.
Mere branding in public content does not authorize an admin workflow.

Loading is semantic selection by the planner/model, not a hard runtime check that
the CMS is installed and a content task exists. A CMS URL alone does not activate
its full recipe; URL-matched adapter notes can appear before a content task is
selected. The normal new-run reset clears active skills. The always-visible
catalog contains summaries, not nine recipes. Budget tests cap the nine-entry
loader description at 2,000 characters, one loaded recipe at 12,000, and a specific
CMS adapter at 1,300. Character budgets are not token counts or a guarantee about
model behavior.

All nine Markdown files and the CMS adapter module are byte-identical across
Chrome/Firefox. Browser-specific agent/tool code keeps its existing differences;
only the corresponding guidance changes are mirrored.

## Supported service contracts

Official references and concrete request recipes are in each linked package.
Reviewed 2026-09-30; verify the installed API version, site model and role before
each task. “API supports” does not mean “this browser session can authenticate.”

| Package | Official write API and content scope | Existing auth required / material limits |
|---|---|---|
| [Ghost](../src/chrome/skills/cms-ghost.md) | Admin posts, pages, tags; draft and web-only publish | Working session plus Origin/Referer, or existing signed Admin JWT; no JWT signer. `updated_at` collision checks, native Lexical, no newsletter sending. |
| [Drupal](../src/chrome/skills/cms-drupal.md) | JSON:API nodes in existing bundles and taxonomy | Enabled writable JSON:API, entity/field/workflow rights; cookie auth also needs session CSRF token. Core translation creation and moderation have limits. |
| [Joomla](../src/chrome/skills/cms-joomla.md) | Web Services `v1` articles and content categories | Existing `X-Joomla-Token`, API login and content ACLs; workflow-dependent state changes. PATCH preserves intro/full text. |
| [Webflow](../src/chrome/skills/cms-webflow.md) | Data API v2 staged collection items, references, per-item publish | Existing site/OAuth token and CMS scopes; CMS/localization depend on site plan/setup. No whole-site publication. |
| [Shopify](../src/chrome/skills/cms-shopify.md) | Versioned GraphQL Admin Blog, Article, Page | Existing Admin token, content scopes/staff rights; dashboard/Storefront auth is insufficient. Queries use gated POST too. Blogs have no draft flag. |
| [Wix](../src/chrome/skills/cms-wix.md) | Blog v3 draft posts, linked posts, categories/tags | Existing supported identity with Manage Blog, or authorized API key plus site ID. Rich Content and multilingual fields are conditional; no arbitrary Editor pages. |
| [Strapi](../src/chrome/skills/cms-strapi.md) | v5 Content REST API for existing types/relations | Scoped Content API auth differs from admin auth. Explicit `status=draft` is essential; REST writes otherwise publish. Draft & Publish must already be enabled. v4 is a separate contract. |
| [Contentful](../src/chrome/skills/cms-contentful.md) | CMA entries, localized fields, links, publish | Management token and space/environment/type rights; Delivery/Preview keys cannot write. Full-body PUT and version locking; locale publishing depends on plan/setup. |
| [Sanity](../src/chrome/skills/cms-sanity.md) | Content Lake Mutation and document Actions APIs | Existing project/dataset write auth; custom Studio cookies may not reach API. Schema knowledge and revision guards required. No AI Agent Actions or release-wide publish. |

## Permission and secret boundaries

Task authorization, DIV API mutation authorization and CMS access rights are
three separate conditions. A supported content API is preferred before editor
failure only when all are met. Missing `/allow-api` is requested once when it is
the remaining blocker; a valid prior/persistent grant is reused. Refusal leads to
an allowed UI fallback. Ask overrides existing API grants and blocks write-method
fetches, including Shopify read-only GraphQL POSTs. No gate implementation or
public tool schema is loosened by this change.

`fetch_url` executes in the background. It attaches cookies within the active
tab's registrable domain, which does not guarantee service authentication or a
matching page Origin/Referer. It accepts explicit headers/body and rejects
redirects before following. Auth headers are model-generated arguments, and a
CSRF discovery response can expose the token to the model and raw trace. These
packages supply no opaque credential injection; existing replay IDs only work
when the runtime already captured a compatible same-origin request. Strict
Secret Handling therefore often requires UI fallback. No instruction asks the
user to disable it.

Fetch responses are bounded text/JSON strings. GET continuation can recover a
large record; replaying a write to paginate is prohibited. Generic ETag,
Retry-After and other response headers are not exposed. Use JSON version fields
when offered; do not pretend a timestamp comparison is atomic locking or invent
unavailable preconditions. APIs lacking an atomic guard require fresh comparison
and possibly UI when the requested concurrency guarantee cannot be achieved.

## Integrity, recovery and publication

Recipes read the existing record first and retain its identity, type, language,
relations, format and publication state. New content starts as a safe draft when
supported. Unsupported rich text or required fields lead to the observed editor,
not lossy conversion. A successful HTTP response is followed by a fresh read.

Timeouts and partial responses are reconciled using known IDs, exact scoped
queries and documented endpoint mechanisms before retry or UI fallback. A lost
create response is not permission to create again. Multiple matching records
remain ambiguous. Auth/rights failures do not trigger retry loops. Existing
drafts, including partially completed API work, are resumed in the same editor.

Publication is limited to the verified item and requested outcome. Updating a
published object can affect live content and is never a reason to demote it.
“Published in CMS” and “visible on the website” are separate evidence claims;
pending builds, access restrictions and routing are reported without automatic
deployments, whole-site publishing or email.

## Validation layers

`node --test test/cms-api-first.mjs` exercises packaged catalog/loader behavior,
runtime skill activation, Compact exclusion and adapter matching, actual
background hydration plus Settings removal/re-enable across restart, storage
capacity, and Chrome/Firefox parity. It dispatches each CMS's representative
write through the existing agent batch API gate, including permission-off,
conversation/persistent approval, Ask override and GraphQL query POST cases.

Synthetic HTTP fixtures exercise the real `fetch_url` transport and agent gate:
title-only existing-draft read/update/read with type/locale/relations retained,
401/403/409/429/503 responses, redirect refusal and uncertain-create recovery by
GET. These are prescribed request sequences against a fixture server function;
they validate transport/contracts, **not autonomous model choices or a live CMS**.
Strict Secret Handling checks policy delivery, not a new enforcement mechanism.
The existing runtime/network/security tests remain the source for hard gates.

Eight `test/llm/scenarios/cms/201..208.json` replay cases cover uncertain creation,
version conflicts, insufficient rights, missing safe auth/Strict mode, partial
locale publication, stale public pages, permission refusal and Ask with a prior
grant. The existing scenario runner now accepts fixture-owned packaged/active
skill IDs and uses the production loader. The offline suite validates these
payloads and rubrics, **not model responses**. To evaluate decisions with an
explicitly configured model endpoint, run `node test/llm/run-scenarios.mjs
--category cms-api-first --tier full` (or `mid`). No live-model evaluation was
performed here. Compact package exclusion is tested separately; these replay
seeds do not reproduce live adapter injection.

No real account credentials, test content publication, account setting changes
or paid resources are used. Live service auth, custom editors, server-specific
workflows and actual front-end visibility require an authorized test installation;
they are not claimed as tested by Markdown checks or synthetic fixtures.

After `npm run build:all`, `npm run test:cms:browser` serves only built local
assets to headless Chromium and Firefox. It checks real browser module imports,
packaged Markdown loading, CMS routing and Compact exclusion. This is not an
installed-extension or live CMS editing test.
