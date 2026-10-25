import React, { useEffect, useMemo, useState } from 'react';
import type {
  GaffaAuthUser,
  GaffaContextBag,
  GaffaFreeAgent,
  GaffaRosterPlayer,
  GaffaUserClub,
  PlayerProfile,
} from '../types';
import type { GaffaLinkState } from '../services/gaffaContext';
import {
  auditGaffaLineup,
  buildDossierLookupMap,
  computeGaffaClubAlerts,
  ACADEMY_STATUSES,
  DEFENSIVE_SLOTS,
  faBidFloorRate,
  lookupPlayerDossier,
  openingFaFloor,
  SQUAD_STATUSES,
} from '../services/gaffaLineupAudit';

interface GaffaConnectStripProps {
  link: GaffaLinkState | null;
  syncing: boolean;
  error: string | null;
  onSync: (leagueId: string, clubId: string) => void;
  onDisconnect: () => void;
  onQuickPrompt?: (prompt: string) => void;
  calibratedDossiers?: PlayerProfile[];
  disabled?: boolean;
  authUser?: GaffaAuthUser | null;
  userClubs?: GaffaUserClub[];
  authLoading?: boolean;
  onSignInPassword?: (email: string, password: string) => Promise<void> | void;
  onSignInGoogle?: () => Promise<void> | void;
  onSignOut?: () => Promise<void> | void;
}

type InspectorTab = 'lineup' | 'squad' | 'market';
type MarketFilter = 'ALL' | 'U21' | 'GK' | 'DEF' | 'MID' | 'ATT';
type SquadFilter = 'ALL' | 'ACTIVE' | 'IR' | 'ACADEMY' | 'OTHER';
type LineupAudit = ReturnType<typeof auditGaffaLineup>;
type DossierMap = ReturnType<typeof buildDossierLookupMap>;
/** Present only when the parent wired quick prompts; ask buttons render only then. */
type AskHandler = ((prompt: string) => void) | undefined;

const MARKET_FILTERS: MarketFilter[] = ['ALL', 'U21', 'GK', 'DEF', 'MID', 'ATT'];
const FA_LIST_LIMIT = 30;

const MARKET_FILTER_MATCH: Record<MarketFilter, (p: GaffaFreeAgent, u21AgeLimit: number) => boolean> = {
  ALL: () => true,
  U21: (p, u21AgeLimit) => p.age != null && p.age <= u21AgeLimit,
  GK: (p) => p.position.toUpperCase() === 'GK',
  DEF: (p) => DEFENSIVE_SLOTS.has(p.position.toUpperCase()),
  MID: (p) => ['DM', 'CM', 'AM'].includes(p.position.toUpperCase()),
  ATT: (p) => ['LW', 'RW', 'ST'].includes(p.position.toUpperCase()),
};

/**
 * Each filter matches exactly the players its label counts: ACTIVE is the squad the roster cap
 * counts (loans out included), and OTHER is everyone outside squad, IR and academy.
 */
const SQUAD_FILTER_MATCH: Record<SquadFilter, (p: GaffaRosterPlayer) => boolean> = {
  ALL: () => true,
  ACTIVE: (p) => SQUAD_STATUSES.has(p.status),
  IR: (p) => p.status === 'ir',
  ACADEMY: (p) => ACADEMY_STATUSES.has(p.status),
  OTHER: (p) => !SQUAD_STATUSES.has(p.status) && p.status !== 'ir' && !ACADEMY_STATUSES.has(p.status),
};

const ALERT_TONE: Record<'critical' | 'warning' | 'info', string> = {
  critical: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  info: 'border-charcoal/15 dark:border-cream-400/15 bg-cream-200/50 dark:bg-charcoal-light/50 text-charcoal/75 dark:text-cream-200/75',
};

const ASK_BUTTON_CLASS =
  'shrink-0 text-[10px] font-sans uppercase tracking-wider text-emerald-700 dark:text-emerald-400 hover:underline disabled:opacity-40';
const ASK_BUTTON_BOLD_CLASS =
  'shrink-0 text-[10px] font-sans font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 hover:underline disabled:opacity-40';
const ROW_CARD_CLASS =
  'flex items-center justify-between gap-2 px-2 py-1.5 border border-charcoal/10 dark:border-cream-400/10 bg-cream-100/50 dark:bg-charcoal/40';
const SECTION_LABEL_CLASS =
  'text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/50 dark:text-cream-400/50';

const clubKey = (leagueId: string, clubId: string) => `${leagueId}:${clubId}`;

const AskButton: React.FC<{ label: string; prompt: string; onAsk: (prompt: string) => void; disabled: boolean; bold?: boolean }> = ({
  label,
  prompt,
  onAsk,
  disabled,
  bold = false,
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={() => onAsk(prompt)}
    className={bold ? ASK_BUTTON_BOLD_CLASS : ASK_BUTTON_CLASS}
  >
    {label}
  </button>
);

const ManualIdForm: React.FC<{
  leagueId: string;
  clubId: string;
  onLeagueIdChange: (value: string) => void;
  onClubIdChange: (value: string) => void;
  onSync: (leagueId: string, clubId: string) => void;
  busy: boolean;
  syncing: boolean;
  /** Compact sits under a connected club; the full-size form replaces the sign-in row. */
  compact: boolean;
}> = ({ leagueId, clubId, onLeagueIdChange, onClubIdChange, onSync, busy, syncing, compact }) => {
  const inputClass = compact
    ? 'flex-1 min-w-0 bg-transparent border border-charcoal/20 dark:border-cream-400/20 px-2 py-1 text-xs font-mono text-charcoal dark:text-cream-50 outline-none focus:border-charcoal dark:focus:border-cream-400'
    : 'flex-1 min-w-0 bg-transparent border border-charcoal/20 dark:border-cream-400/20 px-2 py-1.5 text-sm font-sans text-charcoal dark:text-cream-50 outline-none focus:border-charcoal dark:focus:border-cream-400';
  const buttonClass = compact
    ? 'shrink-0 px-3 py-1 bg-charcoal dark:bg-emerald-600 text-cream-50 text-[10px] font-sans uppercase tracking-wide disabled:opacity-40'
    : 'shrink-0 px-3 py-1.5 bg-charcoal dark:bg-emerald-600 text-cream-50 text-[11px] font-sans uppercase tracking-wide disabled:opacity-40';
  return (
    <div className="mt-2 flex flex-col sm:flex-row gap-2">
      <input
        value={leagueId}
        onChange={(e) => onLeagueIdChange(e.target.value)}
        placeholder="League ID"
        className={inputClass}
      />
      <input
        value={clubId}
        onChange={(e) => onClubIdChange(e.target.value)}
        placeholder="Club ID"
        className={inputClass}
      />
      <button
        type="button"
        disabled={busy || !leagueId.trim() || !clubId.trim()}
        onClick={() => onSync(leagueId.trim(), clubId.trim())}
        className={buttonClass}
      >
        {syncing ? 'Syncing…' : compact ? 'Sync IDs' : 'Sync'}
      </button>
    </div>
  );
};

const SignInForm: React.FC<{
  email: string;
  password: string;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onSignInGoogle?: () => Promise<void> | void;
  busy: boolean;
  authLoading: boolean;
}> = ({ email, password, onEmailChange, onPasswordChange, onSubmit, onSignInGoogle, busy, authLoading }) => (
  <form onSubmit={onSubmit} className="mt-2 flex flex-col sm:flex-row gap-2">
    <input
      type="email"
      value={email}
      onChange={(e) => onEmailChange(e.target.value)}
      placeholder="Gaffa email"
      autoComplete="email"
      className="flex-1 min-w-0 bg-transparent border border-charcoal/20 dark:border-cream-400/20 px-2.5 py-1.5 text-xs font-sans text-charcoal dark:text-cream-50 outline-none focus:border-charcoal dark:focus:border-cream-400"
    />
    <input
      type="password"
      value={password}
      onChange={(e) => onPasswordChange(e.target.value)}
      placeholder="Password"
      autoComplete="current-password"
      className="flex-1 min-w-0 bg-transparent border border-charcoal/20 dark:border-cream-400/20 px-2.5 py-1.5 text-xs font-sans text-charcoal dark:text-cream-50 outline-none focus:border-charcoal dark:focus:border-cream-400"
    />
    <div className="flex items-center gap-1.5 shrink-0">
      <button
        type="submit"
        disabled={busy || !email.trim() || !password}
        className="px-3 py-1.5 bg-charcoal dark:bg-emerald-600 text-cream-50 text-[11px] font-sans uppercase tracking-wide disabled:opacity-40"
      >
        {authLoading ? 'Signing in…' : 'Sign in'}
      </button>
      {onSignInGoogle && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onSignInGoogle()}
          className="px-2.5 py-1.5 border border-charcoal/20 dark:border-cream-400/20 bg-cream-100/80 dark:bg-charcoal/70 text-charcoal dark:text-cream-100 text-[11px] font-sans uppercase tracking-wide hover:border-charcoal/40 dark:hover:border-cream-400/40 disabled:opacity-40 flex items-center gap-1.5"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M21.35 11.1h-9.17v2.73h6.51c-.33 3.81-3.5 5.44-6.5 5.44C8.36 19.27 5 15.65 5 12c0-3.65 3.36-7.27 7.2-7.27 3.09 0 4.9 1.97 4.9 1.97L19 4.72S16.56 2 12.1 2C6.42 2 2.03 6.8 2.03 12c0 5.05 4.13 10 10.22 10 5.35 0 9.25-3.67 9.25-9.09 0-1.15-.15-1.81-.15-1.81Z"
            />
          </svg>
          <span>Google</span>
        </button>
      )}
    </div>
  </form>
);

const AlertList: React.FC<{
  alerts: ReturnType<typeof computeGaffaClubAlerts>;
  onAsk: AskHandler;
  disabled: boolean;
}> = ({ alerts, onAsk, disabled }) => (
  <div className="mt-2 space-y-1">
    {alerts.map((alert) => (
      <div
        key={alert.id}
        className={`flex items-center justify-between gap-2 px-2.5 py-1 text-[11px] font-sans border ${ALERT_TONE[alert.severity]}`}
      >
        <span className="leading-snug">{alert.text}</span>
        {alert.prompt && onAsk && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAsk(alert.prompt!)}
            className="shrink-0 text-[10px] font-bold uppercase tracking-wider underline hover:opacity-80 disabled:opacity-40"
          >
            Ask Scout
          </button>
        )}
      </div>
    ))}
  </div>
);

/** Starter tabs and filter pills share this active/idle styling pattern. */
const PillButton: React.FC<{ active: boolean; onClick: () => void; base: string; on: string; off: string; children: React.ReactNode }> = ({
  active,
  onClick,
  base,
  on,
  off,
  children,
}) => (
  <button type="button" onClick={onClick} className={`${base} ${active ? on : off}`}>
    {children}
  </button>
);

const LineupTab: React.FC<{ audit: LineupAudit; onAsk: AskHandler; disabled: boolean }> = ({
  audit,
  onAsk,
  disabled,
}) => (
  <div className="max-h-56 overflow-y-auto pr-1 space-y-2 text-xs">
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
      {audit.starters.map((s) => (
        <div
          key={`${s.slot}-${s.player_id}-${s.name}`}
          className="flex items-center justify-between gap-2 px-2 py-1.5 border border-charcoal/10 dark:border-cream-400/10 bg-cream-100/60 dark:bg-charcoal/50"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] font-bold px-1 bg-charcoal/10 dark:bg-cream-400/15 text-charcoal dark:text-cream-100">
                {s.slot}
              </span>
              <span className="font-serif font-semibold truncate text-charcoal dark:text-cream-100">
                {s.name}
              </span>
              {s.scoutOvr && (
                <span className="font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
                  {s.scoutOvr} OVR
                </span>
              )}
              {s.oopPenalty && (
                <span className="font-mono text-[9px] px-1 bg-amber-500/20 text-amber-800 dark:text-amber-300">
                  −20% OOP
                </span>
              )}
            </div>
            <div className="text-[10px] font-sans text-charcoal/55 dark:text-cream-400/60 truncate mt-0.5">
              {s.coveringBench.length > 0
                ? `Sub cover: ${s.coveringBench.map((c) => `${c.name} (${c.benchSlot})`).join(' → ')}`
                : '⚠ No eligible bench sub'}
            </div>
          </div>
          {onAsk && (
            <AskButton
              label="Scout"
              prompt={`Evaluate my ${s.slot} starter ${s.name} and my backup cover at ${s.slot}. Should I hold or look for an upgrade?`}
              onAsk={onAsk}
              disabled={disabled}
            />
          )}
        </div>
      ))}
    </div>

    {audit.bench.length > 0 && (
      <div className="pt-1">
        <div className={`${SECTION_LABEL_CLASS} mb-1`}>Bench Auto-Sub Priority (DEF → MID → ATT → FLEX)</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {audit.bench.map((b) => (
            <div
              key={`${b.benchSlot}-${b.player_id}`}
              className="px-2 py-1.5 border border-charcoal/10 dark:border-cream-400/10 bg-cream-100/40 dark:bg-charcoal/40"
            >
              <div className="flex items-center justify-between gap-1">
                <span className="font-mono text-[9px] font-bold uppercase text-charcoal/60 dark:text-cream-400/60">
                  {b.benchSlot}
                </span>
                {b.scoutOvr && (
                  <span className="font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
                    {b.scoutOvr}
                  </span>
                )}
              </div>
              <div className="font-serif text-xs truncate text-charcoal dark:text-cream-100">{b.name}</div>
              <div className="text-[10px] font-mono text-charcoal/50 dark:text-cream-400/50">
                Covers: {b.coversStarterSlots.join('/')}
              </div>
            </div>
          ))}
        </div>
      </div>
    )}

    <div className="text-[10px] font-sans text-charcoal/55 dark:text-cream-400/60 pt-1">
      Cleanly fillable formations (no OOP penalty):{' '}
      <span className="font-mono text-charcoal/80 dark:text-cream-200">
        {audit.feasibleFormations
          .filter((f) => f.canFillCleanly)
          .map((f) => f.formation)
          .join(', ') || 'none'}
      </span>
    </div>
  </div>
);

const SquadTab: React.FC<{
  bag: GaffaContextBag;
  audit: LineupAudit;
  players: GaffaRosterPlayer[];
  squadFilter: SquadFilter;
  onSquadFilterChange: (filter: SquadFilter) => void;
  dossierMap: DossierMap;
  onAsk: AskHandler;
  disabled: boolean;
}> = ({ bag, audit, players, squadFilter, onSquadFilterChange, dossierMap, onAsk, disabled }) => {
  const filters: Array<{ id: SquadFilter; label: string }> = [
    { id: 'ALL', label: `All (${bag.roster?.length ?? 0})` },
    { id: 'ACTIVE', label: `Active/Bench (${audit.activeBenchCount}/${audit.rosterCap})` },
    { id: 'IR', label: `IR (${audit.irPlayers.length}/${audit.irCap})` },
    { id: 'ACADEMY', label: `Academy (${audit.academyPlayers.length}/${audit.academyCap ?? '?'})` },
    { id: 'OTHER', label: `Held/Loan (${(bag.roster ?? []).filter(SQUAD_FILTER_MATCH.OTHER).length})` },
  ];
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {filters.map((f) => (
            <PillButton
              key={f.id}
              active={squadFilter === f.id}
              onClick={() => onSquadFilterChange(f.id)}
              base="px-2 py-0.5 text-[10px] font-sans uppercase tracking-wider"
              on="bg-charcoal/15 dark:bg-cream-400/20 font-bold text-charcoal dark:text-cream-100"
              off="text-charcoal/55 dark:text-cream-400/60 hover:underline"
            >
              {f.label}
            </PillButton>
          ))}
        </div>
      </div>

      <div className="max-h-48 overflow-y-auto pr-1 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {players.map((p) => {
          const d = lookupPlayerDossier(p.name, p.display_name, dossierMap);
          const pos = [p.primary_position, ...(p.secondary_positions ?? [])].join('/');
          return (
            <div key={p.player_id} className={ROW_CARD_CLASS}>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[10px] font-bold text-charcoal/70 dark:text-cream-300">{pos}</span>
                  <span className="font-serif truncate text-charcoal dark:text-cream-100">{p.name}</span>
                  {d && (
                    <span className="font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
                      {d.ratings.overall}/{d.ratings.potential}
                    </span>
                  )}
                </div>
                <div className="text-[10px] font-sans text-charcoal/50 dark:text-cream-400/50">
                  {p.pl_team ?? 'PL'} · <span className="uppercase font-mono">{p.status}</span>
                </div>
              </div>
              {onAsk && (
                <AskButton
                  label="Ask"
                  prompt={`What is ${p.name}'s dynasty outlook and trade value on my squad right now?`}
                  onAsk={onAsk}
                  disabled={disabled}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const MarketTab: React.FC<{
  bag: GaffaContextBag;
  freeAgents: GaffaFreeAgent[];
  marketFilter: MarketFilter;
  onMarketFilterChange: (filter: MarketFilter) => void;
  floorRate: number;
  dossierMap: DossierMap;
  onAsk: AskHandler;
  disabled: boolean;
}> = ({ bag, freeAgents, marketFilter, onMarketFilterChange, floorRate, dossierMap, onAsk, disabled }) => (
  <div className="space-y-2 text-xs max-h-56 overflow-y-auto pr-1">
    {/* Live Auctions & Open Listings */}
    {((bag.open_auctions?.length ?? 0) > 0 || (bag.open_listings?.length ?? 0) > 0) && (
      <div className="space-y-1">
        <div className={SECTION_LABEL_CLASS}>Live Auctions & Open Listings</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {(bag.open_auctions ?? []).map((a) => (
            <div
              key={`auc-${a.player_id}`}
              className="flex items-center justify-between gap-2 px-2 py-1.5 border border-emerald-500/30 bg-emerald-500/5"
            >
              <div className="min-w-0">
                <div className="font-serif font-semibold truncate text-charcoal dark:text-cream-100">
                  {a.name}{' '}
                  <span className="font-mono text-[10px] font-normal text-charcoal/60 dark:text-cream-400">
                    ({a.position})
                  </span>
                </div>
                <div className="text-[10px] font-mono text-emerald-700 dark:text-emerald-400">
                  LIVE AUCTION · High €{a.highest_bid_eur_m ?? 0}m (next €
                  {(a.highest_bid_eur_m ?? 0) + 1}m)
                </div>
              </div>
              {onAsk && (
                <AskButton
                  label="Bid Math"
                  prompt={`Should I bid on the live auction for ${a.name} (currently at €${a.highest_bid_eur_m ?? 0}m) given my squad and €${bag.budget_eur_m ?? 0}m balance, and what is my max bid ceiling?`}
                  onAsk={onAsk}
                  disabled={disabled}
                  bold
                />
              )}
            </div>
          ))}

          {(bag.open_listings ?? []).map((l) => {
            const floor = l.min_bid_eur_m ?? l.ask_eur_m ?? l.release_clause_eur_m;
            return (
              <div key={`list-${l.player_id}`} className={ROW_CARD_CLASS}>
                <div className="min-w-0">
                  <div className="font-serif truncate text-charcoal dark:text-cream-100">
                    {l.name}{' '}
                    <span className="font-mono text-[10px] text-charcoal/60 dark:text-cream-400">
                      ({l.position})
                    </span>
                  </div>
                  <div className="text-[10px] font-sans text-charcoal/50 dark:text-cream-400/50 truncate">
                    {l.seller_club_name}
                    {l.yours ? ' (YOURS)' : ''}
                    {floor != null ? ` · €${floor}m` : ''}
                  </div>
                </div>
                {!l.yours && onAsk && (
                  <AskButton
                    label="Evaluate"
                    prompt={`Evaluate ${l.name} listed by ${l.seller_club_name}${floor != null ? ` at €${floor}m` : ''}. Does he upgrade my squad and what offer makes sense?`}
                    onAsk={onAsk}
                    disabled={disabled}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    )}

    {/* Unowned Free Agents Pool */}
    <div className="space-y-1.5 pt-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={SECTION_LABEL_CLASS}>Unowned Free Agents ({bag.free_agents?.length ?? 0})</span>
        <div className="flex flex-wrap gap-1">
          {MARKET_FILTERS.map((f) => (
            <PillButton
              key={f}
              active={marketFilter === f}
              onClick={() => onMarketFilterChange(f)}
              base="px-1.5 py-0.5 text-[10px] font-mono uppercase"
              on="bg-charcoal/15 dark:bg-cream-400/20 font-bold text-charcoal dark:text-cream-100"
              off="text-charcoal/50 dark:text-cream-400/50 hover:underline"
            >
              {f}
            </PillButton>
          ))}
        </div>
      </div>

      {freeAgents.length === 0 ? (
        <p className="text-[11px] font-serif italic text-charcoal/50 dark:text-cream-400/50 py-2">
          No unowned players match this filter.
        </p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {freeAgents.map((fa) => {
            const d = lookupPlayerDossier(fa.name, fa.display_name, dossierMap);
            const mv = fa.market_value_eur_m ?? 0;
            const openFloor = openingFaFloor(mv, floorRate);
            return (
              <div key={fa.player_id} className={ROW_CARD_CLASS}>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10px] font-bold text-charcoal/70 dark:text-cream-300">
                      {fa.position}
                    </span>
                    <span className="font-serif truncate text-charcoal dark:text-cream-100">{fa.name}</span>
                    {d && (
                      <span className="font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
                        {d.ratings.overall}/{d.ratings.potential}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] font-sans text-charcoal/50 dark:text-cream-400/50">
                    {fa.pl_team ?? 'PL'}
                    {fa.age != null ? ` · age ${fa.age}` : ''} · MV €{mv}m · Floor €
                    {openFloor}m
                  </div>
                </div>
                {onAsk && (
                  <AskButton
                    label="Bid Math"
                    prompt={`Should I nominate ${fa.name} (${fa.position}, ${fa.pl_team ?? 'PL'}, MV €${mv}m, opening floor €${openFloor}m) from free agency, and what is my bid ceiling with the 10% Scout's Fee?`}
                    onAsk={onAsk}
                    disabled={disabled}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  </div>
);

export const GaffaConnectStrip: React.FC<GaffaConnectStripProps> = ({
  link,
  syncing,
  error,
  onSync,
  onDisconnect,
  onQuickPrompt,
  calibratedDossiers = [],
  disabled = false,
  authUser = null,
  userClubs = [],
  authLoading = false,
  onSignInPassword,
  onSignInGoogle,
  onSignOut,
}) => {
  const [leagueId, setLeagueId] = useState(link?.league_id ?? '');
  const [clubId, setClubId] = useState(link?.club_id ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [manualMode, setManualMode] = useState(false);
  const [selectedClubKey, setSelectedClubKey] = useState('');
  // Tab and filters live here so they survive the inspector closing and reopening.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<InspectorTab>('lineup');
  const [marketFilter, setMarketFilter] = useState<MarketFilter>('ALL');
  const [squadFilter, setSquadFilter] = useState<SquadFilter>('ALL');

  useEffect(() => {
    setLeagueId(link?.league_id ?? '');
    setClubId(link?.club_id ?? '');
    if (link?.league_id && link?.club_id) {
      setSelectedClubKey(clubKey(link.league_id, link.club_id));
    }
  }, [link?.league_id, link?.club_id]);

  useEffect(() => {
    if (!selectedClubKey && userClubs.length > 0) {
      setSelectedClubKey(clubKey(userClubs[0].league_id, userClubs[0].club_id));
    }
  }, [selectedClubKey, userClubs]);

  const bag = link?.bag;
  const connected = Boolean(bag?.connected || (link?.league_id && link?.club_name));

  const dossierMap = useMemo(
    () => buildDossierLookupMap(calibratedDossiers),
    [calibratedDossiers],
  );

  const audit = useMemo(
    () => (bag?.connected ? auditGaffaLineup(bag, calibratedDossiers) : null),
    [bag, calibratedDossiers],
  );

  const alerts = useMemo(
    () => computeGaffaClubAlerts(bag, calibratedDossiers),
    [bag, calibratedDossiers],
  );

  const floorRate = faBidFloorRate(bag);

  const filteredFa = useMemo(() => {
    const u21AgeLimit = bag?.settings?.taxi_age_limit ?? 21;
    const matches = MARKET_FILTER_MATCH[marketFilter];
    return (bag?.free_agents ?? []).filter((p) => matches(p, u21AgeLimit)).slice(0, FA_LIST_LIMIT);
  }, [bag?.free_agents, bag?.settings?.taxi_age_limit, marketFilter]);

  const filteredRoster = useMemo(
    () => (bag?.roster ?? []).filter(SQUAD_FILTER_MATCH[squadFilter]),
    [bag?.roster, squadFilter],
  );

  const quickChips = useMemo(() => {
    if (!bag?.connected) return [];
    const gwLabel = bag.matchup?.gameweek ? `GW${bag.matchup.gameweek}` : 'saved';
    const oppLabel = bag.matchup?.opponent_club_name
      ? ` vs ${bag.matchup.opponent_club_name}`
      : '';
    const chips: Array<{ label: string; prompt: string }> = [
      {
        label: `Audit ${gwLabel} XI & auto-subs`,
        prompt: `Audit my ${gwLabel} starting XI, bench order, and auto-sub coverage${oppLabel}. Flag any OOP penalties, uncovered slots, or formation upgrades.`,
      },
      {
        label: 'Best U21 Academy stashes in FA',
        prompt: `Which unowned U21 players in our league's free-agent pool are the best Academy stashes right now, and what are their opening FA floor bids?`,
      },
    ];

    if ((bag.open_auctions?.length ?? 0) > 0 || (bag.open_listings?.length ?? 0) > 0) {
      chips.push({
        label: 'Evaluate live auctions & listings',
        prompt: `Review the live auctions and open listings in our league against my current squad needs and €${bag.budget_eur_m ?? 0}m balance. Which targets make sense and what should I bid?`,
      });
    }

    if (bag.budget_eur_m != null) {
      chips.push({
        label: `Deploy €${bag.budget_eur_m}m balance`,
        prompt: `Given my roster depth, standings rank, and €${bag.budget_eur_m}m Club Balance, what is my weakest starting slot and best market path to upgrade it?`,
      });
    }

    return chips;
  }, [bag]);

  const firePrompt = (prompt: string) => {
    if (disabled || !onQuickPrompt) return;
    onQuickPrompt(prompt);
  };
  const onAsk: AskHandler = onQuickPrompt ? firePrompt : undefined;

  const handleClubSelectChange = (val: string) => {
    setSelectedClubKey(val);
    const [nextLeagueId, nextClubId] = val.split(':');
    if (nextLeagueId && nextClubId) {
      onSync(nextLeagueId, nextClubId);
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onSignInPassword || !email.trim() || !password) return;
    await onSignInPassword(email.trim(), password);
    setPassword('');
  };

  const busy = syncing || authLoading;
  const manualIdProps = {
    leagueId,
    clubId,
    onLeagueIdChange: setLeagueId,
    onClubIdChange: setClubId,
    onSync,
    busy,
    syncing,
  };

  return (
    <div className="mb-3 border border-charcoal/15 dark:border-cream-400/15 bg-cream-50/85 dark:bg-charcoal-surface/85 px-3.5 py-2.5 transition-colors">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/55 dark:text-cream-400/60">
            Gaffa club
          </span>
          {authUser?.email && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 bg-charcoal/5 dark:bg-cream-400/10 text-charcoal/65 dark:text-cream-300/75 truncate max-w-[180px]">
              {authUser.email}
            </span>
          )}
          {bag?.standings?.rank != null && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 bg-charcoal/5 dark:bg-cream-400/10 text-charcoal/70 dark:text-cream-200/80">
              Rank #{bag.standings.rank}
              {bag.standings.of_teams ? `/${bag.standings.of_teams}` : ''} · {bag.standings.wins}-
              {bag.standings.draws}-{bag.standings.losses}
            </span>
          )}
          {bag?.matchup && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
              GW{bag.matchup.gameweek} vs {bag.matchup.opponent_club_name ?? 'TBD'}
              {bag.matchup.your_score != null || bag.matchup.opponent_score != null
                ? ` (${bag.matchup.your_score ?? 0}–${bag.matchup.opponent_score ?? 0})`
                : ''}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {connected && bag?.connected && (
            <button
              type="button"
              onClick={() => setInspectorOpen((prev) => !prev)}
              className="text-[10px] font-sans font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 hover:underline flex items-center gap-1"
            >
              <span>{inspectorOpen ? 'Hide Club & Market' : 'Inspect Club & Market'}</span>
              <span className="material-symbols-outlined text-[13px]">
                {inspectorOpen ? 'expand_less' : 'expand_more'}
              </span>
            </button>
          )}
          {connected && (
            <button
              type="button"
              disabled={busy}
              onClick={() => link && onSync(link.league_id, link.club_id)}
              className="text-[10px] font-sans uppercase tracking-wide text-charcoal/60 dark:text-cream-400/60 hover:underline disabled:opacity-50"
            >
              {syncing ? 'Syncing…' : 'Refresh'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setManualMode((prev) => !prev)}
            className="text-[10px] font-sans uppercase tracking-wide text-charcoal/50 dark:text-cream-400/50 hover:underline"
          >
            {manualMode ? (authUser ? 'Hide IDs' : 'Sign In') : 'Manual IDs'}
          </button>
          {authUser && onSignOut ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onSignOut()}
              className="text-[10px] font-sans uppercase tracking-wide text-charcoal/45 dark:text-cream-400/45 hover:underline disabled:opacity-50"
            >
              Sign out
            </button>
          ) : connected ? (
            <button
              type="button"
              onClick={onDisconnect}
              className="text-[10px] font-sans uppercase tracking-wide text-charcoal/45 dark:text-cream-400/45 hover:underline"
            >
              Disconnect
            </button>
          ) : null}
        </div>
      </div>

      {/* Club Switcher when signed in with 1+ clubs */}
      {authUser && userClubs.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="text-[10px] font-sans font-bold uppercase tracking-wider text-charcoal/55 dark:text-cream-400/60">
            Select club
          </label>
          <select
            value={
              link?.league_id && link?.club_id
                ? clubKey(link.league_id, link.club_id)
                : selectedClubKey
            }
            disabled={busy}
            onChange={(e) => handleClubSelectChange(e.target.value)}
            className="flex-1 min-w-[200px] bg-cream-100/90 dark:bg-charcoal/80 border border-charcoal/20 dark:border-cream-400/20 px-2.5 py-1 text-xs font-serif text-charcoal dark:text-cream-100 outline-none focus:border-emerald-600 dark:focus:border-emerald-400 disabled:opacity-50"
          >
            {userClubs.map((c) => {
              const key = clubKey(c.league_id, c.club_id);
              return (
                <option key={key} value={key}>
                  {c.club_name} · {c.league_name} (€{c.budget_eur_m}m)
                </option>
              );
            })}
          </select>
          {!connected && (
            <button
              type="button"
              disabled={busy || !selectedClubKey}
              onClick={() => handleClubSelectChange(selectedClubKey)}
              className="shrink-0 px-2.5 py-1 bg-charcoal dark:bg-emerald-600 text-cream-50 text-[10px] font-sans uppercase tracking-wider disabled:opacity-40"
            >
              {syncing ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
      )}

      {connected ? (
        <div className="mt-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm font-serif text-charcoal dark:text-cream-100">
            <div>
              <span className="italic font-semibold">{link?.club_name ?? 'Club'}</span>
              {link?.league_name ? (
                <span className="text-charcoal/50 dark:text-cream-400/50"> · {link.league_name}</span>
              ) : null}
              {bag?.budget_eur_m != null ? (
                <span className="text-emerald-700 dark:text-emerald-400 font-mono text-xs ml-1.5">
                  €{bag.budget_eur_m}m
                </span>
              ) : null}
              {audit ? (
                <span className="text-charcoal/45 dark:text-cream-400/45 font-mono text-[11px] ml-2">
                  · {audit.activeBenchCount}/{audit.rosterCap} squad · {bag?.free_agents?.length ?? 0} FA
                  {(bag?.open_auctions?.length ?? 0) > 0
                    ? ` · ${bag?.open_auctions?.length} live auction${bag?.open_auctions?.length === 1 ? '' : 's'}`
                    : ''}
                  {(bag?.open_listings?.length ?? 0) > 0
                    ? ` · ${bag?.open_listings?.length} listed`
                    : ''}
                </span>
              ) : null}
            </div>
            {link?.last_synced_at ? (
              <span className="text-[10px] font-sans text-charcoal/40 dark:text-cream-400/40">
                Synced {new Date(link.last_synced_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {bag?.stale ? ' · stale' : ''}
              </span>
            ) : null}
          </div>

          {manualMode && <ManualIdForm {...manualIdProps} compact />}

          {/* Proactive Roster-State & Lineup Alerts */}
          {alerts.length > 0 && <AlertList alerts={alerts} onAsk={onAsk} disabled={disabled} />}

          {/* Contextual Starter Chips */}
          {quickChips.length > 0 && onQuickPrompt && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {quickChips.map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  disabled={disabled}
                  onClick={() => firePrompt(chip.prompt)}
                  className="btn-new-chat text-[11px] font-sans px-2.5 py-1 border border-charcoal/15 dark:border-cream-400/15 bg-cream-100/80 dark:bg-charcoal/70 text-charcoal/80 dark:text-cream-200/80 hover:border-emerald-600/50 dark:hover:border-emerald-400/50 hover:text-emerald-700 dark:hover:text-emerald-300 disabled:opacity-40"
                >
                  {chip.label}
                </button>
              ))}
            </div>
          )}

          {/* Interactive Club & Market Inspector Drawer */}
          {inspectorOpen && bag?.connected && audit && (
            <div className="mt-3 pt-2.5 border-t border-charcoal/15 dark:border-cream-400/15">
              <div className="flex items-center justify-between gap-2 mb-2.5">
                <div className="flex items-center gap-1">
                  {(
                    [
                      { id: 'lineup', label: `XI & Auto-Subs (${audit.formation ?? 'Lineup'})` },
                      { id: 'squad', label: `Squad (${bag.roster?.length ?? 0})` },
                      {
                        id: 'market',
                        label: `Market & FA (${(bag.open_auctions?.length ?? 0) + (bag.open_listings?.length ?? 0)} live · ${bag.free_agents?.length ?? 0} FA)`,
                      },
                    ] as Array<{ id: InspectorTab; label: string }>
                  ).map((t) => (
                    <PillButton
                      key={t.id}
                      active={activeTab === t.id}
                      onClick={() => setActiveTab(t.id)}
                      base="px-2.5 py-1 text-[10px] font-sans font-bold uppercase tracking-wider transition-colors"
                      on="bg-charcoal dark:bg-emerald-600 text-cream-50"
                      off="bg-cream-200/70 dark:bg-charcoal-light/60 text-charcoal/65 dark:text-cream-300/70 hover:text-charcoal dark:hover:text-cream-100"
                    >
                      {t.label}
                    </PillButton>
                  ))}
                </div>
              </div>

              {activeTab === 'lineup' && <LineupTab audit={audit} onAsk={onAsk} disabled={disabled} />}
              {activeTab === 'squad' && (
                <SquadTab
                  bag={bag}
                  audit={audit}
                  players={filteredRoster}
                  squadFilter={squadFilter}
                  onSquadFilterChange={setSquadFilter}
                  dossierMap={dossierMap}
                  onAsk={onAsk}
                  disabled={disabled}
                />
              )}
              {activeTab === 'market' && (
                <MarketTab
                  bag={bag}
                  freeAgents={filteredFa}
                  marketFilter={marketFilter}
                  onMarketFilterChange={setMarketFilter}
                  floorRate={floorRate}
                  dossierMap={dossierMap}
                  onAsk={onAsk}
                  disabled={disabled}
                />
              )}
            </div>
          )}
        </div>
      ) : manualMode ? (
        <ManualIdForm {...manualIdProps} compact={false} />
      ) : authUser ? (
        userClubs.length === 0 ? (
          <p className="mt-1.5 text-xs font-serif italic text-charcoal/60 dark:text-cream-400/60">
            No clubs found on your Gaffa account. Join a league on Gaffa or switch to Manual IDs.
          </p>
        ) : null
      ) : (
        <SignInForm
          email={email}
          password={password}
          onEmailChange={setEmail}
          onPasswordChange={setPassword}
          onSubmit={handlePasswordSubmit}
          onSignInGoogle={onSignInGoogle}
          busy={busy}
          authLoading={authLoading}
        />
      )}

      {error && (
        <p className="mt-1.5 text-[11px] font-sans text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
};
