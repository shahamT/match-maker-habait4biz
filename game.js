'use strict';
/**
 * game.js — state machine + scoring for "שת"פ נולד".
 *
 * Pure functions over a single in-memory game object. No timers, no I/O:
 * every action receives `now` (epoch ms) from the caller, so timing is
 * owned by the server and fully testable.
 */

const crypto = require('crypto');

// ---- Tunables ---------------------------------------------------------------
const PAIR_MS = 60 * 1000;            // per-pair decision timer
const ADD_TIME_MS = 60 * 1000;        // "⏳ הוסף דקה לסבב" (design: one minute per press)
const COUNTDOWN_MS = 3700;            // 3 · 2 · 1 · צאו! overlay before the round clock starts
const LIFELINES_PER_TEAM = 3;
const MAX_ARGUMENT_CHARS = 120;
const MAX_NAME_CHARS = 40;
const VOTE_VALUES = [5, 2, -2];
const REJECT_DELTA = -1;              // דילוג מודע על זוג עסקים
const TIMEOUT_DELTA = -2;             // נגמר הזמן בלי החלטה — יקר יותר מדילוג
const ACCEPT_DELTA = 3;               // שידוך שנשלח לשיפוט
const MIN_ROUND_SECONDS = 30;
const MAX_ROUND_SECONDS = 4 * 60 * 60;
const DEFAULT_ROUND_SECONDS = 900;

const PHASES = ['lobby', 'playing', 'paused', 'judging', 'finished'];

class GameError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'GameError';
    this.code = code;
    this.status = status;
  }
}

// ---- Construction -----------------------------------------------------------

function createGame(prev) {
  return {
    phase: 'lobby',
    lobbyOpen: false,                 // false = host still on the setup screen; true = QR lobby is showing
    roundSeconds: prev ? prev.roundSeconds : DEFAULT_ROUND_SECONDS,
    roundEndsAt: null,
    roundTotalMs: null,               // initial round length + added minutes (for the ring fraction)
    countdownEndsAt: null,            // epoch ms; clients show the 3-2-1 overlay until then
    pausedRemaining: null,
    roundOver: false,
    pool: prev ? prev.pool : { businesses: [], source: 'default', fileName: null },
    teams: {},
    matches: [],
    // Businesses locked by an accepted match: they never appear in any team's game again.
    matchedBusinesses: [],
    judging: { currentMatchIndex: null, votingOpen: false, lastScored: null, order: [] },
    counters: { team: 0, match: 0 },
    createdAt: Date.now(),
    finishedAt: null,
  };
}

/** Wipe everything except the business pool and the configured round length. */
function reset(game) {
  return createGame(game);
}

// ---- Text helpers -----------------------------------------------------------

// Bidi/format control characters that sneak into copy-pasted Hebrew lists.
const CONTROL_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function cleanText(value, max) {
  let s = String(value == null ? '' : value).replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

// ---- Business pool ----------------------------------------------------------

function pickField(item, exactKeys, fuzzy) {
  for (const k of exactKeys) if (item[k] !== undefined && item[k] !== null) return item[k];
  for (const k of Object.keys(item)) {
    if (fuzzy.test(k) && typeof item[k] === 'string') return item[k];
  }
  return undefined;
}

/**
 * Accepts either the spec shape `{ id, name, description }` or the exported
 * spreadsheet shape `{ "שם העסק": ..., "פעילות עסקית – ניסוח קצר": ... }`
 * (or any object whose first two string values are name/description).
 */
function normalizeBusinesses(raw) {
  let list = raw;
  if (list && !Array.isArray(list) && typeof list === 'object') {
    if (Array.isArray(list.businesses)) list = list.businesses;
    else if (Array.isArray(list.items)) list = list.items;
    else if (Array.isArray(list.data)) list = list.data;
  }
  if (!Array.isArray(list)) {
    throw new GameError('bad_pool', 'הקובץ צריך להכיל רשימה (מערך) של עסקים');
  }
  const out = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const strings = Object.values(item).filter((v) => typeof v === 'string');
    let name = pickField(item, ['name', 'title', 'business', 'שם העסק', 'שם'], /שם|name|title/i);
    let description = pickField(
      item,
      ['description', 'desc', 'about', 'פעילות עסקית – ניסוח קצר', 'פעילות עסקית', 'תיאור'],
      /פעילות|תיאור|desc|about/i
    );
    if (name === undefined) {
      name = strings[0];
      if (description === undefined) description = strings[1];
    } else if (description === undefined) {
      description = strings.find((s) => s !== name);
    }
    name = cleanText(name, 80);
    description = cleanText(description, 200);
    if (!name) return;
    out.push({ id: 'b' + (i + 1), name, description });
  });
  if (out.length < 2) {
    throw new GameError('bad_pool', 'נדרשים לפחות שני עסקים תקינים עם שם');
  }
  return out;
}

function setBusinesses(game, raw, { source = 'upload', fileName = null } = {}) {
  if (game.phase !== 'lobby') {
    throw new GameError('wrong_phase', 'אפשר להחליף את מאגר העסקים רק לפני תחילת המשחק');
  }
  const businesses = normalizeBusinesses(raw);
  game.pool = { businesses, source, fileName: fileName ? cleanText(fileName, 120) : null };
  return game.pool;
}

// ---- Lookups ----------------------------------------------------------------

function teamByToken(game, token) {
  if (!token) return null;
  for (const t of Object.values(game.teams)) if (t.token === token) return t;
  return null;
}

function currentMatch(game) {
  const i = game.judging.currentMatchIndex;
  if (i === null || i === undefined) return null;
  const order = game.judging.order;
  if (order && order.length) {
    const id = order[i];
    return game.matches.find((m) => m.id === id) || null;
  }
  return game.matches[i] || null;
}

/** How many matches the judging phase will walk through. */
function judgingTotal(game) {
  const order = game.judging.order;
  return order && order.length ? order.length : game.matches.length;
}

/**
 * Judging order: one match from every team in turn, then everyone's second, and
 * so on. Teams that ran out of matches are simply skipped, so no team has two
 * matches judged back to back while another is still waiting for its first.
 */
function buildJudgingOrder(game) {
  const byTeam = new Map();
  for (const t of teamList(game).sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1))) {
    byTeam.set(t.id, []);
  }
  for (const m of game.matches) {
    if (!byTeam.has(m.teamId)) byTeam.set(m.teamId, []);
    byTeam.get(m.teamId).push(m.id);
  }
  const lists = Array.from(byTeam.values()).filter((l) => l.length);
  const rounds = lists.reduce((max, l) => Math.max(max, l.length), 0);
  const order = [];
  for (let r = 0; r < rounds; r++) {
    for (const l of lists) if (l[r]) order.push(l[r]);
  }
  return order;
}

function teamList(game) {
  return Object.values(game.teams);
}

function leaderboard(game) {
  return teamList(game)
    .slice()
    .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
}

// ---- Pairing ----------------------------------------------------------------

function randomOf(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Every business currently on some *other* team's screen. */
function shownElsewhere(game, team) {
  const busy = new Set();
  for (const t of teamList(game)) {
    if (t.id === team.id || !t.currentPair) continue;
    busy.add(t.currentPair.businessA.id);
    busy.add(t.currentPair.businessB.id);
  }
  return busy;
}

/**
 * Businesses this team may still be shown, in tiers from strictest to loosest.
 * Tier 1 is the rule as asked for: never shown to this team, never part of an
 * accepted match, and not on another team's screen right now (so two teams can
 * never race for the same business). The looser tiers only come into play when
 * the pool runs dry mid-round — better a repeat than a dead screen.
 */
function candidateTiers(game, team, excludeIds) {
  const ex = new Set(excludeIds || []);
  const seen = new Set(team.seenBusinesses);
  const matched = new Set(game.matchedBusinesses);
  const busy = shownElsewhere(game, team);
  const free = game.pool.businesses.filter((b) => !ex.has(b.id));
  const unmatched = free.filter((b) => !matched.has(b.id));
  const unseen = unmatched.filter((b) => !seen.has(b.id));
  return [unseen.filter((b) => !busy.has(b.id)), unseen, unmatched, free];
}

function pickCandidate(game, team, excludeIds) {
  for (const tier of candidateTiers(game, team, excludeIds)) {
    if (tier.length) return randomOf(tier);
  }
  return null;
}

/** A business shown to a team is burned for that team for the rest of the game. */
function markSeen(team, ...ids) {
  for (const id of ids) if (!team.seenBusinesses.includes(id)) team.seenBusinesses.push(id);
}

function drawPair(game, team) {
  if (game.pool.businesses.length < 2) throw new GameError('pool_too_small', 'נדרשים לפחות שני עסקים במאגר');
  const a = pickCandidate(game, team, []);
  const b = pickCandidate(game, team, [a.id]);
  return Math.random() < 0.5 ? [a, b] : [b, a];
}

/**
 * Lock the businesses of an accepted match. If another team happens to be
 * holding one (only reachable through the loosened tiers above), swap that side
 * out for free — no penalty, no lifeline, timer untouched.
 */
function lockMatched(game, ids, exceptTeamId) {
  for (const id of ids) if (!game.matchedBusinesses.includes(id)) game.matchedBusinesses.push(id);
  const locked = new Set(game.matchedBusinesses);
  for (const t of teamList(game)) {
    if (t.id === exceptTeamId || !t.currentPair) continue;
    for (const key of ['businessA', 'businessB']) {
      const cp = t.currentPair;
      if (!locked.has(cp[key].id)) continue;
      const other = key === 'businessA' ? cp.businessB : cp.businessA;
      const next = pickCandidate(game, t, [other.id, cp[key].id]);
      if (next) {
        cp[key] = next;
        markSeen(t, next.id);
      }
    }
  }
}

function assignPair(game, team, now) {
  const [a, b] = drawPair(game, team);
  markSeen(team, a.id, b.id);
  const paused = game.phase === 'paused';
  // During the 3-2-1 countdown the pair timer only starts when the countdown ends.
  const base = game.countdownEndsAt && game.countdownEndsAt > now ? game.countdownEndsAt : now;
  team.currentPair = {
    businessA: a,
    businessB: b,
    expiresAt: paused ? null : base + PAIR_MS,
    pausedRemaining: paused ? PAIR_MS : null,
    arguing: false,
    issuedAt: now,
  };
  return team.currentPair;
}

// ---- Guards -----------------------------------------------------------------

function assertPhase(game, phases, message) {
  if (!phases.includes(game.phase)) {
    throw new GameError('wrong_phase', message || 'הפעולה לא זמינה בשלב הזה של המשחק');
  }
}

function requirePlayable(game, team, now) {
  if (game.phase === 'paused') throw new GameError('paused', 'המשחק מושהה כרגע');
  if (game.phase !== 'playing') throw new GameError('wrong_phase', 'הפעולה לא זמינה בשלב הזה של המשחק');
  if (game.roundOver) throw new GameError('round_over', 'הסבב הסתיים, ממתינים למנחה');
  if (game.countdownEndsAt && now != null && now < game.countdownEndsAt) {
    throw new GameError('countdown', 'המשחק מתחיל בעוד רגע');
  }
  if (!team.currentPair) throw new GameError('no_pair', 'אין כרגע זוג עסקים פעיל');
}

// ---- Teams ------------------------------------------------------------------

function join(game, { player1, player2, teamName } = {}, now) {
  if (game.phase === 'finished') throw new GameError('game_finished', 'המשחק הסתיים, אי אפשר להצטרף');
  // The onboarding screen asks for one thing: the pair's name. Player names are optional extras.
  const p1 = cleanText(player1, MAX_NAME_CHARS);
  const p2 = cleanText(player2, MAX_NAME_CHARS);
  let name = cleanText(teamName, MAX_NAME_CHARS);
  if (!name && p1 && p2) name = cleanText(`${p1} ו${p2}`, MAX_NAME_CHARS);
  if (!name) throw new GameError('missing_names', 'נא למלא את שם הקבוצה / הצמד');

  const id = 't' + (++game.counters.team);
  const team = {
    id,
    token: crypto.randomBytes(16).toString('hex'),
    player1: p1,
    player2: p2,
    teamName: name,
    score: 0,
    lifelines: LIFELINES_PER_TEAM,
    currentPair: null,
    seenBusinesses: [],
    connected: false,
    joinedAt: now,
    lastEvent: null,
  };
  game.teams[id] = team;
  if ((game.phase === 'playing' || game.phase === 'paused') && !game.roundOver) {
    assignPair(game, team, now);
  }
  return team;
}

function setConnected(game, teamId, connected) {
  const team = game.teams[teamId];
  if (!team) return false;
  const next = !!connected;
  if (team.connected === next) return false;
  team.connected = next;
  return true;
}

// ---- Player actions ---------------------------------------------------------

function reject(game, team, now) {
  requirePlayable(game, team, now);
  team.score += REJECT_DELTA;
  team.lastEvent = { type: 'reject', delta: REJECT_DELTA, at: now };
  assignPair(game, team, now);
}

/** Player opened the argument modal: freeze this team's pair timer. Idempotent. */
function acceptOpen(game, team, now) {
  requirePlayable(game, team, now);
  const cp = team.currentPair;
  if (cp.arguing) return;
  cp.pausedRemaining = Math.max(0, (cp.expiresAt == null ? PAIR_MS : cp.expiresAt) - now);
  cp.expiresAt = null;
  cp.arguing = true;
}

/** Player closed the modal without submitting: resume with the remaining time. */
function acceptCancel(game, team, now) {
  const cp = team.currentPair;
  if (!cp || !cp.arguing) return; // nothing to do (stale request)
  cp.arguing = false;
  if (game.phase === 'playing' && !game.roundOver) {
    cp.expiresAt = now + (cp.pausedRemaining == null ? PAIR_MS : cp.pausedRemaining);
    cp.pausedRemaining = null;
  }
  // paused / round-over: keep pausedRemaining, expiresAt stays null
}

function accept(game, team, argument, now) {
  requirePlayable(game, team, now);
  const text = cleanText(argument);
  if (!text) throw new GameError('empty_argument', 'כתבו נימוק קצר לפני השליחה');
  if (text.length > MAX_ARGUMENT_CHARS) {
    throw new GameError('argument_too_long', `הנימוק ארוך מדי (עד ${MAX_ARGUMENT_CHARS} תווים)`);
  }
  const cp = team.currentPair;
  team.score += ACCEPT_DELTA;
  team.lastEvent = { type: 'accept', delta: ACCEPT_DELTA, at: now };
  game.matches.push({
    id: 'm' + (++game.counters.match),
    teamId: team.id,
    businessA: cp.businessA,
    businessB: cp.businessB,
    argument: text,
    votes: {},
    judged: false,
    judgeScore: null,
    createdAt: now,
  });
  lockMatched(game, [cp.businessA.id, cp.businessB.id], team.id);
  assignPair(game, team, now);
}

function lifeline(game, team, slot, now) {
  requirePlayable(game, team, now);
  const s = Number(slot);
  if (s !== 1 && s !== 2) throw new GameError('bad_slot', 'משבצת לא תקינה');
  if (team.lifelines <= 0) throw new GameError('no_lifelines', 'נגמרו ההחלפות לקבוצה שלכם');

  const cp = team.currentPair;
  const keepKey = s === 1 ? 'businessB' : 'businessA';
  const replaceKey = s === 1 ? 'businessA' : 'businessB';
  const keep = cp[keepKey];
  const current = cp[replaceKey];

  const next = pickCandidate(game, team, [keep.id, current.id]);
  if (!next) throw new GameError('no_candidates', 'אין עסק חלופי זמין במאגר');
  cp[replaceKey] = next;
  markSeen(team, next.id);
  team.lifelines -= 1;
  team.lastEvent = { type: 'lifeline', delta: 0, at: now, slot: s };
}

function vote(game, team, matchId, value) {
  if (game.phase !== 'judging' || !game.judging.votingOpen) {
    throw new GameError('not_voting', 'ההצבעה סגורה כרגע');
  }
  const match = currentMatch(game);
  if (!match || match.id !== String(matchId)) {
    throw new GameError('stale_match', 'השידוך הזה כבר לא בהצבעה');
  }
  if (match.teamId === team.id) throw new GameError('own_match', 'אי אפשר להצביע לשידוך שלכם');
  const v = Number(value);
  if (!VOTE_VALUES.includes(v)) throw new GameError('bad_vote', 'ערך הצבעה לא תקין');
  if (match.votes[team.id] !== undefined) throw new GameError('already_voted', 'הצבעתכם כבר נקלטה');
  match.votes[team.id] = v;
}

// ---- Round clock / tick -----------------------------------------------------

/** Advance time-based state. Returns true if anything changed. */
function tick(game, now) {
  let changed = false;
  if (game.phase === 'playing' && !game.roundOver && game.roundEndsAt != null && now >= game.roundEndsAt) {
    game.roundOver = true;
    for (const t of teamList(game)) {
      if (t.currentPair) {
        t.currentPair.expiresAt = null;
        t.currentPair.pausedRemaining = null;
      }
    }
    changed = true;
  }
  if (game.phase === 'playing' && !game.roundOver) {
    for (const t of teamList(game)) {
      const cp = t.currentPair;
      if (cp && cp.expiresAt != null && now >= cp.expiresAt) {
        t.score += TIMEOUT_DELTA;
        t.lastEvent = { type: 'timeout', delta: TIMEOUT_DELTA, at: now };
        assignPair(game, t, now);
        changed = true;
      }
    }
  }
  return changed;
}

// ---- Host actions -----------------------------------------------------------

function validRoundSeconds(roundSeconds, fallback) {
  const s = roundSeconds == null || roundSeconds === '' ? fallback : Number(roundSeconds);
  if (!Number.isFinite(s) || s < MIN_ROUND_SECONDS || s > MAX_ROUND_SECONDS) {
    throw new GameError(
      'bad_round_seconds',
      `אורך הסבב חייב להיות בין ${MIN_ROUND_SECONDS} ל-${MAX_ROUND_SECONDS} שניות`
    );
  }
  return Math.round(s);
}

/** Host leaves the setup screen: commit the round length and show the QR lobby. */
function openLobby(game, roundSeconds) {
  assertPhase(game, ['lobby'], 'הלובי כבר נפתח');
  game.roundSeconds = validRoundSeconds(roundSeconds, game.roundSeconds);
  game.lobbyOpen = true;
}

function start(game, roundSeconds, now) {
  assertPhase(game, ['lobby'], 'אפשר להתחיל סבב רק מהלובי');
  game.roundSeconds = validRoundSeconds(roundSeconds, game.roundSeconds);
  if (game.pool.businesses.length < 2) throw new GameError('pool_too_small', 'נדרשים לפחות שני עסקים במאגר');
  game.lobbyOpen = true;
  game.countdownEndsAt = now + COUNTDOWN_MS;
  game.roundTotalMs = game.roundSeconds * 1000;
  game.roundEndsAt = game.countdownEndsAt + game.roundTotalMs;
  game.pausedRemaining = null;
  game.roundOver = false;
  game.phase = 'playing';
  for (const t of teamList(game)) assignPair(game, t, now);
}

/** Host ends the round early: same effect as the clock hitting zero. */
function endRound(game, now) {
  assertPhase(game, ['playing', 'paused'], 'אין סבב פעיל לסיים');
  if (game.roundOver) return;
  game.phase = 'playing';
  game.roundOver = true;
  game.roundEndsAt = now;
  game.pausedRemaining = null;
  game.countdownEndsAt = null;
  for (const t of teamList(game)) {
    if (t.currentPair) {
      t.currentPair.expiresAt = null;
      t.currentPair.pausedRemaining = null;
    }
  }
}

function pause(game, now) {
  assertPhase(game, ['playing'], 'אפשר להשהות רק בזמן משחק');
  game.pausedRemaining = Math.max(0, game.roundEndsAt - now);
  game.roundEndsAt = null;
  game.countdownEndsAt = null;
  for (const t of teamList(game)) {
    const cp = t.currentPair;
    if (cp && cp.expiresAt != null) {
      cp.pausedRemaining = Math.max(0, cp.expiresAt - now);
      cp.expiresAt = null;
    }
  }
  game.phase = 'paused';
}

function resume(game, now) {
  assertPhase(game, ['paused'], 'המשחק לא מושהה');
  game.roundEndsAt = now + (game.pausedRemaining == null ? 0 : game.pausedRemaining);
  game.pausedRemaining = null;
  game.phase = 'playing';
  if (!game.roundOver) {
    for (const t of teamList(game)) {
      const cp = t.currentPair;
      if (cp && !cp.arguing && cp.expiresAt == null) {
        cp.expiresAt = now + (cp.pausedRemaining == null ? PAIR_MS : cp.pausedRemaining);
        cp.pausedRemaining = null;
      }
    }
  }
}

function addTime(game, now) {
  assertPhase(game, ['playing', 'paused'], 'אפשר להוסיף זמן רק במהלך סבב');
  game.roundTotalMs = (game.roundTotalMs || 0) + ADD_TIME_MS;
  if (game.phase === 'paused') {
    game.pausedRemaining = (game.pausedRemaining || 0) + ADD_TIME_MS;
    if (game.roundOver) game.roundOver = false;
    for (const t of teamList(game)) if (!t.currentPair) assignPair(game, t, now);
    return;
  }
  if (game.roundOver) {
    // Rescue an ended round: everyone gets another minute and a fresh pair.
    game.roundOver = false;
    game.roundEndsAt = now + ADD_TIME_MS;
    for (const t of teamList(game)) assignPair(game, t, now);
  } else {
    game.roundEndsAt += ADD_TIME_MS;
  }
}

function beginJudging(game, now) {
  assertPhase(game, ['playing', 'paused'], 'אפשר לעבור לשיפוט רק מתוך סבב פעיל');
  game.roundOver = true;
  game.roundEndsAt = null;
  game.pausedRemaining = null;
  game.countdownEndsAt = null;
  for (const t of teamList(game)) {
    if (t.currentPair) {
      t.currentPair.expiresAt = null;
      t.currentPair.pausedRemaining = null;
      t.currentPair.arguing = false;
    }
  }
  if (!game.matches.length) {
    game.phase = 'finished';
    game.finishedAt = now;
    return;
  }
  game.phase = 'judging';
  game.judging.order = buildJudgingOrder(game);
  game.judging.currentMatchIndex = 0;
  game.judging.votingOpen = true;
  game.judging.lastScored = null;
}

function scoreCurrentMatch(game, now) {
  const m = currentMatch(game);
  if (!m || m.judged) return null;
  const values = Object.values(m.votes);
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const score = Math.round(mean) || 0; // normalise -0
  m.judged = true;
  m.judgeScore = score;
  const team = game.teams[m.teamId];
  if (team) {
    team.score += score;
    team.lastEvent = { type: 'judged', delta: score, at: now, matchId: m.id };
  }
  game.judging.lastScored = { teamId: m.teamId, matchId: m.id, delta: score, at: now };
  return score;
}

function nextMatch(game, now) {
  assertPhase(game, ['judging'], 'לא נמצאים בשלב השיפוט');
  if (game.judging.currentMatchIndex === null) throw new GameError('judging_done', 'כל השידוכים כבר נשפטו');
  scoreCurrentMatch(game, now);
  const next = game.judging.currentMatchIndex + 1;
  if (next >= judgingTotal(game)) {
    game.judging.currentMatchIndex = null;
    game.judging.votingOpen = false;
  } else {
    game.judging.currentMatchIndex = next;
    game.judging.votingOpen = true;
  }
}

function finish(game, now) {
  assertPhase(game, ['playing', 'paused', 'judging'], 'אין משחק פעיל לסיים');
  if (game.phase === 'judging' && game.judging.currentMatchIndex !== null) scoreCurrentMatch(game, now);
  game.judging.currentMatchIndex = null;
  game.judging.votingOpen = false;
  game.roundEndsAt = null;
  game.pausedRemaining = null;
  game.roundOver = true;
  game.phase = 'finished';
  game.finishedAt = now;
}

// ---- Views ------------------------------------------------------------------

function businessView(b) {
  return b ? { id: b.id, name: b.name, description: b.description } : null;
}

function pairView(cp) {
  if (!cp) return null;
  return {
    businessA: businessView(cp.businessA),
    businessB: businessView(cp.businessB),
    expiresAt: cp.expiresAt,
    pausedRemaining: cp.pausedRemaining,
    arguing: !!cp.arguing,
    issuedAt: cp.issuedAt,
  };
}

function rowView(team, rank) {
  const e = team.lastEvent;
  return {
    id: team.id,
    teamName: team.teamName,
    player1: team.player1,
    player2: team.player2,
    score: team.score,
    lifelines: team.lifelines,
    connected: !!team.connected,
    rank,
    // Last score change, so the projection can float "+2"/"−2" and colour the bar for ~1.5s.
    lastEvent: e && e.delta ? { type: e.type, delta: e.delta, at: e.at } : null,
  };
}

function matchStats(m) {
  const values = Object.values(m.votes);
  const tally = { '5': 0, '2': 0, '-2': 0 };
  for (const v of values) tally[String(v)] = (tally[String(v)] || 0) + 1;
  const average = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return { voteCount: values.length, average, tally };
}

function judgingView(game, { forTeam = null, includeSubmitter = false } = {}) {
  const j = game.judging;
  const total = judgingTotal(game);
  const view = {
    index: j.currentMatchIndex,
    total,
    votingOpen: !!j.votingOpen,
    done: game.phase === 'judging' && j.currentMatchIndex === null,
    lastScored: j.lastScored,
    match: null,
  };
  const m = currentMatch(game);
  if (!m) return view;
  const stats = matchStats(m);
  view.eligibleVoters = Math.max(0, teamList(game).length - 1);
  view.match = {
    id: m.id,
    businessA: businessView(m.businessA),
    businessB: businessView(m.businessB),
    argument: m.argument,
    voteCount: stats.voteCount,
    average: stats.average,
    tally: stats.tally,
  };
  if (includeSubmitter) {
    const t = game.teams[m.teamId];
    view.match.teamId = m.teamId;
    view.match.teamName = t ? t.teamName : null;
  }
  if (forTeam) {
    view.isMine = m.teamId === forTeam.id;
    view.myVote = m.votes[forTeam.id] === undefined ? null : m.votes[forTeam.id];
  }
  return view;
}

function baseView(game, role, now) {
  const rows = leaderboard(game).map((t, i) => rowView(t, i + 1));
  return {
    role,
    serverNow: now,
    phase: game.phase,
    lobbyOpen: !!game.lobbyOpen,
    roundOver: !!game.roundOver,
    round: 1,
    roundSeconds: game.roundSeconds,
    roundEndsAt: game.roundEndsAt,
    roundTotalMs: game.roundTotalMs,
    countdownEndsAt: game.countdownEndsAt,
    pausedRemaining: game.pausedRemaining,
    teamCount: rows.length,
    matchCount: game.matches.length,
    podium: rows.slice(0, 3),
    _rows: rows,
  };
}

/**
 * Build the state payload for one client.
 * @param {'player'|'screen'|'host'} role
 * @param {{ token?: string, links?: object }} opts
 */
function viewFor(game, role, opts, now) {
  opts = opts || {};
  const base = baseView(game, role, now);
  const rows = base._rows;
  delete base._rows;

  if (role === 'player') {
    const team = teamByToken(game, opts.token);
    if (!team) return { role, serverNow: now, phase: game.phase, unknownToken: true };
    const rank = rows.findIndex((r) => r.id === team.id) + 1;
    return Object.assign(base, {
      team: {
        id: team.id,
        teamName: team.teamName,
        player1: team.player1,
        player2: team.player2,
        score: team.score,
        lifelines: team.lifelines,
        rank,
        currentPair: pairView(team.currentPair),
        myMatches: game.matches.filter((m) => m.teamId === team.id).length,
        lastEvent: team.lastEvent,
      },
      judging: judgingView(game, { forTeam: team }),
      links: opts.links ? { exportUrl: opts.links.exportUrl } : null,
    });
  }

  if (role === 'screen') {
    return Object.assign(base, {
      leaderboard: rows,
      judging: judgingView(game, {}), // anonymous: no submitter
      pool: { count: game.pool.businesses.length, source: game.pool.source, fileName: game.pool.fileName },
      links: opts.links || null,
    });
  }

  if (role === 'host') {
    return Object.assign(base, {
      leaderboard: rows,
      teams: leaderboard(game).map((t, i) =>
        Object.assign(rowView(t, i + 1), {
          currentPair: pairView(t.currentPair),
          myMatches: game.matches.filter((m) => m.teamId === t.id).length,
          joinedAt: t.joinedAt,
        })
      ),
      matches: game.matches.map((m) => {
        const t = game.teams[m.teamId];
        const stats = matchStats(m);
        return {
          id: m.id,
          teamId: m.teamId,
          teamName: t ? t.teamName : null,
          businessA: businessView(m.businessA),
          businessB: businessView(m.businessB),
          argument: m.argument,
          voteCount: stats.voteCount,
          average: stats.average,
          judged: m.judged,
          judgeScore: m.judgeScore,
          createdAt: m.createdAt,
        };
      }),
      judging: judgingView(game, { includeSubmitter: true }),
      pool: { count: game.pool.businesses.length, source: game.pool.source, fileName: game.pool.fileName },
      links: opts.links || null,
    });
  }

  throw new GameError('bad_role', 'תפקיד לא תקין');
}

// ---- Export -----------------------------------------------------------------

function exportRows(game) {
  const rows = game.matches.map((m) => {
    const t = game.teams[m.teamId];
    return {
      teamName: t ? t.teamName : '',
      players: t ? [t.player1, t.player2].filter(Boolean).join(', ') : '',
      businessA: m.businessA ? m.businessA.name : '',
      businessB: m.businessB ? m.businessB.name : '',
      argument: m.argument,
      judgeScore: m.judged ? m.judgeScore : null,
      createdAt: m.createdAt,
    };
  });
  rows.sort((a, b) => {
    const sa = a.judgeScore == null ? -Infinity : a.judgeScore;
    const sb = b.judgeScore == null ? -Infinity : b.judgeScore;
    return sb - sa || a.createdAt - b.createdAt;
  });
  return rows;
}

module.exports = {
  GameError,
  PHASES,
  PAIR_MS,
  ADD_TIME_MS,
  COUNTDOWN_MS,
  LIFELINES_PER_TEAM,
  MAX_ARGUMENT_CHARS,
  VOTE_VALUES,
  DEFAULT_ROUND_SECONDS,
  createGame,
  reset,
  normalizeBusinesses,
  setBusinesses,
  teamByToken,
  currentMatch,
  leaderboard,
  join,
  setConnected,
  reject,
  acceptOpen,
  acceptCancel,
  accept,
  lifeline,
  vote,
  tick,
  openLobby,
  start,
  endRound,
  pause,
  resume,
  addTime,
  beginJudging,
  nextMatch,
  finish,
  viewFor,
  exportRows,
};
