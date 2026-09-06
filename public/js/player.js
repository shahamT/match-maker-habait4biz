/* player.js — phone client. Screens + micro-interactions lifted from "design/Prototype - Mobile.dc.html"
   (renderVals()), wired to the real server state via window.MM (common.js). */
(function () {
  'use strict';
  const { clock, fmtClock, api, getState, connectStream, toast, $, $$, setText, showScreen, bindAction } = window.MM;

  const STORAGE = { teamId: 'mm.teamId', token: 'mm.token' };
  const PAIR_MS = 60 * 1000; // per-pair decision timer (server PAIR_MS)
  const LIFELINES = 3;
  const C = 2 * Math.PI * 33; // ring circumference (r=33)
  const OUT_MS = 240; // cardOutUp .24s
  const FLOAT_MS = 1500; // floatUp 1.5s + badge colour hold
  const LIFE_MS = 700; // prototype swap(): the 🛟 keeps its glow through the fade and turns spent (grayscale) after 700 ms
  const HOLD_MS = 1600; // own-match screen hold after "judged"
  const SPLASH_MS = 2100;

  const state = {
    token: null,
    teamId: null,
    view: null,
    stream: null,
    screen: null,
    pairKey: null,
    lastPair: null,
    out: null, // { side:'a'|'b'|'both', at } — an out-animation started locally
    swapTimer: null,
    lastScore: null,
    lastEventAt: 0,
    floatTimer: null,
    modalOpen: false,
    opening: false,
    closing: false, // accept-cancel in flight: ignore a stale arguing:true push until the server answers
    submitting: false,
    holdUntil: 0,
    holdTimer: null,
    countLabel: null,
    ringClass: '',
    dash: '',
  };

  const els = {};

  // ---- Storage ----------------------------------------------------------------
  function loadCreds() {
    try {
      state.teamId = localStorage.getItem(STORAGE.teamId);
      state.token = localStorage.getItem(STORAGE.token);
    } catch (err) {
      state.teamId = null;
      state.token = null;
    }
  }
  function saveCreds(teamId, token) {
    state.teamId = teamId;
    state.token = token;
    try {
      localStorage.setItem(STORAGE.teamId, teamId);
      localStorage.setItem(STORAGE.token, token);
    } catch (err) {
      /* private mode: session only */
    }
  }
  function clearCreds() {
    state.teamId = null;
    state.token = null;
    try {
      localStorage.removeItem(STORAGE.teamId);
      localStorage.removeItem(STORAGE.token);
    } catch (err) {
      /* ignore */
    }
  }

  // ---- DOM helpers ------------------------------------------------------------
  function replay(el, cls, remove) {
    if (!el) return;
    (remove || [cls]).forEach((c) => el.classList.remove(c));
    void el.offsetWidth; // force reflow so the CSS animation restarts (the prototype's key="…" re-creation)
    el.classList.add(cls);
  }
  function cardTargets(side) {
    if (side === 'a') return [els.cardA];
    if (side === 'b') return [els.cardB];
    return [els.cardA, els.connector, els.cardB];
  }
  function fmtDelta(d) {
    return (d > 0 ? '+' : '−') + Math.abs(d);
  }

  // ---- Boot -------------------------------------------------------------------
  function collect() {
    els.logo = $('.corner-logo');
    els.splash = $('[data-overlay="splash"]');
    els.countdown = $('[data-overlay="countdown"]');
    els.countLabel = $('[data-bind="countdown-label"]');
    els.pausedOverlay = $('[data-overlay="paused"]');
    els.conn = $('[data-bind="conn"]');

    els.joinForm = $('#join-form');
    els.teamInput = $('#teamName');
    els.register = $('#btn-register');

    els.lifelines = $('[data-bind="lifelines"]');
    els.lifeSpans = $$('span', els.lifelines);
    els.ring = $('[data-bind="timer-ring"]');
    els.timerLabel = $('[data-bind="timer-label"]');
    els.badge = $('[data-bind="score-badge"]');
    els.float = $('[data-bind="score-float"]');
    els.cardA = $('[data-slot="1"]');
    els.cardB = $('[data-slot="2"]');
    els.connector = $('[data-bind="connector"]');
    els.swapBtns = $$('[data-lifeline]');
    els.btnYes = $('#btn-yes');
    els.btnNo = $('#btn-no');

    els.modal = $('[data-modal="argument"]');
    els.argForm = $('#argument-form');
    els.argument = $('#argument');
    els.counter = $('#argument-counter');
    els.submit = $('#btn-submit-argument');
    els.pausedRing = $('[data-bind="paused-ring"]');
    els.argA = $('[data-bind="arg-a"]');
    els.argB = $('[data-bind="arg-b"]');

    els.voteActions = $('[data-bind="vote-actions"]');
    els.voteBtns = $$('[data-vote]');
    els.voteStatus = $('[data-bind="vote-status"]');

    els.ownBadge = $('[data-bind="own-score-badge"]');
    els.ownFloat = $('[data-bind="own-score-float"]');

    els.downloaded = $('[data-bind="downloaded"]');
  }

  async function boot() {
    collect();
    loadCreds();
    bindStatic();
    setTimeout(() => {
      els.splash.hidden = true;
    }, SPLASH_MS);
    setInterval(tick, 250);

    if (!state.token) return showOnboarding();
    try {
      const view = await getState('player', state.token);
      render(view);
      connect();
    } catch (err) {
      if (err.status === 404 || err.code === 'unknown_token') {
        clearCreds();
        showOnboarding();
      } else {
        // Server unreachable: keep the token, show the waiting screen and let the stream retry.
        setScreen('waiting');
        els.conn.hidden = false;
        connect();
      }
    }
  }

  function showOnboarding() {
    state.view = null;
    state.pairKey = null;
    state.lastPair = null;
    state.lastScore = null;
    state.lastEventAt = 0;
    state.holdUntil = 0;
    els.countdown.hidden = true;
    els.pausedOverlay.hidden = true;
    els.conn.hidden = true;
    els.downloaded.hidden = true; // prototype hostReset: downloaded:false
    if (state.modalOpen) closeModal(false);
    setScreen('onboarding');
    updateRegister();
  }

  function connect() {
    if (state.stream) state.stream.stop();
    state.stream = connectStream('player', state.token, {
      onState: render,
      onLost() {
        clearCreds();
        toast('המשחק אופס, נא להירשם מחדש', 'info');
        showOnboarding();
      },
      onStatus(s) {
        document.body.dataset.conn = s;
        els.conn.hidden = s !== 'offline';
      },
    });
  }

  function setScreen(name) {
    if (state.screen !== name) {
      showScreen(name);
      // MM.showScreen stamps body.dataset.screen, so on the next call `[data-screen]` matches <body>
      // itself and hides it when its stale value differs. Undo that here (common.js is off-limits).
      document.body.hidden = false;
      state.screen = name;
    }
    els.logo.classList.toggle('on', !(name === 'onboarding' || name === 'waiting'));
  }

  // ---- Static bindings ------------------------------------------------------------
  function updateRegister() {
    // The render owns `disabled`: the button is disabled (opacity .45) while the input is empty.
    els.register.disabled = !els.teamInput.value.trim();
  }

  function bindStatic() {
    // Onboarding — the register button goes through MM.bindAction (serialised, data-busy, error toast).
    els.teamInput.addEventListener('input', updateRegister);
    bindAction(els.register, async () => {
      const teamName = els.teamInput.value.trim();
      if (!teamName) return;
      const { teamId, token } = await api('/api/join', { teamName });
      saveCreds(teamId, token);
      const view = await getState('player', token);
      render(view);
      connect();
    });
    els.joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      // Enter in the input already dispatches a synthetic click on the submit button (e.submitter);
      // a programmatic requestSubmit() has no submitter, so route it through the same bound click.
      if (!e.submitter) els.register.click();
    });

    // Board actions
    bindAction(els.btnNo, async () => {
      startOut('both');
      try {
        render(await api('/api/action/reject', { token: state.token }));
      } catch (err) {
        cancelOut();
        throw err;
      }
      finishOut();
    });

    bindAction(els.btnYes, () => openModal(true));

    els.swapBtns.forEach((btn) =>
      bindAction(btn, async () => {
        const team = state.view && state.view.team;
        if (!team || team.lifelines <= 0) return;
        const side = btn.dataset.lifeline === '1' ? 'a' : 'b';
        const span = els.lifeSpans[LIFELINES - team.lifelines]; // next unspent 🛟
        if (span) {
          replay(span, 'fading');
          setTimeout(() => span.classList.remove('fading'), LIFE_MS);
        }
        startOut(side);
        try {
          render(await api('/api/action/lifeline', { token: state.token, slot: Number(btn.dataset.lifeline) }));
        } catch (err) {
          cancelOut();
          if (span) span.classList.remove('fading');
          throw err;
        }
        finishOut();
      })
    );

    // Argument sheet
    els.argument.addEventListener('input', () => {
      if (els.argument.value.length > 120) els.argument.value = els.argument.value.slice(0, 120);
      updateCounter();
    });
    els.argForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = els.argument.value.trim();
      if (state.submitting || text.length < 3) return;
      state.submitting = true;
      els.submit.disabled = true;
      startOut('both');
      try {
        const view = await api('/api/action/accept', { token: state.token, argument: text });
        closeModal(false);
        render(view);
        finishOut();
      } catch (err) {
        cancelOut();
        toast(err.message);
      } finally {
        state.submitting = false;
        updateCounter();
      }
    });
    $$('[data-action="close-modal"]').forEach((el) => el.addEventListener('click', () => closeModal(true)));

    // Voting
    els.voteBtns.forEach((btn) =>
      bindAction(btn, async () => {
        const m = state.view && state.view.judging && state.view.judging.match;
        if (!m) return;
        render(await api('/api/vote', { token: state.token, matchId: m.id, value: Number(btn.dataset.vote) }));
      })
    );

    // Summary download: open links.exportUrl once (new tab / download) and show "הקובץ בדרך אליכם ✓".
    bindAction($('[data-action="download"]'), () => {
      const v = state.view;
      const url = (v && v.links && v.links.exportUrl) || '/api/host/export.csv';
      // window.open() returns null by spec when 'noopener' is passed, so detach the opener by hand;
      // only fall back to a top-level navigation when the popup was actually blocked.
      const w = window.open(url, '_blank');
      if (w) {
        try {
          w.opener = null;
        } catch (err) {
          /* cross-origin window: nothing to detach */
        }
      } else {
        window.location.assign(url);
      }
      els.downloaded.hidden = false;
    });
  }

  // ---- Argument sheet -----------------------------------------------------------
  function updateCounter() {
    const len = els.argument.value.length;
    setText(els.counter, `${len}/120`);
    els.counter.classList.toggle('near', len >= 110);
    els.submit.disabled = state.submitting || els.argument.value.trim().length < 3;
  }

  async function openModal(notify) {
    if (state.modalOpen) return;
    state.modalOpen = true;
    els.modal.hidden = false;
    els.argument.value = '';
    updateCounter();
    setTimeout(() => {
      if (state.modalOpen) els.argument.focus();
    }, 50);
    if (!notify) return;
    state.opening = true;
    try {
      render(await api('/api/action/accept-open', { token: state.token }));
    } catch (err) {
      closeModal(false);
      throw err;
    } finally {
      state.opening = false;
    }
  }

  async function closeModal(notify) {
    if (!state.modalOpen) return;
    state.modalOpen = false;
    els.modal.hidden = true;
    els.argument.blur();
    if (!notify) return;
    state.closing = true; // mirror of the `opening` guard: a stale arguing:true push must not reopen the sheet
    try {
      render(await api('/api/action/accept-cancel', { token: state.token }));
    } catch (err) {
      /* stale; the next state push sorts it out */
    } finally {
      state.closing = false;
    }
  }

  // Two phones of one team act as one: follow currentPair.arguing.
  function syncModal(view) {
    const cp = view.team.currentPair;
    const onBoard = (view.phase === 'playing' || view.phase === 'paused') && !view.roundOver && cp;
    if (!onBoard) {
      if (state.modalOpen && !state.submitting) closeModal(false);
      return;
    }
    if (cp.arguing && !state.modalOpen && !state.submitting && !state.closing) openModal(false);
    else if (!cp.arguing && state.modalOpen && !state.opening && !state.submitting) closeModal(false);
  }

  // ---- Pair change animation ------------------------------------------------------
  function startOut(side) {
    clearTimeout(state.swapTimer);
    state.out = { side, at: Date.now() };
    cardTargets(side).forEach((el) => replay(el, 'anim-out', ['anim-in', 'anim-out']));
  }
  function cancelOut() {
    state.out = null;
    cardTargets('both').forEach((el) => el.classList.remove('anim-out'));
  }
  // Safety net after an action response: if the pair key did not change (the server re-issued the
  // identical pair), the optimistic out-animation must still be followed by cardInUp.
  function finishOut() {
    if (!state.out) return;
    const side = state.out.side;
    const wait = Math.max(0, OUT_MS - (Date.now() - state.out.at));
    clearTimeout(state.swapTimer);
    state.swapTimer = setTimeout(() => swapIn(side), wait);
  }
  function fillCards(cp) {
    setText($('[data-bind="name"]', els.cardA), cp.businessA.name);
    setText($('[data-bind="description"]', els.cardA), cp.businessA.description || '');
    setText($('[data-bind="name"]', els.cardB), cp.businessB.name);
    setText($('[data-bind="description"]', els.cardB), cp.businessB.description || '');
  }
  function swapIn(side) {
    const latest = state.view && state.view.team && state.view.team.currentPair;
    if (latest) fillCards(latest);
    cardTargets(side).forEach((el) => replay(el, 'anim-in', ['anim-in', 'anim-out']));
    state.out = null;
  }

  function renderPair(cp) {
    if (cp) {
      setText(els.argA, cp.businessA.name);
      setText(els.argB, cp.businessB.name);
    }
    // issuedAt is part of the key: a re-issued identical pair (pool exhausted) must still swap in.
    const key = cp ? `${cp.businessA.id}:${cp.businessB.id}:${cp.issuedAt == null ? '' : cp.issuedAt}` : null;
    if (key === state.pairKey) return;
    const prev = state.lastPair;
    state.pairKey = key;
    state.lastPair = cp;
    if (!cp) {
      clearTimeout(state.swapTimer);
      cancelOut();
      return;
    }
    if (!prev) {
      // First pair (round start / page load): cards simply slide in.
      clearTimeout(state.swapTimer);
      state.out = null;
      fillCards(cp);
      cardTargets('both').forEach((el) => replay(el, 'anim-in', ['anim-in', 'anim-out']));
      return;
    }
    let side = 'both';
    const sameA = prev.businessA.id === cp.businessA.id;
    const sameB = prev.businessB.id === cp.businessB.id;
    if (sameA && !sameB) side = 'b';
    else if (sameB && !sameA) side = 'a';
    if (state.out) {
      // Out-animation already running (optimistic): finish its 240 ms, then swap in on the same side.
      if (state.out.side !== side) side = 'both';
      state.out.side = side; // so finishOut() (fallback) swaps the same side back in
      const wait = Math.max(0, OUT_MS - (Date.now() - state.out.at));
      clearTimeout(state.swapTimer);
      state.swapTimer = setTimeout(() => swapIn(side), wait);
    } else {
      // Pair changed from the server (timeout / other phone): out → swap → in.
      startOut(side);
      state.swapTimer = setTimeout(() => swapIn(side), OUT_MS);
    }
  }

  // ---- Score float + badge ----------------------------------------------------------
  function showFloat(delta) {
    const loss = delta < 0;
    const text = fmtDelta(delta);
    [els.float, els.ownFloat].forEach((el) => {
      el.hidden = true;
      void el.offsetWidth;
      el.textContent = text;
      el.classList.toggle('loss', loss);
      el.hidden = false;
    });
    [els.badge, els.ownBadge].forEach((b) => {
      b.classList.remove('gain', 'loss');
      void b.offsetWidth;
      b.classList.add(loss ? 'loss' : 'gain');
    });
    clearTimeout(state.floatTimer);
    state.floatTimer = setTimeout(() => {
      els.float.hidden = true;
      els.ownFloat.hidden = true;
      els.badge.classList.remove('gain', 'loss');
      els.ownBadge.classList.remove('gain', 'loss');
    }, FLOAT_MS);
  }

  function handleScore(team, first) {
    const ev = team.lastEvent;
    const evNew = !!(ev && ev.at > state.lastEventAt);
    let delta = 0;
    if (!first) {
      if (evNew && ev.delta) delta = ev.delta;
      else if (state.lastScore != null && team.score !== state.lastScore) delta = team.score - state.lastScore;
    }
    if (ev) state.lastEventAt = Math.max(state.lastEventAt, ev.at);
    state.lastScore = team.score;
    $$('[data-bind="score"], [data-bind="own-score"], [data-bind="ended-score"], [data-bind="jw-score"], [data-bind="final-score"]').forEach(
      (el) => setText(el, String(team.score))
    );
    if (!delta) return;
    if (evNew && ev.type === 'judged' && state.screen === 'own') {
      // Hold the own-match screen so the float is seen before the next match appears.
      state.holdUntil = Date.now() + HOLD_MS;
    }
    if (evNew && ev.type === 'accept') setTimeout(() => showFloat(delta), 250); // prototype: float after the card swap
    else showFloat(delta);
  }

  // ---- Lifelines -------------------------------------------------------------------
  function renderLifelines(n) {
    els.lifelines.dataset.count = String(n);
    els.lifeSpans.forEach((s, i) => s.classList.toggle('spent', i < LIFELINES - n));
    els.swapBtns.forEach((b) => {
      b.disabled = n <= 0;
    });
  }

  // ---- Judging -------------------------------------------------------------------
  function renderJudging(view) {
    const j = view.judging || {};
    const m = j.match;
    if (m) {
      setText('[data-bind="other-a"]', m.businessA.name);
      setText('[data-bind="other-desc-a"]', m.businessA.description || '');
      setText('[data-bind="other-b"]', m.businessB.name);
      setText('[data-bind="other-desc-b"]', m.businessB.description || '');
      setText('[data-bind="other-arg"]', m.argument || '');
      if (j.isMine && state.holdUntil <= Date.now()) {
        // Only my own match feeds the "זה השידוך שלכם" pills, and never during the 1.6 s judged hold,
        // so the pills keep showing the pair the float refers to (even if the next match is mine too).
        setText('[data-bind="own-a"]', m.businessA.name);
        setText('[data-bind="own-b"]', m.businessB.name);
      }
      const voted = j.myVote !== null && j.myVote !== undefined;
      els.voteActions.classList.toggle('voted', voted);
      els.voteBtns.forEach((b) => {
        b.disabled = voted || !j.votingOpen;
        b.classList.toggle('chosen', voted && Number(b.dataset.vote) === j.myVote);
      });
      els.voteStatus.hidden = !voted;
    }
    if (j.done) {
      setText('[data-bind="jw-title"]', 'השיפוט הסתיים!');
      $('[data-bind="jw-sub"]').innerHTML = 'כל השידוכים דורגו.<br>ממתינים שהמנחה יכריז על המנצחים — עיניים על המסך הגדול!';
    } else {
      setText('[data-bind="jw-title"]', 'שלב השיפוט');
      $('[data-bind="jw-sub"]').innerHTML = 'ממתינים שהמנחה יעלה את השידוך הבא ללוח...<br>עיניים על המסך הגדול!';
    }
  }

  // ---- Screen selection ----------------------------------------------------------------
  function chooseScreen() {
    const v = state.view;
    if (!v) return;
    const phase = v.phase;
    let name = 'waiting';
    if (phase === 'lobby') name = 'waiting';
    else if (phase === 'playing' || phase === 'paused') name = v.roundOver ? 'ended' : 'board';
    else if (phase === 'judging') name = v.judging && v.judging.match ? (v.judging.isMine ? 'own' : 'vote') : 'judging-wait';
    else if (phase === 'finished') name = 'summary';

    clearTimeout(state.holdTimer);
    if (name !== 'own' && state.screen === 'own' && state.holdUntil > Date.now()) {
      name = 'own';
      state.holdTimer = setTimeout(() => {
        state.holdUntil = 0;
        if (state.view) renderJudging(state.view); // refresh pills/buttons for the match that is now current
        chooseScreen();
      }, state.holdUntil - Date.now() + 20);
    }
    setScreen(name);
    els.pausedOverlay.hidden = !(phase === 'paused' && !v.roundOver);
    if (phase !== 'finished') els.downloaded.hidden = true; // prototype hostReset/hostFinish: downloaded:false
  }

  // ---- Render --------------------------------------------------------------------------
  function render(view) {
    if (!view || view.role !== 'player') return;
    if (view.unknownToken) {
      clearCreds();
      showOnboarding();
      return;
    }
    clock.sync(view.serverNow);
    const first = !state.view;
    state.view = view;
    const team = view.team;

    $$('[data-bind="team-name"]').forEach((el) => setText(el, team.teamName));
    handleScore(team, first);
    renderLifelines(team.lifelines);
    renderPair(team.currentPair);
    $$('[data-bind="my-matches"], [data-bind="jw-matches"], [data-bind="final-matches"]').forEach((el) =>
      setText(el, String(team.myMatches || 0))
    );
    renderJudging(view);
    syncModal(view);
    chooseScreen();
    tick();
  }

  // ---- Timers (server clock, 250 ms) ----------------------------------------------------
  function setRing(cls, dash) {
    if (cls !== state.ringClass) {
      els.ring.className.baseVal = `ring-prog${cls ? ' ' + cls : ''}`;
      state.ringClass = cls;
    }
    if (dash !== state.dash) {
      els.ring.style.strokeDasharray = dash;
      els.pausedRing.style.strokeDasharray = dash;
      state.dash = dash;
    }
  }

  function tick() {
    const v = state.view;
    if (!v || !v.team) return;
    const now = clock.now();

    // 3-2-1 overlay
    const live = (v.phase === 'playing' || v.phase === 'paused') && !v.roundOver;
    const cd = live && v.countdownEndsAt && now < v.countdownEndsAt;
    els.countdown.hidden = !cd;
    if (cd) {
      const rem = v.countdownEndsAt - now;
      const label = rem > 2800 ? '3' : rem > 1900 ? '2' : rem > 1000 ? '1' : 'צאו!';
      if (label !== state.countLabel) {
        state.countLabel = label;
        els.countLabel.dir = label === 'צאו!' ? 'rtl' : 'ltr';
        els.countLabel.textContent = label;
        replay(els.countLabel, 'pop');
      }
    } else {
      state.countLabel = null;
    }

    // Pair ring
    const cp = v.team.currentPair;
    if (cp) {
      let ms;
      if (cp.expiresAt != null) ms = clock.remaining(cp.expiresAt);
      else if (cp.pausedRemaining != null) ms = cp.pausedRemaining;
      else ms = PAIR_MS;
      ms = Math.min(PAIR_MS, Math.max(0, ms));
      const frac = ms / PAIR_MS;
      const dash = `${(C * frac).toFixed(1)} ${(C * (1 - frac)).toFixed(1)}`;
      const colour = ms > 30000 ? '' : ms > 10000 ? 'yellow' : 'red';
      const flash = ms <= 10000 && ms > 0 ? ' flash' : '';
      setText(els.timerLabel, fmtClock(ms));
      setRing((colour + flash).trim(), dash);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
