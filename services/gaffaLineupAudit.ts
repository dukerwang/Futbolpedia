import type {
  GaffaContextBag,
  GaffaFreeAgent,
  GaffaOpenAuction,
  GaffaOpenListing,
  GaffaRosterPlayer,
  PlayerProfile,
} from '../types';
import {
  foldPlayerName,
  getDossierEvaluationDate,
  isPrimeCard,
  toBasePlayerSlug,
} from './dossierStore';

export const DEFENSIVE_SLOTS = new Set(['CB', 'LB', 'RB', 'LWB', 'RWB']);
const MID_ATT_SLOTS = new Set(['DM', 'CM', 'AM', 'LW', 'RW', 'ST']);
const ALL_GAFFA_SLOTS = ['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'DM', 'CM', 'AM', 'LW', 'RW', 'ST'];

/** Football words for a slot, checked after explicit slot tokens when inferring trade slots. */
const SLOT_ALIASES: ReadonlyArray<readonly [RegExp, string[]]> = [
  [/\b(striker|centre-?forward|center-?forward|#9)\b/i, ['ST']],
  [/\b(winger|wide forward)\b/i, ['LW', 'RW']],
  [/\b(centre-?back|center-?back)\b/i, ['CB']],
  [/\b(full-?back)\b/i, ['LB', 'RB']],
  [/\b(wing-?back)\b/i, ['LWB', 'RWB']],
  [/\b(keeper|goalkeeper)\b/i, ['GK']],
];

/** Roster statuses: held players freeze the market; squad statuses count toward the roster cap. */
const HELD_STATUSES = new Set(['held', 'pending_activation']);
export const SQUAD_STATUSES = new Set(['active', 'bench', 'loan_out']);
const FIELDABLE_STATUSES = new Set(['active', 'bench', 'loan_in']);
export const ACADEMY_STATUSES = new Set(['taxi', 'academy']);

const DEFAULT_ROSTER_CAP = 22;
const DEFAULT_FA_BID_FLOOR = 0.6;

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word match on accent-folded text, so "Rice" never matches inside "price". */
const containsWord = (foldedText: string, foldedWord: string): boolean =>
  new RegExp(`(?<![a-z0-9])${escapeRegExp(foldedWord)}(?![a-z0-9])`).test(foldedText);

const foldedSurname = (name: string): string => foldPlayerName(name.trim()).split(/\s+/).pop() ?? '';

/**
 * How a player name appears in a message folded with `foldPlayerName`: as the full name, as a
 * surname of at least 4 letters, or not at all. Accent-insensitive ("odegaard" finds Ødegaard).
 */
type NameMatch = 'full' | 'surname' | null;

function matchPlayerName(name: string | undefined, foldedMessage: string): NameMatch {
  if (!name || name.trim().length < 3) return null;
  const full = foldPlayerName(name.trim()).replace(/\s+/g, ' ');
  if (containsWord(foldedMessage, full)) return 'full';
  const surname = foldedSurname(name);
  return surname !== full && surname.length >= 4 && containsWord(foldedMessage, surname)
    ? 'surname'
    : null;
}

function heldPlayersOf(roster: GaffaRosterPlayer[]): GaffaRosterPlayer[] {
  return roster.filter((p) => HELD_STATUSES.has(p.status));
}

function squadCountOf(roster: GaffaRosterPlayer[]): number {
  return roster.filter((p) => SQUAD_STATUSES.has(p.status)).length;
}

/** League FA bid floor as a fraction of market value. */
export function faBidFloorRate(bag: GaffaContextBag | undefined): number {
  return bag?.settings?.free_agent_bid_floor ?? DEFAULT_FA_BID_FLOOR;
}

/** Opening FA nomination bid: floor share of MV, rounded down, never below €1m. */
export function openingFaFloor(marketValueEurM: number, floorRate: number): number {
  return marketValueEurM > 0 ? Math.max(1, Math.floor(marketValueEurM * floorRate)) : 1;
}

/** The 12 legal Gaffa formations mapped to their 11 strict positional slots. */
const GAFFA_FORMATIONS: Record<string, string[]> = {
  '4-3-3': ['GK', 'LB', 'CB', 'CB', 'RB', 'DM', 'CM', 'CM', 'LW', 'RW', 'ST'],
  '4-2-1-3': ['GK', 'LB', 'CB', 'CB', 'RB', 'DM', 'DM', 'AM', 'LW', 'RW', 'ST'],
  '4-2-2-2': ['GK', 'LB', 'CB', 'CB', 'RB', 'DM', 'DM', 'AM', 'AM', 'ST', 'ST'],
  '4-2-4': ['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'LW', 'RW', 'ST', 'ST'],
  '4-3-1-2': ['GK', 'LB', 'CB', 'CB', 'RB', 'DM', 'CM', 'CM', 'AM', 'ST', 'ST'],
  '4-3-2-1': ['GK', 'LB', 'CB', 'CB', 'RB', 'DM', 'CM', 'CM', 'AM', 'AM', 'ST'],
  '3-4-1-2': ['GK', 'CB', 'CB', 'CB', 'LWB', 'RWB', 'CM', 'CM', 'AM', 'ST', 'ST'],
  '3-4-3': ['GK', 'CB', 'CB', 'CB', 'LWB', 'RWB', 'CM', 'CM', 'LW', 'RW', 'ST'],
  '3-4-2-1': ['GK', 'CB', 'CB', 'CB', 'LWB', 'RWB', 'CM', 'CM', 'AM', 'AM', 'ST'],
  '3-5-2': ['GK', 'CB', 'CB', 'CB', 'LWB', 'RWB', 'DM', 'CM', 'AM', 'ST', 'ST'],
  '5-3-2': ['GK', 'LWB', 'CB', 'CB', 'CB', 'RWB', 'DM', 'CM', 'CM', 'ST', 'ST'],
  '5-2-3': ['GK', 'LWB', 'CB', 'CB', 'CB', 'RWB', 'CM', 'CM', 'LW', 'RW', 'ST'],
};

const BENCH_PRIORITY: Record<string, number> = {
  DEF: 0,
  MID: 1,
  ATT: 2,
  FLEX: 3,
};

function isPlayerEligibleForSlot(player: GaffaRosterPlayer, slot: string): boolean {
  const target = slot.trim().toUpperCase();
  if (player.primary_position.toUpperCase() === target) return true;
  return (player.secondary_positions ?? []).some((s) => s.toUpperCase() === target);
}

/**
 * Gaffa OOP rule: if a player's PRIMARY position is midfield/attack (DM, CM, AM, LW, RW, ST)
 * and he is fielded in a DEFENSIVE slot (CB, LB, RB, LWB, RWB), he takes a 20% penalty
 * to rating and points — even if also listed defensively. Does NOT apply in reverse.
 */
function hasOopPenalty(primaryPosition: string, targetSlot: string): boolean {
  const prim = primaryPosition.trim().toUpperCase();
  const slot = targetSlot.trim().toUpperCase();
  return MID_ATT_SLOTS.has(prim) && DEFENSIVE_SLOTS.has(slot);
}

export function buildDossierLookupMap(dossiers: PlayerProfile[] = []): Map<string, PlayerProfile> {
  const map = new Map<string, PlayerProfile>();
  for (const d of dossiers) {
    if (!d?.basicInfo?.name) continue;
    // Gaffa fields current players, so a prime card must never stand in for the live rating.
    if (isPrimeCard(d)) continue;
    const key = toBasePlayerSlug(d.basicInfo.name);
    const existing = map.get(key);
    // Several dated current cards can exist for one player. Keep the newest.
    if (existing && (getDossierEvaluationDate(existing) ?? '') > (getDossierEvaluationDate(d) ?? '')) {
      continue;
    }
    map.set(key, d);
  }
  return map;
}

export function lookupPlayerDossier(
  name: string,
  displayName: string | undefined,
  dossierMap: Map<string, PlayerProfile>,
): PlayerProfile | undefined {
  const byFull = dossierMap.get(toBasePlayerSlug(name));
  if (byFull) return byFull;
  if (displayName) {
    return dossierMap.get(toBasePlayerSlug(displayName));
  }
  return undefined;
}

interface AuditedStarterSlot {
  player_id: string;
  name: string;
  slot: string;
  primary_position: string;
  secondary_positions: string[];
  pl_team: string | null;
  status: string;
  eligible: boolean;
  oopPenalty: boolean;
  coveringBench: Array<{
    name: string;
    benchSlot: string;
    oopIfSubbed: boolean;
  }>;
  scoutOvr?: number;
  scoutPot?: number;
}

interface AuditedBenchSlot {
  player_id: string;
  name: string;
  benchSlot: string;
  primary_position: string;
  secondary_positions: string[];
  pl_team: string | null;
  coversStarterSlots: string[];
  scoutOvr?: number;
  scoutPot?: number;
}

interface FormationFeasibility {
  formation: string;
  canFillCleanly: boolean;
  missingSlots: string[];
}

interface GaffaLineupAuditResult {
  formation: string | null;
  gameweek: number | null;
  starters: AuditedStarterSlot[];
  bench: AuditedBenchSlot[];
  uncoveredSlots: string[];
  oopStarters: AuditedStarterSlot[];
  ineligibleStarters: AuditedStarterSlot[];
  feasibleFormations: FormationFeasibility[];
  heldPlayers: GaffaRosterPlayer[];
  activeBenchCount: number;
  rosterCap: number;
  irPlayers: GaffaRosterPlayer[];
  irCap: number;
  academyPlayers: GaffaRosterPlayer[];
  academyCap: number | null;
}

export function auditGaffaLineup(
  bag: GaffaContextBag,
  calibratedDossiers: PlayerProfile[] = [],
): GaffaLineupAuditResult {
  const roster = bag.roster ?? [];
  const rosterById = new Map<string, GaffaRosterPlayer>();
  const rosterByName = new Map<string, GaffaRosterPlayer>();
  for (const p of roster) {
    rosterById.set(p.player_id, p);
    rosterByName.set(p.name.toLowerCase(), p);
    if (p.display_name) rosterByName.set(p.display_name.toLowerCase(), p);
  }

  const dossierMap = buildDossierLookupMap(calibratedDossiers);

  const resolveRosterPlayer = (id: string, name: string): GaffaRosterPlayer | undefined =>
    rosterById.get(id) ?? rosterByName.get(name.toLowerCase());

  const rawBench = [...(bag.lineup?.bench ?? [])].sort((a, b) => {
    const pa = BENCH_PRIORITY[a.slot.toUpperCase()] ?? 99;
    const pb = BENCH_PRIORITY[b.slot.toUpperCase()] ?? 99;
    return pa - pb;
  });

  const auditedBench: AuditedBenchSlot[] = rawBench.map((b) => {
    const rp = resolveRosterPlayer(b.player_id, b.name);
    const prim = rp?.primary_position ?? b.slot;
    const sec = rp?.secondary_positions ?? [];
    const dossier = lookupPlayerDossier(b.name, rp?.display_name, dossierMap);
    const allPos = [prim, ...sec].map((s) => s.toUpperCase());
    return {
      player_id: b.player_id,
      name: b.name,
      benchSlot: b.slot,
      primary_position: prim,
      secondary_positions: sec,
      pl_team: rp?.pl_team ?? null,
      coversStarterSlots: [...new Set(allPos)],
      scoutOvr: dossier?.ratings?.overall,
      scoutPot: dossier?.ratings?.potential,
    };
  });

  const auditedStarters: AuditedStarterSlot[] = (bag.lineup?.starters ?? []).map((s) => {
    const rp = resolveRosterPlayer(s.player_id, s.name);
    const prim = rp?.primary_position ?? s.slot;
    const sec = rp?.secondary_positions ?? [];
    const eligible = rp ? isPlayerEligibleForSlot(rp, s.slot) : true;
    const oopPenalty = hasOopPenalty(prim, s.slot);
    const dossier = lookupPlayerDossier(s.name, rp?.display_name, dossierMap);

    const coveringBench = auditedBench
      .filter((b) => b.coversStarterSlots.includes(s.slot.toUpperCase()))
      .map((b) => ({
        name: b.name,
        benchSlot: b.benchSlot,
        oopIfSubbed: hasOopPenalty(b.primary_position, s.slot),
      }));

    return {
      player_id: s.player_id,
      name: s.name,
      slot: s.slot,
      primary_position: prim,
      secondary_positions: sec,
      pl_team: rp?.pl_team ?? null,
      status: rp?.status ?? 'active',
      eligible,
      oopPenalty,
      coveringBench,
      scoutOvr: dossier?.ratings?.overall,
      scoutPot: dossier?.ratings?.potential,
    };
  });

  const uncoveredSlots = [
    ...new Set(
      auditedStarters.filter((s) => s.coveringBench.length === 0).map((s) => s.slot),
    ),
  ];
  const oopStarters = auditedStarters.filter((s) => s.oopPenalty);
  const ineligibleStarters = auditedStarters.filter((s) => !s.eligible);

  // Greedy check of which formations the fieldable squad can fill with no OOP penalty.
  const fieldablePool = roster.filter((p) => FIELDABLE_STATUSES.has(p.status));

  const feasibleFormations: FormationFeasibility[] = Object.entries(GAFFA_FORMATIONS).map(
    ([formation, requiredSlots]) => {
      const usedIds = new Set<string>();
      const missingSlots: string[] = [];

      // Fill the scarcest slots (fewest eligible players) first.
      const slotsWithCandidates = requiredSlots.map((slot) => ({
        slot,
        candidates: fieldablePool.filter(
          (p) => isPlayerEligibleForSlot(p, slot) && !hasOopPenalty(p.primary_position, slot),
        ),
      }));
      slotsWithCandidates.sort((a, b) => a.candidates.length - b.candidates.length);

      for (const item of slotsWithCandidates) {
        const pick = item.candidates.find((c) => !usedIds.has(c.player_id));
        if (pick) {
          usedIds.add(pick.player_id);
        } else {
          missingSlots.push(item.slot);
        }
      }

      return {
        formation,
        canFillCleanly: missingSlots.length === 0,
        missingSlots,
      };
    },
  );

  const heldPlayers = heldPlayersOf(roster);
  const activeBenchCount = squadCountOf(roster);
  const irPlayers = roster.filter((p) => p.status === 'ir');
  const academyPlayers = roster.filter((p) => ACADEMY_STATUSES.has(p.status));

  return {
    formation: bag.lineup?.formation ?? null,
    gameweek: bag.lineup?.gameweek ?? bag.matchup?.gameweek ?? null,
    starters: auditedStarters,
    bench: auditedBench,
    uncoveredSlots,
    oopStarters,
    ineligibleStarters,
    feasibleFormations,
    heldPlayers,
    activeBenchCount,
    rosterCap: bag.settings?.roster_size ?? DEFAULT_ROSTER_CAP,
    irPlayers,
    irCap: bag.settings?.ir_size ?? 2,
    academyPlayers,
    academyCap: bag.settings?.taxi_size ?? 3,
  };
}

interface GaffaClubAlert {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  text: string;
  prompt?: string;
}

export function computeGaffaClubAlerts(
  bag: GaffaContextBag | undefined,
  calibratedDossiers: PlayerProfile[] = [],
): GaffaClubAlert[] {
  if (!bag?.connected) return [];
  const audit = auditGaffaLineup(bag, calibratedDossiers);
  const alerts: GaffaClubAlert[] = [];

  if (audit.heldPlayers.length > 0) {
    const names = audit.heldPlayers.map((p) => p.display_name || p.name).join(', ');
    alerts.push({
      id: 'held-lock',
      severity: 'critical',
      text: `Held player lock active (${names}) — bids, recalls, promotions, and net-in trades are frozen until resolved.`,
      prompt: `I have ${names} held on my roster. What is my cleanest move to resolve the held player lock without wasting value?`,
    });
  }

  if (audit.oopStarters.length > 0) {
    const summary = audit.oopStarters
      .map((s) => `${s.name} at ${s.slot} (primary ${s.primary_position})`)
      .join(', ');
    alerts.push({
      id: 'oop-penalty',
      severity: 'warning',
      text: `20% OOP penalty active in saved XI: ${summary}.`,
      prompt: `My saved XI has ${summary} taking a 20% out-of-position penalty. How should I adjust my formation or lineup?`,
    });
  }

  if (audit.uncoveredSlots.length > 0 && audit.starters.length > 0) {
    alerts.push({
      id: 'uncovered-slots',
      severity: 'warning',
      text: `No eligible bench auto-sub cover for ${audit.uncoveredSlots.join(', ')} in your saved XI.`,
      prompt: `Audit my saved XI and bench order — which starter slots lack auto-sub cover and how should I set my bench?`,
    });
  }

  if (audit.activeBenchCount >= audit.rosterCap) {
    alerts.push({
      id: 'roster-full',
      severity: 'info',
      text: `Active squad at capacity (${audit.activeBenchCount}/${audit.rosterCap}) — winning an auction requires nominating a drop (20% MV severance, min €2m).`,
      prompt: `My active squad is full (${audit.activeBenchCount}/${audit.rosterCap}). Who is my most expendable drop candidate if I bid on the market?`,
    });
  }

  return alerts;
}

export function formatLineupAuditPromptBlock(
  bag: GaffaContextBag,
  calibratedDossiers: PlayerProfile[] = [],
): string {
  if (!bag.connected) return '';
  const audit = auditGaffaLineup(bag, calibratedDossiers);

  const secondarySuffix = (positions: string[]) => (positions.length ? `/${positions.join(',')}` : '');
  const scoutTag = (slot: { scoutOvr?: number; scoutPot?: number }) =>
    slot.scoutOvr ? ` [Scout: ${slot.scoutOvr} OVR / ${slot.scoutPot} POT]` : '';

  const starterLines = audit.starters.map((s) => {
    const sec = secondarySuffix(s.secondary_positions);
    const oop = s.oopPenalty ? ' [20% OOP PENALTY — primary MID/ATT in defensive slot]' : '';
    const inelig = !s.eligible ? ' [INELIGIBLE FOR SLOT]' : '';
    const scout = scoutTag(s);
    const cover =
      s.coveringBench.length > 0
        ? `Auto-sub cover (in DEF→MID→ATT→FLEX order): ${s.coveringBench
            .map((c) => `${c.name} [${c.benchSlot}]${c.oopIfSubbed ? ' (20% OOP if subbed)' : ''}`)
            .join(' → ')}`
        : 'NO BENCH AUTO-SUB COVER';
    return `  - [${s.slot}] ${s.name} (primary ${s.primary_position}${sec}, ${s.pl_team ?? '?'})${scout}${oop}${inelig} | ${cover}`;
  });

  const benchLines = audit.bench.map((b) => {
    const sec = secondarySuffix(b.secondary_positions);
    const scout = scoutTag(b);
    return `  - [${b.benchSlot}] ${b.name} (${b.primary_position}${sec}, ${b.pl_team ?? '?'})${scout} → eligible for: ${b.coversStarterSlots.join(', ')}`;
  });

  const cleanFormations = audit.feasibleFormations
    .filter((f) => f.canFillCleanly)
    .map((f) => f.formation);

  return `<locked_lineup_audit>
Formation: ${audit.formation ?? 'unknown'}${audit.gameweek != null ? ` · GW${audit.gameweek}` : ''}
Squad capacity: ${audit.activeBenchCount}/${audit.rosterCap} active · IR ${audit.irPlayers.length}/${audit.irCap} · Academy ${audit.academyPlayers.length}/${audit.academyCap ?? '?'}
Held players locking market/lineup: ${audit.heldPlayers.map((p) => p.name).join(', ') || 'none'}
Starters with 20% OOP penalty: ${audit.oopStarters.map((s) => `${s.name} (${s.slot})`).join(', ') || 'none'}
Starter slots with ZERO eligible bench cover: ${audit.uncoveredSlots.join(', ') || 'none — all slots covered'}
Legal formations fillable cleanly (no OOP penalty) from current active/bench squad: ${cleanFormations.join(', ') || 'none without a positional gap'}

Starting XI & Auto-Sub Chain:
${starterLines.join('\n') || '  (empty)'}

Bench Order (checked strictly DEF → MID → ATT → FLEX):
${benchLines.join('\n') || '  (empty)'}
</locked_lineup_audit>`;
}

/**
 * Dynamically infer all Gaffa positional slots involved in a trade or player question
 * by checking named players in the bag and explicit positional mentions.
 */
export function inferInvolvedGaffaSlots(message: string, bag: GaffaContextBag): string[] {
  const slots = new Set<string>();
  const folded = foldPlayerName(message);

  // 1. Check any player from roster, listings, auctions, or free agents mentioned in the message
  const checkName = (name: string | undefined, pos: string, sec?: string[]) => {
    if (matchPlayerName(name, folded)) {
      if (pos) {
        pos
          .split(/[/,\s]+/)
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
          .forEach((s) => slots.add(s));
      }
      for (const sp of sec ?? []) {
        slots.add(sp.trim().toUpperCase());
      }
    }
  };

  for (const p of bag.roster ?? []) {
    checkName(p.name, p.primary_position, p.secondary_positions);
    checkName(p.display_name, p.primary_position, p.secondary_positions);
  }
  for (const l of bag.open_listings ?? []) {
    checkName(l.name, l.position);
  }
  for (const a of bag.open_auctions ?? []) {
    checkName(a.name, a.position);
  }
  for (const fa of bag.free_agents ?? []) {
    checkName(fa.name, fa.position);
    checkName(fa.display_name, fa.position);
  }

  // 2. Explicit slot tokens, then football words for a slot
  for (const slot of ALL_GAFFA_SLOTS) {
    if (new RegExp(`\\b${slot}\\b`, 'i').test(message)) {
      slots.add(slot);
    }
  }
  for (const [pattern, aliasSlots] of SLOT_ALIASES) {
    if (pattern.test(message)) aliasSlots.forEach((s) => slots.add(s));
  }

  if (slots.size === 0) {
    slots.add('ST');
  }

  return [...slots].slice(0, 4);
}

export function buildRosterCapacityNote(bag: GaffaContextBag): string {
  if (!bag.connected) return '';
  const roster = bag.roster ?? [];
  const held = heldPlayersOf(roster);
  const activeCount = squadCountOf(roster);
  const maxRoster = bag.settings?.roster_size ?? DEFAULT_ROSTER_CAP;

  if (held.length > 0) {
    return `Held lock active (${held.map((p) => p.name).join(', ')}) — net-in multi-player trades and bids are blocked until resolved.`;
  }
  if (activeCount >= maxRoster) {
    return `Squad full (${activeCount}/${maxRoster}) — a 2-for-1 incoming trade requires a prior drop (20% MV severance, min €2m).`;
  }
  return `Squad ${activeCount}/${maxRoster} (${maxRoster - activeCount} open slot${maxRoster - activeCount === 1 ? '' : 's'}).`;
}

/**
 * Deterministic Bid-Sizing, FA Floor, Scout's Fee (10% rebate), and Drop-Severance Calculator.
 */
export function buildGaffaBidValuationBlock(
  message: string,
  bag: GaffaContextBag,
  calibratedDossiers: PlayerProfile[] = [],
): string {
  if (!bag.connected) return '';
  const wantsBidMath =
    /\b(bid|nominate|open an? auction|how much|floor|scout'?s? fee|release clause|severance|drop|claim|buy|sign|acquire|worth)\b/i.test(
      message,
    );
  if (!wantsBidMath) return '';

  const floorRate = faBidFloorRate(bag);
  const dossierMap = buildDossierLookupMap(calibratedDossiers);
  const folded = foldPlayerName(message);

  type Candidate<T> = { item: T; name: string; level: NameMatch };
  const candidate = <T,>(item: T, name: string, ...aliases: Array<string | undefined>): Candidate<T> => {
    const levels = [name, ...aliases].map((n) => matchPlayerName(n, folded));
    const level = levels.includes('full') ? 'full' : levels.includes('surname') ? 'surname' : null;
    return { item, name, level };
  };
  const fa = (bag.free_agents ?? []).map((p) => candidate(p, p.name, p.display_name));
  const auctions = (bag.open_auctions ?? []).map((a) => candidate(a, a.name));
  const listings = (bag.open_listings ?? []).map((l) => candidate(l, l.name));

  // A full-name hit ("Reece James") outranks surname-only hits on other players ("Daniel James").
  const fullSurnames = new Set(
    [...fa, ...auctions, ...listings]
      .filter((m) => m.level === 'full')
      .map((m) => foldedSurname(m.name)),
  );
  const keep = <T,>(matches: Candidate<T>[]): T[] =>
    matches
      .filter(
        (m) =>
          m.level === 'full' ||
          (m.level === 'surname' && !fullSurnames.has(foldedSurname(m.name))),
      )
      .map((m) => m.item);

  const matchedFa: GaffaFreeAgent[] = keep(fa);
  const matchedAuctions: GaffaOpenAuction[] = keep(auctions);
  const matchedListings: GaffaOpenListing[] = keep(listings);

  if (
    matchedFa.length === 0 &&
    matchedAuctions.length === 0 &&
    matchedListings.length === 0 &&
    !/\b(bid|scout'?s? fee|fa floor|severance|release clause)\b/i.test(message)
  ) {
    return '';
  }

  const lines: string[] = [
    '<locked_bid_calculator>',
    `Club Balance: €${bag.budget_eur_m ?? 0}m · FA Floor Rule: ${Math.round(floorRate * 100)}% of MV (rounded down, min €1m) · Scout's Fee: 10% of winning FA bid to nominating manager (rebate if you win, cash payout if outbid).`,
    buildRosterCapacityNote(bag),
  ];

  for (const fa of matchedFa.slice(0, 4)) {
    const mv = fa.market_value_eur_m ?? 0;
    const openingFloor = openingFaFloor(mv, floorRate);
    const netAtFloor = Number((openingFloor * 0.9).toFixed(1));
    const dossier = lookupPlayerDossier(fa.name, fa.display_name, dossierMap);
    const scoutBit = dossier
      ? ` · Scout ${dossier.ratings.overall} OVR / ${dossier.ratings.potential} POT (${dossier.playstyleAndRole?.playstyle?.archetype ?? 'calibrated'})`
      : '';
    lines.push(
      `  - FA Target ${fa.name} (${fa.position}, ${fa.pl_team ?? '?'}${fa.age != null ? `, age ${fa.age}` : ''})${scoutBit}: MV €${mv}m → Opening FA floor €${openingFloor}m (if you nominate and win at €${openingFloor}m, 10% Scout's Fee rebate makes net cost €${netAtFloor}m; if outbid at €B, you receive €0.10×B). Status: ${fa.live_auction ? 'LIVE AUCTION OPEN' : 'Unowned (nominate to open auction)'}.`,
    );
  }

  for (const a of matchedAuctions.slice(0, 4)) {
    const high = a.highest_bid_eur_m ?? 0;
    const minNext = high + 1;
    lines.push(
      `  - Live Auction ${a.name} (${a.position}, kind=${a.kind}): current high bid €${high}m → minimum next bid €${minNext}m${a.expires_at ? ` · expires ${a.expires_at}` : ''}.`,
    );
  }

  for (const l of matchedListings.slice(0, 4)) {
    const prices = [
      l.min_bid_eur_m != null ? `min bid €${l.min_bid_eur_m}m` : null,
      l.ask_eur_m != null ? `asking €${l.ask_eur_m}m` : null,
      l.release_clause_eur_m != null ? `release clause €${l.release_clause_eur_m}m` : null,
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `  - Listed Target ${l.name} (${l.position}, seller: ${l.seller_club_name}${l.yours ? ' [YOURS]' : ''}): ${prices || 'no fixed price'}.`,
    );
  }

  lines.push('</locked_bid_calculator>');
  return lines.join('\n');
}
