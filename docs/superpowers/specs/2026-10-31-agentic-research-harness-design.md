# Agentic research harness for chat — design spec

**Date:** 2026-10-31
**Status:** Draft for review

## Problem

Asked to "break down Arsenal's build-up shape this season", Futbolpedia wrote a detailed, confident
answer about a team that no longer exists: a starter who has been injured for months, two squad
players in the double pivot, no mention of the summer's main signing or of the player who has
started most in midfield, and three unnamed attackers. Every rule in the chat prompt was obeyed.
The answer was still wrong, because the harness gave the model almost nothing true to work from
and then demanded specifics.

Five things in the current flow produce answers like that one, and any question about the present
can hit them:

1. **The prompt asks for confident detail without enough evidence to support it.** The chat
   prompt asks for "sharp, authoritative" prose, the exact player in every role, no "nameless
   theoretical template", and verdicts that never hedge. With thin evidence, the only way to obey
   is to invent.
2. **Research is decided before the model sees the question.** The router picks one or two search
   queries up front. A fast extractor then condenses each result to about 190 words
   (`SEARCH_DIGEST_SYSTEM_INSTRUCTION` in `aiClient.ts`). Club grounding adds the registered squad
   and recent scores, but not who started or who is injured.
3. **The writer loses its tools whenever pre-grounding ran.** `conversationalScout.ts` sets
   `toolMode: hasCompleteContext ? 'local_only' : 'full'`, and `hasCompleteContext` is true for any
   non-empty `factualFoundation`. That includes the fallback string "No grounded search results
   available for this turn." So the writer can't search the web or call API-Football at exactly
   the moment its evidence is weakest.
4. **The model's memory is a season or more behind the app.** The app works in the 2026-27 season,
   and the Arsenal answer reads like an older squad. Anything the model fills in from memory about
   current squads, roles, form or injuries is likely to be wrong, and the prompt doesn't treat it
   as untrustworthy.
5. **Nothing checks the answer against the evidence.** Gates exist for manager names
   (`managerMentions.ts`) and dossier numbers (`dossierNumberGate.ts`), but nothing asks whether
   the players, injuries, transfers and roles in a reply appear anywhere in what was researched.

## Goals

1. Answers about the present are built from evidence gathered for that question, and every
   current fact in them can be traced to that evidence.
2. The model works out what the question needs and fetches it with tools, instead of receiving
   whatever two fixed queries returned.
3. Facts and judgment are separate. Judgments stay confident; facts that couldn't be verified are
   either dropped or stated as unverified, never presented as certain.
4. Answers stay reasonably fast, using `gemini-3.8-flash` throughout. The user sees research
   progress within about a second, and the answer starts within roughly 10 seconds on a cold
   question (an estimate, to be measured).
5. Turns that don't need live facts, such as a debate about stored cards or a historical
   comparison, skip research and stay as fast as they are today.

## Non-goals

- Switching models. Gemini 4 Argon stays an option for later, not part of this design.
- Changing how dossier cards are rated or grounded (`dossierSynthesizer.ts`, `groundingService.ts`
  player grounding).
- Gaffa mode. It has its own context bag; it can adopt the ledger and gate later.

## Design

Turns that need facts about the present (current squads, tactics, form, injuries, transfers,
standings, a player's current season) go through four stages. Other turns keep today's path.

```
message
  │
  ▼
1. Understand ── one Flash call: what's asked, timeframe, entities, evidence checklist
  │
  ▼
2. Research ──── checklist items run in parallel through typed tools ──► evidence ledger
  │                                                                     (E1…En, with sources)
  ▼
3. Gap check ─── only when items came back empty or contradict each other;
  │              one bounded round of extra tool calls
  ▼
4. Write ─────── writer reads the ledger, keeps its tools, marks facts with ledger ids
  │
  ▼
5. Verify ────── deterministic gate: named players, injuries and clubs must match the ledger;
                 unsupported claims are repaired or marked
```

### 1. Understand

The router's `TurnRoute` gains a `research` field: the timeframe (`live`, `historical` or
`timeless`), the entities, the shape of answer wanted, and an evidence checklist. Each checklist
item names a kind of evidence and its subject:

| Kind | Source | Example subject |
| --- | --- | --- |
| `lineups` | API-Football `fixtures/lineups` (last 3 matches) | a club |
| `injuries` | API-Football `injuries` (last and next fixture) | a club |
| `squad` | API-Football `players/squads` | a club |
| `fixtures` | API-Football `fixtures` | a club |
| `standings` | API-Football `standings` (new route) | a league |
| `player_season` | API-Football `players` (existing route) | a player |
| `transfers` | web search, last two windows | a club or player |
| `web` | web search with a stated purpose | free text |
| `dossier` | saved and shared cards | a player and edition |

The regex fast paths keep working and emit fixed checklists. The club tactics path, for example,
always asks for `lineups`, `injuries`, `transfers`, and one `web` item about how the team sets up.
Only the LLM classifier path writes a checklist freely. A `historical` or `timeless` turn about
stored cards gets an empty checklist and skips to the writer, as today.

### 2. Research

A new `services/researchRunner.ts` runs every checklist item in parallel and writes the results
into an evidence ledger. Each entry has an id (`E1`, `E2`, …), its kind, its source, the date it
describes, and its content. API-Football results stay structured. Web results keep their source
URLs and a longer digest (about 500 words instead of 190), written to keep names, dates and
numbers rather than prose. The ledger replaces today's single `factualFoundation` string.

The server caches API-Football team context for six hours, so a second question about the same
club researches in well under a second.

The chat shows the research as it happens, under the existing loading indicator: one line per
item ("Arsenal: last 3 lineups", "Arsenal: injury list") with a check when it lands. This is what
makes a 6 to 10 second wait feel like work rather than lag.

### 3. Gap check

A code check, not a model call, decides whether this stage runs: it runs only when a checklist
item came back empty or failed, or when two sources disagree in a way code can see (a player on
the injury list who started the latest match). When it runs, one Flash call with medium thinking
reads the question and a summary of the ledger, and may request up to three more tool calls, run
in one parallel round. There's no open-ended loop.

### 4. Write

The writer gets the ledger and keeps its full tool set; the `local_only` lockout is removed. Its
instructions change in three ways:

- **Facts and judgment are separate.** Current facts (who plays, where, who is injured, who
  arrived, results, numbers) must come from the ledger or a tool call made during writing.
  Judgments about style, quality and trade-offs can stay confident. When something the answer
  needs isn't in the ledger, the writer says so in one plain sentence instead of filling it in.
- **Facts carry ledger ids.** The writer tags current facts inline (`[E3]`). The stream sanitizer
  strips the tags before display, and the verify gate reads them. Later, the tags can drive a
  sources list under the reply.
- **The "authoritative, never hedge" rules apply to verdicts only.** The chat prompt is rewritten
  so its tone rules can't be met by inventing facts. The new rules go in the system instruction
  once, so it stays byte-stable for prompt caching; the ledger goes in the turn message.

The writer stays at low thinking to begin with. Phase 3 measures medium thinking on live turns
and keeps it only if quality improves enough to justify the time.

### 5. Verify

A deterministic gate, in the style of the manager gate, runs on the finished reply:

- Every player named as part of a current squad must appear in the ledger (lineups, squad list,
  injury list or web evidence) or in a card in play.
- A player on the injury list can't be described as starting or playing now.
- A club, signing or departure stated as current must appear in the ledger.

Where a check fails, one quick Flash repair call rewrites only the offending sentences from the
ledger. If the repair fails too, the gate removes the claim and adds a short note that it couldn't
be verified. The gate never touches judgment sentences that name no current fact.

## Speed

These are estimates for a cold question about one club, to be replaced by measurements in
Phase 1:

| Stage | Today | New |
| --- | --- | --- |
| Understand / route | 0–1.5 s | 0–1.5 s (fast paths stay 0 s) |
| Research | 3–5 s (2 searches + club context) | 3–6 s (more items, same parallel wait) |
| Gap check | none | 0 s usually; 2–3 s when gaps exist |
| First answer token | about 6–8 s | about 6–10 s |
| Verify | none | under 50 ms; 2–3 s only when a repair runs |

Research runs in parallel, so adding items mostly adds cost (more searches and API-Football
calls), not time. Repeat questions about the same club are faster than today because of the
server cache.

## Phases

Each phase ships as one PR with offline tests, and each is useful on its own.

**Status, 2026-11-01:** Phase 1 shipped (#41). Phase 2 is built as the brief, research and reflect
loop (`researchAgent.ts`, `researchTools.ts`): the reflect step from Phase 3 moved into it, and the
writer runs at low thinking once a brief exists. The verify gate and the evidence panel are built
but parked on `feat/evidence-and-name-check`, unmerged: the focus is the quality of the research
and the answer, not checks after the fact.

**Status, Futbolpedia 3.5:** research reports each lookup's status and plans around what no
source covers, runs facts before analysis with dated sources, discards earlier-season sources
that contradict the live facts, and builds a situation snapshot (first-choice XI, absences, form,
what changed) that the writer argues from. Each club's snapshot is shared through the Supabase
`club_snapshots` table and rebuilt at most once a day. `npm run eval:live` scores the question set
with a grader model.

1. **Unblock and ledger.** Keep the writer's tools on live turns, and stop the fallback string from
   counting as context. Ship the recent-lineups and injury grounding (branch
   `fix/tactics-grounding`). Replace `factualFoundation` with a ledger with ids and longer digests,
   and rewrite the chat prompt's tone rules into the facts-versus-judgment split. Add timing logs
   per stage.
2. **Research plan.** Add the `research` checklist to `TurnRoute`, `researchRunner.ts` with typed
   tools (including a new standings route), and the live research trail in the chat.
3. **Gap check and verify.** Add the gap check, the verify gate with repair, and the medium-thinking
   experiment for the writer.
4. **Sources.** Show the ledger entries a reply used as a collapsible sources list, and extend the
   flow to player questions about the current season and to comparisons in current form.

## Testing

- **Offline (in `npm test`):** checklist parsing and the fast-path checklists; ledger building
  from recorded API-Football and search fixtures; the gap check's code trigger; the verify gate on
  recorded replies (injured player described as starting, a departed player named in the XI, an
  unverifiable signing); tag stripping in the stream sanitizer.
- **End-to-end with Gemini faked at fetch**, like `test-dossier-pipeline.ts`: a tactics question
  runs all four stages, and a stored-card debate skips research.
- **Live evaluation after deploy:** a fixed set of about 15 real questions (club tactics, current
  form, injuries, transfers, standings, historical debates), scored for verifiable names, injured
  players described as playing, gaps admitted plainly, and time to first token. Run the set before
  Phase 1 too, so each phase has a baseline to beat.

## Risks

- **Flash tool use.** Flash at low thinking rarely chooses to call tools, which is why research is
  planned and run by code rather than left to the writer's tool loop. The writer's own tool calls
  are a backstop, not the main path.
- **API-Football coverage.** Lineups and injuries depend on the plan including those endpoints. If
  they're missing, the ledger records the gap and the writer says what it couldn't verify.
- **Cost.** More searches per live turn. The checklist caps items at six, and the server cache
  absorbs repeats.
- **Over-hedging.** A strict facts rule can make answers timid. The split keeps judgments
  confident, and the live evaluation watches for answers that hedge on facts the ledger has.

## Open questions

- Should the sources list be visible to everyone from Phase 4, or behind a toggle?
- Does the gap check need medium thinking, or is low enough once it only runs on real gaps?
- Which turns count as `live` when the message gives no timeframe? The current default (no
  timeframe with a retired player means his prime) handles players; clubs need a rule too.
