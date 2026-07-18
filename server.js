// GoalEdge backend — connects to real TxLine data and serves it to the
// frontend as simple REST endpoints. This is the "one backend connection,
// re-broadcast to many users" pattern we talked about earlier tonight.
//
// SETUP:
//   1. npm install   (already done if you copied package.json too)
//   2. Create a .env file in this folder with:
//        TXLINE_API_TOKEN=txoracle_api_4dc32c2490824bf8baeb0994983669da
//        FIXTURE_ID=18257865
//   3. node server.js
//
// Your frontend then calls:
//   GET http://localhost:5001/api/state   -> latest score + odds
//   GET http://localhost:5001/api/our-model -> your team's model output

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { EventSource } = require("eventsource");

const app = express();
app.use(cors()); // permissive for hackathon use — locks this down later if ever public

const API_BASE_URL = "https://txline-dev.txodds.com/api";
const JWT_URL = "https://txline-dev.txodds.com/auth/guest/start";
const API_TOKEN = process.env.TXLINE_API_TOKEN;
const FIXTURE_ID = process.env.FIXTURE_ID || "18257865"; // France v England

if (!API_TOKEN) {
  console.error("Missing TXLINE_API_TOKEN in .env — see instructions at top of this file.");
  process.exit(1);
}

// ---- In-memory live state, kept fresh by the background stream listeners ----
const liveState = {
  fixtureId: FIXTURE_ID,
  score: { participant1: null, participant2: null },
  matchClock: null,
  gameState: null,
  odds: {
    matchWinner: null,   // { part1: pct, draw: pct, part2: pct }
    totalGoals: null,    // { line: number, over: pct, under: pct }
  },
  lastUpdated: null,
};

let currentJwt = null;

async function getFreshJwt() {
  const response = await axios.post(JWT_URL);
  currentJwt = response.data.token;
  return currentJwt;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${currentJwt}`,
    "X-Api-Token": API_TOKEN,
  };
}

// ---- Odds stream: keeps liveState.odds fresh ----
function startOddsStream() {
  const streamUrl = `${API_BASE_URL}/odds/stream`;

  const eventSource = new EventSource(streamUrl, {
    fetch: async (input, init) => {
      const attemptFetch = (jwt) =>
        fetch(input, {
          ...init,
          headers: { ...init.headers, ...authHeaders(), Authorization: `Bearer ${jwt}` },
        });

      let response = await attemptFetch(currentJwt);
      if (response.status === 401 || response.status === 403) {
        console.log("[Odds] JWT expired, renewing...");
        const newJwt = await getFreshJwt();
        response = await attemptFetch(newJwt);
      }
      return response;
    },
  });

  eventSource.onopen = () => console.log("[Odds] Stream connected.");
  eventSource.onerror = (err) => console.error("[Odds] Stream error:", err);

  eventSource.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (String(msg.FixtureId) !== String(FIXTURE_ID)) return;

      liveState.lastUpdated = new Date().toISOString();

      if (msg.SuperOddsType === "1X2_PARTICIPANT_RESULT" && msg.Pct) {
        liveState.odds.matchWinner = {
          part1: parseFloat(msg.Pct[0]),
          draw: parseFloat(msg.Pct[1]),
          part2: parseFloat(msg.Pct[2]),
        };
      }

      if (msg.SuperOddsType === "OVERUNDER_PARTICIPANT_GOALS" && msg.MarketParameters) {
        const line = msg.MarketParameters.line;
        console.log(`[Odds DEBUG] OVERUNDER line=${line} Pct=${JSON.stringify(msg.Pct)}`);
        // Guard: only accept match-level totals (line >= 2).
        // Per-participant markets ("Will France score?") also use this SuperOddsType but
        // have line=0.5 — without this guard they overwrite totalGoals with France's
        // scoring probability, which coincidentally equals the 1X2 win probability.
        if (line >= 2) {
          liveState.odds.totalGoals = {
            line,
            over:  msg.Pct && msg.Pct[0] !== "NA" ? parseFloat(msg.Pct[0]) : null,
            under: msg.Pct && msg.Pct[1] !== "NA" ? parseFloat(msg.Pct[1]) : null,
          };
        }
      }
    } catch (e) {
      // Ignore malformed/non-JSON messages
    }
  };
}

// ---- Scores stream: keeps liveState.score fresh ----
function startScoresStream() {
  const streamUrl = `${API_BASE_URL}/scores/stream`;

  const eventSource = new EventSource(streamUrl, {
    fetch: async (input, init) => {
      const attemptFetch = (jwt) =>
        fetch(input, {
          ...init,
          headers: { ...init.headers, ...authHeaders(), Authorization: `Bearer ${jwt}` },
        });

      let response = await attemptFetch(currentJwt);
      if (response.status === 401 || response.status === 403) {
        console.log("[Scores] JWT expired, renewing...");
        const newJwt = await getFreshJwt();
        response = await attemptFetch(newJwt);
      }
      return response;
    },
  });

  eventSource.onopen = () => console.log("[Scores] Stream connected.");
  eventSource.onerror = (err) => console.error("[Scores] Stream error:", err);

  eventSource.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      // TEMPORARY DEBUG LINE — prints every raw score message so we can see
      // the real field names. Remove this once the mapping below is fixed.
      console.log("[Scores DEBUG] raw message:", JSON.stringify(msg));

      if (String(msg.FixtureId) !== String(FIXTURE_ID)) return;

      liveState.lastUpdated = new Date().toISOString();
      if (msg.Participant1Score !== undefined) liveState.score.participant1 = msg.Participant1Score;
      if (msg.Participant2Score !== undefined) liveState.score.participant2 = msg.Participant2Score;
      if (msg.GameState !== undefined) liveState.gameState = msg.GameState;
      if (msg.MatchClock !== undefined) liveState.matchClock = msg.MatchClock;
    } catch (e) {
      // Ignore malformed/non-JSON messages
    }
  };
}

// ---- "Our Model" — placeholder formula, swap the inside of this function
// once your teammate hands you the real one ----
function ourModelProbability() {
  const minutesElapsed = liveState.matchClock || 0;
  const pregameExpectedGoals = 2.75; // TODO: pull real pregame line instead of hardcoding
  const goalsSoFar = (liveState.score.participant1 || 0) + (liveState.score.participant2 || 0);
  const remainingFraction = Math.max(0, (90 - minutesElapsed) / 90);
  const expectedRemaining = pregameExpectedGoals * remainingFraction * 0.5; // rough scaling
  const projectedTotal = goalsSoFar + expectedRemaining;

  const line = liveState.odds.totalGoals?.line || 2.5;
  // Very rough probability estimate — replace with your teammate's real model
  const overProbability = projectedTotal > line ? 0.5 + Math.min(0.45, (projectedTotal - line) * 0.2)
                                                  : 0.5 - Math.min(0.45, (line - projectedTotal) * 0.2);

  return {
    projectedTotalGoals: Math.round(projectedTotal * 10) / 10,
    overProbabilityPct: Math.round(overProbability * 1000) / 10,
  };
}

// ---- Routes ----
app.get("/api/state", (req, res) => {
  res.json(liveState);
});

app.get("/api/our-model", (req, res) => {
  res.json(ourModelProbability());
});

app.get("/health", (req, res) => res.json({ ok: true }));

// ---- Startup ----
async function start() {
  await getFreshJwt();
  console.log("Got initial guest JWT.");
  startOddsStream();
  startScoresStream();

  const PORT = 5001;
  app.listen(PORT, () => {
    console.log(`\nGoalEdge backend running at http://localhost:${PORT}`);
    console.log(`Try: http://localhost:${PORT}/api/state\n`);
  });
}

start().catch((err) => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});
