# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start development server (Express + Vite middleware) on port 3000
npm run build    # Vite production build to /dist
npm start        # Run production server (serves /dist statically)
```

```bash
npm run typecheck   # tsc --noEmit
npm test            # offline checks, feeds and Gemini faked (see package.json for the list)
npm run eval:live   # scores the live question set with a grader model; needs the network and GEMINI_API_KEY
```

## Environment Variables

- `API_KEY` — Google Gemini API key (used by `services/geminiService.ts`)
- `API_FOOTBALL_KEY` — API-Football key (used by `server.ts`; the free plan can't read the current season, so chat research uses the keyless ESPN and Fantasy Premier League feeds behind `/api/live/*`)

Supabase credentials are hardcoded in `geminiService.ts` (publishable key, safe for client exposure). The Supabase JS client is loaded via a `<script>` tag in `index.html` and accessed at `window.supabase`, not via an npm package — see the guard at the top of `geminiService.ts`.

## Architecture

### Server (`server.ts`)
A single Express server handles everything:
- `/api/football/squad` — Backend lookup against API-Football (hides `API_FOOTBALL_KEY` from the client); there is no general pass-through route
- `/api/live/club`, `/api/live/player`, `/api/live/table` — current-season facts from the keyless ESPN and Fantasy Premier League feeds (`services/liveFootball.ts`). Each reports what it couldn't get with a status: `empty`, `not_covered` or `failed`

### Chat research (`services/researchAgent.ts`)
A chat turn about live facts plans its research in a brief (what's distinctive or changed this season, lookups tagged facts or analysis), runs the facts first and the analysis searches against them, reads each club's shared daily snapshot (`services/clubSnapshots.ts`, Supabase `club_snapshots`), then runs reflect (discards earlier-season sources, may add a round) alongside the situation snapshot (`services/situationSnapshot.ts`: first-choice XI, absences, form, what changed). The writer argues from `<situation_snapshot>`. `CLAUDE.md` has the full description.
- In dev: Vite is mounted as Express middleware (`middlewareMode: true`)
- In prod: serves the built `/dist` directory

### AI Pipeline (`services/geminiService.ts`)
The core complexity lives here. There are two chat modes:

**Default mode** (formal profile/comparison requests) runs a 3-stage pipeline:
1. **Query generation** — Flash model generates 4 targeted search vectors as structured JSON
2. **Factual foundation** — Runs those queries in parallel via `googleSearch` tool, captures grounding source URLs
3. **Extraction** — Distills raw search results into a verified fact object (identifies data gaps for Protocol P)
4. **Synthesis** — `synthesizeFormalResponse()` calls `generateContent` with `responseSchema` to guarantee schema-valid JSON. Falls back to `sendChatMessage` if schema enforcement fails.

**Fast mode** skips steps 1–3 and goes straight to the chat model with a compressed prompt.

### Gaffa mode (`services/gaffaChatService.ts`)
Separate chat domain from dossier synthesis. When the ChatInput **Gaffa** toggle is on, `App` routes to `sendGaffaMessage` — prose only, never `responseSchema` dossiers. Rules come from curated `constants/gaffaRules.ts` (`GAFFA_RULES_SNAPSHOT`, versioned). Soft auto-detect in `services/gaffaDetect.ts` nudges switching mode when default chat looks Gaffa-specific; it does not silently inject Gaffa context.

**Phase 2 club connect:** paste league + club IDs in the Gaffa connect strip, or open `#/gaffa/<leagueId>/<clubId>` (Gaffa club page **Ask Futbolpedia**). Express `GET /api/gaffa/context` proxies to Gaffa `GET /api/integrations/futbolpedia/context` with server-only `FUTBOLPEDIA_READ_SECRET` + `GAFFA_BASE_URL`. Live bag fills `GaffaContextBag` for roster/budget/standings/matchup/XI plus listings, live auctions, and league settings.

**Critical quirks:**
- `ThinkingLevel` + `responseSchema` conflict on Gemini Flash — the synthesis step deliberately omits `thinkingConfig` to prevent malformed JSON output. Use `MINIMAL` thinking in any fallback path that parses JSON.
- `SIMULATION_YEAR` / `SIMULATION_SEASON` in `constants.ts` are compile-time constants, not `new Date()`. This is intentional — keeping the system instruction byte-stable enables Gemini's implicit prompt caching.
- The EAFC playstyle directory in `constants.ts` is only injected into the system instruction when the query matches an EAFC-specific pattern. `getMasterInstructions(includeEAFC)` controls this.

### Frontend State
`App.tsx` manages all state via React hooks. Two persistence layers:
- **`localStorage`** — Conversations (`futbolpedia-conversations`), active dossiers (`futbolpedia-global-dossiers`), theme, active conversation ID
- **Supabase** (`profiles` table, `player_data` JSONB column) — Read-only profile sharing via `#/player/<uuid>` URL hash

On init, `App.tsx` runs a migration path: old `futbolpedia-chat-history` / `futbolpedia-all-profiles` keys are consolidated into the newer `futbolpedia-conversations` schema.

### Key Types (`types.ts`)
- `PlayerProfile` — The central data model. Contains `basicInfo`, `ratings` (overall/potential), `attributes` (25 outfield), optional `goalkeeperAttributes`, `strengths`, `weaknesses`, `playstyleAndRole`, `shortBio`, `latestUpdate`.
- `Conversation` — Wraps an array of `ChatMessage` plus the `activeProfile` and `allProfiles` at the time.
- `ChatMessage.content` is a union: `string | PlayerProfile | ReactNode`.

### Prompt Engineering (`constants.ts`)
The `MASTER_INSTRUCTION_SET` is a ~300-line system prompt. Key concepts when modifying it:
- **Protocols A–Q** are named rules the model must follow (B = injury quarantine, E = stat-lock anti-hallucination, M = temporal firewall, P = data gap → set attribute to 0, etc.)
- The **25-attribute schema** and **rating tier scale** (60–99) are defined here and must match `types.ts`
- `CRITICAL_FINAL_CHECKS` (Section X) is appended last and lists the most frequently violated rules — edit this section when the model repeatedly breaks a specific rule
