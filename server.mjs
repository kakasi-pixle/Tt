import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { TikTokLiveConnection, WebcastEvent } from "tiktok-live-connector";

const PORT = Number(process.env.PORT || 10000);

const MIN_SECONDS = Number(
  process.env.MIN_SECONDS || 30
);

// تقديري فقط إذا لم توفر TikTok وقت الانتهاء الحقيقي
const CHEST_SECONDS = Number(
  process.env.CHEST_SECONDS || 60
);

const app = express();
const server = http.createServer(app);

const wss = new WebSocketServer({
  server
});

app.use(express.json());
app.use(express.static("public"));

/*
  username -> monitor
*/
const monitors = new Map();

/*
  boxKey -> box
*/
const boxes = new Map();

function cleanUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function getMonitorState() {
  return [...monitors.values()].map(m => ({
    username: m.username,
    status: m.state.status,
    roomId: m.state.roomId || null,
    viewers: m.state.viewers || 0,
    lastError: m.state.lastError || null
  }));
}

function getBoxes() {
  const now = Date.now();

  return [...boxes.values()]
    .map(box => ({
      ...box,
      remaining: Math.max(
        0,
        Math.ceil((box.expiresAt - now) / 1000)
      )
    }))
    .filter(box => box.remaining >= MIN_SECONDS)
    .sort((a, b) => {
      return (
        a.remaining - b.remaining ||
        b.diamonds - a.diamonds
      );
    });
}

function snapshot() {
  return {
    type: "snapshot",

    monitors: getMonitorState(),

    boxes: getBoxes(),

    config: {
      minSeconds: MIN_SECONDS,
      chestSeconds: CHEST_SECONDS
    }
  };
}

function broadcast(data) {
  const message = JSON.stringify(data);

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
}

function broadcastSnapshot() {
  broadcast(snapshot());
}

function scheduleReconnect(username) {
  const monitor = monitors.get(username);

  if (!monitor) return;

  if (monitor.reconnectTimer) return;

  monitor.reconnectTimer = setTimeout(() => {

    const current = monitors.get(username);

    if (!current) return;

    current.reconnectTimer = null;

    connectUsername(username);

  }, 5000);
}

async function connectUsername(username) {

  const monitor = monitors.get(username);

  if (!monitor) return;

  if (monitor.connection) {
    try {
      await monitor.connection.disconnect();
    } catch {}
  }

  monitor.state.status = "connecting";
  monitor.state.lastError = null;

  broadcast({
    type: "monitor:update",

    monitor: {
      username,
      status: "connecting",
      roomId: monitor.state.roomId || null,
      viewers: monitor.state.viewers || 0,
      lastError: null
    }
  });

  const connection =
    new TikTokLiveConnection(username);

  monitor.connection = connection;

  /*
    LIVE connected
  */

  connection.on("connected", state => {

    const m = monitors.get(username);

    if (!m) return;

    if (m.connection !== connection) return;

    m.state.status = "live";

    m.state.roomId =
      state.roomId || null;

    m.state.lastError = null;

    broadcast({
      type: "monitor:update",

      monitor: {
        username,
        status: "live",
        roomId: m.state.roomId,
        viewers: m.state.viewers || 0,
        lastError: null
      }
    });
  });

  /*
    Viewer count
  */

  connection.on(
    WebcastEvent.ROOM_USER,
    data => {

      const m = monitors.get(username);

      if (!m) return;

      if (m.connection !== connection) return;

      m.state.viewers =
        Number(
          data.viewerCount ??
          data.totalUser ??
          0
        );

      broadcast({
        type: "monitor:update",

        monitor: {
          username,
          status: m.state.status,
          roomId: m.state.roomId || null,
          viewers: m.state.viewers,
          lastError: m.state.lastError || null
        }
      });
    }
  );

  /*
    Treasure Chest / Envelope
  */

  connection.on(
    WebcastEvent.ENVELOPE,
    data => {

      const info =
        data?.envelopeInfo;

      if (!info) return;

      const envelopeId =
        String(
          info.envelopeId ??
          `${username}-${Date.now()}`
        );

      const diamonds =
        Number(
          info.diamondCount ?? 0
        );

      const people =
        Number(
          info.peopleCount ?? 0
        );

      const createdAt =
        Date.now();

      /*
        لا يوجد ضمان أن connector يعطي
        وقت الانتهاء الحقيقي.
      */

      const expiresAt =
        createdAt +
        CHEST_SECONDS * 1000;

      const box = {

        id: envelopeId,

        username,

        diamonds,

        people,

        sender:
          info.sendUserName ||
          null,

        createdAt,

        expiresAt,

        estimated: true
      };

      boxes.set(
        `${username}:${envelopeId}`,
        box
      );

      broadcast({
        type: "box:new",

        box: {
          ...box,

          remaining:
            CHEST_SECONDS
        }
      });
    }
  );

  /*
    Disconnect
  */

  connection.on(
    "disconnected",
    () => {

      const m =
        monitors.get(username);

      if (!m) return;

      if (m.connection !== connection) return;

      m.state.status = "offline";

      broadcast({
        type: "monitor:update",

        monitor: {
          username,
          status: "offline",
          roomId: m.state.roomId || null,
          viewers: m.state.viewers || 0,
          lastError:
            m.state.lastError || null
        }
      });

      scheduleReconnect(username);
    }
  );

  /*
    Stream ended
  */

  connection.on(
    "streamEnd",
    () => {

      const m =
        monitors.get(username);

      if (!m) return;

      if (m.connection !== connection) return;

      m.state.status = "offline";

      broadcast({
        type: "monitor:update",

        monitor: {
          username,
          status: "offline",
          roomId: m.state.roomId || null,
          viewers: m.state.viewers || 0,
          lastError: null
        }
      });
    }
  );

  /*
    Error
  */

  connection.on(
    "error",
    ({ info, exception }) => {

      const m =
        monitors.get(username);

      if (!m) return;

      if (m.connection !== connection) return;

      m.state.status = "error";

      m.state.lastError =
        String(
          info ||
          exception?.message ||
          "Connection error"
        );

      broadcast({
        type: "monitor:update",

        monitor: {
          username,
          status: "error",
          roomId: m.state.roomId || null,
          viewers: m.state.viewers || 0,
          lastError:
            m.state.lastError
        }
      });
    }
  );

  /*
    Connect
  */

  try {

    await connection.connect();

  } catch (error) {

    const m =
      monitors.get(username);

    if (!m) return;

    m.state.status = "offline";

    m.state.lastError =
      error?.message ||
      "Failed to connect";

    broadcast({
      type: "monitor:update",

      monitor: {
        username,
        status: "offline",
        roomId: m.state.roomId || null,
        viewers: m.state.viewers || 0,
        lastError:
          m.state.lastError
      }
    });

    scheduleReconnect(username);
  }
}


/*
  Health check
*/

app.get(
  "/api/health",
  (_req, res) => {

    res.json({
      ok: true,
      service:
        "TikTok Live Box Monitor",

      uptime:
        process.uptime()
    });
  }
);


/*
  Current data
*/

app.get(
  "/api/monitors",
  (_req, res) => {

    res.json({
      monitors:
        getMonitorState(),

      boxes:
        getBoxes()
    });
  }
);


/*
  Add usernames
*/

app.post(
  "/api/monitors",
  async (req, res) => {

    const input =
      Array.isArray(
        req.body?.usernames
      )
        ? req.body.usernames
        : [req.body?.username];

    const added = [];

    for (const raw of input) {

      const username =
        cleanUsername(raw);

      if (!username) continue;

      if (username.length > 64) continue;

      if (monitors.has(username)) {
        continue;
      }

      monitors.set(
        username,
        {
          username,

          connection: null,

          reconnectTimer: null,

          state: {
            status: "connecting",
            roomId: null,
            viewers: 0,
            lastError: null
          }
        }
      );

      added.push(username);

      connectUsername(username);
    }

    broadcastSnapshot();

    res.json({
      ok: true,
      added
    });
  }
);


/*
  Delete username
*/

app.delete(
  "/api/monitors/:username",
  async (req, res) => {

    const username =
      cleanUsername(
        req.params.username
      );

    const monitor =
      monitors.get(username);

    if (!monitor) {

      return res.status(404).json({
        ok: false,
        error:
          "Username not found"
      });
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

    for (
      const key of boxes.keys()
    ) {

      if (
        key.startsWith(
          `${username}:`
        )
      ) {
        boxes.delete(key);
      }
    }

    broadcastSnapshot();

    res.json({
      ok: true
    });
  }
);


/*
  WebSocket
*/

wss.on(
  "connection",
  ws => {

    ws.send(
      JSON.stringify(
        snapshot()
      )
    );
  }
);


/*
  Remove expired boxes + realtime tick
*/

setInterval(() => {

  const now =
    Date.now();

  for (
    const [key, box]
    of boxes
  ) {

    if (
      box.expiresAt <= now
    ) {
      boxes.delete(key);
    }
  }

  broadcast({
    type: "tick",

    boxes:
      getBoxes()
  });

}, 1000);


/*
  Start
*/

server.listen(
  PORT,
  () => {

    console.log(
      `Server running on port ${PORT}`
    );
  }
);
