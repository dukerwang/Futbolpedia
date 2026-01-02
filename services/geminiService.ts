import { GoogleGenAI, Chat, Content, Type } from "@google/genai";
import type { PlayerProfile, Attributes, ChatMessage, PlayerComparison } from '../types';
import { MASTER_INSTRUCTION_SET } from '../constants';

let chat: Chat | null = null;
let currentModel: string | null = null;
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });

const getCurrentSeasonInfo = () => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.toLocaleString('default', { month: 'long' });
    const seasonStartYear = now.getMonth() >= 6 ? year : year - 1; 
    const currentSeason = `${seasonStartYear}-${(seasonStartYear + 1).toString().slice(-2)}`;
    return { year, month, seasonStartYear, currentSeason };
};

export const resetChat = () => {
  chat = null;
  currentModel = null;
};

function initializeChat(model: string, history?: Content[]) {
  chat = ai.chats.create({
    model: model,
    config: {
        systemInstruction: MASTER_INSTRUCTION_SET,
        tools: [{googleSearch: {}}],
        temperature: 0.3,
    },
    history,
  });
  currentModel = model;
}

const isPlayerProfile = (content: any): content is PlayerProfile => {
    return typeof content === 'object' && content !== null && 'basicInfo' in content && 'ratings' in content;
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

const sendChatMessage = async (message: string, history: ChatMessage[], model: string, imageData?: string): Promise<string | PlayerProfile | PlayerComparison> => {
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

  if (!chat || currentModel !== model) {
    console.log(`[System] Initializing chat with model: ${model}`);
    initializeChat(model, geminiHistory);
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

    const response = await chat!.sendMessage({ message: parts });
    
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

export const sendMessageToAI = async (message: string, history: ChatMessage[], imageData?: string): Promise<string | PlayerProfile | PlayerComparison> => {
    
    const { year, month, currentSeason } = getCurrentSeasonInfo();
    const previousSeason = `${year - 1}-${year}`; // e.g., 2024-2025
    console.log(`[GLOBAL WORKFLOW] Decomposing query: "${message}"`);

    // Default to Gemini 3 Flash for Profiles/Ratings as recommended
    let selectedModel = 'gemini-3-flash-preview';

    try {
        // Only run query expansion if there's no image. 
        // Image-based analysis usually benefits more from the direct prompt context.
        let queries: string[] = [];
        if (!imageData) {
            const queryGenPrompt = `The user's message is: "${message}".
Act as a "Tactical Research Assistant." You must generate a list of Google Search queries to gather the complete context.

**INTENT CLASSIFICATION:**
Determine the best model tier for this request:
- "Flash": For Player Profiles, Attribute Ratings, Comparison Tables, Rankings, or simple Stats.
- "Pro": For "Deep Dive" tactical analysis, complex "Why" questions, hypothetical scenarios, or future projections.

**STRATEGY:**
Do not use a single "kitchen sink" query. Break the request down into specific data retrieval tasks.

**MANDATORY QUERY TYPES (Generate as needed):**
1.  **Current Form (The "Now"):** "[Player] stats ${currentSeason} goals assists injury news"
2.  **Historical Class (The "Anchor"):** "[Player] stats ${previousSeason} goals assists" (CRITICAL for rating accuracy).
3.  **Team Context (The "Environment"):** "[Club] last 5 match results league table position ${month} ${year}" (To detect crises/form).
4.  **Narrative (The "Story"):** "[Player] recent analysis pundit criticism transfer news ${month} ${year}"
5.  **Roster Check (Tactical/Lineup Queries):** If the user asks about tactics or fit, search "[Club] transfers out 2024 2025" and "[Club] squad ${currentSeason}".

**CONSTRAINT:**
If the user asks to **COMPARE** two players, you MUST generate the "Current Form" and "Historical Class" queries for **BOTH** players individually.

**OUTPUT:**
Return a JSON object with:
- 'queries': Array of search strings.
- 'category': String, either "Flash" or "Pro".`;
            
            // Using Gemini 3 Flash for Data Processing (RAG)
            const queryGenResponse = await ai.models.generateContent({
                model: "gemini-3-flash-preview", 
                contents: queryGenPrompt,
                config: {
                    temperature: 0.0,
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: Type.OBJECT,
                        properties: { 
                            queries: { type: Type.ARRAY, items: { type: Type.STRING } },
                            category: { type: Type.STRING, description: "Flash or Pro" }
                        },
                        required: ["queries", "category"]
                    }
                }
            });
            
            try {
                const parsed = JSON.parse((queryGenResponse.text || '').trim());
                if (parsed) {
                    if (Array.isArray(parsed.queries)) {
                        queries = parsed.queries;
                    }
                    if (parsed.category === 'Pro') {
                        selectedModel = 'gemini-3-pro-preview';
                    }
                }
            } catch (e) {
                console.error("Failed to parse query generation response:", e);
            }
        }

        // Fallback or Image path
        if (queries.length === 0 && message.trim()) {
            queries.push(`${message} stats ${currentSeason}`);
        }

        console.log(`[GLOBAL WORKFLOW] Executing Search Strategy:`, queries);
        console.log(`[GLOBAL WORKFLOW] Selected Model:`, selectedModel);
        
        let finalAnswerPrompt = `User Query: "${message}"
${imageData ? "Note: The user has uploaded an image. Please incorporate any visual information from the image into your analysis." : ""}

**FACTUAL FOUNDATION (MANDATORY CONTEXT):**
${queries.length > 0 ? `Please use your Google Search tool to execute the following queries and treat the results as the "Verified Factual Foundation":
${queries.map(q => `- ${q}`).join('\n')}` : "No specific web search performed for this image-based query."}

**EXECUTION INSTRUCTIONS:**
1. **Verify Date:** Today is ${month} ${year}. The active season is ${currentSeason}.
2. **Apply Protocols:** - **Protocol J (Universal Research):** Use the search data provided.
   - **Protocol I (Explanation Integrity):** If checking ratings, cite the Section IV Scale exactly.
   - **Protocol L (Temporal Firewall):** Strict date adherence. Do not cite old matches as new.
   - **Protocol N (Generational Weapon):** Use correct paths for 96+ ratings.
   - **Protocol W (Live Roster Firewall):** If tactics/lineup involved, verify player current club status before citing.
3. **Generate Response:** Produce the JSON or Markdown response strictly adhering to the System Instructions.
`;
        
        return sendChatMessage(finalAnswerPrompt, history, selectedModel, imageData);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("[GLOBAL WORKFLOW] Failed:", errorMessage);
        // Fallback to Flash on error
        return sendChatMessage(message, history, 'gemini-3-flash-preview', imageData);
    }
};
