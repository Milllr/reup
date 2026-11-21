import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { liveUrl, param } from './lib/hub';
import { Ops } from './screens/ops';
import { Phone } from './screens/phone';
import { Tv } from './screens/tv';
import { store } from './store/live';
import { mockMessages, mockSnapshot } from './store/mock';
import './styles/specimen.css';
import './styles/app.css';

const path = location.pathname.replace(/\/+$/, '');

if (param('mock') === '1') {
  // No hub: start from contracts/mocks. Without ?at= the sample messages play on a timer, one every 2 seconds.
  const snapshot = mockSnapshot(param('at'));
  store.set({ snapshot, mock: true, connected: true, syncedAt: snapshot.now });
  if (!param('at')) {
    const queue = mockMessages();
    const timer = setInterval(() => {
      const next = queue.shift();
      if (next) store.receive(next);
      else clearInterval(timer);
    }, 2000);
  }
} else {
  store.connect(liveUrl(path === '/ops' ? 'ops' : 'screen'));
  setInterval(() => store.ping(), 20_000);
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode>{path === '/m' ? <Phone /> : path === '/ops' ? <Ops /> : <Tv />}</StrictMode>);
