(function () {
  const { FACES } = MCModelTools;

  const engine = new MCAssetEngine();
  const ui = {
    selectedId: null,
    filter: { query: '', kind: 'all', category: 'all', ns: '' },
    state: {},
  };

  let scene, camera, renderer, group, controls;
  let raf = null;

  document.addEventListener('DOMContentLoaded', init);

  function init() {
    bindUI();
    initThree();
    toast('Load a vanilla client jar to begin.');
  }

  function bindUI() {
    const fileInput = $('#debug-file');
    $('#debug-load').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) loadPack(file);
    });
    $('#debug-search').addEventListener('input', e => {
      ui.filter.query = e.target.value;
      renderList();
    });
    $('#debug-kind').addEventListener('change', e => {
      ui.filter.kind = e.target.value;
      renderList();
    });
    $('#debug-category').addEventListener('change', e => {
      ui.filter.category = e.target.value;
      renderList();
    });
    $('#debug-namespace').addEventListener('change', e => {
      ui.filter.ns = e.target.value;
      renderList();
    });
  }

  async function loadPack(file) {
    try {
      toast(`Reading ${file.name}...`);
      const pack = await MCJarLoader.loadJar(file, (done, total) => {
        toast(`Parsing ${done.toLocaleString()} / ${total.toLocaleString()} files...`);
      });
      engine.addPack(pack);
      $('#debug-pack-label').textContent = `${file.name} — ${engine.blocks.size.toLocaleString()} blocks, ${engine.items.size.toLocaleString()} items`;
      populateFilters();
      renderList();
      updateCounters();
      toast(`Loaded ${file.name}.`);
    } catch (err) {
      console.error(err);
      toast(`Pack failed: ${err.message || err}`);
    }
  }

  function populateFilters() {
    const cats = engine.categories();
    const catSel = $('#debug-category');
    catSel.innerHTML = '<option value="all">Every category</option>'
      + cats.filter(c => c.id !== 'all').map(c => `<option value="${esc(c.id)}">${esc(c.id)} (${c.count})</option>`).join('');

    const nsSel = $('#debug-namespace');
    const namespaces = Array.from(engine.namespaces).sort();
    nsSel.innerHTML = '<option value="">Every namespace</option>'
      + namespaces.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  }

  function updateCounters() {
    $('#debug-counters').innerHTML = `
      <span>${engine.blocks.size.toLocaleString()} blocks</span>
      <span>${engine.items.size.toLocaleString()} items</span>
      <span>${engine.models.size.toLocaleString()} models</span>
      <span>${engine.textures.size.toLocaleString()} textures</span>
    `;
  }

  function listEntries() {
    const q = ui.filter.query.trim().toLowerCase();
    const all = [];
    if (ui.filter.kind !== 'items') {
      for (const entry of engine.blocks.values()) all.push({ ...entry, _kind: 'block' });
    }
    if (ui.filter.kind === 'items' || ui.filter.kind === 'orphans' || ui.filter.kind === 'all') {
      for (const item of engine.items.values()) {
        if (engine.blocks.has(item.id)) {
          if (ui.filter.kind === 'orphans') continue;
          if (ui.filter.kind === 'all') continue;
        }
        all.push({ ...item, _kind: 'item' });
      }
    }
    return all
      .filter(e => !ui.filter.ns || e.ns === ui.filter.ns)
      .filter(e => ui.filter.category === 'all' || e.category === ui.filter.category)
      .filter(e => !q || `${e.id} ${e.displayName || ''} ${e.shape || ''}`.toLowerCase().includes(q))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  function renderList() {
    const entries = listEntries();
    const rows = entries.slice(0, 1500).map(entry => {
      const icon = entryIcon(entry);
      const iconHtml = icon ? `<img src="${esc(icon)}" alt="">` : '<span></span>';
      const cls = entry.id === ui.selectedId ? 'active' : '';
      const shape = entry.shape || entry._kind;
      return `
        <button class="debug-row ${cls}" data-id="${esc(entry.id)}" data-kind="${esc(entry._kind)}">
          ${iconHtml}
          <span>
            <strong>${esc(entry.displayName || entry.id)}</strong>
            <em>${esc(entry.id)} &middot; ${esc(shape)}</em>
          </span>
        </button>
      `;
    }).join('');
    const root = $('#debug-rows');
    root.innerHTML = rows || '<p style="color:var(--muted);padding:12px;">No matches.</p>';
    for (const row of root.querySelectorAll('.debug-row')) {
      row.addEventListener('click', () => selectEntry(row.dataset.id, row.dataset.kind));
    }
  }

  function entryIcon(entry) {
    const layer0 = engine.itemLayer0(entry.id);
    if (layer0) return layer0;
    return entry.icon || null;
  }

  function selectEntry(id, kind) {
    ui.selectedId = id;
    if (kind === 'block') {
      const entry = engine.blocks.get(id);
      ui.state = Object.assign({}, entry?.defaultState || {});
    } else {
      ui.state = {};
    }
    renderList();
    renderDetail();
  }

  function renderDetail() {
    const id = ui.selectedId;
    if (!id) return;
    const blockEntry = engine.blocks.get(id);
    const itemEntry = engine.items.get(id);
    const entry = blockEntry || itemEntry;
    if (!entry) return;

    renderMeta(entry, blockEntry, itemEntry);
    renderStateControls(blockEntry);
    rebuildPreview();
    renderResolvedDetails();
  }

  function renderMeta(entry, blockEntry, itemEntry) {
    const layer0 = engine.itemLayer0(entry.id);
    const rows = [
      ['ID', entry.id],
      ['Namespace', entry.ns],
      ['Name', entry.name],
      ['Display name', entry.displayName || ''],
      ['Has block', blockEntry ? 'yes' : 'no'],
      ['Has item', itemEntry ? 'yes' : 'no'],
      ['Item layer0', layer0 ? 'yes' : 'no'],
      ['Shape', blockEntry?.shape || '-'],
      ['Category', entry.category || '-'],
      ['Full cube', blockEntry?.fullCube ? 'yes' : 'no'],
      ['Behavior', blockEntry ? JSON.stringify(blockEntry.behavior) : '-'],
    ];
    $('#debug-meta').innerHTML = rows.map(([k, v]) => `<strong>${esc(k)}</strong><span>${esc(v)}</span>`).join('');
  }

  function renderStateControls(blockEntry) {
    if (!blockEntry || !blockEntry.stateSchema || !Object.keys(blockEntry.stateSchema).length) {
      $('#debug-state-controls').innerHTML = '<p style="color:var(--muted);font-size:12px;margin:0;">No state schema.</p>';
      return;
    }
    const html = Object.entries(blockEntry.stateSchema).map(([key, values]) => {
      const current = String(ui.state[key] ?? values[0] ?? '');
      const opts = values.map(v => `<option ${String(v) === current ? 'selected' : ''} value="${esc(v)}">${esc(v)}</option>`).join('');
      return `<div class="debug-state-row"><label>${esc(key)}</label><select data-state="${esc(key)}">${opts}</select></div>`;
    }).join('');
    const root = $('#debug-state-controls');
    root.innerHTML = html;
    for (const sel of root.querySelectorAll('select[data-state]')) {
      sel.addEventListener('change', () => {
        ui.state[sel.dataset.state] = sel.value;
        rebuildPreview();
        renderResolvedDetails();
      });
    }
  }

  function renderResolvedDetails() {
    const id = ui.selectedId;
    if (!id) return;
    const blockEntry = engine.blocks.get(id);
    if (blockEntry) {
      const debug = engine.debugBlock(id, ui.state);
      $('#debug-parts').textContent = JSON.stringify(debug.parts, null, 2);
      $('#debug-blockstate').textContent = JSON.stringify(debug.blockstate, null, 2);
      const firstSource = debug.parts[0]?.source;
      const firstModel = firstSource ? engine.models.get(engine.modelKey(firstSource, blockEntry.ns)) : null;
      $('#debug-model').textContent = firstModel ? JSON.stringify(firstModel, null, 2) : '(no model resolved)';
      renderTextureGrid(debug.parts, blockEntry.ns);
    } else {
      const item = engine.items.get(id);
      const itemModel = item && engine.resolveModel(`${item.ns}:item/${item.name}`, item.ns);
      $('#debug-parts').textContent = '(item only)';
      $('#debug-blockstate').textContent = '(no blockstate)';
      $('#debug-model').textContent = itemModel ? JSON.stringify(itemModel, null, 2) : '(no item model)';
      $('#debug-textures').innerHTML = '';
    }
  }

  function renderTextureGrid(parts, ns) {
    const seen = new Map();
    for (const part of parts) {
      for (const [key, ref] of Object.entries(part.textures || {})) {
        let resolved = ref;
        let safety = 16;
        while (typeof resolved === 'string' && resolved.startsWith('#') && safety-- > 0) {
          resolved = part.textures[resolved.slice(1)];
        }
        const url = engine.textureUrl(resolved, ns);
        seen.set(key, { ref, resolved, url });
      }
    }
    if (!seen.size) {
      $('#debug-textures').innerHTML = '<p style="color:var(--muted);font-size:12px;margin:0;">No textures.</p>';
      return;
    }
    $('#debug-textures').innerHTML = Array.from(seen.entries()).map(([key, info]) => `
      <figure>
        ${info.url ? `<img src="${esc(info.url)}" alt="">` : '<div style="height:48px;color:#ff7373;display:grid;place-items:center;">missing</div>'}
        <div>#${esc(key)}</div>
        <div>${esc(info.resolved || '(unresolved)')}</div>
      </figure>
    `).join('');
  }

  function initThree() {
    const canvas = $('#debug-canvas');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x151922);
    camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    group = new THREE.Group();
    scene.add(group);
    scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const sun = new THREE.DirectionalLight(0xffffff, 0.55);
    sun.position.set(3, 5, 2);
    scene.add(sun);

    const grid = new THREE.GridHelper(4, 4, 0x526176, 0x2c333f);
    grid.position.y = -0.5;
    scene.add(grid);

    const axes = new THREE.AxesHelper(0.8);
    scene.add(axes);

    controls = { yaw: Math.PI / 4, pitch: 0.5, radius: 3, target: new THREE.Vector3(0, 0, 0) };

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      controls.radius *= e.deltaY > 0 ? 1.1 : 0.9;
      controls.radius = clamp(controls.radius, 0.6, 12);
      schedule();
    }, { passive: false });

    let drag = null;
    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, yaw: controls.yaw, pitch: controls.pitch, target: controls.target.clone(), shift: e.shiftKey };
    });
    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (drag.shift) {
        const right = new THREE.Vector3(-Math.sin(controls.yaw), 0, Math.cos(controls.yaw));
        controls.target.copy(drag.target).addScaledVector(right, -dx * 0.005).add(new THREE.Vector3(0, dy * 0.005, 0));
      } else {
        controls.yaw = drag.yaw - dx * 0.01;
        controls.pitch = clamp(drag.pitch - dy * 0.01, -1.4, 1.4);
      }
      schedule();
    });
    canvas.addEventListener('pointerup', e => {
      canvas.releasePointerCapture(e.pointerId);
      drag = null;
    });

    new ResizeObserver(resize).observe(canvas.parentElement);
    resize();
    schedule();
  }

  function rebuildPreview() {
    while (group.children.length) {
      const child = group.children.pop();
      child.traverse(c => { if (c.geometry) c.geometry.dispose(); });
    }
    const blockEntry = engine.blocks.get(ui.selectedId);
    if (!blockEntry) {
      schedule();
      return;
    }
    const parts = engine.partsForBlock(ui.selectedId, ui.state);
    const root = buildObject(parts, blockEntry.ns);
    if (root) group.add(root);
    schedule();
  }

  function buildObject(parts, ns) {
    const root = new THREE.Group();
    for (const part of parts) {
      const partGroup = new THREE.Group();
      for (const element of part.elements) partGroup.add(meshFromElement(element, part, ns));
      partGroup.rotation.order = 'YXZ';
      partGroup.rotation.y = THREE.MathUtils.degToRad(-(part.y || 0));
      partGroup.rotation.x = THREE.MathUtils.degToRad(part.x || 0);
      root.add(partGroup);
    }
    return root.children.length ? root : null;
  }

  function meshFromElement(element, part, ns) {
    const faceNames = FACES.filter(f => element.faces?.[f]);
    const materials = faceNames.map(face => {
      const url = engine.textureUrlForFace(element.faces[face], part.textures, ns);
      return url ? makeMaterial(url) : missingMaterial();
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

  const textureCache = new Map();
  function makeMaterial(url) {
    if (textureCache.has(url)) return textureCache.get(url);
    const texture = new THREE.TextureLoader().load(url, schedule);
    texture.flipY = false;
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

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      const cp = Math.cos(controls.pitch);
      camera.position.set(
        controls.target.x + controls.radius * cp * Math.cos(controls.yaw),
        controls.target.y + controls.radius * Math.sin(controls.pitch),
        controls.target.z + controls.radius * cp * Math.sin(controls.yaw),
      );
      camera.lookAt(controls.target);
      renderer.render(scene, camera);
    });
  }

  function resize() {
    const canvas = $('#debug-canvas');
    const parent = canvas.parentElement;
    const w = Math.max(1, parent.clientWidth | 0);
    const h = Math.max(1, parent.clientHeight | 0);
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    schedule();
  }

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function toast(message) {
    const box = $('#toast');
    box.textContent = message;
    box.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => box.classList.add('hidden'), 2400);
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function $(selector) { return document.querySelector(selector); }
})();
