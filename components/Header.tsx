import React from 'react';

interface HeaderProps {
    onNewChat: () => void;
    toggleTheme: () => void;
    isDarkMode: boolean;
}

export const Header: React.FC<HeaderProps> = ({ onNewChat, toggleTheme, isDarkMode }) => {
  return (
    <header className="sticky top-0 w-full flex items-center justify-between px-8 pt-[calc(1.25rem+env(safe-area-inset-top))] pb-5 bg-cream-200 dark:bg-charcoal z-50 shrink-0 border-b border-cream-300 dark:border-charcoal-border select-none transition-colors duration-300">
        <div className="flex items-center gap-4">
            <div className="size-10 flex items-center justify-center text-charcoal dark:text-cream-50 border-2 border-charcoal dark:border-cream-50 rounded-full">
                <span className="material-symbols-outlined text-[22px]">sports_soccer</span>
            </div>
            <div className="flex flex-col">
                <h1 className="text-charcoal dark:text-cream-50 text-xl font-serif font-bold tracking-tight leading-none">Futbolpedia AI</h1>
                <span className="text-[10px] text-cream-800 dark:text-cream-400 uppercase tracking-[0.2em] mt-0.5">Analysis Tool</span>
            </div>
        </div>
        
        <div className="flex items-center gap-4">
            <button 
                onClick={toggleTheme} 
                className="p-2 text-charcoal dark:text-cream-400 hover:bg-cream-300 dark:hover:bg-charcoal-light rounded-full transition-colors"
                title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
                <span className="material-symbols-outlined text-[20px]">{isDarkMode ? 'light_mode' : 'dark_mode'}</span>
            </button>

            <button 
                onClick={onNewChat} 
                className="p-2 text-charcoal dark:text-cream-400 hover:bg-cream-300 dark:hover:bg-charcoal-light rounded-full transition-colors"
                title="Reset Chat"
            >
                <span className="material-symbols-outlined text-[20px]">restart_alt</span>
            </button>
        </div>
    </header>
  );
};