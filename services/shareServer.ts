import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { parsePath, addressPath, chatPath } from './cardPaths';
import {
  resolveCardPage,
  resolveChatPage,
  SharePageCache,
  storeReads,
  type CardPage,
  type ChatPageResult,
  type ShareReads,
} from './sharePages';
import {
  cardImagePath,
  cardImageVersion,
  cardMeta,
  chatImagePath,
  chatImageVersion,
  chatMeta,
  injectMeta,
  notFoundMeta,
  parseImageFile,
} from './shareMeta';
import { renderCardImage, renderChatImage, renderDefaultImage } from './shareImage';

/**
 * The server side of shareable links. `/p/…` and `/c/<code>` send the app's index.html with that
 * card's or chat's tags in place of the default ones, and `/og/…` serves the preview images,
 * drawn once per card version and kept in memory and on disk. Nothing here calls a model.
 */

export interface ShareServerOptions {
  /** The app's index.html for this request (in development, after Vite's transform). */
  html(req: Request): Promise<string>;
  reads?: ShareReads;
  /** Where images are kept between restarts; null keeps them in memory only. */
  cacheDir?: string | null;
  now?: () => number;
}

const IMAGE_CACHE_MAX = 300;
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** The origin this request came in on, so a preview's image loads from the server that drew it. */
function requestOrigin(req: Request): string {
  const host = req.get('x-forwarded-host')?.split(',')[0].trim() || req.get('host') || 'futbolpedia.org';
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const forwarded = req.get('x-forwarded-proto')?.split(',')[0].trim();
  return `${forwarded || (local ? req.protocol : 'https')}://${host}`;
}

/** A small least-recently-used store for rendered PNGs. */
class ImageCache {
  private entries = new Map<string, Buffer>();
  private inflight = new Map<string, Promise<Buffer>>();

  constructor(private dir: string | null) {}

  private remember(key: string, png: Buffer) {
    this.entries.delete(key);
    this.entries.set(key, png);
    while (this.entries.size > IMAGE_CACHE_MAX) this.entries.delete(this.entries.keys().next().value!);
  }

  async get(key: string, render: () => Promise<Buffer>): Promise<{ png: Buffer; source: 'memory' | 'disk' | 'render' }> {
    const hit = this.entries.get(key);
    if (hit) {
      this.remember(key, hit);
      return { png: hit, source: 'memory' };
    }
    const file = this.dir ? path.join(this.dir, `${key.replace(/[^a-zA-Z0-9_.-]/g, '_')}.png`) : null;
    if (file) {
      const disk = await fs.readFile(file).catch(() => null);
      if (disk) {
        this.remember(key, disk);
        return { png: disk, source: 'disk' };
      }
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = render().finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const png = await pending;
    this.remember(key, png);
    if (file) {
      fs.mkdir(path.dirname(file), { recursive: true })
        .then(() => fs.writeFile(file, png))
        .catch((err) => console.warn('[share] image not kept on disk:', err?.message || err));
    }
    return { png, source: 'render' };
  }
}

export function registerShareRoutes(app: Express, options: ShareServerOptions): void {
  const reads = options.reads ?? storeReads();
  const now = options.now ?? Date.now;
  const cardPages = new SharePageCache<CardPage>();
  const chatPages = new SharePageCache<ChatPageResult>();
  const images = new ImageCache(options.cacheDir === undefined ? path.join(process.cwd(), '.cache', 'og') : options.cacheDir);
  let defaultImage: Promise<Buffer> | null = null;

  const keep = (v: { kind: string }) => v.kind !== 'unavailable';

  const sendPage = async (req: Request, res: Response, status: number, block: string | null, label: string) => {
    const html = await options.html(req);
    console.log(`[share] ${req.path} → ${label}`);
    res.status(status).type('html').setHeader('Cache-Control', 'public, max-age=300');
    res.send(block ? injectMeta(html, block) : html);
  };

  const sendPng = (res: Response, png: Buffer, cache = IMMUTABLE) => {
    res.status(200).type('png').setHeader('Cache-Control', cache);
    res.send(png);
  };

  const toDefaultImage = (res: Response) => res.redirect(302, '/og/default.png');

  app.get('/og/default.png', async (_req, res) => {
    try {
      defaultImage ??= renderDefaultImage().catch((err) => {
        defaultImage = null;
        throw err;
      });
      sendPng(res, await defaultImage, 'public, max-age=86400');
    } catch (err: any) {
      console.error('[share] default image failed:', err?.message || err);
      res.status(500).end();
    }
  });

  app.get('/og/p/:file', async (req, res) => {
    const started = now();
    const parsed = parseImageFile(String(req.params.file));
    if (!parsed) return res.status(404).end();
    try {
      const card = await reads.readSlug(parsed.key);
      if (!card) return toDefaultImage(res);
      const version = cardImageVersion(card);
      if (version !== parsed.version) {
        const current = cardImagePath(card);
        return current ? res.redirect(302, current) : toDefaultImage(res);
      }
      const { png, source } = await images.get(`p-${parsed.key}-${version}`, () => renderCardImage(card));
      console.log(`[share] image ${parsed.key} ${source} ${now() - started}ms`);
      sendPng(res, png);
    } catch (err: any) {
      console.error('[share] card image failed:', err?.message || err);
      toDefaultImage(res);
    }
  });

  app.get('/og/c/:file', async (req, res) => {
    const started = now();
    const parsed = parseImageFile(String(req.params.file));
    if (!parsed) return res.status(404).end();
    try {
      const page = await chatPages.get(parsed.key.toUpperCase(), () => resolveChatPage(parsed.key, reads), keep, now());
      if (page.kind !== 'chat') return toDefaultImage(res);
      const version = chatImageVersion(page);
      if (version !== parsed.version) return res.redirect(302, chatImagePath(page));
      const { png, source } = await images.get(`c-${page.code}-${version}`, () => renderChatImage(page));
      console.log(`[share] image chat ${page.code} ${source} ${now() - started}ms`);
      sendPng(res, png);
    } catch (err: any) {
      console.error('[share] chat image failed:', err?.message || err);
      toDefaultImage(res);
    }
  });

  app.get('/p/*rest', async (req, res, next) => {
    try {
      const parsed = parsePath(req.path);
      const origin = requestOrigin(req);
      if (!parsed || parsed.kind !== 'card') {
        return sendPage(req, res, 404, notFoundMeta(req.path, origin), 'not an address');
      }
      const canonicalPath = addressPath(parsed.address);
      if (!parsed.canonical) return res.redirect(301, canonicalPath);
      const page = await cardPages.get(canonicalPath, () => resolveCardPage(parsed.address, reads, now()), keep, now());
      switch (page.kind) {
        case 'card':
          return sendPage(req, res, 200, cardMeta(page, origin), 'card');
        case 'redirect':
          console.log(`[share] ${req.path} → ${page.to}`);
          return res.redirect(301, page.to);
        case 'not_found':
          return sendPage(req, res, 404, notFoundMeta(canonicalPath, origin, page.player), 'not found');
        default:
          return sendPage(req, res, 200, null, 'store unavailable, default tags');
      }
    } catch (err) {
      next(err);
    }
  });

  app.get('/c/:code', async (req, res, next) => {
    try {
      const parsed = parsePath(req.path);
      const origin = requestOrigin(req);
      if (!parsed || parsed.kind !== 'chat') return sendPage(req, res, 404, notFoundMeta(req.path, origin), 'not an address');
      if (!parsed.canonical) return res.redirect(301, chatPath(parsed.code));
      const page = await chatPages.get(parsed.code, () => resolveChatPage(parsed.code, reads), keep, now());
      if (page.kind === 'chat') return sendPage(req, res, 200, chatMeta(page, origin), 'chat');
      if (page.kind === 'not_found') return sendPage(req, res, 404, notFoundMeta(req.path, origin), 'chat not found');
      return sendPage(req, res, 200, null, 'store unavailable, default tags');
    } catch (err) {
      next(err);
    }
  });
}

/** The production index.html, read once. */
export function builtIndexHtml(distPath: string): () => Promise<string> {
  let html: Promise<string> | null = null;
  return () => (html ??= fs.readFile(path.join(distPath, 'index.html'), 'utf8'));
}
