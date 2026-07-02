# Futbolpedia AI — design conventions

This is the component set behind Futbolpedia AI, an editorial-style AI football
scouting tool. There is no provider/root wrapper required — components are
plain Tailwind-styled React with no context dependency. Just render them.

## Color vocabulary

Use these custom Tailwind color families — never invent hex values or
default Tailwind grays for surfaces/text that should carry the brand look:

| Family | Shades | Use |
|---|---|---|
| `cream` | `50, 100, 200, 300, 400, 800, 900` | Light-mode surfaces/text. `bg-cream-200` = page background, `bg-cream-100`/`300` = card/bubble surfaces, `text-cream-800` = muted light-mode text |
| `charcoal` | `DEFAULT, surface, light, border` | Dark-mode surfaces/text. `dark:bg-charcoal` = page background, `dark:bg-charcoal-surface`/`-light` = card surfaces, `dark:border-charcoal-border` = borders |
| `emerald` | `400, 500, 600, 900` | The one accent color — active/selected states, primary actions. `bg-emerald-500 hover:bg-emerald-600` |

Always pair light + dark: `bg-cream-200 dark:bg-charcoal text-charcoal dark:text-cream-100`. `darkMode: 'class'` — dark mode is toggled via a `dark` class on a parent, not `prefers-color-scheme`.

Stock Tailwind colors (`gray-*`, `red-*`, `blue-*`, `green-*`) are still available and used for status/semantic cases (errors, rating-scale gradients) — don't replace those with the brand palette.

## Typography

Three font families, set via `fontFamily`:
- `font-serif` → Playfair Display — headings, editorial emphasis, the wordmark ("Futbolpedia AI")
- `font-sans` → Inter (default body face)
- `font-mono` → JetBrains Mono — numeric/stat displays

Prose blocks (AI analysis text) use the `.prose` class with custom overrides already defined in `styles.css` (serif bold-strong, italic serif h3) — reuse `.prose` for any rendered markdown/long-form text rather than hand-rolling typography.

## Other tokens

- `shadow-paper`, `shadow-float`, `shadow-right-depth`, `shadow-dark-float` — custom elevation shadows for cards/panels/flyouts.
- `ease-ios-ease` — custom easing (`cubic-bezier(0.16, 1, 0.3, 1)`) for iOS-style transitions.
- Rounded, soft-surface cards are the norm (`rounded-lg`/`rounded-xl`), not sharp corners.

## Where the truth lives

Read `styles.css` (imports `_ds_bundle.css`, which holds the full compiled Tailwind output plus the custom theme) before styling anything new — it's the authoritative source for every class above. Each component's `.prompt.md` documents its own props.

## Example

```tsx
import { Header, ChatMessage } from 'futbolpedia-ai';

<div className="bg-cream-200 dark:bg-charcoal min-h-screen font-sans">
  <Header
    onNewChat={() => {}}
    toggleTheme={() => {}}
    isDarkMode={false}
    allProfilesCount={2}
    onToggleDossier={() => {}}
    isPanelOpen={false}
    onToggleConversations={() => {}}
    isConversationsOpen={false}
  />
  <main className="max-w-2xl mx-auto p-6">
    <ChatMessage
      message={{ id: '1', sender: 'ai', content: 'Elite dribbler, needs work on defensive positioning.' }}
    />
  </main>
</div>
```
