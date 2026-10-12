// Todo list: simple checklist with categories, quick-add, and check-off.
(function () {
  'use strict';
  var D = window.DATA;
  var V = { el: null, query: '', drawer: false, pending: {} };

  function open() { return D.groceries.filter(function (g) { return !g.done; }); }
  function done() { return D.groceries.filter(function (g) { return g.done; }); }

  function find(name, isDone) {
    return D.groceries.filter(function (g) { return !!g.done === isDone && g.name.toLowerCase() === name.toLowerCase(); })[0];
  }

  function row(g) {
    return '<div class="t-row' + (V.pending[g.id] ? ' is-checking' : '') + '" data-id="' + g.id + '">' +
      '<button class="t-hit" data-check="' + g.id + '">' +
      '<span class="t-box">' + App.icon('check', 22) + '</span>' +
      '<span class="t-name"><b>' + App.esc(g.name) + '</b>' + (g.note ? '<small>' + App.esc(g.note) + '</small>' : '') + '</span>' +
      '<span class="t-cat label">' + g.cat + '</span>' +
      '</button>' +
      '<button class="t-del" data-del="' + g.id + '" aria-label="Delete">' + App.icon('x', 18) + '</button>' +
      '</div>';
  }

  function listHTML() {
    var items = open();
    var order = ['Errands', 'To Buy', 'To Do', 'Home', 'Work', 'Other'];
    var groups = order.map(function (cat) {
      return { cat: cat, items: items.filter(function (g) { return g.cat === cat; }) };
    }).filter(function (x) { return x.items.length; });

    var d = done();
    return (items.length
      ? groups.map(function (gr) {
          return '<div class="t-cat" data-cat="' + gr.cat + '"><div class="t-cat-h"><span class="label">' + gr.cat + '</span><span class="label num" data-cat-count>' + gr.items.length + '</span></div>' +
            gr.items.map(row).join('') + '</div>';
        }).join('')
      : '<div class="t-empty serif">All done!<br><i>Nothing left to do.</i></div>') +
      (d.length
        ? '<div class="t-drawer' + (V.drawer ? ' is-open' : '') + '">' +
            '<button class="t-drawer-h" data-drawer><span>' + App.icon('check', 22) + ' Done <b class="num">(' + d.length + ')</b></span><span class="label">' + (V.drawer ? 'Hide' : 'Show') + '</span></button>' +
            (V.drawer ? '<div class="t-drawer-list">' + d.map(function (g) {
              return '<button class="t-got" data-revive="' + g.id + '">' + App.esc(g.name) + '<span class="label">Add back</span></button>';
            }).join('') + '<button class="btn btn--ghost t-clear" data-clear>Clear ' + d.length + ' checked items</button></div>' : '') +
          '</div>'
        : '');
  }

  function suggestHTML() {
    var q = V.query.trim().toLowerCase();
    if (q) {
      var matches = D.catalog.filter(function (c) { return c[0].toLowerCase().indexOf(q) === 0; })
        .concat(D.catalog.filter(function (c) { var i = c[0].toLowerCase().indexOf(q); return i > 0; })).slice(0, 5);
      var exact = matches.some(function (m) { return m[0].toLowerCase() === q; });
      if (matches.length || !exact) {
        return '<div class="label">Suggestions</div><div class="t-ac">' + matches.map(function (m) {
          var on = find(m[0], false);
          return '<button class="t-ac-row" data-add="' + App.esc(m[0]) + '"><b>' + App.esc(m[0]) + '</b><span class="label">' + (on ? 'On list' : m[1]) + '</span>' + App.icon('plus', 26) + '</button>';
        }).join('') + (!exact ? '<button class="t-ac-row t-ac-row--new" data-add="' + App.esc(V.query.trim()) + '"><b>Add "' + App.esc(V.query.trim()) + '"</b><span class="label">' + categorize(V.query) + '</span>' + App.icon('plus', 26) + '</button>' : '') + '</div>';
      }
    }
    return '<div class="label">Common items</div><div class="t-usuals">' + D.usuals.map(usualTile).join('') + '</div>';
  }

  function usualTile(name) {
    var on = find(name, false);
    return '<button class="t-tile' + (on ? ' is-on' : '') + '" data-add="' + App.esc(name) + '">' +
      '<b>' + App.esc(name) + '</b><span>' + (on ? App.icon('check', 16) + 'On list' : categorize(name)) + '</span></button>';
  }

  // ---- helpers
  function categorize(name) {
    var n = name.toLowerCase();
    var hit = D.catalog.filter(function (c) { return c[0].toLowerCase() === n; })[0] ||
      D.catalog.filter(function (c) { var a = c[0].toLowerCase(); return a.indexOf(n) > -1 || n.indexOf(a) > -1; })[0] ||
      D.catalog.filter(function (c) { return n.split(/\s+/).some(function (w) { return w.length > 3 && c[0].toLowerCase().indexOf(w) > -1; }); })[0];
    return hit ? hit[1] : 'Other';
  }

  function swap(old, html) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    old.parentNode.replaceChild(tmp.firstChild, old);
  }

  function refreshUsualFor(g) {
    if (V.query.trim()) return paintSuggest();
    var t = V.el.querySelector('.t-usuals [data-add="' + App.esc(g.name) + '"]');
    if (t) swap(t, usualTile(g.name));
  }

  function catCount(cat) {
    var c = V.el.querySelector('.t-cat[data-cat="' + cat + '"]');
    if (!c) return;
    var n = c.querySelectorAll('.t-row').length;
    if (!n) c.parentNode.removeChild(c);
    else c.querySelector('[data-cat-count]').textContent = n;
  }

  function insertRow(g) {
    var cat = V.el.querySelector('.t-cat[data-cat="' + g.cat + '"]');
    if (!cat) return paintList();
    var tmp = document.createElement('div');
    tmp.innerHTML = row(g);
    cat.appendChild(tmp.firstChild);
    catCount(g.cat);
    paintHead();
  }

  function removeRow(g) {
    var r = V.el.querySelector('.t-list [data-id="' + g.id + '"]');
    var drawer = V.el.querySelector('.t-drawer');
    if (!r || !drawer || V.drawer || !open().length) return paintList();
    r.parentNode.removeChild(r);
    catCount(g.cat);
    drawer.querySelector('.num').textContent = '(' + done().length + ')';
    paintHead();
  }

  function flash(g) {
    var r = V.el.querySelector('.t-list [data-id="' + g.id + '"]');
    if (!r) return;
    r.classList.add('is-flash');
    if (r.scrollIntoView) r.scrollIntoView({ block: 'nearest' });
    setTimeout(function () { r.classList.remove('is-flash'); }, 1200);
  }

  function paintList() { var l = V.el.querySelector('.t-list'); var st = l.scrollTop; l.innerHTML = listHTML(); l.scrollTop = st; paintHead(); }
  function paintSuggest() { V.el.querySelector('.t-suggest').innerHTML = suggestHTML(); }
  function paintHead() {
    V.el.querySelector('.t-count').innerHTML = '<span class="num">' + open().length + '</span> open';
  }

  function render() {
    V.el.innerHTML = '<div class="todo">' +
      '<header class="t-head"><div><div class="label">Shared list</div><h1 class="serif">Todo</h1></div><div class="t-count"></div></header>' +
      '<div class="t-list"></div>' +
      '<aside class="t-side">' +
      '  <div class="t-add">' +
      '    <label class="t-input-wrap">' + App.icon('plus', 30) + '<input class="t-input" placeholder="Add an item…" autocomplete="off" enterkeyhint="done"></label>' +
      '  </div>' +
      '  <div class="t-suggest"></div>' +
      '</aside></div>';
    var input = V.el.querySelector('.t-input');
    input.value = V.query;
    input.addEventListener('input', function () { V.query = input.value; paintSuggest(); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && input.value.trim()) { add(input.value); } });
    paintList(); paintSuggest();
  }

  function add(name) {
    name = name.trim();
    var g = find(name, false), msg;
    if (g) {
      msg = 'Already on the list · <b>' + App.esc(g.name) + '</b>';
      flash(g);
    } else if ((g = find(name, true))) {
      g.done = false;
      msg = 'Added back <b>' + App.esc(g.name) + '</b>';
      paintList();
    } else {
      var catFromCatalog = D.catalog.filter(function (c) { return c[0].toLowerCase() === name.toLowerCase(); })[0];
      g = { id: D._gid(), name: catFromCatalog ? catFromCatalog[0] : name.charAt(0).toUpperCase() + name.slice(1), cat: categorize(name), done: false, note: '' };
      D.groceries.push(g);
      msg = 'Added <b>' + App.esc(g.name) + '</b> to ' + g.cat;
      insertRow(g);
    }
    var hadQuery = !!V.query.trim();
    V.query = '';
    var input = V.el.querySelector('.t-input');
    if (input) input.value = '';
    if (hadQuery) paintSuggest(); else refreshUsualFor(g);
    flash(g);
    App.emit('data');
    App.toast(msg, { icon: 'check', ms: 3000 });
  }

  function check(g) {
    V.pending[g.id] = true;
    var rowEl = V.el.querySelector('[data-id="' + g.id + '"]');
    rowEl.classList.add('is-checking');
    setTimeout(function () {
      if (!V.pending[g.id]) return;
      delete V.pending[g.id];
      g.done = true;
      removeRow(g);
      refreshUsualFor(g);
      App.emit('data');
    }, 800);
    App.toast('<b>' + App.esc(g.name) + '</b> done', {
      icon: 'check',
      undo: function () {
        var wasDone = g.done;
        delete V.pending[g.id];
        g.done = false;
        if (wasDone) paintList();
        else { var r = V.el.querySelector('.t-list [data-id="' + g.id + '"]'); if (r) r.classList.remove('is-checking'); }
        refreshUsualFor(g);
        App.emit('data');
      }
    });
  }

  function onClick(e) {
    var t;
    if ((t = e.target.closest('[data-check]'))) {
      var g = D.groceries.filter(function (x) { return x.id === t.dataset.check; })[0];
      if (g && !V.pending[g.id]) check(g);
      else if (g) { delete V.pending[g.id]; t.parentNode.classList.remove('is-checking'); }
      return;
    }
    if ((t = e.target.closest('[data-del]'))) {
      var g = D.groceries.filter(function (x) { return x.id === t.dataset.del; })[0];
      if (!g) return;
      var idx = D.groceries.indexOf(g);
      D.groceries.splice(idx, 1);
      paintList();
      App.toast('Removed <b>' + App.esc(g.name) + '</b>', {
        icon: 'x', undo: function () { D.groceries.splice(idx, 0, g); paintList(); App.emit('data'); }
      });
      App.emit('data');
      return;
    }
    if ((t = e.target.closest('[data-add]'))) return add(t.dataset.add);
    if ((t = e.target.closest('[data-drawer]'))) { V.drawer = !V.drawer; return paintList(); }
    if ((t = e.target.closest('[data-revive]'))) {
      var r = D.groceries.filter(function (x) { return x.id === t.dataset.revive; })[0];
      r.done = false; paintList(); paintSuggest(); App.emit('data');
      return App.toast('Added back <b>' + App.esc(r.name) + '</b>', { icon: 'check', ms: 2500 });
    }
    if ((t = e.target.closest('[data-clear]'))) {
      var gone = done();
      D.groceries = D.groceries.filter(function (x) { return gone.indexOf(x) < 0; });
      V.drawer = false;
      paintList();
      App.toast('Cleared ' + gone.length + ' items', {
        icon: 'check', undo: function () { D.groceries = D.groceries.concat(gone); paintList(); }
      });
    }
  }

  App.register('shopping', {
    show: function (el) {
      if (!V.el) { V.el = el; el.addEventListener('click', onClick); }
      render();
    }
  });
})();