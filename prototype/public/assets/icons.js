/* Inline SVG sprite. Injected as the first child of <body> so <use href="#i-x">
 * resolves before first paint. Stroke icons, sized by .icon in app.css. */

(function () {
  'use strict';

  var ICONS = {
    'play':    '<path d="M6 3.5l14 8.5-14 8.5z"/>',
    'stop':    '<rect x="5" y="5" width="14" height="14" rx="1"/>',
    'flip':    '<path d="M17 2.5l4 4-4 4"/><path d="M21 6.5H9a5 5 0 000 10h1"/><path d="M7 21.5l-4-4 4-4"/><path d="M3 17.5h12a5 5 0 000-10h-1"/>',
    'flash':   '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    'camera':  '<path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/>',
    'save':    '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
    'vol-on':  '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 010 7"/><path d="M19 5a10 10 0 010 14"/>',
    'vol-off': '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6"/><path d="M16 9l6 6"/>',
    'mic':     '<path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><path d="M12 19v4"/><path d="M8 23h8"/>',
    'expand':  '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
    'link':    '<path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>',
    'power':   '<path d="M18.36 6.64a9 9 0 11-12.73 0"/><path d="M12 2v10"/>',
    'nofeed':  '<path d="M2 2l20 20"/><path d="M16 16v2a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2h2"/><path d="M22 8l-6 4"/><path d="M10 6h4a2 2 0 012 2v2"/>',
    'copy':    '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
    'info':    '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    'phone':   '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
    'monitor': '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    'settings':'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
  };

  function inject() {
    if (document.getElementById('icon-sprite')) return;
    var parts = ['<svg id="icon-sprite" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">'];
    for (var k in ICONS) {
      if (!Object.prototype.hasOwnProperty.call(ICONS, k)) continue;
      parts.push('<symbol id="i-' + k + '" viewBox="0 0 24 24">' + ICONS[k] + '</symbol>');
    }
    parts.push('</svg>');
    var host = document.createElement('div');
    host.innerHTML = parts.join('');
    document.body.insertBefore(host.firstChild, document.body.firstChild);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject);
  else inject();
})();
