import express from "express";
import fs from "node:fs/promises";
import http from "node:http";
import { WebSocketServer } from "ws";
import {
  TikTokLiveConnection,
  WebcastEvent
} from "tiktok-live-connector";

const PORT = Number(process.env.PORT || 3000);
const MIN_SECONDS = Number(
  process.env.MIN_SECONDS || 30
);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const FILE = "./monitors.json";

const monitors = new Map();
const boxes = new Map();

app.use(express.json());

/* =========================
   WEBSITE
========================= */

app.use(express.static(process.cwd()));

app.get("/", (_req, res) => {
  res.sendFile(
    new URL(
      "./index.html",
      import.meta.url
    ).pathname
  );
});

/* =========================
   FILE STORAGE
========================= */

async function loadUsers() {
  try {
    const data = JSON.parse(
      await fs.readFile(FILE, "utf8")
    );

    for (
      const username of data.usernames || []
    ) {
      addMonitor(username);
    }

  } catch {
    await saveUsers();
  }
}

async function saveUsers() {
  try {
    await fs.writeFile(
      FILE,
      JSON.stringify(
        {
          usernames: [
            ...monitors.keys()
          ]
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      "[SAVE ERROR]",
      error
    );
  }
}

/* =========================
   USERNAME
========================= */

function cleanUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/* =========================
   FIND EXPIRY
========================= */

function findExpiry(
  obj,
  depth = 0
) {
  if (
    !obj ||
    typeof obj !== "object" ||
    depth > 8
  ) {
    return null;
  }

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

  for (
    const key of Object.keys(obj)
  ) {

    const lower =
      key.toLowerCase();

    if (
      names.some(
        name =>
          name.toLowerCase() ===
          lower
      )
    ) {

      const value =
        obj[key];

      const number =
        Number(value);

      if (
        Number.isFinite(number)
      ) {

        let ms = number;

        if (
          number < 100000000000
        ) {
          ms =
            number * 1000;
        }

        if (
          ms > Date.now() &&
          ms <
            Date.now() +
              60 *
                60 *
                1000
        ) {
          return ms;
        }
      }

      const parsed =
        Date.parse(value);

      if (
        Number.isFinite(parsed) &&
        parsed > Date.now()
      ) {
        return parsed;
      }
    }
  }

  for (
    const key of Object.keys(obj)
  ) {

    const result =
      findExpiry(
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
   STATE
========================= */

function getState() {

  const now =
    Date.now();

  return {

    monitors:
      [...monitors.values()]
        .map(m => ({

          username:
            m.username,

          status:
            m.status,

          viewers:
            m.viewers,

          roomId:
            m.roomId,

          error:
            m.error

        })),

    boxes:
      [...boxes.values()]
        .map(box => ({

          ...box,

          remaining:
            box.expiresAt
              ? Math.max(
                  0,
                  Math.ceil(
                    (box.expiresAt -
                      now) /
                      1000
                  )
                )
              : null

        }))
        .filter(box => {

          if (
            box.remaining ===
            null
          ) {
            return true;
          }

          return (
            box.remaining >=
            MIN_SECONDS
          );

        })

  };
}

/* =========================
   WEBSOCKET BROADCAST
========================= */

function broadcast(data) {

  const message =
    JSON.stringify(data);

  for (
    const ws of wss.clients
  ) {

    if (
      ws.readyState === 1
    ) {

      try {
        ws.send(message);
      } catch {}
    }
  }
}

function broadcastState() {

  broadcast({

    type: "state",

    data:
      getState()

  });
}

/* =========================
   ADD MONITOR
========================= */

function addMonitor(
  username
) {

  username =
    cleanUsername(
      username
    );

  if (
    !username ||
    monitors.has(username)
  ) {
    return false;
  }

  monitors.set(
    username,
    {

      username,

      connection:
        null,

      status:
        "connecting",

      viewers:
        0,

      roomId:
        null,

      error:
        null,

      reconnect:
        null

    }
  );

  connectMonitor(
    username
  );

  return true;
}

/* =========================
   REMOVE MONITOR
========================= */

async function removeMonitor(
  username
) {

  const monitor =
    monitors.get(
      username
    );

  if (!monitor) {
    return false;
  }

  if (
    monitor.reconnect
  ) {

    clearTimeout(
      monitor.reconnect
    );
  }

  if (
    monitor.connection
  ) {

    try {

      await monitor
        .connection
        .disconnect();

    } catch {}
  }

  monitors.delete(
    username
  );

  for (
    const [
      key,
      box
    ] of boxes
  ) {

    if (
      box.username ===
      username
    ) {

      boxes.delete(
        key
      );
    }
  }

  await saveUsers();

  broadcastState();

  return true;
}

/* =========================
   RECONNECT
========================= */

function reconnect(
  username
) {

  const monitor =
    monitors.get(
      username
    );

  if (
    !monitor ||
    monitor.reconnect
  ) {
    return;
  }

  monitor.reconnect =
    setTimeout(
      () => {

        monitor.reconnect =
          null;

        if (
          monitors.has(
            username
          )
        ) {

          connectMonitor(
            username
          );
        }

      },
      5000
    );
}

/* =========================
   TIKTOK CONNECTION
========================= */

async function connectMonitor(
  username
) {

  const monitor =
    monitors.get(
      username
    );

  if (!monitor) {
    return;
  }

  monitor.status =
    "connecting";

  monitor.error =
    null;

  broadcastState();

  console.log(
    `[CONNECTING] @${username}`
  );

  const connection =
    new TikTokLiveConnection(
      username
    );

  monitor.connection =
    connection;

  /* =====================
     CONNECTED
  ===================== */

  connection.on(
    "connected",
    info => {

      const m =
        monitors.get(
          username
        );

      if (
        !m ||
        m.connection !==
          connection
      ) {
        return;
      }

      m.status =
        "live";

      m.roomId =
        info?.roomId ||
        null;

      m.error =
        null;

      console.log(
        `[CONNECTED] @${username}`,
        info
      );

      broadcastState();
    }
  );

  /* =====================
     WEBSOCKET CONNECTED
  ===================== */

  connection.on(
    "websocketConnected",
    () => {

      console.log(
        `[WEBSOCKET CONNECTED] @${username}`
      );

    }
  );

  /* =====================
     ROOM USER
  ===================== */

  connection.on(
    WebcastEvent.ROOM_USER,
    data => {

      const m =
        monitors.get(
          username
        );

      if (
        !m ||
        m.connection !==
          connection
      ) {
        return;
      }

      m.viewers =
        Number(
          data?.viewerCount ||
          0
        );

      broadcastState();
    }
  );

  /* =====================
     ENVELOPE
  ===================== */

  connection.on(
    WebcastEvent.ENVELOPE,
    data => {

      console.log(
        `[ENVELOPE] @${username}`
      );

      console.log(
        JSON.stringify(
          data,
          null,
          2
        )
      );

      const envelope =
        data?.envelopeInfo ||
        {};

      const id =
        String(
          envelope.envelopeId ||
          `${username}-${Date.now()}`
        );

      const key =
        `${username}:${id}`;

      if (
        boxes.has(key)
      ) {
        return;
      }

      const expiresAt =
        findExpiry(
          data
        );

      const box = {

        id,

        username,

        sender:
          envelope.sendUserName ||
          null,

        diamonds:
          Number(
            envelope.diamondCount ||
            0
          ),

        people:
          Number(
            envelope.peopleCount ||
            0
          ),

        createdAt:
          Date.now(),

        expiresAt,

        timeSource:
          expiresAt
            ? "payload"
            : "unavailable"

      };

      boxes.set(
        key,
        box
      );

      console.log(
        `[BOX FOUND] @${username}`,
        {
          diamonds:
            box.diamonds,

          people:
            box.people,

          expiresAt:
            box.expiresAt
        }
      );

      broadcast({

        type:
          "box",

        box: {

          ...box,

          remaining:
            expiresAt
              ? Math.max(
                  0,
                  Math.ceil(
                    (expiresAt -
                      Date.now()) /
                      1000
                  )
                )
              : null

        }

      });

      broadcastState();
    }
  );

  /* =====================
     DISCONNECTED
  ===================== */

  connection.on(
    "disconnected",
    info => {

      const m =
        monitors.get(
          username
        );

      if (
        !m ||
        m.connection !==
          connection
      ) {
        return;
      }

      console.error(
        `[DISCONNECTED] @${username}`,
        info
      );

      m.status =
        "offline";

      m.error =
        info?.reason ||
        "TikTok disconnected";

      broadcastState();

      reconnect(
        username
      );
    }
  );

  /* =====================
     STREAM END
  ===================== */

  connection.on(
    "streamEnd",
    () => {

      const m =
        monitors.get(
          username
        );

      if (
        !m ||
        m.connection !==
          connection
      ) {
        return;
      }

      console.log(
        `[STREAM END] @${username}`
      );

      m.status =
        "offline";

      m.error =
        "LIVE ended";

      broadcastState();
    }
  );

  /* =====================
     ERROR
  ===================== */

  connection.on(
    "error",
    error => {

      const m =
        monitors.get(
          username
        );

      if (
        !m ||
        m.connection !==
          connection
      ) {
        return;
      }

      const message =
        error?.message ||
        error?.info ||
        error?.toString() ||
        "Unknown error";

      console.error(
        `[TIKTOK ERROR] @${username}:`,
        error
      );

      m.status =
        "error";

      m.error =
        message;

      broadcastState();

      reconnect(
        username
      );
    }
  );

  /* =====================
     CONNECT
  ===================== */

  try {

    const result =
      await connection.connect();

    console.log(
      `[CONNECT RESULT] @${username}`,
      result
    );

  } catch (error) {

    const m =
      monitors.get(
        username
      );

    if (!m) {
      return;
    }

    const message =
      error?.message ||
      error?.info ||
      error?.toString() ||
      "Connection failed";

    console.error(
      `[CONNECT FAILED] @${username}:`,
      error
    );

    m.status =
      "error";

    m.error =
      message;

    broadcastState();

    reconnect(
      username
    );
  }
}

/* =========================
   API
========================= */

app.get(
  "/api/state",
  (_req, res) => {

    res.json(
      getState()
    );

  }
);

app.post(
  "/api/monitors",
  async (
    req,
    res
  ) => {

    const usernames =
      Array.isArray(
        req.body?.usernames
      )
        ? req.body.usernames
        : [
            req.body?.username
          ];

    const added = [];

    for (
      const value of usernames
    ) {

      const username =
        cleanUsername(
          value
        );

      if (
        addMonitor(
          username
        )
      ) {

        added.push(
          username
        );

      }
    }

    await saveUsers();

    broadcastState();

    res.json({

      ok: true,

      added

    });

  }
);

app.delete(
  "/api/monitors/:username",
  async (
    req,
    res
  ) => {

    const username =
      cleanUsername(
        req.params.username
      );

    const removed =
      await removeMonitor(
        username
      );

    res.json({

      ok:
        removed

    });

  }
);

app.get(
  "/api/health",
  (_req, res) => {

    res.json({

      ok:
        true,

      uptime:
        process.uptime()

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

        type:
          "state",

        data:
          getState()

      })
    );

  }
);

/* =========================
   TIMER
========================= */

setInterval(
  () => {

    const now =
      Date.now();

    for (
      const [
        key,
        box
      ] of boxes
    ) {

      if (
        box.expiresAt &&
        box.expiresAt <=
          now
      ) {

        boxes.delete(
          key
        );

      }

    }

    broadcast({

      type:
        "tick",

      boxes:
        [...boxes.values()]
          .map(box => ({

            ...box,

            remaining:
              box.expiresAt
                ? Math.max(
                    0,
                    Math.ceil(
                      (box.expiresAt -
                        now) /
                        1000
                    )
                  )
                : null

          }))

    });

  },
  1000
);

/* =========================
   START SERVER
========================= */

await loadUsers();

server.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `================================`
    );

    console.log(
      `TikTok Live Monitor Started`
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Min seconds: ${MIN_SECONDS}`
    );

    console.log(
      `================================`
    );

  }
);
