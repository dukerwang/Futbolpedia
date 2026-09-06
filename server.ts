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
        timeout: 20000,
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

  const API_KEY = process.env.API_FOOTBALL_KEY;
  const API_URL = "https://v3.football.api-sports.io";
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;
  console.log(`[startup] GEMINI_API_KEY set: ${!!GEMINI_API_KEY} (${GEMINI_API_KEY ? GEMINI_API_KEY.slice(0, 6) + '...' : 'MISSING'})`);

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
