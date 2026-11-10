/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * GitHub Pages serves project sites from a sub path (https://<user>.github.io/<repo>/).
 * The deploy workflow sets BASE_PATH to "/<repo>/". Locally it defaults to "/".
 */
function resolveBase(): string {
  const raw = process.env.BASE_PATH?.trim();
  if (!raw) return '/';
  const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

/**
 * Social preview tags need absolute URLs. The deploy workflow sets SITE_URL from the repository
 * owner and name; the fallback is the current public URL.
 */
function siteUrlPlugin(): Plugin {
  const raw = process.env.SITE_URL?.trim() || 'https://huhsoll.github.io/1090web/';
  const siteUrl = raw.endsWith('/') ? raw : `${raw}/`;
  return {
    name: 'site-url',
    transformIndexHtml: (html) => html.replaceAll('__SITE_URL__', siteUrl),
  };
}

export default defineConfig({
  base: resolveBase(),
  plugins: [react(), siteUrlPlugin()],
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
