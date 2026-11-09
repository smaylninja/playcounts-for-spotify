"use strict";

/* Spotify Play Counts — popup logic. */

const SETTINGS_KEY = "slc:settings:v1";

const DEFAULTS = {
  enabled: true,
  placement: "cell",
  compact: false,
};

const PLACEMENTS = ["cell", "subtitle"];

const ui = {
  version: document.getElementById("version"),
  enabled: document.getElementById("enabled"),
  compact: document.getElementById("compact"),
  stats: document.getElementById("stats"),
  hint: document.getElementById("hint"),
};

const radios = Array.prototype.slice.call(
  document.querySelectorAll('input[name="placement"]'),
);

let settings = Object.assign({}, DEFAULTS);
let pollTimer = 0;

/* -------------------------------------------------------------------- */
/* Settings                                                              */
/* -------------------------------------------------------------------- */

function paint() {
  ui.enabled.checked = settings.enabled;
  ui.compact.checked = settings.compact;
  for (let i = 0; i < radios.length; i += 1) {
    radios[i].checked = radios[i].value === settings.placement;
  }
  document.body.classList.toggle("is-off", !settings.enabled);
}

function readForm() {
  let placement = settings.placement;
  for (let i = 0; i < radios.length; i += 1) {
    if (radios[i].checked) {
      placement = radios[i].value;
      break;
    }
  }
  if (PLACEMENTS.indexOf(placement) === -1) placement = DEFAULTS.placement;

  settings = {
    enabled: ui.enabled.checked,
    placement,
    compact: ui.compact.checked,
  };
}

function save() {
  try {
    chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  } catch (_) {
    /* ignore */
  }
}

/* -------------------------------------------------------------------- */
/* Stats from the content script                                         */
/* -------------------------------------------------------------------- */

function number(value) {
  const parsed = typeof value === "number" ? value : 0;
  try {
    return new Intl.NumberFormat("ru-RU").format(parsed);
  } catch (_) {
    return String(parsed);
  }
}

function line(label, value, warn) {
  const row = document.createElement("p");
  row.className = "stats__line" + (warn ? " stats__line--warn" : "");

  const name = document.createElement("span");
  name.textContent = label;

  const amount = document.createElement("span");
  amount.className = "stats__value";
  amount.textContent = value;

  row.appendChild(name);
  row.appendChild(amount);
  return row;
}

function message(text) {
  const row = document.createElement("p");
  row.className = "stats__line";
  const span = document.createElement("span");
  span.textContent = text;
  row.appendChild(span);
  return row;
}

function renderIdle(text) {
  ui.stats.textContent = "";
  ui.stats.appendChild(message(text));
  ui.hint.textContent = "";
}

function renderStats(stats) {
  const matched = typeof stats.matched === "number" ? stats.matched : 0;
  ui.stats.textContent = "";
  ui.stats.appendChild(line("Треков в кэше", number(stats.cached)));
  ui.stats.appendChild(line("Строк с треками", number(stats.withId)));
  ui.stats.appendChild(line("Из них с числом", number(matched)));
  ui.stats.appendChild(
    line(
      "Число показано",
      number(stats.shown),
      matched > 0 && stats.shown === 0,
    ),
  );

  if (!stats.enabled) {
    ui.hint.textContent = "Расширение выключено — включите переключатель выше.";
    return;
  }
  if (stats.withId === 0) {
    ui.hint.textContent =
      "На странице пока нет строк с треками. Откройте альбом или плейлист.";
    return;
  }
  if (matched === 0) {
    ui.hint.textContent =
      "Числа для этих треков ещё не пришли. Прокрутите список или обновите страницу (F5) — данные подтягиваются из ответов Spotify.";
    return;
  }
  if (stats.shown === 0) {
    ui.hint.textContent =
      "Числа есть, но вставить их в строки не удалось. Попробуйте другой вариант размещения выше.";
    return;
  }
  ui.hint.textContent = "";
}

function queryStats() {
  return new Promise((resolve) => {
    let pending;
    try {
      pending = chrome.tabs.query({ active: true, currentWindow: true });
    } catch (_) {
      resolve(null);
      return;
    }
    pending
      .then((tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || typeof tab.id !== "number") {
          resolve(null);
          return;
        }
        chrome.tabs.sendMessage(tab.id, { type: "slc:stats" }, (response) => {
          if (chrome.runtime.lastError || !response) {
            resolve(null);
            return;
          }
          resolve(response);
        });
      })
      .catch(() => resolve(null));
  });
}

async function poll() {
  const stats = await queryStats();
  if (!stats) {
    renderIdle(
      "Расширение не отвечает на этой вкладке. Откройте open.spotify.com и обновите страницу.",
    );
    return;
  }
  renderStats(stats);
}

/* -------------------------------------------------------------------- */
/* Boot                                                                  */
/* -------------------------------------------------------------------- */

function bind() {
  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!target || !target.matches || !target.matches("input")) return;
    readForm();
    paint();
    save();
    poll();
  });
}

async function start() {
  try {
    ui.version.textContent = "v" + chrome.runtime.getManifest().version;
  } catch (_) {
    ui.version.textContent = "";
  }

  try {
    const stored = await chrome.storage.sync.get(SETTINGS_KEY);
    const value = stored && stored[SETTINGS_KEY];
    if (value && typeof value === "object") {
      settings = Object.assign({}, DEFAULTS, value);
    }
  } catch (_) {
    settings = Object.assign({}, DEFAULTS);
  }

  paint();
  bind();
  poll();
  pollTimer = setInterval(poll, 1200);
}

window.addEventListener("unload", () => {
  if (pollTimer) clearInterval(pollTimer);
});

start();
