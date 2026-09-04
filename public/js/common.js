/* common.js — shared client plumbing: server clock, API calls, SSE with polling fallback, toast. */
(function (global) {
  'use strict';

  // ---- Server clock ---------------------------------------------------------
  const clock = {
    offset: 0,
    sync(serverNow) {
      if (typeof serverNow === 'number' && isFinite(serverNow)) this.offset = serverNow - Date.now();
    },
    now() {
      return Date.now() + this.offset;
    },
    remaining(ts) {
      if (ts == null) return 0;
      return Math.max(0, ts - this.now());
    },
  };

  function fmtClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // ---- HTTP -----------------------------------------------------------------
  async function parse(res) {
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      data = null;
    }
    if (!res.ok) {
      const e = new Error((data && data.message) || 'שגיאה בתקשורת עם השרת');
      e.code = data && data.error;
      e.status = res.status;
      throw e;
    }
    return data;
  }

  async function api(path, body) {
    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        cache: 'no-store',
      });
    } catch (err) {
      const e = new Error('אין חיבור לשרת, בודקים שוב...');
      e.code = 'network';
      throw e;
    }
    return parse(res);
  }

  async function getState(role, token) {
    const url = `/api/state?role=${encodeURIComponent(role)}` + (token ? `&token=${encodeURIComponent(token)}` : '');
    let res;
    try {
      res = await fetch(url, { cache: 'no-store' });
    } catch (err) {
      const e = new Error('אין חיבור לשרת');
      e.code = 'network';
      throw e;
    }
    return parse(res);
  }

  // ---- Realtime: SSE with backoff + polling fallback --------------------------
  function connectStream(role, token, handlers) {
    const onState = handlers.onState || function () {};
    const onLost = handlers.onLost || function () {};
    const onStatus = handlers.onStatus || function () {};

    let es = null;
    let attempts = 0;
    let everConnected = false;
    let stopped = false;
    let retryTimer = null;
    let pollTimer = null;
    let sseRetryTimer = null;
    let mode = 'sse';

    function status(s) {
      try {
        onStatus(s, mode);
      } catch (err) {
        /* ignore */
      }
    }

    function handle(data) {
      if (!data) return;
      clock.sync(data.serverNow);
      if (data.unknownToken) {
        stop();
        onLost();
        return;
      }
      onState(data);
    }

    function streamUrl() {
      return `/api/stream?role=${encodeURIComponent(role)}` + (token ? `&token=${encodeURIComponent(token)}` : '');
    }

    function clearTimers() {
      clearTimeout(retryTimer);
      retryTimer = null;
    }

    function stopPolling() {
      clearInterval(pollTimer);
      pollTimer = null;
      clearTimeout(sseRetryTimer);
      sseRetryTimer = null;
    }

    async function pollOnce() {
      try {
        const data = await getState(role, token);
        status('online');
        handle(data);
      } catch (err) {
        if (err.status === 404 || err.code === 'unknown_token') {
          stop();
          onLost();
          return;
        }
        status('offline');
      }
    }

    function startPolling() {
      if (pollTimer) return;
      mode = 'poll';
      status('polling');
      pollOnce();
      pollTimer = setInterval(pollOnce, 3000);
      sseRetryTimer = setTimeout(() => {
        stopPolling();
        mode = 'sse';
        attempts = 0;
        openSSE();
      }, 30000);
    }

    function openSSE() {
      if (stopped) return;
      if (typeof EventSource === 'undefined') return startPolling();
      if (es) {
        es.close();
        es = null;
      }
      status('connecting');
      es = new EventSource(streamUrl());
      es.addEventListener('state', (e) => {
        everConnected = true;
        attempts = 0;
        stopPolling();
        mode = 'sse';
        status('online');
        try {
          handle(JSON.parse(e.data));
        } catch (err) {
          /* ignore malformed */
        }
      });
      es.onerror = async () => {
        if (stopped) return;
        if (es) {
          es.close();
          es = null;
        }
        attempts += 1;
        status('offline');
        // Probe with a plain GET: keeps state fresh and detects a dead token (server restart).
        try {
          const data = await getState(role, token);
          handle(data);
          if (stopped) return;
        } catch (err) {
          if (err.status === 404 || err.code === 'unknown_token') {
            stop();
            onLost();
            return;
          }
        }
        if (!everConnected && attempts >= 3) return startPolling();
        const delay = Math.min(15000, 1000 * Math.pow(2, attempts - 1));
        clearTimers();
        retryTimer = setTimeout(openSSE, delay);
      };
    }

    function stop() {
      stopped = true;
      clearTimers();
      stopPolling();
      if (es) {
        es.close();
        es = null;
      }
    }

    // Mobile browsers freeze EventSource in the background; reconnect when visible again.
    document.addEventListener('visibilitychange', () => {
      if (stopped || document.visibilityState !== 'visible') return;
      if (mode === 'sse') {
        // Always reopen: a stream frozen during phone sleep can look OPEN but be dead.
        clearTimers();
        attempts = 0;
        openSSE();
      } else {
        pollOnce();
      }
    });

    openSSE();
    return { stop, get mode() { return mode; } };
  }

  // ---- Toast ----------------------------------------------------------------
  let toastTimer = null;
  function toast(message, kind) {
    let el = document.getElementById('mm-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mm-toast';
      el.className = 'mm-toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.dataset.kind = kind || 'error';
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  // ---- DOM helpers ----------------------------------------------------------
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $$(sel, root) {
    return Array.from((root || document).querySelectorAll(sel));
  }
  function setText(sel, text, root) {
    const el = typeof sel === 'string' ? $(sel, root) : sel;
    if (el && el.textContent !== String(text)) el.textContent = text;
  }
  function showScreen(name) {
    // body carries data-screen as a status flag for tests; never toggle the body itself.
    $$('[data-screen]').forEach((s) => {
      if (s === document.body) return;
      s.hidden = s.dataset.screen !== name;
    });
    document.body.dataset.screen = name;
    document.body.hidden = false;
  }

  // Serialise button actions: mark busy while in flight (render owns 'disabled'), toast on error.
  function bindAction(el, fn) {
    if (!el) return;
    el.addEventListener('click', async () => {
      if (el.disabled || el.dataset.busy) return;
      el.dataset.busy = '1';
      try {
        await fn();
      } catch (err) {
        toast(err.message || 'שגיאה');
      } finally {
        delete el.dataset.busy;
      }
    });
  }

  global.MM = { clock, fmtClock, api, getState, connectStream, toast, $, $$, setText, showScreen, bindAction };
})(window);
