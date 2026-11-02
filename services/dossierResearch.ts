import { getCurrentSeasonInfo } from './aiClient';
import { liveClubSnapshots, type SnapshotSource } from './clubSnapshots';
import { eraEntry, liveEraSnapshots, type EraSnapshotSource } from './eraSnapshots';
import { addEvidence, emptyLedger, formatLedger, seasonStartDate, type EvidenceLedger } from './evidenceLedger';
import {
  executeCall,
  fileOutcomes,
  liveToolset,
  type ResearchCall,
  type ResearchToolset,
  type ToolOutcome,
} from './researchTools';
import { applyStory, deriveClubCore, formatClubSituation } from './situationSnapshot';

/**
 * The facts a dossier is rated from, gathered with the chat research's tools and filed in an
 * evidence ledger, so a card reads the same live feeds and history routes a chat answer does and
 * knows which lookups came back empty. A current card reads the player's live season record, his
 * club's recent XIs (worked into a first-choice XI, with the club's stored snapshot story when
 * there is one) and the web searches; a past version reads his career record, the web search, and
 * a stored era snapshot for a requested season. No model call beyond the searches, and nothing is
 * built: snapshots are read only when someone has already stored them.
 */

export interface DossierResearchDeps {
  tools: ResearchToolset;
  clubSnapshots: Pick<SnapshotSource, 'stored'>;
  eraSnapshots: Pick<EraSnapshotSource, 'stored'>;
}

export const liveDossierResearch = (): DossierResearchDeps => ({
  tools: liveToolset([]),
  clubSnapshots: liveClubSnapshots,
  eraSnapshots: liveEraSnapshots,
});

export interface DossierResearch {
  ledger: EvidenceLedger;
  /** The club's situation from its live data (first-choice XI, absences, form), or empty. */
  clubSituation: string;
  /** The club the live season record or the registered club put him at. */
  club: string | null;
}

/**
 * The searches take about 9 s; a live lookup still running when they finish gets this much longer,
 * then is filed as too slow, so the feeds never hold a card back.
 */
export const LIVE_GRACE_MS = 2_000;

const TOO_SLOW: ToolOutcome = { status: 'failed', result: null, missing: [], note: 'too slow for this card' };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The promise's value if it settles before `deadline`, else `fallback`. */
const byDeadline = <T>(p: Promise<T>, deadline: Promise<void>, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), deadline.then(() => fallback)]);

/** The ledger as the synthesis prompt's <factual_foundation> reads it, with the club's situation first. */
export function formatDossierResearch(research: DossierResearch, options: { current: boolean }): string {
  const { seasonStartYear } = getCurrentSeasonInfo();
  const ledger = formatLedger(research.ledger, options.current ? { seasonStart: seasonStartDate(seasonStartYear) } : {});
  return [
    research.clubSituation &&
      `[CLUB SITUATION — worked out in code from the live club data below: who has started where]\n${research.clubSituation}`,
    ledger,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** A current card's facts: his live season, his club's live data and situation, and the searches. */
export async function researchCurrentPlayer(args: {
  name: string;
  searches: string[];
  /** The club API-Football registers him at, used when no live season record names one. */
  registeredClub: Promise<string | null>;
  deps?: DossierResearchDeps;
  graceMs?: number;
}): Promise<DossierResearch> {
  const deps = args.deps ?? liveDossierResearch();
  const playerCall: ResearchCall = { tool: 'player_season', subject: args.name };
  const searchCalls: ResearchCall[] = args.searches.map((subject) => ({ tool: 'web_search', subject }));

  const player = executeCall(playerCall, deps.tools);
  const clubName = player.then(async (o) => o.result?.team ?? (await args.registeredClub.catch(() => null)) ?? null);
  const club = clubName.then((name) => (name ? executeCall({ tool: 'club_recent_team', subject: name }, deps.tools) : null));
  const snapshot = clubName.then((name) =>
    name ? deps.clubSnapshots.stored(name, club.then((o) => o ?? TOO_SLOW)).catch(() => null) : null,
  );
  const searches = await Promise.all(searchCalls.map((c) => executeCall(c, deps.tools)));

  const deadline = sleep(args.graceMs ?? LIVE_GRACE_MS);
  const [playerOutcome, name, clubOutcome, stored] = await Promise.all([
    byDeadline(player, deadline, TOO_SLOW),
    byDeadline(clubName, deadline, null),
    byDeadline<ToolOutcome | null | undefined>(club, deadline, undefined),
    byDeadline(snapshot, deadline, null),
  ]);

  const calls: ResearchCall[] = [playerCall];
  const outcomes: ToolOutcome[] = [playerOutcome];
  if (name) {
    calls.push({ tool: 'club_recent_team', subject: name });
    outcomes.push(clubOutcome ?? TOO_SLOW);
  }
  const ledger = fileOutcomes(emptyLedger(), [...calls, ...searchCalls], [...outcomes, ...searches]);

  const report = clubOutcome?.result?.club;
  return {
    ledger,
    clubSituation: report ? formatClubSituation(applyStory(deriveClubCore(report), stored?.story)) : '',
    club: report?.team ?? name ?? null,
  };
}

/** A past version's facts: his career record, the search, and a requested season's stored era snapshot. */
export async function researchPastPlayer(args: {
  name: string;
  search: string;
  season?: string | null;
  deps?: DossierResearchDeps;
  graceMs?: number;
}): Promise<DossierResearch> {
  const deps = args.deps ?? liveDossierResearch();
  const careerCall: ResearchCall = { tool: 'player_career', subject: args.name, ...(args.season ? { season: args.season } : {}) };
  const searchCall: ResearchCall = { tool: 'web_search', subject: args.search };

  const career = executeCall(careerCall, deps.tools);
  const snapshot = args.season
    ? deps.eraSnapshots.stored({ kind: 'player_window', subject: args.name, period: args.season, facts: career }).catch(() => null)
    : Promise.resolve(null);
  const search = await executeCall(searchCall, deps.tools);

  const deadline = sleep(args.graceMs ?? LIVE_GRACE_MS);
  const [careerOutcome, stored] = await Promise.all([byDeadline(career, deadline, TOO_SLOW), byDeadline(snapshot, deadline, null)]);

  let ledger = fileOutcomes(emptyLedger(), [careerCall, searchCall], [careerOutcome, search]);
  if (stored) ledger = addEvidence(ledger, eraEntry(stored));
  return { ledger, clubSituation: '', club: null };
}
