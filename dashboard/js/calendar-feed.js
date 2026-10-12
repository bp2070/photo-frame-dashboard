/**
 * Calendar Feed — fetches real events from the Cloudflare Worker and merges
 * them into the dashboard data model.
 *
 * The calendar starts blank. If a cached feed response exists in localStorage
 * it loads instantly; otherwise events appear after the Worker responds.
 * Fresh events are fetched in the background and the cache is updated.
 *
 * This file MUST be imported after `data.js` and `app.js` in main.js.
 */
(function () {
  'use strict';
  var D = window.DATA;
  if (!D) return;

  // Start blank — no fake data. Real events come from cache or feed.
  D.events = [];
  var CACHE_KEY = 'hq-cal-feed';

  // Person ID -> name mapping, built from D.people
  function buildPersonMap() {
    var map = {};
    (D.people || []).forEach(function (p) {
      map[p.name.toLowerCase()] = p.id;
      map[p.id] = p.id;
    });
    map['family'] = 'family';
    map['everyone'] = 'family';
    return map;
  }

  // ---- localStorage cache ------------------------------------------------

  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return false;
      var data = JSON.parse(raw);
      if (!Array.isArray(data) || data.length === 0) return false;
      D.events = data.map(function (e) {
        return {
          id: e.id,
          start: new Date(e.s),
          end: new Date(e.e),
          title: e.t,
          people: e.p || D.ALL.slice(),
          allDay: e.a || false,
          loc: e.l || undefined,
          notes: e.n || undefined,
          travel: undefined,
          _feed: true,
        };
      });
      D.events.sort(function (a, b) { return a.start.getTime() - b.start.getTime(); });
      return true;
    } catch (e) {
      return false;
    }
  }

  function saveCache(feedEvents) {
    try {
      var data = feedEvents.map(function (e) {
        return { id: e.id, s: e.start, e: e.end, t: e.title, p: e.people, a: e.allDay, l: e.location, n: e.description };
      });
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch (e) { /* storage may be full */ }
  }

  // ---- Transform feed events -> dashboard format -------------------------

  function applyFeed(feedEvents) {
    var personMap = buildPersonMap();
    D.events = feedEvents.map(function (e) {
      var start = new Date(e.start);
      var end = new Date(e.end);
      var people;
      if (e.people && e.people.length > 0) {
        people = e.people;
      } else if (e.categories && e.categories.length > 0) {
        people = [];
        e.categories.forEach(function (label) {
          var id = personMap[label.toLowerCase()];
          if (id && id !== 'family') people.push(id);
        });
        if (people.length === 0) people = D.ALL.slice();
      } else {
        people = D.ALL.slice();
      }
      var seen = {};
      people = people.filter(function (p) { var ok = !seen[p]; seen[p] = true; return ok; });
      return {
        id: 'cal_' + e.id.replace(/[^a-zA-Z0-9_-]/g, '_'),
        start: start,
        end: end,
        title: e.title,
        people: people.length > 0 ? people : D.ALL.slice(),
        allDay: !!e.allDay,
        loc: e.location || undefined,
        notes: e.description ? e.description.replace(/<[^>]+>/g, '').trim() : undefined,
        travel: undefined,
        _feed: true,
      };
    });
    D.events.sort(function (a, b) { return a.start.getTime() - b.start.getTime(); });
    saveCache(feedEvents);
  }

  // ---- Fetch from Worker -------------------------------------------------

  async function fetchAndMerge() {
    try {
      var url = '/api/calendar/events?days=90';
      var controller = new AbortController();
      var timeout = setTimeout(function () { controller.abort(); }, 10000);
      var res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) { console.warn('Calendar feed: HTTP ' + res.status); return false; }
      var feedEvents = await res.json();
      if (!Array.isArray(feedEvents) || feedEvents.length === 0) {
        console.warn('Calendar feed: empty response');
        return false;
      }
      console.log('Calendar feed: loaded ' + feedEvents.length + ' events');
      applyFeed(feedEvents);
      if (window.App && window.App.emit) window.App.emit('data');
      return true;
    } catch (err) {
      if (err.name === 'AbortError') console.warn('Calendar feed: timeout');
      else console.warn('Calendar feed: ' + (err.message || 'unknown error'));
      return false;
    }
  }

  // ---- Startup -----------------------------------------------------------
  // Phase 1: load cached data immediately (no flash on reload)
  var cacheLoaded = loadCache();
  if (cacheLoaded) {
    console.log('Calendar feed: loaded from cache (' + D.events.length + ' events)');
    if (window.App && window.App.emit) window.App.emit('data');
  }

  // Phase 2: fetch fresh data after a brief delay, then keep refreshing
  setTimeout(function () {
    fetchAndMerge();
    setInterval(fetchAndMerge, 15 * 60 * 1000);
  }, setTimeout ? 500 : 0);

  // Expose manual refresh
  D.refreshCalendar = fetchAndMerge;
})();