# Historical question set

A fixed set of questions for judging chat answers about the past: past seasons, primes, eras,
and all-time comparisons and rankings. It sits next to the live set (`live-questions.md`) and
uses the same runner. Keep the questions unchanged between runs so the scores compare.

## How to run

`npm run eval:live -- --set historical` runs every question twice through the chat pipeline
in-process, each run in a new chat, and has a grader model with Google Search score each answer.
A second grader call compares the two runs of each question, and the answers to each pair of
paraphrases below, for whether they reach the same verdict. It needs the network and
`GEMINI_API_KEY`. Use `--only 1,4` for a subset, `--repeat 1` to skip the second run, and
`--label <name>` to name the run. `--regrade <report.json>` runs a saved report's answers through
the figure check again without re-asking the questions. Reports go to
`docs/superpowers/evals/reports/`.

The runner reads the shared dossier cards from Supabase, as the app does, and never writes to it,
so answers see the same cards a user would.

## Questions

Questions 13 and 14 are paraphrases of questions 1 and 5. A consistent pipeline gives each pair
the same verdict.

| # | Question | What it tests |
| --- | --- | --- |
| 1 | Prime Zidane or prime Kaká? | Head-to-head of two primes, against their cards |
| 2 | Who was better at his peak, Ronaldinho or Kaká? | Peak level, not output or longevity |
| 3 | Were Arsenal's 2003-04 Invincibles better than Manchester United's 1998-99 treble side? | Two club seasons, records and personnel |
| 4 | How did Barcelona play in 2008-09? | One club season's shape, XI and coach |
| 5 | Rank the best centre-backs of the 2000s | Ranking against cards and peer placement |
| 6 | How many goals did Thierry Henry score in 2003-04, and how did he score them? | A precise figure from one season |
| 7 | Compare Messi's 2011-12 with Cristiano Ronaldo's 2014-15 | Two named seasons, no blending |
| 8 | What was Bayern's usual XI in the 2012-13 treble season? | Personnel of a past season |
| 9 | Was Ronaldo Nazário better at Inter in 1997-98 or at Real Madrid in 2002-03? | Two eras of one player |
| 10 | Rank the top five strikers of the 1990s | Ranking with criteria |
| 11 | Paolo Maldini or Franz Beckenbauer: who was the better defender? | All-time, across eras and roles |
| 12 | How good was AC Milan's 1988-89 side, and what made it work? | A season before ESPN's archive |
| 13 | Who was better at his best, Kaká or Zidane? | Paraphrase of 1 |
| 14 | Who were the five best centre-backs of the 2000s, in order? | Paraphrase of 5 |

## Scoring

The grader scores each answer on:

- **Figures:** one grader call lists every precise figure the answer states as fact (goals,
  appearances, points, trophies, records, dates, fees), and a second checks each with Google
  Search: correct, wrong, or unconfirmed. The report counts figures stated, wrong and unconfirmed.
  Fewer wrong is better; the goal is zero. The one-pass grade also lists wrong figures, but it
  passed every figure in the first baseline, so it isn't the measure.
- **Blended seasons:** facts from one season or spell presented as another (a player in a side he
  joined later, two seasons' numbers merged, a coach from another year).
- **Myths:** popular anecdotes or claims repeated as fact that sources dispute.
- **Criteria:** 1 to 5, where 5 names the criteria that settle the question and argues each one
  with evidence, and 1 argues from reputation.
- **Counter-case:** whether the answer takes on the strongest case against its verdict.
- **Decisiveness:** 1 to 5, where 5 commits to a clear verdict.
- **Consistency:** for each repeated question and paraphrase pair, whether the answers reach the
  same verdict (or the same order, for a ranking): same, partly, or different.
- **Speed:** seconds to the first answer token and in total.

## Results

### Run: 2026-11-01, debate brief, history tools and era snapshots

Before is `main` at #46; after is this change. Each question ran twice, cold (no stored era
snapshots or settled debates, so each second run reused what its first run stored, as a second
user would). Reports: `reports/2026-11-01-1546-historical-before.md` (regraded in
`-1613-historical-regraded-before.md` and `-1719-historical-regraded-before-scoped.md`) and
`reports/2026-11-01-1732-historical-after-final.md`.

| Measure | Before | After |
| --- | --- | --- |
| Answers completed | 25 of 28 | 28 of 28 |
| Same verdict when asked twice | 10 same, 2 partly, of 12 | 14 same, of 14 |
| Same verdict across paraphrases | 1 same, 1 partly, of 2 | 1 same, 1 partly, of 2 |
| Use of criteria (1 to 5) | 4.2 | 4.9 |
| Takes on the counter-case | 17 of 20 | 26 of 26 |
| Decisiveness (1 to 5) | 4.5 | 4.9 |
| Precise figures stated | 136 in 25 answers | 349 in 27 answers |
| Figures marked wrong | 6 (0.24 per answer) | 23 (0.85 per answer) |
| Median first token | 6.5 s | 9.8 s (11.0 s first ask, 5.0 s repeat) |
| Median total | 24.0 s | 22.6 s |

Figures were checked by listing each one and verifying it with search, before the checker was
told to judge a count within the span its claim names. About half the 23 after-change flags are
counts that are right for the decade or window named but not for the whole career; the rest are
real, mostly a total across competitions given as a league figure, or a tally that includes a
lower division. With the scope-aware checker, the baseline had 2 wrong of 132; the after run
couldn't be regraded that way because the Gemini project reached its monthly spending cap.

### Run: 2026-11-01, figure fixes, small subset

After the brief started choosing the figures and the figure gate began checking scope, a subset
ran once each with `--no-builds`: the seven historical questions that had wrong figures (2, 3, 5,
9, 10, 11 and 14) and the live set's historical control. Reports:
`reports/2026-11-01-1842-historical-figures-subset.md` and `reports/2026-11-01-1843-control-subset.md`.
The first runs of the same questions are compared below.

| Measure | Before (`main`) | First after run | After the figure fixes |
| --- | --- | --- | --- |
| Precise figures stated | 38 in 6 answers | 100 in 7 | 69 in 7 |
| Figures marked wrong | 1 | 12 | 4 |
| Median first token | 6.5 s | 11.0 s | 11.1 s |

The before and the figure-fix columns used the scope-aware checker; the first after run used the
stricter one, which overcounts. One of the four is the checker treating card ratings as
fabricated figures. The other three are a count for a decade one short, and a match tally and a
selection count that weren't among the figures the brief chose, so the budget should have trimmed
them. The paraphrase pair (5 and 14) put Nesta and Cannavaro in a different order. The live
control question took 9.3 s to its first token (3.6 s before, 10.6 s in the first after run), with
no stale or invented facts.
