/** Teach: a new part is on the teach spot. Its picture sits in the frame while reup names it and a person says yes. */
import type { Snapshot } from '@reup/contracts';
import { Frame, Plate, Word } from '../../components';
import { hubUrl } from '../../lib/hub';
import type { LiveState } from '../../store/reduce';
import { alertText, BottomBar } from '../common';

export const SURE = { sure: 'sure', fairly_sure: 'fairly sure', not_sure: 'not sure' } as const;

export function Teach({ live }: { live: LiveState }) {
  const s = live.snapshot as Snapshot;
  const teach = s.teach;
  if (!teach) return null;
  const sug = teach.suggestion;
  const zone = s.zones.find((z) => z.id === teach.zoneId)?.name ?? 'Teach spot';
  const settled = teach.status === 'confirmed';
  return (
    <Plate tone="paper" label="New part">
      <Word text="New part" at="top" quiet={!live.connected && !live.mock} />
      <Frame label="The new part" waiting={!settled} settle style={{ left: 730, top: 280, width: 460, height: 600 }}>
        {teach.cropUrl ? <img className="fill mat crop" src={hubUrl(teach.cropUrl)} alt="The new part on the teach spot" /> : <div className="fill mat feed" />}
      </Frame>
      <div className="abs stack" style={{ left: 96, top: 420, width: 560, gap: 22 }}>
        <span className="meta">{zone}</span>
        <p className="copy small" style={{ maxWidth: '21em' }}>Put one unit on the teach spot. reup names it from the store catalog and starts counting it.</p>
      </div>
      <div className="abs stack" style={{ left: 1280, top: 420, width: 580, gap: 22 }}>
        {teach.status === 'needs_confirm' && sug ? (
          <>
            <p className="figure mid">{`Looks like ${sug.name.charAt(0).toLowerCase()}${sug.name.slice(1)}.`}</p>
            <span className="meta">{`${sug.unit}${sug.sku ? ` · Offcut ${sug.sku}` : ' · not in the catalog'} · ${SURE[sug.confidence]}`}</span>
            <p className="copy small" style={{ maxWidth: '19em' }}>Confirm on a phone or the operator page.</p>
          </>
        ) : teach.status === 'failed' ? (
          <>
            <p className="figure mid">Could not name it.</p>
            <p className="copy small" style={{ maxWidth: '19em' }}>Type a name on a phone or the operator page to add it.</p>
          </>
        ) : (
          <p className="figure mid">Naming it.</p>
        )}
      </div>
      <BottomBar credit="Named by Gemini from the store catalog" alert={alertText(live) ?? (teach.status === 'failed' ? (teach.error ?? 'Could not name it.') : null)} />
    </Plate>
  );
}
