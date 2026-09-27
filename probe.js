/* MAIN-мир: перехват attachShadow + объявление <video> из закрытых Shadow DOM.
   Оптимизировано: нет обходов всего документа, только точечные наблюдения. */
(() => {
  if (window.__veProbe) return;
  window.__veProbe = 1;

  const closedRoots = [];
  const seen = new WeakSet();
  const orig = Element.prototype.attachShadow;

  const announce = el => {
    try { window.dispatchEvent(new CustomEvent('__veVideo', { detail: el })); } catch (e) {}
  };

  const scanRoot = (r, deep) => {
    try {
      const vids = r.getElementsByTagName('video');   // быстрая нативная выборка
      for (let i = 0; i < vids.length; i++){
        if (!seen.has(vids[i])) { seen.add(vids[i]); announce(vids[i]); }
      }
      if (deep){                                       // только при редком обходе: вложенные open-roots
        const els = r.querySelectorAll('*');
        for (let i = 0; i < els.length; i++){
          const sr = els[i].shadowRoot;
          if (sr) scanRoot(sr, false);
        }
      }
    } catch (e) {}
  };

  Element.prototype.attachShadow = function (init) {
    const root = orig.call(this, init);
    closedRoots.push(root);
    new MutationObserver(() => scanRoot(root, false)).observe(root, { childList: true, subtree: true });
    scanRoot(root, false);
    return root;
  };

  setInterval(() => { for (let i = 0; i < closedRoots.length; i++) scanRoot(closedRoots[i], true); }, 3000);
  window.addEventListener('__veDump', () => { for (let i = 0; i < closedRoots.length; i++) scanRoot(closedRoots[i], true); });
})();