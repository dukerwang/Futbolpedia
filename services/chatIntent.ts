/** Words that only ask to see something: verbs of showing, card nouns and filler. */
const SHOW_WORDS =
  /\b(?:let me see|lemme see|lets see|let s see|can i see|show(?: me| us)?|pull(?: up)?|bring(?: up)?|open(?: up)?|see|view|display|give me|get me|can you|could you|please|pls|the|a|an|his|her|their|its|card|cards|dossier|dossiers|profile|profiles|and|for|of|me|again|here|up)\b/g;

/**
 * Whether what's left of a message once its @ mentions are taken out only asks to see them
 * ("let me see", "pull up his card"), so the cards are the whole answer and no model turn runs.
 */
export const asksToSeeMentions = (leftover: string): boolean =>
  leftover
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(SHOW_WORDS, ' ')
    .trim() === '';
