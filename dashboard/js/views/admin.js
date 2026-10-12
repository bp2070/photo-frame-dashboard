/**
 * Admin panel — accessible only when logged in as admin.
 * Manages people, and shows dashboard configuration status.
 */
(function () {
  'use strict';
  var D = window.DATA;
  var App = window.App;
  var V = { el: null };

  // ---- People management helpers ----
  function peopleHTML() {
    return '<div class="ad-section"><div class="label">People</div>' +
      '<div class="ad-people">' + D.people.map(function (p, i) {
        return '<div class="ad-person" style="--c:' + p.color + '">' +
          '<div class="ad-avatar">' + (p.name ? p.name[0] : '?') + '</div>' +
          '<div class="ad-p-fields">' +
          '<input class="ad-input ad-input--name" value="' + App.esc(p.name) + '" data-idx="' + i + '" data-field="name">' +
          '<div class="ad-p-meta"><span>ID: ' + p.id + '</span><span>Color: ' + p.color + '</span></div>' +
          '</div>' +
          '<label class="ad-toggle">' +
          '<input type="checkbox" data-idx="' + i + '" data-field="home" ' + (p.home ? 'checked' : '') + '>' +
          '<span>At home</span></label>' +
          '<button class="ad-del" data-del-person="' + i + '" aria-label="Delete">' + App.icon('x', 18) + '</button>' +
          '</div>';
      }).join('') + '</div>' +
      '<button class="btn btn--ghost" data-add-person style="margin-top:12px">' + App.icon('plus', 20) + ' Add person</button></div>';
  }

  // ---- Config status ----
  function statusHTML() {
    return '<div class="ad-section"><div class="label">Status</div>' +
      '<div class="ad-status">' +
      '<div class="ad-stat"><span>Logged in as</span><b>' + App.esc(App.user ? App.user.email : '') + '</b></div>' +
      '<div class="ad-stat"><span>Admin</span><b>' + (App.user && App.user.isAdmin ? 'Yes' : 'No') + '</b></div>' +
      '<div class="ad-stat"><span>Calendar feed</span><b id="ad-cal-status">Checking…</b></div>' +
      '</div></div>';
  }

  // ---- Full render ----
  function render() {
    V.el.innerHTML = '<div class="admin">' +
      '<div class="ad-head"><div><div class="label">Settings</div><h1 class="serif">Admin</h1></div>' +
      '<button class="btn btn--ghost" data-logout style="margin-left:auto">' + App.icon('x', 20) + ' Sign out</button></div>' +
      '<div class="ad-body">' + statusHTML() + peopleHTML() + '</div>' +
      '<div class="ad-footer"><button class="btn btn--solid" data-save>Save changes</button>' +
      '<span class="label ad-saved" style="opacity:0">Saved</span></div></div>';

    // Check calendar status
    fetch('/api/health').then(function (r) { return r.json(); }).then(function (d) {
      var el = V.el.querySelector('#ad-cal-status');
      if (el) el.textContent = d.calendarConfigured ? 'Connected' : 'Not configured';
    }).catch(function () {
      var el = V.el.querySelector('#ad-cal-status');
      if (el) el.textContent = 'Unreachable';
    });
  }

  // ---- Event handling ----
  function onClick(e) {
    var t = e.target.closest('button');
    if (!t) return;

    if (t.hasAttribute('data-logout')) {
      App.logout();
      return;
    }

    if (t.hasAttribute('data-save')) {
      // Read all name inputs and update D.people
      var inputs = V.el.querySelectorAll('.ad-input--name');
      inputs.forEach(function (inp) {
        var idx = parseInt(inp.dataset.idx, 10);
        if (idx >= 0 && idx < D.people.length) {
          D.people[idx].name = inp.value;
        }
      });

      // Read home checkboxes
      var checks = V.el.querySelectorAll('[data-field="home"]');
      checks.forEach(function (chk) {
        var idx = parseInt(chk.dataset.idx, 10);
        if (idx >= 0 && idx < D.people.length) {
          D.people[idx].home = chk.checked;
        }
      });

      // Save to localStorage for persistence
      try {
        localStorage.setItem('hq-people', JSON.stringify(D.people));
      } catch (err) { /* storage may be full */ }

      // Show saved confirmation
      var saved = V.el.querySelector('.ad-saved');
      if (saved) {
        saved.style.opacity = '1';
        setTimeout(function () { saved.style.opacity = '0'; }, 2000);
      }

      App.emit('data');
      return;
    }

    if (t.hasAttribute('data-add-person')) {
      D.people.push({
        id: 'p' + (D.people.length + 1),
        name: 'New Person',
        color: '#666666',
        rgb: '102 102 102',
        ink: '#FFFFFF',
        home: true,
        status: '',
      });
      D.ALL.push(D.people[D.people.length - 1].id);
      render();
      App.emit('data');
      return;
    }

    if (t.hasAttribute('data-del-person')) {
      var idx = parseInt(t.dataset.delPerson, 10);
      if (idx >= 0 && idx < D.people.length) {
        var removed = D.people.splice(idx, 1)[0];
        var idIdx = D.ALL.indexOf(removed.id);
        if (idIdx > -1) D.ALL.splice(idIdx, 1);
        render();
        App.emit('data');
        App.toast('Removed <b>' + App.esc(removed.name) + '</b>', { icon: 'x', ms: 2000 });
      }
      return;
    }
  }

  // ---- Input handler for real-time field updates ----
  function onInput(e) {
    // Color pickers and other dynamic fields could go here
  }

  App.register('admin', {
    show: function (el) {
      if (!App.user || !App.user.isAdmin) {
        App.go('home');
        return;
      }
      if (!V.el) {
        V.el = el;
        el.addEventListener('click', onClick);
        el.addEventListener('input', onInput);
      }
      render();
    },
  });
})();