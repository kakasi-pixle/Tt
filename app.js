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

  list.innerHTML =
    state.monitors.map(account => {

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
              @${escapeHTML(
                account.username
              )}
            </strong>

            <button
              onclick="removeAccount('${escapeHTML(
                account.username
              )}')"
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
}

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
}

async function addAccounts() {

  const input =
    $("userInput");

  const usernames =
    input.value
      .split(/[\s,\n]+/)
      .map(x => x.trim())
      .filter(Boolean);

  if (!usernames.length) {
    return;
  }

  try {

    const response =
      await fetch(
        "/api/monitors",
        {
          method: "POST",

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

    const result =
      await response.json();

    if (!response.ok) {

      alert(
        result.error ||
        "حدث خطأ أثناء إضافة الحساب"
      );

      return;
    }

    input.value = "";

  } catch (error) {

    alert(
      "تعذر الاتصال بالسيرفر: " +
      error.message
    );
  }
}

async function removeAccount(
  username
) {

  try {

    await fetch(
      "/api/monitors/" +
      encodeURIComponent(
        username
      ),
      {
        method: "DELETE"
      }
    );

  } catch (error) {

    alert(
      "فشل حذف الحساب: " +
      error.message
    );
  }
}

window.removeAccount =
  removeAccount;

const addButton =
  $("add");

if (addButton) {
  addButton.onclick =
    addAccounts;
}

function connect() {

  const protocol =
    location.protocol === "https:"
      ? "wss:"
      : "ws:";

  const socket =
    new WebSocket(
      `${protocol}//${location.host}`
    );

  socket.onmessage =
    event => {

      try {

        const message =
          JSON.parse(
            event.data
          );

        if (
          message.type ===
          "state"
        ) {

          state.monitors =
            message.data?.monitors ||
            [];

          state.boxes =
            message.data?.boxes ||
            [];

          renderAccounts();
          renderBoxes();

        }

        if (
          message.type ===
          "box"
        ) {

          if (
            message.box
          ) {

            state.boxes.push(
              message.box
            );

          }

          renderBoxes();
        }

        if (
          message.type ===
          "tick"
        ) {

          state.boxes =
            message.boxes ||
            [];

          renderBoxes();
        }

      } catch (error) {

        console.error(
          error
        );
      }
    };

  socket.onclose = () => {

    setTimeout(
      connect,
      2000
    );
  };
}

connect();
