import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  JIRA_BASE_URL = '',
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  PORT = 3101,
} = process.env;

const BASE = JIRA_BASE_URL.replace(/\/$/, '');
const AUTH = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
const LIST_FIELDS = 'summary,status,assignee,issuetype,priority,parent,labels,updated';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function jiraErrorMessage(data, status) {
  if (data && typeof data === 'object') {
    const msgs = [...(data.errorMessages ?? []), ...Object.values(data.errors ?? {})];
    if (msgs.length) return msgs.join(' · ');
    if (data.message) return data.message;
  }
  return `Jira respondió ${status}`;
}

async function jira(pathname, { method = 'GET', body, query } = {}) {
  if (!BASE || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new HttpError(500, 'Faltan JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN en .env');
  }
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: AUTH,
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
    .replace(/href="(\/[^"]*)"/g, (_, p) => `href="${BASE}${p}" target="_blank" rel="noreferrer"`);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

const k = (req) => encodeURIComponent(req.params.key);

app.get('/api/me', async (_req, res) => {
  const me = await jira('/rest/api/3/myself');
  res.json({ ...user(me), baseUrl: BASE });
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
  const cfg = await jira(`/rest/agile/1.0/board/${req.params.id}/configuration`);
  res.json(
    (cfg.columnConfig?.columns ?? []).map((c) => ({ name: c.name, statusIds: c.statuses.map((s) => s.id) })),
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
    url: `${BASE}/browse/${issue.key}`,
    comments: (comments.comments ?? []).map((c) => ({
      id: c.id,
      author: user(c.author),
      created: c.created,
      bodyHtml: rewriteHtml(c.renderedBody),
    })),
  });
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

let labelsCache = { at: 0, values: [] };
app.get('/api/labels', async (_req, res) => {
  if (Date.now() - labelsCache.at > 5 * 60_000) {
    const values = [];
    let startAt = 0;
    for (;;) {
      const data = await jira('/rest/api/3/label', { query: { startAt, maxResults: 1000 } });
      values.push(...data.values);
      startAt += data.values.length;
      if (data.isLast || !data.values.length) break;
    }
    labelsCache = { at: Date.now(), values };
  }
  res.json(labelsCache.values);
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
  const upstream = await fetch(BASE + p, { headers: { Authorization: AUTH } });
  res.status(upstream.status);
  res.set('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(await upstream.arrayBuffer()));
});

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  const code = err.status ?? 500;
  if (code >= 500) console.error(err);
  res.status(code).json({ error: err.message, details: err.details });
});

app.listen(PORT, () => console.log(`API en http://localhost:${PORT} → ${BASE || '(sin JIRA_BASE_URL)'}`));
