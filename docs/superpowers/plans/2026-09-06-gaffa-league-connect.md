# Gaffa League Connect (Phase 2) — Implementation Plan

> **For agentic workers:** Implement task-by-task. Checkboxes track progress. Spec is the source of truth.

**Goal:** Solo-first league/club connect so Futbolpedia Gaffa mode can lock live roster, Club Balance, standings, current matchup, and XI/bench into `GaffaContextBag`. Advise only — no writes.

**Source of truth:** `docs/superpowers/specs/2026-09-06-gaffa-league-connect-design.md`

**Repos:**

| Repo | Path | Role |
|---|---|---|
| Gaffa | `/Users/dukewang/Fantasy Futbol` | Read-only integration route + secret gate |
| Futbolpedia | `/Users/dukewang/Futbolpedia` | Express proxy, connect UI, types, bag → chat |

## Global constraints

- Secret `FUTBOLPEDIA_READ_SECRET` never reaches the browser.
- Integration route is **read-only** (no lineup/trade/bid mutations).
- Bag scope **B only** — no listings / full settings overrides.
- Reuse peek / club loaders; do not invent a second roster model.
- Stale rule: refresh fail + cache &lt; 24h → use cache with stale note; else disconnected caveats.
- Auto-refresh before Gaffa send if bag missing or older than **10 minutes**.
- `npx tsc --noEmit` (Futbolpedia) and Gaffa `npm run build` (or project’s usual typecheck) before done.
- Do not commit `.env` files or real secrets.

## Resolved plan choices

| Choice | Decision |
|---|---|
| Gaffa loader | Extract shared builder from peek route logic (or call shared lib) used by peek + integration |
| Lineup location | Top-level `lineup` on API response; map into `GaffaContextBag.lineup` (add field) + keep `matchup` sibling |
| Connect UI | Compact strip above ChatInput when `domain === 'gaffa'` |
| Secret bring-up | Dedicated `FUTBOLPEDIA_READ_SECRET` on both sides (document in `.env.example`) |

## File structure

### Gaffa

| Path | Action |
|---|---|
| `src/lib/auth/authorizeFutbolpediaRead.ts` | Create — validate `x-futbolpedia-secret` |
| `src/lib/integrations/futbolpediaContext.ts` | Create — build bag from admin queries (factor from peek) |
| `src/lib/integrations/futbolpediaContextTypes.ts` | Create — response contract matching spec |
| `src/app/api/integrations/futbolpedia/context/route.ts` | Create — GET handler |
| `.env.example` | Modify — document `FUTBOLPEDIA_READ_SECRET` |
| Optional: refactor `.../clubs/[teamId]/peek/route.ts` | Modify — call shared builder to avoid drift |

### Futbolpedia

| Path | Action |
|---|---|
| `types.ts` | Modify — concrete bag field types + `lineup` |
| `server.ts` | Modify — `GET /api/gaffa/context` proxy |
| `services/gaffaContext.ts` | Create — fetch/cache helpers, stale policy, localStorage link |
| `constants/gaffaRules.ts` | Modify — serialize connected bag compactly |
| `services/gaffaChatService.ts` | Modify — accept/use live bag (already has `contextBag` param) |
| `components/GaffaConnectStrip.tsx` | Create — IDs, Sync, status, Disconnect |
| `components/ChatInput.tsx` / `App.tsx` | Modify — mount strip; pass bag into `sendGaffaMessage` |
| `.env.example` or README note | Document `GAFFA_BASE_URL`, `FUTBOLPEDIA_READ_SECRET` |
| `AGENTS.md` / `CLAUDE.md` | Light note on Phase 2 connect |

---

## Task 1: Gaffa — auth helper + response types

**Repo:** Gaffa

- [ ] Add `authorizeFutbolpediaRead(req)` — true iff `x-futbolpedia-secret` === `process.env.FUTBOLPEDIA_READ_SECRET` (non-empty).
- [ ] Add `FutbolpediaClubContextResponse` types per spec §1 (roster, standings, matchup, lineup, names, budget, synced_at).
- [ ] Document env in `.env.example`.

**Done when:** Helper unit-smokeable; types exported for the route.

---

## Task 2: Gaffa — context builder + route

**Repo:** Gaffa  
**Reuse:** `/Users/dukewang/Fantasy Futbol/src/app/api/leagues/[leagueId]/clubs/[teamId]/peek/route.ts` and `squadPeekTypes.ts`

- [ ] Implement `buildFutbolpediaClubContext(leagueId, teamId): Promise<FutbolpediaClubContextResponse | null>` using admin client:
  - Validate team belongs to league
  - Roster entries + player names/positions/status
  - `faab_budget` → `budget_eur_m`
  - Standing row (rank, W/D/L, PF)
  - Current GW matchup for this team (opponent name, scores/status) — null if none
  - Lineup: formation + starters/bench from same source peek uses (`LINEUP_VISIBILITY` behavior OK to mirror)
- [ ] Map peek fantasy points/ppg **out** of the Futbolpedia bag (scoring firewall — do not feed FP as locked football quality). Include identity/status/positions/balance/standings/matchup/XI only.
- [ ] `GET /api/integrations/futbolpedia/context` — secret gate → builder → JSON; 401/404 as spec.
- [ ] Prefer factoring peek to call the same underlying load so peek and integration cannot drift (if refactor is large, duplicate queries once with a TODO — prefer shared builder).

**Done when:** `curl` with secret + real ids returns bag; wrong secret → 401.

---

## Task 3: Futbolpedia — types + Express proxy

**Repo:** Futbolpedia

- [ ] Replace `unknown` bag fields with concrete types aligned to Gaffa response; add `lineup?`, `league_name?`, `club_name?`.
- [ ] `GET /api/gaffa/context?leagueId=&teamId=` in `server.ts`:
  - Require env `GAFFA_BASE_URL`, `FUTBOLPEDIA_READ_SECRET`
  - Proxy to Gaffa integration URL with secret header
  - Map 401/404/502 cleanly
- [ ] Do not expose secret in responses or client bundles.

**Done when:** Local Express proxy returns bag when Gaffa is up.

---

## Task 4: Futbolpedia — link storage + sync helpers

**Repo:** Futbolpedia — `services/gaffaContext.ts`

- [ ] `GAFFA_LINK_KEY` localStorage schema per spec.
- [ ] `loadGaffaLink` / `saveGaffaLink` / `clearGaffaLink`.
- [ ] `fetchGaffaContext(leagueId, teamId)` → `GET /api/gaffa/context`.
- [ ] `resolveContextBagForSend(link)`:
  - If no link → `emptyGaffaContextBag()`
  - If bag fresh (&lt; 10 min) → use it (`connected: true`)
  - Else try refresh; on failure use cache if &lt; 24h with stale flag; else disconnected
- [ ] Map API JSON → `GaffaContextBag` including `gaffa_rules_version` from constants.

**Done when:** Helpers work in isolation (manual or tiny script).

---

## Task 5: Compact bag serialization + chat wiring

**Repo:** Futbolpedia

- [ ] Update `buildContextBagBlock` / connected branch in `constants/gaffaRules.ts` to print a **compact** locked roster (name, pos, status), balance, standings line, matchup line, XI/bench — not a huge JSON blob.
- [ ] Note stale when applicable (“data synced_at … may be stale”).
- [ ] `App.tsx`: before `sendGaffaMessage`, `resolveContextBagForSend` and pass `contextBag`.
- [ ] Keep continuity + Phase 1 rules path unchanged when disconnected.

**Done when:** Connected send includes locked facts; disconnect restores caveats.

---

## Task 6: Connect UI strip

**Repo:** Futbolpedia — `components/GaffaConnectStrip.tsx`

- [ ] Show only when Gaffa domain is on.
- [ ] League ID + Club ID inputs, Sync, Disconnect.
- [ ] Status: club name, budget if known, last synced, errors.
- [ ] Wire into `App` above `ChatInput`.
- [ ] Persist successful sync to localStorage.

**Done when:** Paste ids → Sync → status shows club; Disconnect clears.

---

## Task 7: Docs + acceptance

- [ ] Update Futbolpedia `AGENTS.md` / `CLAUDE.md` with Phase 2 env vars + connect flow.
- [ ] Optional one-liner in Gaffa `AGENTS.md` / `.env.example` for the integration route.
- [ ] Manual acceptance from spec §3:
  1. Sync real club
  2. “What’s my budget?” / “Who’s on IR?” matches bag
  3. Trade Q uses bag without pasted roster
  4. Bad secret/ids → clear error
  5. Disconnect → caveats
  6. Stale path (optional: kill Gaffa mid-session with warm cache)
- [ ] Typecheck/build both repos.

---

## Execution order

1 → 2 (Gaffa) → 3 → 4 → 5 → 6 → 7 (Futbolpedia).  
Futbolpedia Tasks 3–4 can use a **mocked bag fixture** if Gaffa route is not deployed yet; swap to live proxy when Task 2 is up.

## Out of scope

- OAuth / deep-link tokens
- Listings / settings overrides
- Write APIs
- Pushing this commit’s secrets
