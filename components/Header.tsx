import React from 'react';

export type AppView = 'chat' | 'hub';

interface HeaderProps {
    onNewChat: () => void;
    toggleTheme: () => void;
    isDarkMode: boolean;
    dossierCount: number;
    view: AppView;
    onViewChange: (view: AppView) => void;
    onToggleConversations: () => void;
    isConversationsOpen: boolean;
}

const VIEW_TABS: Array<{ id: AppView; label: string; icon: string }> = [
    { id: 'chat', label: 'Chat', icon: 'chat' },
    { id: 'hub', label: 'Dossiers', icon: 'folder_shared' },
];

export const Header: React.FC<HeaderProps> = ({ 
    onNewChat, 
    toggleTheme, 
    isDarkMode,
    dossierCount,
    view,
    onViewChange,
    onToggleConversations,
    isConversationsOpen,
}) => {
  return (
    <header className="sticky top-0 w-full flex items-center justify-between gap-3 px-4 sm:px-8 pt-[calc(1.25rem+env(safe-area-inset-top))] pb-5 bg-cream-200 dark:bg-charcoal z-50 shrink-0 border-b border-cream-300 dark:border-charcoal-border select-none transition-colors duration-300">
        <div className="flex items-center gap-4 min-w-0">
            <div className="size-10 shrink-0 flex items-center justify-center text-charcoal dark:text-cream-50 border-2 border-charcoal dark:border-cream-50 rounded-full">
                <span className="material-symbols-outlined text-[22px]">sports_soccer</span>
            </div>
            <div className="hidden sm:flex flex-col">
                <h1 className="text-charcoal dark:text-cream-50 text-xl font-serif font-bold tracking-tight leading-none">Futbolpedia AI 2</h1>
                <span className="text-[10px] text-cream-800 dark:text-cream-400 uppercase tracking-[0.2em] mt-0.5">Analysis Tool</span>
            </div>
        </div>
        
        <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
            <nav
                aria-label="Main views"
                className="flex items-center p-0.5 rounded-full bg-cream-300/60 dark:bg-charcoal-light/50 border border-cream-300 dark:border-charcoal-border"
            >
                {VIEW_TABS.map(({ id, label, icon }) => {
                    const selected = view === id;
                    return (
                        <button
                            key={id}
                            onClick={() => onViewChange(id)}
                            aria-current={selected ? 'page' : undefined}
                            className={`flex items-center gap-1.5 px-2.5 sm:px-3.5 py-1.5 rounded-full text-xs font-sans font-semibold transition-colors ${
                                selected
                                ? 'bg-white dark:bg-charcoal text-charcoal dark:text-cream-50 shadow-xs'
                                : 'text-charcoal/60 dark:text-cream-400 hover:text-charcoal dark:hover:text-cream-100'
                            }`}
                            title={label}
                            aria-label={id === 'hub' && dossierCount > 0 ? `${label} (${dossierCount})` : label}
                        >
                            <span aria-hidden="true" className={`material-symbols-outlined text-[18px] block ${selected ? 'text-emerald-600 dark:text-emerald-400' : ''}`}>{icon}</span>
                            <span className="hidden sm:inline">{label}</span>
                            {id === 'hub' && dossierCount > 0 && (
                                <span className="min-w-4 h-4 px-1 flex items-center justify-center rounded-full text-[9px] font-mono font-bold bg-emerald-500 text-white">
                                    {dossierCount}
                                </span>
                            )}
                        </button>
                    );
                })}
            </nav>

            <button
                onClick={onToggleConversations}
                className={`p-2 rounded-full transition-colors ${
                    isConversationsOpen 
                    ? 'bg-emerald-500 text-white hover:bg-emerald-600' 
                    : 'text-charcoal dark:text-cream-400 hover:bg-cream-300 dark:hover:bg-charcoal-light'
                }`}
                title={isConversationsOpen ? "Close Saved Briefings" : "Open Saved Briefings"}
            >
                <span className="material-symbols-outlined text-[20px] block">forum</span>
            </button>

            <button 
                onClick={toggleTheme} 
                className="p-2 text-charcoal dark:text-cream-400 hover:bg-cream-300 dark:hover:bg-charcoal-light rounded-full transition-colors"
                title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
                <span className="material-symbols-outlined text-[20px]">{isDarkMode ? 'light_mode' : 'dark_mode'}</span>
            </button>

            <button 
                onClick={onNewChat} 
                className="btn-new-chat p-2 text-charcoal dark:text-cream-400 hover:bg-cream-300 dark:hover:bg-charcoal-light rounded-full"
                title="New Chat"
            >
                <span className="material-symbols-outlined text-[20px] block btn-new-chat-icon">add_comment</span>
            </button>
        </div>
    </header>
  );
};