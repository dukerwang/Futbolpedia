import express from "express";
import { createServer as createViteServer } from "vite";
import cors from "cors";
import path from "path";
import axios from "axios";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // API Routes
  app.get("/api/health", (req, res) => {
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

  const PLAYER_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
  const playerFactCache = new Map<string, { expiresAt: number; payload: any }>();
  const teamIdCache = new Map<string, number>();
  const teamContextCache = new Map<
    number,
    { expiresAt: number; coach: string | null; recentFixtures: any[]; upcomingFixtures: any[] }
  >();

  const getTeamContextById = async (teamId: number) => {
    const cached = teamContextCache.get(teamId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }

    const [lastFixturesRes, nextFixturesRes, coachRes] = await Promise.allSettled([
      axios.get(`${API_URL}/fixtures`, {
        params: { team: teamId, last: 5 },
        headers: { "x-apisports-key": API_KEY },
        timeout: 4500,
      }),
      axios.get(`${API_URL}/fixtures`, {
        params: { team: teamId, next: 3 },
        headers: { "x-apisports-key": API_KEY },
        timeout: 4500,
      }),
      axios.get(`${API_URL}/coachs`, {
        params: { team: teamId },
        headers: { "x-apisports-key": API_KEY },
        timeout: 4500,
      }),
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

    let coach: string | null = null;
    if (coachRes.status === "fulfilled") {
      const coaches: any[] = coachRes.value.data?.response ?? [];
      const activeCoach =
        coaches.find((c) =>
          Array.isArray(c?.career) &&
          c.career.some((stint: any) => stint?.team?.id === teamId && stint?.end === null),
        ) || coaches[0];
      if (activeCoach?.name) {
        coach =
          activeCoach.firstname && activeCoach.lastname
            ? `${activeCoach.firstname} ${activeCoach.lastname}`
            : String(activeCoach.name);
      }
    }

    const entry = {
      expiresAt: Date.now() + PLAYER_CACHE_TTL_MS,
      coach,
      recentFixtures,
      upcomingFixtures,
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
    const season = typeof req.query.season === "string" ? parseInt(req.query.season, 10) || 2025 : 2025;
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

      const profileRes = await axios.get(`${API_URL}/players/profiles`, {
        params: { search: searchTerm },
        headers: { "x-apisports-key": API_KEY },
        timeout: 6000,
      });

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
      let recentFixtures: any[] = [];

      if (basePlayer?.id) {
        try {
          const statsRes = await axios.get(`${API_URL}/players`, {
            params: { id: basePlayer.id, season },
            headers: { "x-apisports-key": API_KEY },
            timeout: 6000,
          });
          const statEntry = statsRes.data?.response?.[0];
          const primaryStat = statEntry?.statistics?.[0];
          if (statEntry?.player) {
            injured = statEntry.player.injured ?? injured;
          }
          if (primaryStat) {
            currentClub = primaryStat.team?.name ?? null;
            league = primaryStat.league?.name ?? null;
            seasonStats = {
              season,
              appearances: primaryStat.games?.appearences ?? null,
              lineups: primaryStat.games?.lineups ?? null,
              minutes: primaryStat.games?.minutes ?? null,
              goals: primaryStat.goals?.total ?? null,
              assists: primaryStat.goals?.assists ?? null,
              keyPasses: primaryStat.passes?.key ?? null,
              tackles: primaryStat.tackles?.total ?? null,
              interceptions: primaryStat.tackles?.interceptions ?? null,
              duelsWon: primaryStat.duels?.won ?? null,
              rating: primaryStat.games?.rating ?? null,
            };
            if (primaryStat.team?.id) {
              if (currentClub) {
                teamIdCache.set(currentClub.toLowerCase(), primaryStat.team.id);
              }
              const teamCtx = await Promise.race([
                getTeamContextById(primaryStat.team.id),
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 900)),
              ]);
              if (teamCtx) {
                coach = teamCtx.coach;
                recentFixtures = teamCtx.recentFixtures;
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
      const teamRes = await axios.get(`${API_URL}/teams`, {
        params: { search: team as string },
        headers: { "x-apisports-key": API_KEY }
      });

      if (!teamRes.data.response || teamRes.data.response.length === 0) {
        return res.status(404).json({ error: "Team not found" });
      }

      const teamId = teamRes.data.response[0].team.id;
      const teamName = teamRes.data.response[0].team.name;
      if (teamName) teamIdCache.set(String(teamName).toLowerCase(), teamId);
      teamIdCache.set(String(team).toLowerCase().trim(), teamId);

      // 2. Get Squad
      const squadRes = await axios.get(`${API_URL}/players/squads`, {
        params: { team: teamId },
        headers: { "x-apisports-key": API_KEY }
      });

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
        const teamRes = await axios.get(`${API_URL}/teams`, {
          params: { search: rawTeam },
          headers: { "x-apisports-key": API_KEY },
          timeout: 5000,
        });
        const first = teamRes.data?.response?.[0]?.team;
        if (!first?.id) {
          return res.status(404).json({ error: "Team not found" });
        }
        teamId = first.id as number;
        resolvedTeamName = first.name || rawTeam;
        teamIdCache.set(rawTeam.toLowerCase(), teamId);
        if (first.name) teamIdCache.set(String(first.name).toLowerCase(), teamId);
      }

      const ctx = await getTeamContextById(teamId);
      return res.json({
        available: true,
        team: resolvedTeamName,
        coach: ctx.coach,
        recentFixtures: ctx.recentFixtures,
        upcomingFixtures: ctx.upcomingFixtures,
      });
    } catch (error: any) {
      console.warn("[api/football/fixtures] lookup failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to fetch fixtures from API-Football" });
    }
  });

  app.get("/api/football/proxy/*endpoint", async (req, res) => {
      try {
          const endpoint = Array.isArray(req.params.endpoint) ? req.params.endpoint.join('/') : req.params.endpoint;
          const query = req.query;

          const response = await axios.get(`${API_URL}/${endpoint}`, {
              params: query,
              headers: { "x-apisports-key": API_KEY }
          });
          
          res.json(response.data);
      } catch (error: any) {
          console.error(error?.response?.data || error);
          res.status(500).json({ error: "Failed to fetch from API-Football proxy" });
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
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
