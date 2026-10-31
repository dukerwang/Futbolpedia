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
    <header className="sticky top-0 w-full flex items-center justify-between gap-3 px-4 sm:px-8 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:pt-[calc(1.25rem+env(safe-area-inset-top))] pb-3 sm:pb-5 bg-cream-200 dark:bg-charcoal z-50 shrink-0 border-b border-cream-300 dark:border-charcoal-border select-none transition-colors duration-300">
        {/* The brand doubles as the way home to the chat */}
        <button
            onClick={() => onViewChange('chat')}
            className="flex items-center gap-4 min-w-0 text-left rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            title="Back to chat"
            aria-label="Futbolpedia, back to chat"
        >
            <div className="size-10 shrink-0 flex items-center justify-center text-charcoal dark:text-cream-50 border-2 border-charcoal dark:border-cream-50 rounded-full">
                <span className="material-symbols-outlined text-[22px]">sports_soccer</span>
            </div>
            <div className="hidden sm:flex flex-col">
                <h1 className="text-charcoal dark:text-cream-50 text-xl font-serif font-bold tracking-tight leading-none">Futbolpedia AI 2</h1>
                <span className="text-[10px] text-cream-800 dark:text-cream-400 uppercase tracking-[0.2em] mt-0.5">Analysis Tool</span>
            </div>
        </button>
        
        <div className="flex items-center gap-0.5 sm:gap-3 shrink-0">
            <button
                onClick={() => onViewChange(view === 'hub' ? 'chat' : 'hub')}
                aria-pressed={view === 'hub'}
                className={`relative flex items-center gap-1.5 p-2 md:pl-2.5 md:pr-3.5 rounded-full transition-colors ${
                    view === 'hub'
                    ? 'bg-emerald-500 text-white hover:bg-emerald-600'
                    : 'text-charcoal dark:text-cream-400 hover:bg-cream-300 dark:hover:bg-charcoal-light'
                }`}
                title={view === 'hub' ? 'Back to chat' : 'Dossiers'}
                aria-label={dossierCount > 0 ? `Dossiers (${dossierCount})` : 'Dossiers'}
            >
                <span aria-hidden="true" className="material-symbols-outlined text-[20px] block">folder_shared</span>
                <span aria-hidden="true" className="hidden md:inline text-[11px] font-sans font-bold uppercase tracking-widest">Dossiers</span>
                {dossierCount > 0 && (
                    <span className={`absolute -top-1 -right-1 flex h-4 min-w-4 px-1 items-center justify-center rounded-full text-[9px] font-mono font-bold shadow-sm transition-colors ${
                        view === 'hub'
                        ? 'bg-charcoal dark:bg-cream-200 text-cream-50 dark:text-charcoal'
                        : 'bg-emerald-500 text-white'
                    }`}>
                        {dossierCount}
                    </span>
                )}
            </button>

            <button
                onClick={onToggleConversations}
                className={`flex items-center gap-1.5 p-2 md:pl-2.5 md:pr-3.5 rounded-full transition-colors ${
                    isConversationsOpen 
                    ? 'bg-emerald-500 text-white hover:bg-emerald-600' 
                    : 'text-charcoal dark:text-cream-400 hover:bg-cream-300 dark:hover:bg-charcoal-light'
                }`}
                title={isConversationsOpen ? "Close past chats" : "Past chats"}
                aria-label={isConversationsOpen ? "Close past chats" : "Past chats"}
            >
                <span aria-hidden="true" className="material-symbols-outlined text-[20px] block">forum</span>
                <span aria-hidden="true" className="hidden md:inline text-[11px] font-sans font-bold uppercase tracking-widest">Chats</span>
            </button>

            <button 
                onClick={toggleTheme} 
                className="p-2 text-charcoal dark:text-cream-400 hover:bg-cream-300 dark:hover:bg-charcoal-light rounded-full transition-colors"
                title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
                aria-label={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
                <span className="material-symbols-outlined text-[20px] block">{isDarkMode ? 'light_mode' : 'dark_mode'}</span>
            </button>

            <button 
                onClick={onNewChat} 
                className="btn-new-chat flex items-center gap-1.5 p-2 md:pl-2.5 md:pr-3.5 text-charcoal dark:text-cream-400 hover:bg-cream-300 dark:hover:bg-charcoal-light rounded-full"
                title="New chat"
                aria-label="New chat"
            >
                <span aria-hidden="true" className="material-symbols-outlined text-[20px] block btn-new-chat-icon">add_comment</span>
                <span aria-hidden="true" className="hidden md:inline text-[11px] font-sans font-bold uppercase tracking-widest">New chat</span>
            </button>
        </div>
    </header>
  );
};