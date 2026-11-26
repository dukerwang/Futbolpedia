import React, { useEffect, useState } from 'react';
import type { PlayerProfile } from '../../types';
import { cardPath } from '../../services/cardPaths';
import { getCardKey, isPrimeCard } from '../../services/dossierCards';
import { shareDossierCard, type GlobalHubDossierItem } from '../../services/dossierCache';
import { getAttributeLabel, getShortTierLabel, positionCodes } from '../../constants/ratingTiers';
import { ActionMenu } from './Menu';
import { attributeBarFill, editionInkOf, INK_TEXT, INK_WASH, overallText, shortEditionLabel } from './editionInk';
import { EditionLabel, RevisionNote } from '../EditionLabel';

/** One entry of the hub, drawn as a card (grid) or a ranked row (list). */
export interface HubEntryProps {
  item: GlobalHubDossierItem;
  tab: 'global' | 'mine';
  /** Position in the current order, shown in the list when the order is by rating. */
  rank?: number;
  isSelected: boolean;
  isSaved: boolean;
  /** The player's other cards in this tab, in version order. */
  otherVersions: PlayerProfile[];
  /** Entrance order, for the staggered rise; undefined skips the entrance (offscreen entries). */
  enterIndex?: number;
  /** False when a section heading already names the tier. */
  showTier?: boolean;
  onOpen: () => void;
  onOpenVersion: (profile: PlayerProfile) => void;
  onShowAllVersions: () => void;
  onAsk: () => void;
  onRename?: (newName: string) => void;
  onDelete?: () => void;
}

const MAX_VERSION_LINKS = 2;
/** Attribute bars start at this value, so the differences between good and great are visible. */
const BAR_FLOOR = 50;
const barWidth = (value: number) => `${Math.max(3, Math.min(100, ((value - BAR_FLOOR) / (100 - BAR_FLOOR)) * 100))}%`;
const STAGGER_MS = 32;

const attributeValue = (profile: PlayerProfile, key: string): number | undefined => {
  const value =
    (profile.attributes as unknown as Record<string, number> | undefined)?.[key] ??
    (profile.goalkeeperAttributes as unknown as Record<string, number> | undefined)?.[key];
  return typeof value === 'number' ? value : undefined;
};

/**
 * The card's three signature attributes with their values: the ones the scout named, else the
 * three highest (a goalkeeper's from his goalkeeping set).
 */
export const signatureAttributes = (profile: PlayerProfile): Array<{ key: string; label: string; value: number }> => {
  const named = (profile.signatureSpikes ?? [])
    .map((key) => ({ key, label: getAttributeLabel(key), value: attributeValue(profile, key) }))
    .filter((a): a is { key: string; label: string; value: number } => typeof a.value === 'number');
  if (named.length >= 3) return named.slice(0, 3);
  const pool = (profile.goalkeeperAttributes ?? profile.attributes) as unknown as Record<string, number> | undefined;
  const ranked = Object.entries(pool ?? {})
    .filter(([key, value]) => typeof value === 'number' && !named.some((n) => n.key === key))
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ key, label: getAttributeLabel(key), value }));
  return [...named, ...ranked].slice(0, 3);
};

/** Share, rename and remove, shared by both shapes of an entry. */
const useEntryActions = (profile: PlayerProfile, onRename?: (name: string) => void) => {
  const [shareState, setShareState] = useState<'idle' | 'saving' | 'copied'>('idle');
  const [isEditing, setIsEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  useEffect(() => {
    if (shareState !== 'copied') return;
    const timer = setTimeout(() => setShareState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [shareState]);

  const share = async () => {
    if (shareState === 'saving') return;
    setShareState('saving');
    try {
      const slug = await shareDossierCard(profile);
      const path = profile.revision ? null : cardPath(profile);
      await navigator.clipboard.writeText(`${window.location.origin}${path ?? `/#/p/${slug}`}`);
      setShareState('copied');
    } catch (err) {
      console.error('Share failed:', err);
      setShareState('idle');
      if (err instanceof Error) window.alert(err.message);
    }
  };

  const startRename = () => {
    setNameDraft(profile.basicInfo.name);
    setIsEditing(true);
  };
  const saveRename = (e: React.FormEvent) => {
    e.preventDefault();
    if (nameDraft.trim() && onRename) onRename(nameDraft.trim());
    setIsEditing(false);
  };

  return { shareState, share, isEditing, setIsEditing, nameDraft, setNameDraft, startRename, saveRename };
};

const menuItems = (shareState: string, canEdit: boolean) => [
  { id: 'share', label: shareState === 'copied' ? 'Link copied' : 'Copy link', icon: shareState === 'copied' ? 'check' : 'link' },
  ...(canEdit
    ? [
        { id: 'rename', label: 'Rename', icon: 'edit' },
        { id: 'delete', label: 'Remove from your dossiers', icon: 'delete', tone: 'danger' as const },
      ]
    : []),
];

const EditionMark: React.FC<{ profile: PlayerProfile; earlierRating: boolean; compact?: boolean }> = ({ profile, earlierRating, compact }) =>
  compact ? (
    <EditionLabel profile={profile} earlierRating={earlierRating} size="xs" compact />
  ) : (
    <EditionLabel profile={profile} earlierRating={earlierRating} size="sm" />
  );

const Trajectory: React.FC<{ diff?: number; since?: string }> = ({ diff, since }) => {
  if (typeof diff !== 'number' || diff === 0) return null;
  const up = diff > 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 font-mono text-[11px] font-medium ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}
      title={since ? `Since the ${since} rating` : 'Since the previous rating'}
    >
      <span aria-hidden="true" className="material-symbols-outlined text-[14px]">
        {up ? 'arrow_upward' : 'arrow_downward'}
      </span>
      {Math.abs(diff)}
    </span>
  );
};

const RenameForm: React.FC<{
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  size: 'card' | 'row';
}> = ({ value, onChange, onSubmit, onCancel, size }) => (
  <form onSubmit={onSubmit} onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      onBlur={onCancel}
      autoFocus
      aria-label="Dossier name"
      className={`min-w-0 flex-1 px-2 py-0.5 font-serif font-bold bg-transparent border-b-2 border-emerald-500 text-charcoal dark:text-cream-50 focus:outline-none ${
        size === 'card' ? 'text-[22px]' : 'text-base'
      }`}
    />
  </form>
);

const VersionLinks: React.FC<{ versions: PlayerProfile[]; onOpen: (p: PlayerProfile) => void; onMore: () => void }> = ({ versions, onOpen, onMore }) => {
  if (versions.length === 0) return null;
  return (
    <div className="flex items-center gap-3 min-w-0 text-[12px] font-sans">
      {versions.slice(0, MAX_VERSION_LINKS).map((version) => {
        const ink = editionInkOf(version);
        return (
          <button
            key={getCardKey(version)}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(version);
            }}
            className="group/v inline-flex items-baseline gap-1.5 min-w-0 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            title={`Open his ${shortEditionLabel(version).toLowerCase()} card`}
          >
            <span className={`truncate max-w-[7.5rem] ${INK_TEXT[ink]} underline decoration-transparent underline-offset-[3px] group-hover/v:decoration-current transition-[text-decoration-color] duration-150`}>
              {shortEditionLabel(version)}
            </span>
            <span className="font-mono text-[12px] font-bold text-charcoal/80 dark:text-cream-200">{version.ratings.overall}</span>
          </button>
        );
      })}
      {versions.length > MAX_VERSION_LINKS && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onMore();
          }}
          className="shrink-0 text-charcoal/45 dark:text-cream-400/70 hover:text-charcoal dark:hover:text-cream-50 transition-colors"
          title="Show all his cards"
        >
          +{versions.length - MAX_VERSION_LINKS}
        </button>
      )}
    </div>
  );
};

const enterStyle = (enterIndex?: number): React.CSSProperties | undefined =>
  enterIndex === undefined ? undefined : { animationDelay: `${enterIndex * STAGGER_MS}ms` };

const handleKeyOpen = (isEditing: boolean, onOpen: () => void) => (e: React.KeyboardEvent) => {
  if (!isEditing && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    onOpen();
  }
};

/** The grid's collectible card: the Overall set large beside its tier and edition, then the player, then his three best attributes. */
export const HubCard: React.FC<HubEntryProps> = (props) => {
  const { item, tab, isSelected, isSaved, otherVersions, enterIndex, showTier = true, onOpen, onOpenVersion, onShowAllVersions, onAsk, onRename, onDelete } = props;
  const { profile, isCurrentRating, trajectoryDiff, previousRatingDate } = item;
  const actions = useEntryActions(profile, onRename);
  const earlierRating = tab === 'global' && !isCurrentRating && !isPrimeCard(profile);
  const attrs = signatureAttributes(profile);
  const archetype = profile.playstyleAndRole?.playstyle?.archetype;
  const position = positionCodes(profile.basicInfo.position);

  const onMenu = (id: string) => {
    if (id === 'share') actions.share();
    else if (id === 'rename') actions.startRename();
    else if (id === 'delete') onDelete?.();
  };

  return (
    <article
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={`${profile.basicInfo.name}, ${profile.ratings.overall}`}
      onClick={() => !actions.isEditing && onOpen()}
      onKeyDown={handleKeyOpen(actions.isEditing, onOpen)}
      style={enterStyle(enterIndex)}
      className={`hub-entry group relative flex flex-col rounded-[14px] bg-cream-50 dark:bg-charcoal-surface border cursor-pointer select-none shadow-card dark:shadow-none transition-[transform,box-shadow,border-color] duration-300 ease-out-expo active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-cream-200 dark:focus-visible:ring-offset-charcoal ${
        enterIndex !== undefined ? 'motion-safe:animate-rise-in' : ''
      } ${
        isSelected
          ? 'border-emerald-500/70 ring-1 ring-emerald-500/30'
          : 'border-charcoal/[0.07] dark:border-white/[0.06] can-hover:hover:-translate-y-[3px] can-hover:hover:shadow-lift dark:can-hover:hover:shadow-lift-dark can-hover:hover:border-charcoal/[0.14] dark:can-hover:hover:border-white/[0.12]'
      }`}
    >
      <span aria-hidden="true" className={`pointer-events-none absolute inset-x-0 top-0 h-32 rounded-t-[14px] ${INK_WASH[earlierRating ? 'older' : editionInkOf(profile)]}`} />
      <div className="relative px-5 pt-5">
        <div className="flex items-start gap-4">
          <span className={`font-serif font-extrabold text-[46px] leading-[0.82] tracking-[-0.03em] ${overallText(profile.ratings.overall)} [font-variant-numeric:lining-nums_tabular-nums]`}>
            {profile.ratings.overall}
          </span>
          <div className="min-w-0 flex-1 flex flex-col gap-1.5 pt-0.5">
            <span className="flex items-center justify-between gap-2">
              {showTier ? (
                <span className="truncate text-[10.5px] font-sans font-semibold uppercase tracking-[0.14em] text-charcoal/50 dark:text-cream-400/80">
                  {getShortTierLabel(profile.ratings.overall)}
                </span>
              ) : (
                <span className="truncate text-[12px] font-sans font-semibold tracking-[0.04em] text-charcoal/80 dark:text-cream-200">{position || '—'}</span>
              )}
              <Trajectory diff={trajectoryDiff} since={previousRatingDate} />
            </span>
            <span className="flex items-center gap-2 text-[12px] font-sans min-w-0">
              <EditionMark profile={profile} earlierRating={earlierRating} />
              {profile.revision && (
                <RevisionNote />
              )}
            </span>
          </div>
        </div>

        <div className="mt-5">
          {actions.isEditing ? (
            <RenameForm
              value={actions.nameDraft}
              onChange={actions.setNameDraft}
              onSubmit={actions.saveRename}
              onCancel={() => actions.setIsEditing(false)}
              size="card"
            />
          ) : (
            <h3 className="font-serif font-bold text-[22px] leading-[1.15] tracking-[-0.012em] text-charcoal dark:text-cream-50 line-clamp-2 [text-wrap:balance]">
              {profile.basicInfo.name}
            </h3>
          )}
          {archetype && (
            <p className="mt-1 font-serif italic text-[14px] leading-snug text-emerald-700 dark:text-emerald-400 line-clamp-1">{archetype}</p>
          )}
          <p className="mt-2.5 flex items-center gap-2 text-[12px] font-sans text-charcoal/55 dark:text-cream-400/80 min-w-0">
            {showTier && position && <span className="shrink-0 font-semibold text-charcoal/80 dark:text-cream-200 tracking-wide">{position}</span>}
            <span className="truncate">{[profile.basicInfo.club, profile.basicInfo.nationality].filter(Boolean).join(', ')}</span>
          </p>
        </div>
      </div>

      {attrs.length > 0 && (
        <dl className="mt-5 px-5 grid gap-2">
          {attrs.map((a, i) => (
            <div key={a.key} className="grid grid-cols-[minmax(0,1fr)_4.5rem_1.75rem] items-center gap-3">
              <dt className="truncate text-[12px] font-sans text-charcoal/65 dark:text-cream-300/80">{a.label}</dt>
              <span aria-hidden="true" className="relative h-[3px] rounded-full bg-charcoal/[0.07] dark:bg-white/[0.08] overflow-hidden">
                <span
                  className={`absolute inset-y-0 left-0 rounded-full origin-left ${attributeBarFill(a.value)} ${
                    enterIndex !== undefined ? 'motion-safe:animate-bar-grow' : ''
                  }`}
                  style={{
                    width: barWidth(a.value),
                    animationDelay: enterIndex !== undefined ? `${enterIndex * STAGGER_MS + 180 + i * 60}ms` : undefined,
                  }}
                />
              </span>
              <dd className="text-right font-mono text-[12px] font-bold text-charcoal dark:text-cream-50 [font-variant-numeric:tabular-nums]">{a.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-auto pt-5">
        <div className="mx-5 border-t border-charcoal/[0.07] dark:border-white/[0.06]" />
        <div className="flex items-center gap-2 pl-5 pr-2.5 py-2 min-h-[48px]">
          <div className="min-w-0 flex-1">
            {otherVersions.length > 0 ? (
              <VersionLinks versions={otherVersions} onOpen={onOpenVersion} onMore={onShowAllVersions} />
            ) : tab === 'global' && isSaved ? (
              <span className="inline-flex items-center gap-1 text-[12px] text-charcoal/45 dark:text-cream-400/70" title="In your dossiers">
                <span aria-hidden="true" className="material-symbols-outlined text-[15px]">bookmark_added</span>
                Saved
              </span>
            ) : null}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAsk();
            }}
            className="shrink-0 inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[12.5px] font-sans font-medium text-charcoal/70 dark:text-cream-300 hover:text-charcoal dark:hover:text-cream-50 hover:bg-charcoal/[0.05] dark:hover:bg-white/[0.06] transition-[background-color,color,transform] duration-150 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            title={`Ask about ${profile.basicInfo.name} in chat`}
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[17px]">chat_bubble</span>
            Ask
          </button>
          <ActionMenu label={`More for ${profile.basicInfo.name}`} items={menuItems(actions.shareState, !!onRename)} onAction={onMenu} />
        </div>
      </div>
    </article>
  );
};

/** The list's ranked row: rank, Overall, the player and his version, and where he plays. */
export const HubRow: React.FC<HubEntryProps> = (props) => {
  const { item, tab, rank, isSelected, otherVersions, enterIndex, onOpen, onOpenVersion, onShowAllVersions, onAsk, onRename, onDelete } = props;
  const { profile, isCurrentRating, trajectoryDiff, previousRatingDate } = item;
  const actions = useEntryActions(profile, onRename);
  const earlierRating = tab === 'global' && !isCurrentRating && !isPrimeCard(profile);
  const archetype = profile.playstyleAndRole?.playstyle?.archetype;
  const position = positionCodes(profile.basicInfo.position);
  const attrs = signatureAttributes(profile);

  const onMenu = (id: string) => {
    if (id === 'ask') onAsk();
    else if (id === 'share') actions.share();
    else if (id === 'rename') actions.startRename();
    else if (id === 'delete') onDelete?.();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={`${rank ? `${rank}. ` : ''}${profile.basicInfo.name}, ${profile.ratings.overall}`}
      onClick={() => !actions.isEditing && onOpen()}
      onKeyDown={handleKeyOpen(actions.isEditing, onOpen)}
      style={enterStyle(enterIndex)}
      className={`hub-entry group relative grid items-center gap-x-3 md:gap-x-5 pl-2 pr-1 md:px-3 py-3 cursor-pointer select-none rounded-xl transition-[background-color,transform] duration-200 active:scale-[0.995] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 ${
        rank ? 'grid-cols-[1.5rem_2.75rem_minmax(0,1fr)_auto]' : 'grid-cols-[2.75rem_minmax(0,1fr)_auto]'
      } ${
        rank
          ? 'lg:grid-cols-[2rem_3.25rem_minmax(0,2.4fr)_minmax(0,1.3fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_auto]'
          : 'lg:grid-cols-[3.25rem_minmax(0,2.4fr)_minmax(0,1.3fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_auto]'
      } ${enterIndex !== undefined ? 'motion-safe:animate-rise-in' : ''} ${
        isSelected ? 'bg-emerald-500/[0.08]' : 'can-hover:hover:bg-charcoal/[0.035] dark:can-hover:hover:bg-white/[0.035]'
      }`}
    >
      {rank !== undefined && (
        <span className="text-right font-mono text-[11px] text-charcoal/35 dark:text-cream-400/50 [font-variant-numeric:tabular-nums]">{rank}</span>
      )}
      <span className={`font-serif font-extrabold text-[28px] md:text-[30px] leading-none tracking-[-0.03em] ${overallText(profile.ratings.overall)} [font-variant-numeric:lining-nums_tabular-nums]`}>
        {profile.ratings.overall}
      </span>

      <div className="min-w-0">
        {actions.isEditing ? (
          <RenameForm
            value={actions.nameDraft}
            onChange={actions.setNameDraft}
            onSubmit={actions.saveRename}
            onCancel={() => actions.setIsEditing(false)}
            size="row"
          />
        ) : (
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="truncate font-serif font-bold text-[16.5px] leading-tight text-charcoal dark:text-cream-50">{profile.basicInfo.name}</span>
            <Trajectory diff={trajectoryDiff} since={previousRatingDate} />
          </div>
        )}
        {/* Phones and tablets read the version and club here; wide screens give them columns. */}
        <div className="lg:hidden mt-1 flex items-center gap-2 text-[12px] font-sans min-w-0">
          <EditionMark profile={profile} earlierRating={earlierRating} compact />
          <span className="truncate text-charcoal/50 dark:text-cream-400/70">{[position, profile.basicInfo.club].filter(Boolean).join(' · ')}</span>
        </div>
        {archetype && (
          <p className="hidden lg:block mt-0.5 truncate font-serif italic text-[13px] text-emerald-700 dark:text-emerald-400">{archetype}</p>
        )}
      </div>

      <div className="hidden lg:flex flex-col gap-0.5 min-w-0 text-[12.5px] font-sans">
        <EditionMark profile={profile} earlierRating={earlierRating} />
        {otherVersions.length > 0 && (
          <div className="pl-3">
            <VersionLinks versions={otherVersions} onOpen={onOpenVersion} onMore={onShowAllVersions} />
          </div>
        )}
      </div>

      <div className="hidden lg:block min-w-0 text-[12.5px] font-sans">
        <p className="truncate text-charcoal/80 dark:text-cream-200">
          {position && <span className="font-semibold tracking-wide mr-2">{position}</span>}
          {profile.basicInfo.club}
        </p>
        <p className="truncate text-charcoal/45 dark:text-cream-400/70">{profile.basicInfo.nationality}</p>
      </div>

      <div className="hidden lg:block min-w-0 text-[12px] font-sans text-charcoal/55 dark:text-cream-400/80">
        {attrs.slice(0, 2).map((a) => (
          <p key={a.key} className="flex items-baseline justify-between gap-3">
            <span className="truncate">{a.label}</span>
            <span className="font-mono font-bold text-charcoal/80 dark:text-cream-200">{a.value}</span>
          </p>
        ))}
      </div>

      <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onAsk}
          className="hidden md:inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-[12.5px] font-medium text-charcoal/70 dark:text-cream-300 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-charcoal/[0.05] dark:hover:bg-white/[0.06] transition-[opacity,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
          title={`Ask about ${profile.basicInfo.name} in chat`}
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[17px]">chat_bubble</span>
          Ask
        </button>
        <ActionMenu
          label={`More for ${profile.basicInfo.name}`}
          items={[{ id: 'ask', label: 'Ask in chat', icon: 'chat_bubble' }, ...menuItems(actions.shareState, !!onRename)]}
          onAction={onMenu}
        />
      </div>
    </div>
  );
};
