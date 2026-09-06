/* HTTP smoke test: boots server.js on a test port and walks the whole API.
   Run: node test/smoke.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.SMOKE_PORT) || 3101;
const BASE = `http://localhost:${PORT}`;
const pool = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'businesses-hebrew-keys.json'), 'utf8'));
const VALID_IN_FIXTURE = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(p, body) {
  const res = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function get(p) {
  const res = await fetch(BASE + p);
  return { status: res.status, data: await res.json().catch(() => null), res };
}
const state = async (role, token) => (await get(`/api/state?role=${role}${token ? '&token=' + token : ''}`)).data;
function expectErr(r, code, status) {
  assert.strictEqual(r.status, status || 400, `expected ${status || 400}, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.strictEqual(r.data.error, code, `expected ${code}, got ${JSON.stringify(r.data)}`);
  assert.ok(/[\u0590-\u05FF]/.test(r.data.message), 'message should be Hebrew');
}
let n = 0;
const step = (s) => console.log(`  ${++n}. ${s}`);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), PUBLIC_URL: '' },
  stdio: 'ignore',
});
const stop = () => {
  try {
    server.kill();
  } catch (e) {
    /* ignore */
  }
};

(async () => {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      up = (await fetch(BASE + '/api/state?role=host')).ok;
    } catch (e) {
      await sleep(250);
    }
  }
  assert.ok(up, 'server did not start');

  let r;
  step('boot: lobby with default pool');
  let hv = await state('host');
  assert.strictEqual(hv.phase, 'lobby');
  assert.strictEqual(hv.pool.source, 'default');
  assert.ok(hv.pool.count >= 2);

  step('upload spreadsheet-shaped JSON');
  const up1 = await post('/api/host/businesses', { fileName: 'עסקים.json', businesses: pool });
  assert.strictEqual(up1.status, 200, JSON.stringify(up1.data));
  assert.strictEqual(up1.data.count, VALID_IN_FIXTURE);
  hv = await state('host');
  assert.strictEqual(hv.pool.count, VALID_IN_FIXTURE);
  assert.strictEqual(hv.pool.source, 'upload');
  expectErr(await post('/api/host/businesses', { businesses: 'nope' }), 'bad_pool');

  step('static pages + QR links');
  for (const p of ['/', '/screen', '/host']) {
    const r = await fetch(BASE + p);
    assert.strictEqual(r.status, 200);
    assert.ok((await r.text()).includes('dir="rtl"'), p + ' should be RTL');
  }
  const sv0 = await state('screen');
  assert.ok(sv0.links.playerQr.startsWith('data:image/png;base64,'));
  assert.strictEqual(sv0.links.playerUrl, BASE + '/');
  assert.strictEqual(sv0.links.exportUrl, BASE + '/api/host/export.csv');

  step('join two teams; bad token 404; missing names 400');
  expectErr(await post('/api/join', { player1: 'x' }), 'missing_names');
  expectErr(await post('/api/join', { teamName: '   ' }), 'missing_names');
  const solo = (await post('/api/join', { teamName: 'צמד הגולן' })).data;
  assert.ok(solo.token, 'team-name-only join works (design has a single field)');
  const A = (await post('/api/join', { player1: 'דנה', player2: 'יוסי', teamName: 'הצפוניים' })).data;
  const B = (await post('/api/join', { player1: 'רון', player2: 'מאיה' })).data;
  assert.ok(A.token && A.teamId && B.token);
  assert.strictEqual((await get('/api/state?role=player&token=bogus')).status, 404);
  let pa = await state('player', A.token);
  assert.strictEqual(pa.team.teamName, 'הצפוניים');
  assert.strictEqual(pa.team.currentPair, null);
  assert.strictEqual((await state('player', B.token)).team.teamName, 'רון ומאיה');

  step('SSE stream delivers an initial state event and tracks connection');
  const ac = new AbortController();
  const sres = await fetch(BASE + `/api/stream?role=player&token=${A.token}`, { signal: ac.signal });
  assert.strictEqual(sres.headers.get('content-type').split(';')[0], 'text/event-stream');
  const reader = sres.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (!buf.includes('event: state')) buf += dec.decode((await reader.read()).value);
  while (!buf.includes('\n\n', buf.indexOf('event: state'))) buf += dec.decode((await reader.read()).value);
  const evt = JSON.parse(buf.slice(buf.indexOf('data: ') + 6, buf.indexOf('\n\n', buf.indexOf('data: '))));
  assert.strictEqual(evt.team.id, A.teamId);
  await sleep(150);
  assert.strictEqual((await state('host')).teams.find((t) => t.id === A.teamId).connected, true);
  ac.abort();
  await sleep(200);
  assert.strictEqual((await state('host')).teams.find((t) => t.id === A.teamId).connected, false);
  assert.strictEqual((await get('/api/stream?role=player&token=bogus')).status, 404);

  step('setup → open lobby → start; player actions rejected in lobby');
  expectErr(await post('/api/action/reject', { token: A.token }), 'wrong_phase');
  assert.strictEqual((await state('screen')).lobbyOpen, false);
  expectErr(await post('/api/host/open-lobby', { roundSeconds: 5 }), 'bad_round_seconds');
  r = await post('/api/host/open-lobby', { roundSeconds: 600 });
  assert.strictEqual(r.data.lobbyOpen, true);
  assert.strictEqual(r.data.roundSeconds, 600);
  expectErr(await post('/api/host/start', { roundSeconds: 5 }), 'bad_round_seconds');
  assert.strictEqual((await post('/api/host/start', { roundSeconds: 120 })).status, 200);
  pa = await state('player', A.token);
  assert.ok(pa.team.currentPair && pa.team.currentPair.businessA.name);
  assert.ok(Math.abs(pa.team.currentPair.expiresAt - (pa.serverNow + 3700 + 60000)) < 1500, 'pair timer starts after the 3.7s countdown');
  assert.ok(pa.countdownEndsAt > pa.serverNow && pa.countdownEndsAt <= pa.serverNow + 3700);
  expectErr(await post('/api/action/reject', { token: A.token }), 'countdown');
  await sleep(3800);
  expectErr(await post('/api/host/start', { roundSeconds: 120 }), 'wrong_phase');

  step('reject −1; lifelines; accept-open/cancel keeps remaining; accept +4');
  r = await post('/api/action/reject', { token: A.token });
  assert.strictEqual(r.data.team.score, -1); // דילוג
  const keepB = r.data.team.currentPair.businessB.id;
  r = await post('/api/action/lifeline', { token: A.token, slot: 1 });
  assert.strictEqual(r.data.team.lifelines, 2);
  assert.strictEqual(r.data.team.currentPair.businessB.id, keepB);
  await post('/api/action/lifeline', { token: A.token, slot: 2 });
  await post('/api/action/lifeline', { token: A.token, slot: 1 });
  expectErr(await post('/api/action/lifeline', { token: A.token, slot: 1 }), 'no_lifelines');
  r = await post('/api/action/accept-open', { token: A.token });
  const frozen = r.data.team.currentPair.pausedRemaining;
  assert.strictEqual(r.data.team.currentPair.expiresAt, null);
  await sleep(1200);
  r = await post('/api/action/accept-cancel', { token: A.token });
  assert.ok(Math.abs(r.data.team.currentPair.expiresAt - r.data.serverNow - frozen) < 300, 'remaining preserved');
  expectErr(await post('/api/action/accept', { token: A.token, argument: 'x'.repeat(121) }), 'argument_too_long');
  expectErr(await post('/api/action/accept', { token: A.token, argument: '' }), 'empty_argument');
  r = await post('/api/action/accept', { token: A.token, argument: 'שניהם עובדים עם משפחות בגליל' });
  assert.strictEqual(r.data.team.score, 3); // −1 דילוג + 4 שידוך
  assert.strictEqual(r.data.team.myMatches, 1);

  step('pause / resume / add-time');
  r = await post('/api/host/pause');
  assert.strictEqual(r.data.phase, 'paused');
  pa = await state('player', A.token);
  assert.strictEqual(pa.team.currentPair.expiresAt, null);
  const pr = pa.team.currentPair.pausedRemaining;
  expectErr(await post('/api/action/reject', { token: A.token }), 'paused');
  await sleep(700);
  await post('/api/host/resume');
  pa = await state('player', A.token);
  assert.ok(Math.abs(pa.team.currentPair.expiresAt - pa.serverNow - pr) < 300);
  const before = pa.roundEndsAt;
  r = await post('/api/host/add-time');
  assert.strictEqual(r.data.roundEndsAt, before + 60000, 'add-time adds one minute (design: הוסף דקה)');

  step('end-round freezes everyone; add-time rescues; late joiner gets a pair; B submits two matches');
  r = await post('/api/host/end-round');
  assert.strictEqual(r.data.roundOver, true);
  expectErr(await post('/api/action/reject', { token: A.token }), 'round_over');
  r = await post('/api/host/add-time');
  assert.strictEqual(r.data.roundOver, false);
  assert.ok((await state('player', A.token)).team.currentPair.expiresAt > 0);
  const C = (await post('/api/join', { player1: 'עומר', player2: 'נועה' })).data;
  assert.ok((await state('player', C.token)).team.currentPair);
  await post('/api/action/accept', { token: B.token, argument: 'שידוך ב-1' });
  await post('/api/action/accept', { token: B.token, argument: 'שידוך ב-2' });
  assert.strictEqual((await state('screen')).matchCount, 3);
  assert.ok((await state('screen')).leaderboard.find((t) => t.id === A.teamId).lastEvent.delta !== undefined, 'rows carry lastEvent');

  step('judging: anonymity, vote rules, running average, scoring on advance');
  expectErr(await post('/api/vote', { token: B.token, matchId: 'm1', value: 5 }), 'not_voting');
  r = await post('/api/host/judging');
  assert.strictEqual(r.data.phase, 'judging');
  let sv = await state('screen');
  assert.strictEqual(sv.judging.match.teamId, undefined);
  assert.strictEqual(sv.judging.match.argument, 'שניהם עובדים עם משפחות בגליל');
  assert.strictEqual((await state('host')).judging.match.teamId, A.teamId);
  assert.strictEqual((await state('player', A.token)).judging.isMine, true);
  expectErr(await post('/api/vote', { token: A.token, matchId: 'm1', value: 5 }), 'own_match');
  expectErr(await post('/api/vote', { token: B.token, matchId: 'm9', value: 5 }), 'stale_match');
  r = await post('/api/vote', { token: B.token, matchId: 'm1', value: 5 });
  assert.strictEqual(r.data.judging.myVote, 5);
  expectErr(await post('/api/vote', { token: B.token, matchId: 'm1', value: 2 }), 'already_voted');
  await post('/api/vote', { token: C.token, matchId: 'm1', value: 2 });
  sv = await state('screen');
  assert.strictEqual(sv.judging.match.voteCount, 2);
  assert.strictEqual(sv.judging.match.average, 3.5);
  r = await post('/api/host/next-match');
  assert.strictEqual(r.data.leaderboard.find((t) => t.id === A.teamId).score, 7); // 3 + ציון שיפוט 4
  assert.strictEqual(r.data.judging.lastScored.delta, 4);
  await post('/api/vote', { token: A.token, matchId: 'm2', value: -2 });
  await post('/api/vote', { token: C.token, matchId: 'm2', value: -2 });
  await post('/api/host/next-match');
  r = await post('/api/host/next-match'); // m3 with no votes → 0
  assert.strictEqual(r.data.judging.done, true);
  expectErr(await post('/api/host/next-match'), 'judging_done');
  assert.strictEqual((await state('player', A.token)).judging.match, null);

  step('finish → podium; join rejected; CSV export with BOM, quotes, sort order');
  r = await post('/api/host/finish');
  assert.strictEqual(r.data.phase, 'finished');
  assert.strictEqual(r.data.podium[0].id, A.teamId);
  expectErr(await post('/api/join', { player1: 'a', player2: 'b' }), 'game_finished');
  const csvRes = await fetch(BASE + '/api/host/export.csv');
  assert.ok(csvRes.headers.get('content-disposition').startsWith('attachment'));
  const bytes = new Uint8Array(await csvRes.arrayBuffer());
  assert.deepStrictEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
  const lines = new TextDecoder('utf-8').decode(bytes).trim().split(String.fromCharCode(13, 10));
  assert.strictEqual(lines[0], '"שם הקבוצה","משתתפים","עסק א","עסק ב","הנימוק","ציון שיפוט"');
  assert.strictEqual(lines.length, 4);
  assert.ok(lines[1].startsWith('"הצפוניים","דנה, יוסי"') && lines[1].endsWith('"4"'));
  assert.ok(lines[2].endsWith('"0"') && lines[3].endsWith('"-2"'));

  step('reset keeps uploaded pool; judging with zero matches → podium');
  r = await post('/api/host/reset');
  assert.strictEqual(r.data.phase, 'lobby');
  assert.strictEqual(r.data.pool.count, VALID_IN_FIXTURE);
  assert.strictEqual(r.data.teamCount, 0);
  assert.strictEqual((await get('/api/state?role=player&token=' + A.token)).status, 404);
  await post('/api/join', { player1: 'a', player2: 'b' });
  await post('/api/host/start', { roundSeconds: 60 });
  r = await post('/api/host/judging');
  assert.strictEqual(r.data.phase, 'finished');

  step('finish judging early: current match scored, the rest stay unranked');
  await post('/api/host/reset');
  const T1 = (await post('/api/join', { teamName: 'צמד א' })).data;
  const T2 = (await post('/api/join', { teamName: 'צמד ב' })).data;
  await post('/api/host/start', { roundSeconds: 600 });
  await sleep(3900); // 3-2-1 countdown
  await post('/api/action/accept', { token: T1.token, argument: 'שידוך ראשון' });
  await post('/api/action/accept', { token: T1.token, argument: 'שידוך שני' });
  await post('/api/action/accept', { token: T2.token, argument: 'שידוך שלישי' });
  r = await post('/api/host/judging');
  assert.strictEqual(r.data.judging.total, 3);
  assert.strictEqual(r.data.judging.index, 0);
  await post('/api/vote', { token: T2.token, matchId: 'm1', value: 5 });
  r = await post('/api/host/finish'); // early: still on match 1 of 3
  assert.strictEqual(r.data.phase, 'finished');
  assert.strictEqual(r.data.leaderboard.find((t) => t.id === T1.teamId).score, 4 + 4 + 5);
  assert.strictEqual(r.data.leaderboard.find((t) => t.id === T2.teamId).score, 4);
  const csvLate = new TextDecoder('utf-8').decode(new Uint8Array(await (await fetch(BASE + '/api/host/export.csv')).arrayBuffer()));
  const rowsLate = csvLate.trim().split(String.fromCharCode(13, 10)).slice(1);
  assert.strictEqual(rowsLate.length, 3);
  assert.ok(rowsLate[0].endsWith('"5"'), 'the judged match keeps its score');
  assert.ok(rowsLate[1].endsWith('""') && rowsLate[2].endsWith('""'), 'unranked matches export with an empty score');

  step('businesses template downloads and is itself uploadable');
  const tplRes = await fetch(BASE + '/api/host/businesses-template.json');
  assert.strictEqual(tplRes.status, 200);
  assert.ok(/attachment/.test(tplRes.headers.get('content-disposition') || ''));
  const tpl = await tplRes.json();
  assert.ok(Array.isArray(tpl) && tpl.length >= 2);
  assert.ok(tpl.every((b) => typeof b.name === 'string' && b.name && typeof b.description === 'string'));
  await post('/api/host/reset');
  r = await post('/api/host/businesses', { fileName: 'תבנית-עסקים.json', businesses: tpl });
  assert.strictEqual(r.data.count, tpl.length);

  step('malformed JSON body → 400');
  const bad = await fetch(BASE + '/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.strictEqual(bad.status, 400);

  stop();
  console.log('\nSMOKE OK');
})().catch((e) => {
  stop();
  console.error('\nSMOKE FAILED at step', n, '\n', e);
  process.exit(1);
});
