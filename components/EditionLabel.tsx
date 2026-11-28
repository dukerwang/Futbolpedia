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
  /** For a long window (a current card's 12 months): in a narrow place it moves to a second line, whole. */
  wrap?: boolean;
  className?: string;
}

export const InkLabel: React.FC<InkLabelProps> = ({ ink, name, when, title, size = 'sm', compact, wrap, className = '' }) => {
  const s = SIZE[size];
  const layout = wrap ? 'flex-wrap gap-y-0.5' : compact ? 'shrink-0 max-w-[65%]' : '';
  const whenClass = wrap
    ? `whitespace-nowrap font-mono ${s.when}`
    : compact
      ? `truncate ${s.text}`
      : `shrink-0 font-mono ${s.when}`;
  const mark = <span aria-hidden="true" className={`shrink-0 rotate-45 rounded-[1px] ${s.mark} ${INK_DOT[ink]}`} />;
  const label = <span className={`font-medium ${s.text} ${compact || wrap ? 'shrink-0 whitespace-nowrap' : 'truncate'} ${INK_TEXT[ink]}`}>{name}</span>;
  return (
    <span className={`inline-flex items-center ${s.gap} min-w-0 font-sans ${layout} ${className}`} title={title}>
      {wrap ? (
        // The mark stays beside the name when the window drops below them.
        <span className={`inline-flex items-center ${s.gap}`}>
          {mark}
          {label}
        </span>
      ) : (
        <>
          {mark}
          {label}
        </>
      )}
      {when && <span className={`text-charcoal/45 dark:text-cream-400/70 ${whenClass}`}>{when}</span>}
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
      wrap={Boolean(profile.version?.formWindow)}
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
