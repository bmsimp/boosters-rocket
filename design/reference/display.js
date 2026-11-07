/* Applies the person's display choices before the page paints. Choices live on this device only. */
(function () {
  var KEY = 'br-display', root = document.documentElement, saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }

  function apply(o) {
    // theme: device | light | dark   contrast: device | standard | more
    // text: standard | large | larger   motion: device | reduce
    var map = { theme: ['light', 'dark'], contrast: ['standard', 'more'], text: ['large', 'larger'], motion: ['reduce'] };
    Object.keys(map).forEach(function (k) {
      if (map[k].indexOf(o[k]) >= 0) root.setAttribute('data-' + k, o[k]);
      else root.removeAttribute('data-' + k);
    });
  }
  apply(saved);

  // Reference-page switches: #dark, #light, #hc, #large, #larger, #gold (combine with +).
  location.hash.slice(1).split('+').forEach(function (k) {
    if (k === 'dark' || k === 'light') root.setAttribute('data-theme', k);
    if (k === 'hc') root.setAttribute('data-contrast', 'more');
    if (k === 'large' || k === 'larger') root.setAttribute('data-text', k);
    if (k === 'gold') root.setAttribute('data-club', 'gold');
  });

  window.BoosterDisplay = {
    get: function () { return Object.assign({ theme: 'device', contrast: 'device', text: 'standard', motion: 'device' }, saved); },
    set: function (k, v) {
      saved[k] = v; apply(saved);
      try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* private mode: applies for this visit only */ }
    }
  };
})();
