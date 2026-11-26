import React from 'react';
import type { PlayerProfile } from '../types';
import { editionInkOf, editionParts, INK_DOT, INK_TEXT, type EditionInk } from './hub/editionInk';

/**
 * A card's version, written rather than boxed: a small diamond and the edition's name in its ink,
 * then the window it covers in a quieter voice ("◆ Prime 2010–12"). Used wherever a card names
 * its version, so Prime reads gold, an era blue, a season copper and current form emerald
 * throughout the app.
 */

const SIZE = {
  xs: { text: 'text-[11.5px]', when: 'text-[10.5px]', mark: 'w-[5px] h-[5px]', gap: 'gap-1.5' },
  sm: { text: 'text-[12.5px]', when: 'text-[11px]', mark: 'w-[6px] h-[6px]', gap: 'gap-1.5' },
  md: { text: 'text-[13.5px]', when: 'text-[12px]', mark: 'w-[7px] h-[7px]', gap: 'gap-2' },
} as const;

interface InkLabelProps {
  ink: EditionInk;
  name: string;
  when?: string;
  title?: string;
  size?: keyof typeof SIZE;
  /** Phones: keep the name whole and let the window give way. */
  compact?: boolean;
  className?: string;
}

export const InkLabel: React.FC<InkLabelProps> = ({ ink, name, when, title, size = 'sm', compact, className = '' }) => {
  const s = SIZE[size];
  return (
    <span className={`inline-flex items-center ${s.gap} min-w-0 font-sans ${compact ? 'shrink-0 max-w-[65%]' : ''} ${className}`} title={title}>
      <span aria-hidden="true" className={`shrink-0 rotate-45 rounded-[1px] ${s.mark} ${INK_DOT[ink]}`} />
      <span className={`font-medium ${s.text} ${compact ? 'shrink-0 whitespace-nowrap' : 'truncate'} ${INK_TEXT[ink]}`}>{name}</span>
      {when && (
        <span className={`text-charcoal/45 dark:text-cream-400/70 ${compact ? `truncate ${s.text}` : `shrink-0 font-mono ${s.when}`}`}>{when}</span>
      )}
    </span>
  );
};

interface EditionLabelProps {
  profile: PlayerProfile;
  /** In the global hub an older current card reads as an earlier rating. */
  earlierRating?: boolean;
  size?: keyof typeof SIZE;
  compact?: boolean;
  className?: string;
}

export const EditionLabel: React.FC<EditionLabelProps> = ({ profile, earlierRating = false, size, compact, className }) => {
  const { name, when, title } = editionParts(profile, earlierRating);
  return (
    <InkLabel
      ink={earlierRating ? 'older' : editionInkOf(profile)}
      name={name}
      when={when}
      title={title}
      size={size}
      compact={compact}
      className={className}
    />
  );
};

/** "Your revision", in the same written style, beside an edition label. */
export const RevisionNote: React.FC<{ title?: string; size?: keyof typeof SIZE }> = ({ title = 'Your accepted challenge of the shared card', size = 'sm' }) => (
  <span className={`shrink-0 font-sans font-medium text-indigo-600 dark:text-indigo-300 ${SIZE[size].text}`} title={title}>
    Your Revision
  </span>
);
