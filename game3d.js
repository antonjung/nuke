'use strict';

// ── 3D chain-reaction game ───────────────────────────────────────────────────
// Surface cells of an N×N×N cube. Adjacency = ±1 in any axis, filtered to surface.
// Exposed as window.Game3D = { start, newRound, isReady }

window.Game3D = (() => {

  // ── State ──────────────────────────────────────────────────────────────────
  const G = {
    N: 3,
    cells: {},
    surface: [],
    turn: 'blue',
    over: false,
    busy: false,
    played: { blue: false, red: false },
    epoch: 0,
    aiMode: false,
    aiDifficulty: 'medium',
  };

  // ── Three.js handles ───────────────────────────────────────────────────────
  let THREE = null;
  let renderer = null;
  let scene = null;
  let camera = null;
  let group = null;
  let cellMeshes = [];
  let edgeMeshes = [];
  let dotGroups = {};
  let meshByKey = new Map();   // key → mesh (O(1) lookup)
  let rafId = null;
  let ready = false;

  // Targeted rotation: lerp rotX/rotY toward a target (set by aimAt*)
  let rotXTarget = 0.35;
  let rotYTarget = 0.6;
  let targeting  = false;

  // Critical cell pulse: key → { mesh, edges, baseEI }
  const criticalSet = new Map();

  // Smooth material colour/opacity animation: key → { mesh, fc, tc, fo, to_op, t0, dur }
  const matAnims = new Map();

  const SPACING  = 1.08;
  const CSIZE    = 0.9;

  const COL = {
    empty : { c: 0x1e2055, e: 0x000000, ei: 0.0,  op: 0.18 },
    blue  : { c: 0x4a9eff, e: 0x1a3a70, ei: 0.25, op: 0.52 },
    red   : { c: 0xff4a6e, e: 0x701a30, ei: 0.25, op: 0.52 },
  };

  const DOT_COLOR    = 0x999999;
  const DOT_EMISSIVE = 0x333333;
  const DOT_EI       = 0.4;
  const DOT_R        = CSIZE * 0.13;

  const DOT_POS = {
    1: [[0,    0,    0   ]],
    2: [[-0.24, 0,   0   ], [0.24,  0,   0   ]],
    3: [[-0.22, 0.2, 0   ], [0.22,  0.2, 0   ], [0, -0.22, 0]],
  };

  const $ = id => document.getElementById(id);

  // ── Grid helpers ───────────────────────────────────────────────────────────

  const key = (x, y, z) => `${x},${y},${z}`;

  function isSurf(x, y, z, N) {
    return x === 0 || x === N-1 || y === 0 || y === N-1 || z === 0 || z === N-1;
  }

  function buildSurface(N) {
    const a = [];
    for (let x = 0; x < N; x++)
      for (let y = 0; y < N; y++)
        for (let z = 0; z < N; z++)
          if (isSurf(x, y, z, N)) a.push([x, y, z]);
    return a;
  }

  const DIRS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

  function nbrs(x, y, z, N) {
    return DIRS
      .map(([dx,dy,dz]) => [x+dx, y+dy, z+dz])
      .filter(([nx,ny,nz]) =>
        nx >= 0 && nx < N && ny >= 0 && ny < N && nz >= 0 && nz < N &&
        isSurf(nx, ny, nz, N)
      );
  }

  const cap = (x, y, z, N) => nbrs(x, y, z, N).length;

  // Normalise to [-π, π] so rotation lerp always takes the short arc
  function normAngle(a) {
    while (a >  Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  // ── Scene setup ────────────────────────────────────────────────────────────

  async function loadThree() {
    if (THREE) return true;
    return new Promise(resolve => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js';
      s.onload  = () => { THREE = window.THREE; resolve(true); };
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }

  function setupScene(container) {
    const w = container.clientWidth;
    const h = container.clientHeight;

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x0a0a1a, 1);
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 200);
    repositionCamera();

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const d1 = new THREE.DirectionalLight(0xffffff, 0.8);
    d1.position.set(6, 9, 6);
    scene.add(d1);
    const d2 = new THREE.DirectionalLight(0x6080ff, 0.25);
    d2.position.set(-5, -4, -5);
    scene.add(d2);

    group = new THREE.Group();
    group.rotation.x = 0.35;
    group.rotation.y = 0.6;
    scene.add(group);

    function loop() {
      rafId = requestAnimationFrame(loop);

      // Targeted rotation: smoothly pivot toward explosion / AI move
      if (targeting) {
        rotX += (rotXTarget - rotX) * 0.07;
        rotY += normAngle(rotYTarget - rotY) * 0.07;
        group.rotation.x = rotX;
        group.rotation.y = rotY;
      }

      // Smooth colour / opacity animation for cell material transitions
      if (matAnims.size) {
        const now = performance.now();
        for (const [k, a] of matAnims) {
          const t = Math.min((now - a.t0) / a.dur, 1);
          if (a.mesh.material) {
            a.mesh.material.color.lerpColors(a.fc, a.tc, t);
            a.mesh.material.opacity = a.fo + (a.to_op - a.fo) * t;
          }
          if (t >= 1) matAnims.delete(k);
        }
      }

      renderer.render(scene, camera);
    }
    loop();

    setupPointer(container);
    window.addEventListener('resize', () => onResize(container));
  }

  function repositionCamera() {
    if (!camera || !G.N) return;
    const dist = G.N * SPACING * 1.85 + 3;
    camera.position.set(0, 0, dist);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }

  function onResize(container) {
    if (!renderer || !camera) return;
    const w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  // ── Pointer interaction ────────────────────────────────────────────────────

  let pDown = false, pMoved = false, px = 0, py = 0;
  let rotX = 0.35, rotY = 0.6;

  function setupPointer(container) {
    const el = renderer.domElement;

    el.addEventListener('pointerdown', e => {
      pDown = true; pMoved = false;
      px = e.clientX; py = e.clientY;
      targeting = false; // user takes manual control
      el.setPointerCapture(e.pointerId);
    });

    el.addEventListener('pointermove', e => {
      if (!pDown) return;
      const dx = e.clientX - px, dy = e.clientY - py;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) pMoved = true;
      if (pMoved) {
        rotY += dx * 0.008;
        rotX  = Math.max(-1.3, Math.min(1.3, rotX + dy * 0.008));
        group.rotation.x = rotX;
        group.rotation.y = rotY;
        px = e.clientX; py = e.clientY;
      }
    });

    el.addEventListener('pointerup', e => {
      if (!pMoved) onCellTap(e);
      pDown = false; pMoved = false;
    });
  }

  function onCellTap(e) {
    if (G.over || G.busy) return;
    if (G.aiMode && G.turn !== 'blue') return;

    const rect = renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(mouse, camera);
    const hits = ray.intersectObjects(cellMeshes);
    if (!hits.length) return;

    const { cx, cy, cz } = hits[0].object.userData;
    const cell = G.cells[key(cx, cy, cz)];
    if (cell.p && cell.p !== G.turn) return;

    doTurn(cx, cy, cz);
  }

  // ── Cell meshes ────────────────────────────────────────────────────────────

  function rebuildMeshes() {
    cellMeshes.forEach(m => group.remove(m));
    edgeMeshes.forEach(m => group.remove(m));
    Object.values(dotGroups).flat().forEach(m => group.remove(m));
    cellMeshes = [];
    edgeMeshes = [];
    dotGroups  = {};
    meshByKey.clear();
    criticalSet.clear();
    matAnims.clear();

    const N   = G.N;
    const off = (N - 1) / 2 * SPACING;
    const boxGeo  = new THREE.BoxGeometry(CSIZE, CSIZE, CSIZE);
    const edgeGeo = new THREE.EdgesGeometry(boxGeo);
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x4455cc, transparent: true, opacity: 0.45 });

    for (const [x, y, z] of G.surface) {
      const mat = new THREE.MeshStandardMaterial({
        color: COL.empty.c, emissive: COL.empty.e, emissiveIntensity: COL.empty.ei,
        roughness: 0.35, metalness: 0.1,
        transparent: true, opacity: COL.empty.op, depthWrite: false,
      });
      const mesh = new THREE.Mesh(boxGeo, mat);
      const pos  = [x * SPACING - off, y * SPACING - off, z * SPACING - off];
      mesh.position.set(...pos);

      const edges = new THREE.LineSegments(edgeGeo, edgeMat.clone());
      edges.position.set(...pos);
      group.add(edges);
      edgeMeshes.push(edges);

      mesh.userData = { cx: x, cy: y, cz: z, edges };
      group.add(mesh);
      cellMeshes.push(mesh);
      meshByKey.set(key(x, y, z), mesh);
      dotGroups[key(x, y, z)] = [];
    }
  }

  const getMesh = (x, y, z) => meshByKey.get(key(x, y, z));

  function renderAll() { G.surface.forEach(([x,y,z]) => renderCell(x, y, z)); }

  // Start (or restart) a smooth colour + opacity transition for a cell
  function animateMat(k, mesh, col, dur = 320) {
    const tc = new THREE.Color(col.c);
    const existing = matAnims.get(k);
    // Start from wherever the current animation has reached
    let fc, fo;
    if (existing) {
      const t = Math.min((performance.now() - existing.t0) / existing.dur, 1);
      fc = existing.fc.clone().lerp(existing.tc, t);
      fo = existing.fo + (existing.to_op - existing.fo) * t;
    } else {
      fc = mesh.material.color.clone();
      fo = mesh.material.opacity;
    }
    if (fc.equals(tc) && Math.abs(fo - col.op) < 0.001) return;
    matAnims.set(k, { mesh, fc, tc, fo, to_op: col.op, t0: performance.now(), dur });
  }

  function renderCell(x, y, z) {
    const k    = key(x, y, z);
    const cell = G.cells[k];
    const mesh = getMesh(x, y, z);
    if (!mesh) return;

    const col    = cell.p ? COL[cell.p] : COL.empty;
    const edges  = mesh.userData.edges;
    const isCrit = cell.p && cell.n > 0 && cell.n === cap(x, y, z, G.N) - 1;

    // Animate colour / opacity change
    animateMat(k, mesh, col);

    // Emissive + critical set
    if (isCrit) {
      if (!criticalSet.has(k)) {
        criticalSet.set(k, { mesh, edges, baseEI: col.ei });
        if (edges?.material) edges.material.color.setHex(0xff8800);
      }
    } else {
      if (criticalSet.has(k)) {
        criticalSet.delete(k);
        if (edges?.material) { edges.material.color.setHex(0x4455cc); edges.material.opacity = 0.45; }
      }
      mesh.material.emissiveIntensity = col.ei;
    }
    // Set emissive target (not animated — instant is fine)
    mesh.material.emissive.setHex(col.e);

    dotGroups[k].forEach(d => group.remove(d));
    dotGroups[k] = [];
    if (!cell.p || cell.n <= 0) return;

    const positions = DOT_POS[Math.min(cell.n, 3)];
    if (!positions) return;

    const dotGeo = new THREE.SphereGeometry(DOT_R, 10, 10);
    for (const [dx, dy, dz] of positions) {
      const dot = new THREE.Mesh(dotGeo, new THREE.MeshStandardMaterial({
        color: DOT_COLOR, emissive: DOT_EMISSIVE, emissiveIntensity: DOT_EI,
        roughness: 0.3, metalness: 0.1,
      }));
      dot.position.set(
        mesh.position.x + dx * CSIZE,
        mesh.position.y + dy * CSIZE,
        mesh.position.z + dz * CSIZE,
      );
      group.add(dot);
      dotGroups[k].push(dot);
    }
  }

  // ── Rotation targeting ─────────────────────────────────────────────────────

  // Aim the camera at the centroid of a list of [x,y,z] grid cells
  function aimAt(cells, N) {
    const off = (N - 1) / 2 * SPACING;
    let wx = 0, wy = 0, wz = 0;
    for (const [x, y, z] of cells) {
      wx += x * SPACING - off;
      wy += y * SPACING - off;
      wz += z * SPACING - off;
    }
    wx /= cells.length; wy /= cells.length; wz /= cells.length;
    rotYTarget = -Math.atan2(wx, wz);
    rotXTarget = Math.max(-1.1, Math.min(1.1,
      Math.atan2(wy, Math.sqrt(wx * wx + wz * wz))
    ));
    targeting = true;
  }

  // ── Explosion animation helpers ────────────────────────────────────────────

  function animatePulse(meshes, duration, maxScale, maxEI) {
    return new Promise(resolve => {
      const t0 = performance.now();
      function tick(now) {
        const t = Math.min((now - t0) / duration, 1);
        const s  = 1 + maxScale * Math.sin(t * Math.PI);
        const ei = maxEI     * Math.sin(t * Math.PI);
        for (const m of meshes) {
          if (!m?.material) continue;
          m.scale.setScalar(s);
          m.material.emissiveIntensity = Math.max(0, ei);
        }
        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          for (const m of meshes) { if (m) m.scale.setScalar(1); }
          resolve();
        }
      }
      requestAnimationFrame(tick);
    });
  }

  const flashExplode = meshes => animatePulse(meshes, 500, 0.55, 1.8);
  const flashReceive = meshes => animatePulse(meshes, 280, 0.14, 0.7);
  const flashCapture = meshes => animatePulse(meshes, 360, 0.10, 1.5);

  // Animate spheres flying along a bezier arc from exploding cells to their neighbours
  function animateElectrons(toExplode, N) {
    return new Promise(resolve => {
      const flyers = [];
      const t0  = performance.now();
      const dur = 400;

      for (const [x, y, z] of toExplode) {
        const cell = G.cells[key(x, y, z)];
        if (!cell?.p) continue;
        const fromMesh = getMesh(x, y, z);
        if (!fromMesh) continue;

        const fill = cell.p === 'blue' ? 0x88ccff : 0xff88aa;
        const emv  = cell.p === 'blue' ? 0x2266cc : 0xcc2244;

        for (const [nx, ny, nz] of nbrs(x, y, z, N)) {
          const toMesh = getMesh(nx, ny, nz);
          if (!toMesh) continue;

          const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(DOT_R * 1.3, 8, 8),
            new THREE.MeshStandardMaterial({ color: fill, emissive: emv, emissiveIntensity: 0.9 }),
          );
          sphere.position.copy(fromMesh.position);
          group.add(sphere);

          const from = fromMesh.position.clone();
          const to   = toMesh.position.clone();
          // Arc: bezier control point pushed outward from the cube centre
          const mid  = from.clone().add(to).multiplyScalar(0.5);
          const outL = mid.length();
          const ctrl = outL > 0.01
            ? mid.clone().addScaledVector(mid.clone().normalize(), SPACING * 0.85)
            : mid.clone().add(new THREE.Vector3(0, SPACING * 0.85, 0));

          flyers.push({ sphere, from, ctrl, to });
        }
      }

      if (!flyers.length) { resolve(); return; }

      function tick(now) {
        const t  = Math.min((now - t0) / dur, 1);
        const mt = 1 - t;
        for (const { sphere, from, ctrl, to } of flyers) {
          // Quadratic bezier position
          sphere.position.set(
            mt*mt*from.x + 2*mt*t*ctrl.x + t*t*to.x,
            mt*mt*from.y + 2*mt*t*ctrl.y + t*t*to.y,
            mt*mt*from.z + 2*mt*t*ctrl.z + t*t*to.z,
          );
          sphere.scale.setScalar(1 - 0.5 * t); // shrink as it arrives
        }
        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          for (const { sphere } of flyers) {
            sphere.geometry.dispose();
            sphere.material.dispose();
            group.remove(sphere);
          }
          resolve();
        }
      }
      requestAnimationFrame(tick);
    });
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ── Game logic ─────────────────────────────────────────────────────────────

  async function doTurn(x, y, z) {
    G.busy = true;
    const epoch = G.epoch;
    let ok = await executeTurn(x, y, z);

    if (ok && G.epoch === epoch && G.aiMode && G.turn === 'red') {
      $('red-ind').classList.add('thinking');
      await sleep(900 + Math.random() * 800);
      $('red-ind').classList.remove('thinking');

      if (G.epoch === epoch && !G.over) {
        const move = aiPick();
        if (move) {
          // Rotate to the chosen cell so the player can see it before it's placed
          aimAt([move], G.N);
          await sleep(500);
          if (G.epoch === epoch && !G.over)
            ok = await executeTurn(...move);
        }
      }
    }
    if (G.epoch === epoch) G.busy = false;
  }

  async function executeTurn(x, y, z) {
    const epoch = G.epoch;
    const N = G.N;
    G.played[G.turn] = true;

    const cell = G.cells[key(x, y, z)];
    cell.p = G.turn;
    cell.n++;
    renderCell(x, y, z);
    updateHUD();

    if (cell.n >= cap(x, y, z, N)) {
      await processChain([[x, y, z]]);
    }
    if (G.epoch !== epoch) return false;

    const winner = checkWin();
    if (winner) { G.over = true; showWin(winner); return false; }

    G.turn = G.turn === 'blue' ? 'red' : 'blue';
    updateHUD();
    return true;
  }

  async function processChain(initial) {
    const epoch = G.epoch;
    const N = G.N;
    let wave = dedup(initial);

    while (wave.length) {
      if (G.epoch !== epoch) { targeting = false; return; }

      // Only animate cells that are still at capacity
      const toExplode = wave.filter(([x,y,z]) => {
        const c = G.cells[key(x,y,z)];
        return c && c.n >= cap(x, y, z, N);
      });
      if (!toExplode.length) break;

      // Pivot cube to face this wave's centre
      aimAt(toExplode, N);

      const waveMeshes = toExplode.map(([x,y,z]) => getMesh(x, y, z)).filter(Boolean);

      // Snapshot owners + collect receiver keys before logic runs
      const prevOwner = {};
      for (const [x,y,z] of G.surface) prevOwner[key(x,y,z)] = G.cells[key(x,y,z)].p;
      const receiverKeys = new Set();
      for (const [x,y,z] of toExplode)
        for (const [nx,ny,nz] of nbrs(x, y, z, N))
          receiverKeys.add(key(nx, ny, nz));

      // Explosion pulse + electron flight in parallel (electrons start 120ms in)
      await Promise.all([
        flashExplode(waveMeshes),
        sleep(120).then(() => animateElectrons(toExplode, N)),
      ]);
      if (G.epoch !== epoch) { targeting = false; return; }

      // Apply explosion logic
      for (const [x,y,z] of toExplode) {
        const cell = G.cells[key(x,y,z)];
        if (!cell || cell.n < cap(x,y,z,N)) continue;
        const player = cell.p;
        const ns = nbrs(x, y, z, N);
        cell.n -= ns.length;
        if (cell.n <= 0) { cell.n = 0; cell.p = null; }
        for (const [nx,ny,nz] of ns) {
          G.cells[key(nx,ny,nz)].n++;
          G.cells[key(nx,ny,nz)].p = player;
        }
      }

      // renderCell now starts colour animations instead of snapping instantly
      renderAll();
      updateHUD();
      if (checkWin()) { targeting = false; return; }

      // Flash captured vs plain-received cells in parallel
      const capturedMeshes = [], recvOnlyMeshes = [];
      for (const k of receiverKeys) {
        const [x,y,z] = k.split(',').map(Number);
        const m = getMesh(x, y, z);
        if (!m) continue;
        (G.cells[k].p && G.cells[k].p !== prevOwner[k] ? capturedMeshes : recvOnlyMeshes).push(m);
      }
      await Promise.all([flashCapture(capturedMeshes), flashReceive(recvOnlyMeshes)]);
      if (G.epoch !== epoch) { targeting = false; return; }

      wave = [];
      for (const [x,y,z] of G.surface)
        if (G.cells[key(x,y,z)].n >= cap(x,y,z,N)) wave.push([x,y,z]);
      wave = dedup(wave);
    }

    targeting = false;
  }

  function dedup(cells) {
    const seen = new Set();
    return cells.filter(([x,y,z]) => {
      const k = key(x,y,z);
      return seen.has(k) ? false : (seen.add(k), true);
    });
  }

  function checkWin() {
    if (!G.played.blue || !G.played.red) return null;
    const live = Object.values(G.cells).filter(c => c.n > 0);
    if (!live.length) return null;
    const ps = new Set(live.map(c => c.p));
    return ps.size === 1 ? [...ps][0] : null;
  }

  function updateHUD() {
    const counts = { blue: 0, red: 0 };
    Object.values(G.cells).forEach(c => { if (c.p) counts[c.p] += c.n; });
    $('blue-count').textContent = counts.blue;
    $('red-count').textContent  = counts.red;
    $('blue-ind').classList.toggle('active', G.turn === 'blue');
    $('red-ind').classList.toggle('active',  G.turn === 'red');
    document.querySelector('#red-ind .p-name').textContent = G.aiMode ? 'CPU' : 'Red';
    $('hud').classList.toggle('red-turn', G.turn === 'red');
  }

  function showWin(player) {
    const orb = $('win-orb'), label = $('win-label');
    orb.className = label.className = player;
    label.textContent = G.aiMode
      ? (player === 'blue' ? 'You Win!' : 'CPU Wins!')
      : (player === 'blue' ? 'Blue Wins!' : 'Red Wins!');
    $('win-modal').classList.remove('hidden');
  }

  // ── AI ─────────────────────────────────────────────────────────────────────

  function cloneCells(cells) {
    const g = {};
    for (const [k, v] of Object.entries(cells)) g[k] = { ...v };
    return g;
  }

  function simulate(cells, N, player, x, y, z) {
    const g = cloneCells(cells);
    g[key(x,y,z)].p = player;
    g[key(x,y,z)].n++;

    let wave = g[key(x,y,z)].n >= cap(x,y,z,N) ? [[x,y,z]] : [];
    for (let i = 0; i < 500 && wave.length; i++) {
      const boom = wave.filter(([cx,cy,cz]) => g[key(cx,cy,cz)].n >= cap(cx,cy,cz,N));
      if (!boom.length) break;
      for (const [cx,cy,cz] of boom) {
        const c = g[key(cx,cy,cz)];
        if (c.n < cap(cx,cy,cz,N)) continue;
        const pl = c.p;
        const ns = nbrs(cx,cy,cz,N);
        c.n -= ns.length;
        if (c.n <= 0) { c.n = 0; c.p = null; }
        for (const [nx,ny,nz] of ns) { g[key(nx,ny,nz)].n++; g[key(nx,ny,nz)].p = pl; }
      }
      const live = Object.values(g).filter(c => c.n > 0);
      if (new Set(live.map(c => c.p)).size === 1) break;
      wave = G.surface.filter(([cx,cy,cz]) => g[key(cx,cy,cz)].n >= cap(cx,cy,cz,N));
    }
    return g;
  }

  function evaluate(cells, N, player) {
    let myC = 0, opC = 0, myF = 0, opF = 0, myCells = 0, opCells = 0;
    for (const [x,y,z] of G.surface) {
      const c = cells[key(x,y,z)];
      if (!c.p || !c.n) continue;
      const cc = cap(x,y,z,N);
      if (c.p === player) { myC += c.n; myCells++; if (c.n >= cc-1) myF++; }
      else                { opC += c.n; opCells++; if (c.n >= cc-1) opF++; }
    }
    if (myCells > 0 && opCells === 0) return  100000;
    if (myCells === 0 && opCells > 0) return -100000;
    return (myC - opC)*10 + (myCells - opCells)*5 + (myF - opF)*8;
  }

  function validMoves(cells, player) {
    return G.surface.filter(([x,y,z]) => { const c = cells[key(x,y,z)]; return !c.p || c.p === player; });
  }

  function aiPick() {
    const player = 'red', opp = 'blue', N = G.N;
    const moves = validMoves(G.cells, player);
    if (!moves.length) return null;

    if (G.aiDifficulty === 'easy')
      return moves[Math.floor(Math.random() * moves.length)];

    let best = -Infinity, bestMoves = [];
    for (const [x,y,z] of moves) {
      const res = simulate(G.cells, N, player, x, y, z);
      let score = evaluate(res, N, player);

      if (G.aiDifficulty === 'hard') {
        const oppMoves = validMoves(res, opp);
        const sample   = oppMoves.length > 6
          ? oppMoves.sort(() => Math.random()-0.5).slice(0, 6) : oppMoves;
        if (sample.length) {
          let worst = Infinity;
          for (const [ox,oy,oz] of sample) {
            const s = evaluate(simulate(res, N, opp, ox, oy, oz), N, player);
            if (s < worst) worst = s;
          }
          score = worst;
        }
      }

      if (score > best) { best = score; bestMoves = [[x,y,z]]; }
      else if (score === best) bestMoves.push([x,y,z]);
    }
    return bestMoves[Math.floor(Math.random() * bestMoves.length)];
  }

  async function aiOpeningMove(epoch) {
    G.busy = true;
    $('red-ind').classList.add('thinking');
    await sleep(700 + Math.random() * 700);
    $('red-ind').classList.remove('thinking');
    if (G.epoch !== epoch || G.over) { G.busy = false; return; }
    const move = aiPick();
    if (move) {
      aimAt([move], G.N);
      await sleep(400);
      if (G.epoch === epoch && !G.over) await executeTurn(...move);
    }
    if (G.epoch === epoch) G.busy = false;
  }

  // ── Init helpers ───────────────────────────────────────────────────────────

  function resetState(N, aiMode, aiDifficulty, turn) {
    G.epoch++;
    G.N    = N;
    G.over = false;
    G.busy = false;
    G.played = { blue: false, red: false };
    G.turn = turn;
    G.aiMode = aiMode;
    G.aiDifficulty = aiDifficulty;
    G.surface = buildSurface(N);
    G.cells = {};
    for (const [x,y,z] of G.surface) G.cells[key(x,y,z)] = { p: null, n: 0 };
    targeting = false;
    criticalSet.clear();
    matAnims.clear();
    $('red-ind').classList.remove('thinking');
    $('win-modal').classList.add('hidden');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async function start(container, opts) {
    const ok = await loadThree();
    if (!ok) return false;

    if (!renderer) setupScene(container);
    ready = true;

    const { N, aiMode, aiDifficulty, turn } = opts;
    resetState(N, aiMode, aiDifficulty, turn);
    repositionCamera();
    rebuildMeshes();
    renderAll();
    updateHUD();

    if (turn === 'red' && aiMode) aiOpeningMove(G.epoch);
    return true;
  }

  function newRound(opts) {
    if (!ready) return;
    const { N, aiMode, aiDifficulty, turn } = opts;
    const sizeChanged = G.N !== N;
    resetState(N, aiMode, aiDifficulty, turn);
    rebuildMeshes();
    if (sizeChanged) repositionCamera();
    renderAll();
    updateHUD();
    if (turn === 'red' && aiMode) aiOpeningMove(G.epoch);
  }

  function isReady() { return ready; }

  return { start, newRound, isReady };

})();
