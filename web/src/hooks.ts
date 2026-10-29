import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { toast } from './toast';
import type { Board, Column, Issue, IssueDetail, IssuePatch, Me, Priority, Sprint, Transition, User } from './types';

export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export type View = 'sprint' | 'backlog';

function parseHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const params = new URLSearchParams(qs);
  return { view: (path === 'backlog' ? 'backlog' : 'sprint') as View, issue: params.get('issue') };
}

export function useRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const navigate = useCallback((view: View, issue: string | null) => {
    location.hash = `/${view}${issue ? `?issue=${issue}` : ''}`;
  }, []);
  return { ...route, navigate };
}

export interface AppCtx {
  me: Me;
  board: Board;
  sprints: Sprint[];
  /** Board columns, read from the board configuration. */
  columns: Column[];
  hiddenSprintIds: number[];
  setHiddenSprintIds: (ids: number[]) => void;
  openIssue: (key: string) => void;
}

export const AppContext = createContext<AppCtx | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('AppContext missing');
  return ctx;
}

interface Action {
  key: string;
  fn: () => Promise<unknown>;
  optimistic?: Partial<Issue>;
  /** Extra local cache update applied before the request. */
  local?: () => void;
  success?: string;
}

export function useIssueActions() {
  const qc = useQueryClient();

  const patchLocal = (key: string, patch: Partial<Issue>) => {
    qc.setQueriesData<Issue[]>({ queryKey: ['issues'] }, (old) =>
      old?.map((i) => {
        if (i.key === key) return { ...i, ...patch };
        if (i.parent?.key === key && patch.status) return { ...i, parent: { ...i.parent, status: patch.status } };
        return i;
      }),
    );
    qc.setQueryData<IssueDetail>(['issue', key], (old) => old && { ...old, ...patch });
  };

  const m = useMutation({
    mutationFn: async (a: Action) => {
      // Don't let an in-flight (e.g. periodic) refetch overwrite the optimistic update.
      await qc.cancelQueries({ queryKey: ['issues'] });
      if (a.optimistic) patchLocal(a.key, a.optimistic);
      a.local?.();
      await a.fn();
    },
    onSuccess: (_d, a) => a.success && toast(a.success),
    onError: (e) => toast(e.message, 'error'),
    onSettled: (_d, _e, a) => {
      qc.invalidateQueries({ queryKey: ['issues'] });
      qc.invalidateQueries({ queryKey: ['issue', a.key] });
      qc.invalidateQueries({ queryKey: ['count'] });
      qc.invalidateQueries({ queryKey: ['transitions', a.key] });
    },
  });
  // Lists come back from Jira in rank order, so reordering locally is just moving the item.
  const moveLocal = (key: string, pos: 'before' | 'after', target: string) =>
    qc.setQueriesData<Issue[]>({ queryKey: ['issues'] }, (old) => {
      if (!old?.some((i) => i.key === target)) return old;
      const item = old.find((i) => i.key === key);
      if (!item) return old;
      const rest = old.filter((i) => i.key !== key);
      const t = rest.findIndex((i) => i.key === target);
      rest.splice(pos === 'before' ? t : t + 1, 0, item);
      return rest;
    });

  /** Resolves to whether it succeeded; errors are already surfaced as toasts. */
  const run = (a: Action) => m.mutateAsync(a).then(() => true, () => false);

  return {
    pending: m.isPending,
    transition: (key: string, t: Transition) =>
      run({ key, fn: () => api.transition(key, t.id), optimistic: { status: t.to } }),
    assign: (key: string, user: User | null) =>
      run({ key, fn: () => api.updateIssue(key, { assignee: user?.accountId ?? null }), optimistic: { assignee: user } }),
    setPriority: (key: string, p: Priority) =>
      run({ key, fn: () => api.updateIssue(key, { priority: p.id }), optimistic: { priority: { name: p.name, icon: p.icon } } }),
    setLabels: (key: string, labels: string[]) =>
      run({ key, fn: () => api.updateIssue(key, { labels }), optimistic: { labels } }),
    update: (key: string, patch: IssuePatch, optimistic?: Partial<Issue>) =>
      run({ key, fn: () => api.updateIssue(key, patch), optimistic }),
    setParent: (key: string, parent: Issue | null) =>
      run({
        key,
        fn: () => api.updateIssue(key, { parent: parent?.key ?? null }),
        optimistic: {
          parent: parent && { key: parent.key, summary: parent.summary, status: parent.status, issuetype: parent.issuetype },
        },
      }),
    moveToSprint: (key: string, sprint: Sprint | null, opts?: { at?: { pos: 'before' | 'after'; target: string }; local?: () => void }) =>
      run({
        key,
        fn: () => api.moveToSprint(key, sprint?.id ?? null, opts?.at),
        local: opts?.local,
        success: `${key} → ${sprint?.name ?? 'Backlog'}`,
      }),
    rank: (key: string, pos: 'before' | 'after', target: string) =>
      run({ key, fn: () => api.rank(key, pos, target), local: () => moveLocal(key, pos, target) }),
    deleteIssue: (key: string) =>
      run({
        key,
        fn: () => api.deleteIssue(key),
        // Its subtasks go too.
        local: () =>
          qc.setQueriesData<Issue[]>({ queryKey: ['issues'] }, (old) => old?.filter((i) => i.key !== key && i.parent?.key !== key)),
        success: `${key} eliminado`,
      }),
    comment: (key: string, body: string) => run({ key, fn: () => api.comment(key, body) }),
    worklog: (key: string, body: { timeSpent: string; started: string; comment?: string }) =>
      run({ key, fn: () => api.worklog(key, body), success: `Registrado ${body.timeSpent} en ${key}` }),
  };
}
