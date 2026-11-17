# Gaffa conversations in deep mode, and one agentic path

Date: 2026-11-17

## Problem

Deep mode (`services/deepTurn.ts`) has been the default path for present-day questions since PR 81, but `takesDeepPath` sends every turn with a Gaffa club attached to the stage pipeline, because only that pipeline builds the club's blocks (`buildGaffaTurn`) and runs the Gaffa post-processing. The shared conversation `/c/W8BVT5`, the worst Gaffa conversation on record, ran on the stage pipeline. The composer also still carries a Fast toggle and the stage writer a `request_deeper` tool, both from the time deep mode was opt-in.

Decisions already made: Gaffa conversations in the app take the deep loop with the club context and the same checks; Gaffa's own panel (`noRating`, ten turns a day) and trade questions stay on the stage pipeline; the Fast toggle goes.

## Entry

`takesDeepPath` drops its blanket `gaffa` exclusion and gains `gaffaTrade`. A turn with a club attached takes the loop unless it is a panel turn (`noRating`, already excluded) or a trade: `leagueFocusOf` gives `trade` (which also covers a follow-up in a trade thread) or `looksLikeAssetTrade` matches the message. Every other exclusion stays. `sendMessageToAI` works out `gaffaTrade` before routing, so the early question search starts only for turns that may still end on the stage pipeline (the panel and trades).

## Context in the first message

`runDeepTurn` takes `gaffaBag`. Before the first round it builds the Gaffa turn with `buildGaffaTurn`, PR 86's squad availability included, and puts its blocks after `<context>`: the club and squad block always, then `<gaffa_manager_reasoning>`, the rules, the lineup audit, the market lock and the bid calculator as the focus decides. `buildGaffaTurn` gains `scorecard: false`, so the loop can never pay for a trade scorecard even if a caller sends one. The focus is recomputed every turn from the message and the history, as on the stage pipeline. The starters' Premier League clubs (`squadClubs`) join the spotted clubs for stored snapshots and coaches, as they join the stage pipeline's research. The thread signature carries the club id, as on the stage pipeline, so switching clubs starts the follow-up state afresh.

## Tools

On a Gaffa turn the loop also gets `grep_gaffa_market`, the stage writer's local filter over the league's free agents, squad, listings and auctions. It reads the bag in memory, so it is free, like `grep_saved_dossiers`.

No new availability tool. The squad block already prints the FPL line beside every player Gaffa lists as anything but active and every player FPL lists as out, and `get_player_season` returns any Premier League player's FPL status (`describeFplStatus`), so a free agent or another player the user names is one counted lookup away. A second route to the same feed would only split the budget.

The turn's instructions gain one line saying the club's blocks are the source for the squad, the market and the rules, and pointing at those two tools.

## Locks and gates

The stage pipeline's Gaffa post-processing (`finishGaffa`) moves into `gaffaTurn.ts` as `finishGaffaReply` and both paths call it on every gated segment, on the stream and on the final reply: `lockGaffaRosterNames`, and the trade cap when a scorecard exists (stage only).

The market rule ("a player is available in this league only when the market list names him") was a prompt rule on both paths: no code enforced it. A new code gate, `gateGaffaMarket`, does. On a turn whose focus isn't `none`, it removes each sentence that puts forward a player who is on none of the bag's lists (free agents, listings, auctions) nor in the squad. A player is put forward when he is the object of sign, nominate, bid on, claim, pick up or grab (on a market question also buy, target, bring in, acquire or add), or when a sentence with a market cue (free agent, unowned, FA, nominate, auction, bid, waiver, claim; plain "available" only on a market turn, where it can't mean fitness) introduces him as `**Name** (Club ...)`, opens on his full name, or lists him after "free agents such as". Denied claims ("isn't a free agent", "owned by") and verbs told not to happen ("don't sign") are left alone. A list item that introduces such a player goes whole, a table row that leads with his full name goes whole, a following sentence that opens on he or his goes with the cut one, and sentences are cut through the figure gate's `drop` option so nothing is left as a fragment.

The shape rules are narrow on purpose. A first draft treated any bold label in a market sentence as a name, and C1's recorded first reply showed why that fails: labels such as "Scout's Fee Rebate" read as unlisted players. With the narrow rules, all three recorded C1 replies pass untouched against a bag holding their players, and taking one free agent off the list removes only the sentence that names him. What the gate can still miss is a player named in a sentence of another shape (a bare surname in a cost line, say); the prompt rule still covers those. A legacy bag with no free-agent list checks against auctions and listings, as its market block already tells the model. Because the rule was the same on both paths, the gate runs on both: the stage pipeline gains it too. It isn't part of the gate-feedback correction round; a market finding has no evidence the model could rewrite towards.

The figure gate counts the Gaffa blocks as evidence on the deep path, as on the stage path; `grep_gaffa_market` results join the tool results like every other tool's.

## Threads about the past

Replaying C1 showed a second cause of that conversation's trouble. `threadIsHistorical` reads the last six messages, replies included, for "prime", "peak" or a decade, and the recorded first reply called a free agent "in his prime years". Every later turn therefore counted as a thread about the past: on the stage pipeline that means the debate brief and no Gaffa club at all (`runConversationalScout` drops the bag on a historical thread), and under this change it would have kept the turn off the loop. A conversation with a club attached now counts as about the past only when the user's own words say so (`threadIsHistorical(..., { userOnly: true })`), on both paths. Conversations without a club are unchanged.

## Fallback

Unchanged: a deep Gaffa turn that gives up runs the stage pipeline once, which builds its own Gaffa turn with the club.

## Retiring the Fast toggle and Go deeper

- The composer's toggle and `speedToggle` go. `deep` and `fast` stay in `SendMessageOptions`: the eval's `--deep` and `--stage` and the tests force a path with them.
- With no Fast turns, `request_deeper` could only ever be offered when `DEEP_BY_DEFAULT` is off. The tool, its rule, `InitiativeOptions.deeper` and the composer's Go deeper slot go; `initiative` becomes a plain flag. The Go deeper chip goes. The `goDeeper` block kind, its type, registry entry and `blocksOf` mapping stay so stored conversations still parse, and `ReplyBody` draws `drawnBlocksOf(message)`, which leaves a stored one out: its only action reran the turn in deep mode, which is now what every eligible turn does.
- `DEEP_BY_DEFAULT` stays as the one-line kill switch: set to `false`, every chat turn takes the stage pipeline and nothing in the UI asks for deep. `deepByDefault` stays as the per-turn override tests and the eval use.

## Tests

`scripts/test-gaffa-deep.ts` (in `npm test`, model, tools and availability faked): a squad, a market and a lineup question take the loop with their blocks in its first message and `grep_gaffa_market` among its tools; the grep runs free; the market gate removes an unlisted free agent from a deep reply on the stream and the final reply and keeps a listed one; a trade question and a panel turn stay on the stage pipeline; a failing loop falls back to the stage pipeline with the club; a club thread reads as present unless the user names the past; and C1 (`/c/W8BVT5`) from the live set's Conversations section is replayed turn by turn through `sendMessageToAI`, checking each turn takes the loop with the club block, the starter's FPL line and the reasoning block, and the market blocks on the first turn. Existing tests drop the toggle and Go deeper cases. The live set gains C5, one Gaffa market question, for the eval subset.
