# Questions about the past in the deep loop

Date: 2026-11-18

Status: design. Nothing here is built. Every live check below is a plan for the user to approve,
with its token estimate; this design spent no Gemini calls.

## Problem

Deep mode (`services/deepTurn.ts`) has been the default path for present-day questions since
2026-11-16, but `takesDeepPath` sends every turn where `threadIsHistorical` is true to the stage
pipeline. There, `runDebateResearch` (`services/debateBrief.ts`) fixes the shape of the answer
before the writer starts:

- One brief call reads the question into a fixed `criterion` enum, two to four criteria, the
  versions compared, the disagreement, a counter-case, a verdict or order, the one figure per
  criterion the writer may quote, and up to `DEBATE_CALL_LIMIT` (6) lookups. A brief that misses
  `BRIEF_WAIT_MS` gives way to `cardBrief`, which takes the cards' order as the verdict.
- Code rewrites the brief's verdict or order to the cards' order when the criterion is
  `peak_level` or `mixed` (`checkBriefAgainstCards`, `services/debateConsistency.ts`), and the
  writer is told to keep it.
- A settled brief is kept for the browser session only (`liveDebateRecords`, keyed by
  `debateSignature` and `cardFingerprint`), on purpose: a brief written in the browser can't be
  vouched for, and a shared row would let anyone set the verdict everyone gets.
- The writer gets `PAST_DEBATE_RULES` or `PAST_CONVERSATION_RULES`, local tools unless a lookup
  failed (`writerNeedsNetwork`), and a scoped figure gate held to `figureBudget`: the brief's
  chosen figures and room for their counterparts, with every other figure's sentence cut from the
  end.

It works: in the 2026-11-01 run every repeated question got the same verdict, criteria scored 4.9,
and the figure fixes brought wrong figures down to about one in every two answers. Its costs are
the ones the roadmap sets out to remove. The order of stages is code's, the criteria come from an
enum, the brief decides which figures exist before anyone has read the records, and the model
can't disagree with a card, only be overruled. It's also where users noticed the scout attaching
card ratings to answers that don't turn on how good anyone was.

This design moves those turns into the deep loop. The brief's thinking becomes guidance the loop
reads, the cards' order becomes context it reads before it commits, disagreement becomes visible
instead of silently corrected, and verdicts the cards don't settle get a server-written store.

## Summary

| Area | Decision |
| --- | --- |
| Entry | Every prose turn about the past takes the loop, behind its own switch, `DEEP_PAST`. The stage pipeline stays as the fallback and the kill switch. A present-day deep turn comparing two or more carded versions (current form against a prime) gets the cards' order and `commit_verdict` too. |
| First message | Cards in play with their order and peer placements, edition gaps, stored era snapshots for the cards' windows and the named season, and settled verdicts for the same versions. No brief. |
| Model decides | Which records to read, the criteria, the counter-case, the verdict, and which figures matter. |
| Card consistency | A free `commit_verdict` tool checks the verdict against the cards and the settled verdict before the model writes. The model may depart only by saying why in the reply; a pair it put against the cards is reported for card review through `reportCardDisagreements` with path `deep`. |
| Cross-session | A server-written `debate_verdicts` table keyed by the versions compared and the criterion, never by the user's words. The server checks a proposed verdict before storing it. |
| Figures | The figures named in `commit_verdict` replace the brief's slots in the figure budget; the scoped gate and the correction round stay. |
| Budget | A past budget inside the deep loop: 60 s, 8 lookups, 2 searches, 5 rounds. |
| Measurement | `--set historical --deep` on six questions run twice, about 1.0M input tokens; an optional stage control adds about 0.4M. |

## Entry

`takesDeepPath` drops `turn.historical` from its exclusions and gains `pastDeep`, read from a new
constant `DEEP_PAST` (exported from `deepTurn.ts`, `false` until the live check passes). A past
turn takes the loop when the turn wants deep (`wantsDeep`) and `DEEP_PAST`, or a per-turn
`deepPast` override, says yes. Every other exclusion is unchanged: ratings and challenges keep
their pipelines, archive questions and images stay on the stage pipeline, and Gaffa's panel and
Gaffa trades never reach the loop. A conversation with a Gaffa club attached counts as about the
past only on the user's own words, as now (`threadIsHistorical` with `userOnly`), and a past turn
in such a conversation runs without the club's blocks, as the stage pipeline does today.

No past turn stays on the stage pipeline by design. The two kinds the brief handles differently
both fit the loop:

- A judgment (head-to-head, ranking, how good a season or version was) is what the loop's past
  rules, the card order and `commit_verdict` are for.
- A follow-up that questions a fact or the last answer (the brief's kind `other`) is what deep
  mode's pushback rule already covers: look the fact up this turn, correct the earlier reply in a
  sentence or hold it with the record, and stop. `PAST_CONVERSATION_RULES` folds into the past
  rules below as one bullet.

The stage pipeline stays as the fallback, run once when the loop throws, ends empty or spends its
budget with no answer (`runDeepWithFallback`, unchanged). It reads the settled verdicts too, so a
fallback answer and a loop answer start from the same prior.

A turn that may take the loop starts no early debate brief. `startDebateBrief` runs before routing
today and is a wasted call when the loop answers, the same reason a deep present-day turn starts no
question search. In its place, once the turn is routed, the career records of the cards' players
and of named players with no card, and a named club season's record, are fetched with the era
snapshot reads (`loadPastContext`, at most four). They cost no Gemini call (Wikipedia, cached on the
server for a week), and the ones back within the context wait go into the first message as
evidence. The first design only warmed the cache and left them out of the prompt; in the first
live run (2026-11-18) the model then often answered from style without reading them, and use of
criteria fell to 3.7 of 5.

A present-day turn that compares versions also gets the card anchor. When a deep turn that isn't
about the past has two or more carded versions in play (current form set against a prime, say),
its first message carries the `<cards_in_play>` block below and its tools include `commit_verdict`.
The card rule is about versions, not about the thread's era, so both cards order the comparison the
same way they would in a past thread. The rest of that turn stays a present-day turn: coaches, the
present unchecked line and the present budget.

## The first message

A past turn's first message is built by the same `runDeepTurn` with a `past` flag. What changes:

- **Cards.** `cardsForTurn`, `editionGaps`, `createDossierTools` and `wantsPrimeOf` get
  `historical: true` instead of the hard-coded `false`, so a prime is preferred where the thread
  is about primes and a player whose prime has no card gets `editionGapNote` (his current card is
  never read as his prime).
- **The cards' order.** A `<cards_in_play>` block lists the cards in play best first
  (`formatCardOrder`), each with its window and peer placement (the `placementText` lines the brief
  reads today), and one line saying what a card answers: how good one version of a player was
  across its window, on one all-era standard. It says nothing about output, longevity, influence
  or big games, so on those the cards are background. How a reply mentions a card is the card-
  mentions work now in `prompts/chatPrompt.ts`; this block only makes the order and its meaning
  available, so that rule has something to apply to.
- **Era snapshots.** For each card's window and for a named club season (`route.requestedSeason`
  with the spotted clubs), the stored era snapshot is read, not built, within `ERA_PEEK_MS`, and
  sits in a `<stored_era_snapshots>` block, as `<stored_snapshots>` does for clubs today.
  Background builds still start for at most `MAX_ERA_BUILDS` (1) missing snapshots, for the next
  person, once the model has called the record they'd be built from.
- **Settled verdicts.** The rows of `debate_verdicts` (see Settled verdicts) for the versions in
  play, read within `SETTLED_PEEK_MS`, each with its kind, criterion, verdict or order, the
  criteria it was argued on, the counter-case, its date, and whether it's still current (the cards
  it was settled under are unchanged) or stale (a card was re-rated since, named with its old and
  new Overall, or an era snapshot of one of its subjects was built after it was settled). For a ranking, the row for the scope the message names (position and period).
- **No coaches.** Today's coaches aren't looked up for the first message: a past turn names past
  coaches only from its evidence. This also saves the grounded coach searches the present loop
  starts for every spotted club.
- **Unchanged.** The conversation, `<locked_dossiers>`, the peer ledger, the saved-dossier block,
  the date and season, and the last turn's research on a follow-up.

What the model decides itself: which records to read (`player_career`, `club_season`, cards it
didn't get, a search), what the question turns on and the criteria that settle it, the strongest
counter-case, which figures carry the argument, and the verdict. Code puts nothing in front of
those choices but the cards, the snapshots and the prior verdict, all of which are shared state
every turn reads alike.

### Past rules

`pastModeRules` replaces the present-day thoroughness bullets of `deepModeRules` on a past turn
(the budget, parallel calls and preamble rules stay). It carries the brief's useful thinking as
guidance, in descriptive prose with no player names, rating anchors or sample phrases:

- Work out what the latest message asks and what it turns on: how good a version was at its best,
  how long it held that level, its output, its effect on results and the team, its record in the
  biggest matches, its range of roles, or a mix. Read it from the words the user chose.
- Decide the two to four things that would settle it, and read the records those need. Season and
  career records and the stored era snapshots come first; a web search is for an analytical point
  they can't give, asking for contemporary accounts.
- Know the strongest case against your answer before you commit, and give it its due in a
  sentence or two.
- Commit to one answer. For a judgment, call `commit_verdict` before you write it.
- Where the question is who was better, the cards in play have already rated the versions: argue
  their order. If the evidence this turn gives you a reason to think a card is wrong, you may say
  so, in one sentence with the reason, and keep your own view; never contradict a card silently.
- On any other criterion, the cards are background: argue from the records.
- A settled verdict is the scout's earlier answer to this question on these versions. Keep it
  unless the user's question or this turn's evidence gives a reason not to, and say the reason
  when you depart. Don't say that an answer follows a settled verdict unless the user asks why, or
  it matters to the answer; that follows the card-mention rule against narrating internals.
- The past fact rules: `PAST_FACT_RULES`, with "as `<debate_brief>` lists it" replaced by "as you
  named it in `commit_verdict`".
- `PAST_DEBATE_RULES`' writing rules: plain conversational prose, the answer early, no labelled
  criterion, counter-case or verdict sections. A follow-up that questions a fact or the last answer
  gets the conduct bullet from `PAST_CONVERSATION_RULES`.

The intent-and-conduct rules (`<user_need>` and pushback) reach the loop through `deepModeRules`
as they do now. Prompt consolidation, which the chat-principles session is designing, may move
these bullets; this spec only fixes their content.

### Tools

The loop keeps its whole tool set. The history tools are already declared (`club_season`,
`player_career`), as are the cards, the views and `web_search`. Two things change:

- **`commit_verdict`** is new (below). It's free, like the show tools.
- **`uncheckedFor`** gets a past variant: for each carded player in play, his career record unless
  it was read or an era snapshot for his window is in context; for a named club season, its
  record. As now, the line only informs; code never forces a round for it.

The live tools stay offered: a past thread can still ask how a version compares with today's
player, and a stray call costs a lookup, not a wrong answer.

## Consistency with the cards

### `commit_verdict`

The loop learns the cards' order from its first message, before it reads anything. It commits
through one free tool, called when its research is done and before it writes:

```
commit_verdict({
  kind: 'head_to_head' | 'ranking' | 'single',
  criterion: 'peak_level' | 'sustained_level' | 'output' | 'influence' | 'big_games' | 'versatility' | 'mixed',
  sides: string[],             // the versions compared, as named in the reply
  verdict?: string,            // the winning side, for a head-to-head or single
  order?: string[],            // best first, for a ranking
  scope?: { position?: string, period?: string },   // a ranking's field
  figures?: string[],          // at most 4: each figure that decides a criterion, described by what it counts, its competition and its span
  departs?: string             // why, when the commitment goes against the cards or a settled verdict
})
```

`big_games` joins the criteria because users ask it and it is neither output nor influence. It's
added to `DEBATE_CRITERIA` and to the ranking view's `RANKING_CRITERIA` in migration step 3. It
isn't card-settled: a card rates level across a window, not the biggest matches in it.

Code answers with what it found, in the tool result, and changes nothing:

- **Against the cards.** For a card-settled criterion, `checkVerdictAgainstCards` or
  `checkOrderAgainstCards` against the cards in play and any card the model read this turn (through
  the turn's card lookup, so a card found mid-turn counts). The result says agree, level (the
  criteria decide) or against, naming each card's version and Overall.
- **Against the settled verdict.** The same criterion's row for these versions, if any: agree or
  against, and whether the row is current or stale.
- **When `departs` is empty and the commitment goes against either,** the result asks the model to
  argue the cards' order (or the settled verdict), or to call again with `departs` set. A second
  call that still departs with no reason is recorded as a departure with no reason, and the
  turn's stats say so. Code never rewrites the reply.

`commit_verdict` is offered on past turns and on present-day deep turns with two or more carded
versions in play, at most twice a turn. It never ends the turn and
never counts against lookups or rounds, so committing in the same round as the last lookups costs
nothing. Its arguments become the turn's structured verdict: the figure budget reads them, the
settled-verdict store is proposed them, and the eval compares them across runs without a grader
call.

The call is measured, not required (see Decisions): `DeepStats` gains `committed` and
`departures`, and the eval reports how often a judgment was written without a commitment. Code
doesn't force a round for it; code enforces facts and budgets, not judgment.

### Card-settled criteria

The card-order build (`docs/superpowers/specs/2026-11-18-card-order-disagreement-design.md`)
settled this: `CARD_SETTLED_CRITERIA` in `debateConsistency.ts` is `peak_level` and `mixed`, and
`cardsSettle` serves both the debate check and `show_ranking`. A card rates the level a version
held across a window of at most three seasons, which says nothing about longevity, so
`sustained_level` isn't card-settled. `commit_verdict`'s check uses `cardsSettle` too.

### Disagreement

When the model departs from the cards, three things happen, all visible:

1. The reply says so in a sentence with the reason. The writing rule asks for it; the eval checks
   it.
2. `show_ranking` still draws the cards' order for a card-settled criterion, since the drawn list
   is the shared record, and its tool result says what moved, as now. The prose can disagree with
   the drawn list only by saying so.
3. Each pair of cards the commitment put the other way is reported through the card-order
   build's channel: `reportCardDisagreements` with `via: 'deep'`, which posts to
   `/api/cards/disagreements` from a browser and records into the scout tally on the server.
   `DisagreementPath` and `readDisagreementReport` gain `'deep'`; nothing else in that channel
   changes. The pairs come from `checkOrderAgainstCards`' swaps and `checkVerdictAgainstCards`'
   pair, as on the debate check, whether the model then argues the cards' order or departs. As in
   that channel, only card keys cross: the `departs` reason stays in the reply and the turn's
   stats, never on the server.

There is no second channel for card disagreements. `POST /api/debates/departure` (below) is only
for contests of a stored settled verdict.

A stored verdict never carries a departure from the cards: the server settles a card-settled
criterion on the cards' order (below). So across sessions the cards win until card review changes
a card, and a departure is one turn's argued view, not a new default.

## Settled verdicts

### The table

A new Supabase table, `debate_verdicts`, written only by the server with `SUPABASE_SECRET_KEY`, as
`club_snapshots` and `era_snapshots` are. Browsers read it with the publishable key; it has no
insert, update or delete policy. A row is a verdict on versions, not on a question's words:

| Column | Holds |
| --- | --- |
| `verdict_key` | `kind:criterion:<sorted subject keys>`, hashed past 200 characters as `debateKey` does |
| `subjects` | The sorted subject keys, for reading by versions |
| `scope` | For a ranking: canonical position (or `any`) and normalized period |
| `kind`, `criterion` | From the commitment |
| `verdict` | The winning subject key, or the order as subject keys |
| `criteria` | Two to four short criterion names, written by the server's check call |
| `counter_case` | One sentence, written by the server's check call |
| `fingerprint` | Each subject card's key, Overall and `rerateAt`, at settling time |
| `status` | `current` or `contested` |
| `departures` | Distinct clients that departed from it since it was settled |
| `version`, `settled_at` | `DEBATE_VERDICT_VERSION` and when |

Subject keys come from what the turn resolved, never from typed text: a carded version is
`<player slug>:<edition>:<window>` from its card; an uncarded player is `<player slug>:<window>`
with the window normalized by `normalizePeriod`; a club season is the era snapshot's subject and
season, as `eraKey` builds them from the history route's resolved article. A ranking's field is
part of its key (`scope`); its entries aren't, so the same field asked with different candidates
finds the same row.

Keying by versions and criterion, not by `debateSignature`, does three things the browser store
can't. Paraphrases of one question share a row (the 2026-11-01 run had one of two paraphrase pairs
only partly agree). No user text is stored, so there is nothing personal to leak and nothing for a
later prompt to read as instructions. And a follow-up in a thread can settle or reuse a verdict,
since the key doesn't depend on the thread.

The cost of the key is that the browser must guess the versions before the loop runs. It reads
every row whose `subjects` match the cards in play (any criterion, a handful at most) and, for a
ranking, the row whose `scope` matches what code parses from the message (a canonical position and
a decade or season span). A guess that misses costs a prior, never a wrong one.

### Settling a verdict

The browser never sends a verdict to be stored as written. After the reply is final, a turn that
committed calls `POST /api/debates/settle` with the subject keys, kind, criterion, the chosen side
or order, and the ranking's candidate names. No reasons, criteria or prose cross. The server then:

1. Validates: every subject key resolves on the server (a shared card by key, an era snapshot or
   history record for a club season), at most 2 subjects for a head-to-head, 15 for a ranking, the
   verdict is one of the subjects, and the names are names (length and character checks).
2. Skips when a current row with the same verdict exists, or the key was refused in the last 10
   minutes.
3. For a card-settled criterion, checks the proposal against the cards it reads itself. A proposal
   against the cards is refused; level cards leave it to the next step.
4. Runs one schema-bound call (`settle` task, low thinking) that reads the cards, the stored era
   snapshots and the history records for the subjects, and the proposal, and answers accept or
   refuse with two to four criteria and a counter-case of its own. An accepted proposal is stored;
   a refused one isn't, and the next turn's loop decides afresh.

This is the card review pattern at a smaller size: one side proposes, an independent call with the
record checks, code enforces the cards. First and later askers see the same verdict because the
stored one is the first asker's, once checked.

### Invalidation

- **Re-rated cards.** On read, the browser compares the row's fingerprint with the cards in play.
  For a card-settled criterion a stale row is dropped (the cards are the prior). For any other
  criterion it is shown as stale, naming what changed, so the loop reconsiders; the next accepted
  proposal replaces it. Nothing scans the table when a card changes.
- **New era snapshots.** An era snapshot of one of a row's subjects (a player window or a club
  season) built after the row was settled marks it stale, the same way a re-rated card does. The
  check compares the snapshots' `built_at` with the row's `settled_at` when both are read; the row
  stores nothing extra. The server's settle check treats such a row as replaceable.
- **Departures.** `POST /api/debates/departure` records that a turn departed from a stored settled
  verdict (key only, no reason text). It isn't used for disagreements with a card. When `VERDICT_REOPEN_DEPARTURES` (3) distinct clients have departed, the row
  turns `contested`: it's shown as contested, and the next accepted proposal replaces it. This
  mirrors `REVISION_CONSENSUS_USERS`.
- **Version.** `DEBATE_VERDICT_VERSION` bumps reopen every row when the settle call or the key
  changes.
- A `keep_debate_verdicts` trigger, like `keep_era_snapshots`, skips any update that doesn't carry
  a newer version, a changed fingerprint, or a contested status.

### Abuse

The browser store stayed out of Supabase because anyone could have written the verdict everyone
gets. Here:

- Browsers can't write the table at all.
- No browser text is stored. A verdict is a choice among resolved subject keys; criteria and
  counter-case are the server's own words. So a stored row can't carry an instruction into a later
  turn's prompt.
- A card-settled verdict can't go against the cards, by code.
- Any other verdict must pass the server's independent check against records the server fetched.
  What's left is a defensible verdict on a contested question being the first one stored, which
  the departure count reopens.
- Spend is capped: `DEBATE_SETTLE_CALLS` a day (default 20), five settles an hour per client
  address, one build in flight per key, and `DEBATE_SETTLE=off`. Without the secret key, verdicts
  are kept in the server's memory only, as club snapshots are.
- Departure counts use a salted hash of the client address per day, as the card-order channel's
  sources do. Without accounts this is the weakest part: three addresses can reopen a row. That's
  accepted for now (see Decisions): reopening never changes a verdict by itself and only opens a
  checked, budgeted settle call. Accounts can replace it later.

`liveDebateRecords` and the settled-brief path stay for the stage pipeline until the last
migration step, which points the stage pipeline at the new store and retires them.

## Figures

The brief chose the figures before anyone read the records; `figureBudget` then allowed those
figures and room for their counterparts, and cut other figures' sentences from the end. In the
loop the model reads the records first, then chooses.

- **Slots from the commitment.** The `figures` the model names in `commit_verdict` become the
  budget's slots: `{ max: max(2, 2 × slots + 1), slots }`, as `figureBudget` computes today.
  `matchesSlot` is unchanged, so a figure counts as chosen only when its noun, competition and
  season fit a named one.
- **No named figures.** A turn whose commitment named no figures, or that didn't commit (a fact
  question, a follow-up), has no budget: each figure is still held to the evidence by the scoped
  gate. The first live run (2026-11-18) used a ceiling of six here, which cut a season's goals from
  question 6, the question asking for them, so the ceiling was dropped.
- **Scope checks stay.** `runDeepTurn` passes `{ scoped: true, budget }` to the figure gate on a
  past turn, so qualifier, season and career checks, honour counts and numbers written as words all
  apply as on the debate path.
- **Correction round stays.** `correctReply` already runs on every deep turn with lookups left.
  A figure cut only for the budget isn't a finding, as now, so the round fixes unsupported figures
  and never argues with the budget.
- **Evidence.** The figure gate's evidence on a past turn adds the stored era snapshots and keeps
  everything deep mode already counts: the ledger with tables expanded, the cards, and every tool
  result. The ledger is formatted without `seasonStart`, so web entries aren't tagged as predating
  the season.
- **Manager gate.** The loop passes `past: true` to `sanitizeScoutProse`, which skips the
  current-coach scrub, as the debate path does. Without it, a past coach would be rewritten as
  today's.

## Latency and budget

What past questions cost today, from the 2026-11-01 runs (3.8 Flash; Hydrogen, the current model,
is slower per call):

| Step | Time |
| --- | --- |
| Router | about 2.8 s |
| Debate brief | 2 to 8 s, usually overlapping the router when started early; about 10 ms when settled |
| `player_career`, `club_season` | 0.6 to 1.2 s cold; under 10 ms cached |
| Web search | 9 to 13 s; the debate path cuts it at 4 s past the records, so most were left out |
| First token | median 9.8 s (11.0 s first ask, 5.0 s settled) |
| Total | median 22.6 s |

The present loop's budget (`DEEP_BUDGET_MS` 120 s, 12 lookups, 4 searches, 10 rounds) is far more
than a past question uses, and the present loop never came near it. A past turn gets
`DEEP_PAST_BUDGET`: 60 s, 8 lookups, 2 searches, 5 rounds. Eight lookups cover the debate path's
six plus a card or two read mid-turn; two searches, because records and era snapshots carry what
the debate path's searches were for and each search adds about 10 s; five rounds, because records
return in about a second and most turns should need two.

Expected path on a cold head-to-head: router, card lookup and the context peek (about 3.5 s), a
first round that calls the records and commits (about 4 s), records (about 1 s, less when
prewarmed), and the writing round to the first token (about 3 s): about 11 to 12 s, near today's
11 s. With a current settled verdict and the cards, the model may commit and write in its first
round: about 7 s. A search adds its 9 to 14 s, and the loop has no 4 s cut-off: the model is told
what a search costs and decides. The eval measures whether that's the right call.

## Measurement

### Eval changes (offline)

- `--set historical --deep` sends each question with `deep: true` and `deepPast: true`. With
  `--stage`, it sends `fast: true`, as now.
- The historical report gains the live report's research columns (path, fallback, lookups,
  searches, rounds, views, gate fixed, dropped and removed) and four of its own: committed (yes or
  no), card agreement (agree, level, departed with reason, departed silently), prior used
  (current, stale, none), ratings out of place, and, for a ranking, whether the stored ranking
  was found (code's scope parse against the scope the model committed).
- Ratings out of place is a new grader field: whether the answer quotes a card's Overall or
  attribute on a question that doesn't turn on how good the players were. It measures the problem
  users reported.
- Committed verdicts are compared across runs in code, exactly; the grader comparison stays for
  the prose and for answers that didn't commit.
- The runner uses an in-memory verdict store with the real settle handler in-process, so run 2 and
  each paraphrase read what run 1 settled. `--no-prior` starts every question with an empty store,
  to measure the loop's own consistency. `--no-builds` still applies.

### The deciding run

Questions 1, 3, 5, 6, 13 and 14, each twice, `--deep --no-builds`:

| # | Why |
| --- | --- |
| 1, 13 | Head-to-head of two primes the cards settle, and its paraphrase |
| 5, 14 | A ranking against cards and placements, and its paraphrase |
| 3 | Two club seasons: records, no card settles it |
| 6 | A precise figure from one season: no commitment, the figure ceiling |

```bash
npm run eval:live -- --set historical --deep --only 1,3,5,6,13,14 --no-builds --label past-deep
```

Estimate for 12 answers: about 3 loop calls each (two rounds and the correction round, about 55k
input tokens together, since every round resends the system prompt, the cards and the
conversation), at most one search (about 5k), and four grader calls (about 15k). That's about 75k
per answer, 0.9M for the twelve, plus about 3 settle calls (about 25k), 8 comparison calls (about
30k). Total about **1.0M input tokens, 110 calls, and 50k output tokens plus
Hydrogen's thinking (up to about 1.8k per call, so up to about 0.2M)**.

An optional control on the same six with `--stage --repeat 1` adds about **0.4M input tokens and
40 calls**. The 2026-11-01 stage numbers ran on 3.8 Flash with a smaller card pool, so the control
is the only same-day comparison; skip it if the cap is close.

C3, the past-fact pushback case, is a separate run of two turns
(`npm run eval:live -- --conversations --only C3 --deep`, about 0.1M) and checks the follow-up
bullet.

The switch flips (`DEEP_PAST` to `true`) when the deep run shows:

- Same verdict on every repeated question, and both paraphrase pairs the same.
- On questions 1, 5, 13 and 14, every verdict agrees with the cards or departs with a stated
  reason, and at most one departs.
- Committed on every judgment question.
- Wrong figures per answer no higher than the 2026-11-01 subset's 4 in 7, by the scope-aware
  checker.
- Ratings out of place on no answer to questions 3 and 6.
- Criteria and decisiveness at 4.5 or above, the counter-case taken on in every judgment answer.
- Median first token within 4 s of the stage control's (or of 11 s without one), and no fallbacks.

## Migration

Each step lands as its own change, testable with the model, tools, stores and clock faked, and
none spends a Gemini call.

1. **One list of card-settled criteria.** Done in the card-order build (`CARD_SETTLED_CRITERIA`,
   `scripts/test-card-order.ts`). `big_games` moves to step 3.
2. **`commit_verdict` and its check.** A pure `checkCommitment` in `debateConsistency.ts` (cards,
   settled verdict, departure) and the tool's handler. New `scripts/test-commit-verdict.ts`: agree,
   level, against with and without a reason, a card found mid-turn, the second-call rule.
3. **Past mode in the loop, behind `DEEP_PAST = false`.** `takesDeepPath` with `pastDeep`; the
   past first message (cards' order, edition gaps, stored era snapshots, no coaches);
   `pastModeRules`; `DEEP_PAST_BUDGET`; the past `uncheckedFor`; `prewarmCareers`; no early
   debate brief when the loop may take the turn; `past: true` and the scoped figure options;
   `big_games` in `DEBATE_CRITERIA` and `RANKING_CRITERIA` (not card-settled); the cards' order
   and `commit_verdict` on present-day deep turns with two or more carded versions; pairs reported
   through `reportCardDisagreements` with `via: 'deep'`. New
   `scripts/test-deep-past.ts`: which turns take the loop with the switch on and off, the first
   message's blocks, the budget line, the figure slots from a commitment and the ceiling without
   one, a past coach left alone, a fallback to the debate path, a Gaffa-club conversation whose
   user names the past, a current-against-prime turn getting the cards' order, a pair reported
   with path `deep`. `test-deep-turn.ts` keeps passing with the switch off, and
   `test-card-order.ts` accepts the new path.
4. **Settled verdicts.** The migration (`debate_verdicts`, public read, `keep_debate_verdicts`),
   `services/debateVerdicts.ts` (keys, fingerprints, staleness, the browser read), and on the
   server `POST /api/debates/settle` and `POST /api/debates/departure` with the settle call,
   budget, rate limit and off switch. New `scripts/test-debate-verdicts.ts`: keys from cards and
   club seasons, paraphrases sharing a key, a re-rated card making a row stale, a proposal against
   the cards refused without a call, accept and refuse, the daily cap, three departures contesting
   a row, nothing stored from browser text. `test-snapshot-server.ts` gains the two routes.
5. **Eval support.** The flags, columns, grader field and in-memory store above. Tests: the report
   builder with fake runs.
6. **The live run**, on the user's approval of the estimate above. If it passes, `DEEP_PAST` flips
   to `true` in its own change, and `CLAUDE.md`'s "Questions about the past" and "Deep mode"
   sections are rewritten.
7. **Retire what the loop replaced.** The stage pipeline's debate path reads `debate_verdicts` as
   its settled brief's source; `liveDebateRecords`, `startDebateBrief` and the browser
   `DebateStore` go. `runDebateResearch`, `cardBrief` and `checkBriefAgainstCards` stay as the
   fallback.

## Decisions

Answers to the questions this design left open, decided on 2026-11-18.

1. **Requiring the commitment.** Measure, don't force. Code enforces facts and budgets, not
   judgment. The eval reports judgments written without `commit_verdict`, and that report decides
   whether anything more is needed.
2. **Current form against a prime.** These turns get the cards' order and `commit_verdict`. Both
   versions have cards, and the card rule is about versions, not about the thread's era.
3. **Following a settled verdict.** The reply doesn't announce it, unless the user asks why or it
   matters to the answer, matching the card-mention rule against narrating internals.
4. **Hashed client addresses.** Accepted for now. The departure counts only open a checked,
   budgeted settle call. Accounts can replace them later.
5. **A new era snapshot.** It marks verdicts settled before it existed as stale, as a re-rated card
   does.
6. **Stored ranking lookups that miss.** Measured in the eval.

## Not in scope

- The card-to-card-review channel, beyond adding the `deep` path
  (`docs/superpowers/specs/2026-11-18-card-order-disagreement-design.md`).
- The wording of how a reply mentions a card (the card-mentions work in `prompts/chatPrompt.ts`).
- Prompt consolidation across paths (the chat-principles session).
- Changes to the era snapshot builds or the history routes.
