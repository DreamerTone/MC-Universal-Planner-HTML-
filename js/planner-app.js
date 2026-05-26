(function () {
  const { FACES, humanName } = MCModelTools;

  const state = {
    engine: new MCAssetEngine(),
    selectedId: null,
    category: 'all',
    tool: 'place',
    query: '',
    creativeOpen: false,
  };

  const world = {
    cells: new Map(),
    size: { x: 32, y: 24, z: 32 },
  };

  let scene, camera, renderer, gridPlane, blockRoot, controls, raycaster, pointer;
  const textureCache = new Map();
  let needsRender = true;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    bindUI();
    initThree();
    renderCatalog();
    updateSelected();
    toast('Load a vanilla client jar to begin.');
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
    for (const id of ['place', 'erase', 'pick']) {
      $(`#tool-${id}`).addEventListener('click', () => setTool(id));
    }

    window.addEventListener('keydown', e => {
      if (e.key.toLowerCase() === 'e' && !isTyping()) {
        e.preventDefault();
        state.creativeOpen ? closeCreative() : openCreative();
      }
      if (e.key === 'Escape' && state.creativeOpen) closeCreative();
    });
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
    const icon = entry.icon ? `<img src="${entry.icon}" alt="">` : '<span class="drop-icon"></span>';
    return `
      <button class="block-card ${active}" data-id="${escapeHtml(entry.id)}">
        ${icon}
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
    $('#selected-card').innerHTML = `
      ${entry.icon ? `<img src="${entry.icon}" alt="">` : '<span class="drop-icon"></span>'}
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
    for (const id of ['place', 'erase', 'pick']) $(`#tool-${id}`).classList.toggle('active', id === tool);
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
    const erase = e.shiftKey || e.button === 2 || state.tool === 'erase';
    if (state.tool === 'pick') {
      const key = hit.cellKey;
      if (key && world.cells.has(key)) selectBlock(world.cells.get(key).id);
      return;
    }
    if (erase) eraseCell(hit.cell);
    else placeAt(hit.placeCell, hit.normal);
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

  function placeAt(cell, normal) {
    const entry = state.engine.blocks.get(state.selectedId);
    if (!entry || !inside(cell)) return;
    const placementState = placementStateFor(entry, cell, normal);
    setCell(cell, entry.id, placementState);
    refreshAround(cell);
  }

  function setCell(cell, id, blockState) {
    const key = cellKey(cell);
    const old = world.cells.get(key);
    if (old) blockRoot.remove(old.object);
    const object = objectFor(id, blockState);
    object.position.set(cell.x - world.size.x / 2 + 0.5, cell.y + 0.5, cell.z - world.size.z / 2 + 0.5);
    object.traverse(child => { child.userData.cellKey = key; });
    blockRoot.add(object);
    world.cells.set(key, { id, state: blockState, object });
    afterWorldChange();
  }

  function eraseCell(cell) {
    if (!cell) return;
    const key = cellKey(cell);
    const old = world.cells.get(key);
    if (!old) return;
    blockRoot.remove(old.object);
    world.cells.delete(key);
    refreshAround(cell);
    afterWorldChange();
  }

  function clearBuild() {
    for (const cell of world.cells.values()) blockRoot.remove(cell.object);
    world.cells.clear();
    afterWorldChange();
  }

  function refreshAround(cell) {
    const queue = [cell, addCell(cell, { x: 1, y: 0, z: 0 }), addCell(cell, { x: -1, y: 0, z: 0 }), addCell(cell, { x: 0, y: 0, z: 1 }), addCell(cell, { x: 0, y: 0, z: -1 })];
    for (const next of queue) {
      const record = world.cells.get(cellKey(next));
      if (!record) continue;
      const entry = state.engine.blocks.get(record.id);
      if (!hasConnectorState(entry)) continue;
      const merged = Object.assign({}, record.state, connectorState(record.id, next));
      if (JSON.stringify(merged) !== JSON.stringify(record.state)) setCell(next, record.id, merged);
    }
  }

  function afterWorldChange() {
    $('#build-count').textContent = `${world.cells.size.toLocaleString()} placed`;
    needsRender = true;
  }

  function placementStateFor(entry, cell, normal) {
    const out = Object.assign({}, entry.defaultState || {});
    if (entry.behavior?.axisOnPlace) out.axis = Math.abs(normal.x) ? 'x' : (Math.abs(normal.z) ? 'z' : 'y');
    if (entry.behavior?.horizontalFacingOnPlace) {
      if (Math.abs(normal.x)) out.facing = normal.x > 0 ? 'east' : 'west';
      else if (Math.abs(normal.z)) out.facing = normal.z > 0 ? 'south' : 'north';
      else out.facing = facingFromCamera();
    }
    if (entry.behavior?.halfOnPlace) out.half = normal.y < 0 ? 'top' : 'bottom';
    if (hasConnectorState(entry)) Object.assign(out, connectorState(entry.id, cell));
    return out;
  }

  function connectorState(id, cell) {
    const entry = state.engine.blocks.get(id);
    const checks = {
      north: { x: 0, y: 0, z: -1 },
      east: { x: 1, y: 0, z: 0 },
      south: { x: 0, y: 0, z: 1 },
      west: { x: -1, y: 0, z: 0 },
    };
    const out = {};
    for (const [side, delta] of Object.entries(checks)) {
      const other = world.cells.get(cellKey(addCell(cell, delta)));
      out[side] = connectorValue(entry, !!other && canConnect(entry, other, side));
    }
    if (entry?.behavior?.connector === 'wall' && 'up' in (entry.stateSchema || {})) out.up = 'true';
    return out;
  }

  function hasConnectorState(entry) {
    return !!entry?.behavior?.connector;
  }

  function connectorValue(entry, connected) {
    if (entry?.behavior?.connector === 'wall') return connected ? 'low' : 'none';
    return connected ? 'true' : 'false';
  }

  function canConnect(entry, otherRecord, side) {
    const other = state.engine.blocks.get(otherRecord.id);
    if (!entry || !other) return false;
    if (other.behavior?.solidConnectorTarget || other.fullCube) return true;
    if (entry.behavior?.connector === 'fence' && other.behavior?.fenceGate) {
      const facing = otherRecord.state?.facing || other.defaultState?.facing || 'north';
      return axisForSide(side) !== axisForSide(facing);
    }
    return entry.behavior?.connector && entry.behavior.connector === other.behavior?.connector;
  }

  function axisForSide(side) {
    return side === 'east' || side === 'west' ? 'x' : 'z';
  }

  function objectFor(id, blockState) {
    const parts = state.engine.partsForBlock(id, blockState);
    const root = new THREE.Group();
    for (const part of parts) {
      const group = new THREE.Group();
      for (const element of part.elements) group.add(meshFromElement(element, part, id));
      group.rotation.order = 'YXZ';
      group.rotation.y = THREE.MathUtils.degToRad(part.y || 0);
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
    const texture = new THREE.TextureLoader().load(url, () => { needsRender = true; });
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshLambertMaterial({ map: texture, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide });
    textureCache.set(url, material);
    return material;
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
