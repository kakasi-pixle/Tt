const state = {
  monitors: [],
  boxes: []
};

const $ = id => document.getElementById(id);

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* =========================
   STATS
========================= */

function updateStats() {

  const users = $("users");
  const live = $("live");
  const boxes = $("boxes");

  if (users) {
    users.textContent =
      state.monitors.length;
  }

  if (live) {
    live.textContent =
      state.monitors.filter(
        account =>
          account.status === "live"
      ).length;
  }

  if (boxes) {
    boxes.textContent =
      state.boxes.length;
  }
}

/* =========================
   ACCOUNTS
========================= */

function renderAccounts() {

  const list =
    $("accountList");

  if (!list) return;

  if (!state.monitors.length) {

    list.innerHTML = `
      <div class="empty">
        لا توجد حسابات مضافة
      </div>
    `;

    updateStats();
    return;
  }

  list.innerHTML =
    state.monitors.map(account => {

      let status =
        "🟡 جاري الاتصال";

      let className =
        "connecting";

      if (
        account.status === "live"
      ) {

        status =
          `🟢 LIVE — ${Number(
            account.viewers || 0
          ).toLocaleString()} مشاهد`;

        className =
          "live";
      }

      if (
        account.status === "offline"
      ) {

        status =
          "⚪ Offline";

        className =
          "offline";
      }

      if (
        account.status === "error"
      ) {

        status =
          "🔴 فشل الاتصال";

        className =
          "error";
      }

      return `
        <div class="account ${className}">

          <div class="account-top">

            <strong>
              @${escapeHTML(
                account.username
              )}
            </strong>

            <button
              type="button"
              class="remove-account"
              data-username="${escapeHTML(
                account.username
              )}"
            >
              حذف
            </button>

          </div>

          <div class="account-status">
            ${status}
          </div>

          ${
            account.error
              ? `
                <div class="account-error">
                  ❌ ${escapeHTML(
                    account.error
                  )}
                </div>
              `
              : ""
          }

          ${
            account.roomId
              ? `
                <div class="room">
                  Room ID:
                  ${escapeHTML(
                    account.roomId
                  )}
                </div>
              `
              : ""
          }

        </div>
      `;

    }).join("");

  document
    .querySelectorAll(
      ".remove-account"
    )
    .forEach(button => {

      button.addEventListener(
        "click",
        () => {

          removeAccount(
            button.dataset.username
          );

        }
      );

    });

  updateStats();
}

/* =========================
   BOXES
========================= */

function renderBoxes() {

  const list =
    $("boxList");

  if (!list) return;

  if (!state.boxes.length) {

    list.innerHTML = `
      <div class="empty">
        📦 لا توجد صناديق حاليًا
      </div>
    `;

    updateStats();
    return;
  }

  list.innerHTML =
    state.boxes.map(box => {

      const remaining =
        box.remaining == null
          ? "غير معروف"
          : `${box.remaining} ثانية`;

      return `
        <div class="box">

          <strong>
            📦 @${escapeHTML(
              box.username
            )}
          </strong>

          <div>
            💎 العملات:
            ${Number(
              box.diamonds || 0
            ).toLocaleString()}
          </div>

          <div>
            👥 الأشخاص:
            ${Number(
              box.people || 0
            ).toLocaleString()}
          </div>

          <div>
            ⏱️ ${remaining}
          </div>

        </div>
      `;

    }).join("");

  updateStats();
}

/* =========================
   ADD ACCOUNTS
========================= */

async function addAccounts() {

  const input =
    $("userInput");

  if (!input) return;

  const usernames =
    input.value
      .split(/[\s,\n]+/)
      .map(x => x.trim())
      .filter(Boolean);

  if (!usernames.length) {
    return;
  }

  /*
   * أظهر الحساب فورًا
   */

  for (
    const username of usernames
  ) {

    const clean =
      username
        .replace(/^@/, "")
        .toLowerCase();

    const exists =
      state.monitors.some(
        account =>
          account.username
            .toLowerCase() === clean
      );

    if (!exists) {

      state.monitors.push({

        username:
          username.replace(/^@/, ""),

        status:
          "connecting",

        viewers:
          0,

        roomId:
          null,

        error:
          null

      });

    }
  }

  renderAccounts();

  input.value = "";

  try {

    const response =
      await fetch(
        "/api/monitors",
        {

          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              usernames
            })

        }
      );

    const text =
      await response.text();

    let result;

    try {

      result =
        JSON.parse(text);

    } catch {

      result = {
        ok: false,
        error: text
      };

    }

    if (!response.ok) {

      setAccountError(
        usernames,
        result.error ||
        `HTTP ${response.status}`
      );

      return;
    }

    if (
      result.errors &&
      result.errors.length
    ) {

      for (
        const item
        of result.errors
      ) {

        setAccountError(
          [item.username],
          item.error
        );

      }

    }

  } catch (error) {

    setAccountError(
      usernames,
      "تعذر الاتصال بالسيرفر: " +
      error.message
    );

  }
}

/* =========================
   ERROR
========================= */

function setAccountError(
  usernames,
  error
) {

  for (
    const username of usernames
  ) {

    const clean =
      username
        .replace(/^@/, "")
        .toLowerCase();

    const account =
      state.monitors.find(
        m =>
          m.username
            .toLowerCase() === clean
      );

    if (account) {

      account.status =
        "error";

      account.error =
        error;

    }

  }

  renderAccounts();
}

/* =========================
   REMOVE
========================= */

async function removeAccount(
  username
) {

  try {

    const response =
      await fetch(
        "/api/monitors/" +
        encodeURIComponent(
          username
        ),
        {
          method: "DELETE"
        }
      );

    if (!response.ok) {

      throw new Error(
        `HTTP ${response.status}`
      );

    }

    state.monitors =
      state.monitors.filter(
        m =>
          m.username.toLowerCase() !==
          username.toLowerCase()
      );

    renderAccounts();

  } catch (error) {

    setAccountError(
      [username],
      "فشل الحذف: " +
      error.message
    );

  }
}

/* =========================
   ADD BUTTON
========================= */

const addButton =
  $("add");

if (addButton) {

  addButton.addEventListener(
    "click",
    addAccounts
  );

}

/* =========================
   WEBSOCKET
========================= */

function connect() {

  const protocol =
    location.protocol === "https:"
      ? "wss:"
      : "ws:";

  const socket =
    new WebSocket(
      `${protocol}//${location.host}`
    );

  socket.onopen = () => {

    const connection =
      $("connection");

    if (connection) {

      connection.textContent =
        "● Connected";

      connection.className =
        "connected";

    }

  };

  socket.onmessage =
    event => {

      try {

        const message =
          JSON.parse(
            event.data
          );

        /* STATE */

        if (
          message.type ===
          "state"
        ) {

          const serverAccounts =
            message.data?.monitors ||
            [];

          /*
           * تحديث الحسابات الموجودة
           */

          for (
            const account
            of serverAccounts
          ) {

            const index =
              state.monitors.findIndex(
                m =>
                  m.username
                    .toLowerCase() ===
                  String(
                    account.username
                  ).toLowerCase()
              );

            if (index === -1) {

              state.monitors.push(
                account
              );

            } else {

              state.monitors[index] =
                account;

            }

          }

          state.boxes =
            message.data?.boxes ||
            [];

          renderAccounts();
          renderBoxes();

        }

        /* NEW BOX */

        else if (
          message.type ===
          "box"
        ) {

          if (
            message.box
          ) {

            const exists =
              state.boxes.some(
                box =>
                  box.id ===
                  message.box.id
              );

            if (!exists) {

              state.boxes.push(
                message.box
              );

            }

          }

          renderBoxes();

        }

        /* TIMER */

        else if (
          message.type ===
          "tick"
        ) {

          state.boxes =
            message.boxes ||
            [];

          renderBoxes();

        }

      } catch (error) {

        console.error(error);

      }

    };

  socket.onclose = () => {

    const connection =
      $("connection");

    if (connection) {

      connection.textContent =
        "● Reconnecting...";

      connection.className =
        "";

    }

    setTimeout(
      connect,
      2000
    );

  };
}

/* =========================
   START
========================= */

renderAccounts();
renderBoxes();
connect();
