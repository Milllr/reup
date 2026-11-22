/** The menu: three bars in the top right corner of every page. It moves between the board, its screens and the other pages. */
import { useEffect, useRef, useState } from 'react';
import { cx } from '../components';
import { param } from '../lib/hub';

export type Look = 'shelf' | 'shop' | 'order' | 'why';
export type Page = '/' | '/analytics' | '/ops' | '/m';

/** The board's own screens, in the operator page's words. Auto hands the choice back to reup. */
export const LOOKS: { look: Look | null; label: string }[] = [
  { look: null, label: 'Auto' },
  { look: 'shelf', label: 'Shelf' },
  { look: 'shop', label: 'Shop' },
  { look: 'order', label: 'Order' },
  { look: 'why', label: 'Why' },
];

export const PAGES: { page: Page; label: string }[] = [
  { page: '/', label: 'Board' },
  { page: '/analytics', label: 'Analytics' },
  { page: '/ops', label: 'Operator' },
  { page: '/m', label: 'Phone' },
];

/** A page's address. It carries what only the address holds: the mock switch and a hub that lives elsewhere. Keys stay with the session. */
export function pageHref(page: Page, get: (name: string) => string | null = param): string {
  const q = new URLSearchParams();
  for (const name of ['mock', 'hub']) {
    const value = get(name);
    if (value) q.set(name, value);
  }
  const query = q.toString();
  return query ? `${page}?${query}` : page;
}

/** Something the board can do from its menu: move the ledges, name what is on the teach spot. */
export interface Action { label: string; run: () => void }

/**
 * On the board, onLook is given and the menu also lists the board's screens: picking one shows it on this screen only.
 * actions are listed last, under their own heading.
 * Inside the stage the menu is placed in stage units. On a page that scrolls it is fixed to the window.
 */
export function Menu({ page, look = null, onLook, actions = [], fixed = false }: { page: Page; look?: Look | null; onLook?: (look: Look | null) => void; actions?: Action[]; fixed?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const bars = useRef<HTMLButtonElement>(null);

  // Focus leaves the bars when the menu shuts, so Enter on the Order screen still means yes.
  const shut = () => {
    setOpen(false);
    bars.current?.blur();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') shut();
    };
    const onDown = (e: PointerEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) shut();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  return (
    <div ref={root} className={cx('menu', fixed && 'fixed')}>
      <button ref={bars} type="button" aria-label="Menu" aria-expanded={open} onClick={() => (open ? shut() : setOpen(true))}>
        <i /><i /><i />
      </button>
      {open ? (
        <nav aria-label="Pages">
          {PAGES.map((p) => <a key={p.page} href={pageHref(p.page)} aria-current={p.page === page ? 'page' : undefined}>{p.label}</a>)}
          {onLook ? (
            <>
              <span className="meta">This screen shows</span>
              {LOOKS.map((l) => (
                <button key={l.label} type="button" aria-pressed={l.look === look} onClick={() => { onLook(l.look); shut(); }}>{l.label}</button>
              ))}
            </>
          ) : null}
          {actions.length > 0 ? (
            <>
              <span className="meta">The board</span>
              {actions.map((a) => (
                <button key={a.label} type="button" onClick={() => { shut(); a.run(); }}>{a.label}</button>
              ))}
            </>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
