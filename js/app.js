/* App boot, JAR gate, tabs, and wiring for the four views. */
(function () {
  const { el, els, toast, setStatus, humanName, fmtCount } = MCUI;

  const state = {
    pack: null,
    registry: new MCRegistry(),
    calc: null,
    builder: null,
    browserView: null,
    currentRecipeId: null,
  };

  /* ====================================================================
   * GATE
   * Always require a click before entering the app, even when a pack
   * is cached. This honors the "don't auto-give access to the grid" rule.
   * ==================================================================== */
  async function initGate() {
    const cached = await MCStorage.getPack('primary').catch(() => null);
    if (cached) {
      el('#gate-cached').classList.remove('hidden');
      el('#cached-name').textContent = cached.name;
      el('#cached-version').textContent = (cached.meta && cached.meta.mcVersion) || 'unknown';
    }
    el('#gate-file').addEventListener('change', (e) => {
      const f = e.target.files[0]; if (f) handleJar(f);
    });
    const drop = el('#gate-drop');
    drop.addEventListener('click', () => el('#gate-file').click());
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el('#gate-file').click(); }
    });
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => {
      e.preventDefault(); drop.classList.remove('dragover');
    }));
    drop.addEventListener('drop', (e) => {
      const f = e.dataTransfer.files[0]; if (f) handleJar(f);
    });
    el('#gate-use-cached').addEventListener('click', async () => {
      const c = await MCStorage.getPack('primary');
      if (c && c.blob) await handleJar(new File([c.blob], c.name), { fromCache: true });
    });
    el('#gate-clear-cached').addEventListener('click', async () => {
      await MCStorage.deletePack('primary');
      el('#gate-cached').classList.add('hidden');
      setStatus('Cached pack removed.', 'ok');
    });
  }

  async function handleJar(file, opts = {}) {
    const name = file.name || 'unknown.jar';
    if (!/\.(jar|zip)$/i.test(name)) {
      setStatus('Please choose a .jar file.', 'error');
      return;
    }
    setStatus(`Reading ${name}...`);
    try {
      const pack = await MCJarLoader.loadJar(file, (done, total) => {
        setStatus(`Parsing ${name}: ${done.toLocaleString()} / ${total.toLocaleString()} entries`);
      });
      const blocksCount = sumBy(pack, n => n.blocks.size);
      const itemsCount = sumBy(pack, n => n.items.size);
      const recipesCount = sumBy(pack, n => n.recipes.size);
      if (blocksCount === 0 && recipesCount === 0) {
        setStatus('No blocks or recipes found. Is this a vanilla client jar (not the server jar)?', 'error');
        return;
      }
      state.pack = pack;
      state.registry.reset();
      state.registry.addPack(pack);
      state.calc = new MCRecipes(state.registry);

      if (!opts.fromCache) {
        await MCStorage.savePack('primary', file, {
          mcVersion: pack.mcVersion,
          packFormat: pack.packFormat,
        }).catch(err => console.warn('cache save failed', err));
      }

      setStatus(
        `Loaded ${pack.mcVersion || 'unknown'} - ${blocksCount.toLocaleString()} blocks, `
        + `${itemsCount.toLocaleString()} items, ${recipesCount.toLocaleString()} recipes.`,
        'ok'
      );
      enterApp(pack);
    } catch (err) {
      console.error(err);
      setStatus(`Failed to read jar: ${err.message || err}`, 'error');
    }
  }

  function sumBy(pack, fn) {
    let n = 0; for (const nsd of Object.values(pack.namespaces)) n += fn(nsd);
    return n;
  }

  /* ====================================================================
   * APP
   * ==================================================================== */
  function enterApp(pack) {
    el('#gate').classList.add('hidden');
    el('#app').classList.remove('hidden');
    el('#pack-version').textContent = pack.mcVersion
      ? `MC ${pack.mcVersion}` + (pack.packFormat ? ` (pack ${pack.packFormat})` : '')
      : 'MC version unknown';

    // Tabs
    els('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
    el('#change-pack').addEventListener('click', () => {
      el('#app').classList.add('hidden');
      el('#gate').classList.remove('hidden');
      setStatus('');
    });

    initBuilderView();
    initRecipesView();
    initBrowserView();
    initMaterialsView();
  }

  function switchTab(name) {
    els('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    els('.view').forEach(v => v.classList.toggle('active', v.dataset.view === name));
    if (name === 'materials') renderMaterials();
  }

  /* ---------- BUILDER ---------- */
  function initBuilderView() {
    state.builder = new MCBuilder(el('#grid-canvas'), state.registry);

    renderPalette('');
    el('#palette-search').addEventListener('input', (e) => renderPalette(e.target.value));

    els('.tool').forEach(b => b.addEventListener('click', () => {
      els('.tool').forEach(x => x.classList.toggle('active', x === b));
      state.builder.setTool(b.dataset.tool);
    }));

    el('#apply-size').addEventListener('click', () => {
      const w = +el('#grid-w').value;
      const d = +el('#grid-d').value;
      const h = +el('#grid-h').value;
      state.builder.setSize(w, d, h);
      el('#layer-slider').max = String(h - 1);
      if (+el('#layer-slider').value > h - 1) {
        el('#layer-slider').value = String(h - 1);
        el('#layer-num').textContent = String(h - 1);
      }
    });
    el('#layer-slider').addEventListener('input', (e) => {
      const v = +e.target.value;
      el('#layer-num').textContent = String(v);
      state.builder.setLayer(v);
    });
    el('#show-below').addEventListener('change', (e) => state.builder.setShowBelow(e.target.checked));

    el('#clear-layer').addEventListener('click', () => state.builder.clearLayer());
    el('#clear-build').addEventListener('click', () => {
      if (confirm('Clear the whole build?')) state.builder.clear();
    });
    el('#save-build').addEventListener('click', saveBuild);
    el('#load-build').addEventListener('click', loadBuild);
    el('#export-build').addEventListener('click', exportBuild);
    el('#import-build-btn').addEventListener('click', () => el('#import-build').click());
    el('#import-build').addEventListener('change', (e) => importBuild(e.target.files[0]));

    state.builder.on('hover', (pos) => {
      el('#cursor-coords').textContent = pos
        ? `x=${pos.x}  y=${state.builder.layer}  z=${pos.z}`
        : '-';
      if (pos) {
        const c = state.builder.cells.get(`${pos.x},${state.builder.layer},${pos.z}`);
        el('#cell-info').textContent = c ? c.id : '';
      } else el('#cell-info').textContent = '';
    });
    state.builder.on('picked', (entry) => {
      state.builder.setSelected(entry);
      renderSelected(entry);
      const cell = el(`.palette-cell[data-id="${cssEscape(entry.id)}"]`);
      els('.palette-cell.selected').forEach(c => c.classList.remove('selected'));
      if (cell) cell.classList.add('selected');
    });
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return s.replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
  }

  function renderPalette(query) {
    const grid = el('#palette-grid');
    const entries = state.registry.allEntries({ kind: 'block', query });
    const cap = 500;
    const shown = entries.slice(0, cap);
    grid.innerHTML = shown.map(e => `
      <div class="palette-cell ${e.texture ? '' : 'no-tex'}" data-id="${e.id}" title="${e.displayName} (${e.id})">
        ${e.texture ? `<img src="${e.texture}" alt="">` : `${e.name}`}
      </div>
    `).join('') + (entries.length > cap
      ? `<div class="muted" style="grid-column:1/-1;padding:8px;text-align:center;font-size:11px">${entries.length - cap} more &mdash; refine search</div>`
      : '');
    els('.palette-cell').forEach(cell => {
      cell.addEventListener('click', () => {
        const id = cell.dataset.id;
        const entry = state.registry.get(id);
        if (!entry) return;
        state.builder.setSelected(entry);
        renderSelected(entry);
        els('.palette-cell.selected').forEach(c => c.classList.remove('selected'));
        cell.classList.add('selected');
      });
    });
  }

  function renderSelected(entry) {
    const sel = el('#selected-block');
    if (!entry) { sel.innerHTML = '<span>No block selected</span>'; return; }
    sel.innerHTML = `
      ${entry.texture ? `<img src="${entry.texture}" alt="">` : ''}
      <div class="info">
        <span class="name">${escapeHtml(entry.displayName)}</span>
        <span class="id">${entry.id}</span>
      </div>`;
  }

  async function saveBuild() {
    const data = state.builder.toJSON();
    await MCStorage.saveProject({
      id: 'default',
      mcVersion: state.pack.mcVersion,
      data,
    });
    toast('Build saved.', 'ok');
  }
  async function loadBuild() {
    const p = await MCStorage.getProject('default');
    if (!p) { toast('No saved build found.', 'error'); return; }
    state.builder.fromJSON(p.data);
    el('#grid-w').value = state.builder.W;
    el('#grid-d').value = state.builder.D;
    el('#grid-h').value = state.builder.H;
    el('#layer-slider').max = String(state.builder.H - 1);
    el('#layer-slider').value = '0';
    el('#layer-num').textContent = '0';
    toast('Build loaded.', 'ok');
  }
  function exportBuild() {
    const data = state.builder.toJSON();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `mc-build-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function importBuild(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        state.builder.fromJSON(data);
        el('#grid-w').value = state.builder.W;
        el('#grid-d').value = state.builder.D;
        el('#grid-h').value = state.builder.H;
        el('#layer-slider').max = String(state.builder.H - 1);
        toast('Build imported.', 'ok');
      } catch (e) {
        toast('Failed to import: ' + e.message, 'error');
      }
    };
    reader.readAsText(file);
  }

  /* ---------- RECIPES VIEW ---------- */
  function initRecipesView() {
    const search = el('#recipe-search');
    const countInput = el('#recipe-count');
    const breakRaw = el('#recipe-break-raw');
    search.addEventListener('input', () => renderRecipeResults(search.value));
    countInput.addEventListener('input', () => renderRecipeDetail(state.currentRecipeId));
    breakRaw.addEventListener('change', () => renderRecipeDetail(state.currentRecipeId));
    renderRecipeResults('');
  }

  function renderRecipeResults(query) {
    const root = el('#recipe-results');
    const q = query.trim().toLowerCase();
    // Only items that have at least one recipe (or all items with q)
    const hasRecipe = new Set(state.registry.recipes.keys());
    const all = state.registry.allEntries({ kind: 'all', query });
    const filtered = q ? all : all.filter(e => hasRecipe.has(e.id));
    filtered.sort((a, b) => {
      const ar = hasRecipe.has(a.id) ? 0 : 1;
      const br = hasRecipe.has(b.id) ? 0 : 1;
      return ar - br || a.id.localeCompare(b.id);
    });
    const cap = 300;
    const shown = filtered.slice(0, cap);
    root.innerHTML = shown.map(e => `
      <div class="res" data-id="${e.id}">
        ${e.texture ? `<img src="${e.texture}" alt="">` : `<div style="width:28px;height:28px;background:#3a4150"></div>`}
        <div>
          <div class="name">${escapeHtml(e.displayName)}${hasRecipe.has(e.id) ? '' : ' <span class="muted" style="font-size:10px">(raw)</span>'}</div>
          <div class="id">${e.id}</div>
        </div>
      </div>
    `).join('') + (filtered.length > cap
      ? `<div class="muted" style="padding:10px;text-align:center;font-size:12px">${filtered.length - cap} more</div>` : '');
    els('#recipe-results .res').forEach(r => {
      r.addEventListener('click', () => {
        els('#recipe-results .res').forEach(x => x.classList.remove('active'));
        r.classList.add('active');
        renderRecipeDetail(r.dataset.id);
      });
    });
  }

  function renderRecipeDetail(id) {
    state.currentRecipeId = id;
    const root = el('#recipe-detail');
    if (!id) { root.innerHTML = '<p class="muted">Select an item to see its recipe.</p>'; return; }
    const entry = state.registry.get(id);
    if (!entry) { root.innerHTML = `<p class="muted">${id} not found.</p>`; return; }
    const recipes = state.calc.allRecipes(id);
    const count = Math.max(1, +el('#recipe-count').value || 1);
    const breakRaw = el('#recipe-break-raw').checked;

    let html = `<h3>${escapeHtml(entry.displayName)} <span class="muted" style="font-weight:400;font-size:12px">${id}</span></h3>`;

    if (!recipes.length) {
      html += `<p class="muted">No recipe found &mdash; this is a raw material in this pack.</p>`;
    } else {
      html += `<div class="muted" style="margin-bottom:8px">${recipes.length} recipe${recipes.length === 1 ? '' : 's'}:</div>`;
      for (const rec of recipes) html += renderRecipeBlock(rec);
    }

    // Total materials for N
    const { totals } = state.calc.materialsFor(id, count, { breakRaw });
    html += `<h3 style="margin-top:20px">Materials needed for ${count} &times; ${escapeHtml(entry.displayName)}</h3>`;
    html += renderMaterialsList(totals);
    root.innerHTML = html;
  }

  function renderRecipeBlock(rec) {
    if (rec.type === 'crafting_shaped') {
      return `<div style="margin-bottom:16px">
        <span class="recipe-type-tag">shaped</span>
        <div style="display:flex;align-items:center;margin-top:6px">
          ${renderShapedGrid(rec)}
          <span class="craft-arrow">&rarr;</span>
          <span class="craft-result">${renderItemCell(rec.result.id, rec.result.count)}</span>
        </div>
      </div>`;
    }
    if (rec.type === 'crafting_shapeless') {
      return `<div style="margin-bottom:16px">
        <span class="recipe-type-tag">shapeless</span>
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:6px">
          ${rec.inputs.map(i => renderItemCell(i.id, i.count, i.isTag)).join('')}
          <span class="craft-arrow">&rarr;</span>
          ${renderItemCell(rec.result.id, rec.result.count)}
        </div>
      </div>`;
    }
    // smelting / blasting / smoking / campfire / stonecutting / smithing / unknown
    const ingredients = rec.inputs.map(i => renderItemCell(i.id, i.count, i.isTag)).join('');
    return `<div style="margin-bottom:16px">
      <span class="recipe-type-tag">${rec.type.replace(/_/g, ' ')}</span>
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:6px">
        ${ingredients}
        <span class="craft-arrow">&rarr;</span>
        ${renderItemCell(rec.result.id, rec.result.count)}
      </div>
    </div>`;
  }

  function renderShapedGrid(rec) {
    const rows = rec.pattern || [];
    const w = Math.max(...rows.map(r => r.length), 1);
    const cells = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        if (r < rows.length && c < w) {
          const ch = rows[r][c];
          const ing = rec.key && rec.key[ch];
          if (ing) {
            cells.push(`<div class="craft-cell">${renderItemImg(ing.id, ing.isTag)}</div>`);
            continue;
          }
        }
        cells.push(`<div class="craft-cell"></div>`);
      }
    }
    return `<div class="craft-grid">${cells.join('')}</div>`;
  }

  function renderItemImg(id, isTag) {
    if (isTag) {
      const real = state.registry.firstItemInTag(id) || id;
      const e = state.registry.get(real);
      return e && e.texture ? `<img src="${e.texture}" title="any ${id}">` : `<span style="font-size:10px">#${shortId(id)}</span>`;
    }
    const e = state.registry.get(id);
    return e && e.texture ? `<img src="${e.texture}" title="${id}">` : `<span style="font-size:10px">${shortId(id)}</span>`;
  }

  function renderItemCell(id, count, isTag) {
    return `<div class="craft-cell" title="${id}">
      ${renderItemImg(id, isTag)}
      ${count && count > 1 ? `<span class="count">${count}</span>` : ''}
    </div>`;
  }

  function renderMaterialsList(totals) {
    if (!totals.size) return '<p class="muted">None.</p>';
    const arr = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]);
    return `<div class="materials-list">` + arr.map(([id, qty]) => {
      const entry = state.registry.get(id) || { displayName: shortId(id), texture: null };
      return `<div class="mat-row" title="${id}">
        ${entry.texture ? `<img src="${entry.texture}" alt="">` : `<div style="width:28px;height:28px;background:#3a4150"></div>`}
        <div style="display:flex;flex-direction:column;min-width:0">
          <span class="qty">${fmtCount(qty)}</span>
          <span class="nm">${escapeHtml(entry.displayName)}</span>
        </div>
      </div>`;
    }).join('') + `</div>`;
  }

  function shortId(id) { return id.replace(/^minecraft:/, ''); }

  /* ---------- BROWSER ---------- */
  function initBrowserView() {
    state.browserView = new MCBrowserView('#browser-grid', state.registry);
    state.browserView.refreshNamespaces();
    state.browserView.render();
  }

  /* ---------- MATERIALS ---------- */
  function initMaterialsView() {
    el('#mat-refresh').addEventListener('click', renderMaterials);
    el('#mat-break-raw').addEventListener('change', renderMaterials);
  }

  function renderMaterials() {
    const root = el('#materials-content');
    const counts = state.builder.blockCounts();
    if (!counts.size) {
      root.innerHTML = '<p class="muted">Build is empty. Place some blocks in the Builder tab.</p>';
      return;
    }
    const breakRaw = el('#mat-break-raw').checked;
    const totals = state.calc.materialsForBuild(counts, { breakRaw });

    const blockSummary = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id, qty]) => {
        const e = state.registry.get(id) || { displayName: shortId(id), texture: null };
        return `<div class="mat-row" title="${id}">
          ${e.texture ? `<img src="${e.texture}" alt="">` : `<div style="width:28px;height:28px;background:#3a4150"></div>`}
          <div style="display:flex;flex-direction:column;min-width:0">
            <span class="qty">${qty}</span>
            <span class="nm">${escapeHtml(e.displayName)}</span>
          </div>
        </div>`;
      }).join('');

    root.innerHTML = `
      <h3 style="margin-top:14px">Blocks in build (${counts.size} unique)</h3>
      <div class="materials-list">${blockSummary}</div>
      <h3 style="margin-top:20px">${breakRaw ? 'Raw materials needed' : 'Direct ingredients needed'}</h3>
      ${renderMaterialsList(totals)}
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /* ---- start ---- */
  document.addEventListener('DOMContentLoaded', initGate);
})();
