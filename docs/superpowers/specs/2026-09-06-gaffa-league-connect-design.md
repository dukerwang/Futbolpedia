# Gaffa League Connect (Phase 2) — Design Spec

**Date:** 2026-09-06  
**Status:** Approved for implementation planning  
**Depends on:** `docs/superpowers/specs/2026-09-06-gaffa-qa-design.md` (Phase 1 Gaffa Q&A)

## Problem

Phase 1 Gaffa mode can answer rules, strategy, and trade questions with a curated rules snapshot, but it cannot see a manager’s real club. Trade follow-ups still require the user to paste roster context, and answers must caveat unknown budget/standings/XI.

## Goals

1. **Solo-first connect:** paste Gaffa `leagueId` + `teamId` in Futbolpedia; sync live club state into `GaffaContextBag`.
2. **Matchday-useful bag (scope B):** roster, Club Balance, standings, current GW matchup, starting XI / bench.
3. **Clean boundary:** Gaffa exposes a read-only integration route; Futbolpedia Express proxies it (secret never in the browser).
4. **Multi-user-ready shape:** same bag payload later authenticated by a short-lived connect token instead of a shared secret + pasted IDs — without rewriting the chat consumer.
5. **Advise only:** no lineup/trade/bid mutations from Futbolpedia.

## Non-goals (this slice)

- “Sign in with Gaffa” / OAuth / per-user PATs
- Gaffa deep-link “Connect club” button (leave room; do not build)
- Open listings or full league settings overrides (scope C)
- Embedding Futbolpedia chat inside Gaffa
- Direct Futbolpedia → Gaffa Supabase service-role access

## Product decisions

| Decision | Choice |
|---|---|
| Audience | Solo now; API shaped for multi-user later |
| Bag scope | B — roster + balance + standings + matchup + XI/bench |
| Connect UX | Paste league + club IDs in Futbolpedia |
| Architecture | Gaffa read API + Futbolpedia server proxy |
| Writes | None |

## Architecture

```
Futbolpedia UI (paste IDs, Sync)
        │
        ▼
Express GET /api/gaffa/context?leagueId=&teamId=
        │  (adds FUTBOLPEDIA_READ_SECRET server-side)
        ▼
Gaffa GET /api/integrations/futbolpedia/context?leagueId=&teamId=
        │  (admin/peek loaders → bag JSON)
        ▼
localStorage link + in-memory/cached GaffaContextBag
        │
        ▼
sendGaffaMessage(..., { contextBag })  // locked facts when connected: true
```

---

## Section 1 — Gaffa read API

### Route

`GET /api/integrations/futbolpedia/context?leagueId=<uuid>&teamId=<uuid>`

### Auth

- Header: `x-futbolpedia-secret: <FUTBOLPEDIA_READ_SECRET>`
- Dedicated env var (do **not** reuse `CRON_SECRET` for this surface long-term; may temporarily share during local solo bring-up if documented, but ship with its own secret).
- No Supabase user session required on this route.
- 401 on missing/wrong secret; 404 if league/team missing or team not in league.

### Response (bag contract)

Reuse existing peek / club-view loaders; do not invent a second roster model.

```ts
interface FutbolpediaClubContextResponse {
  league_id: string;
  club_id: string; // teams.id
  league_name: string;
  club_name: string;
  budget_eur_m: number; // teams.faab_budget
  roster: Array<{
    player_id: string;
    name: string;
    display_name?: string;
    primary_position: string;
    secondary_positions?: string[];
    status: 'active' | 'bench' | 'ir' | 'taxi' | 'loan_in' | 'loan_out' | 'pending_activation' | string;
  }>;
  standings: {
    rank: number | null;
    played?: number;
    wins: number;
    draws: number;
    losses: number;
    points_for: number;
    points_against?: number;
  };
  matchup: {
    gameweek: number;
    opponent_club_name: string | null;
    status: string; // scheduled | live | completed | …
    your_score?: number | null;
    opponent_score?: number | null;
  } | null;
  lineup: {
    formation?: string | null;
    starters: Array<{ player_id: string; name: string; slot: string }>;
    bench: Array<{ player_id: string; name: string; slot: string }>;
  } | null;
  synced_at: string; // ISO
}
```

### Implementation notes (Gaffa)

- Prefer composing from `SquadPeek` / `loadClubView` / standings view already used by `GET .../clubs/[teamId]/peek`.
- Current GW matchup: resolve the team’s matchup for the league’s current gameweek; null if none.
- Lineup: from matchup lineup JSON or current saved XI — whichever peek/club-view already trusts.
- CORS: not required if only Futbolpedia server calls Gaffa.
- Logging: no roster dumps at info level; secret never logged.

### Forward compatibility

Later connect-token auth returns **this same JSON**. Futbolpedia’s bag mapper should not care how the request was authorized.

---

## Section 2 — Futbolpedia connect + proxy

### Server

- Env: `GAFFA_BASE_URL` (e.g. `https://www.gaffa.live`), `FUTBOLPEDIA_READ_SECRET`
- Route: `GET /api/gaffa/context?leagueId=&teamId=`
  - Forwards to Gaffa integration route with secret header
  - Returns bag JSON to the client (still no secret)
  - Maps upstream errors to clear 401/404/502 messages

### Client connect UI (Gaffa mode)

Visible when Gaffa domain is on (compact strip above or beside composer):

- Inputs: League ID, Club ID
- Actions: **Sync**, **Disconnect**
- Status: disconnected | connected (`club_name` · league) · last synced time · error

### Persistence

`localStorage` key e.g. `futbolpedia-gaffa-link`:

```ts
{
  league_id: string;
  club_id: string;
  league_name?: string;
  club_name?: string;
  last_synced_at?: string;
  // optional cached bag for stale reuse
  bag?: GaffaContextBag;
}
```

### Sync policy

1. **Manual Sync** always fetches fresh.
2. Before a Gaffa `sendGaffaMessage`, if linked and bag missing or older than **10 minutes**, refresh automatically (non-blocking spinner on status; if refresh fails, see stale rule).
3. **Stale rule (locked):** if refresh fails but a cached bag exists and `synced_at` is **&lt; 24 hours**, use it and tell the model (and optionally the UI) the data may be stale. If older than 24h or no cache, run disconnected Phase 1 caveats and surface a sync error.

### Disconnect

Clears link + cached bag; subsequent Gaffa turns use `connected: false`.

---

## Section 3 — Bag → chat

### Types

Tighten Futbolpedia `GaffaContextBag` so `roster`, `standings`, `matchup` (and lineup under matchup or a sibling field) match the Gaffa response — replace Phase 1 `unknown` placeholders.

### Injection

- `App` / Gaffa send path passes `contextBag` into `sendGaffaMessage`.
- `buildGaffaSystemInstruction` / context-bag block already supports `connected: true` locked facts — expand to serialize roster, balance, standings, matchup, XI clearly and compactly (token-aware: prefer tabular/bullet compact form over huge JSON dumps).
- Model rules:
  - Must not contradict locked bag fields (ownership, balance, rank, XI).
  - May still research real-world football for players on or off the roster.
  - Must not claim it executed a trade/lineup change.
- Continuity (`ongoing_thread`) remains; live bag removes “I don’t have your club” when connected.

### Acceptance

1. Paste real league+club IDs → Sync → UI shows club name and balance.
2. Gaffa mode: “who’s on my IR?” / “what’s my budget?” → answers match bag.
3. Trade question without pasted roster → uses bag backups/balance; no false “I don’t know your club.”
4. Wrong secret / bad IDs → clear error; no silent empty connected state.
5. Disconnect → caveats return.
6. Stale refresh failure within 24h → answers still use last bag with stale note.

---

## Repos & ownership

| Change | Repo |
|---|---|
| Integration route + secret check + bag assembly | Gaffa (`Fantasy Futbol`) |
| Express proxy, connect UI, types, `sendGaffaMessage` wiring | Futbolpedia |

Implementation may land as coordinated PRs/commits in both repos; Futbolpedia chat consumer can be developed against a mocked bag until Gaffa route ships.

## Open plan choices (non-blockers)

1. Exact Gaffa loader to reuse (peek route internals vs `loadClubView`).
2. Whether lineup lives on `matchup` or top-level `lineup` in `GaffaContextBag` (spec response includes top-level `lineup`; mapper should be consistent).
3. UI placement: strip above ChatInput vs small modal from a “Club” chip.

## Out of scope reminders

- Listings / settings overrides
- OAuth / deep-link token issuance UI
- Write APIs
