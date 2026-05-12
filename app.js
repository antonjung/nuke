'use strict';

// ── Dot layout (viewBox 0-100) ──────────────────────────────────────────────
const DOT_POSITIONS = {
  1: [[50, 50]],
  2: [[33, 33], [67, 67]],
  3: [[67, 28], [33, 67], [67, 67]],
};

// ── State ───────────────────────────────────────────────────────────────────
let G = {
  size: 8,
  grid: [],        // grid[r][c] = { p: 'blue'|'red'|null, n: number }
  turn: 'blue',
  over: false,
  busy: false,
  played: { blue: false, red: false },
  epoch: 0,        // incremented on newGame to cancel stale coroutines
};

// ── Grid logic ───────────────────────────────────────────────────────────────

function mkGrid(size) {
  return Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({ p: null, n: 0 }))
  );
}

function neighbors(r, c) {
  const a = [];
  if (r > 0)         a.push([r - 1, c]);
  if (r < G.size - 1) a.push([r + 1, c]);
  if (c > 0)         a.push([r, c - 1]);
  if (c < G.size - 1) a.push([r, c + 1]);
  return a;
}

function capacity(r, c) { return neighbors(r, c).length; }

function needsExplode(r, c) { return G.grid[r][c].n >= capacity(r, c); }

function checkWin() {
  if (!G.played.blue || !G.played.red) return null;
  const live = G.grid.flat().filter(c => c.n > 0);
  if (!live.length) return null;
  const ps = new Set(live.map(c => c.p));
  return ps.size === 1 ? [...ps][0] : null;
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

const $  = id => document.getElementById(id);
const cellEl = (r, c) => document.querySelector(`.cell[data-r="${r}"][data-c="${c}"]`);
const sleep  = ms => new Promise(ok => setTimeout(ok, ms));

function dedup(cells) {
  const seen = new Set();
  return cells.filter(([r, c]) => {
    const k = `${r},${c}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

// ── Dots SVG ─────────────────────────────────────────────────────────────────

function makeDots(count, player) {
  const positions = DOT_POSITIONS[count];
  if (!positions) return null;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'dots-svg');
  svg.setAttribute('aria-hidden', 'true');

  const fill = player === 'blue' ? '#4a9eff' : '#ff4a6e';

  svg.style.filter = `drop-shadow(0 0 4px ${fill})`;

  positions.forEach(([cx, cy]) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', cx);
    c.setAttribute('cy', cy);
    c.setAttribute('r', 11);
    c.setAttribute('fill', fill);
    svg.appendChild(c);
  });

  return svg;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function buildGrid() {
  const wrapper  = $('grid-wrapper');
  const gridEl   = $('grid');
  const avail    = Math.min(wrapper.clientWidth - 28, wrapper.clientHeight - 28);
  const cellPx   = Math.max(28, Math.min(68, Math.floor((avail - (G.size + 1) * 3) / G.size)));
  document.documentElement.style.setProperty('--cell-px', `${cellPx}px`);

  gridEl.style.gridTemplateColumns = `repeat(${G.size}, var(--cell-px))`;
  gridEl.innerHTML = '';

  for (let r = 0; r < G.size; r++) {
    for (let c = 0; c < G.size; c++) {
      const div = document.createElement('div');
      div.className = 'cell';
      div.dataset.r = r;
      div.dataset.c = c;
      div.addEventListener('click', onCellClick);
      gridEl.appendChild(div);
    }
  }
}

function renderCell(r, c) {
  const data = G.grid[r][c];
  const el   = cellEl(r, c);
  if (!el) return;

  // Preserve animation classes while updating colour class
  const animCls = [...el.classList].filter(k => k === 'exploding' || k === 'receiving');
  el.className  = ['cell', data.p || '', ...animCls].filter(Boolean).join(' ');

  el.querySelectorAll('.dots-svg').forEach(s => s.remove());

  if (data.n > 0 && data.p && DOT_POSITIONS[data.n]) {
    const svg = makeDots(data.n, data.p);
    if (svg) el.appendChild(svg);
  }
}

function renderAll() {
  for (let r = 0; r < G.size; r++)
    for (let c = 0; c < G.size; c++)
      renderCell(r, c);
}

function updateHUD() {
  const counts = { blue: 0, red: 0 };
  G.grid.flat().forEach(cell => { if (cell.p) counts[cell.p] += cell.n; });

  $('blue-count').textContent = counts.blue;
  $('red-count').textContent  = counts.red;

  $('blue-ind').classList.toggle('active', G.turn === 'blue');
  $('red-ind').classList.toggle('active',  G.turn === 'red');

  const hud = $('hud');
  hud.classList.toggle('red-turn', G.turn === 'red');
}

// ── Animation ────────────────────────────────────────────────────────────────

async function animateWave(wave) {
  await Promise.all(wave.map(([r, c]) => animateCell(r, c)));
}

async function animateCell(r, c) {
  const el     = cellEl(r, c);
  const data   = G.grid[r][c];
  const player = data.p;
  const nbrs   = neighbors(r, c);

  el.classList.add('exploding');

  const fromRect = el.getBoundingClientRect();
  const fx = fromRect.left + fromRect.width  / 2;
  const fy = fromRect.top  + fromRect.height / 2;

  // Particle size relative to cell
  const pSize = Math.max(8, Math.min(18, fromRect.width * 0.28));

  const particleAnims = nbrs.map(([nr, nc]) => {
    const toEl = cellEl(nr, nc);
    if (!toEl) return Promise.resolve();

    const toRect = toEl.getBoundingClientRect();
    const tx = toRect.left + toRect.width  / 2;
    const ty = toRect.top  + toRect.height / 2;

    const p = document.createElement('div');
    p.className       = `particle ${player}`;
    p.style.width     = `${pSize}px`;
    p.style.height    = `${pSize}px`;
    p.style.left      = `${fx}px`;
    p.style.top       = `${fy}px`;
    document.body.appendChild(p);

    return p.animate(
      [
        { transform: 'translate(-50%,-50%) scale(1.3)', opacity: 1 },
        { transform: `translate(calc(-50% + ${tx - fx}px), calc(-50% + ${ty - fy}px)) scale(0.55)`, opacity: 0.85 },
      ],
      { duration: 300, easing: 'cubic-bezier(0.4,0,1,1)' }
    ).finished.then(() => {
      p.remove();
      // Flash the receiving cell
      toEl.classList.add('receiving');
      setTimeout(() => toEl.classList.remove('receiving'), 260);
    });
  });

  await Promise.all([sleep(320), ...particleAnims]);
  el.classList.remove('exploding');
}

// ── Chain reaction ───────────────────────────────────────────────────────────

async function processChain(initial) {
  const myEpoch = G.epoch;
  let wave = dedup(initial);

  while (wave.length) {
    if (G.epoch !== myEpoch) return;
    await animateWave(wave);
    if (G.epoch !== myEpoch) return;

    for (const [r, c] of wave) {
      const cell = G.grid[r][c];
      if (cell.n < capacity(r, c)) continue; // guard: already drained

      const player = cell.p;
      const nbrs   = neighbors(r, c);

      cell.n -= nbrs.length;
      if (cell.n <= 0) { cell.n = 0; cell.p = null; }

      for (const [nr, nc] of nbrs) {
        G.grid[nr][nc].n++;
        G.grid[nr][nc].p = player;
      }
    }

    renderAll();
    updateHUD();

    if (checkWin()) return; // one player eliminated — stop chain

    // Collect next wave
    const next = [];
    for (let r = 0; r < G.size; r++)
      for (let c = 0; c < G.size; c++)
        if (needsExplode(r, c)) next.push([r, c]);

    wave = dedup(next);
  }
}

// ── Click handler ─────────────────────────────────────────────────────────────

async function onCellClick(e) {
  if (G.over || G.busy) return;

  const r    = +e.currentTarget.dataset.r;
  const c    = +e.currentTarget.dataset.c;
  const cell = G.grid[r][c];

  if (cell.p && cell.p !== G.turn) return;

  const myEpoch = G.epoch;
  G.busy = true;
  G.played[G.turn] = true;

  cell.p = G.turn;
  cell.n++;

  renderCell(r, c);
  updateHUD();

  if (needsExplode(r, c)) {
    await processChain([[r, c]]);
  }

  if (G.epoch !== myEpoch) return; // game was reset during chain reaction

  const winner = checkWin();
  if (winner) {
    G.over = true;
    showWin(winner);
  } else {
    G.turn = G.turn === 'blue' ? 'red' : 'blue';
    updateHUD();
  }

  G.busy = false;
}

// ── Win screen ───────────────────────────────────────────────────────────────

function showWin(player) {
  const orb   = $('win-orb');
  const label = $('win-label');
  orb.className   = player;
  label.className = player;
  label.textContent = player === 'blue' ? 'Blue Wins!' : 'Red Wins!';
  $('win-modal').classList.remove('hidden');
}

// ── New game ──────────────────────────────────────────────────────────────────

function newGame() {
  G.epoch++;
  G.size   = +$('grid-size').value;
  G.grid   = mkGrid(G.size);
  G.turn   = 'blue';
  G.over   = false;
  G.busy   = false;
  G.played = { blue: false, red: false };

  $('win-modal').classList.add('hidden');
  buildGrid();
  renderAll();
  updateHUD();
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

$('new-game').addEventListener('click', newGame);
$('play-again').addEventListener('click', newGame);
$('grid-size').addEventListener('change', newGame);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!G.busy) { buildGrid(); renderAll(); updateHUD(); }
  }, 150);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () =>
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  );
}

document.addEventListener('DOMContentLoaded', newGame);
