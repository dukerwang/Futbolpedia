export interface ManagerVerificationContext {
  verifiedFacts: string[];
  supplementalCorpus?: string[];
  currentHeadCoach: string | null;
}

export const KNOWN_STALE_CLUB_MANAGERS: Record<string, { currentCoach: string; stale: string[] }> = {
  Chelsea: {
    currentCoach: 'Xabi Alonso',
    stale: [
      'Enzo Maresca',
      'Maresca',
      'Mauricio Pochettino',
      'Pochettino',
      'Graham Potter',
      'Potter',
      'Frank Lampard',
      'Lampard',
      'Thomas Tuchel',
      'Tuchel',
    ],
  },
  Liverpool: {
    currentCoach: 'Arne Slot',
    stale: ['Jürgen Klopp', 'Jurgen Klopp', 'Klopp'],
  },
  'Manchester United': {
    currentCoach: 'Ruben Amorim',
    stale: ['Erik ten Hag', 'Ten Hag', 'Ole Gunnar Solskjaer'],
  },
  'FC Barcelona': {
    currentCoach: 'Hansi Flick',
    stale: ['Xavi Hernandez', 'Xavi'],
  },
  'Bayern Munich': {
    currentCoach: 'Vincent Kompany',
    stale: ['Thomas Tuchel', 'Julian Nagelsmann'],
  },
  Juventus: {
    currentCoach: 'Thiago Motta',
    stale: ['Massimiliano Allegri', 'Allegri'],
  },
  Napoli: {
    currentCoach: 'Antonio Conte',
    stale: ['Walter Mazzarri', 'Rudi Garcia', 'Luciano Spalletti'],
  },
  Brighton: {
    currentCoach: 'Fabian Hürzeler',
    stale: ['Roberto De Zerbi', 'De Zerbi', 'Graham Potter'],
  },
};

const normalizeClubKey = (club: string): string =>
  club.toLowerCase().replace(/\bfc\b/g, '').replace(/\s+/g, ' ').trim();

/**
 * Corrects a club's head-coach record (e.g. from API-Football, which lags managerial changes)
 * when the club is listed in KNOWN_STALE_CLUB_MANAGERS and the record is missing or names a
 * known former coach. Coaches of unlisted clubs pass through untouched.
 */
export function correctStaleCoachRecord(
  club: string | null | undefined,
  coach: string | null | undefined,
): string | null {
  const clubKey = club ? normalizeClubKey(club) : '';
  const entry = clubKey
    ? Object.entries(KNOWN_STALE_CLUB_MANAGERS).find(
        ([name]) => normalizeClubKey(name) === clubKey,
      )?.[1]
    : undefined;
  if (!entry) return coach ?? null;
  const coachLower = coach?.toLowerCase() ?? '';
  const isStale = entry.stale.some((name) => coachLower.includes(name.toLowerCase()));
  return !coach || isStale ? entry.currentCoach : coach;
}

export function scrubKnownStaleManagers(text: string): string {
  if (!text) return text;
  let result = text;

  for (const [, { currentCoach, stale }] of Object.entries(KNOWN_STALE_CLUB_MANAGERS)) {
    for (const staleName of stale) {
      const escaped = staleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // 1. "Under [Stale]" -> "Under [CurrentCoach]"
      result = result.replace(
        new RegExp(`\\b(under)\\s+(?:manager\\s+|head\\s+coach\\s+|coach\\s+)?${escaped}\\b`, 'gi'),
        (match, prefix: string) => {
          const isCapital = prefix[0] === prefix[0].toUpperCase();
          const p = isCapital ? 'Under' : 'under';
          return `${p} ${currentCoach}`;
        },
      );

      // 2. "[Stale]'s" -> "[CurrentCoach]'s"
      result = result.replace(
        new RegExp(`\\b${escaped}['’]s\\b`, 'gi'),
        `${currentCoach}'s`,
      );

      // 3. "[Stale] deploys / uses / fields" -> "[CurrentCoach] deploys / uses / fields"
      result = result.replace(
        new RegExp(
          `\\b${escaped}\\s+(deploys|uses|fields|plays|favours|favors|prefers|relies on)\\b`,
          'gi',
        ),
        (match, verb) => `${currentCoach} ${verb}`,
      );

      // 4. "managed by [Stale]" / "coached by [Stale]" -> "managed by [CurrentCoach]"
      result = result.replace(
        new RegExp(`\\b(managed by|coached by)\\s+${escaped}\\b`, 'gi'),
        (match, prefix) => `${prefix} ${currentCoach}`,
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

function cleanCandidateName(candidate: string): string {
  return candidate.replace(LEADING_PREPOSITION_REGEX, '').trim();
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
  let out = scrubKnownStaleManagers(text);

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
      const isCapital = prefix[0] === prefix[0].toUpperCase();
      const isUnder = prefix.toLowerCase() === 'under';
      if (isUnder) {
        const p = isCapital ? 'Under' : 'under';
        return verifiedCoach ? `${p} ${verifiedCoach}` : (isCapital ? 'In the current tactical setup' : 'in the current tactical setup');
      }
      return verifiedCoach ? `${prefix} ${verifiedCoach}` : 'in the current tactical setup';
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
