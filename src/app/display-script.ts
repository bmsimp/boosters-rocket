/** Runs before first paint (inlined in <head>). Choices live on this device only. */
export const DISPLAY_SCRIPT = `
(function () {
  var KEY = 'br-display', root = document.documentElement, saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
  var map = { theme: ['light', 'dark'], contrast: ['standard', 'more'], text: ['large', 'larger'], motion: ['reduce'] };
  function apply(o) {
    Object.keys(map).forEach(function (k) {
      if (map[k].indexOf(o[k]) >= 0) root.setAttribute('data-' + k, o[k]);
      else root.removeAttribute('data-' + k);
    });
  }
  apply(saved);
  window.BoosterDisplay = {
    get: function () { return Object.assign({ theme: 'device', contrast: 'device', text: 'standard', motion: 'device' }, saved); },
    set: function (k, v) {
      saved[k] = v; apply(saved);
      try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) {}
    }
  };
})();`;
