export interface ManagerVerificationContext {
  verifiedFacts: string[];
  supplementalCorpus?: string[];
  currentHeadCoach: string | null;
  /** Club the verified coach manages; lets the stale-name scrub use the live coach for that club. */
  currentClub?: string | null;
}

export interface KnownClubManager {
  currentCoach: string;
  /** Lowercase names the club goes by in prose; the stale-name scrub only runs when one appears. */
  aliases: string[];
  /**
   * Recent former coaches a model might still cite as current. Full names only — bare surnames
   * like "Xavi" or "Slot" collide with players and ordinary words.
   */
  stale: string[];
}

/**
 * Hand-verified coach overrides for clubs where API-Football or model memory lags.
 * This is a stopgap, not a source of truth: every entry stops applying once the table is older
 * than KNOWN_CLUB_MANAGERS_MAX_AGE_DAYS, so a forgotten table fails open to live data instead
 * of injecting wrong names. Re-verify all entries and bump the date together.
 */
export const KNOWN_CLUB_MANAGERS_VERIFIED_ON = '2026-10-25';
const KNOWN_CLUB_MANAGERS_MAX_AGE_DAYS = 120;

export const KNOWN_CLUB_MANAGERS: Record<string, KnownClubManager> = {
  Chelsea: {
    currentCoach: 'Xabi Alonso',
    aliases: ['chelsea'],
    stale: ['Liam Rosenior', 'Mauricio Pochettino', 'Graham Potter', 'Frank Lampard'],
  },
  'Manchester City': {
    currentCoach: 'Enzo Maresca',
    aliases: ['manchester city', 'man city'],
    stale: [],
  },
  Liverpool: {
    currentCoach: 'Andoni Iraola',
    aliases: ['liverpool'],
    stale: ['Arne Slot'],
  },
  'Manchester United': {
    currentCoach: 'Michael Carrick',
    aliases: ['manchester united', 'man utd', 'man united'],
    stale: ['Ruben Amorim', 'Rúben Amorim', 'Erik ten Hag'],
  },
  'FC Barcelona': {
    currentCoach: 'Hansi Flick',
    aliases: ['barcelona', 'barça', 'barca'],
    stale: ['Xavi Hernandez', 'Xavi Hernández'],
  },
  'Bayern Munich': {
    currentCoach: 'Vincent Kompany',
    aliases: ['bayern'],
    stale: ['Thomas Tuchel', 'Julian Nagelsmann'],
  },
  Juventus: {
    currentCoach: 'Luciano Spalletti',
    aliases: ['juventus', 'juve'],
    stale: ['Igor Tudor', 'Thiago Motta'],
  },
  Napoli: {
    currentCoach: 'Massimiliano Allegri',
    aliases: ['napoli'],
    stale: ['Antonio Conte'],
  },
  Brighton: {
    currentCoach: 'Fabian Hürzeler',
    aliases: ['brighton'],
    stale: ['Roberto De Zerbi'],
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;

const KNOWN_CLUB_MANAGERS_VERIFIED_MS = Date.parse(`${KNOWN_CLUB_MANAGERS_VERIFIED_ON}T00:00:00Z`);

/** Whole days until the table expires; zero or negative once it has. */
export function daysUntilKnownClubManagersTableExpires(now: Date = new Date()): number {
  const expiresMs = KNOWN_CLUB_MANAGERS_VERIFIED_MS + KNOWN_CLUB_MANAGERS_MAX_AGE_DAYS * DAY_MS;
  return Math.floor((expiresMs - now.getTime()) / DAY_MS);
}

/** False once the hand-verified table is too old to trust; callers then defer to live data. */
export function isKnownClubManagersTableFresh(now: Date = new Date()): boolean {
  return now.getTime() - KNOWN_CLUB_MANAGERS_VERIFIED_MS <= KNOWN_CLUB_MANAGERS_MAX_AGE_DAYS * DAY_MS;
}

export interface CurrentCoachRecord {
  coach: string | null;
  /** Start date (YYYY-MM-DD) of the coach's open stint at the team, when API-Football has one. */
  coachSince: string | null;
}

/**
 * Picks a team's current head coach from an API-Football `/coachs?team=<id>` response. The
 * response lists every coach who ever managed the team, so take the open stint (`end === null`)
 * at this team with the latest start; fall back to the first entry, undated, when none is open.
 */
export function pickCurrentCoach(coaches: unknown, teamId: number): CurrentCoachRecord {
  const list: any[] = Array.isArray(coaches) ? coaches : [];
  let best: { coach: any; since: string | null; sinceMs: number } | null = null;
  for (const coach of list) {
    if (!Array.isArray(coach?.career)) continue;
    for (const stint of coach.career) {
      if (stint?.team?.id !== teamId || stint?.end !== null) continue;
      const since = typeof stint.start === 'string' ? stint.start.slice(0, 10) : null;
      const parsed = since ? Date.parse(since) : NaN;
      const sinceMs = Number.isNaN(parsed) ? -Infinity : parsed;
      if (!best || sinceMs > best.sinceMs) best = { coach, since, sinceMs };
    }
  }
  const chosen = best?.coach ?? list[0];
  if (!chosen?.name) return { coach: null, coachSince: null };
  return {
    coach:
      chosen.firstname && chosen.lastname
        ? `${chosen.firstname} ${chosen.lastname}`
        : String(chosen.name),
    coachSince: best?.since ?? null,
  };
}

/** Never rewrite a name that is some listed club's current coach (e.g. a coach who moved clubs). */
const CURRENT_COACHES_LOWER = new Set(
  Object.values(KNOWN_CLUB_MANAGERS).map((m) => m.currentCoach.toLowerCase()),
);

const normalizeClubKey = (club: string): string =>
  club.toLowerCase().replace(/\bfc\b/g, '').replace(/\s+/g, ' ').trim();

const findKnownClubManager = (club: string): KnownClubManager | undefined => {
  const key = normalizeClubKey(club);
  return Object.entries(KNOWN_CLUB_MANAGERS).find(
    ([name, entry]) => normalizeClubKey(name) === key || entry.aliases.includes(key),
  )?.[1];
};

const coachNamesMatch = (a: string, b: string): boolean => {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  return aLower.includes(bLower) || bLower.includes(aLower);
};

/**
 * Corrects a club's head-coach record (e.g. from API-Football, which lags managerial changes)
 * when the club is listed in KNOWN_CLUB_MANAGERS. Live data wins unless the record is missing,
 * names a known former coach, or started its stint (`coachSince`) before the table was verified
 * — a coach appointed after that date is newer than the table. Unlisted clubs, and every club
 * once the table has expired, pass through untouched.
 */
export function correctStaleCoachRecord(
  club: string | null | undefined,
  coach: string | null | undefined,
  coachSince: string | null | undefined = null,
  now: Date = new Date(),
): string | null {
  const entry = club && isKnownClubManagersTableFresh(now) ? findKnownClubManager(club) : undefined;
  if (!entry) return coach ?? null;
  if (!coach) return entry.currentCoach;
  const coachLower = coach.toLowerCase();
  if (entry.stale.some((name) => coachLower.includes(name.toLowerCase()))) return entry.currentCoach;
  if (coachNamesMatch(coach, entry.currentCoach)) return coach;
  const sinceMs = coachSince ? Date.parse(coachSince.slice(0, 10)) : NaN;
  return !Number.isNaN(sinceMs) && sinceMs < KNOWN_CLUB_MANAGERS_VERIFIED_MS
    ? entry.currentCoach
    : coach;
}

/** One prompt line listing the verified current coaches, or '' once the table has expired. */
export function formatKnownClubManagersForPrompt(now: Date = new Date()): string {
  if (!isKnownClubManagersTableFresh(now)) return '';
  const pairs = Object.entries(KNOWN_CLUB_MANAGERS)
    .map(([club, { currentCoach }]) => `${club} — ${currentCoach}`)
    .join('; ');
  return `Verified current head coaches (as of ${KNOWN_CLUB_MANAGERS_VERIFIED_ON}): ${pairs}.`;
}

/**
 * Rewrites "under [former coach]" / "[former coach]'s system"-style attributions to the club's
 * current coach — the turn's verified coach when `verified` names this club, else the table's.
 * Only runs for clubs the text actually mentions, skips anyone who currently coaches a listed
 * club or the verified club, and does nothing once the table has expired.
 */
export function scrubKnownStaleManagers(
  text: string,
  now: Date = new Date(),
  verified?: { club?: string | null; coach?: string | null },
): string {
  if (!text || !isKnownClubManagersTableFresh(now)) return text;
  const lowerText = text.toLowerCase();
  const verifiedCoach = verified?.coach?.trim() || null;
  const verifiedEntry =
    verifiedCoach && verified?.club ? findKnownClubManager(verified.club) : undefined;
  let result = text;

  for (const entry of Object.values(KNOWN_CLUB_MANAGERS)) {
    const { aliases, stale } = entry;
    if (!aliases.some((alias) => lowerText.includes(alias))) continue;
    // A verified coach the table lists as this club's former coach loses, as in correctStaleCoachRecord.
    const useVerified =
      entry === verifiedEntry &&
      verifiedCoach !== null &&
      !stale.some((name) => coachNamesMatch(name, verifiedCoach));
    const currentCoach = useVerified && verifiedCoach ? verifiedCoach : entry.currentCoach;
    for (const staleName of stale) {
      if (CURRENT_COACHES_LOWER.has(staleName.toLowerCase())) continue;
      // Nor a former coach the turn verified at another club (e.g. Pochettino coaching elsewhere).
      if (verifiedCoach && verified?.club && entry !== verifiedEntry && coachNamesMatch(staleName, verifiedCoach)) {
        continue;
      }
      const escaped = staleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // 1. "Under [Stale]" -> "Under [CurrentCoach]"
      result = result.replace(
        new RegExp(`\\b(under)\\s+(?:manager\\s+|head\\s+coach\\s+|coach\\s+)?${escaped}\\b`, 'gi'),
        (_match, prefix: string) => `${prefix[0] === 'U' ? 'Under' : 'under'} ${currentCoach}`,
      );

      // 2. "[Stale]'s" -> "[CurrentCoach]'s"
      result = result.replace(new RegExp(`\\b${escaped}['’]s\\b`, 'gi'), `${currentCoach}'s`);

      // 3. "[Stale] deploys / uses / fields" -> "[CurrentCoach] deploys / uses / fields"
      result = result.replace(
        new RegExp(
          `\\b${escaped}\\s+(deploys|uses|fields|plays|favours|favors|prefers|relies on)\\b`,
          'gi',
        ),
        (_match, verb) => `${currentCoach} ${verb}`,
      );

      // 4. "managed by [Stale]" / "coached by [Stale]" -> "managed by [CurrentCoach]"
      result = result.replace(
        new RegExp(`\\b(managed by|coached by)\\s+${escaped}\\b`, 'gi'),
        (_match, prefix) => `${prefix} ${currentCoach}`,
      );
    }
  }

  return result;
}

const UNDER_MANAGER_PATTERN =
  /\b(under|managed by|coached by)\s+(?:manager\s+|head\s+coach\s+|coach\s+)?([A-Z][a-zA-ZÀ-ÿ'’-]+(?:\s+[A-Z][a-zA-ZÀ-ÿ'’-]+){0,2})/gi;

const POSSESSIVE_MANAGER_PATTERN =
  /\b([A-Z][a-zA-ZÀ-ÿ'’-]+(?:\s+[A-Z][a-zA-ZÀ-ÿ'’-]+)?)['’]s\s+(?:(?:attacking|defensive|tactical|high-pressing|positional)\s+)?(?:rotation|system|setup|approach|tactics|side|structure|philosophy|regime)\b/gi;

const NON_MANAGER_PHRASES = new Set([
  'in',
  'at',
  'for',
  'with',
  'from',
  'by',
  'on',
  'into',
  'during',
  'after',
  'before',
  'through',
  'pressure',
  'scrutiny',
  'champions',
  'league',
  'champions league',
  'premier league',
  'la liga',
  'serie a',
  'bundesliga',
  'ligue 1',
  'europa league',
  'conference league',
  'world cup',
  'copa america',
  'euros',
  'uefa',
  'fifa',
  'conmebol',
  'europe',
  'european',
  'english',
  'spanish',
  'italian',
  'german',
  'french',
  'club',
  'team',
  'squad',
  'opponent',
  'opposition',
  'manager',
  'coach',
  'today',
  'modern',
  'current',
  'previous',
  'former',
  'new',
  'his',
  'their',
  'our',
  'its',
  'the',
  'this',
  'that',
  'arsenal',
  'chelsea',
  'liverpool',
  'manchester city',
  'man city',
  'manchester united',
  'man utd',
  'tottenham',
  'tottenham hotspur',
  'spurs',
  'newcastle',
  'newcastle united',
  'aston villa',
  'brighton',
  'real madrid',
  'barcelona',
  'fc barcelona',
  'atletico madrid',
  'atlético madrid',
  'bayern munich',
  'bayern',
  'borussia dortmund',
  'dortmund',
  'bayer leverkusen',
  'leverkusen',
  'paris saint-germain',
  'psg',
  'inter milan',
  'inter',
  'ac milan',
  'milan',
  'juventus',
  'napoli',
  'benfica',
  'porto',
  'sporting',
  'ajax',
]);

const LEADING_PREPOSITION_REGEX =
  /^(?:in|at|for|with|from|by|on|under|over|through|during|after|before)\s+/i;

/**
 * Strips a leading preposition and keeps only the leading capitalized words. The name patterns
 * are case-insensitive, so "under Mauricio Pochettino at the club" captures "Mauricio Pochettino
 * at the" — without trimming, that never reads as a person and slips past verification.
 */
function cleanCandidateName(candidate: string): string {
  const tokens = candidate.replace(LEADING_PREPOSITION_REGEX, '').trim().split(/\s+/);
  const end = tokens.findIndex((t) => !/^[A-ZÀ-ÖØ-Þ]/.test(t));
  return tokens.slice(0, end === -1 ? tokens.length : end).join(' ');
}

function isLikelyPersonName(candidate: string): boolean {
  const cleaned = cleanCandidateName(candidate);
  if (!cleaned || cleaned.length < 3) return false;
  const lower = cleaned.toLowerCase();
  if (NON_MANAGER_PHRASES.has(lower)) return false;
  for (const phrase of NON_MANAGER_PHRASES) {
    if (phrase.includes(' ') && lower.includes(phrase)) return false;
  }
  // Must start with an uppercase letter
  if (!/^[A-ZÀ-ÖØ-Þ]/.test(cleaned)) return false;
  const tokens = cleaned.split(/\s+/);
  if (tokens.some((t) => NON_MANAGER_PHRASES.has(t.toLowerCase()))) return false;
  return true;
}

function collectManagerMentions(text: string): string[] {
  const mentions: string[] = [];
  for (const match of text.matchAll(UNDER_MANAGER_PATTERN)) {
    const rawName = match[2];
    if (rawName && isLikelyPersonName(rawName)) {
      mentions.push(cleanCandidateName(rawName));
    }
  }
  for (const match of text.matchAll(POSSESSIVE_MANAGER_PATTERN)) {
    const rawName = match[1];
    if (rawName && isLikelyPersonName(rawName)) {
      mentions.push(cleanCandidateName(rawName));
    }
  }
  return mentions;
}

function verificationCorpus(ctx: ManagerVerificationContext): string {
  return [...ctx.verifiedFacts, ...(ctx.supplementalCorpus ?? []), ctx.currentHeadCoach ?? '']
    .join(' ')
    .toLowerCase();
}

function isNameVerified(name: string, corpus: string): boolean {
  const normalized = name.toLowerCase();
  if (corpus.includes(normalized)) return true;
  const lastName = normalized.split(/\s+/).at(-1);
  return lastName && lastName.length >= 4 ? corpus.includes(lastName) : false;
}

/** Head-coach names in prose must be search-verified — shared by Futbolpedia profiles and Gaffa outlooks. */
export function findUnverifiedManagerMentions(
  text: string,
  ctx: ManagerVerificationContext,
): string[] {
  const corpus = verificationCorpus(ctx);
  const verifiedCoach = ctx.currentHeadCoach?.trim() ?? null;
  const issues: string[] = [];

  for (const mentioned of collectManagerMentions(text)) {
    if (verifiedCoach) {
      const verifiedLower = verifiedCoach.toLowerCase();
      const mentionedLower = mentioned.toLowerCase();
      if (mentionedLower === verifiedLower || verifiedLower.includes(mentionedLower)) {
        continue;
      }
      if (isNameVerified(mentioned, corpus)) continue;
      issues.push(
        `manager "${mentioned}" conflicts with verified head coach "${verifiedCoach}"`,
      );
      continue;
    }

    if (!isNameVerified(mentioned, corpus)) {
      issues.push(`manager "${mentioned}" not verified in extraction`);
    }
  }

  return issues;
}

/**
 * Surgically replaces unverified manager attributions in prose ("under [Name]" -> "in the current setup",
 * "[Name]'s system" -> "the team's system") so unverified coach names never reach the user and never
 * require a second full LLM synthesis call.
 */
export function scrubUnverifiedManagerText(
  text: string,
  ctx: ManagerVerificationContext,
): string {
  if (!text) return text;

  // 1. First, scrub any known stale / sacked managers across major clubs
  let out = scrubKnownStaleManagers(text, new Date(), {
    club: ctx.currentClub,
    coach: ctx.currentHeadCoach,
  });

  const corpus = verificationCorpus(ctx);
  const verifiedCoach = ctx.currentHeadCoach?.trim() ?? null;

  const isAllowed = (mentioned: string): boolean => {
    const cleaned = cleanCandidateName(mentioned);
    if (!isLikelyPersonName(cleaned)) return true;
    if (verifiedCoach) {
      const verifiedLower = verifiedCoach.toLowerCase();
      const mentionedLower = cleaned.toLowerCase();
      if (mentionedLower === verifiedLower || verifiedLower.includes(mentionedLower)) {
        return true;
      }
    }
    return isNameVerified(cleaned, corpus);
  };

  out = out.replace(
    /\b(under|managed by|coached by)\s+(?:manager\s+|head\s+coach\s+|coach\s+)?([A-Z][a-zA-ZÀ-ÿ'’-]+(?:\s+[A-Z][a-zA-ZÀ-ÿ'’-]+){0,2})/gi,
    (fullMatch, prefix: string, name: string) => {
      const cleaned = cleanCandidateName(name);
      if (isAllowed(cleaned)) return fullMatch;
      // Keep any lowercase words the case-insensitive capture swallowed after the name.
      const tail = cleaned ? name.slice(name.indexOf(cleaned) + cleaned.length) : '';
      const isCapital = prefix[0] === prefix[0].toUpperCase();
      const isUnder = prefix.toLowerCase() === 'under';
      if (isUnder) {
        const p = isCapital ? 'Under' : 'under';
        return (verifiedCoach ? `${p} ${verifiedCoach}` : (isCapital ? 'In the current tactical setup' : 'in the current tactical setup')) + tail;
      }
      return (verifiedCoach ? `${prefix} ${verifiedCoach}` : 'in the current tactical setup') + tail;
    },
  );

  out = out.replace(
    /\b([A-Z][a-zA-ZÀ-ÿ'’-]+(?:\s+[A-Z][a-zA-ZÀ-ÿ'’-]+)?)['’]s\s+((?:(?:attacking|defensive|tactical|high-pressing|positional)\s+)?(?:rotation|system|setup|approach|tactics|side|structure|philosophy|regime))\b/gi,
    (fullMatch, name: string, rest: string) => {
      const cleaned = cleanCandidateName(name);
      if (isAllowed(cleaned)) return fullMatch;
      return verifiedCoach ? `${verifiedCoach}'s ${rest}` : `the team's ${rest}`;
    },
  );

  return out;
}
