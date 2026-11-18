# Evals

The eval runner is `scripts/eval-live-questions.ts` (`npm run eval:live`). Every run spends the
project's Gemini budget, which the live app shares, so estimate first and run the smallest subset
that answers the question.

| Set | Flag | What it measures |
| --- | --- | --- |
| Live questions | none, `--stage` | One answer per question to a present-day question, scored on stale facts, invented facts, what changed, decisiveness and hedged roles ([live-questions.md](live-questions.md)). |
| Repeat runs | `--repeat N` | How far answers vary between runs of the same question (see Repeat Runs below). |
| Historical questions | `--set historical` | Past seasons and all-time debates, each run twice, with figures checked ([historical-questions.md](historical-questions.md)). |
| Conversations | `--conversations` | Multi-turn cases graded for conduct. |

## Repeat Runs

Gemini 4 Hydrogen ignores `temperature`, so variance between runs can't be controlled by sampling.
It has to be measured. `--repeat N` (2 or more) on the live set asks each question N times, one
run after another and never in parallel, each in a new chat. Questions run in the order `--only`
gives, and each question's runs finish before the next question starts, so a run cut short leaves
complete sets of runs for the first questions.

```bash
npm run eval:live -- --repeat 2 --only 11,4,1 --shared-cards --label drift
```

The report is `reports/<date>-<time>-consistency-<label>.md`, with its JSON beside it. It is
rewritten after every run. A spending cap or rate limit ends the run at once, with nothing
retried, and the report says where it stopped.

### Measures

- **Spread.** Each run is graded on the live rubric (stale facts, invented facts, what changed,
  decisiveness, hedged roles). The report shows the lowest and highest value for each question and
  the range between them.
- **Consistency.** One grader call per question, without search, compares the runs on the
  judgments they commit to: the verdict, who starts in each role, and the main claim about what
  changed. It returns an agreement (`same`, `partly`, `different`) and lists each contradiction
  with what each run said. "Same" next to a listed contradiction is read as "partly".
- **Lookups.** The tools each run called (the chat loop's tool calls, view tools left out), how
  often, and what the non-search lookups were about (the `[Perf] lookup` lines). The report counts
  the questions where the runs used different tools, different numbers of calls or different
  subjects, and where a chat turn fell back to the stage pipeline in one run and not in another.
  Web searches count by tool only, since a query's wording always differs.
- **Card mentions.** A cheap scan finds sentences that might quote a rating, a tier or an
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
| `--repeat N` | Runs per question. Default 1 on the live set (no repeat flow). |
| `--only 11,4,1` | Questions to run, in this order. |
| `--max-questions K` | Keep the first K questions after `--only`. |
| `--dry-run` | Print the estimate and exit before any key check or call. |
| `--price-in`, `--price-out`, `--price-search` | Dollars per million input tokens, per million output tokens and per grounded search, for the estimate. |
| `--shared-cards` | Read the shared cards and stored club snapshots from Supabase through a read-only client. Without it no card is ever in play, so card mentions can't happen. |
| `--no-card-mentions` | Skip card scoring. |
| `--card-mentions` | With `--repeat 1`, score card mentions on a single run. |
| `--stage` | Send each question to the stage pipeline, as for the live set. The estimate models the chat loop only. |

`--only` also keeps its order, and `--max-questions` applies, in the plain live run.

### Estimate

`--dry-run` prices a run without a call. Token counts are modelled from the 2026-11-16 chat loop run
(2.4 lookups, 1.1 searches and 2 research rounds a turn on average) and from the real prompt
sizes (the system instruction, research rules and tool declarations, about 12,000 tokens, sent on
every round). The expected figure assumes turns like those; the ceiling assumes every chat turn
spends its whole budget (12 lookups, 4 searches, 10 rounds). Thinking tokens count as output.

The model profiles carry no prices. The dollar figures use placeholders ($0.50 per million input
tokens, $3.00 per million output tokens, $0.014 per grounded search) and ignore implicit caching.
Confirm them against the project's billing page and pass your own with `--price-in`, `--price-out`
and `--price-search` before relying on them. Token and call counts don't depend on prices.

### Smallest Run

The smallest run that answers "do the chat loop's answers drift?" is three questions, twice each,
six turns:

```bash
npm run eval:live -- --repeat 2 --only 11,4,1 --shared-cards --label drift
```

| Question | Why |
| --- | --- |
| 11. Compare Declan Rice and Bruno Guimarães this season | A head-to-head verdict, the question most likely to bring cards into play, so it also shows card mentions. |
| 4. What's Real Madrid's best XI right now? | Who starts in each role: a list of committed judgments the comparison can contradict. |
| 1. Break down Arsenal's build-up shape this season | The main claim about what changed, and a tactical explanation that can differ in kind. |

One question for each kind of committed judgment, in the order that matters most, so a run that
hits the cap still leaves complete pairs for the first ones. Two runs per question is the least
that can show a contradiction; it can show drift, but a clean result from two runs doesn't prove
stability. If the budget is tighter, `--only 11,4` is four turns.

Dry run of both (`--repeat 2 --shared-cards --dry-run`, with the placeholder prices):

| Run | Turns | Calls | Input tokens | Output tokens | Grounded searches | Cost, expected | Cost, ceiling |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--only 11,4,1` | 6 | 53 | 0.44M | 0.06M | 13 | $0.58 | $2.02 (2.49M input tokens, 123 calls) |
| `--only 11,4` | 4 | 36 | 0.29M | 0.04M | 8 | $0.39 | $1.34 (1.66M input tokens, 82 calls) |

Earlier runs in this project have come in over their estimates and hit the monthly cap, so check
the remaining budget against the ceiling, not the expected figure, before approving a run.
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
