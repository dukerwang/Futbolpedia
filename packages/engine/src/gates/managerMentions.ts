/** A club's verified current head coach, from the app's live manager lookup. */
export interface VerifiedClubManager {
  club: string;
  coach: string;
  /** Immediate predecessor; prose attributing the club to this name is rewritten to `coach`. */
  previousCoach?: string | null;
}

export interface ManagerVerificationContext {
  verifiedFacts: string[];
  supplementalCorpus?: string[];
  currentHeadCoach: string | null;
  /** Club the verified coach manages. */
  currentClub?: string | null;
  /** Verified coaches for every club in play this turn (the dossier's club, or the clubs a chat turn is about). */
  clubManagers?: VerifiedClubManager[];
  /**
   * Only `currentHeadCoach` may be named (nobody, when it is null), even if another name appears
   * in the grounding text. Search results often mention a sacked coach ("X replaced Y"), which
   * would otherwise count as verified. Used for dossier cards, which are about one club.
   */
  strictCurrentCoach?: boolean;
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

const foldName = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * True when two coach names refer to the same person: equal after folding accents, or one is
 * the other's full name ("Xabi Alonso" / "Alonso", "Rúben Amorim" / "Ruben Amorim").
 */
export function sameCoach(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = foldName(a);
  const y = foldName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  return shorter.length >= 4 && new RegExp(`(^| )${shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(longer);
}

const clubMentionNames = (club: string): string[] => {
  const name = foldName(club).replace(/\b(fc|cf|afc)\b/g, '').replace(/\s+/g, ' ').trim();
  return name ? [name] : [];
};

/**
 * Rewrites "under [previous coach]" / "[previous coach]'s system"-style attributions to the
 * club's verified current coach. Only runs for clubs the text names, and never rewrites anyone
 * who currently coaches one of the given clubs (a coach who moved, like a former Chelsea coach
 * now at Manchester City).
 */
export function scrubFormerCoaches(text: string, managers: VerifiedClubManager[] = []): string {
  if (!text || managers.length === 0) return text;
  const foldedText = foldName(text);
  let result = text;

  for (const { club, coach, previousCoach } of managers) {
    if (!previousCoach || !coach) continue;
    if (!clubMentionNames(club).some((name) => foldedText.includes(name))) continue;
    if (managers.some((m) => sameCoach(m.coach, previousCoach))) continue;
    const escaped = previousCoach.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 1. "Under [Previous]" -> "Under [Coach]"
    result = result.replace(
      new RegExp(`\\b(under)\\s+(?:manager\\s+|head\\s+coach\\s+|coach\\s+)?${escaped}\\b`, 'gi'),
      (_match, prefix: string) => `${prefix[0] === 'U' ? 'Under' : 'under'} ${coach}`,
    );

    // 2. "[Previous]'s" -> "[Coach]'s"
    result = result.replace(new RegExp(`\\b${escaped}['’]s\\b`, 'gi'), `${coach}'s`);

    // 3. "[Previous] deploys / uses / fields" -> "[Coach] deploys / uses / fields"
    result = result.replace(
      new RegExp(
        `\\b${escaped}\\s+(deploys|uses|fields|plays|favours|favors|prefers|relies on)\\b`,
        'gi',
      ),
      (_match, verb) => `${coach} ${verb}`,
    );

    // 4. "managed by [Previous]" / "coached by [Previous]" -> "managed by [Coach]"
    result = result.replace(
      new RegExp(`\\b(managed by|coached by)\\s+${escaped}\\b`, 'gi'),
      (_match, prefix) => `${prefix} ${coach}`,
    );
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
 * Strips a leading preposition and keeps the first run of capitalized words. The name patterns
 * are case-insensitive, so they also capture surrounding lowercase words: "under Mauricio
 * Pochettino at the club" yields "Mauricio Pochettino at the", and "He anchors Maresca's system"
 * yields "anchors Maresca". Without trimming, neither reads as a person and both slip past.
 */
function cleanCandidateName(candidate: string): string {
  const tokens = candidate.replace(LEADING_PREPOSITION_REGEX, '').trim().split(/\s+/);
  const isCapitalized = (t: string) => /^[A-ZÀ-ÖØ-Þ]/.test(t);
  const start = tokens.findIndex(isCapitalized);
  if (start === -1) return '';
  const end = tokens.findIndex((t, i) => i > start && !isCapitalized(t));
  return tokens.slice(start, end === -1 ? tokens.length : end).join(' ');
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
  return [
    ...ctx.verifiedFacts,
    ...(ctx.supplementalCorpus ?? []),
    ctx.currentHeadCoach ?? '',
    ...(ctx.clubManagers ?? []).map((m) => m.coach),
  ]
    .join(' ')
    .toLowerCase();
}

/** Whether a manager name may stay in prose under this context. */
function isManagerNameAllowed(name: string, ctx: ManagerVerificationContext, corpus: string): boolean {
  const verifiedCoach = ctx.currentHeadCoach?.trim() || null;
  if (verifiedCoach && sameCoach(name, verifiedCoach)) return true;
  if (ctx.strictCurrentCoach) return false;
  if ((ctx.clubManagers ?? []).some((m) => sameCoach(name, m.coach))) return true;
  return isNameVerified(name, corpus);
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
  const verifiedCoach = ctx.currentHeadCoach?.trim() || null;
  return collectManagerMentions(text)
    .filter((mentioned) => !isManagerNameAllowed(mentioned, ctx, corpus))
    .map((mentioned) =>
      verifiedCoach
        ? `manager "${mentioned}" conflicts with verified head coach "${verifiedCoach}"`
        : `manager "${mentioned}" not verified in extraction`,
    );
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

  // 1. Rewrite a club's previous coach to its verified current coach.
  let out = scrubFormerCoaches(text, ctx.clubManagers ?? []);

  const corpus = verificationCorpus(ctx);
  const verifiedCoach = ctx.currentHeadCoach?.trim() ?? null;

  const isAllowed = (mentioned: string): boolean => {
    const cleaned = cleanCandidateName(mentioned);
    if (!isLikelyPersonName(cleaned)) return true;
    return isManagerNameAllowed(cleaned, ctx, corpus);
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
      // Keep a leading word the case-insensitive capture swallowed ("in Maresca's system").
      const lead = cleaned ? name.slice(0, name.indexOf(cleaned)) : '';
      return lead + (verifiedCoach ? `${verifiedCoach}'s ${rest}` : `the team's ${rest}`);
    },
  );

  return out;
}
