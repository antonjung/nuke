'use strict';

const VERSION = '2.5.1';

// ── Dot layout (viewBox 0-100) ──────────────────────────────────────────────
const DOT_POSITIONS = {
  1: [[50, 50]],
  2: [[33, 33], [67, 67]],
  3: [[67, 28], [33, 67], [67, 67]],
  4: [[33, 33], [67, 33], [33, 67], [67, 67]],
  5: [[33, 33], [67, 33], [50, 50], [33, 67], [67, 67]],
  6: [[33, 22], [67, 22], [33, 50], [67, 50], [33, 78], [67, 78]],
  7: [[25, 22], [75, 22], [25, 50], [50, 50], [75, 50], [25, 78], [75, 78]],
  8: [[20, 22], [50, 22], [80, 22], [20, 50], [80, 50], [20, 78], [50, 78], [80, 78]],
};

// ── Online state ─────────────────────────────────────────────────────────────
let NET = {
  peer: null,
  conn: null,
  role: null,       // 'host' | 'guest'
  active: false,
  scanActive: false,
  stream: null,
  joinUrl: null,
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
  aiMode: true,
  aiVsAi: false,
  aiDifficulty: 'medium',
  diagonal: false, // when true, Moore (8-way) neighbourhood for explosions
};

// ── Grid logic ───────────────────────────────────────────────────────────────

function mkGrid(size) {
  return Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({ p: null, n: 0 }))
  );
}

function neighbors(r, c) {
  if (G.diagonal) {
    const a = [];
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++)
        if ((dr || dc) && r+dr >= 0 && r+dr < G.size && c+dc >= 0 && c+dc < G.size)
          a.push([r+dr, c+dc]);
    return a;
  }
  const a = [];
  if (r > 0)          a.push([r - 1, c]);
  if (r < G.size - 1) a.push([r + 1, c]);
  if (c > 0)          a.push([r, c - 1]);
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

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

function dedup(cells) {
  const seen = new Set();
  return cells.filter(([r, c]) => {
    const k = `${r},${c}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

// ── Dots SVG ─────────────────────────────────────────────────────────────────

function makeDots(count, player) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'dots-svg');
  svg.setAttribute('aria-hidden', 'true');

  const fill = player === 'blue' ? '#4a9eff' : '#ff4a6e';
  svg.style.filter = `drop-shadow(0 0 4px ${fill})`;

  if (G.diagonal) {
    // Orbiting electrons: N dots evenly fanned around the cell centre
    const dotR    = count <= 3 ? 11 : count <= 5 ? 10 : 9;
    const orbitR  = 28;
    const period  = 3; // seconds per full rotation
    for (let i = 0; i < count; i++) {
      const g = document.createElementNS(NS, 'g');
      g.style.transformOrigin         = '50px 50px';
      g.style.animationName           = 'electron-orbit';
      g.style.animationDuration       = `${period}s`;
      g.style.animationTimingFunction = 'linear';
      g.style.animationIterationCount = 'infinite';
      g.style.animationDelay          = `${-(period / count) * i}s`;
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', 50);
      c.setAttribute('cy', 50 - orbitR);
      c.setAttribute('r', dotR);
      c.setAttribute('fill', fill);
      g.appendChild(c);
      svg.appendChild(g);
    }
    return svg;
  }

  const positions = DOT_POSITIONS[count];
  if (!positions) return null;
  const dotR = count <= 3 ? 11 : count <= 5 ? 10 : 9;
  positions.forEach(([cx, cy]) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', cx);
    c.setAttribute('cy', cy);
    c.setAttribute('r', dotR);
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
  gridEl.classList.toggle('enhanced', G.diagonal);
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

  const isCritical = data.p && data.n > 0 && data.n === capacity(r, c) - 1;
  const animCls = [...el.classList].filter(k => k === 'exploding' || k === 'receiving' || k === 'capturing');
  el.className  = ['cell', data.p || '', isCritical ? 'critical' : '', ...animCls].filter(Boolean).join(' ');

  el.querySelectorAll('.dots-svg').forEach(s => s.remove());

  if (data.n > 0 && data.p && (G.diagonal || DOT_POSITIONS[data.n])) {
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

  if (NET.active) {
    document.querySelector('#blue-ind .p-name').textContent = NET.role === 'host'  ? 'You' : 'Opp';
    document.querySelector('#red-ind .p-name').textContent  = NET.role === 'guest' ? 'You' : 'Opp';
  } else {
    document.querySelector('#blue-ind .p-name').textContent = G.aiVsAi ? 'CPU' : 'Blue';
    document.querySelector('#red-ind .p-name').textContent  = (G.aiMode || G.aiVsAi) ? 'CPU' : 'Red';
  }

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
      { duration: Math.round(300 * (window.ANIM_SCALE ?? 1)), easing: 'cubic-bezier(0.4,0,1,1)' }
    ).finished.then(() => {
      p.remove();
      // Flash the receiving cell
      toEl.classList.add('receiving');
      setTimeout(() => toEl.classList.remove('receiving'), Math.round(260 * (window.ANIM_SCALE ?? 1)));
    });
  });

  await Promise.all([sleep(Math.round(320 * (window.ANIM_SCALE ?? 1))), ...particleAnims]);
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

    // Snapshot owners before applying logic so we can detect captures
    const prevOwner = G.grid.map(row => row.map(cell => cell.p));

    for (const [r, c] of wave) {
      const cell = G.grid[r][c];
      if (cell.n < capacity(r, c)) continue;

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

    if (checkWin()) return;

    // Flash cells that changed owner (newly captured)
    for (let r = 0; r < G.size; r++) {
      for (let c = 0; c < G.size; c++) {
        const el = cellEl(r, c);
        const cur = G.grid[r][c].p;
        if (el && cur && cur !== prevOwner[r][c]) {
          el.classList.remove('capturing');
          void el.offsetWidth; // restart animation if already playing
          el.classList.add('capturing');
          setTimeout(() => el.classList.remove('capturing'), Math.round(440 * (window.ANIM_SCALE ?? 1)));
        }
      }
    }

    // Collect next wave
    const next = [];
    for (let r = 0; r < G.size; r++)
      for (let c = 0; c < G.size; c++)
        if (needsExplode(r, c)) next.push([r, c]);

    wave = dedup(next);
  }
}

// ── AI ────────────────────────────────────────────────────────────────────────

function cloneGrid(grid) {
  return grid.map(row => row.map(cell => ({ ...cell })));
}

function simulateMove(grid, size, player, r, c) {
  const g = cloneGrid(grid);
  g[r][c].p = player;
  g[r][c].n++;

  const nbrs = (rr, cc) => {
    if (G.diagonal) {
      const a = [];
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++)
          if ((dr || dc) && rr+dr >= 0 && rr+dr < size && cc+dc >= 0 && cc+dc < size)
            a.push([rr+dr, cc+dc]);
      return a;
    }
    const a = [];
    if (rr > 0)      a.push([rr - 1, cc]);
    if (rr < size-1) a.push([rr + 1, cc]);
    if (cc > 0)      a.push([rr, cc - 1]);
    if (cc < size-1) a.push([rr, cc + 1]);
    return a;
  };
  const cap = (rr, cc) => nbrs(rr, cc).length;

  let wave = g[r][c].n >= cap(r, c) ? [[r, c]] : [];

  for (let iter = 0; iter < 500 && wave.length; iter++) {
    const toExplode = wave.filter(([rr, cc]) => g[rr][cc].n >= cap(rr, cc));
    if (!toExplode.length) break;

    for (const [rr, cc] of toExplode) {
      const cell = g[rr][cc];
      if (cell.n < cap(rr, cc)) continue;
      const pl = cell.p;
      const ns = nbrs(rr, cc);
      cell.n -= ns.length;
      if (cell.n <= 0) { cell.n = 0; cell.p = null; }
      for (const [nr, nc] of ns) { g[nr][nc].n++; g[nr][nc].p = pl; }
    }

    const live = g.flat().filter(cell => cell.n > 0);
    if (new Set(live.map(cell => cell.p)).size === 1) break;

    wave = [];
    for (let rr = 0; rr < size; rr++)
      for (let cc = 0; cc < size; cc++)
        if (g[rr][cc].n >= cap(rr, cc)) wave.push([rr, cc]);
  }

  return g;
}

function evaluateGrid(grid, size, player) {
  const cap = (r, c) => {
    if (G.diagonal) {
      let n = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++)
          if ((dr || dc) && r+dr >= 0 && r+dr < size && c+dc >= 0 && c+dc < size)
            n++;
      return n;
    }
    let n = 0;
    if (r > 0) n++; if (r < size-1) n++;
    if (c > 0) n++; if (c < size-1) n++;
    return n;
  };
  let myCounters = 0, oppCounters = 0, myCells = 0, oppCells = 0;
  let myNearFull = 0, oppNearFull = 0;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const cell = grid[r][c];
      if (!cell.p || cell.n === 0) continue;
      const cellCap = cap(r, c);
      if (cell.p === player) {
        myCounters += cell.n; myCells++;
        if (cell.n >= cellCap - 1) myNearFull++;
      } else {
        oppCounters += cell.n; oppCells++;
        if (cell.n >= cellCap - 1) oppNearFull++;
      }
    }
  }

  if (myCells > 0 && oppCells === 0) return 100000;
  if (myCells === 0 && oppCells > 0) return -100000;

  return (myCounters - oppCounters) * 10
       + (myCells   - oppCells)     * 5
       + (myNearFull - oppNearFull) * 8;
}

function getValidMoves(grid, size, player) {
  const moves = [];
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (!grid[r][c].p || grid[r][c].p === player)
        moves.push([r, c]);
  return moves;
}

function aiPickMove(player = 'red') {
  const opp   = player === 'red' ? 'blue' : 'red';
  const moves = getValidMoves(G.grid, G.size, player);
  if (!moves.length) return null;

  if (G.aiDifficulty === 'easy') {
    return moves[Math.floor(Math.random() * moves.length)];
  }

  let best = -Infinity;
  let bestMoves = [];

  for (const [r, c] of moves) {
    const result = simulateMove(G.grid, G.size, player, r, c);
    let score = evaluateGrid(result, G.size, player);

    if (G.aiDifficulty === 'hard') {
      const oppMoves = getValidMoves(result, G.size, opp);
      const sample = oppMoves.length > 8
        ? oppMoves.sort(() => Math.random() - 0.5).slice(0, 8)
        : oppMoves;
      if (sample.length) {
        let worst = Infinity;
        for (const [or, oc] of sample) {
          const s = evaluateGrid(simulateMove(result, G.size, opp, or, oc), G.size, player);
          if (s < worst) worst = s;
        }
        score = worst;
      }
    }

    if (score > best) { best = score; bestMoves = [[r, c]]; }
    else if (score === best) bestMoves.push([r, c]);
  }

  return bestMoves[Math.floor(Math.random() * bestMoves.length)];
}

// ── Turn execution ────────────────────────────────────────────────────────────

async function executeTurn(r, c) {
  const myEpoch = G.epoch;
  G.played[G.turn] = true;

  const cell = G.grid[r][c];
  cell.p = G.turn;
  cell.n++;

  renderCell(r, c);
  updateHUD();

  if (needsExplode(r, c)) {
    await processChain([[r, c]]);
  }

  if (G.epoch !== myEpoch) return false;

  const winner = checkWin();
  if (winner) {
    G.over = true;
    showWin(winner);
    return false;
  }

  G.turn = G.turn === 'blue' ? 'red' : 'blue';
  updateHUD();
  return true;
}

// ── Click handler ─────────────────────────────────────────────────────────────

async function onCellClick(e) {
  if (G.over || G.busy) return;
  if (G.aiVsAi) return;
  if (G.aiMode && G.turn !== 'blue') return;
  if (NET.active) {
    if (NET.role === 'host'  && G.turn !== 'blue') return;
    if (NET.role === 'guest' && G.turn !== 'red')  return;
  }

  const r    = +e.currentTarget.dataset.r;
  const c    = +e.currentTarget.dataset.c;
  const cell = G.grid[r][c];

  if (cell.p && cell.p !== G.turn) return;

  G.busy = true;
  const myEpoch = G.epoch;

  let ok = await executeTurn(r, c);

  if (ok && G.epoch === myEpoch && NET.active && NET.conn) {
    NET.conn.send({ type: 'move', r, c });
  }

  if (ok && G.epoch === myEpoch && G.aiMode && G.turn === 'red') {
    $('red-ind').classList.add('thinking');
    await sleep(900 + Math.random() * 800);
    $('red-ind').classList.remove('thinking');

    if (G.epoch === myEpoch && !G.over) {
      const move = aiPickMove();
      if (move) ok = await executeTurn(move[0], move[1]);
    }
  }

  if (G.epoch === myEpoch) G.busy = false;
}

// ── Win screen ───────────────────────────────────────────────────────────────

function showWin(player) {
  $(`${player}-ind`).classList.add('won');
  const arrow = $('turn-arrow');
  arrow.innerHTML = '&#9733;';
  arrow.style.color = `var(--${player})`;
  const bar = $('result-bar');
  bar.className = player;
  bar.textContent = NET.active
    ? (player === (NET.role === 'host' ? 'blue' : 'red') ? 'You Win!' : 'Opp Wins!')
    : G.aiVsAi
      ? (player === 'blue' ? 'Blue Wins!' : 'Red Wins!')
      : G.aiMode
        ? (player === 'blue' ? 'You Win!' : 'CPU Wins!')
        : (player === 'blue' ? 'Blue Wins!' : 'Red Wins!');
}

function showStalemate(player) {
  const bar = $('result-bar');
  bar.className = 'stalemate';
  const name = G.aiVsAi                        ? (player === 'blue' ? 'Blue' : 'Red')
             : (G.aiMode && player === 'red')   ? 'CPU'
             : (G.aiMode && player === 'blue')  ? 'You'
             : (player === 'blue' ? 'Blue' : 'Red');
  bar.textContent = name === 'You' ? "You're Trapped!" : `${name} Trapped!`;
}

// ── New game ──────────────────────────────────────────────────────────────────

function aiOpts() {
  const mode    = $('mode').value;
  const aiVsAi  = mode === 'demo';
  const aiMode  = !aiVsAi && mode !== '2p';
  const aiDifficulty = aiVsAi ? 'medium' : mode;
  const turn    = (mode !== '2p' && $('first-move').value === 'red') ? 'red' : 'blue';
  return { mode, aiMode, aiVsAi, aiDifficulty, turn };
}

function newGame(fromRemote = false) {
  $('win-modal').classList.add('hidden');
  $('blue-ind').classList.remove('won');
  $('red-ind').classList.remove('won');
  const arrow = $('turn-arrow');
  arrow.innerHTML = '&#9660;';
  arrow.style.color = '';
  $('result-bar').className = 'hidden';

  if ($('board').value === '3d') {
    if (window.Game3D && Game3D.isReady()) {
      const { aiMode, aiVsAi, aiDifficulty, turn } = aiOpts();
      Game3D.newRound({ N: +$('cube-size').value, aiMode, aiVsAi, aiDifficulty, turn });
    }
    return;
  }

  let aiMode, aiVsAi, aiDifficulty, turn;
  if (NET.active) {
    aiMode = false; aiVsAi = false; aiDifficulty = 'none'; turn = 'blue';
  } else {
    ({ aiMode, aiVsAi, aiDifficulty, turn } = aiOpts());
  }

  G.epoch++;
  G.size          = +$('grid-size').value;
  G.aiMode        = aiMode;
  G.aiVsAi        = aiVsAi;
  G.aiDifficulty  = aiDifficulty;
  G.turn          = turn;
  G.diagonal      = $('expl-mode').value === 'enhanced';
  G.grid          = mkGrid(G.size);
  G.over          = false;
  G.busy          = false;
  G.played        = { blue: false, red: false };

  if (NET.active && NET.conn && !fromRemote) {
    NET.conn.send({ type: 'newgame', size: G.size, diagonal: G.diagonal });
  }

  $('red-ind').classList.remove('thinking');
  $('blue-ind').classList.remove('thinking');
  buildGrid();
  renderAll();
  updateHUD();

  if (G.aiVsAi) demoLoop(G.epoch);
  else if (!NET.active && turn === 'red') aiOpeningMove(G.epoch);
}

async function aiOpeningMove(epoch) {
  G.busy = true;
  $('red-ind').classList.add('thinking');
  await sleep(700 + Math.random() * 700);
  $('red-ind').classList.remove('thinking');
  if (G.epoch !== epoch || G.over) { G.busy = false; return; }
  const move = aiPickMove('red');
  if (move) await executeTurn(move[0], move[1]);
  if (G.epoch === epoch) G.busy = false;
}

async function demoLoop(epoch) {
  if (G.epoch !== epoch || G.over || !G.aiVsAi) return;
  G.busy = true;
  const player = G.turn;
  $(`${player}-ind`).classList.add('thinking');
  await sleep(900 + Math.random() * 800);
  $(`${player}-ind`).classList.remove('thinking');
  if (G.epoch !== epoch || G.over) { G.busy = false; return; }
  const move = aiPickMove(player);
  if (!move) { G.busy = false; return; }
  await executeTurn(move[0], move[1]);
  if (G.epoch === epoch) {
    G.busy = false;
    if (!G.over) demoLoop(epoch);
  }
}

// ── Online multiplayer ────────────────────────────────────────────────────────

function setSettingsEnabled(on) {
  ['board', 'mode', 'first-move', 'grid-size', 'cube-size', 'expl-mode'].forEach(id => {
    const el = $(id);
    if (el) el.disabled = !on;
  });
}

function netDispose() {
  NET.scanActive = false;
  const vid = $('scan-video');
  if (vid) vid.srcObject = null;
  if (NET.stream) { NET.stream.getTracks().forEach(t => t.stop()); NET.stream = null; }
  if (NET.conn)   { try { NET.conn.close();    } catch(e) {} NET.conn = null; }
  if (NET.peer)   { try { NET.peer.destroy();  } catch(e) {} NET.peer = null; }
}

function netReset() {
  netDispose();
  NET.role    = null;
  NET.active  = false;
  NET.joinUrl = null;
  $('online-badge').classList.add('hidden');
  $('share-link-btn').classList.add('hidden');
  setSettingsEnabled(true);
}

function netGoLive() {
  NET.active = true;
  $('online-badge').classList.remove('hidden');
  setSettingsEnabled(false);
}

async function openInvite() {
  try {
    await Promise.all([
      loadScript('https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js'),
      loadScript('https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'),
    ]);
  } catch(e) {
    alert('Network error — check your connection and try again.');
    return;
  }

  netReset();
  $('invite-status').textContent = 'Connecting to server…';
  $('qr-container').innerHTML = '';
  $('invite-modal').classList.remove('hidden');

  NET.role = 'host';
  NET.peer = new Peer(undefined, { debug: 0 });

  NET.peer.on('open', id => {
    const url = `${location.origin}${location.pathname}?join=${id}`;
    NET.joinUrl = url;
    $('invite-status').textContent = 'Waiting for opponent…';
    new QRCode($('qr-container'), {
      text: url, width: 200, height: 200,
      colorDark: '#000000', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
    const btn = $('share-link-btn');
    btn.textContent = navigator.share ? 'Share Link' : 'Copy Link';
    btn.classList.remove('hidden');
  });

  NET.peer.on('connection', conn => {
    NET.conn = conn;
    conn.on('open', () => {
      $('invite-modal').classList.add('hidden');
      netGoLive();
      newGame();
      conn.send({ type: 'start', size: G.size, diagonal: G.diagonal });
    });
    conn.on('data',  receiveNetData);
    conn.on('close', onNetDisconnect);
    conn.on('error', onNetDisconnect);
  });

  NET.peer.on('error', err => {
    $('invite-status').textContent = `Error: ${err.type} — please retry.`;
  });
}

async function openJoin() {
  try {
    await Promise.all([
      loadScript('https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js'),
      loadScript('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js'),
    ]);
  } catch(e) {
    alert('Network error — check your connection and try again.');
    return;
  }

  $('join-status').textContent = 'Starting camera…';
  $('join-modal').classList.remove('hidden');

  try {
    NET.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    const vid = $('scan-video');
    vid.srcObject = NET.stream;
    await vid.play();
    $('join-status').textContent = 'Point at the host\'s QR code';
    NET.scanActive = true;
    requestAnimationFrame(scanFrame);
  } catch(e) {
    $('join-status').textContent =
      e.name === 'NotAllowedError' ? 'Camera permission denied' : `Camera error: ${e.message}`;
  }
}

function scanFrame() {
  if (!NET.scanActive) return;
  const vid = $('scan-video');
  const cvs = $('scan-canvas');
  if (vid.readyState >= vid.HAVE_ENOUGH_DATA) {
    cvs.width  = vid.videoWidth;
    cvs.height = vid.videoHeight;
    const ctx = cvs.getContext('2d');
    ctx.drawImage(vid, 0, 0);
    const img  = ctx.getImageData(0, 0, cvs.width, cvs.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (code) {
      NET.scanActive = false;
      try {
        const peerId = new URL(code.data).searchParams.get('join');
        if (peerId) { connectToPeer(peerId); return; }
      } catch(e) {}
      $('join-status').textContent = 'Unrecognised QR — try again';
      NET.scanActive = true;
    }
  }
  requestAnimationFrame(scanFrame);
}

async function connectToPeer(peerId) {
  $('join-status').textContent = 'Connecting…';
  if (typeof Peer === 'undefined') {
    try { await loadScript('https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js'); }
    catch(e) { $('join-status').textContent = 'Failed to load network library'; return; }
  }
  if (NET.stream) { NET.stream.getTracks().forEach(t => t.stop()); NET.stream = null; }
  if (NET.peer)   { try { NET.peer.destroy(); } catch(e) {} NET.peer = null; }

  NET.role = 'guest';
  NET.peer = new Peer(undefined, { debug: 0 });

  NET.peer.on('open', () => {
    NET.conn = NET.peer.connect(peerId, { reliable: true });
    NET.conn.on('open', () => {
      $('join-modal').classList.add('hidden');
      netGoLive();
    });
    NET.conn.on('data',  receiveNetData);
    NET.conn.on('close', onNetDisconnect);
    NET.conn.on('error', onNetDisconnect);
  });

  NET.peer.on('error', err => {
    $('join-status').textContent = `Connection failed: ${err.type}`;
  });
}

function receiveNetData(data) {
  switch (data.type) {
    case 'start':
    case 'newgame': {
      if (data.size     !== undefined) $('grid-size').value = data.size;
      if (data.diagonal !== undefined) $('expl-mode').value = data.diagonal ? 'enhanced' : 'classic';
      newGame(true);
      break;
    }
    case 'move': {
      applyRemoteMove(data.r, data.c);
      break;
    }
  }
}

async function applyRemoteMove(r, c) {
  if (G.over || G.busy) return;
  G.busy = true;
  const ep = G.epoch;
  await executeTurn(r, c);
  if (G.epoch === ep) G.busy = false;
}

function onNetDisconnect() {
  if (!NET.active) return;
  NET.active = false;
  $('online-badge').classList.add('hidden');
  setSettingsEnabled(true);
  const bar = $('result-bar');
  bar.className = 'stalemate';
  bar.textContent = 'Opponent disconnected';
  G.over = true;
  G.busy = false;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

$('new-game').addEventListener('click', newGame);
$('play-again').addEventListener('click', newGame);
$('grid-size').addEventListener('change', newGame);
$('cube-size').addEventListener('change', newGame);

$('board').addEventListener('change', () => {
  const is3D = $('board').value === '3d';
  $('grid-wrapper').classList.toggle('hidden', is3D);
  $('game3d-wrapper').classList.toggle('hidden', !is3D);
  $('grid-size').style.display   = is3D ? 'none' : '';
  $('cube-size').style.display   = is3D ? ''     : 'none';
  $('expl-mode').style.display   = is3D ? 'none' : '';
  if (is3D) {
    start3D();
  } else {
    newGame();
  }
});

async function start3D() {
  const { aiMode, aiVsAi, aiDifficulty, turn } = aiOpts();
  const ok = await Game3D.start($('game3d-wrapper'), {
    N: +$('cube-size').value, aiMode, aiVsAi, aiDifficulty, turn,
  });
  if (!ok) {
    $('board').value = '2d';
    $('board').dispatchEvent(new Event('change'));
    alert('3D mode requires an internet connection to load Three.js.');
  }
}

$('mode').addEventListener('change', () => {
  $('first-move').style.display = $('mode').value !== '2p' ? '' : 'none';
  newGame();
});
$('first-move').addEventListener('change', newGame);
$('expl-mode').addEventListener('change', newGame);

function applyAnimScale(s) {
  const root = document.documentElement.style;
  root.setProperty('--anim-explode', `${Math.round(320 * s)}ms`);
  root.setProperty('--anim-recv',    `${Math.round(260 * s)}ms`);
  root.setProperty('--anim-capture', `${Math.round(420 * s)}ms`);
}

window.ANIM_SCALE = 1.7;
applyAnimScale(1.7);
$('anim-speed').addEventListener('change', () => {
  window.ANIM_SCALE = parseFloat($('anim-speed').value);
  applyAnimScale(window.ANIM_SCALE);
});

$('help-btn').addEventListener('click', () => $('help-modal').classList.remove('hidden'));
$('help-close').addEventListener('click', () => $('help-modal').classList.add('hidden'));
$('help-modal').addEventListener('click', e => {
  if (e.target === $('help-modal')) $('help-modal').classList.add('hidden');
});

$('invite-btn').addEventListener('click', openInvite);
$('join-btn').addEventListener('click', openJoin);

$('share-link-btn').addEventListener('click', async () => {
  if (!NET.joinUrl) return;
  const btn = $('share-link-btn');
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Join my Nuke game', url: NET.joinUrl });
    } else {
      await navigator.clipboard.writeText(NET.joinUrl);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy Link'; }, 1800);
    }
  } catch(e) {}
});

$('invite-cancel').addEventListener('click', () => {
  netReset();
  $('invite-modal').classList.add('hidden');
});
$('join-cancel').addEventListener('click', () => {
  netReset();
  $('join-modal').classList.add('hidden');
});

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

document.addEventListener('DOMContentLoaded', async () => {
  $('version').textContent = `v${VERSION}`;

  const joinId = new URLSearchParams(location.search).get('join');
  if (joinId) {
    history.replaceState({}, '', location.pathname);
    newGame();
    $('join-modal').classList.remove('hidden');
    $('join-status').textContent = 'Connecting to host…';
    connectToPeer(joinId);
    return;
  }

  newGame();
});
