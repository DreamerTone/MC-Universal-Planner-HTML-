(function (global) {
  function el(sel, root) { return (root || document).querySelector(sel); }
  function els(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  let toastTimer = null;
  function toast(msg, kind) {
    const t = el('#toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast ' + (kind || '');
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  function setStatus(msg, kind) {
    const s = el('#gate-status');
    if (!s) return;
    s.textContent = msg || '';
    s.className = 'status ' + (kind || '');
  }

  function humanName(id) {
    // "minecraft:oak_planks" -> "Oak Planks"
    const part = id.includes(':') ? id.split(':')[1] : id;
    return part.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function fmtCount(n) {
    if (n < 64) return String(n);
    const stacks = Math.floor(n / 64);
    const rem = n - stacks * 64;
    return `${n} (${stacks}×64${rem ? ` + ${rem}` : ''})`;
  }

  global.MCUI = { el, els, toast, setStatus, humanName, fmtCount };
})(window);
