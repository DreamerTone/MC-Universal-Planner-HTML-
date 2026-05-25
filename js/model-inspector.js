(function () {
  const { el, els, humanName } = MCUI;

  const state = {
    registry: new MCRegistry(),
    selectedId: null,
    entries: [],
    textures: new Map(),
  };

  let scene, camera, renderer, root, controls;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    initDrop();
    initThree();
    el('#inspect-search').addEventListener('input', renderList);
    el('#inspect-namespace').addEventListener('change', renderList);
    el('#inspect-render').addEventListener('click', renderSelected);
    el('#inspect-state').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) renderSelected();
    });
    renderList();
  }

  function initDrop() {
    const drop = el('#inspect-drop');
    const fileInput = el('#inspect-file');
    drop.addEventListener('click', () => fileInput.click());
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) loadJar(file);
    });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('dragover');
    }));
    drop.addEventListener('drop', (e) => {
      const file = e.dataTransfer.files[0];
      if (file) loadJar(file);
    });
  }

  async function loadJar(file) {
    setStatus(`Reading ${file.name}...`);
    try {
      const pack = await MCJarLoader.loadJar(file, (done, total) => {
        setStatus(`Parsing ${done.toLocaleString()} / ${total.toLocaleString()} entries`);
      });
      state.registry.reset();
      state.registry.addPack(pack);
      state.entries = state.registry.allEntries({ kind: 'block' });
      el('#inspect-pack-version').textContent = pack.mcVersion
        ? `MC ${pack.mcVersion} - ${state.entries.length.toLocaleString()} blocks`
        : `${state.entries.length.toLocaleString()} blocks`;
      refreshNamespaces();
      renderList();
      setStatus(`Loaded ${file.name}.`, 'ok');
    } catch (err) {
      console.error(err);
      setStatus(`Failed to inspect jar: ${err.message || err}`, 'error');
    }
  }

  function refreshNamespaces() {
    const opts = ['<option value="">All namespaces</option>'];
    for (const ns of Array.from(state.registry.namespaces).sort()) {
      opts.push(`<option value="${escapeHtml(ns)}">${escapeHtml(ns)}</option>`);
    }
    el('#inspect-namespace').innerHTML = opts.join('');
  }

  function renderList() {
    const query = el('#inspect-search').value || '';
    const ns = el('#inspect-namespace').value || null;
    const entries = state.registry.allEntries({ kind: 'block', ns, query });
    el('#inspect-count').textContent = `${entries.length.toLocaleString()} blocks`;
    el('#inspect-list').innerHTML = entries.slice(0, 800).map(entry => `
      <button class="inspect-row ${entry.id === state.selectedId ? 'active' : ''}" data-id="${entry.id}">
        ${entry.iconTexture || entry.texture ? `<img src="${entry.iconTexture || entry.texture}" alt="">` : '<span class="inspect-no-icon"></span>'}
        <span class="inspect-row-main">
          <span class="inspect-row-title">
            <strong>${escapeHtml(entry.displayName)}</strong>
            <span class="shape-pill ${entry.renderHint?.fullCube ? 'full' : 'custom'}">${escapeHtml(shapeLabel(entry))}</span>
          </span>
          <em>${escapeHtml(entry.id)}</em>
        </span>
      </button>
    `).join('') + (entries.length > 800
      ? '<div class="muted inspect-more">More blocks hidden. Refine search.</div>'
      : '');
    els('.inspect-row').forEach(row => {
      row.addEventListener('click', () => selectBlock(row.dataset.id));
    });
  }

  function shapeLabel(entry) {
    if (entry?.renderHint?.fullCube) return 'full cube';
    return entry?.renderHint?.shape || 'custom';
  }

  function selectBlock(id) {
    state.selectedId = id;
    const entry = state.registry.get(id);
    el('#inspect-title').textContent = entry ? entry.displayName : id;
    el('#inspect-subtitle').textContent = id;
    el('#inspect-state').value = JSON.stringify(defaultStateFor(entry), null, 2);
    renderList();
    renderSelected();
  }

  function defaultStateFor(entry) {
    const out = {};
    if (entry?.behavior?.axisOnPlace) out.axis = 'y';
    if (entry?.behavior?.horizontalFacingOnPlace) {
      out.facing = 'north';
      if (entry.name.includes('stairs')) {
        out.half = 'bottom';
        out.shape = 'straight';
      }
    }
    if (entry?.behavior?.connectsCardinal) {
      out.north = true;
      out.east = true;
      out.south = true;
      out.west = true;
    }
    if (entry?.name === 'lantern' || entry?.name.endsWith('_lantern')) out.hanging = false;
    return out;
  }

  function renderSelected() {
    if (!state.selectedId) return;
    let blockState;
    try {
      blockState = JSON.parse(el('#inspect-state').value || '{}');
    } catch (err) {
      setStatus(`State JSON is invalid: ${err.message}`, 'error');
      return;
    }
    setStatus('');
    const debug = state.registry.debugBlock(state.selectedId, blockState);
    el('#inspect-summary').textContent = JSON.stringify(summarizeDebug(debug), null, 2);
    el('#inspect-json').textContent = JSON.stringify({
      blockstate: debug.blockstate,
      directBlockModel: debug.directBlockModel,
      itemModel: debug.itemModel,
      parts: debug.parts,
    }, null, 2);
    renderPreview(debug);
  }

  function summarizeDebug(debug) {
    return {
      entry: debug.entry,
      state: debug.state,
      partCount: debug.parts.length,
      elementCount: debug.parts.reduce((sum, part) => sum + part.elements.length, 0),
      parts: debug.parts.map((part, i) => ({
        part: i + 1,
        rotation: { x: part.x, y: part.y, uvlock: part.uvlock },
        textureKeys: Object.keys(part.textures || {}),
        elements: part.elements.map(el => ({
          from: el.from,
          to: el.to,
          rotation: el.rotation || null,
          faces: Object.fromEntries(Object.entries(el.faces || {}).map(([face, def]) => [
            face,
            { texture: def.texture, uv: def.uv || null, rotation: def.rotation || 0 },
          ])),
        })),
      })),
    };
  }

  function initThree() {
    const canvas = el('#inspect-canvas');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1d22);
    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    root = new THREE.Group();
    scene.add(root);
    scene.add(new THREE.AmbientLight(0xffffff, 0.62));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(5, 8, 6);
    scene.add(sun);
    scene.add(new THREE.GridHelper(4, 8, 0x3a4150, 0x2f343d));
    controls = { yaw: Math.PI / 4, pitch: 0.55, radius: 3.2, target: new THREE.Vector3() };
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      controls.radius *= e.deltaY > 0 ? 1.1 : 0.9;
      controls.radius = Math.max(1.4, Math.min(10, controls.radius));
    }, { passive: false });
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      canvas._drag = { x: e.clientX, y: e.clientY, yaw: controls.yaw, pitch: controls.pitch };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!canvas._drag) return;
      controls.yaw = canvas._drag.yaw - (e.clientX - canvas._drag.x) * 0.01;
      controls.pitch = Math.max(-1.2, Math.min(1.2, canvas._drag.pitch - (e.clientY - canvas._drag.y) * 0.01));
    });
    canvas.addEventListener('pointerup', () => { canvas._drag = null; });
    new ResizeObserver(fitCanvas).observe(canvas.parentElement);
    fitCanvas();
    loop();
  }

  function fitCanvas() {
    const parent = el('#inspect-canvas').parentElement;
    const w = Math.max(1, parent.clientWidth | 0);
    const h = Math.max(1, parent.clientHeight | 0);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function loop() {
    requestAnimationFrame(loop);
    const cp = Math.cos(controls.pitch);
    camera.position.set(
      controls.target.x + controls.radius * cp * Math.cos(controls.yaw),
      controls.target.y + controls.radius * Math.sin(controls.pitch),
      controls.target.z + controls.radius * cp * Math.sin(controls.yaw),
    );
    camera.lookAt(controls.target);
    renderer.render(scene, camera);
  }

  function renderPreview(debug) {
    while (root.children.length) root.remove(root.children[0]);
    for (const part of debug.parts) {
      const group = new THREE.Group();
      for (const element of part.elements) group.add(meshFromElement(element, part));
      group.rotation.order = 'YXZ';
      group.rotation.y = THREE.MathUtils.degToRad(part.y || 0);
      group.rotation.x = THREE.MathUtils.degToRad(part.x || 0);
      root.add(group);
    }
  }

  function meshFromElement(element, part) {
    const faceNames = ['east', 'west', 'up', 'down', 'south', 'north']
      .filter(name => element.faces && element.faces[name]);
    const materials = faceNames.map(name => {
      const ref = element.faces[name].texture;
      const url = state.registry.textureUrlForModelRef(ref, part.textures, part.ns);
      return materialFromUrl(url);
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
    const x1 = from[0] / 16 - 0.5, y1 = from[1] / 16 - 0.5, z1 = from[2] / 16 - 0.5;
    const x2 = to[0] / 16 - 0.5, y2 = to[1] / 16 - 0.5, z2 = to[2] / 16 - 0.5;
    const corners = {
      east:  [[x2, y1, z2], [x2, y1, z1], [x2, y2, z1], [x2, y2, z2]],
      west:  [[x1, y1, z1], [x1, y1, z2], [x1, y2, z2], [x1, y2, z1]],
      up:    [[x1, y2, z2], [x2, y2, z2], [x2, y2, z1], [x1, y2, z1]],
      down:  [[x1, y1, z1], [x2, y1, z1], [x2, y1, z2], [x1, y1, z2]],
      south: [[x1, y1, z2], [x2, y1, z2], [x2, y2, z2], [x1, y2, z2]],
      north: [[x2, y1, z1], [x1, y1, z1], [x1, y2, z1], [x2, y2, z1]],
    };
    const positions = [], uvs = [], indices = [];
    const geom = new THREE.BufferGeometry();
    let faceIndex = 0;
    for (const name of faceNames) {
      const face = element.faces[name];
      const base = positions.length / 3;
      for (const p of corners[name]) positions.push(p[0], p[1], p[2]);
      const uv = face.uv || defaultFaceUv(name, from, to);
      const u1 = uv[0] / 16, v1 = uv[1] / 16;
      const u2 = uv[2] / 16, v2 = uv[3] / 16;
      const uvQuad = [[u1, v2], [u2, v2], [u2, v1], [u1, v1]];
      const rotation = ((face.rotation || 0) / 90) % 4;
      for (let i = 0; i < 4; i++) {
        const pair = uvQuad[(i + rotation + 4) % 4];
        uvs.push(pair[0], pair[1]);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      geom.addGroup(faceIndex * 6, 6, faceIndex);
      faceIndex++;
    }
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
  }

  function defaultFaceUv(name, from, to) {
    switch (name) {
      case 'up':
      case 'down':
        return [from[0], from[2], to[0], to[2]];
      case 'north':
      case 'south':
        return [from[0], 16 - to[1], to[0], 16 - from[1]];
      case 'east':
      case 'west':
        return [from[2], 16 - to[1], to[2], 16 - from[1]];
      default:
        return [0, 0, 16, 16];
    }
  }

  function materialFromUrl(url) {
    if (!url) return new THREE.MeshBasicMaterial({ color: 0xff44aa, wireframe: true });
    if (state.textures.has(url)) return state.textures.get(url);
    const texture = new THREE.TextureLoader().load(url);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshLambertMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.1,
      side: THREE.DoubleSide,
    });
    state.textures.set(url, material);
    return material;
  }

  function setStatus(message, kind) {
    const node = el('#inspect-status');
    node.textContent = message || '';
    node.className = `status ${kind || ''}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
})();
