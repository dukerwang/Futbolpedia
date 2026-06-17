
import { GoogleGenAI, Chat, Content, Type, ThinkingLevel } from "@google/genai";
import type { PlayerProfile, Attributes, ChatMessage, PlayerComparison } from '../types';
import { MASTER_INSTRUCTION_SET } from '../constants';

const supabaseUrl = "https://vnqpluwoxjukoxlnwawo.supabase.co";
const supabaseKey = "sb_publishable_B8pIUFHdh6dc-JUzJMfVrg_Bc5x5Bi4";

// Safe Initialization of Supabase from the global window object (loaded via script tag in index.html)
export const supabase = (typeof window !== 'undefined' && (window as any).supabase)
  ? (window as any).supabase.createClient(supabaseUrl, supabaseKey)
  : null;

export const isSupabaseReady = () => !!supabase;

export const saveProfileToShare = async (profileData: any) => {
  if (!supabase) throw new Error("Share service unavailable. Missing Supabase configuration.");
  const { data, error } = await supabase
    .from('profiles')
    .insert([{ player_data: profileData }])
    .select()
    .single();

  if (error) {
    console.error("Supabase Save Error:", error);
    throw error;
  }
  return data.id;
};

export const getSharedProfile = async (id: string) => {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('player_data')
      .eq('id', id)
      .single();

    if (error) {
      console.error("Supabase Fetch Error:", error);
      return null;
    }
    return data.player_data;
  } catch (e) {
    console.error("Error fetching shared profile:", e);
    return null;
  }
};

let currentThinkingLevel: string | null = null;
let chat: Chat | null = null;
let currentModel: string | null = null;
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });

const getCurrentSeasonInfo = () => {
    const now = new Date();
    const year = 2026; // Static context for the Futbolpedia 2026 simulation
    const month = now.toLocaleString('default', { month: 'long' });
    const seasonStartYear = 2025; 
    const currentSeason = `2025-26`;
    return { year, month, seasonStartYear, currentSeason };
};

export const resetChat = () => {
  chat = null;
  currentModel = null;
};

// Optimized for Gemini 3 Flash / Pro
function initializeChat(model: string, history?: Content[], level: "minimal" | "low" | "medium" | "high" = "high") {
  const levelMap: Record<string, ThinkingLevel> = {
    minimal: ThinkingLevel.MINIMAL,
    low: ThinkingLevel.LOW,
    medium: ThinkingLevel.MEDIUM,
    high: ThinkingLevel.HIGH
  };

  chat = ai.chats.create({
    model: model,
    config: {
        systemInstruction: MASTER_INSTRUCTION_SET,
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
        temperature: 1.0, 
        thinkingConfig: {
          thinkingLevel: levelMap[level],
        },
    },
    history,
  });
  currentModel = model;
  currentThinkingLevel = level;
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

const sendChatMessage = async (
  message: string, 
  history: ChatMessage[], 
  model: string, 
  imageData?: string, 
  thinkingLevel: "minimal" | "low" | "medium" | "high" = "high"
): Promise<string | PlayerProfile | PlayerComparison> => {
  const geminiHistory: Content[] = history
    .map((msg): Content | null => {
      const isUser = msg.sender === 'user';
      let parts: any[] = [];
      
      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content });
      } else if (isPlayerProfile(msg.content) || isPlayerComparison(msg.content)) {
        if (!isUser) {
           parts.push({ text: JSON.stringify(msg.content) });
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

  if (!chat || currentModel !== model || currentThinkingLevel !== thinkingLevel) {
    initializeChat(model, geminiHistory, thinkingLevel);
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

    let jsonText = text.trim();
    const firstOpen = jsonText.indexOf('{');
    const lastClose = jsonText.lastIndexOf('}');

    if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
        jsonText = jsonText.substring(firstOpen, lastClose + 1);
    }

    if (jsonText.startsWith('{') && jsonText.endsWith('}')) {
      try {
        const parsedJson = JSON.parse(jsonText);
        const foundComparison = findComparisonData(parsedJson);
        if (foundComparison) return sanitizeComparisonData(foundComparison);
        const foundProfile = findProfileData(parsedJson);
        if (foundProfile) return sanitizeProfileData(foundProfile);
      } catch (e) {
        console.warn("Attempted to parse as JSON but failed, treating as text:", e);
      }
    }
    return text;
  } catch (error) {
    console.error("Gemini API call failed:", error);
    if (error instanceof Error) throw new Error(`The AI model failed to respond. Details: ${error.message}`);
    throw new Error("An unexpected error occurred while communicating with the AI.");
  }
};

export const sendMessageToAI = async (message: string, history: ChatMessage[], imageData?: string, mode: 'default' | 'fast' = 'default'): Promise<string | PlayerProfile | PlayerComparison> => {
    // 2026 Simulation Context
    const { year, month, currentSeason } = getCurrentSeasonInfo();
    
    try {
        let factualFoundation = "";
        let selectedModel = 'gemini-3-flash-preview'; 

        // 1. INTENT GATES (The Fix: Define these BEFORE triggering search)
        const isProfileRequest = /\b(rate|rating|profile|scout|evaluate|scouting|dossier|how good|rank|tier)\b/i.test(message) || /analysis on|report on|who is/i.test(message);
        const isComparison = /compare|vs|versus|better/i.test(message);
        const isHistorical = /prime|history|historical|all time|all-time|peak/i.test(message);
        // We only trigger the heavy "Lead Scout" machinery if it looks like a scouting task
        const isFormal = isProfileRequest || isComparison;

        // FAST MODE BYPASS
        if (mode === 'fast' && !imageData) {
            const fastPrompt = `
    <context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
    <instructions>
    You are in FAST MODE. Skip deep multi-step research. 
    1. Use the googleSearch tool efficiently if you need data you don't have.
    2. Answer concisely but accurately.
    3. Maintain the Futbolpedia identity (Objective, Scout-like).
    </instructions>
    <task>${message}</task>`;
            // Use low thinking level for speed
            return sendChatMessage(fastPrompt, history, 'gemini-3-flash-preview', undefined, 'low');
        }

        // DEFAULT MODE LOGIC
        if (!imageData && mode === 'default') {
            // ONLY RUN VECTORS IF IT IS A FORMAL REQUEST
            if (isFormal) {
                // "Omniscient Scout" Multi-Vector Search Logic
                let queryGenPrompt = `
Task: Generate comprehensive search queries for: "${message}".
Context: Current Date is ${month} ${year}. Season: ${currentSeason}.
MANDATORY SEARCH VECTORS (Generate exactly 1 highly precise query per vector):

VECTOR A (The Anchor & Class): Search for the player's 2024/2025 peak, major awards, and "best player" rankings.
VECTOR B (The Hard Data): Search for ${currentSeason} stats, G/A per 90, clean sheets, and advanced metrics.
VECTOR C (The Narrative & Eye Test): Search for recent pundit analysis, fan sentiment (e.g., "criticism", "praise", "flop", "revelation"), and specific match performance reviews from the current month.
VECTOR D (The Context): Search for "injury history ${year}", "tactical fit [Club Name]", and manager quotes about role or fitness.

OUTPUT: JSON with a single 'queries' array containing strictly strings.`;

                if (isHistorical) {
                    queryGenPrompt = `
Task: Generate comprehensive search queries for evaluating the PEAK/PRIME of: "${message}".
MANDATORY SEARCH VECTORS (Generate exactly 1 highly precise query per vector):

VECTOR A (The Anchor & Class): Search for the player's absolute peak season, major awards, and "best player" rankings during their prime.
VECTOR B (The Hard Data): Search for their best season stats, G/A per 90, clean sheets, and advanced metrics from their prime years.
VECTOR C (The Narrative & Eye Test): Search for pundit analysis, fan sentiment, and specific match performance reviews from their peak era.
VECTOR D (The Context): Search for tactical fit and manager quotes about their role during their most dominant period.

OUTPUT: JSON with a single 'queries' array containing strictly strings.`;
                }

                const queryGenResponse = await ai.models.generateContent({
                    model: "gemini-3-flash-preview", 
                    contents: queryGenPrompt,
                    config: {
                        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
                        responseMimeType: "application/json",
                    }
                });
                
                // Robust JSON Cleanup
                const rawText = queryGenResponse.text || '{}';
                const cleanJson = rawText.replace(/```json|```/g, '').trim();
                const parsed = JSON.parse(cleanJson);
                const queries = (parsed.queries || []);
                
                // Concurrency Limit (Safe cap at 8)
                const SAFE_QUERY_LIMIT = 8;
                
                const results = await Promise.all(queries.slice(0, SAFE_QUERY_LIMIT).map(async (q: string) => {
                   try {
                       const res = await ai.models.generateContent({
                           model: "gemini-3-flash-preview",
                           contents: `[Date: ${month} ${year}] ${q}`,
                           config: { tools: [{googleSearch: {}}] }
                       });
                       return `[QUERY: ${q}]\n${res.text}`;
                   } catch (e) {
                       console.warn(`Search failed for: ${q}`);
                       return `[QUERY: ${q}]\nData unavailable.`;
                   }
                }));
                
                factualFoundation = results.join('\n\n---\n\n');
                selectedModel = 'gemini-3.1-pro-preview';
            } else {
                // NON-FORMAL CHAT (The Fallback Fix)
                // We skip the vector search to prevent hallucinations.
                // We provide a simple instruction so it acts as a chatbot, not a data engine.
                factualFoundation = "User is engaging in general conversation. Do not generate a JSON profile. Respond conversationally as the Senior Tactical Columnist. You have access to the googleSearch tool—use it if the user asks a question requiring current stats, squad info, injuries, or recent news.";
                selectedModel = 'gemini-3-flash-preview';
            }
        }

        const selectedLevel: "minimal" | "low" | "medium" | "high" = isFormal || selectedModel.includes('pro') ? "high" : "low";

        let finalInstructions = `
    1. IDENTITY: Senior Tactical Columnist / Lead Scout.
    2. ANCHOR: Disregard 2024 memory. Use the 2026 factual foundation provided above.
    3. PROTOCOL M (Temporal Firewall): Strictly verify the YEAR of events. Prioritize ${month} ${year} data.
    4. PROTOCOL B (Injury Quarantine / "Rodri" Override): If the foundation shows the player started a match in the last 7 days, they are MATCH FIT. Ignore any "injured" status from 2025.
    5. ROSTER CHECK: If foundation shows a transfer or loan in the 25-26 season, update the basicInfo.club accordingly.
    6. DATA INTEGRITY: Use foundation data only for 'latestUpdate' and 'basicInfo'. Do not calculate ratings using ranking numbers; ratings must be based on the attribute framework applied to verified ability.
    7. GENERATIONAL WEAPON RULE: The "Generational Weapon" (Protocol C) ONLY applies to 96+ players. Do NOT cite it or require it for any player projected at 95 or below.
    <synthesis_mandate>
    You are prohibited from ignoring the "Narrative" or "Context" vectors.
    BEFORE rating the player, you must cross-reference:
    1. Does the "Hard Data" support the "Anchor"? (Is he performing to his class?)
    2. Does the "Narrative" explain the "Data"? (e.g., Is low output due to "tactical misuse" or "poor form"?)
    3. Does the "Context" justify a rating protection? (e.g., "Returning from injury" vs "Healthy but poor").
    If the General Narrative is negative (e.g., "struggling", "out of depth"), you MUST lower the rating attributes (Consistency, Composure) regardless of the player's historical Anchor.
    </synthesis_mandate>
        `;

        if (isHistorical) {
            finalInstructions = `
    1. IDENTITY: Senior Tactical Columnist / Lead Scout.
    2. ANCHOR: Evaluate the player strictly on their PEAK/PRIME according to the factual foundation.
    3. EXEMPTION FROM TEMPORAL FIREWALL: Disregard their 2026 status (retired, manager, etc.). Rate them as if they are in their prime competing against modern standards.
    4. DATA INTEGRITY: Use foundation data for 'latestUpdate' to describe their peak era achievements. Do not calculate ratings using ranking numbers; ratings must be based on the attribute framework applied to verified ability.
            `;
        }

        const finalAnswerPrompt = `
    <context>System Date: ${month} ${year}. Season: ${currentSeason}</context>
    <factual_foundation>
    ${factualFoundation}
    </factual_foundation>
    
    <instructions>
    ${finalInstructions}
    </instructions>

    <task>${message}</task>`;
        
        return sendChatMessage(finalAnswerPrompt, history, selectedModel, imageData, selectedLevel);
    } catch (error) {
        console.error("[GLOBAL WORKFLOW] Failed:", error);
        return sendChatMessage(message, history, 'gemini-3-flash-preview', imageData, "low");
    }
};
