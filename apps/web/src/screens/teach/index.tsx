/**
 * Teach: a new part is on the teach spot. Its picture sits in a frame while reup names it and a person says yes.
 * A screen that can say yes also has the board with every box on it, to say where the part sits.
 */
import type { Snapshot, TeachState } from '@reup/contracts';
import { type CSSProperties, useState } from 'react';
import { Frame, Plate, Word } from '../../components';
import { hubUrl, yesKey } from '../../lib/hub';
import type { LiveState } from '../../store/reduce';
import { alertText, BottomBar } from '../common';
import { BoxMaker, useBoxes } from './boxes';
import { SURE, TeachForm } from './form';

export { SURE } from './form';

/** The picture's shape when it has not loaded yet: the teach spot on the station as built, a little taller than wide. */
const SHAPE = 0.89;

/** The frame that holds a picture of this shape (width over height) whole, inside a box of maxW by maxH. The mat is 18 a side. */
export function frameFor(shape: number, maxW: number, maxH: number): { width: number; height: number } {
  const a = shape > 0 && Number.isFinite(shape) ? shape : SHAPE;
  const [w, h] = [maxW - 36, maxH - 36];
  const height = Math.min(h, w / a);
  return { width: Math.round(height * a) + 36, height: Math.round(height) + 36 };
}

/** "Looks like wood screws #8 x 2 in." */
const looksLike = (name: string) => `Looks like ${name.charAt(0).toLowerCase()}${name.slice(1)}.`;

/** The sentence beside the picture is set as large as its length lets it fit. */
const figureSize = (text: string) => (text.length <= 16 ? 68 : text.length <= 40 ? 52 : 40);

/** The picture of the part. The frame takes the picture's own shape, so all of it shows and nothing is cut. */
function Picture({ teach, maxW, maxH, style }: { teach: TeachState; maxW: number; maxH: number; style?: CSSProperties }) {
  const [shape, setShape] = useState(SHAPE);
  return (
    <Frame label="The new part" waiting={teach.status !== 'confirmed'} settle style={{ ...frameFor(shape, maxW, maxH), ...style }}>
      {teach.cropUrl ? (
        <img className="fill mat crop" src={hubUrl(teach.cropUrl)} alt="The new part on the teach spot"
          onLoad={(e) => { const img = e.currentTarget; if (img.naturalWidth > 0 && img.naturalHeight > 0) setShape(img.naturalWidth / img.naturalHeight); }} />
      ) : <div className="fill mat feed" />}
    </Frame>
  );
}

/** A screen that holds a key: the board with its boxes, the picture, the name, and the form right here. */
function Card({ live, teach, bearer }: { live: LiveState; teach: TeachState; bearer: string }) {
  const s = live.snapshot as Snapshot;
  const boxes = useBoxes(s, teach);
  const sug = teach.suggestion;
  const said = teach.status === 'naming' ? 'Naming it.' : teach.status === 'needs_confirm' && sug ? looksLike(sug.name) : 'Type its name.';
  return (
    <>
      <BoxMaker live={live} boxes={boxes} style={{ left: 96, top: 280, width: 1040, height: 601 }} />
      <div className="abs stack teach" style={{ left: 1200, top: 280, width: 660, gap: 24 }}>
        <div className="row">
          <Picture teach={teach} maxW={320} maxH={320} />
          <div className="stack" style={{ gap: 14, minWidth: 0 }}>
            <p className="figure mid" style={{ fontSize: figureSize(said) }}>{said}</p>
            {teach.status === 'needs_confirm' && sug ? <span className="meta">{SURE[sug.confidence]}</span> : null}
          </div>
        </div>
        {teach.status === 'naming' ? null : <TeachForm teach={teach} s={s} bearer={bearer} focus place={boxes.place} />}
      </div>
    </>
  );
}

export function Teach({ live, bearer: given }: { live: LiveState; bearer?: string | null }) {
  const s = live.snapshot as Snapshot;
  const bearer = given !== undefined ? given : yesKey(s);
  const teach = s.teach;
  if (!teach) return null;
  const sug = teach.suggestion;
  return (
    <Plate tone="paper" label="New part">
      <Word text="New part" at="top" quiet={!live.connected && !live.mock} />
      {bearer != null ? (
        // The station's own laptop, or a TV opened with ?k=. A new card starts with fresh boxes.
        <Card key={teach.id} live={live} teach={teach} bearer={bearer} />
      ) : (
        <>
          <Picture teach={teach} maxW={520} maxH={600} style={{ left: 540, top: 280 }} />
          <div className="abs stack" style={{ left: 1120, top: 420, width: 640, gap: 14 }}>
            {teach.status === 'naming' ? (
              <p className="figure mid">Naming it.</p>
            ) : teach.status === 'needs_confirm' && sug ? (
              <>
                <p className="figure mid">{looksLike(sug.name)}</p>
                <span className="meta">{`${sug.unit}${sug.sku ? ` · Offcut ${sug.sku}` : ' · not in the catalog'} · ${SURE[sug.confidence]}`}</span>
                <p className="copy small" style={{ maxWidth: '19em' }}>Confirm on a phone or the operator page.</p>
              </>
            ) : (
              <>
                <p className="figure mid">Could not name it.</p>
                <p className="copy small" style={{ maxWidth: '19em' }}>Type a name on a phone or the operator page to add it.</p>
              </>
            )}
          </div>
        </>
      )}
      <BottomBar credit="Named by Gemini from the store catalog" alert={alertText(live) ?? (teach.status === 'failed' ? (teach.error ?? 'Could not name it.') : null)} />
    </Plate>
  );
}
