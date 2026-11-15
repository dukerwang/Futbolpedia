import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import satori from 'satori';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import type { PlayerProfile } from '../types';
import { describeCardEdition } from '../components/pills';
import { getShortTierLabel } from '../constants/ratingTiers';
import { traitTitle } from './cardTraits';
import { IMAGE_HEIGHT, IMAGE_WIDTH } from './shareMeta';
import type { ChatPage } from './sharePages';

/**
 * Link preview images, drawn on the server: the cream headline layout for a card (rating, name,
 * archetype, share line, strength chips) and for a shared chat (the opening question and the
 * cards it discusses). satori lays the tree out as SVG and resvg's WebAssembly build turns it into
 * a 1200×630 PNG, so nothing depends on the host's native libraries. Server only.
 */

/** Playfair's default figures are old-style (a 9 drops below the line); ratings use lining figures. */

/** The app's own tokens (the Tailwind config in index.html). */
const COLORS = {
  cream: '#F5F2E9',
  creamLight: '#FAF9F6',
  ink: '#1A1F2E',
  muted: '#8C8982',
  rule: '#D6D3CA',
  emerald: '#059669',
  emeraldSoft: 'rgba(16, 185, 129, 0.12)',
  emeraldInk: '#064E3B',
};

type Node = { type: string; props: Record<string, unknown> };
type Child = Node | string | null | undefined | false;

/** A satori element, without React. */
function h(type: string, style: Record<string, unknown>, ...children: Child[]): Node {
  const kids = children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false);
  return { type, props: { style: { display: 'flex', ...style }, children: kids.length === 1 ? kids[0] : kids } };
}

const require = createRequire(import.meta.url);
const font = (pkg: string, file: string): Buffer => readFileSync(require.resolve(`${pkg}/files/${file}`));

let fontsCache: Parameters<typeof satori>[1]['fonts'] | null = null;
function fonts(): Parameters<typeof satori>[1]['fonts'] {
  if (fontsCache) return fontsCache;
  const set: Parameters<typeof satori>[1]['fonts'] = [];
  for (const subset of ['latin', 'latin-ext']) {
    set.push(
      { name: 'Playfair Display', data: font('@fontsource/playfair-display', `playfair-display-${subset}-700-normal.woff`), weight: 700, style: 'normal' },
      { name: 'Playfair Display', data: font('@fontsource/playfair-display', `playfair-display-${subset}-700-italic.woff`), weight: 700, style: 'italic' },
      { name: 'Inter', data: font('@fontsource/inter', `inter-${subset}-400-normal.woff`), weight: 400, style: 'normal' },
      { name: 'Inter', data: font('@fontsource/inter', `inter-${subset}-600-normal.woff`), weight: 600, style: 'normal' },
      { name: 'JetBrains Mono', data: font('@fontsource/jetbrains-mono', `jetbrains-mono-${subset}-500-normal.woff`), weight: 500, style: 'normal' },
    );
  }
  fontsCache = set;
  return set;
}

let wasmReady: Promise<void> | null = null;
function ensureWasm(): Promise<void> {
  wasmReady ??= initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'))).catch((err) => {
    wasmReady = null;
    throw err;
  });
  return wasmReady;
}

async function toPng(tree: Node): Promise<Buffer> {
  const [svg] = await Promise.all([
    satori(tree as unknown as Parameters<typeof satori>[0], { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, fonts: fonts() }),
    ensureWasm(),
  ]);
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: IMAGE_WIDTH } });
  const png = resvg.render().asPng();
  resvg.free();
  return Buffer.from(png);
}

/** Cuts text at a word boundary with an ellipsis. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const breakAt = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('-'));
  return `${(breakAt > max * 0.5 ? cut.slice(0, breakAt) : cut).replace(/[\s,;:.–&-]+$/, '')}…`;
}

/** Shrinks a headline's type for long text, down to a floor. */
const fitSize = (text: string, base: number, fitsChars: number, floor: number): number =>
  text.length <= fitsChars ? base : Math.max(floor, Math.round((base * fitsChars) / text.length));

const mono = (size: number, color: string, text: string, extra: Record<string, unknown> = {}): Node =>
  h('div', { fontFamily: 'JetBrains Mono', fontWeight: 500, fontSize: size, letterSpacing: size * 0.16, textTransform: 'uppercase', color, ...extra }, text);

/**
 * The 1200×630 canvas. Padding goes on an inner box: on the root, satori adds it to the fixed
 * width and height and the layout runs off the image.
 */
const frame = (inner: Record<string, unknown>, ...children: Child[]): Node =>
  h(
    'div',
    { width: IMAGE_WIDTH, height: IMAGE_HEIGHT, background: COLORS.cream, color: COLORS.ink, fontFamily: 'Inter' },
    h('div', { flex: 1, flexDirection: 'column', ...inner }, ...children),
  );

const topBar = (right: string): Node =>
  h(
    'div',
    { justifyContent: 'space-between', alignItems: 'center' },
    mono(20, COLORS.emerald, 'Futbolpedia'),
    mono(18, COLORS.muted, right),
  );

/** Characters of chip text that fit on the image's one row of chips. */
const CHIP_ROW_CHARS = 80;

/**
 * The first strength titles that fit on one row: three when they're short enough, otherwise two,
 * each cut at a word only when one title alone is too long.
 */
export function strengthChips(card: PlayerProfile): string[] {
  const titles = (card.strengths ?? []).map((line) => traitTitle(line)).filter(Boolean);
  for (const count of [3, 2]) {
    const chips = titles.slice(0, count);
    if (chips.reduce((n, t) => n + t.length, 0) <= CHIP_ROW_CHARS) return chips;
  }
  return titles.slice(0, 2).map((t) => clip(t, CHIP_ROW_CHARS / 2));
}

export function cardImageTree(card: PlayerProfile): Node {
  const name = card.basicInfo?.name ?? '';
  const overall = card.ratings?.overall ?? 0;
  const archetype = card.playstyleAndRole?.playstyle?.archetype?.trim();
  const role = [card.basicInfo?.position?.split('/')[0], card.basicInfo?.club, overall ? getShortTierLabel(overall) : '']
    .filter((s) => s && s !== 'N/A')
    .join(' · ');
  const chips = strengthChips(card);
  const quote = card.shareLine ? clip(card.shareLine, 140) : '';

  return frame(
    { padding: '60px 76px 56px' },
    topBar(describeCardEdition(card).label),
    h(
      'div',
      { alignItems: 'flex-end', marginTop: 'auto' },
      h('div', { fontFamily: 'Playfair Display', fontWeight: 700, fontVariantNumeric: 'lining-nums', fontSize: 168, lineHeight: 0.82, color: COLORS.emerald, marginRight: 36, letterSpacing: -4 }, String(overall)),
      h(
        'div',
        { flexDirection: 'column', flex: 1, paddingBottom: 6 },
        h('div', { fontFamily: 'Playfair Display', fontWeight: 700, fontSize: fitSize(name, 64, 18, 40), lineHeight: 1.02 }, clip(name, 34)),
        archetype ? h('div', { fontFamily: 'Playfair Display', fontStyle: 'italic', fontWeight: 700, fontSize: 30, marginTop: 10, color: COLORS.ink, opacity: 0.85 }, clip(archetype, 48)) : null,
        role ? h('div', { fontSize: 24, marginTop: 8, color: COLORS.muted }, role) : null,
      ),
    ),
    quote
      ? h('div', { fontFamily: 'Playfair Display', fontStyle: 'italic', fontWeight: 700, fontSize: 27, lineHeight: 1.35, marginTop: 30, color: COLORS.ink, opacity: 0.8 }, `“${quote}”`)
      : null,
    chips.length
      ? h(
          'div',
          { marginTop: quote ? 22 : 34, paddingTop: 22, borderTop: `2px solid ${COLORS.rule}`, overflow: 'hidden' },
          ...chips.map((c) =>
            h('div', { flexShrink: 0, fontSize: 20, fontWeight: 600, color: COLORS.emeraldInk, background: COLORS.emeraldSoft, borderRadius: 999, padding: '8px 16px', marginRight: 10 }, c),
          ),
        )
      : null,
  );
}

export function chatImageTree(page: Pick<ChatPage, 'title' | 'question' | 'replies' | 'cards'>): Node {
  const headline = page.question || page.title;
  const showTitle = !!page.question && page.title && page.title !== page.question;
  const quoted = page.question ? `“${clip(headline, 120)}”` : clip(headline, 120);
  return frame(
    { padding: '60px 76px 56px' },
    topBar(`Conversation · ${page.replies} ${page.replies === 1 ? 'reply' : 'replies'}`),
    h('div', { fontFamily: 'Playfair Display', fontWeight: 700, fontSize: fitSize(quoted, 60, 60, 40), lineHeight: 1.14, marginTop: 'auto' }, quoted),
    showTitle ? h('div', { fontSize: 24, marginTop: 14, color: COLORS.muted }, clip(page.title, 80)) : null,
    page.cards.length
      ? h(
          'div',
          { marginTop: 28, paddingTop: 22, borderTop: `2px solid ${COLORS.rule}` },
          ...page.cards.slice(0, 4).map((c) =>
            h(
              'div',
              { alignItems: 'center', background: COLORS.creamLight, border: `2px solid ${COLORS.rule}`, borderRadius: 14, padding: '10px 18px 10px 12px', marginRight: 14 },
              h('div', { fontFamily: 'Playfair Display', fontWeight: 700, fontVariantNumeric: 'lining-nums', fontSize: 36, color: COLORS.emerald, marginRight: 12, minWidth: 48, justifyContent: 'center' }, String(c.ratings?.overall ?? '')),
              h(
                'div',
                { flexDirection: 'column' },
                h('div', { fontSize: 20, fontWeight: 600 }, clip(c.basicInfo?.name ?? '', page.cards.length > 2 ? 16 : 24)),
                h('div', { fontSize: 16, color: COLORS.muted, marginTop: 2 }, describeCardEdition(c).label),
              ),
            ),
          ),
        )
      : null,
  );
}

export function defaultImageTree(): Node {
  return frame(
    { justifyContent: 'center', padding: '0 96px' },
    mono(22, COLORS.emerald, 'futbolpedia.org'),
    h('div', { fontFamily: 'Playfair Display', fontWeight: 700, fontSize: 96, marginTop: 18 }, 'Futbolpedia'),
    h('div', { fontSize: 32, marginTop: 18, color: COLORS.muted, lineHeight: 1.35 }, 'Every player on one all-time scale, and an analyst to argue it with.'),
  );
}

export const renderCardImage = (card: PlayerProfile): Promise<Buffer> => toPng(cardImageTree(card));
export const renderChatImage = (page: Pick<ChatPage, 'title' | 'question' | 'replies' | 'cards'>): Promise<Buffer> => toPng(chatImageTree(page));
export const renderDefaultImage = (): Promise<Buffer> => toPng(defaultImageTree());
