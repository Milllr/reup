/** Ask reup: one question about use, stock or orders, one plain answer from the hub's own data. */
import { AskResult } from '@reup/contracts';
import { useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { call, type Reply } from '../../lib/hub';
import { mockAsk } from '../../store/mock';

export const ASK_HINT = 'What did we use most this week?';
export const ASK_EMPTY = 'Ask about use, stock or orders. The answer comes from the counts on this board.';
export const ASK_WAIT = 'Asking.';
export const ASK_FALLBACK = 'Gemini did not answer, so this is reup reading its own numbers.';

export type Ask = (question: string) => Promise<Reply<AskResult>>;

export const askHub: Ask = (question) => call<AskResult>('POST', '/api/ask', { question });
export const askMock: Ask = async () => ({ ok: true, status: 200, data: AskResult.parse(mockAsk), message: null });

type View = { kind: 'empty' } | { kind: 'asking'; question: string } | { kind: 'answer'; question: string; result: AskResult } | { kind: 'error'; question: string; message: string };

/** The small print under an answer: where it came from and what it rests on. */
export function sourceLine(result: AskResult): string {
  if (result.source === 'fallback') return ASK_FALLBACK;
  const n = result.facts.length;
  return n === 0 ? 'Gemini, from the board. The numbers here do not cover it.' : `Gemini, from ${n} ${n === 1 ? 'fact' : 'facts'} on this board.`;
}

export function AskReup({ ask, style }: { ask: Ask; style?: CSSProperties }) {
  const [question, setQuestion] = useState('');
  const [view, setView] = useState<View>({ kind: 'empty' });
  const latest = useRef(0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (q === '' || view.kind === 'asking') return;
    const n = ++latest.current;
    setView({ kind: 'asking', question: q });
    const res = await ask(q);
    if (n !== latest.current) return;
    const parsed = res.ok ? AskResult.safeParse(res.data) : null;
    if (parsed?.success) setView({ kind: 'answer', question: q, result: parsed.data });
    else setView({ kind: 'error', question: q, message: `Could not ask. ${res.message ?? 'The hub sent something unexpected.'}` });
  };

  return (
    <form className="stack ask" style={{ gap: 12, ...style }} onSubmit={(e) => void submit(e)} aria-label="Ask reup">
      <label className="field">
        <span className="meta">Ask reup</span>
        <span className="row" style={{ gap: 10, alignItems: 'stretch' }}>
          <input style={{ flex: 1, minWidth: 0 }} value={question} maxLength={200} placeholder={ASK_HINT} onChange={(e) => setQuestion(e.target.value)} />
          <button className="btn" type="submit" disabled={question.trim() === '' || view.kind === 'asking'}>Ask</button>
        </span>
      </label>
      <div aria-live="polite" className="stack" style={{ gap: 6 }}>
        {view.kind === 'empty' ? <p className="copy small" style={{ opacity: 0.7 }}>{ASK_EMPTY}</p> : null}
        {view.kind === 'asking' ? <p className="copy small">{ASK_WAIT}</p> : null}
        {view.kind === 'answer' ? (
          <>
            <p className="copy small ask-answer">{view.result.answer}</p>
            <span className="meta" style={{ textTransform: 'none', letterSpacing: 0 }}>{sourceLine(view.result)}</span>
          </>
        ) : null}
        {view.kind === 'error' ? <p className="copy small" role="alert">{view.message}</p> : null}
      </div>
    </form>
  );
}
