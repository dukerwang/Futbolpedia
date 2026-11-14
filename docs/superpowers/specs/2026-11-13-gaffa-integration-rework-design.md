# Gaffa Integration Rework — Design Spec

**Date:** 2026-11-13
**Status:** Draft, awaiting review
**Repos:** Futbolpedia (`dukerwang/Futbolpedia`) and Gaffa (`dukerwang/Fantasy Futbol`, local `~/Fantasy Futbol`)
**Supersedes:** `2026-10-23-gaffa-auth-club-selector-design.md` (sign-in, club selector, RLS bag assembly, manual IDs)

## Problem

The integration has two halves, and both fall short.

**Futbolpedia inside Gaffa is a weaker product than Futbolpedia.** Gaffa's chat panel (`FutbolpediaChatPanel.tsx`) posts to Gaffa's `/api/leagues/[leagueId]/clubs/[teamId]/futbolpedia-chat`, which forwards to Futbolpedia's `POST /api/gaffa/chat`. That runs `sendGaffaMessage` (`services/gaffaChatService.ts`), a separate pipeline that predates the research harness: a regex turn classifier, one grounded web search, and a prose call with local tools only. It never touches the live feeds, club snapshots, the situation snapshot, the research brief, the history routes, the figure gate, card lookup, or the manager gates. It returns one JSON blob after up to 110 s, so the panel shows "Gaffa briefing…" with no streaming, and replies never show a card. The panel is styled as part of Gaffa, so nothing tells a manager that Futbolpedia is its own product or gives them a way into it.

**Gaffa inside Futbolpedia is cluttered and hard to connect.** Gaffa is a separate chat domain behind a composer toggle, with a soft auto-detect nudge (`gaffaDetect.ts`). `GaffaConnectStrip.tsx` (946 lines) holds a password form, a Google button, a Manual IDs form, a club dropdown, standings and matchup pills, alerts, four quick-prompt chips, and an inspector drawer with lineup, squad and market tabs. A club connects in three different ways (sign-in, pasted UUIDs, `#/gaffa/<league>/<club>` deep link), and the club context loads two different ways: `fetchGaffaContextFromSupabase` (about 330 lines in `gaffaAuth.ts` that rebuild Gaffa's context bag from its tables over RLS) and the `/api/gaffa/context` proxy.

**`/api/gaffa/context` is open.** Futbolpedia's server answers any caller who supplies a league and club UUID, attaching `FUTBOLPEDIA_READ_SECRET` itself. Anyone holding two UUIDs can read that club's roster, lineup, budget and standings, and Gaffa's deep links put those UUIDs in URLs.

## Goals

1. One chat pipeline. A Gaffa club is context on a native Futbolpedia conversation, not a separate mode, and Gaffa's panel runs that same pipeline.
2. Sign-in that takes one click for anyone already signed in to Gaffa, whatever method they used there, and loads every league and club automatically.
3. Futbolpedia reads in Gaffa as its own product: its own mark, type and colours, streaming replies, cards, and routes out to futbolpedia.ai.studio from the places in Gaffa where a manager wants to read further.
4. No club context readable without the owner's grant.

## Non-goals

- Writing to Gaffa from Futbolpedia (lineups, bids, trades). The integration stays read-only.
- Futbolpedia user accounts. The Gaffa grant is the only identity Futbolpedia holds.
- Changing Gaffa's outlook engine (`packages/futbolpedia-engine`) or its player outlooks.

## Connect with Gaffa

A grant flow modelled on OAuth's authorization code with PKCE, built on Gaffa's existing session.

### Flow

1. Futbolpedia's **Connect Gaffa** button generates a `code_verifier` and `state`, then opens a popup to `https://www.gaffa.live/connect/futbolpedia?state=…&code_challenge=…&return_origin=<origin>`.
2. Gaffa's `/connect/futbolpedia` page requires a Gaffa session (it redirects to Gaffa's sign-in and back if needed). It names Futbolpedia, lists what it can read (your clubs, squads, lineups, league market and standings; read-only), and offers **Allow** and **Cancel**.
3. On **Allow**, Gaffa stores a one-time code (hashed, five-minute expiry, bound to the user, challenge and origin) and posts `{ type: 'gaffa-connect', code, state }` to `window.opener` with `targetOrigin` set to `return_origin`. `return_origin` must be on an allowlist (`FUTBOLPEDIA_ALLOWED_ORIGINS`: the AI Studio origin, `http://localhost:3000`).
4. Futbolpedia checks `state`, then exchanges the code: `POST https://www.gaffa.live/api/integrations/futbolpedia/token` with `{ code, code_verifier }`. Gaffa returns an opaque grant token. Futbolpedia keeps it in `localStorage` (`futbolpedia-gaffa-grant`).
5. Where a popup is blocked or `window.opener` is lost (mobile Safari opening a tab), the page falls back to a full redirect: `return_origin/#/gaffa/connected?code=…&state=…`, with the verifier kept in `sessionStorage`.

### Gaffa storage

A migration adds two service-role-only tables (RLS on, no policies):

- `futbolpedia_auth_codes`: `code_hash`, `user_id`, `code_challenge`, `return_origin`, `expires_at`, `used_at`.
- `futbolpedia_grants`: `id`, `user_id`, `token_hash`, `created_at`, `last_used_at`, `revoked_at`.

Gaffa's settings page gets a **Connected apps** section listing the Futbolpedia grant with **Revoke**.

### Gaffa endpoints

All take `Authorization: Bearer <grant token>` and resolve the grant to a user:

- `GET /api/integrations/futbolpedia/clubs`: the user's clubs across leagues (`club_id`, `club_name`, `league_id`, `league_name`, `season`, `league_status`, `budget_eur_m`).
- `GET /api/integrations/futbolpedia/context?leagueId&teamId`: the existing `buildFutbolpediaClubContext` bag, only for a club the grant's user owns (403 otherwise).
- `DELETE /api/integrations/futbolpedia/grant`: revokes the calling token (Futbolpedia's **Disconnect**).

The `x-futbolpedia-secret` path stays only for server-to-server calls where Gaffa's server has already checked the session itself (the in-Gaffa chat below).

### Futbolpedia side

`services/gaffaAuth.ts` is rewritten around the grant: `connectGaffa()` (popup and fallback), `listGaffaClubs()`, `fetchGaffaClubContext(leagueId, clubId)`, `disconnectGaffa()`. Browser calls go through Futbolpedia's server (`GET /api/gaffa/clubs`, `GET /api/gaffa/context`), which forwards the bearer token; the server never adds the shared secret to a browser request. A 401 clears the stored grant and shows **Connect Gaffa** again.

Removed: the second Supabase client, password and Google sign-in, `fetchGaffaContextFromSupabase` and its helpers, Manual IDs, and the UUID-only deep link. `#/gaffa/<league>/<club>` stays as a route but only preselects that club when the grant's user owns it; otherwise it opens **Connect Gaffa**.

## Gaffa club in Futbolpedia chat

### Composer

The Futbolpedia/Gaffa toggle, the auto-detect nudge (`gaffaDetect.ts`) and `GaffaConnectStrip.tsx` go. In their place, one chip beside the composer:

- Not connected: **Gaffa** opens a small dialog with **Connect Gaffa** and a line on what it does.
- Connected: the chip shows the attached club (`Club name · League`) or **No club**. Its menu lists every club grouped by league, **No club**, **Open in Gaffa** (the club's roster page), and **Disconnect**.

The attached club is stored on the conversation (`Conversation.gaffaClub: { leagueId, clubId }`), so each conversation keeps its own. A new conversation takes the last club used. Switching clubs mid-conversation applies from the next turn.

### Empty state

When a club is attached and the conversation is empty, the welcome area shows the club line (rank, record, next matchup, balance) and at most three suggested questions drawn from the bag: an XI and auto-sub check when a lineup is saved, the strongest free agent for the weakest slot, and the live auctions when there are any. Alerts from `computeGaffaClubAlerts` appear only as the first of those suggestions, never as a list.

The inspector drawer (lineup, squad and market tabs) is removed. Gaffa already shows those screens; **Open in Gaffa** goes there.

### Pipeline

`sendMessageToAI` takes an optional `gaffa?: { bag: GaffaContextBag }`. Routing, research, the brief, snapshots, cards and gates run as they do today. On top:

- **League context block.** Every turn with a club attached gets a compact `<gaffa_club>` block: club, league, rank, record, matchup, balance, and the squad with positions and PL clubs. The rules snapshot (`GAFFA_RULES_SNAPSHOT`) moves from the system instruction into this block, so the cached system prefix stays byte-stable.
- **League intent.** `classifyTurn` gains `leagueFocus: 'none' | 'squad' | 'lineup' | 'market' | 'trade' | 'rules'` (regex fast paths reusing `classifyGaffaTurn`'s cues, else the Flash classifier). It decides which locked blocks join the turn: `formatLineupAuditPromptBlock` for `lineup`, `buildLockedMarketTurnBlock` and `buildGaffaBidValuationBlock` for `market`, `buildTradeScorecard` for `trade`. A turn with `leagueFocus: 'none'` is ordinary Futbolpedia with the club block as background.
- **Research targets.** The squad's PL clubs join the clubs the turn opens when `leagueFocus` is `squad` or `lineup`, so the situation snapshot and injury lists cover the manager's starters.
- **Name lock.** `lockGaffaRosterNames` runs after the figure gate when a locked block named Gaffa players.
- **Cards.** Players in the squad or market are looked up in the card index like any target player, so the reply can show their cards.

`gaffaChatService.ts` shrinks to the scorecard builder and prompt helpers the pipeline calls; `sendGaffaMessage`, `classifyGaffaTurn`'s routing role, `gatherGaffaFoundation` and the separate system instruction go.

## Futbolpedia in Gaffa

### Server

Futbolpedia's `POST /api/gaffa/chat` keeps the read-secret check (Gaffa's server already verified the session and club ownership) and changes to:

- Run `sendMessageToAI` in-process with the club context, the way `scripts/eval-history.ts` does, including a read-only `window.supabase` stand-in so shared cards, club snapshots and era snapshots are read.
- Stream newline-delimited JSON: `{ type: 'stage', label }`, `{ type: 'text', text }` (accumulated, gate-cleaned, as the browser stream already is), `{ type: 'cards', cards: [{ name, edition, overall, tier, slug }] }`, `{ type: 'scorecard', … }`, `{ type: 'done', prose }`, `{ type: 'error', message }`.
- Take `conversationId` from Gaffa and keep per-thread state per conversation (see Thread state below).
- Limit spend: each Gaffa user gets `GAFFA_CHAT_DAILY_TURNS` (10) turns a day, counted on Futbolpedia's server by the `userId` Gaffa sends and logged with a `[gaffa]` line per turn. Futbolpedia's Gemini key pays for these turns, and the live app shares that budget. The panel shows the turns left once three or fewer remain. At the limit the composer is replaced by **Continue in Futbolpedia**, which carries the thread over; Futbolpedia itself has no limit.

### Thread state

`conversationalScout.ts` keeps four module-level variables: `lastThreadSignature`, `lastThreadGrounding`, `lastThreadSituation` and `lastSituationSignature`. A follow-up whose thread signature matches reuses the previous turn's research (as a `prior_turn` evidence entry) and its situation snapshot. The signature is the first 60 characters of the thread's first message.

In a browser that is one person's state. On Futbolpedia's server it is shared by every Gaffa user. Two managers who open with the same suggested question have the same signature, so the second manager's follow-up would be handed the first manager's research and the first manager's club XI as its situation snapshot. Interleaved turns also overwrite each other, so a manager loses their own prior-turn research.

The fix: the four variables become a `ThreadState` held in a map keyed by conversation ID (at most 500 entries, an hour's TTL, oldest dropped first). `sendMessageToAI` takes `conversationId`; the browser passes its conversation's ID, and the server passes `gaffa:<userId>:<conversationId>`. The signature also includes the attached club's ID, so switching clubs in a conversation starts fresh. This fixes a smaller browser bug too: two conversations in the same tab that open with the same words currently share state.

The other module-level caches (`clubManagers`, `identityCache`, the card index, the calibrated pool, era snapshots, settled debates) hold facts that are the same for every user, so sharing them on the server is intended. An offline check runs two conversations with the same opening message, interleaved, and asserts neither sees the other's research or situation.

A new public, read-only route, `GET /api/cards/lookup?names=a,b,c` (at most 25 names, cached 10 minutes), returns the shared card for each name that has one: `name`, `edition`, `overall`, `tier`, `position`, `slug`. Gaffa uses it to decide where to show Futbolpedia links.

### Panel

Gaffa's route pipes Futbolpedia's stream through unchanged. `FutbolpediaChatPanel` is restyled as Futbolpedia's:

- Futbolpedia's wordmark, serif type and charcoal-and-cream palette inside the panel, set apart from Gaffa's chrome, with a line under the header: "Futbolpedia: football analysis that reads your club."
- Streaming text with stage labels from the stream, replacing "Gaffa briefing…".
- Cards under a reply as compact Futbolpedia chips (name and edition, no Overall or tier) linking to `futbolpedia/#/p/<slug>`. Ratings stay on Futbolpedia for now.
- The trade scorecard keeps its Trade Lock layout in Futbolpedia's style.

### Continue in Futbolpedia

**Continue in Futbolpedia** carries a Gaffa thread into Futbolpedia. Gaffa sends the thread's turns to Futbolpedia's server, which creates a shared conversation (the existing `shared_conversations` table, so anyone with the code can open it) with the club attached, and returns `#/c/<code>`. Futbolpedia opens it as a new local conversation the manager can keep going. It appears:

- In the panel header, once the thread has a reply.
- In place of the composer when the day's turns are used up.
- Under a reply whose question needs more than the panel gives, such as a long comparison or a request to rate someone, as a single link.

### Routes into Futbolpedia

Where there's no thread to carry over, Gaffa links start something new on Futbolpedia instead. A shared `FutbolpediaLink` component (Futbolpedia's mark, opens in a new tab) is used in three ways:

- **Read**: a player's Futbolpedia dossier (`#/p/<slug>`), when `/api/cards/lookup` has a card.
- **Scout**: `#/scout?name=<name>`, a new route that opens the Scout panel with that name queued, when no card exists.
- **Ask**: `#/gaffa/<league>/<club>?q=<question>`, which opens a new Futbolpedia conversation with the club attached (after Connect, if needed) and the question in the message box, unsent.

Placements:

- **Player hub** (`PlayerHub.tsx`) and the scouting block (`PlayerCardScouting.tsx`): Read or Scout, plus Ask ("Should I go after <player>?" when he's on the market, "How is <player> doing?" when he's in your squad).
- **Club roster** (`ClubClient.tsx`): "Ask Futbolpedia about this squad" opens the in-Gaffa panel with a suggested question; "Open in Futbolpedia" is Ask with no question.
- **Auctions, listings and trades**: "Ask Futbolpedia" beside a player or offer opens the in-Gaffa panel with the question filled in.
- **Chat channel list**: the Futbolpedia channel keeps its caption and gains the Futbolpedia mark.

The players index gets no Futbolpedia ratings for now; that waits until current-card ratings are trusted enough to show in Gaffa.

## Removed code

Futbolpedia: `GaffaConnectStrip.tsx`, `gaffaDetect.ts`, the domain toggle and nudge in `ChatInput.tsx`, the Gaffa state and handlers in `App.tsx` that the chip doesn't need, `fetchGaffaContextFromSupabase` and the RLS helpers in `gaffaAuth.ts`, `sendGaffaMessage` and its routing, `resolveContextBagForSend`'s proxy fallback, and the old Gaffa auth spec's Google redirect (`?gaffa_auth=1`).

Gaffa: `futbolpediaConnectUrl.ts`'s UUID-only link becomes the ownership-checked route above; nothing else is removed.

## Phases

Each phase ships on its own and leaves both apps working.

0. **Close the open proxy (Futbolpedia).** Remove the browser-facing `GET /api/gaffa/context` and the fallback to it in `fetchGaffaContext`. Signed-in managers already read their own club over RLS, and `POST /api/gaffa/chat` fetches context server-side without the route. Manual IDs and the UUID deep link stop working for anyone not signed in, which is the point.
1. **Grant flow (Gaffa).** Tables, `/connect/futbolpedia`, token, clubs, context and revoke endpoints, Connected apps in settings.
2. **Connect and club context (Futbolpedia).** Grant client, composer chip, `Conversation.gaffaClub`, `leagueFocus` and the league blocks in the native pipeline; old Gaffa mode removed.
3. **Native chat for Gaffa (Futbolpedia server).** Streaming `/api/gaffa/chat` on `sendMessageToAI`, per-conversation thread state, daily turn budget, `/api/cards/lookup`, share-code creation, `#/scout?name=`.
4. **Futbolpedia branding and routes (Gaffa).** Streaming branded panel, card chips, Continue in Futbolpedia, `FutbolpediaLink` across the player hub, index, roster and market.

## Testing

- Futbolpedia `npm test` gains offline checks: the grant client (popup message, state mismatch, redirect fallback, 401 clears the grant), `leagueFocus` routing and which locked blocks join each focus, the per-conversation thread state (two interleaved conversations don't share grounding), the NDJSON stream from `/api/gaffa/chat` with Gemini faked at fetch, the turn budget, and `/api/cards/lookup`.
- Gaffa vitest: code issue and exchange (expiry, reuse, wrong verifier, origin not on the allowlist), bearer resolution, the ownership check on context, revoke.
- Manual: connect from the AI Studio build and from localhost, popup and redirect paths, switching clubs mid-conversation, and a full Gaffa panel turn in Chrome.

## Decisions

- **Turn budget:** 10 Gaffa turns per user per day; the count shows at three or fewer, and the limit hands off to Futbolpedia.
- **Carry-over:** Continue in Futbolpedia uses a shared conversation that anyone with the code can open. Revisit if threads start carrying anything sensitive.
- **Ratings in Gaffa:** none for now, in the players index or in card chips. Links lead to the dossier on Futbolpedia.
