# Futbolpedia Engine Overhaul (Gemini 4 Argon Architecture) — Design Spec

**Date:** 2026-10-16  
**Status:** Approved for implementation planning  

## Problem

Futbolpedia's AI pipeline was originally created in the Gemini 2.0 / 2.5 era and patched incrementally through Gemini 3.x (`services/geminiService.ts` at 1,584 lines and `constants.ts` at 486 lines). That history left five structural bottlenecks:

1. **Regex intent routing:** Over 15 overlapping regular expressions in `sendMessageToAI` and `extractCandidateSlug` guess whether a message wants a dossier card, a comparison, a rating defense, or an archive lookup, stripping words from the prompt to infer player names.
2. **Unstructured snippet scraping for basic facts:** Formal dossier generation fires 5 blind Google Searches in parallel, truncates the text, and runs an unvalidated `JSON.parse` extraction pass to guess age, height, weight, club, and season stats, while the existing API-Football integration in `server.ts` goes unused by the dossier pipeline.
3. **Rating drift and inflated tier labels:** Synthesis runs at `temperature: 0.7` with `ThinkingLevel.LOW` and emits `ratings` before calibrating the player's archetype or strengths/weaknesses. The legacy Section III scale also labeled 94–95 `"Best in World"`, treated a Top-15 Ballon d'Or finish as an automatic `91+` floor, and started `"World-Class"` down at `86`, while `SidePanel.tsx`, `PlayerProfileDisplay.tsx`, and `constants.ts` each used conflicting tier tables.
4. **Triple-duplicated monolithic system prompt:** The 486-line prompt in `constants.ts` repeats the same rules three times (Protocols A–T, Section X Critical Final Checks, and `getFormalSynthesisQualityReminders`), and injects the full JSON dossier schema into conversational turns, requiring "Anti-Leak" instructions to stop JSON from spilling into normal chat.
5. **Static dossiers during rating debates:** When a user challenges a rating or attribute in chat and the scout agrees to adjust it, the change only appears in conversational prose while the dossier card in the side panel stays frozen at the old numbers.

## Goals

1. **Modular AI service architecture:** Split the 1,584-line `services/geminiService.ts` monolith and 486-line `constants.ts` into focused, single-purpose modules for client management, dossier storage, turn routing, hybrid grounding, calibrated dossier synthesis, conversational scouting, and mode-specific prompts.
2. **Structured Turn Router:** Replace the regex intent gauntlet with a 0ms fast path for simple commands (`"Rate <Player>"`) and a schema-enforced turn classifier (`TurnRoute`) for nuanced prompts.
3. **Hybrid Parallel Grounding (API-Football + Web Search):** Add `GET /api/football/player` in `server.ts` (with server-side TTL caching) and combine deterministic API-Football biographical/statistical facts with 2–3 targeted Google Searches into a schema-validated `VerifiedPlayerFacts` object, shared by both Futbolpedia and Gaffa mode (`services/gaffaChatService.ts`).
4. **Recalibrated Rating Tier Scale & Scout Calibration:** Unify a single, strict Rating Tier Scale across prompts and UI components where `"World-Class"` starts at `90`, relative labels like `"Best in World"` and the automatic Ballon d'Or `91+` floor are removed, and synthesis requires a leading `calibration` block (`tierBand`, `peerBenchmark`, `signatureSpikes`, `genuineFlaws`) at low temperature (`0.35`) with `ThinkingLevel.MEDIUM`.
5. **Live Dossier Revision in Chat:** When a user challenges a rating or requests an adjustment in chat and the scout concedes, return a structured `dossierPatch` that updates `activeProfile`, `allProfiles`, `globalDossiers`, and the Supabase cache in place.

## Non-goals

- Replacing the eye-test scout Overall rating with a rigid mathematical weighted-average formula.
- Changing the persisted `PlayerProfile` JSON shape in Supabase (`player_profiles`) or `localStorage` (`futbolpedia-conversations`, `futbolpedia-global-dossiers`).
- Changing Gaffa trade scorecard math (`deriveTradeVerdict`) or Gaffa league connect routes.

---

## Architecture Overview

```
User Message (App.tsx)
        │
        ▼
services/geminiService.ts (Public Facade)
        │
        ├─► 1. services/turnRouter.ts
        │      ├─ 0ms local fast-path for "Rate/Scout/Profile <Player>"
        │      └─ Schema-enforced classifyTurn() -> TurnRoute
        │
        ├─► 2. services/dossierStore.ts
        │      └─ In-conversation lock, saved archive match, & Supabase TTL cache
        │
        ├─► 3. services/groundingService.ts (Hybrid Parallel Grounding)
        │      ├─ Track A: GET /api/football/player (API-Football bio, club, injury, season stats)
        │      ├─ Track B: 2-3 parallel Google Searches (coach/transfer lock, scouting eye-test, honours)
        │      └─ Schema-enforced fact consolidation -> VerifiedPlayerFacts
        │
        ├─► 4a. services/dossierSynthesizer.ts (when intent === 'single_dossier')
        │      ├─ Uses prompts/dossierPrompt.ts + PLAYER_PROFILE_SYNTHESIS_SCHEMA
        │      ├─ Leading calibration block (tierBand, peerBenchmark, signatureSpikes, genuineFlaws)
        │      ├─ Schema-enforced primaryPosition / secondaryPosition enums
        │      └─ Post-synthesis validation (tierBand bounds, attribute spread, manager grounding)
        │
        └─► 4b. services/conversationalScout.ts (compare, challenge_or_revise, tactical_chat)
               ├─ Uses prompts/chatPrompt.ts (zero dossier JSON schema in prompt)
               └─ For challenge_or_revise: returns { replyProse, dossierPatch? } -> live UI update
```

---

## Section 1 — Module Decomposition

| File | Responsibility |
|---|---|
| `constants/ratingTiers.ts` | Single source of truth for the recalibrated Rating Tier Scale, position canonical maps, and attribute category metadata. Used by prompts, synthesis validation, `SidePanel.tsx`, and `PlayerProfileDisplay.tsx`. |
| `prompts/scoutCore.ts` | Shared analytical philosophy: The Scout's Code, recalibrated Section III Rating Tier Scale, and the 25 Outfield + 7 Goalkeeper Attribute Definitions. |
| `prompts/dossierPrompt.ts` | Dossier synthesis system instruction built on `scoutCore.ts`: Scout Calibration workflow, Spiky Profile rules, Tactico footballing identity, and Short Bio craft. |
| `prompts/chatPrompt.ts` | Conversational scout system instruction built on `scoutCore.ts`: prose comparisons, rating defense/revision rules, and optional EAFC Playstyles directory. Contains no dossier JSON schema. |
| `services/aiClient.ts` | Lazy `GoogleGenAI` initialization, `FLASH_MODEL` constant, `generateStructured<T>()`, `runGroundedSearch()`, and `generateProse()`. |
| `services/dossierStore.ts` | Supabase client initialization, `toPlayerSlug()`, `getCachedDossier()`, `upsertCachedDossier()`, `shareConversation()`, `getSharedConversation()`, and conversation/archive dossier lookup helpers. |
| `services/turnRouter.ts` | `classifyTurn()` with 0ms local fast-path and schema-enforced LLM classification into `TurnRoute`. |
| `services/groundingService.ts` | `gatherPlayerGrounding()` combining `/api/football/player` with parallel Google Search and schema-enforced `VerifiedPlayerFacts` extraction; also exports `gatherSearchFoundation()` for Gaffa mode. |
| `services/dossierSynthesizer.ts` | `synthesizePlayerDossier()` with `PLAYER_PROFILE_SYNTHESIS_SCHEMA`, `calibration` validation, canonical position/club normalization, and manager-mention verification. |
| `services/conversationalScout.ts` | `runConversationalScout()` for tactical Q&A, multi-player comparisons, archive inventory replies, and `challenge_or_revise` turns with `dossierPatch` generation and application. |
| `services/geminiService.ts` | Thin public facade re-exporting `sendMessageToAI`, `resetChat`, `getCachedDossier`, `shareConversation`, `getSharedConversation`, `generateJsonWithSchema`, `sendProseChatMessage`, `gatherSearchFoundation`, `supabase`, and `toPlayerSlug`. |

---

## Section 2 — Recalibrated Rating Tier Scale

`constants/ratingTiers.ts` defines the canonical tier bands and helper functions (`getTierForRating(rating: number)` and `TIER_BAND_RANGES`) used across prompts, synthesis validation, `SidePanel.tsx`, and `PlayerProfileDisplay.tsx`:

| Tier Enum ID | Range | Display Label | Definition |
|---|---|---|---|
| `99_GOAT` | 99 | GOAT | Once-in-history footballing peak. |
| `96_98_ICON` | 96–98 | Generational Icon | Historic, position-redefining peak across eras. Requires a Generational Weapon (Protocol C). |
| `93_95_WC_ELITE` | 93–95 | World-Class Elite | Rare, game-warping individual quality at the top of the World-Class bracket, sitting just below all-time generational icons. |
| `90_92_WORLD_CLASS` | 90–92 | World-Class | The entry threshold for the World-Class label. Undisputed elite players at their position globally who walk into any starting XI. |
| `87_89_BORDERLINE_WC` | 87–89 | Borderline World-Class | Standout stars and primary difference-makers at Champions League clubs who sit just shy of the 90+ World-Class bar. |
| `84_86_HIGH_END_STARTER` | 84–86 | High-End Starter | Proven high-level Champions League starters and standout Top 5 league performers, clearly above a standard starter. |
| `80_83_QUALITY_STARTER` | 80–83 | Quality Top-Flight Starter | Dependable everyday first-choice starters in a Top 5 league who execute their role well without being star players. |
| `75_79_ROTATIONAL` | 75–79 | Rotational / Average Top-Flight | Functional starters for mid-to-lower-table Top 5 league sides or trusted rotation pieces at top clubs. |
| `70_74_SQUAD_DEPTH` | 70–74 | Squad Depth | Backup or specialist squad professionals in a Top 5 league. |
| `60_69_DEVELOPING` | 60–69 | Developing / Raw Prospect | Youth prospects or lower-tier professionals not yet proven at top-flight level. |

### Key Analytical Changes in `prompts/scoutCore.ts`
- **No relative "Best in World" tier label:** Being the highest-rated or most decorated player in a single season does not automatically assign 94–95; every tier measures intrinsic footballing quality against an absolute historical standard.
- **No automatic Ballon d'Or 91+ floor:** Individual awards and nominations serve as contextual evidence of standing, never a mandatory numerical floor. Team trophies and media narrative never inflate a player into the 90+ World-Class bracket unless their intrinsic on-pitch quality warrants it.
- **World-Class strictly starts at 90:** Players in the 84–89 range are explicitly graded as High-End Starters (`84–86`) or Borderline World-Class (`87–89`), aligning prompt definitions with the `>= 90` emerald highlight threshold in `SidePanel.tsx`.

---

## Section 3 — Turn Router (`services/turnRouter.ts`)

### Route Contract

```ts
export type TurnIntent =
  | 'single_dossier'
  | 'compare'
  | 'challenge_or_revise'
  | 'archive_inventory'
  | 'tactical_chat';

export interface TurnRoute {
  intent: TurnIntent;
  targetPlayers: string[];
  isHistorical: boolean;
  wantsRegeneration: boolean;
  needsSearch: boolean;
}
```

### Routing Logic
1. **Deterministic 0ms Fast-Path:**
   - If the message matches a clean single-player dossier request pattern (e.g. `"rate <name>"`, `"scout <name>"`, `"profile <name>"`, `"dossier on <name>"`, or a bare 1–4 word player name when no question/challenge/comparison cues are present) and contains no comparison (`vs`, `versus`, `compare`, `or`), challenge (`why`, `too low`, `too high`, `disagree`), or regeneration/positional-variation cues (`again`, `at striker`, `update`, `refresh`), `classifyTurn` resolves immediately in 0ms with `intent: 'single_dossier'`.
   - If the message explicitly asks to list saved/archived dossiers (`"what dossiers do I have saved"`, `"list my dossiers"`), it resolves immediately as `archive_inventory`.
2. **Schema-Enforced LLM Classifier:**
   - For all other messages, `classifyTurn` calls `generateStructured<TurnRoute>` using `FLASH_MODEL` with `ThinkingLevel.MINIMAL` and `temperature: 0.1`.
   - Context passed to the classifier includes the last 2 chat messages, the active dossier's player name (`activeProfile?.basicInfo.name`), and the names of players dossiered in the current conversation so pronouns (`"he"`, `"him"`, `"his passing"`) resolve directly to the canonical player name in `targetPlayers`.
   - Guardrail: if `intent === 'single_dossier'` but `targetPlayers.length === 0` and no image is attached, downgrade `intent` to `'tactical_chat'` so the pipeline never invents a random dossier.

---

## Section 4 — Hybrid Parallel Grounding (`server.ts` & `services/groundingService.ts`)

### 1. Server Endpoint: `GET /api/football/player` in `server.ts`
- Query parameters: `name` (required string), `season` (optional year, defaults to `2025`).
- Behavior:
  1. Checks an in-memory server cache (`Map<string, { expiresAt: number; data: ApiFootballPlayerFactSheet | null }>`, 6-hour TTL) keyed by normalized player query.
  2. If `API_FOOTBALL_KEY` is missing, returns `{ available: false, player: null }` with HTTP 200 so the client never errors out.
  3. Calls API-Football `GET /players/profiles?search=<lastNameOrFullName>` to resolve the player's profile (ID, full name, age, birth date, nationality, height, weight, position, photo) and `GET /players?id=<playerId>&season=<season>` to pull their active club, league, injury status, and season totals (appearances, lineups, minutes, goals, assists, passes, rating).
  4. Caches and returns the normalized `ApiFootballPlayerFactSheet`.

```ts
export interface ApiFootballPlayerFactSheet {
  id: number;
  name: string;
  firstname?: string;
  lastname?: string;
  age: number | null;
  nationality: string | null;
  height: string | null;
  weight: string | null;
  position: string | null;
  currentClub: string | null;
  league: string | null;
  injured: boolean | null;
  seasonStats: {
    season: number;
    appearances: number | null;
    lineups: number | null;
    minutes: number | null;
    goals: number | null;
    assists: number | null;
    keyPasses: number | null;
    tackles: number | null;
    interceptions: number | null;
    duelsWon: number | null;
    rating: string | null;
  } | null;
}
```

### 2. Client Grounding Orchestrator (`services/groundingService.ts`)
- For a formal dossier request (`gatherPlayerGrounding(playerName, query, mode, isHistorical)`):
  - **Historical requests (`isHistorical === true`):** Runs 3 parallel Google Searches focused on peak era honours/anchor, peak season statistical output, and peak tactical identity/scouting analysis.
  - **Current requests (`isHistorical === false`):** Fires `fetch('/api/football/player?name=...')` and 3 parallel Google Searches (2 in `fast` mode) in a single `Promise.allSettled` wave:
    1. **Search 1 (Club, Coach & Availability Lock):** Current club as of `SIMULATION_YEAR`, confirmed current head coach, injury/availability, recent match date, and transfer/loan mobility.
    2. **Search 2 (Eye-Test & Tactical Profile):** Detailed scouting report on how the player operates on the pitch, technical/physical/mental strengths, weaknesses, and role usage.
    3. **Search 3 (Standing & Output — Default mode):** `SIMULATION_SEASON` performance narrative, major honours/rankings, and peer standing.
- **Schema-Enforced Fact Extraction (`extractVerifiedFacts`):**
  - Runs `generateStructured<FutbolpediaVerifiedFacts>` with a strict `responseSchema` (replacing the old unvalidated `JSON.parse` on raw text), combining the `ApiFootballPlayerFactSheet` and web search results.
  - Precedence rule: API-Football anchors `age`, `nationality`, `height`, and `weight`; for `currentClub`, web search overrides API-Football if search confirms a more recent transfer or loan in `SIMULATION_YEAR`.
- **Gaffa Mode Integration:**
  - `gatherSearchFoundation` in `services/groundingService.ts` also fetches `/api/football/player` in parallel for up to 2 named trade/evaluation players and prepends their verified API-Football bio/club/stats summary to the grounding notes used by `services/gaffaChatService.ts`.

---

## Section 5 — Calibrated Dossier Synthesis (`services/dossierSynthesizer.ts`)

### Synthesis Schema (`PLAYER_PROFILE_SYNTHESIS_SCHEMA`)
To enforce calibration before rating generation and guarantee valid position strings, the synthesis schema requires:

1. `calibration` (required object):
   - `tierBand`: `Type.STRING` with `enum` of the 10 canonical tier IDs from `constants/ratingTiers.ts`.
   - `peerBenchmark`: `Type.STRING` naming 1–2 real-world positional peers that anchor the player's placement within that tier.
   - `signatureSpikes`: `Type.ARRAY` of 3–4 attribute keys where the player excels.
   - `genuineFlaws`: `Type.ARRAY` of 2–3 attribute keys representing real limitations.
2. `basicInfo` (required object):
   - `name`, `age`, `nationality`, `club`, `height`, `weight`
   - `primaryPosition`: `Type.STRING` with `enum` of the 16 canonical positions (`Goalkeeper`, `Centre-Back`, `Left Back`, `Right Back`, `Left Wing-Back`, `Right Wing-Back`, `Defensive Midfielder`, `Central Midfielder`, `Attacking Midfielder`, `Left Midfielder`, `Right Midfielder`, `Left Winger`, `Right Winger`, `Striker`, `Centre Forward`, `Second Striker`).
   - `secondaryPosition`: `Type.STRING` with `enum` of the same 16 canonical positions plus `'None'`.
3. `ratings`, `strengths`, `weaknesses`, `attributes`, `goalkeeperAttributes`, `shortBio`, `playstyleAndRole`, `latestUpdate`.

### Synthesis Execution & Validation Gates
1. Calls `generateStructured` with `prompts/dossierPrompt.ts`, `temperature: 0.35`, and `ThinkingLevel.MEDIUM`.
2. **Position & Club Normalization:** Joins `primaryPosition` and `secondaryPosition` (when not `'None'` and distinct) with `'/'` into `basicInfo.position`, and runs `normalizeClub(basicInfo.club)` and height/weight cleanup.
3. **Tier-Band Consistency Check:** If `ratings.overall` falls outside the integer range of the model's chosen `calibration.tierBand` by more than 1 point, or if `findProfileManagerGroundingIssues` detects an unverified head-coach name in prose, retries once with an explicit `<validation_retry>` correction block.
4. **Spiky Profile Verification:** Checks that outfield attributes for recognizable players (`ratings.overall > 0`) have genuine spread and no zeroed attributes.
5. Strips `calibration` and returns the clean `PlayerProfile`.

---

## Section 6 — Conversational Scout & Live Dossier Revision (`services/conversationalScout.ts` & `App.tsx`)

### 1. Conversational Modes
- Uses `prompts/chatPrompt.ts` (which includes `scoutCore.ts` and, when `isEAFCRequest` is true, `FC_PLAYSTYLES_DIRECTORY`).
- Serializes all dossiers from the active conversation (`mergeConversationDossiers`) into authoritative context so follow-ups never contradict earlier numbers.
- For `compare` and `tactical_chat` turns that require grounding (`route.needsSearch === true`), runs `groundingService` for the named players or topic before generating the response.

### 2. Live Dossier Revision (`intent === 'challenge_or_revise'`)
When the user challenges a rating/attribute or asks to adjust an existing dossier in the conversation:
- Calls `generateStructured<ChallengeTurnResult>` with schema:
  ```ts
  export interface DossierPatch {
    targetPlayerName: string;
    overall?: number;
    potential?: number;
    attributes?: Partial<Attributes>;
    goalkeeperAttributes?: Partial<GoalkeeperAttributes>;
    strengths?: string[];
    weaknesses?: string[];
    archetype?: string;
    playstyleDescription?: string;
    bestRoles?: string[];
  }

  export interface ChallengeTurnResult {
    replyProse: string;
    revisedDossier: boolean;
    dossierPatch?: DossierPatch;
  }
  ```
- If `revisedDossier === true` and `dossierPatch` matches a dossier in the conversation:
  1. Merges the patched fields onto the target `PlayerProfile` (`applyDossierPatch`).
  2. Saves the updated dossier to the Supabase cache (`upsertCachedDossier`).
  3. Invokes `options?.onDossierUpdated?.(updatedProfile)` passed from `App.tsx` to `sendMessageToAI`.
  4. In `App.tsx`, `onDossierUpdated` calls `saveAndSetActiveProfile(updatedProfile)` and updates any matching inline `PlayerProfile` message in the current conversation so the side panel card, conversation history, and global dossier archive reflect the revised numbers immediately while the chat displays `replyProse`.

---

## Acceptance Criteria

1. `npx tsc --noEmit` and `npm run build` pass with zero errors.
2. `services/geminiService.ts` is reduced from 1,584 lines to a clean facade delegating to the focused modules in `services/` and `prompts/`.
3. Rating tier labels across `constants/ratingTiers.ts`, `prompts/scoutCore.ts`, `components/SidePanel.tsx`, and `components/PlayerProfileDisplay.tsx` use the single recalibrated scale (`World-Class` starting at 90, no `"Best in World"` tier label, no automatic Ballon d'Or 91+ floor).
4. `GET /api/football/player` resolves player biographical and season stats from API-Football with caching and graceful fallback when `API_FOOTBALL_KEY` is absent.
5. Dossier synthesis uses schema-enforced position enums and leading `calibration` anchoring at low temperature (`0.35`).
6. Conversational challenges that result in a conceded rating or attribute adjustment update the active dossier in `App.tsx` and the side panel live while returning the scout's prose explanation in chat.
