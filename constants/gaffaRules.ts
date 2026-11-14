import type { GaffaContextBag, GaffaFreeAgent, PlayerProfile } from '../types';
import { buildDossierLookupMap, lookupPlayerDossier } from '../services/gaffaLineupAudit';

/** Bump when the snapshot is refreshed from Gaffa's USER_GUIDE. */
export const GAFFA_RULES_VERSION = '2026-10-19';

/**
 * Curated rules brief for Gaffa Q&A — distilled from Fantasy Futbol/docs/USER_GUIDE.md.
 * Not a verbatim dump. Commissioner settings may differ; these are common defaults.
 */
export const GAFFA_RULES_SNAPSHOT = `=== GAFFA RULES SNAPSHOT (v${GAFFA_RULES_VERSION}) ===
Disclaimer: Many figures are commissioner-tunable. Treat the numbers below as common defaults. Money is in €m.

THESIS
- Dynasty Premier League fantasy: win by being right about footballers, not by farming a points table.
- Players are graded against position-specific expectations (match-rating style), then converted to fantasy points.
- Dynasty (the main format): squads carry forever after one inaugural snake draft; thereafter change via auctions, trades, loans.
- Redraft leagues also exist: a new draft every season and fewer systems. The context bag's is_dynasty says which one this league is. See LEAGUE FORMATS.

POSITIONS & FORMATIONS
- 12 tactical positions (no DEF/MID/FWD buckets): GK; CB, LB, RB, LWB, RWB; DM, CM, AM; LW, RW, ST.
- Eligibility is strict: a slot accepts only its own position. A CB cannot fill LB. Multi-position listing is the only flexibility.
- Twelve formations: 4-3-3, 4-2-1-3, 4-2-2-2, 4-2-4, 4-3-1-2, 4-3-2-1, 3-4-1-2, 3-4-3, 3-4-2-1, 3-5-2, 5-3-2, 5-2-3.
- XI: exactly 11 starters + exactly 4 bench slots: DEF (CB/LB/RB/LWB/RWB), MID (DM/CM/AM), ATT (ST/LW/RW), FLEX (anyone starter-eligible, including emergency GK).

LOCKS
- Formation locks when the first match involving ANY of your squad kicks off.
- An individual player locks only when HIS club kicks off.
- After this gameweek's last dated kickoff, next week's lineup, academy moves, and IR moves unlock. Exception: a player in this week's lineup (starting or bench) can't move on or off IR until the week settles, because that would change points already scored. This week's scores stay until settlement.

SQUAD STATUS
- Active/Bench count toward roster (commonly 22).
- IR (Injured Reserve): parking for injured players; common cap 2 (3 for a club that bought the Club Facilities upgrade); does not count toward active roster. Cannot place an auction bid while a healthy player sits on IR.
- Academy: prospect stash for players aged 21 or younger on 1 August, the start of the season (commonly 3 slots, up to 5 with Club Facilities upgrades); not counted in active roster.
- Loaned out / loaned in. A player loaned out still counts toward the LENDER's squad, not the borrower's.
- Held: a player who arrived when the squad was full (loan expiry, retained player returning to the PL, an auction won when no bidder with room bid). Still owned, off the squad, not counted. See HELD PLAYERS.
- On Loan Abroad: a player who left the PL on loan. Uses no squad place and no retained slot, gets no compensation, rejoins automatically on return. See FINANCE / ACADEMY / DEPARTURES.
- Full common capacity roughly 22 + 3 Academy + 2 IR (more for clubs with facility upgrades).
- The connected context bag carries THIS club's own IR / academy / loans-out caps, upgrades included. Prefer them over the defaults here.

HELD PLAYERS
- A held player is never auto-dropped and never pushes the squad over the limit.
- The manager activates him (to reserves, or academy/IR if eligible) once there's room. Activation is closed mid-gameweek (first kickoff to last kickoff).
- While any player is held, the squad can't grow: no bids, no borrowing, no loan recalls, no promotion from academy or IR, no trade that brings in more players than it sends out. A held player going out in a trade frees no place. Drops, sales, one-for-one trades, moves to IR/academy, and loaning others out still work.
- Live bids are withdrawn the moment a player is held.
- If still held at the next gameweek's first kickoff, the lineup locks until resolved. The last saved lineup is used each week, with only unavailable players' slots filled.
- Dropping a held player costs normal severance and sends him to auction. He can be sold or traded, not loaned out.

CLUB FACILITIES
- One-time, permanent upgrades bought with Club Balance, per club. No upkeep, never sold back, carried every season. Visible to other managers. The money is destroyed, not paid to anyone.
- Academy: 3 → 4 slots for €60m, 4 → 5 for €90m (needs slot 4 first).
- Injured Reserve: 2 → 3 slots for €60m.
- Loans Out: 1 → 2 for €30m. The loan-in cap never changes.
- Active roster size can't be bought.

SCORING (PHILOSOPHY — not math dump)
- Each appearance → displayed rating roughly 1.0–10.0 (average PL starter ~6.5), built from match impact, creativity/threat, defensive work, clean sheets / goals conceded context, goals/assists, saves (GK), with a flex boost on the player's best role-relevant component.
- Fantasy points come from a separate curve of that performance — not a flat "6 for a goal" table. No appearance/participation points.
- Displayed rating ≤ 5.5 → 0.00 fantasy points. Zero is the floor (never negative).
- Curve is front-loaded: elite performances outweigh stacks of average ones.
- Rare-feat bonus (hat-trick, 3+ assists, exceptional chance-creation) adds a small top-up (~3–5+).
- Out-of-position (OOP) penalty: if a player's PRIMARY position is midfield/attack (DM, CM, AM, LW, RW, ST) and he is fielded in a DEFENSIVE slot (CB, LB, RB, LWB, RWB), he takes a 20% penalty to rating and points — even if also listed defensively. Does NOT apply in reverse (defender in midfield/attack is not penalised).
- Double gameweeks: both matches rate separately; points sum.
- Red cards devastate the week via match impact / lost minutes — often near the zero threshold — without a separate flat −3 line item.
- Do NOT explain sigmoid weights, ICT imputation, or private scoring engine internals unless the user explicitly asks how the math works.

MATCHUPS & BENCH
- H2H each week: score = starting XI fantasy points + bench effects.
- Auto-sub: if a starter finishes on zero minutes (after his fixture is confirmed finished), check bench in order DEF → MID → ATT → FLEX for the first player who (1) played >0 minutes and (2) is eligible for that exact empty slot. Each bench player used once. Strict eligibility still applies (bench CB never covers LB).
- The sub is re-rated at the SLOT he filled.
- Bench Depth Bonus: unused bench players who played add 25% of their points (at their normal position).
- Draw band: gap of 10 points or less = draw (league). Cups have no draws.
- Forgotten lineup: previous GW lineup carries forward / auto-build — not a forfeit.

CUPS
- Champions Cup, League Cup, Consolation Cup run alongside the league off the SAME XI and score.
- No separate cup lineup. Seeds from league position; first season seeds at GW7. Two-legged rounds possible. Cup ties never draw; tie-breaks: best individual performer, then higher bracket/seed.

MARKET, TRADES, LOANS (CONCEPTUAL)
- One open auction board for free agents and listed players; bids from Club Balance (common start ~250; never resets between seasons).
- Open bidding (see highest bid / bidder). Must beat current high. Roster-full bids nominate a drop (severance ~20% market value, min €2m).
- Free-agent floor commonly 60% of market value, rounded down (a €2m player still opens at €1m). New PL arrivals blocked until Transfermarkt-priced.
- Settlement: when an auction ends, the highest bidder WITH ROOM wins at their own bid. Only if no bidder has room does the highest bidder win, and the player is held. A holding club can't bid.
- Listing a rostered player: minimum bid (≥60% MV), release clause, and/or asking price.
- 20% of every winning free-agent bid returns to the league; the other 80% is retired.
  - Scout's Fee: 10% of the winning bid, uncapped, to the manager who nominated the player into the auction, WHETHER THEY WIN OR LOSE. If the scout wins, it's a rebate on their own bid.
  - Solidarity: the other 10%, split equally among clubs that didn't win.
  - System-opened auctions (new-arrival or promoted-club sweeps, re-auction after a drop, post-departure return auction, season-kickoff sweep) pay no Scout's Fee even if a manager bid first; the whole 20% is solidarity.
  - Severance and loan slot buyback fees also send 20% to solidarity, with no Scout's Fee.
- Trades: any mix of players + Club Balance; accept/reject/counter; no commissioner veto / no trade deadline. Deferred if a involved player already kicked off this GW.
- Loans: 4–16 GWs; caps commonly 1 out / 2 in (a club can buy a second loan-out slot); fees + optional performance bonus; recall / slot buyback exist. Recalling needs room and is refused while holding a player. A loan ending into a full squad makes the returning player held.

PL-ONLY & DYNASTY
- Roster pool is Premier League. Exit from the PL ends usable roster eligibility and materially hurts dynasty value; PL arrivals are acquisition opportunities.
- Evaluate assets on short-run role/minutes AND multi-year durability (age, career phase), without inventing the user's roster needs.

FINANCE / ACADEMY / DEPARTURES (BRIEF)
- Match revenue every 4 GWs (win/draw/loss payments). Club Balance is a permanent dynasty asset.
- Academy eligibility is age on 1 August, the start of the season: 21 or younger on that date qualifies for the whole season, so a mid-season birthday changes nothing. He is judged again each 1 August.
- An aged-out player is never moved or dropped automatically. He may stay in the Academy, but while he does the club can't bid or move anyone else into the Academy until he's promoted or dropped.
- Departure from the PL (transfer abroad, relegation, retirement): the manager chooses RELEASE (60% of market value as compensation, barred from the return auction) or RETAIN (no cash, keep his rights in a scarce retained slot, commonly 3). Retained rights are tradeable; the return-auction bar stays with whoever took compensation.
- A retained player who returns joins the squad if there's room; otherwise he's held, and the manager can decline him for nothing (he goes to auction).
- A player who leaves the PL ON LOAN gets no Release/Retain choice: he's On Loan Abroad, uses no squad place or retained slot, gets no compensation, and rejoins automatically when back (held if the squad is full). He can be traded or dropped for nothing. If a new season starts and he hasn't returned, it's treated as a permanent departure.
- Offseason reset exists — do not invent league-specific payout tables unless present here.

MANAGERS LEAVING (CARETAKER)
- Before the draft, leaving removes the club. After the draft, a club whose manager leaves or is removed stays in the league, run by the Caretaker until a new manager takes it over from the invite code. It keeps its squad, Club Balance, record and fixtures, so tables and cup brackets never change.
- On handover the manager's live bids are withdrawn and open trade/loan offers and unbid listings cancelled; deals already agreed still complete at the end of the gameweek.
- The Caretaker never does business: no bids, sales, trades or loans, and nobody can propose a trade or loan to a Caretaker club. It picks the best lineup from projected points before each gameweek, moves injured players to IR and back between gameweeks, and activates held players when there's room.
- Inactivity: opening the league or the dashboard counts as active. After 5 full gameweeks without a visit the manager is warned; after one more, the commissioner is told. Removing a manager is always the commissioner's decision. International breaks and the summer don't count.
- Commissioner tools in Settings: see when each manager was last active, remove a manager, transfer the commissioner role. A commissioner must hand the role on before leaving a league that has drafted.

LEAGUE FORMATS
- Dynasty is the default and everything above describes it.
- Redraft (chosen when the league is created): a new snake draft every season, with squads cleared and Club Balances reset to the league budget (recommended €100m). Same positions, scoring, lineups, auto-subs, matchups, draw band and cups. Trades, IR and free-agent auctions still exist.
  - Switched off in redraft: Academy, loans, Club Facilities, listings, severance (drops are free), the retained list (a departing player simply leaves; no compensation), Match Revenue, prizes, and the solidarity/Scout's Fee split.
  - Every free agent opens at €1m regardless of market value.
  - Transfer Day: all redraft bids settle together 24 hours before the gameweek's first kickoff (in a congested week, halfway between the previous gameweek's last match and the next one's first). Highest bidder with room wins, top-priced players first. After Transfer Day, any free agent nobody bid on can be signed instantly for free with Sign Now, until his club kicks off. A dropped player goes to auction until the next Transfer Day.
- Expansion draft (dynasty only, offseason, before Kickoff): the commissioner adds up to 4 clubs. Each existing club protects 8 senior players (Academy and loaned-out players are exempt on top). New clubs pick in a random order from unprotected players and free agents; no existing club loses more than 2. New clubs start with the league's median Club Balance; nobody pays or is paid for players taken. When the last squad is full, fixtures and cups are rebuilt.
`;

export function emptyGaffaContextBag(): GaffaContextBag {
  return {
    gaffa_rules_version: GAFFA_RULES_VERSION,
    connected: false,
  };
}

function formatFaPlayerLine(p: GaffaFreeAgent, dossierMap: Map<string, PlayerProfile>): string {
  const alias = p.display_name && p.display_name !== p.name ? ` (aka ${p.display_name})` : '';
  const dossier = lookupPlayerDossier(p.name, p.display_name, dossierMap);
  const bits = [
    `${p.name}${alias} | ${p.position}`,
    p.pl_team || null,
    p.market_value_eur_m != null ? `€${p.market_value_eur_m}m` : null,
    p.age != null ? `age ${p.age}` : null,
    dossier ? `Scout ${dossier.ratings.overall} OVR / ${dossier.ratings.potential} POT` : null,
    p.live_auction ? 'LIVE AUCTION (bid now)' : null,
  ].filter(Boolean);
  return `  - ${bits.join(' · ')}`;
}

/** FA players listed inline; past this the model filters the rest with `grep_gaffa_market`. */
const FA_INLINE_CAP = 60;

/**
 * FA pool = unowned active PL players in THIS league (Gaffa free-agents board).
 * Live auctions are only the subset currently being bid on. Listings are owned.
 * Empty auctions/listings ≠ empty FA. Only an empty `free_agents` array is empty FA.
 * A missing `free_agents` field is a legacy bag — do not claim the pool is empty.
 */
function formatLockedMarketLines(
  bag: GaffaContextBag,
  dossierMap: Map<string, PlayerProfile>,
): string[] {
  const listings = bag.open_listings ?? [];
  const auctions = bag.open_auctions ?? [];
  const fa = bag.free_agents;
  const lines: string[] = [];

  if (fa == null) {
    lines.push(
      'FA POOL: unowned list is NOT in this bag (legacy context). Live auctions are only players currently being bid on — they are NOT the full free-agency pool.',
      'Do NOT say FA is empty because live auctions or listings are empty. Do not invent names. You may only name live-auction players as currently bid-able.',
    );
  } else if (fa.length === 0) {
    lines.push(
      'FA POOL (free agency / unowned in THIS league): EMPTY — every active PL player is rostered or rights-held.',
      'If asked who is in FA, the highest-potential unowned player, or who to buy from free agency: say the unowned pool is empty. Do not invent a market. Do not name real-world free agents, EAFC regens, Liga MX licensing quirks, or other sports.',
    );
  } else {
    const liveCount = fa.filter((p) => p.live_auction).length;
    lines.push(
      `FA POOL (free agency / unowned in THIS league): ${fa.length} players. THIS is free agency — not listings, not "empty because no live auctions".`,
      'You can nominate anyone below to open an FA auction (FA floor applies). LIVE AUCTION means a bid is already open.',
      `Rank "highest potential" only among THESE names. Use calibrated Scout OVR/POT where tagged below, and market value / age otherwise — do not invent overall or potential ratings for untagged players. ${liveCount} currently on a live auction.`,
    );
    const sortedFa =
      fa.length > FA_INLINE_CAP
        ? [...fa].sort(
            (a, b) =>
              Number(Boolean(b.live_auction)) - Number(Boolean(a.live_auction)) ||
              (b.market_value_eur_m ?? 0) - (a.market_value_eur_m ?? 0),
          )
        : fa;
    for (const p of sortedFa.slice(0, FA_INLINE_CAP)) {
      lines.push(formatFaPlayerLine(p, dossierMap));
    }
    if (fa.length > FA_INLINE_CAP) {
      lines.push(
        `  ... plus ${fa.length - FA_INLINE_CAP} more unowned FA players in this league. Use the \`grep_gaffa_market\` tool to filter all ${fa.length} unowned players by position, age (e.g. U21), Scout OVR/POT, club, or keyword in <1ms.`,
      );
    }
  }

  if (auctions.length === 0) {
    lines.push(
      'Live auctions (currently being bid on): none. Empty auctions does not mean empty FA.',
    );
  } else {
    lines.push(`Live auctions (${auctions.length}) — currently being bid on (subset of FA if kind=free_agent; listed/owned if kind=listing):`);
    for (const a of auctions) {
      lines.push(
        `  - ${a.name} ${a.position} · ${a.kind}` +
          (a.highest_bid_eur_m != null ? ` · high €${a.highest_bid_eur_m}m` : ''),
      );
    }
  }

  if (listings.length === 0) {
    lines.push('Open listings (owned players for sale/trade/loan — NOT free agency): none.');
  } else {
    lines.push(
      `Open listings (${listings.length}) — owned by a Gaffa club, NOT the FA pool:`,
    );
    for (const l of listings) {
      const price = [
        l.min_bid_eur_m != null ? `min €${l.min_bid_eur_m}m` : null,
        l.ask_eur_m != null ? `ask €${l.ask_eur_m}m` : null,
        l.release_clause_eur_m != null ? `clause €${l.release_clause_eur_m}m` : null,
      ]
        .filter(Boolean)
        .join(', ');
      const doors = [
        l.open_to_sale ? 'sale' : null,
        l.open_to_trade ? 'trade' : null,
        l.open_to_loan ? 'loan' : null,
      ]
        .filter(Boolean)
        .join('/');
      lines.push(
        `  - ${l.name} ${l.position} from ${l.seller_club_name}${l.yours ? ' (YOURS)' : ''}` +
          `${price ? ` · ${price}` : ''}${doors ? ` · ${doors}` : ''}`,
      );
    }
  }

  return lines;
}

/** Compact turn-level lock so first-turn FA questions cannot ignore the system bag. */
export function buildLockedMarketTurnBlock(
  bag: GaffaContextBag,
  calibratedDossiers: PlayerProfile[] = [],
): string {
  if (!bag.connected) {
    return `<locked_market>
No live Gaffa bag this turn. If the user asks about free agency / FA / unowned / highest potential available: you do not have this league's unowned pool — say so. Do not invent a market from real-world unattached players, EAFC, Liga MX licensing, or other sports.
</locked_market>`;
  }

  const rosterNames = (bag.roster ?? [])
    .map((p) => p.name)
    .filter(Boolean)
    .slice(0, 40);
  const settings = bag.settings
    ? `League settings: roster ${bag.settings.roster_size} · FA floor ${
        bag.settings.free_agent_bid_floor != null
          ? `${Math.round(bag.settings.free_agent_bid_floor * 100)}% MV`
          : 'unknown'
      }${bag.settings.league_status ? ` · ${bag.settings.league_status}` : ''}.`
    : 'League settings: not in bag.';

  return `<locked_market>
This turn is already inside Gaffa (${bag.league_name ?? 'league'} / ${bag.club_name ?? 'club'}). The user does not need to say "in the Gaffa league".
Answer market / FA / unowned / "can I buy X from FA" / "highest potential" availability ONLY from names below. Closed set = roster + listings + live auctions + FA pool. If the FA pool list is present and empty, say so — do not invent a market. If the FA pool list is missing, do not treat empty auctions as empty FA.
Empty live auctions / listings does not mean free agency is empty.

${formatLockedMarketLines(bag, buildDossierLookupMap(calibratedDossiers)).join('\n')}
${settings}
Roster names (not FA): ${rosterNames.join(', ') || 'none listed'}.
</locked_market>`;
}


interface GaffaGrepItem {
  pool: string;
  name: string;
  display_name?: string;
  position: string;
  pl_team?: string | null;
  age?: number | null;
  market_value_eur_m?: number | null;
  status?: string;
  detail?: string;
  scout_ovr?: number;
  scout_pot?: number;
  scout_archetype?: string;
  scout_top_attributes?: Record<string, number>;
}

export interface GaffaMarketGrepParams {
  pool?: 'free_agents' | 'roster' | 'listings' | 'auctions' | 'all';
  position?: string;
  plTeam?: string;
  maxAge?: number;
  minAge?: number;
  minMarketValue?: number;
  maxMarketValue?: number;
  minOverall?: number;
  minPotential?: number;
  query?: string;
  sortBy?: 'market_value' | 'age' | 'overall' | 'potential';
  limit?: number;
}

/** Numeric grep bounds: [param, item field, bound]. Items missing the field never match a bound. */
const GREP_RANGE_FILTERS: ReadonlyArray<
  readonly [
    'maxAge' | 'minAge' | 'minMarketValue' | 'maxMarketValue' | 'minOverall' | 'minPotential',
    'age' | 'market_value_eur_m' | 'scout_ovr' | 'scout_pot',
    'min' | 'max',
  ]
> = [
  ['maxAge', 'age', 'max'],
  ['minAge', 'age', 'min'],
  ['minMarketValue', 'market_value_eur_m', 'min'],
  ['maxMarketValue', 'market_value_eur_m', 'max'],
  ['minOverall', 'scout_ovr', 'min'],
  ['minPotential', 'scout_pot', 'min'],
];

const byMarketValueDesc = (a: GaffaGrepItem, b: GaffaGrepItem) =>
  (b.market_value_eur_m ?? -1) - (a.market_value_eur_m ?? -1);

/** Youngest first for age; highest first otherwise, with scout sorts tie-broken by market value. */
const GREP_SORTS: Record<
  NonNullable<GaffaMarketGrepParams['sortBy']>,
  (a: GaffaGrepItem, b: GaffaGrepItem) => number
> = {
  market_value: byMarketValueDesc,
  age: (a, b) => (a.age ?? 99) - (b.age ?? 99),
  overall: (a, b) => (b.scout_ovr ?? -1) - (a.scout_ovr ?? -1) || byMarketValueDesc(a, b),
  potential: (a, b) => (b.scout_pot ?? -1) - (a.scout_pot ?? -1) || byMarketValueDesc(a, b),
};

/**
 * Instant (<1ms) structured grep over the connected Gaffa club bag
 * (unowned FA pool, club roster, open listings, and live auctions),
 * cross-linked with calibrated Futbolpedia dossiers when available.
 */
export function grepGaffaBag(
  bag: GaffaContextBag,
  params: GaffaMarketGrepParams = {},
  calibratedDossiers: PlayerProfile[] = [],
) {
  if (!bag.connected) {
    return {
      connected: false,
      message: 'No Gaffa club is connected in this session.',
      results: [],
    };
  }

  const dossierMap = buildDossierLookupMap(calibratedDossiers);
  const poolType = params.pool ?? 'all';
  const posFilter = params.position?.trim().toUpperCase();
  const teamFilter = params.plTeam?.trim().toLowerCase();
  const queryTokens = params.query
    ? params.query
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    : [];

  const attachScoutMeta = (name: string, displayName?: string) => {
    const d = lookupPlayerDossier(name, displayName, dossierMap);
    if (!d) return {};
    const topAttrs = Object.entries(d.attributes || {})
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    const scout_top_attributes: Record<string, number> = {};
    for (const [k, v] of topAttrs) scout_top_attributes[k] = v;
    return {
      scout_ovr: d.ratings?.overall,
      scout_pot: d.ratings?.potential,
      scout_archetype: d.playstyleAndRole?.playstyle?.archetype,
      scout_top_attributes,
    };
  };

  const items: GaffaGrepItem[] = [];
  const wants = (pool: NonNullable<GaffaMarketGrepParams['pool']>) =>
    poolType === 'all' || poolType === pool;

  if (wants('free_agents')) {
    for (const p of bag.free_agents ?? []) {
      items.push({
        pool: 'free_agent',
        name: p.name,
        display_name: p.display_name,
        position: p.position,
        pl_team: p.pl_team,
        age: p.age,
        market_value_eur_m: p.market_value_eur_m,
        detail: p.live_auction ? 'LIVE AUCTION' : 'unowned (nominate to open auction)',
        ...attachScoutMeta(p.name, p.display_name),
      });
    }
  }

  if (wants('roster')) {
    for (const p of bag.roster ?? []) {
      const pos = [p.primary_position, ...(p.secondary_positions ?? [])].join('/');
      items.push({
        pool: 'roster',
        name: p.name,
        display_name: p.display_name,
        position: pos,
        pl_team: p.pl_team,
        status: p.status,
        ...attachScoutMeta(p.name, p.display_name),
      });
    }
  }

  if (wants('listings')) {
    for (const l of bag.open_listings ?? []) {
      const price = l.min_bid_eur_m ?? l.ask_eur_m ?? l.release_clause_eur_m ?? null;
      items.push({
        pool: 'listing',
        name: l.name,
        position: l.position,
        market_value_eur_m: price,
        detail: `Seller: ${l.seller_club_name}${l.yours ? ' (YOURS)' : ''}`,
        ...attachScoutMeta(l.name),
      });
    }
  }

  if (wants('auctions')) {
    for (const a of bag.open_auctions ?? []) {
      items.push({
        pool: 'auction',
        name: a.name,
        position: a.position,
        market_value_eur_m: a.highest_bid_eur_m ?? null,
        detail: `Kind: ${a.kind}${a.highest_bid_eur_m != null ? `, high €${a.highest_bid_eur_m}m` : ''}`,
        ...attachScoutMeta(a.name),
      });
    }
  }

  const filtered = items.filter((item) => {
    // A substring match also covers a whole token of a multi-position string like "CM/DM".
    if (posFilter && !item.position.toUpperCase().includes(posFilter)) {
      return false;
    }
    if (teamFilter && !(item.pl_team || '').toLowerCase().includes(teamFilter)) {
      return false;
    }
    for (const [paramKey, itemKey, bound] of GREP_RANGE_FILTERS) {
      const limit = params[paramKey];
      if (typeof limit !== 'number') continue;
      const value = item[itemKey];
      if (value == null || (bound === 'min' ? value < limit : value > limit)) return false;
    }
    if (queryTokens.length > 0) {
      const hay = [
        item.name,
        item.display_name,
        item.position,
        item.pl_team,
        item.status,
        item.detail,
        item.scout_archetype,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!queryTokens.every((t) => hay.includes(t))) return false;
    }
    return true;
  });

  // sortBy arrives from a model tool call, so anything unrecognised falls back to market value.
  const sortBy = params.sortBy && Object.hasOwn(GREP_SORTS, params.sortBy) ? params.sortBy : 'market_value';
  filtered.sort(GREP_SORTS[sortBy]);

  const limit = Math.max(1, Math.min(50, params.limit ?? 25));
  return {
    connected: true,
    club: bag.club_name,
    league: bag.league_name,
    budget_eur_m: bag.budget_eur_m,
    totalMatches: filtered.length,
    results: filtered.slice(0, limit),
  };
}
