# Shareable Links

Futbolpedia 4, sub-project 1 of 4. Approved in brainstorming on 2026-11-14.

## Futbolpedia 4

Futbolpedia 4 is four sub-projects, each with its own spec, plan and release, in this order:

1. **Shareable links** (this spec): real addresses for cards and shared chats, a card page, and link previews.
2. **Accounts and sync**: sign-in, with conversations, Your dossiers and the Gaffa grant synced across devices. It also ties challenges and anything published to a person.
3. **Public pages**: verdict pages first, then other public pages such as player pages and best-ever lists, indexable by search engines. Debates are kept out of Supabase today because the browser writes the debate brief, so a public verdict is either written by the server or published by a signed-in user under their name. Accounts come first for that reason.
4. **All-time XI**: build a side from any era's cards and argue it with the analyst, possibly with a simulated match. Not designed yet.

## Problem

Every Futbolpedia link is a hash route (`#/p/<slug>`, `#/c/<code>`). The part after `#` never reaches the server, so a pasted link can only show the generic Futbolpedia preview in iMessage, WhatsApp or X. Opening a card link drops you into the chat with the card in the side panel, then clears the address bar, so the link can't be passed on. A current-form link also names one dated card, so it goes out of date at the next monthly re-rating.

## Goals

- Every card and shared chat has a readable address that shows a rich preview when pasted anywhere.
- A card link opens a page built around that card, which a newcomer understands without being told.
- A card link always shows the latest card of that version, with earlier ratings one click away.
- Old links, including Gaffa's, keep working.
- Opening a page or drawing a preview never spends Gemini budget.

## Non-goals

Public verdict pages, accounts, a sitemap or other indexing work, and moving `#/scout` or `#/gaffa/…` routes.

## Addresses

| Address | Opens |
|---|---|
| `/p/<player>` | The player's default card: their current-form card if one was rated in the last 90 days, otherwise their prime card, otherwise their current card however old. |
| `/p/<player>/prime` | The player's prime card. |
| `/p/<player>/era/<YYYY-YY>` | The era card for that window. |
| `/p/<player>/season/<YYYY-YY>` | The season card for that season. |
| `/p/<player>/<YYYY-MM-DD>` | One earlier rating of the current form or prime, by evaluation date. Linked from the page's earlier ratings; never the default share link. |
| `/c/<code>` | A shared conversation. |

`<player>` is `toBasePlayerSlug` of the card's name. `/p/<player>` and `/p/<player>/prime` read the existing pointer rows (`toDossierCardSlug`), so they always mean the newest card of that version. Era and season addresses read the archive slugs `getCachedEraCard` and `getCachedSeasonCard` already use.

The 90-day rule picks between current form and prime without a career-status call. A retired player's current card stops being refreshed, so their default address moves to their prime within three months of retiring.

### Rules

- **Re-rated prime.** `/p/<player>/prime` follows the pointer, so it shows the new prime. When the re-rate moved the window, the old card's dated address still opens it, with a banner that links to the current prime. Superseded primes are left out of earlier ratings, as `dropSupersededPrimes` leaves them out of the Hub.
- **Active player's prime.** An active player's default address is their current form. Their prime page, when a prime card exists, says they're still playing and when the prime was rated, with a chip to their current form.
- **Other names.** An address whose name has no pointer is looked up in the card index (`fetchCardIndex`, by the names on each card). A match answers with a permanent redirect to the card's own address; no match is not found.
- **Not found.** A player nobody has rated gets a page that says so, with a button that opens Scout with the name filled in. The server answers it with status 404.

### Old links

The app maps `#/p/<versioned-slug>` to the matching new address and replaces it in the address bar, and `#/c/<code>` to `/c/<code>`. Gaffa's existing links keep working through this.

## Previews

Both images are 1200×630 PNGs in the cream headline style: Futbolpedia's cream background, Playfair Display headings, the emerald accent and JetBrains Mono labels.

**Card.** Top: the Futbolpedia mark and the edition label (`describeCardEdition`, such as "Current form · Nov 2026"). Then the Overall in large emerald type beside the player's name, their archetype (`playstyleAndRole.playstyle.archetype`) in italics, and a line with position, club and tier (`getShortTierLabel`). Then the card's `shareLine` as a quote. Bottom: one row of chips with the strength titles (`traitTitle`): the first three when they fit, otherwise the first two, cut at a word only when one title alone is too long. A card without a `shareLine` leaves the quote out.

**Chat.** Top: the Futbolpedia mark and "Conversation · N replies". The opening question as the headline, the chat's title under it, and a bottom strip with a tile for each card the chat discusses (up to four): Overall, name and edition. A chat with no cards leaves the strip out.

The page's text tags use the same facts: the title is "Bukayo Saka · 90 · Current form" for a card and the chat's title for a chat; the description is the `shareLine` or the opening question.

### `shareLine`

A new optional card field: one sentence of at most 140 characters that says what the card concludes about the player. The synthesis schema asks for it in the same call that writes the card, so new cards pay nothing extra. Its prompt guidance is descriptive, with no names, numbers or sample phrases, following the prompt rules in `CLAUDE.md`. `sanitizeProfileData` drops a value that is empty or too long.

Existing cards get it from a backfill script modelled on `scripts/backfill-card-traits.ts`: a proposal run writes a report, and `--apply` writes reviewed lines through the service role. The refresh-window trigger needs the same allowance it has for strengths and weaknesses. The backfill is a separate step, run only after its Gemini cost is estimated and approved.

## Card page

`components/CardPage.tsx`, opened by the app's new `card` view. On desktop it has two columns; on a phone the side column moves below the card.

- **Main column.** Chips for the player's other versions (current form, prime, eras, seasons; era chips blue, as in the Hub), then the card itself through `PlayerProfileDisplay`, with "Rated <date>" beside the name.
- **Side column.** Ask about <player>: three starter questions and a box to ask your own. Earlier ratings: date and Overall for each earlier card of this edition, from `fetchPriorDossiersForPlayer`, each linking to its dated address. Then a Scout another player button.

Starter questions are written by code from the card's edition, position and tier, with no model call. Clicking one starts a new conversation with the card as a mention (as the Hub's Ask button does, through `cardReference`) and sends the question. **Ask about <player>** and the free-text box do the same but leave sending to you. Opening a page doesn't add the card to Your dossiers; asking about it or pressing **Save** does.

### Design bar

The mockups from brainstorming fix the layout only. Before any page code, a high-fidelity mockup with the real card component, real cards and the app's own tokens goes to the owner for approval. Before release the page gets a design review (spacing, type scale, hierarchy, light and dark themes) and screenshots at 375 px and desktop width.

## Shared chats

`/c/<code>` opens the conversation as `#/c/` does today. The address stays until you send a message of your own, then becomes `/`, since the conversation is now yours.

## Architecture

### Shared

`services/cardPaths.ts` (new, browser and server): parses an address into a lookup (`{ player, edition, window?, date? }` or a chat code), builds a card's address from a `PlayerProfile`, and maps old hash slugs to new addresses. Both sides use it, so they can't disagree about an address.

### Server

- `services/sharePages.ts`: resolves a request to `{ kind: 'card', card, history, canonical }`, `{ kind: 'redirect', to }` or `{ kind: 'not_found' }`, and the same for chats through `getSharedConversation`. It reads through the server's publishable-key client (`useServerSupabase`), under the same row-level security as a browser, and keeps answers in memory for five minutes.
- `services/shareMeta.ts`: builds the title, description, canonical link, Open Graph and Twitter card tags for a resolved page. Every value is HTML-escaped, since names and questions are typed by people.
- `services/shareImage.tsx`: draws the two preview layouts with satori and `@resvg/resvg-wasm`. Playfair Display, Inter and JetBrains Mono (all under the SIL Open Font License) ship in `assets/fonts/`.
- `server.ts`:
  - `/p/*` and `/c/:code` send `index.html` with the page's tags replacing the default block between marker comments. In production the built `index.html` is read once; in development it goes through `vite.transformIndexHtml` first. A redirect answers 301 and not found answers 404.
  - `/og/p/<cardKey>-<version>.png` and `/og/c/<code>-<version>.png` serve the images. `<version>` is a short hash of the card's `rerateAt`, `createdAt` and `latestUpdateAsOf`, or of the chat's row, so a re-rate that keeps the evaluation date still gets a new image. Images are kept in a bounded memory cache and on disk under `.cache/og/`, and sent with `Cache-Control: public, max-age=31536000, immutable`. Each request logs a `[share]` line.

### App

`App` gets a `card` view beside Chat and Dossiers. On load it reads `location.pathname` through `cardPaths.ts` and replaces old hash links. Opening a card from the Hub, a chip or a link uses `history.pushState`, and `popstate` restores the view, so back and refresh work. The logo and Chat return to `/`. The share buttons in `SidePanel`, `DossierHub` and `ConversationsPanel` copy the new addresses.

### Gaffa

`/api/cards/lookup` adds a `path` to each `CardLink` beside `slug`. A small follow-up PR in Gaffa switches `futbolpediaCardUrl` and Continue in Futbolpedia (`shareGaffaThread`'s `path`) to the new addresses; until then the redirects carry them.

## Failure handling

| Failure | Result |
|---|---|
| Supabase unreachable while serving a page | `index.html` with the default tags; the app loads and fetches the card itself. |
| Image render fails | The image address redirects to a fixed `/og/default.png`. |
| Unknown card or chat code | The 404 page, offering Scout for a card. |
| Card has no `shareLine` or strengths | The preview leaves out that part. |

## Testing

Offline checks, added to `npm test`:

- `scripts/test-card-paths.ts`: parsing and building every address form, old hash slugs, the 90-day rule, alias redirects, superseded primes and an active player's prime.
- `scripts/test-share-pages.ts`: resolution with Supabase faked in memory, including not found and a Supabase failure.
- `scripts/test-share-meta.ts`: the tags for a card and a chat, and escaping of names and questions that contain markup.
- `scripts/test-share-image.ts`: both layouts render a 1200×630 PNG with the fonts loaded, and missing `shareLine`, strengths or cards don't throw.

After the AI Studio publish: fetch a few live addresses and check their tags, check that each image loads at 1200×630, and paste a card and a chat link into a messaging app.
