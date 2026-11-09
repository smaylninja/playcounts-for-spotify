/*!
 * Spotify Play Counts — content script (isolated world).
 *
 * • listens for the { trackId: playcount } maps posted by inject.js;
 * • keeps them in memory and in chrome.storage.local (so revisits are instant);
 * • finds Spotify's track rows and puts the number into each row.
 *
 * Rendering is deliberately defensive: Spotify's class names are hashed on
 * every deploy, so we only rely on stable hooks (`data-testid="tracklist-row"`,
 * `role="row"`, links to /track/<id>) and we never throw when something is
 * missing — a row without a recognised structure is simply skipped.
 */
(() => {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Constants                                                           */
  /* ------------------------------------------------------------------ */

  const MSG_SOURCE = "slc-playcounts";
  const CACHE_KEY = "slc:cache:v1";
  const SETTINGS_KEY = "slc:settings:v1";

  const ID_RE = /^[0-9A-Za-z]{22}$/;
  const TRACK_HREF_RE = /\/track\/([0-9A-Za-z]{22})(?:[/?#]|$)/;
  const ROW_SELECTOR = '[data-testid="tracklist-row"],[role="row"]';
  // Spotify may prefix paths with a locale: /intl-ru/album/…, /intl-de/playlist/…
  const LOCALE_PREFIX_RE = /^\/intl-[a-z]{2}(?:-[a-z]{2,4})?(?=\/)/i;
  const ALBUM_LIKE_RE = /^\/(?:album|playlist|user)\//;
  const LIKED_RE = /^\/collection\/tracks/;

  const MAX_CACHE = 300000;
  const MAX_PERSIST = 50000;
  const RENDER_DELAY = 80;
  const PERSIST_DELAY = 5000;

  const DEFAULTS = {
    enabled: true,
    placement: "cell", // 'cell' | 'subtitle'
    compact: false,
    allPages: false,
  };

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  let settings = Object.assign({}, DEFAULTS);
  const cache = new Map();
  let cacheLoaded = false;
  let cacheDirty = false;
  let persistTimer = 0;
  let renderTimer = 0;
  let lastStats = { rows: 0, withId: 0, matched: 0, shown: 0 };
  let debugOn = false;

  let fullFormatter = null;
  let compactFormatter = null;

  try {
    debugOn = window.localStorage.getItem("slc:debug") === "1";
  } catch (_) {
    debugOn = false;
  }

  const log = (...args) => {
    if (debugOn) {
      console.log(
        "%c[SpotifyPlays]",
        "color:#1db954;font-weight:bold",
        ...args,
      );
    }
  };

  /* ------------------------------------------------------------------ */
  /* Helpers: numbers                                                    */
  /* ------------------------------------------------------------------ */

  function getFullFormatter() {
    if (!fullFormatter) {
      try {
        fullFormatter = new Intl.NumberFormat("ru-RU");
      } catch (_) {
        fullFormatter = null;
      }
    }
    return fullFormatter;
  }

  function getCompactFormatter() {
    if (!compactFormatter) {
      try {
        compactFormatter = new Intl.NumberFormat("ru-RU", {
          notation: "compact",
          maximumFractionDigits: 1,
        });
      } catch (_) {
        compactFormatter = null;
      }
    }
    return compactFormatter;
  }

  function formatFull(value) {
    const formatter = getFullFormatter();
    if (!formatter) return String(value);
    try {
      return formatter.format(value);
    } catch (_) {
      return String(value);
    }
  }

  function formatShort(value) {
    if (!settings.compact) return formatFull(value);
    const formatter = getCompactFormatter();
    if (!formatter) return formatFull(value);
    try {
      return formatter.format(value);
    } catch (_) {
      return formatFull(value);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Helpers: DOM                                                        */
  /* ------------------------------------------------------------------ */

  function currentPath() {
    try {
      return String(window.location.pathname || "").replace(
        LOCALE_PREFIX_RE,
        "",
      );
    } catch (_) {
      return "";
    }
  }

  function pageAllowed() {
    if (settings.allPages) return true;
    const path = currentPath();
    return ALBUM_LIKE_RE.test(path) || LIKED_RE.test(path);
  }

  function titleLink(row) {
    const preferred = row.querySelector('a[data-testid="internal-track-link"]');
    if (preferred) return preferred;
    return row.querySelector('a[href*="/track/"]');
  }

  function trackIdFromRow(row) {
    const link = titleLink(row);
    if (!link) return null;
    const href = link.getAttribute("href") || "";
    const match = TRACK_HREF_RE.exec(href);
    return match ? match[1] : null;
  }

  /**
   * The line that holds the artists (or show/host) of a row. Playlist/album
   * rows use it for "Artist • 1 234 567", which looks native.
   */
  function subtitleLine(row, title) {
    const links = row.querySelectorAll(
      'a[href*="/artist/"],a[href*="/show/"],a[href*="/user/"]',
    );
    for (let i = 0; i < links.length; i += 1) {
      const link = links[i];
      if (link === title) continue;
      const parent = link.parentElement;
      if (!parent || parent === row) continue;
      if (title && parent.contains(title)) continue;
      return parent;
    }
    return null;
  }

  /**
   * Decides where the badge goes. Every strategy falls back to the next one,
   * so an unexpected markup still produces something reasonable.
   */
  function resolveAnchor(row, mode) {
    const title = titleLink(row);
    if (!title) return null;

    if (mode === "subtitle") {
      const subtitle = subtitleLine(row, title);
      if (subtitle) return { el: subtitle, kind: "append" };
    }

    return { el: title, kind: "after" };
  }

  function createBadge() {
    const badge = document.createElement("span");
    badge.className = "slc-badge";
    return badge;
  }

  function decorateBadge(badge, count) {
    badge.className = "slc-badge slc-badge--" + settings.placement;
    badge.textContent = formatShort(count);
    badge.title = "Всего прослушиваний: " + formatFull(count);
    badge.setAttribute("data-slc-count", String(count));
  }

  function placeBadge(badge, anchor) {
    if (anchor.kind === "append") {
      anchor.el.appendChild(badge);
    } else {
      anchor.el.insertAdjacentElement("afterend", badge);
    }
  }

  function clearRow(row) {
    const badges = row.querySelectorAll(".slc-badge");
    for (let i = 0; i < badges.length; i += 1) badges[i].remove();
    if (row.dataset) {
      delete row.dataset.slcSig;
      delete row.dataset.slcId;
    }
  }

  function removeAllBadges() {
    const badges = document.querySelectorAll(".slc-badge");
    for (let i = 0; i < badges.length; i += 1) badges[i].remove();
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  function applyToRow(row, id) {
    const count = cache.get(id);
    if (typeof count !== "number") {
      if (row.dataset && row.dataset.slcId && row.dataset.slcId !== id)
        clearRow(row);
      return false;
    }

    const signature =
      id +
      "|" +
      count +
      "|" +
      settings.placement +
      "|" +
      (settings.compact ? "1" : "0");
    let badge = row.querySelector(".slc-badge");

    if (
      badge &&
      badge.isConnected &&
      row.dataset &&
      row.dataset.slcSig === signature
    ) {
      return true;
    }

    if (!row.dataset.slcId || row.dataset.slcId !== id) {
      // The row element was recycled by React for another track.
      if (badge) badge.remove();
      badge = null;
    }

    const anchor = resolveAnchor(row, settings.placement);
    if (!anchor) return false;

    if (!badge) badge = createBadge();
    decorateBadge(badge, count);
    placeBadge(badge, anchor);

    if (row.dataset) {
      row.dataset.slcSig = signature;
      row.dataset.slcId = id;
    }
    return true;
  }

  function render() {
    if (!cacheLoaded) return;

    if (!settings.enabled || !pageAllowed()) {
      removeAllBadges();
      lastStats = { rows: 0, withId: 0, matched: 0, shown: 0 };
      return;
    }

    let rows;
    try {
      rows = document.querySelectorAll(ROW_SELECTOR);
    } catch (_) {
      return;
    }

    let withId = 0;
    let matched = 0;
    let shown = 0;

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      let id = null;
      try {
        id = trackIdFromRow(row);
      } catch (_) {
        id = null;
      }
      if (!id) {
        if (row.dataset && row.dataset.slcSig) clearRow(row);
        continue;
      }
      withId += 1;
      if (cache.has(id)) matched += 1;
      try {
        if (applyToRow(row, id)) shown += 1;
      } catch (_) {
        /* never let one broken row stop the whole pass */
      }
    }

    lastStats = { rows: rows.length, withId, matched, shown };
    log(
      "rows",
      rows.length,
      "| tracks",
      withId,
      "| with number",
      matched,
      "| badges",
      shown,
      "| cache",
      cache.size,
    );
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = 0;
      render();
    }, RENDER_DELAY);
  }

  /* ------------------------------------------------------------------ */
  /* Cache persistence                                                   */
  /* ------------------------------------------------------------------ */

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      persistCache();
    }, PERSIST_DELAY);
  }

  function persistCache() {
    if (!cacheDirty) return;
    cacheDirty = false;
    const plain = Object.create(null);
    let written = 0;
    for (const entry of cache) {
      if (written >= MAX_PERSIST) break;
      plain[entry[0]] = entry[1];
      written += 1;
    }
    try {
      chrome.storage.local.set({ [CACHE_KEY]: plain }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {
      /* extension reloaded / storage unavailable */
    }
  }

  function loadCache() {
    let request;
    try {
      request = chrome.storage.local.get(CACHE_KEY);
    } catch (_) {
      cacheLoaded = true;
      scheduleRender();
      return;
    }
    request
      .then((stored) => {
        const plain = stored && stored[CACHE_KEY];
        if (plain && typeof plain === "object") {
          for (const id in plain) {
            if (!ID_RE.test(id)) continue;
            const value = plain[id];
            if (typeof value === "number" && value >= 0) cache.set(id, value);
          }
        }
        cacheLoaded = true;
        log("loaded", cache.size, "cached play counts");
        scheduleRender();
      })
      .catch(() => {
        cacheLoaded = true;
        scheduleRender();
      });
  }

  function loadSettings() {
    let request;
    try {
      request = chrome.storage.sync.get(SETTINGS_KEY);
    } catch (_) {
      scheduleRender();
      return;
    }
    request
      .then((stored) => {
        const value = stored && stored[SETTINGS_KEY];
        if (value && typeof value === "object") {
          settings = Object.assign({}, DEFAULTS, value);
        }
        scheduleRender();
      })
      .catch(() => {
        scheduleRender();
      });
  }

  /* ------------------------------------------------------------------ */
  /* Incoming play counts                                                */
  /* ------------------------------------------------------------------ */

  function absorb(data) {
    if (!data || typeof data !== "object") return 0;
    let added = 0;
    for (const id in data) {
      if (!ID_RE.test(id)) continue;
      const value = data[id];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        continue;
      if (cache.get(id) !== value) {
        if (cache.size >= MAX_CACHE) break;
        cache.set(id, value);
        added += 1;
      }
    }
    return added;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const payload = event.data;
    if (!payload || payload.source !== MSG_SOURCE) return;

    const added = absorb(payload.data);
    if (added === 0) return;

    cacheDirty = true;
    schedulePersist();
    scheduleRender();
    if (debugOn) log("received", added, "counts, cache size", cache.size);
  });

  /* ------------------------------------------------------------------ */
  /* Mutation observer                                                   */
  /* ------------------------------------------------------------------ */

  function isOwnNode(node) {
    return (
      node &&
      node.nodeType === 1 &&
      node.classList &&
      node.classList.contains("slc-badge")
    );
  }

  /**
   * Ignore the mutations our own rendering produces, but never ignore
   * removals: React may wipe a badge during a re-render, and then the row has
   * to be visited again.
   */
  function recordsAreOurs(records) {
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      const target = record.target;
      if (
        target &&
        target.nodeType === 1 &&
        target.closest &&
        target.closest(".slc-badge")
      ) {
        continue;
      }
      if (record.type === "childList") {
        if (record.removedNodes.length > 0) return false;
        let ours = true;
        const added = record.addedNodes;
        for (let j = 0; j < added.length; j += 1) {
          if (!isOwnNode(added[j])) {
            ours = false;
            break;
          }
        }
        if (ours) continue;
      }
      return false;
    }
    return true;
  }

  function startObserving() {
    const root = document.documentElement || document.body;
    if (!root) return;
    const observer = new MutationObserver((records) => {
      if (recordsAreOurs(records)) return;
      scheduleRender();
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------ */
  /* Messaging with the popup                                            */
  /* ------------------------------------------------------------------ */

  function buildStats() {
    return {
      enabled: settings.enabled,
      placement: settings.placement,
      pageAllowed: pageAllowed(),
      path: currentPath(),
      rows: lastStats.rows,
      withId: lastStats.withId,
      matched: lastStats.matched,
      shown: lastStats.shown,
      cached: cache.size,
      debug: debugOn,
    };
  }

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== "object") return undefined;
      if (message.type === "slc:stats") {
        sendResponse(buildStats());
        return undefined;
      }
      if (message.type === "slc:rescan") {
        render();
        sendResponse(buildStats());
        return undefined;
      }
      return undefined;
    });
  } catch (_) {
    /* extension context is gone (reloaded/updated) */
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !changes[SETTINGS_KEY]) return;
      const value = changes[SETTINGS_KEY].newValue;
      settings =
        value && typeof value === "object"
          ? Object.assign({}, DEFAULTS, value)
          : Object.assign({}, DEFAULTS);
      scheduleRender();
    });
  } catch (_) {
    /* ignore */
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  function boot() {
    startObserving();
    loadSettings();
    loadCache();
    scheduleRender();
    log("content script ready");
  }

  if (document.documentElement) {
    boot();
  } else {
    const once = new MutationObserver(() => {
      if (!document.documentElement) return;
      once.disconnect();
      boot();
    });
    once.observe(document, { childList: true, subtree: true });
  }
})();
