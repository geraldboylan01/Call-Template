# Call Template Canvas (Phase 1 MVP)

Single-page, no-backend web app for live client calls with a Prezi-style focused/overview flow.

## Run Locally

1. Open `index.html` directly in a browser.
2. Optional: serve with any static server (`python -m http.server`, `npx serve`, etc.) for stricter module behavior.

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. In repository settings, open **Pages**.
3. Set source to your main branch root (`/`) and save.
4. Your site will publish at the provided Pages URL.

## How To Use

- Start with greeting: `Hello Client!`
- Change client name in the top-left input.
- Click `New Module` (or press `N` / `ArrowRight`) to create and move to a new module.
- Edit module title + notes (autosaved to `localStorage`).
- Click `Zoom Out` (or press `O`) to view all modules fitted on one screen.
- Drag cards in overview to reorder (SortableJS).
- Click any overview card to zoom back into that module.
- Press `ArrowLeft` for previous module in focused mode.
- Press `Esc` to exit overview back to focused.
- Click `Reset` to clear session and return to greeting.

## Keyboard Shortcuts

- `N`: New module
- `O`: Toggle overview
- `ArrowRight`: New module
- `ArrowLeft`: Previous module
- `Esc`: Exit overview

## File Structure

- `index.html`
- `styles/base.css`
- `js/state.js`
- `js/layout.js`
- `js/zoom.js`
- `js/swipe.js`
- `js/render.js`
- `js/app.js`
