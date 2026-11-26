import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);

// The reply-view and Gaffa chip galleries exist only in dev: `import.meta.env.DEV` is false in a production
// build, so Vite drops this branch and its chunk is never emitted.
if (import.meta.env.DEV && window.location.pathname.replace(/\/$/, '') === '/dev/blocks') {
  import('./components/views/BlocksGallery').then(({ BlocksGallery }) => {
    root.render(
      <React.StrictMode>
        <BlocksGallery />
      </React.StrictMode>
    );
  });
} else if (import.meta.env.DEV && window.location.pathname.replace(/\/$/, '') === '/dev/gaffa-chip') {
  import('./components/GaffaChipGallery').then(({ GaffaChipGallery }) => {
    root.render(
      <React.StrictMode>
        <GaffaChipGallery />
      </React.StrictMode>
    );
  });
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
