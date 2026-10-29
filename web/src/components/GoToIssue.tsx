import { useEffect, useRef, useState } from 'react';
import { toast } from '../toast';
import { Icon } from './icons';

const KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

/**
 * Accepts a key ("ABC-123"), a bare number (uses `projectKey`), a Jira URL
 * (/browse/ABC-123 or ?selectedIssue=ABC-123) or a link to this app (?issue=ABC-123).
 */
export function parseIssueKey(input: string, projectKey?: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return projectKey ? `${projectKey}-${s}` : null;
  const up = s.toUpperCase();
  if (KEY.test(up)) return up;
  try {
    const url = new URL(s);
    const hashQuery = new URLSearchParams(url.hash.split('?')[1] ?? '');
    const candidates = [
      url.searchParams.get('selectedIssue'),
      url.searchParams.get('issue'),
      hashQuery.get('issue'),
      url.pathname.match(/\/browse\/([^/?#]+)/)?.[1],
      url.pathname.split('/').pop(),
    ];
    for (const c of candidates) {
      const k = c && decodeURIComponent(c).toUpperCase();
      if (k && KEY.test(k)) return k;
    }
  } catch {
    // Not a URL: fall through.
  }
  return null;
}

export function GoToIssue({ projectKey, onOpen }: { projectKey?: string; onOpen: (key: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const submit = () => {
    const key = parseIssueKey(value, projectKey);
    if (!key) return toast('No reconozco esa clave o URL', 'error');
    onOpen(key);
    setValue('');
    ref.current?.blur();
  };

  return (
    <form
      className="search goto"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Icon.Search />
      <input
        ref={ref}
        value={value}
        placeholder="Abrir ticket, ID o URL…"
        onChange={(e) => setValue(e.target.value)}
        onPaste={(e) => {
          // A pasted URL or key opens straight away.
          const key = parseIssueKey(e.clipboardData.getData('text'), projectKey);
          if (!key) return;
          e.preventDefault();
          onOpen(key);
          setValue('');
          e.currentTarget.blur();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setValue('');
            e.currentTarget.blur();
          }
        }}
      />
      <kbd>⌘K</kbd>
    </form>
  );
}
