import { useEffect, useState } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'ca-theme';

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(p: ThemePref) {
  const root = document.documentElement;
  if (p === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', p);
  try {
    if (p === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {
    /* storage unavailable: preference lasts for this page only */
  }
  // keep the browser UI colour in step with the effective theme
  const dark =
    p === 'dark' || (p === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#141613' : '#16402F');
}

/** Theme preference shared across components (light / dark / system). */
export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(read);
  useEffect(() => {
    const onChange = () => setPref(read());
    window.addEventListener('ca-theme', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('ca-theme', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return [
    pref,
    (p) => {
      applyTheme(p);
      setPref(p);
      window.dispatchEvent(new Event('ca-theme'));
    },
  ];
}

export function ThemeToggle({ compact }: { compact?: boolean }) {
  const [pref, set] = useTheme();
  const opts: [ThemePref, string, string][] = [
    ['light', 'Light', '☀'],
    ['dark', 'Dark', '☾'],
    ['system', 'System', '◐'],
  ];
  return (
    <div className="seg theme-seg" role="radiogroup" aria-label="Colour theme">
      {opts.map(([v, label, icon]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={pref === v}
          aria-pressed={pref === v}
          onClick={() => set(v)}
          title={`${label} theme`}
        >
          <span aria-hidden="true">{icon}</span>
          {!compact && <span className="theme-label"> {label}</span>}
          {compact && <span className="sr-only">{label}</span>}
        </button>
      ))}
    </div>
  );
}
