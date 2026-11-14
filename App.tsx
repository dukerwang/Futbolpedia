import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Header, type AppView } from './components/Header';
import { ChatHistory } from './components/ChatHistory';
import { ChatInput, type Mention } from './components/ChatInput';
import { ScoutDesk, type ScoutJob } from './components/ScoutDesk';
import { SidePanel } from './components/SidePanel';
import { ConversationsPanel } from './components/ConversationsPanel';
import { WhatsNewPopup } from './components/WhatsNewPopup';
import { DossierHub, type HubTab } from './components/DossierHub';
import { cardReference } from './components/pills';
import type {
  ChatMessage,
  PlayerProfile,
  Conversation,
  GaffaContextBag,
  GaffaTradeScorecard,
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
  type ReplyAttachments,
} from './services/geminiService';
import { isFullCard, ratingTask, requestForCard } from './services/ratingCommand';
import { fetchSharedEditions } from './services/dossierStore';
import { autoTitle, generateChatTitle, hasAutoTitle, titleBrief } from './services/chatTitle';
import { LEGACY_PURGE_KEY, isLegacyShape, orphanKeys, withoutCards } from './services/legacyDossiers';
import { asksToSeeMentions } from './services/chatIntent';
import {
  completeGaffaConnect,
  connectGaffa,
  disconnectGaffa,
  gaffaBaseUrl,
  GaffaNotConnectedError,
  listMyGaffaClubs,
  loadGrant,
  onGrantChange,
  parseConnectedHash,
} from './services/gaffaConnect';
import {
  cachedClubBag,
  clearClubBags,
  loadClubBag,
  parseGaffaClubHash,
  type GaffaClubRef,
} from './services/gaffaContext';
import { GaffaClubChip } from './components/GaffaClubChip';
import type { GaffaWelcomeClub } from './components/GaffaClubWelcome';

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

/**
 * Files a card in your dossiers: it goes to the end of the list, which is newest-last, so a card
 * Scout just served sits at the top of "Most recent" even when the shared card was rated weeks ago.
 * Your own revision of that card is kept in place of the shared one, but still moves up.
 */
const fileCard = (list: PlayerProfile[], card: PlayerProfile): PlayerProfile[] => {
  const key = getCardKey(card);
  const existing = list.find(p => getCardKey(p) === key);
  const kept = existing?.revision && !card.revision ? existing : card;
  return [...list.filter(p => getCardKey(p) !== key), kept];
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

const LAST_GAFFA_CLUB_KEY = 'futbolpedia-gaffa-last-club';

/** The club last attached to a conversation, while Gaffa is connected. */
function lastGaffaClub(): GaffaClubRef | null {
  if (!loadGrant()) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_GAFFA_CLUB_KEY) ?? 'null');
    return parsed?.leagueId && parsed?.clubId ? { leagueId: parsed.leagueId, clubId: parsed.clubId } : null;
  } catch {
    return null;
  }
}

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
  // Main view: the chat, or the dossier hub (the global hub and "Your dossiers" as tabs)
  const [view, setView] = useState<AppView>('chat');
  const [hubTab, setHubTab] = useState<HubTab>('global');
  // Text the hub's "Ask" puts in the chat box
  const [chatDraft, setChatDraft] = useState<{ id: number; text: string } | null>(null);
  // The left panel is the Scout desk or one open dossier.
  const [panelMode, setPanelMode] = useState<'scout' | 'dossier'>('dossier');
  const [scoutJobs, setScoutJobs] = useState<ScoutJob[]>([]);
  // Cards Scout rated this session, newest first.
  const [freshKeys, setFreshKeys] = useState<string[]>([]);
  const [scoutFocus, setScoutFocus] = useState(0);
  // Names a link put in Scout's field (`#/scout?name=`), waiting for you to press Rate.
  const [scoutPrefill, setScoutPrefill] = useState<{ id: number; text: string } | null>(null);
  // Puts a mention of a card in the chat box (Scout's Ask).
  const [mentionRequest, setMentionRequest] = useState<{ id: number; card: PlayerProfile } | null>(null);

  // Connect with Gaffa: the grant, the manager's clubs, and the club attached to this conversation.
  const [gaffaGrant, setGaffaGrant] = useState<string | null>(() => loadGrant());
  const [gaffaClub, setGaffaClub] = useState<GaffaClubRef | null>(null);
  const [gaffaClubs, setGaffaClubs] = useState<GaffaUserClub[]>([]);
  const [gaffaClubsLoading, setGaffaClubsLoading] = useState(false);
  const [gaffaConnecting, setGaffaConnecting] = useState(false);
  const [gaffaError, setGaffaError] = useState<string | null>(null);
  const [gaffaBag, setGaffaBag] = useState<GaffaContextBag | null>(null);
  const [gaffaBase, setGaffaBase] = useState<string | null>(null);
  // A club from Gaffa's Open in Futbolpedia link, waiting for conversations (and the grant) to load.
  const [pendingClubLink, setPendingClubLink] = useState<(GaffaClubRef & { question?: string }) | null>(null);

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

  // The old Gaffa mode kept a Gaffa Supabase session (its access and refresh tokens) and a saved
  // club here. Connect with Gaffa replaced both, so they go.
  useEffect(() => {
    try {
      for (const key of [
        'futbolpedia-gaffa-auth',
        'futbolpedia-gaffa-auth-code-verifier',
        'futbolpedia-gaffa-link',
        'futbolpedia-gaffa-strip-collapsed',
      ]) localStorage.removeItem(key);
    } catch { /* unavailable */ }
  }, []);

  // The grant can arrive from a popup tab or go when Gaffa refuses it.
  useEffect(() => onGrantChange(setGaffaGrant), []);
  useEffect(() => {
    void gaffaBaseUrl().then(setGaffaBase);
  }, []);

  // With a grant, load the manager's clubs.
  useEffect(() => {
    if (!gaffaGrant) {
      setGaffaClubs([]);
      return;
    }
    let active = true;
    setGaffaClubsLoading(true);
    listMyGaffaClubs()
      .then((clubs) => {
        if (!active) return;
        setGaffaClubs(clubs);
        setGaffaError(null);
      })
      .catch((err) => {
        if (active && !(err instanceof GaffaNotConnectedError)) {
          setGaffaError(err instanceof Error ? err.message : 'Could not load your Gaffa clubs');
        }
      })
      .finally(() => {
        if (active) setGaffaClubsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [gaffaGrant]);

  // A club attached to this conversation that isn't one of the manager's (a shared conversation,
  // another account) is dropped once the clubs are known.
  useEffect(() => {
    if (!gaffaClub || gaffaClubsLoading || !gaffaGrant) return;
    if (gaffaClubs.length > 0 && !gaffaClubs.some(c => c.league_id === gaffaClub.leagueId && c.club_id === gaffaClub.clubId)) {
      setGaffaClub(null);
    }
  }, [gaffaClub, gaffaClubs, gaffaClubsLoading, gaffaGrant]);

  // The attached club's bag, for the welcome; each turn reads it again if it's over ten minutes old.
  useEffect(() => {
    if (!gaffaClub || !gaffaGrant) {
      setGaffaBag(null);
      return;
    }
    let active = true;
    setGaffaBag(cachedClubBag(gaffaClub));
    void loadClubBag(gaffaClub).then((bag) => {
      if (active) setGaffaBag(bag.connected ? bag : null);
    });
    try { localStorage.setItem(LAST_GAFFA_CLUB_KEY, JSON.stringify(gaffaClub)); } catch { /* unavailable */ }
    return () => {
      active = false;
    };
  }, [gaffaClub, gaffaGrant]);

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
        const updated = fileCard(prev, datedProfile);
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

    // Cards from before the current pipeline go, judged as stored (before dating fills them in).
    const purgeLegacy = !localStorage.getItem(LEGACY_PURGE_KEY);
    const keepCard = (p: PlayerProfile) => !purgeLegacy || !isLegacyShape(p);
    if (purgeLegacy) {
      savedConvs = savedConvs.map(conv => withoutCards(conv, isLegacyShape));
      localStorage.setItem('futbolpedia-conversations', JSON.stringify(savedConvs));
    }

    setConversations(savedConvs);

    // Load global dossiers
    let savedGlobalDossiers: PlayerProfile[] = [];
    try {
      const storedGlobal = localStorage.getItem(GLOBAL_DOSSIERS_KEY);
      if (storedGlobal) {
        const parsed = JSON.parse(storedGlobal);
        if (Array.isArray(parsed)) {
          savedGlobalDossiers = parsed.filter(keepCard).map((p: PlayerProfile) => datedOrSelf(p, p.createdAt || Date.now()));
          if (savedGlobalDossiers.length !== parsed.length) saveGlobalDossiers(savedGlobalDossiers);
        }
      } else {
        // Migrate from the legacy all-profiles key, then from saved conversations
        const oldProfilesStr = localStorage.getItem(LEGACY_ALL_PROFILES_KEY);
        if (oldProfilesStr) {
          const parsedOld = JSON.parse(oldProfilesStr);
          if (Array.isArray(parsedOld)) {
            savedGlobalDossiers = parsedOld.filter(keepCard).map((p: PlayerProfile) => datedOrSelf(p, p.createdAt || Date.now()));
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
    setGaffaClub(activeConv.gaffaClub ?? null);

    // Mark as initialized so synchronization effect can run safely
    isInitializedRef.current = true;

    // Then the cards the shared store has never held for that player and edition. Only cards loaded
    // now are judged, so a card Scout files in the meantime is never caught by a stale read.
    if (purgeLegacy) {
      const loadedAt = Date.now();
      const loadedCards = [...savedGlobalDossiers, ...savedConvs.flatMap(c => c.allProfiles ?? [])];
      void fetchSharedEditions().then(shared => {
        if (!shared) return; // Try again next visit rather than judge against an unreadable store.
        const orphans = orphanKeys(loadedCards, shared);
        const drop = (p: PlayerProfile) => orphans.has(getCardKey(p)) && (p.createdAt ?? 0) <= loadedAt;
        if (orphans.size > 0) {
          setGlobalDossiers(prev => {
            const kept = prev.filter(p => !drop(p));
            saveGlobalDossiers(kept);
            return kept;
          });
          setAllProfiles(prev => prev.filter(p => !drop(p)));
          setActiveProfile(prev => (prev && drop(prev) ? null : prev));
          setConversations(prev => {
            const kept = prev.map(conv => withoutCards(conv, drop));
            localStorage.setItem('futbolpedia-conversations', JSON.stringify(kept));
            return kept;
          });
        }
        localStorage.setItem(LEGACY_PURGE_KEY, String(Date.now()));
      });
    }

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
            setGaffaClub(importedConv.gaffaClub ?? null);
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
      } else if (hash.startsWith('#/scout')) {
        // Scout on Futbolpedia (from Gaffa): Scout opens with the name in its field. Nothing is
        // rated until you press Rate, so a link can't spend a rating on its own.
        const name = new URLSearchParams(hash.split('?')[1] ?? '').get('name')?.trim().slice(0, 80);
        window.history.replaceState({}, '', window.location.pathname);
        setPanelMode('scout');
        setIsPanelOpen(true);
        setScoutFocus(Date.now());
        if (name) setScoutPrefill({ id: Date.now(), text: name });
      } else if (hash.startsWith('#/gaffa/connected')) {
        // Gaffa's approval page sent this tab back with its answer (no popup, or the popup lost its
        // opener). Finish the exchange; a popup tab then closes itself.
        const answer = parseConnectedHash(hash);
        window.history.replaceState({}, '', window.location.pathname);
        if (!answer) return;
        try {
          await completeGaffaConnect(answer);
          if (window.opener || window.name === 'gaffa-connect') window.close();
        } catch (err) {
          setGaffaError(err instanceof Error ? err.message : 'Gaffa connection failed');
        }
      } else if (hash.startsWith('#/gaffa/')) {
        // Open in Futbolpedia / Ask from Gaffa: a new conversation with that club, once the
        // conversations have loaded.
        const link = parseGaffaClubHash(hash);
        window.history.replaceState({}, '', window.location.pathname);
        if (link) setPendingClubLink(link);
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
              title = autoTitle(firstUserMsg.content);
            }
          }

          return {
            ...conv,
            messages,
            activeProfile,
            allProfiles,
            gaffaClub: gaffaClub ?? undefined,
            title
          };
        }
        return conv;
      });

      localStorage.setItem('futbolpedia-conversations', JSON.stringify(updated));
      return updated;
    });
  }, [messages, activeProfile, allProfiles, gaffaClub, activeConversationId]);

  // Once the opening exchange lands, the model titles the chat from what it's about. Older chats
  // still wearing their stand-in title get one the next time they're opened.
  const titleRequestsRef = useRef(new Set<string>());
  useEffect(() => {
    if (isLoading || !activeConversationId || titleRequestsRef.current.has(activeConversationId)) return;
    const conv = conversations.find(c => c.id === activeConversationId);
    if (!conv || !hasAutoTitle(conv)) return;
    const brief = titleBrief(conv.messages);
    if (!brief) return;
    const id = activeConversationId;
    titleRequestsRef.current.add(id);
    void generateChatTitle(brief).then(title => {
      if (!title) return;
      setConversations(prev => {
        // A rename while the title was being written wins.
        const updated = prev.map(c => (c.id === id && hasAutoTitle(c) ? { ...c, title, titleSource: 'generated' as const } : c));
        localStorage.setItem('futbolpedia-conversations', JSON.stringify(updated));
        return updated;
      });
    });
  }, [isLoading, activeConversationId, conversations]);
  
  // Connect Gaffa: the popup has to open inside the click, so this runs straight from it.
  const handleConnectGaffa = useCallback(async () => {
    setGaffaConnecting(true);
    setGaffaError(null);
    try {
      const outcome = await connectGaffa();
      if (outcome === 'cancelled') setGaffaError('Gaffa wasn\'t connected.');
    } catch (err) {
      setGaffaError(err instanceof Error ? err.message : 'Gaffa connection failed');
    } finally {
      setGaffaConnecting(false);
    }
  }, []);

  const handleSelectGaffaClub = useCallback((club: GaffaClubRef | null) => {
    setGaffaClub(club);
    setGaffaError(null);
    if (!club) {
      try { localStorage.removeItem(LAST_GAFFA_CLUB_KEY); } catch { /* unavailable */ }
    }
  }, []);

  const handleDisconnectGaffa = useCallback(async () => {
    await disconnectGaffa();
    clearClubBags();
    try { localStorage.removeItem(LAST_GAFFA_CLUB_KEY); } catch { /* unavailable */ }
    setGaffaClub(null);
    setGaffaClubs([]);
    setGaffaBag(null);
    setGaffaError(null);
  }, []);

  // A reply that filed a dossier: the card is saved and shown, and the chat gets its card.
  const dossierReply = useCallback((profile: PlayerProfile, id: string): ChatMessage => {
    // The in-chat card opens the panel, so the reply doesn't cover the chat on phones.
    saveAndSetActiveProfile(profile);
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
    mentions: Mention[] = [],
  ) => {
    if (!userMessageText.trim() && !imageData) return;

    // Mentioned cards join the conversation, so the model reads them in full. A shared card picked
    // from the suggestions is only an outline until the pipeline serves it (a cache hit).
    let mentionedCards: PlayerProfile[];
    try {
      mentionedCards = await Promise.all(mentions.map(async (m) => {
        if (isFullCard(m.card)) return stampDossier(m.card, Date.now());
        const local = globalDossiers.find(d => getCardKey(d) === getCardKey(m.card));
        if (local) return local;
        const served = await ratePlayer(requestForCard(m.card), [], [], globalDossiers);
        if (typeof served === 'string') throw new Error(served);
        return stampDossier(served, Date.now());
      }));
    } catch {
      mentionedCards = mentions.map(m => m.card).filter(isFullCard);
    }
    if (mentionedCards.length > 0) {
      setGlobalDossiers(prev => {
        const updated = mentionedCards.reduce(fileCard, prev);
        saveGlobalDossiers(updated);
        return updated;
      });
    }
    if (mentionedCards.length > 0) {
      setAllProfiles(prev => mentionedCards.reduce(upsertCard, prev));
    }
    const conversationCards = mentionedCards.reduce(upsertCard, allProfiles);
    const mentionLabels = mentions.map(m => m.label);

    // A message that only mentions cards, or only asks to see them, pulls those cards up: no
    // question, so no turn for the model.
    const leftover = mentions.reduce((text, m) => text.split(m.label).join(' '), userMessageText).trim();
    if (mentionedCards.length > 0 && asksToSeeMentions(leftover) && !imageData) {
      const now = Date.now();
      setMessages(prev => [
        ...prev,
        { id: generateId(), sender: 'user', content: userMessageText.trim(), timestamp: now, mentions: mentionLabels },
        ...mentionedCards.map((card, i): ChatMessage => ({
          id: generateId(),
          sender: 'ai',
          // The card is the reply; history reads the card itself through dossierKey.
          content: '',
          timestamp: now + i + 1,
          dossier: toChatDossierRef(card),
          dossierKey: getCardKey(card),
        })),
      ]);
      return;
    }
    // The model reads each mention as the exact card it names, edition included.
    const modelText = mentions.reduce(
      (text, m) => text.split(m.label).join(cardReference(m.card)),
      userMessageText,
    );

    const lowerCaseMessage = userMessageText.toLowerCase();

    let specificLoadingMessage = 'Consulting archives...';
    if (imageData) {
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
      ...(mentionLabels.length > 0 ? { mentions: mentionLabels } : {}),
    };

    setMessages(prev => [...prev, newUserMessage]);

    try {
      const streamingMessageId = generateId();
      let streamStarted = false;
      let lastStreamFlushAt = 0;
      let revisedProfile: PlayerProfile | null = null;

      // The conversation's Gaffa club, read again if it's over ten minutes old.
      const clubBag = gaffaClub && gaffaGrant ? await loadClubBag(gaffaClub) : null;
      if (clubBag?.connected) setGaffaBag(clubBag);
      let scorecard: GaffaTradeScorecard | null = null;

      let attachments: ReplyAttachments | null = null;
      const aiResponse = await sendMessageToAI(
        modelText,
        messages,
        imageData,
        conversationCards,
        globalDossiers,
        {
          onAttachments: (a) => { attachments = a; },
          onDossierUpdated: (updatedProfile) => {
            saveAndSetActiveProfile(updatedProfile);
            revisedProfile = updatedProfile;
          },
          onStageChange: (label) => setLoadingMessage(label),
          gaffaBag: clubBag?.connected ? clubBag : undefined,
          conversationId: activeConversationId ?? undefined,
          onGaffaScorecard: (card) => {
            scorecard = card;
            streamStarted = true;
            setIsLoading(false);
            setMessages(prev => [
              ...prev.filter(m => m.id !== streamingMessageId),
              { id: streamingMessageId, sender: 'ai', content: '', timestamp: Date.now(), gaffaScorecard: card },
            ]);
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
        },
      );

      let newAiMessage: ChatMessage;

      if (typeof aiResponse === 'object' && 'basicInfo' in aiResponse) {
        newAiMessage = dossierReply(aiResponse as PlayerProfile, streamingMessageId);
      } else {
        const { cards = [], scoutOffers = [] } = (attachments ?? {}) as Partial<ReplyAttachments>;
        // Cards chat showed join the conversation and your dossiers, as mentioned ones do.
        if (cards.length > 0) {
          const stamped = cards.map(card => stampDossier(card, Date.now()));
          setGlobalDossiers(prev => {
            const updated = stamped.reduce(fileCard, prev);
            saveGlobalDossiers(updated);
            return updated;
          });
          setAllProfiles(prev => stamped.reduce(upsertCard, prev));
        }
        newAiMessage = {
          id: streamingMessageId,
          sender: 'ai',
          content: aiResponse,
          timestamp: Date.now(),
          // A challenge that revised the card shows the new numbers in the thread.
          ...(revisedProfile ? { dossier: toChatDossierRef(revisedProfile) } : {}),
          ...(cards.length > 0 ? { cards: cards.map(toChatDossierRef) } : {}),
          ...(scoutOffers.length > 0 ? { scoutOffers } : {}),
          ...(scorecard ? { gaffaScorecard: scorecard } : {}),
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
  }, [messages, allProfiles, globalDossiers, gaffaClub, gaffaGrant, activeConversationId, saveAndSetActiveProfile, dossierReply]);

  // The Rate command: a rating without a chat turn to route. It lands in the chat like a typed one.
  const handleRate = useCallback(async (request: RatingRequest) => {
    if (isLoading) return;
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
  }, [isLoading, messages, allProfiles, globalDossiers, dossierReply]);

  const openScout = useCallback(() => {
    setPanelMode('scout');
    setIsPanelOpen(true);
    setIsConversationsOpen(false);
    setScoutFocus(Date.now());
  }, []);

  // Cmd/Ctrl+K opens Scout from anywhere.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
      e.preventDefault();
      openScout();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openScout]);

  // Scout rates in the background, two players at a time, while you keep chatting.
  const globalDossiersRef = useRef(globalDossiers);
  globalDossiersRef.current = globalDossiers;
  const updateJob = useCallback((id: string, patch: Partial<ScoutJob>) => {
    setScoutJobs(prev => prev.map(j => (j.id === id ? { ...j, ...patch } : j)));
  }, []);

  const runScoutJob = useCallback(async (job: ScoutJob) => {
    try {
      const reply = await ratePlayer(job.request, [], [], globalDossiersRef.current, {
        onStageChange: (stage) => updateJob(job.id, { stage }),
      });
      if (typeof reply === 'string') {
        updateJob(job.id, { status: 'error', error: reply });
        return;
      }
      const card = stampDossier(reply, Date.now());
      setGlobalDossiers(prev => {
        const updated = fileCard(prev, card);
        saveGlobalDossiers(updated);
        return updated;
      });
      setFreshKeys(prev => [getCardKey(card), ...prev.filter(k => k !== getCardKey(card))]);
      setScoutJobs(prev => prev.filter(j => j.id !== job.id));
    } catch (err) {
      updateJob(job.id, {
        status: 'error',
        error: err instanceof Error ? err.message : 'Something went wrong while rating him.',
      });
    }
  }, [updateJob]);

  useEffect(() => {
    const running = scoutJobs.filter(j => j.status === 'running').length;
    const next = scoutJobs.find(j => j.status === 'queued');
    if (running >= 2 || !next) return;
    const started = { ...next, status: 'running' as const, startedAt: Date.now(), stage: undefined };
    setScoutJobs(prev => prev.map(j => (j.id === next.id ? started : j)));
    void runScoutJob(started);
  }, [scoutJobs, runScoutJob]);

  const handleScout = useCallback((requests: RatingRequest[]) => {
    setScoutJobs(prev => [
      ...prev,
      ...requests.map((request): ScoutJob => ({ id: generateId(), request, status: 'queued' })),
    ]);
  }, []);

  const handleScoutName = useCallback((name: string) => {
    openScout();
    handleScout([{ name, edition: 'auto' }]);
  }, [openScout, handleScout]);

  const isPhone = () => !window.matchMedia('(min-width: 768px)').matches;

  // Scout's Ask: the card goes into the chat box as a mention. On a phone the sheet steps aside.
  const handleScoutAsk = useCallback((profile: PlayerProfile) => {
    setMentionRequest({ id: Date.now(), card: profile });
    setView('chat');
    if (isPhone()) setIsPanelOpen(false);
  }, []);

  const handleScoutOpenCard = useCallback((profile: PlayerProfile) => {
    // A shared card from the suggestions joins your dossiers through the pipeline (a cache hit).
    if (!isFullCard(profile)) {
      handleScout([requestForCard(profile)]);
      return;
    }
    handleSelectProfile(profile);
    setPanelMode('dossier');
  }, [handleScout]);

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
    setPanelMode('dossier');
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
    setGaffaClub(target.gaffaClub ?? null);
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
      // A new conversation keeps the last club you used.
      ...(lastGaffaClub() ? { gaffaClub: lastGaffaClub()! } : {}),
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
    setGaffaClub(newConv.gaffaClub ?? null);
    setIsPanelOpen(false);
  }, []);

  // A club linked from Gaffa opens a new conversation (once), then joins it when it's one of the
  // connected manager's clubs. Signed out of Gaffa, it waits for Connect Gaffa.
  const openedClubLinkRef = useRef<object | null>(null);
  useEffect(() => {
    if (!pendingClubLink || !isInitializedRef.current || conversations.length === 0) return;
    if (openedClubLinkRef.current !== pendingClubLink) {
      openedClubLinkRef.current = pendingClubLink;
      handleNewConversation();
      if (pendingClubLink.question) setChatDraft({ id: Date.now(), text: pendingClubLink.question });
    }
    if (!gaffaGrant) {
      setGaffaError('Connect Gaffa to bring this club into the chat.');
      return;
    }
    if (gaffaClubsLoading) return;
    const owned = gaffaClubs.some(c => c.league_id === pendingClubLink.leagueId && c.club_id === pendingClubLink.clubId);
    if (owned) {
      setGaffaClub({ leagueId: pendingClubLink.leagueId, clubId: pendingClubLink.clubId });
      setGaffaError(null);
    } else if (gaffaClubs.length > 0) {
      setGaffaError('That club isn\'t one of yours on Gaffa.');
    }
    if (gaffaClubs.length > 0) setPendingClubLink(null);
  }, [pendingClubLink, conversations.length, gaffaGrant, gaffaClubs, gaffaClubsLoading, handleNewConversation]);

  // The new-chat welcome for the attached club.
  const gaffaWelcome = useMemo<GaffaWelcomeClub | null>(() => {
    if (!gaffaClub || !gaffaGrant) return null;
    const club = gaffaClubs.find(c => c.league_id === gaffaClub.leagueId && c.club_id === gaffaClub.clubId);
    if (!club && !gaffaBag) return null;
    return {
      clubName: club?.club_name ?? gaffaBag?.club_name ?? 'Your club',
      leagueName: club?.league_name ?? gaffaBag?.league_name ?? 'Gaffa',
      bag: gaffaBag,
    };
  }, [gaffaClub, gaffaGrant, gaffaClubs, gaffaBag]);

  const handleRenameConversation = useCallback((id: string, newTitle: string) => {
    setConversations(prev => {
      const updated = prev.map(c => c.id === id ? { ...c, title: newTitle, titleSource: 'user' as const } : c);
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
          setGaffaClub(nextActive.gaffaClub ?? null);
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
          setGaffaClub(null);
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
    setPanelMode('dossier');
    setIsPanelOpen(true);
  }, [saveAndSetActiveProfile, handleSelectProfile]);

  // "Ask" on a hub card: the card joins this conversation as a stub (so the model reads the full
  // card, as with a generated dossier) and the chat box starts with a reference to that exact
  // version, which keeps the reply on it rather than another edition of the player.
  const handleAskAboutDossier = useCallback((profile: PlayerProfile) => {
    saveAndSetActiveProfile(profile);
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
  }, [saveAndSetActiveProfile]);

  // The panel shows the Scout desk, or one dossier (and is closed when none is active).
  const showPanel = isPanelOpen && (panelMode === 'scout' || activeProfile !== null);

  const toggleConversations = () => {
    setIsConversationsOpen(!isConversationsOpen);
  };

  return (
    <div className="flex flex-col h-full bg-cream-200 dark:bg-charcoal text-charcoal dark:text-cream-100 transition-colors duration-300 relative">
      <WhatsNewPopup />
      
      <Header 
        onOpenScout={() => (showPanel && panelMode === 'scout' ? setIsPanelOpen(false) : openScout())}
        isScoutOpen={showPanel && panelMode === 'scout'}
        scoutBusy={scoutJobs.filter(j => j.status !== 'error').length}
        onNewChat={handleNewConversation} 
        toggleTheme={toggleTheme} 
        isDarkMode={isDarkMode} 
        dossierCount={globalDossiers.length}
        view={view}
        onViewChange={(next) => {
          // The header's Dossiers button always opens on the global hub.
          if (next === 'hub') setHubTab('global');
          setView(next);
        }}
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
          mode={panelMode}
          onBack={() => setPanelMode('scout')}
          scout={
            <ScoutDesk
              jobs={scoutJobs}
              dossiers={globalDossiers}
              freshKeys={freshKeys}
              onScout={handleScout}
              onOpenCard={handleScoutOpenCard}
              onAsk={handleScoutAsk}
              onRetry={(id) => updateJob(id, { status: 'queued', error: undefined, stage: undefined })}
              onDismiss={(id) => setScoutJobs(prev => prev.filter(j => j.id !== id))}
              onOpenHub={() => { setHubTab('mine'); setView('hub'); if (isPhone()) setIsPanelOpen(false); }}
              onClose={() => setIsPanelOpen(false)}
              focusToken={scoutFocus}
              prefill={scoutPrefill}
            />
          }
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
              onScout={(name) => (name ? handleScoutName(name) : openScout())}
            />
          </div>

          {/* Main Chat Area */}
          <main className="flex-1 flex flex-col w-full h-full relative min-h-0" inert={view !== 'chat'}>
            <ChatHistory 
                messages={messages} 
                isLoading={isLoading} 
                loadingMessage={loadingMessage}
                conversationKey={`${activeConversationId ?? 'init'}-${newChatRevision}`}
                gaffaClub={gaffaWelcome}
                onSuggestion={(prompt) => handleSendMessage(prompt)}
                onOpenScout={openScout}
                onScoutName={handleScoutName}
                onOpenDossier={handleOpenDossier}
                onRetry={handleRetry}
            />
            
            {/* Input Container - Sticky Bottom */}
            <div className="flex-none px-3 sm:px-6 pt-2 sm:pt-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:pb-8 bg-gradient-to-t from-cream-200 dark:from-charcoal via-cream-200/95 dark:via-charcoal/95 to-transparent z-20">
                <div className="max-w-[800px] mx-auto w-full">
                    <ChatInput
                        onSendMessage={handleSendMessage}
                        isLoading={isLoading}
                        loadingMessage={loadingMessage}
                        gaffaControl={
                          <GaffaClubChip
                            connected={Boolean(gaffaGrant)}
                            clubs={gaffaClubs}
                            selected={gaffaClub}
                            loadingClubs={gaffaClubsLoading}
                            connecting={gaffaConnecting}
                            error={gaffaError}
                            gaffaBaseUrl={gaffaBase}
                            disabled={isLoading}
                            onConnect={handleConnectGaffa}
                            onSelect={handleSelectGaffaClub}
                            onDisconnect={handleDisconnectGaffa}
                          />
                        }
                        draft={chatDraft}
                        localCards={globalDossiers}
                        mentionRequest={mentionRequest}
                        onScoutName={handleScoutName}
                    />
                </div>
            </div>
          </main>
      </div>
    </div>
  );
};

export default App;