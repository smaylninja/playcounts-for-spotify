/*!
 * Spotify Play Counts — MAIN-world hook.
 *
 * Runs at document_start in the page's own JavaScript context (before
 * Spotify's bundle) and wraps fetch / XMLHttpRequest so that every answer of
 * the GraphQL "pathfinder" endpoint can be inspected.
 *
 * A typical album/playlist answer looks like this (trimmed):
 *
 *   {"data":{"albumUnion":{"tracksV2":{"items":[
 *      {"uid":"...","track":{"uri":"spotify:track:2ov1wwG4...","playcount":"1234567"}}
 *   ]}}}}
 *
 * We do not hard-code that path: any object carrying both a
 * "spotify:track:*" uri and a numeric "playcount" is collected, no matter how
 * deeply it is nested or which operation produced it (getAlbum, fetchPlaylist,
 * queryArtistOverview, ...). The resulting { trackId: playcount } map is
 * posted to the isolated content script.
 */
(() => {
  'use strict';

  const CHANNEL = 'slc-playcounts';
  const TRACK_PREFIX = 'spotify:track:';
  const BATCH_DELAY = 250;
  const MAX_DEPTH = 40;
  const MAX_COUNT = Number.MAX_SAFE_INTEGER;

  let debugOn = false;
  try {
    debugOn = window.localStorage.getItem('slc:debug') === '1';
  } catch (_) {
    debugOn = false;
  }

  const log = (...args) => {
    if (debugOn) {
      console.log('%c[SpotifyPlays]', 'color:#1db954;font-weight:bold', ...args);
    }
  };

  /* ------------------------------------------------------------------ */
  /* Extract play counts                                                 */
  /* ------------------------------------------------------------------ */

  function toCount(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) && value >= 0 && value <= MAX_COUNT
        ? Math.round(value)
        : null;
    }
    if (typeof value === 'string') {
      const text = value.trim();
      if (!/^\d{1,15}$/.test(text)) return null;
      const parsed = Number(text);
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
  }

  function ownTrackId(node) {
    const uri = node.uri;
    if (typeof uri === 'string' && uri.lastIndexOf(TRACK_PREFIX, 0) === 0) {
      const id = uri.slice(TRACK_PREFIX.length);
      if (/^[0-9A-Za-z]{22}$/.test(id)) return id;
    }
    if (
      node.__typename === 'Track' &&
      typeof node.id === 'string' &&
      /^[0-9A-Za-z]{22}$/.test(node.id)
    ) {
      return node.id;
    }
    return null;
  }

  /**
   * Some payloads put playcount on the wrapper item instead of the track
   * itself: {"uid":"…","playcount":"…","track":{"uri":…}}. Resolve the track
   * through the known wrapper field names only, so an album-level counter can
   * never be attributed to a random nested object.
   */
  const WRAPPER_KEYS = ['track', 'trackUnion', 'trackV2', 'data', 'item', 'itemV2', 'entity'];

  function nestedTrackId(node) {
    for (let i = 0; i < WRAPPER_KEYS.length; i += 1) {
      const child = node[WRAPPER_KEYS[i]];
      if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
      const id = ownTrackId(child);
      if (id) return id;
    }
    return null;
  }

  function walk(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) walk(node[i], out, depth + 1);
      return;
    }

    let raw;
    if (Object.prototype.hasOwnProperty.call(node, 'playcount')) raw = node.playcount;
    else if (Object.prototype.hasOwnProperty.call(node, 'playCount')) raw = node.playCount;

    const count = toCount(raw);
    if (count !== null) {
      const id = ownTrackId(node) || nestedTrackId(node);
      if (id) out[id] = count;
    }

    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (key === 'uri' || key === 'playcount' || key === 'playCount') continue;
      const child = node[key];
      if (child && typeof child === 'object') walk(child, out, depth + 1);
    }
  }

  function extract(text) {
    if (typeof text !== 'string' || text.length < 20) return null;
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      return null;
    }
    const found = Object.create(null);
    walk(json, found, 0);
    return found;
  }

  /* ------------------------------------------------------------------ */
  /* Batching → postMessage                                              */
  /* ------------------------------------------------------------------ */

  let pending = Object.create(null);
  let pendingSize = 0;
  let flushTimer = 0;

  function flush() {
    flushTimer = 0;
    if (pendingSize === 0) return;
    const data = pending;
    pending = Object.create(null);
    pendingSize = 0;
    try {
      window.postMessage({ source: CHANNEL, data }, '*');
    } catch (error) {
      log('postMessage failed', error);
      return;
    }
    log('sent', Object.keys(data).length, 'play counts');
  }

  function enqueue(found) {
    if (!found) return;
    let added = 0;
    const ids = Object.keys(found);
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      pending[id] = found[id];
      added += 1;
    }
    if (added === 0) return;
    pendingSize += added;
    if (!flushTimer) flushTimer = setTimeout(flush, BATCH_DELAY);
  }

  function consume(text, label) {
    const found = extract(text);
    if (!found) return;
    const ids = Object.keys(found);
    if (ids.length === 0) return;
    log('found', ids.length, 'tracks in', label);
    enqueue(found);
  }

  /* ------------------------------------------------------------------ */
  /* Network hooks                                                       */
  /* ------------------------------------------------------------------ */

  function isTarget(url) {
    if (typeof url !== 'string') return false;
    return url.indexOf('api-partner.spotify.com') !== -1 && url.indexOf('/pathfinder/') !== -1;
  }

  function guessLabel(url) {
    try {
      return new URL(url, location.href).pathname;
    } catch (_) {
      return String(url).slice(0, 80);
    }
  }

  /* fetch ------------------------------------------------------------------ */

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function fetch(input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      const promise = nativeFetch.apply(this, arguments);
      if (isTarget(url)) {
        try {
          promise.then((response) => {
            try {
              const body = response.clone().text();
              body.then((text) => consume(text, guessLabel(url))).catch(() => {});
            } catch (_) {
              /* response body already used / not readable — ignore */
            }
          }).catch(() => {});
        } catch (_) {
          /* ignore */
        }
      }
      return promise;
    };
  }

  /* XMLHttpRequest --------------------------------------------------------- */

  const xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (xhrProto && typeof xhrProto.open === 'function' && typeof xhrProto.send === 'function') {
    const nativeOpen = xhrProto.open;
    const nativeSend = xhrProto.send;

    xhrProto.open = function open(method, url) {
      try {
        this.__slcUrl = url;
      } catch (_) {
        /* ignore */
      }
      return nativeOpen.apply(this, arguments);
    };

    xhrProto.send = function send() {
      try {
        const url = this.__slcUrl;
        if (isTarget(url)) {
          this.addEventListener('load', function onLoad() {
            try {
              const type = this.responseType;
              if (type === '' || type === 'text') {
                consume(this.responseText, guessLabel(url));
              } else if (type === 'json') {
                const found = Object.create(null);
                walk(this.response, found, 0);
                enqueue(found);
              } else if (type === 'arraybuffer' && this.response) {
                consume(new TextDecoder().decode(this.response), guessLabel(url));
              } else if (type === 'blob' && this.response && this.response.text) {
                this.response.text().then((text) => consume(text, guessLabel(url))).catch(() => {});
              }
            } catch (_) {
              /* ignore */
            }
          });
        }
      } catch (_) {
        /* ignore */
      }
      return nativeSend.apply(this, arguments);
    };
  }

  /* ------------------------------------------------------------------ */
  /* Tiny diagnostics hook for the DevTools console                      */
  /* ------------------------------------------------------------------ */

  try {
    window.__spotifyPlaysDebug = {
      get enabled() {
        return debugOn;
      },
      extract(text) {
        const found = extract(text);
        return found ? Object.keys(found).length : 0;
      },
    };
  } catch (_) {
    /* ignore */
  }

  log('hook installed');
})();
