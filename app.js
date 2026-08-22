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
   ACCOUNTS
========================= */

function renderAccounts() {
  const list = $("accountList");

  if (!list) return;

  if (!state.monitors.length) {
    list.innerHTML = `
      <div class="empty">
        لا توجد حسابات مضافة
      </div>
    `;
    return;
  }

  list.innerHTML = state.monitors.map(account => {

    let status = "🟡 جاري الاتصال";
    let className = "connecting";

    if (account.status === "live") {
      status =
        `🟢 LIVE — ${Number(
          account.viewers || 0
        ).toLocaleString()} مشاهد`;

      className = "live";
    }

    if (account.status === "offline") {
      status = "⚪ Offline";
      className = "offline";
    }

    if (account.status === "error") {
      status = "🔴 فشل الاتصال";
      className = "error";
    }

    return `
      <div class="account ${className}">

        <div class="account-top">

          <strong>
            @${escapeHTML(account.username)}
          </strong>

          <button
            type="button"
            class="remove-account"
            data-username="${escapeHTML(account.username)}"
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
                ❌ ${escapeHTML(account.error)}
              </div>
            `
            : ""
        }

        ${
          account.roomId
            ? `
              <div class="room">
                Room ID:
                ${escapeHTML(account.roomId)}
              </div>
            `
            : ""
        }

      </div>
    `;
  }).join("");

  document
    .querySelectorAll(".remove-account")
    .forEach(button => {

      button.addEventListener("click", () => {
        removeAccount(
          button.dataset.username
        );
      });

    });
}

/* =========================
   BOXES
========================= */

function renderBoxes() {
  const list = $("boxList");

  if (!list) return;

  if (!state.boxes.length) {
    list.innerHTML = `
      <div class="empty">
        📦 لا توجد صناديق حاليًا
      </div>
    `;
    return;
  }

  list.innerHTML = state.boxes.map(box => {

    const remaining =
      box.remaining == null
        ? "غير معروف"
        : `${box.remaining} ثانية`;

    return `
      <div class="box">

        <strong>
          📦 @${escapeHTML(box.username)}
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
}

/* =========================
   ADD ACCOUNT
========================= */

async function addAccounts() {

  const input = $("userInput");

  if (!input) return;

  const usernames = input.value
    .split(/[\s,\n]+/)
    .map(x => x.trim())
    .filter(Boolean);

  if (!usernames.length) {
    return;
  }

  /*
   * أظهر الحساب فورًا.
   * لا ننتظر السيرفر.
   */
  for (const username of usernames) {

    const exists =
      state.monitors.some(
        m =>
          m.username.toLowerCase() ===
          username
            .replace(/^@/, "")
            .toLowerCase()
      );

    if (!exists) {
      state.monitors.push({
        username:
          username.replace(/^@/, ""),
        status: "connecting",
        viewers: 0,
        roomId: null,
        error: null
      });
    }
  }

  renderAccounts();

  input.value = "";

  try {

    const response = await fetch(
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

    const text =
      await response.text();

    let result;

    try {
      result = JSON.parse(text);
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

    /*
     * لو السيرفر أعاد خطأ
     */
    if (
      result.errors &&
      result.errors.length
    ) {

      for (const item of result.errors) {

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
   LOCAL ERROR
========================= */

function setAccountError(
  usernames,
  error
) {

  for (const username of usernames) {

    const clean =
      username
        .replace(/^@/, "")
        .toLowerCase();

    const account =
      state.monitors.find(
        m =>
          m.username.toLowerCase() ===
          clean
      );

    if (account) {

      account.status = "error";
      account.error = error;
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
        encodeURIComponent(username),
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

    const account =
      state.monitors.find(
        m =>
          m.username.toLowerCase() ===
          username.toLowerCase()
      );

    if (account) {
      account.status = "error";
      account.error =
        "فشل الحذف: " +
        error.message;
    }

    renderAccounts();
  }
}

/* =========================
   ADD BUTTON
========================= */

const addButton = $("add");

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

    console.log(
      "WebSocket connected"
    );
  };

  socket.onmessage = event => {

    try {

      const message =
        JSON.parse(event.data);

      /*
       * SERVER STATE
       */
      if (
        message.type === "state"
      ) {

        const serverMonitors =
          Array.isArray(
            message.data?.monitors
          )
            ? message.data.monitors
            : [];

        /*
         * لا نمسح الحسابات المحلية
         * التي لم يصلها السيرفر بعد.
         */
        for (
          const serverAccount
          of serverMonitors
        ) {

          const index =
            state.monitors.findIndex(
              m =>
                m.username.toLowerCase() ===
                String(
                  serverAccount.username
                ).toLowerCase()
            );

          if (index === -1) {

            state.monitors.push(
              serverAccount
            );

          } else {

            state.monitors[index] =
              serverAccount;
          }
        }

        state.boxes =
          Array.isArray(
            message.data?.boxes
          )
            ? message.data.boxes
            : [];

        renderAccounts();
        renderBoxes();
      }

      /*
       * NEW BOX
       */
      else if (
        message.type === "box"
      ) {

        if (message.box) {

          const exists =
            state.boxes.some(
              b =>
                b.id ===
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

      /*
       * TIMER
       */
      else if (
        message.type === "tick"
      ) {

        state.boxes =
          Array.isArray(
            message.boxes
          )
            ? message.boxes
            : [];

        renderBoxes();
      }

    } catch (error) {

      console.error(
        "WebSocket message error:",
        error
      );
    }
  };

  socket.onerror = error => {

    console.error(
      "WebSocket error:",
      error
    );
  };

  socket.onclose = () => {

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
