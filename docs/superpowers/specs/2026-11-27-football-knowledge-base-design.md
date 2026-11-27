# Football knowledge base

Futbolpedia should combine three roles: an eye-test scout, a data-driven analyst and an
encyclopedia that knows the game's history. Each role currently leans on something it doesn't own.
The encyclopedia leans on the model's training memory and on Wikipedia, fetched on demand. The
analyst has goals, appearances and, for the Premier League only, FPL minutes. The scout sees only
the prose a few searches return. Past players therefore arrive with decades of settled consensus,
while current players are judged on thin evidence gathered on the spot. That asymmetry is one
reason current-form cards run low against primes.

This design adds a store of facts about players, clubs and seasons that the app builds as people
use it, and exposes it to the model as tools.

## Principles

- **Tools, not prompt blocks.** Every layer is reached through a tool the model chooses to call,
  in the chat loop and, later, in an agentic rater. No master prompt pushes a block of records
  into every turn. Each tool's declaration says what it returns and what it doesn't cover; the
  prompt describes the tools and never scripts their order. Code enforces only budgets, schemas
  and the gates. Existing code-pushed blocks (the past turn's first-message records,
  `MAX_FIRST_RECORDS`) are candidates to become tool calls once the tools exist and an eval shows
  the model reaches for them.
- **Facts, never judgments.** The store holds sourced, dated facts. Ratings, verdicts and reviews
  stay in their own tables and never flow back into the store. A model that reads its own past
  opinions as evidence anchors on itself, so no model-written summary is stored as a fact.
- **Provenance on every field.** Each figure carries its source and the date it was read. When
  sources disagree, both are kept and the conflict is recorded; nothing is overwritten silently.
- **Completed seasons freeze.** A finished season's rows are kept for good, like era snapshots.
  The season in progress updates from the live feeds.
- **Demand-driven scope.** The store grows from what people ask about, not from a crawl. A tool
  that misses reads through to the source, stores what it read, and returns it.
- **No model calls for facts.** Identity, records, timelines and team strength are parsed by
  code. Tests fake every source, as the rest of the app's tests do.

## Scope

Top-level men's football: the leagues in `LIVE_LEAGUES` (`services/liveFootball.ts`) and the
European club competitions. Match-level rows cover the current season and the two before it;
earlier seasons are kept at season level from Wikipedia. Players in scope: everyone with a card,
everyone in the squad of a club with a stored snapshot, and anyone a tool resolves on demand.

## Feasibility (checked 2026-11-27)

| Source | Status | Use |
|---|---|---|
| Wikidata SPARQL | Reachable, about 1 s a query, CC0 | Identity, disambiguation, club spells by year, external IDs |
| ESPN site API (already used) | Reachable, keyless, unofficial | Per-match box scores for every league in scope |
| FPL feed (already used) | Reachable, Premier League only | Minutes, expected goals and assists, availability |
| Wikipedia (already used) | Reachable | Season-by-season appearances and goals, honours |
| Club Elo | Site answers; `api.clubelo.com` timed out twice | Team strength across eras, if the API comes back |
| FBref | Refuses scripted requests; lost its Opta advanced data on 2026-01-20 | None |
| Understat | Served a page with no data to a scripted request; no documented API | None |
| StatsBomb open data | Free event data for selected past competitions; licence unchecked | Later, historical calibration only |

What each source gives:

- **Wikidata** splits players who share a name by birth date. A query for "Nuno Mendes" returns
  the PSG left-back (born 2002) and a midfielder born in 1978, each with their own ID. It maps a
  player to his ESPN, FBref, Transfermarkt, Sofascore and UEFA IDs, so one ID joins every
  source. Its appearance counts are stale, so it is never a source for statistics.
- **ESPN's match summary** (`/apis/site/v2/sports/soccer/<league>/summary?event=<id>`) gives
  each player's appearance, substitute flag, goals, assists, shots, shots on target, fouls
  committed and suffered, offsides, cards, saves and goals against, along with `keyEvents`
  (substitutions, so minutes can be derived), formation slots and commentary. It covers every
  league in scope, not only the Premier League. How far back the box scores go is unverified.
- **Advanced per-90 data** (progression, defensive actions, expected goals) beyond the Premier
  League has no free source the app may use. The analyst works from box scores, FPL and team
  strength, and the observations layer covers what box scores miss.

## Layers

### 1. Identity

Table `kb_entities`: Wikidata ID as the key; kind (player, club, competition); names and
aliases; birth date, nationality and positions; external IDs (ESPN, FPL, Transfermarkt,
Wikipedia article). Resolution takes a name and optional hints (club, birth year, era) and returns
one entity or, when it's ambiguous, the candidates. It never guesses. It replaces the grounded
search in `getPlayerIdentity` for any player Wikidata covers, keeping that search as the
fallback, which saves a grounded call on most new cards.

### 2. Facts

- `kb_appearances`: one row per player and match (ESPN match ID, date, club, competition, slot,
  derived minutes, the box-score stats).
- `kb_player_seasons`: one row per player, season, club and competition, aggregated by code from
  appearances where they exist and read from Wikipedia otherwise. Each field carries its source
  and date; `frozen` once the season ends.
- `kb_conflicts`: the field, both values, both sources and the date.

The hourly sweep the server already runs adds the appearances of finished matches for clubs in
scope. A 12-month window, per-90 figures and percentiles against players at the same position in
the same league are computed by code from appearances.

### 3. Timeline

`kb_events`: dated, sourced events, such as transfers and loans (Wikidata spells, the live
feeds), injuries with FPL's dated notes, coach changes (`club_managers`) and awards. This makes
"what changed" and "the last 12 months" lookups instead of fresh searches.

### 4. Team strength

`kb_team_strength`: club, date, rating, source. Club Elo when its API answers. Otherwise, a rating
computed by code from ESPN results, which go back to 2003-04. Strength lets the analyst say what
level a player faced and lets a 1999 side and a 2026 side be compared on more than reputation.

### 5. Observations (later)

The eye test, kept as cited claims about a player (pressing, 1v1 defending, progression), each
with source, publisher and date. A grounded search returns the model's answer with source links,
not the sources' own text, so a stored claim would be a model paraphrase. That's exactly the
judgment this design keeps out. Observations wait for a fetch-and-quote path: the server fetches
the cited page and stores only text that appears in it verbatim, with the model limited to
choosing and tagging excerpts.

## Tools

The tools join the chat loop's declarations (`CHAT_DECLARATIONS`, `services/chatTurn.ts`) and, in
phase 4, the rater's. Results are filed in the evidence ledger, so the figure gate counts their
figures as supported. Each read is free of model calls, so it takes the loop's local-tool rate
rather than a lookup from the budget, the same way card reads do.

- `who_is(name, hint?)`: the entity, or the candidates when the name is ambiguous.
- `player_record(player, from?, to?, competition?)`: seasons, or a window's totals and per-90
  figures, each figure with its source.
- `player_timeline(player, from?, to?)`: dated events.
- `position_percentiles(player, window?, metrics?)`: where his box-score figures sit among
  players at his position in his league, computed by code.
- `team_strength(club, date or season)`.
- Later, `observations(player, topic?)`.

## Agentic rater (phase 4)

Card synthesis today is a fixed pipeline with no tools: code gathers the evidence, then one
schema call writes the card. In phase 4 the rater becomes a loop like the chat loop: the knowledge
base tools, `peer_cards(position, near)` for the closest peers on demand, `read_card`,
`web_search`, a stated budget, and a `submit_card` tool whose argument is the card schema,
checked by the same code invariants (tier band, peer placement, version rules, the trait check).
It supersedes the evidence code wires in today, including the 12-month window's career call; the
window rule itself stays. It needs its own eval-key check before it becomes the way cards are
rated.

## Phases

1. **Identity.** `kb_entities`, Wikidata resolution and the crosswalk, `who_is` in the chat loop.
   Wiring into card naming waits until the current-form window PR merges, since both touch
   `services/groundingService.ts`.
2. **Appearances and player seasons.** ESPN box scores in the sweep, Wikipedia for earlier
   seasons, `player_record` and `position_percentiles`.
3. **Timeline and team strength.** `player_timeline`, `team_strength`. Retry Club Elo first.
4. **Agentic rater.**
5. **Observations,** after a fetch-and-quote path exists.

## Risks

- ESPN's API is unofficial and can change without notice; parse defensively, and log and skip
  anything unexpected, as `services/liveFootball.ts` does.
- Wikidata asks clients to name themselves in the User-Agent and limits query time; send one
  query per resolution and cache results.
- Identity errors spread to every layer. A low-confidence match returns candidates, and the
  conflicts table catches facts that don't fit.
- Size: about 80,000 appearance rows a season across the leagues in scope, which is small for
  Supabase.
