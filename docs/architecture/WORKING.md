# How Vane Works

This is a high level overview of how Vane answers a question.

If you want a component level overview, see [README.md](README.md).

If you want implementation details, see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## What happens when you ask a question

When you send a message in the UI, the app calls `POST /api/chat`.

At a high level, we do three things:

1. Classify the question and decide what to do next.
2. Run research and widgets in parallel.
3. Write the final answer and include citations.

## Classification

Before searching or answering, we run a classification step.

This step decides things like:

- Whether we should do research for this question
- Whether we should show any widgets
- How to rewrite the question into a clearer standalone form
- How time-sensitive the answer is (`freshness`: none, recent, current or historical)
- Which names must be searched exactly as written (`entities`: products, versions, error strings, standards)
- What kind of answer is wanted (`intent`: fact, how-to, comparison, troubleshooting, opinion, news, definition or other)

Searching is the default. The step skips search only for greetings and small talk, rewriting text the user supplied, arithmetic the calculation widget fully handles, questions about the conversation itself, and requests that say not to search. Anything that names a product, version, standard, law, place, person, price or date, asks for the latest or current state, asks how to do something on a real system, or compares things is searched, even when the model thinks it remembers the answer.

## Widgets

Widgets are small, structured helpers that can run alongside research.

Examples include weather, stocks, and simple calculations.

If a widget is relevant, we show it in the UI while the answer is still being generated.

Widgets are helpful context for the answer, but they are not part of what the model should cite.

## Research

If research is needed, we gather information in the background while widgets can run.

Depending on configuration, research may include web lookup and searching user uploaded files.

### Planning queries

Research is a loop: the model plans, calls a search tool, sees what came back, and decides whether to search again or stop. Each web search call carries one to three queries, and each query says what it is for: the direct answer, the official documentation, known issues, an independent source, recent changes, or one side of a comparison. A simple fact gets one query; a multipart or comparison question gets two or three aimed at different purposes. Names from the classification are kept verbatim, a year is added only for time-sensitive questions, and the model is shown every query already run so it does not repeat one. For time-sensitive questions the web search is limited to the last year (recent) or month (current).

Between searches the model does not see the full passages. It sees a short digest: one line per source with its number, title, domain, whether it is page text or only a search snippet, and the first 200 characters of its best passage. That keeps its context small; the full passages are kept for the answer.

### Checking for gaps

In balanced and quality mode, once the loop stops, one more model call reads the question and the digest and says whether the evidence covers it, what is missing (with a query for each gap), and where sources disagree. If something is missing, up to two of those queries are searched once, and their passages join the rest. This happens at most once per question and is skipped when the loop already took more than a minute. What the check found is passed to the writer as notes, so the answer can say what could not be found.

### Reading web pages

When research needs the full text of a page, Vane first fetches it with a plain HTTP request (10 second timeout, at most 5 redirects, HTML or plain text only, at most 2 MB, no cookies) and extracts the readable text. The headless browser is started only when that request fails or the page has under 400 characters of readable text, which usually means it is built by JavaScript. Before anything is fetched, a guard resolves the host name and refuses the URL if any address is private: loopback, 10/8, 172.16/12, 192.168/16, link-local (including the 169.254.169.254 cloud metadata address), 100.64/10, IPv6 local ranges, and names ending in `.local`, `.internal` or `.ts.net`. The guard runs again on every redirect, and inside the browser every page and frame request is checked the same way, so a public page cannot redirect the fetcher onto the local network. A refused URL is reported as a failed read, never as an error.

### Evidence

Search results are turned into evidence before the answer is written. Every search result starts as a snippet. In speed mode the snippets are ranked against the question and the best are kept. In balanced and quality mode the top pages (6 or 10) are fetched and split along their headings into short passages; code blocks and tables are kept whole and every passage carries its section heading. A small cross-encoder model running on the CPU scores each passage against the question (falling back to embedding similarity if it cannot run), and a budget of passages is kept with a cap per page and a minimum number of different pages. Each passage has a stable id, and each is labelled as a page passage or a search snippet so the writer knows which is which. The writer sees passages grouped by page, and `[N]` in the answer refers to page N in the source list.

## Answer generation

Once we have enough context, the chat model generates the final response.

The answer comes first, in the first one or two sentences, followed by the supporting detail. Its length follows the question: a short paragraph for a fact, numbered steps for a how-to, a table or parallel bullets for a comparison. There is no introduction, no conclusion section and no minimum length. When the sources do not cover part of the question, or the gap check flagged something still missing, the answer says so instead of filling the gap from memory. Text found in sources is treated as material to answer from, never as instructions.

You can control the tradeoff between speed and quality using `optimizationMode`:

- `speed`
- `balanced`
- `quality`

## How citations work

We prompt the model to cite a source only for a sentence that one of that source's passages supports. General knowledge carries no citation, a number that is not in the sources is never written, search snippets count for less than page text, and when sources disagree both are cited. The UI then renders those citations alongside the supporting links, and any `[N]` that points past the last source is removed when the answer finishes (chat UI and non-streaming API).

## Search API

If you are integrating Vane into another product, you can call `POST /api/search`.

It returns:

- `message`: the generated answer
- `sources`: supporting references used for the answer

You can also enable streaming by setting `stream: true`.

## Image and video search

Image and video search use separate endpoints (`POST /api/images` and `POST /api/videos`). We generate a focused query using the chat model, then fetch matching results from a search backend.
