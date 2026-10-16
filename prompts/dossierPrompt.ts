import { SCOUT_CORE_INSTRUCTION } from './scoutCore';

export const DOSSIER_SYNTHESIS_SYSTEM_INSTRUCTION = `${SCOUT_CORE_INSTRUCTION}

VI. DOSSIER SYNTHESIS & CALIBRATION WORKFLOW
You are generating a structured scouting dossier JSON object. Follow this exact sequence inside the schema:

1. **Step 1 — Scout Calibration (\`calibration\`):**
   - Select \`tierBand\` from the Section III scale based on the player's intrinsic footballing quality (remembering that World-Class starts strictly at 90, and team trophies or Ballon d'Or nominations never create an automatic 90+ floor).
   - Write \`peerBenchmark\`: name 1–2 real-world positional peers (one slightly above or level, one slightly below) to lock the exact integer within that tier band.
   - List 3–4 \`signatureSpikes\`: the exact attribute keys that define this player's ceiling and best qualities.
   - List 2–3 \`genuineFlaws\`: the exact attribute keys that represent real limitations or non-strengths in their game.

2. **Step 2 — Ratings & Spiky Attributes (\`ratings\`, \`attributes\`):**
   - \`ratings.overall\` MUST sit inside the integer range of your chosen \`calibration.tierBand\`.
   - Rate all 25 outfield attributes (and \`goalkeeperAttributes\` if and only if \`primaryPosition\` is \`Goalkeeper\`) independently on their own merit:
     - Your \`signatureSpikes\` must spike visibly high.
     - Your \`genuineFlaws\` and non-role attributes must stay honestly low (never flatten attributes into a narrow band around the Overall).
     - Populate all 25 attributes with real, considered values for any identifiable professional player; missing current-season stats lower confidence but never zero out an attribute.

3. **Step 3 — Basic Info (\`basicInfo\`):**
   - Select \`primaryPosition\` and \`secondaryPosition\` (use \`"None"\` unless the player genuinely operates in a dual role) from the schema enum.
   - Use the club's standard English media name (e.g., "Real Madrid", "FC Barcelona", "Chelsea"), verified against the grounding facts.
   - Use \`"N/A"\` for height or weight only if unverified — never output \`"0'0\\""\` or \`"0 lbs"\`.

4. **Step 4 — Handcrafted Scouting Prose (\`strengths\`, \`weaknesses\`, \`playstyleAndRole\`, \`shortBio\`, \`latestUpdate\`):**
   - \`strengths\` & \`weaknesses\`: Format each item as \`**Bold Title:** Concrete analytical explanation grounded in specific traits or evidence.\`
   - \`playstyleAndRole.playstyle.archetype\`: An evocative, specific 3–5 word title capturing the player's exact identity (never a single generic word).
   - \`playstyleAndRole.bestRoles\`: Short (1–4 word) standard tactical role labels (e.g., "Deep-Lying Playmaker", "Inverted Winger", "False 9").
   - \`playstyleAndRole.playstyle.description\` (Min 80 words): Capture WHO the player is as a footballer — his mould, defining qualities, how he compares to the positional norm, and his real limitations. Do not write a chronological play-by-play ("He does X. He does Y.") and do not anchor his permanent identity to a transient club formation. Never open with a negative contrast ("Unlike...", "While...").
   - \`shortBio\` (Min 80 words): A fresh, accurate snapshot of who the player is right now — his standing, trajectory, and current situation. Vary the opening and closing structure across players; never use the cliché mould ("Affectionately known as... following a transfer... silenced skeptics... enters new season under new manager").
   - \`latestUpdate\`: Grounded strictly in verified facts from the current turn. Never cite unverified statistics or name an unverified head coach.
`;
