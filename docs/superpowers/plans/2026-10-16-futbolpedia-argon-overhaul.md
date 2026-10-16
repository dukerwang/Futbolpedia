# Futbolpedia Engine Overhaul (Gemini 3.8 Flash & Gemini 4 Argon Architecture) — Implementation Plan

**Goal:** Replace the legacy Gemini 2/3-era monolithic pipeline with a modular, model-aware architecture featuring a Model Capability Registry, recalibrated Rating Tier Scale (`World-Class` starting at 90), Structured Turn Router, Hybrid Parallel Grounding (API-Football + Web Search), Schema-First Scout Calibration, Split Prompts, and Live Dossier Revision in chat.

**Spec:** `docs/superpowers/specs/2026-10-16-futbolpedia-argon-overhaul-design.md`

---

## Task 1: Canonical Rating Tiers, Positions & Model Capability Registry

**Files:**
- Create: `constants/ratingTiers.ts`
- Create: `constants/modelProfiles.ts`
- Modify: `constants.ts` (re-export shared constants and build prompts from the new modular prompt files)

**Details:**
1. In `constants/ratingTiers.ts`:
   - Define `RATING_TIERS` from `99_GOAT` down to `60_69_DEVELOPING` with `World-Class` starting at `90` (`90–92: World-Class`, `93–95: World-Class Elite`), `87–89: Borderline World-Class`, `84–86: High-End Starter`, `80–83: Quality Top-Flight Starter`, `75–79: Rotational / Average Top-Flight`, `70–74: Squad Depth`, `60–69: Developing / Raw Prospect`.
   - Export `getTierForRating(rating: number)`, `getShortTierLabel(rating: number)`, `TIER_BAND_IDS`, `CANONICAL_POSITIONS` (the 16 valid positions), `normalizePosition()`, and `normalizeClub()`.
2. In `constants/modelProfiles.ts`:
   - Define `AITask = 'routing' | 'grounding' | 'extraction' | 'synthesis' | 'chat'`.
   - Define `ModelProfile` (`id`, `family`, `supportsHighThinkingWithSchema`, `taskDefaults` for thinkingLevel and temperature).
   - Provide built-in profiles for `gemini-3.8-flash` and `gemini-4-argon` (plus prefix matching for future `gemini-4*` / `gemini-5*` models) and `resolveTaskModelConfig(task, mode)` so switching or mixing models across tasks requires changing a single config constant.

---

## Task 2: Split System Prompts (`prompts/`)

**Files:**
- Create: `prompts/scoutCore.ts`
- Create: `prompts/dossierPrompt.ts`
- Create: `prompts/chatPrompt.ts`
- Modify: `constants.ts`

**Details:**
1. `prompts/scoutCore.ts`:
   - Simulation constants (`SIMULATION_YEAR = 2026`, `SIMULATION_SEASON = '2025-26'`).
   - Principle-driven Scout's Code (Intrinsic Quality over team trophies, Form vs. Class, Tactical Role Primacy, League Context & Skill Translation, High-Risk Creator rule, Injury Quarantine / Rodri Rule, Generational Weapon paths strictly for 96+, Temporal & Head-Coach Grounding, Writer's Code).
   - No relative `"Best in World"` tier label and no automatic Ballon d'Or Top-15 `91+` floor.
   - Recalibrated Rating Tier Scale generated directly from `RATING_TIERS`.
   - Complete 25 Outfield + 7 Goalkeeper Attribute Definitions and `FC_PLAYSTYLES_DIRECTORY`.
2. `prompts/dossierPrompt.ts`:
   - Focused system instruction for structured dossier synthesis: Scout Calibration workflow (`tierBand`, `peerBenchmark`, `signatureSpikes`, `genuineFlaws`), Spiky Profile spread mandate, Tactico footballing identity, and non-templated Short Bio craft.
3. `prompts/chatPrompt.ts`:
   - Focused system instruction for conversational scouting, multi-player prose comparisons, and honest rating defense/revision (`challenge_or_revise`), with zero JSON dossier schema in prompt.

---

## Task 3: Modular AI Client & Dossier Store (`services/aiClient.ts` & `services/dossierStore.ts`)

**Files:**
- Create: `services/aiClient.ts`
- Create: `services/dossierStore.ts`

**Details:**
1. `services/aiClient.ts`:
   - Lazy `GoogleGenAI` singleton (`getAi()`).
   - `generateStructured<T>({ task, mode, prompt, systemInstruction, schema, temperatureOverride, thinkingLevelOverride })`: resolves model, thinkingLevel, and temperature via `resolveTaskModelConfig`, calls `generateContent` with `responseMimeType: 'application/json'` and `responseSchema`, logs `[Perf]` token diagnostics, and parses JSON cleanly.
   - `runGroundedSearch({ query, dateContext })`: runs `generateContent` with `tools: [{ googleSearch: {} }]` and extracts grounding source URLs/titles alongside text.
   - `generateChatTurn({ message, history, imageData, systemInstruction, mode, temperatureOverride, thinkingLevelOverride, allowSquadTool })`: stateless per-call chat execution supporting `get_football_squad` tool calls without brittle module-global mutable state.
2. `services/dossierStore.ts`:
   - Supabase client initialization, `toPlayerSlug`, `getCachedDossier`, `upsertCachedDossier`, `shareConversation`, `getSharedConversation`.
   - `serializeProfileForHistory`, `mergeConversationDossiers`, `findReferencedDossiers`, `buildLockedDossiersBlock`, `resolveSavedDossiersForRequest`, `buildSavedDossiersBlock`, and `applyDossierPatch`.

---

## Task 4: Server API-Football Player Endpoint & Hybrid Grounding (`server.ts` & `services/groundingService.ts`)

**Files:**
- Modify: `server.ts`
- Create: `services/groundingService.ts`
- Modify: `services/gaffaChatService.ts`

**Details:**
1. In `server.ts`:
   - Add `GET /api/football/player` with a 6-hour in-memory TTL cache.
   - Queries API-Football `/players/profiles` and `/players` to return `ApiFootballPlayerFactSheet` (name, age, nationality, height, weight, position, currentClub, league, injured, seasonStats). Gracefully returns `{ available: false, player: null }` if `API_FOOTBALL_KEY` is missing or no match is found.
2. In `services/groundingService.ts`:
   - `fetchApiFootballPlayer(playerName)`: calls `/api/football/player` with a short timeout and safe fallback.
   - `gatherPlayerGrounding({ playerName, rawMessage, mode, isHistorical })`: runs `fetchApiFootballPlayer` in parallel with 2–3 targeted Google Searches, then runs schema-enforced `extractVerifiedFacts` to produce `{ foundationText, verifiedFacts, apiPlayer }`.
   - `gatherSearchFoundation(queries, playerHints?)`: parallel search helper for Gaffa mode that also enriches with API-Football player facts when player names are present.

---

## Task 5: Structured Turn Router, Dossier Synthesizer & Conversational Scout

**Files:**
- Create: `services/turnRouter.ts`
- Create: `services/dossierSynthesizer.ts`
- Create: `services/conversationalScout.ts`
- Modify: `services/geminiService.ts`

**Details:**
1. `services/turnRouter.ts`:
   - 0ms local fast-path for clean single-player commands (`"Rate Saka"`, `"Scout Pedri"`) and archive inventory queries.
   - Schema-enforced `classifyTurn()` returning `TurnRoute` (`intent`, `targetPlayers`, `isHistorical`, `wantsRegeneration`, `needsSearch`), resolving pronouns against active/recent conversation dossiers.
2. `services/dossierSynthesizer.ts`:
   - Defines `PLAYER_PROFILE_SYNTHESIS_SCHEMA` with leading `calibration` (`tierBand`, `peerBenchmark`, `signatureSpikes`, `genuineFlaws`) and enum-constrained `primaryPosition` / `secondaryPosition`.
   - Validates tier-band bounds, attribute spread, and manager grounding (`findProfileManagerGroundingIssues`), retrying once with targeted feedback if a gate fails.
   - Strips `calibration` and returns a clean `PlayerProfile`.
3. `services/conversationalScout.ts`:
   - Handles `compare`, `tactical_chat`, `archive_inventory`, and `challenge_or_revise`.
   - On `challenge_or_revise`, uses a structured response schema (`{ replyProse, revisedDossier, dossierPatch }`). When `revisedDossier` is true, patches the target `PlayerProfile`, updates the Supabase cache, and invokes `onDossierUpdated`.
4. `services/geminiService.ts`:
   - Thin facade wiring `turnRouter`, `dossierStore`, `groundingService`, `dossierSynthesizer`, and `conversationalScout` while preserving all existing exports.

---

## Task 6: UI Tier Sync & Live Dossier Revision Wiring (`App.tsx`, `SidePanel.tsx`, `PlayerProfileDisplay.tsx`)

**Files:**
- Modify: `components/SidePanel.tsx`
- Modify: `components/PlayerProfileDisplay.tsx`
- Modify: `App.tsx`
- Modify: `vite.config.ts` (expose optional `FUTBOLPEDIA_MODEL` / `FUTBOLPEDIA_SYNTHESIS_MODEL` env vars)

**Details:**
1. Update `SidePanel.tsx` and `PlayerProfileDisplay.tsx` to use `getShortTierLabel` / `getTierForRating` from `constants/ratingTiers.ts` so UI tier labels match the new scale (`World-Class` at 90+).
2. Update `App.tsx` to pass an `onDossierUpdated` callback to `sendMessageToAI` so live rating/attribute revisions in chat immediately update `activeProfile`, `allProfiles`, `globalDossiers`, and open the side panel with the updated numbers.
3. Run `npx tsc --noEmit` and `npm run build` to verify zero TypeScript or bundle errors.
