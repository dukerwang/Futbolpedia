import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Header, type AppView } from './components/Header';
import { ChatHistory } from './components/ChatHistory';
import { ChatInput } from './components/ChatInput';
import { SidePanel } from './components/SidePanel';
import { ConversationsPanel } from './components/ConversationsPanel';
import { WhatsNewPopup } from './components/WhatsNewPopup';
import { DossierHub, type HubTab } from './components/DossierHub';
import { cardReference } from './components/pills';
import type {
  ChatMessage,
  PlayerProfile,
  Conversation,
  ChatDomain,
  GaffaAuthUser,
  GaffaUserClub,
  ChatDossierRef,
  RatingRequest,
} from './types';
import { toChatDossierRef } from './components/DossierChatCard';
import {
  sendMessageToAI,
  ratePlayer,
  resetChat,
  getCachedDossier,
  getSharedConversation,
  ensureDossierDated,
  getCardKey,
  renameDossierCard,
  stampDossier,
} from './services/geminiService';
import { ratingTask } from './services/ratingCommand';
import { sendGaffaMessage } from './services/gaffaChatService';
import { looksLikeGaffaQuestion } from './services/gaffaDetect';
import {
  clearGaffaLink,
  fetchGaffaContext,
  loadGaffaLink,
  mapResponseToBag,
  parseGaffaConnectHash,
  resolveContextBagForSend,
  saveGaffaLink,
  type GaffaLinkState,
} from './services/gaffaContext';
import {
  fetchMyGaffaClubs,
  getGaffaSessionUser,
  onGaffaAuthStateChange,
  signInGaffaWithGoogle,
  signInGaffaWithPassword,
  signOutGaffa,
} from './services/gaffaAuth';
import { GaffaConnectStrip } from './components/GaffaConnectStrip';

const generateId = () => `id-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
const CHAT_HISTORY_KEY = 'futbolpedia-chat-history';
const ACTIVE_PROFILE_KEY = 'futbolpedia-active-profile';
const GLOBAL_DOSSIERS_KEY = 'futbolpedia-global-dossiers';
const LEGACY_ALL_PROFILES_KEY = 'futbolpedia-all-profiles';

const saveGlobalDossiers = (dossiers: PlayerProfile[]) =>
  localStorage.setItem(GLOBAL_DOSSIERS_KEY, JSON.stringify(dossiers));

/**
 * Replaces the card with the same card key, or appends it. The user's revision of a card is
 * never replaced by the unrevised shared version (opening it from the hub, a cache hit).
 */
const upsertCard = (list: PlayerProfile[], card: PlayerProfile): PlayerProfile[] => {
  const key = getCardKey(card);
  const index = list.findIndex(p => getCardKey(p) === key);
  if (index === -1) return [...list, card];
  if (list[index].revision && !card.revision) return list;
  return list.map((p, i) => (i === index ? card : p));
};

/** Appends the cards whose card key isn't in the list yet; returns the same list if none are new. */
const addMissingCards = (list: PlayerProfile[], cards: PlayerProfile[]): PlayerProfile[] => {
  const keys = new Set(list.map(getCardKey));
  const added = cards.filter(card => {
    const key = getCardKey(card);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  return added.length > 0 ? [...list, ...added] : list;
};

/** Undated legacy cards stay in the personal library; only the shared registry requires a date. */
const datedOrSelf = (p: PlayerProfile, fallbackMs: number): PlayerProfile =>
  ensureDossierDated(p, fallbackMs) ?? p;

const App: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingMessage, setLoadingMessage] = useState<string>('Processing...');
  const [isLoading, setIsLoading] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Conversations State
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [isConversationsOpen, setIsConversationsOpen] = useState(false);
  const [newChatRevision, setNewChatRevision] = useState(0);
  const isInitializedRef = useRef(false);

  // Sidebar / Dossier State
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [activeProfile, setActiveProfile] = useState<PlayerProfile | null>(null);
  const [allProfiles, setAllProfiles] = useState<PlayerProfile[]>([]);
  const [globalDossiers, setGlobalDossiers] = useState<PlayerProfile[]>([]);
  // Main view: the chat, or the dossier hub ("Your dossiers" and the global hub as tabs)
  const [view, setView] = useState<AppView>('chat');
  const [hubTab, setHubTab] = useState<HubTab>('mine');
  // Text the hub's "Ask" puts in the chat box
  const [chatDraft, setChatDraft] = useState<{ id: number; text: string } | null>(null);
  // Opens the chat box's Rate command (from the keyboard shortcut).
  const [openRate, setOpenRate] = useState<number | null>(null);

  // Chat domain (Futbolpedia default vs Gaffa Q&A) — persisted per conversation
  const [domain, setDomain] = useState<ChatDomain>('default');
  const [gaffaNudge, setGaffaNudge] = useState<string | null>(null);
  const [gaffaLink, setGaffaLink] = useState<GaffaLinkState | null>(null);
  // Phones only: the connect strip can be folded away so the conversation keeps most of the screen.
  const [gaffaStripCollapsed, setGaffaStripCollapsed] = useState(() => {
    try { return localStorage.getItem('futbolpedia-gaffa-strip-collapsed') === 'true'; } catch { return false; }
  });
  const toggleGaffaStrip = () => {
    setGaffaStripCollapsed(prev => {
      try { localStorage.setItem('futbolpedia-gaffa-strip-collapsed', String(!prev)); } catch { /* storage unavailable */ }
      return !prev;
    });
  };
  const [gaffaSyncing, setGaffaSyncing] = useState(false);
  const [gaffaSyncError, setGaffaSyncError] = useState<string | null>(null);
  const [gaffaUser, setGaffaUser] = useState<GaffaAuthUser | null>(null);
  const [gaffaClubs, setGaffaClubs] = useState<GaffaUserClub[]>([]);
  const [gaffaAuthLoading, setGaffaAuthLoading] = useState(false);

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

  // Load persisted Gaffa club link
  useEffect(() => {
    setGaffaLink(loadGaffaLink());
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
      const datedProfile = stampDossier(profile, Date.now());
      localStorage.setItem(ACTIVE_PROFILE_KEY, JSON.stringify(datedProfile));

      setGlobalDossiers(prev => {
        const updated = upsertCard(prev, datedProfile);
        saveGlobalDossiers(updated);
        return updated;
      });

      setAllProfiles(prev => {
        const updated = upsertCard(prev, datedProfile);
        localStorage.setItem(LEGACY_ALL_PROFILES_KEY, JSON.stringify(updated));
        return updated;
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
        const legacyAllProfiles = localStorage.getItem(LEGACY_ALL_PROFILES_KEY);

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
      const storedGlobal = localStorage.getItem(GLOBAL_DOSSIERS_KEY);
      if (storedGlobal) {
        const parsed = JSON.parse(storedGlobal);
        if (Array.isArray(parsed)) {
          savedGlobalDossiers = parsed.map((p: PlayerProfile) => datedOrSelf(p, p.createdAt || Date.now()));
        }
      } else {
        // Migrate from the legacy all-profiles key, then from saved conversations
        const oldProfilesStr = localStorage.getItem(LEGACY_ALL_PROFILES_KEY);
        if (oldProfilesStr) {
          const parsedOld = JSON.parse(oldProfilesStr);
          if (Array.isArray(parsedOld)) {
            savedGlobalDossiers = parsedOld.map((p: PlayerProfile) => datedOrSelf(p, p.createdAt || Date.now()));
          }
        }

        savedConvs.forEach(conv => {
          if (conv.allProfiles) {
            savedGlobalDossiers = addMissingCards(
              savedGlobalDossiers,
              conv.allProfiles.map(prof => datedOrSelf(prof, prof.createdAt || conv.createdAt || Date.now())),
            );
          }
        });

        saveGlobalDossiers(savedGlobalDossiers);
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
    setDomain(activeConv.domain ?? 'default');

    // Mark as initialized so synchronization effect can run safely
    isInitializedRef.current = true;

    // Handle shared content via URL hash (#/p/<slug> for dossiers, #/c/<code> for conversations)
    const loadSharedProfile = async () => {
      const hash = window.location.hash;

      if (hash.startsWith('#/p/')) {
        const slug = hash.slice(4);
        if (!slug) return;
        setIsLoading(true);
        try {
          const profile = await getCachedDossier(slug, false);
          if (profile) {
            setMessages(prev => [...prev, {
              id: `shared-${Date.now()}`,
              sender: 'ai',
              content: `I've retrieved the archived dossier for **${profile.basicInfo.name}**.`,
              timestamp: Date.now(),
            }]);
            setActiveProfile(profile);
            const profileWithDate = { ...profile, createdAt: profile.createdAt || Date.now() };
            setGlobalDossiers(prev => {
              const updated = addMissingCards(prev, [profileWithDate]);
              if (updated !== prev) saveGlobalDossiers(updated);
              return updated;
            });
            setAllProfiles(prev => addMissingCards(prev, [profileWithDate]));
            setIsPanelOpen(true);
            window.history.replaceState({}, '', window.location.pathname);
          }
        } catch (err) {
          console.error("Shared profile fetch failed:", err);
        } finally {
          setIsLoading(false);
        }

      } else if (hash.startsWith('#/c/')) {
        const code = hash.slice(4);
        if (!code) return;
        setIsLoading(true);
        try {
          const sharedConv = await getSharedConversation(code);
          if (sharedConv) {
            // Fork into a new local conversation
            const importedId = generateId();
            const importedConv: Conversation = {
              ...sharedConv,
              id: importedId,
              title: sharedConv.title ? `${sharedConv.title} (shared)` : 'Shared Briefing',
              createdAt: Date.now(),
            };
            setConversations(prev => {
              const updated = [importedConv, ...prev];
              localStorage.setItem('futbolpedia-conversations', JSON.stringify(updated));
              return updated;
            });
            setActiveConversationId(importedId);
            localStorage.setItem('futbolpedia-active-conversation-id', importedId);
            setMessages(importedConv.messages);
            setActiveProfile(importedConv.activeProfile);
            setAllProfiles(importedConv.allProfiles);
            setDomain(importedConv.domain ?? 'default');
            setGaffaNudge(null);
            // Merge any dossiers from the shared conversation
            if (importedConv.allProfiles?.length > 0) {
              setGlobalDossiers(prev => {
                const updated = addMissingCards(
                  prev,
                  importedConv.allProfiles.map(prof => ({ ...prof, createdAt: prof.createdAt || Date.now() })),
                );
                saveGlobalDossiers(updated);
                return updated;
              });
            }
            setIsConversationsOpen(true);
            window.history.replaceState({}, '', window.location.pathname);
          }
        } catch (err) {
          console.error("Shared conversation fetch failed:", err);
        } finally {
          setIsLoading(false);
        }
      } else if (hash.startsWith('#/gaffa/')) {
        const ids = parseGaffaConnectHash(hash);
        window.history.replaceState({}, '', window.location.pathname);
        if (!ids) return;
        const newId = generateId();
        const newConv: Conversation = {
          id: newId,
          title: 'Gaffa club',
          messages: [],
          createdAt: Date.now(),
          activeProfile: null,
          allProfiles: [],
          domain: 'gaffa',
        };
        setConversations((prev) => {
          const updated = [newConv, ...prev];
          localStorage.setItem('futbolpedia-conversations', JSON.stringify(updated));
          return updated;
        });
        setActiveConversationId(newId);
        localStorage.setItem('futbolpedia-active-conversation-id', newId);
        setMessages([]);
        setActiveProfile(null);
        setAllProfiles([]);
        setDomain('gaffa');
        setGaffaNudge(null);
        setIsLoading(true);
        setGaffaSyncing(true);
        setGaffaSyncError(null);
        try {
          const res = await fetchGaffaContext(ids.leagueId, ids.clubId);
          const bag = mapResponseToBag(res);
          const next: GaffaLinkState = {
            league_id: bag.league_id!,
            club_id: bag.club_id!,
            league_name: bag.league_name,
            club_name: bag.club_name,
            last_synced_at: bag.synced_at,
            bag,
          };
          saveGaffaLink(next);
          setGaffaLink(next);
        } catch (err) {
          console.error('Gaffa connect from hash failed:', err);
          setGaffaSyncError(err instanceof Error ? err.message : 'Sync failed');
          setGaffaLink({ league_id: ids.leagueId, club_id: ids.clubId });
        } finally {
          setGaffaSyncing(false);
          setIsLoading(false);
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
            domain,
            title
          };
        }
        return conv;
      });

      localStorage.setItem('futbolpedia-conversations', JSON.stringify(updated));
      return updated;
    });
  }, [messages, activeProfile, allProfiles, domain, activeConversationId]);
  
  const handleDomainChange = useCallback((next: ChatDomain) => {
    setDomain(next);
    setGaffaNudge(null);
    resetChat();
  }, []);

  const handleGaffaSync = useCallback(async (leagueId: string, clubId: string) => {
    setGaffaSyncing(true);
    setGaffaSyncError(null);
    try {
      const res = await fetchGaffaContext(leagueId, clubId);
      const bag = mapResponseToBag(res);
      const next: GaffaLinkState = {
        league_id: bag.league_id!,
        club_id: bag.club_id!,
        league_name: bag.league_name,
        club_name: bag.club_name,
        last_synced_at: bag.synced_at,
        bag,
      };
      saveGaffaLink(next);
      setGaffaLink(next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sync failed';
      setGaffaSyncError(msg);
    } finally {
      setGaffaSyncing(false);
    }
  }, []);

  // Subscribe to Gaffa Supabase Auth and auto-load/select user's clubs
  useEffect(() => {
    let active = true;

    const params = new URLSearchParams(window.location.search);
    if (params.get('gaffa_auth') === '1') {
      setDomain('gaffa');
      params.delete('gaffa_auth');
      const nextSearch = params.toString();
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', nextUrl);
    }

    const syncClubsForUser = async (user: GaffaAuthUser | null) => {
      if (!active) return;
      setGaffaUser(user);
      if (!user) {
        setGaffaClubs([]);
        return;
      }
      try {
        const clubs = await fetchMyGaffaClubs(user.id);
        if (!active) return;
        setGaffaClubs(clubs);
        if (clubs.length === 0) return;

        const saved = loadGaffaLink();
        const matchingSaved = saved
          ? clubs.find(
              (c) => c.league_id === saved.league_id && c.club_id === saved.club_id,
            )
          : undefined;
        const target = matchingSaved ?? clubs[0];
        const alreadyFresh =
          matchingSaved &&
          saved?.bag?.connected &&
          saved.last_synced_at &&
          Date.now() - Date.parse(saved.last_synced_at) < 10 * 60 * 1000;

        if (!alreadyFresh) {
          void handleGaffaSync(target.league_id, target.club_id);
        }
      } catch (err) {
        if (!active) return;
        setGaffaSyncError(
          err instanceof Error ? err.message : 'Could not load your Gaffa clubs',
        );
      }
    };

    void getGaffaSessionUser().then(syncClubsForUser);
    const unsubscribe = onGaffaAuthStateChange((user) => {
      void syncClubsForUser(user);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [handleGaffaSync]);

  const handleGaffaSignInPassword = useCallback(
    async (email: string, password: string) => {
      setGaffaAuthLoading(true);
      setGaffaSyncError(null);
      try {
        await signInGaffaWithPassword(email, password);
      } catch (err) {
        setGaffaSyncError(err instanceof Error ? err.message : 'Sign-in failed');
      } finally {
        setGaffaAuthLoading(false);
      }
    },
    [],
  );

  const handleGaffaSignInGoogle = useCallback(async () => {
    setGaffaAuthLoading(true);
    setGaffaSyncError(null);
    try {
      await signInGaffaWithGoogle();
    } catch (err) {
      setGaffaSyncError(err instanceof Error ? err.message : 'Google sign-in failed');
      setGaffaAuthLoading(false);
    }
  }, []);

  const handleGaffaSignOut = useCallback(async () => {
    setGaffaAuthLoading(true);
    try {
      await signOutGaffa();
      clearGaffaLink();
      setGaffaUser(null);
      setGaffaClubs([]);
      setGaffaLink(null);
      setGaffaSyncError(null);
    } finally {
      setGaffaAuthLoading(false);
    }
  }, []);

  const handleGaffaDisconnect = useCallback(() => {
    clearGaffaLink();
    setGaffaLink(null);
    setGaffaSyncError(null);
  }, []);

  // A reply that filed a dossier: the card is saved and shown, and the chat gets its card.
  const dossierReply = useCallback((profile: PlayerProfile, id: string): ChatMessage => {
    saveAndSetActiveProfile(profile);
    setIsPanelOpen(true);
    return {
      id,
      sender: 'ai',
      content: `Dossier generated for **${profile.basicInfo.name}**. See the side panel for full analysis.`,
      timestamp: Date.now(),
      dossier: toChatDossierRef(profile),
      dossierKey: getCardKey(profile),
    };
  }, [saveAndSetActiveProfile]);

  const errorReply = (err: unknown): ChatMessage => ({
    id: generateId(),
    sender: 'ai',
    content: `Editor's Note: I encountered an issue. ${err instanceof Error ? err.message : 'An unknown error occurred.'}`,
    timestamp: Date.now(),
    isError: true,
  });

  const handleSendMessage = useCallback(async (
    userMessageText: string,
    imageData?: string,
    messageDomain: ChatDomain = domain,
  ) => {
    if (!userMessageText.trim() && !imageData) return;

    const activeDomain = messageDomain;
    const lowerCaseMessage = userMessageText.toLowerCase();

    // Soft nudge when default domain looks Gaffa-specific — never silently inject Gaffa context.
    if (activeDomain === 'default' && userMessageText.trim() && looksLikeGaffaQuestion(userMessageText)) {
      setGaffaNudge('This looks like a Gaffa question — switch to Gaffa mode?');
    } else if (activeDomain === 'gaffa') {
      setGaffaNudge(null);
    }

    let specificLoadingMessage = 'Consulting archives...';
    if (activeDomain === 'gaffa') {
      if (/\b(trade|swap|€|\d+\s*m)\b/i.test(userMessageText)) {
        specificLoadingMessage = 'Weighing the trade...';
      } else if (/\b(audit|lineup|starting xi|\bxi\b|auto-?subs?|formation)\b/i.test(lowerCaseMessage)) {
        specificLoadingMessage = 'Auditing lineup & bench cover...';
      } else if (/\b(bid|nominate|auction|fa floor|scout'?s? fee|clause)\b/i.test(lowerCaseMessage)) {
        specificLoadingMessage = 'Calculating bid & market math...';
      } else if (/\b(oop|auto-?sub|eligibility|formation|bench|lock|rule)\b/i.test(lowerCaseMessage)) {
        specificLoadingMessage = 'Checking the rulebook...';
      } else {
        specificLoadingMessage = 'Gaffa briefing...';
      }
    } else if (imageData) {
      specificLoadingMessage = 'Analyzing imagery...';
    } else if (/\b(compare|versus)\b|\bvs\.?\b/.test(lowerCaseMessage)) {
      specificLoadingMessage = 'Comparing players...';
    } else if (lowerCaseMessage.includes('rate') || lowerCaseMessage.includes('profile')) {
      specificLoadingMessage = 'Scouting player...';
    }

    setLoadingMessage(specificLoadingMessage);
    setIsLoading(true);

    const newUserMessage: ChatMessage = {
      id: generateId(),
      sender: 'user',
      content: userMessageText || 'Image uploaded',
      image: imageData,
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, newUserMessage]);

    try {
      const streamingMessageId = generateId();
      let streamStarted = false;
      let lastStreamFlushAt = 0;

      if (activeDomain === 'gaffa') {
        const contextBag = await resolveContextBagForSend(gaffaLink);
        if (contextBag.connected && contextBag.synced_at) {
          const nextLink: GaffaLinkState = {
            league_id: contextBag.league_id!,
            club_id: contextBag.club_id!,
            league_name: contextBag.league_name,
            club_name: contextBag.club_name,
            last_synced_at: contextBag.synced_at,
            bag: contextBag,
          };
          saveGaffaLink(nextLink);
          setGaffaLink(nextLink);
        }
        const { prose, scorecard } = await sendGaffaMessage(userMessageText, messages, {
          imageData,
          contextBag,
          connectAttempted: Boolean(gaffaLink),
          savedDossiers: globalDossiers,
          conversationProfiles: allProfiles,
          onStageChange: (label) => setLoadingMessage(label),
          onScorecardReady: (lockedCard) => {
            streamStarted = true;
            setIsLoading(false);
            setMessages(prev => {
              const exists = prev.some(m => m.id === streamingMessageId);
              if (exists) {
                return prev.map(m =>
                  m.id === streamingMessageId ? { ...m, gaffaScorecard: lockedCard } : m,
                );
              }
              return [
                ...prev,
                {
                  id: streamingMessageId,
                  sender: 'ai',
                  content: '',
                  timestamp: Date.now(),
                  gaffaScorecard: lockedCard,
                },
              ];
            });
          },
          onStreamChunk: (accumulatedText) => {
            const now = Date.now();
            if (streamStarted && now - lastStreamFlushAt < 45) return;
            lastStreamFlushAt = now;
            if (!streamStarted) {
              streamStarted = true;
              setIsLoading(false);
            }
            setMessages(prev => {
              const exists = prev.some(m => m.id === streamingMessageId);
              if (exists) {
                return prev.map(m =>
                  m.id === streamingMessageId ? { ...m, content: accumulatedText } : m,
                );
              }
              return [
                ...prev,
                {
                  id: streamingMessageId,
                  sender: 'ai',
                  content: accumulatedText,
                  timestamp: now,
                },
              ];
            });
          },
        });
        setMessages(prev => {
          const exists = prev.some(m => m.id === streamingMessageId);
          if (exists) {
            return prev.map(m =>
              m.id === streamingMessageId
                ? { ...m, content: prose, gaffaScorecard: scorecard ?? m.gaffaScorecard }
                : m,
            );
          }
          return [
            ...prev,
            {
              id: streamingMessageId,
              sender: 'ai',
              content: prose,
              timestamp: Date.now(),
              gaffaScorecard: scorecard ?? undefined,
            },
          ];
        });
        return;
      }

      const aiResponse = await sendMessageToAI(
        userMessageText,
        messages,
        imageData,
        allProfiles,
        globalDossiers,
        {
          onDossierUpdated: (updatedProfile) => {
            saveAndSetActiveProfile(updatedProfile);
            setIsPanelOpen(true);
          },
          onStageChange: (label) => setLoadingMessage(label),
          onStreamChunk: (accumulatedText) => {
            const now = Date.now();
            if (streamStarted && now - lastStreamFlushAt < 45) return;
            lastStreamFlushAt = now;
            if (!streamStarted) {
              streamStarted = true;
              setIsLoading(false);
            }
            setMessages(prev => {
              const exists = prev.some(m => m.id === streamingMessageId);
              if (exists) {
                return prev.map(m =>
                  m.id === streamingMessageId ? { ...m, content: accumulatedText } : m,
                );
              }
              return [
                ...prev,
                {
                  id: streamingMessageId,
                  sender: 'ai',
                  content: accumulatedText,
                  timestamp: now,
                },
              ];
            });
          },
        },
      );

      let newAiMessage: ChatMessage;

      if (typeof aiResponse === 'object' && 'basicInfo' in aiResponse) {
        newAiMessage = dossierReply(aiResponse as PlayerProfile, streamingMessageId);
      } else {
        newAiMessage = {
          id: streamingMessageId,
          sender: 'ai',
          content: aiResponse,
          timestamp: Date.now(),
        };
      }

      setMessages(prev => {
        const exists = prev.some(m => m.id === streamingMessageId);
        if (exists) {
          return prev.map(m => (m.id === streamingMessageId ? newAiMessage : m));
        }
        return [...prev, newAiMessage];
      });
    } catch (err) {
      setMessages(prev => [...prev, errorReply(err)]);
    } finally {
      setIsLoading(false);
    }
  }, [messages, allProfiles, globalDossiers, domain, gaffaLink, saveAndSetActiveProfile, dossierReply]);

  // The Rate command: a rating without a chat turn to route. It lands in the chat like a typed one.
  const handleRate = useCallback(async (request: RatingRequest) => {
    if (isLoading) return;
    if (domain === 'gaffa') handleDomainChange('default');
    setGaffaNudge(null);
    setLoadingMessage(`Scouting ${request.name}...`);
    setIsLoading(true);
    setMessages(prev => [...prev, {
      id: generateId(),
      sender: 'user',
      content: ratingTask(request),
      timestamp: Date.now(),
      rating: request,
    }]);
    try {
      const reply = await ratePlayer(request, messages, allProfiles, globalDossiers, {
        onStageChange: (label) => setLoadingMessage(label),
      });
      const id = generateId();
      const aiMessage: ChatMessage =
        typeof reply === 'object' && 'basicInfo' in reply
          ? dossierReply(reply, id)
          : { id, sender: 'ai', content: reply, timestamp: Date.now() };
      setMessages(prev => [...prev, aiMessage]);
    } catch (err) {
      setMessages(prev => [...prev, errorReply(err)]);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, domain, handleDomainChange, messages, allProfiles, globalDossiers, dossierReply]);

  // Cmd/Ctrl+K opens the Rate command from anywhere.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      setView('chat');
      setOpenRate(Date.now());
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleSelectProfile = useCallback((profile: PlayerProfile | null) => {
    setActiveProfile(profile);
    if (profile) {
      localStorage.setItem(ACTIVE_PROFILE_KEY, JSON.stringify(profile));
    } else {
      localStorage.removeItem(ACTIVE_PROFILE_KEY);
    }
  }, []);

  const handleOpenDossier = useCallback((ref: ChatDossierRef) => {
    const byKey = ref.cardKey ? globalDossiers.find(d => getCardKey(d) === ref.cardKey) : undefined;
    const byName = globalDossiers.filter(d => d.basicInfo.name.toLowerCase() === ref.name.toLowerCase());
    // Name fallback covers legacy messages and cards re-dated since the reply; prefer the newest card.
    const match = byKey ?? byName.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
    setIsConversationsOpen(false);
    // A deleted dossier falls back to the hub so the tap still lands somewhere useful.
    if (!match) {
      setView('hub');
      return;
    }
    handleSelectProfile(match);
    setIsPanelOpen(true);
  }, [globalDossiers, handleSelectProfile]);

  // Retry drops the failed exchange first, then resends once state (and the history closure) has caught up.
  const [pendingRetry, setPendingRetry] = useState<{ text: string; image?: string; rating?: RatingRequest } | null>(null);

  const handleRetry = useCallback((errorMessageId: string) => {
    const errorIndex = messages.findIndex(m => m.id === errorMessageId);
    if (errorIndex < 0) return;
    let userIndex = errorIndex - 1;
    while (userIndex >= 0 && messages[userIndex].sender !== 'user') userIndex--;
    const userMessage = messages[userIndex];
    if (!userMessage || typeof userMessage.content !== 'string') return;
    const dropIds = new Set(messages.slice(userIndex, errorIndex + 1).map(m => m.id));
    setMessages(prev => prev.filter(m => !dropIds.has(m.id)));
    setPendingRetry({ text: userMessage.content, image: userMessage.image, rating: userMessage.rating });
  }, [messages]);

  useEffect(() => {
    if (!pendingRetry || isLoading) return;
    setPendingRetry(null);
    if (pendingRetry.rating) handleRate(pendingRetry.rating);
    else handleSendMessage(pendingRetry.text, pendingRetry.image);
  }, [pendingRetry, isLoading, handleSendMessage, handleRate]);

  const handleRenameDossier = useCallback((cardKey: string, newName: string) => {
    const rename = (d: PlayerProfile): PlayerProfile => renameDossierCard(d, newName);

    setGlobalDossiers(prev => {
      const updated = prev.map(d => (getCardKey(d) === cardKey ? rename(d) : d));
      saveGlobalDossiers(updated);
      return updated;
    });

    setActiveProfile(prev => {
      if (prev && getCardKey(prev) === cardKey) {
        const updated = rename(prev);
        localStorage.setItem(ACTIVE_PROFILE_KEY, JSON.stringify(updated));
        return updated;
      }
      return prev;
    });
  }, []);

  const handleDeleteDossier = useCallback((cardKey: string) => {
    setGlobalDossiers(prev => {
      const filtered = prev.filter(d => getCardKey(d) !== cardKey);
      saveGlobalDossiers(filtered);
      return filtered;
    });

    setActiveProfile(prev => {
      if (prev && getCardKey(prev) === cardKey) {
        localStorage.removeItem(ACTIVE_PROFILE_KEY);
        return null;
      }
      return prev;
    });
  }, []);

  const handleSelectConversation = useCallback((id: string) => {
    resetChat();
    setView('chat');
    const target = conversations.find(c => c.id === id);
    if (!target) return;

    setActiveConversationId(id);
    localStorage.setItem('futbolpedia-active-conversation-id', id);

    setMessages(target.messages);
    setActiveProfile(target.activeProfile);
    setAllProfiles(target.allProfiles);
    setDomain(target.domain ?? 'default');
    setGaffaNudge(null);
  }, [conversations]);

  const handleNewConversation = useCallback(() => {
    resetChat();
    setView('chat');
    const newId = generateId();
    const newConv: Conversation = {
      id: newId,
      title: 'New Briefing',
      messages: [],
      createdAt: Date.now(),
      activeProfile: null,
      allProfiles: [],
      domain: 'default',
    };

    setConversations(prev => {
      const updated = [newConv, ...prev];
      localStorage.setItem('futbolpedia-conversations', JSON.stringify(updated));
      return updated;
    });

    setActiveConversationId(newId);
    setNewChatRevision(prev => prev + 1);
    localStorage.setItem('futbolpedia-active-conversation-id', newId);

    setMessages([]);
    setActiveProfile(null);
    setAllProfiles([]);
    setDomain('default');
    setGaffaNudge(null);
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
          setDomain(nextActive.domain ?? 'default');
          setGaffaNudge(null);
        } else {
          const newId = generateId();
          const newConv: Conversation = {
            id: newId,
            title: 'New Briefing',
            messages: [],
            createdAt: Date.now(),
            activeProfile: null,
            allProfiles: [],
            domain: 'default',
          };
          filtered.push(newConv);
          setActiveConversationId(newId);
          localStorage.setItem('futbolpedia-active-conversation-id', newId);
          setMessages([]);
          setActiveProfile(null);
          setAllProfiles([]);
          setDomain('default');
          setGaffaNudge(null);
          setIsPanelOpen(false);
        }
      }

      localStorage.setItem('futbolpedia-conversations', JSON.stringify(filtered));
      return filtered;
    });
  }, [activeConversationId]);

  const handleSelectHubDossier = useCallback((profile: PlayerProfile, from: HubTab) => {
    // A global card opened from the hub joins your dossiers, as before.
    if (from === 'global') saveAndSetActiveProfile(profile);
    else handleSelectProfile(profile);
    setIsPanelOpen(true);
  }, [saveAndSetActiveProfile, handleSelectProfile]);

  // "Ask" on a hub card: the card joins this conversation as a stub (so the model reads the full
  // card, as with a generated dossier) and the chat box starts with a reference to that exact
  // version, which keeps the reply on it rather than another edition of the player.
  const handleAskAboutDossier = useCallback((profile: PlayerProfile) => {
    saveAndSetActiveProfile(profile);
    if (domain === 'gaffa') handleDomainChange('default');
    const reference = cardReference(profile);
    const key = getCardKey(profile);
    setMessages(prev =>
      prev.at(-1)?.dossierKey === key
        ? prev
        : [...prev, {
            id: `ask-${Date.now()}`,
            sender: 'ai',
            content: `Pulled up **${reference}**. What would you like to know?`,
            timestamp: Date.now(),
            dossierKey: key,
          }],
    );
    setChatDraft({ id: Date.now(), text: `${reference}: ` });
    setView('chat');
  }, [saveAndSetActiveProfile, domain, handleDomainChange]);

  // The panel only ever shows one dossier, so it's closed whenever none is active.
  const showPanel = isPanelOpen && activeProfile !== null;

  const toggleConversations = () => {
    setIsConversationsOpen(!isConversationsOpen);
  };

  return (
    <div className="flex flex-col h-full bg-cream-200 dark:bg-charcoal text-charcoal dark:text-cream-100 transition-colors duration-300 relative">
      <WhatsNewPopup />
      
      <Header 
        onNewChat={handleNewConversation} 
        toggleTheme={toggleTheme} 
        isDarkMode={isDarkMode} 
        dossierCount={globalDossiers.length}
        view={view}
        onViewChange={setView}
        onToggleConversations={toggleConversations}
        isConversationsOpen={isConversationsOpen}
      />
      
      {/* Slide-out Dossier Panel - LEFT SIDED */}
      <SidePanel 
          isOpen={showPanel} 
          onClose={() => setIsPanelOpen(false)} 
          profile={activeProfile} 
          allProfiles={globalDossiers}
          onSelectProfile={handleSelectProfile}
          onOpenHub={view === 'hub' ? undefined : () => setView('hub')}
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

      <div className={`flex-1 flex flex-col relative overflow-hidden transition-all duration-500 ease-ios-ease ${showPanel ? 'md:pl-[450px]' : ''} ${isConversationsOpen ? 'md:pr-[350px]' : ''}`}>
          {/* Dossier hub, layered over the chat so both keep their scroll position, tab and filters */}
          <div
            className={`absolute inset-0 z-30 flex flex-col bg-cream-200 dark:bg-charcoal transition-[padding] duration-500 ease-ios-ease ${view === 'hub' ? '' : 'invisible'} ${showPanel ? 'md:pl-[450px]' : ''} ${isConversationsOpen ? 'md:pr-[350px]' : ''}`}
            inert={view !== 'hub'}
          >
            <DossierHub
              isActive={view === 'hub'}
              tab={hubTab}
              onTabChange={setHubTab}
              savedProfiles={globalDossiers}
              activeCardKey={showPanel && activeProfile ? getCardKey(activeProfile) : null}
              onSelectDossier={handleSelectHubDossier}
              onAskAbout={handleAskAboutDossier}
              onRenameDossier={handleRenameDossier}
              onDeleteDossier={handleDeleteDossier}
              onStartChat={() => setView('chat')}
            />
          </div>

          {/* Main Chat Area */}
          <main className="flex-1 flex flex-col w-full h-full relative min-h-0" inert={view !== 'chat'}>
            <ChatHistory 
                messages={messages} 
                isLoading={isLoading} 
                loadingMessage={loadingMessage}
                conversationKey={`${activeConversationId ?? 'init'}-${newChatRevision}`}
                domain={domain}
                onSuggestion={(prompt) => handleSendMessage(prompt)}
                onOpenDossier={handleOpenDossier}
                onRetry={handleRetry}
            />
            
            {/* Input Container - Sticky Bottom */}
            <div className="flex-none px-3 sm:px-6 pt-2 sm:pt-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:pb-8 bg-gradient-to-t from-cream-200 dark:from-charcoal via-cream-200/95 dark:via-charcoal/95 to-transparent z-20">
                <div className="max-w-[800px] mx-auto w-full">
                    {domain === 'gaffa' && (
                      <button
                        type="button"
                        onClick={toggleGaffaStrip}
                        aria-expanded={!gaffaStripCollapsed}
                        className="sm:hidden w-full mb-2 flex items-center justify-between gap-2 min-h-9 px-3 border border-charcoal/15 dark:border-cream-400/15 bg-cream-50/85 dark:bg-charcoal-surface/85 text-left"
                      >
                        <span className="min-w-0 truncate text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/55 dark:text-cream-400/60">
                          Gaffa club
                          <span className="normal-case tracking-normal font-serif italic font-normal text-xs text-charcoal/80 dark:text-cream-200/80 ml-2">
                            {gaffaLink?.club_name ?? (gaffaUser ? 'Not connected' : 'Signed out')}
                          </span>
                        </span>
                        <span className="material-symbols-outlined text-[18px] text-charcoal/60 dark:text-cream-400/60">
                          {gaffaStripCollapsed ? 'expand_less' : 'expand_more'}
                        </span>
                      </button>
                    )}
                    {domain === 'gaffa' && (
                      <div className={gaffaStripCollapsed ? 'hidden sm:block' : ''}>
                      <GaffaConnectStrip
                        link={gaffaLink}
                        syncing={gaffaSyncing}
                        error={gaffaSyncError}
                        onSync={handleGaffaSync}
                        onDisconnect={handleGaffaDisconnect}
                        onQuickPrompt={(prompt) => handleSendMessage(prompt, undefined, 'gaffa')}
                        calibratedDossiers={globalDossiers}
                        disabled={isLoading}
                        authUser={gaffaUser}
                        userClubs={gaffaClubs}
                        authLoading={gaffaAuthLoading}
                        onSignInPassword={handleGaffaSignInPassword}
                        onSignInGoogle={handleGaffaSignInGoogle}
                        onSignOut={handleGaffaSignOut}
                      />
                      </div>
                    )}
                    <ChatInput
                        onSendMessage={handleSendMessage}
                        isLoading={isLoading}
                        loadingMessage={loadingMessage}
                        domain={domain}
                        onDomainChange={handleDomainChange}
                        gaffaNudge={gaffaNudge}
                        onAcceptGaffaNudge={() => handleDomainChange('gaffa')}
                        onDismissGaffaNudge={() => setGaffaNudge(null)}
                        draft={chatDraft}
                        onRate={handleRate}
                        localCards={globalDossiers}
                        openRate={openRate}
                    />
                </div>
            </div>
          </main>
      </div>
    </div>
  );
};

export default App;