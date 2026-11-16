# Deep mode against the default path: 2026-11-16

Live questions 1, 3, 4, 5, 8 and 11, run once in each mode with `npm run eval:live -- --only 1,3,4,5,8,11` (default) and the same with `--deep` (deep mode at low thinking). Both runs were cold: Supabase isn't loaded outside the browser, so neither read stored club snapshots, and the default path built every club snapshot in memory. Answers and grades were by `gemini-4-hydrogen`; the grader is the same model as the writer, so read the scores against each other, not as absolute.

The full deep report is [2026-11-16-0457-deep-low.md](2026-11-16-0457-deep-low.md).

## Spend cap

The default run stopped at question 8: the project reached its monthly Gemini spend cap (HTTP 429, "temporarily rate-limited to prevent exceeding its monthly spending cap"), which also rate-limits the live app until the cap is raised or resets. The run was stopped at once and nothing was retried. The estimate before the run was about 200 calls and 2M input tokens for all 12 answers and their grading; the cap was reached partway through, so other spend this month counted toward it too. Default answers for questions 8 and 11 don't exist, and the default run's report wasn't written because the script wrote it only at the end. The eval now writes its report after every question.

The default path's lookup counts for this run were lost with its report. The Lookups and Searches columns for the default path come from the last full cold run of the same questions (`2026-11-01-1008-precision-speed-cold`, on `gemini-3.8-flash`), as a reference for how much the brief researches, not a same-day measurement.

## Comparison

| # | Question | Mode | Lookups | Searches | Rounds | Shown | First token (s) | Total (s) | Stale | Invented | Decisive |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Arsenal's build-up shape | Deep | 3 | 1 | 1 | 1 XI | 19.4 | 24.3 | 0 | 0 | 5 |
| 1 | | Default | 4 (ref.) | 3 (ref.) | – | – | 25.6 | 30.5 | 1 | 0 | 4 |
| 3 | Manchester City injuries | Deep | 1 | 0 | 1 | – | 7.8 | 8.2 | 0 | 0 | 5 |
| 3 | | Default | 4 (ref.) | 3 (ref.) | – | – | 25.5 | 26.0 | 0 | 0 | 5 |
| 4 | Real Madrid's best XI | Deep | 2 | 1 | 2 | 1 XI | 22.5 | 26.4 | 0 | 0 | 5 |
| 4 | | Default | 5 (ref.) | 4 (ref.) | – | – | 34.5 | 39.1 | 0 | 0 | 5 |
| 5 | Chelsea's summer signings | Deep | 2 | 1 | 1 | – | 19.5 | 23.9 | 0 | 2 | 4 |
| 5 | | Default | 4 (ref.) | 3 (ref.) | – | – | 30.1 | 34.1 | 0 | 0 | 4 |
| 8 | Wirtz's role | Deep | 3 | 2 | 2 | – | 31.6 | 35.2 | 0 | 0 | 5 |
| 8 | | Default | 7 (ref.) | 4 (ref.) | – | – | spend cap | | | | |
| 11 | Rice and Guimarães | Deep | 4 | 0 | 1 | – | 15.1 | 22.1 | 0 | 0 | 5 |
| 11 | | Default | 8 (ref.) | 3 (ref.) | – | – | not run | | | | |

On the four questions both modes answered (1, 3, 4, 5):

| | Deep | Default |
| --- | --- | --- |
| Median first token | 19.5 s | 27.9 s |
| Mean total | 20.7 s | 32.4 s |
| Stale facts | 0 | 1 |
| Invented facts | 2 | 0 |
| Mean decisiveness | 4.75 | 4.5 |

Deep mode's tool calls, in order:

| # | Calls | Ended |
| --- | --- | --- |
| 1 | get_club_recent_team, web_search, show_pitch | answered |
| 3 | get_club_recent_team | answered |
| 4 | get_club_recent_team, web_search, show_pitch | answered |
| 5 | get_club_recent_team, web_search | answered |
| 8 | web_search, web_search, get_club_recent_team | answered |
| 11 | get_player_season, get_player_season, get_club_recent_team, get_club_recent_team | answered |

## Reading

**Research.** The model researched less than the brief does. It made 1 to 4 lookups and at most 2 web searches per question, against 4 to 8 lookups and 3 to 4 searches for the default path (reference counts, before snapshot builds). It never came near a budget: every turn ended because the model chose to answer, after one or two rounds, with at most 35 of its 120 seconds used. Its choices were sensible for each question: the live club feed first for team questions, the FPL record for a player comparison, the injury list alone for an injury question, and a search only where the feeds don't reach (transfers, a player's role at a new club). The cost of researching lightly shows in the grader's notes: question 3 answered from the injury list alone and missed knocks reported during the international break, and questions 3 and 11 didn't say what changed this season, which the default path's brief puts at the centre.

**Presentation tools.** The model drew the XI with `show_pitch` on the two questions about how a club lines up (1 and 4) and not elsewhere, which is the right call. It never called `show_dossier`: no cards were in play, since the eval can't read the shared card store.

**Accuracy and decisiveness.** No stale facts in deep mode against one on the default path, and decisiveness at least as high. Both invented facts were in question 5. One is a fact swap (a player's starts at left-back and right-back exchanged). The other comes from the figure gate, which both paths share: it removed a sentence with an unsupported figure from a bullet, leaving the next sentence's "He" pointing at the wrong player and another bullet cut mid-sentence. Deep answers quote more feed figures (minutes, starts, expected goals), so they expose that gate behaviour more often.

**Time.** Deep mode was faster: about 8 s sooner to the first token and 12 s sooner overall on the shared questions, because it skips the brief, reflect and situation calls and the cold snapshot builds. About 1.5 s of every deep turn went to waiting for today's coaches before the first round; in the app, where those come from the `club_managers` table, the wait is shorter.

**Cost.** One to two rounds, each resending the conversation, plus 0 to 2 searches and the coach lookups: roughly half the calls of a cold default turn in this sample.

## Recommendation

Keep deep mode opt-in, at low thinking. On these six questions it was faster, as accurate on stale facts and as decisive, and it chose its lookups well, so it is a strong candidate to become the default for questions about one club or one player. It isn't ready to replace the default path yet: it researches lightly and skips the "what changed this season" angle the brief enforces, the sample is four shared questions graded by the same model, and the default comparison is incomplete because of the spend cap. Medium thinking wasn't run (no repeat runs); since low thinking already finished well inside the budget, medium is worth testing only if a follow-up shows the model stopping too early.

Next steps, once the cap allows:

- Add a line to `deepModeRules` asking the model to establish what changed this season before answering a question about the present, then rerun questions 3 and 11 in deep mode only.
- Run the remaining live questions (2, 6, 7, 9, 10, 12) in deep mode with stored club snapshots available, to see whether a fresh snapshot makes the model research even less.
- Fix the figure gate's sentence removal so it never leaves a dangling pronoun or a cut bullet (shared by both paths).
