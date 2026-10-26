# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start development server (Express + Vite middleware) on port 3000
npm run build    # Vite production build to /dist
npm start        # Run production server (serves /dist statically)
```

```bash
npm run typecheck   # tsc --noEmit (run `npm ci` in packages/engine first for its vitest types)
npm test            # offline app checks: scripts/test-dossier-cards.ts, test-dossier-pipeline.ts (end-to-end with Gemini faked at fetch), test-chat-consistency.ts (chat vs stored cards), test-gaffa-name-matching.ts, test-club-managers.ts
cd packages/engine && npm ci && npm test   # outlook engine + manager-fidelity vitest suite
```

CI (`.github/workflows/ci.yml`) runs all of the above plus `npm run build` on every PR and push to `main`. The tests need no network or API keys; add new offline checks to `npm test`.

## Environment Variables

- `GEMINI_API_KEY` — Google Gemini key. Vite injects it into the client as `process.env.API_KEY` (read by `services/aiClient.ts`); the server's `/gemini-api-proxy/*` also uses it.
- `API_FOOTBALL_KEY` — API-Football key (used by `server.ts`)
- `GAFFA_BASE_URL`, `FUTBOLPEDIA_READ_SECRET` — server-only Gaffa integration (see `.env.example`)

Supabase publishable keys are hardcoded (safe for client exposure): Futbolpedia's in `services/dossierCache.ts`, Gaffa's in `services/gaffaAuth.ts`. The Supabase JS client is loaded via a `<script>` tag in `index.html` and accessed at `window.supabase`, not via an npm package.

## Architecture

### Server (`server.ts`)
A single Express server handles everything:
- `/api/football/player`, `/api/football/squad`, `/api/football/fixtures`, `/api/football/proxy/*` — API-Football proxy (hides `API_FOOTBALL_KEY`), with in-memory caches for player facts and team context
- `/api/gaffa/context`, `/api/gaffa/chat` — Gaffa integration behind `FUTBOLPEDIA_READ_SECRET`
- `/gemini-api-proxy/*` — forwards AI Studio's redirected Gemini calls with the server-side key
- In dev: Vite is mounted as Express middleware (`middlewareMode: true`); in prod: serves `/dist`

### AI pipeline (`services/`)
`geminiService.ts` is the entry point (`sendMessageToAI`) and a re-export barrel for older imports. Each turn:
1. **Route** — `turnRouter.ts` `classifyTurn` tries 0ms regex fast paths (archive, single dossier, compare, challenge, ranking, club tactics), then falls back to a schema-enforced Flash classifier. The result is a `TurnRoute` (`intent`, `analyticalMode`, target players/clubs, search queries).
2. **Single dossier** — checks the in-conversation dossier, the saved archive, the in-memory calibrated pool, and the shared Supabase cache (`dossierCache.ts`), in that order. `dossierStore.ts` is a barrel over the dossier modules: `dossierCards` (card keys, slugs, evaluation dates), `dossierCache` (Supabase cache, versioned archive, sharing, Global Dossier Hub), `dossierContext` (history serialization, references, locked/saved/prior-rating blocks), `dossierLedger` (grep tool, peer ledger) and `dossierPatch`. On a miss, `groundingService.ts` runs API-Football and Google Search grounding in parallel and `dossierSynthesizer.ts` generates the card with `responseSchema`. It then enforces calibration invariants deterministically and scrubs unverified manager mentions.

**Ratings are the model's judgment of footballing ability.** Overall is never computed from attributes. Tiers (`constants/ratingTiers.ts`, Scout's Code §II) describe how good a footballer a version is on one all-era standard; positional rank, honours and dominance of an era are evidence, never the band itself. While rating, the model fills `calibration.peerPlacement`: which `<calibrated_peer_ledger>` peers this version was better than, level with, or not as good as. `ratingPlacement.ts` resolves those names to ledger cards (same edition preferred, never the player himself, ambiguous names ignored) and moves the Overall into the range that placement allows (strictly above/below when integers leave room, a tie otherwise). A self-contradictory placement changes nothing. The resolved placement is stored on the card (`peerPlacement`), shown under the benchmark, and serialized for chat.
3. **Everything else** — `conversationalScout.ts` handles live dossier challenges (structured patch → `applyDossierPatch`) and prose turns (comparisons, debates, rankings, tactics), pre-grounding with search when needed.

**Chat stays on the stored cards.** A new dossier shows in chat as a one-line stub carrying `dossierKey`; `buildHistoryContents` swaps each stub for the full card, so the model sees cards where the user saw them. Challenge turns get the challenged card plus the full card of every other player in the thread (in the same edition), and the thread's earlier replies keep their closing verdicts. A follow-up with no timeframe in a prime debate stays on prime cards. After generation, `dossierNumberGate.ts` puts any misquoted attribute of a card in play back to its stored value; it never touches Overall/Potential, which debate prose may propose on purpose.

`aiClient.ts` wraps `@google/genai`: `generateStructured` (schema JSON), `runGroundedSearch`, and `generateProseTurn` (streaming chat with local tools `grep_saved_dossiers` / `grep_gaffa_market` and network tools backed by the API-Football routes). Per-task model, thinking level and temperature come from `constants/modelProfiles.ts`.

### Gaffa mode (`services/gaffaChatService.ts`)
Separate chat domain from dossier synthesis. When the ChatInput **Gaffa** toggle is on, `App` routes to `sendGaffaMessage` — prose only, never `responseSchema` dossiers. Rules come from curated `constants/gaffaRules.ts` (`GAFFA_RULES_SNAPSHOT`, versioned). Soft auto-detect in `services/gaffaDetect.ts` nudges switching mode when default chat looks Gaffa-specific; it does not silently inject Gaffa context.

**Club connect:** sign in through `services/gaffaAuth.ts` and pick a club (RLS context loader), paste league + club IDs in the connect strip, or open `#/gaffa/<leagueId>/<clubId>`. Express `GET /api/gaffa/context` proxies to Gaffa `GET /api/integrations/futbolpedia/context`. The live bag fills `GaffaContextBag` (roster, budget, standings, matchup, XI, listings, auctions, FA pool, league settings); `gaffaLineupAudit.ts` derives lineup audits, alerts and bid valuations from it.

### Manager fidelity
API-Football and model memory both lag coaching changes, so neither decides who manages a club. `services/clubManagers.ts` looks it up live: a focused Google-grounded Flash search per club (coach, appointment date, immediate predecessor, source), cross-checked against API-Football's `pickCurrentCoach` record (the search wins a disagreement; no search answer means nobody is named). Results are shared through the Supabase `club_managers` table and refreshed at most once a day per club. Nothing is maintained by hand.
- **Cards:** the dossier prompt forbids manager names in card prose. After synthesis, `attachVerifiedManager` sets `profile.clubManager` (shown on the card with its verified date) and scrubs the prose in strict mode, so only the verified coach can be named, and nobody when the lookup found no one.
- **Chat:** `conversationalScout` looks up the clubs in play, passes them to the model as `<verified_managers>`, and gives them to the scrub as `clubManagers`.
- **Gates** (`packages/engine/src/gates/managerMentions.ts`): `scrubUnverifiedManagerText` replaces coach names the turn didn't verify. `scrubFormerCoaches` rewrites a club's immediate predecessor to its current coach, only for clubs the text names and never for someone currently coaching another club in play. `strictCurrentCoach` closes the loophole where a sacked coach counts as verified because search text mentions him.
- API-Football's coach is no longer written into grounding text. It's kept only as the lookup's cross-check.

**Critical quirks:**
- `gemini-3.8-flash` rejects `ThinkingLevel.MINIMAL` (HTTP 400); `aiClient.ts` maps the `minimal` tier to `LOW`.
- `SIMULATION_YEAR` / `SIMULATION_SEASON` (`prompts/scoutCore.ts`) are computed once at module load from the real date via `getRealWorldFootballSeason`, so the system instruction stays byte-stable within a process for Gemini's implicit prompt caching. Per-turn prompts read the date through `getCurrentSeasonInfo()`.
- The EAFC playstyle directory is only injected when the query matches an EAFC pattern — `buildConversationalScoutInstruction(includeEAFC)` controls this.
- `CALIBRATION_EPOCH_MS` in `dossierCache.ts` marks the last rating recalibration. `isRatedOnCurrentScale` keeps older cards (by their own `createdAt`, falling back to row time) out of the cache, peer ledger, prior-rating memory, the Hub and sharing, so old-scale numbers never anchor a new rating. Cards rated before the 2026-10-20 recalibration were moved to the RLS-locked `player_profiles_pre_recalibration` table. When you change the scale, bump the epoch and archive the same way. The 2026-10-26 rule rewrite (ability-first tiers, peer placement) deliberately kept the epoch: cards are records of when they were rated, so existing cards stay in use as rated and anchor new ones.
- Shared cards: a current card is the one shared card for `CARD_REFRESH_DAYS` (30) from its evaluation date, prime cards are frozen, and accepted challenges stay personal revisions logged to `dossier_revisions` (3 agreeing people re-rate early). The `enforce_dossier_refresh_window` trigger (`supabase/migrations/`) mirrors `CARD_REFRESH_DAYS`, `CALIBRATION_EPOCH_MS` and `REVISION_CONSENSUS_USERS`, so change them in both places. Inside the window only the Latest Update moves: `latestUpdateRefresh.ts` rewrites it from fresh facts once it is `LATEST_UPDATE_REFRESH_DAYS` (7) old, stamps `latestUpdateAsOf`, and writes the pointer row only (same evaluation date, so the trigger allows it).
- Versions, not legacies: a card rates one version of a player (current form, prime, or a named past season), never a career. `classifyTurn` reads a past season from the message (`requestedSeason`) and the pipeline rates that season as a `season_snapshot` card, stored only under its archive slug and found by `getCachedSeasonCard`. With no timeframe, `getCareerStatus` (a grounded Flash check run alongside grounding) sends a retired player to his prime. A prime is a window, not one season: the stretch of consecutive seasons (at most `MAX_PRIME_WINDOW_SEASONS`, 3) when he played at his best, chosen by level rather than output, and rated at the level he sustained across it. The model returns `version.primeWindow`; `sanitizeProfileData` derives `seasonOrEra` ("2003-06") and the label from it, and a longer window fails validation. A multi-season window never answers a single-season request (`seasonMatches`), so that season gets its own season card. Prime cards from before windows keep their one season and still serve as that season's card.
- Positions: `CANONICAL_POSITIONS` has no separate Striker (it maps to Centre Forward). `Libero` is for sweeper-era cards only: `resolveLiberoPosition` pairs it with a modern position (`Libero/Centre-Back` by default) and files it under Centre-Back on current cards.

### Frontend State
`App.tsx` manages all state via React hooks. Two persistence layers:
- **`localStorage`** — Conversations (`futbolpedia-conversations`), active dossiers (`futbolpedia-global-dossiers`), theme, active conversation ID
- **Supabase** — `player_profiles` (dossier cache, `player_data` JSONB) and `shared_conversations` (share codes)

On init, `App.tsx` runs a migration path: old `futbolpedia-chat-history` / `futbolpedia-all-profiles` keys are consolidated into the newer `futbolpedia-conversations` schema.

### Key Types (`types.ts`)
- `PlayerProfile` — The central data model. Contains `basicInfo`, `ratings` (overall/potential), `attributes` (25 outfield), optional `goalkeeperAttributes`, `strengths`, `weaknesses`, `playstyleAndRole`, `shortBio`, `latestUpdate`.
- `Conversation` — Wraps an array of `ChatMessage` plus the `activeProfile` and `allProfiles` at the time.
- `ChatMessage.content` is a union: `string | PlayerProfile | ReactNode`.

### Prompt Engineering (`prompts/`, re-exported by `constants.ts`)
- `scoutCore.ts` — shared scouting philosophy, Section III rating tier scale, the 25+7 attribute framework, and named protocols (A–Q: B = injury quarantine, E = stat-lock, M = temporal firewall, Q = contextual triangulation, …). Kept byte-stable as the cached prompt prefix.
- `chatPrompt.ts` — conversational scouting mandate (Section VIII) built by `buildConversationalScoutInstruction`.
- `dossierPrompt.ts` — schema-aligned calibration and synthesis workflow (Section VI).
- **No specific examples in prompts.** Guidance that shapes cards or chat prose must be descriptive: no player names, rating anchors, quoted sample phrases or jargon lists, because the model reuses them. Format specs (YYYY-YY, label templates, enum values) are fine.
- Tier bands, canonical positions, club/position normalization and attribute labels live in `constants/ratingTiers.ts` and must match `types.ts` and the synthesis schema.
