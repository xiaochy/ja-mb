/* Future-time colour ramp.

   Red -> maize, matching the burned-in track colours in the paper's figures and
   in the gallery clips, so the 3D view and the videos encode time the same way.
   The same five stops are declared as --t0..--t4 in css/style.css, so the CSS
   gradients (the legend bar, the layer swatch) and the WebGL line colours
   cannot drift apart. */
(function (global) {
  'use strict';

  var HEX = ['#c81e1e', '#e24a1a', '#f4761a', '#fda31a', '#ffcb05'];

  var STOPS = HEX.map(function (h) {
    return [
      parseInt(h.slice(1, 3), 16) / 255,
      parseInt(h.slice(3, 5), 16) / 255,
      parseInt(h.slice(5, 7), 16) / 255
    ];
  });

  /** t in [0,1] -> [r,g,b] in [0,1]. */
  function ramp(t) {
    if (!isFinite(t)) t = 0;
    t = Math.min(1, Math.max(0, t));
    var x = t * (STOPS.length - 1);
    var i = Math.min(STOPS.length - 2, Math.floor(x));
    var f = x - i;
    var a = STOPS[i];
    var b = STOPS[i + 1];
    return [
      a[0] + (b[0] - a[0]) * f,
      a[1] + (b[1] - a[1]) * f,
      a[2] + (b[2] - a[2]) * f
    ];
  }

  function css(t) {
    var c = ramp(t);
    return 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ','
      + Math.round(c[2] * 255) + ')';
  }

  global.TrackColormap = { ramp: ramp, css: css, stops: STOPS, hex: HEX };
})(window);
