import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './app/error-boundary';
import './globals.css';

const surface = new URLSearchParams(window.location.search).get('surface') ?? 'main';
document.documentElement.dataset.surface = surface;

const App = lazy(() => import('./app/App').then((m) => ({ default: m.App })));
const OverlayRoot = lazy(() => import('./app/overlay-root').then((m) => ({ default: m.OverlayRoot })));
const PopoverRoot = lazy(() => import('./app/popover-root').then((m) => ({ default: m.PopoverRoot })));

const Root = surface === 'overlay' ? OverlayRoot : surface === 'popover' ? PopoverRoot : App;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Suspense fallback={null}>
        <Root />
      </Suspense>
    </ErrorBoundary>
  </React.StrictMode>,
);
