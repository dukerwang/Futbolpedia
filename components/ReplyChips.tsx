import React, { useState } from 'react';

const chipClass =
    'inline-flex items-center gap-1.5 min-h-10 px-3.5 border border-cream-300 dark:border-charcoal-border bg-cream-50/60 dark:bg-charcoal-surface/60 text-[14px] font-sans text-charcoal/85 dark:text-cream-100/90 text-left transition-colors hover:border-emerald-600 dark:hover:border-emerald-500 disabled:opacity-50 disabled:hover:border-cream-300 dark:disabled:hover:border-charcoal-border';

/** The options of a question the reply asked: one tap sends that reading as the next message. */
export const AskChips: React.FC<{ options: string[]; onAsk: (text: string) => void }> = ({ options, onAsk }) => {
    const [picked, setPicked] = useState<string | null>(null);
    return (
        <div role="group" aria-label="Reply options" className="flex flex-wrap gap-2">
            {options.map(option => (
                <button
                    key={option}
                    type="button"
                    disabled={picked !== null}
                    aria-pressed={picked === option}
                    onClick={() => { setPicked(option); onAsk(option); }}
                    className={`${chipClass} ${picked === option ? 'border-emerald-600 dark:border-emerald-500' : ''}`}
                >
                    {option}
                </button>
            ))}
        </div>
    );
};
