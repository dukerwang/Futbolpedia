import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerProfile } from '../types';
import { fetchCardIndex } from '../services/dossierCache';
import { cardEdition, toBasePlayerSlug } from '../services/dossierCards';
import { getShortTierLabel } from '../constants/ratingTiers';
import { describeCardEdition } from './pills';
import { GaffaMark, GaffaWordmark, GAFFA_PUBLIC_URL } from './GaffaClubChip';
import { markWelcomeSeen } from './welcomeSeen';
import { overallText } from './hub/editionInk';

/**
 * The first-visit walkthrough: what Futbolpedia is, how to read a rating, how to use Scout, the
 * shared library, the analyst, and Gaffa. Shown once, and again from the header's guide button.
 */


interface WelcomeWalkthroughProps {
  open: boolean;
  onClose: () => void;
  /** The last step's main button: into the chat. */
  onStartTalking: () => void;
  /** The last step's second button: Scout. */
  onRatePlayer: () => void;
}

/** Playfair's default figures are old-style; ratings use lining figures. */
const LINING: React.CSSProperties = { fontVariantNumeric: 'lining-nums tabular-nums' };

type Tone = 'emerald' | 'amber' | 'blue';

interface Showcase {
  name: string;
  archetype: string;
  edition: 'current' | 'prime' | 'era';
  label: string;
  overall: number;
  tone: Tone;
  icon: string;
}

/**
 * The cards the walkthrough shows. Their numbers and labels are refreshed from the shared library
 * when it answers, so the walkthrough never shows a rating the library has since changed.
 */
const SHOWCASE: Showcase[] = [
  { name: 'Kaká', archetype: 'Vertical Transition Conductor', edition: 'prime', label: 'Prime · 2005–07', overall: 96, tone: 'amber', icon: 'workspace_premium' },
  { name: 'Bukayo Saka', archetype: 'Inverted Playmaking Inside Forward', edition: 'current', label: 'Current form · Nov 2026', overall: 90, tone: 'emerald', icon: 'bolt' },
  { name: 'Edin Džeko', archetype: 'Complete Focal Target Forward', edition: 'era', label: 'Manchester City era · 2011–14', overall: 86, tone: 'blue', icon: 'auto_stories' },
];
const DEBATE = [
  { name: 'Thierry Henry', overall: 96 },
  { name: 'Alan Shearer', overall: 94 },
];

function useShowcase(open: boolean): { cards: Showcase[]; debate: typeof DEBATE } {
  const [index, setIndex] = useState<PlayerProfile[]>([]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchCardIndex()
      .then((cards) => live && setIndex(cards))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open]);
  return useMemo(() => {
    const find = (name: string, edition: string) =>
      index.find((c) => toBasePlayerSlug(c.basicInfo?.name ?? '') === toBasePlayerSlug(name) && cardEdition(c) === edition);
    const cards = SHOWCASE.map((s) => {
      const card = find(s.name, s.edition);
      return card?.ratings?.overall ? { ...s, overall: card.ratings.overall, label: describeCardEdition(card).label } : s;
    });
    const debate = DEBATE.map((d) => {
      const card = find(d.name, 'prime');
      return card?.ratings?.overall ? { ...d, overall: card.ratings.overall } : d;
    });
    return { cards, debate };
  }, [index]);
}

const Icon: React.FC<{ name: string; className?: string }> = ({ name, className = 'text-[18px]' }) => (
  <span className={`material-symbols-outlined leading-none ${className}`} aria-hidden="true">
    {name}
  </span>
);

/** The version in a word, for tiles three across. */
const TINY_LABEL: Record<Showcase['edition'], string> = { current: 'Current form', prime: 'Prime', era: 'Era' };

const TONE_PILL: Record<Tone, string> = {
  emerald: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25',
  amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25',
  blue: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/25',
};
const TONE_TEXT: Record<Tone, string> = {
  emerald: 'text-emerald-700 dark:text-emerald-300',
  amber: 'text-amber-700 dark:text-amber-300',
  blue: 'text-blue-700 dark:text-blue-300',
};
const TONE_ACCENT: Record<Tone, string> = {
  emerald: 'from-emerald-500 via-teal-500 to-emerald-600',
  amber: 'from-amber-400 via-yellow-500 to-amber-600',
  blue: 'from-blue-400 via-sky-500 to-blue-600',
};

const Pill: React.FC<{ card: Showcase }> = ({ card }) => (
  <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${TONE_PILL[card.tone]}`}>
    <Icon name={card.icon} className="text-[14px]" />
    {card.label}
  </span>
);

const Rating: React.FC<{ value: number; className: string }> = ({ value, className }) => (
  <span
    className={`block font-serif font-bold leading-[0.8] ${overallText(value)} ${className}`}
    style={LINING}
  >
    {value}
  </span>
);

const Accent: React.FC<{ tone: Tone }> = ({ tone }) => (
  <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${TONE_ACCENT[tone]}`} />
);

const CARD_SHELL =
  'relative overflow-hidden rounded-xl border border-cream-300/80 dark:border-charcoal-border bg-cream-50 dark:bg-charcoal-surface shadow-paper';

/** A card as the side panel shows it, shortened. */
const MiniCard: React.FC<{ card: Showcase; className?: string }> = ({ card, className = '' }) => (
  <div className={`${CARD_SHELL} p-4 ${className}`}>
    <Accent tone={card.tone} />
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <Pill card={card} />
        <div className="font-serif font-bold text-[19px] leading-tight mt-2.5 text-charcoal dark:text-white truncate">{card.name}</div>
        <div className="font-serif italic text-[12.5px] text-emerald-700 dark:text-emerald-400 mt-0.5 truncate">{card.archetype}</div>
      </div>
      <div className="text-right shrink-0">
        <Rating value={card.overall} className="text-[34px]" />
        <div className="text-[10.5px] font-semibold text-charcoal/60 dark:text-cream-300 mt-1.5">{getShortTierLabel(card.overall)}</div>
      </div>
    </div>
  </div>
);

/** A library tile: the version, then the name with its rating beside it. `tiny` fits three across. */
const Tile: React.FC<{ card: Showcase; tiny?: boolean }> = ({ card, tiny }) => (
  <div className={`${CARD_SHELL} ${tiny ? 'p-2.5' : 'p-3.5'}`}>
    <Accent tone={card.tone} />
    <div className={`${tiny ? 'text-[9.5px]' : 'text-[10.5px]'} truncate font-medium ${TONE_TEXT[card.tone]}`}>
      {tiny ? TINY_LABEL[card.edition] : card.label}
    </div>
    <div className={tiny ? 'flex flex-col-reverse gap-1.5 mt-1.5' : 'flex items-end justify-between gap-2 mt-2'}>
      <div className="min-w-0">
        <div className={`font-serif font-bold ${tiny ? 'text-[13px]' : 'text-[16px]'} leading-tight text-charcoal dark:text-white truncate`}>
          {tiny ? card.name.split(' ').slice(-1)[0] : card.name}
        </div>
        <div className={`${tiny ? 'text-[9.5px]' : 'text-[10.5px]'} truncate text-charcoal/55 dark:text-cream-400 mt-0.5`}>{getShortTierLabel(card.overall)}</div>
      </div>
      <Rating value={card.overall} className={tiny ? 'text-[26px]' : 'text-[28px]'} />
    </div>
  </div>
);

const Callout: React.FC<{ n: number }> = ({ n }) => (
  <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-charcoal dark:bg-cream-100 text-cream-50 dark:text-charcoal text-[11px] font-bold" aria-hidden="true">
    {n}
  </span>
);

interface Point {
  icon: string | number;
  title: string;
  body: React.ReactNode;
}

interface Step {
  kicker: string;
  title: string;
  lead: string;
  points: Point[];
  visual: React.ReactNode;
  links?: Array<{ label: string; href: string }>;
}

const SCALE: Array<{ range: string; label: string; bar: string }> = [
  { range: '60s', label: 'Prospects', bar: 'bg-cream-400 dark:bg-cream-400/25' },
  { range: '70s', label: 'Squad players', bar: 'bg-cream-400 dark:bg-cream-400/25' },
  { range: '80s', label: 'Top-flight starters', bar: 'bg-emerald-500/30' },
  { range: '90–95', label: 'World-class', bar: 'bg-emerald-500/70' },
  { range: '96–98', label: 'Icons', bar: 'bg-emerald-600' },
  { range: '99', label: 'The greatest', bar: 'bg-amber-500' },
];

function buildSteps(cards: Showcase[], debate: typeof DEBATE, scoutKey: string): Step[] {
  const [kaka, saka] = cards;
  return [
    {
      kicker: 'Welcome',
      title: 'Futbolpedia',
      lead:
        'Futbolpedia is an AI football analyst. Ask it about any player, from this season’s breakout star to a 1970s legend, and it scouts them: a rating, what they do best, where they fall short, and how they compare. Then talk it through, the way you would with a friend who watches every game.',
      points: [
        { icon: 'person_search', title: 'A scouting report on anyone', body: 'A rating out of 99, strengths, weaknesses and a full attribute profile.' },
        { icon: 'history_edu', title: 'Any version of a player', body: 'How they’re playing now, their best years, one spell at a club, or a single season.' },
        { icon: 'forum', title: 'An analyst to argue with', body: 'Comparisons, tactics, transfers, who was better: ask anything and get a real opinion back.' },
      ],
      visual: (
        <div className="@3xl:h-full flex items-center justify-center">
          <div className="hidden @3xl:block w-full max-w-[340px] space-y-3">
            {cards.map((c, i) => (
              <MiniCard key={c.name} card={c} className={i === 1 ? 'translate-x-6' : i === 2 ? 'translate-x-12' : ''} />
            ))}
          </div>
          <div className="@3xl:hidden w-full grid grid-cols-3 gap-2">
            {cards.map((c) => (
              <Tile key={c.name} card={c} tiny />
            ))}
          </div>
        </div>
      ),
    },
    {
      kicker: 'Step 1 of 5',
      title: 'Ratings',
      lead:
        'Each card is the analyst’s assessment of one player, with a rating out of 99. The rating says how good a footballer they are, judged on their game, not on how famous they are or how many trophies they won.',
      points: [
        { icon: 1, title: 'The rating', body: 'Out of 99. A 90 is world-class; only a handful of players ever reach the high 90s.' },
        { icon: 2, title: 'The kind of player', body: 'A short description of how they play.' },
        {
          icon: 3,
          title: 'Which version',
          body: (
            <>
              <b>Current form</b> is how good they are now, re-rated every month. A <b>prime</b> is their best spell of up to
              three seasons. An <b>era</b> is one chapter, like a spell at one club, and a <b>season</b> is a single season.
            </>
          ),
        },
      ],
      visual: (
        <div className="@3xl:h-full flex flex-col justify-center gap-5">
          <div className={`${CARD_SHELL} p-4`}>
            <Accent tone="emerald" />
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Pill card={saka} />
                  <Callout n={3} />
                </div>
                <div className="font-serif font-bold text-[21px] mt-2.5 text-charcoal dark:text-white">{saka.name}</div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="font-serif italic text-[13px] text-emerald-700 dark:text-emerald-400 truncate">{saka.archetype}</span>
                  <Callout n={2} />
                </div>
              </div>
              <div className="flex items-start gap-1.5">
                <Callout n={1} />
                <div className="text-right">
                  <Rating value={saka.overall} className="text-[38px]" />
                  <div className="text-[11px] font-semibold text-charcoal/60 dark:text-cream-300 mt-1.5">{getShortTierLabel(saka.overall)}</div>
                </div>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-6 gap-1" aria-label="What the ratings mean">
            {SCALE.map((s) => (
              <div key={s.range} className="min-w-0">
                <div className={`h-2 rounded-full ${s.bar}`} />
                <div className="mt-2 text-[11px] leading-tight text-charcoal/70 dark:text-cream-300">
                  <b className="block text-charcoal dark:text-white" style={LINING}>
                    {s.range}
                  </b>
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      ),
    },
    {
      kicker: 'Step 2 of 5',
      title: 'Scout',
      lead: 'Want a player who isn’t rated yet? Scout them. Futbolpedia studies the player and writes their card.',
      points: [
        { icon: 'ads_click', title: 'Open Scout', body: <>Press <b>Scout</b> at the top of the page, or <b>{scoutKey}</b>.</> },
        { icon: 'edit', title: 'Type a name', body: 'Or paste a whole squad, one name per line or separated by commas.' },
        {
          icon: 'tune',
          title: 'Pick a version',
          body: <><b>Current</b> for how they play now, <b>Prime</b> for their best years, or an <b>Era</b> or <b>Season</b> you name.</>,
        },
        { icon: 'hourglass_top', title: 'Keep going', body: 'Cards are written in the background, so you can chat while you wait.' },
      ],
      visual: (
        <div className="@3xl:h-full flex items-center justify-center" aria-hidden="true">
          <div className="w-full max-w-[360px] rounded-2xl border border-cream-300 dark:border-charcoal-border bg-cream-100 dark:bg-charcoal shadow-float overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-cream-300 dark:border-charcoal-border bg-cream-50 dark:bg-charcoal-surface">
              <div className="flex items-center gap-2 font-serif font-bold text-[16px] text-charcoal dark:text-white">
                <Icon name="person_search" className="text-[18px] text-emerald-600 dark:text-emerald-400" />
                Scout
              </div>
              <span className="text-[10px] font-mono text-charcoal/40 dark:text-cream-400">{scoutKey}</span>
            </div>
            <div className="p-4 space-y-3">
              <div className="rounded-xl border border-emerald-500/50 bg-white dark:bg-charcoal-surface px-3 py-2.5 text-[13px] text-charcoal dark:text-cream-100">
                Lamine Yamal, Pedri
              </div>
              <div className="flex items-center gap-2">
                <div className="flex rounded-lg border border-cream-300 dark:border-charcoal-border p-0.5 text-[11.5px]">
                  {['Current', 'Prime', 'Era', 'Season'].map((v, i) => (
                    <span key={v} className={`px-2.5 py-1 rounded-md ${i === 0 ? 'bg-emerald-600 text-white font-medium' : 'text-charcoal/60 dark:text-cream-300'}`}>
                      {v}
                    </span>
                  ))}
                </div>
                <span className="ml-auto rounded-lg bg-emerald-600 text-white text-[12px] font-semibold px-3.5 py-1.5">Scout</span>
              </div>
              <div className="pt-2 space-y-2">
                {[
                  ['Lamine Yamal', 'Scouting…', 'bg-emerald-500 animate-pulse'],
                  ['Pedri', 'Queued', 'bg-cream-400 dark:bg-charcoal-border'],
                ].map(([n, status, dot]) => (
                  <div key={n} className="flex items-center gap-3 rounded-lg border border-cream-300 dark:border-charcoal-border bg-white dark:bg-charcoal-surface px-3 py-2">
                    <span className={`size-1.5 rounded-full ${dot}`} />
                    <span className="text-[13px] font-medium text-charcoal dark:text-cream-100 flex-1">{n}</span>
                    <span className="text-[11px] text-charcoal/50 dark:text-cream-400">{status}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ),
    },
    {
      kicker: 'Step 3 of 5',
      title: 'The library',
      lead: 'Every card anyone rates goes into one library that everyone shares. If a player is already in it, their card opens instantly.',
      points: [
        { icon: 'folder_shared', title: 'Browse it', body: <>Open <b>Dossiers</b> at the top. Filter by version, position or rating, or search for a name.</> },
        { icon: 'link', title: 'Every card has a page', body: 'Its own link, to send to a friend or post in a group chat.' },
        { icon: 'bookmark', title: 'Yours too', body: <>Cards you scout or save are kept under <b>Your dossiers</b>.</> },
      ],
      visual: (
        <div className="@3xl:h-full flex flex-col justify-center" aria-hidden="true">
          <div className="flex flex-wrap gap-1.5 mb-3 text-[11px]">
            {['All', 'Current', 'Prime', 'Eras', 'Seasons'].map((f, i) => (
              <span
                key={f}
                className={`rounded-full border px-2.5 py-1 ${
                  i === 0
                    ? 'bg-charcoal text-white border-charcoal dark:bg-cream-100 dark:text-charcoal dark:border-cream-100'
                    : 'border-cream-300 dark:border-charcoal-border text-charcoal/70 dark:text-cream-300'
                }`}
              >
                {f}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {cards.map((c) => (
              <Tile key={c.name} card={c} />
            ))}
            <div className="rounded-xl border border-dashed border-cream-400 dark:border-charcoal-border flex items-center justify-center text-[12px] leading-snug text-charcoal/50 dark:text-cream-400 p-3 text-center">
              And every other player anyone has scouted
            </div>
          </div>
        </div>
      ),
    },
    {
      kicker: 'Step 4 of 5',
      title: 'The analyst',
      lead:
        'Ask the analyst anything: who was better at their peak, who starts this weekend, whether a transfer makes sense. It answers with a real opinion, and backs it with the cards.',
      points: [
        { icon: 'alternate_email', title: 'Bring in a card', body: <>Type <b>@</b> and a name. The analyst reads that exact card.</> },
        { icon: 'rate_review', title: 'Think a rating is off?', body: 'Ask about it in the chat any time. To have it changed, press Challenge on the card and say why; if the evidence backs you, you keep a revised card.' },
        { icon: 'stadium', title: 'Football this season', body: 'Who’s starting this weekend, who’s injured, and what has changed at a club since last season.' },
      ],
      visual: (
        <div className="@3xl:h-full flex flex-col justify-center gap-3" aria-hidden="true">
          <div className="self-end max-w-[88%] rounded-2xl rounded-br-md bg-cream-300 dark:bg-charcoal-light px-3.5 py-2.5 text-[13px] text-charcoal dark:text-cream-100">
            Who was better at their peak,{' '}
            <span className="rounded bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 px-1 font-medium">@{debate[0].name}</span> or{' '}
            <span className="rounded bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 px-1 font-medium">@{debate[1].name}</span>?
          </div>
          <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-cream-300 dark:border-charcoal-border bg-white dark:bg-charcoal-surface px-3.5 py-3 text-[13px] leading-relaxed text-charcoal dark:text-cream-100">
            <div className="text-[10px] font-bold uppercase tracking-widest text-charcoal/40 dark:text-cream-400 mb-1.5">Analyst</div>
            The answer argues it point by point, from their peak level to what each did for their team, and ends on a clear verdict.
            <div className="flex gap-2 mt-3">
              {debate.map((d) => (
                <span key={d.name} className="inline-flex items-center gap-2 rounded-lg border border-cream-300 dark:border-charcoal-border px-2 py-1">
                  <Rating value={d.overall} className="text-[16px] leading-none" />
                  <span className="text-[11px]">{d.name}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      ),
    },
    {
      kicker: 'Step 5 of 5',
      title: 'Gaffa',
      lead:
        'Gaffa is a fantasy Premier League game, played like the real thing. Players score on how their match actually went, rated against others in their position, and you build your club in a live transfer market. Futbolpedia works with it.',
      points: [
        { icon: 'groups', title: 'Your league', body: 'Four to twelve managers, a head-to-head match every gameweek, and four trophies a season.' },
        { icon: 'gavel', title: 'A real transfer market', body: 'When a player joins a Premier League club, managers bid for the player in a public auction.' },
        {
          icon: 'link',
          title: 'Connect your club',
          body: <>Press <b>Gaffa</b> in the chat box and Futbolpedia helps with your lineup, trades and bids. It can read your club but never change it.</>,
        },
      ],
      links: [
        { label: 'Visit Gaffa', href: GAFFA_PUBLIC_URL },
        { label: 'Read the Gaffa guide', href: `${GAFFA_PUBLIC_URL}/guide` },
      ],
      visual: (
        <div className="@3xl:h-full flex items-center justify-center" aria-hidden="true">
          <div className="w-full max-w-[360px] rounded-2xl border border-cream-300 dark:border-charcoal-border bg-cream-50 dark:bg-charcoal-surface shadow-float overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-cream-300 dark:border-charcoal-border">
              <span className="size-9 shrink-0 rounded-full bg-emerald-600 text-white flex items-center justify-center">
                <GaffaMark className="size-6" />
              </span>
              <div>
                <GaffaWordmark className="block text-[15px] text-charcoal dark:text-white" />
                <div className="text-[11px] text-charcoal/55 dark:text-cream-400 mt-1">Fantasy football, played like the real thing</div>
              </div>
            </div>
            <div className="p-4 space-y-3 text-[12.5px] text-charcoal dark:text-cream-100">
              <div className="flex items-center justify-between rounded-lg bg-cream-100 dark:bg-charcoal px-3 py-2.5">
                <div>
                  <div className="text-[10px] uppercase tracking-widest font-bold text-charcoal/45 dark:text-cream-400">This gameweek</div>
                  <div className="font-semibold mt-0.5">Your club v a rival</div>
                </div>
                <div className="font-mono font-bold text-[15px]" style={LINING}>
                  152.6 <span className="text-charcoal/40 dark:text-cream-400 font-normal">–</span> 145.3
                </div>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-cream-100 dark:bg-charcoal px-3 py-2.5">
                <div>
                  <div className="text-[10px] uppercase tracking-widest font-bold text-charcoal/45 dark:text-cream-400">Auction</div>
                  <div className="font-semibold mt-0.5">New Premier League signing</div>
                </div>
                <div className="text-[11px] text-charcoal/55 dark:text-cream-400">Open bidding</div>
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {['League title', 'Champions Cup', 'League Cup', 'Consolation Cup'].map((t) => (
                  <span key={t} className="rounded-full border border-cream-300 dark:border-charcoal-border px-2.5 py-1 text-[11px]">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      ),
    },
  ];
}

const scoutShortcut = (): string =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl+K';

export const WelcomeWalkthrough: React.FC<WelcomeWalkthroughProps> = ({ open, onClose, onStartTalking, onRatePlayer }) => {
  const [step, setStep] = useState(0);
  const { cards, debate } = useShowcase(open);
  const steps = useMemo(() => buildSteps(cards, debate, scoutShortcut()), [cards, debate]);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const last = step === steps.length - 1;
  const current = steps[step];

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  const close = (then?: () => void) => {
    markWelcomeSeen();
    onClose();
    then?.();
  };

  useEffect(() => {
    if (!open) return;
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') setStep((s) => Math.min(steps.length - 1, s + 1));
      else if (e.key === 'ArrowLeft') setStep((s) => Math.max(0, s - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // close only marks the walkthrough seen and calls onClose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, steps.length]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center sm:p-6">
      <div className="absolute inset-0 bg-charcoal/45 dark:bg-black/70 backdrop-blur-md" onClick={() => close()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        className="@container relative w-full h-[100dvh] sm:h-[min(660px,90vh)] sm:max-w-[1040px] flex flex-col bg-cream-100 dark:bg-charcoal-surface sm:rounded-2xl sm:border border-cream-300 dark:border-charcoal-border shadow-float overflow-hidden animate-fade-in"
      >
        <div className="flex-1 min-h-0 overflow-y-auto grid grid-cols-1 @3xl:grid-cols-[1fr_1.05fr]">
          <div key={`text-${step}`} className="order-2 @3xl:order-1 px-6 @lg:px-10 pt-6 @3xl:pt-12 pb-6 flex flex-col animate-fade-in">
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-emerald-700 dark:text-emerald-400">{current.kicker}</p>
            <h2 id="welcome-title" className="font-serif font-bold text-[30px] @lg:text-[38px] leading-[1.05] tracking-tight text-charcoal dark:text-white mt-2">
              {current.title}
            </h2>
            <p className="text-[15px] leading-relaxed text-charcoal/80 dark:text-cream-200 mt-3 max-w-[46ch]">{current.lead}</p>
            <ul className="mt-6 space-y-4">
              {current.points.map((p) => (
                <li key={p.title} className="flex gap-3">
                  {typeof p.icon === 'number' ? (
                    <span className="mt-0.5">
                      <Callout n={p.icon} />
                    </span>
                  ) : (
                    <span className="mt-0.5 shrink-0 size-8 rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 flex items-center justify-center">
                      <Icon name={p.icon} />
                    </span>
                  )}
                  <div>
                    <div className="text-[14px] font-semibold text-charcoal dark:text-white">{p.title}</div>
                    <div className="text-[13px] leading-relaxed text-charcoal/65 dark:text-cream-300 mt-0.5">{p.body}</div>
                  </div>
                </li>
              ))}
            </ul>
            {current.links && (
              <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2">
                {current.links.map((l) => (
                  <a
                    key={l.href}
                    href={l.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[13px] font-semibold text-emerald-700 dark:text-emerald-400 hover:underline"
                  >
                    {l.label}
                    <Icon name="north_east" className="text-[15px]" />
                  </a>
                ))}
              </div>
            )}
          </div>
          <div
            key={`visual-${step}`}
            className="order-1 @3xl:order-2 bg-cream-200/70 dark:bg-charcoal/60 @3xl:border-l border-b @3xl:border-b-0 border-cream-300 dark:border-charcoal-border px-6 @lg:px-10 py-7 @3xl:py-12 animate-fade-in"
          >
            {current.visual}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-3 px-6 @lg:px-10 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-4 border-t border-cream-300 dark:border-charcoal-border bg-cream-50 dark:bg-charcoal-surface">
          <div className="flex items-center gap-1.5" aria-label={`Step ${step + 1} of ${steps.length}`}>
            {steps.map((s, i) => (
              <button
                key={s.title}
                type="button"
                aria-label={`Go to ${s.title}`}
                aria-current={i === step ? 'step' : undefined}
                onClick={() => setStep(i)}
                className={`h-1.5 rounded-full transition-all ${i === step ? 'w-6 bg-emerald-600 dark:bg-emerald-400' : 'w-1.5 bg-charcoal/15 dark:bg-cream-400/30'}`}
              />
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {!last && (
              <button
                type="button"
                onClick={() => close()}
                className="rounded-xl px-3 py-2.5 text-[13px] font-medium text-charcoal/50 dark:text-cream-400 hover:text-charcoal dark:hover:text-white"
              >
                Skip
              </button>
            )}
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                className="rounded-xl px-4 py-2.5 text-[13px] font-medium text-charcoal/70 dark:text-cream-300 hover:bg-cream-200 dark:hover:bg-charcoal-light"
              >
                Back
              </button>
            )}
            {last && (
              <button
                type="button"
                onClick={() => close(onRatePlayer)}
                className="hidden sm:inline-flex rounded-xl border border-cream-300 dark:border-charcoal-border px-4 py-2.5 text-[13px] font-medium text-charcoal dark:text-cream-100 hover:border-emerald-500/50"
              >
                Rate a player
              </button>
            )}
            <button
              ref={primaryRef}
              type="button"
              onClick={() => (last ? close(onStartTalking) : setStep(step + 1))}
              className="rounded-xl bg-emerald-600 hover:bg-emerald-700 px-5 py-2.5 text-[13px] font-semibold text-white inline-flex items-center gap-1.5"
            >
              {last ? 'Start talking' : step === 0 ? 'Show me how' : 'Next'}
              <Icon name="arrow_forward" className="text-[16px]" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
