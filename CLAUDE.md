# nuke

## overview
A PWA chain-reaction strategy game playable on a single device. Built with vanilla JS, CSS, and Three.js for 3D mode. Service worker provides offline support.

## rules of the game

- Two players: Blue and Red
- Take turns placing one counter on any empty cell or a cell you already own
- When a cell holds as many counters as it has neighbours it **explodes** — counters fly out to every neighbour
- Captured neighbours change to the exploding player's colour
- Chain reactions continue until the board is stable
- Win by being the only player with counters remaining

Cell capacity by position:
- Corner cells: 2 neighbours
- Edge cells: 3 neighbours
- Inner cells: 4 neighbours
- 3D surface cells: varies (2–5 neighbours on cube surface)

## files

- `index.html` — shell, options bar, HUD, result banner, modals
- `app.js` — 2D game logic, AI, animation, state (`G`), version constant `VERSION`
- `game3d.js` — 3D game (Three.js IIFE exposed as `window.Game3D`), own local `G`
- `styles.css` — all styles including animation keyframes and CSS custom properties
- `sw.js` — service worker; `CACHE` name must be bumped whenever `VERSION` in `app.js` changes

## options (UI)

| Select | Values |
|---|---|
| Board | 2D / 3D |
| Mode | vs Human / AI Easy / AI Medium / AI Hard |
| Who goes first | Blue / Red |
| Grid size (2D) | 4×4 to 12×12, default 6×6 |
| Cube size (3D) | 3×3×3 / 4×4×4 |
| Animation speed | Fast (1×) / Normal (1.7×, default) / Slow (2.8×) |

## animation

### 2D
- CSS keyframe animations: `explode-*`, `receive-*`, `capture-flash-*`
- CSS custom properties `--anim-explode`, `--anim-recv`, `--anim-capture` are updated by JS when speed changes
- Particle divs fly from exploding cell to neighbours using the Web Animations API
- Critical cells (one counter from exploding) get a static glow via `.critical` class
- Captured cells flash white → player colour via `.capturing` class

### 3D (Three.js)
- Cells are `BoxGeometry` + `EdgesGeometry` LineSegments on the surface of an N×N×N cube
- Counters are grey `SphereGeometry` dots offset inside each cell
- Render loop drives: targeted rotation (lerp toward explosion/AI move), critical cell edge pulse, `matAnims` colour lerp
- `matAnims` Map: smooth per-cell colour/opacity transitions triggered by `renderAll()`
- `animateElectrons()`: quadratic bezier sphere arcs fly from exploding cells to neighbours
- `flashExplode/Receive/Capture`: scale + emissive pulse via `animatePulse()`
- Explosion logic applied mid-electron-flight so colour transitions are visible during travel
- `window.ANIM_SCALE` scales all 3D animation durations; `T(ms)` helper used throughout
- `aimAt()`: rotates cube toward explosion centroid or AI chosen cell before placement

## AI
- Easy: random valid move
- Medium: 1-ply (picks best immediate score)
- Hard: 2-ply minimax with 6 opponent samples
- Think time: 900–1700ms mid-game, 700–1400ms opening (unaffected by speed setting)
- AI rotates cube to chosen cell before placing (preview pause)

## win / game end
- No modal overlay — board stays fully visible
- `#result-bar`: full-width coloured banner appears between options bar and board showing "YOU Win!" / "CPU Wins!" / "Blue Wins!" / "Red Wins!" with pulsing glow
- Winning player's HUD indicator gets `won` class (pulsing border glow)
- Turn arrow becomes ★ in winner's colour
- "New Game" button (footer) resets everything

## service worker / versioning
- Bump `VERSION` in `app.js` and `CACHE` in `sw.js` together on every release
- Current version: 2.3.5
