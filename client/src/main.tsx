import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initClock } from './clock';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

const render = () =>
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );

/**
 * Ask the server what time it is before the first paint, so nothing ever
 * renders a now/next against an uncorrected device clock — even for one frame.
 * The call is small and its failure is survivable, so it does not gate the app
 * for long or at all when offline: `initClock` resolves either way.
 */
initClock().finally(render);
