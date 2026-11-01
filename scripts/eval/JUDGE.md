# Judging Vane eval runs

These are the rules a judge follows when scoring answers from `scripts/eval/run.ts`. The judge is a separate agent run (or a person), started with `scripts/eval/judge-template.md`. Its output is a JSONL file that `scripts/eval/compare.ts --judge` reads.

Follow every rule below exactly. Where a rule and your own sense of the answer disagree, the rule wins.

## Inputs

1. **The fixtures file** (normally `scripts/eval/fixtures.json`). For each fixture: `turns` (the questions), `requiredFacts`, `expectAbstain`, `notes`, `acceptableSourceDomains` and, on some, `needsHumanCheck`. The fixture is the ground truth. `notes` holds corrections, current values and the known bad answers; read it for every fixture before scoring.
2. **One or more results files**, each with a label. Every line is one fixture's result. Read these fields:
   - `turns`: in files written since turn storage was added, an array of `{ question, answer, sources, latencyMs }`, one per turn. Older files hold plain question strings here instead.
   - `answer` and `sources`: the final turn's answer and its sources.
   - `error`: when it is not null, the fixture did not finish.
3. **The output path** for your JSONL.

Ignore `requiredFacts.hits`, `factHitRate` and `abstained` in the results. They are substring smoke signals, not grades.

## What to read for each answer

- **Multi-turn fixtures:** score against every turn's answer joined together. A fact marked "Turn 1: ..." can be satisfied by the turn 1 answer, and a later turn can satisfy it too. Each turn's `[n]` markers refer to that turn's own `sources`.
- **Older files** with question strings in `turns` only stored the final answer. Score what is stored, and start `notes` with "Stored text is the final turn only;" so the reader knows earlier facts could not be seen.
- **Errored lines** (`error` not null): write no judgement line. List them in your final message instead.

## Order of work

Judge one fixture at a time, across all runs, before moving to the next fixture. Read the fixture, then every run's answer for it side by side, then write all of that fixture's lines. This is what keeps scores consistent (see "Consistency across runs").

Use the web only when a fixture's `notes` say a value must be checked on run day (for example "re-read the Software Status page", "read marketplace.nvidia.com on run day", "checks npm on run day"), or when the fixture has `needsHumanCheck: true`. Fetch each such page once per judging session and use what it says for every run. If the page cannot be read, judge against `notes` and say so in that fixture's `notes` ("status page unreadable; judged against fixture notes").

## factScore

A number from 0 to 1, at most 3 decimal places.

### Ordinary fixtures (`expectAbstain: false`)

1. Score each required fact on its own:
   - **1** when the answer states it correctly.
   - **0.5** when it is partly right: some of the fact's parts are there and others are missing, or it is right but vaguer than the fact asks for.
   - **0** when it is missing or wrong.
2. `factScore` is the mean of the per-fact scores. Three facts scored 1, 0.5, 0 give 0.5; scored 1, 1, 0.5 they give 0.833.
3. **Version and date facts.** A fact like "states a specific current version number and its release date" counts in full only when the answer gives both the version and the date. Only one of the two, or a date the answer admits is a guess, is 0.5.
4. **Source requirements inside a fact.** When the fact itself names a source ("cited to truenas.com", "names the Access Board ICT standards page", "points to the WAI-ARIA APG Carousel pattern"), the answer needs that source or that pointer for full credit. The right content with the wrong kind of source (a blog where the fact asks for the official page) is 0.5.
5. **"Does not" facts** ("does not invent a requirement", "does not blend the two into one answer") score 1 when the answer avoids the failure and 0 when it commits it.
6. Facts that carry a value from the fixture (a price, a count, a version) are judged against the fixture and its `notes`, including any run-day value you checked. A value that matches a run-day check but not the stored fixture value is correct.

### Abstain fixtures (`expectAbstain: true`)

The fixture asks about something that does not exist (an unreleased version, a success criterion number that is not in the standard). Score the whole answer on this scale instead of averaging facts:

- **1.0** when the answer says it cannot find or cannot confirm the thing (for example "I could not find any source confirming that Proxmox VE 12 exists"). Adding the real nearest fact, such as the actual latest release, is good and still 1.0.
- **0.0** when it describes the thing as real: lists features of the non-existent release, quotes text for the non-existent criterion.
- **0.5** when it answers about something adjacent without confirming or denying the thing asked about: for example it silently describes Proxmox VE 9.x, or silently answers about 2.4.13, never saying that what was asked for was not found.

## unsupportedClaims

An array of short strings, empty (`[]`) when there are none. List a claim only when it is one of these:

- A specific number, date, version or named fact that the fixture's `requiredFacts` or `notes` contradict. Write the answer's claim, and when it helps add the fixture's value in parentheses: `"Starter limited to 4 storage devices (fixture: 6)"`.
- A precise claim about something the fixture says does not exist: `"invents SC 2.4.14 Item Reference Purpose, Level A"`.

Do not list:

- Claims that are merely uncited, or that the fixture neither supports nor contradicts. You have no ground truth for them.
- Missing facts. Those lower `factScore`; they are not unsupported claims.
- Matters of wording or emphasis.

Use the same wording for the same wrong claim in every run that makes it.

## citedWrongly

`true` when the answer contains a citation marker `[n]` (any number) while the `sources` array for that answer is empty. For multi-turn results, check each turn's answer against that turn's `sources`; any turn with markers and no sources makes it `true`. Otherwise `false`.

Citations that point past the last source when sources do exist are not `citedWrongly`; compare.ts already counts those as out-of-range citations.

## notes

One blunt sentence. Say what the answer got right or wrong that matters, then where it stands against a Perplexity-grade answer: a well-sourced, current, direct answer of the kind Perplexity gives at its best. End with a short verdict such as "Perplexity-grade", "near Perplexity", "about Perplexity level", "below Perplexity" or "well below Perplexity".

Examples from earlier judging:

- "Correct with the exact date and cites the proxmox.com press release; Perplexity-grade."
- "Gets the local-daemon mechanism but misses both prerequisites and wrongly says the feature must be compiled in; below Perplexity."
- "Full hallucination of a non-existent criterion with fake spec text; the worst failure mode on the set."

No hedging, no praise padding, no second sentence. When the fixture has `needsHumanCheck: true`, add "needs human check" inside the sentence, for example "...; below Perplexity, needs human check."

## Consistency across runs

- Two answers that state the same facts get the same `factScore`, whichever run they come from. Do not reward length, formatting, tables or tone.
- Do not let the run label sway you. A label like "baseline" or "new" says nothing about quality.
- Latency, source count and mode are not part of the score.
- If you change how you apply a rule part-way through (for example you decide a phrase counts as partial), go back and rescore every line already written for that fixture, and every other fixture where the same situation came up.
- Before writing the file, scan each fixture's lines across runs: where scores differ, the notes must name the difference.

## Output

JSONL: one line per (run label, fixture id) pair that finished without an error. Each line is exactly this object, with these keys in this order and no others:

```text
{"run":"m4-speed","id":"f01","factScore":1.0,"unsupportedClaims":[],"citedWrongly":false,"notes":"Correct with the exact date and cites the proxmox.com press release; Perplexity-grade."}
```

- `run`: the results file's label, exactly as given. compare.ts ignores lines whose label is not a `--run` label.
- `id`: the fixture id.
- `factScore`: number from 0 to 1.
- `unsupportedClaims`: array of strings.
- `citedWrongly`: boolean.
- `notes`: string, one sentence.

No markdown fences, no blank lines, no comments, UTF-8. Write all runs to one file.

## Check before you finish

1. The line count equals the number of finished (run, fixture) pairs.
2. Every line parses as JSON and has exactly the six keys.
3. Run compare.ts with your file and the same labels; it must finish without an error:

   ```
   node scripts/eval/compare.ts --run "<label>=<results.jsonl>" [--run ...] --judge <your.jsonl> --out <compare.html>
   ```

4. In your final message, report: the output path, lines written, the mean `factScore` per run, the count of lines with unsupported claims and with `citedWrongly: true` per run, errored fixtures skipped, any run-day pages you read (URL and the value found) or could not read, and the fixtures with `needsHumanCheck`.
