import express from "express";
import { createServer as createViteServer } from "vite";
import cors from "cors";
import path from "path";
import axios from "axios";
import { pickCurrentCoach } from "./packages/engine/src/gates/managerMentions.ts";
import { getRealWorldFootballSeason } from "./prompts/scoutCore";
import {
  LINEUP_MATCHES,
  mergeAbsences,
  parseAbsences,
  parseTeamLineup,
  type TeamAbsence,
  type TeamLineup,
} from "./services/teamLineups";
import { createLiveFootball } from "./services/liveFootball";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // API Routes
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Proxy to Gaffa club-context integration (secret stays server-side).
  app.get("/api/gaffa/context", async (req, res) => {
    const leagueId = typeof req.query.leagueId === "string" ? req.query.leagueId.trim() : "";
    const teamId = typeof req.query.teamId === "string" ? req.query.teamId.trim() : "";
    if (!leagueId || !teamId) {
      return res.status(400).json({ error: "Missing leagueId or teamId" });
    }

    const base = (process.env.GAFFA_BASE_URL || "").replace(/\/$/, "");
    const secret = process.env.FUTBOLPEDIA_READ_SECRET;
    if (!base || !secret) {
      return res.status(503).json({
        error: "Gaffa connect is not configured (GAFFA_BASE_URL / FUTBOLPEDIA_READ_SECRET)",
      });
    }

    try {
      const url = `${base}/api/integrations/futbolpedia/context?leagueId=${encodeURIComponent(leagueId)}&teamId=${encodeURIComponent(teamId)}`;
      const upstream = await axios.get(url, {
        headers: { "x-futbolpedia-secret": secret },
        validateStatus: () => true,
        timeout: 30000,
      });
      if (upstream.status === 401) {
        return res.status(401).json({ error: "Gaffa rejected the read secret" });
      }
      if (upstream.status === 404) {
        return res.status(404).json({ error: upstream.data?.error || "League or club not found" });
      }
      if (upstream.status >= 400) {
        return res.status(502).json({
          error: upstream.data?.error || `Gaffa error (${upstream.status})`,
        });
      }
      return res.json(upstream.data);
    } catch (err: any) {
      console.error("[gaffa/context]", err?.message || err);
      return res.status(502).json({ error: "Could not reach Gaffa" });
    }
  });

  // In-app Gaffa chat: Gaffa (session-auth) proxies here with the read secret.
  // Always loads the live club bag (roster, listings, auctions, unowned FA pool, settings) before
  // Gaffa-mode prompt assembly — first turn included; the user need not say "Gaffa".
  // Prose only (+ optional trade lock), never a dossier card.
  app.post("/api/gaffa/chat", async (req, res) => {
    const { authorizeGaffaReadSecret, runGaffaChatTurn } = await import("./services/gaffaChatApi");
    if (!authorizeGaffaReadSecret(req.headers["x-futbolpedia-secret"])) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body ?? {};
    try {
      const result = await runGaffaChatTurn({
        message: body.message,
        history: Array.isArray(body.history) ? body.history : [],
        leagueId: body.leagueId ?? body.league_id,
        clubId: body.clubId ?? body.club_id ?? body.teamId,
        speed: body.speed === "fast" ? "fast" : "default",
      });
      return res.json(result);
    } catch (err: any) {
      const status = Number(err?.status);
      if (status >= 400 && status < 600) {
        return res.status(status).json({ error: err.message || "Chat failed" });
      }
      console.error("[gaffa/chat]", err?.message || err);
      return res.status(502).json({ error: "Gaffa chat failed" });
    }
  });

  const API_KEY = process.env.API_FOOTBALL_KEY;
  const API_URL = "https://v3.football.api-sports.io";
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;
  console.log(`[startup] GEMINI_API_KEY set: ${!!GEMINI_API_KEY} (${GEMINI_API_KEY ? GEMINI_API_KEY.slice(0, 6) + '...' : 'MISSING'})`);
  // Without it, club research has no lineups, injury list or squad; chat answers fall back to web search.
  console.log(`[startup] API_FOOTBALL_KEY set: ${!!API_KEY}`);

  // API-Football answers plan limits, quota and bad parameters with HTTP 200, an empty response and
  // an `errors` field, so a refused call looks like "no data" unless the errors are logged.
  const apiFootballGet = (endpoint: string, params: Record<string, unknown>, timeout?: number) =>
    axios
      .get(`${API_URL}/${endpoint}`, {
        params,
        headers: { "x-apisports-key": API_KEY },
        ...(timeout ? { timeout } : {}),
      })
      .then((res) => {
        const errors = res.data?.errors;
        const hasErrors = Array.isArray(errors) ? errors.length > 0 : errors && Object.keys(errors).length > 0;
        if (hasErrors) console.warn(`[api-football] ${endpoint} ${JSON.stringify(params)} refused: ${JSON.stringify(errors)}`);
        return res;
      })
      .catch((err) => {
        console.warn(`[api-football] ${endpoint} ${JSON.stringify(params)} failed: ${err?.message || err}`);
        throw err;
      });

  const PLAYER_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
  const playerFactCache = new Map<string, { expiresAt: number; payload: any }>();
  const teamIdCache = new Map<string, number>();
  const teamContextCache = new Map<
    number,
    {
      expiresAt: number;
      coach: string | null;
      coachSince: string | null;
      recentFixtures: any[];
      upcomingFixtures: any[];
      squad: Array<{ name: string; position: string | null; age: number | null }>;
      recentLineups: TeamLineup[];
      /** Null when the injury list couldn't be read, so "nobody injured" is never assumed. */
      unavailable: TeamAbsence[] | null;
    }
  >();

  const getTeamContextById = async (teamId: number) => {
    const cached = teamContextCache.get(teamId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }

    const [lastFixturesRes, nextFixturesRes, coachRes, squadRes] = await Promise.allSettled([
      apiFootballGet("fixtures", { team: teamId, last: 5 }, 4500),
      apiFootballGet("fixtures", { team: teamId, next: 3 }, 4500),
      apiFootballGet("coachs", { team: teamId }, 4500),
      apiFootballGet("players/squads", { team: teamId }, 4500),
    ]);

    const formatFixture = (f: any) => ({
      date: f?.fixture?.date ? String(f.fixture.date).slice(0, 10) : null,
      competition: f?.league?.name ?? null,
      homeTeam: f?.teams?.home?.name ?? null,
      awayTeam: f?.teams?.away?.name ?? null,
      score:
        f?.goals?.home != null && f?.goals?.away != null
          ? `${f.goals.home}-${f.goals.away}`
          : "Scheduled",
    });

    const recentFixtures =
      lastFixturesRes.status === "fulfilled"
        ? (lastFixturesRes.value.data?.response ?? []).map(formatFixture)
        : [];

    const upcomingFixtures =
      nextFixturesRes.status === "fulfilled"
        ? (nextFixturesRes.value.data?.response ?? []).map(formatFixture)
        : [];

    // API-Football's record lags managerial changes. The app treats it only as a cross-check for
    // the live manager lookup (services/clubManagers.ts), never as the source of truth.
    const { coach, coachSince } =
      coachRes.status === "fulfilled"
        ? pickCurrentCoach(coachRes.value.data?.response, teamId)
        : { coach: null, coachSince: null };

    // Who actually played and who is out: lineups of the latest matches and the injury lists for
    // the last and next fixtures. These need the fixture ids, so they follow the first round.
    const fixturesOf = (r: PromiseSettledResult<any>): any[] =>
      r.status === "fulfilled" && Array.isArray(r.value.data?.response) ? r.value.data.response : [];
    const played = fixturesOf(lastFixturesRes)
      .filter((f: any) => f?.goals?.home != null && f?.fixture?.id)
      .sort((a: any, b: any) => (b.fixture.timestamp ?? 0) - (a.fixture.timestamp ?? 0))
      .slice(0, LINEUP_MATCHES);
    const nextFixtureId = fixturesOf(nextFixturesRes)
      .filter((f: any) => f?.fixture?.id)
      .sort((a: any, b: any) => (a.fixture.timestamp ?? 0) - (b.fixture.timestamp ?? 0))[0]?.fixture.id;
    const injuryFixtureIds = [nextFixtureId, played[0]?.fixture.id].filter(Boolean);
    const [lineupResults, injuryResults] = await Promise.all([
      Promise.allSettled(played.map((f: any) => apiFootballGet("fixtures/lineups", { fixture: f.fixture.id }, 4500))),
      Promise.allSettled(injuryFixtureIds.map((id) => apiFootballGet("injuries", { fixture: id }, 4500))),
    ]);
    const recentLineups = played
      .map((f: any, i: number) => {
        const r = lineupResults[i];
        if (r.status !== "fulfilled") return null;
        const home = f.teams?.home?.id === teamId;
        return parseTeamLineup(r.value.data?.response, teamId, {
          date: f.fixture.date ? String(f.fixture.date).slice(0, 10) : null,
          competition: f.league?.name ?? null,
          opponent: (home ? f.teams?.away?.name : f.teams?.home?.name) ?? null,
        });
      })
      .filter((l: TeamLineup | null): l is TeamLineup => l !== null);
    const injuryLists = injuryResults
      .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled" && Array.isArray(r.value.data?.response))
      .map((r) => parseAbsences(r.value.data.response, teamId));
    const unavailable = injuryLists.length > 0 ? mergeAbsences(...injuryLists) : null;

    const squad: Array<{ name: string; position: string | null; age: number | null }> =
      squadRes.status === "fulfilled"
        ? (squadRes.value.data?.response?.[0]?.players ?? [])
            .filter((p: any) => p?.name)
            .map((p: any) => ({
              name: String(p.name),
              position: p.position ? String(p.position) : null,
              age: typeof p.age === "number" ? p.age : null,
            }))
        : [];

    console.log(
      `[api-football] team ${teamId}: ${recentFixtures.length} recent fixtures, ${recentLineups.length}/${played.length} lineups, injuries ${
        unavailable ? unavailable.length : "unread"
      }, squad ${squad.length}`,
    );

    // A context with no recent fixtures means the calls failed or were refused; keep it only
    // briefly so the next turn tries again instead of reusing the empty answer for hours.
    const entry = {
      expiresAt: Date.now() + (recentFixtures.length > 0 ? PLAYER_CACHE_TTL_MS : 5 * 60 * 1000),
      coach,
      coachSince,
      recentFixtures,
      upcomingFixtures,
      squad,
      recentLineups,
      unavailable,
    };
    teamContextCache.set(teamId, entry);
    return entry;
  };

  const formatHeightImperial = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const cmMatch = String(raw).match(/(\d{2,3})\s*cm/i);
    if (cmMatch) {
      const cm = parseInt(cmMatch[1], 10);
      if (cm > 100) {
        const totalInches = Math.round(cm / 2.54);
        const feet = Math.floor(totalInches / 12);
        const inches = totalInches % 12;
        return `${feet}'${inches}"`;
      }
    }
    return String(raw).trim() || null;
  };

  const formatWeightLbs = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const kgMatch = String(raw).match(/(\d{2,3})\s*kg/i);
    if (kgMatch) {
      const kg = parseInt(kgMatch[1], 10);
      if (kg > 35) {
        return `${Math.round(kg * 2.20462)} lbs`;
      }
    }
    return String(raw).trim() || null;
  };

  app.get("/api/football/player", async (req, res) => {
    const rawName = typeof req.query.name === "string" ? req.query.name.trim() : "";
    const defaultSeason = getRealWorldFootballSeason().seasonStartYear;
    const season = typeof req.query.season === "string" ? parseInt(req.query.season, 10) || defaultSeason : defaultSeason;
    if (!rawName || rawName.length < 2) {
      return res.status(400).json({ error: "Missing player name" });
    }
    if (!API_KEY) {
      return res.json({ available: false, player: null });
    }

    const cacheKey = `${rawName.toLowerCase()}:${season}`;
    const cached = playerFactCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json(cached.payload);
    }

    try {
      const tokens = rawName.split(/\s+/).filter(Boolean);
      const searchTerm = tokens.length > 1 ? tokens[tokens.length - 1] : rawName;

      const profileRes = await apiFootballGet("players/profiles", { search: searchTerm }, 6000);

      const candidates: any[] = profileRes.data?.response ?? [];
      if (candidates.length === 0) {
        const emptyPayload = { available: true, player: null };
        playerFactCache.set(cacheKey, { expiresAt: Date.now() + PLAYER_CACHE_TTL_MS, payload: emptyPayload });
        return res.json(emptyPayload);
      }

      const lowerFull = rawName.toLowerCase();
      const matchedEntry =
        candidates.find((c) => {
          const p = c?.player;
          if (!p) return false;
          const full = `${p.firstname || ""} ${p.lastname || ""}`.toLowerCase();
          return (
            String(p.name || "").toLowerCase() === lowerFull ||
            full.includes(lowerFull) ||
            tokens.every((t) => full.includes(t.toLowerCase()) || String(p.name || "").toLowerCase().includes(t.toLowerCase()))
          );
        }) || candidates[0];

      const basePlayer = matchedEntry.player;
      let currentClub: string | null = null;
      let league: string | null = null;
      let injured: boolean | null = basePlayer?.injured ?? null;
      let seasonStats: any = null;
      let coach: string | null = null;
      let coachSince: string | null = null;
      let recentFixtures: any[] = [];

      if (basePlayer?.id) {
        try {
          const statsRes = await apiFootballGet("players", { id: basePlayer.id, season }, 6000);
          const statEntry = statsRes.data?.response?.[0];
          const allStats: any[] = Array.isArray(statEntry?.statistics) ? statEntry.statistics : [];
          if (statEntry?.player) {
            injured = statEntry.player.injured ?? injured;
          }
          if (allStats.length > 0) {
            const natLower = String(basePlayer.nationality || "").toLowerCase();
            const clubStats = allStats.filter((s) => {
              const teamName = String(s?.team?.name || "").toLowerCase();
              return !natLower || teamName !== natLower;
            });
            const effectiveStats = clubStats.length > 0 ? clubStats : allStats;
            const primaryClubId = effectiveStats[0]?.team?.id;
            const sameClubStats = primaryClubId
              ? effectiveStats.filter((s) => s?.team?.id === primaryClubId)
              : [effectiveStats[0]];

            // Pick the competition with the most minutes for the primary league label & rating
            const mainCompStat = [...sameClubStats].sort(
              (a, b) => (b?.games?.minutes ?? 0) - (a?.games?.minutes ?? 0),
            )[0] || effectiveStats[0];

            currentClub = mainCompStat?.team?.name ?? effectiveStats[0]?.team?.name ?? null;
            league = mainCompStat?.league?.name ?? effectiveStats[0]?.league?.name ?? null;

            const sumField = (getter: (s: any) => number | null | undefined): number =>
              sameClubStats.reduce((acc, s) => acc + (Number(getter(s)) || 0), 0);

            seasonStats = {
              season,
              appearances: sumField((s) => s?.games?.appearences),
              lineups: sumField((s) => s?.games?.lineups),
              minutes: sumField((s) => s?.games?.minutes),
              goals: sumField((s) => s?.goals?.total),
              assists: sumField((s) => s?.goals?.assists),
              keyPasses: sumField((s) => s?.passes?.key),
              tackles: sumField((s) => s?.tackles?.total),
              interceptions: sumField((s) => s?.tackles?.interceptions),
              duelsWon: sumField((s) => s?.duels?.won),
              rating: mainCompStat?.games?.rating ?? null,
            };
            if (primaryClubId) {
              if (currentClub) {
                teamIdCache.set(currentClub.toLowerCase(), primaryClubId);
              }
              const teamCtxPromise = getTeamContextById(primaryClubId);
              const teamCtx = await Promise.race([
                teamCtxPromise,
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 900)),
              ]);
              if (teamCtx) {
                coach = teamCtx.coach;
                coachSince = teamCtx.coachSince;
                recentFixtures = teamCtx.recentFixtures;
              } else {
                void teamCtxPromise
                  .then((resolvedCtx) => {
                    const cachedEntry = playerFactCache.get(cacheKey);
                    if (cachedEntry?.payload?.player && resolvedCtx) {
                      cachedEntry.payload.player.coach = resolvedCtx.coach;
                      cachedEntry.payload.player.coachSince = resolvedCtx.coachSince;
                      cachedEntry.payload.player.recentFixtures = resolvedCtx.recentFixtures;
                    }
                  })
                  .catch(() => {});
              }
            }
          }
        } catch (statsErr) {
          // Non-fatal: still return profile bio facts
        }
      }

      const payload = {
        available: true,
        player: {
          id: basePlayer.id,
          name: basePlayer.name || `${basePlayer.firstname || ""} ${basePlayer.lastname || ""}`.trim(),
          firstname: basePlayer.firstname,
          lastname: basePlayer.lastname,
          age: basePlayer.age ?? null,
          nationality: basePlayer.nationality ?? null,
          height: formatHeightImperial(basePlayer.height),
          weight: formatWeightLbs(basePlayer.weight),
          position: basePlayer.position ?? null,
          currentClub,
          league,
          coach,
          coachSince,
          injured,
          seasonStats,
          recentFixtures,
        },
      };

      playerFactCache.set(cacheKey, { expiresAt: Date.now() + PLAYER_CACHE_TTL_MS, payload });
      return res.json(payload);
    } catch (error: any) {
      console.warn("[api/football/player] lookup failed:", error?.message || error);
      return res.json({ available: false, player: null });
    }
  });

  app.get("/api/football/squad", async (req, res) => {
    try {
      const { team } = req.query;
      if (!team) return res.status(400).json({ error: "Missing team name" });

      // 1. Search for team
      const teamRes = await apiFootballGet("teams", { search: team as string });

      if (!teamRes.data.response || teamRes.data.response.length === 0) {
        return res.status(404).json({ error: "Team not found" });
      }

      const teamId = teamRes.data.response[0].team.id;
      const teamName = teamRes.data.response[0].team.name;
      if (teamName) teamIdCache.set(String(teamName).toLowerCase(), teamId);
      teamIdCache.set(String(team).toLowerCase().trim(), teamId);

      // 2. Get Squad
      const squadRes = await apiFootballGet("players/squads", { team: teamId });

      res.json(squadRes.data);
    } catch (error: any) {
      console.error(error?.response?.data || error);
      res.status(500).json({ error: "Failed to fetch from API-Football" });
    }
  });

  app.get("/api/football/fixtures", async (req, res) => {
    try {
      const rawTeam = typeof req.query.team === "string" ? req.query.team.trim() : "";
      if (!rawTeam) return res.status(400).json({ error: "Missing team name" });
      if (!API_KEY) return res.json({ available: false, team: rawTeam, recentFixtures: [], upcomingFixtures: [] });

      let teamId = teamIdCache.get(rawTeam.toLowerCase());
      let resolvedTeamName = rawTeam;
      if (!teamId) {
        const teamRes = await apiFootballGet("teams", { search: rawTeam }, 5000);
        const first = teamRes.data?.response?.[0]?.team;
        if (!first?.id) {
          return res.status(404).json({ error: "Team not found" });
        }
        teamId = first.id as number;
        resolvedTeamName = first.name || rawTeam;
        console.log(`[api-football] team "${rawTeam}" resolved to ${first.name} (${first.country ?? "?"}, id ${teamId})`);
        teamIdCache.set(rawTeam.toLowerCase(), teamId);
        if (first.name) teamIdCache.set(String(first.name).toLowerCase(), teamId);
      }

      const ctx = await getTeamContextById(teamId);
      return res.json({
        available: true,
        team: resolvedTeamName,
        coach: ctx.coach,
        coachSince: ctx.coachSince,
        recentFixtures: ctx.recentFixtures,
        upcomingFixtures: ctx.upcomingFixtures,
        squad: ctx.squad,
        recentLineups: ctx.recentLineups,
        unavailable: ctx.unavailable,
      });
    } catch (error: any) {
      console.warn("[api/football/fixtures] lookup failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to fetch fixtures from API-Football" });
    }
  });

  // Current-season facts for chat research and the writer's tools, from ESPN's public match data
  // and the Fantasy Premier League feed (services/liveFootball.ts). Both are free and keyless;
  // API-Football's free plan can't read the current season. Lookups are cached for every user.
  const live = createLiveFootball(async (url) => {
    const res = await axios.get(url, {
      timeout: 6000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Futbolpedia/3.0)", Accept: "application/json" },
    });
    return res.data;
  });
  const liveQuery = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 80) : "");

  app.get("/api/live/club", async (req, res) => {
    const name = liveQuery(req.query.name);
    if (!name) return res.status(400).json({ error: "Missing club name" });
    const start = Date.now();
    try {
      const result = await live.club(name);
      console.log(`[live] club "${name}": ${result.found ? `${result.team}, ${result.league}` : "not found"} (${Date.now() - start}ms)${result.missing.length ? `; missing: ${result.missing.join("; ")}` : ""}`);
      return res.json(result);
    } catch (error: any) {
      console.warn(`[live] club "${name}" failed:`, error?.message || error);
      return res.json({ found: false, missing: [`Live match data for ${name} (lookup failed)`] });
    }
  });

  app.get("/api/live/player", async (req, res) => {
    const name = liveQuery(req.query.name);
    if (!name) return res.status(400).json({ error: "Missing player name" });
    try {
      const result = await live.player(name);
      console.log(`[live] player "${name}": ${"reason" in result ? result.reason : `${result.name}, ${result.team}`}`);
      return res.json(result);
    } catch (error: any) {
      console.warn(`[live] player "${name}" failed:`, error?.message || error);
      return res.json({ found: false, reason: "lookup failed" });
    }
  });

  app.get("/api/live/table", async (req, res) => {
    const league = liveQuery(req.query.league);
    if (!league) return res.status(400).json({ error: "Missing league name" });
    try {
      const result = await live.table(league, liveQuery(req.query.country) || undefined);
      console.log(`[live] table "${league}": ${"reason" in result ? result.reason : `${result.league}, ${result.season}`}`);
      return res.json(result);
    } catch (error: any) {
      console.warn(`[live] table "${league}" failed:`, error?.message || error);
      return res.json({ found: false, reason: "lookup failed" });
    }
  });

  // AI Studio's service worker intercepts browser requests to generativelanguage.googleapis.com
  // and redirects them here. This route forwards them back to Google using the server-side
  // GEMINI_API_KEY. We ignore the incoming x-goog-api-key header because AI Studio's service
  // worker injects its own internal key there, which has different/lower quota than the user's key.
  app.all("/gemini-api-proxy/*path", async (req, res) => {
    try {
      const proxyPath = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
      const targetUrl = `https://generativelanguage.googleapis.com/${proxyPath}`;
      // Strip AI Studio internal params (e.g. __applet_proxy) before forwarding to Google.
      const params = Object.fromEntries(
        Object.entries(req.query).filter(([key]) => !key.startsWith('__'))
      );
      console.log(`[gemini-proxy] ${req.method} ${proxyPath} key=${GEMINI_API_KEY ? GEMINI_API_KEY.slice(0,6) + '...' : 'MISSING'}`);
      const response = await axios({
        method: req.method as any,
        url: targetUrl,
        params,
        data: req.method !== "GET" ? req.body : undefined,
        headers: {
          "Content-Type": "application/json",
          // Always use the server-side key — never trust the incoming header from AI Studio's SW.
          "x-goog-api-key": GEMINI_API_KEY || "",
        },
        responseType: "stream",
        validateStatus: () => true,
      });
      console.log(`[gemini-proxy] response status: ${response.status}`);
      res.status(response.status);
      const forward = ["content-type", "x-goog-safety-encoding", "cache-control"];
      forward.forEach(h => { if (response.headers[h]) res.setHeader(h, response.headers[h]); });
      response.data.pipe(res);
    } catch (error: any) {
      // Only genuine network errors reach here (not HTTP 4xx/5xx)
      res.status(500).json({ error: "Gemini proxy error", details: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
