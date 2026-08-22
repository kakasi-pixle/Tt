import express from "express";
import fs from "node:fs/promises";
import http from "node:http";
import { WebSocketServer } from "ws";
import {
  TikTokLiveConnection,
  WebcastEvent
} from "tiktok-live-connector";

const PORT = Number(process.env.PORT || 10000);
const MIN_SECONDS = Number(process.env.MIN_SECONDS || 30);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const monitors = new Map();
const boxes = new Map();

const FILE = "./monitors.json";

app.use(express.json());
app.use(express.static("."));

async function loadUsers() {
  try {
    const data = JSON.parse(
      await fs.readFile(FILE, "utf8")
    );

    for (const username of data.usernames || []) {
      addMonitor(username);
    }
  } catch {
    await saveUsers();
  }
}

async function saveUsers() {
  await fs.writeFile(
    FILE,
    JSON.stringify(
      {
        usernames: [...monitors.keys()]
      },
      null,
      2
    )
  );
}

function cleanUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/*
 * يبحث داخل الـpayload الكامل عن حقول زمنية محتملة.
 * لا نعتبر أي قيمة وقتًا حقيقيًا إلا إذا كانت منطقية
 * وقابلة للتحويل إلى timestamp مستقبلي.
 */
function findExpiry(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) {
    return null;
  }

  const keys = Object.keys(obj);

  const names = [
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

  for (const key of keys) {
    const lower = key.toLowerCase();

    if (
      names.some(
        x => x.toLowerCase() === lower
      )
    ) {
      const value = obj[key];

      const number = Number(value);

      if (Number.isFinite(number)) {
        let ms = number;

        if (number < 100000000000) {
          ms = number * 1000;
        }

        if (
          ms > Date.now() &&
          ms < Date.now() + 60 * 60 * 1000
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

  for (const key of keys) {
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

function state() {
  return {
    monitors: [...monitors.values()].map(m => ({
      username: m.username,
      status: m.status,
      viewers: m.viewers,
      roomId: m.roomId,
      error: m.error
    })),

    boxes: [...boxes.values()]
      .map(box => ({
        ...box,
        remaining:
          box.expiresAt
            ? Math.max(
                0,
                Math.ceil(
                  (box.expiresAt - Date.now()) / 1000
                )
              )
            : null
      }))
      .filter(box => {
        if (box.remaining === null) {
          return true;
        }

        return box.remaining >= MIN_SECONDS;
      })
  };
}

function broadcast(data) {
  const message = JSON.stringify(data);

  for (const ws of wss.clients) {
    if (ws.readyState === 1) {
      ws.send(message);
    }
  }
}

function broadcastState() {
  broadcast({
    type: "state",
    data: state()
  });
}

function addMonitor(username) {
  username = cleanUsername(username);

  if (!username || monitors.has(username)) {
    return false;
  }

  monitors.set(username, {
    username,
    connection: null,
    status: "connecting",
    viewers: 0,
    roomId: null,
    error: null,
    reconnect: null
  });

  connectMonitor(username);

  return true;
}

async function removeMonitor(username) {
  const monitor = monitors.get(username);

  if (!monitor) {
    return false;
  }

  if (monitor.reconnect) {
    clearTimeout(monitor.reconnect);
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

function reconnect(username) {
  const monitor = monitors.get(username);

  if (!monitor || monitor.reconnect) {
    return;
  }

  monitor.reconnect = setTimeout(() => {
    monitor.reconnect = null;

    if (monitors.has(username)) {
      connectMonitor(username);
    }
  }, 5000);
}

async function connectMonitor(username) {
  const monitor = monitors.get(username);

  if (!monitor) {
    return;
  }

  monitor.status = "connecting";
  monitor.error = null;

  broadcastState();

  const connection =
    new TikTokLiveConnection(username);

  monitor.connection = connection;

  connection.on("connected", info => {
    const m = monitors.get(username);

    if (!m || m.connection !== connection) {
      return;
    }

    m.status = "live";
    m.roomId = info?.roomId || null;
    m.error = null;

    broadcastState();
  });

  connection.on(
    WebcastEvent.ROOM_USER,
    data => {
      const m = monitors.get(username);

      if (!m || m.connection !== connection) {
        return;
      }

      m.viewers =
        Number(
          data?.viewerCount ??
          data?.totalUser ??
          0
        );

      broadcastState();
    }
  );

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

      /*
       * أهم جزء:
       * نبحث في الـevent كاملًا، وليس envelopeInfo فقط.
       */
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

      broadcast({
        type: "box",
        box: {
          ...box,
          remaining:
            expiresAt
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

  connection.on(
    "disconnected",
    () => {
      const m = monitors.get(username);

      if (!m || m.connection !== connection) {
        return;
      }

      m.status = "offline";

      broadcastState();

      reconnect(username);
    }
  );

  connection.on(
    "streamEnd",
    () => {
      const m = monitors.get(username);

      if (!m || m.connection !== connection) {
        return;
      }

      m.status = "offline";

      broadcastState();
    }
  );

  connection.on(
    "error",
    error => {
      const m = monitors.get(username);

      if (!m || m.connection !== connection) {
        return;
      }

      m.status = "error";

      m.error =
        error?.message ||
        error?.info ||
        "Connection error";

      broadcastState();

      reconnect(username);
    }
  );

  try {
    await connection.connect();
  } catch (error) {
    const m = monitors.get(username);

    if (!m) {
      return;
    }

    m.status = "offline";

    m.error =
      error?.message ||
      "Connection failed";

    broadcastState();

    reconnect(username);
  }
}

/* API */

app.get("/api/state", (_req, res) => {
  res.json(state());
});

app.post("/api/monitors", async (req, res) => {
  const usernames =
    Array.isArray(req.body?.usernames)
      ? req.body.usernames
      : [req.body?.username];

  const added = [];

  for (const value of usernames) {
    const username = cleanUsername(value);

    if (addMonitor(username)) {
      added.push(username);
    }
  }

  await saveUsers();
  broadcastState();

  res.json({
    ok: true,
    added
  });
});

app.delete(
  "/api/monitors/:username",
  async (req, res) => {
    const username =
      cleanUsername(
        req.params.username
      );

    const removed =
      await removeMonitor(username);

    res.json({
      ok: removed
    });
  }
);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime()
  });
});

/* WebSocket */

wss.on("connection", ws => {
  ws.send(
    JSON.stringify({
      type: "state",
      data: state()
    })
  );
});

/*
 * تحديث العدادات فقط إذا كان
 * expiry حقيقيًا موجودًا.
 */

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

  broadcast({
    type: "tick",
    boxes: [...boxes.values()]
      .map(box => ({
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

await loadUsers();

server.listen(PORT, () => {
  console.log(
    `LIVE Monitor running on ${PORT}`
  );
});
