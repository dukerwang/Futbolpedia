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
