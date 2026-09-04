/* End-to-end browser test: boots server.js on a test port, drives headless Edge/Chrome
   over the DevTools protocol through the player / projection (screen + host) flow defined
   in design/LIFT-SPEC.md, saves screenshots to test/shots/, and fails on any console error
   or unexpected UI state.
   Run: node test/browser.js   (Windows with Edge or Chrome installed; Node ≥ 22) */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.E2E_PORT) || 3102;
const BASE = `http://localhost:${PORT}`;
const SHOTS = path.join(__dirname, 'shots');
const BROWSERS = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const BROWSER = BROWSERS.find((p) => fs.existsSync(p));
const PROFILE = path.join(__dirname, 'edge-profile-' + process.pid);
const CDP_PORT = 9400 + (process.pid % 200);
const WAIT = 8000; // generous default timeout for waitFor polling
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const failures = [];
let checks = 0;

async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
  }
  send(method, params, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    });
  }
  on(fn) {
    this.listeners.push(fn);
  }
}

class Page {
  constructor(cdp, sessionId, name) {
    this.cdp = cdp;
    this.sid = sessionId;
    this.name = name;
  }
  send(m, p) {
    return this.cdp.send(m, p, this.sid);
  }
  async init(w, h, mobile) {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });
  }
  async goto(url) {
    const loaded = new Promise((res) => {
      const l = (msg) => {
        if (msg.sessionId === this.sid && msg.method === 'Page.loadEventFired') {
          this.cdp.listeners = this.cdp.listeners.filter((x) => x !== l);
          res();
        }
      };
      this.cdp.on(l);
    });
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(500);
  }
  // Runs an expression inside the page (DevTools Runtime.evaluate) — test-only.
  async run(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`[${this.name}] evaluate failed: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description)}`);
    return r.result.value;
  }
  async waitFor(expr, timeout = WAIT) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.run(expr)) return true;
      } catch (e) {
        /* element may not exist yet — keep polling */
      }
      await sleep(150);
    }
    return false;
  }
  async shot(file) {
    await Promise.race([this.send('Page.bringToFront'), sleep(2000)]).catch(() => {});
    await sleep(400);
    const r = await Promise.race([this.send('Page.captureScreenshot', { format: 'png' }), sleep(8000).then(() => null)]);
    if (r) fs.writeFileSync(path.join(SHOTS, `${file}.png`), Buffer.from(r.data, 'base64'));
  }
  async click(sel) {
    const ok = await this.run(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el || el.disabled) return false; el.click(); return true; })()`);
    if (!ok) failures.push(`[${this.name}] could not click ${sel}`);
    await sleep(500);
  }
  text(sel) {
    return this.run(`((document.querySelector(${JSON.stringify(sel)}) || {}).textContent || '').trim()`);
  }
}

// Expression helpers (strings evaluated inside the page).
const screenIs = (name) => `document.body.dataset.screen === ${JSON.stringify(name)}`;
// An element counts as visible when it exists, is not [hidden] and its computed display/visibility show it.
const visible = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el || el.hidden) return false; const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden'; })()`;
const notVisible = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el || el.hidden) return true; const cs = getComputedStyle(el); return cs.display === 'none' || cs.visibility === 'hidden'; })()`;
const textOf = (sel) => `((document.querySelector(${JSON.stringify(sel)}) || {}).textContent || '').trim()`;
// Number of lifeline spans rendered with the spent style (opacity .22 / grayscale).
const spentCount = `(() => [...document.querySelectorAll('[data-bind="lifelines"] > span')].filter(s => { const cs = getComputedStyle(s); return Number(cs.opacity) < 0.5 || /grayscale/.test(cs.filter); }).length)()`;
const clockToSec = (s) => {
  const m = /^(\d+):(\d\d)$/.exec(String(s || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

function check(name, cond) {
  checks++;
  if (!cond) failures.push(name);
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
}

let server = null;
let browser = null;
function cleanup() {
  try {
    if (browser) browser.kill();
  } catch (e) {
    /* ignore */
  }
  try {
    if (server) server.kill();
  } catch (e) {
    /* ignore */
  }
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (e) {
    /* profile dir is gitignored; a locked file is harmless */
  }
}

(async () => {
  if (!BROWSER) throw new Error('No Edge/Chrome found; set BROWSER_PATH');
  fs.mkdirSync(SHOTS, { recursive: true });
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), PUBLIC_URL: '' }, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      up = (await fetch(BASE + '/api/state?role=screen')).ok;
    } catch (e) {
      await sleep(250);
    }
  }
  if (!up) throw new Error('server did not start');

  browser = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 40 && !version; i++) {
    try {
      version = await (await fetch(`http://localhost:${CDP_PORT}/json/version`)).json();
    } catch (e) {
      await sleep(250);
    }
  }
  if (!version) throw new Error('browser did not expose DevTools');
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') errors.push(`${msg.params.exceptionDetails.text} ${JSON.stringify(msg.params.exceptionDetails.exception && msg.params.exceptionDetails.exception.description)}`);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(`console.error ${msg.params.args.map((a) => a.value || a.description).join(' ')}`);
  });
  async function newPage(name, w, h, mobile) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const p = new Page(cdp, sessionId, name);
    await p.init(w, h, mobile);
    return p;
  }

  const TEAM_A = 'הצפוניים';
  const TEAM_B = 'הדרומיים';
  const player = await newPage('player', 390, 844, true);
  // The projection page is served at both /screen and /host; the host controls live inside the stage.
  const screen = await newPage('screen', 1920, 1080, false);

  // ---------------------------------------------------------------------------
  console.log('splash → onboarding');
  await player.goto(BASE + '/');
  await screen.goto(BASE + '/screen');
  check('player splash overlay visible on load', await player.waitFor(visible('[data-overlay="splash"]'), 3000));
  await player.shot('00-player-splash');
  check('player shows onboarding after splash', await player.waitFor(screenIs('onboarding')));
  check('splash gone after ~2.1 s', await player.waitFor(notVisible('[data-overlay="splash"]')));
  check('argument modal hidden on onboarding', await player.run(notVisible('[data-modal="argument"]')));
  check('register button disabled while #teamName is empty', await player.run(`document.querySelector('#teamName').value === '' && document.querySelector('#btn-register').disabled === true`));
  await player.run(`const i = document.querySelector('#teamName'); i.value = ${JSON.stringify(TEAM_A)}; i.dispatchEvent(new Event('input', { bubbles: true })); true`);
  check('register button enabled once text is typed', await player.waitFor(`document.querySelector('#btn-register').disabled === false`));
  await player.shot('01-player-onboarding');

  // ---------------------------------------------------------------------------
  console.log('projection setup');
  check('projection shows setup', await screen.waitFor(screenIs('setup')));
  const minutes0 = Number(await screen.text('[data-bind="minutes"]'));
  check('setup shows a minutes value (1–30)', Number.isFinite(minutes0) && minutes0 >= 1 && minutes0 <= 30);
  await screen.click('#btn-plus');
  check('#btn-plus increments minutes', await screen.waitFor(`Number(${textOf('[data-bind="minutes"]')}) === ${Math.min(30, minutes0 + 1)}`));
  await screen.click('#btn-minus');
  check('#btn-minus decrements minutes', await screen.waitFor(`Number(${textOf('[data-bind="minutes"]')}) === ${minutes0}`));
  check('setup has no "מסך למנחה בלבד" note', await screen.run(`!document.querySelector('[data-screen="setup"]:not(body)').textContent.includes('למנחה בלבד')`));
  check('template download link points at the template endpoint', await screen.run(`(document.querySelector('#btn-template') || {}).getAttribute && document.querySelector('#btn-template').getAttribute('href') === '/api/host/businesses-template.json'`));
  const tplRes = await fetch(BASE + '/api/host/businesses-template.json');
  const tpl = await tplRes.json().catch(() => null);
  check('template endpoint serves a downloadable JSON array of {name, description}',
    tplRes.ok && /attachment/.test(tplRes.headers.get('content-disposition') || '') &&
    Array.isArray(tpl) && tpl.length >= 2 && tpl.every((b) => typeof b.name === 'string' && typeof b.description === 'string'));
  const tplUp = await post('/api/host/businesses', { fileName: 'template.json', businesses: tpl });
  check('the template itself uploads cleanly', tplUp && tplUp.count === tpl.length);
  await screen.shot('01-screen-setup');
  await screen.click('#btn-open-lobby');

  // ---------------------------------------------------------------------------
  console.log('lobby');
  check('projection shows lobby with QR', await screen.waitFor(`${screenIs('lobby')} && String((document.querySelector('[data-bind="player-qr"]') || {}).src || '').startsWith('data:image/png')`));
  check('no team chips yet', await screen.run(`document.querySelectorAll('[data-bind="lobby-teams"] [data-team]').length === 0`));
  await screen.shot('02-screen-lobby-empty');

  console.log('join');
  await player.run(`document.querySelector('#join-form').requestSubmit(); true`);
  check('player on waiting screen after join', await player.waitFor(screenIs('waiting')));
  check('team name rendered', await player.waitFor(`${textOf('[data-bind="team-name"]')} === ${JSON.stringify(TEAM_A)}`));
  check('token stored', await player.run(`!!localStorage.getItem('mm.token') && !!localStorage.getItem('mm.teamId')`));
  check('projection shows one team chip', await screen.waitFor(`document.querySelectorAll('[data-bind="lobby-teams"] [data-team]').length === 1`));
  check('chip carries the team name', await screen.run(`document.querySelector('[data-bind="lobby-teams"] [data-team]').textContent.includes(${JSON.stringify(TEAM_A)})`));
  check('team-count shows 1', await screen.waitFor(`/(^|\\D)1(\\D|$)/.test(${textOf('[data-bind="team-count"]')})`));
  check('#btn-start disabled with 1 team', await screen.run(`document.querySelector('#btn-start').disabled === true`));
  await player.shot('02-player-waiting');
  await screen.shot('02-screen-lobby-one-team');

  const B = await post('/api/join', { teamName: TEAM_B });
  check('second team joined via API', !!(B && B.token));
  check('projection shows two team chips', await screen.waitFor(`document.querySelectorAll('[data-bind="lobby-teams"] [data-team]').length === 2`));
  check('#btn-start enabled with 2 teams', await screen.waitFor(`document.querySelector('#btn-start').disabled === false`));
  await screen.shot('02-screen-lobby-two-teams');

  // ---------------------------------------------------------------------------
  console.log('start → countdown');
  await screen.click('#btn-start');
  const startedAt = Date.now();
  check('player countdown overlay visible', await player.waitFor(visible('[data-overlay="countdown"]'), 3000));
  check('projection countdown overlay visible', await screen.waitFor(visible('[data-overlay="countdown"]'), 3000));
  // Sample the countdown label on both pages while it runs; it must cycle through more than one value.
  const seenPlayer = new Set();
  const seenScreen = new Set();
  const tSample = Date.now();
  while (Date.now() - tSample < 3600) {
    seenPlayer.add(await player.text('[data-bind="countdown-label"]'));
    seenScreen.add(await screen.text('[data-bind="countdown-label"]'));
    await sleep(200);
  }
  seenPlayer.delete('');
  seenScreen.delete('');
  check(`player countdown label cycles (${[...seenPlayer].join(' ')})`, seenPlayer.size >= 2);
  check(`projection countdown label cycles (${[...seenScreen].join(' ')})`, seenScreen.size >= 2);
  await player.shot('03-player-countdown');
  await screen.shot('03-screen-countdown');

  // ---------------------------------------------------------------------------
  console.log('board');
  check('countdown gone, player on board', await player.waitFor(`${screenIs('board')} && ${notVisible('[data-overlay="countdown"]')}`));
  check('business names rendered in both slots', await player.waitFor(`[...document.querySelectorAll('[data-slot] [data-bind="name"]')].length === 2 && [...document.querySelectorAll('[data-slot] [data-bind="name"]')].every(e => e.textContent.trim().length > 0)`));
  check('pair timer label matches 0:5x', await player.waitFor(`/^0:5\\d$/.test(${textOf('[data-bind="timer-label"]')})`));
  check('lifelines render three spans', await player.run(`document.querySelectorAll('[data-bind="lifelines"] > span').length === 3`));
  check('projection live board with 2 rows', await screen.waitFor(`${screenIs('live')} && ${notVisible('[data-overlay="countdown"]')} && document.querySelectorAll('[data-board] [data-team]').length === 2`));
  check('projection round clock running', await screen.waitFor(`/^\\d+:\\d\\d$/.test(${textOf('[data-bind="round-clock"]')})`));
  await player.shot('04-player-board');
  await screen.shot('04-screen-live');

  // ---------------------------------------------------------------------------
  console.log('lifeline');
  const beforeA = await player.text('[data-slot="1"] [data-bind="name"]');
  const beforeB = await player.text('[data-slot="2"] [data-bind="name"]');
  await player.click('[data-lifeline="1"]');
  check('one lifeline span gets the spent style', await player.waitFor(`${spentCount} === 1`));
  check('slot 1 name changed', await player.waitFor(`${textOf('[data-slot="1"] [data-bind="name"]')} !== ${JSON.stringify(beforeA)} && ${textOf('[data-slot="1"] [data-bind="name"]')}.length > 0`));
  check('slot 2 name unchanged', (await player.text('[data-slot="2"] [data-bind="name"]')) === beforeB);
  await player.shot('05-player-lifeline');

  // ---------------------------------------------------------------------------
  console.log('argument sheet open / freeze / close');
  await player.click('#btn-yes');
  check('argument modal open (not hidden)', await player.waitFor(`!document.querySelector('[data-modal="argument"]').hidden && ${visible('[data-modal="argument"]')}`));
  const frozen1 = await player.text('[data-bind="timer-label"]');
  await sleep(1100);
  const frozen2 = await player.text('[data-bind="timer-label"]');
  check(`pair timer frozen while sheet open (${frozen1} / ${frozen2})`, frozen1 !== '' && frozen1 === frozen2);
  await player.shot('06-player-argument-open');
  await player.click('[data-action="close-modal"]');
  check('argument modal closed via close-modal', await player.waitFor(notVisible('[data-modal="argument"]')));
  const resumed1 = clockToSec(await player.text('[data-bind="timer-label"]'));
  await sleep(1300);
  const resumed2 = clockToSec(await player.text('[data-bind="timer-label"]'));
  check(`pair timer resumes after close (${resumed1}s → ${resumed2}s)`, Number.isFinite(resumed1) && Number.isFinite(resumed2) && resumed2 < resumed1);

  // ---------------------------------------------------------------------------
  console.log('accept + reject');
  await player.click('#btn-yes');
  check('argument modal open again', await player.waitFor(visible('[data-modal="argument"]')));
  const ARG = 'שניהם עובדים עם משפחות צעירות בגליל'; // 35 characters
  check('argument fixture is 35 chars', ARG.length === 35);
  await player.run(`const t = document.querySelector('#argument'); t.value = ${JSON.stringify(ARG)}; t.dispatchEvent(new Event('input', { bubbles: true })); true`);
  check('counter shows 35/120', await player.waitFor(`${textOf('#argument-counter')} === '35/120'`));
  check('submit enabled with ≥3 chars', await player.run(`document.querySelector('#btn-submit-argument').disabled === false`));
  check('no pair timeout so far (test ran fast enough)', Date.now() - startedAt < 55000);
  await player.run(`document.querySelector('#argument-form').requestSubmit(); true`);
  check('score is 2 after accept', await player.waitFor(`${textOf('[data-bind="score"]')} === '2'`));
  check('score float shows +2', await player.waitFor(`${textOf('[data-bind="score-float"]')} === '+2' && ${visible('[data-bind="score-float"]')}`, 3000));
  check('argument modal closed after submit', await player.waitFor(notVisible('[data-modal="argument"]')));
  await player.shot('07-player-after-accept');
  await player.click('#btn-no');
  check('score is 0 after reject', await player.waitFor(`${textOf('[data-bind="score"]')} === '0'`));
  check('score float shows −2', await player.waitFor(`['−2', '-2'].includes(${textOf('[data-bind="score-float"]')}) && ${visible('[data-bind="score-float"]')}`, 3000));
  check('projection row for the team shows delta and score', await screen.waitFor(`(() => { const row = [...document.querySelectorAll('[data-board] [data-team]')].find(r => ((r.querySelector('.row-name') || {}).textContent || '').includes(${JSON.stringify(TEAM_A)})); if (!row) return false; const d = ((row.querySelector('.row-delta') || {}).textContent || '').trim(); const s = ((row.querySelector('.row-score') || {}).textContent || '').trim(); return /[+\\-−]\\d/.test(d) && s === '0'; })()`, 4000));
  await player.shot('08-player-after-reject');
  await screen.shot('08-screen-live-delta');

  // ---------------------------------------------------------------------------
  console.log('pause / resume / add time');
  await screen.click('#btn-pause');
  check('player paused overlay visible', await player.waitFor(visible('[data-overlay="paused"]')));
  check('projection paused overlay visible', await screen.waitFor(visible('[data-overlay="paused"]')));
  await player.shot('09-player-paused');
  await screen.shot('09-screen-paused');
  await screen.click('#btn-resume');
  check('player paused overlay gone after resume', await player.waitFor(notVisible('[data-overlay="paused"]')));
  check('projection paused overlay gone after resume', await screen.waitFor(notVisible('[data-overlay="paused"]')));
  const clockBefore = clockToSec(await screen.text('[data-bind="round-clock"]'));
  await screen.click('#btn-add-time');
  const clockAfter = clockToSec(await screen.text('[data-bind="round-clock"]'));
  check(`round clock increases by ~60 s after add-time (${clockBefore}s → ${clockAfter}s)`, Number.isFinite(clockBefore) && Number.isFinite(clockAfter) && clockAfter - clockBefore >= 55 && clockAfter - clockBefore <= 62);

  // ---------------------------------------------------------------------------
  console.log('reconnect');
  await player.goto(BASE + '/');
  check('reload → straight back to board with same score (no onboarding)', await player.waitFor(`${screenIs('board')} && ${textOf('[data-bind="score"]')} === '0'`));
  check('lifelines preserved after reload (one spent)', await player.waitFor(`document.querySelectorAll('[data-bind="lifelines"] > span').length === 3 && ${spentCount} === 1`));
  check('team name preserved after reload', await player.run(`${textOf('[data-bind="team-name"]')} === ${JSON.stringify(TEAM_A)}`));
  await player.shot('10-player-reloaded');

  // ---------------------------------------------------------------------------
  console.log('end round');
  const ARG_B = 'שידוך של הדרומיים';
  const acceptB = await post('/api/action/accept', { token: B.token, argument: ARG_B });
  check('second team submitted a match via API', !(acceptB && acceptB.error));
  await screen.click('#btn-end-round');
  check('in-app confirm dialog opens for end-round', await screen.waitFor(visible('[data-overlay="confirm"]')));
  await screen.shot('10b-screen-confirm');
  await screen.click('#btn-confirm-no');
  check('cancel closes the dialog and the round keeps running',
    (await screen.waitFor(notVisible('[data-overlay="confirm"]'))) && (await player.run(screenIs('board'))));
  await screen.click('#btn-end-round');
  await screen.waitFor(visible('[data-overlay="confirm"]'));
  await screen.click('#btn-confirm-yes');
  check('player shows ended screen', await player.waitFor(screenIs('ended')));
  check('projection ended overlay visible', await screen.waitFor(visible('[data-overlay="ended"]')));
  await player.shot('11-player-ended');
  await screen.shot('11-screen-ended');

  // ---------------------------------------------------------------------------
  console.log('judging');
  await screen.click('#btn-judging');
  check('player sees own-match screen for match 1 (team A)', await player.waitFor(screenIs('own')));
  check('projection judging with index 1/2', await screen.waitFor(`${screenIs('judging')} && ${textOf('[data-bind="judge-index"]')}.replace(/\\s/g, '') === '1/2'`));
  check('projection shows the argument text', await screen.waitFor(`${textOf('[data-bind="judge-arg"]')}.includes(${JSON.stringify(ARG)})`));
  check('projection judging text does NOT contain team A name', await screen.run(`!document.querySelector('[data-screen="judging"]:not(body)').textContent.includes(${JSON.stringify(TEAM_A)})`));
  check('player own screen shows the businesses', await player.run(`${textOf('[data-bind="own-a"]')}.length > 0 && ${textOf('[data-bind="own-b"]')}.length > 0`));
  await player.shot('12-player-own');
  await screen.shot('12-screen-judging');

  const vote = await post('/api/vote', { token: B.token, matchId: 'm1', value: 5 });
  check('team B voted 5 via API', !(vote && vote.error));
  check('votes-total shows 1', await screen.waitFor(`/(^|\\D)1(\\D|$)/.test(${textOf('[data-bind="votes-total"]')})`));
  check('weighted shows +5.0', await screen.waitFor(`${textOf('[data-bind="weighted"]')} === '+5.0'`));
  check('pct-5 shows 100%', await screen.waitFor(`${textOf('[data-bind="pct-5"]')} === '100%'`));
  check('#btn-next label is "לשידוך הבא" on a non-final match', await screen.run(`${textOf('#btn-next')}.includes('לשידוך הבא')`));
  check('early-finish button visible while matches remain', await screen.run(`${visible('#btn-finish-judging')} && ${textOf('#btn-finish-judging')}.includes('סיום השיפוט')`));
  await screen.shot('13-screen-judging-voted');

  await screen.click('#btn-next');
  check('player score is 5 after scoring', await player.waitFor(`${textOf('[data-bind="score"]')} === '5'`));
  check('player sees vote screen for match 2', await player.waitFor(screenIs('vote')));
  check('projection judging index 2/2', await screen.waitFor(`${textOf('[data-bind="judge-index"]')}.replace(/\\s/g, '') === '2/2'`));
  check('vote screen shows argument of match 2', await player.waitFor(`${textOf('[data-bind="other-arg"]')}.includes(${JSON.stringify(ARG_B)})`));
  await player.shot('14-player-vote');

  await player.click('[data-vote="2"]');
  check('vote status pill visible', await player.waitFor(visible('[data-bind="vote-status"]')));
  check('all vote buttons disabled', await player.waitFor(`[...document.querySelectorAll('[data-vote]')].length === 3 && [...document.querySelectorAll('[data-vote]')].every(b => b.disabled)`));
  check('chosen vote keeps opacity 1', await player.waitFor(`Math.abs(Number(getComputedStyle(document.querySelector('[data-vote="2"]')).opacity) - 1) < 0.01`));
  check('other votes dimmed to ≈ .22', await player.waitFor(`[...document.querySelectorAll('[data-vote]')].filter(b => b.dataset.vote !== '2').every(b => Math.abs(Number(getComputedStyle(b).opacity) - 0.22) < 0.03)`));
  await player.shot('15-player-voted');
  check('#btn-next label contains "לפודיום" on the last match', await screen.waitFor(`${textOf('#btn-next')}.includes('לפודיום')`));
  check('early-finish button hidden on the last match', await screen.waitFor(notVisible('#btn-finish-judging')));
  await screen.shot('15-screen-judging-last');

  // ---------------------------------------------------------------------------
  console.log('podium');
  await screen.click('#btn-next');
  check('player summary screen', await player.waitFor(screenIs('summary')));
  check('player final score 5', await player.waitFor(`${textOf('[data-bind="final-score"]')} === '5'`));
  check('projection podium', await screen.waitFor(screenIs('podium')));
  check('podium p1 is team A', await screen.waitFor(`${textOf('[data-bind="p1-name"]')} === ${JSON.stringify(TEAM_A)}`));
  check('podium p1 score 5', await screen.waitFor(`${textOf('[data-bind="p1-score"]')} === '5'`));
  await sleep(1500); // let the staggered fadeIn finish before the screenshot
  await player.shot('16-player-summary');
  await screen.shot('16-screen-podium');

  // ---------------------------------------------------------------------------
  console.log('reset');
  check('podium has no "למנחה בלבד" note', await screen.run(`!document.querySelector('[data-screen="podium"]:not(body)').textContent.includes('למנחה בלבד')`));
  await screen.click('#btn-reset');
  check('in-app confirm dialog opens for reset', await screen.waitFor(visible('[data-overlay="confirm"]')));
  await screen.click('#btn-confirm-yes');
  check('player back to onboarding after reset (token cleared)', await player.waitFor(`${screenIs('onboarding')} && !localStorage.getItem('mm.token')`));
  check('projection back to setup', await screen.waitFor(screenIs('setup')));
  await player.shot('17-player-onboarding-after-reset');
  await screen.shot('17-screen-setup-after-reset');

  console.log(`\n${checks - failures.length}/${checks} checks passed; screenshots in test/shots/`);
  if (errors.length) console.log('BROWSER ERRORS:\n  ' + errors.join('\n  '));
  if (failures.length) console.log('FAILED:\n  ' + failures.join('\n  '));
  await cdp.send('Browser.close').catch(() => {});
  await sleep(1500);
  cleanup();
  process.exit(failures.length || errors.length ? 1 : 0);
})().catch((e) => {
  cleanup();
  console.error('E2E DRIVER ERROR', e);
  process.exit(1);
});
