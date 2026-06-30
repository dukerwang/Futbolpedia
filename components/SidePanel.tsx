import React, { useState, useEffect } from 'react';
import type { PlayerProfile } from '../types';
import { ATTRIBUTE_CATEGORIES, GK_ATTRIBUTE_CATEGORIES } from '../constants';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { supabase, toPlayerSlug } from '../services/geminiService';

interface SidePanelProps {
  isOpen: boolean;
  onClose: () => void;
  profile: PlayerProfile | null;
  allProfiles: PlayerProfile[];
  onSelectProfile: (profile: PlayerProfile | null) => void;
  onBackToHome: () => void;
  onRenameDossier?: (oldName: string, newName: string) => void;
  onDeleteDossier?: (playerName: string) => void;
}

const getTierColorClass = (rating: number) => {
    if (rating >= 90) return 'bg-emerald-500'; // 90+ Emerald
    if (rating >= 80) return 'bg-emerald-400'; // 80-89 Sage/Light Green
    if (rating >= 70) return 'bg-charcoal/50 dark:bg-gray-400'; // 70-79 Charcoal Light
    return 'bg-gray-200 dark:bg-gray-700'; // <70 Faint Grey
};

const AttributeLine: React.FC<{ label: string; rating: number }> = ({ label, rating }) => {
    return (
        <div className="group">
            <div className="flex justify-between text-xs mb-1.5 items-end">
                <span className="text-charcoal/70 dark:text-cream-200 font-medium">{label}</span>
                <span className={`font-mono text-sm leading-none font-bold ${rating >= 90 ? 'text-emerald-600 dark:text-emerald-400' : 'text-charcoal dark:text-cream-100'}`}>{rating}</span>
            </div>
            <div className="h-[3px] w-full bg-cream-400/30 dark:bg-charcoal-light/50 rounded-full overflow-hidden">
                <div 
                    className={`h-full relative transition-all duration-1000 rounded-full ${getTierColorClass(rating)}`} 
                    style={{ width: `${rating}%` }}
                >
                </div>
            </div>
        </div>
    );
};

export const SidePanel: React.FC<SidePanelProps> = ({ 
  isOpen, 
  onClose, 
  profile,
  allProfiles = [],
  onSelectProfile,
  onBackToHome,
  onRenameDossier,
  onDeleteDossier
}) => {
  const [shareStatus, setShareStatus] = useState<'idle' | 'saving' | 'copied'>('idle');
  const [isDesktop, setIsDesktop] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  
  // Dossier list editing states
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editNameText, setEditNameText] = useState('');
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);
  const [sharingName, setSharingName] = useState<string | null>(null);
  const [sharedName, setSharedName] = useState<string | null>(null);

  const currentIndex = profile && allProfiles
    ? allProfiles.findIndex(p => p.basicInfo.name.toLowerCase() === profile.basicInfo.name.toLowerCase())
    : -1;
  
  // Mobile Gesture State
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [currentTouch, setCurrentTouch] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    const checkDesktop = () => setIsDesktop(window.matchMedia('(min-width: 768px)').matches);
    checkDesktop();
    window.addEventListener('resize', checkDesktop);
    return () => window.removeEventListener('resize', checkDesktop);
  }, []);

  // Animation Trigger (now based on isOpen state to support home page transitions too)
  useEffect(() => {
    if (isOpen) {
        const timer = setTimeout(() => setIsVisible(true), 50);
        return () => clearTimeout(timer);
    } else {
        setIsVisible(false);
    }
  }, [isOpen]);

  const getTierText = (rating: number) => {
      if (rating >= 96) return "Generational Icon";
      if (rating >= 91) return "World Class Elite";
      if (rating >= 86) return "Elite Starter";
      if (rating >= 81) return "High-Caliber";
      if (rating >= 76) return "Top Flight Proven";
      if (rating >= 70) return "Squad Rotation";
      return "Developing";
  };

  const renderMarkdown = (text: string) => {
      if (!text) return { __html: '' };
      const safeText = DOMPurify.sanitize(marked.parse(text) as string);
      return { __html: safeText };
  };

  const handleShare = async () => {
    if (!profile || !supabase) return;
    setShareStatus('saving');
    try {
        const slug = toPlayerSlug(profile.basicInfo.name);
        const { error } = await supabase
          .from('player_profiles')
          .upsert(
            { player_slug: slug, player_data: profile, updated_at: new Date().toISOString() },
            { onConflict: 'player_slug' }
          );
        if (error) throw error;
        const shareUrl = `${window.location.origin}/#/p/${slug}`;
        await navigator.clipboard.writeText(shareUrl);
        setShareStatus('copied');
        setTimeout(() => setShareStatus('idle'), 2000);
    } catch (err) {
        console.error(err);
        setShareStatus('idle');
    }
  };

  const formatPosition = (position: string) => {
      if (!position) return '';
      const mappings: Record<string, string> = {
          'Goalkeeper': 'GK',
          'Center Back': 'CB', 'Centre Back': 'CB', 'Centre-Back': 'CB',
          'Left Back': 'LB', 'Left-Back': 'LB',
          'Right Back': 'RB', 'Right-Back': 'RB',
          'Left Wing Back': 'LWB', 'Left Wing-Back': 'LWB',
          'Right Wing Back': 'RWB', 'Right Wing-Back': 'RWB',
          'Defensive Midfielder': 'DM',
          'Central Midfielder': 'CM',
          'Attacking Midfielder': 'AM',
          'Left Winger': 'LW', 'Left Midfielder': 'LM',
          'Right Winger': 'RW', 'Right Midfielder': 'RM',
          'Striker': 'ST', 'Centre Forward': 'CF', 'Center Forward': 'CF',
          'Second Striker': 'SS', 'Forward': 'FW'
      };
      
      return position.split(/[\/,]/).map(p => {
          const trimmed = p.trim();
          const key = Object.keys(mappings).find(k => k.toLowerCase() === trimmed.toLowerCase());
          return key ? mappings[key] : trimmed;
      }).join('/');
  };

  // --- NATIVE SWIPE LOGIC ---
  const handleTouchStart = (e: React.TouchEvent) => {
    if (isDesktop) return;
    setTouchStart(e.targetTouches[0].clientY);
    setIsDragging(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (isDesktop || !isDragging || touchStart === null) return;
    const y = e.targetTouches[0].clientY;
    if (y > touchStart) {
      setCurrentTouch(y);
    }
  };

  const handleTouchEnd = () => {
    if (isDesktop || !isDragging || touchStart === null) {
        setIsDragging(false);
        setTouchStart(null);
        setCurrentTouch(null);
        return;
    }
    
    if (currentTouch) {
      const diff = currentTouch - touchStart;
      if (diff > 100) {
        onClose();
      }
    }
    
    setTouchStart(null);
    setCurrentTouch(null);
    setIsDragging(false);
  };

  const getPanelStyle = (): React.CSSProperties => {
      if (!isVisible) {
          return isDesktop 
            ? { transform: 'translateX(-100%)' } 
            : { transform: 'translateY(100%)' };
      }

      if (isDesktop) {
          return {
              transform: isOpen ? 'translateX(0)' : 'translateX(-100%)',
          };
      } else {
          if (isDragging && currentTouch && touchStart) {
              const diff = Math.max(0, currentTouch - touchStart);
              return { 
                  transform: `translateY(${diff}px)`, 
                  transition: 'none'
              };
          }
          return {
              transform: isOpen ? 'translateY(0)' : 'translateY(100%)',
          };
      }
  };

  const handleStartRename = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingName(name);
    setEditNameText(name);
  };

  const handleSaveRename = (oldName: string, e: React.FormEvent) => {
    e.preventDefault();
    if (editNameText.trim() && onRenameDossier) {
      onRenameDossier(oldName, editNameText.trim());
    }
    setEditingName(null);
  };

  const handleCancelRename = () => {
    setEditingName(null);
  };

  const handleDeleteClick = (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDeleteName === name) {
      if (onDeleteDossier) {
        onDeleteDossier(name);
      }
      setConfirmDeleteName(null);
    } else {
      setConfirmDeleteName(name);
      // Automatically reset confirmation after 3 seconds
      setTimeout(() => {
        setConfirmDeleteName(prev => prev === name ? null : prev);
      }, 3000);
    }
  };

  const handleShareDossierItem = async (p: PlayerProfile, e: React.MouseEvent) => {
    e.stopPropagation();
    if (sharingName || !supabase) return;
    setSharingName(p.basicInfo.name);
    try {
      const slug = toPlayerSlug(p.basicInfo.name);
      const { error } = await supabase
        .from('player_profiles')
        .upsert(
          { player_slug: slug, player_data: p, updated_at: new Date().toISOString() },
          { onConflict: 'player_slug' }
        );
      if (error) throw error;
      await navigator.clipboard.writeText(`${window.location.origin}/#/p/${slug}`);
      setSharedName(p.basicInfo.name);
      setTimeout(() => setSharedName(null), 2000);
    } catch (err) {
      console.error('Failed to share dossier:', err);
    } finally {
      setSharingName(null);
    }
  };

  // Prevent render if not open and not visible
  if (!isOpen && !isVisible) return null;

  // Render Dossier Library Home if active profile is null
  if (!profile) {
    return (
      <>
        {!isDesktop && isOpen && (
            <div 
                className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 md:hidden animate-fade-in"
                onClick={onClose}
            />
        )}

        <div 
            style={getPanelStyle()}
            className={`fixed z-[60] bg-cream-100 dark:bg-charcoal border-r border-cream-300/80 dark:border-charcoal-border/80 shadow-right-depth dark:shadow-dark-float flex flex-col
                inset-x-0 bottom-0 h-[92vh] rounded-t-2xl transition-transform duration-500 ease-ios-ease will-change-transform
                md:inset-y-0 md:left-0 md:h-full md:w-[450px] md:rounded-none
            `}
        >
            {/* Header Area */}
            <div className="flex justify-between items-center px-8 py-6 border-b border-cream-300 dark:border-charcoal-border bg-cream-50 dark:bg-charcoal-surface rounded-t-2xl md:rounded-none sticky top-0 z-50">
                <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[22px] text-emerald-600 dark:text-emerald-400">folder_shared</span>
                    <h3 className="text-sm font-serif font-bold text-charcoal dark:text-white uppercase tracking-widest">
                        Dossier Library
                    </h3>
                </div>
                <button
                    onClick={onClose}
                    className="p-1.5 text-charcoal/60 dark:text-cream-400 hover:text-red-500 hover:bg-cream-200 dark:hover:bg-charcoal-light rounded-full transition-colors"
                    title="Close Panel"
                >
                    <span className="material-symbols-outlined text-[18px] block">close</span>
                </button>
            </div>

            {/* Scrollable Dossiers List */}
            <div className="flex-1 overflow-y-auto px-6 py-6 space-y-3 bg-cream-100 dark:bg-charcoal">
                {allProfiles.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-64 opacity-40 text-center px-4 select-none">
                        <span className="material-symbols-outlined text-[40px] mb-2">folder_open</span>
                        <p className="text-sm font-serif italic">No dossiers generated yet</p>
                        <p className="text-xs font-sans mt-2 max-w-[280px] leading-relaxed mx-auto text-charcoal/60 dark:text-cream-400">
                            Ask Futbolpedia to rate or scout a player to compile a scouting dossier here.
                        </p>
                    </div>
                ) : (
                    allProfiles.map((p) => {
                        const isEditing = editingName === p.basicInfo.name;
                        const isDeleting = confirmDeleteName === p.basicInfo.name;
                        const formattedDate = new Date(p.createdAt || Date.now()).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric'
                        });

                        return (
                            <div
                                key={p.basicInfo.name}
                                onClick={() => {
                                    if (!isEditing) {
                                        onSelectProfile(p);
                                    }
                                }}
                                className="group relative flex flex-col p-4 rounded-xl border transition-all duration-300 cursor-pointer bg-white dark:bg-charcoal-surface/30 border-cream-300/60 dark:border-charcoal-border hover:bg-cream-200/50 dark:hover:bg-charcoal-light/30 shadow-sm"
                            >
                                {isEditing ? (
                                    <form
                                        onSubmit={(e) => handleSaveRename(p.basicInfo.name, e)}
                                        onClick={(e) => e.stopPropagation()}
                                        className="flex items-center gap-1.5 w-full"
                                    >
                                        <input
                                            type="text"
                                            value={editNameText}
                                            onChange={(e) => setEditNameText(e.target.value)}
                                            autoFocus
                                            onBlur={() => {
                                                // Wait for form actions to proceed
                                                setTimeout(() => {
                                                    setEditingName(null);
                                                }, 200);
                                            }}
                                            className="flex-1 px-3 py-1.5 text-xs font-serif bg-cream-100 dark:bg-charcoal border border-emerald-500/50 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 text-charcoal dark:text-cream-50"
                                        />
                                        <button
                                            type="submit"
                                            className="p-1 text-emerald-600 hover:text-emerald-500 active:scale-95 transition-transform"
                                            title="Save name"
                                        >
                                            <span className="material-symbols-outlined text-[18px] block font-bold">check</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={handleCancelRename}
                                            className="p-1 text-red-500 hover:text-red-400 active:scale-95 transition-transform"
                                            title="Cancel"
                                        >
                                            <span className="material-symbols-outlined text-[18px] block">close</span>
                                        </button>
                                    </form>
                                ) : (
                                    <div className="flex justify-between items-center pr-12">
                                        <div className="flex flex-col">
                                            <h4 className="font-serif font-bold text-sm tracking-tight text-charcoal dark:text-cream-50 line-clamp-1">
                                                {p.basicInfo.name}
                                            </h4>
                                            <div className="flex items-center gap-1.5 mt-1 text-[10px] font-mono text-charcoal/50 dark:text-cream-400 font-medium">
                                                <span>{formattedDate}</span>
                                                <span className="size-1 rounded-full bg-charcoal/20 dark:bg-cream-400/20"></span>
                                                <span>{formatPosition(p.basicInfo.position)}</span>
                                                <span className="size-1 rounded-full bg-charcoal/20 dark:bg-cream-400/20"></span>
                                                <span className="line-clamp-1 max-w-[120px]">{p.basicInfo.club}</span>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-1 bg-cream-200/50 dark:bg-charcoal-light/40 px-2.5 py-1 rounded-lg border border-cream-300/40 dark:border-charcoal-border shrink-0 ml-2">
                                            <span className="text-xs font-mono font-bold text-emerald-600 dark:text-emerald-400">{p.ratings.overall}</span>
                                            <span className="text-[8px] font-bold text-charcoal/40 dark:text-cream-400 uppercase tracking-wider">OVR</span>
                                        </div>
                                    </div>
                                )}

                                {!isEditing && (
                                    <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover:opacity-100 md:group-focus-within:opacity-100 transition-opacity bg-gradient-to-l from-white dark:from-charcoal-surface via-white dark:via-charcoal-surface to-transparent pl-4 py-1.5 rounded-r-xl">
                                        <button
                                            onClick={(e) => handleShareDossierItem(p, e)}
                                            disabled={sharingName === p.basicInfo.name}
                                            className={`p-1 rounded transition-all ${
                                                sharedName === p.basicInfo.name
                                                    ? 'text-emerald-600 dark:text-emerald-400'
                                                    : 'text-charcoal/50 dark:text-cream-400/60 hover:text-blue-500 hover:bg-cream-300/30 dark:hover:bg-charcoal-light/40'
                                            }`}
                                            title="Share Dossier"
                                        >
                                            <span className="material-symbols-outlined text-[14px] block">
                                                {sharingName === p.basicInfo.name ? 'hourglass_empty' : sharedName === p.basicInfo.name ? 'check' : 'link'}
                                            </span>
                                        </button>
                                        <button
                                            onClick={(e) => handleStartRename(p.basicInfo.name, e)}
                                            className="p-1 text-charcoal/50 dark:text-cream-400/60 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-cream-300/30 dark:hover:bg-charcoal-light/40 rounded transition-all"
                                            title="Rename Dossier"
                                        >
                                            <span className="material-symbols-outlined text-[14px] block">edit</span>
                                        </button>
                                        <button
                                            onClick={(e) => handleDeleteClick(p.basicInfo.name, e)}
                                            className={`p-1 rounded transition-all ${
                                                isDeleting
                                                    ? 'bg-red-500/10 text-red-600 border border-red-500/30 hover:bg-red-500 hover:text-white px-2'
                                                    : 'text-charcoal/50 dark:text-cream-400/60 hover:text-red-500 hover:bg-cream-300/30 dark:hover:bg-charcoal-light/40'
                                            }`}
                                            title={isDeleting ? "Click again to confirm delete" : "Delete Dossier"}
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
  }

  const categories = profile.goalkeeperAttributes ? GK_ATTRIBUTE_CATEGORIES : ATTRIBUTE_CATEGORIES;
  const attrSource = profile.goalkeeperAttributes ? profile.goalkeeperAttributes : profile.attributes;

  return (
    <>
        {!isDesktop && isOpen && (
            <div 
                className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 md:hidden animate-fade-in"
                onClick={onClose}
            />
        )}

        <div 
            style={getPanelStyle()}
            className={`fixed z-[60] bg-cream-100 dark:bg-charcoal border-r border-cream-300 dark:border-charcoal-border shadow-right-depth dark:shadow-dark-float flex flex-col
                inset-x-0 bottom-0 h-[92vh] rounded-t-2xl transition-transform duration-500 ease-ios-ease will-change-transform
                md:inset-y-0 md:left-0 md:h-full md:w-[450px] md:rounded-none
            `}
        >
            {/* Header Area */}
            <div 
                className="flex flex-col border-b border-cream-300 dark:border-charcoal-border bg-cream-50 dark:bg-charcoal-surface rounded-t-2xl md:rounded-none sticky top-0 z-50 touch-none"
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
            >
                {/* Visual Handle */}
                <div className="w-full h-8 flex items-center justify-center md:hidden cursor-grab active:cursor-grabbing">
                    <div className="w-16 h-1.5 bg-charcoal/20 dark:bg-cream-400/20 rounded-full"></div>
                </div>

                <div className="flex justify-between items-start px-8 pt-6 pb-4">
                    <div className="flex-1 pr-4">
                        <h2 className="text-2xl font-serif font-bold text-charcoal dark:text-white leading-tight">{profile.basicInfo.name}</h2>
                        <p className="text-emerald-600 dark:text-emerald-400 font-serif italic text-base leading-tight mt-1 mb-1">
                            {profile.playstyleAndRole?.playstyle?.archetype}
                        </p>
                        <div className="flex flex-wrap items-center gap-1.5 mt-2 text-xs text-charcoal/60 dark:text-cream-400 font-sans">
                                <span className="font-semibold text-charcoal dark:text-cream-200">{formatPosition(profile.basicInfo.position)}</span>
                                <span className="w-px h-3 bg-charcoal/20 dark:bg-cream-400/20"></span>
                                <span className="line-clamp-1">{profile.basicInfo.club}</span>
                                {profile.basicInfo.height && profile.basicInfo.height !== 'N/A' && (
                                    <>
                                        <span className="w-px h-3 bg-charcoal/20 dark:bg-cream-400/20"></span>
                                        <span>{profile.basicInfo.height}</span>
                                    </>
                                )}
                        </div>
                    </div>
                    
                    <div className="flex flex-col items-end text-right shrink-0">
                        <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-widest mb-1.5">{getTierText(profile.ratings.overall)}</span>
                        
                        <div className="flex gap-4">
                            <div className="flex flex-col items-center">
                                <span className={`text-2xl font-mono font-bold leading-none ${profile.ratings.overall >= 90 ? 'text-emerald-600 dark:text-emerald-400' : 'text-charcoal dark:text-white'}`}>{profile.ratings.overall}</span>
                                <span className="text-[8px] font-bold text-charcoal/40 dark:text-cream-400 uppercase tracking-wider mt-1">OVR</span>
                            </div>
                            <div className="flex flex-col items-center">
                                <span className="text-2xl font-mono font-bold leading-none text-charcoal/60 dark:text-cream-200">{profile.ratings.potential}</span>
                                <span className="text-[8px] font-bold text-charcoal/40 dark:text-cream-400 uppercase tracking-wider mt-1">POT</span>
                            </div>
                        </div>

                        {/* Navigation Arrows placed in the blank space under OVR and POT, but above share/close buttons */}
                        {allProfiles.length > 1 && currentIndex !== -1 && (
                            <div className="flex items-center bg-cream-200/60 dark:bg-charcoal-light/35 rounded-lg p-0.5 border border-cream-300/60 dark:border-charcoal-border select-none mt-4">
                                <button 
                                    disabled={currentIndex === 0}
                                    onClick={() => onSelectProfile(allProfiles[currentIndex - 1])}
                                    className="p-1 rounded text-charcoal/60 dark:text-cream-400 hover:text-charcoal dark:hover:text-white hover:bg-cream-200 dark:hover:bg-charcoal-light disabled:opacity-20 disabled:pointer-events-none transition-all active:scale-95"
                                    title="Previous Dossier"
                                >
                                    <span className="material-symbols-outlined text-[15px] font-bold block">arrow_back</span>
                                </button>
                                
                                <span className="text-[10px] font-mono font-bold px-2 text-charcoal/70 dark:text-cream-300">
                                    {currentIndex + 1}/{allProfiles.length}
                                </span>

                                <button 
                                    disabled={currentIndex === allProfiles.length - 1}
                                    onClick={() => onSelectProfile(allProfiles[currentIndex + 1])}
                                    className="p-1 rounded text-charcoal/60 dark:text-cream-400 hover:text-charcoal dark:hover:text-white hover:bg-cream-200 dark:hover:bg-charcoal-light disabled:opacity-20 disabled:pointer-events-none transition-all active:scale-95"
                                    title="Next Dossier"
                                >
                                    <span className="material-symbols-outlined text-[15px] font-bold block">arrow_forward</span>
                                </button>
                            </div>
                        )}
                    </div>
                </div>

                {/* Toolbar / Inline Back, Share and Close */}
                <div className="flex justify-between items-center px-8 pb-5">
                    <div className="flex items-center">
                        <span className="text-[10px] uppercase tracking-widest text-charcoal/40 dark:text-cream-400/40 font-bold">Confidential Dossier</span>
                    </div>
                    
                    <div className="flex items-center gap-2">
                        {/* Inline Back to Dossier Home Button */}
                        <button 
                            onClick={onBackToHome}
                            className="p-1.5 text-charcoal/60 dark:text-cream-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-all flex items-center gap-1 rounded-lg hover:bg-cream-200/50 dark:hover:bg-charcoal-light/30 px-2 py-1"
                            title="Back to Dossier Home"
                        >
                            <span className="material-symbols-outlined text-[18px] block">arrow_back</span>
                            <span className="text-[10px] font-sans font-bold uppercase tracking-wider">Back</span>
                        </button>

                        <button 
                            onClick={handleShare} 
                            className="p-1.5 text-charcoal/60 dark:text-cream-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors rounded-lg hover:bg-cream-200/50 dark:hover:bg-charcoal-light/30" 
                            title="Share Profile"
                        >
                            <span className="material-symbols-outlined text-[18px] block">{shareStatus === 'copied' ? 'check' : 'share'}</span>
                        </button>
                        <button 
                            onClick={onClose} 
                            className="p-1.5 text-charcoal/60 dark:text-cream-400 hover:text-red-500 transition-colors rounded-lg hover:bg-cream-200/50 dark:hover:bg-charcoal-light/30" 
                            title="Close"
                        >
                            <span className="material-symbols-outlined text-[18px] block">close</span>
                        </button>
                    </div>
                </div>
            </div>

            {/* Content Scroll Area */}
            <div 
                className="flex-1 overflow-y-auto px-8 py-8 scrollbar-hide space-y-10 bg-cream-100 dark:bg-charcoal" 
                onPointerDownCapture={e => e.stopPropagation()} 
                onTouchStart={e => e.stopPropagation()} 
            >
                
                {/* 1. Scout Summary */}
                <div>
                        <h3 className="text-xs font-serif font-bold text-charcoal dark:text-white uppercase tracking-[0.2em] mb-4 border-b border-cream-300 dark:border-charcoal-border pb-2 inline-block">Scout Summary</h3>
                        <div className="prose prose-sm dark:prose-invert leading-relaxed text-charcoal dark:text-cream-100 text-[15px] font-light text-justify font-sans" dangerouslySetInnerHTML={renderMarkdown(profile.shortBio)} />
                </div>

                {/* 2. Tactical Brief */}
                {profile.playstyleAndRole?.playstyle?.description && (
                     <div>
                          <h3 className="text-xs font-serif font-bold text-charcoal dark:text-white uppercase tracking-[0.2em] mb-4 border-b border-cream-300 dark:border-charcoal-border pb-2 inline-block">
                              <span className="flex items-center gap-2">Tactical Brief</span>
                          </h3>
                          <div className="prose prose-sm dark:prose-invert leading-relaxed text-charcoal dark:text-cream-100 text-[15px] font-light text-justify font-sans" dangerouslySetInnerHTML={renderMarkdown(profile.playstyleAndRole.playstyle.description)} />
                     </div>
                )}

                {/* 3. Best Roles */}
                {profile.playstyleAndRole?.bestRoles && profile.playstyleAndRole.bestRoles.length > 0 && (
                     <div>
                          <h3 className="text-xs font-serif font-bold text-charcoal dark:text-white uppercase tracking-[0.2em] mb-4 border-b border-cream-300 dark:border-charcoal-border pb-2 inline-block">Effective Roles</h3>
                          <div className="flex flex-wrap gap-2">
                              {profile.playstyleAndRole.bestRoles.map((role, idx) => (
                                  <span key={idx} className="px-3 py-1 bg-white dark:bg-charcoal-light border border-cream-300 dark:border-charcoal-border rounded-full text-xs font-bold text-charcoal/80 dark:text-cream-200 font-sans">
                                      {role}
                                  </span>
                              ))}
                          </div>
                      </div>
                )}

                {/* 4. Strengths & Weaknesses */}
                <div className="grid grid-cols-1 gap-6">
                    <div>
                            <h4 className="flex items-center gap-2 text-[11px] font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-widest mb-3">
                            Key Strengths
                            </h4>
                            <ul className="text-sm text-charcoal dark:text-cream-200 space-y-2 list-none pl-0 font-sans">
                            {profile.strengths.map((s,i) => (
                                <li key={i} className="flex gap-3">
                                    <span className="text-emerald-500 font-bold">•</span>
                                    <span dangerouslySetInnerHTML={renderMarkdown(s.replace(/\*\*/g, ''))} />
                                </li>
                            ))}
                            </ul>
                    </div>
                    <div>
                            <h4 className="flex items-center gap-2 text-[11px] font-bold text-red-700 dark:text-red-400 uppercase tracking-widest mb-3">
                            Areas to Improve
                            </h4>
                            <ul className="text-sm text-charcoal dark:text-cream-200 space-y-2 list-none pl-0 font-sans">
                            {profile.weaknesses.map((w,i) => (
                                <li key={i} className="flex gap-3">
                                    <span className="text-red-500 font-bold">•</span>
                                    <span dangerouslySetInnerHTML={renderMarkdown(w.replace(/\*\*/g, ''))} />
                                </li>
                            ))}
                            </ul>
                    </div>
                </div>

                {/* 5. Attributes */}
                <div>
                    <h3 className="text-xs font-serif font-bold text-charcoal dark:text-white uppercase tracking-[0.2em] mb-6 border-b border-cream-300 dark:border-charcoal-border pb-2 inline-block">Technical Profile</h3>
                    <div className="space-y-8">
                        {Object.entries(categories).map(([category, list]) => (
                            <div key={category}>
                                    <h4 className="text-[10px] font-bold text-charcoal/50 dark:text-cream-400 uppercase tracking-widest mb-4">
                                    {category}
                                    </h4>
                                    <div className="space-y-4">
                                    {list.map(attr => (
                                        <AttributeLine 
                                            key={attr.key} 
                                            label={attr.label} 
                                            rating={(attrSource as any)[attr.key] || 0} 
                                        />
                                    ))}
                                    </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* 6. Latest Update */}
                <div className="bg-cream-50 dark:bg-charcoal-surface p-5 border-l-4 border-charcoal dark:border-cream-400 shadow-sm">
                    <h3 className="text-[10px] font-bold text-charcoal/50 dark:text-cream-400 uppercase tracking-widest mb-2">Latest Intelligence</h3>
                    <div className="text-xs text-charcoal dark:text-cream-200 leading-relaxed font-sans" dangerouslySetInnerHTML={renderMarkdown(profile.latestUpdate)} />
                </div>

                {/* Bottom Spacer */}
                <div className="h-10"></div>
            </div>
        </div>
    </>
  );
};
