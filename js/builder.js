/* 3D voxel builder powered by three.js.
 * - One BoxGeometry shared by every block; materials cached per block id.
 * - Left-drag orbits, right/middle-drag (or shift-drag) pans, wheel zooms.
 * - Click an empty floor cell to place at y=0; click a block face to place
 *   adjacent on that face. Right-click or Erase tool to remove. Pick tool
 *   copies the block under the cursor into the palette selection. */
(function (global) {

  class OrbitLite {
    constructor(camera, dom, target) {
      this.camera = camera;
      this.dom = dom;
      this.target = target.clone();
      this.radius = 30;
      this.azimuth = Math.PI / 4;
      this.polar = Math.PI / 3.2;
      this._down = null;
      this.onChange = null;

      dom.addEventListener('mousedown', (e) => {
        const orbit = e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.altKey;
        const pan = e.button === 1 || e.button === 2 || e.shiftKey || e.altKey;
        if (!orbit && !pan) return;
        this._down = {
          x: e.clientX, y: e.clientY,
          mode: pan ? 'pan' : 'orbit',
          azimuth: this.azimuth, polar: this.polar,
          target: this.target.clone(),
        };
        if (e.button !== 0) e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!this._down) return;
        const dx = e.clientX - this._down.x;
        const dy = e.clientY - this._down.y;
        if (this._down.mode === 'orbit') {
          this.azimuth = this._down.azimuth - dx * 0.008;
          this.polar = this._down.polar - dy * 0.008;
          this.polar = Math.max(0.05, Math.min(Math.PI - 0.05, this.polar));
        } else {
          const m = this.camera.matrix.elements;
          const right = new THREE.Vector3(m[0], m[1], m[2]);
          const up = new THREE.Vector3(m[4], m[5], m[6]);
          const f = this.radius * 0.0022;
          this.target.copy(this._down.target)
            .addScaledVector(right, -dx * f)
            .addScaledVector(up, dy * f);
        }
        this.update();
      });
      window.addEventListener('mouseup', () => { this._down = null; });
      dom.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.radius *= e.deltaY > 0 ? 1.12 : 0.9;
        this.radius = Math.max(2, Math.min(500, this.radius));
        this.update();
      }, { passive: false });
    }

    isDragging() {
      if (!this._down) return false;
      // Once movement exceeds a threshold we consider it a drag.
      return this._down._moved;
    }

    update() {
      const x = this.target.x + this.radius * Math.sin(this.polar) * Math.cos(this.azimuth);
      const y = this.target.y + this.radius * Math.cos(this.polar);
      const z = this.target.z + this.radius * Math.sin(this.polar) * Math.sin(this.azimuth);
      this.camera.position.set(x, y, z);
      this.camera.lookAt(this.target);
      if (this.onChange) this.onChange();
    }
  }

  class Builder {
    constructor(canvas, registry) {
      if (!global.THREE) throw new Error('three.js not loaded');
      this.canvas = canvas;
      this.registry = registry;
      this.W = 16; this.D = 16; this.H = 16;
      this.cells = new Map();        // "x,y,z" -> { id, mesh, state }
      this._textures = new Map();    // id -> THREE.Texture
      this._materials = new Map();   // id -> THREE.Material
      this._geometries = new Map();  // render shape -> THREE.BufferGeometry
      this._sharedGeom = null;
      this.tool = 'place';
      this.selected = null;

      this._handlers = {};
      this._needsRender = true;

      this._initThree();
      this._initScene();
      this._initControls();
      this._initPicking();
      this._loop();

      this._ro = new ResizeObserver(() => this._fitCanvas());
      this._ro.observe(canvas.parentElement || canvas);
    }

    on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); }
    _emit(ev, data) { (this._handlers[ev] || []).forEach(f => f(data)); }

    setSize(w, d, h) {
      this.W = Math.max(1, Math.min(64, w | 0));
      this.D = Math.max(1, Math.min(64, d | 0));
      this.H = Math.max(1, Math.min(64, h | 0));
      this._rebuildHelpers();
      this._frameCamera();
      this._emit('resized');
      this._needsRender = true;
    }
    setTool(t) { this.tool = t; }
    setSelected(entry) { this.selected = entry; }

    clear() {
      for (const c of this.cells.values()) this.scene.remove(c.mesh);
      this.cells.clear();
      this._needsRender = true;
      this._emit('changed');
    }

    blockCounts() {
      const m = new Map();
      for (const c of this.cells.values()) m.set(c.id, (m.get(c.id) || 0) + 1);
      return m;
    }

    toJSON() {
      return {
        version: 2,
        engine: '3d',
        size: { w: this.W, d: this.D, h: this.H },
        cells: Array.from(this.cells.entries()).map(([k, v]) => [k, {
          id: v.id,
          state: v.state || {},
        }]),
      };
    }

    fromJSON(data) {
      if (!data || (data.version !== 1 && data.version !== 2)) {
        throw new Error('Unsupported project file');
      }
      this.W = data.size.w; this.D = data.size.d;
      this.H = data.size.h || data.size.w;
      for (const c of this.cells.values()) this.scene.remove(c.mesh);
      this.cells.clear();
      for (const [k, cell] of data.cells) {
        const [x, y, z] = k.split(',').map(Number);
        const id = typeof cell === 'string' ? cell : cell.id;
        const state = typeof cell === 'string' ? {} : (cell.state || {});
        this._placeRaw(x, y, z, id, state, { quiet: true });
      }
      this._refreshConnectors();
      this._rebuildHelpers();
      this._frameCamera();
      this._emit('resized');
      this._emit('changed');
      this._needsRender = true;
    }

    /* ---------- three.js setup ---------- */
    _initThree() {
      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x1a1d22);

      this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;

      this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
      const sun = new THREE.DirectionalLight(0xffffff, 0.85);
      sun.position.set(8, 14, 6);
      this.scene.add(sun);
      const fill = new THREE.DirectionalLight(0xffffff, 0.25);
      fill.position.set(-5, 6, -3);
      this.scene.add(fill);

      this._sharedGeom = new THREE.BoxGeometry(1, 1, 1);

      this._fitCanvas();
    }

    _fitCanvas() {
      const parent = this.canvas.parentElement;
      const w = Math.max(1, (parent ? parent.clientWidth : this.canvas.clientWidth) | 0);
      const h = Math.max(1, (parent ? parent.clientHeight : this.canvas.clientHeight) | 0);
      this.renderer.setPixelRatio(window.devicePixelRatio || 1);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this._needsRender = true;
    }

    _initScene() {
      // Invisible ground for picking empty cells at y=0
      const planeGeom = new THREE.PlaneGeometry(1000, 1000);
      const planeMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
      this.ground = new THREE.Mesh(planeGeom, planeMat);
      this.ground.rotation.x = -Math.PI / 2;
      this.ground.userData.isGround = true;
      this.scene.add(this.ground);

      this.helpers = new THREE.Group();
      this.scene.add(this.helpers);
      this._rebuildHelpers();
    }

    _rebuildHelpers() {
      while (this.helpers.children.length) {
        const c = this.helpers.children[0];
        this.helpers.remove(c);
        if (c.geometry) c.geometry.dispose();
      }
      // Floor grid lines
      const linesMat = new THREE.LineBasicMaterial({ color: 0x3a4150 });
      const pts = [];
      for (let x = 0; x <= this.W; x++) {
        pts.push(new THREE.Vector3(x, 0.001, 0), new THREE.Vector3(x, 0.001, this.D));
      }
      for (let z = 0; z <= this.D; z++) {
        pts.push(new THREE.Vector3(0, 0.001, z), new THREE.Vector3(this.W, 0.001, z));
      }
      const floorGeom = new THREE.BufferGeometry().setFromPoints(pts);
      this.helpers.add(new THREE.LineSegments(floorGeom, linesMat));

      // Build-volume wireframe
      const box = new THREE.BoxGeometry(this.W, this.H, this.D);
      const edges = new THREE.EdgesGeometry(box);
      const wire = new THREE.LineSegments(edges,
        new THREE.LineBasicMaterial({ color: 0x4a5160, transparent: true, opacity: 0.45 })
      );
      wire.position.set(this.W / 2, this.H / 2, this.D / 2);
      this.helpers.add(wire);
      box.dispose();

      // Origin axes (small)
      const ax = new THREE.AxesHelper(2);
      ax.position.set(0, 0.01, 0);
      this.helpers.add(ax);
    }

    /* ---------- controls ---------- */
    _initControls() {
      this.controls = new OrbitLite(
        this.camera, this.canvas,
        new THREE.Vector3(this.W / 2, this.H * 0.35, this.D / 2)
      );
      this.controls.onChange = () => { this._needsRender = true; };
      this._frameCamera();
    }

    _frameCamera() {
      this.controls.target.set(this.W / 2, this.H * 0.35, this.D / 2);
      this.controls.radius = Math.max(this.W, this.H, this.D) * 1.9;
      this.controls.update();
    }

    /* ---------- picking ---------- */
    _initPicking() {
      this._raycaster = new THREE.Raycaster();
      this._down = null;

      this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      this.canvas.addEventListener('mousedown', (e) => {
        this._down = { x: e.clientX, y: e.clientY, button: e.button };
      });
      this.canvas.addEventListener('mouseup', (e) => {
        const d = this._down; this._down = null;
        if (!d) return;
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return; // drag, not click
        this._handleClick(e, d.button);
      });
      this.canvas.addEventListener('mousemove', (e) => {
        const c = this._cellUnderCursor(e);
        this._emit('hover', c);
      });
    }

    _pickables() {
      const objs = [this.ground];
      for (const c of this.cells.values()) objs.push(c.mesh);
      return objs;
    }

    _ndcFromEvent(e) {
      const rect = this.canvas.getBoundingClientRect();
      return new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
    }

    _cellUnderCursor(e) {
      this._raycaster.setFromCamera(this._ndcFromEvent(e), this.camera);
      const hits = this._raycaster.intersectObjects(this._pickables(), true);
      if (!hits.length) return null;
      const h = hits[0];
      const cellKey = this._cellKeyFromObject(h.object);
      if (cellKey) {
        const [x, y, z] = cellKey.split(',').map(Number);
        return { x, y, z };
      }
      const x = Math.floor(h.point.x);
      const z = Math.floor(h.point.z);
      if (x < 0 || x >= this.W || z < 0 || z >= this.D) return null;
      return { x, y: 0, z };
    }

    _handleClick(e, button) {
      this._raycaster.setFromCamera(this._ndcFromEvent(e), this.camera);
      const hits = this._raycaster.intersectObjects(this._pickables(), true);
      if (!hits.length) return;
      const hit = hits[0];
      const isRight = button === 2;
      const cellKey = this._cellKeyFromObject(hit.object);

      // Block clicked
      if (cellKey) {
        const [x, y, z] = cellKey.split(',').map(Number);
        if (this.tool === 'pick') {
          const cell = this.cells.get(cellKey);
          const entry = cell && this.registry.get(cell.id);
          if (entry) { this.selected = entry; this._emit('picked', entry); }
          return;
        }
        if (this.tool === 'erase' || isRight) {
          this._eraseAt(x, y, z);
          return;
        }
        const n = this._worldNormalFromHit(hit);
        this._placeAt(x + Math.round(n.x), y + Math.round(n.y), z + Math.round(n.z), n);
        return;
      }

      // Ground clicked
      if (hit.object.userData.isGround) {
        if (this.tool === 'erase' || isRight || this.tool === 'pick') return;
        const px = Math.floor(hit.point.x);
        const pz = Math.floor(hit.point.z);
        if (this.tool === 'fill') {
          this._fillLevel(0);
        } else {
          this._placeAt(px, 0, pz, new THREE.Vector3(0, 1, 0));
        }
      }
    }

    _cellKeyFromObject(obj) {
      let cur = obj;
      while (cur) {
        if (cur.userData && cur.userData.cellKey) return cur.userData.cellKey;
        cur = cur.parent;
      }
      return null;
    }

    _worldNormalFromHit(hit) {
      const n = hit.face.normal.clone();
      n.transformDirection(hit.object.matrixWorld);
      return new THREE.Vector3(
        Math.abs(n.x) > 0.5 ? Math.sign(n.x) : 0,
        Math.abs(n.y) > 0.5 ? Math.sign(n.y) : 0,
        Math.abs(n.z) > 0.5 ? Math.sign(n.z) : 0,
      );
    }

    _fillLevel(y) {
      if (!this.selected) return;
      const state = this._stateForPlacement(this.selected, new THREE.Vector3(0, 1, 0));
      for (let x = 0; x < this.W; x++)
        for (let z = 0; z < this.D; z++)
          this._placeRaw(x, y, z, this.selected.id, state);
      this._needsRender = true;
      this._emit('changed');
    }

    _placeAt(x, y, z, normal) {
      if (x < 0 || x >= this.W || y < 0 || y >= this.H || z < 0 || z >= this.D) return;
      if (!this.selected) return;
      this._placeRaw(x, y, z, this.selected.id, this._stateForPlacement(this.selected, normal));
      this._needsRender = true;
      this._emit('changed');
    }

    _placeRaw(x, y, z, id, state = {}, opts = {}) {
      const key = `${x},${y},${z}`;
      const existing = this.cells.get(key);
      if (existing) {
        if (existing.id === id && JSON.stringify(existing.state || {}) === JSON.stringify(state || {})) return;
        this.scene.remove(existing.mesh);
      }
      const entry = this.registry.get(id);
      const mesh = this._objectFor(entry, state);
      mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
      mesh.userData.cellKey = key;
      this._tagCellKey(mesh, key);
      this.scene.add(mesh);
      this.cells.set(key, { id, mesh, state });
      if (!opts.quiet) this._refreshConnectorsAround(x, y, z);
    }

    _eraseAt(x, y, z) {
      const key = `${x},${y},${z}`;
      const c = this.cells.get(key);
      if (!c) return;
      this.scene.remove(c.mesh);
      this.cells.delete(key);
      this._refreshConnectorsAround(x, y, z);
      this._needsRender = true;
      this._emit('changed');
    }

    _stateForPlacement(entry, normal) {
      const n = normal || new THREE.Vector3(0, 1, 0);
      const state = {};
      if (entry.behavior && entry.behavior.axisOnPlace) {
        state.axis = Math.abs(n.x) > 0 ? 'x' : (Math.abs(n.z) > 0 ? 'z' : 'y');
      }
      if (entry.behavior && entry.behavior.horizontalFacingOnPlace) {
        if (Math.abs(n.x) > 0) state.facing = n.x > 0 ? 'east' : 'west';
        else if (Math.abs(n.z) > 0) state.facing = n.z > 0 ? 'south' : 'north';
        else state.facing = 'north';
        if (entry.name.includes('stairs')) {
          state.half = n.y < 0 ? 'top' : 'bottom';
          state.shape = 'straight';
        }
      }
      if (entry.behavior && entry.behavior.connectsCardinal) {
        Object.assign(state, this._connectorStateFor(entry.id, null));
      }
      return state;
    }

    _connectorStateFor(id, key) {
      const [x, y, z] = key ? key.split(',').map(Number) : [null, null, null];
      const at = (dx, dz) => key ? this.cells.get(`${x + dx},${y},${z + dz}`) : null;
      const connects = (cell) => !!cell && this._canConnect(id, cell.id);
      return {
        north: connects(at(0, -1)),
        east: connects(at(1, 0)),
        south: connects(at(0, 1)),
        west: connects(at(-1, 0)),
      };
    }

    _canConnect(id, otherId) {
      if (!otherId) return false;
      const entry = this.registry.get(id);
      const other = this.registry.get(otherId);
      if (!entry || !other) return false;
      if (entry.renderHint?.shape === 'fence') {
        return other.renderHint?.shape === 'fence' || other.renderHint?.fullCube;
      }
      if (entry.renderHint?.shape === 'pane') {
        return other.renderHint?.shape === 'pane' || other.renderHint?.fullCube;
      }
      if (entry.renderHint?.shape === 'wall') {
        return other.renderHint?.shape === 'wall' || other.renderHint?.fullCube;
      }
      return false;
    }

    _refreshConnectors() {
      for (const key of Array.from(this.cells.keys())) {
        const [x, y, z] = key.split(',').map(Number);
        this._refreshConnectorAt(x, y, z);
      }
    }

    _refreshConnectorsAround(x, y, z) {
      [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dz]) => {
        this._refreshConnectorAt(x + dx, y, z + dz);
      });
    }

    _refreshConnectorAt(x, y, z) {
      const key = `${x},${y},${z}`;
      const cell = this.cells.get(key);
      const entry = cell && this.registry.get(cell.id);
      if (!cell || !entry || !entry.behavior?.connectsCardinal) return;
      const state = Object.assign({}, cell.state, this._connectorStateFor(cell.id, key));
      if (JSON.stringify(state) === JSON.stringify(cell.state || {})) return;
      this.scene.remove(cell.mesh);
      const mesh = this._objectFor(entry, state);
      mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
      mesh.userData.cellKey = key;
      this._tagCellKey(mesh, key);
      this.scene.add(mesh);
      this.cells.set(key, { id: cell.id, mesh, state });
      this._needsRender = true;
    }

    _tagCellKey(obj, key) {
      obj.traverse(o => { o.userData.cellKey = key; });
    }

    _objectFor(entry, state) {
      if (entry && entry.renderHint?.shape === 'fence') return this._fenceObjectFor(entry, state || {});
      const parts = entry ? this.registry.modelPartsForBlock(entry.id, state || {}) : [];
      if (parts.length) return this._objectFromModelParts(entry, parts);
      return this._fallbackObjectFor(entry);
    }

    _objectFromModelParts(entry, parts) {
      const root = new THREE.Group();
      for (const part of parts) {
        const partGroup = new THREE.Group();
        for (const el of part.elements) {
          partGroup.add(this._meshFromModelElement(entry, el, part));
        }
        partGroup.rotation.order = 'YXZ';
        partGroup.rotation.y = THREE.MathUtils.degToRad(part.y || 0);
        partGroup.rotation.x = THREE.MathUtils.degToRad(part.x || 0);
        root.add(partGroup);
      }
      return root;
    }

    _meshFromModelElement(entry, el, part) {
      const from = el.from || [0, 0, 0];
      const to = el.to || [16, 16, 16];
      const face = el.faces || {};
      const materialForFace = (name) => {
        const texRef = face[name] && face[name].texture;
        const url = texRef ? this.registry.textureUrlForModelRef(texRef, part.textures, part.ns) : null;
        return url ? this._materialFromUrl(url, { modelUv: true }) : this._transparentMaterial();
      };
      const faceNames = ['east', 'west', 'up', 'down', 'south', 'north'].filter(name => face[name]);
      const materials = faceNames.map(materialForFace);
      const mesh = new THREE.Mesh(this._geometryFromModelElement(el, faceNames), materials);
      if (el.rotation && typeof el.rotation.angle === 'number') {
        return this._rotatedElementGroup(mesh, el.rotation);
      }
      return mesh;
    }

    _geometryFromModelElement(el, faceNames) {
      const from = el.from || [0, 0, 0];
      const to = el.to || [16, 16, 16];
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
      const positions = [];
      const uvs = [];
      const indices = [];
      const geom = new THREE.BufferGeometry();
      let faceIndex = 0;
      for (const name of faceNames) {
        const face = el.faces[name];
        const base = positions.length / 3;
        for (const p of corners[name]) positions.push(p[0], p[1], p[2]);
        const uv = face.uv || [0, 0, 16, 16];
        const u1 = uv[0] / 16, v1 = 1 - uv[1] / 16;
        const u2 = uv[2] / 16, v2 = 1 - uv[3] / 16;
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

    _rotatedElementGroup(mesh, rot) {
      const pivot = new THREE.Group();
      const origin = rot.origin || [8, 8, 8];
      pivot.position.set(origin[0] / 16 - 0.5, origin[1] / 16 - 0.5, origin[2] / 16 - 0.5);
      mesh.position.sub(pivot.position);
      const angle = THREE.MathUtils.degToRad(rot.angle || 0);
      if (rot.axis === 'x') pivot.rotation.x = angle;
      else if (rot.axis === 'y') pivot.rotation.y = angle;
      else if (rot.axis === 'z') pivot.rotation.z = angle;
      pivot.add(mesh);
      return pivot;
    }

    _fallbackObjectFor(entry) {
      const root = new THREE.Group();
      const mesh = new THREE.Mesh(this._geometryFor(entry), this._materialFor(entry ? entry.id : null));
      const offset = this._meshOffsetFor(entry);
      mesh.position.copy(offset);
      root.add(mesh);
      return root;
    }

    _fenceObjectFor(entry, state) {
      const root = new THREE.Group();
      const mat = this._materialFromUrl(this._textureUrlForEntry(entry));
      this._addBox(root, [6, 0, 6], [10, 16, 10], mat);
      if (state.north) {
        this._addBox(root, [7, 12, 0], [9, 15, 9], mat);
        this._addBox(root, [7, 6, 0], [9, 9, 9], mat);
      }
      if (state.south) {
        this._addBox(root, [7, 12, 7], [9, 15, 16], mat);
        this._addBox(root, [7, 6, 7], [9, 9, 16], mat);
      }
      if (state.east) {
        this._addBox(root, [7, 12, 7], [16, 15, 9], mat);
        this._addBox(root, [7, 6, 7], [16, 9, 9], mat);
      }
      if (state.west) {
        this._addBox(root, [0, 12, 7], [9, 15, 9], mat);
        this._addBox(root, [0, 6, 7], [9, 9, 9], mat);
      }
      return root;
    }

    _addBox(root, from, to, material) {
      const sx = Math.max(0.001, (to[0] - from[0]) / 16);
      const sy = Math.max(0.001, (to[1] - from[1]) / 16);
      const sz = Math.max(0.001, (to[2] - from[2]) / 16);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
      mesh.position.set(
        (from[0] + to[0]) / 32 - 0.5,
        (from[1] + to[1]) / 32 - 0.5,
        (from[2] + to[2]) / 32 - 0.5,
      );
      root.add(mesh);
    }

    _textureUrlForEntry(entry) {
      return entry?.textureSet?.side
        || entry?.textureSet?.all
        || entry?.texture
        || null;
    }

    _transparentMaterial() {
      if (!this._transparentMat) {
        this._transparentMat = new THREE.MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          alphaTest: 1,
          side: THREE.DoubleSide,
        });
      }
      return this._transparentMat;
    }

    _materialFor(id) {
      if (this._materials.has(id)) return this._materials.get(id);
      const entry = this.registry.get(id);
      const mat = this._faceMaterialsFor(entry);
      this._materials.set(id, mat);
      return mat;
    }

    _faceMaterialsFor(entry) {
      if (!entry) return new THREE.MeshLambertMaterial({ color: 0x55606f });
      const set = entry.textureSet;
      if (set && (entry.renderHint?.shape || 'cube') === 'cube') {
        return [
          this._materialFromUrl(set.right || set.side || set.all),
          this._materialFromUrl(set.left || set.side || set.all),
          this._materialFromUrl(set.top || set.all),
          this._materialFromUrl(set.bottom || set.all),
          this._materialFromUrl(set.front || set.side || set.all),
          this._materialFromUrl(set.back || set.side || set.all),
        ];
      }
      return entry.texture
        ? this._materialFromUrl(entry.texture)
        : new THREE.MeshLambertMaterial({ color: 0x55606f });
    }

    _materialFromUrl(url, opts = {}) {
      const tex = this._textureForUrl(url, opts);
      return tex
        ? new THREE.MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide })
        : new THREE.MeshLambertMaterial({ color: 0x55606f });
    }

    _geometryFor(entry) {
      const shape = entry && entry.renderHint ? entry.renderHint.shape : 'cube';
      if (this._geometries.has(shape)) return this._geometries.get(shape);
      let geom;
      switch (shape) {
        case 'slab':
          geom = new THREE.BoxGeometry(1, 0.5, 1);
          break;
        case 'stairs':
          geom = new THREE.BoxGeometry(1, 0.75, 1);
          break;
        case 'pane':
          geom = new THREE.BoxGeometry(0.14, 1, 1);
          break;
        case 'fence':
          geom = new THREE.BoxGeometry(0.28, 1, 0.28);
          break;
        case 'wall':
          geom = new THREE.BoxGeometry(0.55, 1, 0.55);
          break;
        case 'door':
          geom = new THREE.BoxGeometry(1, 1, 0.16);
          break;
        case 'trapdoor':
          geom = new THREE.BoxGeometry(1, 0.1875, 1);
          break;
        case 'carpet':
          geom = new THREE.BoxGeometry(1, 0.0625, 1);
          break;
        case 'cross':
          geom = this._createCrossGeometry();
          break;
        case 'custom':
          geom = new THREE.BoxGeometry(0.9, 0.9, 0.9);
          break;
        default:
          geom = this._sharedGeom;
      }
      this._geometries.set(shape, geom);
      return geom;
    }

    _createCrossGeometry() {
      const positions = new Float32Array([
        -0.5, -0.5, -0.5,   0.5, -0.5,  0.5,   0.5,  0.5,  0.5,
        -0.5, -0.5, -0.5,   0.5,  0.5,  0.5,  -0.5,  0.5, -0.5,
         0.5, -0.5, -0.5,  -0.5, -0.5,  0.5,  -0.5,  0.5,  0.5,
         0.5, -0.5, -0.5,  -0.5,  0.5,  0.5,   0.5,  0.5, -0.5,
      ]);
      const uvs = new Float32Array([
        0, 0, 1, 0, 1, 1,
        0, 0, 1, 1, 0, 1,
        0, 0, 1, 0, 1, 1,
        0, 0, 1, 1, 0, 1,
      ]);
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geom.computeVertexNormals();
      return geom;
    }

    _meshOffsetFor(entry) {
      const shape = entry && entry.renderHint ? entry.renderHint.shape : 'cube';
      switch (shape) {
        case 'slab': return new THREE.Vector3(0, -0.25, 0);
        case 'stairs': return new THREE.Vector3(0, -0.125, 0);
        case 'trapdoor': return new THREE.Vector3(0, -0.40625, 0);
        case 'carpet': return new THREE.Vector3(0, -0.46875, 0);
        case 'cross': return new THREE.Vector3(0, -0.09, 0);
        case 'custom': return new THREE.Vector3(0, -0.05, 0);
        default: return new THREE.Vector3(0, 0, 0);
      }
    }

    _textureFor(entry) {
      if (!entry || !entry.texture) return null;
      if (this._textures.has(entry.id)) return this._textures.get(entry.id);
      const t = this._textureForUrl(entry.texture);
      this._textures.set(entry.id, t);
      return t;
    }

    _textureForUrl(url, opts = {}) {
      if (!url) return null;
      const key = `${url}|${opts.modelUv ? 'model' : 'default'}`;
      if (this._textures.has(key)) return this._textures.get(key);
      const t = new THREE.TextureLoader().load(url, () => { this._needsRender = true; });
      if (opts.modelUv) t.flipY = false;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.colorSpace = THREE.SRGBColorSpace;
      this._textures.set(key, t);
      return t;
    }

    _loop() {
      requestAnimationFrame(() => this._loop());
      if (this._needsRender) {
        this.renderer.render(this.scene, this.camera);
        this._needsRender = false;
      }
    }
  }

  global.MCBuilder = Builder;
})(window);
