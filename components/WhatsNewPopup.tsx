import React, { useState, useEffect } from 'react';

interface WhatsNewPopupProps {
  onClose?: () => void;
}

export const WhatsNewPopup: React.FC<WhatsNewPopupProps> = ({ onClose }) => {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    // Check if user has seen this v3 version of the 'What's New' popup
    const hasSeen = localStorage.getItem('futbolpedia-whats-new-seen-v3');
    if (!hasSeen) {
      setIsOpen(true);
    }
  }, []);

  const handleClose = () => {
    localStorage.setItem('futbolpedia-whats-new-seen-v3', 'true');
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
        className="relative w-full max-w-7xl bg-cream-100 dark:bg-charcoal-surface rounded-2xl border border-cream-300 dark:border-charcoal-border shadow-dark-float dark:shadow-2xl overflow-hidden flex flex-col max-h-[90vh] md:max-h-[85vh] animate-in fade-in zoom-in-95 duration-300 z-10"
        id="whats-new-card"
      >
        {/* Header - Styled with Elegant Serif Headings */}
        <div className="relative px-6 pt-6 pb-4 md:px-8 md:pt-8 md:pb-6 border-b border-cream-300/60 dark:border-charcoal-border/50 shrink-0">
          <button 
            onClick={handleClose}
            className="absolute top-4 right-4 md:top-6 md:right-6 p-2 text-cream-800 dark:text-cream-400 hover:text-charcoal dark:hover:text-cream-100 hover:bg-cream-300/50 dark:hover:bg-charcoal-light rounded-full transition-all duration-200"
            title="Dismiss"
            id="whats-new-close-btn"
          >
            <span className="material-symbols-outlined text-[24px] block">close</span>
          </button>

          <div className="flex items-center gap-2.5 mb-2">
            <div className="size-8 flex items-center justify-center text-emerald-500 bg-emerald-500/10 dark:bg-emerald-500/15 rounded-full">
              <span className="material-symbols-outlined text-[18px]">sports_soccer</span>
            </div>
            <span className="text-[10px] font-mono uppercase tracking-[0.25em] text-emerald-600 dark:text-emerald-400 font-bold">
              Update Briefing • v3.0
            </span>
          </div>

          <h2 className="text-2xl md:text-4xl font-serif font-bold text-charcoal dark:text-cream-100 tracking-tight leading-tight">
            What's New in Futbolpedia
          </h2>
          <p className="text-xs md:text-sm text-cream-800 dark:text-cream-400 mt-1 md:mt-2 font-sans font-light">
            We've overhauled the scouting experience with multi-player comparisons, dynamic sharing, persistent chats, and faster, highly accurate reports.
          </p>
        </div>

        {/* Scrollable Body - Bento Grid style content */}
        <div className="flex-1 overflow-y-auto px-6 py-6 md:px-8 md:py-8 space-y-8 custom-scrollbar">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
            
            {/* Column 1: Juggle multiple players and chats at once */}
            <div className="flex flex-col space-y-4 p-5 rounded-xl bg-cream-200/50 dark:bg-charcoal/40 border border-cream-300/30 dark:border-charcoal-border/30" id="feature-group-multitasking">
              <div className="flex items-center gap-3 pb-3 border-b border-cream-300/40 dark:border-charcoal-border/40">
                <div className="size-9 flex items-center justify-center text-emerald-500 bg-emerald-500/10 rounded-lg shrink-0">
                  <span className="material-symbols-outlined text-[20px]">layers</span>
                </div>
                <div>
                  <h3 className="font-serif text-lg font-bold text-charcoal dark:text-cream-100 leading-snug">Multi-Scouting</h3>
                  <p className="text-[10px] font-mono text-cream-800 dark:text-cream-400 uppercase tracking-wider mt-0.5">Tabs & Side-by-Side</p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex gap-3">
                  <span className="text-emerald-500 font-serif text-sm mt-0.5 shrink-0 select-none">✦</span>
                  <div>
                    <h4 className="text-sm font-semibold text-charcoal dark:text-cream-100">Multiple dossiers side by side</h4>
                    <p className="text-xs text-cream-800 dark:text-cream-400 mt-1 font-light leading-relaxed">
                      Build a whole library of player dossiers and flip between them, instead of being stuck with one at a time. Compare, revisit, and keep your shortlist right at hand.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <span className="text-emerald-500 font-serif text-sm mt-0.5 shrink-0 select-none">✦</span>
                  <div>
                    <h4 className="text-sm font-semibold text-charcoal dark:text-cream-100">Multiple conversations at once</h4>
                    <p className="text-xs text-cream-800 dark:text-cream-400 mt-1 font-light leading-relaxed">
                      Keep several scouting threads going in parallel and switch between them freely, so different players and questions each get their own space.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Column 2: Share your scouting */}
            <div className="flex flex-col space-y-4 p-5 rounded-xl bg-cream-200/50 dark:bg-charcoal/40 border border-cream-300/30 dark:border-charcoal-border/30" id="feature-group-share">
              <div className="flex items-center gap-3 pb-3 border-b border-cream-300/40 dark:border-charcoal-border/40">
                <div className="size-9 flex items-center justify-center text-emerald-500 bg-emerald-500/10 rounded-lg shrink-0">
                  <span className="material-symbols-outlined text-[20px]">share</span>
                </div>
                <div>
                  <h3 className="font-serif text-lg font-bold text-charcoal dark:text-cream-100 leading-snug">Share Scouting</h3>
                  <p className="text-[10px] font-mono text-cream-800 dark:text-cream-400 uppercase tracking-wider mt-0.5">Dossiers & Links</p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex gap-3">
                  <span className="text-emerald-500 font-serif text-sm mt-0.5 shrink-0 select-none">✦</span>
                  <div>
                    <h4 className="text-sm font-semibold text-charcoal dark:text-cream-100">Send a dossier to anyone</h4>
                    <p className="text-xs text-cream-800 dark:text-cream-400 mt-1 font-light leading-relaxed">
                      Every player dossier now has its own shareable link — one click copies it to your clipboard, ready to drop in a chat or group.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <span className="text-emerald-500 font-serif text-sm mt-0.5 shrink-0 select-none">✦</span>
                  <div>
                    <h4 className="text-sm font-semibold text-charcoal dark:text-cream-100">Share whole conversations</h4>
                    <p className="text-xs text-cream-800 dark:text-cream-400 mt-1 font-light leading-relaxed">
                      Share an entire back-and-forth, dossiers included. When a friend opens your link, the full conversation lands in their library so they can pick up right where you left off.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <span className="text-emerald-500 font-serif text-sm mt-0.5 shrink-0 select-none">✦</span>
                  <div>
                    <h4 className="text-sm font-semibold text-charcoal dark:text-cream-100">Quick share everywhere</h4>
                    <p className="text-xs text-cream-800 dark:text-cream-400 mt-1 font-light leading-relaxed">
                      Hover over any dossier or past conversation and a link icon is right there — save and copy in one tap.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Column 3: Keep every chat */}
            <div className="flex flex-col space-y-4 p-5 rounded-xl bg-cream-200/50 dark:bg-charcoal/40 border border-cream-300/30 dark:border-charcoal-border/30" id="feature-group-history">
              <div className="flex items-center gap-3 pb-3 border-b border-cream-300/40 dark:border-charcoal-border/40">
                <div className="size-9 flex items-center justify-center text-emerald-500 bg-emerald-500/10 rounded-lg shrink-0">
                  <span className="material-symbols-outlined text-[20px]">forum</span>
                </div>
                <div>
                  <h3 className="font-serif text-lg font-bold text-charcoal dark:text-cream-100 leading-snug">Keep Every Chat</h3>
                  <p className="text-[10px] font-mono text-cream-800 dark:text-cream-400 uppercase tracking-wider mt-0.5">Persistence & UI</p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex gap-3">
                  <span className="text-emerald-500 font-serif text-sm mt-0.5 shrink-0 select-none">✦</span>
                  <div>
                    <h4 className="text-sm font-semibold text-charcoal dark:text-cream-100">Conversation history</h4>
                    <p className="text-xs text-cream-800 dark:text-cream-400 mt-1 font-light leading-relaxed">
                      Your chats are saved automatically, so you can jump back into any past conversation instead of starting over.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <span className="text-emerald-500 font-serif text-sm mt-0.5 shrink-0 select-none">✦</span>
                  <div>
                    <h4 className="text-sm font-semibold text-charcoal dark:text-cream-100">Cleaner, calmer interface</h4>
                    <p className="text-xs text-cream-800 dark:text-cream-400 mt-1 font-light leading-relaxed">
                      Answers now stream in with a smooth typewriter effect and a refreshed loading indicator, and dossier controls moved up to the header so the chat stays focused.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <span className="text-emerald-500 font-serif text-sm mt-0.5 shrink-0 select-none">✦</span>
                  <div>
                    <h4 className="text-sm font-semibold text-charcoal dark:text-cream-100">Dossier library in focus</h4>
                    <p className="text-xs text-cream-800 dark:text-cream-400 mt-1 font-light leading-relaxed">
                      The dossier button and its count are always visible, so your saved players are never more than a click away. Player age now sits right alongside position and club in the header.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Column 4: Smarter, faster answers */}
            <div className="flex flex-col space-y-4 p-5 rounded-xl bg-cream-200/50 dark:bg-charcoal/40 border border-cream-300/30 dark:border-charcoal-border/30" id="feature-group-intelligence">
              <div className="flex items-center gap-3 pb-3 border-b border-cream-300/40 dark:border-charcoal-border/40">
                <div className="size-9 flex items-center justify-center text-emerald-500 bg-emerald-500/10 rounded-lg shrink-0">
                  <span className="material-symbols-outlined text-[20px]">bolt</span>
                </div>
                <div>
                  <h3 className="font-serif text-lg font-bold text-charcoal dark:text-cream-100 leading-snug">Smarter, Faster</h3>
                  <p className="text-[10px] font-mono text-cream-800 dark:text-cream-400 uppercase tracking-wider mt-0.5">Analytic Engine</p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex gap-3">
                  <span className="text-emerald-500 font-serif text-sm mt-0.5 shrink-0 select-none">✦</span>
                  <div>
                    <h4 className="text-sm font-semibold text-charcoal dark:text-cream-100">Noticeably faster dossiers</h4>
                    <p className="text-xs text-cream-800 dark:text-cream-400 mt-1 font-light leading-relaxed">
                      Popular players come back instantly, and even fresh scouting reports are generated meaningfully quicker than before.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <span className="text-emerald-500 font-serif text-sm mt-0.5 shrink-0 select-none">✦</span>
                  <div>
                    <h4 className="text-sm font-semibold text-charcoal dark:text-cream-100">Deeper quick answers</h4>
                    <p className="text-xs text-cream-800 dark:text-cream-400 mt-1 font-light leading-relaxed">
                      Fast responses now dig into more sources behind the scenes, so you get richer, more complete scouting without the wait.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <span className="text-emerald-500 font-serif text-sm mt-0.5 shrink-0 select-none">✦</span>
                  <div>
                    <h4 className="text-sm font-semibold text-charcoal dark:text-cream-100">Accurate scouting reports</h4>
                    <p className="text-xs text-cream-800 dark:text-cream-400 mt-1 font-light leading-relaxed">
                      Ratings now reflect a realistic spread of a player's real ability, and write-ups read like a genuine scout's take on player identity.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <span className="text-emerald-500 font-serif text-sm mt-0.5 shrink-0 select-none">✦</span>
                  <div>
                    <h4 className="text-sm font-semibold text-charcoal dark:text-cream-100">Cleaner dossiers</h4>
                    <p className="text-xs text-cream-800 dark:text-cream-400 mt-1 font-light leading-relaxed">
                      Bios, CDM/CAM labels, and tactical summaries are more polished and consistent with no stray formatting.
                    </p>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>

        {/* Footer / Call To Action */}
        <div className="px-6 py-5 md:px-8 md:py-6 border-t border-cream-300/60 dark:border-charcoal-border/50 bg-cream-200/40 dark:bg-charcoal/20 flex flex-col sm:flex-row items-center justify-between gap-4 shrink-0">
          <span className="text-xs font-mono text-cream-800 dark:text-cream-400 flex items-center gap-1.5 font-light">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            Scouting network live & fully operational
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
