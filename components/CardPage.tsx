import React, { useEffect, useMemo, useState } from 'react';
import type { PlayerProfile } from '../types';
import { ATTRIBUTE_CATEGORIES, GK_ATTRIBUTE_CATEGORIES } from '../constants';
import { getShortTierLabel, positionCodes } from '../constants/ratingTiers';
import { latestUpdateLabel } from './pills';
import { AttributeLine, CardSectionTitle, renderCardMarkdown } from './cardParts';
import { parsePath } from '../services/cardPaths';
import { cardEdition, getDossierEvaluationDate } from '../services/dossierCards';
import { resolveCardPage, storeReads, type CardPage as ResolvedCardPage, type ShareReads } from '../services/sharePages';
import { cardTitle } from '../services/shareMeta';
import { starterQuestions } from '../services/starterQuestions';
import { EditionLabel, InkLabel } from './EditionLabel';
import { overallText, type EditionInk } from './hub/editionInk';

/**
 * A card's own page (`/p/<player>…`): the card at page width with the player's other versions
 * above it, and beside it (below the header on a phone) starter questions, a box to ask your own,
 * the rating history, and Save, Share and Scout. Resolved through the same rules the server uses
 * for the page's tags, so the page and its preview always show the same card.
 */

interface CardPageProps {
  path: string;
  /** Goes to another address: `replace` for a redirect, so Back doesn't land on it again. */
  onNavigate: (path: string, options?: { replace?: boolean }) => void;
  /** Takes the card into a new conversation; with a question, sends it. */
  onAsk: (card: PlayerProfile, question?: string) => void;
  onSave: (card: PlayerProfile) => void;
  isSaved: (card: PlayerProfile) => boolean;
  /** Opens Scout, with a player's name when the page has one. */
  onScout: (name?: string) => void;
  onOpenLibrary: () => void;
  reads?: ShareReads;
}

/** Playfair's default figures are old-style (a 9 drops below the line); ratings use lining figures. */
const LINING: React.CSSProperties = { fontVariantNumeric: 'lining-nums tabular-nums' };

const fmtDay = (iso: string | null | undefined): string =>
  iso
    ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    : '';

const fmtMonth = (iso: string): string =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

const unslug = (slug: string): string =>
  slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** When the shared card was rated: a current card's evaluation date, else when it was last rated. */
function ratedOn(card: PlayerProfile): string | null {
  if (cardEdition(card) === 'current') return getDossierEvaluationDate(card);
  const at = card.rerateAt || card.createdAt;
  return at ? new Date(at).toISOString().slice(0, 10) : getDossierEvaluationDate(card);
}

const Icon: React.FC<{ name: string; className?: string }> = ({ name, className = 'text-[18px]' }) => (
  <span className={`material-symbols-outlined leading-none ${className}`} aria-hidden="true">
    {name}
  </span>
);

/**
 * The card's masthead, set like the hub's: no box and no colour bar, just the edition, the name in
 * display serif, the archetype, and the Overall as the page's one large numeral in its tier's
 * colour. A hairline closes it, and the facts sit under it as a quiet row.
 */
const CardHeader: React.FC<{ card: PlayerProfile }> = ({ card }) => {
  const type = cardEdition(card);
  const { overall, potential } = card.ratings;
  const facts: Array<[string, string]> = [
    ['Position', positionCodes(card.basicInfo.position)],
    ['Club', card.basicInfo.club],
  ];
  if (card.basicInfo.nationality) facts.push(['Nation', card.basicInfo.nationality]);
  if (type === 'current' && card.basicInfo.age) facts.push(['Age', String(card.basicInfo.age)]);
  const rated = fmtDay(ratedOn(card));
  if (rated) facts.push(['Rated', rated]);

  return (
    <header className="px-1 @lg:px-2">
      <EditionLabel profile={card} size="md" />
      <div className="mt-4 flex items-end justify-between gap-5 @lg:gap-8">
        <div className="min-w-0 flex-1 pb-1">
          <h1 className="font-serif font-extrabold text-charcoal dark:text-cream-50 leading-[0.98] tracking-[-0.02em] text-[36px] @lg:text-[56px] [text-wrap:balance]">
            {card.basicInfo.name}
          </h1>
        </div>
        <div className="shrink-0 flex flex-col items-end text-right">
          <span
            className={`block font-serif font-extrabold leading-[0.8] tracking-[-0.04em] text-[72px] @lg:text-[112px] ${overallText(overall)}`}
            style={LINING}
          >
            {overall}
          </span>
          <span className="mt-3 text-[13px] @lg:text-[14px] font-medium leading-none text-charcoal/80 dark:text-cream-200 whitespace-nowrap">{getShortTierLabel(overall)}</span>
          {potential !== overall && (
            <span className="mt-1.5 text-[12.5px] leading-none text-charcoal/50 dark:text-cream-400/80">
              Potential <span className="font-semibold text-charcoal/75 dark:text-cream-200" style={LINING}>{potential}</span>
            </span>
          )}
        </div>
      </div>
      {card.playstyleAndRole?.playstyle?.archetype && (
        <p className="mt-3 font-serif italic text-emerald-700 dark:text-emerald-400 text-[17px] @lg:text-[22px] leading-snug [text-wrap:balance]">
          {card.playstyleAndRole.playstyle.archetype}
        </p>
      )}
      <dl className="mt-6 mb-4 py-5 border-y border-charcoal/[0.1] dark:border-white/[0.08] grid grid-cols-2 @lg:flex @lg:flex-wrap gap-y-4 gap-x-10">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[12px] text-charcoal/50 dark:text-cream-400/75">{label}</dt>
            <dd className="mt-0.5 text-[14.5px] font-medium text-charcoal dark:text-cream-100 truncate">{value}</dd>
          </div>
        ))}
      </dl>
    </header>
  );
};

const Traits: React.FC<{ title: string; items: string[]; tone: 'good' | 'bad' }> = ({ title, items, tone }) => (
  <div>
    <h4
      className={`font-serif font-bold text-[17px] mb-3 ${
        tone === 'good' ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'
      }`}
    >
      {title}
    </h4>
    <ul className="space-y-3 text-[14px] leading-relaxed text-charcoal/90 dark:text-cream-200 list-none pl-0">
      {items.map((line, i) => (
        <li key={i} className="flex gap-3">
          <span className={`font-bold ${tone === 'good' ? 'text-emerald-500' : 'text-red-500'}`}>•</span>
          <span className="[&_strong]:font-semibold [&_strong]:text-charcoal dark:[&_strong]:text-white [&_p]:m-0" dangerouslySetInnerHTML={renderCardMarkdown(line)} />
        </li>
      ))}
    </ul>
  </div>
);

const Prose: React.FC<{ text: string }> = ({ text }) => (
  <div
    className="text-[15px] leading-[1.75] font-light text-charcoal dark:text-cream-100 max-w-[68ch] [&_p]:mb-3 last:[&_p]:mb-0"
    dangerouslySetInnerHTML={renderCardMarkdown(text)}
  />
);

const CardSections: React.FC<{ card: PlayerProfile }> = ({ card }) => {
  const categories = card.goalkeeperAttributes ? GK_ATTRIBUTE_CATEGORIES : ATTRIBUTE_CATEGORIES;
  const attrs = (card.goalkeeperAttributes ?? card.attributes) as unknown as Record<string, number>;
  const update = latestUpdateLabel(card);
  return (
    <div className="space-y-10 px-1 @lg:px-2">
      {card.version?.peakContext && (
        <section>
          <CardSectionTitle>Peak Context</CardSectionTitle>
          <Prose text={card.version.peakContext} />
        </section>
      )}
      <section>
        <CardSectionTitle>Scout Summary</CardSectionTitle>
        <Prose text={card.shortBio} />
      </section>
      <section className="grid grid-cols-1 @2xl:grid-cols-2 gap-8 rounded-2xl border border-cream-300/70 dark:border-charcoal-border bg-white/50 dark:bg-charcoal-surface/50 p-5 @lg:p-6">
        <Traits title="Key Strengths" items={card.strengths ?? []} tone="good" />
        <Traits title="Areas to Improve" items={card.weaknesses ?? []} tone="bad" />
      </section>
      {card.playstyleAndRole?.playstyle?.description && (
        <section>
          <CardSectionTitle>Tactical Brief</CardSectionTitle>
          <Prose text={card.playstyleAndRole.playstyle.description} />
          {(card.playstyleAndRole.bestRoles?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-2 mt-5">
              {card.playstyleAndRole.bestRoles.map((role) => (
                <span
                  key={role}
                  className="px-3 py-1 bg-white dark:bg-charcoal-light border border-cream-300 dark:border-charcoal-border rounded-full text-xs font-bold text-charcoal/80 dark:text-cream-200"
                >
                  {role}
                </span>
              ))}
            </div>
          )}
        </section>
      )}
      <section>
        <CardSectionTitle className="mb-6">Technical Profile</CardSectionTitle>
        <div className="grid grid-cols-1 @xl:grid-cols-2 gap-x-10 gap-y-8">
          {Object.entries(categories).map(([category, list]) => (
            <div key={category}>
              <h4 className="text-[13px] font-medium text-charcoal/55 dark:text-cream-400/80 mb-4">{category}</h4>
              <div className="space-y-4">
                {list.map((a) => (
                  <AttributeLine key={a.key} label={a.label} rating={attrs?.[a.key] || 0} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
      {card.latestUpdate && (
        <section className="bg-cream-50 dark:bg-charcoal-surface p-5 rounded-xl border border-charcoal/[0.1] dark:border-white/[0.08]">
          <h3 className="font-serif font-bold text-[17px] text-charcoal dark:text-cream-50 mb-2">
            Latest Intelligence{update && <span className="font-sans font-normal text-[13px] text-charcoal/50 dark:text-cream-400/80"> · {update}</span>}
          </h3>
          <div className="text-[13px] text-charcoal dark:text-cream-200 leading-relaxed" dangerouslySetInnerHTML={renderCardMarkdown(card.latestUpdate)} />
        </section>
      )}
    </div>
  );
};

const AskBlock: React.FC<{ card: PlayerProfile; onAsk: CardPageProps['onAsk'] }> = ({ card, onAsk }) => {
  const [draft, setDraft] = useState('');
  const questions = useMemo(() => starterQuestions(card), [card]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = draft.trim();
    onAsk(card, q || undefined);
  };
  return (
    <section className="rounded-2xl border border-cream-300/80 dark:border-charcoal-border bg-white dark:bg-charcoal-surface shadow-paper p-5">
      <div className="flex items-center gap-2 mb-1">
        <Icon name="forum" className="text-[18px] text-emerald-600 dark:text-emerald-400" />
        <h2 className="font-serif font-bold text-[17px] text-charcoal dark:text-white">Ask About {card.basicInfo.name}</h2>
      </div>
      <p className="text-[12px] text-charcoal/55 dark:text-cream-400 mb-4">The analyst reads this card and argues from it.</p>
      <div className="space-y-2">
        {questions.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onAsk(card, q)}
            className="group w-full text-left flex items-start gap-2.5 rounded-xl border border-cream-300 dark:border-charcoal-border bg-cream-100/70 dark:bg-charcoal/60 hover:border-emerald-500/50 hover:bg-emerald-500/[0.05] px-3.5 py-2.5 text-[13px] leading-snug text-charcoal dark:text-cream-100 transition-colors"
          >
            <span className="flex-1">{q}</span>
            <Icon name="arrow_forward" className="text-[16px] text-charcoal/30 dark:text-cream-400/50 group-hover:text-emerald-600 mt-px" />
          </button>
        ))}
      </div>
      <form
        onSubmit={submit}
        className="mt-3 flex items-center gap-2 rounded-xl border border-cream-300 dark:border-charcoal-border bg-cream-50 dark:bg-charcoal pl-3.5 pr-1.5 py-1.5 focus-within:border-emerald-500/60"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask your own question…"
          aria-label={`Ask about ${card.basicInfo.name}`}
          className="flex-1 min-w-0 bg-transparent text-[13px] text-charcoal dark:text-cream-100 placeholder:text-charcoal/40 dark:placeholder:text-cream-400/60 outline-none"
        />
        <button
          type="submit"
          aria-label="Ask"
          className="size-8 shrink-0 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center transition-colors"
        >
          <Icon name="arrow_upward" />
        </button>
      </form>
    </section>
  );
};

const HistoryBlock: React.FC<{ page: Extract<ResolvedCardPage, { kind: 'card' }>; onNavigate: CardPageProps['onNavigate'] }> = ({ page, onNavigate }) => {
  const { card, history, banner } = page;
  const type = cardEdition(card);
  const evaluation = getDossierEvaluationDate(card);

  let body: React.ReactNode;
  if (type === 'current' && history.length > 0 && evaluation) {
    const rows = [{ date: evaluation, overall: card.ratings.overall, path: '', now: true }, ...history.map((h) => ({ ...h, now: false }))];
    const max = Math.max(...rows.map((r) => r.overall));
    const min = Math.min(...rows.map((r) => r.overall)) - 2;
    body = (
      <ol className="space-y-1">
        {rows.map((r, i) => {
          const prev = rows[i + 1];
          const diff = prev ? r.overall - prev.overall : 0;
          const inner = (
            <>
              <span className={`w-20 text-[12px] ${r.now ? 'font-semibold text-charcoal dark:text-white' : 'text-charcoal/60 dark:text-cream-400'}`}>{fmtMonth(r.date)}</span>
              <span className="flex-1 h-[3px] rounded-full bg-cream-300/70 dark:bg-charcoal-light">
                <span
                  className={`block h-full rounded-full ${r.now ? 'bg-emerald-500' : 'bg-charcoal/30 dark:bg-cream-400/40'}`}
                  style={{ width: `${max === min ? 100 : ((r.overall - min) / (max - min)) * 100}%` }}
                />
              </span>
              <span className={`font-mono font-bold text-sm w-6 text-right ${r.now ? 'text-emerald-600 dark:text-emerald-400' : 'text-charcoal/70 dark:text-cream-200'}`}>{r.overall}</span>
              <span
                className={`w-6 text-[10px] font-mono ${diff > 0 ? 'text-emerald-600 dark:text-emerald-400' : diff < 0 ? 'text-red-600 dark:text-red-400' : 'text-charcoal/30 dark:text-cream-400/40'}`}
              >
                {prev ? (diff > 0 ? `+${diff}` : diff < 0 ? diff : '=') : ''}
              </span>
            </>
          );
          return (
            <li key={r.date}>
              {r.now ? (
                <div className="flex items-center gap-3 px-2 py-1.5 -mx-2">{inner}</div>
              ) : (
                <button type="button" onClick={() => onNavigate(r.path)} className="w-full flex items-center gap-3 rounded-lg px-2 py-1.5 -mx-2 hover:bg-cream-200/60 dark:hover:bg-charcoal-light/40 text-left">
                  {inner}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    );
  } else if (type === 'current') {
    body = `This is ${card.basicInfo.name}'s first rating. Current form is re-rated every month, and each earlier rating stays here with its own link.`;
  } else if (type === 'era') {
    body = `An era card rates one chapter of a career, ${(card.version?.seasonOrEra ?? '').replace('-', '–')}. It doesn't change.`;
  } else if (type === 'season_snapshot') {
    body = 'A season card rates one season. It doesn’t change.';
  } else if (banner?.kind === 'superseded_prime') {
    body = 'This prime was later re-rated over a different window, so it no longer answers for the player’s prime. It stays here, with its own link, as a record.';
  } else {
    body = 'A prime rates the player at their best, over a window of up to three seasons. It’s fixed once rated.';
  }

  return (
    <section className="rounded-2xl border border-cream-300/80 dark:border-charcoal-border bg-white dark:bg-charcoal-surface shadow-paper p-5">
      <h2 className="font-serif font-bold text-[17px] text-charcoal dark:text-white mb-2">{type === 'current' ? 'Rating History' : 'About This Card'}</h2>
      {typeof body === 'string' ? <p className="text-[13px] leading-relaxed text-charcoal/70 dark:text-cream-300">{body}</p> : body}
    </section>
  );
};

const ActionButton: React.FC<{ icon: string; label: string; onClick: () => void; pressed?: boolean }> = ({ icon, label, onClick, pressed }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={pressed}
    className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-cream-300 dark:border-charcoal-border bg-white dark:bg-charcoal-surface px-3 py-2.5 text-[13px] font-medium text-charcoal dark:text-cream-100 hover:border-emerald-500/50 transition-colors"
  >
    <Icon name={icon} className="text-[17px]" />
    {label}
  </button>
);

const Actions: React.FC<{ card: PlayerProfile; canonical: string } & Pick<CardPageProps, 'onSave' | 'isSaved' | 'onScout'>> = ({ card, canonical, onSave, isSaved, onScout }) => {
  const [copied, setCopied] = useState(false);
  const saved = isSaved(card);
  const share = async () => {
    const url = `${window.location.origin}${canonical}`;
    try {
      if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title: cardTitle(card), url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the share sheet was dismissed */
    }
  };
  return (
    <div className="flex gap-2">
      <ActionButton icon={saved ? 'bookmark_added' : 'bookmark_add'} label={saved ? 'Saved' : 'Save'} onClick={() => onSave(card)} pressed={saved} />
      <ActionButton icon={copied ? 'check' : 'ios_share'} label={copied ? 'Copied' : 'Share'} onClick={share} />
      <ActionButton icon="person_search" label="Scout" onClick={() => onScout()} />
    </div>
  );
};

const VERSION_INK: Record<string, EditionInk> = { current: 'current', prime: 'prime', era: 'era', season_snapshot: 'season', season: 'season' };

/** The player's cards as a row of tabs, each in its edition's ink, the open one underlined. */
const VersionChips: React.FC<{ page: Extract<ResolvedCardPage, { kind: 'card' }>; onNavigate: CardPageProps['onNavigate'] }> = ({ page, onNavigate }) => {
  if (page.versions.length < 2) return null;
  return (
    <nav aria-label="His cards" className="-mx-1 flex items-stretch gap-1 overflow-x-auto scrollbar-hide border-b border-charcoal/[0.08] dark:border-white/[0.07]">
      {page.versions.map((v) => {
        const [name, when] = v.label.split(' · ');
        return (
          <button
            key={v.path}
            type="button"
            aria-current={v.current ? 'page' : undefined}
            onClick={() => !v.current && onNavigate(v.path)}
            className={`group relative shrink-0 flex items-center gap-3 px-3 pt-1.5 pb-3 rounded-t-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
              v.current ? '' : 'opacity-70 hover:opacity-100'
            }`}
          >
            <InkLabel ink={VERSION_INK[v.edition] ?? 'prime'} name={name} when={when} size="sm" />
            <span className="font-mono text-[13px] font-bold text-charcoal dark:text-cream-50 [font-variant-numeric:tabular-nums]">{v.overall}</span>
            <span
              aria-hidden="true"
              className={`absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-charcoal dark:bg-cream-50 origin-center transition-transform duration-300 ease-out-expo ${v.current ? 'scale-x-100' : 'scale-x-0'}`}
            />
          </button>
        );
      })}
    </nav>
  );
};

const Banner: React.FC<{ page: Extract<ResolvedCardPage, { kind: 'card' }>; onNavigate: CardPageProps['onNavigate'] }> = ({ page, onNavigate }) => {
  const { banner, card } = page;
  if (!banner) return null;
  if (banner.kind === 'superseded_prime') {
    const current = page.versions.find((v) => v.edition === 'prime');
    return (
      <div className="flex flex-col @lg:flex-row @lg:items-center gap-2 @lg:gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-4 py-3 text-sm text-charcoal dark:text-cream-100">
        <div className="flex items-start gap-3 flex-1">
          <Icon name="update" className="text-[20px] text-amber-600 dark:text-amber-300 mt-px" />
          <p>
            <span className="font-semibold">This prime was re-rated.</span> {card.basicInfo.name}'s prime is now rated
            {current ? ` over ${current.label.replace(/^Prime · /, '')}, at ${current.overall}` : ' over a different window'}. This is the earlier card, kept for the record.
          </p>
        </div>
        <button type="button" onClick={() => onNavigate(banner.to)} className="self-start @lg:self-auto shrink-0 font-semibold text-emerald-700 dark:text-emerald-400 hover:underline whitespace-nowrap">
          See the current prime →
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col @lg:flex-row @lg:items-center gap-2 @lg:gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-4 py-3 text-sm text-charcoal dark:text-cream-100">
      <div className="flex items-start gap-3 flex-1">
        <Icon name="directions_run" className="text-[20px] text-emerald-600 dark:text-emerald-400 mt-px" />
        <p>
          <span className="font-semibold">Still playing.</span> This prime was rated{banner.ratedOn ? ` on ${fmtDay(banner.ratedOn)}` : ''}; {card.basicInfo.name}'s current form has its own card.
        </p>
      </div>
      <button type="button" onClick={() => onNavigate(banner.currentPath)} className="self-start @lg:self-auto shrink-0 font-semibold text-emerald-700 dark:text-emerald-400 hover:underline whitespace-nowrap">
        Current form →
      </button>
    </div>
  );
};

const NotFound: React.FC<{ player: string; onScout: CardPageProps['onScout']; onOpenLibrary: () => void }> = ({ player, onScout, onOpenLibrary }) => {
  const name = unslug(player);
  return (
    <div className="max-w-xl mx-auto px-5 py-16 @lg:py-24 text-center">
      <div className="mx-auto mb-6 size-14 rounded-full border border-cream-300 dark:border-charcoal-border bg-white dark:bg-charcoal-surface flex items-center justify-center">
        <Icon name="person_search" className="text-[26px] text-emerald-600 dark:text-emerald-400" />
      </div>
      <p className="text-[10px] font-bold uppercase tracking-widest text-charcoal/45 dark:text-cream-400 mb-3">Not Rated Yet</p>
      <h1 className="font-serif font-bold text-[32px] @lg:text-[40px] leading-tight text-charcoal dark:text-white">{name}</h1>
      <p className="mt-4 text-[15px] leading-relaxed text-charcoal/70 dark:text-cream-300">
        Nobody has scouted {name} yet. Scout them and the card joins the library everyone shares, on the same all-time scale as every other player.
      </p>
      <div className="mt-8 flex flex-col @sm:flex-row gap-3 justify-center">
        <button type="button" onClick={() => onScout(name)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 px-5 py-3 text-sm font-semibold text-white">
          <Icon name="person_search" />
          Scout {name}
        </button>
        <button
          type="button"
          onClick={onOpenLibrary}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-cream-300 dark:border-charcoal-border bg-white dark:bg-charcoal-surface px-5 py-3 text-sm font-medium text-charcoal dark:text-cream-100"
        >
          <Icon name="grid_view" />
          Browse the library
        </button>
      </div>
    </div>
  );
};

export const CardPage: React.FC<CardPageProps> = ({ path, onNavigate, onAsk, onSave, isSaved, onScout, onOpenLibrary, reads }) => {
  const [page, setPage] = useState<ResolvedCardPage | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const parsed = parsePath(path);
    if (!parsed || parsed.kind !== 'card') {
      setPage({ kind: 'not_found', player: path.split('/')[2] ?? '' });
      setLoadedPath(path);
      return;
    }
    resolveCardPage(parsed.address, reads ?? storeReads()).then((result) => {
      if (cancelled) return;
      if (result.kind === 'redirect') {
        onNavigate(result.to, { replace: true });
        return;
      }
      setPage(result);
      setLoadedPath(path);
    });
    return () => {
      cancelled = true;
    };
    // onNavigate is stable enough; the page reloads when the address changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reads, attempt]);

  // The tab's title follows the card, as the server's tags do for a fresh load.
  useEffect(() => {
    if (page?.kind !== 'card') return;
    document.title = cardTitle(page.card);
    return () => {
      // A page opened straight from a link started with the card's title, so leave the app's own.
      document.title = 'Futbolpedia';
    };
  }, [page]);

  // A new card starts at the top.
  useEffect(() => {
    document.getElementById('card-page-scroll')?.scrollTo({ top: 0 });
  }, [loadedPath]);

  const loading = !page || loadedPath !== path;

  return (
    <div id="card-page-scroll" className="@container h-full overflow-y-auto bg-cream-100 dark:bg-charcoal">
      {loading ? (
        <div className="mx-auto max-w-[1180px] px-4 @lg:px-8 py-10" aria-busy="true">
          <div className="h-48 rounded-2xl bg-cream-200/80 dark:bg-charcoal-surface animate-pulse" />
          <div className="mt-8 space-y-3 max-w-[68ch]">
            {[92, 100, 86, 95, 70].map((w) => (
              <div key={w} className="h-3 rounded bg-cream-200/80 dark:bg-charcoal-surface animate-pulse" style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
      ) : page.kind === 'not_found' ? (
        <NotFound player={page.player} onScout={onScout} onOpenLibrary={onOpenLibrary} />
      ) : page.kind === 'unavailable' ? (
        <div className="max-w-xl mx-auto px-5 py-24 text-center">
          <h1 className="font-serif font-bold text-[28px] text-charcoal dark:text-white">The Library Can't Be Reached</h1>
          <p className="mt-3 text-[15px] text-charcoal/70 dark:text-cream-300">This card couldn't be loaded just now. Try again in a moment.</p>
          <button type="button" onClick={() => {
              setLoadedPath(null);
              setAttempt((n) => n + 1);
            }} className="mt-6 rounded-xl border border-cream-300 dark:border-charcoal-border px-5 py-2.5 text-sm font-medium">
            Try again
          </button>
        </div>
      ) : page.kind === 'card' ? (
        <main className="mx-auto max-w-[1180px] px-4 @lg:px-8 py-6 @lg:py-10 pb-[calc(2.5rem+env(safe-area-inset-bottom))]">
          <div className="mb-5 empty:hidden">
            <VersionChips page={page} onNavigate={onNavigate} />
          </div>
          <div className="grid grid-cols-1 @5xl:grid-cols-[minmax(0,1fr)_340px] gap-6 @5xl:gap-10 items-start">
            <div className="space-y-6 min-w-0">
              <Banner page={page} onNavigate={onNavigate} />
              <CardHeader card={page.card} />
              <div className="@5xl:hidden">
                <AskBlock card={page.card} onAsk={onAsk} />
              </div>
              <CardSections card={page.card} />
              <div className="@5xl:hidden space-y-4">
                <HistoryBlock page={page} onNavigate={onNavigate} />
                <Actions card={page.card} canonical={page.canonical} onSave={onSave} isSaved={isSaved} onScout={onScout} />
              </div>
            </div>
            <aside className="hidden @5xl:block sticky top-6 space-y-4">
              <AskBlock card={page.card} onAsk={onAsk} />
              <HistoryBlock page={page} onNavigate={onNavigate} />
              <Actions card={page.card} canonical={page.canonical} onSave={onSave} isSaved={isSaved} onScout={onScout} />
            </aside>
          </div>
        </main>
      ) : null}
    </div>
  );
};
