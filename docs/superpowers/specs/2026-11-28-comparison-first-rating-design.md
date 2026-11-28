# Comparison-First Rating

## Problem

A prime re-rated on 2026-11-28 came out at 90, below four 91 primes at his position, with a case
for lower that cites a 12-week muscle injury. Earlier versions of the same card argued injuries and
consistency; once Protocol B banned availability, the chat argued work rate and pressing instead.
Every rule removed one reason and the model found the next, because the reason never set the
number.

The synthesis call sees every peer's Overall (the ledger lines and `<closest_peers>` in full), picks
a number that fits among them, fills `peerPlacement` to match, and writes the justification last.
The order comes first and the football is written to defend it.

Challenges have the same shape. A challenge on that card argued for 91 in its prose but left
`dossierPatch.peerPlacement` empty, so `placeRevisedOverall` fell back to the stored placement and
held 90, and the reply ended with an appended sentence contradicting its own paragraph. The
correction round from #120 was meant to stop that and didn't.

## Design

### Comparison before numbers

`services/peerComparison.ts` runs one schema-enforced call on the synthesis model before synthesis.
It compares the version being rated with each of his closest peers (`selectClosestPeers`, as the
rating already chooses them) head to head: `better`, `level` or `not_as_good`, each with one
sentence of football reasoning.

The call sees no number. Each peer is shown by name, version and window, position, best roles,
archetype, playstyle, strengths and weaknesses (`serializePeerForComparison`). Overall, Potential,
tier and attribute values are left out, and any "<attribute> 91" or tier name inside a peer's prose
is cut. The player is shown from the same `<factual_foundation>` synthesis reads, with the task that
names his version. The prompt asks which was the better footballer, the question Overall answers,
and says availability, durability, minutes, team success, trophies and fame are not reasons. It
names no player, rating anchor or sample phrase.

Peers are labelled `P1` to `P6` in the prompt, so a comparison maps to a card by its label and never
by name resolution.

### Reasons checked by code

`services/reasonCheck.ts` reads each reason for an argument from availability (injuries, missed
matches, minutes played, durability, fitness record), team success (trophies, titles, team results)
or fame. The patterns look for the argument, not a word: a reason that mentions a match, a final,
"the final minutes" or "won the ball" passes, and one that says he missed half a season, played
more matches or won more titles is flagged.

Flagged pairs go back once, in one follow-up call covering only those pairs, with what each rested
on. A pair still flagged after that is dropped: it doesn't count toward the placement and isn't
stored.

### Range by code, card inside it

The comparisons become the placement: `better` is `betterThan`, `level` is `levelWith`,
`not_as_good` is `notAsGoodAs`, each resolved to its peer card directly. `placementRange` in
`services/ratingPlacement.ts` turns that into the Overall range it allows.

Synthesis receives the comparisons and the range in a `<peer_comparisons>` block as a constraint it
writes within: the Overall goes inside the range, and `calibration.peerPlacement` repeats the
comparisons. Code then holds the card to the range and records the comparisons as the card's
`peerPlacement`, whatever the model filled.

When the comparisons contradict each other there is no range. Synthesis then rates as it does today
(its own placement against the ledger, held by `applyPeerPlacement`), and the confidence verdict
says the head-to-head placement was mixed. When the call fails, times out or no peer survives,
synthesis rates as today with no note.

The comparisons are stored on the card as `peerComparisons` (optional, so old cards still read),
each with the peer, the judgment and the reason, also when they were mixed. Chat reads them in the
card's history block. Card review's prime drafts get the comparison step through `draftPrimeRerate`
(`services/geminiService.ts`), which runs `rateDossier`; `services/cardReview.ts` is left alone
while the ledger-quarantine change is in flight, so the reviewer's own card description
(`describeCard`) doesn't quote the comparisons yet.

### Availability out of every field

The case for higher and for lower (`scoutingDebate`), `peakContext` and the confidence verdict argue
football. The schema descriptions say so. `reviseCardTraits` (`services/cardTraits.ts`) already runs
one call on every new card's traits; it now also reads `scoutingDebate`, and a case the reason check
flags is marked `[REWRITE]` with id `DEBATE_HIGHER` or `DEBATE_LOWER` in the same call. A rewrite
that is still flagged is ignored and the case stays as written. When the traits need nothing and a
case is flagged, the call runs for the case alone. No call is added to a card that had one.

### Challenges carry their placement

`dossierPatch.peerPlacement` is required in the challenge schema, with all three arrays required
(empty when the Overall doesn't move).

A challenge whose patch moves the Overall runs the same comparison step against the card's closest
peers, with the user's argument, the card's stored comparisons and any grounding notes as context.
Code derives the range:

- The proposed Overall is inside the range: the card takes it, and its placement and comparisons are
  the new comparisons.
- It's outside: the card takes the range's nearest value, and one more challenge call is told the
  comparisons, the range and the Overall the card will show, and writes the reply for that number.
  If that reply still states another Overall for the player, code replaces the number in place.
- The comparisons contradict each other or the call fails: the model's own placement places the
  Overall, as before (`placeRevisedOverall`), and the reply's number is aligned the same way.

The reply never states an Overall the card won't show. The appended "the card's placement ... holds
this version at" sentence and `placementCheckBlock` are gone.

### Chat explains cards honestly

The chat mandate's pushback section gains one line: when a user questions an order between carded
players, explain it from what the cards say (their comparisons and reasons, strengths, weaknesses,
placement), never from a criterion the cards don't state; when the user's argument is strong, say
so plainly and point to Challenge.

## Cost

One added call per rating (the comparison), on the synthesis model, about 9,000 input tokens and
about 1,500 output tokens with thinking; two when a reason is flagged. The bridge check's season
drafts make it too, so its estimate rises from 33 to 41 calls expected. A challenge that moves the
Overall adds one or two (the comparison and, when the number falls outside the range, the rewrite);
one that doesn't move it adds none.

## Live Check (Plan Only)

**Needs the user's approval and `EVAL_GEMINI_API_KEY`. Don't run it without both.** Past evals on
the app's key spent the cap and took futbolpedia.org's chat down.

Re-rate five primes at one position whose order the user can judge, held and never published, and
read each card's comparisons, reasons, range and Overall. Five central midfielder primes from the
shared library are a good set: pick five whose order you hold a firm view on, including the prime
whose re-rating prompted this change.

Price it first (no key, no call):

```bash
npx tsx scripts/eval-prime-order.ts --dry-run --players "Name One,Name Two,Name Three,Name Four,Name Five"
```

Then, with approval:

```bash
npx tsx scripts/eval-prime-order.ts --players "Name One,Name Two,Name Three,Name Four,Name Five" --label cm-primes
```

The script reads the shared cards through the read-only client, runs `draftPrimeRerate` for each
player (a rerate with his own cards out of view, held, never published), and writes a report under
`docs/superpowers/evals/reports/` with each player's published Overall, the new Overall, the range
and every comparison with its reason.

| | Calls | Input tokens | Output tokens (thinking included) | Grounded searches | Cost |
| --- | --- | --- | --- | --- | --- |
| Expected | 26 | about 224,000 | about 57,000 | 10 | about $0.42 |
| Ceiling | 36 | about 414,000 | about 95,000 | 40 | about $1.05 |

The calls are one cap check, then for each player: the identity lookup (grounded), one web search
(grounded), the comparison, the synthesis and the traits rewrite. The ceiling adds a reason
follow-up and a synthesis retry for every player, and four searches per grounded call, so a run
stays near 40 calls at worst. `--dry-run` prints the same figures. Synthesis
input is about 29,000 tokens with the library as it stood on 2026-11-27, the comparison about 9,000.
Prices are the evals' placeholders ($0.50 per million input tokens, $3.00 per million output tokens,
$0.014 per search); confirm them on the billing page.

**Reading it.** The check passes when the comparisons' reasons are football (no availability, team
success or fame survives), each Overall sits inside its range, and the order of the five matches
the order their comparisons give. A card whose comparisons were mixed says so in its confidence
verdict. If the order still looks wrong to you, read the reasons: a wrong reason points at the
comparison prompt, a right reason with a wrong number points at the range.
