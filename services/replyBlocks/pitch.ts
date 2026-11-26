import { Type } from '@google/genai';
import type { ReadyBlock } from '../../types';
import { executeCall, fileOutcomes, type ResearchCall } from '../researchTools';
import { lineupViewOf, type LineupView } from '../lineupView';
import { applyStory, deriveClubCore, sameClubName } from '../situationSnapshot';
import { BLOCK_TEXT } from './blockText';
import { readyBlock, type BlockEntry } from './entry';

export const pitchBlock = (id: string, view: LineupView): ReadyBlock<'pitch'> => readyBlock('pitch', id, view);

/** A club's first-choice XI, drawn from its live report. */
export const pitchEntry: BlockEntry<'pitch'> = {
  kind: 'pitch',
  tool: {
    name: 'show_pitch',
    description: `Draws a club's first-choice XI under your reply, worked out by code from its recent starting XIs and injury list (the data get_club_recent_team returns), with who is out. Use it when the answer is about who plays for the club or how it lines up. Call it where the reader needs the XI in your argument. Free: it doesn't count against your lookups.`,
    parameters: {
      type: Type.OBJECT,
      properties: { club: { type: Type.STRING, description: 'The club name.' } },
      required: ['club'],
    },
  },

  hint: ({ club }) => ({ title: club }),

  /** Reads the club's live report when the turn hasn't, then works the XI out of it. */
  async build({ club }, ctx) {
    if (!club) return { error: 'Missing club' };
    // The XI the writer argues from, when the turn built a situation snapshot that holds the club.
    const argued = ctx.situation?.()?.clubs.find((c) => sameClubName(c.club, club));
    const fromSituation = argued ? lineupViewOf(argued) : null;
    if (fromSituation) return { block: pitchBlock(ctx.newId(), fromSituation) };
    const find = () => ctx.ledger.read().entries.find((e) => e.club && sameClubName(e.club.team, club));
    let entry = find();
    if (!entry) {
      const call: ResearchCall = { tool: 'club_recent_team', subject: club, stage: 'facts' };
      const outcome = await executeCall(call, ctx.tools);
      ctx.ledger.write(fileOutcomes(ctx.ledger.read(), [call], [outcome]));
      entry = find();
    }
    if (!entry?.club) return { error: 'No live data for that club, so no XI to draw.' };
    const story = ctx.stored.find((s) => sameClubName(s.club, entry!.club!.team))?.story;
    const view = lineupViewOf(applyStory(deriveClubCore(entry.club), story));
    if (!view) return { error: 'No recent lineups or season starts to work an XI out from.' };
    return { block: pitchBlock(ctx.newId(), view) };
  },

  toolResult: ({ data: view }) => ({
    shown: true,
    club: view.club,
    formation: view.formation,
    xi: view.xi.map((s) => `${s.role} ${s.name ?? 'unknown'}${s.rotation ? ` (even split with ${s.rotation})` : ''}`).join(', '),
    out: view.out.map((o) => o.name).join(', ') || 'nobody listed',
  }),
  ...BLOCK_TEXT.pitch,
};
