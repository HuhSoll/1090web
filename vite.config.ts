/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Build stamp shown with research results (Phase 9I): package version and git commit. */
function buildStamp(): { version: string; commit: string | null; builtAt: string } {
  const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }).version;
  let commit: string | null;
  try {
    commit = execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    commit = null;
  }
  return { version, commit, builtAt: new Date().toISOString().slice(0, 19) + 'Z' };
}

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
  // URL() lowercases the host (the workflow passes the owner name with its original casing).
  const href = new URL(raw).href;
  const siteUrl = href.endsWith('/') ? href : `${href}/`;
  return {
    name: 'site-url',
    transformIndexHtml: (html) => html.replaceAll('__SITE_URL__', siteUrl),
  };
}

export default defineConfig({
  base: resolveBase(),
  plugins: [react(), siteUrlPlugin()],
  define: { __APP_BUILD__: JSON.stringify(buildStamp()) },
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
