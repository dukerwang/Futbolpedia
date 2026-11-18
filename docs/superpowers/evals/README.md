# Evals

The eval runner is `scripts/eval-live-questions.ts` (`npm run eval:live`). It runs a question set
through the real pipeline, saves the answers, and can have a grader model score them.

Evals are cheap by default and can't spend the live app's Gemini budget. The live app costs about
$0.40 to $0.90 a day; its spikes of $7 to $8 came from evals run on the same key, and each cap hit
took futbolpedia.org's chat down. An eval now has its own key, checks the cap before it starts,
stops at the first 429, saves answers without grading unless you ask, and reports what it used.

| Set | Flag | What it measures |
| --- | --- | --- |
| Live questions | none, `--stage` | One answer per question to a present-day question ([live-questions.md](live-questions.md)). With `--grade`, scored on stale facts, invented facts, what changed, decisiveness and hedged roles. |
| Repeat runs | `--repeat N` | How far answers vary between runs of the same question (see Repeat Runs below). |
| Historical questions | `--set historical` | Past seasons and all-time debates, each run once ([historical-questions.md](historical-questions.md)). With `--grade`, scored on figures, blended seasons, myths and criteria. |
| Conversations | `--conversations` | Multi-turn cases. With `--grade`, graded for conduct. |

## Setup

Create a Gemini key in a separate Google project with a small spending cap, and put it in
`.env.local` (or export it):

```bash
EVAL_GEMINI_API_KEY=...
```

Every eval script reads `EVAL_GEMINI_API_KEY` and refuses to start without it, naming the
variable. That covers `eval-live-questions.ts` in every mode and `smoke-model.ts`. None of them falls
back to `GEMINI_API_KEY`, which is the live app's key. The key is set for the eval process only: the
eval replaces both `API_KEY` and `GEMINI_API_KEY` in its own environment, so nothing it runs can reach
the app's key, and the app's key handling is unchanged.

`--use-app-key` is the explicit escape hatch. It runs the eval on `GEMINI_API_KEY` and prints a
warning that it spends the live app's budget. Use it only when you mean to.

## Cost Controls

### Cap Check

Before the first real call, the eval sends one request with `maxOutputTokens: 1`. If the answer is a
429 that mentions the spending cap, the run exits with a message and sends nothing else. A plain rate
limit, an invalid key or a network failure also ends the run there, each with its own message.

During a run, the first 429 or spending-cap error stops every later model call at once. The call
that got it isn't retried, the pipeline's own retries are skipped, and every later call throws
without reaching the network (a chat turn that would fall back to the stage pipeline can't spend
there either). Each runner (the live set, repeat runs, the historical set and the conversations)
keeps the report it has written so far, notes where it stopped, and exits with status 1. The report
is rewritten after every question or run, so a crash keeps what finished too.

### Cheap By Default

| Flag | Effect |
| --- | --- |
| `--grade` | Call the grader models. Without it, answers are saved for a person to read and no grader, comparison or card-scoring call is made. |
| `--figure-check` | Historical set: list every precise figure in each answer and verify each with search. Implies `--grade`. |
| `--repeat N` | Runs of each question. Default 1 on every set, the historical set included. The historical set's verdict comparison runs only when a question has two or more runs. |
| `--builds` | Let era snapshot builds run. Off by default: a turn reads stored era snapshots and never builds one. |
| `--fresh-search` | Bypass the search cache (see below). |

The runner has no store for era snapshots (`db: null` in `createSnapshotServer`), so a build never
completes in an eval whether or not you pass `--builds`. The flag restores the app's behavior and
costs nothing today. Club snapshot builds on the stage pipeline (`--stage`, and the stage fallback)
still run in memory and still cost calls; the estimate counts them.

`--past-mode` makes one settle call for each new question a run settles. `--warm` answers every
question twice. Both stay as they were, and both show in the usage totals.

### Search Cache

During an eval run only, grounded search results (the research digest behind `web_search` and
`runGroundedSearch`) are kept on disk under `.cache/eval-search/<day>/`, keyed by the query, the kind
of digest (`brief`, `evidence` or `analysis`) and the UTC day. A rerun the same day reuses them and
pays for no search. Searches that failed or found nothing are never stored. `--fresh-search` neither
reads nor writes the cache. Reports count the searches reused.

The cache lives in `scripts/eval-search-cache.ts`, which only `startEvalSession` imports, and reaches
the pipeline through `setSearchCache` in `services/aiClient.ts`. The app never calls it, so the app
neither reads nor writes the cache; `scripts/test-eval-costs.ts` pins that. The smoke test bypasses
the cache, since its point is to time the model.

Searches made outside `runGroundedSearch` stay uncached: the club coach lookup (`clubManagers.ts`),
the player identity lookup (`groundingService.ts`) and the search the stage writer can run inside its
own turn. They still count in the usage totals.

### Usage

Every report and the end of every run give the real tokens and searches, counted from each
response's `usageMetadata`: input tokens (prompt tokens plus the tokens a search tool fed back to the
model), output tokens, thinking tokens, and grounded searches, per answer and in total. Totals are
split into the pipeline's answers, grading and checks, and the cap check. Thinking tokens bill as
output. A search counts once per query the model ran, or once for a call made only to search.

The JSON beside each report carries the same numbers (`usage` on each answer, and totals), and the
dry run reads them back (see Dry Run).

### Dry Run

`--dry-run` prices any set with no key and no call: calls, input and output tokens, grounded
searches and cost, expected and at the ceiling. It reflects `--grade`, `--figure-check`, `--repeat`,
`--stage`, `--past-mode`, `--only`, `--max-questions` and `--builds`.

```bash
npm run eval:live -- --dry-run --only 11,4,1                          # the live set
npm run eval:live -- --dry-run --set historical --only 1,3,5 --grade --figure-check
npm run eval:live -- --dry-run --conversations --only C2,C3,C4 --grade
```

The estimate takes the shape of an average answer (lookups, searches and rounds) from the saved
reports under `reports/`. A report written by the current runner also records each answer's tokens;
when a report does, the estimate uses the measured figure in place of its model, so each run makes the
next estimate better. The reports saved before this change record no tokens, so today the token
counts are modelled from their lookups, searches and rounds and the real prompt sizes. The grader and
figure-check calls are always modelled, because a report records their total and not each call.

The model profiles carry no prices. The dollar figures use placeholders ($0.50 per million input
tokens, $3.00 per million output tokens, $0.014 per grounded search) and ignore implicit caching.
Confirm them against the project's billing page and pass your own with `--price-in`, `--price-out`
and `--price-search`. Token and call counts don't depend on prices. The ceiling assumes every turn
spends its whole budget (12 lookups, 4 searches and 10 rounds on the chat loop; 8, 2 and 5 in past
mode). Earlier runs in this project have come in over their estimates, so check the eval project's
remaining budget against the ceiling, not the expected figure, before approving a run.

## Recommended Check

Run an eval only before flipping a switch that changes what the model reads, and start with the
smallest run that answers the question: three targeted questions, each run once, no grader. Read the
three answers yourself.

```bash
npm run eval:live -- --only 11,4,1 --shared-cards --label check
```

| Question | Why |
| --- | --- |
| 11. Compare Declan Rice and Bruno Guimarães this season | A head-to-head verdict, the question most likely to bring cards into play. |
| 4. What's Real Madrid's best XI right now? | Who starts in each role: a list of committed judgments. |
| 1. Break down Arsenal's build-up shape this season | The main claim about what changed, and a tactical explanation that can differ in kind. |

That is three turns: about 15 calls and $0.18 expected, $0.91 at the ceiling, with the placeholder
prices. Pick the questions that exercise the switch, in the order that matters most, so a run that
hits the cap still leaves the first ones. For a change to the past-question path, take two or three
historical questions the same way:

```bash
npm run eval:live -- --set historical --past-mode --only 1,3,5 --label past-check
```

Add flags only when the question needs them:

| Need | Run | Calls | Cost, expected | Cost, ceiling |
| --- | --- | --- | --- | --- |
| Score the three answers | `--only 11,4,1 --grade` | 21 | $0.26 | $0.99 |
| Do answers drift? | `--only 11,4,1 --repeat 2 --grade --shared-cards` | 51 | $0.58 | $2.02 |
| Are a past answer's figures right? | `--set historical --only 1,3,5 --grade --figure-check` | 24 | $0.50 | $0.92 |
| Does a conversation's conduct hold? | `--conversations --only C2,C3,C4 --grade` | 28 | $0.33 | $1.53 |

These are the dry run's figures with the placeholder prices; run `--dry-run` for your own flags.
Don't run the whole historical set twice with the figure check on a shared budget: the estimate is
about $4.69 expected and $8.61 at the ceiling.

## Repeat Runs

Gemini 4 Hydrogen ignores `temperature`, so variance between runs can't be controlled by sampling.
It has to be measured. `--repeat N` (2 or more) on the live set asks each question N times, one run
after another and never in parallel, each in a new chat. Questions run in the order `--only` gives,
and each question's runs finish before the next question starts, so a run cut short leaves complete
sets of runs for the first questions.

```bash
npm run eval:live -- --repeat 2 --only 11,4,1 --grade --shared-cards --label drift
```

The report is `reports/<date>-<time>-consistency-<label>.md`, with its JSON beside it. It is
rewritten after every run. Without `--grade`, the report holds each answer and the Lookups section,
which comes from the turns' own logs; the measures marked below need `--grade`.

### Measures

- **Spread** (`--grade`). Each run is graded on the live rubric (stale facts, invented facts, what
  changed, decisiveness, hedged roles). The report shows the lowest and highest value for each
  question and the range between them.
- **Consistency** (`--grade`). One grader call per question, without search, compares the runs on the
  judgments they commit to: the verdict, who starts in each role, and the main claim about what
  changed. It returns an agreement (`same`, `partly`, `different`) and lists each contradiction
  with what each run said. "Same" next to a listed contradiction is read as "partly".
- **Lookups.** The tools each run called (the chat loop's tool calls, view tools left out), how
  often, and what the non-search lookups were about (the `[Perf] lookup` lines). The report counts
  the questions where the runs used different tools, different numbers of calls or different
  subjects, and where a chat turn fell back to the stage pipeline in one run and not in another.
  Web searches count by tool only, since a query's wording always differs.
- **Card mentions** (`--grade`). A cheap scan finds sentences that might quote a rating, a tier or an
  attribute score. A grader call (without search) runs only for an answer the scan flags, so
  answers that never touch a card cost nothing here. For each figure it records the kind, the
  version the figure belongs to (current, prime, era, season or unstated), the version under
  discussion (those, or all-time), and whether the figure helped the answer or decorated it. Code
  decides the version mismatch: a figure from another version than the one discussed, and current
  form in an all-time discussion. The report also counts the questions where one run quoted a card
  and another didn't.

### Flags

| Flag | Effect |
| --- | --- |
| `--repeat N` | Runs per question. Default 1. |
| `--grade` | Score the runs: the rubric, the comparison and card figures. |
| `--only 11,4,1` | Questions to run, in this order. |
| `--max-questions K` | Keep the first K questions after `--only`. |
| `--dry-run` | Print the estimate and exit before any key check or call. |
| `--price-in`, `--price-out`, `--price-search` | Dollars per million input tokens, per million output tokens and per grounded search, for the estimate. |
| `--shared-cards` | Read the shared cards and stored club snapshots from Supabase through a read-only client. Without it no card is ever in play, so card mentions can't happen. |
| `--no-card-mentions` | Skip card scoring. |
| `--card-mentions` | With `--repeat 1`, score card mentions on a single run (needs `--grade`). |
| `--stage` | Send each question to the stage pipeline, as for the live set. |

`--only` also keeps its order, and `--max-questions` applies, in the plain live run.

The card-mention results depend on `--shared-cards` finding cards for the players asked about; if
the run shows no card figures, that is the first thing to check.

### Limits

- The grader is the same model that writes the answers, so it can share their blind spots. Read
  the spread and the contradictions as comparisons between runs.
- The process keeps its live-feed caches between runs, so the feeds hold still. That isolates the
  model's variance from the sources', and means the eval can't see drift caused by a feed that
  changed between two users' turns.
- Two runs per question show whether answers can differ, not how often. A rate needs more runs of
  the same questions.
- A search cache hit reuses the same digest in both runs of a repeat, which removes search variance
  from the comparison. Pass `--fresh-search` when the question is whether searches drift.
