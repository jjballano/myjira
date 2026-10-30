import express from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  JIRA_BASE_URL = '',
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  PORT = 3101,
} = process.env;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = JIRA_BASE_URL.replace(/\/$/, '');
const LIST_FIELDS = 'summary,status,assignee,issuetype,priority,parent,labels,updated';

class HttpError extends Error {
  constructor(status, message, details, login = false) {
    super(message);
    this.status = status;
    this.details = details;
    this.login = login;
  }
}

/** Per-request Jira target: `api` to call, `site` for browser links, `auth` header. */
const jiraCtx = new AsyncLocalStorage();
const ctx = () => jiraCtx.getStore();

function jiraErrorMessage(data, status) {
  if (data && typeof data === 'object') {
    const msgs = [...(data.errorMessages ?? []), ...Object.values(data.errors ?? {})];
    if (msgs.length) return msgs.join(' · ');
    if (data.message) return data.message;
  }
  return `Jira respondió ${status}`;
}

async function jira(pathname, { method = 'GET', body, query } = {}) {
  const { api, auth } = ctx();
  const url = new URL(api + pathname);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      Accept: 'application/json',
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  // A revoked token or a changed password: send the user back to the login form.
  if (res.status === 401) throw new HttpError(401, 'Tu sesión de Jira ya no es válida, vuelve a entrar', data, true);
  if (!res.ok) throw new HttpError(res.status, jiraErrorMessage(data, res.status), data);
  return data;
}

// Agile endpoints paginate with startAt/maxResults and either isLast or total.
async function agilePaged(pathname, key, query = {}) {
  const out = [];
  let startAt = 0;
  for (;;) {
    const data = await jira(pathname, { query: { ...query, startAt, maxResults: 100 } });
    const items = data[key] ?? [];
    out.push(...items);
    startAt += items.length;
    if (!items.length || data.isLast || (data.total !== undefined && startAt >= data.total)) break;
  }
  return out;
}

async function searchJql(jql, fields, maxResults = 100) {
  const out = [];
  let nextPageToken;
  do {
    const data = await jira('/rest/api/3/search/jql', {
      method: 'POST',
      body: { jql, fields, maxResults, nextPageToken },
    });
    out.push(...(data.issues ?? []));
    nextPageToken = data.nextPageToken;
  } while (nextPageToken && out.length < 1000);
  return out;
}

const user = (u) =>
  u ? { accountId: u.accountId, displayName: u.displayName, avatar: u.avatarUrls?.['48x48'] } : null;

const status = (s) => (s ? { id: s.id, name: s.name, category: s.statusCategory?.key ?? 'new' } : null);

const issueType = (t) =>
  t ? { name: t.name, icon: t.iconUrl, subtask: !!t.subtask, hierarchyLevel: t.hierarchyLevel ?? 0 } : null;

function slimIssue(i) {
  const f = i.fields ?? {};
  return {
    id: i.id,
    key: i.key,
    summary: f.summary ?? '',
    status: status(f.status),
    assignee: user(f.assignee),
    issuetype: issueType(f.issuetype),
    priority: f.priority ? { name: f.priority.name, icon: f.priority.iconUrl } : null,
    parent: f.parent
      ? {
          key: f.parent.key,
          summary: f.parent.fields?.summary ?? '',
          status: status(f.parent.fields?.status),
          issuetype: issueType(f.parent.fields?.issuetype),
        }
      : null,
    labels: f.labels ?? [],
    updated: f.updated,
  };
}

const slimSprint = (s) =>
  s && {
    id: s.id,
    name: s.name,
    state: s.state,
    startDate: s.startDate,
    endDate: s.endDate,
    goal: s.goal,
    originBoardId: s.originBoardId,
  };

// Rendered HTML points images at Jira (auth required): route them through our proxy.
function rewriteHtml(html) {
  if (!html) return '';
  return html
    .replace(/src="(?:https?:\/\/[^"/]*atlassian\.net)?(\/[^"]*)"/g, (_, p) => `src="/api/asset?path=${encodeURIComponent(p)}"`)
    .replace(/href="(\/[^"]*)"/g, (_, p) => `href="${ctx().site}${p}" target="_blank" rel="noreferrer"`);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

const k = (req) => encodeURIComponent(req.params.key);

/* ---------- auth ---------- */

// Each user signs in with their own email + API token. The token stays on the server;
// the browser only holds a random session id. If .env has credentials, they're used when there's no session.
const SID = 'myjira_sid';
const SESSIONS_FILE = path.join(ROOT, '.sessions.json');

// Persisted so `--watch` restarts don't log everyone out. Holds tokens: gitignored.
const sessions = new Map(existsSync(SESSIONS_FILE) ? Object.entries(JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'))) : []);
const saveSessions = () => writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });

const cookies = (req) =>
  Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  );
const cookieOpts = (req) => ({ httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
const basic = (email, token) => 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
const ENV_AUTH = BASE && JIRA_EMAIL && JIRA_API_TOKEN ? { site: BASE, auth: basic(JIRA_EMAIL, JIRA_API_TOKEN) } : null;

// Only Jira Cloud sites, so the proxy can't be pointed at arbitrary hosts. JIRA_BASE_URL pins the site.
function siteUrl(input) {
  if (BASE) return BASE;
  let url;
  try {
    url = new URL(String(input ?? '').trim().replace(/^(?!https?:\/\/)/, 'https://'));
  } catch {
    throw new HttpError(400, 'URL de Jira inválida');
  }
  if (!/^[a-z0-9-]+\.atlassian\.net$/i.test(url.hostname)) throw new HttpError(400, 'La URL debe ser https://<tu-sitio>.atlassian.net');
  return `https://${url.hostname.toLowerCase()}`;
}

app.get('/api/auth/config', (_req, res) => res.json({ site: BASE || null }));

app.post('/api/auth/login', async (req, res) => {
  const { site: rawSite, email, token } = req.body ?? {};
  if (!email || !token) throw new HttpError(400, 'Faltan email o API token');
  const site = siteUrl(rawSite);
  // Pasted tokens can carry line breaks or zero-width characters; a real token has neither.
  const clean = String(token).replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, '');
  const auth = basic(String(email).trim(), clean);
  try {
    await jiraCtx.run({ api: site, site, auth }, () => jira('/rest/api/3/myself'));
  } catch (e) {
    console.warn(`Login rechazado para ${email} en ${site}: Jira ${e.status ?? e.message} (token de ${clean.length} caracteres)`);
    if (e.status === 401 || e.status === 403) throw new HttpError(401, 'Email o API token incorrectos');
    throw new HttpError(502, `No se pudo conectar con ${site}`);
  }
  const sid = randomBytes(32).toString('hex');
  sessions.set(sid, { site, auth });
  saveSessions();
  res.cookie(SID, sid, { ...cookieOpts(req), maxAge: 90 * 24 * 3600_000 });
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  const sid = cookies(req)[SID];
  if (sid && sessions.delete(sid)) saveSessions();
  res.clearCookie(SID, cookieOpts(req));
  res.json({ ok: true });
});

app.use('/api', (req, _res, next) => {
  const s = sessions.get(cookies(req)[SID]);
  const c = s ? { ...s, session: true } : ENV_AUTH && { ...ENV_AUTH, session: false };
  if (!c) throw new HttpError(401, 'Inicia sesión con tu cuenta de Jira', undefined, true);
  jiraCtx.run({ api: c.site, ...c }, next);
});

app.get('/api/me', async (_req, res) => {
  const me = await jira('/rest/api/3/myself');
  res.json({ ...user(me), baseUrl: ctx().site, session: ctx().session });
});

app.get('/api/boards', async (req, res) => {
  const boards = await agilePaged('/rest/agile/1.0/board', 'values', { name: req.query.name });
  res.json(boards.map((b) => ({ id: b.id, name: b.name, type: b.type, projectKey: b.location?.projectKey })));
});

app.get('/api/boards/:id/sprints', async (req, res) => {
  const sprints = await agilePaged(`/rest/agile/1.0/board/${req.params.id}/sprint`, 'values', {
    state: 'active,future',
  });
  res.json(sprints.map(slimSprint));
});

app.get('/api/boards/:id/columns', async (req, res) => {
  const [cfg, statuses] = await Promise.all([
    jira(`/rest/agile/1.0/board/${req.params.id}/configuration`),
    jira('/rest/api/3/status').catch(() => []),
  ]);
  // The board config only carries status ids; names are needed to split a column per status.
  const names = new Map(statuses.map((s) => [s.id, s.name]));
  res.json(
    (cfg.columnConfig?.columns ?? []).map((c) => ({
      name: c.name,
      statusIds: c.statuses.map((s) => s.id),
      statusNames: c.statuses.map((s) => names.get(s.id) ?? s.id),
    })),
  );
});

app.get('/api/boards/:id/sprints/:sprintId/issues', async (req, res) => {
  const issues = await agilePaged(
    `/rest/agile/1.0/board/${req.params.id}/sprint/${req.params.sprintId}/issue`,
    'issues',
    { fields: LIST_FIELDS },
  );
  res.json(issues.map(slimIssue));
});

app.get('/api/boards/:id/sprints/:sprintId/count', async (req, res) => {
  const data = await jira(`/rest/agile/1.0/board/${req.params.id}/sprint/${req.params.sprintId}/issue`, {
    query: { maxResults: 1, fields: 'key' },
  });
  res.json({ total: data.total ?? 0 });
});

app.get('/api/boards/:id/backlog', async (req, res) => {
  const issues = await agilePaged(`/rest/agile/1.0/board/${req.params.id}/backlog`, 'issues', {
    fields: LIST_FIELDS,
  });
  res.json(issues.map(slimIssue));
});

app.get('/api/boards/:id/backlog/count', async (req, res) => {
  const data = await jira(`/rest/agile/1.0/board/${req.params.id}/backlog`, {
    query: { maxResults: 1, fields: 'key' },
  });
  res.json({ total: data.total ?? 0 });
});

// Batch lookup, used for epic headers (assignee etc.).
app.get('/api/issues', async (req, res) => {
  const keys = String(req.query.keys ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Z][A-Z0-9_]*-\d+$/i.test(s));
  if (!keys.length) return res.json([]);
  const issues = await searchJql(`key in (${keys.join(',')})`, LIST_FIELDS.split(','));
  res.json(issues.map(slimIssue));
});

app.get('/api/issues/:key', async (req, res) => {
  const [issue, agile, comments] = await Promise.all([
    jira(`/rest/api/2/issue/${k(req)}`, {
      query: { expand: 'renderedFields', fields: `${LIST_FIELDS},description,reporter,timetracking,project` },
    }),
    jira(`/rest/agile/1.0/issue/${k(req)}`, { query: { fields: 'sprint' } }).catch(() => null),
    jira(`/rest/api/2/issue/${k(req)}/comment`, {
      query: { expand: 'renderedBody', orderBy: 'created', maxResults: 100 },
    }),
  ]);
  const f = issue.fields;
  res.json({
    ...slimIssue(issue),
    description: f.description ?? '',
    descriptionHtml: rewriteHtml(issue.renderedFields?.description),
    reporter: user(f.reporter),
    timetracking: f.timetracking ?? {},
    project: { key: f.project?.key, name: f.project?.name },
    sprint: slimSprint(agile?.fields?.sprint) ?? null,
    url: `${ctx().site}/browse/${issue.key}`,
    comments: (comments.comments ?? []).map((c) => ({
      id: c.id,
      author: user(c.author),
      created: c.created,
      bodyHtml: rewriteHtml(c.renderedBody),
    })),
  });
});

// Subtasks of a story, or the issues of an epic, in rank order.
app.get('/api/issues/:key/children', async (req, res) => {
  if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(req.params.key)) throw new HttpError(400, 'Clave inválida');
  const issues = await searchJql(`parent = "${req.params.key}" ORDER BY Rank ASC`, LIST_FIELDS.split(','));
  res.json(issues.map(slimIssue));
});

app.put('/api/issues/:key', async (req, res) => {
  const { summary, description, labels, parent, assignee, priority } = req.body ?? {};
  const fields = {};
  if (summary !== undefined) fields.summary = summary;
  if (description !== undefined) fields.description = description;
  if (labels !== undefined) fields.labels = labels;
  if (parent !== undefined) fields.parent = parent ? { key: parent } : null;
  if (priority !== undefined) fields.priority = { id: priority };
  if (Object.keys(fields).length) {
    // v2 takes description as wiki markup, which round-trips through a plain textarea.
    await jira(`/rest/api/2/issue/${k(req)}`, { method: 'PUT', body: { fields } });
  }
  if (assignee !== undefined) {
    await jira(`/rest/api/3/issue/${k(req)}/assignee`, { method: 'PUT', body: { accountId: assignee } });
  }
  res.json({ ok: true });
});

app.delete('/api/issues/:key', async (req, res) => {
  await jira(`/rest/api/3/issue/${k(req)}`, { method: 'DELETE', query: { deleteSubtasks: 'true' } });
  res.json({ ok: true });
});

app.get('/api/issues/:key/transitions', async (req, res) => {
  const data = await jira(`/rest/api/3/issue/${k(req)}/transitions`);
  res.json(data.transitions.map((t) => ({ id: t.id, name: t.name, to: status(t.to) })));
});

app.post('/api/issues/:key/transitions', async (req, res) => {
  await jira(`/rest/api/3/issue/${k(req)}/transitions`, {
    method: 'POST',
    body: { transition: { id: req.body.id } },
  });
  res.json({ ok: true });
});

app.post('/api/issues/:key/comments', async (req, res) => {
  const c = await jira(`/rest/api/2/issue/${k(req)}/comment`, { method: 'POST', body: { body: req.body.body } });
  res.json({ id: c.id });
});

app.post('/api/issues/:key/worklog', async (req, res) => {
  const { timeSpent, started, comment } = req.body ?? {};
  const w = await jira(`/rest/api/2/issue/${k(req)}/worklog`, {
    method: 'POST',
    body: { timeSpent, started, ...(comment && { comment }) },
  });
  res.json({ id: w.id });
});

app.post('/api/issues/:key/sprint', async (req, res) => {
  const { sprintId, before, after } = req.body ?? {};
  const body = { issues: [req.params.key] };
  const rank = before ? { rankBeforeIssue: before } : after ? { rankAfterIssue: after } : {};
  if (sprintId) {
    await jira(`/rest/agile/1.0/sprint/${sprintId}/issue`, { method: 'POST', body: { ...body, ...rank } });
  } else {
    // The backlog endpoint can't rank, so place it afterwards.
    await jira('/rest/agile/1.0/backlog/issue', { method: 'POST', body });
    if (before || after) await jira('/rest/agile/1.0/issue/rank', { method: 'PUT', body: { ...body, ...rank } });
  }
  res.json({ ok: true });
});

// Jira rank is global; the Agile API accepts either rankBeforeIssue or rankAfterIssue.
app.put('/api/rank', async (req, res) => {
  const { issues, before, after } = req.body ?? {};
  if (!Array.isArray(issues) || !issues.length || (!before && !after)) throw new HttpError(400, 'Parámetros de orden inválidos');
  const data = await jira('/rest/agile/1.0/issue/rank', {
    method: 'PUT',
    body: { issues, ...(before ? { rankBeforeIssue: before } : { rankAfterIssue: after }) },
  });
  // 207 Multi-Status reports per-issue failures inside a 2xx response.
  const failed = (data?.entries ?? []).filter((e) => e.status >= 400);
  if (failed.length) throw new HttpError(400, failed.flatMap((f) => f.errors ?? []).join(' · ') || 'No se pudo reordenar');
  res.json({ ok: true });
});

app.get('/api/users/assignable', async (req, res) => {
  const users = await jira('/rest/api/3/user/assignable/search', {
    query: { issueKey: req.query.issueKey, query: req.query.query, maxResults: 30 },
  });
  res.json(users.map(user));
});

app.get('/api/priorities', async (_req, res) => {
  const data = await jira('/rest/api/3/priority/search', { query: { maxResults: 100 } });
  res.json((data.values ?? []).map((p) => ({ id: p.id, name: p.name, icon: p.iconUrl })));
});

const labelsCache = new Map();
app.get('/api/labels', async (_req, res) => {
  const cached = labelsCache.get(ctx().api);
  if (!cached || Date.now() - cached.at > 5 * 60_000) {
    const values = [];
    let startAt = 0;
    for (;;) {
      const data = await jira('/rest/api/3/label', { query: { startAt, maxResults: 1000 } });
      values.push(...data.values);
      startAt += data.values.length;
      if (data.isLast || !data.values.length) break;
    }
    labelsCache.set(ctx().api, { at: Date.now(), values });
  }
  res.json(labelsCache.get(ctx().api).values);
});

app.get('/api/parents', async (req, res) => {
  const project = String(req.query.project ?? '').replace(/[^A-Z0-9_]/gi, '');
  const q = String(req.query.query ?? '').trim();
  let jql = `issuetype = Epic AND statusCategory != Done`;
  if (project) jql = `project = "${project}" AND ${jql}`;
  if (/^[A-Z][A-Z0-9_]*-\d+$/i.test(q)) jql = `key = "${q}"`;
  else if (q) jql += ` AND summary ~ "${q.replace(/["\\]/g, '')}*"`;
  try {
    const issues = await searchJql(`${jql} ORDER BY updated DESC`, LIST_FIELDS.split(','), 50);
    res.json(issues.map(slimIssue));
  } catch (e) {
    if (e.status === 400) return res.json([]);
    throw e;
  }
});

app.get('/api/asset', async (req, res) => {
  const p = String(req.query.path ?? '');
  if (!p.startsWith('/')) throw new HttpError(400, 'path inválido');
  const upstream = await fetch(ctx().api + p, { headers: { Authorization: ctx().auth } });
  res.status(upstream.status);
  res.set('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(await upstream.arrayBuffer()));
});

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

const dist = path.join(ROOT, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  const code = err.status ?? 500;
  if (code >= 500) console.error(err);
  res.status(code).json({ error: err.message, details: err.details, ...(err.login && { login: true }) });
});

app.listen(PORT, () =>
  console.log(`API en http://localhost:${PORT}${BASE ? ` → ${BASE}` : ''}${ENV_AUTH ? ' (token de .env sin sesión)' : ''}`),
);
