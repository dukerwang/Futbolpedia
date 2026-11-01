# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Today: the owner and one friend, who rate players, compare cards and argue about them. Sessions are often a run of "rate X", "rate Y" with the occasional question. Use is split about evenly between phone (375-430px) and desktop.

Next: anyone who finds futbolpedia.ai.studio. A newcomer has to understand what the product does and how to rate a player without being told.

## Product Purpose

Futbolpedia rates footballers on one all-era standard and lets you talk about those ratings. It has two halves that must work together:

- **Dossier cards**: one version of a player (current form, prime, a named era or a past season) with Overall and Potential, 25 attributes, archetype, strengths and weaknesses. The cards are a large part of what makes the product feel special.
- **Chat**: an analyst you question, push back on and debate with: comparisons, rankings, tactics, challenges to a card.

Success is a growing library of cards that chat can pull in, answer from and argue about, without the user re-asking for the same card.

## Positioning

Ratings are the model's judgment of footballing ability on one all-era scale, placed against a calibrated peer ledger, and each card rates one version of a player rather than a career. One shared card per player version, so everyone argues about the same numbers.

## Operating Context

- Rating a player takes roughly 20-40 seconds when no card exists (grounding, then synthesis). A published card is served in under a second.
- Shared cards live in Supabase. A current card is the shared card for 30 days; prime, era and season cards are frozen.
- A separate Gaffa mode answers fantasy-league questions with its own rules and context.

## Capabilities and Constraints

- React + Express, Gemini models, hosted on Google AI Studio (changes go live after merge, the AI Studio pull script and Publish).
- The system instruction must stay byte-stable for prompt caching.
- Prompts carry no specific examples (player names, sample phrases, rating anchors).
- Undecided: accounts beyond the current local-storage model; how the product introduces itself to a first-time visitor.

## Brand Commitments

- Name: Futbolpedia. The existing editorial look (warm cream and charcoal, serif display and italic serif input, emerald accent, square-cornered panels with thin rules) is the established identity.
- Voice: a scout's dossier: confident, specific, plain.

## Evidence on Hand

Real shared cards in the Supabase `player_profiles` table (about a hundred on the current scale as of 2026-10-31). No testimonials, user counts or press exist; don't invent any.

## Product Principles

1. The card is the unit: everything else creates, opens, compares or questions a card.
2. Rating is a first-class act, never a side effect of phrasing a chat message correctly.
3. Chat and cards share one context: a card you can see is a card chat can use, and the other way round.
4. Never make the user ask twice for something the product already has.
5. Work the same on a phone and a desk.
