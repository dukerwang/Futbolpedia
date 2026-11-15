# Shareable Links: Implementation Plan

**Goal:** Real addresses for cards (`/p/<player>…`) and shared chats (`/c/<code>`), a card page, and link previews drawn on the server, as the spec describes.

**Spec:** `docs/superpowers/specs/2026-11-14-shareable-links-design.md`

**Order:** Tasks 1–6 are server and shared code with offline tests, and can land before any UI. Task 7 is a gate: the owner approves a high-fidelity mockup before Task 8 writes page code. Tasks 11–13 come after the release.

**Rules that apply throughout:** no Gemini calls on any page or image path; every new offline check joins `npm test`; prompt guidance stays descriptive (no names, numbers or sample phrases); use "they" for players in new prose and comments.

---

## Task 1: Addresses (`services/cardPaths.ts`)

**Files:**
- Create: `services/cardPaths.ts`
- Create: `scripts/test-card-paths.ts`
- Modify: `package.json` (`test`)

**Details:**
1. Types:
   - `CardAddress = { player: string; edition: 'default' | 'prime' | 'era' | 'season'; window?: string; date?: string }`
   - `ParsedAddress = { kind: 'card'; address: CardAddress } | { kind: 'chat'; code: string } | null`
2. `parsePath(pathname)`: accepts `/p/<player>`, `/p/<player>/prime`, `/p/<player>/era/<YYYY-YY>`, `/p/<player>/season/<YYYY-YY>`, `/p/<player>/<YYYY-MM-DD>` and `/c/<code>`. Trailing slashes and case in the player slug are tolerated. Anything else returns null.
3. `cardPath(profile)`: the canonical address of a card, by edition. Current form goes to `/p/<base>`, and so does a prime when it's the player's default. Pass the default decision in, not computed here, so this stays pure: `cardPath(profile, { isDefault })`. Season and era cards use `version.seasonOrEra`. `datedCardPath(profile)` gives `/p/<base>/<evaluationDate>`.
4. `legacyHashToPath(hash)`: maps `#/p/<slug>` to a path. A versioned slug (`<base>--<edition>--<moment>`) maps by edition; a pointer slug (`<base>` or `prime-<base>`) maps to `/p/<base>` or `/p/<base>/prime`. `#/c/<code>` maps to `/c/<code>`.
5. `pickDefaultCard({ current, prime }, now)`: the 90-day rule from the spec. Takes `now` so tests can fix it.
6. Pointer slugs come from `toDossierCardSlug` and archive slugs from `toVersionedSlug`; don't build slug strings by hand.

**Tests** (`test-card-paths.ts`): every address form round-trips; malformed paths return null; legacy hashes for each edition; the 90-day rule (fresh current, stale current with a prime, stale current without a prime, prime only).

---

## Task 2: `shareLine` on new cards

**Files:**
- Modify: `types.ts` (`PlayerProfile.shareLine?: string`)
- Modify: `services/dossierSynthesizer.ts` (schema property, not in `required`; `sanitizeProfileData` trims it and drops it when empty or over 140 characters)
- Modify: `prompts/dossierPrompt.ts` (one descriptive line on what `shareLine` is for)
- Modify: `scripts/test-dossier-cards.ts` (sanitizer cases)

**Details:**
1. Schema description: one sentence, at most 140 characters, stating what the card concludes about the player at this version. The prompt line says it's read on its own as a link preview, so it must make sense without the card and must not quote numbers.
2. `sanitizeProfileData`: strip surrounding quotes, collapse whitespace, drop the field when over 140 characters (don't truncate mid-sentence).
3. Check that `buildHistoryContents` and the chat serializers ignore the field, so chat prompts don't grow.

**Tests:** a valid line passes; an empty, quoted or over-long line is cleaned or dropped; a card without the field still validates.

---

## Task 3: Page resolution (`services/sharePages.ts`)

**Files:**
- Create: `services/sharePages.ts`
- Create: `scripts/test-share-pages.ts`
- Modify: `package.json` (`test`)

**Details:**
1. `resolveCardPage(address, deps)` returns `{ kind: 'card'; card; history; canonical; banner? } | { kind: 'redirect'; to } | { kind: 'not_found'; name }`. `deps` holds the reads, so tests fake them:
   - Pointers: `getCachedDossier(slug, false)` for `toDossierCardSlug(name)` and `toDossierCardSlug(name, true)`.
   - Era and season cards: `getCachedEraCard` and `getCachedSeasonCard`.
   - Dated cards and history: `fetchPriorDossiersForPlayer` (already drops superseded primes and revisions). For a dated address, look up the archive slug directly so a superseded prime still opens.
   - Aliases: `fetchCardIndex`.
2. Rules:
   - Default address: `pickDefaultCard`.
   - A dated address whose prime was superseded gets `banner: { kind: 'superseded_prime', to }`.
   - An active player's prime gets `banner: { kind: 'active_prime', currentPath }` when a current card exists inside 90 days.
   - A name with no pointer is matched in the card index by `toBasePlayerSlug` of each card's name; a match redirects to its canonical address.
   - A non-canonical spelling of a canonical address (case, trailing slash) redirects.
3. `history`: same edition only, newest first, each `{ date, overall, path }`.
4. `resolveChatPage(code, deps)`: through `getSharedConversation`; returns the conversation, its opening user message, reply count and up to four cards it discusses (the `dossierKey` stubs resolved against `allProfiles`), or `not_found`.
5. A five-minute in-memory cache keyed by the normalized address, bounded to a few thousand entries. Failures are not cached.
6. Never throws: a read failure resolves to `{ kind: 'unavailable' }`, which the server treats as "send the default page".

**Tests:** with Supabase faked in memory, as in `scripts/test-dossier-cache-hit.ts`: each address form; the 90-day rule end to end; alias redirect; superseded prime banner; active-player prime banner; not found; a read that throws gives `unavailable`; chat resolution with and without cards.

---

## Task 4: Page tags (`services/shareMeta.ts`, `index.html`)

**Files:**
- Create: `services/shareMeta.ts`
- Create: `scripts/test-share-meta.ts`
- Modify: `index.html` (wrap the default title, description, canonical and Open Graph tags in `<!-- share-meta:start -->` and `<!-- share-meta:end -->`)
- Modify: `package.json` (`test`)

**Details:**
1. `cardMeta(page, origin)` and `chatMeta(page, origin)` return the tag block as a string:
   - `<title>`, `description`, `canonical`
   - `og:type`, `og:url`, `og:title`, `og:description`, `og:image` with width and height, `og:site_name`
   - `twitter:card` set to `summary_large_image`
2. Titles follow the spec ("Bukayo Saka · 90 · Current form"; the chat's title). The description is `shareLine` or the opening question. When neither exists, use the edition and archetype for a card, and the title for a chat.
3. `injectMeta(html, block)` replaces the marked region. If the markers are missing, it returns the HTML unchanged and logs once.
4. Escape every value with one `escapeHtml` helper (`& < > " '`).
5. `origin` comes from the request's host, so futbolpedia.org and futbolpedia.ai.studio each point at themselves. The canonical address always uses `https://futbolpedia.org`.
6. A not-found page gets a `noindex` robots tag.

**Tests:** tags for a card with and without `shareLine`; tags for a chat; a name and a question containing `<script>` and quotes come out escaped; `injectMeta` with and without markers; canonical is always futbolpedia.org.

---

## Task 5: Preview images (`services/shareImage.ts`)

**Files:**
- Create: `services/shareImage.ts`
- Create: `scripts/test-share-image.ts`
- Modify: `package.json` (dependencies `satori`, `@resvg/resvg-wasm`, `@fontsource/playfair-display`, `@fontsource/inter`, `@fontsource/jetbrains-mono`; `test`)

**Details:**
1. Build the element trees with a small `h(type, props, ...children)` helper that returns satori's plain-object nodes, so the server needs no React or TSX.
2. Fonts: load the `.woff` files from the `@fontsource` packages (satori reads TTF, OTF and WOFF, not WOFF2):
   - Playfair Display 700 and 700 italic
   - Inter 400 and 600
   - JetBrains Mono 500

   Resolve the paths with `createRequire(import.meta.url).resolve`, so they work after AI Studio's `npm install`.
3. `@resvg/resvg-wasm`: call `initWasm` once with the wasm file read from the package, guarded by a promise so concurrent requests share it.
4. `renderCardImage(card)` and `renderChatImage(page)` return a PNG `Buffer`, 1200×630, using the layouts in the spec. Take the colours from the app's Tailwind config in `index.html` (cream, charcoal, emerald), not new values.
5. Text limits:
   - Name: shrink the type size for long names, down to a floor, then truncate with an ellipsis.
   - `shareLine`: at most two lines.
   - Strength chips: the first three `traitTitle`s, each truncated past a fixed width.
   - Chat question: at most three lines.
   - Chat card tiles: at most four.
6. `imageVersion(card)` and `chatImageVersion(row)`: an 8-character hash of the fields the spec lists.

**Tests:** both renders return a PNG whose header says 1200×630; a card with no `shareLine`, no strengths and a very long name renders; a chat with no cards renders; render time logged.

**Check before merging:** `npm run build` and a production start (`NODE_ENV=production npm start`) render an image, to confirm the wasm and font paths resolve outside dev.

---

## Task 6: Server routes (`server.ts`)

**Files:**
- Modify: `server.ts`
- Modify: `scripts/test-share-pages.ts` or create `scripts/test-share-server.ts` (in-process requests, as `scripts/test-snapshot-server.ts` does)
- Modify: `.gitignore` if `.cache/og/` isn't already covered by `.cache/`

**Details:**
1. Register before the Vite middleware and the production catch-all:
   - `GET /p/*rest` and `GET /c/:code`: parse with `parsePath`, resolve, then:
     - `card` or `chat`: send the HTML with `injectMeta` and status 200.
     - `redirect`: 301 to the target.
     - `not_found`: the HTML with not-found tags and status 404.
     - `unavailable`: the plain HTML with status 200.
   - The HTML source: in production, read `dist/index.html` once at start. In development, read `index.html` and pass it through `vite.transformIndexHtml(req.originalUrl, html)` so HMR still works. Hoist the Vite server so these routes can reach it.
   - `GET /og/p/:file` and `GET /og/c/:file`: split `<key>-<version>.png`, resolve the card or chat, check the version matches (a stale version redirects to the current one), render, cache, and send with `Content-Type: image/png` and `Cache-Control: public, max-age=31536000, immutable`.
   - `GET /og/default.png`: a fixed Futbolpedia image, rendered once at start or shipped in `public/`.
2. Image cache:
   - Memory: a bounded LRU of a few hundred images.
   - Disk: `.cache/og/<key>-<version>.png`, read before rendering.
   - Renders of the same key are shared while in flight.
   - A render failure redirects (302) to `/og/default.png` and isn't cached.
3. Log one `[share]` line per page and image request: path, result kind, cache hit or render time.

**Tests:** in-process requests for a card page (status, tags present), an alias (301), not found (404 with `noindex`), Supabase failing (200, default tags), an image (PNG, cache headers), and a stale image version (redirect).

---

## Task 7: High-fidelity mockup (gate)

**Files:**
- Create: a mockup screen in the brainstorming companion (`.superpowers/`, not committed)

**Details:**
1. Build the card page in layout B at desktop width and at 375 px, in light and dark themes. Use real shared cards, for example a current card with history, an era card and a retired player's prime, rendered with the app's own type, colours and the look of the side panel's card.
2. Include the side column's starter questions, earlier ratings, Scout button and both banners.
3. Include the not-found page.
4. **Stop and get the owner's approval.** Revise until approved. Task 8 starts only after that.

---

## Task 8: Card page and routing in the app

**Files:**
- Create: `components/CardPage.tsx`
- Create: `services/starterQuestions.ts`, `scripts/test-starter-questions.ts`
- Modify: `components/Header.tsx` (`AppView` gains `'card'`)
- Modify: `App.tsx`
- Modify: `package.json` (`test`)

**Details:**
1. `starterQuestions(card)`: three questions from the card's edition, position and tier. Every phrasing is a template filled by code; there's no model call. Write templates per edition (current form, prime, era, season) that cover comparison with peers at the position, the case for a higher or lower rating, and the player's role. Questions about the present apply only to current cards.
2. `CardPage` props: the resolved page from `sharePages` (reused in the browser through the same resolver with the browser's Supabase client), `onAsk(card, question?)`, `onSave(card)`, `onScout(name?)`, `onNavigate(path)`. It renders:
   - Version chips (blue for eras, as in the Hub).
   - The card: extract `SidePanel`'s header and sections into `components/CardBody.tsx` (a `layout: 'panel' | 'page'` prop for the wider page arrangement), used by both, with "Rated <date>" under the name. `PlayerProfileDisplay` is unused; leave it alone.
   - The banners.
   - The side column: starter questions, a free-text box, earlier ratings and Scout.
   - The not-found state.
3. `App.tsx`:
   - Add a `card` view and a `cardPage` state. On load, read `location.pathname` with `parsePath`, or migrate a legacy hash with `legacyHashToPath`, then `history.replaceState`. This replaces the `#/p/` and `#/c/` branches of `loadSharedProfile`. Keep the `#/scout` and `#/gaffa/` branches.
   - Opening a card from the Hub, a chip, an earlier rating or the side panel calls a `navigate(path)` that does `history.pushState` and sets the view. A `popstate` listener restores the view from the path.
   - The logo and Chat button navigate to `/`.
   - `onAsk`: reuse `handleAskAboutDossier`, in a new conversation. With a starter question, fill the draft with `cardReference(card)` plus the question and send it.
   - `onSave`: add the card to Your dossiers through the existing `addMissingCards` path. Opening a page doesn't save.
   - `/c/<code>`: import the conversation as today, but keep the address. Navigate to `/` when the user sends their first message in it.
4. Share buttons: `SidePanel`, `DossierHub` and `ConversationsPanel` copy addresses built with `cardPath` and `/c/<code>` on `window.location.origin`.

**Tests:** `test-starter-questions.ts`: each edition yields three distinct questions, none mentions the present for a prime, era or season card, and none contains a number. `npm run typecheck`.

---

## Task 9: Gaffa's card links

**Files:**
- Modify: `services/cardLinks.ts` (`CardLink.path`, from `cardPath`)
- Modify: `scripts/test-gaffa-connect.ts` or the existing card-link check (expect `path`)

**Details:**
1. Keep `slug` so current Gaffa builds keep working.

---

## Task 10: Design review, docs and release

**Files:**
- Modify: `CLAUDE.md` (Architecture: the share routes, `cardPaths`, `sharePages`, `shareMeta`, `shareImage`, the card view; Frontend State: paths replace `#/p/` and `#/c/`; the `npm test` list)

**Details:**
1. Run a design review of the built page against the approved mockup:
   - Spacing, type scale, hierarchy, light and dark themes.
   - Screenshots at 375 px and desktop width in the browser pane.
   - Paste-preview checks of the generated images.
   - Fix what it finds.
2. Run `npm run typecheck`, `npm test` and `npm run build`.
3. Open the PR. After merge, remind the owner that the AI Studio pull and publish are still needed.
4. After the owner publishes:
   - `curl` a card address, an alias, a chat and a missing player on futbolpedia.org, and check status and tags.
   - Fetch each image's address and check that it is a 1200×630 PNG.
   - Ask the owner to paste a card link and a chat link into a messaging app.

---

## Task 11: Gaffa follow-up (separate PR in `dukerwang/Gaffa`)

**Files:**
- Modify: `src/lib/integrations/futbolpediaLinks.ts` (`futbolpediaCardUrl` takes a path; use `CardLink.path` when present)
- Modify: `src/lib/integrations/futbolpediaStream.ts` and its test
- Modify: Futbolpedia's `services/gaffaChatApi.ts` (`shareGaffaThread` returns `/c/<code>`); this change ships in Futbolpedia's PR, which Gaffa reads unchanged

---

## Task 12: `shareLine` backfill (separate, needs approval to run)

**Files:**
- Create: `supabase/migrations/<timestamp>_card_share_line.sql` (extend the refresh-window trigger's service-role allowance to `shareLine`, alongside strengths and weaknesses)
- Create: `scripts/backfill-share-lines.ts`, modelled on `scripts/backfill-card-traits.ts`

**Details:**
1. The proposal run reads every shared card without a `shareLine` and writes one per card with a low-thinking call that sees only the card. Output is a JSON report and a Markdown copy, with no Supabase writes.
2. `--apply <report.json>` writes the reviewed lines with `SUPABASE_SECRET_KEY` to every row holding that card, only where the row still lacks a `shareLine`.
3. **Before the proposal run:** count the cards, estimate input and output tokens and cost, and get the owner's go-ahead (`gemini-spend-confirm`). Run a small sample first.

---

## Task 13: Close out

1. Stop the brainstorming companion server.
2. Update the spec's status line to "Shipped" with the PR links.
