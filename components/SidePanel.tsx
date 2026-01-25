import React, { useState, useEffect } from 'react';
import type { PlayerProfile } from '../types';
import { ATTRIBUTE_CATEGORIES, GK_ATTRIBUTE_CATEGORIES } from '../constants';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { ShareButton } from './ShareButton';
import { supabase } from '../services/geminiService';

interface SidePanelProps {
  isOpen: boolean;
  onClose: () => void;
  profile: PlayerProfile | null;
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

export const SidePanel: React.FC<SidePanelProps> = ({ isOpen, onClose, profile }) => {
  const [shareStatus, setShareStatus] = useState<'idle' | 'saving' | 'copied'>('idle');
  const [isDesktop, setIsDesktop] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  
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

  // Animation Trigger
  useEffect(() => {
    if (profile) {
        const timer = setTimeout(() => setIsVisible(true), 50);
        return () => clearTimeout(timer);
    } else {
        setIsVisible(false);
    }
  }, [profile]);

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
        const { data: savedRow, error } = await supabase
        .from('profiles')
        .insert([{ player_data: profile }])
        .select()
        .single();

        if (error) throw error;
        const shareUrl = `${window.location.origin}/#/player/${savedRow.id}`;
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

  if (!profile) return null;

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

                <div className="flex justify-between items-start px-8 pt-8 pb-4">
                    <div>
                        <h2 className="text-3xl font-serif font-bold text-charcoal dark:text-white leading-tight">{profile.basicInfo.name}</h2>
                        <p className="text-emerald-600 dark:text-emerald-400 font-serif italic text-lg leading-tight mt-1 mb-1">
                            {profile.playstyleAndRole?.playstyle?.archetype}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 mt-2 text-sm text-charcoal/60 dark:text-cream-400 font-sans">
                                <span className="font-semibold text-charcoal dark:text-cream-200">{formatPosition(profile.basicInfo.position)}</span>
                                <span className="w-px h-3 bg-charcoal/20 dark:bg-cream-400/20"></span>
                                <span>{profile.basicInfo.club}</span>
                                {profile.basicInfo.height && profile.basicInfo.height !== 'N/A' && (
                                    <>
                                        <span className="w-px h-3 bg-charcoal/20 dark:bg-cream-400/20"></span>
                                        <span>{profile.basicInfo.height}</span>
                                    </>
                                )}
                                {profile.basicInfo.weight && profile.basicInfo.weight !== 'N/A' && (
                                    <>
                                        <span className="w-px h-3 bg-charcoal/20 dark:bg-cream-400/20"></span>
                                        <span>{profile.basicInfo.weight}</span>
                                    </>
                                )}
                        </div>
                    </div>
                    
                    <div className="flex flex-col items-end text-right">
                            <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-widest mb-1">{getTierText(profile.ratings.overall)}</span>
                            <div className="flex gap-4">
                            <div className="flex flex-col items-center">
                                <span className={`text-3xl font-mono font-bold leading-none ${profile.ratings.overall >= 90 ? 'text-emerald-600 dark:text-emerald-400' : 'text-charcoal dark:text-white'}`}>{profile.ratings.overall}</span>
                                <span className="text-[9px] font-bold text-charcoal/40 dark:text-cream-400 uppercase tracking-wider mt-1">OVR</span>
                            </div>
                            <div className="flex flex-col items-center">
                                <span className="text-3xl font-mono font-bold leading-none text-charcoal/60 dark:text-cream-200">{profile.ratings.potential}</span>
                                <span className="text-[9px] font-bold text-charcoal/40 dark:text-cream-400 uppercase tracking-wider mt-1">POT</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Toolbar */}
                <div className="flex justify-between items-center px-6 pb-6">
                        <span className="text-[10px] uppercase tracking-widest text-charcoal/40 dark:text-cream-400/40 font-bold">Confidential Dossier</span>
                    <div className="flex gap-1">
                        <button onClick={handleShare} className="p-2 text-charcoal/60 dark:text-cream-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors" title="Share Profile">
                            <span className="material-symbols-outlined text-[20px]">{shareStatus === 'copied' ? 'check' : 'share'}</span>
                        </button>
                        <button onClick={onClose} className="p-2 text-charcoal/60 dark:text-cream-400 hover:text-red-500 transition-colors" title="Close">
                            <span className="material-symbols-outlined text-[20px]">close</span>
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
                        <div className="prose prose-sm dark:prose-invert leading-relaxed text-charcoal dark:text-cream-100 text-[15px] font-light text-justify" dangerouslySetInnerHTML={renderMarkdown(profile.shortBio)} />
                </div>

                {/* 2. Tactical Brief */}
                {profile.playstyleAndRole?.playstyle?.description && (
                     <div>
                         <h3 className="text-xs font-serif font-bold text-charcoal dark:text-white uppercase tracking-[0.2em] mb-4 border-b border-cream-300 dark:border-charcoal-border pb-2 inline-block">
                             <span className="flex items-center gap-2">Tactical Brief</span>
                         </h3>
                         <div className="prose prose-sm dark:prose-invert leading-relaxed text-charcoal dark:text-cream-100 text-[15px] font-light text-justify" dangerouslySetInnerHTML={renderMarkdown(profile.playstyleAndRole.playstyle.description)} />
                     </div>
                )}

                {/* 3. Best Roles */}
                {profile.playstyleAndRole?.bestRoles && profile.playstyleAndRole.bestRoles.length > 0 && (
                     <div>
                         <h3 className="text-xs font-serif font-bold text-charcoal dark:text-white uppercase tracking-[0.2em] mb-4 border-b border-cream-300 dark:border-charcoal-border pb-2 inline-block">Effective Roles</h3>
                         <div className="flex flex-wrap gap-2">
                             {profile.playstyleAndRole.bestRoles.map((role, idx) => (
                                 <span key={idx} className="px-3 py-1 bg-white dark:bg-charcoal-light border border-cream-300 dark:border-charcoal-border rounded-full text-xs font-bold text-charcoal/80 dark:text-cream-200">
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
                            <ul className="text-sm text-charcoal dark:text-cream-200 space-y-2 list-none pl-0">
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
                            <ul className="text-sm text-charcoal dark:text-cream-200 space-y-2 list-none pl-0">
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
                    <div className="text-xs text-charcoal dark:text-cream-200 leading-relaxed" dangerouslySetInnerHTML={renderMarkdown(profile.latestUpdate)} />
                </div>

                {/* Bottom Spacer */}
                <div className="h-10"></div>
            </div>
        </div>
    </>
  );
};