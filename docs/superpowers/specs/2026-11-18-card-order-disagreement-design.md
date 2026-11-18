# Card order disagreements

Status: built 2026-11-18. No live Gemini calls; every check is offline.

## Background

Cards anchor "who was better" answers. When a question turns on how good players were, code puts
carded players in card order, so two conversations never contradict each other or the cards. Two
places do this:

- The debate brief's check (`checkBriefAgainstCards` in `services/debateBrief.ts`, built on
  `checkOrderAgainstCards` and `checkVerdictAgainstCards` in `services/debateConsistency.ts`), on a
  thread about the past.
- `show_ranking` (`services/replyBlocks/ranking.ts`), on any prose turn that draws a ranking.

Both tell the model what moved (`cardNotes`, the tool result's `moves`). Two problems remain:

1. The two places use different rules for when the cards settle an order. The debate check covers
   `peak_level` and `mixed`; `show_ranking` also covers `sustained level`. The same question gets a
   different order depending on the path.
2. A model whose evidence says a card is wrong has nowhere to say so except by arguing against the
   card in prose. The card never hears about it.

## Part 1: one rule

### Decision

The cards settle an order for **peak level** and **mixed** only. Sustained level is left out.

### Reasoning

A card's Overall is the level one version of a player held across a window of at most three
seasons. It is not a measure of how long he stayed there:

- `prompts/dossierPrompt.ts`: "A card rates one version of a player ... never his career or
  legacy", and a prime is rated at "the level he sustained across that window, not one season's
  spike and not his career".
- `services/dossierSynthesizer.ts`, the prime and era instructions: rate the level he sustained
  across the window, "not his career, longevity, trophy count or legacy".
- `constants/ratingTiers.ts`: every tier measures how good a footballer the version is on one
  all-era standard; honours and dominance of an era are evidence, never the band.

The debate brief defines `sustained_level` as "how long it held a high level", and `show_ranking`
describes it as "how good over a career". That is longevity, which the rating rules exclude from
the card. A player with a two-season prime at a higher level than another's decade at a slightly
lower level has the higher card, and the longer career can still win a sustained-level question.
So for sustained level the cards inform the argument and the model's order stands, as for output,
influence and versatility.

The "level he sustained across that window" wording in the card rules is about the window, not the
career: it stops a one-season spike from setting a three-season prime's rating. It doesn't make the
card a longevity measure.

### Shape

`services/debateConsistency.ts` exports:

- `CARD_SETTLED_CRITERIA`: `['peak_level', 'mixed']`.
- `cardsSettle(criterion: string)`: true for a criterion in that list, read in either spelling
  (`peak_level` from the debate brief, `peak level` from the ranking view).

`checkVerdictAgainstCards`, `checkBriefAgainstCards` and `show_ranking` all call `cardsSettle`.
`CARD_ORDERED_CRITERIA` is removed. The `show_ranking` declaration names the criteria from
`CARD_SETTLED_CRITERIA`, so its description can't drift from the rule.

## Part 2: disagreements reach card review

### Principle

The answer stays consistent: the checks still put carded players in card order. What changes is
that each time a check moves the model's order, the move is recorded as evidence that two cards
may be out of place, and the daily card review can re-examine them. A disagreement never changes a
card directly, never changes what another user is told, and never spends calls beyond the card
review budget.

### What counts as a disagreement

A disagreement is one ordered pair of shared cards: the model put card `lower` above card `higher`,
and the cards put `higher` above `lower`. Captured at:

- **The debate check.** `checkOrderAgainstCards` now returns `swaps`, each carded entry that moved
  up with each carded entry it passed, as card keys. `checkVerdictAgainstCards` returns the pair
  when it changes a verdict. `checkBriefAgainstCards` reports both when the check runs on a written
  brief. A settled debate reused from the browser session and the late `cardBrief` (already in card
  order) report nothing.
- **`show_ranking`.** When the cards reorder a ranking under a settled criterion, its swaps are
  reported.

A pair is reported only when both cards carry a card key. Level cards produce no pair (nothing
moves).

### Model-called tool: not built

A tool such as `flag_card(card, reason)` would let the model flag a card nothing moved, with its
reason. It isn't built:

- The reason is free text written from a conversation the user steers. It can't reach the planning
  call or the reviewer without letting a browser write into another prompt.
- Without the reason, the tool adds only cases the automatic capture misses, mostly a model that
  thinks one card is wrong with no second card in play. A count against a single card says much
  less than a pair, and the coherence and covered-gap signals already cover single cards.
- It would need a prompt rule in `prompts/chatPrompt.ts`, which another session owns.

It can be added later as another source for the same tally, counted without its reason.

### Path to the server

```
browser turn ──report──▶ POST /api/cards/disagreements ──▶ scout tally (memory)
server turn (Gaffa panel) ──report──▶ scout tally (directly)
                                             │
scout's day ── gatherCardSignals ◀───────────┘  resolved against the served pool
       │
       ├─ summary: "Pairs of cards that answers ordered the other way"
       └─ actions: review_prime for a prime in a pair; a current card in a pair is queued
```

`services/cardDisagreements.ts` holds the sink, the request reader and the tally:

- `reportCardDisagreements(pairs)` hands pairs to the current sink and never throws. In a browser
  the default sink posts them, at most once per pair per page load, to `/api/cards/disagreements`
  with `keepalive`. Elsewhere the default is nothing; the server sets a sink that records into its
  tally (`setDisagreementSink`), so Gaffa panel turns count too, under one source, `server`.
- `readDisagreementReport(body)` accepts at most `MAX_PAIRS_PER_REPORT` (8) pairs, each two
  distinct card keys of the shape `getCardKey` produces and a `via` of `debate` or `ranking`.
  Anything else is dropped. No text, reason or name is read.
- `createDisagreementTally(now)`, composed into `createScoutTally`, counts each pair once per
  source per day over `DEMAND_DAYS` (7). A source is a salted hash of the request's address, kept in
  memory only; at most `MAX_PAIRS_PER_SOURCE_DAY` (12) pairs a source a day count, and at most
  `TALLY_CAP` pairs are held. A restart loses the counts, like the other tallies.

The route answers 204 whatever it receives. It does no database read: the keys are checked at
planning time, against the pool card review already reads.

### What a browser can and can't do

A browser can report pairs that never happened. The design bounds what that buys:

- **Only real cards count.** At planning time each key must resolve to a card in today's served
  pool (shared cards only; personal revisions and re-rated keys don't resolve), and the shared
  cards must still put `higher` above `lower`. Anything else is dropped before the planner sees it.
- **Counts, not content.** The planner and the reviewer see card keys, names from the cards, and
  counts: reports (source-days), days and which path. Nothing a user wrote crosses.
- **A threshold.** A pair enters the signals only with at least `DISAGREEMENT_MIN_REPORTS` (2)
  counted reports, so one source needs two days.
- **The source hash is a heuristic, not a boundary.** Behind a proxy it may merge or split
  visitors. The guarantees above don't depend on it.
- **The worst case is a refused review.** A forged pair can at most make the planner spend part of
  the day's `CARD_REVIEW_CALLS` on a review that fresh research doesn't support. The reviewer and
  code's guards decide; a disagreement alone can't move a card more than one tier band.

This is the same exposure as card views, which a browser can also inflate by loading pages.

### In the scout's day

`gatherCardSignals` adds `disagreements`, each with both cards as `CardRef`s (higher first), the
counted reports, the distinct days, the first and last day, and the count by path. Capped at
twenty, most reported first. `formatCardSignals` lists them under their own heading, and the log's
signal line counts them.

Actions:

- **`review_prime`**: a prime card in a pair is a review target (`cardTargets.review`). `openedFor`
  opens the review with kind `disagreement` when no covered gap or contradiction comes first. Its
  evidence re-checks the pair against today's pool and states the count, both cards, and that only
  the count was kept. A pair that no longer holds gives no evidence, and the review isn't run.
- **`rerate_current`**: a current card can only be re-rated after its window closes. A current
  card in a pair is listed with when its window ends; the journal keeps the signal, and `queued()`
  reads it back, so on the day the window closes the card shows as queued in the list of cards past
  their window, with the disagreement as why.
- Era and season cards in a pair are listed for the record. No action reviews them today.

Code's guard on a draft (`guardDraft`) refuses a move across more than one tier band when the review
was opened on a disagreement, since a count is not a record. The reviewer prompt is unchanged: its
"proportionate" check already says a contradiction may call for no move on this card when the other
card is out of place, and the disagreement's evidence says the same.

The planner's card action list says `review_prime` may name a prime in a disagreement pair. No new
action, no new budget: every action still comes out of `CARD_REVIEW_CALLS`.

### What the model is told

Nothing new. `cardNotes` and the ranking tool result are unchanged, and no prompt mentions that a
disagreement is recorded, so replies don't start describing their own bookkeeping.

## Tests

`scripts/test-card-order.ts`, in `npm test`, with the sink, stores and clock faked:

- The rule: `cardsSettle` for every debate and ranking criterion in both spellings; the debate
  check and `show_ranking` agree on every criterion for the same cards (sustained level reorders in
  neither, peak level and mixed in both).
- Capture: swaps from `checkOrderAgainstCards`, the pair from a changed verdict, nothing from level
  cards or an unchanged order, `checkBriefAgainstCards` reporting, `show_ranking` reporting under a
  settled criterion and not otherwise, and the browser sink posting each pair once.
- The route reader: malformed bodies, long lists, bad keys, a pair of one card.
- The tally: one count per source per day, the per-source cap, the week's window, the size cap.
- Card review: pairs resolved against the pool, dropped when a key is gone or the cards now agree
  with the answer, the threshold, the summary section, `cardTargets` and `sanitizePlan` admitting a
  prime in a pair, `openedFor` with kind `disagreement`, the review skipped when the pair no longer
  holds, `guardDraft` refusing a two-band move, and a current card queued from the journal.
