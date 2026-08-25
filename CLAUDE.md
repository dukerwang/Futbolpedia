# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start development server (Express + Vite middleware) on port 3000
npm run build    # Vite production build to /dist
npm start        # Run production server (serves /dist statically)
```

No test runner is configured. TypeScript type-check: `npx tsc --noEmit`.

## Environment Variables

- `API_KEY` — Google Gemini API key (used by `services/geminiService.ts`)
- `API_FOOTBALL_KEY` — API-Football key (used by `server.ts`)

Supabase credentials are hardcoded in `geminiService.ts` (publishable key, safe for client exposure). The Supabase JS client is loaded via a `<script>` tag in `index.html` and accessed at `window.supabase`, not via an npm package — see the guard at the top of `geminiService.ts`.

## Architecture

### Server (`server.ts`)
A single Express server handles everything:
- `/api/football/squad` and `/api/football/proxy/*` — Backend proxy to API-Football (hides `API_FOOTBALL_KEY` from the client)
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
