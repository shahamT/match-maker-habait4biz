/* screen.js — projection + host page (served at /screen and /host).
   Renders the 1920×1080 stage from the server's screen view; all timing comes from MM.clock. */
(function () {
  'use strict';
  const { clock, fmtClock, api, connectStream, toast, $, $$, setText, showScreen, bindAction } = window.MM;

  const RING_C = 2 * Math.PI * 98;
  const EVENT_WINDOW_MS = 1500;
  const ROW_STEP = 52;
  const ROW_H = 48;
  const CONFETTI_COLORS = ['#FCD611', '#A855D6', '#C7ABD4', '#702E91', '#FFF1A8'];

  const state = {
    view: null,
    minutes: null,          // host-chosen round length (setup screen); null until the first state arrives
    minutesTouched: false,
    judgeMatchId: null,     // id of the match currently shown on the judging card
    countLabel: null,       // last countdown label rendered
    lastConn: null,
    confettiBuilt: false,
  };

  // ---- boot ---------------------------------------------------------------------------------
  function boot() {
    fitStage();
    window.addEventListener('resize', fitStage);
    bindStatic();
    connectStream('screen', null, {
      onState: render,
      onStatus(s) {
        document.body.dataset.conn = s;
        if (s === 'offline' && state.lastConn === 'online') toast('אין חיבור לשרת, מתחברים מחדש...');
        if (s === 'online' || s === 'offline') state.lastConn = s;
      },
    });
    setInterval(tick, 250);
  }

  // Scale the 1920×1080 stage to fit the viewport, centred.
  function fitStage() {
    const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    const stage = $('#stage');
    const wrap = $('#stage-wrap');
    stage.style.transform = `scale(${scale})`;
    wrap.style.height = `${Math.round(1080 * scale)}px`;
    wrap.style.width = `${Math.round(1920 * scale)}px`;
  }

  // ---- confirmation dialog (added; replaces window.confirm) ------------------------------------
  let confirmResolve = null;
  let confirmPhase = null;

  function askConfirm(title, body, yesLabel) {
    closeConfirm(false); // never stack dialogs
    setText('[data-bind="confirm-title"]', title);
    setText('[data-bind="confirm-body"]', body);
    setText('#btn-confirm-yes', yesLabel);
    confirmPhase = state.view ? state.view.phase + ':' + !!state.view.roundOver : null;
    $('[data-overlay="confirm"]').hidden = false;
    $('#btn-confirm-yes').focus();
    return new Promise((resolve) => {
      confirmResolve = resolve;
    });
  }

  function closeConfirm(answer) {
    const overlay = $('[data-overlay="confirm"]');
    if (overlay.hidden) return;
    overlay.hidden = true;
    const resolve = confirmResolve;
    confirmResolve = null;
    confirmPhase = null;
    if (resolve) resolve(!!answer);
  }

  // ---- static bindings -----------------------------------------------------------------------
  function bindStatic() {
    $('#btn-confirm-yes').addEventListener('click', () => closeConfirm(true));
    $('#btn-confirm-no').addEventListener('click', () => closeConfirm(false));
    $('[data-overlay="confirm"]').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) closeConfirm(false); // click outside the card = cancel
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeConfirm(false);
      else if (e.key === 'Enter' && !$('[data-overlay="confirm"]').hidden) closeConfirm(true);
    });
    bindAction($('#btn-minus'), () => setMinutes((state.minutes || 1) - 1));
    bindAction($('#btn-plus'), () => setMinutes((state.minutes || 1) + 1));

    // Business pool upload: parsed on this device, sent as JSON, kept in server memory only.
    const fileInput = $('#pool-file');
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          throw new Error('הקובץ אינו JSON תקין');
        }
        const result = await api('/api/host/businesses', { fileName: file.name, businesses: parsed });
        toast(`נטענו ${result.count} עסקים מתוך ${file.name}`, 'info');
      } catch (err) {
        toast(err.message || 'הטעינה נכשלה');
      } finally {
        fileInput.value = '';
      }
    });

    bindAction($('#btn-open-lobby'), async () => {
      const minutes = state.minutes || Math.max(1, Math.round((state.view ? state.view.roundSeconds : 900) / 60));
      await api('/api/host/open-lobby', { roundSeconds: minutes * 60 });
    });
    bindAction($('#btn-start'), () => api('/api/host/start'));
    bindAction($('#btn-add-time'), () => api('/api/host/add-time'));
    bindAction($('#btn-pause'), () => api('/api/host/pause'));
    bindAction($('#btn-resume'), () => api('/api/host/resume'));
    bindAction($('#btn-end-round'), async () => {
      const ok = await askConfirm('לסיים את הסבב?', 'הצמדים לא יוכלו להמשיך לשדך, ונעבור לשלב השיפוט.', '⏹ סיום הסבב');
      if (!ok) return;
      await api('/api/host/end-round');
    });
    bindAction($('#btn-judging'), () => api('/api/host/judging'));
    bindAction($('#btn-podium'), () => api('/api/host/finish'));
    bindAction($('#btn-next'), async () => {
      const j = state.view && state.view.judging;
      const last = j && j.match && j.index + 1 >= j.total;
      await api(last ? '/api/host/finish' : '/api/host/next-match');
    });
    // Added: end judging early. The match on screen is scored; the ones after it stay unranked.
    bindAction($('#btn-finish-judging'), async () => {
      const j = state.view && state.view.judging;
      const left = j && j.match ? Math.max(0, j.total - (j.index + 1)) : 0;
      const what = left === 1 ? 'שידוך אחד לא ידורג' : `${left} שידוכים לא ידורגו`;
      const ok = await askConfirm('לסיים את השיפוט?', `${what} ולא יקבלו ניקוד. השידוך שעל המסך יקבל את הניקוד שהצטבר, ונעבור לפודיום.`, '🏆 סיום ולפודיום');
      if (!ok) return;
      await api('/api/host/finish');
    });
    bindAction($('#btn-export'), async () => {
      const url = state.view && state.view.links && state.view.links.exportUrl;
      if (!url) throw new Error('קובץ הסיכום עדיין לא זמין');
      window.open(url, '_blank', 'noopener');
    });
    bindAction($('#btn-reset'), async () => {
      const ok = await askConfirm('לאפס את המשחק?', 'כל הצמדים, הניקוד והשידוכים יימחקו, ונחזור למסך ההגדרות.', 'איפוס המשחק');
      if (!ok) return;
      await api('/api/host/reset');
      state.minutesTouched = false;
      state.confettiBuilt = false;
    });
  }

  function setMinutes(n) {
    state.minutes = Math.min(30, Math.max(1, n));
    state.minutesTouched = true;
    setText('[data-bind="minutes"]', String(state.minutes));
  }

  // ---- render ---------------------------------------------------------------------------------
  function render(view) {
    if (!view || view.role !== 'screen') return;
    state.view = view;
    document.body.dataset.phase = view.phase;
    // A confirm that is about to act on a phase we already left is stale — drop it.
    if (confirmPhase !== null && confirmPhase !== view.phase + ':' + !!view.roundOver) closeConfirm(false);
    // Off-screen sections keep no team names around: <body> carries data-screen (MM.showScreen), so a
    // '[data-screen="judging"]' lookup resolves to the body and its textContent must stay anonymous.
    if (view.phase !== 'lobby') $('[data-bind="lobby-teams"]').replaceChildren();
    // Leaderboard rows persist (hidden) through judging so rank changes animate when the board returns.

    if (view.phase === 'lobby') {
      state.judgeMatchId = null;
      if (!view.lobbyOpen) {
        if (!state.minutesTouched) {
          state.minutes = Math.min(30, Math.max(1, Math.round((view.roundSeconds || 60) / 60)));
          setText('[data-bind="minutes"]', String(state.minutes));
        }
        renderSetup(view);
        switchScreen('setup');
      } else {
        renderLobby(view);
        switchScreen('lobby');
      }
    } else if (view.phase === 'playing' || view.phase === 'paused') {
      renderLive(view);
      switchScreen('live');
      fitBoard($('[data-board="live"]'), view.leaderboard.length); // measure only once the section is displayed
    } else if (view.phase === 'judging') {
      if (view.judging.match) {
        renderJudging(view);
        switchScreen('judging');
      } else {
        renderLive(view);
        switchScreen('live');
        fitBoard($('[data-board="live"]'), view.leaderboard.length);
      }
    } else if (view.phase === 'finished') {
      renderPodium(view);
      switchScreen('podium');
    }
    if (view.phase !== 'finished') state.confettiBuilt = false;
    tick();
  }

  // MM.showScreen stamps data-screen on <body>, so from its second call on the body itself matches
  // '[data-screen]' and gets hidden whenever the name changes (blank page). Undo that here.
  function switchScreen(name) {
    showScreen(name);
    document.body.hidden = false;
  }

  // ---- setup ----------------------------------------------------------------------------------
  function renderSetup(view) {
    const pool = view.pool || { count: 0, source: 'default', fileName: null };
    const src = pool.source === 'upload' && pool.fileName ? pool.fileName : 'ברירת מחדל';
    setText('[data-bind="pool-summary"]', `${pool.count} עסקים במאגר · ${src}`);
  }

  // ---- lobby ----------------------------------------------------------------------------------
  function renderLobby(view) {
    const img = $('[data-bind="player-qr"]');
    const links = view.links || {};
    if (links.playerQr && img.getAttribute('src') !== links.playerQr) img.src = links.playerQr;
    setText('[data-bind="team-count"]', String(view.teamCount));

    const list = $('[data-bind="lobby-teams"]');
    const keep = new Set();
    (view.leaderboard || []).forEach((t) => {
      keep.add(t.id);
      let chip = list.querySelector(`[data-team="${cssId(t.id)}"]`);
      if (!chip) {
        chip = document.createElement('div');
        chip.className = 'team-chip';
        chip.dataset.team = t.id;
        list.appendChild(chip);
      }
      setText(chip, t.teamName);
    });
    $$('[data-team]', list).forEach((chip) => {
      if (!keep.has(chip.dataset.team)) chip.remove();
    });

    const btn = $('#btn-start');
    btn.disabled = view.teamCount < 2;
  }

  // ---- live board -----------------------------------------------------------------------------
  function renderLive(view) {
    setText('.round-num', String(view.round || 1));
    const board = $('[data-board="live"]');
    const rows = view.leaderboard || [];
    const max = Math.max(10, ...rows.map((r) => r.score));
    const keep = new Set();

    rows.forEach((r) => {
      keep.add(r.id);
      let el = board.querySelector(`[data-team="${cssId(r.id)}"]`);
      const rank = r.rank || rows.indexOf(r) + 1;
      if (!el) {
        el = document.createElement('div');
        el.className = 'row';
        el.dataset.team = r.id;
        el.style.top = `${(rank - 1) * ROW_STEP}px`;
        el.innerHTML =
          '<div dir="ltr" class="row-rank"></div><div class="row-name"></div><div class="row-track"><div class="row-bar"></div></div><div class="row-score-wrap"><div dir="ltr" class="row-score"></div></div>';
        board.appendChild(el);
      }
      el.style.top = `${(rank - 1) * ROW_STEP}px`;
      setText($('.row-rank', el), String(rank));
      setText($('.row-name', el), r.teamName);
      $('.row-bar', el).style.width = `${Math.max(2, Math.round((r.score / max) * 100))}%`;
      setText($('.row-score', el), String(r.score));
      el.classList.toggle('lead', rank === 1 && r.score > 0);
      el._row = r;
      updateRowEvent(el, r);
    });
    $$('[data-team]', board).forEach((el) => {
      if (!keep.has(el.dataset.team)) el.remove();
    });

    // Bottom bar: the whole bar is moot once judging started (the done overlay covers it).
    const judging = view.phase === 'judging';
    const paused = view.phase === 'paused';
    $('#btn-add-time').hidden = judging;
    $('#btn-pause').hidden = judging || paused;
    $('#btn-resume').hidden = judging || !paused;
    $('#btn-end-round').hidden = judging;
    $('#btn-pause').disabled = view.roundOver;
    $('#btn-end-round').disabled = view.roundOver;
  }

  // Scale the board down when more rows exist than fit in its box.
  function fitBoard(board, n) {
    if (!n) {
      board.style.transform = '';
      return;
    }
    const need = (n - 1) * ROW_STEP + ROW_H;
    const avail = board.clientHeight;
    if (avail > 0 && need > avail) board.style.transform = `scale(${(avail / need).toFixed(4)})`;
    else board.style.transform = '';
  }

  // Colour / lift / floating delta for a team whose lastEvent happened within the last 1.5 s.
  function updateRowEvent(el, r) {
    const e = r.lastEvent;
    const fresh = e && e.delta && clock.now() - e.at < EVENT_WINDOW_MS && clock.now() - e.at > -5000;
    const up = !!fresh && e.delta > 0;
    const down = !!fresh && e.delta < 0;
    el.classList.toggle('up', up);
    el.classList.toggle('down', down);
    if (fresh && String(e.at) !== el.dataset.deltaAt) {
      el.dataset.deltaAt = String(e.at);
      const wrap = $('.row-score-wrap', el);
      $$('.row-delta', wrap).forEach((d) => d.remove());
      const d = document.createElement('div');
      d.dir = 'ltr';
      d.className = 'row-delta' + (e.delta < 0 ? ' neg' : '');
      d.textContent = e.delta > 0 ? `+${e.delta}` : `-${Math.abs(e.delta)}`;
      d.addEventListener('animationend', () => d.remove());
      wrap.appendChild(d);
    }
  }

  // ---- judging --------------------------------------------------------------------------------
  function renderJudging(view) {
    const j = view.judging;
    const m = j.match;
    setText('[data-bind="judge-index"]', `${(j.index || 0) + 1}/${j.total}`);

    let card = $('[data-judge-card]');
    if (state.judgeMatchId !== m.id) {
      // Re-create the card so popIn replays on every new match.
      const fresh = card.cloneNode(true);
      card.replaceWith(fresh);
      card = fresh;
      state.judgeMatchId = m.id;
    }
    setText($('[data-bind="judge-a"]', card), m.businessA ? m.businessA.name : '');
    setText($('[data-bind="judge-desc-a"]', card), m.businessA ? m.businessA.description || '' : '');
    setText($('[data-bind="judge-b"]', card), m.businessB ? m.businessB.name : '');
    setText($('[data-bind="judge-desc-b"]', card), m.businessB ? m.businessB.description || '' : '');
    setText($('[data-bind="judge-arg"]', card), m.argument || '');

    const tally = m.tally || {};
    const v5 = tally['5'] || 0;
    const v2 = tally['2'] || 0;
    const vn = tally['-2'] || 0;
    const tot = v5 + v2 + vn;
    const pct5 = tot ? Math.round((v5 / tot) * 100) : 0;
    const pct2 = tot ? Math.round((v2 / tot) * 100) : 0;
    const pctN = tot ? 100 - pct5 - pct2 : 0;
    const avg = tot ? (v5 * 5 + v2 * 2 - vn * 2) / tot : 0;
    // Vote progress: how many of the pairs that may vote have voted, so the host knows
    // at a glance whether it is safe to move on.
    const eligible = j.eligibleVoters || 0;
    const allIn = eligible > 0 && tot >= eligible;
    setText('[data-bind="votes-total"]', String(tot));
    setText('[data-bind="votes-eligible"]', String(eligible));
    setText('[data-bind="votes-label"]', allIn ? 'כולם הצביעו ✓' : 'צמדים הצביעו');
    $('[data-bind="votes-progress"]').classList.toggle('done', allIn);
    setText('[data-bind="weighted"]', (avg >= 0 ? '+' : '') + avg.toFixed(1));
    $('[data-meter="5"]').style.width = `${pct5}%`;
    $('[data-meter="2"]').style.width = `${pct2}%`;
    $('[data-meter="n"]').style.width = `${pctN}%`;
    setText('[data-bind="pct-5"]', `${pct5}%`);
    setText('[data-bind="pct-2"]', `${pct2}%`);
    setText('[data-bind="pct-n"]', `${pctN}%`);
    const last = j.index + 1 >= j.total;
    setText('#btn-next', last ? '🏆 לפודיום' : '⏭️ לשידוך הבא');
    // Only useful while matches remain after this one; on the last match #btn-next already finishes.
    $('#btn-finish-judging').hidden = last;
  }

  // ---- podium ---------------------------------------------------------------------------------
  function renderPodium(view) {
    const pod = (k) => (view.podium && view.podium[k]) || { teamName: '—', score: 0 };
    [1, 2, 3].forEach((n) => {
      const p = pod(n - 1);
      setText(`[data-bind="p${n}-name"]`, p.teamName);
      setText(`[data-bind="p${n}-score"]`, String(p.score));
    });
    if (!state.confettiBuilt) {
      buildConfetti();
      state.confettiBuilt = true;
    }
  }

  function buildConfetti() {
    const box = $('[data-confetti]');
    box.innerHTML = '';
    for (let i = 0; i < 48; i++) {
      const p = document.createElement('div');
      p.className = 'confetti-piece';
      p.style.left = `${(i * 37) % 100}%`;
      p.style.width = `${10 + (i % 4) * 4}px`;
      p.style.height = `${14 + (i % 3) * 6}px`;
      p.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      p.style.borderRadius = i % 3 === 0 ? '50%' : '3px';
      p.style.animation = `confetti ${5 + (i % 5) * 0.9}s linear infinite`;
      p.style.animationDelay = `-${(i * 0.37) % 6}s`;
      box.appendChild(p);
    }
  }

  // ---- 250 ms tick: clock, ring, overlays, row event windows -----------------------------------
  function tick() {
    const v = state.view;
    if (!v) return;
    const now = clock.now();
    const live = v.phase === 'playing' || v.phase === 'paused' || (v.phase === 'judging' && !v.judging.match);

    // Countdown overlay
    const counting = live && v.countdownEndsAt && now < v.countdownEndsAt;
    const cd = $('[data-overlay="countdown"]');
    if (counting) {
      const rem = v.countdownEndsAt - now;
      const label = rem > 2800 ? '3' : rem > 1900 ? '2' : rem > 1000 ? '1' : 'צאו!';
      if (label !== state.countLabel) {
        state.countLabel = label;
        const old = $('[data-bind="countdown-label"]', cd);
        const digit = document.createElement('div');
        digit.className = 'countdown-digit';
        digit.dataset.bind = 'countdown-label';
        digit.dir = label === 'צאו!' ? 'rtl' : 'ltr';
        digit.textContent = label;
        old.replaceWith(digit);
      }
      cd.hidden = false;
    } else {
      cd.hidden = true;
      state.countLabel = null;
    }

    // Ended / judging-done overlay
    const ended = $('[data-overlay="ended"]');
    const roundEnded = (v.phase === 'playing' || v.phase === 'paused') && v.roundOver;
    const judgingDone = v.phase === 'judging' && !v.judging.match;
    if (roundEnded || judgingDone) {
      const variant = judgingDone ? 'done' : 'ended';
      if (ended.dataset.variant !== variant || ended.hidden) {
        ended.dataset.variant = variant;
        setText('[data-bind="ended-emoji"]', judgingDone ? '⚖️' : '⏱');
        setText('[data-bind="ended-title"]', judgingDone ? 'השיפוט הסתיים!' : 'הסבב הסתיים!');
        setText('[data-bind="ended-sub"]', judgingDone ? 'כל השידוכים נשפטו — עוברים להכרזה על המנצחים' : 'עוברים לשלב השיפוט — הצמדים מצביעים מהטלפונים');
        $('#btn-judging').hidden = judgingDone;
        $('#btn-podium').hidden = !judgingDone;
      }
      ended.hidden = false;
    } else {
      ended.hidden = true;
    }

    // Paused overlay (added)
    $('[data-overlay="paused"]').hidden = !(v.phase === 'paused' && !v.roundOver);

    if (!live) return;

    // Round clock + ring. During the 3-2-1 countdown the clock holds the full round length
    // (roundEndsAt already includes the countdown offset) and only starts when the countdown ends.
    let ms = 0;
    if (counting) ms = v.roundTotalMs != null ? v.roundTotalMs : v.roundEndsAt - v.countdownEndsAt;
    else if (v.phase === 'paused') ms = v.pausedRemaining || 0;
    else if (v.roundEndsAt) ms = clock.remaining(v.roundEndsAt);
    const total = v.roundTotalMs || 1;
    const frac = Math.min(1, Math.max(0, ms / total));
    const secs = Math.ceil(ms / 1000);
    const color = ms > total / 2 ? '#00FF87' : ms > 10000 ? '#FCD611' : '#FF0055';
    setText('[data-bind="round-clock"]', fmtClock(ms));
    const ring = $('[data-bind="round-ring"]');
    ring.style.stroke = color;
    ring.style.filter = `drop-shadow(0 0 14px ${color})`;
    ring.style.strokeDasharray = `${(RING_C * frac).toFixed(1)} ${(RING_C * (1 - frac)).toFixed(1)}`;
    ring.classList.toggle('flash', secs <= 10 && secs > 0);

    // Row event windows expire locally (no server push at +1.5 s)
    $$('[data-board="live"] [data-team]').forEach((el) => {
      if (el._row) updateRowEvent(el, el._row);
    });
  }

  function cssId(id) {
    return String(id).replace(/["\\]/g, '\\$&');
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
