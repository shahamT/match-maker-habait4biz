/* Unit tests for game.js — pure functions driven with injected timestamps.
   Run: node test/unit.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const game = require('../game.js');

const hebrewPool = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'businesses-hebrew-keys.json'), 'utf8'));
const VALID_IN_FIXTURE = 8; // one entry has a blank name and is dropped
const CONTROL_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
const CD = game.COUNTDOWN_MS; // 3700: pair + round timers start when the 3-2-1 overlay ends
const MIN = game.ADD_TIME_MS; // 60000

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓', name);
  } catch (e) {
    console.log('  ✗', name, '\n    ', e.message);
    process.exitCode = 1;
  }
}
function throwsCode(fn, code) {
  try {
    fn();
  } catch (e) {
    assert.strictEqual(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return;
  }
  throw new Error(`expected error ${code}`);
}
function fresh(pool) {
  const g = game.createGame();
  game.setBusinesses(g, pool || hebrewPool, { source: 'upload', fileName: 'fixture.json' });
  return g;
}
const T = (name) => ({ teamName: name });

console.log('normalizeBusinesses');
ok('spreadsheet shape: bidi marks stripped, blank names dropped, duplicates kept', () => {
  const list = game.normalizeBusinesses(hebrewPool);
  assert.strictEqual(list.length, VALID_IN_FIXTURE);
  assert.ok(list.every((b) => b.name && !CONTROL_RE.test(b.name) && !CONTROL_RE.test(b.description)));
  assert.strictEqual(list.filter((b) => b.name === 'שירן פרץ').length, 2);
  assert.strictEqual(list[1].name, 'מייטר הנשמה');
  assert.strictEqual(new Set(list.map((b) => b.id)).size, VALID_IN_FIXTURE);
});
ok('spec shape + wrapper object + positional fallback', () => {
  assert.strictEqual(game.normalizeBusinesses({ businesses: [{ name: 'a', description: 'x' }, { name: 'b' }] }).length, 2);
  const pos = game.normalizeBusinesses([{ foo: 'שם', bar: 'תיאור' }, { foo: 'שם2', bar: 'תיאור2' }]);
  assert.strictEqual(pos[0].name, 'שם');
  assert.strictEqual(pos[0].description, 'תיאור');
});
ok('rejects non-arrays and fewer than 2 valid entries', () => {
  throwsCode(() => game.normalizeBusinesses('x'), 'bad_pool');
  throwsCode(() => game.normalizeBusinesses([{ name: '' }, { name: '' }]), 'bad_pool');
});

console.log('lobby');
ok('join: team name only (design), or two players → auto name; nothing → error', () => {
  const g = fresh();
  assert.strictEqual(game.join(g, T('צמד הגולן'), 0).teamName, 'צמד הגולן');
  assert.strictEqual(game.join(g, { player1: 'א', player2: 'ב' }, 0).teamName, 'א וב');
  throwsCode(() => game.join(g, { player1: 'א' }, 0), 'missing_names');
  throwsCode(() => game.join(g, { teamName: '  ' }, 0), 'missing_names');
});
ok('open-lobby commits round length and flips lobbyOpen; start also opens it', () => {
  const g = fresh();
  assert.strictEqual(g.lobbyOpen, false);
  throwsCode(() => game.openLobby(g, 5), 'bad_round_seconds');
  game.openLobby(g, 600);
  assert.strictEqual(g.lobbyOpen, true);
  assert.strictEqual(g.roundSeconds, 600);
  game.join(g, T('x'), 0);
  game.start(g, undefined, 0);
  assert.strictEqual(g.roundSeconds, 600);
  assert.strictEqual(g.roundTotalMs, 600000);
  const g2 = fresh();
  game.start(g2, 300, 0);
  assert.strictEqual(g2.lobbyOpen, true);
  assert.strictEqual(game.reset(g2).lobbyOpen, false);
});

console.log('timers');
ok('start: countdown 3.7s, then pair + round timers run; actions blocked during countdown', () => {
  const g = fresh();
  const A = game.join(g, T('א'), 0);
  game.start(g, 300, 0);
  assert.strictEqual(g.countdownEndsAt, CD);
  assert.strictEqual(g.roundEndsAt, CD + 300000);
  assert.strictEqual(A.currentPair.expiresAt, CD + 60000);
  throwsCode(() => game.reject(g, A, 1000), 'countdown');
  throwsCode(() => game.lifeline(g, A, 1, 1000), 'countdown');
  game.reject(g, A, CD);
  assert.strictEqual(A.score, -1);
  assert.strictEqual(A.currentPair.expiresAt, CD + 60000);
});
ok('pair timeout at exactly 60s after countdown: −2, new pair, timer reset', () => {
  const g = fresh();
  const A = game.join(g, T('א'), 0);
  game.start(g, 300, 0);
  assert.strictEqual(game.tick(g, CD + 59999), false);
  assert.strictEqual(game.tick(g, CD + 60000), true);
  assert.strictEqual(A.score, -2);
  assert.strictEqual(A.currentPair.expiresAt, CD + 120000);
  assert.strictEqual(A.lastEvent.type, 'timeout');
  assert.strictEqual(A.seenBusinesses.length, 4); // two pairs, four distinct businesses
});
ok('pause freezes round + pair timers, resume restores exactly', () => {
  const g = fresh();
  const A = game.join(g, T('א'), 0);
  game.start(g, 300, 0);
  game.pause(g, 10000);
  assert.strictEqual(g.phase, 'paused');
  assert.strictEqual(g.pausedRemaining, CD + 300000 - 10000);
  assert.strictEqual(g.countdownEndsAt, null);
  assert.strictEqual(A.currentPair.expiresAt, null);
  assert.strictEqual(A.currentPair.pausedRemaining, CD + 60000 - 10000);
  throwsCode(() => game.reject(g, A, 20000), 'paused');
  assert.strictEqual(game.tick(g, 999999), false);
  game.resume(g, 100000);
  assert.strictEqual(g.roundEndsAt, 100000 + CD + 300000 - 10000);
  assert.strictEqual(A.currentPair.expiresAt, 100000 + CD + 60000 - 10000);
  assert.strictEqual(A.currentPair.pausedRemaining, null);
});
ok('accept-open freezes only that team; cancel resumes with the remaining time', () => {
  const g = fresh();
  const A = game.join(g, T('א'), 0);
  const B = game.join(g, T('ב'), 0);
  game.start(g, 300, 0);
  game.acceptOpen(g, A, 20000);
  assert.strictEqual(A.currentPair.arguing, true);
  assert.strictEqual(A.currentPair.pausedRemaining, CD + 60000 - 20000);
  assert.strictEqual(A.currentPair.expiresAt, null);
  game.acceptOpen(g, A, 25000); // idempotent
  assert.strictEqual(A.currentPair.pausedRemaining, CD + 60000 - 20000);
  assert.strictEqual(game.tick(g, CD + 60000), true); // B times out, A does not
  assert.strictEqual(B.score, -2);
  assert.strictEqual(A.score, 0);
  game.acceptCancel(g, A, 200000);
  assert.strictEqual(A.currentPair.expiresAt, 200000 + CD + 60000 - 20000);
  assert.strictEqual(A.currentPair.arguing, false);
});
ok('pause while arguing keeps the argued remaining; resume does not restart it', () => {
  const g = fresh();
  const A = game.join(g, T('א'), 0);
  game.start(g, 300, 0);
  game.acceptOpen(g, A, 30000);
  game.pause(g, 40000);
  game.resume(g, 50000);
  assert.strictEqual(A.currentPair.expiresAt, null); // still arguing
  assert.strictEqual(A.currentPair.pausedRemaining, CD + 60000 - 30000);
  game.acceptCancel(g, A, 60000);
  assert.strictEqual(A.currentPair.expiresAt, 60000 + CD + 60000 - 30000);
});
ok('round end → roundOver, no more penalties, actions rejected; add-time rescues with one minute', () => {
  const g = fresh();
  const A = game.join(g, T('א'), 0);
  game.start(g, 60, 0);
  game.acceptOpen(g, A, 5000);
  assert.strictEqual(game.tick(g, CD + 60000), true);
  assert.strictEqual(g.roundOver, true);
  assert.strictEqual(A.currentPair.expiresAt, null);
  assert.strictEqual(game.tick(g, 999999), false);
  assert.strictEqual(A.score, 0);
  throwsCode(() => game.reject(g, A, 70000), 'round_over');
  throwsCode(() => game.accept(g, A, 'x', 70000), 'round_over');
  game.addTime(g, 100000);
  assert.strictEqual(g.roundOver, false);
  assert.strictEqual(g.roundEndsAt, 100000 + MIN);
  assert.strictEqual(g.roundTotalMs, 60000 + MIN);
  assert.strictEqual(A.currentPair.expiresAt, 100000 + 60000);
  assert.strictEqual(A.currentPair.arguing, false);
});
ok('end-round (host) freezes everyone like the clock hitting zero; works from paused too', () => {
  const g = fresh();
  const A = game.join(g, T('א'), 0);
  game.start(g, 300, 0);
  game.endRound(g, 10000);
  assert.strictEqual(g.roundOver, true);
  assert.strictEqual(g.roundEndsAt, 10000);
  assert.strictEqual(A.currentPair.expiresAt, null);
  throwsCode(() => game.reject(g, A, 11000), 'round_over');
  assert.strictEqual(game.tick(g, 999999), false);
  const g2 = fresh();
  game.join(g2, T('ב'), 0);
  game.start(g2, 300, 0);
  game.pause(g2, 5000);
  game.endRound(g2, 6000);
  assert.strictEqual(g2.phase, 'playing');
  assert.strictEqual(g2.roundOver, true);
  throwsCode(() => game.endRound(fresh(), 0), 'wrong_phase');
});
ok('add-time while playing extends by 60s; while paused extends pausedRemaining; total tracks it', () => {
  const g = fresh();
  game.join(g, T('א'), 0);
  game.start(g, 300, 0);
  game.addTime(g, 5000);
  assert.strictEqual(g.roundEndsAt, CD + 300000 + MIN);
  assert.strictEqual(g.roundTotalMs, 300000 + MIN);
  game.pause(g, 20000);
  game.addTime(g, 30000);
  assert.strictEqual(g.pausedRemaining, CD + 300000 + MIN - 20000 + MIN);
  assert.strictEqual(g.roundTotalMs, 300000 + 2 * MIN);
});

console.log('actions');
ok('reject/accept scoring and validation', () => {
  const g = fresh();
  const A = game.join(g, { player1: 'א', player2: 'ב', teamName: '' }, 0);
  assert.strictEqual(A.teamName, 'א וב');
  game.start(g, 300, 0);
  game.reject(g, A, 4000);
  assert.strictEqual(A.score, -1);
  throwsCode(() => game.accept(g, A, '   ', 5000), 'empty_argument');
  throwsCode(() => game.accept(g, A, 'x'.repeat(121), 5000), 'argument_too_long');
  game.accept(g, A, ' שת"פ  מעולה ', 6000);
  assert.strictEqual(A.score, 2); // −1 דילוג + 3 שידוך
  assert.strictEqual(g.matches.length, 1);
  assert.strictEqual(g.matches[0].argument, 'שת"פ מעולה');
  assert.strictEqual(A.currentPair.expiresAt, 66000);
  assert.strictEqual(A.lastEvent.type, 'accept');
  assert.strictEqual(A.lastEvent.delta, 3);
});
ok('lifeline replaces one slot, keeps timer, decrements, blocks at 0', () => {
  const g = fresh();
  const A = game.join(g, T('א'), 0);
  game.start(g, 300, 0);
  const keep = A.currentPair.businessB.id;
  const old = A.currentPair.businessA.id;
  game.lifeline(g, A, 1, 5000);
  assert.strictEqual(A.currentPair.businessB.id, keep);
  assert.notStrictEqual(A.currentPair.businessA.id, old);
  assert.strictEqual(A.currentPair.expiresAt, CD + 60000);
  assert.strictEqual(A.lifelines, 2);
  game.lifeline(g, A, 2, 5000);
  game.lifeline(g, A, '1', 5000);
  assert.strictEqual(A.lifelines, 0);
  throwsCode(() => game.lifeline(g, A, 1, 5000), 'no_lifelines');
  throwsCode(() => game.lifeline(g, game.join(g, T('y'), 5000), 3, 5000), 'bad_slot');
  assert.strictEqual(A.score, 0);
});
ok('a tiny pool degrades to repeats instead of throwing', () => {
  const three = [{ name: '1' }, { name: '2' }, { name: '3' }];
  const g = fresh(three);
  const A = game.join(g, T('א'), 0);
  game.start(g, 300, 0);
  for (let i = 0; i < 10; i++) game.reject(g, A, 4000 + i);
  assert.strictEqual(A.seenBusinesses.length, 3); // the whole pool, then repeats
  const two = fresh([{ name: '1' }, { name: '2' }]);
  const B = game.join(two, T('ב'), 0);
  game.start(two, 300, 0);
  for (let i = 0; i < 5; i++) game.reject(two, B, 4000 + i);
  throwsCode(() => game.lifeline(two, B, 1, 5000), 'no_candidates');
});
ok('late join during countdown/play gets a pair; during pause a frozen pair; after finish rejected', () => {
  const g = fresh();
  game.join(g, T('א'), 0);
  game.start(g, 300, 0);
  const C = game.join(g, T('ג'), 1000); // mid-countdown → timer starts when countdown ends
  assert.strictEqual(C.currentPair.expiresAt, CD + 60000);
  const L = game.join(g, T('ד'), 50000);
  assert.strictEqual(L.currentPair.expiresAt, 110000);
  game.pause(g, 60000);
  const P = game.join(g, T('ה'), 61000);
  assert.strictEqual(P.currentPair.expiresAt, null);
  assert.strictEqual(P.currentPair.pausedRemaining, 60000);
  game.resume(g, 70000);
  assert.strictEqual(P.currentPair.expiresAt, 130000);
  game.finish(g, 80000);
  throwsCode(() => game.join(g, T('z'), 90000), 'game_finished');
});

console.log('judging');
ok('zero matches → straight to finished', () => {
  const g = fresh();
  game.join(g, T('א'), 0);
  game.start(g, 300, 0);
  game.beginJudging(g, 5000);
  assert.strictEqual(g.phase, 'finished');
});
ok('vote rules, rounding, score application, anonymity, no token leaks', () => {
  const g = fresh();
  const A = game.join(g, T('א'), 0);
  const B = game.join(g, T('ב'), 0);
  const C = game.join(g, T('ג'), 0);
  game.start(g, 300, 0);
  game.accept(g, A, 'm1', 5000);
  game.accept(g, B, 'm2', 5000);
  game.accept(g, B, 'm3', 5000);
  throwsCode(() => game.vote(g, B, 'm1', 5), 'not_voting');
  game.beginJudging(g, 6000);
  assert.strictEqual(g.phase, 'judging');
  assert.strictEqual(g.judging.currentMatchIndex, 0);
  throwsCode(() => game.vote(g, A, 'm1', 5), 'own_match');
  throwsCode(() => game.vote(g, B, 'm2', 5), 'stale_match');
  throwsCode(() => game.vote(g, B, 'm1', 3), 'bad_vote');
  game.vote(g, B, 'm1', 5);
  game.vote(g, C, 'm1', 2);
  throwsCode(() => game.vote(g, C, 'm1', 2), 'already_voted');
  const sv = game.viewFor(g, 'screen', {}, 7000);
  assert.strictEqual(sv.judging.match.teamId, undefined);
  assert.strictEqual(sv.judging.match.average, 3.5);
  assert.strictEqual(sv.judging.eligibleVoters, 2);
  assert.strictEqual(sv.judging.match.tally['5'], 1);
  const hv = game.viewFor(g, 'host', {}, 7000);
  assert.strictEqual(hv.judging.match.teamId, A.id);
  for (const view of [sv, hv, game.viewFor(g, 'player', { token: B.token }, 7000)]) {
    const json = JSON.stringify(view);
    assert.ok(!json.includes(A.token) && !json.includes(B.token) && !json.includes(C.token), 'token leaked');
  }
  const pvB = game.viewFor(g, 'player', { token: B.token }, 7000);
  assert.strictEqual(pvB.judging.myVote, 5);
  assert.strictEqual(pvB.judging.isMine, false);
  game.nextMatch(g, 8000);
  assert.strictEqual(A.score, 3 + 4); // mean 3.5 → 4
  assert.strictEqual(g.matches[0].judgeScore, 4);
  assert.strictEqual(g.judging.lastScored.teamId, A.id);
  assert.deepStrictEqual(A.lastEvent, { type: 'judged', delta: 4, at: 8000, matchId: 'm1' });
  assert.strictEqual(g.judging.currentMatchIndex, 1);
  game.vote(g, A, 'm2', -2);
  game.vote(g, C, 'm2', -2);
  game.nextMatch(g, 9000); // mean -2
  assert.strictEqual(B.score, 6 - 2); // two accepted matches, then −2
  game.nextMatch(g, 10000); // no votes → 0
  assert.strictEqual(g.matches[2].judgeScore, 0);
  assert.strictEqual(B.score, 4);
  assert.strictEqual(g.judging.currentMatchIndex, null);
  assert.strictEqual(g.judging.votingOpen, false);
  throwsCode(() => game.nextMatch(g, 11000), 'judging_done');
  assert.strictEqual(game.viewFor(g, 'screen', {}, 11000).judging.done, true);
  game.finish(g, 12000);
  assert.strictEqual(g.phase, 'finished');
  assert.deepStrictEqual(game.exportRows(g).map((r) => r.judgeScore), [4, 0, -2]);
  assert.deepStrictEqual(game.viewFor(g, 'screen', {}, 13000).podium.map((p) => p.id), [A.id, B.id, C.id]);
});
ok('finish mid-judging scores the open match; reset keeps pool and round length', () => {
  const g = fresh();
  const A = game.join(g, T('א'), 0);
  const B = game.join(g, T('ב'), 0);
  game.start(g, 300, 0);
  game.accept(g, A, 'm1', 5000);
  game.beginJudging(g, 6000);
  game.vote(g, B, 'm1', 5);
  game.finish(g, 7000);
  assert.strictEqual(A.score, 8); // 3 שידוך + 5 שיפוט
  const g2 = game.reset(g);
  assert.strictEqual(g2.phase, 'lobby');
  assert.strictEqual(g2.pool.businesses.length, VALID_IN_FIXTURE);
  assert.strictEqual(g2.pool.source, 'upload');
  assert.strictEqual(g2.roundSeconds, 300);
  assert.strictEqual(Object.keys(g2.teams).length, 0);
  throwsCode(() => game.setBusinesses(g, [{ name: 'a' }, { name: 'b' }]), 'wrong_phase');
});
ok('mean of −2, −2, +5 rounds to 0 (and never −0)', () => {
  const g = fresh();
  const A = game.join(g, T('א'), 0);
  const B = game.join(g, T('ב'), 0);
  const C = game.join(g, T('ג'), 0);
  const D = game.join(g, T('ד'), 0);
  game.start(g, 300, 0);
  game.accept(g, A, 'm1', 5000);
  game.beginJudging(g, 6000);
  game.vote(g, B, 'm1', -2);
  game.vote(g, C, 'm1', -2);
  game.vote(g, D, 'm1', 5);
  game.nextMatch(g, 7000);
  assert.ok(Object.is(g.matches[0].judgeScore, 0));
});
ok('views expose the fields the projection needs', () => {
  const g = fresh();
  const A = game.join(g, T('א'), 0);
  game.start(g, 300, 0);
  game.reject(g, A, 5000);
  const sv = game.viewFor(g, 'screen', { links: { playerUrl: 'u', exportUrl: 'e' } }, 6000);
  assert.strictEqual(sv.countdownEndsAt, CD);
  assert.strictEqual(sv.roundTotalMs, 300000);
  assert.strictEqual(sv.round, 1);
  assert.strictEqual(sv.lobbyOpen, true);
  assert.strictEqual(sv.pool.count, VALID_IN_FIXTURE);
  assert.deepStrictEqual(sv.leaderboard[0].lastEvent, { type: 'reject', delta: -1, at: 5000 });
  const pv = game.viewFor(g, 'player', { token: A.token, links: { playerUrl: 'u', exportUrl: 'e', playerQr: 'x' } }, 6000);
  assert.deepStrictEqual(pv.links, { exportUrl: 'e' });
  assert.strictEqual(pv.countdownEndsAt, CD);
});

console.log('business uniqueness');
const bigPool = Array.from({ length: 40 }, (_, i) => ({ name: 'v' + (i + 1), description: 'd' + (i + 1) }));

ok('a team never sees the same business twice while the pool holds out', () => {
  const g = fresh(bigPool);
  const A = game.join(g, T('א'), 0);
  game.start(g, 600, 0);
  const seen = [];
  for (let i = 0; i < 15; i++) {
    seen.push(A.currentPair.businessA.id, A.currentPair.businessB.id);
    game.reject(g, A, CD + i);
  }
  seen.push(A.currentPair.businessA.id, A.currentPair.businessB.id);
  assert.strictEqual(new Set(seen).size, seen.length, 'a business was shown twice: ' + seen.join(','));
  assert.strictEqual(A.currentPair.businessA.id === A.currentPair.businessB.id, false);
});

ok('lifeline swaps in a business the team has never seen', () => {
  const g = fresh(bigPool);
  const A = game.join(g, T('א'), 0);
  game.start(g, 600, 0);
  const before = A.seenBusinesses.slice();
  game.lifeline(g, A, 1, CD);
  assert.ok(!before.includes(A.currentPair.businessA.id), 'lifeline reused a seen business');
  assert.strictEqual(A.seenBusinesses.length, before.length + 1);
});

ok('an accepted match locks both businesses out of every other team', () => {
  const g = fresh(bigPool);
  const A = game.join(g, T('א'), 0);
  const B = game.join(g, T('ב'), 0);
  const C = game.join(g, T('ג'), 0);
  game.start(g, 600, 0);
  const locked = new Set();
  for (let i = 0; i < 6; i++) {
    locked.add(A.currentPair.businessA.id);
    locked.add(A.currentPair.businessB.id);
    game.accept(g, A, 'שידוך ' + i, CD + i);
  }
  assert.deepStrictEqual(new Set(g.matchedBusinesses), locked);
  for (const t of [B, C]) {
    for (const id of [t.currentPair.businessA.id, t.currentPair.businessB.id]) {
      assert.ok(!locked.has(id), 'a matched business surfaced for another team');
    }
  }
  // …and it stays locked for every future draw too
  for (let i = 0; i < 8; i++) {
    game.reject(g, B, CD + 100 + i);
    for (const id of [B.currentPair.businessA.id, B.currentPair.businessB.id]) {
      assert.ok(!locked.has(id), 'a matched business was drawn later');
    }
  }
});

ok('two teams never hold the same business at the same time', () => {
  const g = fresh(bigPool);
  const teams = ['א', 'ב', 'ג', 'ד'].map((n) => game.join(g, T(n), 0));
  game.start(g, 600, 0);
  for (let i = 0; i < 4; i++) {
    const held = [];
    for (const t of teams) held.push(t.currentPair.businessA.id, t.currentPair.businessB.id);
    assert.strictEqual(new Set(held).size, held.length, 'two teams share a business');
    for (const t of teams) game.reject(g, t, CD + i);
  }
});

ok('reset clears the locked businesses', () => {
  const g = fresh(bigPool);
  const A = game.join(g, T('א'), 0);
  game.start(g, 600, 0);
  game.accept(g, A, 'שידוך', CD);
  assert.strictEqual(g.matchedBusinesses.length, 2);
  assert.deepStrictEqual(game.reset(g).matchedBusinesses, []);
});

console.log('judging order');
ok('matches are judged one per team, round-robin, skipping teams that ran out', () => {
  const g = fresh(bigPool);
  const A = game.join(g, T('א'), 0);
  const B = game.join(g, T('ב'), 0);
  const C = game.join(g, T('ג'), 0);
  game.start(g, 600, 0);
  // A: 3 matches, B: 1, C: 2 — submitted in bursts, worst case for the ordering
  for (let i = 0; i < 3; i++) game.accept(g, A, 'a' + i, CD + i);
  game.accept(g, B, 'b0', CD + 10);
  for (let i = 0; i < 2; i++) game.accept(g, C, 'c' + i, CD + 20 + i);
  game.beginJudging(g, CD + 30);
  const order = [];
  for (let i = 0; i < 6; i++) {
    order.push(game.currentMatch(g).teamId);
    game.nextMatch(g, CD + 40 + i);
  }
  assert.deepStrictEqual(order, [A.id, B.id, C.id, A.id, C.id, A.id]);
  assert.strictEqual(g.judging.currentMatchIndex, null);
  assert.strictEqual(new Set(g.judging.order).size, 6);
  assert.ok(g.matches.every((m) => m.judged), 'every match should have been judged');
});

ok('judging totals and index follow the round-robin order', () => {
  const g = fresh(bigPool);
  const A = game.join(g, T('א'), 0);
  const B = game.join(g, T('ב'), 0);
  game.start(g, 600, 0);
  game.accept(g, A, 'a0', CD);
  game.accept(g, A, 'a1', CD + 1);
  game.accept(g, B, 'b0', CD + 2);
  game.beginJudging(g, CD + 5);
  const sv = game.viewFor(g, 'screen', {}, CD + 6);
  assert.strictEqual(sv.judging.total, 3);
  assert.strictEqual(sv.judging.index, 0);
  assert.strictEqual(game.currentMatch(g).teamId, A.id);
  game.nextMatch(g, CD + 7);
  assert.strictEqual(game.currentMatch(g).teamId, B.id); // B's only match comes second
  game.nextMatch(g, CD + 8);
  assert.strictEqual(game.currentMatch(g).teamId, A.id);
});

console.log(`\n${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
