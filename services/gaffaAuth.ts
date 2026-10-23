import type {
  GaffaAuthUser,
  GaffaClubContextResponse,
  GaffaFreeAgent,
  GaffaLeagueSettings,
  GaffaLineup,
  GaffaMatchup,
  GaffaOpenAuction,
  GaffaOpenListing,
  GaffaRosterPlayer,
  GaffaStandings,
  GaffaUserClub,
} from '../types';

const GAFFA_SUPABASE_URL = 'https://hnkavimrsbytsesdzwvj.supabase.co';
const GAFFA_SUPABASE_PUBLISHABLE_KEY =
  'sb_publishable_t1EWa_vXscUV_u6M7Xu7JA_uWwdwzdo';

export const gaffaSupabase =
  typeof window !== 'undefined' && (window as any).supabase
    ? (window as any).supabase.createClient(
        GAFFA_SUPABASE_URL,
        GAFFA_SUPABASE_PUBLISHABLE_KEY,
        {
          auth: {
            storageKey: 'futbolpedia-gaffa-auth',
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
          },
        },
      )
    : null;

export function isGaffaSupabaseReady(): boolean {
  return Boolean(gaffaSupabase);
}

function mapSupabaseUser(raw: any): GaffaAuthUser | null {
  if (!raw?.id) return null;
  return {
    id: String(raw.id),
    email: typeof raw.email === 'string' ? raw.email : undefined,
  };
}

export async function getGaffaSessionUser(): Promise<GaffaAuthUser | null> {
  if (!gaffaSupabase) return null;
  try {
    const { data, error } = await gaffaSupabase.auth.getSession();
    if (error || !data?.session?.user) return null;
    return mapSupabaseUser(data.session.user);
  } catch {
    return null;
  }
}

export function onGaffaAuthStateChange(
  callback: (user: GaffaAuthUser | null) => void,
): () => void {
  if (!gaffaSupabase) return () => {};
  const { data } = gaffaSupabase.auth.onAuthStateChange(
    (_event: string, session: any) => {
      callback(mapSupabaseUser(session?.user));
    },
  );
  return () => {
    data?.subscription?.unsubscribe?.();
  };
}

export async function signInGaffaWithPassword(
  email: string,
  password: string,
): Promise<GaffaAuthUser> {
  if (!gaffaSupabase) {
    throw new Error('Gaffa authentication client is unavailable');
  }
  const trimmedEmail = email.trim();
  if (!trimmedEmail || !password) {
    throw new Error('Enter both email and password');
  }
  const { data, error } = await gaffaSupabase.auth.signInWithPassword({
    email: trimmedEmail,
    password,
  });
  if (error) {
    throw new Error(error.message || 'Sign-in failed');
  }
  const user = mapSupabaseUser(data?.user ?? data?.session?.user);
  if (!user) {
    throw new Error('Sign-in succeeded without a user session');
  }
  return user;
}

export async function signInGaffaWithGoogle(): Promise<void> {
  if (!gaffaSupabase) {
    throw new Error('Gaffa authentication client is unavailable');
  }
  const redirectTo =
    typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}?gaffa_auth=1`
      : undefined;
  const { error } = await gaffaSupabase.auth.signInWithOAuth({
    provider: 'google',
    options: redirectTo ? { redirectTo } : undefined,
  });
  if (error) {
    throw new Error(error.message || 'Google sign-in failed');
  }
}

export async function signOutGaffa(): Promise<void> {
  if (!gaffaSupabase) return;
  await gaffaSupabase.auth.signOut();
}

export async function fetchMyGaffaClubs(
  userId?: string,
): Promise<GaffaUserClub[]> {
  if (!gaffaSupabase) return [];
  let uid = userId;
  if (!uid) {
    const user = await getGaffaSessionUser();
    uid = user?.id;
  }
  if (!uid) return [];

  const { data: teamsData, error: teamsErr } = await gaffaSupabase
    .from('teams')
    .select('id, league_id, team_name, abbreviation, faab_budget, created_at')
    .eq('user_id', uid)
    .order('created_at', { ascending: false });

  if (teamsErr) {
    throw new Error(teamsErr.message || 'Could not load your Gaffa clubs');
  }

  const rows: any[] = Array.isArray(teamsData) ? teamsData : [];
  if (rows.length === 0) return [];

  const leagueIds = Array.from(
    new Set(rows.map((r) => r.league_id).filter(Boolean)),
  );

  const leaguesById = new Map<string, any>();
  if (leagueIds.length > 0) {
    const { data: leaguesData } = await gaffaSupabase
      .from('leagues')
      .select('id, name, season, current_season, status')
      .in('id', leagueIds);
    for (const lg of leaguesData ?? []) {
      if (lg?.id) leaguesById.set(String(lg.id), lg);
    }
  }

  return rows.map((row) => {
    const lg = leaguesById.get(String(row.league_id));
    return {
      club_id: String(row.id),
      club_name: String(row.team_name || 'Club'),
      abbreviation: row.abbreviation ?? null,
      budget_eur_m: Number(row.faab_budget ?? 0),
      league_id: String(row.league_id),
      league_name: String(lg?.name || 'Gaffa League'),
      season: lg?.current_season ?? lg?.season ?? null,
      league_status: lg?.status ? String(lg.status) : null,
    };
  });
}

function computeAgeFromDob(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const birthMs = Date.parse(dob);
  if (Number.isNaN(birthMs)) return null;
  const diffYears = (Date.now() - birthMs) / (365.25 * 24 * 60 * 60 * 1000);
  return Math.max(15, Math.floor(diffYears));
}

function normalizeSecondaryPositions(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((s) => String(s).trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.replace(/^\{|\}$/g, '').trim();
    if (!trimmed) return [];
    return trimmed
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Assemble GaffaClubContextResponse directly from Gaffa's RLS-protected
 * Supabase tables using the signed-in manager's session.
 */
export async function fetchGaffaContextFromSupabase(
  leagueId: string,
  clubId: string,
): Promise<GaffaClubContextResponse> {
  if (!gaffaSupabase) {
    throw new Error('Gaffa Supabase client is not initialized');
  }

  const [
    leagueRes,
    teamsRes,
    rosterEntriesRes,
    activePlayersRes,
    matchupsRes,
    listingsRes,
    auctionsRes,
  ] = await Promise.all([
    gaffaSupabase
      .from('leagues')
      .select(
        'id, name, season, current_season, max_teams, roster_size, bench_size, ir_size, taxi_size, taxi_age_limit, faab_budget, is_dynasty, status, free_agent_bid_floor, max_loan_outs, max_loan_ins',
      )
      .eq('id', leagueId)
      .single(),
    gaffaSupabase
      .from('teams')
      .select(
        'id, league_id, user_id, team_name, faab_budget, total_points, academy_slots, ir_slots, loan_out_slots',
      )
      .eq('league_id', leagueId),
    gaffaSupabase
      .from('roster_entries')
      .select('id, team_id, player_id, status, held_at, held_source')
      .eq('league_id', leagueId),
    gaffaSupabase
      .from('players')
      .select(
        'id, name, web_name, date_of_birth, pl_team, primary_position, secondary_positions, market_value, is_active',
      )
      .eq('is_active', true)
      .order('market_value', { ascending: false })
      .limit(1000),
    gaffaSupabase
      .from('matchups')
      .select(
        'id, gameweek, team_a_id, team_b_id, score_a, score_b, lineup_a, lineup_b, status, winner_team_id',
      )
      .eq('league_id', leagueId)
      .order('gameweek', { ascending: true }),
    gaffaSupabase
      .from('player_sale_listings')
      .select(
        'id, seller_team_id, player_id, min_bid, buy_now_price, ask_price, status, open_to_trade, open_to_sale, open_to_loan, auction_expires_at',
      )
      .eq('league_id', leagueId)
      .eq('status', 'pending'),
    gaffaSupabase
      .from('auction_state')
      .select('player_id, kind, status, highest_bid, expires_at')
      .eq('league_id', leagueId)
      .eq('status', 'live'),
  ]);

  if (leagueRes.error || !leagueRes.data) {
    throw new Error(
      leagueRes.error?.message || 'League not found or you are not a member',
    );
  }

  const league = leagueRes.data;
  const teams: any[] = Array.isArray(teamsRes.data) ? teamsRes.data : [];
  const clubTeam = teams.find((t) => String(t.id) === clubId);
  if (!clubTeam) {
    throw new Error('Club not found in this league');
  }

  const teamsById = new Map<string, any>();
  for (const t of teams) {
    teamsById.set(String(t.id), t);
  }

  const allRosterEntries: any[] = Array.isArray(rosterEntriesRes.data)
    ? rosterEntriesRes.data
    : [];
  const activePlayers: any[] = Array.isArray(activePlayersRes.data)
    ? activePlayersRes.data
    : [];
  const matchups: any[] = Array.isArray(matchupsRes.data)
    ? matchupsRes.data
    : [];
  const openListingsRaw: any[] = Array.isArray(listingsRes.data)
    ? listingsRes.data
    : [];
  const liveAuctionsRaw: any[] = Array.isArray(auctionsRes.data)
    ? auctionsRes.data
    : [];

  const playersById = new Map<string, any>();
  for (const p of activePlayers) {
    if (p?.id) playersById.set(String(p.id), p);
  }

  // Fetch any inactive/departed players referenced on rosters, listings, or auctions
  const referencedIds = new Set<string>();
  for (const r of allRosterEntries) {
    if (r?.player_id && !playersById.has(String(r.player_id))) {
      referencedIds.add(String(r.player_id));
    }
  }
  for (const l of openListingsRaw) {
    if (l?.player_id && !playersById.has(String(l.player_id))) {
      referencedIds.add(String(l.player_id));
    }
  }
  for (const a of liveAuctionsRaw) {
    if (a?.player_id && !playersById.has(String(a.player_id))) {
      referencedIds.add(String(a.player_id));
    }
  }

  if (referencedIds.size > 0) {
    const { data: extraPlayers } = await gaffaSupabase
      .from('players')
      .select(
        'id, name, web_name, date_of_birth, pl_team, primary_position, secondary_positions, market_value, is_active',
      )
      .in('id', Array.from(referencedIds));
    for (const p of extraPlayers ?? []) {
      if (p?.id) playersById.set(String(p.id), p);
    }
  }

  // 1. Club roster
  const myRosterEntries = allRosterEntries.filter(
    (r) => String(r.team_id) === clubId,
  );
  const roster: GaffaRosterPlayer[] = myRosterEntries.map((r) => {
    const p = playersById.get(String(r.player_id));
    const status = r.held_at ? 'held' : String(r.status || 'active');
    return {
      player_id: String(r.player_id),
      name: String(p?.name || 'Unknown Player'),
      display_name: p?.web_name ? String(p.web_name) : undefined,
      primary_position: String(p?.primary_position || 'CM'),
      secondary_positions: normalizeSecondaryPositions(p?.secondary_positions),
      status,
      pl_team: p?.pl_team ?? null,
    };
  });

  // 2. Standings across all teams in the league
  const statsByTeam = new Map<
    string,
    {
      wins: number;
      draws: number;
      losses: number;
      played: number;
      pf: number;
      pa: number;
    }
  >();
  for (const t of teams) {
    statsByTeam.set(String(t.id), {
      wins: 0,
      draws: 0,
      losses: 0,
      played: 0,
      pf: 0,
      pa: 0,
    });
  }

  for (const m of matchups) {
    if (String(m.status) !== 'completed') continue;
    const aId = m.team_a_id ? String(m.team_a_id) : null;
    const bId = m.team_b_id ? String(m.team_b_id) : null;
    const scoreA = Number(m.score_a ?? 0);
    const scoreB = Number(m.score_b ?? 0);
    const winnerId = m.winner_team_id ? String(m.winner_team_id) : null;

    if (aId && statsByTeam.has(aId)) {
      const st = statsByTeam.get(aId)!;
      st.played += 1;
      st.pf += scoreA;
      st.pa += scoreB;
      if (winnerId === aId) st.wins += 1;
      else if (winnerId && winnerId === bId) st.losses += 1;
      else if (!winnerId && bId) st.draws += 1;
    }
    if (bId && statsByTeam.has(bId)) {
      const st = statsByTeam.get(bId)!;
      st.played += 1;
      st.pf += scoreB;
      st.pa += scoreA;
      if (winnerId === bId) st.wins += 1;
      else if (winnerId && winnerId === aId) st.losses += 1;
      else if (!winnerId && aId) st.draws += 1;
    }
  }

  const rankedTeams = [...teams].sort((a, b) => {
    const sa = statsByTeam.get(String(a.id))!;
    const sb = statsByTeam.get(String(b.id))!;
    const ptsA = sa.wins * 3 + sa.draws;
    const ptsB = sb.wins * 3 + sb.draws;
    if (ptsB !== ptsA) return ptsB - ptsA;
    if (sb.pf !== sa.pf) return sb.pf - sa.pf;
    return Number(b.total_points ?? 0) - Number(a.total_points ?? 0);
  });

  const rankIdx = rankedTeams.findIndex((t) => String(t.id) === clubId);
  const myStats = statsByTeam.get(clubId) ?? {
    wins: 0,
    draws: 0,
    losses: 0,
    played: 0,
    pf: 0,
    pa: 0,
  };
  const standings: GaffaStandings = {
    rank: rankIdx >= 0 ? rankIdx + 1 : null,
    of_teams: teams.length,
    played: myStats.played,
    wins: myStats.wins,
    draws: myStats.draws,
    losses: myStats.losses,
    points_for: Math.round(myStats.pf * 10) / 10,
    points_against: Math.round(myStats.pa * 10) / 10,
  };

  // 3. Active / upcoming matchup & saved lineup
  const myMatchups = matchups.filter(
    (m) => String(m.team_a_id) === clubId || String(m.team_b_id) === clubId,
  );
  const liveMatchup = myMatchups.find(
    (m) => String(m.status) === 'live' || String(m.status) === 'in_progress',
  );
  const nextScheduled = myMatchups.find(
    (m) => String(m.status) === 'scheduled',
  );
  const lastCompleted = [...myMatchups]
    .reverse()
    .find((m) => String(m.status) === 'completed');
  const focusMatchup = liveMatchup ?? nextScheduled ?? lastCompleted ?? null;

  let matchup: GaffaMatchup | null = null;
  if (focusMatchup) {
    const isTeamA = String(focusMatchup.team_a_id) === clubId;
    const oppId = isTeamA ? focusMatchup.team_b_id : focusMatchup.team_a_id;
    const oppTeam = oppId ? teamsById.get(String(oppId)) : null;
    matchup = {
      gameweek: Number(focusMatchup.gameweek),
      opponent_club_name: oppTeam?.team_name ? String(oppTeam.team_name) : null,
      status: String(focusMatchup.status),
      your_score: isTeamA
        ? focusMatchup.score_a != null
          ? Number(focusMatchup.score_a)
          : null
        : focusMatchup.score_b != null
          ? Number(focusMatchup.score_b)
          : null,
      opponent_score: isTeamA
        ? focusMatchup.score_b != null
          ? Number(focusMatchup.score_b)
          : null
        : focusMatchup.score_a != null
          ? Number(focusMatchup.score_a)
          : null,
    };
  }

  // Find the best lineup JSON for the club (focus matchup first, then latest matchup with a lineup)
  const extractRawLineup = (m: any) => {
    if (!m) return null;
    const isTeamA = String(m.team_a_id) === clubId;
    const raw = isTeamA ? m.lineup_a : m.lineup_b;
    if (raw && (Array.isArray(raw.starters) || Array.isArray(raw.bench))) {
      return { raw, gw: Number(m.gameweek) };
    }
    return null;
  };

  let chosenLineup = extractRawLineup(focusMatchup);
  if (!chosenLineup) {
    for (const m of [...myMatchups].reverse()) {
      const candidate = extractRawLineup(m);
      if (candidate) {
        chosenLineup = candidate;
        break;
      }
    }
  }

  const resolvePlayerName = (playerId: string): string => {
    const p = playersById.get(playerId);
    if (p?.name) return String(p.name);
    const rp = roster.find((r) => r.player_id === playerId);
    return rp?.name ?? 'Unknown Player';
  };

  let lineup: GaffaLineup | null = null;
  if (chosenLineup) {
    const { raw, gw } = chosenLineup;
    lineup = {
      formation: raw.formation ? String(raw.formation) : null,
      gameweek: gw,
      starters: (Array.isArray(raw.starters) ? raw.starters : []).map(
        (s: any) => {
          const pid = String(s.player_id || '');
          return {
            player_id: pid,
            name: s.name ? String(s.name) : resolvePlayerName(pid),
            slot: String(s.slot || 'CM'),
          };
        },
      ),
      bench: (Array.isArray(raw.bench) ? raw.bench : []).map((b: any) => {
        const pid = String(b.player_id || '');
        return {
          player_id: pid,
          name: b.name ? String(b.name) : resolvePlayerName(pid),
          slot: String(b.slot || 'FLEX'),
        };
      }),
    };
  }

  // 4. Open listings & live auctions
  const open_listings: GaffaOpenListing[] = openListingsRaw.map((l) => {
    const p = playersById.get(String(l.player_id));
    const sellerTeam = teamsById.get(String(l.seller_team_id));
    return {
      player_id: String(l.player_id),
      name: String(p?.name || 'Unknown Player'),
      position: String(p?.primary_position || 'CM'),
      seller_club_id: String(l.seller_team_id),
      seller_club_name: String(sellerTeam?.team_name || 'Club'),
      yours: String(l.seller_team_id) === clubId,
      status: String(l.status || 'pending'),
      min_bid_eur_m: l.min_bid != null ? Number(l.min_bid) : null,
      ask_eur_m: l.ask_price != null ? Number(l.ask_price) : null,
      release_clause_eur_m:
        l.buy_now_price != null ? Number(l.buy_now_price) : null,
      open_to_trade: Boolean(l.open_to_trade),
      open_to_sale: Boolean(l.open_to_sale),
      open_to_loan: Boolean(l.open_to_loan),
      expires_at: l.auction_expires_at ? String(l.auction_expires_at) : null,
    };
  });

  const liveAuctionIds = new Set<string>();
  const open_auctions: GaffaOpenAuction[] = liveAuctionsRaw.map((a) => {
    const pid = String(a.player_id);
    liveAuctionIds.add(pid);
    const p = playersById.get(pid);
    return {
      player_id: pid,
      name: String(p?.name || 'Unknown Player'),
      position: String(p?.primary_position || 'CM'),
      kind: String(a.kind || 'free_agent'),
      highest_bid_eur_m: a.highest_bid != null ? Number(a.highest_bid) : null,
      expires_at: a.expires_at ? String(a.expires_at) : null,
    };
  });

  // 5. Unowned active PL free agents
  const ownedPlayerIds = new Set<string>(
    allRosterEntries.map((r) => String(r.player_id)),
  );
  const free_agents: GaffaFreeAgent[] = activePlayers
    .filter((p) => p?.id && !ownedPlayerIds.has(String(p.id)))
    .map((p) => {
      const pid = String(p.id);
      return {
        player_id: pid,
        name: String(p.name || 'Unknown Player'),
        display_name: p.web_name ? String(p.web_name) : undefined,
        position: String(p.primary_position || 'CM'),
        pl_team: p.pl_team ?? null,
        market_value_eur_m:
          p.market_value != null ? Number(p.market_value) : null,
        age: computeAgeFromDob(p.date_of_birth),
        live_auction: liveAuctionIds.has(pid),
      };
    });

  // 6. League settings
  const settings: GaffaLeagueSettings = {
    roster_size: Number(league.roster_size ?? 22),
    bench_size: Number(league.bench_size ?? 4),
    ir_size: Number(clubTeam.ir_slots ?? league.ir_size ?? 2),
    taxi_size:
      clubTeam.academy_slots != null
        ? Number(clubTeam.academy_slots)
        : league.taxi_size != null
          ? Number(league.taxi_size)
          : null,
    taxi_age_limit:
      league.taxi_age_limit != null ? Number(league.taxi_age_limit) : null,
    max_teams: Number(league.max_teams ?? teams.length),
    is_dynasty: Boolean(league.is_dynasty),
    starting_faab_eur_m:
      league.faab_budget != null ? Number(league.faab_budget) : null,
    free_agent_bid_floor:
      league.free_agent_bid_floor != null
        ? Number(league.free_agent_bid_floor)
        : 0.6,
    max_loan_outs:
      clubTeam.loan_out_slots != null
        ? Number(clubTeam.loan_out_slots)
        : league.max_loan_outs != null
          ? Number(league.max_loan_outs)
          : null,
    max_loan_ins:
      league.max_loan_ins != null ? Number(league.max_loan_ins) : null,
    league_status: league.status ? String(league.status) : null,
  };

  return {
    league_id: String(league.id),
    club_id: String(clubTeam.id),
    league_name: String(league.name || 'Gaffa League'),
    club_name: String(clubTeam.team_name || 'Club'),
    budget_eur_m: Number(clubTeam.faab_budget ?? 0),
    roster,
    standings,
    matchup,
    lineup,
    settings,
    open_listings,
    open_auctions,
    free_agents,
    synced_at: new Date().toISOString(),
  };
}
