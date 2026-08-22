const state = {
  monitors: [],
  boxes: [],
  sort: "time"
};

const $ = id =>
  document.getElementById(id);

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function render() {

  $("users").textContent =
    state.monitors.length;

  $("live").textContent =
    state.monitors.filter(
      x => x.status === "live"
    ).length;

  $("boxes").textContent =
    state.boxes.length;

  renderAccounts();
  renderBoxes();
}

function renderAccounts() {

  const el =
    $("accountList");

  if (!state.monitors.length) {
    el.innerHTML =
      `<div class="empty">
        لا توجد حسابات.
      </div>`;
    return;
  }

  el.innerHTML =
    state.monitors.map(m => {

      const status =
        m.status === "live"
          ? "live"
          : m.status === "connecting"
          ? "connecting"
          : "offline";

      return `
        <div class="account">

          <div>
            <span class="dot ${status}"></span>

            <b>
              @${esc(m.username)}
            </b>

            <small>
              ${
                m.status === "live"
                  ? `LIVE • ${Number(
                      m.viewers || 0
                    ).toLocaleString()} viewers`
                  : m.status
              }
            </small>
          </div>

          <button
            onclick="removeUser('${esc(
              m.username
            )}')"
          >
            ×
          </button>

        </div>
      `;
    }).join("");
}

function renderBoxes() {

  const el =
    $("boxList");

  let list =
    [...state.boxes];

  if (state.sort === "diamonds") {
    list.sort(
      (a,b) =>
        b.diamonds - a.diamonds
    );
  }

  else if (state.sort === "people") {
    list.sort(
      (a,b) =>
        b.people - a.people
    );
  }

  else {
    list.sort((a,b) => {

      if (
        a.remaining === null
      ) return 1;

      if (
        b.remaining === null
      ) return -1;

      return (
        a.remaining -
        b.remaining
      );
    });
  }

  if (!list.length) {

    el.innerHTML =
      `<div class="empty">
        📡<br>
        لا توجد صناديق حاليًا
      </div>`;

    return;
  }

  el.innerHTML =
    list.map(box => {

      const hasTimer =
        box.remaining !== null;

      const timer =
        hasTimer
          ? `${box.remaining}s`
          : "غير متاح";

      const source =
        box.timeSource === "payload"
          ? "وقت حقيقي من البيانات"
          : "TikTok لم يرسل وقت الانتهاء";

      return `
        <article class="box">

          <div class="box-main">

            <div class="user">
              📦
              <div>
                <b>
                  @${esc(box.username)}
                </b>

                <small>
                  ${
                    box.sender
                      ? "من " +
                        esc(box.sender)
                      : "Treasure Chest"
                  }
                </small>
              </div>
            </div>

            <div class="metrics">

              <span>
                💎
                ${Number(
                  box.diamonds
                ).toLocaleString()}
              </span>

              <span>
                👥
                ${Number(
                  box.people
                ).toLocaleString()}
              </span>

            </div>

          </div>

          <div class="timer">

            <strong>
              ${timer}
            </strong>

            <small>
              ${esc(source)}
            </small>

          </div>

        </article>
      `;
    }).join("");
}

async function addUsers() {

  const usernames =
    $("userInput")
      .value
      .split(/[\s,\n]+/)
      .filter(Boolean);

  if (!usernames.length) {
    return;
  }

  await fetch(
    "/api/monitors",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        usernames
      })
    }
  );

  $("userInput").value = "";
}

async function removeUser(username) {

  await fetch(
    `/api/monitors/${encodeURIComponent(
      username
    )}`,
    {
      method: "DELETE"
    }
  );
}

$("add")
  .addEventListener(
    "click",
    addUsers
  );

$("sort")
  .addEventListener(
    "change",
    e => {
      state.sort =
        e.target.value;

      renderBoxes();
    }
  );

function connect() {

  const protocol =
    location.protocol === "https:"
      ? "wss:"
      : "ws:";

  const ws =
    new WebSocket(
      `${protocol}//${location.host}`
    );

  ws.onopen = () => {
    $("connection").textContent =
      "● Connected";

    $("connection")
      .className = "connected";
  };

  ws.onclose = () => {
    $("connection").textContent =
      "● Reconnecting...";

    $("connection")
      .className = "";

    setTimeout(
      connect,
      2000
    );
  };

  ws.onmessage = event => {

    const message =
      JSON.parse(event.data);

    if (
      message.type === "state"
    ) {

      state.monitors =
        message.data.monitors || [];

      state.boxes =
        message.data.boxes || [];

      render();
    }

    if (
      message.type === "box"
    ) {

      state.boxes.push(
        message.box
      );

      render();
    }

    if (
      message.type === "tick"
    ) {

      state.boxes =
        message.boxes || [];

      renderBoxes();
      $("boxes").textContent =
        state.boxes.length;
    }
  };
}

connect();
