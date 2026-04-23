// ==UserScript==
// @name         KickTiny
// @namespace    https://github.com/reda777/kicktiny
// @version      0.4.0
// @description  Custom player overlay for Kick.com embeds with DVR
// @author       Reda777
// @match        https://player.kick.com/*
// @updateURL    https://raw.githubusercontent.com/reda777/kicktiny/main/dist/kicktiny.user.js
// @downloadURL  https://raw.githubusercontent.com/reda777/kicktiny/main/dist/kicktiny.user.js
// @supportURL   https://github.com/reda777/kicktiny
// @grant        none
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function() {
'use strict';

// ── store.js ──
// ── store.js ──────────────────────────────────────────────────────────────────
// Creates the application state store. Call createStore() once in main.js and
// pass the returned object to every module that needs it.
//
// API:
//   store.getState()          → state object (treat as readonly outside store)
//   store.setState(patch)     → merge patch, notify subscribers on change
//   store.subscribe(fn)       → fn(state) on every change; returns unsub()
//   store.select(sel, cb)     → cb(slice) only when selected slice changes; returns unsub()

function createStore() {
  const state = {
    // lifecycle
    engine:  'ivs',
    alive:   false,

    // DVR
    dvrAvailable:  false,
    uptimeSec:     0,
    dvrBehindLive: 0,
    dvrWindowSec:  0,
    dvrQualities:  [],
    dvrQuality:    null,

    // stream metadata
    vodId:           null,
    streamStartTime: null,

    // playback
    playing:     false,
    buffering:   false,
    qualities:   [],
    quality:     null,
    autoQuality: true,
    volume:      50,
    muted:       false,
    fullscreen:  false,
    rate:        1,
    atLiveEdge:  true,

    // channel
    username:    '',
    displayName: '',
    avatar:      '',
    viewers:     null,
    title:       null,
    error:       null,
  };

  const _knownKeys = new Set(Object.keys(state));
  const _listeners = new Set();

  // Handles primitives, flat arrays, and plain objects (e.g. quality objects).
  // Without object support, quality comparisons always fail reference equality,
  // causing unnecessary subscriber re-renders on every quality-changed event.
  function shallowEqual(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (Array.isArray(a) && Array.isArray(b))
      return a.length === b.length && a.every((v, i) => v === b[i]);
    if (typeof a === 'object' && typeof b === 'object') {
      const ka = Object.keys(a), kb = Object.keys(b);
      if (ka.length !== kb.length) return false;
      return ka.every(k => a[k] === b[k]);
    }
    return false;
  }

  function getState() { return { ...state }; }

  function setState(patch) {
    let changed = false;
    for (const k in patch) {
      if (!_knownKeys.has(k)) {
        console.warn(`[KickTiny] setState: unknown key "${k}" — typo?`);
        continue;
      }
      if (!shallowEqual(state[k], patch[k])) {
        state[k] = patch[k];
        changed = true;
      }
    }
    if (changed) _listeners.forEach(fn => fn(state));
  }

  function subscribe(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
  }

  // Fires callback only when the selected slice actually changes.
  // Use this in UI components to avoid re-renders from unrelated state updates
  // (e.g. the 500ms position poll or 1s uptime ticker).
  function select(selectorFn, callback) {
    let prev = selectorFn(state);
    return subscribe(s => {
      const next = selectorFn(s);
      if (!shallowEqual(prev, next)) { prev = next; callback(next, s); }
    });
  }

  return { getState, setState, subscribe, select };
}


// ── prefs.js ──
const KEYS = {
  quality: 'kt.quality',
  volume:  'kt.volume',
};

function loadPrefs() {
  return {
    quality: localStorage.getItem(KEYS.quality) || null,
    volume:  localStorage.getItem(KEYS.volume) !== null
               ? Number(localStorage.getItem(KEYS.volume)) : null,
  };
}

function savePrefs(patch) {
  if ('quality' in patch) {
    if (patch.quality === null) localStorage.removeItem(KEYS.quality);
    else localStorage.setItem(KEYS.quality, patch.quality);
  }
  if ('volume' in patch) {
    localStorage.setItem(KEYS.volume, String(patch.volume));
  }
}


// ── api.js ──
const BASE = 'https://kick.com';

async function get(path) {
  const res = await fetch(BASE + path, {
    credentials: 'omit',
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

async function fetchChannelInfo(username) {
  return get(`/api/v2/channels/${username}/info`);
}

async function fetchChannelInit(username) {
  try {
    const data = await fetchChannelInfo(username);
    const ls = data?.livestream ?? null;
    return {
      isLive:       ls?.is_live === true,
      displayName:  data?.user?.username    ?? null,
      avatar:       data?.user?.profile_pic ?? null,
      vodId:        ls?.vod_id              ?? null,
      livestreamId: ls?.id                  ?? null,
      viewers:      ls?.viewer_count        ?? null,
      startTime:    ls?.start_time          ?? null,
      title:        ls?.session_title       ?? null,
    };
  } catch {
    return { isLive: null, displayName: null, avatar: null, vodId: null, livestreamId: null, viewers: null, startTime: null, title: null };
  }
}

function getDeviceId() {
  const KEY = 'kt.deviceId';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

async function fetchVodPlaybackUrl(vodId) {
  try {
    const res = await fetch(
      `https://web.kick.com/api/v1/stream/${encodeURIComponent(vodId)}/playback`,
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Accept':       'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          video_player: {
            player: {
              player_name:             'web',
              player_version:          'web_7a224cf6',
              player_software:         'IVS Player',
              player_software_version: '1.49.0',
            },
            mux_sdk:        { sdk_available: false },
            datazoom_sdk:   { sdk_available: false },
            google_ads_sdk: { sdk_available: false },
          },
          video_session: {
            page_type:              'channel',
            player_remote_played:   false,
            viewer_connection_type: '',
            enable_sampling:        false,
          },
          user_session: {
            player_device_id:               getDeviceId(),
            player_resettable_id:           '',
            player_resettable_consent_type: '',
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const dvr = data?.playback_url?.vod ?? null;
    if (!dvr) throw new Error('vod field missing from response');
    return dvr;
  } catch (e) {
    console.warn('[KickTiny DVR] fetchVodPlaybackUrl failed:', e.message);
    return null;
  }
}

// ── constants.js ──
// ── constants.js ──────────────────────────────────────────────────────────────
// Single source of truth for every magic number in KickTiny.
// Import this module wherever a numeric literal would otherwise appear.

// ── live-edge thresholds ──────────────────────────────────────────────────────
/** IVS live-latency (seconds) below which we consider playback at the live edge */
const LIVE_EDGE_LATENCY_SEC    = 3.5;
/** DVR behindLive (seconds) below which we consider playback at the live edge */
const LIVE_EDGE_BEHIND_SEC     = 30;

// ── UI timers ─────────────────────────────────────────────────────────────────
/** Milliseconds before the control bar auto-hides after the mouse stops moving */
const CONTROLS_HIDE_DELAY_MS   = 3_000;
/** Milliseconds after the mouse leaves the bar before it fades */
const CONTROLS_LEAVE_DELAY_MS  = 500;
/** Milliseconds between clicks to count as a double-click (fullscreen toggle) */
const DOUBLE_CLICK_WINDOW_MS   = 250;
/** Milliseconds between channel-info poll requests */
const POLL_INTERVAL_MS         = 60_000;
/** Milliseconds to debounce saving volume to localStorage */
const VOLUME_SAVE_DEBOUNCE_MS  = 300;

// ── IVS adapter ───────────────────────────────────────────────────────────────
/** Milliseconds between retries when searching for the IVS player in the React tree */
const ADAPTER_RETRY_INTERVAL_MS = 500;
/** Maximum number of IVS player extraction retries before giving up */
const ADAPTER_MAX_RETRIES       = 40;
/** Milliseconds between live-latency samples (used for atLiveEdge updates) */
const LATENCY_POLL_INTERVAL_MS  = 1_000;

// ── DVR controller ────────────────────────────────────────────────────────────
// FIX: reduced from 8000 — we now use HLS events as primary signal,
// this is only the hard timeout fallback.
/** Maximum milliseconds to wait for the HLS seekable window to become available */
const SEEKABLE_WAIT_MS          = 4_000;
/** Milliseconds before JWT expiry at which we pre-fetch a fresh VOD URL */
const EXPIRY_LEAD_MS            = 2 * 60_000;
/** Fallback refresh interval (ms) when no JWT expiry can be parsed from the URL */
const FALLBACK_REFRESH_MS       = 50 * 60_000;
/** Milliseconds between catch-up segment extrapolation attempts */
const CATCH_UP_INTERVAL_MS      = 12_500;
/** Seconds from the seekable end at which catch-up mode activates */
const NEAR_END_THRESHOLD_SEC    = 60;
/** Milliseconds between DVR position-poll ticks */
const POSITION_POLL_INTERVAL_MS = 500;

// ── error recovery ────────────────────────────────────────────────────────────
/** IVS recoverable-error codes that trigger a full page reload */
const RECONNECT_CODES           = new Set([-2, -3]);
/** Maximum times we re-apply a saved quality preference before giving up */
const MAX_REAPPLY_ATTEMPTS      = 3;
/** Maximum page-reload attempts for transient IVS errors before giving up */
const MAX_RELOAD_ATTEMPTS       = 3;

// ── CDNs for hls.js — tried in order ────────────────────────────────────────
const HLS_CDNS = [
  'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js',
];


// ── hls-loader.js — shared, pre-loaded eagerly ──────────────────────────────
// FIX: hls.js is now loaded once at startup (non-blocking) so it's ready
// by the time the user first clicks into DVR. Previously it was fetched
// lazily on first DVR entry, adding a cold CDN round-trip at the worst moment.

let _hlsLoadPromise = null;

function preloadHlsJs() {
  if (_hlsLoadPromise) return _hlsLoadPromise;
  _hlsLoadPromise = new Promise((resolve, reject) => {
    if (window.Hls) { resolve(window.Hls); return; }
    let idx = 0;
    function tryNext() {
      if (idx >= HLS_CDNS.length) { reject(new Error('hls.js failed to load')); return; }
      const s = document.createElement('script');
      s.src = HLS_CDNS[idx++];
      s.onload  = () => window.Hls ? resolve(window.Hls) : tryNext();
      s.onerror = () => tryNext();
      document.head.appendChild(s);
    }
    tryNext();
  });
  return _hlsLoadPromise;
}

// Kick off hls.js download immediately — runs in background, never blocks init.
// By the time the user interacts with DVR it will already be cached.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => preloadHlsJs(), { once: true });
} else {
  preloadHlsJs();
}


// ── engines/ivs-engine.js ──
// ── engines/ivs-engine.js ────────────────────────────────────────────────────
// IVS player adapter. Extracted from adapter.js.
// Receives the store and prefs as constructor parameters — no global imports.
//
// Usage:
//   const ivs = createIvsEngine(store, prefs);
//   ivs.init();
//   ivs.play(); ivs.setVolume(80); ...
//   ivs.destroy();


const EV = {
  STATE_CHANGED:         'PlayerStateChanged',
  QUALITY_CHANGED:       'PlayerQualityChanged',
  VOLUME_CHANGED:        'PlayerVolumeChanged',
  MUTED_CHANGED:         'PlayerMutedChanged',
  PLAYBACK_RATE_CHANGED: 'PlayerPlaybackRateChanged',
  ERROR:                 'PlayerError',
  RECOVERABLE_ERROR:     'PlayerRecoverableError',
};
const PS = { PLAYING: 'Playing', BUFFERING: 'Buffering' };

function createIvsEngine(store, prefs) {
  let _player      = null;
  let _boundPlayer = null;
  let _retryTimer  = null;
  let _latencyTimer = null;

  // ── extraction ─────────────────────────────────────────────────────────────

  function init() {
    clearTimeout(_retryTimer);
    _tryExtract(0);
  }

  function _tryExtract(attempt) {
    const p = _extractPlayer();
    if (p) { _player = p; _onPlayerReady(); return; }
    if (attempt < ADAPTER_MAX_RETRIES) {
      _retryTimer = setTimeout(() => _tryExtract(attempt + 1), ADAPTER_RETRY_INTERVAL_MS);
    } else {
      console.warn('[KickTiny] Could not find IVS player after', ADAPTER_MAX_RETRIES, 'attempts');
    }
  }

  function _extractPlayer() {
    try {
      const video = document.querySelector('video');
      if (!video) return null;
      const fiberKey = Object.keys(video).find(k => k.startsWith('__reactFiber'));
      if (!fiberKey) return null;
      return _walkFiber(video[fiberKey]);
    } catch (e) {
      // The fiber walk can throw on partially-constructed React trees — recoverable.
      console.warn('[KickTiny] extractPlayer error (will retry):', e.message);
    }
    return null;
  }

  function _walkFiber(fiber) {
    const isPlayer = v =>
      v && typeof v === 'object' &&
      typeof v.getState === 'function' &&
      typeof v.getQualities === 'function' &&
      typeof v.setQuality === 'function' &&
      typeof v.getVolume === 'function' &&
      typeof v.setVolume === 'function' &&
      typeof v.addEventListener === 'function';

    const seen = new Set();

    function walkHooks(node) {
      let s = node?.memoizedState;
      while (s) {
        const val = s.memoizedState;
        if (isPlayer(val)) return val;
        if (val && typeof val === 'object' && isPlayer(val.current)) return val.current;
        if (val && typeof val === 'object') {
          try {
            for (const v of Object.values(val)) {
              if (isPlayer(v)) return v;
              if (v && typeof v === 'object' && isPlayer(v?.current)) return v.current;
            }
          } catch (_) {}
        }
        s = s.next;
      }
      return null;
    }

    function walk(node, depth) {
      if (!node || depth > 50 || seen.has(node)) return null;
      seen.add(node);
      if (isPlayer(node.stateNode)) return node.stateNode;
      const h = walkHooks(node);
      if (h) return h;
      return walk(node.return, depth + 1)
          || walk(node.child, depth + 1)
          || walk(node.sibling, depth + 1);
    }

    return walk(fiber, 0);
  }

  // ── player ready ───────────────────────────────────────────────────────────

  function _onPlayerReady() {
    const p = _player;
    if (!p || _boundPlayer === p) return;
    _boundPlayer = p;

    const savedPrefs = prefs.load();
    const vol = savedPrefs.volume !== null ? savedPrefs.volume : Math.round(p.getVolume() * 100);

    store.setState({
      alive:       true,
      playing:     p.getState() === PS.PLAYING,
      buffering:   p.getState() === PS.BUFFERING,
      qualities:   p.getQualities() || [],
      quality:     p.getQuality(),
      autoQuality: p.isAutoQualityMode(),
      volume:      vol,
      muted:       p.isMuted(),
      rate:        p.getPlaybackRate(),
    });

    if (savedPrefs.volume !== null) p.setVolume(savedPrefs.volume / 100);
    let qualityApplied = false;
    if (savedPrefs.quality !== null) qualityApplied = _applyQualityPref(p, savedPrefs.quality);

    let _reapplying = false;
    let _reapplyAttempts = 0;

    p.addEventListener(EV.STATE_CHANGED, e => {
      const s = store.getState();
      if (s.engine !== 'ivs') return;
      const ps        = e?.state ?? e;
      const buffering = ps === PS.BUFFERING;
      const playing   = ps === PS.PLAYING;

      if (playing) {
        sessionStorage.removeItem('kt.reloads');
      }

      store.setState({ playing, buffering });
    });

    p.addEventListener(EV.QUALITY_CHANGED, e => {
      if (store.getState().engine !== 'ivs') return;
      const q  = e?.name ? e : (e?.quality ?? null);
      const qs = p.getQualities();
      if (qs?.length) store.setState({ qualities: qs });

      if (!qualityApplied && savedPrefs.quality !== null && qs?.length) {
        qualityApplied = _applyQualityPref(p, savedPrefs.quality);
        if (qualityApplied) return;
      }

      const savedName = prefs.load().quality;
      const st        = store.getState();

      if (!st.autoQuality && savedName && q?.name !== savedName) {
        if (_reapplyAttempts >= MAX_REAPPLY_ATTEMPTS) {
          _reapplying = false; _reapplyAttempts = 0;
          store.setState({ quality: q, autoQuality: st.autoQuality });
          return;
        }
        if (!_reapplying) {
          const all   = qs || st.qualities;
          const match = all.find(x => x.name === savedName)
            || all.find(x => x.name.replace(/\d+$/, '') === savedName.replace(/\d+$/, ''));
          if (match) {
            _reapplying = true; _reapplyAttempts++;
            p.setAutoQualityMode(false); p.setQuality(match);
          } else {
            _reapplying = false; _reapplyAttempts = 0;
            store.setState({ quality: q, autoQuality: st.autoQuality });
          }
        }
        return;
      }

      _reapplying = false; _reapplyAttempts = 0;
      store.setState({ quality: q, autoQuality: st.autoQuality });
    });

    p.addEventListener(EV.VOLUME_CHANGED, e => {
      if (store.getState().engine !== 'ivs') return;
      const vol = typeof e === 'number' ? e : (e?.volume ?? p.getVolume());
      store.setState({ volume: Math.round(vol * 100) });
    });

    p.addEventListener(EV.MUTED_CHANGED, e => {
      if (store.getState().engine !== 'ivs') return;
      store.setState({ muted: typeof e === 'boolean' ? e : (e?.muted ?? p.isMuted()) });
    });

    p.addEventListener(EV.PLAYBACK_RATE_CHANGED, e => {
      if (store.getState().engine !== 'ivs') return;
      store.setState({ rate: typeof e === 'number' ? e : (e?.playbackRate ?? p.getPlaybackRate()) });
    });

    p.addEventListener(EV.ERROR, err => {
      if (store.getState().engine !== 'ivs') return;
      store.setState({ error: err });
      console.error('[KickTiny] IVS Error:', err);
      if (err?.type === 'ErrorInvalidData' && err?.source === 'MediaPlaylist') {
        console.warn('[KickTiny] Bad M3U8 — attempting recovery play()');
        setTimeout(() => {
          try { p.play(); } catch (_) {
            console.warn('[KickTiny] Recovery failed — reloading page');
            window.location.reload();
          }
        }, 1500);
      }
    });

    p.addEventListener(EV.RECOVERABLE_ERROR, err => {
      const code = err?.code ?? null;
      if (RECONNECT_CODES.has(code)) {
        const key   = 'kt.reloads';
        const count = Number(sessionStorage.getItem(key) || 0);
        if (count >= MAX_RELOAD_ATTEMPTS) {
          console.error('[KickTiny] Too many reload attempts, giving up.');
          sessionStorage.removeItem(key);
          return;
        }
        sessionStorage.setItem(key, String(count + 1));
        console.warn('[KickTiny] IVS fatal worker error, reloading... (attempt', count + 1, 'of', MAX_RELOAD_ATTEMPTS, ')');
        setTimeout(() => window.location.reload(), 2000);
      }
    });

    document.addEventListener('fullscreenchange', () => {
      store.setState({ fullscreen: !!document.fullscreenElement });
    });

    // Fallback quality init after 2s (IVS may not have fired QUALITY_CHANGED yet)
    setTimeout(() => {
      const qs = p.getQualities();
      if (qs?.length) {
        if (!store.getState().qualities.length) store.setState({ qualities: qs });
        if (!qualityApplied && savedPrefs.quality !== null) qualityApplied = _applyQualityPref(p, savedPrefs.quality);
      }
    }, 2000);

    clearInterval(_latencyTimer);
    _latencyTimer = setInterval(() => {
      if (store.getState().engine !== 'ivs') return;
      try {
        const latency = p.getLiveLatency?.();
        if (latency == null || !isFinite(latency)) return;
        store.setState({ atLiveEdge: latency <= LIVE_EDGE_LATENCY_SEC });
      } catch (_) {}
    }, LATENCY_POLL_INTERVAL_MS);

    console.log('[KickTiny] Adapter ready. IVS player attached.');
  }

  function _applyQualityPref(p, savedName) {
    const qs = p.getQualities();
    if (!qs?.length) return false;
    const stripped = savedName.replace(/\d+$/, '');
    const match    = qs.find(q => q.name === savedName)
      || qs.find(q => q.name.replace(/\d+$/, '') === stripped);
    if (match) {
      p.setAutoQualityMode(false);
      p.setQuality(match);
      store.setState({ autoQuality: false, quality: match });
      return true;
    }
    return false;
  }

  // ── PlaybackEngine interface ───────────────────────────────────────────────

  function play()  { _player?.play(); }
  function pause() { _player?.pause(); }

  function setVolume(pct) {
    if (!_player) return;
    _player.setVolume(pct / 100);
    if (pct > 0 && _player.isMuted()) _player.setMuted(false);
  }

  function setMuted(m)  { _player?.setMuted(m); }
  function setRate(r)   { _player?.setPlaybackRate(r); }

  function setQuality(q) {
    if (!_player) return;
    if (q === 'auto') {
      _player.setAutoQualityMode(true);
      store.setState({ autoQuality: true, quality: null });
      savePrefs({ quality: null });
    } else {
      _player.setAutoQualityMode(false);
      _player.setQuality(q);
      store.setState({ autoQuality: false, quality: q });
      savePrefs({ quality: q.name });
    }
  }

  function seekToLive() {
    if (!_player) return;
    _player.setPlaybackRate(2);
    const check = setInterval(() => {
      const lat = _player.getLiveLatency?.();
      if (lat == null || !isFinite(lat) || lat <= LIVE_EDGE_LATENCY_SEC) {
        _player.setPlaybackRate(1);
        clearInterval(check);
      }
    }, 250);
  }

  /** Escape hatch for engine-manager to restore state after DVR→IVS transition. */
  function getRawPlayer() { return _player; }

  function destroy() {
    clearTimeout(_retryTimer);
    clearInterval(_latencyTimer);
    _player = null; _boundPlayer = null;
  }

  return { init, destroy, play, pause, setVolume, setMuted, setRate, setQuality, seekToLive, getRawPlayer };
}


// ── engines/manifest-builder.js ──
// ── engines/manifest-builder.js ──────────────────────────────────────────────
// Owns the segment array and all synthetic HLS manifest logic.
// Pure module — no store dependency, no side-effects.
// The DVR engine owns a single instance and delegates all manifest work here.


const SYNTHETIC_URL = 'https://kt.local/dvr.m3u8';

function createManifestBuilder() {
  let _segments       = [];
  let _lastSegUrl     = '';
  let _targetDuration = 10;

  // ── public API ─────────────────────────────────────────────────────────────

  function reset() {
    _segments   = [];
    _lastSegUrl = '';
  }

  function generate() {
    let out = _buildHeader();
    for (const seg of _segments) {
      if (seg.discontinuity) out += '#EXT-X-DISCONTINUITY\n';
      if (seg.pdt)           out += seg.pdt + '\n';
      out += seg.duration + '\n';
      out += seg.url + '\n';
    }
    return out;
  }

  // Merge incoming playlist text into the segment array.
  // Returns the number of new segments added (0 = nothing new).
  function merge(text, baseUrl) {
    const cleaned  = text.replace(/#EXT-X-ENDLIST.*/g, '');
    const incoming = _parse(cleaned, baseUrl);
    if (!incoming.length) return 0;

    let startIdx = 0;
    if (_lastSegUrl) {
      let overlapIdx = -1;
      for (let i = incoming.length - 1; i >= 0; i--) {
        if (incoming[i].url === _lastSegUrl) {
          overlapIdx = i;
          break;
        }
      }
      startIdx = overlapIdx >= 0 ? overlapIdx + 1 : 0;
    }

    const newSegs = incoming.slice(startIdx);
    if (!newSegs.length) return 0;

    _segments.push(...newSegs);
    _lastSegUrl = _segments[_segments.length - 1].url;
    console.log('[KickTiny DVR] Merged', newSegs.length, 'new segments, total:', _segments.length,
      '\n  tail:', _lastSegUrl.split('/').slice(-1)[0]);
    return newSegs.length;
  }

  // Append the next predicted segment by incrementing the last URL's sequence number.
  // Zero network requests — used during catch-up mode.
  function extrapolate() {
    if (!_segments.length) return false;
    const last  = _segments[_segments.length - 1];
    const match = last.url.match(/^(.*\/)(\d+)\.ts$/);
    if (!match) {
      console.warn('[KickTiny DVR] Cannot extrapolate — URL pattern not recognised');
      return false;
    }

    const url = `${match[1]}${parseInt(match[2], 10) + 1}.ts`;
    let pdt = null;
    if (last.pdt) {
      const m = last.pdt.match(/^#EXT-X-PROGRAM-DATE-TIME:(.+)$/);
      if (m) {
        const nextMs = new Date(m[1]).getTime() + _targetDuration * 1000;
        pdt = `#EXT-X-PROGRAM-DATE-TIME:${new Date(nextMs).toISOString()}`;
      }
    }
    _segments.push({ duration: last.duration, url, pdt, discontinuity: false });
    _lastSegUrl = url;
    console.log('[KickTiny DVR] Extrapolated next segment:', url.split('/').slice(-1)[0]);
    return true;
  }

  // Pick the best variant URL from a multivariant playlist, optionally honouring
  // a preferred quality name (falls back to middle-bandwidth variant).
  function pickVariant(text, baseUrl, preferredName) {
    const lines   = text.split('\n');
    const streams = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t.startsWith('#EXT-X-STREAM-INF')) continue;
      const res  = t.match(/RESOLUTION=\d+x(\d+)/);
      const bw   = t.match(/BANDWIDTH=(\d+)/);
      const name = t.match(/VIDEO="([^"]+)"/);
      const url  = lines[i + 1]?.trim();
      if (!url || url.startsWith('#')) continue;
      streams.push({
        url:       url.startsWith('http') ? url : new URL(url, baseUrl).href,
        height:    res  ? parseInt(res[1], 10)  : 0,
        bandwidth: bw   ? parseInt(bw[1], 10)   : 0,
        name:      name ? name[1]           : '',
      });
    }
    if (!streams.length) return baseUrl;

    if (preferredName) {
      let m = streams.find(s => s.name === preferredName);
      if (!m) {
        const stripped = preferredName.replace(/\d+$/, '');
        m = streams.find(s => s.name.replace(/\d+$/, '') === stripped);
      }
      if (m) { console.log('[KickTiny DVR] Picked variant:', m.name); return m.url; }
    }

    const sorted = [...streams].sort((a, b) => b.bandwidth - a.bandwidth);
    const pick   = sorted[Math.floor(sorted.length / 2)] ?? sorted[0];
    console.log('[KickTiny DVR] No quality match, picking middle variant:', pick.name);
    return pick.url;
  }

  // Parse quality options from a multivariant playlist. Returns sorted array.
  function parseQualities(text) {
    const lines   = text.split('\n');
    const streams = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t.startsWith('#EXT-X-STREAM-INF')) continue;
      const name = t.match(/VIDEO="([^"]+)"/);
      const bw   = t.match(/BANDWIDTH=(\d+)/);
      if (name) streams.push({ name: name[1], index: streams.length, bandwidth: bw ? parseInt(bw[1], 10) : 0 });
    }
    if (!streams.length) return [];
    streams.sort((a, b) => b.bandwidth - a.bandwidth);
    streams.forEach((s, i) => { s.index = i; });
    return streams;
  }

  // True when playback is close enough to the seekable end to warrant extrapolation.
  function nearEnd(currentTime, seekableEnd) {
    return isFinite(seekableEnd) && (seekableEnd - currentTime) < NEAR_END_THRESHOLD_SEC;
  }

  // ── getters ────────────────────────────────────────────────────────────────

  function segmentCount()   { return _segments.length; }
  function getLastSegUrl()  { return _lastSegUrl; }
  function targetDuration() { return _targetDuration; }

  // ── private ────────────────────────────────────────────────────────────────

  function _buildHeader() {
    return [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-PLAYLIST-TYPE:EVENT',
      `#EXT-X-TARGETDURATION:${_targetDuration}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
    ].join('\n') + '\n';
  }

  function _parse(text, baseUrl) {
    const lines  = text.split('\n');
    const result = [];
    let duration = null, pdt = null, discontinuity = false;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('#EXT-X-TARGETDURATION:')) { _targetDuration = parseInt(t.split(':')[1], 10) || _targetDuration; continue; }
      if (t === '#EXT-X-DISCONTINUITY')            { discontinuity = true; continue; }
      if (t.startsWith('#EXT-X-PROGRAM-DATE-TIME:')){ pdt = t; continue; }
      if (t.startsWith('#EXTINF:'))                 { duration = t; continue; }
      if (duration && t && !t.startsWith('#')) {
        const url = t.startsWith('http') ? t : new URL(t, baseUrl).href;
        result.push({ duration, url, pdt, discontinuity });
        duration = null; pdt = null; discontinuity = false;
      }
    }
    return result;
  }

  return {
    reset, generate, merge, extrapolate,
    pickVariant, parseQualities, nearEnd,
    segmentCount, getLastSegUrl, targetDuration,
  };
}


// ── engines/dvr-engine.js ──
// ── engines/dvr-engine.js ────────────────────────────────────────────────────
// HLS.js DVR controller. Extracted from dvr/controller.js.
// Receives store and api as constructor parameters — no global imports.
//
// Usage:
//   const dvr = createDvrEngine(store, api);
//   await dvr.setupContainer(container);
//   await dvr.enter(behindSec);
//   dvr.seekToBehindLive(60);
//   dvr.exit();
//   dvr.destroy();


function createDvrEngine(store, api) {
  let _Hls          = null;
  let _hls          = null;
  let _dvrVideo     = null;
  let _nativeVideo  = null;
  let _posTimer     = null;
  let _expiryTimer  = null;
  let _catchUpTimer = null;
  let _refreshing   = false;
  let _manifestOffset = 0;

  const _mb = createManifestBuilder();

  // ── hls.js — use shared pre-loader ──────────────────────────────────────
  // FIX: replaced the private _loadHlsJs() with the shared preloadHlsJs()
  // that already started downloading on page load. First DVR entry is now
  // instant (or near-instant) instead of paying a full CDN round-trip.

  function _buildCustomLoader(DefaultLoader) {
    return class SyntheticLoader extends DefaultLoader {
      load(context, config, callbacks) {
        if (context.url === SYNTHETIC_URL) {
          const data = _mb.generate();
          const now  = performance.now();
          setTimeout(() => callbacks.onSuccess(
            { data, url: SYNTHETIC_URL },
            {
              aborted: false, loaded: data.length, total: data.length, retry: 0,
              trequest: now, tfirst: now, tload: now, chunkCount: 0, bwEstimate: Infinity,
              loading: { start: now, first: now, end: now },
              parsing: { start: now, end: now },
              buffering: { start: now, first: now, end: now },
            },
            context
          ), 0);
          return;
        }
        super.load(context, config, callbacks);
      }
      abort() {}
    };
  }

  function _createHlsInstance() {
    if (_hls) { _hls.destroy(); _hls = null; }
    _hls = new _Hls({
      loader:                  _buildCustomLoader(_Hls.DefaultConfig.loader),
      liveDurationInfinity:    true,
      backBufferLength:        Infinity,
      enableWorker:            true,
      lowLatencyMode:          false,
      autoStartLoad:           true,
      manifestLoadingTimeOut:  5000,
      manifestLoadingMaxRetry: 2,
    });
    _hls.loadSource(SYNTHETIC_URL);
    _hls.attachMedia(_dvrVideo);
    _hls.on(_Hls.Events.MANIFEST_PARSED, (_, data) => {
      console.log('[KickTiny DVR] Manifest parsed —', data.levels.length, 'level(s),', _mb.segmentCount(), 'segments');
      store.setState({ dvrAvailable: true });
    });
    _hls.on(_Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      console.error('[KickTiny DVR] Fatal error:', data.details);
      _hls.recoverMediaError();
    });
  }

  function _destroyHls() {
    if (_hls) { _hls.destroy(); _hls = null; }
  }

  // ── snapshot fetch ─────────────────────────────────────────────────────────

  async function _fetchAndMergeSnapshot(snapshotUrl) {
    try {
      const res  = await fetch(snapshotUrl);
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      const text = await res.text();

      if (text.includes('#EXT-X-STREAM-INF')) {
        const qualities = _mb.parseQualities(text);
        if (qualities.length) store.setState({ dvrQualities: qualities });

        const s          = store.getState();
        const variantUrl = _mb.pickVariant(text, snapshotUrl, s.quality?.name ?? null);
        const varRes     = await fetch(variantUrl);
        if (!varRes.ok) throw new Error(`variant playlist ${varRes.status}`);
        return _mb.merge(await varRes.text(), variantUrl);
      }
      return _mb.merge(text, snapshotUrl);
    } catch (e) {
      console.warn('[KickTiny DVR] Snapshot fetch failed:', e.message);
      return 0;
    }
  }

  // ── seekable window — event-driven with polling fallback ─────────────────
  // FIX: instead of only polling every 100ms up to 8s, we now also listen to
  // the HLS.js LEVEL_LOADED and FRAG_LOADED events which fire as soon as data
  // is available. This typically resolves in <500ms instead of 2-4s.

  function _waitForSeekable(timeoutMs = SEEKABLE_WAIT_MS) {
    return new Promise(resolve => {
      // Helper — check current seekable state
      const check = () => {
        if (_dvrVideo?.seekable?.length > 0) {
          const i   = _dvrVideo.seekable.length - 1;
          const end = _dvrVideo.seekable.end(i);
          const start = _dvrVideo.seekable.start(i);
          if (isFinite(end) && end > start) return { start, end };
        }
        return null;
      };

      // Resolve immediately if already available
      const immediate = check();
      if (immediate) { resolve(immediate); return; }

      let settled = false;
      const done = result => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (_hls) {
          _hls.off(_Hls.Events.LEVEL_LOADED, onHlsEvent);
          _hls.off(_Hls.Events.FRAG_LOADED,  onHlsEvent);
        }
        resolve(result);
      };

      // HLS events fire as soon as the first segment data arrives
      const onHlsEvent = () => { const r = check(); if (r) done(r); };
      if (_hls && _Hls) {
        _hls.on(_Hls.Events.LEVEL_LOADED, onHlsEvent);
        _hls.on(_Hls.Events.FRAG_LOADED,  onHlsEvent);
      }

      // Lightweight poll as safety net (50ms — much tighter than original 100ms)
      const poll = setInterval(() => { const r = check(); if (r) { clearInterval(poll); done(r); } }, 50);

      // Hard timeout — resolve with null so the caller can bail gracefully
      const deadline = setTimeout(() => {
        clearInterval(poll);
        done(null);
      }, timeoutMs);
    });
  }

  function _getSeekableWindow() {
    if (!_dvrVideo?.seekable?.length) return null;
    const i = _dvrVideo.seekable.length - 1;
    return { start: _dvrVideo.seekable.start(i), end: _dvrVideo.seekable.end(i) };
  }

  // ── JWT expiry ─────────────────────────────────────────────────────────────

  function _getTokenExpiryMs(url) {
    try {
      const jwt   = new URL(url).searchParams.get('init');
      if (!jwt) return null;
      const parts = jwt.split('.');
      if (parts.length < 2) return null;
      let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const payload = JSON.parse(atob(b64));
      return payload?.exp ? payload.exp * 1000 : null;
    } catch { return null; }
  }

  function _scheduleExpiryRefresh(url) {
    clearTimeout(_expiryTimer);
    const expMs = _getTokenExpiryMs(url);
    const delay = expMs
      ? Math.max(5000, expMs - Date.now() - EXPIRY_LEAD_MS)
      : FALLBACK_REFRESH_MS;
    if (expMs) console.log('[KickTiny DVR] Token expires in', Math.round((expMs - Date.now()) / 1000), 's — refresh in', Math.round(delay / 1000), 's');
    _expiryTimer = setTimeout(() => {
      if (store.getState().engine === 'dvr' && !_refreshing) _fetchAndExtendManifest();
    }, delay);
  }

  async function _fetchAndExtendManifest() {
    if (_refreshing || !store.getState().vodId) return;
    _refreshing = true;
    console.log('[KickTiny DVR] Fetching fresh VOD URL (expiry refresh)');
    const newUrl = await api.fetchVodPlaybackUrl(store.getState().vodId);
    if (newUrl) { await _fetchAndMergeSnapshot(newUrl); _scheduleExpiryRefresh(newUrl); }
    _refreshing = false;
  }

  // ── catch-up timer (segment extrapolation) ─────────────────────────────────

  function _startCatchUpTimer() {
    if (_catchUpTimer) return;
    console.log('[KickTiny DVR] Entering catch-up mode (extrapolation)');
    _mb.extrapolate();
    _catchUpTimer = setInterval(() => {
      if (store.getState().engine !== 'dvr') { _stopCatchUpTimer(); return; }
      const win = _getSeekableWindow();
      if (win && _mb.nearEnd(_dvrVideo.currentTime, win.end)) _mb.extrapolate();
    }, CATCH_UP_INTERVAL_MS);
  }

  function _stopCatchUpTimer() {
    if (!_catchUpTimer) return;
    clearInterval(_catchUpTimer); _catchUpTimer = null;
    console.log('[KickTiny DVR] Exiting catch-up mode');
  }

  // ── position poll ──────────────────────────────────────────────────────────

  function _startPositionPoll() {
    _stopPositionPoll();
    _posTimer = setInterval(() => {
      if (!_dvrVideo || store.getState().engine !== 'dvr') { _stopPositionPoll(); return; }
      const win            = _getSeekableWindow();
      const manifestOffset = win ? Math.max(0, store.getState().uptimeSec - win.end) : _manifestOffset;
      const behindLive     = win ? Math.max(0, (win.end - _dvrVideo.currentTime) + manifestOffset) : 0;
      const windowSec      = win ? Math.max(0, win.end - win.start) : 0;

      store.setState({ dvrBehindLive: behindLive, dvrWindowSec: windowSec, atLiveEdge: behindLive <= LIVE_EDGE_BEHIND_SEC });

      if (win) {
        const secsFromEnd = win.end - _dvrVideo.currentTime;
        if (secsFromEnd < NEAR_END_THRESHOLD_SEC) {
          _startCatchUpTimer();
        } else if (secsFromEnd > NEAR_END_THRESHOLD_SEC * 2 && _catchUpTimer) {
          _stopCatchUpTimer();
        }
      }
    }, POSITION_POLL_INTERVAL_MS);
  }

  function _stopPositionPoll() { clearInterval(_posTimer); _posTimer = null; }

  // ── quality switch ─────────────────────────────────────────────────────────

  async function _switchVariant(q) {
    if (!store.getState().vodId) return;
    const savedPos = _dvrVideo?.currentTime ?? 0;
    const vodUrl   = await api.fetchVodPlaybackUrl(store.getState().vodId);
    if (!vodUrl) return;

    const res  = await fetch(vodUrl);
    if (!res.ok) { console.warn('[KickTiny DVR] variant manifest fetch failed:', res.status); return; }
    const text = await res.text();
    if (!text.includes('#EXT-X-STREAM-INF')) return;

    const variantUrl = _mb.pickVariant(text, vodUrl, q.name);
    if (!variantUrl || variantUrl === vodUrl) return;

    console.log('[KickTiny DVR] Switching to variant:', q.name);
    _mb.reset();
    const varRes = await fetch(variantUrl);
    if (!varRes.ok) { console.warn('[KickTiny DVR] variant fetch failed:', varRes.status); return; }
    _mb.merge(await varRes.text(), variantUrl);
    _scheduleExpiryRefresh(vodUrl);
    _destroyHls(); _createHlsInstance();

    const onReady = () => { _dvrVideo.currentTime = savedPos; _dvrVideo.play().catch(() => {}); };
    if (_dvrVideo.readyState >= 1) onReady();
    else _dvrVideo.addEventListener('loadedmetadata', onReady, { once: true });

    store.setState({ dvrQuality: q });
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  function _returnToLiveUi() {
    if (_dvrVideo) _dvrVideo.style.display = 'none';
    if (_nativeVideo) _nativeVideo.style.visibility = 'visible';
  }

  // ── PlaybackEngine interface ───────────────────────────────────────────────

  async function setupContainer(container) {
    if (_dvrVideo) return;
    _nativeVideo = container.querySelector('video');
    if (!_nativeVideo) { console.warn('[KickTiny DVR] No native video found'); return; }
    const cs = window.getComputedStyle(container);
    if (cs.position === 'static') container.style.position = 'relative';
    _dvrVideo = document.createElement('video');
    _dvrVideo.playsInline = true;
    _dvrVideo.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none;z-index:2;background:#000';
    container.appendChild(_dvrVideo);
    _dvrVideo.addEventListener('playing',      () => { if (store.getState().engine === 'dvr') store.setState({ playing: true,  buffering: false }); });
    _dvrVideo.addEventListener('pause',        () => { if (store.getState().engine === 'dvr') store.setState({ playing: false }); });
    _dvrVideo.addEventListener('waiting',      () => { if (store.getState().engine === 'dvr') store.setState({ buffering: true }); });
    _dvrVideo.addEventListener('volumechange', () => {
      if (store.getState().engine === 'dvr') store.setState({ volume: Math.round(_dvrVideo.volume * 100), muted: _dvrVideo.muted });
    });
    console.log('[KickTiny DVR] Container ready');
  }

  async function enter(behindSec) {
    // Preconditions checked by engine-manager before calling
    const s         = store.getState();
    const wasVolume = s.volume;
    const wasMuted  = s.muted;
    store.setState({ buffering: true });

    // FIX: use shared preloader — if hls.js already downloaded in the
    // background this resolves instantly with no network cost.
    if (!_Hls) {
      try { _Hls = await preloadHlsJs(); } catch (e) {
        console.warn('[KickTiny DVR] hls.js load failed:', e.message);
        store.setState({ buffering: false }); throw e;
      }
      if (!_Hls.isSupported()) {
        store.setState({ buffering: false });
        throw new Error('hls.js not supported');
      }
    }

    _nativeVideo.style.visibility = 'hidden';
    _dvrVideo.style.display  = 'block';
    _dvrVideo.volume         = wasVolume / 100;
    _dvrVideo.muted          = wasMuted;
    _dvrVideo.playbackRate   = s.rate;

    const url = await api.fetchVodPlaybackUrl(s.vodId);
    if (!url) { store.setState({ buffering: false }); throw new Error('Could not fetch VOD URL'); }

    _mb.reset();
    const appended = await _fetchAndMergeSnapshot(url);
    if (appended === 0) { store.setState({ buffering: false }); throw new Error('No segments in snapshot'); }

    _destroyHls(); _createHlsInstance();

    // FIX: event-driven seekable detection replaces the pure polling loop.
    const win = await _waitForSeekable();
    if (!win) { store.setState({ buffering: false }); throw new Error('Seekable window never available'); }

    _manifestOffset = Math.max(0, s.uptimeSec - win.end);
    const target = Math.max(0, Math.min(win.end - 1, win.end - (behindSec - _manifestOffset)));
    console.log('[KickTiny DVR] Seekable', win.start.toFixed(1), '–', win.end.toFixed(1),
      '| offset', _manifestOffset.toFixed(1), '→ seeking to', target.toFixed(1));
    _dvrVideo.currentTime = target;

    const trueBehind = Math.max(0, win.end - target) + _manifestOffset;
    store.setState({
      engine:        'dvr',
      buffering:     false,
      dvrAvailable:  true,
      dvrWindowSec:  Math.max(0, win.end - win.start),
      dvrBehindLive: trueBehind,
      atLiveEdge:    trueBehind <= LIVE_EDGE_BEHIND_SEC,
    });

    _startPositionPoll();
    _scheduleExpiryRefresh(url);
    _dvrVideo.play().catch(() => {});

    // Match IVS quality selection if possible
    const st = store.getState();
    if (st.quality !== null && st.dvrQualities?.length) {
      const match = st.dvrQualities.find(q => q.name === st.quality?.name)
        || st.dvrQualities.find(q => q.name.replace(/\d+$/, '') === st.quality?.name.replace(/\d+$/, ''));
      if (match) store.setState({ dvrQuality: match });
    }

    console.log('[KickTiny DVR] DVR mode active');
  }

  function exit() {
    if (!_dvrVideo || !_nativeVideo) return;
    _dvrVideo.pause();
    _destroyHls();
    _returnToLiveUi();
    clearTimeout(_expiryTimer); _expiryTimer = null;
    _stopPositionPoll();
    _stopCatchUpTimer();
    _manifestOffset = 0;
    store.setState({ engine: 'ivs', atLiveEdge: true, dvrBehindLive: 0, dvrWindowSec: 0, buffering: false });
    console.log('[KickTiny DVR] Exited DVR mode');
  }

  function play()  { _dvrVideo?.play().catch(() => {}); }
  function pause() { _dvrVideo?.pause(); }

  function setVolume(pct) {
    if (!_dvrVideo) return;
    _dvrVideo.volume = pct / 100;
    if (pct > 0) _dvrVideo.muted = false;
    store.setState({ volume: pct, muted: _dvrVideo.muted });
  }

  function setMuted(m) {
    if (!_dvrVideo) return;
    _dvrVideo.muted = m;
    store.setState({ muted: m });
  }

  function setRate(r) {
    if (!_dvrVideo) return;
    _dvrVideo.playbackRate = r;
    store.setState({ rate: r });
  }

  function setQuality(q) {
    if (!_hls) return;
    if (q === 'auto') {
      const qs  = store.getState().dvrQualities || [];
      const mid = qs[Math.floor(qs.length / 2)];
      if (mid) _switchVariant(mid);
      store.setState({ dvrQuality: null });
    } else {
      const target = typeof q === 'object' ? q : (store.getState().dvrQualities?.find(x => x.index === q));
      if (target) _switchVariant(target);
    }
  }

  function seekToBehindLive(behindSec) {
    if (!_dvrVideo) return;
    const win = _getSeekableWindow();
    if (!win) return;
    const manifestOffset = Math.max(0, store.getState().uptimeSec - win.end);
    const target = Math.max(0, Math.min(win.end - 1, win.end - (behindSec - manifestOffset)));
    _dvrVideo.currentTime = target;
  }

  function getVideo() { return _dvrVideo; }

  function destroy() {
    _destroyHls();
    _stopPositionPoll();
    _stopCatchUpTimer();
    clearTimeout(_expiryTimer); _expiryTimer = null;
  }

  return {
    setupContainer, enter, exit, destroy,
    play, pause, setVolume, setMuted, setRate,
    setQuality, seekToBehindLive,
    seekToLive: exit,  // unified interface alias
    getVideo,
  };
}


// ── engine-manager.js ──
// ── engine-manager.js ────────────────────────────────────────────────────────
// Coordinates the IVS and DVR engines. This is the key decoupling piece:
// it eliminates all if (inDvr()) checks from actions and UI components by
// exposing a single unified interface that delegates to whichever engine
// is currently active.
//
// Usage:
//   const engines = createEngineManager(store, prefs, api);
//   engines.init(container);
//   engines.play(); engines.setVolume(80);   // no engine awareness needed
//   engines.enterDvr(90);                    // switch to DVR 90s behind live
//   engines.exitDvr();                       // switch back to IVS live


function createEngineManager(store, prefs, api) {
  let _ivs      = null;
  let _dvr      = null;
  let _entering = false;  // race-condition guard on IVS→DVR transition

  function _active() {
    return store.getState().engine === 'dvr' ? _dvr : _ivs;
  }

  // ── Unified PlaybackEngine interface ───────────────────────────────────────
  // Actions and UI call these — they never know which engine is active.

  function play()         { _active()?.play?.(); }
  function pause()        { _active()?.pause?.(); }
  function setVolume(pct) { _active()?.setVolume?.(pct); }
  function setMuted(m)    { _active()?.setMuted?.(m); }
  function setRate(r)     { _active()?.setRate?.(r); }
  function setQuality(q)  { _active()?.setQuality?.(q); }
  function seekToLive() {
    if (store.getState().engine === 'dvr') {
      exitDvr();
    } else {
      _ivs.seekToLive();
    }
  }

  // ── DVR-specific ───────────────────────────────────────────────────────────

  async function enterDvr(behindSec) {
    if (_entering) {
      console.warn('[EngineManager] enterDvr already in progress — ignoring duplicate call');
      return;
    }
    const s = store.getState();
    if (!s.vodId) { console.warn('[EngineManager] enterDvr: no vodId'); return; }

    // If already in DVR, just seek to the requested position
    if (s.engine === 'dvr') {
      _dvr.seekToBehindLive(behindSec);
      return;
    }

    _entering = true;
    const rawPlayer = _ivs.getRawPlayer();
    const wasPlaying = s.playing;
    const wasVolume  = s.volume;
    const wasMuted   = s.muted;

    try {
      if (rawPlayer) rawPlayer.pause();
      await _dvr.enter(behindSec);
    } catch (e) {
      console.warn('[EngineManager] DVR entry failed:', e.message);
      // Restore IVS live playback on failure
      _dvr.exit();
      _restoreIvs(rawPlayer, wasPlaying, wasVolume, wasMuted);
    } finally {
      _entering = false;
    }
  }

  function exitDvr() {
    if (store.getState().engine !== 'dvr') return;
    const rawPlayer = _ivs.getRawPlayer();
    const s = store.getState();

    _dvr.exit();

    // Restore IVS quality and resume from near live edge
    if (rawPlayer) {
      rawPlayer.setVolume(s.volume / 100);
      rawPlayer.setMuted(s.muted);

      // Carry quality selection across the transition
      if (s.dvrQuality !== null && s.qualities?.length) {
        const match = s.qualities.find(q => q.name === s.dvrQuality.name)
          || s.qualities.find(q => q.name.replace(/\d+$/, '') === s.dvrQuality.name.replace(/\d+$/, ''));
        if (match) { rawPlayer.setAutoQualityMode(false); rawPlayer.setQuality(match); }
      }

      // Nudge playback head past accumulated latency
      try {
        const pos     = rawPlayer.getPosition?.() ?? 0;
        const latency = rawPlayer.getLiveLatency?.() ?? 0;
        if (isFinite(pos) && isFinite(latency) && latency > 0) rawPlayer.seekTo(pos + latency + 0.25);
      } catch (_) {}

      rawPlayer.play();
    }

    console.log('[EngineManager] Returned to IVS live');
  }

  function dvrSeekToBehindLive(sec) {
    if (store.getState().engine !== 'dvr') return;
    _dvr.seekToBehindLive(sec);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async function init(container) {
    _ivs = createIvsEngine(store, prefs);
    _dvr = createDvrEngine(store, api);

    _ivs.init();

    // Pre-create the DVR video element — no URL is fetched here.
    // DVR init happens lazily when the user seeks into the past.
    await _dvr.setupContainer(container).catch(e => {
      console.warn('[EngineManager] DVR container setup failed:', e.message);
    });
  }

  function destroy() {
    _ivs?.destroy();
    _dvr?.destroy();
  }

  function isInDvr() { return store.getState().engine === 'dvr'; }

  // ── private ────────────────────────────────────────────────────────────────

  function _restoreIvs(player, wasPlaying, wasVolume, wasMuted) {
    if (!player) return;
    player.setVolume(wasVolume / 100);
    player.setMuted(!!wasMuted);
    if (wasPlaying) player.play();
  }

  return {
    // Unified interface
    play, pause, setVolume, setMuted, setRate, setQuality, seekToLive,
    // DVR transitions
    enterDvr, exitDvr, dvrSeekToBehindLive,
    // Lifecycle
    init, destroy, isInDvr,
  };
}


// ── actions.js ──
// ── actions.js ───────────────────────────────────────────────────────────────
// High-level user-intent actions. The ONLY thing UI components import.
// No if (inDvr()) checks — that complexity lives in the engine manager.
//
// Usage:
//   const actions = createActions(store, engineManager, prefs);
//   actions.togglePlay();
//   actions.setVolume(80);
//   // pass to UI: createBar(store, actions)


function createActions(store, engineManager, prefs) {

  // ── play / pause ────────────────────────────────────────────────────────────

  function play()  { engineManager.play(); }
  function pause() { engineManager.pause(); }

  function togglePlay() {
    store.getState().playing ? engineManager.pause() : engineManager.play();
  }

  // ── volume / mute ───────────────────────────────────────────────────────────

  let _volSaveTimer = null;

  function setVolume(pct) {
    const v = Math.max(0, Math.min(100, pct));
    engineManager.setVolume(v);
    clearTimeout(_volSaveTimer);
    _volSaveTimer = setTimeout(() => prefs.save({ volume: v }), VOLUME_SAVE_DEBOUNCE_MS);
  }

  function setMuted(m) { engineManager.setMuted(m); }

  function toggleMute() {
    const s = store.getState();
    if (s.muted || s.volume === 0) {
      const restore = s.volume > 0 ? s.volume : 5;
      engineManager.setVolume(restore);
      engineManager.setMuted(false);
    } else {
      engineManager.setMuted(true);
    }
  }

  // ── quality / rate ──────────────────────────────────────────────────────────

  function setQuality(q) { engineManager.setQuality(q); }

  function setRate(r) { engineManager.setRate(Math.max(0.25, Math.min(2, r))); }

  // ── live edge ───────────────────────────────────────────────────────────────

  function seekToLive() { engineManager.seekToLive(); }

  // ── DVR ─────────────────────────────────────────────────────────────────────

  function enterDvr(sec)            { engineManager.enterDvr(sec); }
  function dvrSeekToBehindLive(sec) { engineManager.dvrSeekToBehindLive(sec); }

  // ── fullscreen ──────────────────────────────────────────────────────────────

  function toggleFullscreen() {
    const container = document.querySelector('.aspect-video-responsive')
      || document.querySelector('div[class*="aspect-video"]')
      || document.body;
    if (!document.fullscreenElement) {
      container.requestFullscreen?.()?.catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  }

  // ── keyboard bindings ───────────────────────────────────────────────────────
  // Bound once in main.js via actions.bindKeys().

  let _keysBound = false;
  function bindKeys() {
    if (_keysBound) return;
    _keysBound = true;
    document.addEventListener('keydown', e => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const s = store.getState();
      switch (e.key) {
        case ' ':
        case 'k': e.preventDefault(); togglePlay(); break;
        case 'm': toggleMute(); break;
        case 'ArrowUp':   e.preventDefault(); setVolume(s.volume + 5); break;
        case 'ArrowDown': e.preventDefault(); setVolume(s.volume - 5); break;
        case 'ArrowLeft':
          e.preventDefault();
          if (s.engine === 'dvr') {
            dvrSeekToBehindLive(s.dvrBehindLive + 10);
          } else if (s.vodId) {
            enterDvr(60);
          }
          break;
        case 'ArrowRight':
          e.preventDefault();
          if (s.engine === 'dvr') {
            const next = Math.max(0, s.dvrBehindLive - 10);
            if (next <= LIVE_EDGE_BEHIND_SEC) seekToLive();
            else dvrSeekToBehindLive(next);
          }
          break;
        case 'f': toggleFullscreen(); break;
        case 'l': seekToLive(); break;
      }
    });
  }

  return {
    play, pause, togglePlay,
    setVolume, setMuted, toggleMute,
    setQuality, setRate,
    seekToLive, enterDvr, dvrSeekToBehindLive,
    toggleFullscreen, bindKeys,
    DOUBLE_CLICK_WINDOW_MS, // exposed so main.js click handler can read it
  };
}


// ── services/viewer-interceptor.js ──
// ── services/viewer-interceptor.js ───────────────────────────────────────────
// Intercepts Kick's own current-viewers fetches so we can read viewer counts
// with zero extra network requests. Isolated here so the side-effect of
// monkey-patching window.fetch is explicit and contained.
//
// Usage:
//   const viewer = createViewerInterceptor();
//   const unsub  = viewer.onViewerCount(count => setState({ viewers: count }));
//   unsub(); // stop listening

function createViewerInterceptor() {
  const _callbacks = new Set();

  const _origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
    const res = await _origFetch.apply(this, args);

    if (url.includes('current-viewers') && _callbacks.size > 0) {
      res.clone().json().then(data => {
        if (Array.isArray(data) && data[0]?.viewers != null) {
          for (const cb of _callbacks) cb(data[0].viewers);
        }
      }).catch(() => {});
    }

    return res;
  };

  return {
    /** Register a viewer-count callback. Returns an unsubscribe function. */
    onViewerCount(cb) {
      _callbacks.add(cb);
      return () => _callbacks.delete(cb);
    },
  };
}


// ── ui/icons.js ──
// ── ui/icons.js ───────────────────────────────────────────────────────────────
// All SVG icon functions in one place. Importing from here keeps individual
// component files free of inline SVG strings.

const svgPlay = () =>
  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;

const svgPause = () =>
  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;

const svgSpin = () =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="kt-spin"><circle cx="12" cy="12" r="9" stroke-dasharray="30 60"/></svg>`;

const svgExpand = () =>
  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>`;

const svgCompress = () =>
  `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>`;

function svgVolume(muted) {
  return muted
    ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
}


// ── ui/play-button.js ──

function createPlayBtn(store, actions) {
  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-play';
  btn.title = 'Play/Pause (k)';
  btn.innerHTML = svgPlay();
  btn.addEventListener('click', actions.togglePlay);

  // select() fires only when playing or buffering changes — the 500ms position
  // poll and 1s uptime ticker no longer trigger needless DOM updates here.
  store.select(
    s => ({ playing: s.playing, buffering: s.buffering }),
    ({ playing, buffering }) => {
      btn.innerHTML = buffering ? svgSpin() : playing ? svgPause() : svgPlay();
      btn.title = playing ? 'Pause (k)' : 'Play (k)';
    }
  );

  return btn;
}


// ── ui/volume-control.js ──

function createVolumeCtrl(store, actions) {
  const wrap = document.createElement('div');
  wrap.className = 'kt-vol-wrap';

  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-mute';
  btn.addEventListener('click', e => { e.stopPropagation(); actions.toggleMute(); });

  const sliderWrap = document.createElement('div');
  sliderWrap.className = 'kt-vol-slider-wrap';

  const slider = document.createElement('input');
  slider.type = 'range'; slider.className = 'kt-vol-slider';
  slider.min = '0'; slider.max = '100'; slider.step = '1';

  sliderWrap.appendChild(slider);
  wrap.append(btn, sliderWrap);

  let _dragging = false;
  slider.addEventListener('mousedown', () => {
    _dragging = true;
    const up = () => { _dragging = false; document.removeEventListener('mouseup', up); };
    document.addEventListener('mouseup', up);
  });
  slider.addEventListener('input', () => {
    actions.setVolume(Number(slider.value));
    _updateFill(Number(slider.value));
  });

  function syncUi(volume, muted) {
    const isMuted = muted || volume === 0;
    btn.innerHTML = svgVolume(isMuted);
    btn.title     = isMuted ? 'Unmute (m)' : 'Mute (m)';
    if (!_dragging) { slider.value = isMuted ? 0 : volume; _updateFill(isMuted ? 0 : volume); }
  }

  function _updateFill(pct) { slider.style.setProperty('--kt-vol-pct', pct + '%'); }

  // Only re-render when volume or muted actually changes
  store.select(
    s => ({ volume: s.volume, muted: s.muted }),
    ({ volume, muted }) => syncUi(volume, muted)
  );
  syncUi(store.getState().volume, store.getState().muted);

  return wrap;
}


// ── ui/popup.js ──
let _popupGlobalsBound = false;
function bindPopupGlobals() {
  if (_popupGlobalsBound) return;
  _popupGlobalsBound = true;
  document.addEventListener('click', () => {
    document.querySelectorAll('.kt-popup').forEach(p => { p.hidden = true; });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape')
      document.querySelectorAll('.kt-popup').forEach(p => { p.hidden = true; });
  });
  window.addEventListener('resize', () => {
    document.querySelectorAll('.kt-popup').forEach(p => { p.hidden = true; });
  });
}

function openPopup(popup, triggerBtn) {
  popup.hidden = false;
  popup.style.visibility = 'hidden';
  const rect = triggerBtn.getBoundingClientRect();
  const vw = window.innerWidth;
  const popupW = popup.offsetWidth || 120;
  const popupH = popup.offsetHeight || 100;

  const availableH = rect.top - 8 - 4;
  const maxH = Math.max(80, availableH);
  popup.style.maxHeight = maxH + 'px';

  let top = rect.top - Math.min(popupH, maxH) - 8;
  if (top < 4) top = 4;

  let left = rect.right - popupW;
  if (left < 4) left = 4;
  if (left + popupW > vw - 4) left = vw - popupW - 4;

  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
  popup.style.visibility = '';
}

function setupPopupToggle(btn, popup, onOpen) {
  bindPopupGlobals();
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (!popup.hidden) { popup.hidden = true; return; }
    document.querySelectorAll('.kt-popup').forEach(p => { p.hidden = true; });
    if (onOpen) onOpen();
    openPopup(popup, btn);
  });
}


// ── utils/format.js ──
function fmtViewers(n) {
  if (n === null || n === undefined) return '';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function fmtUptime(startDate) {
  if (!startDate) return '';
  const secs = Math.floor((Date.now() - startDate.getTime()) / 1000);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function fmtQuality(name) {
  if (!name) return name;
  // Remove frame rate suffix if 30fps or less (e.g. "480p30" → "480p", "1080p60" stays)
  return name.replace(/(\d+p)(\d+)$/, (_, res, fps) => parseInt(fps, 10) > 30 ? res + fps : res);
}

function fmtDuration(totalSec) {
  const t = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

// ── ui/quality-menu.js ──

function createQualityBtn(store, actions) {
  const wrap = document.createElement('div');
  wrap.className = 'kt-popup-wrap';

  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-qual-btn';
  btn.title = 'Quality'; btn.textContent = 'AUTO';

  const popup = document.createElement('div');
  popup.className = 'kt-popup kt-qual-popup';
  popup.hidden = true;

  let _snap = { engine: 'ivs', qualities: [], quality: null, autoQuality: true, dvrQualities: [], dvrQuality: null };

  setupPopupToggle(btn, popup, () => _renderPopup());
  document.body.appendChild(popup);
  wrap.append(btn);

  store.select(
    s => ({ engine: s.engine, qualities: s.qualities, quality: s.quality, autoQuality: s.autoQuality, dvrQualities: s.dvrQualities, dvrQuality: s.dvrQuality }),
    snap => {
      _snap = snap;
      btn.textContent = snap.engine === 'dvr'
        ? (snap.dvrQuality ? fmtQuality(snap.dvrQuality.name) : 'AUTO')
        : (snap.autoQuality ? 'AUTO' : fmtQuality(snap.quality?.name ?? '?'));
      if (!popup.hidden) _renderPopup();
    }
  );

  function _renderPopup() {
    const items = _snap.engine === 'dvr'
      ? [
          { label: 'Auto', active: _snap.dvrQuality === null, onClick: () => actions.setQuality('auto') },
          ...(_snap.dvrQualities || []).map(q => ({
            label:   fmtQuality(q.name),
            active:  _snap.dvrQuality?.index === q.index,
            onClick: () => actions.setQuality(q),
          })),
        ]
      : [
          { label: 'Auto', active: _snap.autoQuality, onClick: () => actions.setQuality('auto') },
          ...(_snap.qualities || []).map(q => ({
            label:   q.name,
            active:  !_snap.autoQuality && _snap.quality?.name === q.name,
            onClick: () => actions.setQuality(q),
          })),
        ];

    // Diff instead of full re-render when item count is unchanged
    const existing = Array.from(popup.querySelectorAll('.kt-popup-item'));
    if (!popup.hidden && existing.length === items.length) {
      items.forEach((item, i) => {
        const el = existing[i];
        if (el.textContent !== item.label) el.textContent = item.label;
        el.classList.toggle('kt-active', item.active);
        el.onclick = e => { e.stopPropagation(); item.onClick(); popup.hidden = true; };
      });
      return;
    }
    popup.innerHTML = '';
    items.forEach(({ label, active, onClick }) => {
      const item = document.createElement('button');
      item.className = 'kt-popup-item' + (active ? ' kt-active' : '');
      item.textContent = label;
      item.addEventListener('click', e => { e.stopPropagation(); onClick(); popup.hidden = true; });
      popup.appendChild(item);
    });
  }

  return wrap;
}


// ── ui/speed-menu.js ──

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

function createSpeedBtn(store, actions) {
  const wrap = document.createElement('div');
  wrap.className = 'kt-popup-wrap';

  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-speed-btn';
  btn.title = 'Speed'; btn.textContent = '1×';

  const popup = document.createElement('div');
  popup.className = 'kt-popup kt-speed-popup';
  popup.hidden = true;

  RATES.forEach(r => {
    const item = document.createElement('button');
    item.className = 'kt-popup-item';
    item.dataset.rate = r;
    item.textContent = r === 1 ? '1× (normal)' : r + '×';
    item.addEventListener('click', e => { e.stopPropagation(); actions.setRate(r); popup.hidden = true; });
    popup.appendChild(item);
  });

  setupPopupToggle(btn, popup);
  document.body.appendChild(popup);
  wrap.append(btn);

  store.select(
    s => ({ rate: s.rate }),
    ({ rate }) => {
      btn.textContent = rate === 1 ? '1×' : rate + '×';
      popup.querySelectorAll('.kt-popup-item[data-rate]').forEach(item => {
        item.classList.toggle('kt-active', Number(item.dataset.rate) === rate);
      });
    }
  );

  return wrap;
}


// ── ui/fullscreen-button.js ──

function createFullscreenBtn(store, actions) {
  const btn = document.createElement('button');
  btn.className = 'kt-btn kt-fs';
  btn.title = 'Fullscreen (f)';
  btn.innerHTML = svgExpand();
  btn.addEventListener('click', actions.toggleFullscreen);

  store.select(
    s => ({ fullscreen: s.fullscreen }),
    ({ fullscreen }) => {
      btn.innerHTML = fullscreen ? svgCompress() : svgExpand();
      btn.title = fullscreen ? 'Exit fullscreen (f)' : 'Fullscreen (f)';
    }
  );

  return btn;
}


// ── ui/info.js ──

function createInfo(store, actions, viewerInterceptor, api) {
  const wrap    = document.createElement('div');  wrap.className    = 'kt-info';
  const live    = document.createElement('span'); live.className    = 'kt-live-badge'; live.textContent = '● LIVE';
  const viewers = document.createElement('span'); viewers.className = 'kt-viewers';
  const uptime  = document.createElement('span'); uptime.className  = 'kt-uptime';

  wrap.append(viewers, uptime);

  let pollTimer   = null;
  let uptimeTimer = null;
  let startDate   = null;

  // Register viewer-count callback immediately — no null-callback window
  const _unsubViewers = viewerInterceptor.onViewerCount(count => {
    viewers.textContent = fmtViewers(count) + ' watching';
  });

  // ── uptime ticker ────────────────────────────────────────────────────────

  function _startUptimeTicker(start) {
    if (!start || !isFinite(start.getTime())) return;
    if (startDate && start.getTime() === startDate.getTime() && uptimeTimer) return;
    startDate = start;
    clearInterval(uptimeTimer);
    const tick = () => {
      const s = store.getState();
      if (s.engine !== 'dvr') {
        uptime.textContent = fmtUptime(startDate);
      }
      store.setState({ uptimeSec: Math.floor((Date.now() - startDate.getTime()) / 1000) });
      if (store.getState().username && !pollTimer) _startPolling();
    };
    tick();
    uptimeTimer = setInterval(tick, 1000);
  }

  function _stopUptimeTicker() { clearInterval(uptimeTimer); uptimeTimer = null; startDate = null; }

  // ── offline ──────────────────────────────────────────────────────────────

  function _applyOffline() {
    live.textContent = '● OFFLINE';
    live.classList.add('kt-offline');
    viewers.textContent = '';
    uptime.textContent  = '';
    _stopUptimeTicker();
    if (store.getState().engine !== 'dvr') {
      store.setState({ vodId: null, streamStartTime: null, uptimeSec: 0 });
    }
  }

  // ── polling ──────────────────────────────────────────────────────────────

  // FIX: _applyChannelData extracted so it can be called from both
  // the initial eager fetch AND the recurring poll without duplication.
  function _applyChannelData(data) {
    if (data.isLive === null) return;

    if (data.title       !== null) store.setState({ title: data.title });
    if (data.displayName !== null) store.setState({ displayName: data.displayName });
    if (data.avatar      !== null) store.setState({ avatar: data.avatar });

    live.textContent = data.isLive ? '● LIVE' : '● OFFLINE';
    live.classList.toggle('kt-offline', !data.isLive);

    if (!data.isLive) { _applyOffline(); return; }

    if (data.viewers !== null) {
      store.setState({ viewers: data.viewers });
      viewers.textContent = fmtViewers(data.viewers) + ' watching';
    }
    store.setState({ vodId: data.vodId ?? null, streamStartTime: data.startTime ?? null });
    if (data.startTime) {
      let ts = data.startTime;
      if (!ts.includes('T')) ts = ts.replace(' ', 'T');
      if (!/[Zz]$/.test(ts) && !/[+-]\d{2}:?\d{2}$/.test(ts)) ts += 'Z';
      _startUptimeTicker(new Date(ts));
    }
  }

  async function _poll() {
    const s = store.getState();
    if (!s.username) return;
    try {
      const data = await api.fetchChannelInit(s.username);
      _applyChannelData(data);
    } catch (e) { console.warn('[KickTiny] poll error:', e.message); }
  }

  function _startPolling() { clearInterval(pollTimer); _poll(); pollTimer = setInterval(_poll, POLL_INTERVAL_MS); }
  function _stopPolling()  { clearInterval(pollTimer); pollTimer = null; }

  // ── live badge ───────────────────────────────────────────────────────────

  live.addEventListener('click', () => { if (!store.getState().atLiveEdge) actions.seekToLive(); });

  store.select(
    s => ({
      username: s.username,
      atLiveEdge: s.atLiveEdge,
      engine: s.engine,
      dvrBehindLive: s.dvrBehindLive,
      uptimeSec: s.uptimeSec
    }),
    ({ username, atLiveEdge, engine, dvrBehindLive, uptimeSec }) => {
      live.classList.toggle('kt-behind', !atLiveEdge);
      live.title = atLiveEdge ? '' : 'Jump to live';
      // FIX: polling no longer auto-starts here — it's kicked off explicitly
      // from main.js right after username is set, so there's no wait.
      if (startDate) {
        uptime.textContent = engine === 'dvr'
          ? fmtDuration(Math.max(0, uptimeSec - Math.round(dvrBehindLive)))
          : fmtUptime(startDate);
      }
    }
  );

  document.addEventListener('visibilitychange', () => {
    if (!store.getState().username) return;
    if (document.hidden) {
      _stopPolling();
      clearInterval(uptimeTimer); uptimeTimer = null;
    } else {
      if (startDate) _startUptimeTicker(startDate);
      _startPolling();
    }
  });

  // Expose _startPolling so main.js can call it directly after username is set.
  return { live, wrap, destroy: _unsubViewers, startPolling: _startPolling, applyChannelData: _applyChannelData };
}


// ── ui/seekbar.js ──

function createSeekbar(store, actions) {
  const wrap  = document.createElement('div');  wrap.className  = 'kt-seekbar';
  const track = document.createElement('div');  track.className = 'kt-seekbar-track';
  const prog  = document.createElement('div');  prog.className  = 'kt-seekbar-prog';
  const thumb = document.createElement('div');  thumb.className = 'kt-seekbar-thumb';
  const tip   = document.createElement('div');  tip.className   = 'kt-seekbar-tip';

  track.append(prog, thumb);
  wrap.append(track, tip);

  let _dragging        = false;
  let _uptimeSec       = 0;
  let _pendingBehindSec = null; // DVR entry deferred to mouseup

  function render(uiPos, uptimeSec) {
    if (uptimeSec <= 0) { prog.style.width = '0%'; thumb.style.left = '0%'; return; }
    const pct = Math.min(1, Math.max(0, uiPos / uptimeSec)) * 100;
    prog.style.width = `${pct}%`;
    thumb.style.left = `${pct}%`;
  }

  function showTip(e) {
    if (_uptimeSec <= 0) return;
    const rect  = track.getBoundingClientRect();
    const wRect = wrap.getBoundingClientRect();
    const pct   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const behind = _uptimeSec - pct * _uptimeSec;

    tip.textContent = behind <= LIVE_EDGE_BEHIND_SEC ? 'LIVE' : '-' + fmtDuration(behind);
    tip.style.display = 'block';

    const tipW = tip.offsetWidth;
    const hPad = rect.left - wRect.left;
    tip.style.bottom = (wrap.offsetHeight - track.offsetTop + 6) + 'px';
    let left = hPad + (e.clientX - rect.left) - tipW / 2;
    tip.style.left = `${Math.max(0, Math.min(wRect.width - tipW, left))}px`;
  }

  function hideTip() { if (!_dragging) tip.style.display = 'none'; }

  function seekFromEvent(e) {
    if (_uptimeSec <= 0) return;
    const rect = track.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const uiPos   = pct * _uptimeSec;
    const behind  = _uptimeSec - uiPos;
    render(uiPos, _uptimeSec);

    if (behind <= LIVE_EDGE_BEHIND_SEC) {
      if (store.getState().engine === 'dvr') actions.seekToLive();
      _pendingBehindSec = null;
      return;
    }
    if (store.getState().engine === 'dvr') {
      actions.dvrSeekToBehindLive(behind);
      _pendingBehindSec = null;
      return;
    }
    _pendingBehindSec = behind;
  }

  wrap.addEventListener('mouseenter', e => showTip(e));
  wrap.addEventListener('mousemove',  e => showTip(e));
  wrap.addEventListener('mouseleave', () => hideTip());
  wrap.addEventListener('mousedown',  e => { _dragging = true; seekFromEvent(e); e.preventDefault(); });

  document.addEventListener('mousemove', e => { if (!_dragging) return; showTip(e); seekFromEvent(e); });
  document.addEventListener('mouseup', () => {
    if (!_dragging) return;
    _dragging = false;
    tip.style.display = 'none';
    if (_pendingBehindSec !== null && store.getState().engine !== 'dvr') {
      const behind = _pendingBehindSec;
      _pendingBehindSec = null;
      actions.enterDvr(behind);
    } else {
      _pendingBehindSec = null;
    }
  });

  store.select(
    s => ({ uptimeSec: s.uptimeSec, dvrBehindLive: s.dvrBehindLive, engine: s.engine }),
    ({ uptimeSec, dvrBehindLive, engine }) => {
      wrap.style.display = uptimeSec > 0 ? 'block' : 'none';
      if (uptimeSec <= 0) return;
      _uptimeSec = uptimeSec;
      if (_dragging) return;
      render(engine === 'ivs' ? uptimeSec : Math.max(0, uptimeSec - dvrBehindLive), uptimeSec);
  });

  wrap.style.display = 'none';
  return wrap;
}


// ── ui/bar.js ──

function createBar(store, actions, viewerInterceptor, api) {
  const bar = document.createElement('div');
  bar.className = 'kt-bar';

  const info = createInfo(store, actions, viewerInterceptor, api);
  const { live, wrap: infoWrap } = info;

  const left = document.createElement('div'); left.className = 'kt-bar-left';
  left.append(createPlayBtn(store, actions), live, createVolumeCtrl(store, actions), infoWrap);

  const right = document.createElement('div'); right.className = 'kt-bar-right';
  right.append(createSpeedBtn(store, actions), createQualityBtn(store, actions), createFullscreenBtn(store, actions));

  const controls = document.createElement('div'); controls.className = 'kt-controls';
  controls.append(left, right);

  bar.append(createSeekbar(store, actions), controls);

  // Expose info methods so main.js can trigger eager channel fetch
  bar._info = info;

  return bar;
}

function initBarHover(root, bar, container, topBar, store) {
  let hideTimer   = null;

  function hide() {
    bar.classList.remove('kt-bar-visible');
    if (topBar) topBar.classList.remove('kt-top-bar-visible');
    root.classList.add('kt-idle');
    container.classList.add('kt-idle');
  }

  function show() {
    bar.classList.add('kt-bar-visible');
    if (topBar) topBar.classList.add('kt-top-bar-visible');
    root.classList.remove('kt-idle');
    container.classList.remove('kt-idle');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (store.getState().playing) hide(); }, CONTROLS_HIDE_DELAY_MS);
  }

  let _moveRaf = 0;
  container.addEventListener('mousemove', () => {
    if (_moveRaf) return;
    _moveRaf = requestAnimationFrame(() => { show(); _moveRaf = 0; });
  });

  container.addEventListener('mouseleave', () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      bar.classList.remove('kt-bar-visible');
      if (topBar) topBar.classList.remove('kt-top-bar-visible');
      root.classList.remove('kt-idle');
      container.classList.remove('kt-idle');
    }, CONTROLS_LEAVE_DELAY_MS);
  });

  bar.addEventListener('mouseenter', () => {
    clearTimeout(hideTimer);
    bar.classList.add('kt-bar-visible');
    if (topBar) topBar.classList.add('kt-top-bar-visible');
  });

  if (topBar) {
    topBar.addEventListener('mouseenter', () => {
      clearTimeout(hideTimer);
      topBar.classList.add('kt-top-bar-visible');
      bar.classList.add('kt-bar-visible');
    });
  }

  // Only react to actual playing state changes — not every setState tick.
  // The position poll (500ms) and uptime ticker (1s) would otherwise reset
  // the hide timer on every tick, keeping the controls visible forever.
  store.select(
    s => ({ playing: s.playing }),
    ({ playing }) => {
      if (!playing) {
        clearTimeout(hideTimer);
        bar.classList.add('kt-bar-visible');
        if (topBar) topBar.classList.add('kt-top-bar-visible');
        root.classList.remove('kt-idle');
        container.classList.remove('kt-idle');
      } else {
        show();
      }
    }
  );
}


// ── ui/overlay.js ──
function createOverlay(store, actions) {
  const overlay = document.createElement('div');
  overlay.className = 'kt-overlay';
  overlay.innerHTML = `
    <button class="kt-overlay-btn" title="Play (k)">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
    </button>
  `;

  overlay.querySelector('button').addEventListener('click', actions.togglePlay);

  store.select(
    s => ({ alive: s.alive, playing: s.playing, buffering: s.buffering }),
    ({ alive, playing, buffering }) => {
      overlay.classList.toggle('kt-overlay-hidden', !alive || playing || buffering);
    }
  );

  return overlay;
}


// ── ui/topbar.js ──
function createTopBar(store) {
  const bar = document.createElement('div');
  bar.className = 'kt-top-bar';

  const channelLink = document.createElement('a');
  channelLink.className = 'kt-channel-link';
  channelLink.target = '_blank'; channelLink.rel = 'noopener noreferrer';

  const title = document.createElement('div');
  title.className = 'kt-stream-title';

  const avatar = document.createElement('img');
  avatar.className = 'kt-avatar'; avatar.alt = ''; avatar.draggable = false;

  const channelWrap = document.createElement('div');
  channelWrap.className = 'kt-channel-wrap';
  channelWrap.append(avatar, channelLink);
  bar.append(channelWrap, title);

  let _ready = false;
  store.select(
    s => ({ username: s.username, displayName: s.displayName, avatar: s.avatar, title: s.title }),
    ({ username, displayName, avatar: avatarUrl, title: stateTitle }) => {
      if (username && !_ready) {
        _ready = true;
        channelLink.href = `https://www.kick.com/${username}`;
      }
      if (displayName && channelLink.textContent !== displayName) channelLink.textContent = displayName;
      if (avatarUrl  && avatar.src !== avatarUrl)                 avatar.src = avatarUrl;
      if (stateTitle && stateTitle !== title.textContent)         title.textContent = stateTitle;
  });

  return bar;
}


// ── main.js ──
// ── main.js ───────────────────────────────────────────────────────────────────
// Entry point — wiring only. Creates the core services, wires them together,
// and mounts the UI. No business logic lives here.


const CSS = `:root{--kt-black:#0d0d0d;--kt-white:#f0f0f0;--kt-green:#53fc18;--kt-dim:rgba(255,255,255,0.55);--kt-bar-h:42px;--kt-radius:5px;--kt-font:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;--kt-size:13px;--kt-trans:0.2s ease}#kt-root{position:absolute;inset:0;z-index:9999;pointer-events:none;font-family:var(--kt-font);font-size:var(--kt-size);color:var(--kt-white);user-select:none;-webkit-user-select:none}#kt-root.kt-idle{cursor:none}.kt-idle,.kt-idle *{cursor:none !important}.kt-top-bar{position:absolute;top:0;left:0;right:0;padding:10px 14px;display:flex;flex-direction:column;gap:2px;background:linear-gradient(to bottom,rgba(0,0,0,0.85) 0%,rgba(0,0,0,0.5) 60%,transparent 100%);pointer-events:all;opacity:0;transition:opacity var(--kt-trans)}.kt-top-bar-visible{opacity:1}.kt-channel-wrap{display:flex;align-items:center;gap:8px}.kt-avatar{width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1.5px solid rgba(255,255,255,0.2)}.kt-channel-link{font-size:15px;font-weight:700;color:var(--kt-white);text-decoration:none;line-height:1.2;pointer-events:auto}.kt-channel-link:hover{color:var(--kt-green)}.kt-stream-title{font-size:13px;color:var(--kt-white);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;padding-bottom:2px}.kt-bar{position:absolute;bottom:0;left:0;right:0;display:flex;flex-direction:column;padding:0;gap:0;background:linear-gradient(to top,rgba(0,0,0,0.75) 0%,transparent 100%);pointer-events:all;opacity:0;transition:opacity var(--kt-trans);overflow:visible}.kt-bar-visible{opacity:1}.kt-controls{height:var(--kt-bar-h);display:flex;align-items:stretch;justify-content:space-between;padding:0 10px;gap:6px;overflow:visible;min-width:0}.kt-bar-left,.kt-bar-right{display:flex;align-items:center;gap:4px;overflow:visible;flex-shrink:0;min-width:0}.kt-info{display:flex;align-items:center;align-self:stretch;gap:6px;padding:0 4px;flex-shrink:1;overflow:hidden}.kt-bar-left,.kt-bar-right{display:flex;align-items:center;gap:4px;overflow:visible;flex-shrink:0}.kt-seekbar{width:100%;padding:10px 10px 4px;box-sizing:border-box;cursor:pointer;position:relative}.kt-seekbar-track{position:relative;height:3px;border-radius:2px;background:rgba(255,255,255,0.25);transition:height var(--kt-trans)}.kt-seekbar:hover .kt-seekbar-track{height:5px}.kt-seekbar-prog{position:absolute;left:0;top:0;height:100%;width:0%;background:var(--kt-green);border-radius:2px;pointer-events:none;z-index:1}.kt-seekbar-thumb{position:absolute;top:50%;left:0%;width:13px;height:13px;border-radius:50%;background:#fff;transform:translate(-50%,-50%) scale(0);transition:transform 0.15s ease;pointer-events:none;z-index:2}.kt-seekbar:hover .kt-seekbar-thumb{transform:translate(-50%,-50%) scale(1)}.kt-seekbar-tip{position:absolute;display:none;background:rgba(18,18,18,0.9);color:var(--kt-white);font-size:11px;font-weight:600;padding:3px 7px;border-radius:4px;white-space:nowrap;pointer-events:none;user-select:none}.kt-btn:focus-visible,.kt-popup-item:focus-visible,.kt-channel-link:focus-visible,.kt-overlay-btn:focus-visible{outline:2px solid var(--kt-green);outline-offset:2px}.kt-btn{background:none;border:none;padding:0 6px;align-self:center;height:80%;cursor:pointer;color:var(--kt-white);display:flex;align-items:center;justify-content:center;border-radius:var(--kt-radius);transition:color var(--kt-trans),background var(--kt-trans);line-height:0}.kt-btn:hover{color:var(--kt-green);background:rgba(255,255,255,0.08)}.kt-btn svg{width:20px;height:20px}@keyframes kt-spin{to{transform:rotate(360deg)}}.kt-spin{animation:kt-spin 0.8s linear infinite}.kt-vol-wrap{display:flex;align-items:center;align-self:stretch;flex-shrink:0;gap:4px}.kt-vol-slider-wrap{display:none;align-items:center}.kt-vol-wrap:hover .kt-vol-slider-wrap{display:flex}.kt-vol-slider{-webkit-appearance:none;appearance:none;width:70px;height:16px;border-radius:2px;outline:none;cursor:pointer;background:transparent}.kt-vol-slider::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:linear-gradient(to right,var(--kt-green) 0%,var(--kt-green) var(--kt-vol-pct,100%),rgba(255,255,255,0.3) var(--kt-vol-pct,100%),rgba(255,255,255,0.3) 100% )}.kt-vol-slider::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;margin-top:-4.5px;border-radius:50%;background:#fff;cursor:pointer}.kt-vol-slider::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:#fff;cursor:pointer;border:none}.kt-vol-slider::-moz-range-track{height:3px;border-radius:2px;background:rgba(255,255,255,0.3)}.kt-vol-slider::-moz-range-progress{height:3px;border-radius:2px;background:var(--kt-green)}.kt-live-badge{background:#b30906;color:#fff;font-size:10px;font-weight:700;letter-spacing:0.05em;padding:0 8px;height:22px;align-self:center;display:flex;align-items:center;border-radius:var(--kt-radius);line-height:1;transition:background var(--kt-trans)}.kt-live-badge.kt-offline{background:#555}.kt-live-badge.kt-behind{background:#555;cursor:pointer}.kt-live-badge.kt-behind:hover{background:#b30906}.kt-viewers,.kt-uptime{color:var(--kt-dim);font-size:12px;white-space:nowrap}.kt-popup-wrap{position:relative;align-self:stretch;display:flex;align-items:center}.kt-popup{position:fixed;min-width:120px;overflow-y:auto;background:rgba(18,18,18,0.97);border:1px solid rgba(255,255,255,0.12);border-radius:10px;padding:6px;z-index:99999;box-shadow:0 8px 24px rgba(0,0,0,0.6);font-family:var(--kt-font);pointer-events:all;cursor:default}.kt-popup[hidden]{display:none}.kt-popup-item{display:block;width:100%;padding:7px 12px;text-align:left;background:none;border:none;color:var(--kt-white);font-size:var(--kt-size);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer;white-space:nowrap;border-radius:6px;transition:color 0.2s ease,background 0.2s ease}.kt-popup-item:hover{color:var(--kt-white);background:rgba(255,255,255,0.1)}.kt-popup-item.kt-active{color:var(--kt-green)}.kt-qual-btn,.kt-speed-btn{font-size:12px;font-weight:600;padding:6px 8px;letter-spacing:0.02em}.kt-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;transition:opacity var(--kt-trans)}.kt-overlay-hidden{opacity:0}.kt-overlay-btn{pointer-events:auto;background:rgba(0,0,0,0.5);border:none;border-radius:50%;width:60px;height:60px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--kt-white);transition:transform var(--kt-trans),background var(--kt-trans)}.kt-overlay-hidden .kt-overlay-btn{pointer-events:none}.kt-overlay-btn:hover{transform:scale(1.1);background:rgba(83,252,24,0.25);color:var(--kt-green)}.kt-overlay-btn svg{width:32px;height:32px}`;

function injectStyles(css) {
  const style = document.createElement('style');
  style.id = 'kt-styles'; style.textContent = css;
  document.head.appendChild(style);
}

function hideNativeControls() {
  const style = document.createElement('style');
  style.textContent = '.z-controls { display: none !important; }';
  document.head.appendChild(style);
}

function getUsername() {
  return location.pathname.replace(/^\//, '').split('/')[0] || '';
}

function createRoot(container) {
  const root = document.createElement('div');
  root.id = 'kt-root';
  container.appendChild(root);
  return root;
}

function waitForContainer(maxAttempts = 60) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      const c = document.querySelector('.aspect-video-responsive')
        || document.querySelector('div[class*="aspect-video"]');
      if (c) { resolve(c); return; }
      if (++attempts >= maxAttempts) { reject(new Error('[KickTiny] Container not found')); return; }
      setTimeout(check, 200);
    };
    check();
  });
}

let _initialized = false;

async function init() {
  if (_initialized) return;
  _initialized = true;
  try {
    const container = await waitForContainer();

    // ── Core services ───────────────────────────────────────────────────────
    const store   = createStore();
    const prefs   = { load: loadPrefs, save: savePrefs };
    const api     = { fetchChannelInit, fetchVodPlaybackUrl };
    const viewer  = createViewerInterceptor();

    // ── Engine layer ────────────────────────────────────────────────────────
    const engines = createEngineManager(store, prefs, api);

    // ── Actions — the only thing UI touches ────────────────────────────────
    const actions = createActions(store, engines, prefs);

    // ── UI ──────────────────────────────────────────────────────────────────
    injectStyles(CSS);
    hideNativeControls();

    const username = getUsername();
    store.setState({ username });

    const root   = createRoot(container);
    const topBar = createTopBar(store);
    const bar = createBar(store, actions, viewer, api);
    const overlay = createOverlay(store, actions);

    root.append(overlay, topBar, bar);
    initBarHover(root, bar, container, topBar, store);

    // ── FIX: Eager channel info fetch ───────────────────────────────────────
    // Previously channel info only loaded after IVS adapter found the player
    // (up to 20s) because polling started inside the uptime ticker which was
    // itself gated on _onPlayerReady. Now we fire the first fetch immediately
    // after setting username — avatar, title, and viewer count appear in <1s.
    if (username) {
      bar._info.startPolling();
    }

    // ── Double-click: single click = play/pause, double = fullscreen ───────
    let _clickTimer = null;
    container.addEventListener('click', e => {
      if (bar.contains(e.target) || topBar.contains(e.target)) return;
      if (_clickTimer) {
        clearTimeout(_clickTimer); _clickTimer = null;
        actions.toggleFullscreen();
      } else {
        _clickTimer = setTimeout(() => {
          _clickTimer = null;
          actions.togglePlay();
        }, actions.DOUBLE_CLICK_WINDOW_MS);
      }
    });

    // ── Init engines (IVS extraction + DVR container setup) ────────────────
    await engines.init(container);
    actions.bindKeys();

    console.log('[KickTiny] Initialized for', username || 'unknown');
  } catch (e) {
    console.warn('[KickTiny] init error:', e.message);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
