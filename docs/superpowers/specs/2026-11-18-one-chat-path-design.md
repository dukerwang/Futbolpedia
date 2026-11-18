# One Chat Path

Date: 2026-11-18. Status: step 1 (rename and dead flags) built; steps 2 to 5 wait for live checks. No live calls.

## Goal

Futbolpedia's chat grew one switch at a time: the model loop (once opt-in as "deep mode", the
default since 2026-11-16), the stage pipeline it replaced, the debate pipeline for questions about
the past, past mode behind `DEEP_PAST`, and a second prompt set behind `PRINCIPLES_PROMPT`. Each
switch kept live behaviour fixed while it was measured. This spec ends with one chat path: the
loop, under a plain name, with the smallest fallback that still answers when the loop gives up.

The loop isn't a mode any more. Every present-day question takes it, the composer has no speed
toggle, and nothing in the app asks for the stage pipeline. Its name should say it's the chat.

## What Each Path Still Serves

Before anything goes, this is what reaches each pipeline on `main` (`ed6a724`):

| Turn | Path |
| --- | --- |
| A question about the present, a Gaffa club attached included | The loop (`deepTurn.ts`) |
| A question about the past | The debate pipeline (`debateBrief.ts`), then the stage writer; the loop once `DEEP_PAST` is on |
| Gaffa's own panel (`noRating`) | The stage pipeline, with research (`researchAgent.ts`) |
| A Gaffa trade (`isGaffaTrade`) | The stage pipeline, with the trade scorecard above a capped reply |
| A message with an image | The stage pipeline |
| An archive question (`archive_inventory`) | The stage pipeline, local tools only |
| A rating, a card request, a challenge | Their own pipelines (`rateDossier`, `applyDossierPatch`) |
| A loop that gave up (`DeepFailure`, a throw) | The stage pipeline, once, from the start |

So the stage pipeline isn't only a fallback. Four kinds of turn still reach its writer and its
research on purpose. It can't go until each of them takes the loop or a path of its own.

## Step 1: The Rename and the Dead Flags (No Live Check)

### Dead Flags

`DEEP_BY_DEFAULT` is `true`, nothing in the app sends `deep`, `fast` or `deepByDefault`, and the
composer's Fast toggle went on 2026-11-17. They survive only so the eval and the tests can force a
path. They go:

- `DEEP_BY_DEFAULT` and `wantsDeep` (`deepTurn.ts`).
- `deep`, `fast` and `deepByDefault` on `SendMessageOptions`, and `deep`, `fast` and `byDefault`
  on `takesDeepPath`'s argument.
- Their tests in `scripts/test-deep-turn.ts` (the default's value, `wantsDeep`'s truth table, an
  unflagged turn following the constant, `deep: true` overriding a false default).

One option replaces all three: `stage?: boolean` on `SendMessageOptions` (and on `takesChatLoop`),
which sends a turn the loop would take to the stage pipeline. Only the eval's `--stage` and the
tests send it, and it goes with the stage pipeline.

Losing `DEEP_BY_DEFAULT` loses a one-line kill switch. The fallback already catches a loop that
fails, and a broken loop is fixed or reverted like any other code, so the switch has no job left.

Live behaviour doesn't change: with the default on and no flag sent, `wantsDeep` was always true,
so a turn takes the loop exactly when the remaining conditions hold, and the question search before
routing starts exactly when it did.

### Rename Map

| Before | After |
| --- | --- |
| `services/deepTurn.ts` | `services/chatTurn.ts` |
| `runDeepTurn`, `DeepTurnParams`, `DeepTurnDeps` | `runChatTurn`, `ChatTurnParams`, `ChatTurnDeps` |
| `runDeepWithFallback` | `runChatWithFallback` |
| `takesDeepPath` | `takesChatLoop` |
| `DeepStats` | `TurnStats` |
| `DeepBudget`, `DEFAULT_DEEP_BUDGET` | `ResearchBudget`, `DEFAULT_RESEARCH_BUDGET` (`TurnBudget` is taken by Gaffa's daily turn budget) |
| `DEEP_BUDGET_MS`, `DEEP_MAX_CALLS`, `DEEP_MAX_SEARCHES`, `DEEP_MAX_ROUNDS`, `DEEP_CONTEXT_WAIT_MS` | `CHAT_BUDGET_MS`, `CHAT_MAX_CALLS`, `CHAT_MAX_SEARCHES`, `CHAT_MAX_ROUNDS`, `CHAT_CONTEXT_WAIT_MS` |
| `DEEP_DECLARATIONS`, `deepDeclarations`, `DEEP_GAFFA_RULE` | `CHAT_DECLARATIONS`, `chatDeclarations`, `CHAT_GAFFA_RULE` |
| `DeepFailure`, `DeepFallbackReason` | `ChatTurnFailure`, `FallbackReason` |
| `DeepModel`, `DeepConversation`, `DeepReply`, `DeepFunctionCall`, `DeepToolResponse`, `liveDeepModel` | `ChatModel`, `ChatConversation`, `ChatRoundReply`, `ChatFunctionCall`, `ChatToolResponse`, `liveChatModel` |
| `deepModeRules`, `deepResearchRules`, `deepInstructions` | `researchRules`, `principleResearchRules`, `chatInstructions` |
| The `## Deep mode` heading in both research rules | `## Research` |
| `DEEP_PAST`, `DEEP_PAST_BUDGET` | `PAST_MODE`, `PAST_BUDGET` |
| `deepPast` (options, params), `pastDeep` (`takesDeepPath`) | `pastMode` |
| `deepDeps` on `SendMessageOptions` | `chatDeps` |
| `PRINCIPLE_SOURCES.deep`, `.deepPast` | `PRINCIPLE_SOURCES.chat`, `.pastMode` (keys only; the text is unchanged) |
| Model profile task `deep` | `chatTurn` |
| `PathInfo.path` `'deep'` | `'chat'` |
| Card order disagreement path `'deep'` | `'commit'`, summarized as "from committed verdicts" |
| `[deep] fallback`, `[Perf] deep context`, `deep round N`, `deep turn` | `[chat] fallback`, `[Perf] chat context`, `chat round N`, `chat turn` |
| `scripts/test-deep-turn.ts`, `test-deep-past.ts`, `test-gaffa-deep.ts` | `test-chat-turn.ts`, `test-past-mode.ts`, `test-gaffa-chat-turn.ts` |

Unchanged on purpose: the retired `goDeeper` block kind and the `GoDeeper` type, which stored
conversations still hold, and the dated specs and eval reports, which are records.

The disagreement path rename is safe to ship: only a past-mode commitment reports `'deep'`, and
past mode is off, so no browser running an older build sends it.

### Prompts

The model reads one change: the heading of the research rules, `## Deep mode`, becomes
`## Research`, in both the default rules (`researchRules`) and the principle set's
(`principleResearchRules`). The heading is the only text in either that names the mode. Its pinned
hash in `scripts/test-chat-prompt.ts` (`researchRules`, was `deepModeRules`) changes for that
reason alone; every other pin keeps its value, the pin keys renamed from `deep …` to `chat …`. The
principle set's research rules aren't pinned by hash, so the duplication guard covers them.

Checked on the build: a one-off script captured 57 texts the loop sends (the system instruction
with and without EAFC and the principle set, both research rules at the default and past budgets,
`chatInstructions` for every router mode with and without principles and a Gaffa club, the four
declaration sets, the past notes and instructions, the principle sources, `commit_verdict`, the
stage labels and the unchecked line) on `main` and on the branch. Four differed, the two research
rules at two budgets each, and in each only the heading line.

### Eval

- `--deep` goes from the live set: every question it accepted already takes the loop.
- On the historical set, `--set historical --deep` becomes `--set historical --past-mode`, since what
  it does there is turn on past mode for the run.
- `--stage` stays while the stage pipeline does.
- The report's Path column reads `chat`, `stage`, or `chat, then stage (<reason>)`. The repeat
  run's estimate calls the path the chat loop.

## Step 2: Past Mode Takes the Past (Live Check)

`DEEP_PAST` (now `PAST_MODE`) waits for its live check in
`2026-11-18-past-questions-deep-design.md`. When it passes:

- Flip `PAST_MODE`, then delete it with its overrides (`pastMode` on `SendMessageOptions`, on
  `takesChatLoop` and on `ChatTurnParams`), and the eval's `--past-mode`.
- The debate pipeline stays one release as past mode's fallback, then goes: `debateBrief.ts`
  (`runDebateResearch`, `startDebateBrief`, `cardBrief`, `liveDebateRecords`), the stage writer's
  past rules (`PAST_DEBATE_RULES`, `PAST_CONVERSATION_RULES`), the debate brief's need reading and
  `ensureDebateObjectionCheck`, and `scripts/test-history-chat-pipeline.ts`'s debate path. Shared
  pieces past mode reads stay: era snapshots, settled verdicts, the card check
  (`debateConsistency.ts`), `MAX_ERA_BUILDS`.
- The settle route spends only while past mode is on today (`settleEnabled`); after the flip it
  keeps only its `DEBATE_SETTLE` override and the daily cap.

## Step 3: One Prompt Set (Live Check)

`PRINCIPLES_PROMPT` waits for its live check in `2026-11-18-chat-principles-design.md`. When it
passes, the flip PR deletes the old builders it lists there: the legacy branch of
`chatInstructions`, `stageInstructions` and `challengeInstructions`, `researchRules` in favour of
`principleResearchRules` (renamed back to `researchRules`), `proseModeGuidance`'s templates and the
router's `analyticalMode`, `INITIATIVE_RULES` and `VIEW_RULES` in turn instructions, and the
`LEGACY_PINS` block of `scripts/test-chat-prompt.ts`.

## Step 4: The Remaining Stage Turns Move to the Loop (Live Check)

The stage pipeline can't go while Gaffa's panel, Gaffa trades, image turns and archive questions
use it. Each moves on its own, with a live check of its own:

- **Archive questions.** The loop already has `grep_saved_dossiers` and the saved-dossiers block. The
  smallest move: drop `archive_inventory` from the exclusions.
- **Image turns.** The loop's first message needs the image part; the rest is the same turn.
- **Gaffa trades.** Build the trade scorecard before the first round, as the stage pipeline does,
  and keep `finishGaffaReply`'s trade cap on every gated segment.
- **Gaffa's panel.** The panel's daily turn budget limits turns, not lookups; it needs the loop with
  view tools off and a tighter research budget, since its turns are shown in a narrow panel.

## Step 5: The Fallback

Once nothing reaches the stage pipeline on purpose, the only question is what runs when the loop
gives up. Two candidates:

- **A smaller stage path:** brief, research and writer, with the situation snapshot. It repeats the
  lookups the loop already made, keeps `researchAgent.ts`, `situationSnapshot.ts`'s model call and
  the brief alive for a rare event, and keeps two research designs to maintain.
- **A plain answer:** one call on the chat model with no tools, reading the conversation, the cards
  in play, the stored snapshots and the evidence ledger the loop filled before it gave up, with the
  same gates (figure gate, manager scrub, number gate, gate feedback). It costs one call, reuses the
  research already paid for, and says plainly what it couldn't check.

Recommendation: the plain answer. A loop gives up when it throws, ends with no text or spends its
budget without writing; in each case the evidence it gathered is still good, and the deep eval of
2026-11-16 had no fallbacks in twelve questions. The stage pipeline's research is the expensive part
of a fallback and the part least likely to help. `runChatWithFallback` keeps its shape and its
stage label; only the function it falls back to changes.

What goes with the stage pipeline then: `researchAgent.ts` (brief, reflect, the research round),
`turnRouter`'s research queries, `startQuestionSearch` and `looksLikePresentQuestion`, the writer
path of `conversationalScout.ts` (`runConversationalScout`'s research branch, the initiative tools
the loop doesn't offer), `stageInstructions`, `--stage`, the `stage` option, and the stage-only
tests (`test-research-agent.ts`'s pipeline cases, `test-live-chat-pipeline.ts`). What stays: the
challenge path, the gates, the evidence ledger, the situation snapshot's code XI (`show_pitch` and
the club snapshots read it), the club snapshot builds on the server, and the view tools.

## Follow-ups

Each is gated on the live check named, and none is in step 1's PR:

1. Flip and delete `PAST_MODE` (past questions live check).
2. Delete the debate pipeline, one release after step 1 of this list.
3. Flip and delete `PRINCIPLES_PROMPT` and the old prompt builders (chat principles live check).
4. Move archive questions, image turns, Gaffa trades and Gaffa's panel into the loop (one live check
   each, priced before it runs).
5. Replace the stage fallback with the plain answer, and delete the stage pipeline.

Every live check is written as a plan with a token estimate, and runs only after approval.
