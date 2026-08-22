import express from "express";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  TikTokLiveConnection,
  WebcastEvent
} from "tiktok-live-connector";

const PORT = Number(process.env.PORT || 3000);
const MIN_SECONDS = Number(process.env.MIN_SECONDS || 30);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const DATA_FILE = path.join(__dirname, "monitors.json");

const monitors = new Map();
const boxes = new Map();

app.use(express.json());

/* =========================
   WEBSITE
========================= */

app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

/* =========================
   HELPERS
========================= */

function cleanUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function errorText(error) {
  if (!error) {
    return "Unknown error";
  }

  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.stack || error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function sendToAll(data) {
  const message = JSON.stringify(data);

  for (const ws of wss.clients) {
    if (ws.readyState === 1) {
      try {
        ws.send(message);
      } catch {}
    }
  }
}

function broadcastState() {
  sendToAll({
    type: "state",
    data: getState()
  });
}

/* =========================
   STATE
========================= */

function getState() {
  const now = Date.now();

  const monitorList = [...monitors.values()].map(m => ({
    username: m.username,
    status: m.status,
    viewers: m.viewers || 0,
    roomId: m.roomId || null,
    error: m.error || null,
    lastUpdate: m.lastUpdate || null
  }));

  const boxList = [...boxes.values()]
    .map(box => ({
      ...box,
      remaining: box.expiresAt
        ? Math.max(
            0,
            Math.ceil(
              (box.expiresAt - now) / 1000
            )
          )
        : null
    }))
    .filter(box => {
      if (box.remaining === null) {
        return true;
      }

      return box.remaining >= MIN_SECONDS;
    });

  return {
    monitors: monitorList,
    boxes: boxList
  };
}

/* =========================
   STORAGE
========================= */

async function saveUsers() {
  try {
    await fs.writeFile(
      DATA_FILE,
      JSON.stringify(
        {
          usernames: [...monitors.keys()]
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      "SAVE ERROR:",
      errorText(error)
    );
  }
}

async function loadUsers() {
  try {
    const raw = await fs.readFile(
      DATA_FILE,
      "utf8"
    );

    const data = JSON.parse(raw);

    for (const username of data.usernames || []) {
      addMonitor(username);
    }
  } catch {
    await saveUsers();
  }
}

/* =========================
   EXPIRY SEARCH
========================= */

function findExpiry(obj, depth = 0) {
  if (
    !obj ||
    typeof obj !== "object" ||
    depth > 8
  ) {
    return null;
  }

  const possibleKeys = [
    "expireTime",
    "expiryTime",
    "expirationTime",
    "endTime",
    "endTimestamp",
    "expireTimestamp",
    "expiryTimestamp",
    "expirationTimestamp",
    "expireAt",
    "expiresAt"
  ];

  for (const key of Object.keys(obj)) {
    const value = obj[key];

    if (
      possibleKeys.some(
        x =>
          x.toLowerCase() ===
          key.toLowerCase()
      )
    ) {
      const n = Number(value);

      if (Number.isFinite(n)) {
        let ms = n;

        if (n < 100000000000) {
          ms = n * 1000;
        }

        if (
          ms > Date.now() &&
          ms < Date.now() + 3600000
        ) {
          return ms;
        }
      }

      const parsed = Date.parse(value);

      if (
        Number.isFinite(parsed) &&
        parsed > Date.now()
      ) {
        return parsed;
      }
    }
  }

  for (const key of Object.keys(obj)) {
    const result = findExpiry(
      obj[key],
      depth + 1
    );

    if (result) {
      return result;
    }
  }

  return null;
}

/* =========================
   MONITOR
========================= */

function addMonitor(username) {
  username = cleanUsername(username);

  if (!username) {
    return false;
  }

  if (monitors.has(username)) {
    return false;
  }

  monitors.set(username, {
    username,
    status: "connecting",
    viewers: 0,
    roomId: null,
    error: null,
    connection: null,
    reconnectTimer: null,
    lastUpdate: Date.now()
  });

  connectMonitor(username);

  return true;
}

/* =========================
   REMOVE
========================= */

async function removeMonitor(username) {
  username = cleanUsername(username);

  const monitor = monitors.get(username);

  if (!monitor) {
    return false;
  }

  if (monitor.reconnectTimer) {
    clearTimeout(
      monitor.reconnectTimer
    );
  }

  if (monitor.connection) {
    try {
      await monitor.connection.disconnect();
    } catch {}
  }

  monitors.delete(username);

  for (const [key, box] of boxes) {
    if (box.username === username) {
      boxes.delete(key);
    }
  }

  await saveUsers();
  broadcastState();

  return true;
}

/* =========================
   RECONNECT
========================= */

function scheduleReconnect(username) {
  const monitor = monitors.get(username);

  if (!monitor) {
    return;
  }

  if (monitor.reconnectTimer) {
    return;
  }

  monitor.reconnectTimer = setTimeout(() => {
    monitor.reconnectTimer = null;

    if (monitors.has(username)) {
      connectMonitor(username);
    }
  }, 5000);
}

/* =========================
   TIKTOK
========================= */

async function connectMonitor(username) {
  const monitor = monitors.get(username);

  if (!monitor) {
    return;
  }

  monitor.status = "connecting";
  monitor.error = null;
  monitor.lastUpdate = Date.now();

  broadcastState();

  let connection;

  try {
    connection =
      new TikTokLiveConnection(
        username
      );

    monitor.connection = connection;

  } catch (error) {
    monitor.status = "error";
    monitor.error = errorText(error);
    monitor.lastUpdate = Date.now();

    broadcastState();

    scheduleReconnect(username);
    return;
  }

  /* CONNECTED */

  connection.on(
    "connected",
    info => {
      const m = monitors.get(username);

      if (
        !m ||
        m.connection !== connection
      ) {
        return;
      }

      m.status = "live";
      m.error = null;
      m.roomId =
        info?.roomId || null;
      m.lastUpdate = Date.now();

      broadcastState();
    }
  );

  /* ERROR */

  connection.on(
    "error",
    error => {
      const m = monitors.get(username);

      if (
        !m ||
        m.connection !== connection
      ) {
        return;
      }

      m.status = "error";
      m.error = errorText(error);
      m.lastUpdate = Date.now();

      broadcastState();

      scheduleReconnect(username);
    }
  );

  /* DISCONNECTED */

  connection.on(
    "disconnected",
    info => {
      const m = monitors.get(username);

      if (
        !m ||
        m.connection !== connection
      ) {
        return;
      }

      m.status = "offline";

      m.error =
        info
          ? errorText(info)
          : "TikTok disconnected";

      m.lastUpdate = Date.now();

      broadcastState();

      scheduleReconnect(username);
    }
  );

  /* ROOM USERS */

  connection.on(
    WebcastEvent.ROOM_USER,
    data => {
      const m = monitors.get(username);

      if (
        !m ||
        m.connection !== connection
      ) {
        return;
      }

      m.viewers =
        Number(
          data?.viewerCount ||
          data?.totalUser ||
          0
        );

      m.lastUpdate = Date.now();

      broadcastState();
    }
  );

  /* ENVELOPE */

  connection.on(
    WebcastEvent.ENVELOPE,
    data => {
      const envelope =
        data?.envelopeInfo || {};

      const id =
        String(
          envelope.envelopeId ||
          `${username}-${Date.now()}`
        );

      const key =
        `${username}:${id}`;

      if (boxes.has(key)) {
        return;
      }

      const expiresAt =
        findExpiry(data);

      const box = {
        id,
        username,

        sender:
          envelope.sendUserName ||
          null,

        diamonds:
          Number(
            envelope.diamondCount || 0
          ),

        people:
          Number(
            envelope.peopleCount || 0
          ),

        createdAt: Date.now(),

        expiresAt,

        timeSource:
          expiresAt
            ? "payload"
            : "unavailable"
      };

      boxes.set(key, box);

      sendToAll({
        type: "box",
        box: {
          ...box,
          remaining: expiresAt
            ? Math.max(
                0,
                Math.ceil(
                  (expiresAt - Date.now()) /
                  1000
                )
              )
            : null
        }
      });

      broadcastState();
    }
  );

  /* CONNECT */

  try {
    await connection.connect();

  } catch (error) {
    const m = monitors.get(username);

    if (!m) {
      return;
    }

    m.status = "error";
    m.error = errorText(error);
    m.lastUpdate = Date.now();

    broadcastState();

    scheduleReconnect(username);
  }
}

/* =========================
   API
========================= */

app.get(
  "/api/state",
  (_req, res) => {
    res.json(getState());
  }
);

app.post(
  "/api/monitors",
  async (req, res) => {
    const usernames =
      Array.isArray(
        req.body?.usernames
      )
        ? req.body.usernames
        : [
            req.body?.username
          ];

    const added = [];
    const errors = [];

    for (const value of usernames) {
      const username =
        cleanUsername(value);

      if (!username) {
        errors.push({
          username: value,
          error: "Username is empty"
        });

        continue;
      }

      if (monitors.has(username)) {
        errors.push({
          username,
          error: "Already monitoring"
        });

        continue;
      }

      if (addMonitor(username)) {
        added.push(username);
      }
    }

    await saveUsers();
    broadcastState();

    res.json({
      ok: true,
      added,
      errors
    });
  }
);

app.delete(
  "/api/monitors/:username",
  async (req, res) => {
    const removed =
      await removeMonitor(
        req.params.username
      );

    res.json({
      ok: removed
    });
  }
);

/* =========================
   HEALTH
========================= */

app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      ok: true,
      uptime: process.uptime(),
      node: process.version
    });
  }
);

/* =========================
   WEBSOCKET
========================= */

wss.on(
  "connection",
  ws => {
    ws.send(
      JSON.stringify({
        type: "state",
        data: getState()
      })
    );
  }
);

/* =========================
   TIMER
========================= */

setInterval(() => {
  const now = Date.now();

  for (const [key, box] of boxes) {
    if (
      box.expiresAt &&
      box.expiresAt <= now
    ) {
      boxes.delete(key);
    }
  }

  sendToAll({
    type: "tick",
    boxes:
      [...boxes.values()].map(box => ({
        ...box,
        remaining:
          box.expiresAt
            ? Math.max(
                0,
                Math.ceil(
                  (box.expiresAt - now) /
                  1000
                )
              )
            : null
      }))
  });
}, 1000);

/* =========================
   START
========================= */

await loadUsers();

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Server running on port ${PORT}`
    );
  }
);
