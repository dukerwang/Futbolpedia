import React, { useEffect, useState } from 'react';
import type { GaffaLinkState } from '../services/gaffaContext';

interface GaffaConnectStripProps {
  link: GaffaLinkState | null;
  syncing: boolean;
  error: string | null;
  onSync: (leagueId: string, clubId: string) => void;
  onDisconnect: () => void;
}

export const GaffaConnectStrip: React.FC<GaffaConnectStripProps> = ({
  link,
  syncing,
  error,
  onSync,
  onDisconnect,
}) => {
  const [leagueId, setLeagueId] = useState(link?.league_id ?? '');
  const [clubId, setClubId] = useState(link?.club_id ?? '');

  useEffect(() => {
    setLeagueId(link?.league_id ?? '');
    setClubId(link?.club_id ?? '');
  }, [link?.league_id, link?.club_id]);

  const connected = Boolean(link?.bag?.connected || (link?.league_id && link?.club_name));

  return (
    <div className="mb-3 border border-charcoal/15 dark:border-cream-400/15 bg-cream-50/80 dark:bg-charcoal-surface/80 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="text-[10px] font-sans uppercase tracking-widest text-charcoal/50 dark:text-cream-400/50">
          Gaffa club
        </div>
        {connected && (
          <button
            type="button"
            onClick={onDisconnect}
            className="text-[10px] font-sans uppercase tracking-wide text-charcoal/45 dark:text-cream-400/45 hover:underline"
          >
            Disconnect
          </button>
        )}
      </div>

      {connected ? (
        <div className="mt-1.5 text-sm font-serif text-charcoal dark:text-cream-100">
          <span className="italic">{link?.club_name ?? 'Club'}</span>
          {link?.league_name ? (
            <span className="text-charcoal/50 dark:text-cream-400/50"> · {link.league_name}</span>
          ) : null}
          {link?.bag?.budget_eur_m != null ? (
            <span className="text-charcoal/50 dark:text-cream-400/50">
              {' '}
              · €{link.bag.budget_eur_m}m
            </span>
          ) : null}
          {link?.last_synced_at ? (
            <span className="block text-[11px] font-sans text-charcoal/40 dark:text-cream-400/40 mt-0.5">
              Synced {new Date(link.last_synced_at).toLocaleString()}
              {link.bag?.stale ? ' · stale' : ''}
            </span>
          ) : null}
          <button
            type="button"
            disabled={syncing}
            onClick={() => onSync(link!.league_id, link!.club_id)}
            className="mt-1.5 text-[11px] font-sans uppercase tracking-wide text-emerald-700 dark:text-emerald-400 hover:underline disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : 'Refresh'}
          </button>
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
