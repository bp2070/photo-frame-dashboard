/**
 * Auth — attaches user info to App, exposes login/logout, and shows the admin
 * nav button for admin users.
 *
 * Must be imported after app.js in main.js.
 */
(function () {
  'use strict';

  var App = window.App;
  if (!App) return;

  App.user = null; // { email, name, isAdmin }

  async function checkAuth() {
    try {
      var controller = new AbortController();
      setTimeout(function () { controller.abort(); }, 5000);
      var res = await fetch('/auth/me', { signal: controller.signal });
      if (!res.ok) {
        App.user = null;
        showAdminBtn(false);
        return false;
      }
      var data = await res.json();
      if (data.authenticated) {
        App.user = { email: data.email, name: data.name, isAdmin: data.isAdmin };
        showAdminBtn(data.isAdmin);
        App.emit('auth', App.user);
        return true;
      }
      App.user = null;
      showAdminBtn(false);
      return false;
    } catch (e) {
      App.user = null;
      showAdminBtn(false);
      return false;
    }
  }

  function showAdminBtn(show) {
    var btn = document.getElementById('navAdmin');
    if (btn) btn.classList.toggle('is-hidden', !show);
  }

  App.logout = function () {
    App.user = null;
    showAdminBtn(false);
    location.href = '/auth/logout';
  };

  // Check on startup
  setTimeout(checkAuth, 200);
})();