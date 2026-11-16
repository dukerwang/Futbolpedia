import React, { useState } from 'react';

/** A player the reply discussed who has no card yet: one tap sends him to Scout. */
export const ScoutOffer: React.FC<{ name: string; onScout: (name: string) => void }> = ({ name, onScout }) => {
    const [sent, setSent] = useState(false);
    // "prime <name>" offers his prime when only his current form is rated (`scoutOfferRequest`).
    const prime = /^prime\s+/i.test(name);
    const player = prime ? name.replace(/^prime\s+/i, '') : name;
    return (
        <button
            type="button"
            disabled={sent}
            onClick={() => { setSent(true); onScout(name); }}
            className="group/offer flex items-center gap-3 min-h-11 pl-3 pr-3.5 border border-cream-300 dark:border-charcoal-border bg-cream-50/60 dark:bg-charcoal-surface/60 hover:border-emerald-600 dark:hover:border-emerald-500 disabled:hover:border-cream-300 dark:disabled:hover:border-charcoal-border transition-colors text-left"
        >
            <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-emerald-600 dark:text-emerald-400">
                {sent ? 'check' : 'person_search'}
            </span>
            <span className="min-w-0 text-[13px] font-sans text-charcoal/60 dark:text-cream-400/70">
                {prime ? 'No prime dossier on ' : 'No dossier on '}<span className="font-serif font-bold text-[15px] text-charcoal dark:text-cream-50">{player}</span>
            </span>
            <span className="ml-auto shrink-0 flex items-center gap-1 text-[11px] font-sans font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-400">
                {sent ? 'On the desk' : 'Scout'}
                {!sent && <span aria-hidden="true" className="material-symbols-outlined text-[16px] group-hover/offer:translate-x-0.5 transition-transform">arrow_forward</span>}
            </span>
        </button>
    );
};
