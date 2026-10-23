import React, { useEffect, useMemo, useState } from 'react';
import type { PlayerProfile } from '../types';
import type { GaffaLinkState } from '../services/gaffaContext';
import {
  auditGaffaLineup,
  buildDossierLookupMap,
  computeGaffaClubAlerts,
  DEFENSIVE_SLOTS,
  lookupPlayerDossier,
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
}

type InspectorTab = 'lineup' | 'squad' | 'market';
type MarketFilter = 'ALL' | 'U21' | 'GK' | 'DEF' | 'MID' | 'ATT';
type SquadFilter = 'ALL' | 'ACTIVE' | 'IR' | 'ACADEMY' | 'OTHER';

export const GaffaConnectStrip: React.FC<GaffaConnectStripProps> = ({
  link,
  syncing,
  error,
  onSync,
  onDisconnect,
  onQuickPrompt,
  calibratedDossiers = [],
  disabled = false,
}) => {
  const [leagueId, setLeagueId] = useState(link?.league_id ?? '');
  const [clubId, setClubId] = useState(link?.club_id ?? '');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<InspectorTab>('lineup');
  const [marketFilter, setMarketFilter] = useState<MarketFilter>('ALL');
  const [squadFilter, setSquadFilter] = useState<SquadFilter>('ALL');

  useEffect(() => {
    setLeagueId(link?.league_id ?? '');
    setClubId(link?.club_id ?? '');
  }, [link?.league_id, link?.club_id]);

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

  const floorRate = bag?.settings?.free_agent_bid_floor ?? 0.6;

  const filteredFa = useMemo(() => {
    const list = bag?.free_agents ?? [];
    return list
      .filter((p) => {
        if (marketFilter === 'U21') return p.age != null && p.age <= (bag?.settings?.taxi_age_limit ?? 21);
        if (marketFilter === 'GK') return p.position.toUpperCase() === 'GK';
        if (marketFilter === 'DEF') return DEFENSIVE_SLOTS.has(p.position.toUpperCase());
        if (marketFilter === 'MID') return ['DM', 'CM', 'AM'].includes(p.position.toUpperCase());
        if (marketFilter === 'ATT') return ['LW', 'RW', 'ST'].includes(p.position.toUpperCase());
        return true;
      })
      .slice(0, 30);
  }, [bag?.free_agents, bag?.settings?.taxi_age_limit, marketFilter]);

  const filteredRoster = useMemo(() => {
    const list = bag?.roster ?? [];
    return list.filter((p) => {
      if (squadFilter === 'ACTIVE') return p.status === 'active' || p.status === 'bench';
      if (squadFilter === 'IR') return p.status === 'ir';
      if (squadFilter === 'ACADEMY') return p.status === 'taxi' || p.status === 'academy';
      if (squadFilter === 'OTHER') {
        return !['active', 'bench', 'ir', 'taxi', 'academy'].includes(p.status);
      }
      return true;
    });
  }, [bag?.roster, squadFilter]);

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

  return (
    <div className="mb-3 border border-charcoal/15 dark:border-cream-400/15 bg-cream-50/85 dark:bg-charcoal-surface/85 px-3.5 py-2.5 transition-colors">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/55 dark:text-cream-400/60">
            Gaffa club
          </span>
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

        {connected && (
          <div className="flex items-center gap-3">
            {bag?.connected && (
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
            <button
              type="button"
              disabled={syncing}
              onClick={() => link && onSync(link.league_id, link.club_id)}
              className="text-[10px] font-sans uppercase tracking-wide text-charcoal/60 dark:text-cream-400/60 hover:underline disabled:opacity-50"
            >
              {syncing ? 'Syncing…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={onDisconnect}
              className="text-[10px] font-sans uppercase tracking-wide text-charcoal/45 dark:text-cream-400/45 hover:underline"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>

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

          {/* Proactive Roster-State & Lineup Alerts */}
          {alerts.length > 0 && (
            <div className="mt-2 space-y-1">
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  className={`flex items-center justify-between gap-2 px-2.5 py-1 text-[11px] font-sans border ${
                    alert.severity === 'critical'
                      ? 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300'
                      : alert.severity === 'warning'
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300'
                        : 'border-charcoal/15 dark:border-cream-400/15 bg-cream-200/50 dark:bg-charcoal-light/50 text-charcoal/75 dark:text-cream-200/75'
                  }`}
                >
                  <span className="leading-snug">{alert.text}</span>
                  {alert.prompt && onQuickPrompt && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => firePrompt(alert.prompt!)}
                      className="shrink-0 text-[10px] font-bold uppercase tracking-wider underline hover:opacity-80 disabled:opacity-40"
                    >
                      Ask Scout
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

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
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setActiveTab(t.id)}
                      className={`px-2.5 py-1 text-[10px] font-sans font-bold uppercase tracking-wider transition-colors ${
                        activeTab === t.id
                          ? 'bg-charcoal dark:bg-emerald-600 text-cream-50'
                          : 'bg-cream-200/70 dark:bg-charcoal-light/60 text-charcoal/65 dark:text-cream-300/70 hover:text-charcoal dark:hover:text-cream-100'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* TAB 1: XI & AUTO-SUBS */}
              {activeTab === 'lineup' && (
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
                        {onQuickPrompt && (
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() =>
                              firePrompt(
                                `Evaluate my ${s.slot} starter ${s.name} and my backup cover at ${s.slot}. Should I hold or look for an upgrade?`,
                              )
                            }
                            className="shrink-0 text-[10px] font-sans uppercase tracking-wider text-emerald-700 dark:text-emerald-400 hover:underline disabled:opacity-40"
                          >
                            Scout
                          </button>
                        )}
                      </div>
                    ))}
                  </div>

                  {audit.bench.length > 0 && (
                    <div className="pt-1">
                      <div className="text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/50 dark:text-cream-400/50 mb-1">
                        Bench Auto-Sub Priority (DEF → MID → ATT → FLEX)
                      </div>
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
                            <div className="font-serif text-xs truncate text-charcoal dark:text-cream-100">
                              {b.name}
                            </div>
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
              )}

              {/* TAB 2: SQUAD & CAPS */}
              {activeTab === 'squad' && (
                <div className="space-y-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-1">
                      {(
                        [
                          { id: 'ALL', label: `All (${bag.roster?.length ?? 0})` },
                          { id: 'ACTIVE', label: `Active/Bench (${audit.activeBenchCount}/${audit.rosterCap})` },
                          { id: 'IR', label: `IR (${audit.irPlayers.length}/${audit.irCap})` },
                          { id: 'ACADEMY', label: `Academy (${audit.academyPlayers.length}/${audit.academyCap ?? '?'})` },
                          { id: 'OTHER', label: `Held/Loan (${audit.heldPlayers.length})` },
                        ] as Array<{ id: SquadFilter; label: string }>
                      ).map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => setSquadFilter(f.id)}
                          className={`px-2 py-0.5 text-[10px] font-sans uppercase tracking-wider ${
                            squadFilter === f.id
                              ? 'bg-charcoal/15 dark:bg-cream-400/20 font-bold text-charcoal dark:text-cream-100'
                              : 'text-charcoal/55 dark:text-cream-400/60 hover:underline'
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="max-h-48 overflow-y-auto pr-1 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {filteredRoster.map((p) => {
                      const d = lookupPlayerDossier(p.name, p.display_name, dossierMap);
                      const pos = [p.primary_position, ...(p.secondary_positions ?? [])].join('/');
                      return (
                        <div
                          key={p.player_id}
                          className="flex items-center justify-between gap-2 px-2 py-1.5 border border-charcoal/10 dark:border-cream-400/10 bg-cream-100/50 dark:bg-charcoal/40"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-[10px] font-bold text-charcoal/70 dark:text-cream-300">
                                {pos}
                              </span>
                              <span className="font-serif truncate text-charcoal dark:text-cream-100">
                                {p.name}
                              </span>
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
                          {onQuickPrompt && (
                            <button
                              type="button"
                              disabled={disabled}
                              onClick={() =>
                                firePrompt(
                                  `What is ${p.name}'s dynasty outlook and trade value on my squad right now?`,
                                )
                              }
                              className="shrink-0 text-[10px] font-sans uppercase tracking-wider text-emerald-700 dark:text-emerald-400 hover:underline disabled:opacity-40"
                            >
                              Ask
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* TAB 3: MARKET & FA */}
              {activeTab === 'market' && (
                <div className="space-y-2 text-xs max-h-56 overflow-y-auto pr-1">
                  {/* Live Auctions & Open Listings */}
                  {((bag.open_auctions?.length ?? 0) > 0 || (bag.open_listings?.length ?? 0) > 0) && (
                    <div className="space-y-1">
                      <div className="text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/50 dark:text-cream-400/50">
                        Live Auctions & Open Listings
                      </div>
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
                            {onQuickPrompt && (
                              <button
                                type="button"
                                disabled={disabled}
                                onClick={() =>
                                  firePrompt(
                                    `Should I bid on the live auction for ${a.name} (currently at €${a.highest_bid_eur_m ?? 0}m) given my squad and €${bag.budget_eur_m ?? 0}m balance, and what is my max bid ceiling?`,
                                  )
                                }
                                className="shrink-0 text-[10px] font-sans font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 hover:underline disabled:opacity-40"
                              >
                                Bid Math
                              </button>
                            )}
                          </div>
                        ))}

                        {(bag.open_listings ?? []).map((l) => {
                          const floor = l.min_bid_eur_m ?? l.ask_eur_m ?? l.release_clause_eur_m;
                          return (
                            <div
                              key={`list-${l.player_id}`}
                              className="flex items-center justify-between gap-2 px-2 py-1.5 border border-charcoal/10 dark:border-cream-400/10 bg-cream-100/50 dark:bg-charcoal/40"
                            >
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
                              {!l.yours && onQuickPrompt && (
                                <button
                                  type="button"
                                  disabled={disabled}
                                  onClick={() =>
                                    firePrompt(
                                      `Evaluate ${l.name} listed by ${l.seller_club_name}${floor != null ? ` at €${floor}m` : ''}. Does he upgrade my squad and what offer makes sense?`,
                                    )
                                  }
                                  className="shrink-0 text-[10px] font-sans uppercase tracking-wider text-emerald-700 dark:text-emerald-400 hover:underline disabled:opacity-40"
                                >
                                  Evaluate
                                </button>
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
                      <span className="text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/50 dark:text-cream-400/50">
                        Unowned Free Agents ({bag.free_agents?.length ?? 0})
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {(['ALL', 'U21', 'GK', 'DEF', 'MID', 'ATT'] as MarketFilter[]).map((f) => (
                          <button
                            key={f}
                            type="button"
                            onClick={() => setMarketFilter(f)}
                            className={`px-1.5 py-0.5 text-[10px] font-mono uppercase ${
                              marketFilter === f
                                ? 'bg-charcoal/15 dark:bg-cream-400/20 font-bold text-charcoal dark:text-cream-100'
                                : 'text-charcoal/50 dark:text-cream-400/50 hover:underline'
                            }`}
                          >
                            {f}
                          </button>
                        ))}
                      </div>
                    </div>

                    {filteredFa.length === 0 ? (
                      <p className="text-[11px] font-serif italic text-charcoal/50 dark:text-cream-400/50 py-2">
                        No unowned players match this filter.
                      </p>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {filteredFa.map((fa) => {
                          const d = lookupPlayerDossier(fa.name, fa.display_name, dossierMap);
                          const mv = fa.market_value_eur_m ?? 0;
                          const openFloor = mv > 0 ? Math.max(1, Math.floor(mv * floorRate)) : 1;
                          return (
                            <div
                              key={fa.player_id}
                              className="flex items-center justify-between gap-2 px-2 py-1.5 border border-charcoal/10 dark:border-cream-400/10 bg-cream-100/50 dark:bg-charcoal/40"
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-mono text-[10px] font-bold text-charcoal/70 dark:text-cream-300">
                                    {fa.position}
                                  </span>
                                  <span className="font-serif truncate text-charcoal dark:text-cream-100">
                                    {fa.name}
                                  </span>
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
                              {onQuickPrompt && (
                                <button
                                  type="button"
                                  disabled={disabled}
                                  onClick={() =>
                                    firePrompt(
                                      `Should I nominate ${fa.name} (${fa.position}, ${fa.pl_team ?? 'PL'}, MV €${mv}m, opening floor €${openFloor}m) from free agency, and what is my bid ceiling with the 10% Scout's Fee?`,
                                    )
                                  }
                                  className="shrink-0 text-[10px] font-sans uppercase tracking-wider text-emerald-700 dark:text-emerald-400 hover:underline disabled:opacity-40"
                                >
                                  Bid Math
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-2 flex flex-col sm:flex-row gap-2">
          <input
            value={leagueId}
            onChange={(e) => setLeagueId(e.target.value)}
            placeholder="League ID"
            className="flex-1 min-w-0 bg-transparent border border-charcoal/20 dark:border-cream-400/20 px-2 py-1.5 text-sm font-sans text-charcoal dark:text-cream-50 outline-none focus:border-charcoal dark:focus:border-cream-400"
          />
          <input
            value={clubId}
            onChange={(e) => setClubId(e.target.value)}
            placeholder="Club ID"
            className="flex-1 min-w-0 bg-transparent border border-charcoal/20 dark:border-cream-400/20 px-2 py-1.5 text-sm font-sans text-charcoal dark:text-cream-50 outline-none focus:border-charcoal dark:focus:border-cream-400"
          />
          <button
            type="button"
            disabled={syncing || !leagueId.trim() || !clubId.trim()}
            onClick={() => onSync(leagueId.trim(), clubId.trim())}
            className="shrink-0 px-3 py-1.5 bg-charcoal dark:bg-emerald-600 text-cream-50 text-[11px] font-sans uppercase tracking-wide disabled:opacity-40"
          >
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-1.5 text-[11px] font-sans text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
};
