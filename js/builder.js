/* 2D layered builder: a top-down view of one Y-layer at a time, with a
 * slider to move between layers. Blocks are stored sparsely in a Map keyed
 * "x,y,z" so size changes don't lose data outside the new bounds (kept on
 * disk; just clipped from view). */
(function (global) {

  const CELL = 28; // px per cell on screen

  class Builder {
    constructor(canvas, registry) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.registry = registry;

      this.W = 16; this.D = 16; this.H = 8;
      this.layer = 0;
      this.showBelow = true;

      this.tool = 'place';
      this.selected = null;        // entry from registry, or null
      this.cells = new Map();      // "x,y,z" -> { id }
      this._textures = new Map();  // id -> HTMLImageElement
      this._hover = null;          // {x,z}
      this._dragButton = null;     // 0/2 while dragging

      this._onChange = [];
      this._bind();
      this._resize();
      this.render();
    }

    on(ev, fn) { (this._onChange[ev] = this._onChange[ev] || []).push(fn); }
    _emit(ev, data) { (this._onChange[ev] || []).forEach(fn => fn(data)); }

    setSize(w, d, h) {
      this.W = Math.max(1, Math.min(64, w | 0));
      this.D = Math.max(1, Math.min(64, d | 0));
      this.H = Math.max(1, Math.min(64, h | 0));
      if (this.layer >= this.H) this.layer = this.H - 1;
      this._resize();
      this.render();
      this._emit('resized');
    }

    setLayer(y) {
      this.layer = Math.max(0, Math.min(this.H - 1, y | 0));
      this.render();
    }

    setShowBelow(v) { this.showBelow = !!v; this.render(); }
    setTool(t) { this.tool = t; }
    setSelected(entry) { this.selected = entry; }

    clear() { this.cells.clear(); this.render(); this._emit('changed'); }
    clearLayer(y) {
      const yk = y == null ? this.layer : y;
      for (const k of Array.from(this.cells.keys())) {
        const [, ly] = k.split(',').map(Number);
        if (ly === yk) this.cells.delete(k);
      }
      this.render(); this._emit('changed');
    }

    blockCounts() {
      const m = new Map();
      for (const c of this.cells.values()) {
        m.set(c.id, (m.get(c.id) || 0) + 1);
      }
      return m;
    }

    toJSON() {
      return {
        version: 1,
        size: { w: this.W, d: this.D, h: this.H },
        cells: Array.from(this.cells.entries()).map(([k, v]) => [k, v.id]),
      };
    }

    fromJSON(data) {
      if (!data || data.version !== 1) throw new Error('Unsupported project file');
      this.W = data.size.w; this.D = data.size.d; this.H = data.size.h;
      this.layer = 0;
      this.cells.clear();
      for (const [k, id] of data.cells) this.cells.set(k, { id });
      this._resize();
      this.render();
      this._emit('changed');
      this._emit('resized');
    }

    /* ---------- internals ---------- */

    _resize() {
      this.canvas.width = this.W * CELL;
      this.canvas.height = this.D * CELL;
    }

    _bind() {
      const c = this.canvas;
      c.addEventListener('contextmenu', e => e.preventDefault());
      c.addEventListener('mousedown', (e) => {
        this._dragButton = e.button;
        this._applyAt(e);
      });
      window.addEventListener('mouseup', () => { this._dragButton = null; });
      c.addEventListener('mousemove', (e) => {
        const pos = this._cellAt(e);
        this._hover = pos;
        this._emit('hover', pos);
        if (this._dragButton !== null && this.tool !== 'fill') this._applyAt(e);
        this.render();
      });
      c.addEventListener('mouseleave', () => { this._hover = null; this.render(); this._emit('hover', null); });
    }

    _cellAt(e) {
      const rect = this.canvas.getBoundingClientRect();
      const sx = this.canvas.width / rect.width;
      const sy = this.canvas.height / rect.height;
      const px = (e.clientX - rect.left) * sx;
      const py = (e.clientY - rect.top) * sy;
      const x = Math.floor(px / CELL);
      const z = Math.floor(py / CELL);
      if (x < 0 || z < 0 || x >= this.W || z >= this.D) return null;
      return { x, z };
    }

    _applyAt(e) {
      const pos = this._cellAt(e);
      if (!pos) return;
      const key = `${pos.x},${this.layer},${pos.z}`;
      const isRight = e.button === 2 || this._dragButton === 2;

      if (this.tool === 'pick') {
        const c = this.cells.get(key);
        if (c) {
          const entry = this.registry.get(c.id);
          if (entry) { this.selected = entry; this._emit('picked', entry); }
        }
        return;
      }
      if (this.tool === 'erase' || isRight) {
        if (this.cells.delete(key)) { this.render(); this._emit('changed'); }
        return;
      }
      if (this.tool === 'fill') {
        if (!this.selected) return;
        for (let x = 0; x < this.W; x++)
          for (let z = 0; z < this.D; z++)
            this.cells.set(`${x},${this.layer},${z}`, { id: this.selected.id });
        this.render(); this._emit('changed');
        return;
      }
      // place
      if (!this.selected) return;
      this.cells.set(key, { id: this.selected.id });
      this.render(); this._emit('changed');
    }

    _imgFor(id) {
      if (this._textures.has(id)) return this._textures.get(id);
      const entry = this.registry.get(id);
      if (!entry || !entry.texture) { this._textures.set(id, null); return null; }
      const img = new Image();
      img.onload = () => this.render();
      img.src = entry.texture;
      this._textures.set(id, img);
      return img;
    }

    render() {
      const ctx = this.ctx;
      ctx.fillStyle = '#1f232a';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

      // Layer below (faded)
      if (this.showBelow && this.layer > 0) {
        ctx.globalAlpha = 0.28;
        this._renderLayer(this.layer - 1);
        ctx.globalAlpha = 1;
      }

      // Current layer
      this._renderLayer(this.layer);

      // Grid lines
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= this.W; x++) {
        ctx.moveTo(x * CELL + 0.5, 0);
        ctx.lineTo(x * CELL + 0.5, this.D * CELL);
      }
      for (let z = 0; z <= this.D; z++) {
        ctx.moveTo(0, z * CELL + 0.5);
        ctx.lineTo(this.W * CELL, z * CELL + 0.5);
      }
      ctx.stroke();

      // Hover highlight
      if (this._hover) {
        ctx.strokeStyle = '#7cb342';
        ctx.lineWidth = 2;
        ctx.strokeRect(this._hover.x * CELL + 1, this._hover.z * CELL + 1, CELL - 2, CELL - 2);
      }
    }

    _renderLayer(y) {
      const ctx = this.ctx;
      for (let x = 0; x < this.W; x++) {
        for (let z = 0; z < this.D; z++) {
          const cell = this.cells.get(`${x},${y},${z}`);
          if (!cell) continue;
          const img = this._imgFor(cell.id);
          if (img && img.complete && img.naturalWidth) {
            ctx.drawImage(img, x * CELL, z * CELL, CELL, CELL);
          } else {
            ctx.fillStyle = '#3a4150';
            ctx.fillRect(x * CELL + 2, z * CELL + 2, CELL - 4, CELL - 4);
          }
        }
      }
    }
  }

  global.MCBuilder = Builder;
})(window);
