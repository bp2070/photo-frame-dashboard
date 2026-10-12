/**
 * Calendar Feed — fetches real events from the Cloudflare Worker and merges
 * them into the dashboard data model.
 *
 * The module replaces `DATA.events` (the mock data) with real events from
 * Google Calendar, while preserving all other mock data (people, chores,
 * shopping, weather). If the feed is unavailable, it falls back to the mock
 * events so the dashboard always works.
 *
 * This file MUST be imported after `data.js` and `app.js` in main.js.
 */
(function () {
  'use strict';
  const D = window.DATA;
  if (!D) return; // safety: data.js must be loaded first

  // Preserve mock events as the fallback
  const MOCK_EVENTS = D.events.slice();

  // Person ID → name mapping, used to match Google Calendar Labels (Mom, Dad, Anya, Nora)
  // to dashboard person IDs (mom, dad, anya, nora). Built from D.people.
  function buildPersonMap() {
    const map = {};
    (D.people || []).forEach(function (p) {
      // Map by name (case-insensitive) and by id
      map[p.name.toLowerCase()] = p.id;
      map[p.id] = p.id;
    });
    // Also add "family" / "everyone"
    map['family'] = 'family';
    map['everyone'] = 'family';
    return map;
  }

  /**
   * Fetch events from the Worker API and merge into DATA.events.
   * Returns true if successful, false otherwise.
   */
  async function fetchAndMerge() {
    try {
      const url = '/api/calendar/events?days=90';
      const controller = new AbortController();
      const timeout = setTimeout(function () { controller.abort(); }, 10000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        console.warn('Calendar feed: HTTP ' + res.status);
        return false;
      }

      const feedEvents = await res.json();
      if (!Array.isArray(feedEvents) || feedEvents.length === 0) {
        console.warn('Calendar feed: empty response');
        return false;
      }

      console.log('Calendar feed: loaded', feedEvents.length, 'events');

      const personMap = buildPersonMap();

      // Transform to dashboard event format
      D.events = feedEvents.map(function (e) {
        const start = new Date(e.start);
        const end = new Date(e.end);

        // Map people from Google Calendar Labels
        let people;
        if (e.people && e.people.length > 0) {
          // Already mapped by the Worker
          people = e.people;
        } else if (e.categories && e.categories.length > 0) {
          // Map label names → person IDs
          people = [];
          e.categories.forEach(function (label) {
            const id = personMap[label.toLowerCase()];
            if (id && id !== 'family') people.push(id);
          });
          if (people.length === 0) people = D.ALL.slice();
        } else {
          // No labels → assume everyone
          people = D.ALL.slice();
        }

        // Deduplicate people
        const seen = {};
        people = people.filter(function (p) {
          const ok = !seen[p];
          seen[p] = true;
          return ok;
        });

        return {
          id: 'cal_' + e.id.replace(/[^a-zA-Z0-9_-]/g, '_'),
          start: start,
          end: end,
          title: e.title,
          people: people.length > 0 ? people : D.ALL.slice(),
          allDay: !!e.allDay,
          loc: e.location || undefined,
          notes: e.description ? e.description.replace(/<[^>]+>/g, '').trim() : undefined,
          travel: undefined, // Google Calendar doesn't have travel time
          _feed: true, // mark as feed event for potential debugging
        };
      });

      // Sort by start time
      D.events.sort(function (a, b) { return a.start.getTime() - b.start.getTime(); });

      // Notify the app
      if (window.App && window.App.emit) window.App.emit('data');

      return true;
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn('Calendar feed: timeout');
      } else {
        console.warn('Calendar feed: ' + (err.message || 'unknown error'));
      }
      return false;
    }
  }

  // ---- Attempt to load on startup ----
  // Delay slightly to let the app initialize
  const INIT_DELAY = setTimeout ? 1500 : 0;

  setTimeout(function () {
    // Run fetch in the background; don't block the UI
    fetchAndMerge().then(function (ok) {
      if (!ok && D.events === MOCK_EVENTS) {
        // Feed failed and we haven't replaced events yet — already on mock data, that's fine
      } else if (!ok) {
        // Feed worked before but now failed — keep current data
        console.warn('Calendar feed refresh failed, using existing data');
      }
    });

    // Also refresh every 15 minutes while the app is open
    setInterval(function () {
      fetchAndMerge();
    }, 15 * 60 * 1000);
  }, INIT_DELAY);

  // Expose the fetcher so it can be called manually (e.g. from the control panel)
  D.refreshCalendar = fetchAndMerge;
})();