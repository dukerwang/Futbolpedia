import { GoogleGenAI, Chat, Content, Type, ThinkingLevel } from "@google/genai";
import type { PlayerProfile, Attributes, ChatMessage, PlayerComparison } from '../types';
import { MASTER_INSTRUCTION_SET, getMasterInstructions, SIMULATION_YEAR, SIMULATION_SEASON } from '../constants';

const supabaseUrl = "https://hrocnbcavstmjysptjdk.supabase.co";
const supabaseKey = "sb_publishable_NKyG9miYqS8JgdpgWuXm9A_tc3vaVCL";

// Safe Initialization of Supabase from the global window object (loaded via script tag in index.html)
export const supabase = (typeof window !== 'undefined' && (window as any).supabase)
  ? (window as any).supabase.createClient(supabaseUrl, supabaseKey)
  : null;

export const isSupabaseReady = () => !!supabase;

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export const toPlayerSlug = (name: string): string =>
  name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

// Extracts a candidate player slug from a user message for cache lookup.
// Returns null if the message is too vague or ambiguous to extract a name.
const extractCandidateSlug = (message: string): string | null => {
  const candidate = message
    .replace(/\b(give me a?n?|create|generate|can you|please)\b/gi, '')
    .replace(/\b(rate|rating|profile|scout(?:ing)?(?: report)?|evaluate|dossier|how good is|rank(?:ing)?|tier|analyze|analysis|breakdown|report|brief(?:ing)?)\b/gi, '')
    .replace(/\b(on|for|about|of|a|an|the|me)\b/gi, '')
    .replace(/[?!.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!candidate || candidate.length < 2 || candidate.split(' ').length > 6) return null;
  return toPlayerSlug(candidate);
};

// Fetches a cached dossier from Supabase. When checkTTL is true (default),
// returns null if the entry is older than 14 days so the pipeline regenerates it.
// Pass checkTTL=false for share link loads where staleness is acceptable.
export const getCachedDossier = async (slug: string, checkTTL = true): Promise<PlayerProfile | null> => {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('player_profiles')
      .select('player_data, updated_at')
      .eq('player_slug', slug)
      .single();
    if (error || !data) return null;
    if (checkTTL && Date.now() - new Date(data.updated_at).getTime() > CACHE_TTL_MS) return null;
    return data.player_data as PlayerProfile;
  } catch {
    return null;
  }
};

const upsertCachedDossier = async (slug: string, profile: PlayerProfile): Promise<void> => {
  if (!supabase) return;
  try {
    await supabase
      .from('player_profiles')
      .upsert(
        { player_slug: slug, player_data: profile, updated_at: new Date().toISOString() },
        { onConflict: 'player_slug' }
      );
  } catch (e) {
    console.warn('[Cache] Upsert failed:', e);
  }
};

// Omit confusable characters (0/O, 1/I/L) from share codes.
const SHARE_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const generateShareCode = (): string =>
  Array.from({ length: 6 }, () => SHARE_CODE_CHARS[Math.floor(Math.random() * SHARE_CODE_CHARS.length)]).join('');

export const shareConversation = async (conv: import('../types').Conversation): Promise<string> => {
  if (!supabase) throw new Error("Database not available.");
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateShareCode();
    const { error } = await supabase
      .from('shared_conversations')
      .insert({ share_code: code, conversation_data: conv });
    if (!error) return code;
    // Retry only on unique-constraint collisions
    if (!error.message?.includes('unique') && !error.message?.includes('duplicate')) throw error;
  }
  throw new Error("Failed to generate a unique share code after 3 attempts.");
};

export const getSharedConversation = async (code: string): Promise<import('../types').Conversation | null> => {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('shared_conversations')
      .select('conversation_data')
      .eq('share_code', code.toUpperCase())
      .single();
    if (error || !data) return null;
    return data.conversation_data as import('../types').Conversation;
  } catch {
    return null;
  }
};

const FLASH_MODEL = 'gemini-3.5-flash';

// ─── Q1: Structured output schemas ────────────────────────────────────────────
// These are passed to generateContent as responseSchema for formal synthesis,
// guaranteeing schema-valid JSON and eliminating all regex-repair / detection logic.
const OUTFIELD_ATTRIBUTES_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        finishing: { type: Type.NUMBER }, firstTouch: { type: Type.NUMBER },
        dribbling: { type: Type.NUMBER }, vision: { type: Type.NUMBER },
        retention: { type: Type.NUMBER }, combinationPlay: { type: Type.NUMBER },
        delivery: { type: Type.NUMBER }, progressivePassing: { type: Type.NUMBER },
        footballIQ: { type: Type.NUMBER }, offensivePositioning: { type: Type.NUMBER },
        defensivePositioning: { type: Type.NUMBER }, tackling: { type: Type.NUMBER },
        interceptions: { type: Type.NUMBER }, pressingIntensity: { type: Type.NUMBER },
        speed: { type: Type.NUMBER }, acceleration: { type: Type.NUMBER },
        agility: { type: Type.NUMBER }, strength: { type: Type.NUMBER },
        aerialProwess: { type: Type.NUMBER }, stamina: { type: Type.NUMBER },
        composure: { type: Type.NUMBER }, clutch: { type: Type.NUMBER },
        leadership: { type: Type.NUMBER }, consistency: { type: Type.NUMBER },
        flair: { type: Type.NUMBER },
    },
    required: [
        'finishing','firstTouch','dribbling','vision','retention','combinationPlay',
        'delivery','progressivePassing','footballIQ','offensivePositioning',
        'defensivePositioning','tackling','interceptions','pressingIntensity',
        'speed','acceleration','agility','strength','aerialProwess','stamina',
        'composure','clutch','leadership','consistency','flair',
    ],
};

const GK_ATTRIBUTES_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        reflexes: { type: Type.NUMBER }, handling: { type: Type.NUMBER },
        distribution: { type: Type.NUMBER }, commandOfArea: { type: Type.NUMBER },
        GKpositioning: { type: Type.NUMBER }, sweeping: { type: Type.NUMBER },
        ballPlaying: { type: Type.NUMBER },
    },
};

const PLAYER_PROFILE_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        basicInfo: {
            type: Type.OBJECT,
            properties: {
                name: { type: Type.STRING }, age: { type: Type.NUMBER },
                nationality: { type: Type.STRING }, club: { type: Type.STRING },
                position: { type: Type.STRING }, height: { type: Type.STRING },
                weight: { type: Type.STRING },
            },
            required: ['name','age','nationality','club','position','height','weight'],
        },
        ratings: {
            type: Type.OBJECT,
            properties: { overall: { type: Type.NUMBER }, potential: { type: Type.NUMBER } },
            required: ['overall','potential'],
        },
        strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
        weaknesses: { type: Type.ARRAY, items: { type: Type.STRING } },
        attributes: OUTFIELD_ATTRIBUTES_SCHEMA,
        goalkeeperAttributes: GK_ATTRIBUTES_SCHEMA, // optional — sanitizer removes for non-GKs
        shortBio: { type: Type.STRING },
        playstyleAndRole: {
            type: Type.OBJECT,
            properties: {
                playstyle: {
                    type: Type.OBJECT,
                    properties: {
                        archetype: { type: Type.STRING },
                        description: { type: Type.STRING },
                    },
                    required: ['archetype','description'],
                },
                bestRoles: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ['playstyle','bestRoles'],
        },
        latestUpdate: { type: Type.STRING },
    },
    required: ['basicInfo','ratings','strengths','weaknesses','attributes','shortBio','playstyleAndRole','latestUpdate'],
};

const PLAYER_COMPARISON_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        summary: { type: Type.STRING },
        players: { type: Type.ARRAY, items: PLAYER_PROFILE_SCHEMA },
    },
    required: ['summary','players'],
};
// ──────────────────────────────────────────────────────────────────────────────

let currentThinkingLevel: string | null = null;
let currentSystemInstruction: string | null = null;
let chat: Chat | null = null;
let currentModel: string | null = null;
// Lazy singleton: constructing eagerly at module scope means any environment
// that imports this file without process.env populated (design-sync preview
// bundles, tests, etc.) crashes on import even when it never calls the AI.
let _ai: GoogleGenAI | null = null;
const getAi = (): GoogleGenAI => (_ai ??= new GoogleGenAI({ apiKey: process.env.API_KEY as string }));

// Q3: Use shared simulation constants so the year is consistent everywhere.
// The real month is kept for search-query grounding (more precise than "June").
const getCurrentSeasonInfo = () => {
    const now = new Date();
    const month = now.toLocaleString('default', { month: 'long' });
    return { year: SIMULATION_YEAR, month, currentSeason: SIMULATION_SEASON };
};

export const resetChat = () => {
  chat = null;
  currentModel = null;
  currentThinkingLevel = null;
  currentSystemInstruction = null;
};

function initializeChat(model: string, history?: Content[], level: "minimal" | "low" | "medium" | "high" = "medium", systemInstruction?: string) {
  const levelMap: Record<string, ThinkingLevel> = {
    minimal: ThinkingLevel.MINIMAL,
    low: ThinkingLevel.LOW,
    medium: ThinkingLevel.MEDIUM,
    high: ThinkingLevel.HIGH
  };

  // Temperature scaled by thinking level: deeper analysis = lower temp to reduce hallucination.
  const temperature = level === 'high' ? 0.6 : level === 'medium' ? 0.7 : level === 'low' ? 0.8 : 0.85;
  const instruction = systemInstruction ?? MASTER_INSTRUCTION_SET;

  chat = getAi().chats.create({
    model: model,
    config: {
        systemInstruction: instruction,
        tools: [
            {googleSearch: {}},
            {
                functionDeclarations: [
                    {
                        name: "get_football_squad",
                        description: "Gets the current active roster/squad of a football team using API-Football. Use this to verify current players for a club.",
                        parameters: {
                            type: Type.OBJECT,
                            properties: {
                                team: { type: Type.STRING, description: "The name of the football club (e.g. Real Madrid, Arsenal)" }
                            },
                            required: ["team"]
                        }
                    }
                ]
            }
        ],
        // @ts-ignore
        toolConfig: {
            // @ts-ignore
            includeServerSideToolInvocations: true
        },
        temperature,
        thinkingConfig: {
          thinkingLevel: levelMap[level],
        },
    },
    history,
  });
  currentModel = model;
  currentThinkingLevel = level;
  currentSystemInstruction = instruction;
}

const isPlayerProfile = (content: any): content is PlayerProfile => {
    return typeof content === 'object' && content !== null && !('players' in content) && 'basicInfo' in content && 'ratings' in content;
};

const isPlayerComparison = (content: any): content is PlayerComparison => {
    return typeof content === 'object' && content !== null && 'summary' in content && Array.isArray(content.players);
};

const findProfileData = (data: any): Partial<PlayerProfile> | null => {
  if (!data) return null;
  if (data.basicInfo && (data.attributes || data.goalkeeperAttributes) && data.ratings) {
    return data;
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findProfileData(item);
      if (found) return found;
    }
  }
  if (typeof data === 'object' && data !== null) {
    for (const key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        const found = findProfileData(data[key]);
        if (found) return found;
      }
    }
  }
  return null;
};

const findComparisonData = (data: any): Partial<PlayerComparison> | null => {
    if (!data) return null;
    if (data.summary && Array.isArray(data.players) && data.players.length > 1) {
        return data;
    }
    if (typeof data === 'object' && data !== null) {
        for (const key in data) {
            if (Object.prototype.hasOwnProperty.call(data, key)) {
                const found = findComparisonData(data[key]);
                if (found) return found;
            }
        }
    }
    return null;
}

const createDefaultProfile = (): PlayerProfile => {
    const defaultAttributes: Attributes = {
        finishing: 0, firstTouch: 0, dribbling: 0, vision: 0, retention: 0,
        combinationPlay: 0, delivery: 0, progressivePassing: 0, footballIQ: 0,
        offensivePositioning: 0, defensivePositioning: 0, tackling: 0,
        interceptions: 0, pressingIntensity: 0, speed: 0, acceleration: 0,
        agility: 0, strength: 0, aerialProwess: 0, stamina: 0, composure: 0,
        clutch: 0, leadership: 0, consistency: 0, flair: 0,
    };
    return {
        basicInfo: { name: 'N/A', age: 0, nationality: 'N/A', club: 'N/A', position: 'N/A', height: 'N/A', weight: 'N/A' },
        ratings: { overall: 0, potential: 0 },
        strengths: [],
        weaknesses: [],
        attributes: defaultAttributes,
        shortBio: 'Bio not available.',
        playstyleAndRole: {
            playstyle: { archetype: 'N/A', description: 'Playstyle not available.' },
            bestRoles: [],
        },
        latestUpdate: 'Update not available.',
    };
};

// ─── Basic-info normalization (Protocol S safety net) ──────────────────────────
// The prompt asks the model for canonical formats, but we also normalize
// deterministically so the UI never shows "LB" next to "Left Back" or "Barca"
// next to "FC Barcelona" across different dossiers.
// Plain canonical names — deliberately WITHOUT a "(ABBR)" suffix. The dossier UI
// (SidePanel.formatPosition) maps these exact plain names down to short abbreviations
// for display (e.g. "Left Back" → "LB"); appending "(LB)" here breaks that lookup and
// is what caused overly long, un-abbreviated position badges in the UI.
const POSITION_CANON: Record<string, string> = {
    gk: 'Goalkeeper', goalkeeper: 'Goalkeeper', keeper: 'Goalkeeper',
    rb: 'Right Back', rightback: 'Right Back',
    lb: 'Left Back', leftback: 'Left Back',
    cb: 'Centre-Back', centreback: 'Centre-Back', centerback: 'Centre-Back', centraldefender: 'Centre-Back',
    rwb: 'Right Wing-Back', rightwingback: 'Right Wing-Back',
    lwb: 'Left Wing-Back', leftwingback: 'Left Wing-Back',
    cdm: 'Defensive Midfielder', dm: 'Defensive Midfielder', defensivemidfielder: 'Defensive Midfielder', holdingmidfielder: 'Defensive Midfielder',
    cm: 'Central Midfielder', centralmidfielder: 'Central Midfielder', centremidfielder: 'Central Midfielder',
    cam: 'Attacking Midfielder', am: 'Attacking Midfielder', attackingmidfielder: 'Attacking Midfielder',
    rm: 'Right Midfielder', rightmidfielder: 'Right Midfielder',
    lm: 'Left Midfielder', leftmidfielder: 'Left Midfielder',
    rw: 'Right Winger', rightwinger: 'Right Winger', rightwing: 'Right Winger',
    lw: 'Left Winger', leftwinger: 'Left Winger', leftwing: 'Left Winger',
    cf: 'Centre Forward', centreforward: 'Centre Forward', centerforward: 'Centre Forward',
    st: 'Striker', striker: 'Striker',
    ss: 'Second Striker', secondstriker: 'Second Striker',
};

const CLUB_CANON: Record<string, string> = {
    barca: 'FC Barcelona', fcbarcelona: 'FC Barcelona', barcelona: 'FC Barcelona',
    realmadrid: 'Real Madrid', madrid: 'Real Madrid', losblancos: 'Real Madrid',
    atleti: 'Atlético Madrid', atleticomadrid: 'Atlético Madrid', atletico: 'Atlético Madrid',
    manu: 'Manchester United', manutd: 'Manchester United', manunited: 'Manchester United', mufc: 'Manchester United', manchesterunited: 'Manchester United',
    mancity: 'Manchester City', mcfc: 'Manchester City', manchestercity: 'Manchester City',
    spurs: 'Tottenham Hotspur', tottenham: 'Tottenham Hotspur', tottenhamhotspur: 'Tottenham Hotspur',
    chelsea: 'Chelsea', chelseafc: 'Chelsea', cfc: 'Chelsea',
    liverpool: 'Liverpool', lfc: 'Liverpool',
    arsenal: 'Arsenal', gunners: 'Arsenal', arsenalfc: 'Arsenal',
    bayern: 'Bayern Munich', bayernmunich: 'Bayern Munich', fcbayern: 'Bayern Munich', fcbayernmunich: 'Bayern Munich',
    dortmund: 'Borussia Dortmund', bvb: 'Borussia Dortmund', borussiadortmund: 'Borussia Dortmund',
    psg: 'Paris Saint-Germain', parissaintgermain: 'Paris Saint-Germain',
    juve: 'Juventus', juventus: 'Juventus',
    inter: 'Inter Milan', internazionale: 'Inter Milan', intermilan: 'Inter Milan',
    acmilan: 'AC Milan',
};

const normalizePosition = (raw: string): string => {
    if (!raw || raw === 'N/A') return raw || 'N/A';
    // Strip any parenthetical abbreviation the model may still attach despite instructions
    // (e.g. "Left Back (LB)") so the lookup key matches, and so it never leaks into output.
    const parts = raw.split(/\s*(?:\/|,|\bor\b|\band\b)\s*/i).map(s => s.trim()).filter(Boolean);
    const mapped = parts.map(part => {
        const withoutParens = part.replace(/\([^)]*\)/g, '').trim();
        const key = withoutParens.toLowerCase().replace(/[^a-z]/g, '');
        return POSITION_CANON[key] || withoutParens || part;
    });
    const seen = new Set<string>();
    const unique = mapped.filter(m => {
        const k = m.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    }).slice(0, 2); // Protocol S: at most two roles
    return unique.join('/') || raw;
};

const normalizeClub = (raw: string): string => {
    if (!raw || raw === 'N/A') return raw || 'N/A';
    const key = raw.toLowerCase().replace(/[^a-z]/g, '');
    return CLUB_CANON[key] || raw.trim();
};
// ──────────────────────────────────────────────────────────────────────────────

const sanitizeProfileData = (partialProfile: Partial<PlayerProfile> | null): PlayerProfile => {
    const defaults = createDefaultProfile();
    if (!partialProfile) return defaults;

    const sanitized: PlayerProfile = {
        ...defaults,
        ...partialProfile,
        basicInfo: { ...defaults.basicInfo, ...partialProfile.basicInfo },
        ratings: { ...defaults.ratings, ...partialProfile.ratings },
        attributes: { ...defaults.attributes, ...partialProfile.attributes },
        playstyleAndRole: {
            ...defaults.playstyleAndRole, ...partialProfile.playstyleAndRole,
            playstyle: { ...defaults.playstyleAndRole.playstyle, ...partialProfile.playstyleAndRole?.playstyle },
            bestRoles: Array.isArray(partialProfile.playstyleAndRole?.bestRoles) ? partialProfile.playstyleAndRole.bestRoles : [],
        },
        strengths: Array.isArray(partialProfile.strengths) ? partialProfile.strengths : [],
        weaknesses: Array.isArray(partialProfile.weaknesses) ? partialProfile.weaknesses : [],
    };

    const gkAttributes = partialProfile.goalkeeperAttributes;
    const position = sanitized.basicInfo.position?.toLowerCase() || '';
    if (gkAttributes && Object.keys(gkAttributes).length > 0 && (position.includes('goalkeeper') || position.includes('gk'))) {
        sanitized.goalkeeperAttributes = gkAttributes;
    } else {
        delete sanitized.goalkeeperAttributes;
    }

    // Normalize zero-ish height/weight strings the model produces when it
    // misapplies Protocol P to string fields ("0'0\"" → "N/A", "0 lbs" → "N/A").
    const isZeroMeasurement = (s: string): boolean =>
        /^0['"]?0?['"]?$/.test(s.trim()) || /^0\s*(lbs|kg|cm)?$/i.test(s.trim());

    if (!sanitized.basicInfo.height || sanitized.basicInfo.height === 'N/A' || isZeroMeasurement(sanitized.basicInfo.height)) {
        sanitized.basicInfo.height = 'N/A';
    }
    if (!sanitized.basicInfo.weight || sanitized.basicInfo.weight === 'N/A' || isZeroMeasurement(sanitized.basicInfo.weight)) {
        sanitized.basicInfo.weight = 'N/A';
    }

    // Protocol S: enforce canonical position/club formatting regardless of model output.
    sanitized.basicInfo.position = normalizePosition(sanitized.basicInfo.position);
    sanitized.basicInfo.club = normalizeClub(sanitized.basicInfo.club);

    const clean = (str: string): string => (str || '').replace(/\s*\[[\d\s,]+\]\s*/g, ' ').trim();

    sanitized.shortBio = clean(sanitized.shortBio);
    sanitized.latestUpdate = clean(sanitized.latestUpdate);
    sanitized.strengths = sanitized.strengths.map(clean);
    sanitized.weaknesses = sanitized.weaknesses.map(clean);
    sanitized.playstyleAndRole.playstyle.archetype = clean(sanitized.playstyleAndRole.playstyle.archetype);
    sanitized.playstyleAndRole.playstyle.description = clean(sanitized.playstyleAndRole.playstyle.description);
    sanitized.playstyleAndRole.bestRoles = sanitized.playstyleAndRole.bestRoles.map(clean);
    
    return sanitized;
};

const sanitizeComparisonData = (partialComparison: Partial<PlayerComparison> | null): PlayerComparison => {
    const defaults = {
        summary: 'No comparison summary available.',
        players: [],
    };
    if (!partialComparison) return defaults;
    
    const sanitizedPlayers = (partialComparison.players || []).map(p => sanitizeProfileData(p));
    
    return {
        summary: partialComparison.summary || defaults.summary,
        players: sanitizedPlayers,
    };
};

// Robustly recover a structured profile/comparison from a raw model text blob.
// Handles markdown fences, thinking-artifact tokens, and trailing commas. Returns
// null if the text is not (or is too corrupted to be) a valid profile/comparison.
const extractStructuredFromText = (text: string | undefined): PlayerProfile | PlayerComparison | null => {
    if (!text) return null;
    let jsonText = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const firstOpen = jsonText.indexOf('{');
    const lastClose = jsonText.lastIndexOf('}');
    if (firstOpen === -1 || lastClose === -1 || lastClose <= firstOpen) return null;
    const core = jsonText.substring(firstOpen, lastClose + 1);

    const candidates = [
        core,
        // Strip Flash thinking-artifact fragments (e.g. "2.4]." leaking into JSON).
        core.replace(/[\d.]*\]\.?"+\s*/g, '').replace(/\s{2,}/g, ' '),
        // Remove trailing commas before a closing brace/bracket.
        core.replace(/,\s*([}\]])/g, '$1'),
    ];
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            const foundComparison = findComparisonData(parsed);
            if (foundComparison) return sanitizeComparisonData(foundComparison);
            const foundProfile = findProfileData(parsed);
            if (foundProfile) return sanitizeProfileData(foundProfile);
        } catch {
            // try the next repaired candidate
        }
    }
    return null;
};

// ─── Q1: Structured synthesis ──────────────────────────────────────────────────
// Uses generateContent + responseSchema instead of the chat API so Gemini enforces
// schema validity at the API level. No tools are needed here — the full factual
// foundation is already in the prompt. Throws on failure so the caller can fall back.
const synthesizeFormalResponse = async (
    prompt: string,
    isComparisonRequest: boolean,
    systemInstruction: string,
): Promise<PlayerProfile | PlayerComparison> => {
    const schema = isComparisonRequest ? PLAYER_COMPARISON_SCHEMA : PLAYER_PROFILE_SCHEMA;

    // No thinkingConfig — ThinkingLevel + responseSchema conflict on Gemini Flash,
    // producing malformed output. The responseSchema enforces structure at the API level.
    const response = await getAi().models.generateContent({
        model: FLASH_MODEL,
        contents: prompt,
        config: {
            systemInstruction,
            temperature: 0.7,
            responseMimeType: 'application/json',
            responseSchema: schema,
        },
    });

    const text = response.text;
    if (!text) throw new Error('Structured synthesis returned no text');

    // Diagnostic: reveals whether synthesis wall time is spent on THINKING (dynamic
    // thinking when thinkingConfig is omitted) vs OUTPUT generation, and whether implicit
    // prompt caching is hitting the large systemInstruction. Guides where to optimize next.
    const u = (response as any).usageMetadata;
    if (u) {
        console.log(`[Perf] synthesis tokens — prompt: ${u.promptTokenCount ?? '?'}, cached: ${u.cachedContentTokenCount ?? 0}, thoughts: ${u.thoughtsTokenCount ?? 0}, output: ${u.candidatesTokenCount ?? '?'}, total: ${u.totalTokenCount ?? '?'}`);
    }

    const parsed = JSON.parse(text);
    return isComparisonRequest
        ? sanitizeComparisonData(parsed as Partial<PlayerComparison>)
        : sanitizeProfileData(parsed as Partial<PlayerProfile>);
};
// ──────────────────────────────────────────────────────────────────────────────

// ─── Shared formal-synthesis quality reminders ─────────────────────────────────
// Single source of truth for the narrative/attribute/formatting rules that must hold
// no matter which pipeline produces the final JSON — default mode's deep multi-vector
// research, its historical/prime variant, or fast mode's lighter single-search path.
// Update protocol wording HERE ONLY: every prompt pulls from this function, so the
// paths can no longer drift out of sync (which caused two separate bugs previously).
const getFormalSynthesisQualityReminders = (): string => `
    ATTRIBUTE POPULATION (Protocol P): Populate all 25 numerical attributes with real, considered values drawn from the player's established class and scouting profile. Missing current-season stats lowers confidence — it does NOT justify a 0. Only an unidentifiable / footprint-less player may receive 0s. For 'height'/'weight', use "N/A" if unverified — never "0'0\"" or "0 lbs".
    ATTRIBUTE DIFFERENTIATION (Protocol R): Rate each attribute on its own merit — do NOT cluster attributes around the Overall. Elite strengths must spike high and genuine weaknesses must stay visibly low, even for a high-Overall player. The Overall is a position-weighted synthesis of key attributes, never a floor that drags every attribute upward.
    BASIC INFO — POSITION (Protocol S): Select 'position' ONLY from this closed list, output as the PLAIN NAME with NO parenthetical abbreviation attached: Goalkeeper, Centre-Back, Left Back, Right Back, Left Wing-Back, Right Wing-Back, Defensive Midfielder, Central Midfielder, Attacking Midfielder, Left Midfielder, Right Midfielder, Left Winger, Right Winger, Striker, Centre Forward, Second Striker. For a genuine dual role, join exactly two with "/" and nothing else (e.g., "Central Midfielder/Right Back"). Never a generic label ("Defender", "Forward", "Midfielder").
    BASIC INFO — CLUB (Protocol S): The standard media name (e.g., "Real Madrid") — never a nickname ("Barca"). Always populate name, age, nationality, club, and position.
    EFFECTIVE ROLES (bestRoles): Short (1-4 word) standard tactical role labels (e.g., "False 9", "Deep-Lying Playmaker", "Inverted Winger") — not full sentences, not the position list above.
    ARCHETYPE NAMING (Protocol D): An evocative, specific 3-5 word title capturing the player's exact playing identity — never a generic positional label.
    STRENGTHS/WEAKNESSES FORMAT (Protocol L): Each entry MUST follow "**Bold Title:** Analytical sentence with specific evidence." Ground titles and sentences in real, specific traits — not vague labels.
    SHORT BIO — UNIQUE, ACCURATE, CURRENT (Protocols I & L): Minimum 80 words. Goal: a fresh, high-quality snapshot of who the player is RIGHT NOW — current standing, form, situation — worded differently for every player; quality and accuracy come first. Break out of the one reused mould — "Affectionately known as '[nickname]'... following a [transfer]... silenced/defied skeptics by [stat]... enters [new season] under [new manager]" — and never use the crutch phrases "silenced/defied skeptics." A nickname is OPTIONAL; include one only if genuinely famous, never invent or force it as the opener. Vary both the opening (a plain stat/achievement, a defining moment, a direct identity statement, a real tension) and the closing across profiles.
    TACTICAL BRIEF — ACCURATE IDENTITY, NOT ACTION LOG (Protocol T): playstyle.description must capture WHO the player is as a footballer — his true type, defining qualities, how he compares to the norm for his role, and his genuine limitations — as accurately as a world-class scout would. There is NO required opening template; open in whatever way most sharply captures THIS player and vary it across profiles. Make the reader come away knowing what mould he belongs to. Do NOT write it as a chronological chain of "He does X. He does Y. He does Z." actions (a play-by-play), and do NOT anchor it to one club's tactical system. Concrete habits are welcome as evidence, but identity is the payload.
    PRE-OUTPUT VERIFICATION:
       • (P) Every attribute populated from established ability; 0 only for an unidentifiable player; string fields use "N/A"
       • (R) The attribute set has genuine spread (clear peaks and troughs), not a flat band near the Overall
       • (S) position is from the closed list, plain name, max two joined by "/", no "(ABBR)"; all basicInfo fields populated
       • (D) Archetype is specific and evocative, not a generic label
       • (L) Strengths/weaknesses use the bold-title format; bio meets the word minimum with real, current evidence, worded uniquely — not the one reused mould and not the "silenced skeptics" crutch
       • (T) playstyle.description gives an accurate footballing-identity portrait (reader knows the player's type), NOT a chain of "He [verb]s" actions, with no required opening template and no club-system framing
       • (C) Generational Weapon NOT applied to any player at 95 or below
`;
// ──────────────────────────────────────────────────────────────────────────────

const sendChatMessage = async (
  message: string, 
  history: ChatMessage[], 
  model: string, 
  imageData?: string, 
  thinkingLevel: "minimal" | "low" | "medium" | "high" = "medium",
  systemInstruction?: string
): Promise<string | PlayerProfile | PlayerComparison> => {
  const geminiHistory: Content[] = history
    .map((msg): Content | null => {
      const isUser = msg.sender === 'user';
      let parts: any[] = [];
      
      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (isPlayerProfile(msg.content) || isPlayerComparison(msg.content)) {
        if (!isUser) {
          // Compress profiles to a short summary to prevent anchor bias in follow-up questions.
          if (isPlayerProfile(msg.content)) {
            const p = msg.content as PlayerProfile;
            parts.push({ text: `[Profile generated: ${p.basicInfo?.name}, ${p.ratings?.overall} OVR (Pot: ${p.ratings?.potential}), ${p.basicInfo?.club}, ${p.basicInfo?.position}]` });
          } else {
            const c = msg.content as PlayerComparison;
            const names = c.players?.map(p => `${p.basicInfo?.name} (${p.ratings?.overall} OVR)`).join(' vs ') ?? 'comparison';
            parts.push({ text: `[Comparison generated: ${names}]` });
          }
        }
      }

      if (msg.image && isUser) {
        const [mimeType, base64Data] = msg.image.split(';base64,');
        parts.push({
          inlineData: {
            data: base64Data,
            mimeType: mimeType.replace('data:', '')
          }
        });
      }

      if (parts.length > 0) {
        return {
          role: isUser ? 'user' : 'model',
          parts: parts,
        };
      }
      return null;
    })
    .filter((item): item is Content => item !== null);

  const resolvedInstruction = systemInstruction ?? MASTER_INSTRUCTION_SET;
  if (!chat || currentModel !== model || currentThinkingLevel !== thinkingLevel || currentSystemInstruction !== resolvedInstruction) {
    initializeChat(model, geminiHistory, thinkingLevel, resolvedInstruction);
  }

  try {
    const parts: any[] = [{ text: message }];
    if (imageData) {
        const [mimeType, base64Data] = imageData.split(';base64,');
        parts.push({
          inlineData: {
            data: base64Data,
            mimeType: mimeType.replace('data:', '')
          }
        });
    }

    let response = await chat!.sendMessage({ message: parts });
    
    // Process function calls
    while (response.functionCalls && response.functionCalls.length > 0) {
        const functionCall = response.functionCalls[0];
        let apiResult: any = {};
        
        try {
            if (functionCall.name === "get_football_squad") {
                const args = functionCall.args as any;
                if (args && args.team) {
                    console.log(`[API-Football] Fetching squad for ${args.team}...`);
                    const fetchRes = await fetch(`/api/football/squad?team=${encodeURIComponent(args.team)}`);
                    if (!fetchRes.ok) throw new Error("API responded with an error.");
                    apiResult = await fetchRes.json();
                } else {
                    apiResult = { error: "Missing team argument" };
                }
            } else {
                apiResult = { error: "Unknown function" };
            }
        } catch (e: any) {
            console.error("[Function Call Error]", e);
            apiResult = { error: e.message };
        }
        
        response = await chat!.sendMessage({ message: [{
            functionResponse: {
                name: functionCall.name,
                response: apiResult
            }
        }]});
    }

    const text = response.text;

    if (typeof text !== 'string') {
        const finishReason = response.candidates?.[0]?.finishReason;
        if (finishReason && finishReason !== 'STOP') {
             throw new Error(`The model's response was blocked due to: ${finishReason}. Please modify your prompt and try again.`);
        }
        throw new Error("The AI model failed to return a valid text response. Please try again.");
    }

    const structured = extractStructuredFromText(text);
    if (structured) return structured;
    console.warn("All JSON parse attempts failed, treating as text.");
    return text;
  } catch (error) {
    console.error("Gemini API call failed:", error);
    if (error instanceof Error) throw new Error(`The AI model failed to respond. Details: ${error.message}`);
    throw new Error("An unexpected error occurred while communicating with the AI.");
  }
};

export const sendMessageToAI = async (message: string, history: ChatMessage[], imageData?: string, mode: 'default' | 'fast' = 'default'): Promise<string | PlayerProfile | PlayerComparison> => {
    const { year, month, currentSeason } = getCurrentSeasonInfo();

    // Detect EAFC-specific queries to conditionally inject the FC Playstyles directory.
    const isEAFCRequest = /\b(playstyle\+?|fc\s*card|eafc|ea\s*fc)\b/i.test(message);
    const systemInstruction = getMasterInstructions(isEAFCRequest);

    // ── Intent detection (hoisted so the global catch can guard formal requests) ──
    const isProfileRequest = /\b(rate|rating|profile|scout|evaluate|scouting|dossier|how good|rank|tier|analyze|breakdown)\b/i.test(message) || /analysis on|report on|break down/i.test(message);
    const isComparison = /compare|vs|versus|better/i.test(message);
    const isHistorical = /\bprime\b|\bpeak\b|\ball[- ]time\b|\bhistorical\b/i.test(message);
    const isCurrentStateQuery = /\b(squad|roster|lineup|line.?up|formation|manager|coach|signings?|transfers?|this season|playing for|who(?:'s| is) (?:at|managing)|how (?:does|do) .+ play)\b/i.test(message);
    const isFormal = isProfileRequest || isComparison;

    // ── Per-phase timing instrumentation ────────────────────────────────────
    // Logs each pipeline phase's wall time to the console so real bottlenecks can be
    // measured instead of estimated. Set FUTBOLPEDIA_PERF=false on window to silence.
    const perfEnabled = typeof window === 'undefined' || (window as any).FUTBOLPEDIA_PERF !== false;
    const perfStart = (typeof performance !== 'undefined' ? performance : Date).now();
    let perfPrev = perfStart;
    const perf = (label: string) => {
        if (!perfEnabled) return;
        const now = (typeof performance !== 'undefined' ? performance : Date).now();
        console.log(`[Perf] ${label}: +${Math.round(now - perfPrev)}ms (total ${Math.round(now - perfStart)}ms) [${mode}]`);
        perfPrev = now;
    };

    try {
        let factualFoundation = "";

        // ── Dossier cache check (both modes) ────────────────────────────────
        // Single-player profile requests check Supabase before running any pipeline.
        // Applies to fast mode too: a cached dossier is instant AND higher quality than a
        // fresh fast-mode generation, so there is no reason for fast mode to regenerate a
        // player that is already cached. Cache entries are valid for 14 days; stale entries
        // fall through to regenerate via whichever mode was requested.
        if (isProfileRequest && !isComparison && !imageData) {
            const candidateSlug = extractCandidateSlug(message);
            if (candidateSlug) {
                const cached = await getCachedDossier(candidateSlug);
                if (cached) return cached;
            }
        }

        // ── Fast mode bypass ────────────────────────────────────────────────────
        if (mode === 'fast' && !imageData) {
            const fastPrompt = isFormal
                ? `<context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
    <instructions>
    You are in FAST MODE. Use a single googleSearch to gather current data, then generate the response immediately.
    CRITICAL: You MUST output the COMPLETE Player Profile or Comparison JSON schema with ALL required fields.
    The "attributes" object (all 25 values) and "playstyleAndRole" are MANDATORY — do not abbreviate or omit any fields.
    Follow the schema exactly as defined in the system instruction. Output pure JSON only, no preamble.
    </instructions>
    <task>${message}</task>`
                : `<context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
    <instructions>
    You are in FAST MODE. Skip deep multi-step research.
    1. Use the googleSearch tool efficiently if you need data you don't have.
    2. Answer concisely but accurately.
    3. Maintain the Futbolpedia identity (Objective, Scout-like).
    </instructions>
    <task>${message}</task>`;

            // FORMAL fast requests: the chat path (regex JSON parsing) is what leaks raw JSON,
            // so we avoid it entirely. Two quick grounding searches run IN PARALLEL — not
            // sequentially — then STRUCTURED synthesis (responseSchema, guaranteed valid JSON,
            // can never leak). Running the searches concurrently means this two-vector
            // triangulation costs no extra wall-clock time over a single search, while closing
            // most of the data-depth gap with default mode's 4-vector pipeline. Still only
            // ~3 calls total vs. default's ~7, and the slow part (search) isn't serialized.
            if (isFormal) {
                let fastFoundation = '';
                try {
                    const [anchorRes, profileRes] = await Promise.allSettled([
                        getAi().models.generateContent({
                            model: FLASH_MODEL,
                            contents: `[Date: ${month} ${year}] ${message}: player's class/reputation anchor, major awards, current club, transfer/injury status.`,
                            config: { tools: [{ googleSearch: {} }], thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } },
                        }),
                        getAi().models.generateContent({
                            model: FLASH_MODEL,
                            contents: `[Date: ${month} ${year}] ${message}: scouting profile — playing style, specific technical/physical/mental strengths and weaknesses, notable career moments or nicknames, ${currentSeason} form and stats.`,
                            config: { tools: [{ googleSearch: {} }], thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } },
                        }),
                    ]);
                    const anchorText = anchorRes.status === 'fulfilled' ? anchorRes.value.text : '';
                    const profileText = profileRes.status === 'fulfilled' ? profileRes.value.text : '';
                    fastFoundation = [anchorText, profileText].filter(Boolean).join('\n\n---\n\n');
                } catch (e) {
                    console.warn('[Fast Mode] Grounding search failed, synthesizing from prompt only:', e);
                }
                perf('search phase (2 parallel)');

                // Pulls the SAME quality-reminder function as default mode (see
                // getFormalSynthesisQualityReminders) so fast mode's writing/rating quality
                // can never drift out of sync with default mode again — only the depth of the
                // factual foundation differs between the two pipelines, not the standards applied to it.
                const fastSynthPrompt = `<context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
    <factual_foundation>
    ${fastFoundation}
    </factual_foundation>
    <instructions>
    Generate the COMPLETE Player ${isComparison ? 'Comparison' : 'Profile'} JSON per the schema.
    ${getFormalSynthesisQualityReminders()}
    Use the foundation above for current-status facts (club, form, injuries) — do not invent unverified figures.
    </instructions>
    <task>${message}</task>`;

                try {
                    const result = await synthesizeFormalResponse(fastSynthPrompt, isComparison, systemInstruction);
                    perf('synthesis');
                    if (!isComparison && 'basicInfo' in result) {
                        upsertCachedDossier(toPlayerSlug((result as PlayerProfile).basicInfo.name), result as PlayerProfile);
                    }
                    return result;
                } catch (e) {
                    console.warn('[Fast Mode] Structured synthesis failed, guarded chat fallback:', e);
                    const fb = await sendChatMessage(fastPrompt, history, FLASH_MODEL, undefined, 'low', systemInstruction);
                    const structured = typeof fb === 'string' ? extractStructuredFromText(fb) : fb;
                    if (structured && typeof structured === 'object') {
                        if (!isComparison && 'basicInfo' in structured) {
                            upsertCachedDossier(toPlayerSlug((structured as PlayerProfile).basicInfo.name), structured as PlayerProfile);
                        }
                        return structured;
                    }
                    throw new Error("The scouting report came back malformed. Please try that request again in a moment.");
                }
            }
            return sendChatMessage(fastPrompt, history, FLASH_MODEL, undefined, 'low', systemInstruction);
        }

        // ── Default mode: pipeline ──────────────────────────────────────────────
        if (!imageData && mode === 'default') {
            if (isFormal) {
                let queries: string[];

                // ── Standard single-player dossier: skip the query-generation LLM call ──
                // A profile request already NAMES the player, so the four search vectors are
                // deterministic templates — building them in code removes a full serial round
                // trip (the query-gen phase) from the critical path with no loss of search depth
                // or triangulation. This mirrors fast mode, which has always templated its
                // grounding queries inline without any quality regression. The query-gen call is
                // still used for comparison/historical requests below, where it earns its cost by
                // disambiguating the two players / peak eras from a looser prompt.
                //
                // Vectors mirror the previous generated set 1:1 (E2: 5→4, D = merged status+fitness):
                //   A Anchor & Class · B Hard Data · C Scouting Profile & Eye Test · D Status & Fitness
                if (!isComparison && !isHistorical) {
                    queries = [
                        `${message} — 2024/2025 peak season, major awards, and "best player" rankings`,
                        `${message} — ${currentSeason} season stats: goals, assists, G/A per 90, clean sheets, and advanced metrics`,
                        `${message} — scouting report: playing style, specific technical/physical/mental strengths and weaknesses, and pundit/analyst breakdowns of HOW he plays`,
                        `${message} — current club, any ${year} transfer or loan news, injury status, manager quotes about his role, and tactical fit in ${currentSeason}`,
                    ];
                } else {
                    // Comparison / historical: keep the query-gen call so both players (and, for
                    // historical requests, their respective peak eras) are correctly identified.
                    let queryGenPrompt: string;

                    if (isHistorical && isComparison) {
                        queryGenPrompt = `
Task: Generate search queries to compare the PRIME/PEAK of the two players in: "${message}".
MANDATORY: Exactly 4 queries — 2 per player at their respective peaks.

PLAYER 1 — VECTOR A: Absolute peak season stats, major awards, and "best player" rankings during prime.
PLAYER 1 — VECTOR B: Pundit analysis and match performance reviews from their peak era.
PLAYER 2 — VECTOR A: Absolute peak season stats, major awards, and "best player" rankings during prime.
PLAYER 2 — VECTOR B: Pundit analysis and match performance reviews from their peak era.

OUTPUT: JSON with a single 'queries' array containing strictly 4 strings.`;
                    } else if (isHistorical) {
                        queryGenPrompt = `
Task: Generate search queries for evaluating the PEAK/PRIME of: "${message}".
MANDATORY SEARCH VECTORS (exactly 1 precise query per vector):

VECTOR A (Anchor & Class): Absolute peak season, major awards, and "best player" rankings during prime.
VECTOR B (Hard Data): Best season stats, G/A per 90, clean sheets, and advanced metrics from prime years.
VECTOR C (Narrative & Eye Test): Pundit analysis, fan sentiment, and match performance reviews from peak era.
VECTOR D (Context): Tactical fit and manager quotes about their role during their most dominant period.

OUTPUT: JSON with a single 'queries' array containing strictly 4 strings.`;
                    } else {
                        // isComparison && !isHistorical
                        queryGenPrompt = `
Task: Generate search queries to compare the two players in: "${message}".
Context: Current Date is ${month} ${year}. Season: ${currentSeason}.
MANDATORY: Exactly 4 queries — 2 per player. Identify the two players from the request.

PLAYER 1 — VECTOR A: Their ${currentSeason} stats, goals, assists, and hard performance data.
PLAYER 1 — VECTOR B: Recent pundit analysis, form, current club/status, and tactical role (${month} ${year}).
PLAYER 2 — VECTOR A: Their ${currentSeason} stats, goals, assists, and hard performance data.
PLAYER 2 — VECTOR B: Recent pundit analysis, form, current club/status, and tactical role (${month} ${year}).

OUTPUT: JSON with a single 'queries' array containing strictly 4 strings.`;
                    }

                    // LOW thinking for query generation: costs almost nothing but meaningfully improves
                    // query specificity vs MINIMAL (correct club names, season labels, etc.).
                    // responseSchema forces {"queries":[...]} — without it the model maps the VECTOR A/B/C/D
                    // labels to JSON keys (e.g. {"vectorA":"..."}) and parsed.queries returns undefined → [].
                    const queryGenResponse = await getAi().models.generateContent({
                        model: FLASH_MODEL,
                        contents: queryGenPrompt,
                        config: {
                            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                            responseMimeType: "application/json",
                            responseSchema: {
                                type: Type.OBJECT,
                                properties: {
                                    queries: { type: Type.ARRAY, items: { type: Type.STRING } },
                                },
                                required: ['queries'],
                            },
                        }
                    });

                    const rawText = queryGenResponse.text || '{}';
                    const cleanJson = rawText.replace(/```json|```/g, '').trim();
                    const parsed = JSON.parse(cleanJson);
                    queries = (parsed.queries || []);

                    if (queries.length === 0) {
                        throw new Error("Query generation returned no search queries. Cannot produce a grounded profile.");
                    }
                    perf('query generation');
                }

                const SAFE_QUERY_LIMIT = 4;

                // ── Q2: Capture grounding source URLs from each search ──────────────────
                // All searches fire concurrently (see below). Retries with backoff on 429 as
                // a cheap safety net for transient errors, even though the project's quota has
                // ~100x headroom over a single dossier's burst.
                const runSearch = async (q: string, attempt = 0): Promise<string> => {
                    const searchStart = (typeof performance !== 'undefined' ? performance : Date).now();
                    try {
                        const res = await getAi().models.generateContent({
                            model: FLASH_MODEL,
                            contents: `[Date: ${month} ${year}] ${q}`,
                            config: {
                                tools: [{googleSearch: {}}],
                                thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
                            }
                        });
                        if (perfEnabled) {
                            const ms = Math.round(((typeof performance !== 'undefined' ? performance : Date).now()) - searchStart);
                            console.log(`[Perf]   search "${q.slice(0, 48)}…": ${ms}ms${attempt ? ` (attempt ${attempt + 1})` : ''}`);
                        }
                        const chunks = (res as any).candidates?.[0]?.groundingMetadata?.groundingChunks;
                        const sources: string = chunks
                            ?.filter((c: any) => c.web?.uri)
                            ?.slice(0, 3)
                            ?.map((c: any) => c.web.title ? `${c.web.title} (${c.web.uri})` : c.web.uri)
                            ?.join(' | ') ?? '';
                        return `[QUERY: ${q}]\n${res.text}${sources ? `\n[SOURCES: ${sources}]` : ''}`;
                    } catch (e: any) {
                        const is429 = e?.status === 429 || String(e?.message).includes('429') || String(e?.message).includes('RESOURCE_EXHAUSTED');
                        if (is429 && attempt < 2) {
                            await new Promise(r => setTimeout(r, (attempt + 1) * 3000));
                            return runSearch(q, attempt + 1);
                        }
                        console.warn(`Search failed for: ${q}`, e);
                        return `[QUERY: ${q}]\nData unavailable.`;
                    }
                };

                // Latency fix: the search phase is the single biggest contributor to default
                // mode's response time. All 4 grounded searches now run FULLY IN PARALLEL,
                // collapsing the phase to a single wave (~one search's wall time instead of two
                // batched waves). The earlier 2-at-a-time batching existed to dodge a low
                // free-tier RPM cap; on the current plan the quota is 1,000 RPM / 2M TPM, so a
                // 4-request burst per dossier is negligible (would need ~140 concurrent dossiers
                // in one minute to threaten the RPM ceiling). No depth is traded — still 4 vectors.
                const queriesToRun = queries.slice(0, SAFE_QUERY_LIMIT);
                const results = await Promise.all(queriesToRun.map(q => runSearch(q)));

                factualFoundation = results.join('\n\n---\n\n');
                perf(`search phase (${queriesToRun.length} parallel)`);
            } else {
                // Non-formal chat
                if (isCurrentStateQuery) {
                    try {
                        const contextRes = await getAi().models.generateContent({
                            model: FLASH_MODEL,
                            contents: `[Date: ${month} ${year}] ${message}`,
                            config: { tools: [{ googleSearch: {} }] }
                        });
                        factualFoundation = `[CURRENT STATE CONTEXT — ${month} ${year}]\nDo NOT generate a JSON profile. Answer conversationally using the grounded data below.\n${contextRes.text || ''}`;
                    } catch (e) {
                        console.warn('[Context Search] Failed for non-formal query:', e);
                        factualFoundation = "Current state search unavailable. Answer conversationally but flag any current-status claims as potentially unverified.";
                    }
                } else {
                    factualFoundation = "User is engaging in general conversation. Do not generate a JSON profile. Respond conversationally as the Senior Tactical Columnist. You have access to the googleSearch tool—use it if the user asks a question requiring current stats, squad info, injuries, or recent news.";
                }
            }
        }

        // ── Extraction step ─────────────────────────────────────────────────────
        // Distill raw search results into a verified fact object before synthesis.
        // This surfaces data gaps explicitly (Protocol P) rather than letting the
        // model fill them silently from training data.
        let verifiedFactsBlock = '';
        if (isFormal && factualFoundation && !factualFoundation.startsWith('User is engaging')) {
            try {
                // Misc: cap at 8k chars (was 14k) — tail of search snippets is usually
                // redundant boilerplate. 8k preserves all meaningful signal.
                const extractionPrompt = `You are a data extractor. Given these football search results, extract ONLY facts that are explicitly stated. Set any field to null if not found — never infer or guess.

SEARCH RESULTS:
${factualFoundation.substring(0, 8000)}

QUERY CONTEXT: "${message}"

Return ONLY this JSON (no preamble, no markdown):
{
  "playerName": "string or null",
  "currentClub": "string or null (use most recent transfer if found)",
  "age": "number or null",
  "position": "string or null",
  "nationality": "string or null",
  "season2526Stats": "string summarising key stats found, or null",
  "recentForm": "string describing recent results or form, or null",
  "injuryStatus": "string — state fit/playing if they appeared recently, or describe injury if confirmed, or null",
  "recentMatchDate": "the most recent match date found in the results as YYYY-MM-DD or 'Month YYYY', or null — this anchors Protocol M temporal verification",
  "majorAwards": ["array of confirmed awards and rankings found"],
  "tacticalRole": "string about current role or manager quotes, or null",
  "verifiedSources": ["array of source URLs or titles from the SOURCES fields in the search results, if present"],
  "dataGaps": ["list of fields where search results contained no data — e.g. 'season2526Stats', 'injuryStatus'"]
}`;
                const extractionRes = await getAi().models.generateContent({
                    model: FLASH_MODEL,
                    contents: extractionPrompt,
                    config: {
                        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
                        responseMimeType: 'application/json',
                    }
                });
                const rawExtraction = (extractionRes.text || '{}').replace(/```json|```/g, '').trim();
                const parsedFacts = JSON.parse(rawExtraction);
                verifiedFactsBlock = `
    <verified_facts>
    These facts were explicitly confirmed in the search results. Use them for basicInfo and latestUpdate.
    DATA GAPS — handle as CONFIDENCE signals, NOT as attribute erasers (Protocol P):
    • Missing 'season2526Stats' or 'recentForm' → do NOT zero any attribute. Rate ability from the player's established class/scouting profile and simply keep latestUpdate free of any specific unverified stat number.
    • The ONLY time an attribute is 0 is when the player is unidentifiable / has no scouting footprint anywhere. A recognizable professional must have all 25 attributes populated with real, differentiated values.
    • If 'injuryStatus' is in dataGaps → apply Protocol B default (assume fit, do not report injury).
    • Use 'recentMatchDate' to anchor Protocol M temporal verification before writing latestUpdate.
    • 'verifiedSources' lists the real web sources used — cite these when writing latestUpdate if specific match events are mentioned.
    ${JSON.stringify(parsedFacts, null, 2)}
    </verified_facts>`;
            } catch (e) {
                console.warn('[Extraction Step] Failed, proceeding with raw foundation only:', e);
            }
            perf('extraction');
        }

        // MEDIUM thinking for formal requests: HIGH on Flash leaks thinking token fragments
        // ("2.4]." etc.) into JSON output, breaking parse. MEDIUM gives solid reasoning without artifacts.
        const selectedLevel: "minimal" | "low" | "medium" | "high" = isFormal ? "medium" : "low";

        let finalInstructions = `
    1. IDENTITY: Senior Tactical Columnist / Lead Scout.
    2. TRAINING MEMORY PROHIBITION: Your pre-trained knowledge of player club affiliations, squad compositions, manager names, transfer history, and injury statuses is potentially months or years out of date. You are PROHIBITED from stating any current-state fact (club, squad, manager, fitness, role) unless it is explicitly confirmed in the <factual_foundation> or <verified_facts> blocks above. If search data is absent for a current-state claim, write "no current data available" — never default to training memory.
    3. ANCHOR: Use only the factual foundation and verified facts above. They supersede all training knowledge.
    4. PROTOCOL M (Temporal Firewall): Strictly verify the YEAR of events. Prioritize ${month} ${year} data. Use 'recentMatchDate' from verified_facts as your temporal anchor before writing latestUpdate.
    5. PROTOCOL B (Injury Quarantine / "Rodri" Override): If the foundation shows the player started a match in the last 7 days, they are MATCH FIT. Ignore any "injured" status from 2025.
    6. ROSTER CHECK: If foundation shows a transfer or loan in the 25-26 season, update the basicInfo.club accordingly.
    7. DATA INTEGRITY: Use foundation data only for 'latestUpdate' and 'basicInfo'. Do not calculate ratings using ranking numbers; ratings must be based on the attribute framework applied to verified ability.
    8. GENERATIONAL WEAPON RULE: Protocol C ONLY applies to 96+ players. Do NOT cite it or require it for any player projected at 95 or below.
    <synthesis_mandate>
    You are prohibited from ignoring the "Narrative" or "Context" vectors.
    BEFORE rating the player, you must cross-reference:
    1. Does the "Hard Data" support the "Anchor"? (Is he performing to his class?)
    2. Does the "Narrative" explain the "Data"? (e.g., Is low output due to "tactical misuse" or "poor form"?)
    3. Does the "Context" justify a rating protection? (e.g., "Returning from injury" vs "Healthy but poor").
    If the General Narrative is negative (e.g., "struggling", "out of depth"), you MUST lower the rating attributes (Consistency, Composure) regardless of the player's historical Anchor.
    </synthesis_mandate>
    9. QUALITY & FORMATTING (shared rules — see below).
    ${getFormalSynthesisQualityReminders()}
    10. Also confirm before output: (E) latestUpdate contains no stat claim without a specific number from the foundation; (M) every match/club reference year is ${year}, not pulled from memory; (J) only defined tier names used — no invented labels.
        `;

        if (isHistorical) {
            finalInstructions = `
    1. IDENTITY: Senior Tactical Columnist / Lead Scout.
    2. ANCHOR: Evaluate the player strictly on their PEAK/PRIME according to the factual foundation.
    3. EXEMPTION FROM TEMPORAL FIREWALL: Disregard their 2026 status (retired, manager, etc.). Rate them as if they are in their prime competing against modern standards.
    4. DATA INTEGRITY: Use foundation data for 'latestUpdate' to describe their peak era achievements. Do not calculate ratings using ranking numbers; ratings must be based on the attribute framework applied to verified ability.
    5. GENERATIONAL WEAPON RULE: Protocol C ONLY applies to 96+ players. Do NOT cite it or require it for any player projected at 95 or below.
    <synthesis_mandate>
    BEFORE rating the player, you must cross-reference all three search signals:
    1. Does the "Hard Data" support the "Anchor"? (Did his stats reflect his class?)
    2. Does the "Narrative" explain the "Data"? (e.g., tactical role vs raw output)
    3. Does the "Context" support or challenge the rating? (e.g., era, competition level)
    </synthesis_mandate>
    6. QUALITY & FORMATTING (shared rules — see below).
    ${getFormalSynthesisQualityReminders()}
    7. Also confirm before output: (J) only defined tier names used — no invented labels; (A) potential projection ONLY if player was under 25 AND already 90+ during their prime.
            `;
        }

        const finalAnswerPrompt = `
    <context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
    <factual_foundation>
    ${factualFoundation}
    </factual_foundation>
    ${verifiedFactsBlock}
    <instructions>
    ${finalInstructions}
    </instructions>

    <task>${message}</task>`;

        // ── Q1: Route ALL formal default-mode requests (profiles AND comparisons) ──
        // through structured synthesis. synthesizeFormalResponse uses responseSchema so
        // Gemini guarantees schema-valid JSON and retries transient rate limits internally.
        // A formal request must resolve to a structured object — it must NEVER return a
        // raw JSON string to the UI. If every path fails we throw a clean error so the
        // user sees an "Editor's Note" instead of raw braces.
        if (isFormal && !imageData && mode === 'default') {
            const cacheIfProfile = (result: PlayerProfile | PlayerComparison) => {
                if (!isComparison && 'basicInfo' in result) {
                    upsertCachedDossier(toPlayerSlug((result as PlayerProfile).basicInfo.name), result as PlayerProfile);
                }
            };

            try {
                const result = await synthesizeFormalResponse(finalAnswerPrompt, isComparison, systemInstruction);
                perf('synthesis');
                cacheIfProfile(result);
                return result;
            } catch (e) {
                console.warn('[Structured Synthesis] Failed after retries, attempting chat fallback:', e);
                await new Promise(r => setTimeout(r, 1500));
                // Last-resort chat fallback. MINIMAL thinking — medium leaks artifact tokens
                // into JSON. Salvage/guard the result so a corrupted string is never rendered.
                try {
                    const fallback = await sendChatMessage(finalAnswerPrompt, history, FLASH_MODEL, imageData, 'minimal', systemInstruction);
                    const structured = typeof fallback === 'string' ? extractStructuredFromText(fallback) : fallback;
                    if (structured && typeof structured === 'object') {
                        cacheIfProfile(structured);
                        return structured;
                    }
                } catch (fallbackErr) {
                    console.warn('[Chat Fallback] Failed:', fallbackErr);
                }
                throw new Error("The scouting report came back malformed. Please try that request again in a moment.");
            }
        }

        return sendChatMessage(finalAnswerPrompt, history, FLASH_MODEL, imageData, selectedLevel, systemInstruction);
    } catch (error) {
        console.error("[GLOBAL WORKFLOW] Failed:", error);
        // For a formal request, never leak raw JSON: attempt one guarded structured
        // recovery, otherwise surface a clean error the UI renders as an "Editor's Note".
        if (isFormal && !imageData) {
            try {
                const recovered = await sendChatMessage(message, history, FLASH_MODEL, imageData, "minimal", getMasterInstructions(false));
                const structured = typeof recovered === 'string' ? extractStructuredFromText(recovered) : recovered;
                if (structured && typeof structured === 'object') return structured;
            } catch (recoveryErr) {
                console.warn('[Global Recovery] Failed:', recoveryErr);
            }
            throw error instanceof Error ? error : new Error("The scouting report could not be generated. Please try again.");
        }
        // MINIMAL thinking: LOW leaks citation tokens ([2.1.3] etc.) into JSON output.
        return sendChatMessage(message, history, FLASH_MODEL, imageData, "minimal", getMasterInstructions(false));
    }
};
