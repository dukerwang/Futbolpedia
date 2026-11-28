# Current vs. Season Bridge Check

## Cost and Approval

**Don't run this without the user's approval.** It needs `EVAL_GEMINI_API_KEY`, a key from a
separate Google project with a small spending cap, and the script refuses to start without it. Past
evals on the app's key spent the cap and took futbolpedia.org's chat down.

For the eight players below:

| | Calls | Input tokens | Output tokens (thinking included) | Grounded searches | Cost |
| --- | --- | --- | --- | --- | --- |
| Expected | 41 | about 358,000 | about 91,000 | 16 | about $0.68 |
| Ceiling | 57 | about 662,000 | about 151,000 | 64 | about $1.68 |

The calls are one cap check, then for each player: one identity lookup (grounded), one season web
search (grounded), one head-to-head comparison with the closest peers, one card synthesis and one
strengths and weaknesses rewrite. The ceiling assumes every comparison sends a reason back and every
card fails validation once, so each is made twice, and every grounded call runs four searches.

The synthesis input, about 29,000 tokens, was sized on 2026-11-27 from the real prompt with 209
served cards in the library. It grows with the library. Output tokens are modeled, not measured. The
dollar figures use the same placeholder prices as the other evals ($0.50 per million input tokens,
$3.00 per million output tokens, $0.014 per search), so confirm them on the project's billing page.
Earlier runs in this project have come in over their estimates, so check the eval project's
remaining budget against the ceiling.

## Question

Do current-form cards sit below historical cards for the same football? A season card goes through
the historical pipeline. If the historical pipeline rates a player's last season consistently above
his current card, and his football hasn't changed to explain it, the difference is the bias between
the two pipelines, measured.

## Method

For each player, the script rates his 2025-26 season as a season card and compares its Overall with
his published current card's. The gap is the season Overall minus the current Overall.

The season draft differs from a visitor's season request in three ways:

- **It can't see the player's own cards.** The peer ledger, the closest peers and the prior-rating
  block leave them out. A normal season rating reads his current card, which would anchor the number
  being compared with it. Every other card is in view, so he's placed by comparison as usual.
- **It's rated fresh**, even when a 2025-26 season card is already published.
- **It's never published.** The script reads the shared cards through a read-only Supabase client,
  and the draft is held (`draftBlindSeason` in `services/geminiService.ts`).

The app's other routes (live feeds, API-Football) answer as unavailable. A season rating reads the
career record, one web search and any stored era snapshot, so it doesn't need them.

## When to Run It

Run it after the players' current cards have been rated with the 12-month window. Cards rated on or
before 2026-11-04 predate the window and the changes in #115, #117 and #119, so a gap against them
mixes all of those. Their 30-day windows close from 2026-12-04, and card review re-rates them. The
report's **Form window** column says which current cards have one.

Running it once before those re-ratings and once after shows what the window changed, at twice the
cost.

## Players

Eight active players with published current cards on 2026-11-27, across six positions:

| Player | Position | Current Overall on 2026-11-27 |
| --- | --- | --- |
| Nuno Mendes | Left-Back | 90 |
| Reece James | Right-Back | 86 |
| Moisés Caicedo | Defensive Midfielder | 91 |
| Declan Rice | Central Midfielder | 91 |
| Pedri | Central Midfielder | 91 |
| Jude Bellingham | Attacking Midfielder | 93 |
| Lamine Yamal | Winger | 93 |
| Kylian Mbappé | Centre Forward | 95 |

On that date the library had no current goalkeeper card, and its only current centre-back card
wasn't a player in form. If cards for either exist when you run it, swap them in for the second
central midfielder and the second full-back. Swap out anyone whose card is gone, who missed most of
2025-26, or whose role or level has plainly changed since.

## Commands

Price the run first. This makes no call and needs no key:

```bash
npx tsx scripts/eval-bridge-check.ts --dry-run --players "Nuno Mendes,Reece James,Moisés Caicedo,Declan Rice,Pedri,Jude Bellingham,Lamine Yamal,Kylian Mbappé"
```

After the user approves, with `EVAL_GEMINI_API_KEY` set in `.env.local`:

```bash
npx tsx scripts/eval-bridge-check.ts --players "Nuno Mendes,Reece James,Moisés Caicedo,Declan Rice,Pedri,Jude Bellingham,Lamine Yamal,Kylian Mbappé" --label window
```

The script has the same cost controls as the other evals (see [README.md](README.md)): a cap check
before anything else, a stop at the first 429, the day's search cache, and real token and search
counts at the end. It writes `reports/<date>-<time>-bridge-<label>.md` and its JSON after each
player. A player with no current card is listed and costs no call.

## Reading the Result

- **A consistent gap** is a median gap of +1 or more, with the season card higher for at least six
  of the eight. That's the pipeline bias, and its size is about the median.
- **A mixed result**, with gaps in both directions and a median of 0, shows no bias this check can
  see.
- **A negative median** means the guard against reputation carry or the window rule is pushing
  current cards the other way. Read the cards before concluding anything.

Check these before trusting a gap:

- **The windows overlap.** A current card rated in December 2026 covers December 2025 onward, so
  about half of 2025-26 is in both. Real differences between the two are therefore expected to be
  small, and a gap of several points is unlikely to be form alone.
- **Real change is real.** A player who has declined, moved or changed role since 2025-26 should
  have a gap. Take him out of the median and say why.
- **One run per player.** The model's ratings vary between runs, so a 1-point gap for one player
  means nothing. Only the direction across players does.
- **Never correct by a number.** The result says whether the evidence or the instructions need
  work. Ratings are calibrated by comparison with peers, never by adding an offset.

## Tests

`scripts/test-eval-bridge-check.ts` (in `npm test`) fakes the model and covers the comparison, the
stop at a spending limit, the estimate and the refusal without the eval key.
`scripts/test-dossier-pipeline.ts` runs the blind draft end to end with Gemini faked at `fetch` and
checks that none of the player's own cards reaches the prompt.
