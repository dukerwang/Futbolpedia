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
- `/api/history/club-season`, `/api/history/player` — past seasons and careers from Wikipedia and ESPN's archive (`services/historyFootball.ts`), kept for good on the server
- `/api/snapshots/club/research`, `/api/snapshots/club`, `/api/snapshots/era` — shared club and era snapshots, built on the server and stored with the server-only `SUPABASE_SECRET_KEY` (`services/snapshotServer.ts`); browsers can read `club_snapshots` and `era_snapshots` but not write them

### Chat research (`services/researchAgent.ts`)
A chat turn about live facts (never one about primes and past seasons) runs inside a time budget. It plans its research in a brief at low thinking (what's distinctive or changed this season, lookups tagged facts or analysis), runs the facts first and the analysis searches against them, reads each club's shared daily snapshot (`services/clubSnapshots.ts`, Supabase `club_snapshots`), then runs reflect (discards earlier-season sources, may add a round) alongside the situation snapshot (`services/situationSnapshot.ts`: first-choice XI, absences, form, what changed). The writer argues from `<situation_snapshot>`. `CLAUDE.md` has the full description.

A chat turn about primes and past seasons goes through `services/debateBrief.ts` instead: a debate brief (criteria, versions, counter-case, a committed verdict or order), checked against the stored cards' ratings and peer placements in code (`services/debateConsistency.ts`), the season and career records it needs, permanent era snapshots (`services/eraSnapshots.ts`, Supabase `era_snapshots`, built on the server), and settled debates kept for the browser session.
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

### Gaffa club in chat (`services/gaffaTurn.ts`)
A Gaffa club is context on a native conversation, not a separate mode. **Connect with Gaffa** (`services/gaffaConnect.ts`): the composer's Gaffa chip opens Gaffa's `/connect/futbolpedia` in a popup (opened inside the click, before anything is awaited, or browsers block it); the signed-in manager presses Allow and Gaffa posts a one-time code back to this origin, or, with no opener, redirects to `#/gaffa/connected?code&state`. The browser checks the state against the attempt it started and exchanges code and PKCE verifier through `POST /api/gaffa/connect/token` for a read-only `fpg_` grant token, kept in localStorage (`futbolpedia-gaffa-grant`). `/api/gaffa/clubs`, `/api/gaffa/context` and `DELETE /api/gaffa/connect/grant` forward that token to Gaffa (`services/gaffaGrantProxy.ts`) and never attach the shared secret, so a browser reads only the manager's own clubs. A 401 forgets the grant.

The chip lists every club grouped by league; the picked one is stored on the conversation (`Conversation.gaffaClub`), and a new conversation takes the last one used. `services/gaffaContext.ts` caches each club's `GaffaContextBag` and rereads it when it's over ten minutes old. An empty conversation with a club shows `GaffaClubWelcome` (the club line and three questions from the bag). `#/gaffa/<leagueId>/<clubId>[?q=]` from Gaffa opens a new conversation with that club once it's confirmed as one of the manager's, with the question in the box.

Each turn, `runConversationalScout` gets the bag (`gaffaBag`), except on a thread about the past. `leagueFocusOf` reads what the question asks about the club (`none`, `squad`, `lineup`, `market`, `trade`, `rules`; a short follow-up keeps the last question's focus), and `buildGaffaTurn` adds `<gaffa_club>` (club, table, matchup, Club Balance, squad) to every turn, plus `GAFFA_RULES_SNAPSHOT` for rules, lineup, market and trade, the lineup audit for squad and lineup, `<locked_market>` and the bid math for market and trade, and the trade scorecard (one model call, shown above the reply) for trade. A squad or lineup question also researches the PL clubs most starters play for. The block joins the figure gate's evidence, the writer gets `grep_gaffa_market`, and squad and market names are copied exactly (`lockGaffaRosterNames`). A club in a shared conversation that isn't one of the manager's is dropped.

`services/gaffaChatService.ts` (`sendGaffaMessage`) still answers Gaffa's own in-app chat through `/api/gaffa/chat` until that moves onto `sendMessageToAI` (phase 3 of `docs/superpowers/specs/2026-11-13-gaffa-integration-rework-design.md`).

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
