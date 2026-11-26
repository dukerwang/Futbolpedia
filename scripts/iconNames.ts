import fs from 'fs';
import path from 'path';

/**
 * The Material Symbols names the app's source uses, so index.html can ask Google Fonts for only
 * those glyphs (`icon_names=`) instead of the whole 1.1 MB font. The scan is deliberately loose:
 * a token that isn't an icon name costs nothing, since Google Fonts ignores unknown names, but a
 * missed icon would render as its ligature text. So it reads every quoted token near a
 * `material-symbols` class and every quoted token on a line that mentions an icon.
 */

const SOURCE_DIRS = ['components', 'services', 'constants'];
const SOURCE_FILES = ['App.tsx', 'index.tsx'];
const TOKEN = /['"`>]([a-z][a-z0-9_]{1,40})['"`<]/g;

const listSources = (root: string): string[] => {
  const out: string[] = SOURCE_FILES.map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
    }
  };
  SOURCE_DIRS.forEach((d) => walk(path.join(root, d)));
  return out;
};

export function scanIconNames(root: string): string[] {
  const names = new Set<string>();
  for (const file of listSources(root)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const nearIcon = /material-symbols|icon/i.test(line);
      if (!nearIcon) return;
      // An icon's name sits on the span's line or within the next few (a ternary, a JSX child).
      const window = /material-symbols|ICON_CLASS/.test(line) ? lines.slice(i, i + 4).join('\n') : line;
      for (const m of window.matchAll(TOKEN)) names.add(m[1]);
      // A JSX child on a line of its own: `<span className="material-symbols-outlined">\n  search\n</span>`.
      for (const m of window.matchAll(/^\s*([a-z][a-z0-9_]{1,40})\s*$/gm)) names.add(m[1]);
    });
  }
  return [...names].sort();
}

/** The stylesheet URL for exactly these icons: one weight axis, as the app sets icon weight by font-weight. */
export const iconFontHref = (names: string[]): string =>
  `https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..24,300..600,0,0&icon_names=${names.join(',')}&display=block`;

if (process.argv[1] && /iconNames\.ts$/.test(process.argv[1])) {
  const names = scanIconNames(process.cwd());
  console.log(names.length, names.join(' '));
}
