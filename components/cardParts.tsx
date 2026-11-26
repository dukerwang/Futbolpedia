import React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Pieces of a card's body shared by the side panel and the card page. */

export const renderCardMarkdown = (text: string | undefined) => {
  if (!text) return { __html: '' };
  return { __html: DOMPurify.sanitize(marked.parse(text) as string) };
};

const attributeBarClass = (rating: number) => {
  if (rating >= 90) return 'bg-emerald-500'; // 90+ Emerald (World-Class threshold)
  if (rating >= 80) return 'bg-emerald-400'; // 80-89 Sage/Light Green
  if (rating >= 70) return 'bg-charcoal/50 dark:bg-gray-400'; // 70-79 Charcoal Light
  return 'bg-gray-200 dark:bg-gray-700'; // <70 Faint Grey
};

export const AttributeLine: React.FC<{ label: string; rating: number }> = ({ label, rating }) => (
  <div className="group">
    <div className="flex justify-between text-xs mb-1.5 items-end">
      <span className="text-charcoal/70 dark:text-cream-200 font-medium">{label}</span>
      <span
        className={`font-mono text-sm leading-none font-bold ${rating >= 90 ? 'text-emerald-600 dark:text-emerald-400' : 'text-charcoal dark:text-cream-100'}`}
      >
        {rating}
      </span>
    </div>
    <div className="h-[3px] w-full bg-cream-400/30 dark:bg-charcoal-light/50 rounded-full overflow-hidden">
      <div
        className={`h-full relative transition-all duration-1000 rounded-full ${attributeBarClass(rating)}`}
        style={{ width: `${rating}%` }}
      />
    </div>
  </div>
);

/** A card section's small-capitals serif heading with its hairline. */
export const CardSectionTitle: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = 'mb-3' }) => (
  <h3 className={`font-serif font-bold text-[22px] leading-tight tracking-[-0.01em] text-charcoal dark:text-cream-50 ${className}`}>{children}</h3>
);