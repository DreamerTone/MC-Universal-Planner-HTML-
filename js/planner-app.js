(function () {
  const { FACES, humanName } = MCModelTools;

  const state = {
    engine: new MCAssetEngine(),
    selectedId: null,
    category: 'all',
    tool: 'place',
    query: '',
    creativeOpen: false,
    debugMode: localStorage.getItem('mcup.debug') === '1',
  };

  const world = {
    cells: new Map(),
    size: { x: 32, y: 24, z: 32 },
  };

  let scene, camera, renderer, gridPlane, blockRoot, controls, raycaster, pointer;
  const textureCache = new Map();
  const textureLoadPromises = new Map();
  const thumbnailCache = new Map();
  const thumbnailQueue = [];
  let thumbnailWorking = false;
  let thumbRenderer = null;
  let thumbScene = null;
  let thumbCamera = null;
  let needsRender = true;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    bindUI();
    initThree();
    renderCatalog();
    updateSelected();
    if (!loadPackFromQuery()) toast('Load a vanilla client jar to begin.');
  }

  function bindUI() {
    const fileInput = $('#pack-file');
    $('#load-pack').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) loadPack(file);
    });

    const drop = $('#drop-zone');
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') fileInput.click();
    });
    for (const name of ['dragenter', 'dragover']) {
      drop.addEventListener(name, e => {
        e.preventDefault();
        drop.classList.add('dragover');
      });
    }
    for (const name of ['dragleave', 'drop']) {
      drop.addEventListener(name, e => {
        e.preventDefault();
        drop.classList.remove('dragover');
      });
    }
    drop.addEventListener('drop', e => {
      const file = e.dataTransfer.files[0];
      if (file) loadPack(file);
    });

    $('#search').addEventListener('input', e => {
      state.query = e.target.value;
      renderCatalog();
    });
    $('#creative-search').addEventListener('input', renderCreativeGrid);

    $('#open-creative').addEventListener('click', openCreative);
    $('#close-creative').addEventListener('click', closeCreative);
    $('#creative-overlay').addEventListener('click', e => {
      if (e.target.id === 'creative-overlay') closeCreative();
    });
    $('#rerender').addEventListener('click', updateInspector);
    $('#state-json').addEventListener('input', updateDebugFromState);
    $('#clear-build').addEventListener('click', clearBuild);

    for (const tab of $$('.tab')) {
      tab.addEventListener('click', () => setPanel(tab.dataset.panel));
    }
    for (const id of ['place', 'use', 'erase', 'pick']) {
      $(`#tool-${id}`).addEventListener('click', () => setTool(id));
    }

    window.addEventListener('keydown', e => {
      if (e.key.toLowerCase() === 'e' && !isTyping()) {
        e.preventDefault();
        state.creativeOpen ? closeCreative() : openCreative();
      }
      if (e.key === 'Escape' && state.creativeOpen) closeCreative();
      if (e.key === 'F3' && !isTyping()) {
        e.preventDefault();
        toggleDebugMode();
      }
    });

    applyDebugMode();
  }

  function toggleDebugMode() {
    state.debugMode = !state.debugMode;
    localStorage.setItem('mcup.debug', state.debugMode ? '1' : '0');
    applyDebugMode();
    toast(state.debugMode ? 'Debug mode on (F3 to hide)' : 'Debug mode off');
  }

  function applyDebugMode() {
    const debugTab = document.querySelector('.tab[data-panel="debug"]');
    if (debugTab) debugTab.style.display = state.debugMode ? '' : 'none';
    const debugView = document.querySelector('.panel-view[data-panel-view="debug"]');
    if (debugView && !state.debugMode && debugView.classList.contains('active')) {
      setPanel('builder');
    }
    document.body.classList.toggle('debug-mode', state.debugMode);
  }

  async function loadPack(file) {
    try {
      toast(`Reading ${file.name}...`);
      const pack = await MCJarLoader.loadJar(file, (done, total) => {
        toast(`Parsing ${done.toLocaleString()} / ${total.toLocaleString()} files...`);
      });
      state.engine.addPack(pack);
      $('#pack-label').textContent = `${state.engine.blocks.size.toLocaleString()} blocks from ${state.engine.packs.length} pack(s)`;
      renderCatalog();
      toast(`Loaded ${file.name}.`);
    } catch (err) {
      console.error(err);
      toast(`Pack failed: ${err.message || err}`);
    }
  }

  function loadPackFromQuery() {
    const url = new URL(window.location.href);
    const packUrl = url.searchParams.get('pack');
    if (!packUrl) return false;
    (async () => {
      try {
        toast(`Fetching ${packUrl}...`);
        const res = await fetch(packUrl);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const blob = await res.blob();
        const name = packUrl.split('/').pop() || 'pack.jar';
        await loadPack(new File([blob], name, { type: blob.type || 'application/java-archive' }));
      } catch (err) {
        console.error(err);
        toast(`Pack failed: ${err.message || err}`);
      }
    })();
    return true;
  }

  function renderCatalog() {
    const entries = state.engine.allBlocks({ query: state.query, category: state.category });
    $('#block-count').textContent = `${entries.length.toLocaleString()} blocks`;
    $('#library-count').textContent = entries.length.toLocaleString();

    $('#categories').innerHTML = state.engine.categories().map(cat => `
      <button class="category-chip ${cat.id === state.category ? 'active' : ''}" data-category="${escapeHtml(cat.id)}">
        ${escapeHtml(cat.label)} ${cat.count}
      </button>
    `).join('');
    for (const chip of $$('#categories .category-chip')) {
      chip.addEventListener('click', () => {
        state.category = chip.dataset.category;
        renderCatalog();
      });
    }

    $('#library-grid').innerHTML = entries.slice(0, 400).map(blockCard).join('');
    bindBlockCards($('#library-grid'));
    renderCreativeTabs();
    renderCreativeGrid();
  }

  function renderCreativeTabs() {
    $('#creative-tabs').innerHTML = state.engine.categories().map(cat => `
      <button class="category-chip ${cat.id === state.category ? 'active' : ''}" data-category="${escapeHtml(cat.id)}">
        ${escapeHtml(cat.label)}
      </button>
    `).join('');
    for (const chip of $$('#creative-tabs .category-chip')) {
      chip.addEventListener('click', () => {
        state.category = chip.dataset.category;
        renderCatalog();
      });
    }
  }

  function renderCreativeGrid() {
    const entries = state.engine.allBlocks({
      query: $('#creative-search').value || state.query,
      category: state.category,
    });
    $('#creative-meta').textContent = `${entries.length.toLocaleString()} blocks`;
    $('#creative-grid').innerHTML = entries.slice(0, 700).map(blockCard).join('');
    bindBlockCards($('#creative-grid'));
  }

  function blockCard(entry) {
    const active = entry.id === state.selectedId ? 'active' : '';
    const layer0 = state.engine.itemLayer0(entry.id);
    const cached = thumbnailCache.get(entry.id);
    let iconHtml;
    if (layer0) {
      iconHtml = `<img class="card-icon" src="${layer0}" alt="">`;
    } else if (cached) {
      iconHtml = `<img class="card-icon" src="${cached}" alt="">`;
    } else {
      const fallback = entry.icon ? ` style="background-image:url('${entry.icon}')"` : '';
      iconHtml = `<span class="card-icon pending" data-thumb="${escapeHtml(entry.id)}"${fallback}></span>`;
    }
    return `
      <button class="block-card ${active}" data-id="${escapeHtml(entry.id)}">
        ${iconHtml}
        <span>
          <strong>${escapeHtml(entry.displayName)}</strong>
          <em>${escapeHtml(entry.id)}</em>
          <span class="shape-tag">${escapeHtml(entry.shape || 'unknown')}</span>
        </span>
      </button>
    `;
  }

  function bindBlockCards(root) {
    for (const card of root.querySelectorAll('.block-card')) {
      card.addEventListener('click', () => selectBlock(card.dataset.id));
    }
    queueVisibleThumbnails(root);
  }

  function queueVisibleThumbnails(root) {
    const pending = root.querySelectorAll('.card-icon.pending[data-thumb]');
    if (!pending.length) return;
    if (!('IntersectionObserver' in window)) {
      pending.forEach(el => requestThumbnail(el.dataset.thumb));
      return;
    }
    const io = new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const id = entry.target.dataset.thumb;
          if (id) requestThumbnail(id);
          observer.unobserve(entry.target);
        }
      }
    }, { rootMargin: '120px' });
    pending.forEach(el => io.observe(el));
  }

  function requestThumbnail(id) {
    if (thumbnailCache.has(id)) {
      paintThumbnail(id, thumbnailCache.get(id));
      return;
    }
    if (thumbnailQueue.includes(id)) return;
    thumbnailQueue.push(id);
    pumpThumbnailQueue();
  }

  async function pumpThumbnailQueue() {
    if (thumbnailWorking || !thumbnailQueue.length) return;
    thumbnailWorking = true;
    try {
      while (thumbnailQueue.length) {
        const id = thumbnailQueue.shift();
        try {
          const url = await renderThumbnail(id);
          if (url) {
            thumbnailCache.set(id, url);
            paintThumbnail(id, url);
          }
        } catch (err) {
          console.warn('[thumbnail]', id, err);
        }
        await new Promise(r => setTimeout(r, 0));
      }
    } finally {
      thumbnailWorking = false;
    }
  }

  function paintThumbnail(id, url) {
    for (const el of document.querySelectorAll(`.card-icon.pending[data-thumb="${cssEscape(id)}"]`)) {
      el.outerHTML = `<img class="card-icon" src="${url}" alt="">`;
    }
  }

  function ensureThumbnailRenderer() {
    if (thumbRenderer) return;
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    thumbRenderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
    thumbRenderer.setPixelRatio(1);
    thumbRenderer.setClearColor(0x000000, 0);
    thumbScene = new THREE.Scene();
    thumbScene.add(new THREE.AmbientLight(0xffffff, 0.78));
    const key = new THREE.DirectionalLight(0xffffff, 0.7);
    key.position.set(2, 3, 2);
    thumbScene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-2, 1, -1);
    thumbScene.add(fill);
    thumbCamera = new THREE.OrthographicCamera(-0.85, 0.85, 0.85, -0.85, 0.1, 10);
    thumbCamera.position.set(2, 2, 2);
    thumbCamera.lookAt(0, 0, 0);
  }

  async function renderThumbnail(id) {
    const entry = state.engine.blocks.get(id);
    if (!entry) return null;
    ensureThumbnailRenderer();
    const object = objectFor(id, entry.defaultState || {});
    if (!object) return null;
    await waitForTextures(object);
    forceTextureUpload(object);
    object.rotation.set(0, 0, 0);
    thumbScene.add(object);
    try {
      // Render twice: first call uploads textures to the thumb-renderer's
      // GL context, second snapshots the fully-textured frame.
      thumbRenderer.render(thumbScene, thumbCamera);
      thumbRenderer.render(thumbScene, thumbCamera);
      return thumbRenderer.domElement.toDataURL('image/png');
    } finally {
      thumbScene.remove(object);
      disposeObject(object);
    }
  }

  function forceTextureUpload(root) {
    root.traverse(child => {
      const mats = Array.isArray(child.material) ? child.material : (child.material ? [child.material] : []);
      for (const mat of mats) {
        if (mat.map) {
          mat.map.needsUpdate = true;
          if (thumbRenderer && typeof thumbRenderer.initTexture === 'function') {
            try { thumbRenderer.initTexture(mat.map); } catch (e) { /* ignore */ }
          }
        }
      }
    });
  }

  function waitForTextures(root) {
    const promises = [];
    root.traverse(child => {
      const mats = Array.isArray(child.material) ? child.material : (child.material ? [child.material] : []);
      for (const mat of mats) {
        const url = mat.userData?.textureUrl;
        if (!url) continue;
        const pending = textureLoadPromises.get(url);
        if (pending) {
          promises.push(Promise.race([
            pending,
            new Promise(r => setTimeout(r, 1500)),
          ]));
        }
      }
    });
    return Promise.all(promises);
  }

  function disposeObject(root) {
    root.traverse(child => {
      if (child.geometry) child.geometry.dispose();
    });
  }

  function cssEscape(value) {
    return String(value).replace(/(["\\])/g, '\\$1');
  }

  function selectBlock(id) {
    state.selectedId = id;
    closeCreative();
    updateSelected();
    renderCatalog();
  }

  function updateSelected() {
    const entry = state.engine.blocks.get(state.selectedId);
    if (!entry) {
      $('#selected-card').className = 'selected-empty';
      $('#selected-card').textContent = 'No block selected';
      updateInspector();
      return;
    }
    $('#selected-card').className = 'selected-card-box';
    const layer0 = state.engine.itemLayer0(entry.id);
    const thumb = thumbnailCache.get(entry.id);
    let iconHtml;
    if (layer0) iconHtml = `<img src="${layer0}" alt="">`;
    else if (thumb) iconHtml = `<img src="${thumb}" alt="">`;
    else {
      iconHtml = `<span class="card-icon pending" data-thumb="${escapeHtml(entry.id)}"></span>`;
      requestThumbnail(entry.id);
    }
    $('#selected-card').innerHTML = `
      ${iconHtml}
      <span>
        <strong>${escapeHtml(entry.displayName)}</strong>
        <em>${escapeHtml(entry.id)}</em>
        <span class="shape-tag">${escapeHtml(entry.shape)}</span>
      </span>
    `;
    $('#state-json').value = JSON.stringify(entry.defaultState || {}, null, 2);
    updateInspector();
  }

  function updateInspector() {
    const id = state.selectedId;
    if (!id) {
      $('#model-truth').textContent = 'Load a pack, then choose a block.';
      $('#debug-json').textContent = 'Nothing selected.';
      $('#debug-id').textContent = '';
      return;
    }
    const stateJson = readStateJson();
    const debug = state.engine.debugBlock(id, stateJson);
    $('#debug-id').textContent = id;
    $('#model-truth').textContent = JSON.stringify({
      id,
      shape: debug.shape,
      parts: debug.parts.length,
      elements: debug.parts.reduce((sum, part) => sum + part.elementCount, 0),
      modelSources: debug.parts.map(part => part.source),
      textureKeys: Array.from(new Set(debug.parts.flatMap(part => part.textureKeys))),
    }, null, 2);
    $('#debug-json').textContent = JSON.stringify(debug, null, 2);
  }

  function updateDebugFromState() {
    updateInspector();
  }

  function setPanel(panel) {
    for (const tab of $$('.tab')) tab.classList.toggle('active', tab.dataset.panel === panel);
    for (const view of $$('.panel-view')) view.classList.toggle('active', view.dataset.panelView === panel);
  }

  function setTool(tool) {
    state.tool = tool;
    for (const id of ['place', 'use', 'erase', 'pick']) $(`#tool-${id}`).classList.toggle('active', id === tool);
  }

  function openCreative() {
    state.creativeOpen = true;
    $('#creative-overlay').classList.remove('hidden');
    $('#creative-overlay').setAttribute('aria-hidden', 'false');
    $('#creative-search').focus();
  }

  function closeCreative() {
    state.creativeOpen = false;
    $('#creative-overlay').classList.add('hidden');
    $('#creative-overlay').setAttribute('aria-hidden', 'true');
  }

  function initThree() {
    const canvas = $('#builder-canvas');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x151922);
    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = false;

    blockRoot = new THREE.Group();
    scene.add(blockRoot);
    scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const sun = new THREE.DirectionalLight(0xffffff, 0.82);
    sun.position.set(8, 14, 6);
    scene.add(sun);

    const grid = new THREE.GridHelper(world.size.x, world.size.x, 0x526176, 0x303845);
    grid.position.set(0, 0, 0);
    scene.add(grid);

    gridPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(world.size.x, world.size.z),
      new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    );
    gridPlane.rotation.x = -Math.PI / 2;
    scene.add(gridPlane);

    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();
    controls = { yaw: Math.PI / 4, pitch: 0.62, radius: 34, target: new THREE.Vector3(0, 1.5, 0) };

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      controls.radius *= e.deltaY > 0 ? 1.08 : 0.92;
      controls.radius = clamp(controls.radius, 8, 90);
      needsRender = true;
    }, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    new ResizeObserver(resize).observe(canvas.parentElement);
    resize();
    loop();
  }

  function onPointerDown(e) {
    const canvas = $('#builder-canvas');
    canvas.setPointerCapture(e.pointerId);
    canvas._drag = { x: e.clientX, y: e.clientY, yaw: controls.yaw, pitch: controls.pitch, moved: false };
  }

  function onPointerMove(e) {
    const canvas = $('#builder-canvas');
    if (!canvas._drag) {
      updateCursor(e);
      return;
    }
    const dx = e.clientX - canvas._drag.x;
    const dy = e.clientY - canvas._drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) canvas._drag.moved = true;
    if (e.buttons === 1 && canvas._drag.moved) {
      controls.yaw = canvas._drag.yaw - dx * 0.01;
      controls.pitch = clamp(canvas._drag.pitch - dy * 0.01, -1.15, 1.2);
      needsRender = true;
    }
  }

  $('#builder-canvas')?.addEventListener?.('pointerup', onPointerUp);

  function onPointerUp(e) {
    const canvas = $('#builder-canvas');
    const drag = canvas._drag;
    canvas._drag = null;
    if (!drag || drag.moved) return;
    const hit = pick(e);
    if (!hit) return;
    if (state.tool === 'pick') {
      const key = hit.cellKey;
      if (key && world.cells.has(key)) selectBlock(world.cells.get(key).id);
      return;
    }
    const isRight = e.button === 2;
    if (state.debugMode && isRight && hit.cellKey) {
      cycleStateAt(hit.cell);
      return;
    }
    if ((state.tool === 'use' || (isRight && hit.cellKey)) && hit.cellKey) {
      useCell(hit.cell);
      return;
    }
    const erase = e.shiftKey || state.tool === 'erase';
    if (erase) eraseCell(hit.cell);
    else placeAt(hit.placeCell, hit.normal, hit.cell);
  }

  function updateCursor(e) {
    const hit = pick(e);
    $('#cursor-label').textContent = hit ? `${hit.placeCell.x}, ${hit.placeCell.y}, ${hit.placeCell.z}` : 'Ready';
  }

  function pick(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const objects = [];
    blockRoot.traverse(obj => { if (obj.isMesh) objects.push(obj); });
    objects.push(gridPlane);
    const hit = raycaster.intersectObjects(objects, false)[0];
    if (!hit) return null;
    const cellKey = hit.object.userData.cellKey;
    if (cellKey) {
      const base = parseCell(cellKey);
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).round();
      return { cellKey, cell: base, placeCell: addCell(base, normal), normal };
    }
    const p = hit.point;
    return {
      cellKey: null,
      cell: null,
      placeCell: { x: Math.floor(p.x + world.size.x / 2), y: 0, z: Math.floor(p.z + world.size.z / 2) },
      normal: new THREE.Vector3(0, 1, 0),
    };
  }

  function placeAt(cell, normal, hitCell) {
    placeBlockId(state.selectedId, cell, normal, hitCell);
  }

  function placeBlockId(blockId, cell, normal, hitCell) {
    if (!blockId) return;
    const resolved = resolvePlacementBlock(blockId, normal);
    const entry = state.engine.blocks.get(resolved);
    if (!entry || !inside(cell)) return;

    // Slab merge: clicking on a same-material slab promotes it to double.
    if (entry.behavior?.slabMergeable && hitCell) {
      const target = world.cells.get(cellKey(hitCell));
      if (target && target.id === entry.id && target.state?.type !== 'double') {
        target.state = Object.assign({}, target.state, { type: 'double' });
        rebuildCellObject(cellKey(hitCell), target);
        afterWorldChange();
        return;
      }
    }

    // Snow layer stacking: clicking on top of same snow adds a layer.
    if (entry.behavior?.snowStackable && hitCell) {
      const target = world.cells.get(cellKey(hitCell));
      if (target && target.id === entry.id) {
        const n = Math.min(8, Number(target.state?.layers || '1') + 1);
        if (n >= 8) {
          // Promote to full snow block if registry has one; otherwise cap at 8 layers.
          const snowFull = state.engine.blocks.get(entry.ns + ':snow_block');
          if (snowFull) {
            target.id = snowFull.id;
            target.state = snowFull.defaultState || {};
          } else {
            target.state = Object.assign({}, target.state, { layers: '8' });
          }
        } else {
          target.state = Object.assign({}, target.state, { layers: String(n) });
        }
        rebuildCellObject(cellKey(hitCell), target);
        afterWorldChange();
        return;
      }
    }

    if (!canPlaceAt(entry, cell, normal)) return;
    const placementState = placementStateFor(entry, cell, normal);

    // Door: place lower at cell, upper at cell+(0,1,0).
    if (entry.behavior?.doorTwoBlock) {
      const upperCell = addCell(cell, { x: 0, y: 1, z: 0 });
      if (!inside(upperCell)) return;
      if (world.cells.has(cellKey(cell)) || world.cells.has(cellKey(upperCell))) return;
      const lowerState = Object.assign({}, placementState, { half: 'lower' });
      const upperState = Object.assign({}, placementState, { half: 'upper' });
      setCell(cell, entry.id, lowerState, { quiet: true });
      setCell(upperCell, entry.id, upperState, { quiet: true });
      solveConnectionsNear(cell);
      afterWorldChange();
      return;
    }

    // Bed: place foot at cell, head at cell+facing.
    if (entry.behavior?.bedTwoBlock) {
      const headDelta = facingDelta(placementState.facing || 'north');
      const headCell = addCell(cell, headDelta);
      if (!inside(headCell)) return;
      if (world.cells.has(cellKey(cell)) || world.cells.has(cellKey(headCell))) return;
      setCell(cell, entry.id, Object.assign({}, placementState, { part: 'foot' }), { quiet: true });
      setCell(headCell, entry.id, Object.assign({}, placementState, { part: 'head' }), { quiet: true });
      afterWorldChange();
      return;
    }

    setCell(cell, entry.id, placementState, { quiet: true });
    solveConnectionsNear(cell);
    afterWorldChange();
  }

  // Choose the right block id for the clicked face. Vanilla treats wall
  // torches/signs as distinct blocks, so picking 'torch' and clicking a
  // side should place wall_torch facing away from that wall.
  function resolvePlacementBlock(blockId, normal) {
    const entry = state.engine.blocks.get(blockId);
    if (!entry || !normal) return blockId;
    const sideClick = Math.abs(normal.x) + Math.abs(normal.z) > 0.5;
    const tryNames = [];
    if (sideClick) {
      if (entry.behavior?.torch && !entry.behavior?.wallTorch) {
        tryNames.push(entry.name.replace(/torch$/, 'wall_torch'));
      }
      if (entry.behavior?.sign && !entry.behavior?.wallSign) {
        tryNames.push(entry.name.replace(/hanging_sign$/, 'wall_hanging_sign'));
        tryNames.push(entry.name.replace(/sign$/, 'wall_sign'));
      }
      if (entry.behavior?.banner && !entry.behavior?.wallBanner) {
        tryNames.push(entry.name.replace(/banner$/, 'wall_banner'));
      }
      if (entry.behavior?.head && !entry.behavior?.wallHead) {
        tryNames.push(entry.name.replace(/(skull|head)$/, 'wall_$1'));
      }
    } else {
      if (entry.behavior?.wallTorch) tryNames.push(entry.name.replace(/wall_torch$/, 'torch'));
      if (entry.behavior?.wallSign) tryNames.push(entry.name.replace(/wall_hanging_sign$/, 'hanging_sign'), entry.name.replace(/wall_sign$/, 'sign'));
      if (entry.behavior?.wallBanner) tryNames.push(entry.name.replace(/wall_banner$/, 'banner'));
      if (entry.behavior?.wallHead) tryNames.push(entry.name.replace(/wall_(skull|head)$/, '$1'));
    }
    for (const name of tryNames) {
      const w = state.engine.blocks.get(`${entry.ns}:${name}`);
      if (w) return w.id;
    }
    return blockId;
  }

  function canPlaceAt(entry, cell, normal) {
    if (world.cells.has(cellKey(cell))) return false;
    const b = entry.behavior || {};
    const sideClick = Math.abs(normal.x) + Math.abs(normal.z) > 0.5;
    const verticalClick = Math.abs(normal.y) > 0.5;
    const floorClick = normal.y > 0.5;
    const ceilingClick = normal.y < -0.5;
    if ((b.wallTorch || b.wallSign || b.wallBanner || b.wallHead || b.ladder) && !sideClick) return false;
    if (b.ceilingSign && !ceilingClick) return false;
    if ((b.torch || (b.sign && !b.ceilingSign) || b.banner || b.head) && !floorClick) return false;
    if (b.floorOnly && !floorClick) return false;
    if (b.lanternHangable && !verticalClick) return false;
    return true;
  }

  // Test hook for the Playwright harness; harmless in production.
  window.__plannerTest = {
    placeBlock(cell, id, normal, hitCell) {
      const n = normal ? new THREE.Vector3(normal.x || 0, normal.y || 0, normal.z || 0) : new THREE.Vector3(0, 1, 0);
      placeBlockId(id, cell, n, hitCell);
    },
    setState(cell, partial) {
      const record = world.cells.get(cellKey(cell));
      if (!record) return;
      record.state = Object.assign({}, record.state, partial);
      rebuildCellObject(cellKey(cell), record);
      afterWorldChange();
    },
    snapshot() {
      return Array.from(world.cells.entries()).map(([key, record]) => ({ key, id: record.id, state: record.state }));
    },
    world,
  };

  function setCell(cell, id, blockState, opts = {}) {
    const key = cellKey(cell);
    const old = world.cells.get(key);
    if (old) blockRoot.remove(old.object);
    const record = { id, state: blockState, object: null };
    world.cells.set(key, record);
    rebuildCellObject(key, record);
    if (!opts.quiet) afterWorldChange();
  }

  function rebuildCellObject(key, record) {
    if (record.object) blockRoot.remove(record.object);
    const cell = parseCell(key);
    const object = objectFor(record.id, record.state);
    object.position.set(cell.x - world.size.x / 2 + 0.5, cell.y + 0.5, cell.z - world.size.z / 2 + 0.5);
    object.traverse(child => { child.userData.cellKey = key; });
    blockRoot.add(object);
    record.object = object;
  }

  function eraseCell(cell) {
    if (!cell) return;
    const key = cellKey(cell);
    const old = world.cells.get(key);
    if (!old) return;
    const entry = state.engine.blocks.get(old.id);

    // Doors + beds are two-cell structures. Remove the linked half too so we
    // never leave a phantom half-door behind.
    const linked = linkedCell(old, cell, entry);

    blockRoot.remove(old.object);
    world.cells.delete(key);
    if (linked) {
      const linkedKey = cellKey(linked);
      const other = world.cells.get(linkedKey);
      if (other && other.id === old.id) {
        blockRoot.remove(other.object);
        world.cells.delete(linkedKey);
      }
    }
    solveConnectionsNear(cell);
    if (linked) solveConnectionsNear(linked);
    afterWorldChange();
  }

  function linkedCell(record, cell, entry) {
    if (!record || !entry) return null;
    if (entry.behavior?.doorTwoBlock) {
      const half = record.state?.half || 'lower';
      return half === 'lower' ? addCell(cell, { x: 0, y: 1, z: 0 }) : addCell(cell, { x: 0, y: -1, z: 0 });
    }
    if (entry.behavior?.bedTwoBlock) {
      const part = record.state?.part || 'foot';
      const facing = record.state?.facing || 'north';
      const d = facingDelta(facing);
      return part === 'foot' ? addCell(cell, d) : addCell(cell, { x: -d.x, y: 0, z: -d.z });
    }
    return null;
  }

  // Cycle the most useful state property for the block under the cursor,
  // Minecraft Debug Stick style. Only enabled while debug mode is on.
  function cycleStateAt(cell) {
    const key = cellKey(cell);
    const record = world.cells.get(key);
    if (!record) return;
    const entry = state.engine.blocks.get(record.id);
    if (!entry || !entry.stateSchema) return;
    const keys = Object.keys(entry.stateSchema);
    if (!keys.length) return;
    const priority = ['facing', 'shape', 'half', 'type', 'axis', 'hanging', 'open', 'powered', 'face', 'hinge', 'layers', 'rotation'];
    const pick = priority.find(k => keys.includes(k)) || keys[0];
    const values = entry.stateSchema[pick] || [];
    if (!values.length) return;
    const current = String(record.state?.[pick] ?? values[0]);
    const idx = values.indexOf(current);
    const next = values[(idx + 1) % values.length];
    record.state = Object.assign({}, record.state, { [pick]: next });
    rebuildCellObject(key, record);
    solveConnectionsNear(cell);
    toast(`${entry.id} ${pick} = ${next}`);
    afterWorldChange();
  }

  function useCell(cell) {
    const key = cellKey(cell);
    const record = world.cells.get(key);
    if (!record) return;
    const entry = state.engine.blocks.get(record.id);
    if (!entry?.stateSchema) return;

    const schema = entry.stateSchema;
    const nextState = Object.assign({}, record.state);
    let changedKey = null;
    if ('open' in schema) {
      nextState.open = record.state?.open === 'true' ? 'false' : 'true';
      changedKey = 'open';
    } else if ('powered' in schema) {
      nextState.powered = record.state?.powered === 'true' ? 'false' : 'true';
      changedKey = 'powered';
    } else if ('delay' in schema) {
      nextState.delay = nextCycleValue(schema.delay, record.state?.delay || '1');
      changedKey = 'delay';
    } else if ('mode' in schema) {
      nextState.mode = nextCycleValue(schema.mode, record.state?.mode || schema.mode[0]);
      changedKey = 'mode';
    } else if ('bites' in schema) {
      nextState.bites = nextCycleValue(schema.bites, record.state?.bites || '0');
      changedKey = 'bites';
    } else if ('candles' in schema) {
      nextState.candles = nextCycleValue(schema.candles, record.state?.candles || '1');
      changedKey = 'candles';
    } else if ('pickles' in schema) {
      nextState.pickles = nextCycleValue(schema.pickles, record.state?.pickles || '1');
      changedKey = 'pickles';
    } else if ('charges' in schema) {
      nextState.charges = nextCycleValue(schema.charges, record.state?.charges || '0');
      changedKey = 'charges';
    } else if ('level' in schema) {
      nextState.level = nextCycleValue(schema.level, record.state?.level || '0');
      changedKey = 'level';
    } else if ('note' in schema) {
      nextState.note = nextCycleValue(schema.note, record.state?.note || '0');
      changedKey = 'note';
    } else if ('eye' in schema) {
      nextState.eye = record.state?.eye === 'true' ? 'false' : 'true';
      changedKey = 'eye';
    }

    if (!changedKey) return;
    record.state = nextState;
    rebuildCellObject(key, record);
    const linked = linkedCell(record, cell, entry);
    if (linked) {
      const other = world.cells.get(cellKey(linked));
      if (other && other.id === record.id && changedKey in (state.engine.blocks.get(other.id)?.stateSchema || {})) {
        other.state = Object.assign({}, other.state, { [changedKey]: nextState[changedKey] });
        rebuildCellObject(cellKey(linked), other);
      }
    }
    solveConnectionsNear(cell);
    toast(`${entry.displayName} ${changedKey} = ${nextState[changedKey]}`);
    afterWorldChange();
  }

  function nextCycleValue(values, current) {
    const list = (values || []).slice().sort((a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)));
    if (!list.length) return current;
    const idx = list.indexOf(String(current));
    return list[(idx + 1 + list.length) % list.length];
  }

  function clearBuild() {
    for (const cell of world.cells.values()) blockRoot.remove(cell.object);
    world.cells.clear();
    afterWorldChange();
  }

  function solveConnectionsNear(cell) {
    const keys = new Set();
    for (const next of neighborhood(cell)) {
      const key = cellKey(next);
      if (world.cells.has(key)) keys.add(key);
    }

    const dirty = new Set();
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const key of keys) {
        const next = parseCell(key);
        const record = world.cells.get(key);
        if (!record) continue;
        const entry = state.engine.blocks.get(record.id);
        if (!entry) continue;
        let merged = record.state;
        if (hasConnectorState(entry)) {
          merged = Object.assign({}, merged, connectorState(record.id, next));
        }
        if (entry.behavior?.stairShape) {
          merged = Object.assign({}, merged, { shape: solveStairShape(record, next) });
        }
        if (entry.behavior?.fenceGateInWall) {
          merged = Object.assign({}, merged, { in_wall: fenceGateInWallValue(merged, next) ? 'true' : 'false' });
        }
        if (entry.behavior?.railShape) {
          merged = Object.assign({}, merged, { shape: solveRailShape(record, next) });
        }
        if (entry.behavior?.redstoneWire) {
          merged = Object.assign({}, merged, redstoneWireState(record.id, next));
        }
        if (entry.behavior?.chestConnect) {
          merged = Object.assign({}, merged, { type: solveChestType(record, next) });
        }
        if (sameState(merged, record.state)) continue;
        record.state = merged;
        dirty.add(key);
        changed = true;
      }
      if (!changed) break;
    }

    for (const key of dirty) {
      const record = world.cells.get(key);
      if (!record) continue;
      rebuildCellObject(key, record);
    }
  }

  function afterWorldChange() {
    $('#build-count').textContent = `${world.cells.size.toLocaleString()} placed`;
    needsRender = true;
  }

  function placementStateFor(entry, cell, normal) {
    const out = Object.assign({}, entry.defaultState || {});
    const b = entry.behavior || {};
    const sideClick = Math.abs(normal.x) + Math.abs(normal.z) > 0.5;
    const ceilingClick = normal.y < -0.5; // clicked the bottom face of a block above
    const floorClick = normal.y > 0.5;

    if (b.axisOnPlace) out.axis = Math.abs(normal.x) ? 'x' : (Math.abs(normal.z) ? 'z' : 'y');

    if (b.sixWayFacing) {
      out.facing = normalToFacing(normal);
    } else if (b.horizontalFacingOnPlace || b.shape === 'stairs' || b.shape === 'door' || b.shape === 'bed' || b.shape === 'fence gate' || b.shape === 'trapdoor') {
      // Player-relative blocks: face the player (opposite of camera yaw).
      out.facing = facingFromCamera();
    }

    if (b.rotationOnPlace && 'rotation' in out) {
      out.rotation = String(rotationFromCamera());
    }

    if (b.shape === 'stairs') {
      out.half = ceilingClick ? 'top' : 'bottom';
      out.shape = 'straight';
    } else if (b.shape === 'slab') {
      // Slab: top half if you clicked the bottom face of a block above, OR
      // if you hit the upper half of the block face. Without sub-cell
      // precision we approximate using the surface normal.
      out.type = ceilingClick ? 'top' : 'bottom';
    } else if (b.trapdoorPlacement) {
      // Trapdoor attaches to the face you clicked. Half = the side of that face.
      if (sideClick) {
        out.half = 'bottom';
        out.facing = normal.x > 0 ? 'west' : normal.x < 0 ? 'east' : normal.z > 0 ? 'north' : 'south';
      } else {
        out.half = ceilingClick ? 'top' : 'bottom';
      }
      out.open = 'false';
    } else if (b.halfOnPlace) {
      out.half = ceilingClick ? 'top' : 'bottom';
    }

    if (b.lanternHangable) {
      out.hanging = ceilingClick ? 'true' : 'false';
    }

    if (b.doorTwoBlock) {
      out.hinge = preferredDoorHinge(entry, cell, out.facing || 'north');
    }

    if (b.fenceGateInWall) {
      out.in_wall = fenceGateInWallValue(out, cell) ? 'true' : 'false';
    }

    if (b.railShape) {
      out.shape = defaultRailShape(entry, out);
    }

    if (b.redstoneWire) {
      out.power = out.power || '0';
    }

    if (b.faceAttachment) {
      // Buttons/levers: face=floor/wall/ceiling derived from clicked surface.
      if (floorClick) {
        out.face = 'floor';
        out.facing = facingFromCamera();
      } else if (ceilingClick) {
        out.face = 'ceiling';
        out.facing = facingFromCamera();
      } else if (sideClick) {
        out.face = 'wall';
        // facing points OUT from the wall (away from the supporting block).
        out.facing = normal.x > 0 ? 'east' : normal.x < 0 ? 'west' : normal.z > 0 ? 'south' : 'north';
      }
    }

    if (b.wallTorch || b.wallSign || b.ladder) {
      // Wall-mounted blocks: face the open space (same as the normal direction).
      if (sideClick) {
        out.facing = normal.x > 0 ? 'east' : normal.x < 0 ? 'west' : normal.z > 0 ? 'south' : 'north';
      }
    }

    if (b.wallBanner || b.wallHead) {
      if (sideClick) out.facing = normalToFacing(normal);
    }

    if (b.snowStackable && !out.layers) out.layers = '1';

    return out;
  }

  function normalToFacing(normal) {
    if (normal.y > 0.5) return 'up';
    if (normal.y < -0.5) return 'down';
    if (normal.x > 0.5) return 'east';
    if (normal.x < -0.5) return 'west';
    if (normal.z > 0.5) return 'south';
    if (normal.z < -0.5) return 'north';
    return facingFromCamera();
  }

  function rotationFromCamera() {
    // Standing signs/banners use Minecraft's 16-step horizontal rotation.
    const angle = ((controls.yaw + Math.PI * 2) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    return Math.round((angle / (Math.PI * 2)) * 16) & 15;
  }

  function preferredDoorHinge(entry, cell, facing) {
    const leftCell = addCell(cell, facingDelta(ccw(facing)));
    const rightCell = addCell(cell, facingDelta(cw(facing)));
    const left = world.cells.get(cellKey(leftCell));
    const right = world.cells.get(cellKey(rightCell));
    const sameDoor = (record) => record?.id === entry.id && (record.state?.facing || 'north') === facing;
    if (sameDoor(left) && !sameDoor(right)) return 'right';
    if (sameDoor(right) && !sameDoor(left)) return 'left';
    const leftSolid = isSolidCell(leftCell);
    const rightSolid = isSolidCell(rightCell);
    if (leftSolid && !rightSolid) return 'right';
    if (rightSolid && !leftSolid) return 'left';
    return 'left';
  }

  function fenceGateInWallValue(stateLike, cell) {
    const facing = stateLike.facing || 'north';
    const checks = axisForSide(facing) === 'z'
      ? [{ side: 'east', delta: { x: 1, y: 0, z: 0 } }, { side: 'west', delta: { x: -1, y: 0, z: 0 } }]
      : [{ side: 'north', delta: { x: 0, y: 0, z: -1 } }, { side: 'south', delta: { x: 0, y: 0, z: 1 } }];
    return checks.some(({ delta }) => {
      const other = world.cells.get(cellKey(addCell(cell, delta)));
      const otherEntry = other && state.engine.blocks.get(other.id);
      return otherEntry?.behavior?.connector === 'wall';
    });
  }

  function defaultRailShape(entry, stateLike = {}) {
    const values = entry.stateSchema?.shape || [];
    const preferred = axisForSide(stateLike.facing || facingFromCamera()) === 'x' ? 'east_west' : 'north_south';
    if (values.includes(preferred)) return preferred;
    if (values.includes('north_south')) return 'north_south';
    if (values.includes('east_west')) return 'east_west';
    return values[0] || 'north_south';
  }

  function solveRailShape(record, cell) {
    const entry = state.engine.blocks.get(record.id);
    const values = entry?.stateSchema?.shape || [];
    if (!values.length) return record.state?.shape || 'north_south';
    const allow = (shape) => values.includes(shape);
    const railAt = (delta) => {
      const other = world.cells.get(cellKey(addCell(cell, delta)));
      const otherEntry = other && state.engine.blocks.get(other.id);
      return !!otherEntry?.behavior?.railShape;
    };

    if (allow('ascending_east') && railAt({ x: 1, y: 1, z: 0 })) return 'ascending_east';
    if (allow('ascending_west') && railAt({ x: -1, y: 1, z: 0 })) return 'ascending_west';
    if (allow('ascending_south') && railAt({ x: 0, y: 1, z: 1 })) return 'ascending_south';
    if (allow('ascending_north') && railAt({ x: 0, y: 1, z: -1 })) return 'ascending_north';

    const n = railAt({ x: 0, y: 0, z: -1 });
    const s = railAt({ x: 0, y: 0, z: 1 });
    const e = railAt({ x: 1, y: 0, z: 0 });
    const w = railAt({ x: -1, y: 0, z: 0 });

    if (!n && !s && e && w && allow('east_west')) return 'east_west';
    if (!e && !w && n && s && allow('north_south')) return 'north_south';
    if (n && e && !s && !w && allow('north_east')) return 'north_east';
    if (n && w && !s && !e && allow('north_west')) return 'north_west';
    if (s && e && !n && !w && allow('south_east')) return 'south_east';
    if (s && w && !n && !e && allow('south_west')) return 'south_west';
    if ((e || w) && allow('east_west')) return 'east_west';
    if ((n || s) && allow('north_south')) return 'north_south';
    if (allow(record.state?.shape)) return record.state.shape;
    return defaultRailShape(entry, record.state);
  }

  function redstoneWireState(id, cell) {
    const entry = state.engine.blocks.get(id);
    const sides = {
      north: { x: 0, y: 0, z: -1 },
      east: { x: 1, y: 0, z: 0 },
      south: { x: 0, y: 0, z: 1 },
      west: { x: -1, y: 0, z: 0 },
    };
    const out = {};
    for (const [side, delta] of Object.entries(sides)) {
      const other = world.cells.get(cellKey(addCell(cell, delta)));
      out[side] = redstoneWireValue(entry, !!other && canRedstoneConnect(other, side));
    }
    return out;
  }

  function redstoneWireValue(entry, connected) {
    const values = entry?.stateSchema?.north || [];
    if (values.includes('side') || values.includes('up') || values.includes('none')) {
      return connected ? 'side' : 'none';
    }
    return connected ? 'true' : 'false';
  }

  function canRedstoneConnect(otherRecord) {
    const other = state.engine.blocks.get(otherRecord.id);
    if (!other) return false;
    return !!(other.behavior?.redstoneWire || other.behavior?.redstoneTarget || other.id.endsWith(':redstone_block'));
  }

  function solveChestType(record, cell) {
    const entry = state.engine.blocks.get(record.id);
    const values = entry?.stateSchema?.type || [];
    if (!values.includes('left') || !values.includes('right')) return record.state?.type || 'single';
    const facing = record.state?.facing || 'north';
    const same = (delta) => {
      const other = world.cells.get(cellKey(addCell(cell, delta)));
      if (!other || other.id !== record.id) return false;
      if ((other.state?.facing || 'north') !== facing) return false;
      return (other.state?.type || 'single') !== 'single' || true;
    };
    if (same(facingDelta(ccw(facing)))) return 'right';
    if (same(facingDelta(cw(facing)))) return 'left';
    return values.includes('single') ? 'single' : (record.state?.type || values[0]);
  }

  function isSolidCell(cell) {
    const record = world.cells.get(cellKey(cell));
    if (!record) return false;
    const entry = state.engine.blocks.get(record.id);
    return !!(entry?.behavior?.solidConnectorTarget || entry?.fullCube);
  }

  function facingDelta(facing) {
    return {
      north: { x: 0, y: 0, z: -1 },
      south: { x: 0, y: 0, z: 1 },
      east:  { x: 1, y: 0, z: 0 },
      west:  { x: -1, y: 0, z: 0 },
    }[facing] || { x: 0, y: 0, z: 0 };
  }

  function connectorState(id, cell) {
    const entry = state.engine.blocks.get(id);
    const out = {};
    const sides = {
      north: { x: 0, y: 0, z: -1 },
      east:  { x: 1, y: 0, z: 0 },
      south: { x: 0, y: 0, z: 1 },
      west:  { x: -1, y: 0, z: 0 },
    };
    for (const [side, delta] of Object.entries(sides)) {
      const other = world.cells.get(cellKey(addCell(cell, delta)));
      const connected = !!other && canConnect(entry, other, side);
      out[side] = connectorValue(entry, connected, cell, delta);
    }
    if (entry?.behavior?.connector === 'wall' && 'up' in (entry.stateSchema || {})) {
      out.up = wallUpValue(out) ? 'true' : 'false';
    }
    return out;
  }

  function hasConnectorState(entry) {
    return !!entry?.behavior?.connector;
  }

  function connectorValue(entry, connected, cell, delta) {
    const values = entry?.stateSchema?.north || [];
    if (values.includes('low') || values.includes('tall') || values.includes('none')) {
      if (connected && values.includes('tall') && wallSideShouldBeTall(cell, delta)) return 'tall';
      return connected ? 'low' : 'none';
    }
    return connected ? 'true' : 'false';
  }

  function wallSideShouldBeTall(cell, delta) {
    if (!cell || !delta) return false;
    return isSolidCell(addCell(cell, { x: delta.x, y: 1, z: delta.z }))
      || isSolidCell(addCell(cell, { x: 0, y: 1, z: 0 }));
  }

  function wallUpValue(sides) {
    // Vanilla wall.up is true unless connections form exactly a straight line
    // (north+south alone, or east+west alone). With 0/1/3/4 connections it
    // shows the post.
    const connected = (s) => s !== 'none' && s !== 'false';
    const n = connected(sides.north), s = connected(sides.south);
    const e = connected(sides.east), w = connected(sides.west);
    const count = [n, s, e, w].filter(Boolean).length;
    if (count === 2 && ((n && s && !e && !w) || (e && w && !n && !s))) return false;
    return true;
  }

  function canConnect(entry, otherRecord, side) {
    const other = state.engine.blocks.get(otherRecord.id);
    if (!entry || !other) return false;
    // Solid full cubes are universal connection targets.
    if (other.behavior?.solidConnectorTarget || other.fullCube) return true;

    const me = entry.behavior?.connector;
    const them = other.behavior?.connector;

    // Perpendicular fence gate: fences and walls visually connect to gates
    // whose facing axis is perpendicular to the connection side.
    if ((me === 'fence' || me === 'wall') && other.behavior?.fenceGate) {
      const facing = otherRecord.state?.facing || other.defaultState?.facing || 'north';
      return axisForSide(side) !== axisForSide(facing);
    }

    // Like-to-like: fence/fence, wall/wall, pane/pane.
    if (me && them && me === them) {
      // Different fence materials still connect to each other in vanilla
      // (e.g. oak fence to spruce fence) since they share the fence shape.
      // Nether brick fence is the exception, but treating it as compatible
      // is a forgivable simplification for a planner.
      return true;
    }

    // Walls also connect to glass panes and iron bars (visual continuity).
    if (me === 'wall' && them === 'pane') return true;
    if (me === 'pane' && them === 'wall') return true;

    return false;
  }

  function axisForSide(side) {
    return side === 'east' || side === 'west' ? 'x' : 'z';
  }

  // ---------- Stair shape solver ----------
  // Vanilla rule (StairBlock.getStairShape):
  //   1. If the stair in front (+facing) is a stair with same half and
  //      perpendicular facing, the placed stair takes an OUTER corner on
  //      the side whose facing matches the neighbor's.
  //   2. Else if the stair behind (-facing) matches the same criteria,
  //      the placed stair takes an INNER corner on the matching side.
  //   3. Otherwise STRAIGHT.
  function solveStairShape(record, cell) {
    const facing = record.state?.facing || 'north';
    const half = record.state?.half || 'bottom';
    const front = world.cells.get(cellKey(addCell(cell, facingDelta(facing))));
    const back = world.cells.get(cellKey(addCell(cell, facingDelta(oppositeFacing(facing)))));
    const isCompatStair = (r) => {
      if (!r) return null;
      const e = state.engine.blocks.get(r.id);
      if (!e?.behavior?.stairShape) return null;
      if ((r.state?.half || 'bottom') !== half) return null;
      const f = r.state?.facing || 'north';
      if (axisForSide(f) === axisForSide(facing)) return null; // must be perpendicular
      return f;
    };
    const frontF = isCompatStair(front);
    if (frontF) {
      return frontF === ccw(facing) ? 'outer_left' : 'outer_right';
    }
    const backF = isCompatStair(back);
    if (backF) {
      return backF === ccw(facing) ? 'inner_left' : 'inner_right';
    }
    return 'straight';
  }

  function oppositeFacing(f) {
    return { north: 'south', south: 'north', east: 'west', west: 'east' }[f] || f;
  }
  function ccw(f) {
    return { north: 'west', west: 'south', south: 'east', east: 'north' }[f] || f;
  }
  function cw(f) {
    return { north: 'east', east: 'south', south: 'west', west: 'north' }[f] || f;
  }

  function objectFor(id, blockState) {
    const parts = state.engine.partsForBlock(id, blockState);
    const root = new THREE.Group();
    for (const part of parts) {
      const group = new THREE.Group();
      for (const element of part.elements) group.add(meshFromElement(element, part, id));
      group.rotation.order = 'YXZ';
      group.rotation.y = THREE.MathUtils.degToRad(-(part.y || 0));
      group.rotation.x = THREE.MathUtils.degToRad(part.x || 0);
      root.add(group);
    }
    if (!root.children.length) {
      root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), missingMaterial()));
    }
    return root;
  }

  function meshFromElement(element, part, id) {
    const faceNames = FACES.filter(face => element.faces?.[face]);
    const materials = faceNames.map(face => {
      const url = state.engine.textureUrlForFace(element.faces[face], part.textures, id.split(':')[0]);
      return url ? materialFor(url) : missingMaterial();
    });
    const mesh = new THREE.Mesh(geometryFromElement(element, faceNames), materials);
    if (element.rotation && typeof element.rotation.angle === 'number') {
      const pivot = new THREE.Group();
      const origin = element.rotation.origin || [8, 8, 8];
      pivot.position.set(origin[0] / 16 - 0.5, origin[1] / 16 - 0.5, origin[2] / 16 - 0.5);
      mesh.position.sub(pivot.position);
      const angle = THREE.MathUtils.degToRad(element.rotation.angle || 0);
      if (element.rotation.axis === 'x') pivot.rotation.x = angle;
      else if (element.rotation.axis === 'y') pivot.rotation.y = angle;
      else if (element.rotation.axis === 'z') pivot.rotation.z = angle;
      if (element.rotation.rescale && angle !== 0) {
        const factor = 1 / Math.cos(Math.abs(angle));
        if (element.rotation.axis === 'x') pivot.scale.set(1, factor, factor);
        else if (element.rotation.axis === 'y') pivot.scale.set(factor, 1, factor);
        else if (element.rotation.axis === 'z') pivot.scale.set(factor, factor, 1);
      }
      pivot.add(mesh);
      return pivot;
    }
    return mesh;
  }

  function geometryFromElement(element, faceNames) {
    const from = element.from || [0, 0, 0];
    const to = element.to || [16, 16, 16];
    const x1 = from[0] / 16 - 0.5;
    const y1 = from[1] / 16 - 0.5;
    const z1 = from[2] / 16 - 0.5;
    const x2 = to[0] / 16 - 0.5;
    const y2 = to[1] / 16 - 0.5;
    const z2 = to[2] / 16 - 0.5;
    const corners = {
      north: [[x2, y1, z1], [x1, y1, z1], [x1, y2, z1], [x2, y2, z1]],
      east: [[x2, y1, z2], [x2, y1, z1], [x2, y2, z1], [x2, y2, z2]],
      south: [[x1, y1, z2], [x2, y1, z2], [x2, y2, z2], [x1, y2, z2]],
      west: [[x1, y1, z1], [x1, y1, z2], [x1, y2, z2], [x1, y2, z1]],
      up: [[x1, y2, z2], [x2, y2, z2], [x2, y2, z1], [x1, y2, z1]],
      down: [[x1, y1, z1], [x2, y1, z1], [x2, y1, z2], [x1, y1, z2]],
    };
    const positions = [];
    const uvs = [];
    const indices = [];
    const geometry = new THREE.BufferGeometry();
    let faceIndex = 0;
    for (const name of faceNames) {
      const face = element.faces[name];
      const base = positions.length / 3;
      for (const p of corners[name]) positions.push(p[0], p[1], p[2]);
      const uv = face.uv || defaultFaceUv(name, from, to);
      const quad = [
        [uv[0] / 16, uv[3] / 16],
        [uv[2] / 16, uv[3] / 16],
        [uv[2] / 16, uv[1] / 16],
        [uv[0] / 16, uv[1] / 16],
      ];
      const rot = (((face.rotation || 0) / 90) % 4 + 4) % 4;
      for (let i = 0; i < 4; i++) {
        const pair = quad[(i + rot) % 4];
        uvs.push(pair[0], pair[1]);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      geometry.addGroup(faceIndex * 6, 6, faceIndex);
      faceIndex++;
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  function defaultFaceUv(name, from, to) {
    return {
      north: [to[0], 16 - to[1], from[0], 16 - from[1]],
      east: [from[2], 16 - to[1], to[2], 16 - from[1]],
      south: [from[0], 16 - to[1], to[0], 16 - from[1]],
      west: [from[2], 16 - to[1], to[2], 16 - from[1]],
      up: [from[0], from[2], to[0], to[2]],
      down: [to[0], from[2], from[0], to[2]],
    }[name] || [0, 0, 16, 16];
  }

  function materialFor(url) {
    if (textureCache.has(url)) return textureCache.get(url);
    let resolveLoad;
    textureLoadPromises.set(url, new Promise(r => { resolveLoad = r; }));
    const animation = state.engine.textureMetaForUrl(url);
    const texture = new THREE.TextureLoader().load(url, () => {
      applyAnimatedTextureFrame(texture, animation);
      needsRender = true;
      resolveLoad();
    }, undefined, () => resolveLoad());
    texture.flipY = false;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshLambertMaterial({ map: texture, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide });
    material.userData.textureUrl = url;
    textureCache.set(url, material);
    return material;
  }

  function applyAnimatedTextureFrame(texture, animation) {
    if (!animation || !texture.image) return;
    const image = texture.image;
    const frameWidth = positiveInt(animation.width) || image.width;
    const frameHeight = positiveInt(animation.height) || frameWidth;
    if (!frameWidth || !frameHeight || (image.width <= frameWidth && image.height <= frameHeight)) return;

    const columns = Math.max(1, Math.floor(image.width / frameWidth));
    const rows = Math.max(1, Math.floor(image.height / frameHeight));
    const frame = clamp(firstAnimationFrame(animation.frames), 0, columns * rows - 1);
    const repeatX = frameWidth / image.width;
    const repeatY = frameHeight / image.height;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.repeat.set(repeatX, repeatY);
    texture.offset.set((frame % columns) * repeatX, Math.floor(frame / columns) * repeatY);
    texture.needsUpdate = true;
  }

  function firstAnimationFrame(frames) {
    if (!Array.isArray(frames) || !frames.length) return 0;
    const first = frames[0];
    const raw = typeof first === 'object' && first ? first.index : first;
    const frame = Number(raw);
    return Number.isFinite(frame) ? frame : 0;
  }

  function positiveInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function missingMaterial() {
    if (!textureCache.has('__missing')) {
      textureCache.set('__missing', new THREE.MeshLambertMaterial({ color: 0xff44cc, wireframe: true }));
    }
    return textureCache.get('__missing');
  }

  function loop() {
    requestAnimationFrame(loop);
    if (!needsRender) return;
    const cp = Math.cos(controls.pitch);
    camera.position.set(
      controls.target.x + controls.radius * cp * Math.cos(controls.yaw),
      controls.target.y + controls.radius * Math.sin(controls.pitch),
      controls.target.z + controls.radius * cp * Math.sin(controls.yaw),
    );
    camera.lookAt(controls.target);
    renderer.render(scene, camera);
    needsRender = false;
  }

  function resize() {
    const canvas = $('#builder-canvas');
    const parent = canvas.parentElement;
    const w = Math.max(1, parent.clientWidth | 0);
    const h = Math.max(1, parent.clientHeight | 0);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    needsRender = true;
  }

  function readStateJson() {
    try {
      return JSON.parse($('#state-json').value || '{}');
    } catch {
      return {};
    }
  }

  function facingFromCamera() {
    const angle = ((controls.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (angle < Math.PI * 0.25 || angle >= Math.PI * 1.75) return 'west';
    if (angle < Math.PI * 0.75) return 'north';
    if (angle < Math.PI * 1.25) return 'east';
    return 'south';
  }

  function inside(cell) {
    return cell.x >= 0 && cell.x < world.size.x && cell.y >= 0 && cell.y < world.size.y && cell.z >= 0 && cell.z < world.size.z;
  }

  function cellKey(cell) {
    return `${cell.x},${cell.y},${cell.z}`;
  }

  function parseCell(key) {
    const [x, y, z] = key.split(',').map(Number);
    return { x, y, z };
  }

  function addCell(cell, delta) {
    return { x: cell.x + delta.x, y: cell.y + delta.y, z: cell.z + delta.z };
  }

  function cardinalNeighborhood(cell) {
    return [
      cell,
      addCell(cell, { x: 1, y: 0, z: 0 }),
      addCell(cell, { x: -1, y: 0, z: 0 }),
      addCell(cell, { x: 0, y: 0, z: 1 }),
      addCell(cell, { x: 0, y: 0, z: -1 }),
    ];
  }

  function neighborhood(cell) {
    // Cardinal + vertical, so stairs/walls also resolve based on what's
    // above and below (for waterlogging and wall posts in the future).
    return [
      ...cardinalNeighborhood(cell),
      addCell(cell, { x: 0, y: 1, z: 0 }),
      addCell(cell, { x: 0, y: -1, z: 0 }),
    ];
  }

  function sameState(a, b) {
    return JSON.stringify(a || {}) === JSON.stringify(b || {});
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function toast(message) {
    const box = $('#toast');
    box.textContent = message;
    box.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => box.classList.add('hidden'), 2600);
  }

  function isTyping() {
    const tag = document.activeElement?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA';
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  function $(selector) {
    return document.querySelector(selector);
  }

  function $$(selector) {
    return Array.from(document.querySelectorAll(selector));
  }
})();
