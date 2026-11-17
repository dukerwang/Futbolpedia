# Reading the need, and conduct under pushback

Date: 2026-11-17. Status: built, not yet evaluated live.

## Problem

In the shared conversation `/c/W8BVT5` (a Gaffa club on the stage pipeline), the scout recommended
a third goalkeeper because the starter was on Gaffa's IR. The user said the starter would be back
soon; the scout agreed on the user's word. The user then asked why the scout hadn't checked, and
the scout conceded that it "should have checked" and had no verified return date, although the
turn's evidence held the player's FPL record (doubtful, a 75% chance of playing) and the writer had
`get_player_season` in hand. Asked again, it blamed a web search that timed out.

The failures are general, not about injuries:

1. No stage asks what the user is trying to do. The research brief plans lookups for the literal
   words; the writer runs at low thinking with mostly style and fact-discipline rules.
2. The gap rule ("say so plainly in one sentence and work around it") became the default answer to
   pushback, rather than a last resort after checking.
3. The pushback rule says to verify against `<factual_foundation>` but never to go and get the fact,
   and never says that a user's claim about a checkable fact is neither accepted nor rejected on
   their word.
4. Nothing forbids narrating the pipeline (lookups, searches, timeouts).
5. A lookup that was too slow is filed under the same heading as one that failed, which the writer
   reads as "this can't be verified", although its own tools can check it.

## Design

### The need read (no new call)

The research brief gains four short fields, `need` (`services/userNeed.ts`, shared by both briefs):

- `goal`: what the user is trying to decide or do, in the light of what they own, can do next and
  have already said.
- `settle`: what a useful answer must settle, at most four items.
- `objection`: on a follow-up that pushes back on the last reply, what in it they object to; empty
  otherwise.
- `objectionFact`: the checkable fact the objection rests on, as a question research can answer;
  empty when the objection is about judgment.

The brief prompt says the objection fact is checked this turn and never settled on the user's word,
and that its calls must include the lookup that settles it. Code backs that up: when the brief
records an objection fact and plans no call, `ensureObjectionCheck` adds the obvious lookups for the
names the router spotted (a player's season record, a club's recent team) or, with no names, one web
search on the fact. So a pushback turn always researches and its writer always has the full tool set.

The debate brief (questions about the past) gains the same `need` fields: its `kind: other` already
covers a follow-up that questions a fact, but nothing told it that a disputed fact is checked rather
than conceded.

**Why fields, not a new call.** The brief is one low-thinking call of about 5 s that already reads
the thread and the message. Four short fields add well under a hundred output tokens. A separate
"intent" call would add a sequential round trip (the brief needs its answer to plan), about 3 to 5 s
on every researched turn, to produce what the brief can write in the same pass. If evals show the
brief writes the need badly at low thinking, the next step is a better prompt, then medium thinking
for follow-ups only, before a new call.

**Where the writer reads it.** `formatNeedForWriter` writes a `<user_need>` block that the writer
reads first, right after the context line and ahead of the Gaffa club, thread, snapshot and evidence,
so what the answer is for frames everything after it. It is passed whenever the brief exists, even on
a turn whose brief planned no calls (where `<research_brief>` is left out). `formatBriefForWriter`
keeps the rest of the brief. The debate path prints the same block from its brief.

**Deep mode.** It has no brief, so `deepModeRules` (its system instruction, static per budget) gains
the same instruction in prose: work out what the user is trying to decide before researching, and
when they push back on a checkable fact, look it up before answering.

### Writer conduct rules

In `CONVERSATIONAL_SCOUT_MANDATE` (the system prompt every chat path uses: stage, deep, debate and
challenge). It changes as a whole, so it stays byte-stable within a process; the cached prefix
(`SCOUT_CORE_INSTRUCTION`) is untouched. A new section, **Reading the User**, and three reworked
bullets:

- Answer the need with the ordinary sense a knowledgeable friend brings to the user's situation:
  what they own, what they can do next, what they already said.
- When the user challenges a fact or asks why you didn't know something, find it now in the
  evidence or with a tool and answer with it; correct the earlier reply in one sentence. Never
  concede without checking, and never only apologise. The user's word on a checkable fact is a
  claim to check, in either direction.
- Before saying a fact can't be verified, make sure no entry answers it and that you tried the tool
  that would. Partial evidence (a percentage chance of playing, a status, a dated report) is an
  answer: give it with what it implies.
- Never describe your own lookups, searches, timeouts, tools or pipeline (added to **Prose Only**).
- The gap rule keeps honesty about real gaps (no source covers it, the tools came back empty) and
  loses its role as a default: it now comes after checking.

`presentFactRules` (per turn, stage and deep) and the brief's "couldn't establish" line say the same
in short form, so a turn's instructions don't contradict the mandate. The past-debate rules
(`PAST_DEBATE_RULES`, `PAST_CONVERSATION_RULES`) gain the check-before-conceding clause.

### Too-slow gaps

A new gap status, `slow` (`EvidenceGap`), set from a new `ToolOutcome.slow` flag on outcomes that
were still running, or never started, when the writer began: the stage research's `TOO_SLOW` and
`SKIPPED`, the debate research's search past its budget, and deep mode's budget timeout. The lookup
log keeps them as `failed`, so reflect and the scout's day read them as before. The ledger prints
them under their own heading: not back in time, unchecked rather than unverifiable, and checkable
with the writer's tools this turn. The not-covered, failed and not-found headings are unchanged.

The writer has the tool for it: a researched stage turn already gets the full tool set
(`proseToolMode`); the debate path, which gave its writer network tools only when a lookup failed,
now does so for a slow one too (`writerNeedsNetwork`). Card synthesis (`dossierResearch.ts`) has no
tools, so its too-slow outcome is left as it was.

### Regression cases

`docs/superpowers/evals/live-questions.md` gains a **Conversations** section: multi-turn cases as
JSON blocks, each turn with the user's message, an optional recorded reply and what a good answer
must do. `scripts/eval-conversations.ts` (pure, tested offline with fakes) parses them and runs each
tested turn with the recorded turns before it as history (replay), so a turn is judged on its own
rather than on what an earlier live turn happened to say; a turn with no recorded reply before it is
chained from the live answer. A conduct grader (one call per tested turn, no search) checks each
must-do item against the answer and the live feed data for the case's named subjects.
`npm run eval:live -- --conversations` runs them; a case with a Gaffa club reads it with
`FUTBOLPEDIA_READ_SECRET` and is skipped without it.

Cases: C1 is `/c/W8BVT5`'s four turns with their recorded replies. C2 to C4 are general: pushback on
a current lineup claim, pushback on a past fact (the debate path), and a question whose need differs
from its literal words.

## Not in scope

The Gaffa-specific fixes (FPL status wording, availability in the squad block, the bid calculator,
a manager reasoning block) are in the `gaffa-availability` session. This change touches none of
`liveFootball.ts`, `gaffaTurn.ts`, `gaffaLineupAudit.ts` or `gaffaRules.ts`.
