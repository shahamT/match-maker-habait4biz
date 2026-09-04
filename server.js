'use strict';
/**
 * server.js — Express app for "שת"פ נולד".
 *
 * One process, one in-memory game. All timing lives here (tick loop);
 * clients only render what the server pushes over SSE.
 *
 * MUST run as a single instance — two instances would be two separate games.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const QRCode = require('qrcode');
const game = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');

const TICK_MS = 500;
const HEARTBEAT_MS = 20 * 1000;

// ---- Game state -------------------------------------------------------------

let G = game.createGame();

function loadDefaultPool() {
  const file = path.join(__dirname, 'businesses.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    game.setBusinesses(G, raw, { source: 'default', fileName: 'businesses.json' });
    console.log(`[pool] loaded ${G.pool.businesses.length} businesses from businesses.json`);
  } catch (err) {
    console.error('[pool] could not load businesses.json:', err.message);
  }
}
loadDefaultPool();

// ---- Public origin + QR codes -----------------------------------------------

const linkCache = new Map(); // origin → { playerUrl, playerQr, exportUrl, exportQr }
const qrPending = new Map();

function publicOrigin(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = req.get('host') || `localhost:${PORT}`;
  return `${req.protocol}://${host}`;
}

function linkUrls(origin) {
  return { playerUrl: `${origin}/`, exportUrl: `${origin}/api/host/export.csv` };
}

async function ensureLinks(origin) {
  if (linkCache.has(origin)) return linkCache.get(origin);
  if (qrPending.has(origin)) return qrPending.get(origin);
  const urls = linkUrls(origin);
  const p = (async () => {
    const opts = { margin: 1, width: 640, errorCorrectionLevel: 'M' };
    let playerQr = null;
    let exportQr = null;
    try {
      [playerQr, exportQr] = await Promise.all([
        QRCode.toDataURL(urls.playerUrl, opts),
        QRCode.toDataURL(urls.exportUrl, opts),
      ]);
    } catch (err) {
      console.error('[qr] generation failed:', err.message);
    }
    const links = { ...urls, playerQr, exportQr };
    linkCache.set(origin, links);
    qrPending.delete(origin);
    return links;
  })();
  qrPending.set(origin, p);
  return p;
}

function linksFor(origin) {
  return linkCache.get(origin) || { ...linkUrls(origin), playerQr: null, exportQr: null };
}

// ---- SSE fan-out ------------------------------------------------------------

const clients = new Set(); // { res, role, token, teamId, origin }
const connectionsByTeam = new Map(); // teamId → open player streams

function bumpConnections(teamId, delta) {
  const n = Math.max(0, (connectionsByTeam.get(teamId) || 0) + delta);
  if (n === 0) connectionsByTeam.delete(teamId);
  else connectionsByTeam.set(teamId, n);
  return game.setConnected(G, teamId, n > 0);
}

function safeWrite(client, chunk) {
  try {
    client.res.write(chunk);
  } catch (err) {
    clients.delete(client);
  }
}

function sendState(client, now, cache) {
  let key;
  if (client.role === 'player') {
    const team = game.teamByToken(G, client.token);
    if (!team) {
      const payload = JSON.stringify({ role: 'player', serverNow: now, phase: G.phase, unknownToken: true });
      safeWrite(client, `event: state\ndata: ${payload}\n\n`);
      clients.delete(client);
      try {
        client.res.end();
      } catch (err) {
        /* ignore */
      }
      return;
    }
    key = 'player:' + team.id;
  } else {
    key = client.role + ':' + client.origin;
  }
  let payload = cache.get(key);
  if (!payload) {
    payload = JSON.stringify(
      game.viewFor(G, client.role, { token: client.token, links: linksFor(client.origin) }, now)
    );
    cache.set(key, payload);
  }
  safeWrite(client, `event: state\ndata: ${payload}\n\n`);
}

function broadcast() {
  const now = Date.now();
  const cache = new Map();
  for (const client of Array.from(clients)) sendState(client, now, cache);
}

setInterval(() => {
  try {
    if (game.tick(G, Date.now())) broadcast();
  } catch (err) {
    console.error('[tick]', err);
  }
}, TICK_MS);

setInterval(() => {
  for (const client of Array.from(clients)) safeWrite(client, ': hb\n\n');
}, HEARTBEAT_MS);

// ---- App --------------------------------------------------------------------

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

const noStore = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

app.get('/', noStore, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'player.html')));
app.get('/screen', noStore, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'screen.html')));
// The host controls live inside the projection design, so /host is the same page: open it on
// the host's tablet while the projector shows /screen — both drive the same game.
app.get('/host', noStore, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'screen.html')));
app.use(express.static(PUBLIC_DIR, { index: false, etag: true, maxAge: 0 }));

const ROLES = ['player', 'screen', 'host'];

function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof game.GameError) {
        return res.status(err.status || 400).json({ error: err.code, message: err.message });
      }
      console.error('[api]', err);
      res.status(500).json({ error: 'server_error', message: 'שגיאת שרת, נסו שוב' });
    }
  };
}

function requireTeam(req) {
  const token = String((req.body && req.body.token) || req.query.token || '');
  const team = game.teamByToken(G, token);
  if (!team) throw new game.GameError('unknown_token', 'הקבוצה לא נמצאה, יש להירשם מחדש', 404);
  return team;
}

function playerView(team, now, origin) {
  return game.viewFor(G, 'player', { token: team.token, links: origin ? linksFor(origin) : null }, now || Date.now());
}

function mutate(fn) {
  // Run a mutation, broadcast, respond with the caller's own view.
  return wrap(async (req, res) => {
    const now = Date.now();
    const result = await fn(req, now);
    broadcast();
    res.json(result || { ok: true });
  });
}

// ---- Realtime + state -------------------------------------------------------

app.get(
  '/api/stream',
  wrap(async (req, res) => {
    const role = String(req.query.role || 'player');
    if (!ROLES.includes(role)) throw new game.GameError('bad_role', 'תפקיד לא תקין');
    const token = role === 'player' ? String(req.query.token || '') : null;
    let team = null;
    if (role === 'player') {
      team = game.teamByToken(G, token);
      if (!team) throw new game.GameError('unknown_token', 'הקבוצה לא נמצאה, יש להירשם מחדש', 404);
    }
    const origin = publicOrigin(req);
    await ensureLinks(origin);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const client = { res, role, token, teamId: team ? team.id : null, origin };
    clients.add(client);

    let others = false;
    if (team) others = bumpConnections(team.id, +1);
    sendState(client, Date.now(), new Map());
    if (others) broadcast();

    req.on('close', () => {
      clients.delete(client);
      if (client.teamId && bumpConnections(client.teamId, -1)) broadcast();
    });
  })
);

app.get(
  '/api/state',
  noStore,
  wrap(async (req, res) => {
    const role = String(req.query.role || 'player');
    if (!ROLES.includes(role)) throw new game.GameError('bad_role', 'תפקיד לא תקין');
    const now = Date.now();
    const origin = publicOrigin(req);
    const links = await ensureLinks(origin);
    if (role === 'player') {
      const team = requireTeam(req);
      return res.json(playerView(team, now, origin));
    }
    res.json(game.viewFor(G, role, { links }, now));
  })
);

// ---- Player API -------------------------------------------------------------

app.post(
  '/api/join',
  wrap(async (req, res) => {
    const team = game.join(G, req.body || {}, Date.now());
    broadcast();
    res.json({ teamId: team.id, token: team.token });
  })
);

app.post(
  '/api/action/reject',
  mutate((req, now) => {
    const team = requireTeam(req);
    game.reject(G, team, now);
    return playerView(team, now, publicOrigin(req));
  })
);

app.post(
  '/api/action/accept-open',
  mutate((req, now) => {
    const team = requireTeam(req);
    game.acceptOpen(G, team, now);
    return playerView(team, now, publicOrigin(req));
  })
);

app.post(
  '/api/action/accept-cancel',
  mutate((req, now) => {
    const team = requireTeam(req);
    game.acceptCancel(G, team, now);
    return playerView(team, now, publicOrigin(req));
  })
);

app.post(
  '/api/action/accept',
  mutate((req, now) => {
    const team = requireTeam(req);
    game.accept(G, team, req.body ? req.body.argument : '', now);
    return playerView(team, now, publicOrigin(req));
  })
);

app.post(
  '/api/action/lifeline',
  mutate((req, now) => {
    const team = requireTeam(req);
    game.lifeline(G, team, req.body ? req.body.slot : null, now);
    return playerView(team, now, publicOrigin(req));
  })
);

app.post(
  '/api/vote',
  mutate((req, now) => {
    const team = requireTeam(req);
    const body = req.body || {};
    game.vote(G, team, body.matchId, body.value);
    return playerView(team, now, publicOrigin(req));
  })
);

// ---- Host API ---------------------------------------------------------------
// NOTE: intentionally unprotected for now; gate /host and /api/host/* on a
// single env var passcode later.

function hostView(req, now) {
  return game.viewFor(G, 'host', { links: linksFor(publicOrigin(req)) }, now);
}

app.post(
  '/api/host/businesses',
  mutate((req, now) => {
    const body = req.body;
    const raw = body && !Array.isArray(body) && body.businesses !== undefined ? body.businesses : body;
    const fileName = body && !Array.isArray(body) ? body.fileName : null;
    const pool = game.setBusinesses(G, raw, { source: 'upload', fileName: fileName || null });
    return { ok: true, count: pool.businesses.length, source: pool.source, fileName: pool.fileName };
  })
);

app.post(
  '/api/host/open-lobby',
  mutate((req, now) => {
    game.openLobby(G, req.body ? req.body.roundSeconds : undefined);
    return hostView(req, now);
  })
);

app.post(
  '/api/host/start',
  mutate((req, now) => {
    game.start(G, req.body ? req.body.roundSeconds : undefined, now);
    return hostView(req, now);
  })
);

app.post(
  '/api/host/end-round',
  mutate((req, now) => {
    game.endRound(G, now);
    return hostView(req, now);
  })
);

app.post(
  '/api/host/pause',
  mutate((req, now) => {
    game.pause(G, now);
    return hostView(req, now);
  })
);

app.post(
  '/api/host/resume',
  mutate((req, now) => {
    game.resume(G, now);
    return hostView(req, now);
  })
);

app.post(
  '/api/host/add-time',
  mutate((req, now) => {
    game.addTime(G, now);
    return hostView(req, now);
  })
);

app.post(
  '/api/host/judging',
  mutate((req, now) => {
    game.beginJudging(G, now);
    return hostView(req, now);
  })
);

app.post(
  '/api/host/next-match',
  mutate((req, now) => {
    game.nextMatch(G, now);
    return hostView(req, now);
  })
);

app.post(
  '/api/host/finish',
  mutate((req, now) => {
    game.finish(G, now);
    return hostView(req, now);
  })
);

app.post(
  '/api/host/reset',
  mutate((req, now) => {
    G = game.reset(G);
    connectionsByTeam.clear();
    return hostView(req, now);
  })
);

// Sample businesses file the host can download from the setup screen and edit.
const BUSINESSES_TEMPLATE = [
  { name: 'מאפיית הגליל', description: 'לחמי מחמצת ומאפים בטבריה' },
  { name: 'סטודיו נועה', description: 'מיתוג ועיצוב לעסקים קטנים בראש פינה' },
  { name: 'חוות ריח הדבש', description: 'דבש, פולן ומוצרי כוורת מהגולן' },
  { name: 'צימרים בכפר בלום', description: 'אירוח כפרי לזוגות ומשפחות' },
];

app.get('/api/host/businesses-template.json', noStore, (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="businesses-template.json"; filename*=UTF-8''${encodeURIComponent('תבנית-עסקים.json')}`
  );
  res.send(JSON.stringify(BUSINESSES_TEMPLATE, null, 2) + '\n');
});

app.get('/api/host/export.csv', noStore, (req, res) => {
  const rows = game.exportRows(G);
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const header = ['שם הקבוצה', 'משתתפים', 'עסק א', 'עסק ב', 'הנימוק', 'ציון שיפוט'];
  const lines = [header.map(esc).join(',')];
  for (const r of rows) {
    lines.push(
      [r.teamName, r.players, r.businessA, r.businessB, r.argument, r.judgeScore == null ? '' : r.judgeScore]
        .map(esc)
        .join(',')
    );
  }
  const csv = '\uFEFF' + lines.join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="matches.csv"; filename*=UTF-8''${encodeURIComponent('שידוכים.csv')}`
  );
  res.send(csv);
});

// ---- Errors -----------------------------------------------------------------

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found', message: 'נתיב לא קיים' });
  res.status(404).send('Not found');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'bad_json', message: 'גוף הבקשה אינו JSON תקין' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'too_large', message: 'הקובץ גדול מדי (עד 2MB)' });
  }
  console.error('[express]', err);
  res.status(500).json({ error: 'server_error', message: 'שגיאת שרת' });
});

// ---- Listen -----------------------------------------------------------------

app.listen(PORT, () => {
  const origin = PUBLIC_URL || `http://localhost:${PORT}`;
  console.log('שת"פ נולד — server up (single instance only)');
  console.log(`  players : ${origin}/`);
  console.log(`  screen  : ${origin}/screen`);
  console.log(`  host    : ${origin}/host`);
  if (!PUBLIC_URL) console.log('  (set PUBLIC_URL to control the URL encoded in the QR codes)');
});
