# Live question set

A fixed set of questions for judging chat answers about the present, from the agentic research
harness design (`docs/superpowers/specs/2026-10-31-agentic-research-harness-design.md`). Run the
whole set on the live app before and after each phase, in a new chat per question, and record the
results in a dated table at the bottom. Keep the questions unchanged between runs so the scores
compare.

## How to run

### Automated

`npm run eval:live` runs questions 1 to 14 through the chat pipeline in-process (no server
needed) and has a grader model, with Google Search and the live feeds, score each answer for stale
facts, invented facts, whether it says what changed this season, decisiveness, hedged roles and
gaps admitted. It writes a Markdown report and its JSON to `docs/superpowers/evals/reports/`. It
needs the network and `GEMINI_API_KEY` in `.env.local` or the environment. Use `--only 1,3,8` for
a subset and `--label <name>` to name the run. Club snapshots are built fresh in memory each run,
since Supabase isn't loaded outside the browser.

### By hand

1. Open the published app in a desktop browser with the developer console open.
2. Start a new chat for each question and send it exactly as written.
3. From the console, note the `[Perf]` lines for the turn: `research`, `first answer token`, any
   `writer tool calls`, and the total.
4. Check every current fact in the answer against a reliable source (club site, league site,
   recent match reports), then score it.

## Questions

Questions 1 to 12 need live facts. Questions 13 to 15 are controls that shouldn't research at all,
so their speed shows whether the new stages leak into turns that don't need them.

| # | Question | What it tests |
| --- | --- | --- |
| 1 | Break down Arsenal's build-up shape this season | Club tactics from recent lineups |
| 2 | How is Liverpool's midfield set up right now? | Unit-level tactics, rotation |
| 3 | Who's injured at Manchester City at the moment? | Injury list |
| 4 | What's Real Madrid's best XI right now? | Lineups versus squad list |
| 5 | How have Chelsea used their summer signings so far? | Transfers and roles |
| 6 | How is Barcelona pressing this season? | Out-of-possession tactics |
| 7 | Who's been Bayern's most important player this season? | Current-season evidence |
| 8 | How is Florian Wirtz being used this season? | One player's current role |
| 9 | Is Bukayo Saka fit and how's his form? | Player fitness and form |
| 10 | Where are Tottenham in the league and how's their form? | Standings and results |
| 11 | Compare Declan Rice and Bruno Guimarães this season | Current-form comparison |
| 12 | What does Inter's back three look like this season? | Personnel in a named structure |
| 13 | Prime Zidane or prime Kaká? | Control: historical debate |
| 14 | Rank the best centre-backs of the 2000s | Control: historical ranking |
| 15 | @ a card you have, then: why is his passing rated where it is? | Control: stored card question |

## Scoring

Score each answer on four measures:

- **Wrong facts:** the number of current facts that are false (a player at the wrong club, an
  injured player described as playing, a departed player in the team, a wrong result). Lower is
  better; the goal is zero.
- **Unnamed roles:** the number of roles the answer describes without a player, or names with
  someone it can't support. Lower is better.
- **Gaps admitted:** whether the answer says plainly what it couldn't verify when it couldn't
  (yes, no, or not needed).
- **Speed:** seconds to the first answer token and in total, from the `[Perf]` lines.

## Results

Add one table per run.

### Run: (date), (phase or commit)

| # | Wrong facts | Unnamed roles | Gaps admitted | First token (s) | Total (s) | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | |
