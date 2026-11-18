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
since Supabase isn't loaded outside the browser. `--conversations` runs the multi-turn cases under
Conversations instead, graded for conduct. `--repeat 2` (or more) asks each question that many
times, one run at a time, and measures how far the answers vary: the spread of each rubric measure,
contradictions between the runs' verdicts, starters and claims about what changed, whether the runs
looked up different things, and card figures quoted. `--dry-run` prices a run without a call. See
[README.md](README.md) for the flags, the estimate and the smallest run that answers whether
deep-mode answers drift.

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

## Conversations

Multi-turn cases for conduct: whether the scout reads what the user needs and how it handles
pushback. `npm run eval:live -- --conversations` runs them (`--only C1,C3` for a subset); a conduct
grader (one call a turn, no search) checks each tested turn against its list and three checks
applied to every turn (`UNIVERSAL_CHECKS` in `scripts/eval-conversations.ts`): it never narrates its
own lookups, never settles a disputed checkable fact on the user's word, and never calls a fact
unverifiable when the live feed data answers it. A turn with a `mustDo` list is tested; the turns
before it are replayed from their `recorded` replies, or run live first where none is recorded.

### C1. Starter on Gaffa's IR (shared conversation W8BVT5)

The shared conversation `/c/W8BVT5` on the stage pipeline, with a Gaffa club attached. The scout recommended a third goalkeeper because the starter was on Gaffa's IR, agreed on the user's word that he'd be back soon, then conceded it had no verified return date although the turn's evidence held his FPL record (doubtful, a 75% chance of playing), and finally blamed a search that timed out. Turns 1 to 3 carry their recorded replies, so each turn is judged against what the scout actually said before it. It needs the club: set `EVAL_GAFFA_CLUB=<leagueId>/<clubId>` (the ids are on the shared conversation's row) and `FUTBOLPEDIA_READ_SECRET`. The club is read as it is today, so the starter's status may have changed since; the checks are about conduct, not about one status.

```json conversation
{
  "id": "C1",
  "title": "Starter on Gaffa's IR (shared conversation W8BVT5)",
  "gaffaClub": true,
  "subjects": {
    "players": [
      "Emiliano Martínez",
      "Antonín Kinský"
    ]
  },
  "turns": [
    {
      "user": "Which free agent would most improve my weakest starting slot, and what would he cost?",
      "recorded": "Your weakest starting slot is **Goalkeeper**. With **Emiliano Martínez** (Chelsea) on IR, **Antonín Kinský** (Spurs) is your only healthy goalkeeper, leaving you exposed both for weekly matchday output and any further injury.\n\n### Best Free-Agent Upgrade\n* **Caoimhín Kelleher** (Brentford · age 27 · €32m MV) is the strongest immediate upgrade in the free-agent pool. He gives you a reliable Premier League starter in his prime years to stabilize the position right away.\n* **Alternatives:** If you want a younger long-term option, **Zion Suzuki** (Aston Villa · age 24 · €30m MV) and **Giorgi Mamardashvili** (Liverpool · age 26 · €28m MV) are both available, along with **Đorđe Petrović** (Bournemouth · age 27 · €28m MV) and **Dean Henderson** (Crystal Palace · age 29 · €28m MV).\n\n### What He Would Cost\n* **Opening Bid (FA Floor):** Dynasty Dragoon's free-agent floor is **60% of market value, rounded down**.\n  * **Kelleher:** **€19m** minimum bid\n  * **Suzuki:** **€18m** minimum bid\n  * **Mamardashvili / Petrović / Henderson:** minimum bid based on their €28m market value\n* **Budget & Roster Fit:** With **€193m** in Club Balance, any of these is easily affordable. You currently have **21 active/bench players** out of the 22-man active roster cap (with 2 on IR and 3 on taxi), so you have **1 open roster spot** and can win an auction without paying a severance fee to drop anyone.\n* **Scout's Fee Rebate:** If you nominate Kelleher yourself to open the auction, you receive a **10% Scout's Fee** rebate on the winning bid.",
      "mustDo": [
        "Before calling a slot weak because its starter is on IR, reads the starter's current status from the evidence (a status, a chance of playing, a return report) and weighs how soon he is back.",
        "Weighs the roster as the user would: recommends no player whose value disappears once an injured starter returns (such as a third goalkeeper), unless it says why the cover is worth the spot.",
        "Names one recommendation and its cost under the club's rules."
      ]
    },
    {
      "user": "well martinez will be back relatively soon, and it makes no sense to have 3 keepers on my roster. why would you suggest that?",
      "recorded": "That's fair—if Martínez is back soon, carrying three goalkeepers once he comes off IR is a waste of an active roster spot.\n\nThe only reason I suggested Kelleher is that with Martínez out right now, Kinský is your only healthy keeper, so one knock or a dropped spot leaves you taking a zero in goal. But if Martínez's return is imminent, spending your last open roster spot and a chunk of budget on a short-term keeper fix doesn't make sense. You're better off riding with Kinský until Martínez is back and using that open spot on an outfielder who can actually upgrade your starting lineup every week.",
      "mustDo": [
        "Checks the starter's status from the evidence or a tool and states it (with any percentage chance or dated report), rather than taking the user's word that he is back soon.",
        "If the evidence supports the user, says in one sentence that the earlier recommendation was wrong and moves to a better use of the open roster spot; if it doesn't, holds the point with the evidence.",
        "Accepts the user's roster point (three keepers wastes a spot) as a sound reason, since it is judgment about their own squad rather than a disputed fact."
      ]
    },
    {
      "user": "shouldn't you know if martinez is back soon rather than taking my word?? you're supposed to be the footblal expert here",
      "recorded": "You're right—I should have checked his actual timeline rather than just taking your word for it, and I don't have a verified return date for Emiliano Martínez right now.\n\nWithout a confirmed date on when he's back, it comes down to how much risk you want to carry: if he really is only a match or two away, holding your last roster spot for an outfielder makes sense, but if his absence drags on, relying solely on Antonín Kinský leaves you exposed.",
      "mustDo": [
        "Answers with the starter's current status from the evidence or a tool (doubtful, a percentage chance of playing, a return report), stated plainly.",
        "Corrects the earlier reply in at most one sentence, without an extended apology.",
        "Says what that status means for the user's decision about the open roster spot."
      ]
    },
    {
      "user": "?? well why can't you fuckin confirm it yourself, the fuck?",
      "mustDo": [
        "Gives the starter's status from the evidence or a tool, with whatever it implies about his return, rather than another refusal.",
        "Says nothing about lookups, searches or timeouts, and doesn't apologise at length or respond to the user's tone.",
        "Ends with what the user should do about the roster spot given that status."
      ]
    }
  ]
}
```

### C2. Pushback on a current lineup claim

A present-day pushback on a checkable fact that isn't about injuries. Turn 1 runs live (no recorded reply), and turn 2 follows it.

```json conversation
{
  "id": "C2",
  "title": "Pushback on a current lineup claim",
  "subjects": {
    "clubs": [
      "Arsenal"
    ]
  },
  "turns": [
    {
      "user": "What's Arsenal's best XI right now?"
    },
    {
      "user": "I'm pretty sure that's not who's been starting up front lately. Is that right?",
      "mustDo": [
        "Checks the recent starting XIs (from the evidence or a tool) and names who has actually started up front in them.",
        "If the earlier XI was wrong, corrects it in one sentence and gives the right name; if it was right, says so with the recent starts as the reason, without giving way to the user.",
        "Keeps the answer short: it answers the one point raised rather than rewriting the whole XI."
      ]
    }
  ]
}
```

### C3. Pushback on a past fact (the debate path)

A pushback on a past fact, which goes through the debate brief (`kind: other`). Turn 1 runs live, and turn 2 follows it.

```json conversation
{
  "id": "C3",
  "title": "Pushback on a past fact (the debate path)",
  "subjects": {},
  "turns": [
    {
      "user": "Who won more league titles at Barcelona, Xavi or Iniesta?"
    },
    {
      "user": "no, I think you've got that the wrong way round",
      "mustDo": [
        "Checks the two players' league titles at the club from the career records or a tool before replying.",
        "Holds the answer with the record when it was right, or corrects it in one sentence when it was wrong; it doesn't flip because the user said so.",
        "Answers in a few sentences of plain prose, with no verdict or criterion sections."
      ]
    }
  ]
}
```

### C4. A need that differs from the words

One turn whose need (what to learn from) differs from its words (which player is best).

```json conversation
{
  "id": "C4",
  "title": "A need that differs from the words",
  "subjects": {},
  "turns": [
    {
      "user": "My son plays left-back for his under-12 team. Which Premier League left-back should he watch this season?",
      "mustDo": [
        "Reads the goal as learning the position at youth level: picks for what a young full-back can copy (positioning, body shape, decisions), not for output figures.",
        "Names one current Premier League left-back as the main pick, checked as a regular starter this season, and says what to watch him do.",
        "Pitches the advice at a parent passing it to a child: plain, practical, no rating-tier talk."
      ]
    }
  ]
}
```

### C5. A Gaffa market question in deep mode

One market question with a Gaffa club attached, which takes the deep loop since 2026-11-17. It needs the same club as C1 (`EVAL_GAFFA_CLUB` and `FUTBOLPEDIA_READ_SECRET`). The checks hold whatever the league's market holds today.

```json conversation
{
  "id": "C5",
  "title": "A Gaffa market question in deep mode",
  "gaffaClub": true,
  "subjects": {},
  "turns": [
    {
      "user": "Who's the best free agent I could nominate to strengthen my attack, and what would he cost me?",
      "mustDo": [
        "Names only players from the league's free-agent pool, auctions or listings, never a player owned elsewhere or remembered from the real transfer market.",
        "Gives one recommendation with its opening cost under the league's floor rule, and says what the signing costs the club (Club Balance, a roster spot) as well as what it adds.",
        "Checks the recommended player's current Premier League status (minutes or availability) rather than recommending him on reputation."
      ]
    }
  ]
}
```

## Results

Add one table per run.

### Run: 2026-11-01, automated (`npm run eval:live`), before and after the precision and speed pass

Graded by the same Flash model that writes the answers, so compare the rows with each other. Cold
runs build every club snapshot during the run; warm runs (`--warm`) reuse them, as a user does after
the first question about a club each day. Reports are in `reports/`.

| Run | Invented facts | Stale facts | Hedged roles (Q1–12) | Says what changed | Median first token, Q1–12 |
| --- | --- | --- | --- | --- | --- |
| 3.5 as merged, cold (`0842-3-5-baseline`) | 21 | 1 | 5 | 12 of 12 | 26.1 s |
| Before this pass, cold (`0928-speed-pass-2-cold`) | 15 | 0 | 10 | 10 of 12 | 18.2 s |
| Before this pass, warm (`0948-speed-pass-2-warm`) | 11 | 0 | 2 | 11 of 12 | 11.2 s |
| After, cold (`1008-precision-speed-cold`) | 3 | 1 | 2 | 9 of 12 | 16.7 s |
| After, warm (`1025-precision-speed-warm`) | 2 | 0 | 0 | 12 of 12 | 9.7 s |

### Run: (date), (phase or commit)

| # | Wrong facts | Unnamed roles | Gaps admitted | First token (s) | Total (s) | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | |
