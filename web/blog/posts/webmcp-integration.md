---
title: >
  WebMCP: Websites as Tools for AI Agents, and Why We're Excited
slug: webmcp-integration
sortOrder: -5
date: 2026-07-14
readTime: 5 min read
description: >
  WebMCP lets websites expose structured tools to AI agents. A conversation with Google's Gemini-in-Chrome team is pushing us toward integration, and we couldn't be more excited.
excerpt: >
  A new browser standard lets websites hand AI agents a menu of actions instead of forcing them to squint at screenshots. One GitHub issue sparked a conversation that could change how WebBrain works with the web.
titleTag: >
  WebMCP: Websites as Tools for AI Agents - WebBrain Blog
ogTitle: >
  WebMCP: Websites as Tools for AI Agents, and Why We're Excited
ogDescription: >
  WebMCP lets websites expose structured tools to AI agents. A conversation with Google's Gemini-in-Chrome team is pushing us toward integration.
twitterTitle: >
  WebMCP + WebBrain: Excited About the Agentic Web
twitterDescription: >
  WebMCP lets websites expose structured tools to AI agents. A GitHub conversation with Google's Gemini-in-Chrome team has us rethinking how WebBrain interacts with the web.
keywords:
  - WebMCP
  - browser agent
  - AI agent tools
  - WebBrain
  - Model Context Protocol
  - agentic web
  - W3C standard
  - web automation
author: Emre Sokullu
authorUrl: https://emresokullu.com
---

Right now, if you watch an AI agent interact with a website, you will see something absurd: a billion-parameter model squinting at screenshots, guessing which blue rectangle is the submit button, scraping DOM elements, and hoping nothing moved since the last refresh. It works, sort of. But it is the equivalent of dictating a letter by describing the shape of each letter to a calligrapher.

There is a better way, and it is coming to the browser.

## What is WebMCP?

[WebMCP](https://github.com/webmachinelearning/webmcp) is a proposed web standard — co-authored by engineers at Google and Microsoft, incubated through the W3C's Web Machine Learning Community Group — that lets websites expose structured "tools" directly to AI agents running in the browser.

Instead of an agent reverse-engineering a page's UI to figure out how to search, filter, book, or buy, the page itself declares what it can do: here are the tools, here are their inputs, here are the outputs. The agent reads the menu and calls the functions. No screenshots. No guesswork. No brittle CSS selectors that break every time the site ships a redesign.

The API surface is clean. A page registers tools through `document.modelContext.registerTool()` — JavaScript functions with names, descriptions, and JSON Schema input definitions. An agent discovers them, matches a user's intent to the right tool, and invokes it. The browser mediates the whole thing.

## The origin trial

WebMCP shipped in Chrome 146 Canary in early 2026, and as of June 2026 Chrome 149 has an open [origin trial](https://developer.chrome.com/origintrials/#/register_trial/4163014905550602241). The specification is still a Community Group Draft — not yet on the formal W3C standards track — but the trajectory is clear. Angular has experimental support. Cloudflare Browser Run supports it. The ecosystem is moving.

Early benchmarks show roughly a 67% reduction in computational overhead compared to screenshot-based agent interaction. Token usage drops dramatically — some estimates put it at 89% more efficient than pixel-based approaches. That is not a marginal improvement. That is the difference between a local model that can actually help and one that drowns in context before it clicks a single button.

## Why this matters for WebBrain

WebBrain reads the DOM and the accessibility tree. It does not take screenshots. That already puts us in a better position than pixel-based agents, but we still face a fundamental problem: the page was designed for human eyes, not for a language model trying to figure out which element to interact with.

WebMCP changes the equation. If a page exposes its capabilities as structured tools, our planner model does not need to interpret ambiguous UI states to act — it just needs to pick the right tool and fill in the parameters. That is faster, cheaper, more reliable, and safer, because the agent operates within a defined surface instead of having free reign over every element on the page.

## The conversation that started it

On July 8, [Dominic Farolino](https://github.com/domfarolino) — one of the driving forces behind WebMCP and the Gemini-in-Chrome team — opened [issue #305](https://github.com/webbrain-one/webbrain/issues/305) on our repo. The proposition was simple: WebBrain could find WebMCP tools through the Chrome DevTools Protocol and load them into the model's context, giving the agent a structured view of what the page can do before it tries to do anything.

This is exactly the kind of conversation we love. An external team with deep browser platform experience, looking at WebBrain and asking: how do we make this work better? The integration could be straightforward — discover tools via CDP, present them to the planner, let the model choose — but the implications are significant. It means WebBrain could operate on two levels: the general-purpose fallback of reading the DOM when nothing else is available, and the fast path of using declared tools when the page offers them.

We are excited about this. Genuinely.

## An invitation

This is what happens when people from different corners of the ecosystem collide. Dominic is building browser-native AI at Google. We are building local-first browser agents. WebMCP is the bridge between them, and the fact that someone from that world reached out to us tells us we are all solving the same problem from different angles.

We want more of these collisions.

If you are working on something adjacent to browser agents — whether it is a browser extension, a local model, an accessibility tool, an MCP server, or a product that relies on web automation — come talk to us. Open an issue. Start a discussion. Share your "faydali" ideas: the useful, the strange, the ones you cannot stop thinking about.

The agentic web is not going to build itself. But it might build itself if enough people with different pieces of the puzzle start comparing notes.

[Join the conversation on GitHub](https://github.com/webbrain-one/webbrain/issues/305) — and bring your wildest ideas.
