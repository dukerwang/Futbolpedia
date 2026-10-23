# Gaffa Auth Login & Club Selection — Design Spec

**Date:** 2026-10-23  
**Status:** Approved  
**Depends on:** `docs/superpowers/specs/2026-09-06-gaffa-league-connect-design.md`

## Problem

Previously, connecting a Gaffa club in Futbolpedia required manually locating and pasting raw `leagueId` and `clubId` UUIDs into the Gaffa Connect Strip (`components/GaffaConnectStrip.tsx`), and relied exclusively on the server-side `/api/gaffa/context` proxy (`GAFFA_BASE_URL` + `FUTBOLPEDIA_READ_SECRET`). Managers with one or multiple clubs across leagues could not sign in with their Gaffa credentials or switch clubs from a dropdown selector.

## Goals

1. **Direct Gaffa Auth:** Allow managers to sign in to Gaffa from the Gaffa Connect Strip using Email + Password or Google OAuth against the Gaffa Supabase project (`hnkavimrsbytsesdzwvj`), isolated under its own storage key (`futbolpedia-gaffa-auth`).
2. **Automatic Club Discovery & Switcher:** Query the signed-in manager's clubs (`public.teams` joined with `public.leagues`), auto-connect their primary or last-used club, and render a club switcher dropdown when multiple clubs exist.
3. **Direct Authenticated Bag Assembly + Proxy Fallback:** When signed in, assemble `GaffaClubContextResponse` directly from Gaffa's RLS-protected Supabase tables (`leagues`, `teams`, `roster_entries`, `players`, `matchups`, `player_sale_listings`, `auction_state`) so Gaffa mode works in AI Studio, local dev, and production even without `FUTBOLPEDIA_READ_SECRET`. Retain the `/api/gaffa/context` proxy and manual League/Club ID inputs as a toggleable fallback.

## Architecture

### 1. `services/gaffaAuth.ts`

- Instantiates a dedicated Supabase client (`gaffaSupabase`) using `window.supabase.createClient(GAFFA_SUPABASE_URL, GAFFA_SUPABASE_PUBLISHABLE_KEY, { auth: { storageKey: 'futbolpedia-gaffa-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })`.
- Auth operations:
  - `getGaffaSession()` / `onGaffaAuthStateChange(cb)`
  - `signInGaffaWithPassword(email, password)`
  - `signInGaffaWithGoogle()`
  - `signOutGaffa()`
- Club discovery:
  - `fetchMyGaffaClubs(userId)` queries `teams` (`user_id = userId`) joined with `leagues(id, name, season, current_season, status)` and returns `GaffaUserClub[]`.
- Direct RLS context loader:
  - `fetchGaffaContextFromSupabase(leagueId, clubId)` queries league settings, all teams in the league, all roster entries in the league, active Premier League players, league matchups, open transfer listings (`status = 'pending'`), and live auctions (`status = 'live'`) in parallel, then returns a `GaffaClubContextResponse` matching the exact schema expected by `mapResponseToBag`.

### 2. `services/gaffaContext.ts`

- `fetchGaffaContext(leagueId, teamId)` checks if an active Gaffa Supabase session exists (`hasActiveGaffaSession()`). If signed in, it calls `fetchGaffaContextFromSupabase(leagueId, teamId)` first (with fallback to `/api/gaffa/context`). If not signed in, it calls `/api/gaffa/context`.

### 3. `components/GaffaConnectStrip.tsx` & `App.tsx`

- `App.tsx` subscribes to Gaffa auth state on mount, loads `gaffaClubs` for the authenticated user, and auto-syncs the saved club (if it belongs to the user) or the user's primary club.
- `GaffaConnectStrip.tsx` supports:
  - **Signed-out state:** Email + password sign-in form, Google OAuth button, and a **Manual IDs** toggle that reveals the existing `League ID` and `Club ID` inputs.
  - **Signed-in state:** User email badge, club switcher `<select>` dropdown for all managed clubs (`Club Name · League Name`), **Refresh**, **Manual IDs** toggle, and **Sign out**.
