import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { OverlayRoot } from './app/overlay-root';
import { PopoverRoot } from './app/popover-root';
import { ErrorBoundary } from './app/error-boundary';
import './globals.css';

const surface = new URLSearchParams(window.location.search).get('surface') ?? 'main';
document.documentElement.dataset.surface = surface;

const Root = surface === 'overlay' ? OverlayRoot : surface === 'popover' ? PopoverRoot : App;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>,
);
