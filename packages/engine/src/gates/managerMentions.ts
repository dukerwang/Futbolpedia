export interface ManagerVerificationContext {
  verifiedFacts: string[];
  supplementalCorpus?: string[];
  currentHeadCoach: string | null;
}

const UNDER_MANAGER_PATTERN =
  /\bunder\s+(?:manager\s+|head\s+coach\s+|coach\s+)?([A-Z][a-zA-ZÀ-ÿ'’-]+(?:\s+[A-Z][a-zA-ZÀ-ÿ'’-]+){0,2})/g;

const POSSESSIVE_MANAGER_PATTERN =
  /\b([A-Z][a-zA-ZÀ-ÿ'’-]+(?:\s+[A-Z][a-zA-ZÀ-ÿ'’-]+)?)'s\s+(?:(?:attacking|defensive|tactical|high-pressing|positional)\s+)?(?:rotation|system|setup|approach|tactics|side|structure|philosophy|regime)\b/g;

const NON_MANAGER_PHRASES = new Set([
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

function isLikelyPersonName(candidate: string): boolean {
  const cleaned = candidate.trim();
  if (!cleaned || cleaned.length < 3) return false;
  const lower = cleaned.toLowerCase();
  if (NON_MANAGER_PHRASES.has(lower)) return false;
  // Must start with an uppercase letter
  if (!/^[A-ZÀ-ÖØ-Þ]/.test(cleaned)) return false;
  const tokens = cleaned.split(/\s+/);
  if (tokens.some((t) => NON_MANAGER_PHRASES.has(t.toLowerCase()))) return false;
  return true;
}

function collectManagerMentions(text: string): string[] {
  const mentions: string[] = [];
  for (const match of text.matchAll(UNDER_MANAGER_PATTERN)) {
    if (match[1] && isLikelyPersonName(match[1])) {
      mentions.push(match[1].trim());
    }
  }
  for (const match of text.matchAll(POSSESSIVE_MANAGER_PATTERN)) {
    if (match[1] && isLikelyPersonName(match[1])) {
      mentions.push(match[1].trim());
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
  const corpus = verificationCorpus(ctx);
  const verifiedCoach = ctx.currentHeadCoach?.trim() ?? null;

  const isAllowed = (mentioned: string): boolean => {
    if (!isLikelyPersonName(mentioned)) return true;
    if (verifiedCoach) {
      const verifiedLower = verifiedCoach.toLowerCase();
      const mentionedLower = mentioned.toLowerCase();
      if (mentionedLower === verifiedLower || verifiedLower.includes(mentionedLower)) {
        return true;
      }
    }
    return isNameVerified(mentioned, corpus);
  };

  let out = text.replace(
    /\bunder\s+(?:manager\s+|head\s+coach\s+|coach\s+)?([A-Z][a-zA-ZÀ-ÿ'’-]+(?:\s+[A-Z][a-zA-ZÀ-ÿ'’-]+){0,2})/g,
    (fullMatch, name: string) => {
      if (isAllowed(name.trim())) return fullMatch;
      return verifiedCoach ? `under ${verifiedCoach}` : 'in the current tactical setup';
    },
  );

  out = out.replace(
    /\b([A-Z][a-zA-ZÀ-ÿ'’-]+(?:\s+[A-Z][a-zA-ZÀ-ÿ'’-]+)?)'s\s+((?:(?:attacking|defensive|tactical|high-pressing|positional)\s+)?(?:rotation|system|setup|approach|tactics|side|structure|philosophy|regime))\b/g,
    (fullMatch, name: string, rest: string) => {
      if (isAllowed(name.trim())) return fullMatch;
      return verifiedCoach ? `${verifiedCoach}'s ${rest}` : `the team's ${rest}`;
    },
  );

  return out;
}
