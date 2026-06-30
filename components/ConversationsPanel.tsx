import React, { useState, useEffect } from 'react';
import type { Conversation } from '../types';
import { shareConversation } from '../services/geminiService';

interface ConversationsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onRenameConversation: (id: string, newTitle: string) => void;
  onDeleteConversation: (id: string) => void;
}

export const ConversationsPanel: React.FC<ConversationsPanelProps> = ({
  isOpen,
  onClose,
  conversations,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  onRenameConversation,
  onDeleteConversation,
}) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isDesktop, setIsDesktop] = useState(false);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [sharedId, setSharedId] = useState<string | null>(null);

  useEffect(() => {
    const checkDesktop = () => setIsDesktop(window.matchMedia('(min-width: 768px)').matches);
    checkDesktop();
    window.addEventListener('resize', checkDesktop);
    return () => window.removeEventListener('resize', checkDesktop);
  }, []);

  const handleStartRename = (conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(conv.id);
    setEditTitle(conv.title);
  };

  const handleSaveRename = (id: string, e: React.FormEvent) => {
    e.preventDefault();
    if (editTitle.trim()) {
      onRenameConversation(id, editTitle.trim());
    }
    setEditingId(null);
  };

  const handleCancelRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(null);
  };

  const handleDeleteClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDeleteId === id) {
      onDeleteConversation(id);
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(id);
      // Automatically reset confirmation after 3 seconds
      setTimeout(() => {
        setConfirmDeleteId(current => current === id ? null : current);
      }, 3000);
    }
  };

  const handleShareClick = async (conv: Conversation, e: React.MouseEvent) => {
    e.stopPropagation();
    if (sharingId) return;
    setSharingId(conv.id);
    try {
      const code = await shareConversation(conv);
      const url = `${window.location.origin}/#/c/${code}`;
      await navigator.clipboard.writeText(url);
      setSharedId(conv.id);
      setTimeout(() => setSharedId(null), 2000);
    } catch (err) {
      console.error('Failed to share conversation:', err);
    } finally {
      setSharingId(null);
    }
  };

  const getPanelStyle = (): React.CSSProperties => {
    if (isDesktop) {
      return {
        transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
      };
    } else {
      return {
        transform: isOpen ? 'translateY(0)' : 'translateY(100%)',
      };
    }
  };

  return (
    <>
      {/* Backdrop for mobile */}
      {!isDesktop && isOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 md:hidden animate-fade-in"
          onClick={onClose}
        />
      )}

      <div
        style={getPanelStyle()}
        className={`fixed z-[60] bg-cream-100 dark:bg-charcoal border-l border-cream-300 dark:border-charcoal-border shadow-float flex flex-col
          left-0 right-0 bottom-0 h-[85vh] rounded-t-2xl transition-transform duration-500 ease-ios-ease will-change-transform
          md:left-auto md:right-0 md:top-0 md:bottom-0 md:h-full md:w-[350px] md:rounded-none
        `}
      >
        {/* Header Area */}
        <div className="flex justify-between items-center px-6 py-5 border-b border-cream-300 dark:border-charcoal-border bg-cream-50 dark:bg-charcoal-surface rounded-t-2xl md:rounded-none sticky top-0 z-50">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-emerald-600 dark:text-emerald-400">forum</span>
            <h3 className="text-sm font-serif font-bold text-charcoal dark:text-white uppercase tracking-widest">
              Saved Briefs
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-charcoal/60 dark:text-cream-400 hover:text-red-500 hover:bg-cream-200 dark:hover:bg-charcoal-light rounded-full transition-colors"
            title="Close Panels"
          >
            <span className="material-symbols-outlined text-[18px] block">close</span>
          </button>
        </div>

        {/* Action Controls */}
        <div className="p-4 border-b border-cream-300 dark:border-charcoal-border bg-cream-100 dark:bg-charcoal shrink-0">
          <button
            onClick={() => {
              onNewConversation();
              if (!isDesktop) onClose();
            }}
            className="w-full py-3 px-4 flex items-center justify-center gap-2 border border-emerald-500/30 hover:border-emerald-500 hover:bg-emerald-500/5 text-emerald-600 dark:text-emerald-400 font-serif font-bold text-sm tracking-wide rounded-xl transition-all shadow-sm hover:shadow active:scale-98"
          >
            <span className="material-symbols-outlined text-[18px]">add_comment</span>
            Start New Briefing
          </button>
        </div>

        {/* Scrollable Conversation List */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2 bg-cream-100 dark:bg-charcoal">
          {conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 opacity-40 text-center px-4 select-none">
              <span className="material-symbols-outlined text-[32px] mb-2">chat_bubble_outline</span>
              <p className="text-xs font-serif italic">No archived briefings found</p>
            </div>
          ) : (
            conversations.map((conv) => {
              const isActive = conv.id === activeConversationId;
              const isEditing = conv.id === editingId;
              const isDeleting = confirmDeleteId === conv.id;
              const msgCount = conv.messages.length;
              const formattedDate = new Date(conv.createdAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              });

              return (
                <div
                  key={conv.id}
                  onClick={() => {
                    if (!isEditing) {
                      onSelectConversation(conv.id);
                      if (!isDesktop) onClose();
                    }
                  }}
                  className={`group relative flex flex-col p-3.5 rounded-xl border transition-all duration-300 cursor-pointer ${
                    isActive
                      ? 'bg-cream-300/40 dark:bg-charcoal-light/55 border-emerald-500/40 shadow-paper'
                      : 'bg-white dark:bg-charcoal-surface/30 border-cream-300/60 dark:border-charcoal-border hover:bg-cream-200/50 dark:hover:bg-charcoal-light/30'
                  }`}
                >
                  {isEditing ? (
                    <form
                      onSubmit={(e) => handleSaveRename(conv.id, e)}
                      onClick={(e) => e.stopPropagation()}
                      className="flex items-center gap-1.5 w-full"
                    >
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        autoFocus
                        onBlur={(e) => {
                          // Allow submit/cancel clicks to go through before resetting
                          setTimeout(() => {
                            if (editingId === conv.id) setEditingId(null);
                          }, 150);
                        }}
                        className="flex-1 px-2.5 py-1 text-xs font-serif bg-cream-100 dark:bg-charcoal border border-emerald-500/50 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 text-charcoal dark:text-cream-50"
                      />
                      <button
                        type="submit"
                        className="p-1 text-emerald-600 hover:text-emerald-500 active:scale-95 transition-transform"
                        title="Save title"
                      >
                        <span className="material-symbols-outlined text-[16px] block font-bold">check</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelRename}
                        className="p-1 text-red-500 hover:text-red-400 active:scale-95 transition-transform"
                        title="Cancel"
                      >
                        <span className="material-symbols-outlined text-[16px] block">close</span>
                      </button>
                    </form>
                  ) : (
                    <div className="flex flex-col pr-12">
                      <h4 className="font-serif font-bold text-sm tracking-tight text-charcoal dark:text-cream-50 line-clamp-1">
                        {conv.title || 'New Briefing'}
                      </h4>
                      <div className="flex items-center gap-2 mt-1.5 text-[10px] font-mono text-charcoal/50 dark:text-cream-400 font-medium">
                        <span>{formattedDate}</span>
                        <span className="size-1 rounded-full bg-charcoal/20 dark:bg-cream-400/20"></span>
                        <span>{msgCount} message{msgCount !== 1 ? 's' : ''}</span>
                        {conv.allProfiles && conv.allProfiles.length > 0 && (
                          <>
                            <span className="size-1 rounded-full bg-charcoal/20 dark:bg-cream-400/20"></span>
                            <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                              <span className="material-symbols-outlined text-[10px] block">folder</span>
                              {conv.allProfiles.length}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Actions Drawer - displayed on hover or if active */}
                  {!isEditing && (
                    <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity bg-gradient-to-l from-white dark:from-charcoal-surface via-white dark:via-charcoal-surface to-transparent pl-4 py-1.5 rounded-r-xl">
                      <button
                        onClick={(e) => handleShareClick(conv, e)}
                        disabled={sharingId === conv.id}
                        className={`p-1 rounded transition-all ${
                          sharedId === conv.id
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-charcoal/50 dark:text-cream-400/60 hover:text-blue-500 hover:bg-cream-300/30 dark:hover:bg-charcoal-light/40'
                        }`}
                        title="Share Briefing"
                      >
                        <span className="material-symbols-outlined text-[14px] block">
                          {sharingId === conv.id ? 'hourglass_empty' : sharedId === conv.id ? 'check' : 'link'}
                        </span>
                      </button>
                      <button
                        onClick={(e) => handleStartRename(conv, e)}
                        className="p-1 text-charcoal/50 dark:text-cream-400/60 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-cream-300/30 dark:hover:bg-charcoal-light/40 rounded transition-all"
                        title="Rename Briefing"
                      >
                        <span className="material-symbols-outlined text-[14px] block">edit</span>
                      </button>
                      <button
                        onClick={(e) => handleDeleteClick(conv.id, e)}
                        className={`p-1 rounded transition-all ${
                          isDeleting
                            ? 'bg-red-500/10 text-red-600 border border-red-500/30 hover:bg-red-500 hover:text-white px-2'
                            : 'text-charcoal/50 dark:text-cream-400/60 hover:text-red-500 hover:bg-cream-300/30 dark:hover:bg-charcoal-light/40'
                        }`}
                        title={isDeleting ? "Click again to confirm delete" : "Delete Briefing"}
                      >
                        {isDeleting ? (
                          <span className="text-[9px] font-sans font-bold uppercase tracking-wider">Confirm</span>
                        ) : (
                          <span className="material-symbols-outlined text-[14px] block">delete</span>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
};
