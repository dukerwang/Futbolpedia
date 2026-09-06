# Gaffa Q&A in Futbolpedia — Design Spec

**Date:** 2026-09-06  
**Status:** Approved for implementation planning  
**Scope:** Phase 1 (ship) + Phase 2 hooks (design only)

## Problem

Futbolpedia already collaborates with Gaffa via player **outlooks** (`@futbolpedia/engine`). Managers still cannot ask Futbolpedia questions *about* Gaffa — rules, strategy, or trades — inside Futbolpedia chat.

Separately, Futbolpedia’s existing chat already struggles to separate **dossier/rating intent** from **prose Q&A**. Adding Gaffa without a hard intent boundary would make that worse.

## Goals

### Phase 1 (this project)

1. Explicit **Gaffa mode** in Futbolpedia chat.
2. Answers grounded in a curated snapshot of how Gaffa works (from Gaffa’s player guide).
3. Support rules, strategy, and comparative player/trade questions **without** live league/club data.
4. **Never** emit a Futbolpedia dossier card while Gaffa mode is on — prose only.
5. Soft auto-detect that *suggests* switching mode; does not silently inject Gaffa context.

### Phase 2 (later)

Connect to a user’s Gaffa league/club so answers can use live roster, budget, standings, and league setting overrides. Phase 1 must leave a clean context-bag hook for this.

### Non-goals (Phase 1)

- Embedding a Futbolpedia assistant inside the Gaffa app UI.
- Live-fetching rules from Gaffa at runtime.
- Writing to Gaffa (lineups, trades, bids) from Futbolpedia.
- Generating outlook cards or dossier JSON from the Gaffa chat path.
- Full domain-router refactor of EAFC / dossier / Gaffa.

## Product decisions

| Decision | Choice |
|---|---|
| Primary surface | Futbolpedia chat first; Gaffa-app assistant later |
| Intent | Hybrid: explicit Gaffa mode + soft auto-detect nudge |
| Phase 1 answer scope | Rules + strategy + comparative player/trade takes |
| Rules knowledge | Curated snapshot distilled from Gaffa `docs/USER_GUIDE.md` |
| Dossier in Gaffa mode | Disabled — force prose |

## Architecture

### Approach: dedicated Gaffa chat path

Do **not** bolt Gaffa rules onto `MASTER_INSTRUCTION_SET` / formal dossier synthesis (the EAFC inject pattern). Route Gaffa mode to its own handler so intent cannot leak into profile generation.

```
ChatInput (domain: default | gaffa)
    │
    ├─ domain !== gaffa → existing sendMessageToAI (unchanged)
    │
    └─ domain === gaffa → sendGaffaMessage
            │
            ├─ classify turn: rules | strategy | player_trade
            ├─ inject GAFFA_RULES_SNAPSHOT + Gaffa system instruction
            ├─ optional research (search → extract) for player/trade turns
            ├─ optional GaffaContextBag (Phase 1: mostly empty)
            └─ prose Markdown via sendChatMessage (never responseSchema dossier)
```

### Why not share the formal path?

`sendMessageToAI` already encodes fragile regex gates for profile vs explanation vs compare. Gaffa mode must be a hard switch: if the toggle is on, dossier synthesis does not run, regardless of wording like “rate” or “profile.”

## Section 1 — Mode & intent

### Explicit mode

- Add a **Gaffa** control in `ChatInput` alongside the existing default/fast speed toggle.
- Persist mode preference (conversation-level or session-level; implementation plan picks one — prefer conversation so history stays coherent).
- When Gaffa is on:
  - Placeholder / loading copy reflects Gaffa Q&A (not “generating dossier”).
  - `App.handleSendMessage` calls `sendGaffaMessage` instead of `sendMessageToAI`.
- When Gaffa is off: behavior unchanged; Gaffa rules are not injected.

### Soft auto-detect

- If Gaffa mode is **off** and the message matches high-confidence Gaffa cues (e.g. OOP penalty, bench DEF/MID/ATT cover, academy/IR, €m trade framing, formation lock language), show a non-blocking nudge: *“This looks like a Gaffa question — switch to Gaffa mode?”*
- Do **not** auto-answer with Gaffa context while mode is off.
- Auto-detect may later be used *inside* Gaffa mode only to choose rules vs player_trade research depth — never to flip domains silently.

### Relationship to default/fast

- Speed mode (default vs fast) may still apply to research depth inside Gaffa player/trade turns, or Phase 1 can always use a single research depth. Implementation plan should pick one; default recommendation: reuse fast/default as research intensity only, with no dossier branch.

## Section 2 — Knowledge pack

### Source of truth

- Canonical human guide lives in Gaffa: `Fantasy Futbol/docs/USER_GUIDE.md`.
- Futbolpedia ships a curated **`GAFFA_RULES_SNAPSHOT`** distilled from that guide (not a verbatim dump of the entire guide into every prompt).

### Snapshot contents (minimum)

- Product thesis (rate footballers, not farm a points table)
- 12 positions + eligibility strictness + 12 formations
- Bench structure (DEF/MID/ATT/FLEX) and auto-sub order implications
- Dual lock model (formation vs player)
- Squad statuses at a high level (senior / academy / IR as relevant to Q&A)
- Scoring philosophy: positional baselines, OOP penalty concept — **not** sigmoid math unless asked
- Economy framing: money in €m; auctions / trades / loans at conceptual level
- PL-only roster eligibility and transfer-in/out implications
- Dynasty horizon: multi-year asset quality matters
- Disclaimer: commissioner settings may differ; snapshot is common defaults

### Versioning & sync

- Include `gaffa_rules_version` (date or semver string) in the snapshot module and in `GaffaContextBag`.
- When Gaffa mechanics change: update USER_GUIDE → refresh snapshot → bump version.
- Phase 1 sync is **manual** (checklist below). No runtime fetch.

### Manual sync checklist

1. Diff Gaffa `docs/USER_GUIDE.md` (and any DECISIONS notes) since last snapshot.
2. Update `GAFFA_RULES_SNAPSHOT` for changed user-facing rules only.
3. Bump `gaffa_rules_version`.
4. Spot-check 5 golden Q&A prompts (rules + one trade).

## Section 3 — Answer pipeline & guardrails

### Entry point

- `sendGaffaMessage(message, history, options)` in `services/` (either `gaffaChatService.ts` or a clearly separated export from `geminiService.ts`).
- Must not call `synthesizeFormalResponse` / dossier `responseSchema` paths.

### Turn classification

Light classifier (regex/heuristic first; LLM only if needed):

| Kind | Behavior |
|---|---|
| `rules` | Answer from snapshot; search optional and not authoritative for rules |
| `strategy` | Snapshot + general football reasoning; no invented league state |
| `player_trade` | Short research (search → fact extract) + snapshot for mechanical framing → prose |

### Research (player/trade)

- Reuse existing Gemini search tooling patterns from conversational chat / outlook pipeline.
- Respect the same anti-hallucination habits: simulation date awareness, no unverified coach names, no fabricated match stats.
- Scoring-data firewall: do not treat fantasy points or private match ratings as evidence of football quality.

### Output

- Always a Markdown **string** `ChatMessage`.
- May reference Gaffa mechanics naturally (positions, €m, PL eligibility, dynasty horizon).
- Avoid banned meta phrasing: “in Gaffa”, “in Gaffa terms”, “from an FPL perspective.”
- Trade answers: give a reasoned take; explicitly list what depends on unknown club context (needs, standings, settings).
- Do not invent: user’s roster, league standings, market clearing prices, or commissioner overrides.

### Voice

- Futbolpedia scout voice — sharp, specific, opinionated where evidence allows.
- Do not dump engine internals (sigmoid weights, ICT imputation) unless the user asks how scoring is computed.

## Section 4 — Phase 2 hooks

### `GaffaContextBag`

Phase 1 shape (extensible):

```ts
interface GaffaContextBag {
  gaffa_rules_version: string;
  /** Phase 1 always false. Phase 2 sets true after a successful league/club link. */
  connected: boolean;
  league_id?: string;
  club_id?: string;
  settings_overrides?: Record<string, unknown>;
  roster?: unknown;
  budget_eur_m?: number;
  standings?: unknown;
  matchup?: unknown;
  open_listings?: unknown;
  synced_at?: string;
}
```

Phase 1 constructs `{ gaffa_rules_version, connected: false }` only. When `connected` is true, treat populated live fields as **locked facts** the model must not contradict (same pattern as outlook `OutlookContextBag`). Concrete roster/standings types land in the Phase 2 plan.

### Connect flow (later, not Phase 1 build)

1. User links Gaffa account / authorizes read access.
2. User picks league + club.
3. Futbolpedia stores a league-scoped read credential/session.
4. Per turn or on “sync my club”, refresh bag fields from a Gaffa **read API**.
5. Chat may advise; it does not execute trades/lineups in the first Phase 2 slice.

### Until connected

Any club-specific question keeps an explicit caveat: Futbolpedia does not have this club’s state yet.

## UI sketch (Phase 1)

- Chat composer: existing speed toggle + new **Gaffa** toggle/chip.
- Visible mode indicator while Gaffa is on (so users understand why they got prose, not a dossier).
- Optional one-line nudge banner when auto-detect fires and mode is off.
- No new side-panel dossier from Gaffa answers.

## Testing / acceptance (Phase 1)

1. Gaffa mode on + “rate Isak” → prose Gaffa-aware answer, **no** profile card.
2. Gaffa mode off + same → existing dossier/prose behavior unchanged.
3. Gaffa mode on + “Can a CB auto-sub for an LB?” → correct strict-eligibility answer from snapshot.
4. Gaffa mode on + “Isak for Jackson + €70m?” → reasoned trade take + unknown-context caveats; no invented roster/prices.
5. Gaffa mode off + clear Gaffa mechanics question → nudge to switch; no silent Gaffa injection.
6. Rules answer must not contradict snapshot defaults; must mention commissioner variance where relevant.

## Implementation boundaries

| In Phase 1 | Out |
|---|---|
| ChatInput Gaffa control + App routing | Gaffa OAuth / league picker |
| `GAFFA_RULES_SNAPSHOT` + version | Runtime rules sync from Gaffa |
| `sendGaffaMessage` prose pipeline | Dossier/outlook generation in this path |
| Soft auto-detect nudge | Silent domain switching |
| `GaffaContextBag` stub types | Live roster injection |

## Open implementation choices (for the plan, not blockers)

1. Persist Gaffa mode per conversation vs per browser session.
2. Whether default/fast affects Gaffa research depth in Phase 1.
3. Exact module layout (`gaffaChatService.ts` vs engine package vs `constants/gaffaRules.ts`).
4. Auto-detect phrase list v1 (start small; false positives worse than misses).
