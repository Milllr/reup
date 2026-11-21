/** The TV: one stage that moves between screens by itself, from snapshot.screen. Nobody clicks during the demo. */
import { useEffect } from 'react';
import { Frame, Plate, Stage, Word, Wordmark } from '../components';
import { call, token } from '../lib/hub';
import { useLive } from '../store/live';
import { useUntil } from './common';
import { Order } from './order';
import { Shelf } from './shelf';
import { Shop } from './shop';
import { Teach } from './teach';
import { Why } from './why';

const KEYS: Record<string, 'shelf' | 'shop' | 'order' | 'why' | null> = { '1': 'shelf', '2': 'shop', '3': 'order', '4': 'why', '0': null };

export function Tv() {
  const live = useLive();
  const s = live.snapshot;
  const counting = useUntil(live.countingUntil);

  // With ?ops=<token>, keys 1 to 4 force a screen and 0 hands control back to the hub.
  useEffect(() => {
    const ops = token('ops');
    if (!ops) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.key in KEYS) || e.metaKey || e.ctrlKey || e.altKey) return;
      const screen = KEYS[e.key] ?? null;
      const snap = live.snapshot;
      const focusProductId = snap?.focusProductId ?? snap?.orders.at(-1)?.productId ?? snap?.products[0]?.id ?? null;
      void call('POST', '/api/demo/screen', { screen, focusProductId: screen ? focusProductId : null }, ops);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [live.snapshot]);

  if (!s) {
    return (
      <Stage>
        <Plate tone="olive" label="Starting">
          <Wordmark className="abs" style={{ left: 48, top: 40 }} />
          <Frame label="Waiting for the hub" waiting style={{ left: 96, top: 118, width: 1150, height: 662 }} />
          <Word text="Starting" quiet />
        </Plate>
      </Stage>
    );
  }
  let screen = <Shelf live={live} />;
  if (s.teach) screen = <Teach live={live} />;
  else if (counting) screen = <Shelf live={live} moment={{ plate: 'olive', word: 'Counting' }} />;
  else if (s.screen === 'shop') screen = <Shop live={live} />;
  else if (s.screen === 'order') screen = <Order live={live} />;
  else if (s.screen === 'why') screen = <Why live={live} />;
  return <Stage>{screen}</Stage>;
}
