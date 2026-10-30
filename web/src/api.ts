import type { Board, Column, Issue, IssueDetail, IssuePatch, Me, Priority, Sprint, Transition, User } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly login = false,
  ) {
    super(message);
  }
}

async function req<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch('/api' + path, {
    method: init?.method ?? 'GET',
    headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // The session stopped working mid-use: reload so the app lands on the login screen.
    if (data?.login && path !== '/me') window.location.reload();
    throw new ApiError(data?.error ?? res.statusText, !!data?.login);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  me: () => req<Me>('/me'),
  authConfig: () => req<{ site: string | null }>('/auth/config'),
  login: (body: { site?: string; email: string; token: string }) => req('/auth/login', { method: 'POST', body }),
  logout: () => req('/auth/logout', { method: 'POST' }),
  boards: () => req<Board[]>('/boards'),
  sprints: (boardId: number) => req<Sprint[]>(`/boards/${boardId}/sprints`),
  columns: (boardId: number) => req<Column[]>(`/boards/${boardId}/columns`),
  sprintIssues: (boardId: number, sprintId: number) => req<Issue[]>(`/boards/${boardId}/sprints/${sprintId}/issues`),
  sprintCount: (boardId: number, sprintId: number) =>
    req<{ total: number }>(`/boards/${boardId}/sprints/${sprintId}/count`),
  backlog: (boardId: number) => req<Issue[]>(`/boards/${boardId}/backlog`),
  backlogCount: (boardId: number) => req<{ total: number }>(`/boards/${boardId}/backlog/count`),
  issuesByKeys: (keys: string[]) => req<Issue[]>(`/issues?keys=${enc(keys.join(','))}`),
  issue: (key: string) => req<IssueDetail>(`/issues/${enc(key)}`),
  children: (key: string) => req<Issue[]>(`/issues/${enc(key)}/children`),
  updateIssue: (key: string, patch: IssuePatch) => req(`/issues/${enc(key)}`, { method: 'PUT', body: patch }),
  deleteIssue: (key: string) => req(`/issues/${enc(key)}`, { method: 'DELETE' }),
  transitions: (key: string) => req<Transition[]>(`/issues/${enc(key)}/transitions`),
  transition: (key: string, id: string) => req(`/issues/${enc(key)}/transitions`, { method: 'POST', body: { id } }),
  comment: (key: string, body: string) => req(`/issues/${enc(key)}/comments`, { method: 'POST', body: { body } }),
  worklog: (key: string, body: { timeSpent: string; started: string; comment?: string }) =>
    req(`/issues/${enc(key)}/worklog`, { method: 'POST', body }),
  moveToSprint: (key: string, sprintId: number | null, at?: { pos: 'before' | 'after'; target: string }) =>
    req(`/issues/${enc(key)}/sprint`, { method: 'POST', body: { sprintId, ...(at && { [at.pos]: at.target }) } }),
  rank: (key: string, pos: 'before' | 'after', target: string) =>
    req('/rank', { method: 'PUT', body: { issues: [key], [pos]: target } }),
  assignable: (issueKey: string, query: string) =>
    req<User[]>(`/users/assignable?issueKey=${enc(issueKey)}&query=${enc(query)}`),
  labels: () => req<string[]>('/labels'),
  priorities: () => req<Priority[]>('/priorities'),
  parents: (project: string, query: string) => req<Issue[]>(`/parents?project=${enc(project)}&query=${enc(query)}`),
};
