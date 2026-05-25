/* Block / item browser view. */
(function (global) {

  class BrowserView {
    constructor(rootSel, registry) {
      this.root = document.querySelector(rootSel);
      this.registry = registry;
      this.search = document.querySelector('#browser-search');
      this.nsSel = document.querySelector('#browser-ns');
      this.typeSel = document.querySelector('#browser-type');
      this.categorySel = document.querySelector('#browser-category');
      this.count = document.querySelector('#browser-count');

      this.search.addEventListener('input', () => this.render());
      this.nsSel.addEventListener('change', () => this.render());
      this.typeSel.addEventListener('change', () => {
        this.refreshCategories();
        this.render();
      });
      this.categorySel.addEventListener('change', () => this.render());
    }

    refreshNamespaces() {
      const opts = ['<option value="">All</option>'];
      for (const ns of Array.from(this.registry.namespaces).sort()) {
        opts.push(`<option>${ns}</option>`);
      }
      this.nsSel.innerHTML = opts.join('');
      this.refreshCategories();
    }

    refreshCategories() {
      const opts = ['<option value="">All</option>'];
      for (const cat of this.registry.categoriesFor(this.typeSel.value)) {
        opts.push(`<option value="${cat.id}">${cat.label}</option>`);
      }
      const prev = this.categorySel.value;
      this.categorySel.innerHTML = opts.join('');
      if (prev && opts.some(o => o.includes(`value="${prev}"`))) this.categorySel.value = prev;
    }

    render() {
      const entries = this.registry.allEntries({
        kind: this.typeSel.value,
        ns: this.nsSel.value || null,
        category: this.categorySel.value || null,
        query: this.search.value,
      });
      this.count.textContent = `${entries.length} entries`;
      // Cap render to keep DOM manageable; user can search to narrow.
      const cap = 600;
      const shown = entries.slice(0, cap);
      const html = shown.map(e => `
        <div class="browser-card" data-id="${e.id}">
          ${e.texture
            ? `<img src="${e.texture}" alt="">`
            : `<div style="width:48px;height:48px;background:#3a4150"></div>`}
          <div class="nm">${escapeHtml(e.displayName)}</div>
          <div class="id">${e.id}</div>
          <div class="kind">${e.kind} &middot; ${escapeHtml(e.categoryLabel || 'Misc')}</div>
          ${e.renderHint && e.renderHint.shape && e.renderHint.shape !== 'item'
            ? `<div class="shape">${escapeHtml(e.renderHint.shape)}</div>`
            : ''}
        </div>
      `).join('');
      this.root.innerHTML = html + (entries.length > cap
        ? `<div class="muted" style="grid-column:1/-1;padding:12px;text-align:center">${entries.length - cap} more &mdash; refine your search</div>` : '');
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  global.MCBrowserView = BrowserView;
})(window);
