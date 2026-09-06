/**
 * High-precision Gaffa intent cues for the soft nudge when domain is default.
 * Prefer misses over false positives.
 */

/** Manual QA examples — true / false expectations for spot checks. */
export const GAFFA_DETECT_EXAMPLES: Array<{ text: string; expect: boolean }> = [
  { text: 'Can a CB auto-sub for an LB?', expect: true },
  { text: "What's the OOP penalty?", expect: true },
  { text: 'Would you trade Isak for Jackson + €70m?', expect: true },
  { text: 'How does formation lock work in gaffa?', expect: true },
  { text: 'Rate Erling Haaland', expect: false },
  { text: 'Who plays for Arsenal this season?', expect: false },
  { text: 'Is the academy good at Chelsea?', expect: false },
  { text: 'Trade rumours about Isak', expect: false },
];

export function looksLikeGaffaQuestion(message: string): boolean {
  const text = message.trim();
  if (!text) return false;

  // Explicit product name always counts.
  if (/\bgaffa\b/i.test(text)) return true;

  const hasOop = /\boop\b/i.test(text) || /out[-\s]?of[-\s]?position/i.test(text);
  const hasAutoSub =
    /auto[-\s]?sub/i.test(text) ||
    (/\bbench\b/i.test(text) && /\bcover\b/i.test(text));
  const hasLock = /formation\s+lock/i.test(text) || /player\s+lock/i.test(text);
  const hasBenchSlots =
    /\bbench\b/i.test(text) && /\b(def|mid|att|flex)\b/i.test(text);
  const hasStrictEligibility =
    /\b(cb|lb|rb|lwb|rwb|dm|cm|am)\b/i.test(text) &&
    /\b(cover|eligible|eligibility|slot|auto[-\s]?sub)\b/i.test(text);

  const hasMoney = /€\s*\d|\b\d+(\.\d+)?\s*m\b/i.test(text);
  const hasTradeVerb = /\b(trade|auction|bid|release clause|club balance|severance)\b/i.test(text);
  const moneyTrade = hasMoney && hasTradeVerb;

  // Multi-signal roster terms (avoid lone "academy" / "IR" / "trade").
  const hasGaffaRoster =
    (/\binjured\s+reserve\b/i.test(text) || /\b\bir\b/i.test(text)) &&
    /\b(cap|slot|bid|roster|park|stash)\b/i.test(text);
  const hasAcademyGaffa =
    /\bacademy\b/i.test(text) &&
    /\b(u21|slot|stash|promote|loan|roster)\b/i.test(text);
  const hasDrawBand = /\bdraw\s+band\b/i.test(text) || (/\b10\s+points?\b/i.test(text) && /\bdraw\b/i.test(text));
  const hasBenchBonus = /bench\s+depth\s+bonus/i.test(text) || (/\b25%\b/.test(text) && /\bbench\b/i.test(text));

  return (
    hasOop ||
    hasAutoSub ||
    hasLock ||
    hasBenchSlots ||
    hasStrictEligibility ||
    moneyTrade ||
    hasGaffaRoster ||
    hasAcademyGaffa ||
    hasDrawBand ||
    hasBenchBonus
  );
}
