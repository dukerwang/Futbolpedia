import React, { useState, useCallback, useEffect } from 'react';
import { Header } from './components/Header';
import { ChatHistory } from './components/ChatHistory';
import { ChatInput } from './components/ChatInput';
import { SidePanel } from './components/SidePanel';
import type { ChatMessage, PlayerProfile } from './types';
import { sendMessageToAI, resetChat, supabase } from './services/geminiService';

const generateId = () => `id-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
const CHAT_HISTORY_KEY = 'futbolpedia-chat-history';
const ACTIVE_PROFILE_KEY = 'futbolpedia-active-profile';

const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMessage, setLoadingMessage] = useState<string>('Processing...');
  const [isLoading, setIsLoading] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Sidebar / Dossier State
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [activeProfile, setActiveProfile] = useState<PlayerProfile | null>(null);

  // Initialize Theme
  useEffect(() => {
    if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        setIsDarkMode(true);
        document.documentElement.classList.add('dark');
    } else {
        setIsDarkMode(false);
        document.documentElement.classList.remove('dark');
    }
  }, []);

  const toggleTheme = () => {
    if (isDarkMode) {
        document.documentElement.classList.remove('dark');
        localStorage.theme = 'light';
        setIsDarkMode(false);
    } else {
        document.documentElement.classList.add('dark');
        localStorage.theme = 'dark';
        setIsDarkMode(true);
    }
  };

  // Load Shared Profile or Persisted Profile
  useEffect(() => {
    const loadData = async () => {
      const hash = window.location.hash; 
      
      // 1. Shared Profile URL Priority
      if (hash.startsWith('#/player/')) {
        const shareId = hash.split('/').pop(); 
        if (shareId) {
          setIsLoading(true);
          try {
            const { data, error } = await supabase
              .from('profiles')
              .select('player_data')
              .eq('id', shareId)
              .single();

            if (error) throw error;

            if (data?.player_data) {
                const profile = data.player_data;
                setMessages([{
                    id: `shared-${Date.now()}`,
                    sender: 'ai',
                    content: "I've retrieved the archived dossier for " + profile.basicInfo.name + ".",
                }]);
                setActiveProfile(profile);
                setIsPanelOpen(true);
                window.history.replaceState({}, '', window.location.pathname); 
                // Save to local persistence
                localStorage.setItem(ACTIVE_PROFILE_KEY, JSON.stringify(profile));
            }
          } catch (err) {
            console.error("Shared profile fetch failed:", err);
          } finally {
            setIsLoading(false);
          }
          return; // Exit if shared profile found
        }
      }

      // 2. Local Persistence Fallback
      try {
        const savedProfile = localStorage.getItem(ACTIVE_PROFILE_KEY);
        if (savedProfile) {
            setActiveProfile(JSON.parse(savedProfile));
        }
      } catch (e) {
        console.error("Failed to load active profile", e);
      }
    };
    loadData();
  }, []);

  // Load History
  useEffect(() => {
    try {
      const savedMessages = localStorage.getItem(CHAT_HISTORY_KEY);
      if (savedMessages && !window.location.hash.includes('/player/')) {
        const parsedMessages = JSON.parse(savedMessages);
        if (Array.isArray(parsedMessages)) setMessages(parsedMessages);
      }
    } catch (error) {
      console.error("Failed to load chat history:", error);
    }
  }, []);

  // Save History
  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(messages));
    }
  }, [messages]);
  
  const handleSendMessage = useCallback(async (userMessageText: string, imageData?: string, mode: 'default' | 'fast' = 'default') => {
    if (!userMessageText.trim() && !imageData) return;

    // Set Loading State
    let specificLoadingMessage = 'Consulting archives...';
    const lowerCaseMessage = userMessageText.toLowerCase();
    if (mode === 'fast') specificLoadingMessage = 'Quick lookup...';
    else if (imageData) specificLoadingMessage = 'Analyzing imagery...';
    else if (lowerCaseMessage.includes('rate') || lowerCaseMessage.includes('profile')) specificLoadingMessage = 'Scouting player...';
    
    setLoadingMessage(specificLoadingMessage);
    setIsLoading(true);

    // Add User Message
    const newUserMessage: ChatMessage = {
      id: generateId(),
      sender: 'user',
      content: userMessageText || "Image uploaded",
      image: imageData,
    };
    
    setMessages(prev => [...prev, newUserMessage]);

    try {
      const aiResponse = await sendMessageToAI(userMessageText, messages, imageData, mode);
      
      let newAiMessage: ChatMessage;

      // Logic: If response is a Profile, open dossier but keep chat text clean
      if (typeof aiResponse === 'object' && 'basicInfo' in aiResponse) {
          const profile = aiResponse as PlayerProfile;
          setActiveProfile(profile);
          setIsPanelOpen(true); // Auto-open toggle
          
          // Persist the new active profile
          localStorage.setItem(ACTIVE_PROFILE_KEY, JSON.stringify(profile));

          newAiMessage = {
            id: generateId(),
            sender: 'ai',
            content: `Dossier generated for **${profile.basicInfo.name}**. See the side panel for full analysis.`,
          };
      } else if (typeof aiResponse === 'object' && 'summary' in aiResponse) {
          // Comparison - for now treat as text/summary in chat
           newAiMessage = {
            id: generateId(),
            sender: 'ai',
            content: aiResponse,
          };
      } else {
          newAiMessage = {
            id: generateId(),
            sender: 'ai',
            content: aiResponse,
          };
      }

      setMessages(prev => [...prev, newAiMessage]);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
      setMessages(prev => [...prev, {
        id: generateId(),
        sender: 'ai',
        content: `Editor's Note: I encountered an issue. ${errorMessage}`
      }]);
    } finally {
        setIsLoading(false);
    }
  }, [messages]);

  const handleNewChat = useCallback(() => {
    resetChat();
    localStorage.removeItem(CHAT_HISTORY_KEY);
    localStorage.removeItem(ACTIVE_PROFILE_KEY);
    setIsLoading(false);
    setMessages([]);
    setActiveProfile(null);
    setIsPanelOpen(false);
  }, []);

  const togglePanel = () => {
      // If we have an active profile, we can toggle. If not, maybe show a hint.
      if (activeProfile) {
          setIsPanelOpen(!isPanelOpen);
      } else if (!isPanelOpen) {
          // Optional: Could show a toast saying "Generate a profile first"
          console.log("No profile to show");
      }
  };

  return (
    <div className="flex flex-col h-full bg-cream-200 dark:bg-charcoal text-charcoal dark:text-cream-100 transition-colors duration-300 relative">
      
      <Header onNewChat={handleNewChat} toggleTheme={toggleTheme} isDarkMode={isDarkMode} />
      
      {/* Slide-out Dossier Panel - LEFT SIDED */}
      <SidePanel 
          isOpen={isPanelOpen} 
          onClose={() => setIsPanelOpen(false)} 
          profile={activeProfile} 
      />

      <div className={`flex-1 flex flex-col relative overflow-hidden transition-all duration-500 ease-ios-ease ${isPanelOpen ? 'md:pl-[450px]' : ''}`}>
          {/* Main Chat Area */}
          <main className="flex-1 flex flex-col w-full h-full relative min-h-0">
            <ChatHistory 
                messages={messages} 
                isLoading={isLoading} 
                loadingMessage={loadingMessage} 
            />
            
            {/* Input Container - Sticky Bottom */}
            <div className="flex-none px-6 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:pb-8 bg-gradient-to-t from-cream-200 dark:from-charcoal via-cream-200/95 dark:via-charcoal/95 to-transparent z-20">
                <div className="max-w-[800px] mx-auto w-full">
                    <ChatInput 
                        onSendMessage={handleSendMessage} 
                        isLoading={isLoading} 
                        loadingMessage={loadingMessage} 
                        onToggleDossier={togglePanel}
                    />
                </div>
            </div>
          </main>
      </div>
    </div>
  );
};

export default App;