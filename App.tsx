import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { ChatHistory } from './components/ChatHistory';
import { ChatInput } from './components/ChatInput';
import { SidePanel } from './components/SidePanel';
import { ConversationsPanel } from './components/ConversationsPanel';
import type { ChatMessage, PlayerProfile, Conversation } from './types';
import { sendMessageToAI, resetChat, supabase } from './services/geminiService';

const generateId = () => `id-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
const CHAT_HISTORY_KEY = 'futbolpedia-chat-history';
const ACTIVE_PROFILE_KEY = 'futbolpedia-active-profile';

const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMessage, setLoadingMessage] = useState<string>('Processing...');
  const [isLoading, setIsLoading] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Conversations State
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [isConversationsOpen, setIsConversationsOpen] = useState(false);
  const isInitializedRef = useRef(false);

  // Sidebar / Dossier State
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [activeProfile, setActiveProfile] = useState<PlayerProfile | null>(null);
  const [allProfiles, setAllProfiles] = useState<PlayerProfile[]>([]);
  const [globalDossiers, setGlobalDossiers] = useState<PlayerProfile[]>([]);

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

  // Helper to save and set active profile, keeping list of all dossiers up-to-date
  const saveAndSetActiveProfile = useCallback((profile: PlayerProfile | null) => {
    setActiveProfile(profile);
    if (profile) {
      const profileWithDate = {
        ...profile,
        createdAt: profile.createdAt || Date.now()
      };
      
      localStorage.setItem(ACTIVE_PROFILE_KEY, JSON.stringify(profileWithDate));
      
      setGlobalDossiers(prev => {
        const existsIndex = prev.findIndex(p => p.basicInfo.name.toLowerCase() === profileWithDate.basicInfo.name.toLowerCase());
        let updated: PlayerProfile[];
        if (existsIndex === -1) {
          updated = [...prev, profileWithDate];
        } else {
          updated = [...prev];
          updated[existsIndex] = {
            ...profileWithDate,
            createdAt: prev[existsIndex].createdAt || profileWithDate.createdAt
          };
        }
        localStorage.setItem('futbolpedia-global-dossiers', JSON.stringify(updated));
        return updated;
      });

      setAllProfiles(prev => {
        const exists = prev.some(p => p.basicInfo.name.toLowerCase() === profileWithDate.basicInfo.name.toLowerCase());
        if (!exists) {
          const updated = [...prev, profileWithDate];
          localStorage.setItem('futbolpedia-all-profiles', JSON.stringify(updated));
          return updated;
        }
        return prev;
      });
    } else {
      localStorage.removeItem(ACTIVE_PROFILE_KEY);
    }
  }, []);

  // Load Conversations & Profiles (with Migration)
  useEffect(() => {
    let savedConvs: Conversation[] = [];
    try {
      const stored = localStorage.getItem('futbolpedia-conversations');
      if (stored) {
        savedConvs = JSON.parse(stored);
      }
    } catch (e) {
      console.error("Failed to load conversations:", e);
    }

    // Migration of legacy chat data if conversations is empty
    if (savedConvs.length === 0) {
      try {
        const legacyMessages = localStorage.getItem(CHAT_HISTORY_KEY);
        const legacyActiveProfile = localStorage.getItem(ACTIVE_PROFILE_KEY);
        const legacyAllProfiles = localStorage.getItem('futbolpedia-all-profiles');

        let initialMessages: ChatMessage[] = [];
        let initialActiveProfile: PlayerProfile | null = null;
        let initialAllProfiles: PlayerProfile[] = [];

        if (legacyMessages) {
          const parsed = JSON.parse(legacyMessages);
          if (Array.isArray(parsed)) initialMessages = parsed;
        }
        if (legacyActiveProfile) {
          initialActiveProfile = JSON.parse(legacyActiveProfile);
        }
        if (legacyAllProfiles) {
          const parsed = JSON.parse(legacyAllProfiles);
          if (Array.isArray(parsed)) initialAllProfiles = parsed;
        }

        if (initialMessages.length > 0 || initialActiveProfile || initialAllProfiles.length > 0) {
          const legacyConv: Conversation = {
            id: 'legacy-chat',
            title: 'Archived Briefing',
            messages: initialMessages,
            createdAt: Date.now(),
            activeProfile: initialActiveProfile,
            allProfiles: initialAllProfiles,
          };
          savedConvs = [legacyConv];
        }
      } catch (e) {
        console.error("Failed to migrate legacy chat data:", e);
      }
    }

    // If still empty, create a default briefing
    if (savedConvs.length === 0) {
      const defaultId = generateId();
      const defaultConv: Conversation = {
        id: defaultId,
        title: 'New Briefing',
        messages: [],
        createdAt: Date.now(),
        activeProfile: null,
        allProfiles: [],
      };
      savedConvs = [defaultConv];
    }

    setConversations(savedConvs);

    // Load global dossiers
    let savedGlobalDossiers: PlayerProfile[] = [];
    try {
      const storedGlobal = localStorage.getItem('futbolpedia-global-dossiers');
      if (storedGlobal) {
        savedGlobalDossiers = JSON.parse(storedGlobal);
      } else {
        // Migrate from 'futbolpedia-all-profiles'
        const oldProfilesStr = localStorage.getItem('futbolpedia-all-profiles');
        if (oldProfilesStr) {
          const parsedOld = JSON.parse(oldProfilesStr);
          if (Array.isArray(parsedOld)) {
            savedGlobalDossiers = parsedOld.map((p: any) => ({
              ...p,
              createdAt: p.createdAt || Date.now()
            }));
          }
        }

        // Migrate from saved conversations if present
        savedConvs.forEach(conv => {
          if (conv.allProfiles) {
            conv.allProfiles.forEach(prof => {
              const exists = savedGlobalDossiers.some(p => p.basicInfo.name.toLowerCase() === prof.basicInfo.name.toLowerCase());
              if (!exists) {
                savedGlobalDossiers.push({
                  ...prof,
                  createdAt: prof.createdAt || conv.createdAt || Date.now()
                });
              }
            });
          }
        });

        localStorage.setItem('futbolpedia-global-dossiers', JSON.stringify(savedGlobalDossiers));
      }
    } catch (e) {
      console.error("Failed to load global dossiers:", e);
    }
    setGlobalDossiers(savedGlobalDossiers);

    // Set active conversation ID
    let activeId = localStorage.getItem('futbolpedia-active-conversation-id');
    if (!activeId || !savedConvs.some(c => c.id === activeId)) {
      activeId = savedConvs[0].id;
    }
    setActiveConversationId(activeId);
    localStorage.setItem('futbolpedia-active-conversation-id', activeId);

    // Load active conversation's data into individual states
    const activeConv = savedConvs.find(c => c.id === activeId) || savedConvs[0];
    setMessages(activeConv.messages);
    setActiveProfile(activeConv.activeProfile);
    setAllProfiles(activeConv.allProfiles);

    // Mark as initialized so synchronization effect can run safely
    isInitializedRef.current = true;

    // Handle shared profile via Hash URL
    const loadSharedProfile = async () => {
      const hash = window.location.hash;
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
              const profile = data.player_data as PlayerProfile;
              
              // Add a shared notification message
              const sharedMsg: ChatMessage = {
                id: `shared-${Date.now()}`,
                sender: 'ai',
                content: `I've retrieved the archived dossier for **${profile.basicInfo.name}**.`,
                timestamp: Date.now(),
              };

              setMessages(prev => [...prev, sharedMsg]);
              setActiveProfile(profile);
              
              const profileWithDate = {
                ...profile,
                createdAt: profile.createdAt || Date.now()
              };

              setGlobalDossiers(prev => {
                const exists = prev.some(p => p.basicInfo.name.toLowerCase() === profileWithDate.basicInfo.name.toLowerCase());
                if (!exists) {
                  const updated = [...prev, profileWithDate];
                  localStorage.setItem('futbolpedia-global-dossiers', JSON.stringify(updated));
                  return updated;
                }
                return prev;
              });

              setAllProfiles(prev => {
                const exists = prev.some(p => p.basicInfo.name.toLowerCase() === profileWithDate.basicInfo.name.toLowerCase());
                if (!exists) {
                  return [...prev, profileWithDate];
                }
                return prev;
              });
              setIsPanelOpen(true);
              window.history.replaceState({}, '', window.location.pathname);
            }
          } catch (err) {
            console.error("Shared profile fetch failed:", err);
          } finally {
            setIsLoading(false);
          }
        }
      }
    };

    loadSharedProfile();
  }, []);

  // Synchronize active conversation state to the conversations list and save to localStorage
  useEffect(() => {
    if (!isInitializedRef.current || !activeConversationId) return;

    setConversations(prev => {
      const exists = prev.some(c => c.id === activeConversationId);
      if (!exists) return prev;

      const updated = prev.map(conv => {
        if (conv.id === activeConversationId) {
          let title = conv.title;
          if (title === 'New Chat' || title === 'New Briefing' || title === '') {
            const firstUserMsg = messages.find(m => m.sender === 'user');
            if (firstUserMsg && typeof firstUserMsg.content === 'string') {
              const textContent = firstUserMsg.content;
              title = textContent.substring(0, 30).trim() + (textContent.length > 30 ? '...' : '');
            }
          }

          return {
            ...conv,
            messages,
            activeProfile,
            allProfiles,
            title
          };
        }
        return conv;
      });

      localStorage.setItem('futbolpedia-conversations', JSON.stringify(updated));
      return updated;
    });
  }, [messages, activeProfile, allProfiles, activeConversationId]);
  
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
      timestamp: Date.now(),
    };
    
    setMessages(prev => [...prev, newUserMessage]);

    try {
      const aiResponse = await sendMessageToAI(userMessageText, messages, imageData, mode);
      
      let newAiMessage: ChatMessage;

      // Logic: If response is a Profile, open dossier but keep chat text clean
      if (typeof aiResponse === 'object' && 'basicInfo' in aiResponse) {
          const profile = aiResponse as PlayerProfile;
          saveAndSetActiveProfile(profile);
          setIsPanelOpen(true); // Auto-open toggle

          newAiMessage = {
            id: generateId(),
            sender: 'ai',
            content: `Dossier generated for **${profile.basicInfo.name}**. See the side panel for full analysis.`,
            timestamp: Date.now(),
          };
      } else if (typeof aiResponse === 'object' && 'summary' in aiResponse) {
          // Comparison - for now treat as text/summary in chat
           newAiMessage = {
            id: generateId(),
            sender: 'ai',
            content: aiResponse,
            timestamp: Date.now(),
          };
      } else {
          newAiMessage = {
            id: generateId(),
            sender: 'ai',
            content: aiResponse,
            timestamp: Date.now(),
          };
      }

      setMessages(prev => [...prev, newAiMessage]);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred.';
      setMessages(prev => [...prev, {
        id: generateId(),
        sender: 'ai',
        content: `Editor's Note: I encountered an issue. ${errorMessage}`,
        timestamp: Date.now(),
      }]);
    } finally {
        setIsLoading(false);
    }
  }, [messages]);

  const handleSelectProfile = useCallback((profile: PlayerProfile | null) => {
    setActiveProfile(profile);
    if (profile) {
      localStorage.setItem(ACTIVE_PROFILE_KEY, JSON.stringify(profile));
    } else {
      localStorage.removeItem(ACTIVE_PROFILE_KEY);
    }
  }, []);

  const handleRenameDossier = useCallback((oldName: string, newName: string) => {
    setGlobalDossiers(prev => {
      const updated = prev.map(d => {
        if (d.basicInfo.name.toLowerCase() === oldName.toLowerCase()) {
          return {
            ...d,
            basicInfo: {
              ...d.basicInfo,
              name: newName
            }
          };
        }
        return d;
      });
      localStorage.setItem('futbolpedia-global-dossiers', JSON.stringify(updated));
      return updated;
    });

    setActiveProfile(prev => {
      if (prev && prev.basicInfo.name.toLowerCase() === oldName.toLowerCase()) {
        const updated = {
          ...prev,
          basicInfo: {
            ...prev.basicInfo,
            name: newName
          }
        };
        localStorage.setItem(ACTIVE_PROFILE_KEY, JSON.stringify(updated));
        return updated;
      }
      return prev;
    });
  }, []);

  const handleDeleteDossier = useCallback((playerName: string) => {
    setGlobalDossiers(prev => {
      const filtered = prev.filter(d => d.basicInfo.name.toLowerCase() !== playerName.toLowerCase());
      localStorage.setItem('futbolpedia-global-dossiers', JSON.stringify(filtered));
      return filtered;
    });

    setActiveProfile(prev => {
      if (prev && prev.basicInfo.name.toLowerCase() === playerName.toLowerCase()) {
        localStorage.removeItem(ACTIVE_PROFILE_KEY);
        return null;
      }
      return prev;
    });
  }, []);

  const handleSelectConversation = useCallback((id: string) => {
    resetChat();
    const target = conversations.find(c => c.id === id);
    if (!target) return;

    setActiveConversationId(id);
    localStorage.setItem('futbolpedia-active-conversation-id', id);

    setMessages(target.messages);
    setActiveProfile(target.activeProfile);
    setAllProfiles(target.allProfiles);
  }, [conversations]);

  const handleNewConversation = useCallback(() => {
    resetChat();
    const newId = generateId();
    const newConv: Conversation = {
      id: newId,
      title: 'New Briefing',
      messages: [],
      createdAt: Date.now(),
      activeProfile: null,
      allProfiles: [],
    };

    setConversations(prev => {
      const updated = [newConv, ...prev];
      localStorage.setItem('futbolpedia-conversations', JSON.stringify(updated));
      return updated;
    });

    setActiveConversationId(newId);
    localStorage.setItem('futbolpedia-active-conversation-id', newId);

    setMessages([]);
    setActiveProfile(null);
    setAllProfiles([]);
    setIsPanelOpen(false);
  }, []);

  const handleRenameConversation = useCallback((id: string, newTitle: string) => {
    setConversations(prev => {
      const updated = prev.map(c => c.id === id ? { ...c, title: newTitle } : c);
      localStorage.setItem('futbolpedia-conversations', JSON.stringify(updated));
      return updated;
    });
  }, []);

  const handleDeleteConversation = useCallback((id: string) => {
    setConversations(prev => {
      const filtered = prev.filter(c => c.id !== id);
      
      if (activeConversationId === id) {
        if (filtered.length > 0) {
          const nextActive = filtered[0];
          setActiveConversationId(nextActive.id);
          localStorage.setItem('futbolpedia-active-conversation-id', nextActive.id);
          setMessages(nextActive.messages);
          setActiveProfile(nextActive.activeProfile);
          setAllProfiles(nextActive.allProfiles);
        } else {
          const newId = generateId();
          const newConv: Conversation = {
            id: newId,
            title: 'New Briefing',
            messages: [],
            createdAt: Date.now(),
            activeProfile: null,
            allProfiles: [],
          };
          filtered.push(newConv);
          setActiveConversationId(newId);
          localStorage.setItem('futbolpedia-active-conversation-id', newId);
          setMessages([]);
          setActiveProfile(null);
          setAllProfiles([]);
          setIsPanelOpen(false);
        }
      }

      localStorage.setItem('futbolpedia-conversations', JSON.stringify(filtered));
      return filtered;
    });
  }, [activeConversationId]);

  const togglePanel = () => {
    setIsPanelOpen(prev => !prev);
  };

  const toggleConversations = () => {
    setIsConversationsOpen(!isConversationsOpen);
  };

  return (
    <div className="flex flex-col h-full bg-cream-200 dark:bg-charcoal text-charcoal dark:text-cream-100 transition-colors duration-300 relative">
      
      <Header 
        onNewChat={handleNewConversation} 
        toggleTheme={toggleTheme} 
        isDarkMode={isDarkMode} 
        allProfilesCount={globalDossiers.length}
        onToggleDossier={togglePanel}
        isPanelOpen={isPanelOpen}
        onToggleConversations={toggleConversations}
        isConversationsOpen={isConversationsOpen}
      />
      
      {/* Slide-out Dossier Panel - LEFT SIDED */}
      <SidePanel 
          isOpen={isPanelOpen} 
          onClose={() => setIsPanelOpen(false)} 
          profile={activeProfile} 
          allProfiles={globalDossiers}
          onSelectProfile={handleSelectProfile}
          onBackToHome={() => handleSelectProfile(null)}
          onRenameDossier={handleRenameDossier}
          onDeleteDossier={handleDeleteDossier}
      />

      {/* Slide-out Conversations Panel - RIGHT SIDED */}
      <ConversationsPanel 
          isOpen={isConversationsOpen} 
          onClose={() => setIsConversationsOpen(false)} 
          conversations={conversations}
          activeConversationId={activeConversationId}
          onSelectConversation={handleSelectConversation}
          onNewConversation={handleNewConversation}
          onRenameConversation={handleRenameConversation}
          onDeleteConversation={handleDeleteConversation}
      />

      <div className={`flex-1 flex flex-col relative overflow-hidden transition-all duration-500 ease-ios-ease ${isPanelOpen ? 'md:pl-[450px]' : ''} ${isConversationsOpen ? 'md:pr-[350px]' : ''}`}>
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
                    />
                </div>
            </div>
          </main>
      </div>
    </div>
  );
};

export default App;