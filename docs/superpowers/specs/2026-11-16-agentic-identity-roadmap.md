# Agentic identity roadmap

The goal is for Futbolpedia to behave as an agent with an identity rather than a pipeline that
answers: it acts between conversations, makes calls that get scored, knows what it believes and
why it changed its mind, chooses how to present an answer, and reaches for tools on its own
judgment. This roadmap orders the pieces, says what each one changes, and what each depends on.

Two constraints hold throughout. Constraints on what the scout may claim stay: current facts come
from evidence, figures need a source (`figureGate.ts`), ratings stay consistent with the ledger,
no unverified coach is named. They are the scout's code of conduct, not a cage. Constraints on what
the scout may do (fixed stage order, hidden budgets, trimmed tool sets, code deciding what to show)
are the ones this roadmap loosens, one piece at a time, each measured against the eval set before
it changes the default path.

Gemini spend is capped and shared with the live app. Every piece that adds calls names its budget
constant and an off switch, and every eval estimates before it runs.

## Landed

- **Pitch view** (PR 74): a present-day reply attaches `lineups` and draws the first-choice XI
  with `components/PitchView.tsx`. Attached by code rule for now.
- **XI prediction track record** (PR 75): before each match of a club with a stored snapshot, the
  server stores the code XI and a context-adjusted XI, then scores both against ESPN's lineup.
  `GET /api/predictions/club?name=` exposes the record. Nothing reads it yet.
- **Scout's day** (PR 76): once a day one planning call chooses what to research from signals code
  gathers (demand, prediction misses, fixtures, cards near refresh, lookup gaps) and code runs the
  typed actions within `SCOUT_DAY_CALLS`. Notes land in `scout_notes` and are read as evidence;
  `scout_journal` records each day; `GET /api/scout/journal`. `SCOUT_DAY=off` disables it.
- **Deep mode** (PR 77): an opt-in composer toggle sends a present-day turn to one model loop with
  every tool, including `web_search` and `show_pitch`, and a budget it is told about in every tool
  result, plus a coverage line listing what it hasn't checked. The six-question eval found it
  faster, cheaper and as accurate, but light on "what changed"; the thoroughness rules were added
  after. The full twelve-question eval in both modes is written up in the PR and not yet run: it
  decides whether deep mode becomes the default for present-day questions.


- **Initiative** (PR 79): four writer tools on the default path: `ask_user` (a question with two
  to four chips that ends the turn), `prepare_club` (starts a snapshot build for the thread's next
  step, capped per turn and conversation), `offer_rating` (offers, never rates; the code rule stays
  as the fallback for a player named directly) and `request_deeper` (a "Go deeper" chip that reruns
  the message in deep mode). Never in deep mode, Gaffa's panel or a challenge turn.
- **Card review** (PR 78): inside the scout's day, under `CARD_REVIEW_CALLS` (24): current cards past
  their window are re-rated and publish as a visitor's request would; a card whose situation moved
  gets a Latest Update refresh and a queued re-rate; a historical card's data gaps are filled from
  records built since; a prime is reviewed only for a contradiction or a new record, drafted and
  held, guarded by code, then accepted, revised once or refused by an independent reviewer call.
  `card_reviews` and the journal keep the trail, and chat reads accepted reviews as evidence.

- **Deep by default** (PR 80, flipped on 2026-11-16): `DEEP_BY_DEFAULT` in `services/deepTurn.ts`
  is on. Every turn `takesDeepPath` accepts runs the loop, the toggle reads Fast and sends the turn
  to the stage pipeline, a failed loop falls back to the stage pipeline once (`[deep] fallback`),
  and the Go deeper chip appears only on Fast turns. The deciding run is
  `docs/superpowers/evals/reports/2026-11-16-2010-deep-full.md`: twelve questions, no stale facts,
  two invented, "what changed" on ten of eleven, at about half the calls of a cold stage turn.

- **Gates as feedback** (PR 84): when the figure gate, the attribute check or the manager scrub
  flags a reply and the turn has time, the model gets one call to fix the flagged sentences before
  anything is cut (`services/gateFeedback.ts`). Code applies the replacements to the reply, so
  unflagged sentences stay byte-identical, and the gates run again; what is still unsupported is
  removed as before. Deep mode always, counted against its lookup budget; the stage pipeline only
  on a researched turn whose writer finished inside `GATE_FEEDBACK_CUTOFF_MS`. Each round logs
  `[GateFeedback] flagged N, fixed M, dropped D, removed R`, and `npm run eval:live` reports the
  three counts per question. The live check is written up in the PR and not yet run.

## Planned

### 1. Presentation as tools

How an answer is shown becomes the model's call on the default path.

- **Tools**: `show_pitch(club)` (already in deep mode) joins the writer's default tool set;
  `show_table(league)` draws the league table the writer already fetches as a component instead of
  prose; `show_comparison(playerA, playerB)` draws two cards' attributes side by side.
- **Code rules become fallbacks**: the pitch attaches by rule only when the model showed nothing
  on a lineup question; `showCard` keeps its rule for a question about one player.
- **Eval**: questions 1, 4, 10, 11 and 12 check the model reaches for the right view; question 15
  checks a card question doesn't draw a pitch.
- **Depends on** deep mode (shared tool definitions) and lands after initiative to avoid two
  sessions in the writer files at once. Touches `services/aiClient.ts`, new components. Suited to
  Sonnet.

### 2. Card-order rule and disagreement channel

Built. A ranking or verdict that claims who was better follows the cards' order, and the writer
has one way to say where it disagrees with a card instead of arguing against it in prose.

### 3. Consistency eval

Built. Repeat runs of the same questions in deep mode measure how far answers drift from run to
run, and paraphrase pairs measure whether the same question in other words gets the same verdict.
It is the measure for items 4 and 5.

### 4. Chat principles, behind a switch

One principle set for the chat writer on every path, in a byte-stable system instruction, with
per-turn data only in the turn's instructions; router-chosen answer templates end
(`docs/superpowers/specs/2026-11-18-chat-principles-design.md`). Ships behind
`PRINCIPLES_PROMPT`, off, with today's instructions pinned byte for byte while it is off. Step 1
(the core split into section constants, no prompt change) ships first on its own.

### 5. Past questions in the deep loop, behind a switch

Questions about the past take the deep loop with the history tools, behind `DEEP_PAST`, off. Its
prompt work is written in the principle style after item 4's PR merges, and adds no past-specific
writing rules.

## Order

1. Watch the live `[deep]` and `[deep] fallback` log lines after publish; a warm deep run
   (`--deep --warm`) when budget allows, to measure turns that reuse stored snapshots.
2. Presentation as tools.
3. Card-order rule and disagreement channel (built).
4. Consistency eval (built).
5. Chat principles behind `PRINCIPLES_PROMPT`, off.
6. Past questions in the deep loop behind `DEEP_PAST`, off.
7. One live check covering both switches, after the Gemini cap resets on December 1 or with the
   user's yes on its token estimate. It gates both flips: `PRINCIPLES_PROMPT` and `DEEP_PAST` are
   turned on only in PRs that follow a passing check. The `analyticalMode` retirement follows the
   principles flip.

After each piece: merge, then pull and publish in Google AI Studio for it to reach the live app.

## Later

Pieces that build on the above and are not yet designed: the notebook column written from the
journal; the prediction record read by the writer and the pitch view (predicted versus actual);
server-vouched settled debates; dated-knowledge mode; card similarity search.
