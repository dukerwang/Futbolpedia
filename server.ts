import express from "express";
import { createServer as createViteServer } from "vite";
import cors from "cors";
import path from "path";
import axios from "axios";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  const API_KEY = process.env.API_FOOTBALL_KEY;
  const API_URL = "https://v3.football.api-sports.io";

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
          const endpoint = req.params.endpoint;
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

  // Proxy for Gemini API — the browser SDK is pointed at this route via httpOptions.baseUrl
  // so all Gemini traffic flows server-side. The server injects the API key, keeping it
  // off the client bundle and making the app work identically in AI Studio and Cloud Run.
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.API_KEY;
  app.all("/gemini-api-proxy/*path", async (req, res) => {
    try {
      const targetUrl = `https://generativelanguage.googleapis.com/${req.params.path}`;
      // SDK sends the key as x-goog-api-key header; server key overrides if set
      const apiKey = GEMINI_API_KEY || (req.headers["x-goog-api-key"] as string);
      console.log(`[Gemini Proxy] → ${req.method} ${targetUrl} | key=${apiKey ? `set(${apiKey.length}chars)` : "MISSING"} | query=${JSON.stringify(req.query)}`);
      const response = await axios({
        method: req.method as any,
        url: targetUrl,
        params: req.query,
        data: req.method !== "GET" ? req.body : undefined,
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { "x-goog-api-key": apiKey } : {}),
        },
        responseType: "stream",
      });
      res.status(response.status);
      const forward = ["content-type", "x-goog-safety-encoding", "cache-control"];
      forward.forEach(h => { if (response.headers[h]) res.setHeader(h, response.headers[h]); });
      response.data.pipe(res);
    } catch (error: any) {
      if (error.response) {
        // Collect the error body — streaming piping after a throw isn't reliable
        const chunks: Buffer[] = [];
        error.response.data.on("data", (c: Buffer) => chunks.push(c));
        error.response.data.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          console.error(`[Gemini Proxy] ${error.response.status} from Google:`, body);
          res.status(error.response.status).send(body);
        });
        error.response.data.on("error", () => {
          res.status(error.response.status).json({ error: { message: error.message, code: error.response.status, status: "" } });
        });
      } else {
        console.error("[Gemini Proxy] No response:", error.message);
        res.status(500).json({ error: "Gemini proxy error", details: error.message });
      }
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
