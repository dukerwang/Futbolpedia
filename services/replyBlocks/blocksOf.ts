import type { ChatDossierRef, ChatMessage, ReplyBlock } from '../../types';
import { getLegacyDossierRef } from '../dossierRefs';
import { askBlock } from './ask';
import { cardBlock } from './card';
import { goDeeperBlock } from './goDeeper';
import { pitchBlock } from './pitch';
import { proseBlock } from './prose';
import { scorecardBlock } from './scorecard';
import { scoutOfferBlock } from './scoutOffer';

export const LEGACY_ERROR_PREFIX = "Editor's Note: I encountered an issue.";

/** Legacy chats may still store old comparison objects: their summary is the prose. */
const legacyComparisonSummary = (content: unknown): string | null => {
  if (typeof content !== 'object' || content === null) return null;
  if (!('summary' in content) || !('players' in content)) return null;
  const summary = (content as { summary?: unknown }).summary;
  return typeof summary === 'string' ? summary : null;
};

/** The text a message's content stands for: its prose, a stored profile's notice, an old comparison's summary. */
export function proseTextOf(message: ChatMessage): string {
  const { content } = message;
  if (typeof content === 'string') {
    const isError = message.sender !== 'user' && (message.isError || content.startsWith(LEGACY_ERROR_PREFIX));
    return isError ? content.replace(LEGACY_ERROR_PREFIX, '').trim() : content;
  }
  if (typeof content === 'object' && content !== null && 'basicInfo' in content) {
    const profile = content as { basicInfo: { name: string }; shortBio: string };
    return `**Dossier Generated: ${profile.basicInfo.name}**\n\n${profile.shortBio}`;
  }
  return legacyComparisonSummary(content) ?? '';
}

/**
 * What a message shows, in order. A new reply holds its blocks; a stored one is built from its
 * legacy fields in today's order: scorecard, dossier, prose, XIs, cards, Scout offers, the
 * question, Go deeper. Storage is never rewritten.
 */
export function blocksOf(message: ChatMessage): ReplyBlock[] {
  if (message.blocks) return message.blocks;
  const blocks: ReplyBlock[] = [];
  let n = 0;
  const id = () => `legacy-${++n}`;
  const isUser = message.sender === 'user';
  if (message.gaffaScorecard) blocks.push(scorecardBlock(id(), message.gaffaScorecard));
  const dossier = message.dossier ?? (isUser ? null : getLegacyDossierRef(message.content));
  if (dossier) blocks.push(cardBlock(id(), dossier));
  const text = proseTextOf(message);
  if (text) blocks.push(proseBlock(id(), text));
  for (const view of message.lineups ?? []) blocks.push(pitchBlock(id(), view));
  for (const card of message.cards ?? []) blocks.push(cardBlock(id(), card));
  for (const name of message.scoutOffers ?? []) blocks.push(scoutOfferBlock(id(), name));
  if (message.ask?.options.length) blocks.push(askBlock(id(), message.ask));
  if (message.goDeeper?.reason) blocks.push(goDeeperBlock(id(), message.goDeeper));
  return blocks;
}

/** Kinds a stored reply may still hold but nothing draws: Go deeper reran a turn in the chat loop, which every eligible turn now takes. */
const RETIRED_KINDS = new Set<ReplyBlock['kind']>(['goDeeper']);

/** The blocks a reply draws: `blocksOf` without the retired kinds. */
export const drawnBlocksOf = (message: ChatMessage): ReplyBlock[] => blocksOf(message).filter((b) => !RETIRED_KINDS.has(b.kind));

/** A reply's blocks with a dossier card ahead of the prose (after a scorecard), as a revised card is shown. */
export function withDossierBlock(blocks: ReplyBlock[], dossier: ChatDossierRef): ReplyBlock[] {
  const at = blocks.findIndex((b) => b.kind !== 'scorecard');
  const card = cardBlock('dossier', dossier);
  return at < 0 ? [...blocks, card] : [...blocks.slice(0, at), card, ...blocks.slice(at)];
}
