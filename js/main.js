/* JAMB project page -- page chrome.

   The charts live in js/charts.js, the simulation gallery in js/sim-gallery.js
   and the 3D Track Theater in js/track-viewer.js. */
(function () {
  'use strict';

  function getJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' -> ' + r.status);
      return r.json();
    });
  }

  /* The paper and appendix PDFs are dropped into website/ when they are ready.
     Probe for them instead of hard-coding availability, so adding the file is
     the only step: a missing target turns its button into a pending chip. */
  function probeAssets() {
    document.querySelectorAll('a[data-asset]').forEach(function (a) {
      var href = a.getAttribute('href');
      fetch(href, { method: 'HEAD' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); })
        .catch(function () {
          var span = document.createElement('span');
          span.className = a.className + ' is-pending';
          span.title = 'Available after review';
          while (a.firstChild) span.appendChild(a.firstChild);
          a.replaceWith(span);
        });
    });
  }

  function initCopy() {
    var button = document.querySelector('.copy-button');
    if (!button) return;
    button.addEventListener('click', function () {
      var target = document.getElementById(
        button.getAttribute('data-copy-target'));
      if (!target) return;
      navigator.clipboard.writeText(target.innerText).then(function () {
        button.textContent = 'Copied';
        setTimeout(function () { button.textContent = 'Copy'; }, 1800);
      }).catch(function () {
        button.textContent = 'Copy failed';
        setTimeout(function () { button.textContent = 'Copy'; }, 1800);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    probeAssets();
    initCopy();

    getJSON('data/manifest.json')
      .then(function (manifest) {
        window.JAMBManifest = manifest;
        document.dispatchEvent(
          new CustomEvent('jamb:manifest', { detail: manifest }));
      })
      .catch(function (err) {
        console.warn('manifest', err);
        document.dispatchEvent(
          new CustomEvent('jamb:manifest', { detail: null }));
      });
  });
})();
