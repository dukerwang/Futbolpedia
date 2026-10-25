# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start development server (Express + Vite middleware) on port 3000
npm run build    # Vite production build to /dist
npm start        # Run production server (serves /dist statically)
```

TypeScript type-check: `npx tsc --noEmit` (the only errors on a fresh clone are missing `vitest` types under `packages/engine` until you install that package). The app has no test runner; the outlook engine does: `cd packages/engine && npm ci && npx vitest run`.

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
2. **Single dossier** — checks the in-conversation dossier, the saved archive, the in-memory calibrated pool, and the Supabase 14-day cache (`dossierCache.ts`), in that order. `dossierStore.ts` is a barrel over the dossier modules: `dossierCards` (card keys, slugs, evaluation dates), `dossierCache` (Supabase cache, versioned archive, sharing, Global Dossier Hub), `dossierContext` (history serialization, references, locked/saved/prior-rating blocks), `dossierLedger` (grep tool, peer ledger) and `dossierPatch`. On a miss, `groundingService.ts` runs API-Football and Google Search grounding in parallel and `dossierSynthesizer.ts` generates the card with `responseSchema`. It then enforces calibration invariants deterministically and scrubs unverified manager mentions.
3. **Everything else** — `conversationalScout.ts` handles live dossier challenges (structured patch → `applyDossierPatch`) and prose turns (comparisons, debates, rankings, tactics), pre-grounding with search when needed.

`aiClient.ts` wraps `@google/genai`: `generateStructured` (schema JSON), `runGroundedSearch`, and `generateProseTurn` (streaming chat with local tools `grep_saved_dossiers` / `grep_gaffa_market` and network tools backed by the API-Football routes). Per-task model, thinking level and temperature come from `constants/modelProfiles.ts`.

### Gaffa mode (`services/gaffaChatService.ts`)
Separate chat domain from dossier synthesis. When the ChatInput **Gaffa** toggle is on, `App` routes to `sendGaffaMessage` — prose only, never `responseSchema` dossiers. Rules come from curated `constants/gaffaRules.ts` (`GAFFA_RULES_SNAPSHOT`, versioned). Soft auto-detect in `services/gaffaDetect.ts` nudges switching mode when default chat looks Gaffa-specific; it does not silently inject Gaffa context.

**Club connect:** sign in through `services/gaffaAuth.ts` and pick a club (RLS context loader), paste league + club IDs in the connect strip, or open `#/gaffa/<leagueId>/<clubId>`. Express `GET /api/gaffa/context` proxies to Gaffa `GET /api/integrations/futbolpedia/context`. The live bag fills `GaffaContextBag` (roster, budget, standings, matchup, XI, listings, auctions, FA pool, league settings); `gaffaLineupAudit.ts` derives lineup audits, alerts and bid valuations from it.

### Manager fidelity
API-Football and model memory both lag coaching changes. Live data comes first: `pickCurrentCoach` takes the open `/coachs` stint at the team with the latest start, and the team context and `/api/football/player` / `/fixtures` payloads carry `coach` plus `coachSince`. `packages/engine/src/gates/managerMentions.ts` also holds `KNOWN_CLUB_MANAGERS`, a hand-verified override (not a source of truth) dated by `KNOWN_CLUB_MANAGERS_VERIFIED_ON`. It drives `correctStaleCoachRecord` (overrides an API coach record only when it is missing, names a listed stale coach, or has a `coachSince` before the verified date), `scrubKnownStaleManagers` (club-scoped prose rewrites, using the turn's verified coach for the verified club) and `formatKnownClubManagersForPrompt` (scout prompt line). The whole table switches off 120 days after its verified date (the server warns at startup from 14 days out), so when you touch it, re-verify every entry and bump the date together. Use full names only in `stale`, and never list someone who coaches another listed club. `scrubUnverifiedManagerText` separately replaces any coach name that the turn's grounding didn't verify.

**Critical quirks:**
- `gemini-3.8-flash` rejects `ThinkingLevel.MINIMAL` (HTTP 400); `aiClient.ts` maps the `minimal` tier to `LOW`.
- `SIMULATION_YEAR` / `SIMULATION_SEASON` (`prompts/scoutCore.ts`) are computed once at module load from the real date via `getRealWorldFootballSeason`, so the system instruction stays byte-stable within a process for Gemini's implicit prompt caching. Per-turn prompts read the date through `getCurrentSeasonInfo()`.
- The EAFC playstyle directory is only injected when the query matches an EAFC pattern — `buildConversationalScoutInstruction(includeEAFC)` controls this.
- `CALIBRATION_EPOCH_MS` in `dossierCache.ts` invalidates cached dossiers from before the last rating recalibration; bump it when the rating scale changes.
- Shared cards: a current card is the one shared card for `CARD_REFRESH_DAYS` (7) from its evaluation date, prime cards are frozen, and accepted challenges stay personal revisions logged to `dossier_revisions` (3 agreeing people re-rate early). The `enforce_dossier_refresh_window` trigger (`supabase/migrations/`) mirrors `CARD_REFRESH_DAYS`, `CALIBRATION_EPOCH_MS` and `REVISION_CONSENSUS_USERS`, so change them in both places.

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
- Tier bands, canonical positions, club/position normalization and attribute labels live in `constants/ratingTiers.ts` and must match `types.ts` and the synthesis schema.
