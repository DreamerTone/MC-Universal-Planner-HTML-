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
      this.cells = new Map();        // "x,y,z" -> { id, mesh }
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
        cells: Array.from(this.cells.entries()).map(([k, v]) => [k, v.id]),
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
      for (const [k, id] of data.cells) {
        const [x, y, z] = k.split(',').map(Number);
        this._placeRaw(x, y, z, id);
      }
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
      const hits = this._raycaster.intersectObjects(this._pickables(), false);
      if (!hits.length) return null;
      const h = hits[0];
      if (h.object.userData.cellKey) {
        const [x, y, z] = h.object.userData.cellKey.split(',').map(Number);
        return { x, y, z };
      }
      const x = Math.floor(h.point.x);
      const z = Math.floor(h.point.z);
      if (x < 0 || x >= this.W || z < 0 || z >= this.D) return null;
      return { x, y: 0, z };
    }

    _handleClick(e, button) {
      this._raycaster.setFromCamera(this._ndcFromEvent(e), this.camera);
      const hits = this._raycaster.intersectObjects(this._pickables(), false);
      if (!hits.length) return;
      const hit = hits[0];
      const isRight = button === 2;

      // Block clicked
      if (hit.object.userData.cellKey) {
        const [x, y, z] = hit.object.userData.cellKey.split(',').map(Number);
        if (this.tool === 'pick') {
          const cell = this.cells.get(hit.object.userData.cellKey);
          const entry = cell && this.registry.get(cell.id);
          if (entry) { this.selected = entry; this._emit('picked', entry); }
          return;
        }
        if (this.tool === 'erase' || isRight) {
          this._eraseAt(x, y, z);
          return;
        }
        const n = hit.face.normal;
        this._placeAt(x + Math.round(n.x), y + Math.round(n.y), z + Math.round(n.z));
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
          this._placeAt(px, 0, pz);
        }
      }
    }

    _fillLevel(y) {
      if (!this.selected) return;
      for (let x = 0; x < this.W; x++)
        for (let z = 0; z < this.D; z++)
          this._placeRaw(x, y, z, this.selected.id);
      this._needsRender = true;
      this._emit('changed');
    }

    _placeAt(x, y, z) {
      if (x < 0 || x >= this.W || y < 0 || y >= this.H || z < 0 || z >= this.D) return;
      if (!this.selected) return;
      this._placeRaw(x, y, z, this.selected.id);
      this._needsRender = true;
      this._emit('changed');
    }

    _placeRaw(x, y, z, id) {
      const key = `${x},${y},${z}`;
      const existing = this.cells.get(key);
      if (existing) {
        if (existing.id === id) return;
        this.scene.remove(existing.mesh);
      }
      const entry = this.registry.get(id);
      const mesh = new THREE.Mesh(this._geometryFor(entry), this._materialFor(id));
      const offset = this._meshOffsetFor(entry);
      mesh.position.set(x + 0.5 + offset.x, y + 0.5 + offset.y, z + 0.5 + offset.z);
      mesh.userData.cellKey = key;
      this.scene.add(mesh);
      this.cells.set(key, { id, mesh });
    }

    _eraseAt(x, y, z) {
      const key = `${x},${y},${z}`;
      const c = this.cells.get(key);
      if (!c) return;
      this.scene.remove(c.mesh);
      this.cells.delete(key);
      this._needsRender = true;
      this._emit('changed');
    }

    _materialFor(id) {
      if (this._materials.has(id)) return this._materials.get(id);
      const entry = this.registry.get(id);
      const tex = this._textureFor(entry);
      const mat = tex
        ? new THREE.MeshLambertMaterial({ map: tex })
        : new THREE.MeshLambertMaterial({ color: 0x55606f });
      this._materials.set(id, mat);
      return mat;
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
          geom = new THREE.BoxGeometry(0.82, 0.82, 0.82);
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
      const t = new THREE.TextureLoader().load(entry.texture, () => { this._needsRender = true; });
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.colorSpace = THREE.SRGBColorSpace;
      this._textures.set(entry.id, t);
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
