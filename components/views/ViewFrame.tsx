import React from 'react';

/**
 * The frame every reply view sits in: a square-cornered panel with a thin rule and a small-caps
 * caption strip naming the view ("TABLE · PREMIER LEAGUE · 2026-27"). It matches the chat's other
 * pieces (`DossierChatCard`, the Scout offer) and sets `@container`, so a view lays itself out
 * by the width of its own frame rather than the window's.
 */

/** Height of the caption strip. A skeleton and its settled view both use it, so neither moves. */
export const CAPTION_H = 'h-7';

const CAPTION_TEXT = 'text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/50 dark:text-cream-400/60';

export interface ViewFrameProps {
  /** The view's kind, for tests and the gallery: `table`, `comparison`, `ranking`, `pitch`. */
  kind: string;
  /** Parts of the caption, joined with a middle dot. Empty parts are dropped. */
  caption: Array<string | null | undefined>;
  /** Right end of the strip, such as an "as of" date. */
  meta?: string | null;
  /** The view is waiting for its data: the frame says so to assistive technology. */
  pending?: boolean;
  /** What a screen reader calls the frame. Defaults to the caption. */
  label?: string;
  /** Padding is the view's own: tables run edge to edge, a pitch sits inset. */
  children: React.ReactNode;
}

export const ViewFrame: React.FC<ViewFrameProps> = ({ kind, caption, meta, pending, label, children }) => {
  const text = caption.filter(Boolean).join(' · ');
  return (
    <section
      data-view={kind}
      data-state={pending ? 'pending' : 'ready'}
      aria-label={label ?? text}
      aria-busy={pending || undefined}
      className="@container min-w-0 w-full border border-cream-300 dark:border-charcoal-border bg-cream-50/70 dark:bg-charcoal-surface/70"
    >
      <header className={`${CAPTION_H} flex items-center justify-between gap-3 px-3 border-b border-cream-300 dark:border-charcoal-border`}>
        <p className={`${CAPTION_TEXT} truncate`}>{text}</p>
        {meta ? <p className={`${CAPTION_TEXT} shrink-0 font-mono font-medium`}>{meta}</p> : null}
      </header>
      {children}
    </section>
  );
};

/** A grey bar standing in for text or a number while a view waits for its data. */
export const SkeletonBar: React.FC<{ className?: string }> = ({ className = '' }) => (
  <span
    aria-hidden="true"
    className={`block bg-charcoal/10 dark:bg-cream-100/10 animate-pulse motion-reduce:animate-none ${className}`}
  />
);

export { CAPTION_TEXT };
