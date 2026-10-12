/**
 * Home HQ — Cloudflare Worker
 *
 * Handles Google OAuth, session management, Calendar ICS proxy, and admin API.
 *
 * Set secrets with: npm run secret:*  (see package.json for available targets)
 * Required: ADMIN_EMAIL, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET,
 *           GOOGLE_CAL_ICS_URL
 * Optional: AUTH_SECRET, GOOGLE_CAL_PEOPLE
 *
 * OAuth setup:
 *   1. https://console.cloud.google.com → APIs & Services → Credentials
 *   2. Create OAuth 2.0 Client ID → Web application
 *   3. Add redirect URI: https://your-domain.com/auth/callback
 *   4. Copy Client ID & Client Secret → set as secrets
 */

import { parseICS } from './ics.js';

// ------------------------------------------------------------ hex helpers (no external deps)
function hex(buf) {
  var s = '';
  for (var i = 0; i < buf.length; i++) {
    var b = buf[i];
    s += '0123456789abcdef'[b >> 4] + '0123456789abcdef'[b & 15];
  }
  return s;
}

function unhex(s) {
  var buf = new Uint8Array(s.length / 2);
  for (var i = 0; i < buf.length; i++)
    buf[i] = parseInt(s.substr(i * 2, 2), 16);
  return buf;
}

// ------------------------------------------------------------ base64 (no btoa/atob dependency)
function b64encode(str) {
  // Simple base64 for ASCII strings only
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var bytes = new TextEncoder().encode(str);
  var result = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i], b1 = bytes[i + 1] || 0, b2 = bytes[i + 2] || 0;
    result += chars[b0 >> 2];
    result += chars[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 >= bytes.length) { result += '=='; break; }
    result += chars[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 >= bytes.length) { result += '='; break; }
    result += chars[b2 & 63];
  }
  return result;
}

function b64decode(str) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var map = {};
  for (var i = 0; i < 64; i++) map[chars[i]] = i;
  str = str.replace(/=+$/, '');
  var bytes = [];
  for (var i = 0; i < str.length; i += 4) {
    var c0 = map[str[i]] || 0, c1 = map[str[i + 1]] || 0;
    var c2 = map[str[i + 2]] || 0, c3 = map[str[i + 3]] || 0;
    bytes.push((c0 << 2) | (c1 >> 4));
    if (str[i + 2] && str[i + 2] !== '=') bytes.push(((c1 & 15) << 4) | (c2 >> 2));
    if (str[i + 3] && str[i + 3] !== '=') bytes.push(((c2 & 3) << 6) | c3);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function b64url(str) {
  // JWT-style base64url → standard base64
  var s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  return s;
}

function toHex(str) {
  return hex(new TextEncoder().encode(str));
}

function decodeUserFromToken(idToken) {
  try {
    var parts = idToken.split('.');
    if (parts.length < 2) return null;
    var json = b64decode(b64url(parts[1]));
    return JSON.parse(json);
  } catch (e) { return null; }
}

// ------------------------------------------------------------ HMAC
async function hmacSign(data, secret) {
  var key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  var sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return hex(new Uint8Array(sig));
}

// ------------------------------------------------------------ session cookie
async function makeCookie(email, name, isAdmin, secret) {
  var expires = Math.floor(Date.now() / 1000) + 30 * 86400;
  var payload = email + '|' + name + '|' + (isAdmin ? '1' : '0') + '|' + expires;
  var sig = await hmacSign(payload, secret);
  var val = toHex(payload) + '.' + sig;
  return 'session=' + val + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + (30 * 86400);
}

async function verifyCookie(cookieHeader, secret) {
  if (!cookieHeader) return null;
  var m = cookieHeader.match(/session=([a-f0-9]+)\.([a-f0-9]+)/);
  if (!m) return null;
  try {
    var payloadHex = m[1], sig = m[2];
    var raw = new TextDecoder().decode(unhex(payloadHex));
    var parts = raw.split('|');
    if (parts.length < 4) return null;
    var email = parts[0], name = parts[1];
    var isAdmin = parts[2] === '1';
    var expires = parseInt(parts[3], 10);
    if (Math.floor(Date.now() / 1000) > expires) return null;
    var expected = await hmacSign(parts[0] + '|' + parts[1] + '|' + parts[2] + '|' + parts[3], secret);
    if (sig !== expected) return null;
    return { email: email, name: name, isAdmin: isAdmin };
  } catch (e) { return null; }
}

// ------------------------------------------------------------ OAuth config
function oauthConfig(env, requestUrl) {
  var u = new URL(requestUrl);
  var redirectUri = (env.OAUTH_REDIRECT_URI || '').trim();
  if (!redirectUri) {
    var port = (u.port && u.port !== 443 && u.port !== 80) ? ':' + u.port : '';
    redirectUri = u.protocol + '//' + u.host + port + '/auth/callback';
  }
  return {
    clientId: env.GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    redirectUri: redirectUri,
    adminEmail: (env.ADMIN_EMAIL || '').toLowerCase(),
    authSecret: env.AUTH_SECRET || env.GOOGLE_OAUTH_CLIENT_SECRET || 'fallback-secret-change-me',
  };
}

// ------------------------------------------------------------ response helpers
function html(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location: location } });
}

// ------------------------------------------------------------ login page
var LOGIN_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=1280">' +
  '<title>Home HQ</title><style>' +
  'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F2EEE6;font-family:system-ui,sans-serif}' +
  '.card{text-align:center;padding:60px 80px;border-radius:32px;background:#fff;box-shadow:0 8px 40px rgba(0,0,0,.08)}' +
  'h1{font-size:56px;margin:0 0 8px}' +
  'p{font-size:22px;color:#6B635B;margin:0 0 40px}' +
  '.btn{display:inline-flex;align-items:center;gap:14px;padding:0 28px;height:62px;border:0;border-radius:999px;background:#111;color:#fff;font-size:20px;font-weight:700;cursor:pointer;text-decoration:none}' +
  '@media(prefers-color-scheme:dark){body{background:#1A1A1E}.card{background:#24242A;color:#E8E6E3}p{color:#888}}' +
  '</style></head><body><div class="card"><h1>Home HQ</h1><p>Sign in with your Google account</p>' +
  '<a class="btn" href="/auth/login">Sign in with Google</a></div></body></html>';

// ------------------------------------------------------------ ICS proxy
async function fetchCalendarEvents(env, ctx, days) {
  var icsUrl = env.GOOGLE_CAL_ICS_URL || env.CALENDAR_ICS_URL;
  if (!icsUrl) return json({ error: 'Calendar not configured' }, 500);

  var personMap = {};
  try { if (env.GOOGLE_CAL_PEOPLE) personMap = JSON.parse(env.GOOGLE_CAL_PEOPLE); } catch (e) {}

  var now = new Date();
  now.setHours(0, 0, 0, 0);
  var rangeStart = new Date(now.getTime() - 30 * 86400000);
  var rangeEnd = new Date(now.getTime() + days * 86400000);

  var cache = null;
  try { cache = caches.default; } catch (e) {}

  if (cache) {
    try {
      var cached = await cache.match(new Request('https://w/c/' + days));
      if (cached && cached.ok) {
        var h = new Headers(cached.headers);
        h.set('x-cache', 'HIT');
        return new Response(cached.body, { headers: h });
      }
    } catch (e) {}
  }

  var resp = await fetch(icsUrl);
  if (!resp.ok) return json({ error: 'ICS feed error' }, 502);

  var icsText = await resp.text();
  var events = parseICS(icsText, rangeStart, rangeEnd, personMap);
  events.sort(function (a, b) {
    var c = a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
    if (c !== 0) return c;
    return (a.title || '') < (b.title || '') ? -1 : 1;
  });

  var body = JSON.stringify(events);
  var response = new Response(body, {
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
      'x-cache': 'MISS',
    },
  });

  if (cache && ctx) {
    ctx.waitUntil(
      cache.put(
        new Request('https://w/c/' + days, { method: 'GET' }),
        new Response(body, { headers: { 'cache-control': 'public, max-age=300' } })
      )
    );
  }
  return response;
}

// ------------------------------------------------------------ router
export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var path = url.pathname;
    var oauth = oauthConfig(env, request.url);

    // ---- OAuth initiate ----
    if (path === '/auth/login') {
      var googleUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
        'client_id=' + encodeURIComponent(oauth.clientId) +
        '&redirect_uri=' + encodeURIComponent(oauth.redirectUri) +
        '&response_type=code' +
        '&scope=openid%20email%20profile' +
        '&access_type=offline&prompt=consent';
      return redirect(googleUrl);
    }

    // ---- OAuth callback ----
    if (path === '/auth/callback') {
      var code = url.searchParams.get('code');
      if (!code) return html('Missing auth code', 400);

      var tokenBody = 'code=' + encodeURIComponent(code) +
        '&client_id=' + encodeURIComponent(oauth.clientId) +
        '&client_secret=' + encodeURIComponent(oauth.clientSecret) +
        '&redirect_uri=' + encodeURIComponent(oauth.redirectUri) +
        '&grant_type=authorization_code';

      var tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: tokenBody,
      });

      if (!tokenResp.ok) {
        console.warn('OAuth token exchange failed');
        return html('Authentication failed', 401);
      }

      var tokens = await tokenResp.json();
      var email = '', name = '';

      // Decode id_token to get user info
      if (tokens.id_token) {
        var info = decodeUserFromToken(tokens.id_token);
        if (info) {
          email = (info.email || '').toLowerCase();
          name = info.name || info.given_name || info.email || email;
        }
      }

      // Fallback: call UserInfo API
      if (!email && tokens.access_token) {
        var userResp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: 'Bearer ' + tokens.access_token },
        });
        if (userResp.ok) {
          var info = await userResp.json();
          email = (info.email || '').toLowerCase();
          name = info.name || info.given_name || info.email || email;
        }
      }

      if (!email) return html('Could not verify your identity', 401);

      var isAdmin = email === oauth.adminEmail;
      var cookie = await makeCookie(email, name, isAdmin, oauth.authSecret);
      var dest = url.searchParams.get('state') || '/';
      var resp = redirect(dest);
      resp.headers.append('set-cookie', cookie);
      return resp;
    }

    // ---- Logout ----
    if (path === '/auth/logout') {
      var resp = html('Logged out. <a href="/">Sign back in</a>');
      resp.headers.append('set-cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return resp;
    }

    // ---- Current user ----
    if (path === '/auth/me') {
      var user = await verifyCookie(request.headers.get('cookie') || '', oauth.authSecret);
      if (!user) return json({ authenticated: false }, 401);
      return json({
        authenticated: true,
        email: user.email,
        name: user.name,
        isAdmin: user.isAdmin,
      });
    }

    // ---- Calendar events ----
    if (path === '/api/calendar/events' && request.method === 'GET') {
      var days = Math.min(365, Math.max(7, parseInt(url.searchParams.get('days') || '60', 10)));
      try { return await fetchCalendarEvents(env, ctx, days); }
      catch (e) { return json({ error: e.message }, 500); }
    }

    // ---- Health ----
    if (path === '/api/health') {
      return json({
        status: 'ok',
        calendarConfigured: !!(env.GOOGLE_CAL_ICS_URL || env.CALENDAR_ICS_URL),
        authConfigured: !!oauth.clientId,
        adminConfigured: !!oauth.adminEmail,
      });
    }

    // ---- Auth gate ----
    var user = await verifyCookie(request.headers.get('cookie') || '', oauth.authSecret);
    if (!user) {
      if (path.startsWith('/api/')) return json({ error: 'Unauthorized' }, 401);
      return html(LOGIN_PAGE);
    }

    // ---- Admin config (stored client-side via localStorage) ----
    if (path === '/api/admin/check' && request.method === 'GET') {
      if (!user.isAdmin) return json({ error: 'Forbidden' }, 403);
      return json({ admin: true, email: user.email });
    }

    // ---- Serve dashboard static assets ----
    try { return await env.ASSETS.fetch(request); }
    catch (e) { return html('Not found', 404); }
  },
};