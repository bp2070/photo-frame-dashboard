/**
 * Home HQ — Calendar Feed Worker
 *
 * Fetches the Google Calendar secret ICS feed, parses it into the dashboard's
 * event JSON format, and caches responses for 5 minutes.
 *
 * Environment (secrets):
 *   GOOGLE_CAL_ICS_URL — The "Secret address in iCal format" URL from Google Calendar
 *                        Settings → [Calendar name] → Integrate Calendar
 *   GOOGLE_CAL_PEOPLE — Optional JSON mapping of Google Calendar Label names to
 *                        dashboard person IDs. Example:
 *                        '{"Mom":"mom","Dad":"dad","Anya":"anya","Nora":"nora"}'
 *
 * Endpoints:
 *   GET /api/calendar/events?days=60
 *     Returns events. Optional query param: days (default 60, how many days from today to include)
 *   GET /api/health
 *     Returns worker status
 */

import { parseICS } from './ics.js';

// ------------------------------------------------------------ helpers
const DAY_MS = 86400000;

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  });
}

function error(msg, status = 400) {
  return json({ error: msg }, status);
}

/**
 * Compare two ISO date strings for sorting.
 * ISO 8601 dates sort lexicographically correctly.
 */
function cmpIso(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ------------------------------------------------------------ main fetch + parse
async function fetchCalendarEvents(env, ctx, days) {
  const icsUrl = env.GOOGLE_CAL_ICS_URL || env.CALENDAR_ICS_URL;
  if (!icsUrl) {
    throw new Error('GOOGLE_CAL_ICS_URL not configured');
  }

  // Parse person mapping from env
  // Maps Google Calendar Label names → dashboard person IDs
  let personMap = {};
  try {
    const raw = env.GOOGLE_CAL_PEOPLE;
    if (raw) personMap = JSON.parse(raw);
  } catch (e) {
    console.warn('Failed to parse GOOGLE_CAL_PEOPLE, ignoring:', e.message);
  }

  // Calculate range
  const now = todayStart();
  const rangeStart = new Date(now.getTime() - 30 * DAY_MS);  // 30 days back (for recurring event expansion)
  const rangeEnd = new Date(now.getTime() + days * DAY_MS);

  // Build cache key from URL + days param
  const cacheKey = icsUrl + ';days=' + days;
  let cache = null;
  try { cache = caches.default; } catch (e) { /* no cache available */ }

  // Try cache hit
  if (cache) {
    try {
      const cached = await cache.match(new Request('https://worker/cache/' + encodeURIComponent(cacheKey)));
      if (cached && cached.ok) {
        // Return cached with a HIT header
        const headers = new Headers(cached.headers);
        headers.set('x-cache', 'HIT');
        return new Response(cached.body, { status: cached.status, headers });
      }
    } catch (e) {
      // Cache miss or error, continue to fetch
    }
  }

  // Fetch the ICS feed
  const resp = await fetch(icsUrl);
  if (!resp.ok) {
    throw new Error('ICS feed returned ' + resp.status + ' ' + resp.statusText);
  }

  const icsText = await resp.text();
  const events = parseICS(icsText, rangeStart, rangeEnd, personMap);

  // Sort by start time (ISO strings sort lexicographically)
  events.sort(function (a, b) {
    var c = cmpIso(a.start, b.start);
    if (c !== 0) return c;
    return cmpIso(a.title || '', b.title || '');
  });

  const body = JSON.stringify(events);
  const responseHeaders = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=300',
    'x-cache': 'MISS',
  };

  const response = new Response(body, { headers: responseHeaders });

  // Store in cache for 5 minutes (fire-and-forget)
  if (cache && ctx) {
    ctx.waitUntil(
      cache.put(
        new Request('https://worker/cache/' + encodeURIComponent(cacheKey), { method: 'GET' }),
        new Response(body, {
          headers: { 'cache-control': 'public, max-age=300' },
        })
      )
    );
  }

  return response;
}

// ------------------------------------------------------------ router
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-max-age': '86400',
        },
      });
    }

    // ---- Calendar events endpoint ----
    if (path === '/api/calendar/events' && request.method === 'GET') {
      const days = Math.min(365, Math.max(7, parseInt(url.searchParams.get('days') || '60', 10)));
      try {
        return await fetchCalendarEvents(env, ctx, days);
      } catch (e) {
        console.warn('Calendar feed error:', e.message);
        return error(e.message, 500);
      }
    }

    // ---- Health check ----
    if (path === '/api/health' && request.method === 'GET') {
      const configured = !!(env.GOOGLE_CAL_ICS_URL || env.CALENDAR_ICS_URL);
      return json({
        status: 'ok',
        calendarConfigured: configured,
        worker: 'home-hq-calendar-feed',
        version: '1.0.0',
      });
    }

    // ---- Serve static assets from the Pages build ----
    // The Worker is deployed alongside the static assets. For any non-API
    // request, delegate to the asset worker.
    try {
      return await env.ASSETS.fetch(request);
    } catch (e) {
      // If ASSETS binding isn't available (local dev), return a simple 404 page
      return new Response('Not found', { status: 404 });
    }
  },
};