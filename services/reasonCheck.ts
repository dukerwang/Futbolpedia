/**
 * Whether a reason argues from something other than football: availability (injuries, missed
 * matches, minutes, durability, fitness record), team success (trophies, titles, team results) or
 * fame. Overall answers how good a footballer a version was, so none of those can set it.
 *
 * The patterns look for the argument, not the word: a reason that mentions a match, a final, "the
 * final minutes" or "won the ball" is football, and one that says he missed half a season, played
 * more matches or won more titles is not. Pure, so the rating, card traits and tests share it.
 */

export type OffFootballKind = 'availability' | 'team_success' | 'fame';

const AVAILABILITY: RegExp[] = [
  /\binjur(?:y|ies|ed)\b/i,
  /\binjury[- ]prone\b/i,
  /\b(?:muscle|hamstring|knee|ankle|groin|calf|thigh|back|foot)\s+(?:problems?|issues?|tears?|strains?|surgery|operations?)\b/i,
  /\bsidelined\b|\bon the sidelines\b|\blay-?offs?\b/i,
  /\bfitness\s+(?:record|issues?|problems?|concerns?)\b/i,
  /\b(?:stayed|kept|remained)\s+(?:fit|healthy)\b/i,
  /\bdurab(?:le|ility)\b/i,
  /\bavailability\b/i,
  /\bever-?present\b/i,
  /\bmissed\s+(?:\w+\s+){0,3}(?:matches|games|fixtures|months|weeks|seasons?|time|campaigns?)\b/i,
  /\b(?:more|fewer|less|total|regular|consistent)\s+minutes\b|\bminutes\s+played\b|\bminutes\s+(?:a|per)\s+season\b/i,
  /\b(?:more|fewer)\s+(?:appearances|matches|games|starts|caps)\b/i,
  /\b(?:appearance|games-played|match)\s+(?:totals?|counts?|records?)\b/i,
  /\bplayed\s+(?:far\s+|many\s+|much\s+)?(?:more|less|fewer)\s+(?:often|matches|games|football)\b/i,
  /\babsences\b|\btime out (?:injured|of the side|of the team)\b/i,
];

const TEAM_SUCCESS: RegExp[] = [
  /\btroph(?:y|ies)\b/i,
  /\bsilverware\b/i,
  /\bmedals?\b/i,
  /\bhonours\b|\bhonors\b/i,
  /\btitles\b|\btitle-winning\b/i,
  /\bwon\s+(?:the\s+|a\s+|an\s+|two\s+|three\s+|four\s+|five\s+|more\s+|back-to-back\s+|successive\s+|consecutive\s+|\d+\s+)?(?:\w+\s+){0,2}(?:league|title|cup|treble|double|championship|trophy|crown|scudetto|bundesliga|liga|premier league|serie a|ligue 1|world cup|euros?|copa)\b/i,
  /\b(?:his|the)\s+(?:team|side|club)(?:'s)?\s+(?:success|results|record|finish|finished|won|lifted|dominance)\b/i,
  /\bteam\s+(?:success|results|achievements)\b/i,
  /\bfinished\s+(?:top|first|higher|above)\b/i,
];

const FAME: RegExp[] = [
  /\bfame\b|\bfamous\b/i,
  /\breputation\b/i,
  /\bbigger\s+name\b|\bhousehold\s+name\b/i,
];

/** The first kind of off-football argument a reason makes, or null when it argues football. */
export function offFootballReason(text: string | null | undefined): OffFootballKind | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  if (AVAILABILITY.some((re) => re.test(t))) return 'availability';
  if (TEAM_SUCCESS.some((re) => re.test(t))) return 'team_success';
  if (FAME.some((re) => re.test(t))) return 'fame';
  return null;
}

/** What a flagged reason is told it rested on. */
export const OFF_FOOTBALL_LABEL: Record<OffFootballKind, string> = {
  availability: 'availability (injuries, matches or minutes missed, durability, fitness record)',
  team_success: 'team success (trophies, titles, team results)',
  fame: 'fame or reputation',
};
