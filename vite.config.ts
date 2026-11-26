import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { iconFontHref, scanIconNames } from './scripts/iconNames';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        {
          // Asks Google Fonts for only the Material Symbols the source uses (about 30 KB instead of 1.1 MB).
          name: 'icon-font-subset',
          transformIndexHtml: (html: string) => html.replace('%ICON_FONT_HREF%', iconFontHref(scanIconNames(__dirname)).replace(/&/g, '&amp;')),
        },
      ],
      build: {
        rollupOptions: {
          output: {
            // Libraries change far less often than the app, so they cache across deploys.
            manualChunks: (id: string) => {
              if (!id.includes('node_modules')) return undefined;
              if (id.includes('@google/genai')) return 'genai';
              if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
              if (/node_modules\/(marked|dompurify)\//.test(id)) return 'markdown';
              return 'vendor';
            },
          },
        },
      },
      // No key ever reaches the browser bundle: the browser calls Gemini through the server's
      // /gemini-api-proxy (services/aiClient.ts, services/geminiProxy.ts). These stay defined, as
      // empty strings, only so browser code that mentions them doesn't hit an undefined `process`.
      define: {
        'process.env.API_KEY': JSON.stringify(''),
        'process.env.GEMINI_API_KEY': JSON.stringify('')
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
