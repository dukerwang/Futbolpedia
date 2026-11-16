# Chat components and presentation as tools

How a reply is shown becomes the model's call. Today a reply is prose followed by a fixed stack of
optional fields (`lineups`, `cards`, `scoutOffers`, `ask`, `goDeeper`, `gaffaScorecard`), each
attached by code and drawn in a fixed order by `ChatMessage.tsx`. This design replaces that with
an ordered list of typed blocks, a registry that defines each kind of block once, and a set of
view tools the model calls on any chat turn, so a view lands in the reply where the model reached
for it.

It implements item 1 of `2026-11-16-agentic-identity-roadmap.md` and supersedes that item's plan to
keep code attachment rules as fallbacks: the model alone decides what a reply shows.

## Principle

The roadmap separates constraints on what the scout may claim, which stay, from constraints on
what it may do, which this work loosens. Applied to presentation:

- **The model decides**: whether to show a view, which one, how many, and where in the reply. Every
  chat turn that writes prose is offered every view tool. No code attaches a view on its own.
- **Code holds conduct**: a view shows only data code fetched from a real source; the model names
  the subject and never supplies the figures. A ranking that claims who was better follows the
  cards' ratings.
- **Code holds plumbing**: a surface that can't draw a view isn't offered the tools, and a ceiling
  stops a runaway loop.

## Stack

React 19 and the Tailwind theme in `index.html`, with views drawn as hand-written SVG or HTML,
like `PitchView.tsx`. No new runtime dependency. Chat kits (assistant-ui, the Vercel AI SDK's
generative UI, shadcn) would fight both the editorial look and the custom Gemini pipeline.

## Data model

### Blocks

`ReplyBlock` in `types.ts` is a discriminated union on `kind`:

| Kind | Payload | Drawn by |
|---|---|---|
| `prose` | `text` (markdown) | the existing markdown renderer |
| `pitch` | `LineupView` | `PitchView` |
| `table` | `league`, `season`, `rows`, `groups?`, `highlight` (club names) | `LeagueTableView` (new) |
| `comparison` | two `ChatDossierRef`s with each card's attributes (or goalkeeper attributes) | `ComparisonView` (new) |
| `ranking` | `title`, `criterion`, `entries` (each a `ChatDossierRef` or `{ name }` for an uncarded player), `moves` | `RankingView` (new) |
| `card` | `ChatDossierRef` | `DossierChatCard` |
| `scoutOffer` | `name` | `ScoutOffer` (moved out of `ChatMessage.tsx`) |
| `ask` | `AskPrompt` | `AskChips` |
| `goDeeper` | `GoDeeper` | `GoDeeperChip` |
| `scorecard` | `GaffaTradeScorecard` | `GaffaTradeScorecardView` |

Every non-prose block has an `id` and a `status`: `pending` while its data loads, then `ready` or
`failed`. Only `ready` blocks are stored with the conversation.

### Messages

`ChatMessage.blocks?: ReplyBlock[]` holds a new reply. New replies stop writing `lineups`,
`cards`, `scoutOffers`, `ask`, `goDeeper` and `gaffaScorecard`; the fields stay on the type for old
conversations. `content` stays the reply's full prose (the prose blocks joined), so Copy, chat
titles, sharing and anything else that reads `content` keep working.

`blocksOf(message)` returns `message.blocks` when present, else builds blocks from the legacy
fields in today's order (scorecard, dossier, prose, lineups, cards, Scout offers, ask, Go deeper).
Storage is never rewritten.

### Registry

`services/replyBlocks/` holds one file per kind and an `index.ts` that collects them. An entry has:

- `tool?`: the Gemini function declaration, for kinds the model can call. Kinds code adds
  (`scoutOffer` from the router, `ask` and `goDeeper` from initiative, `scorecard` from the Gaffa
  path) have none here; their existing tools and paths add them.
- `build(args, ctx)`: resolves real data through the existing feeds and card lookups and returns
  the block, or an error string the model reads as the tool result. `ctx` carries the turn's
  toolset, card lookups, evidence ledger and clock, so tests fake them.
- `toolResult(block)`: what the model reads back. For a table, its rows; for a comparison, both
  cards' numbers; for a ranking, the final order and any moves. The model argues from what it drew.
- `toHistory(block)`: a one-line stub for later turns, such as
  `[shown: Premier League table, 2026-27]`, so the model knows what the reader has seen.
- `toCopy(block)`: plain text for Copy and Share.

A new view costs one registry entry and one component. Nothing in `App.tsx` or `types.ts` beyond
the union changes.

### Composer

`ReplyComposer` (new, `services/replyBlocks/composer.ts`) replaces `ReplyAttachments`. It holds the
reply as segments: prose segments with view blocks between them. When a view tool runs, the
composer closes the current prose segment, places a `pending` block, and fills it when `build`
resolves (or marks it `failed`). Blocks code adds (Scout offers, `ask`, `goDeeper`, `scorecard`)
go where their feature puts them today: the scorecard first, the rest after the last prose.

Segments, not character offsets, because the figure gate removes sentences: gating each prose
segment on its own leaves every view where the model placed it.

`onAttachments` becomes `onBlocks(blocks)`, called whenever the list changes, and `App.tsx` stores
the list on the streaming message as it arrives.

### Rendering

`ReplyBody` (new, `components/ReplyBody.tsx`) walks `blocksOf(message)`. Prose segments stream
with `useTypewriter` as today. A `pending` view shows a skeleton the height of its settled state,
so the prose below doesn't jump, and settles in place. A `failed` view renders nothing.
`ChatMessage.tsx` keeps the message frame (avatar, header strip, error state, Copy and Share) and
hands the body to `ReplyBody`.

## Views

### Frame

`ViewFrame` (new, `components/views/ViewFrame.tsx`) wraps every view: a square-cornered panel with
a thin rule, matching the existing chat pieces and `PRODUCT.md` (the ds-bundle README's note about
rounded cards is out of date), and a small-caps caption strip naming the view, such as
`TABLE · PREMIER LEAGUE · 2026-27`. Numbers use `font-mono`. Emerald marks only what the reply is
about. Every view works at 375 px with no horizontal page scroll, in light and dark.

### Pitch

`PitchView` moves into the frame unchanged. `show_pitch(club)` comes from deep mode's declaration
into the registry as is, built through `lineupViewOf`.

### League table

`show_table(league, highlight?)` reads `/api/live/table` for the current season. Asked for a past
season, `build` returns "no past tables yet" and the model writes around it; past tables can come
later from the history routes. The clubs in `highlight` are tinted. On a phone the table folds to
the top four, each highlighted club with one neighbour either side, and the bottom three, with a
thin gap row between runs; tapping the frame expands the full table. Columns: position, club,
played, goal difference, points, and a five-result form strip when the feed gives one. A league
with groups shows each group under its label.

### Comparison

`show_comparison(playerA, playerB, edition?)` resolves both cards through `dossierLookup.ts` and
never rates anyone. With `edition` omitted it takes the version each player is discussed in on
this thread, else current form. A missing card is an error naming the player, so the model can
offer a rating with `offer_rating` where that tool is on. The view puts Overall and Potential side
by side, then the attributes in their card groups as mirrored bars from a centre spine, with the
higher value in emerald. A goalkeeper against an outfielder shows the headline numbers and
archetypes only, with one line saying their attributes don't share a scale. Each name opens its
card through `onOpenDossier`.

### Ranking

`show_ranking(title, names[], criterion, edition?)` resolves each name to a card where one exists,
up to 15 entries. `criterion` takes the debate brief's values (`peak level`, `sustained level`,
`output`, `influence`, `versatility`, `mixed`). For `peak level`, `sustained level` and `mixed`,
the claim is who was better, so `build` runs `checkOrderAgainstCards` (`debateConsistency.ts`) and
carded entries take the cards' order; the moves go into `moves` and the tool result, and the prose
follows the final order. For any other criterion the model's order stands. A carded row shows its
position, name, version pill and Overall, and opens the card. An uncarded row shows its name and a
small Scout action that queues the player as a Scout offer does.

### Existing pieces

Dossier card, Scout offer, ask chips, Go deeper and the Gaffa scorecard move onto blocks with no
visual change.

## Tools and integration

### Where the tools are offered

Every prose chat turn is offered all view tools (`show_pitch`, `show_table`, `show_comparison`,
`show_ranking`) and `show_dossier`, on both paths:

- **Stage pipeline**: `generateProseTurn`'s declarations gain the registry's tools, handled in
  `conversationalScout.ts`. This includes threads about the past and turns answered from cards,
  which today are limited to local tools: the view tools join that local set.
- **Deep mode**: `DEEP_DECLARATIONS` takes the registry's declarations instead of its own
  `show_pitch`. View calls are free, like `show_pitch` and `show_dossier` today: they don't count
  against lookups, searches or rounds.

Each tool's description says what it draws and from where (the table is today's, from the live
feed), and the model judges whether it fits the conversation.

Not offered, because the surface can't draw a view: Gaffa's panel (`noRating` turns, whose replies
Gaffa's own UI draws as text) and rating and challenge turns, which produce a card or a patch
rather than prose.

### Limits

The only limit is a runaway ceiling, `MAX_REPLY_VIEWS` (12) per reply, which the tool result
states when reached ("view limit reached, nothing drawn"). No per-kind or per-subject rule: a
model that shows the same table twice has made its own choice.

### Prompt

The view tools' guidance joins the turn's `<instructions>`, one line per offered tool, the way
initiative's `INITIATIVE_RULES` do, so the byte-stable system prompt is unchanged. The lines are
descriptive and carry no examples (no player or club names, no sample phrases): what each view
shows, that a view can carry a point better than prose, that the call goes where the reader needs
the view in the argument, and that the prose shouldn't restate what the view already shows. Deep
mode's `deepModeRules` gets the same lines in place of its `show_pitch` sentence.

### Streaming and anchoring

`generateProseTurn` keeps one running text across rounds. When a round ends in tool calls, the
handlers for view tools call the composer, which closes the prose segment at the text written so
far and places the views. In deep mode, a round's text held back as a preamble to lookups
(`STREAM_HOLD_CHARS`) is still dropped. A round that calls both lookups and views counts as a
preamble round, and its views are placed after the last prose that was kept.

### Conduct gates

The manager scrub, the number gate and the figure gate run on each prose segment against the
turn's evidence, which now includes each view's `toolResult`, so prose that quotes a figure the
table shows counts as supported. Views themselves are never gated: their data comes from the
feeds and cards.

### Removed code rules

- `lineupsForTurn` no longer attaches XIs. The function and its attachment tests are deleted;
  `ThreadState.situationData` stays, since `show_pitch` on a follow-up reads it.
- The card a question about one player attached by rule is no longer shown by code. The model
  shows it with `show_dossier`. Looking up target players' cards for the model to read stays.
- Router Scout offers are not views and stay as initiative left them.

### Existing behaviour kept

- An `ask_user` that ends the turn drops the views and keeps the Scout offers.
- A deep turn that falls back to the stage pipeline drops the blocks from the failed attempt.
- A fallback stage run offers no Go deeper tool.

### History

`buildHistoryContents` writes each view block as its `toHistory` stub in place, so the model reads
its earlier reply in the order the reader saw it.

### Gaffa panel

`POST /api/gaffa/chat` keeps sending prose only. Its turns aren't offered view tools, so there are
no blocks to send.

## Failure handling

- A view whose data can't be fetched (a feed down, a league the feed doesn't cover, a player with
  no card) returns the reason as the tool result and is marked `failed`, which draws nothing.
- A `pending` view when the turn ends is marked `failed` and removed.
- A turn that throws keeps today's error message and retry; blocks from that turn are discarded.
- A legacy message renders through `blocksOf` unchanged.

## Testing

`scripts/test-reply-blocks.ts`, added to `npm test`, with feeds, cards and the clock faked:

- Each registry entry: `build` success and each failure, `toolResult`, `toHistory`, `toCopy`.
- The composer: prose split at view calls, code-added blocks placed, pending blocks resolving and
  failing, a deep-mode preamble round with a view call.
- The figure gate removing a sentence from one segment without moving any view.
- A ranking by `peak level` reordered to the cards with its moves; a ranking by `output` kept in
  the model's order.
- `MAX_REPLY_VIEWS` refusing the next call.
- `blocksOf` on a message with each legacy field.

`test-deep-turn.ts` and `test-initiative.ts` gain the view tools on both paths (offered on a past
thread and a card-only turn, absent on Gaffa's panel). `test-pitch-view.ts` drops its attachment
rule tests and keeps its drawing tests.

### Gallery

A dev-only route (`/dev/blocks`, served only when the server runs in dev) renders every block kind
from fixtures in `components/views/fixtures.ts`, including `pending` and edge states (a grouped
table, a goalkeeper comparison, a ranking with uncarded rows), with a light/dark switch. It is
excluded from the production build. Views are built and checked here without a model call.

### Eval

`npm run eval:live` reports the views each answer drew. Questions 1, 4, 10, 11 and 12 check the
model reaches for a fitting view, and question 15 checks a question about a card draws no pitch.
The run spends the shared Gemini budget: estimate it and get the owner's yes before running.

## Build

Three executor sessions, each on Sonnet:

1. **Block model.** `ReplyBlock`, `blocksOf`, the registry with entries for today's kinds (`pitch`,
   `card`, `scoutOffer`, `ask`, `goDeeper`, `scorecard`, `prose`), `ReplyComposer` replacing
   `ReplyAttachments`, `onBlocks`, `ReplyBody`, and `buildHistoryContents` stubs. No change in what
   the user sees: code still attaches what it attaches today, through the composer.
2. **Views and gallery.** `ViewFrame`, `LeagueTableView`, `ComparisonView`, `RankingView`,
   `PitchView` in the frame, skeletons, fixtures and the `/dev/blocks` route. Pure components
   against the types in this spec, so it runs alongside session 1.
3. **Wiring.** The `show_table`, `show_comparison` and `show_ranking` registry entries with their
   `build` functions, the view tools on both paths, segment anchoring in the stream, per-segment
   gates with view evidence, the prompt lines, removing the code rules, and the eval report's view
   column. Starts once sessions 1 and 2 have merged, and only while no other session is in the
   writer files (`aiClient.ts`, `conversationalScout.ts`, `deepTurn.ts`).

After each merge, the AI Studio pull and Publish put it on the live app.

## Later

Past-season tables from the history routes; predicted versus actual XI on the pitch once the
writer reads the prediction record; a form and fixtures strip; a figure with its source.
