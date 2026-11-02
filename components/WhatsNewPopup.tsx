import React, { useState, useEffect } from 'react';

interface WhatsNewPopupProps {
  onClose?: () => void;
}

/** Bump when the popup describes a new release, so everyone sees it once more. */
const SEEN_KEY = 'futbolpedia-whats-new-seen-fp36b';

interface FeatureGroup {
  id: string;
  icon: string;
  title: string;
  kicker: string;
  items: Array<{ title: string; body: string }>;
  /** Full width: the headline of the briefing. */
  featured?: boolean;
  /** Half width on large screens: a release's own highlights. */
  wide?: boolean;
}

const scoutShortcut = (): string =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl+K';

/** Everything that's changed since Futbolpedia 2: the library first, then 3.6 and 3.5, then the rest by what you do with it. */
const featureGroups = (): FeatureGroup[] => [
  {
    id: 'library',
    icon: 'public',
    title: 'The Global Dossier Library',
    kicker: 'The heart of Futbolpedia 3',
    featured: true,
    items: [
      {
        title: 'Scouted once, shared with everyone',
        body: 'Every dossier anyone creates joins one library the whole community shares. You never start from a blank page, and the library grows with every player scouted.',
      },
      {
        title: 'Instant cards',
        body: 'Look up a player who is already in the library and the card opens in under a second, whatever name you type.',
      },
      {
        title: 'Everyone argues about the same numbers',
        body: "There's one card for each version of a player, so your rating is everyone's rating. When enough people make the same good case against a card, it gets re-rated.",
      },
      {
        title: 'Explore the whole game',
        body: "Browse every card, filter by position, rating and edition, find the biggest risers, and jump from a player's current form to their prime, eras and single seasons.",
      },
    ],
  },
  {
    id: 'past',
    icon: 'history_edu',
    title: 'Settle Any Debate',
    kicker: 'New in 3.6',
    wide: true,
    items: [
      {
        title: 'Greatest-ever questions, answered properly',
        body: 'Who was better at their peak? Who is the best ever in a position? Get a clear verdict, argued point by point, that takes the other side’s best case seriously.',
      },
      {
        title: 'Grounded in the record',
        body: 'Past seasons and careers are checked against the historical record, so every fact is right and sits in the right season.',
      },
      {
        title: 'Consistent with the ratings',
        body: 'Verdicts follow the library’s ratings, so your argument and your cards tell the same story.',
      },
      {
        title: 'Stats you can quote',
        body: 'Numbers come with their competition and seasons attached, ready for your next argument.',
      },
    ],
  },
  {
    id: 'present',
    icon: 'stadium',
    title: 'Football As It Is Today',
    kicker: 'New in 3.5',
    wide: true,
    items: [
      {
        title: "This weekend's team",
        body: 'Ask about any club and get the players who are actually starting and who is injured, not last season’s lineup.',
      },
      {
        title: "What's new, first",
        body: 'Answers lead with what has changed: the signings, the new shape, the player who has taken over a role.',
      },
      {
        title: 'A real opinion',
        body: 'The analyst picks one starter for every position and takes a clear stance, the way a scout would.',
      },
      {
        title: 'Facts it can back up',
        body: 'Answers are built on live match data, and anything that can’t be checked is left out instead of made up.',
      },
    ],
  },
  {
    id: 'ratings',
    icon: 'workspace_premium',
    title: 'One Scale for Every Era',
    kicker: 'Ratings',
    items: [
      {
        title: 'Compare anyone with anyone',
        body: "A 1970s legend and today's breakout star are rated on the same all-time scale, so comparisons across eras finally mean something.",
      },
      {
        title: 'Every version of a player',
        body: 'Rate current form, a prime, a named era such as a spell at one club, or a single season.',
      },
      {
        title: 'Ratings with receipts',
        body: 'Each card shows who a player was better than, level with and behind, how strong the evidence is, and the case for rating them higher or lower.',
      },
      {
        title: 'Always up to date',
        body: 'Current-form cards are re-rated every month and refreshed every week. Prime and history cards stay fixed.',
      },
    ],
  },
  {
    id: 'scout',
    icon: 'person_search',
    title: 'Scout at Speed',
    kicker: 'Scout',
    items: [
      {
        title: 'Scout a whole squad',
        body: `Open Scout from the header or with ${scoutShortcut()} and paste a list of names. Players are rated in the background while you keep chatting.`,
      },
      {
        title: 'Your shortlist, saved',
        body: 'Every card you scout or open is kept in Your dossiers, ready to share with a link.',
      },
      {
        title: 'Make your case',
        body: 'Disagree with a rating? Challenge it in chat. Win the argument and you keep your revised card.',
      },
    ],
  },
  {
    id: 'chat',
    icon: 'forum',
    title: 'An Analyst Who Knows Your Cards',
    kicker: 'Chat',
    items: [
      {
        title: 'Bring any card into the chat',
        body: 'Type @ to pull in any card from the library, and the analyst quotes its exact numbers.',
      },
      {
        title: 'Beyond scouting',
        body: 'Tactics, club form, rankings, transfers: ask anything about football and get an answer with a point of view.',
      },
      {
        title: 'Pick up where you left off',
        body: 'Conversations are saved and titled for you, and you can share a whole chat, cards included.',
      },
    ],
  },
  {
    id: 'gaffa',
    icon: 'sports',
    title: 'Gaffa Mode',
    kicker: 'Fantasy league',
    items: [
      {
        title: 'Your league, your rules',
        body: 'Switch on Gaffa in the chat box for answers drawn from your league’s own rules.',
      },
      {
        title: 'Connect your club',
        body: 'Sign in and pick your club. Gaffa reads your roster, budget, standings, matchup and lineup, plus live listings, auctions and free agents.',
      },
      {
        title: 'Smarter decisions',
        body: 'Audit your starting XI, get a scored verdict on any trade, and know your bid ceiling before an auction.',
      },
    ],
  },
];

export const WhatsNewPopup: React.FC<WhatsNewPopupProps> = ({ onClose }) => {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem(SEEN_KEY)) setIsOpen(true);
  }, []);

  const handleClose = () => {
    localStorage.setItem(SEEN_KEY, 'true');
    setIsOpen(false);
    if (onClose) {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-6 overflow-y-auto" id="whats-new-modal-container">
      {/* Backdrop with smooth blur and fade */}
      <div
        className="fixed inset-0 bg-charcoal/45 dark:bg-black/70 backdrop-blur-md transition-opacity duration-500 ease-out"
        onClick={handleClose}
        id="whats-new-backdrop"
      />

      {/* Modal Card */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        className="relative w-full max-w-7xl bg-cream-100 dark:bg-charcoal-surface rounded-2xl border border-cream-300 dark:border-charcoal-border shadow-dark-float dark:shadow-2xl overflow-hidden flex flex-col max-h-[90vh] md:max-h-[85vh] animate-in fade-in zoom-in-95 duration-300 z-10"
        id="whats-new-card"
      >
        {/* Header - Styled with Elegant Serif Headings */}
        <div className="relative px-6 pt-6 pb-4 md:px-8 md:pt-8 md:pb-6 border-b border-cream-300/60 dark:border-charcoal-border/50 shrink-0">
          <button
            onClick={handleClose}
            className="absolute top-4 right-4 md:top-6 md:right-6 p-2 text-cream-800 dark:text-cream-400 hover:text-charcoal dark:hover:text-cream-100 hover:bg-cream-300/50 dark:hover:bg-charcoal-light rounded-full transition-all duration-200"
            title="Dismiss"
            aria-label="Dismiss"
            id="whats-new-close-btn"
          >
            <span className="material-symbols-outlined text-[24px] block">close</span>
          </button>

          <div className="flex items-center gap-2.5 mb-2">
            <div className="size-8 flex items-center justify-center text-emerald-500 bg-emerald-500/10 dark:bg-emerald-500/15 rounded-full">
              <span className="material-symbols-outlined text-[18px]">sports_soccer</span>
            </div>
            <span className="text-[10px] font-mono uppercase tracking-[0.25em] text-emerald-600 dark:text-emerald-400 font-bold">
              Update Briefing • v3.6
            </span>
          </div>

          <h2 id="whats-new-title" className="text-2xl md:text-4xl font-serif font-bold text-charcoal dark:text-cream-100 tracking-tight leading-tight">
            Welcome to Futbolpedia 3.6
          </h2>
          <p className="text-xs md:text-sm text-cream-800 dark:text-cream-400 mt-1 md:mt-2 font-sans font-light">
            Your AI scout for every era of football. Since Futbolpedia 2, every player has one rating on a single all-time scale, every dossier joins a library the whole community shares, and the analyst knows this weekend's lineup as well as the great sides of history.
          </p>
        </div>

        {/* Scrollable Body - Bento Grid style content */}
        <div className="flex-1 overflow-y-auto px-6 py-6 md:px-8 md:py-8 space-y-8 custom-scrollbar">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
            {featureGroups().map((group) => (
              <div
                key={group.id}
                className={`flex flex-col space-y-4 p-5 rounded-xl bg-cream-200/50 dark:bg-charcoal/40 border ${
                  group.featured
                    ? 'md:col-span-2 xl:col-span-4 border-emerald-500/30 dark:border-emerald-500/25'
                    : group.wide
                      ? 'md:col-span-2 border-emerald-500/30 dark:border-emerald-500/25'
                      : 'border-cream-300/30 dark:border-charcoal-border/30'
                }`}
                id={`feature-group-${group.id}`}
              >
                <div className="flex items-center gap-3 pb-3 border-b border-cream-300/40 dark:border-charcoal-border/40">
                  <div className="size-9 flex items-center justify-center text-emerald-500 bg-emerald-500/10 rounded-lg shrink-0">
                    <span className="material-symbols-outlined text-[20px]">{group.icon}</span>
                  </div>
                  <div>
                    <h3 className="font-serif text-lg font-bold text-charcoal dark:text-cream-100 leading-snug">{group.title}</h3>
                    <p className="text-[10px] font-mono text-cream-800 dark:text-cream-400 uppercase tracking-wider mt-0.5">{group.kicker}</p>
                  </div>
                </div>

                <div
                  className={
                    group.featured ? 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4' : group.wide ? 'grid grid-cols-1 sm:grid-cols-2 gap-4' : 'space-y-4'
                  }
                >
                  {group.items.map((item) => (
                    <div key={item.title} className="flex gap-3">
                      <span className="text-emerald-500 font-serif text-sm mt-0.5 shrink-0 select-none">✦</span>
                      <div>
                        <h4 className="text-sm font-semibold text-charcoal dark:text-cream-100">{item.title}</h4>
                        <p className="text-xs text-cream-800 dark:text-cream-400 mt-1 font-light leading-relaxed">{item.body}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer / Call To Action */}
        <div className="px-6 py-5 md:px-8 md:py-6 border-t border-cream-300/60 dark:border-charcoal-border/50 bg-cream-200/40 dark:bg-charcoal/20 flex flex-col sm:flex-row items-center justify-between gap-4 shrink-0">
          <span className="text-xs font-mono text-cream-800 dark:text-cream-400 flex items-center gap-1.5 font-light">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            Press {scoutShortcut()} anywhere to open Scout
          </span>
          <button
            onClick={handleClose}
            className="w-full sm:w-auto px-6 py-3 bg-emerald-500 hover:bg-emerald-600 dark:bg-emerald-500 dark:hover:bg-emerald-600 text-white font-sans font-medium text-sm rounded-lg shadow-sm hover:shadow transition-all duration-200 flex items-center justify-center gap-2 group cursor-pointer"
            id="whats-new-cta-btn"
          >
            Start Scouting
            <span className="material-symbols-outlined text-[16px] group-hover:translate-x-0.5 transition-transform">arrow_forward</span>
          </button>
        </div>
      </div>
    </div>
  );
};
