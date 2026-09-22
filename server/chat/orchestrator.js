/**
 * Ask Lens - orchestrator
 *
 * One exchange, end to end:
 *
 *   rate limit -> snapshot -> answer cache -> Anthropic (cached prefix)
 *   -> optional tool round -> stream markers -> resolve records -> persist
 *
 * The cached prefix is tools + base prompt + examples + snapshot, which
 * is where the cost saving comes from. Only trimmed history and the new
 * message are fresh tokens.
 */

const Anthropic = require('@anthropic-ai/sdk');
const S = require('./schema.config');
const { getPool } = require('./db');
const { getSnapshot } = require('./snapshot');
const { buildSystem } = require('./systemPrompt');
const { buildTools } = require('./tools');
const { runTool } = require('./toolHandlers');
const answerCache = require('./answerCache');
const rateLimit = require('./rateLimit');
const { modelFor } = require('./router');
const keepwarm = require('./keepwarm');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_TOOL_ROUNDS = 2;
const MARKER_RE = /\[\[(creative|metric|chart|compare|cohort):([^\]]+)\]\]/g;

// ---------------------------------------------------------------
// SSE helper
// ---------------------------------------------------------------

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  res.on('close', () => { closed = true; });
  return {
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() { if (!closed) res.end(); },
    get closed() { return closed; },
  };
}

// ---------------------------------------------------------------
// History
// ---------------------------------------------------------------

/**
 * Recent turns verbatim, older turns as one-line summaries built by
 * template rather than by a model call, so compression is free.
 */
async function loadHistory(sessionId, pool) {
  const { rows } = await pool.query(
    `select role, content from chat_messages
     where session_id = $1
     order by created_at desc
     limit $2`,
    [sessionId, (S.historyTurnsVerbatim + S.historyTurnsCompressed) * 2],
  );
  rows.reverse();

  const verbatimCount = S.historyTurnsVerbatim * 2;
  const older = rows.slice(0, Math.max(0, rows.length - verbatimCount));
  const recent = rows.slice(Math.max(0, rows.length - verbatimCount));

  const messages = [];

  if (older.length) {
    const lines = [];
    for (let i = 0; i < older.length; i += 2) {
      const q = older[i];
      const a = older[i + 1];
      if (!q) continue;
      const qs = q.content.slice(0, 70);
      const as = a ? a.content.replace(MARKER_RE, '').replace(/\s+/g, ' ').slice(0, 70) : '';
      lines.push(`- asked: ${qs}${as ? ` | answered: ${as}` : ''}`);
    }
    if (lines.length) {
      messages.push({
        role: 'user',
        content: `Earlier in this conversation:\n${lines.join('\n')}\n\n(Context only. Answer the question that follows.)`,
      });
      messages.push({ role: 'assistant', content: 'Understood.' });
    }
  }

  for (const r of recent) {
    messages.push({ role: r.role, content: r.content });
  }

  // The API rejects a leading assistant turn.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  return messages;
}

// ---------------------------------------------------------------
// Marker resolution
// ---------------------------------------------------------------

function extractMarkers(text) {
  const out = [];
  let m;
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(text)) !== null) {
    out.push({ kind: m[1], body: m[2], raw: m[0] });
  }
  return out;
}

/** Every creative id a set of markers points at. */
function referencedIds(markers) {
  const ids = new Set();
  for (const mk of markers) {
    if (mk.kind === 'creative') {
      ids.add(mk.body.trim());
    } else if (mk.kind === 'metric') {
      const id = mk.body.split('|')[1];
      if (id && id.trim() !== 'brand') ids.add(id.trim());
    } else if (mk.kind === 'chart') {
      const list = mk.body.split('|')[2] || '';
      if (list.trim() !== 'series') list.split(',').forEach((x) => x.trim() && ids.add(x.trim()));
    } else if (mk.kind === 'compare') {
      mk.body.split(',').forEach((x) => x.trim() && ids.add(x.trim()));
    }
  }
  return [...ids];
}

/** Fetch records the snapshot and tool results did not already supply. */
async function resolveMissing(ids, have, ctx, pool) {
  const missing = ids.filter((id) => !have[id]);
  if (!missing.length) return {};
  const { handlers } = require('./toolHandlers');
  const out = {};
  try {
    const res = await handlers.compare_creatives(
      { creative_ids: missing.length === 1 ? [missing[0], missing[0]] : missing.slice(0, 4) },
      ctx,
    );
    Object.assign(out, res.records);
  } catch (err) {
    console.error('[resolveMissing]', err.message);
  }
  return out;
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------

/**
 * @param {object} p
 * @param {string} p.userId
 * @param {string} p.sessionId
 * @param {string} p.brand
 * @param {number} p.rangeDays
 * @param {string} p.message
 * @param {object} p.res      Express response, used for SSE
 */
async function handleMessage(p) {
  const pool = getPool();
  const stream = sse(p.res);
  const startedAt = Date.now();

  const usage = { input: 0, cached: 0, cacheWrite: 0, output: 0, toolRounds: 0, cacheHit: false };

  try {
    // ---- 1. Rate limit -----------------------------------------
    const limit = await rateLimit.consume(p.userId, { pool });
    if (!limit.allowed) {
      stream.send('error', { message: limit.reason, retryAfter: limit.retryAfter });
      stream.end();
      return;
    }

    // ---- 2. Snapshot -------------------------------------------
    const snap = await getSnapshot(p.brand, p.rangeDays, { pool });
    const snapRecords = snap.records || {};

    stream.send('records', snapRecords);
    stream.send('meta', {
      brand: p.brand,
      rangeDays: p.rangeDays,
      period: `${snap.period_start} to ${snap.period_end}`,
      snapshotVersion: snap.version,
    });

    // ---- 3. History and answer cache ---------------------------
    const history = await loadHistory(p.sessionId, pool);
    const hasHistory = history.length > 0;

    const cacheParams = {
      brand: p.brand,
      rangeDays: p.rangeDays,
      snapshotVersion: snap.version,
      question: p.message,
      hasHistory,
    };

    const cached = await answerCache.get(cacheParams, { pool });
    if (cached) {
      usage.cacheHit = true;
      if (cached.records && Object.keys(cached.records).length) {
        stream.send('records', cached.records);
      }
      stream.send('text', { delta: cached.answer });
      stream.send('done', { ...usage, latencyMs: Date.now() - startedAt });
      stream.end();
      await persist(pool, p, cached.answer, {
        markers: extractMarkers(cached.answer), toolCalls: [], usage,
        latencyMs: Date.now() - startedAt,
      });
      return;
    }

    // ---- 4. Build the request ----------------------------------
    const system = buildSystem({
      brand: p.brand,
      snapshotBody: snap.body,
      rangeDays: p.rangeDays,
    });
    const tools = buildTools();
    const messages = [...history, { role: 'user', content: p.message }];

    const route = modelFor(p.message);
    const toolCtx = { brand: p.brand, rangeDays: p.rangeDays, pool };
    const allRecords = { ...snapRecords };
    const toolCallLog = [];
    let fullText = '';

    // ---- 5. Tool loop ------------------------------------------
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      if (stream.closed) return;

      const runner = client.messages.stream({
        model: route.model,
        max_tokens: route.maxTokens,
        system,
        tools,
        messages,
      });

      runner.on('text', (delta) => {
        fullText += delta;
        stream.send('text', { delta });
      });

      const final = await runner.finalMessage();
      keepwarm.touch(p.brand, route.model); // this call just refreshed the cache

      const u = final.usage || {};
      usage.input += u.input_tokens || 0;
      usage.cached += u.cache_read_input_tokens || 0;
      usage.cacheWrite += u.cache_creation_input_tokens || 0;
      usage.output += u.output_tokens || 0;

      if (final.stop_reason !== 'tool_use' || round === MAX_TOOL_ROUNDS) {
        if (final.stop_reason === 'tool_use') {
          const note = '\n\nI could not complete that lookup. Try narrowing the question.';
          fullText += note;
          stream.send('text', { delta: note });
        }
        break;
      }

      usage.toolRounds += 1;

      const toolUses = final.content.filter((b) => b.type === 'tool_use');
      messages.push({ role: 'assistant', content: final.content });

      const results = [];
      for (const use of toolUses) {
        stream.send('tool', { name: use.name });
        toolCallLog.push({ name: use.name, input: use.input });

        const out = await runTool(use.name, use.input, toolCtx);

        if (out.records && Object.keys(out.records).length) {
          Object.assign(allRecords, out.records);
          stream.send('records', out.records);
        }
        if (out.series) {
          stream.send('series', out.series);
        }

        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: JSON.stringify(out.result),
        });
      }

      messages.push({ role: 'user', content: results });
    }

    // ---- 6. Resolve any marker the payloads missed --------------
    const markers = extractMarkers(fullText);
    const ids = referencedIds(markers);
    const extra = await resolveMissing(ids, allRecords, toolCtx, pool);
    if (Object.keys(extra).length) {
      Object.assign(allRecords, extra);
      stream.send('records', extra);
    }

    const latencyMs = Date.now() - startedAt;
    stream.send('done', { ...usage, latencyMs });
    stream.end();

    // ---- 7. Persist and cache ----------------------------------
    const refused = fullText.startsWith("That's outside what I can help with")
      || fullText.startsWith("I'm scoped to");

    await persist(pool, p, fullText, { markers, toolCalls: toolCallLog, usage, latencyMs, refused });

    if (!refused && !hasHistory) {
      const used = {};
      for (const id of ids) if (allRecords[id]) used[id] = allRecords[id];
      await answerCache.put(cacheParams, { answer: fullText, records: used }, { pool });
    }
  } catch (err) {
    console.error('[orchestrator]', err);
    stream.send('error', { message: 'Something went wrong fetching that. Try again in a moment.' });
    stream.end();
  }
}

// ---------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------

async function persist(pool, p, answer, meta) {
  try {
    await pool.query(
      `insert into chat_messages (session_id, role, content) values ($1, 'user', $2)`,
      [p.sessionId, p.message],
    );
    await pool.query(
      `insert into chat_messages
         (session_id, role, content, markers, tool_calls, refused, cache_hit,
          tokens_in, tokens_cached, tokens_out, latency_ms)
       values ($1, 'assistant', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        p.sessionId, answer,
        JSON.stringify(meta.markers || []),
        JSON.stringify(meta.toolCalls || []),
        !!meta.refused,
        !!meta.usage?.cacheHit,
        meta.usage?.input || 0,
        meta.usage?.cached || 0,
        meta.usage?.output || 0,
        meta.latencyMs || null,
      ],
    );
    await pool.query(
      `update chat_sessions
         set turn_count = turn_count + 1,
             updated_at = now(),
             title = coalesce(title, left($2, 60))
       where id = $1`,
      [p.sessionId, p.message],
    );
  } catch (err) {
    console.error('[persist]', err.message);
  }
}

module.exports = { handleMessage, extractMarkers, referencedIds, loadHistory };
