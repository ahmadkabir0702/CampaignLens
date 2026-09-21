const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const youtubedl = require('youtube-dl-exec');
const os = require('os'); // <--- ADD THIS
const { GoogleGenAI } = require('@google/genai');
const session = require('express-session');
const { query } = require('./db');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sessions live in Redis when it is available. The default MemoryStore keeps
// them in this process, so every deploy logged everyone out and the browser
// was left holding a cookie for a session that no longer existed — which is
// what produced "Not authenticated" right after a deploy.
let sessionStore;
if (process.env.REDIS_URL) {
  try {
    const RedisStore = require('connect-redis').default || require('connect-redis');
    const IORedis = require('ioredis');
    const sessionRedis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
    sessionRedis.on('error', e => console.error('[session] redis:', e.message));
    sessionStore = new RedisStore({ client: sessionRedis, prefix: 'sess:' });
    console.log('[session] using Redis store');
  } catch (e) {
    console.error('[session] Redis store unavailable, falling back to memory:', e.message);
  }
} else {
  console.warn('[session] REDIS_URL not set — sessions reset on every restart.');
}

// Render terminates TLS at its proxy, so without this Express sees the request
// as plain HTTP and a secure cookie would never be set on the custom domain.
app.set('trust proxy', 1);

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'changeme-set-in-env',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// Auth middleware — skips login/logout routes
function requireAuth(req, res, next) {
  if (req.path === '/login' || req.path === '/logout' || req.path === '/api/test-gemini') return next();
  if (req.path.startsWith('/img/')) return next();
  if (req.session && req.session.user) return next();
  // API calls get 401, not redirect
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.redirect('/login');
}

app.options('*', cors({ origin: '*' }));

app.use(requireAuth);

// Role isolation. An influencer coordinator gets exactly one page and the
// handful of API routes it needs; anything else bounces them back to it.
// Everyone else never sees that page.
const COORD_ROLE = 'influencer_coordinator';
const COORD_API = new Set([
  '/api/brands', '/api/switch-brand',
  '/api/others-say-pending', '/api/others-say-stats', '/api/add-creative',
  '/api/campaigns', '/api/check-links',
]);
// Deny by default: a coordinator may reach their own page, the assets it
// needs, and the allowlisted APIs. Everything else bounces. Nothing here
// depends on remembering to name a new page, so adding pages elsewhere in
// the app cannot accidentally expose them to this role.
const COORD_ASSET_RE = /^\/(img|fonts)\//;
// Named individually rather than opening all of /js/, which holds the full
// dashboard code this role must never load.
const COORD_SCRIPTS = new Set(['/js/links.js']);
app.use((req, res, next) => {
  const role = req.session && req.session.role;
  const p = req.path;
  if (role !== COORD_ROLE) return next();

  const ok = p === '/coordinator' || p === '/logout'
    || COORD_ASSET_RE.test(p) || COORD_SCRIPTS.has(p) || COORD_API.has(p);
  if (ok) return next();
  if (p.startsWith('/api/')) return res.status(403).json({ error: 'Not permitted for this role' });
  return res.redirect('/coordinator');
});

// Served from views/, not public/. The static handler cannot reach it, so the
// only way to this page is through this route, which is behind requireAuth
// and the role check below.
// Read at boot so the page is served from memory, but never fatally: this
// runs at module load, so an unreadable file here would stop the whole app
// from starting rather than just breaking one page.
const COORDINATOR_HTML = (() => {
  for (const p of [path.join(__dirname, 'views', 'coordinator.html'),
                   path.join(__dirname, 'coordinator.html')]) {
    try { return fs.readFileSync(p, 'utf8'); } catch (e) { /* try the next */ }
  }
  console.error('[server] coordinator.html not found in views/ or repo root — /coordinator will 503');
  return null;
})();

app.get('/coordinator', (req, res) => {
  if (!COORDINATOR_HTML) {
    return res.status(503).send('Coordinator page is not installed on this deploy.');
  }
  if (!req.session || req.session.role !== COORD_ROLE) return res.redirect('/');
  res.type('html').send(COORDINATOR_HTML);
});

const LOGIN_HTML = fs.readFileSync(path.join(__dirname, 'public', 'login.html'), 'utf8');

app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/');
  const err = req.query.error
    ? '<div class="err">Incorrect username or password.</div>'
    : '';
  res.send(LOGIN_HTML.replace('<!-- ERROR_BLOCK -->', err));
});


app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.post('/api/test-gemini', async (req, res) => {
  const { videoBase64, password } = req.body;
  if (password !== process.env.TEST_SECRET) return res.status(401).json({ error: 'Wrong password' });
  try {
  console.log(`[AI Worker] Generating detailed descriptions...`);
    
    const prompt = `Watch this video carefully and provide a highly descriptive visual and narrative analysis. Extract the following 5 segments:

1. "hook": Write exactly 2 detailed sentences describing the opening hook (first 3 seconds). Note the visual impact, audio, or text used to grab attention.
2. "seg1": (0–25%) Write exactly 2-3 detailed sentences describing the setting, who appears, specific actions, and any text on screen.
3. "seg2": (25–50%) Write exactly 2-3 detailed sentences describing how the narrative, demonstration, or emotional tone develops.
4. "seg3": (50–75%) Write exactly 2-3 detailed sentences describing the core product moment, key features shown, or the climax of the message.
5. "seg4": (75–100%) Write exactly 2-3 detailed sentences describing the closing scene, final branding moments, and the call to action.

Make your descriptions vivid and specific (mention colors, emotions, or exact text if relevant). Return ONLY a valid JSON object with exactly these keys: "hook", "seg1", "seg2", "seg3", "seg4". Do not use markdown formatting or include any extra text outside the JSON.`;
    const result = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: 'video/mp4', data: videoBase64 } },
        { text: prompt }
      ]}],
      config: { responseMimeType: 'application/json', maxOutputTokens: 4000 }
    });
    const parsed = JSON.parse(result.text.replace(/```json|```/g, '').trim());
    res.json({ success: true, result: parsed });
  } catch(err) {
    res.json({ success: false, error: err.message });
  }
});

// Serve static files — only after auth middleware
app.use(express.static(path.join(__dirname, 'public')));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });





// Background download queue — routes only mount when REDIS_URL is set
require('./media-queue').mountMediaQueue(app);

// Run the queue worker inside this process. At current volume a dedicated
// Render Background Worker costs $7/month and buys nothing; the downloads are
// I/O bound and never block the event loop. To split it out later, set
// RUN_WORKER_IN_PROCESS=false here and deploy a worker service with the start
// command `node worker.js` — same file, no code change.
if (String(process.env.RUN_WORKER_IN_PROCESS || 'true') !== 'false') {
  require('./worker').startWorker(ai);
}

// All Postgres-backed API routes live in routes.js
require('./routes')(app, { ai, youtubedl });
// Ask Lens chat routes
require('./server/chat/routes')(app);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});

// Render sends SIGTERM on every deploy. The queue worker runs inside this
// process, so a hard exit kills any analysis in flight and burns one of its
// retries. Stop accepting new HTTP connections first, then let worker.js's
// own handler drain the jobs it already has. Render allows ~30s before
// SIGKILL; anything still running past that is picked up as a stalled job
// and retried by the next instance rather than lost.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} — closing HTTP listener, draining in-flight work`);
    server.close(() => console.log('[server] HTTP listener closed'));
  });
}
