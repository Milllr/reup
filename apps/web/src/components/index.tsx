/** The shared parts every screen is built from. Each one maps to classes in specimen.css; docs/UI.md is the rulebook. */
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { Tone } from '../lib/view';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

/** The TV is drawn at 1920 by 1080 and scaled to fit the window. */
export function Stage({ children }: { children: ReactNode }) {
  useEffect(() => {
    const fit = () => document.documentElement.style.setProperty('--fit', String(Math.min(window.innerWidth / 1920, window.innerHeight / 1080)));
    fit();
    document.body.classList.add('tv');
    window.addEventListener('resize', fit);
    return () => {
      window.removeEventListener('resize', fit);
      document.body.classList.remove('tv');
    };
  }, []);
  return <div className="stage">{children}</div>;
}

export function Plate({ tone, children, className, style, label }: { tone: Tone; children: ReactNode; className?: string; style?: CSSProperties; label?: string }) {
  return <main className={cx('plate', tone, className)} style={style} aria-label={label}>{children}</main>;
}

/** The size that makes a word span the plate, from its width measured at size 400. Never under 260 or over 540. */
export function wordSize(widthAt400: number, target = 1864): number {
  if (!(widthAt400 > 0)) return 480;
  return Math.max(260, Math.min(540, Math.floor((400 * target) / widthAt400)));
}

/** The same for a phone band, in percent of the band's width, from the word's width measured at 20. */
export function bandWordSize(widthAt20: number, bandWidth: number): number {
  if (!(widthAt20 > 0) || !(bandWidth > 0)) return 28;
  return Math.max(14, Math.min(34, Math.floor(((20 * (bandWidth - 20)) / widthAt20) * 10) / 10));
}

export function Word({ text, at = 'bottom', quiet, band }: { text: string; at?: 'top' | 'bottom'; quiet?: boolean; band?: boolean }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      if (band) {
        el.style.setProperty('--w', '20');
        el.style.setProperty('--w', String(bandWordSize(el.offsetWidth, el.parentElement?.clientWidth ?? 0)));
      } else {
        el.style.setProperty('--size', '400');
        el.style.setProperty('--size', String(wordSize(el.offsetWidth)));
      }
    };
    fit();
    // The word is measured again once its font has loaded: the fallback font has other widths.
    const fonts = document.fonts as FontFaceSet | undefined;
    void fonts?.ready.then(fit);
    void fonts?.load?.('600 100px "Inter Tight Variable"').then(fit, () => {});
    fonts?.addEventListener?.('loadingdone', fit);
    if (band) window.addEventListener('resize', fit);
    return () => {
      fonts?.removeEventListener?.('loadingdone', fit);
      if (band) window.removeEventListener('resize', fit);
    };
  }, [text, band]);
  return <h1 ref={ref} className={cx('word', !band && at, !band && at === 'bottom' && /[gjpqy]/.test(text) && 'tails', quiet && 'quiet')}>{text}</h1>;
}

export function Frame({ children, style, waiting, settle, label, tag, className }: { children?: ReactNode; style?: CSSProperties; waiting?: boolean; settle?: boolean; label: string; tag?: ReactNode; className?: string }) {
  return (
    <section className={cx('frame', waiting && 'waiting', settle && 'settle', className)} style={style} aria-label={label}>
      <i className="h tl" /><i className="h tr" /><i className="h bl" /><i className="h br" />
      {tag}
      {children}
    </section>
  );
}

export function Tag({ children, tone, center, style, className }: { children: ReactNode; tone?: 'blue' | 'pink' | 'cream' | 'alert'; center?: boolean; style?: CSSProperties; className?: string }) {
  return <span className={cx('tag', tone, center && 'center', className)} style={style} role={tone === 'alert' ? 'status' : undefined}>{children}</span>;
}

/** One square per unit of capacity, hollow where a unit was taken. Without a capacity, one square per unit on the board. */
export function Units({ count, capacity }: { count: number; capacity: number | null }) {
  const total = Math.max(count, capacity ?? count);
  if (total === 0 || total > 24) return null;
  return (
    <div className="units" role="img" aria-label={capacity != null ? `${count} of ${capacity} in stock` : `${count} in stock`}>
      {Array.from({ length: total }, (_, i) => <i key={i} className={i < count ? undefined : 'gone'} />)}
    </div>
  );
}

export function Wordmark({ style, className }: { style?: CSSProperties; className?: string }) {
  return (
    <svg className={cx('mark', className)} style={style} xmlns="http://www.w3.org/2000/svg" viewBox="0 8 124.5 60" role="img" aria-label="reup">
      <path d="M8 20V44M8 33A12 12 0 0 1 20 20.5H22.5M33.5 32H57.5A12 12 0 1 0 55.21 39.05M68.5 20V32A12 12 0 0 0 92.5 32V20M92.5 32V60M92.5 20H104.5A12 12 0 0 1 104.5 44H92.5" fill="none" stroke="currentColor" strokeWidth="8.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** "Wood screws #8 x 1-1/4 in" reads as two label lines: the kind, then the size. */
export function labelLines(name: string): [string, string] {
  const m = /^([^#\d]*?)\s*([#\d].*)$/.exec(name.trim());
  const [a, b] = m ? [m[1] ?? '', m[2] ?? ''] : [name, ''];
  return [a.trim().toUpperCase().slice(0, 18), b.trim().toUpperCase().slice(0, 22)];
}

/** The drawn box that sits across the Order frame, with the part's name and unit on its label. Works for any part. */
export function PartBox({ name, unit, style }: { name: string; unit: string; style?: CSSProperties }) {
  const [kind, size] = labelLines(name);
  const mono = "'Geist Mono Variable', monospace";
  return (
    <svg className="subject" style={style} viewBox="0 0 560 420" role="img" aria-label={`A box of ${name}`}>
      <polygon points="60,150 210,95 520,130 380,190" fill="#D9BC8E" />
      <polygon points="60,150 380,190 380,400 60,350" fill="#C49E6E" />
      <polygon points="380,190 520,130 520,330 380,400" fill="#A9845A" />
      <polygon points="205,122 232,112 404,160 372,172" fill="#C49E6E" />
      <g transform="matrix(1,0.125,0,1,0,0)">
        <rect x="92" y="186" width="256" height="104" fill="#F7FBE2" />
        <text x="108" y="222" fontFamily={mono} fontWeight="600" fontSize="22" letterSpacing="1" fill="#1E1A19">{kind}</text>
        <text x="108" y="250" fontFamily={mono} fontWeight="500" fontSize="17" letterSpacing="0.6" fill="#1E1A19">{size}</text>
        <text x="108" y="274" fontFamily={mono} fontWeight="500" fontSize="17" letterSpacing="0.6" fill="#1E1A19">{unit.toUpperCase().slice(0, 22)}</text>
      </g>
    </svg>
  );
}
