/* JAMB -- the three charts on the page.

   All numbers come from data/results/*.json, which tools/build_results_json.py
   transcribes from the paper, so nothing here restates a result by hand. The
   only derived quantities are per-category means of the per-task Easy->Hard
   table, taken over the task_groups the builder records; averaging the per-task
   ablation table the same way reproduces the paper's Sync./Seq. columns exactly.

   Palette: navy tints for baselines and maize for ours. The teaser chart is
   the one exception -- it reuses the three pastel colours from the paper's own
   teaser figure, so the figure beside it and the chart read as one image. */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var NAVY = '#00274c';
  var MAIZE = '#ffcb05';
  var REDUCED = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var PARADIGM = {
    dp3: { fill: 'rgb(245,203,185)', on: '#ec8d65' },
    gap: { fill: 'rgb(194,212,235)', on: '#6296da' },
    ours: { fill: 'rgb(195,216,187)', on: '#7fc464' }
  };

  /* ------------------------------------------------------------- helpers */

  function svg(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) {
      if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    return n;
  }

  function text(x, y, str, cls, anchor) {
    var n = svg('text', { x: x, y: y, class: cls, 'text-anchor': anchor || 'middle' });
    n.textContent = str;
    return n;
  }

  function getJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' -> ' + r.status);
      return r.json();
    });
  }

  /** Navy mixed with white; a = navy fraction. */
  function navyTint(a) {
    var mix = function (c) { return Math.round(c * a + 255 * (1 - a)); };
    return 'rgb(' + mix(0) + ',' + mix(39) + ',' + mix(76) + ')';
  }

  /** Baselines walk a light-to-dark navy ramp; the last series is ours. */
  function seriesColors(n) {
    var out = [];
    var k = n - 1;
    for (var i = 0; i < k; i++) {
      out.push(navyTint(k === 1 ? 0.5 : 0.20 + 0.62 * (i / (k - 1))));
    }
    out.push(MAIZE);
    return out;
  }

  function niceMax(v) {
    if (v <= 10) return Math.ceil(v / 2) * 2;
    if (v <= 25) return Math.ceil(v / 5) * 5;
    return Math.ceil(v / 20) * 20;
  }

  /** "Sync-bimanual (8)" -> ["Sync-bimanual", "(8)"]; single words stay whole. */
  function splitLabel(label) {
    var i = label.lastIndexOf(' ');
    return i > 0 ? [label.slice(0, i), label.slice(i + 1)] : [label];
  }

  function ticks(max, n) {
    var out = [];
    for (var i = 0; i <= n; i++) out.push((max * i) / n);
    return out;
  }

  /** Grow bars from the baseline. Attribute animation, so no CSS geometry
      transition support is assumed. */
  function animate(bars, ms) {
    if (REDUCED) {
      bars.forEach(function (b) { b.apply(1); });
      return;
    }
    var t0 = 0;
    function frame(now) {
      if (!t0) t0 = now;
      var p = Math.min(1, (now - t0) / ms);
      var e = 1 - Math.pow(1 - p, 3);
      bars.forEach(function (b) { b.apply(e); });
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function width(host, fallback) {
    var w = host.clientWidth;
    return w > 40 ? w : fallback;
  }

  /** Re-render on resize, but only when the width actually changed. */
  function onResize(host, render) {
    var last = width(host, 0);
    var timer = 0;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var w = width(host, 0);
        if (Math.abs(w - last) < 8) return;
        last = w;
        render();
      }, 160);
    });
  }

  /* --------------------------------------------------------- teaser chart */

  function teaserChart(host, figure, data) {
    var byName = {};
    data.methods.forEach(function (m) { byName[m.name] = m; });
    var rows = [
      { key: 'dp3', label: 'DP3', value: byName.DP3.avg.mean },
      { key: 'gap', label: 'GAP', value: byName.GAP.avg.mean },
      { key: 'ours', label: 'Ours', value: byName.JAMB.avg.mean }
    ];

    var active = null;
    var parts = {};

    function render() {
      var W = Math.max(280, width(host, 400));
      var H = Math.max(250, Math.min(330, W * 0.78));
      var M = { top: 20, right: 12, bottom: 34, left: 34 };
      var pw = W - M.left - M.right;
      var ph = H - M.top - M.bottom;
      var max = 100;

      host.innerHTML = '';
      parts = {};
      var root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, role: 'img',
        'aria-label': 'Real-world success rate: DP3 35.6 percent, GAP 64.4 percent, JAMB 85.6 percent'
      });

      ticks(max, 5).forEach(function (t) {
        var y = M.top + ph - (t / max) * ph;
        root.appendChild(svg('line', {
          x1: M.left, x2: M.left + pw, y1: y, y2: y, class: 'grid-line'
        }));
        root.appendChild(text(M.left - 7, y + 4, String(t), 'tick-text', 'end'));
      });
      root.appendChild(svg('line', {
        x1: M.left, x2: M.left + pw, y1: M.top + ph, y2: M.top + ph, class: 'axis-line'
      }));

      var slot = pw / rows.length;
      var base = Math.min(44, slot * 0.26);
      var anims = [];

      rows.forEach(function (r, i) {
        var cx = M.left + slot * (i + 0.5);
        var h = (r.value / max) * ph;
        var g = svg('g', { class: 'bar-g' });
        var rect = svg('rect', {
          x: cx - base / 2, y: M.top + ph, width: base, height: 0,
          rx: 3, fill: PARADIGM[r.key].fill, stroke: NAVY, 'stroke-width': 0.8
        });
        var val = text(cx, M.top + ph - 7, r.value.toFixed(1) + '%', 'value-text');
        var name = text(cx, M.top + ph + 20, r.label, 'group-text');
        g.appendChild(rect);
        g.appendChild(val);
        root.appendChild(g);
        root.appendChild(name);

        anims.push({
          apply: function (e) {
            rect.setAttribute('height', h * e);
            rect.setAttribute('y', M.top + ph - h * e);
            val.setAttribute('y', M.top + ph - h * e - 7);
          }
        });

        parts[r.key] = {
          rect: rect, val: val, name: name, cx: cx, h: h, base: base,
          top: M.top + ph - h, bottom: M.top + ph
        };

        var hit = svg('rect', {
          x: M.left + slot * i, y: M.top, width: slot, height: ph,
          fill: 'transparent', style: 'cursor:pointer'
        });
        hit.addEventListener('mouseenter', function () { setActive(r.key); });
        hit.addEventListener('mouseleave', function () { setActive(null); });
        root.appendChild(hit);
      });

      host.appendChild(root);
      animate(anims, 620);
      paint();
    }

    function paint() {
      Object.keys(parts).forEach(function (key) {
        var p = parts[key];
        var on = key === active;
        var w = on ? p.base * 1.3 : p.base;
        p.rect.setAttribute('x', p.cx - w / 2);
        p.rect.setAttribute('width', w);
        p.rect.setAttribute('fill', on ? PARADIGM[key].on : PARADIGM[key].fill);
        p.rect.setAttribute('stroke-width', on ? 1.8 : 0.8);
        p.val.setAttribute('style', on
          ? 'font-size:13.5px;font-weight:700;fill:' + NAVY
          : '');
        p.name.setAttribute('style', on ? 'font-weight:700;fill:' + NAVY : '');
      });
      if (figure) {
        figure.classList.toggle('is-active', active != null);
        Array.prototype.forEach.call(figure.querySelectorAll('.hot'), function (h) {
          h.classList.toggle('is-on', h.dataset.key === active);
        });
      }
    }

    function setActive(key) {
      if (key === active) return;
      active = key;
      paint();
    }

    if (figure) {
      Array.prototype.forEach.call(figure.querySelectorAll('.hot'), function (h) {
        h.addEventListener('mouseenter', function () { setActive(h.dataset.key); });
        h.addEventListener('mouseleave', function () { setActive(null); });
        h.addEventListener('focus', function () { setActive(h.dataset.key); });
        h.addEventListener('blur', function () { setActive(null); });
      });
    }

    render();
    onResize(host, render);
  }

  /* ---------------------------------------------------- grouped bar chart */

  /**
   * spec = {
   *   series: [{name, ours}],
   *   groups: [{label, values: [number|null]}],
   *   max, unit
   * }
   */
  function groupedChart(host, legendHost, spec) {
    var colors = seriesColors(spec.series.length);

    if (legendHost) {
      legendHost.innerHTML = '';
      spec.series.forEach(function (s, i) {
        var span = document.createElement('span');
        var sw = document.createElement('i');
        sw.style.background = colors[i];
        span.appendChild(sw);
        span.appendChild(document.createTextNode(s.name));
        legendHost.appendChild(span);
      });
    }

    function render() {
      var W = Math.max(300, width(host, 900));
      var narrow = W < 620;
      var M = { top: 18, right: 10, bottom: narrow ? 48 : 38, left: 36 };
      var ph = Math.max(180, Math.min(340, W * 0.34));
      var H = ph + M.top + M.bottom;
      var pw = W - M.left - M.right;
      var max = spec.max;

      host.innerHTML = '';
      var root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });

      ticks(max, 5).forEach(function (t) {
        var y = M.top + ph - (t / max) * ph;
        root.appendChild(svg('line', {
          x1: M.left, x2: M.left + pw, y1: y, y2: y, class: 'grid-line'
        }));
        root.appendChild(text(M.left - 7, y + 4, t.toFixed(0), 'tick-text', 'end'));
      });
      root.appendChild(svg('line', {
        x1: M.left, x2: M.left + pw, y1: M.top + ph, y2: M.top + ph, class: 'axis-line'
      }));

      var slot = pw / spec.groups.length;
      // cap the bar width so a two-group chart does not turn into slabs
      var inner = Math.min(slot * 0.82, spec.series.length * 46);
      var bw = inner / spec.series.length;
      var anims = [];
      var showValues = bw >= 26;

      spec.groups.forEach(function (g, gi) {
        var x0 = M.left + slot * gi + (slot - inner) / 2;
        g.values.forEach(function (v, si) {
          if (v == null) return;
          var h = (v / max) * ph;
          var x = x0 + bw * si;
          var grp = svg('g', { class: 'bar-g' });
          var rect = svg('rect', {
            x: x + 1, y: M.top + ph, width: Math.max(2, bw - 2), height: 0,
            rx: 2, fill: colors[si],
            class: spec.series[si].ours ? 'bar-rect is-ours' : 'bar-rect',
            stroke: spec.series[si].ours ? NAVY : 'rgba(0,39,76,0.28)',
            'stroke-width': spec.series[si].ours ? 1.2 : 0.7
          });
          var title = svg('title', {});
          title.textContent = spec.series[si].name + ' · ' + g.label + ' · '
            + v.toFixed(1) + spec.unit;
          rect.appendChild(title);
          grp.appendChild(rect);
          var val = null;
          if (showValues) {
            val = text(x + bw / 2, M.top + ph - 5, v.toFixed(1), 'value-text');
            grp.appendChild(val);
          }
          root.appendChild(grp);
          anims.push({
            apply: function (e) {
              rect.setAttribute('height', h * e);
              rect.setAttribute('y', M.top + ph - h * e);
              if (val) val.setAttribute('y', M.top + ph - h * e - 5);
            }
          });
        });

        /* Narrow: break "Sync-bimanual (8)" onto two centred lines rather
           than rotating it. A rotated label overruns the plot on the first
           group and collides with the next on the others. */
        var lx = M.left + slot * (gi + 0.5);
        var ly = M.top + ph + 16;
        var lines = narrow ? splitLabel(g.label) : [g.label];
        lines.forEach(function (ln, li) {
          var t = text(lx, ly + li * 12, ln, 'group-text');
          if (narrow) t.setAttribute('style', 'font-size:10.5px');
          root.appendChild(t);
        });
      });

      host.appendChild(root);
      animate(anims, 560);
    }

    render();
    return render;
  }

  /* ------------------------------------------------- ablation butterfly */

  var SHORT = {
    'Action-only': ['Action-only'],
    'Track regression': ['Track regression'],
    'Track-conditioned action diffusion': ['Track-conditioned', 'action diffusion'],
    'w/o Visual–Track Concatenation': ['w/o Visual–Track', 'Concatenation'],
    'w/o 4D RoPE': ['w/o 4D RoPE'],
    'Full model': ['Full model']
  };

  /**
   * rows = [{ name, ours, left, right }] with left = success rate (higher is
   * better, grows toward the centre from the left) and right = ADE in mm
   * (lower is better, grows rightward). Labels sit in one shared middle
   * column, so the two charts stay row-aligned without repeating them.
   */
  function butterflyChart(host, rows, opts) {
    function render() {
      var W = Math.max(300, width(host, 900));
      var stacked = W < 720;
      host.innerHTML = '';
      if (stacked) {
        host.appendChild(stackedSvg(W, 'left'));
        host.appendChild(stackedSvg(W, 'right'));
      } else {
        host.appendChild(wideSvg(W));
      }
    }

    function labelLines(r) {
      return SHORT[r.name] || [r.name];
    }

    function drawLabel(root, x, y, r, anchor) {
      var lines = labelLines(r);
      var dy = lines.length === 1 ? 4 : -2;
      lines.forEach(function (ln, i) {
        var t = text(x, y + dy + i * 12.5, ln, 'group-text', anchor);
        if (r.ours) t.setAttribute('style', 'font-weight:700;fill:' + NAVY);
        root.appendChild(t);
      });
    }

    function bar(root, x, y, w, h, ours) {
      var rect = svg('rect', {
        x: x, y: y, width: Math.max(1.5, w), height: h, rx: 2,
        // the same blue as the middle paradigm in the teaser chart
        fill: ours ? MAIZE : PARADIGM.gap.fill,
        stroke: NAVY, 'stroke-width': ours ? 1.2 : 0.7
      });
      root.appendChild(rect);
      return rect;
    }

    function wideSvg(W) {
      var rowH = 40;
      var top = 40;
      var bottom = 30;
      var H = top + rows.length * rowH + bottom;
      var labelW = 176;
      var gap = 14;
      // the outermost axis tick labels are centred on the axis ends, so leave
      // half a label of room outside each side
      var pad = 16;
      var side = (W - labelW - gap * 2 - pad * 2) / 2;
      var leftX = pad;
      var labelX = leftX + side + gap;
      var rightX = labelX + labelW + gap;
      var anims = [];

      var root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });
      root.appendChild(text(leftX + side / 2, 16, opts.leftTitle, 'col-head'));
      root.appendChild(text(rightX + side / 2, 16, opts.rightTitle, 'col-head'));

      rows.forEach(function (r, i) {
        var y = top + i * rowH;
        var h = rowH - 16;
        drawLabel(root, labelX + labelW / 2, y + h / 2, r, 'middle');

        if (r.left != null) {
          var lw = (r.left / opts.leftMax) * side;
          var rect = bar(root, leftX + side - lw, y, lw, h, r.ours);
          var lv = text(leftX + side - lw - 6, y + h / 2 + 4,
            r.left.toFixed(1), 'value-text', 'end');
          if (r.ours) lv.setAttribute('style', 'font-weight:700;fill:' + NAVY);
          root.appendChild(lv);
          anims.push({ apply: function (e) {
            rect.setAttribute('x', leftX + side - lw * e);
            rect.setAttribute('width', Math.max(1.5, lw * e));
            lv.setAttribute('x', leftX + side - lw * e - 6);
          } });
        }

        if (r.right != null) {
          var rw = (r.right / opts.rightMax) * side;
          var rrect = bar(root, rightX, y, rw, h, r.ours);
          var rv = text(rightX + rw + 6, y + h / 2 + 4, r.right.toFixed(1),
            'value-text', 'start');
          if (r.ours) rv.setAttribute('style', 'font-weight:700;fill:' + NAVY);
          root.appendChild(rv);
          anims.push({ apply: function (e) {
            rrect.setAttribute('width', Math.max(1.5, rw * e));
            rv.setAttribute('x', rightX + rw * e + 6);
          } });
        } else {
          root.appendChild(text(rightX + 4, y + h / 2 + 4, opts.rightMissing,
            'tick-text', 'start'));
        }
      });

      var axisY = top + rows.length * rowH + 2;
      axis(root, leftX, side, axisY, opts.leftMax, true);
      axis(root, rightX, side, axisY, opts.rightMax, false);
      animate(anims, 620);
      return root;
    }

    function stackedSvg(W, sideKey) {
      var isLeft = sideKey === 'left';
      var rowH = 38;
      var top = 34;
      var H = top + rows.length * rowH + 34;
      var labelW = Math.min(168, W * 0.44);
      var barX = labelW + 10;
      var side = W - barX - 42;
      var max = isLeft ? opts.leftMax : opts.rightMax;
      var anims = [];

      var root = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, role: 'img',
        style: 'margin-bottom:0.9rem'
      });
      // flush left: at phone widths the header is wider than the bar column
      root.appendChild(text(0, 16, isLeft ? opts.leftTitle : opts.rightTitle,
        'col-head', 'start'));

      rows.forEach(function (r, i) {
        var y = top + i * rowH;
        var h = rowH - 15;
        drawLabel(root, labelW, y + h / 2, r, 'end');
        var v = isLeft ? r.left : r.right;
        if (v == null) {
          root.appendChild(text(barX + 2, y + h / 2 + 4,
            isLeft ? '\u2013' : opts.rightMissing, 'tick-text', 'start'));
          return;
        }
        var w = (v / max) * side;
        var rect = bar(root, barX, y, w, h, r.ours);
        var val = text(barX + w + 6, y + h / 2 + 4, v.toFixed(1), 'value-text',
          'start');
        if (r.ours) val.setAttribute('style', 'font-weight:700;fill:' + NAVY);
        root.appendChild(val);
        anims.push({ apply: function (e) {
          rect.setAttribute('width', Math.max(1.5, w * e));
          val.setAttribute('x', barX + w * e + 6);
        } });
      });

      axis(root, barX, side, top + rows.length * rowH + 2, max, false);
      animate(anims, 620);
      return root;
    }

    function axis(root, x0, span, y, max, mirrored) {
      root.appendChild(svg('line', {
        x1: x0, x2: x0 + span, y1: y, y2: y, class: 'axis-line'
      }));
      ticks(max, 4).forEach(function (t) {
        var frac = t / max;
        var x = mirrored ? x0 + span * (1 - frac) : x0 + span * frac;
        root.appendChild(svg('line', {
          x1: x, x2: x, y1: y, y2: y + 4, class: 'axis-line'
        }));
        root.appendChild(text(x, y + 16, t.toFixed(0), 'tick-text'));
      });
    }

    render();
    onResize(host, render);
  }

  /* ------------------------------------------------------------- wiring */

  function meanBy(method, groups, name) {
    var idx = [];
    groups.forEach(function (g, i) { if (g === name) idx.push(i); });
    var sum = 0;
    idx.forEach(function (i) { sum += method.values[i].mean; });
    return sum / idx.length;
  }

  function initPerformance(res) {
    var host = document.getElementById('perf-chart');
    var legend = document.getElementById('perf-legend');
    var note = document.getElementById('perf-note');
    var domainRow = document.getElementById('perf-domain');
    var settingRow = document.getElementById('perf-setting');
    if (!host) return;

    var SIM_ORDER = ['DP', 'DP3', 'DICP', 'GAP', 'ATM', 'JAMB'];
    var HARD_ORDER = ['DP3', 'DICP', 'GAP', 'ATM', 'JAMB'];

    function series(names) {
      return names.map(function (n) {
        return { name: n === 'JAMB' ? 'JAMB (Ours)' : n, ours: n === 'JAMB' };
      });
    }

    function pick(table, name) {
      return table.methods.filter(function (m) { return m.name === name; })[0];
    }

    var VIEWS = {
      'sim:easy': function () {
        return {
          series: series(SIM_ORDER),
          groups: [
            { label: 'Dominant-select', values: SIM_ORDER.map(function (n) {
              return pick(res.dominant_select, n).avg.mean; }) },
            { label: 'Sync-bimanual', values: SIM_ORDER.map(function (n) {
              return pick(res.sync_bimanual, n).avg.mean; }) },
            { label: 'Seq-coordinate', values: SIM_ORDER.map(function (n) {
              return pick(res.seq_coordinate, n).avg.mean; }) }
          ],
          max: 100, unit: '%',
          note: 'Mean success rate per task category, 3 evaluation seeds × 50 '
            + 'rollouts per task. Dominant-select is the 16-task single-arm set; '
            + 'the two bimanual categories hold 8 tasks each.'
        };
      },
      'sim:hard': function () {
        var t = res.easy_to_hard;
        return {
          series: series(HARD_ORDER),
          groups: [
            { label: 'Sync-bimanual', values: HARD_ORDER.map(function (n) {
              return meanBy(pick(t, n), t.task_groups, 'Sync-bimanual'); }) },
            { label: 'Seq-coordinate', values: HARD_ORDER.map(function (n) {
              return meanBy(pick(t, n), t.task_groups, 'Seq-coordinate'); }) }
          ],
          max: 25, unit: '%',
          note: 'Evaluated on the '
            + 'eight representative RoboTwin2.0 tasks. Mean success rate per task category, 3 evaluation seeds × 50 '
            + 'rollouts per task.'
        };
      },
      real: function () {
        var t = res.realworld;
        var names = ['DP3', 'GAP', 'JAMB'];
        var groups = t.tasks.map(function (label, i) {
          return { label: label, values: names.map(function (n) {
            return pick(t, n).values[i].mean; }) };
        });
        groups.push({ label: 'Average', values: names.map(function (n) {
          return pick(t, n).avg.mean; }) });
        return {
          series: series(names), groups: groups, max: 100, unit: '%',
          note: '30 trials per method–task pair on two xArm manipulators with a '
            + 'fixed ZED Mini stereo camera.'
        };
      }
    };

    var state = { domain: 'sim', setting: 'easy' };

    function show() {
      var key = state.domain === 'real' ? 'real'
        : 'sim:' + state.setting;
      var spec = VIEWS[key]();
      settingRow.style.display = state.domain === 'sim' ? '' : 'none';
      note.textContent = spec.note;
      groupedChart(host, legend, spec);
    }

    function bindRow(row, attr, key) {
      row.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        var v = b.getAttribute(attr);
        if (state[key] === v) return;
        state[key] = v;
        Array.prototype.forEach.call(row.children, function (x) {
          x.classList.toggle('is-active', x === b);
        });
        show();
      });
    }

    bindRow(domainRow, 'data-domain', 'domain');
    bindRow(settingRow, 'data-setting', 'setting');
    show();
    onResize(host, show);
  }

  function initAblation(res) {
    var host = document.getElementById('ablation-chart');
    if (!host) return;
    var ade = {};
    res.track_metrics.methods.forEach(function (m) {
      ade[m.name] = m.values[0].mean;
    });
    var rows = res.ablation.methods.map(function (m) {
      return {
        name: m.name, ours: !!m.ours, left: m.avg.mean,
        right: ade[m.name] != null ? ade[m.name] : null
      };
    });
    butterflyChart(host, rows, {
      leftTitle: 'Success rate (%) — higher is better',
      rightTitle: 'Track ADE (mm) — lower is better',
      leftMax: 100, rightMax: 16,
      rightMissing: 'no tracks predicted'
    });
  }

  function init() {
    var need = ['realworld', 'dominant_select', 'sync_bimanual', 'seq_coordinate',
      'easy_to_hard', 'ablation', 'track_metrics'];
    Promise.all(need.map(function (n) {
      return getJSON('data/results/' + n + '.json');
    })).then(function (list) {
      var res = {};
      need.forEach(function (n, i) { res[n] = list[i]; });

      var teaserHost = document.getElementById('teaser-chart');
      if (teaserHost) {
        teaserChart(teaserHost, document.getElementById('paradigm'), res.realworld);
      }
      initPerformance(res);
      initAblation(res);
    }).catch(function (err) {
      console.warn('charts', err);
      ['teaser-chart', 'perf-chart', 'ablation-chart'].forEach(function (id) {
        var h = document.getElementById(id);
        if (h) h.innerHTML = '<div class="loading">Run tools/build_results_json.py '
          + 'to generate data/results/*.json</div>';
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
