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
`--label <name>` to name the run. Reports go to `docs/superpowers/evals/reports/`.

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

- **Wrong figures:** precise numbers (goals, appearances, points, trophies, dates, fees) that are
  false or that no source supports. Lower is better; the goal is zero.
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
