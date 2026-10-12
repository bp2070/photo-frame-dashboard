/**
 * ICS / iCal parser for Google Calendar secret feed.
 *
 * Handles:
 *  - VEVENT parsing (DTSTART, DTEND, SUMMARY, DESCRIPTION, LOCATION, UID, CATEGORIES)
 *  - UTC dates, local dates with TZID, all-day ( VALUE=DATE )
 *  - RRULE expansion (FREQ=WEEKLY with BYDAY, INTERVAL, COUNT/UNTIL)
 *  - EXDATE (recurrence exception dates)
 *
 * No external dependencies — works in Cloudflare Workers.
 *
 * @module ics
 */

// ------------------------------------------------------------ helpers
/**
 * Parse an iCal content line, handling folded continuations (leading space).
 * Returns array of strings, one per property line.
 */
function unfold(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

/**
 * Parse a property line into { name, params, value }
 */
function parsePropLine(line) {
  if (!line || line[0] === ' ') return null;
  const semi = line.indexOf(';');
  const colon = line.indexOf(':');
  let name, paramsStr, value;

  if (semi > -1 && semi < colon) {
    name = line.substring(0, semi);
    paramsStr = line.substring(semi + 1, colon);
    value = line.substring(colon + 1);
  } else if (colon > -1) {
    name = line.substring(0, colon);
    paramsStr = '';
    value = line.substring(colon + 1);
  } else {
    return null;
  }

  const params = {};
  if (paramsStr) {
    // Split by semicolon, but be careful with quoted values like TZID=America/New_York
    let i = 0, len = paramsStr.length;
    while (i < len) {
      const eq = paramsStr.indexOf('=', i);
      if (eq < 0) break;
      const k = paramsStr.substring(i, eq);
      let vStart = eq + 1;
      // Check for quoted value
      if (paramsStr[vStart] === '"') {
        const end = paramsStr.indexOf('"', vStart + 1);
        params[k] = paramsStr.substring(vStart + 1, end);
        i = end + 2; // skip past ";"
      } else {
        const nextSemi = paramsStr.indexOf(';', vStart);
        if (nextSemi < 0) {
          params[k] = paramsStr.substring(vStart);
          i = len;
        } else {
          params[k] = paramsStr.substring(vStart, nextSemi);
          i = nextSemi + 1;
        }
      }
    }
  }

  return { name: name.toUpperCase(), params, value };
}

/**
 * Parse an iCal date-time string.
 *   "20240315T140000Z"       → UTC
 *   "20240315T140000"         → floating (treated as UTC)
 *   "20240315"                → all-day date (no time)
 *   "DTSTART;VALUE=DATE:20240315" → from the value param, treated as all-day
 */
function parseDateTime(val, params) {
  // Check if it's an all-day date (VALUE=DATE)
  const isDate = (params && params.VALUE === 'DATE') || /^\d{8}$/.test(val);

  if (isDate) {
    // All-day: YYYYMMDD
    const year = parseInt(val.substring(0, 4), 10);
    const month = parseInt(val.substring(4, 6), 10) - 1;
    const day = parseInt(val.substring(6, 8), 10);
    return { date: new Date(Date.UTC(year, month, day)), allDay: true };
  }

  let year, month, day, hour, min, sec;
  // Remove trailing Z for parsing, track if UTC
  const utc = val.endsWith('Z');
  const clean = utc ? val.slice(0, -1) : val;

  if (clean.length >= 15) {
    year = parseInt(clean.substring(0, 4), 10);
    month = parseInt(clean.substring(4, 6), 10) - 1;
    day = parseInt(clean.substring(6, 8), 10);
    hour = parseInt(clean.substring(9, 11), 10);
    min = parseInt(clean.substring(11, 13), 10);
    sec = parseInt(clean.substring(13, 15), 10) || 0;
  } else {
    return null;
  }

  let date;
  if (utc) {
    date = new Date(Date.UTC(year, month, day, hour, min, sec));
  } else {
    // Floating time — treat as UTC by default
    date = new Date(Date.UTC(year, month, day, hour, min, sec));
  }
  return { date, allDay: false };
}

// ------------------------------------------------------------ RRULE expansion

const DAY_MAP = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };
const DAY_NAMES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Expand a single recurring event into all its occurrences within [rangeStart, rangeEnd).
 * Returns an array of { start, end } objects.
 */
function expandRecurrence(vevent, rangeStart, rangeEnd) {
  const rruleStr = vevent.RRULE;
  if (!rruleStr) return [];

  // Parse RRULE parameters
  const params = {};
  rruleStr.split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq > 0) {
      params[part.substring(0, eq)] = part.substring(eq + 1);
    }
  });

  if (params.FREQ !== 'WEEKLY') return []; // Only handle weekly for now

  const byDay = params.BYDAY ? params.BYDAY.split(',') : null;
  const interval = parseInt(params.INTERVAL, 10) || 1;
  const count = params.COUNT ? parseInt(params.COUNT, 10) : null;
  const until = params.UNTIL ? parseUntil(params.UNTIL) : null;

  const dtstart = vevent._dtstart;
  const dtend = vevent._dtend;
  if (!dtstart) return [];

  const duration = dtend ? (dtend.getTime() - dtstart.getTime()) : 3600000; // default 1h
  const isAllDay = vevent._allDay;

  const occurrences = [];

  // If we have BYDAY, generate weekly on specific days
  if (byDay && byDay.length > 0) {
    // Start from the week containing dtstart
    const startDow = dtstart.getDay(); // 0=Sun, 1=Mon...
    let current = new Date(dtstart);

    // Move to the beginning of the week (Monday)
    const weekStart = new Date(current);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));

    let weekNum = 0;
    let generated = 0;

    // Go back up to 52 weeks before rangeStart to catch events that start before range
    const searchStart = new Date(rangeStart);
    searchStart.setDate(searchStart.getDate() - 400); // go back far enough

    while (current.getTime() < rangeEnd.getTime() && (count === null || generated < count)) {
      const dow = current.getDay(); // 0=Sun
      const dowName = DAY_NAMES[dow];

      if (byDay.includes(dowName)) {
        generated++;
        if (current.getTime() >= rangeStart.getTime() && current.getTime() < rangeEnd.getTime()) {
          const evStart = new Date(current);
          let evEnd;
          if (isAllDay) {
            evEnd = new Date(evStart);
            evEnd.setDate(evEnd.getDate() + (dtend ? Math.round((dtend - dtstart) / 86400000) : 1));
          } else {
            evEnd = new Date(evStart.getTime() + duration);
          }
          occurrences.push({ start: evStart, end: evEnd, allDay: isAllDay });
        }
        if (count !== null && generated >= count) break;
      }

      // Check UNTIL
      if (until && current.getTime() >= until.getTime() - duration) break;

      // Advance by 1 day
      current.setDate(current.getDate() + 1);

      // If we've passed interval weeks from the start, wrap
      // Actually, for weekly with BYDAY, we just iterate day by day and the
      // interval controls which weeks we include. But for simplicity, we
      // iterate all days and the BYDAY filter handles it. The INTERVAL means
      // "every N weeks", so we skip weeks accordingly.
      const weekDiff = Math.floor((current.getTime() - dtstart.getTime()) / (7 * 86400000));
      if (weekDiff % interval !== 0) {
        // Skip to Monday of the next valid week
        const daysToSkip = (interval - (weekDiff % interval)) * 7;
        current.setDate(current.getDate() + daysToSkip);
      }
    }
  } else {
    // Simple weekly recurrence (no BYDAY) — same day each week
    let current = new Date(dtstart);
    let generated = 0;

    while (current.getTime() < rangeEnd.getTime() && (count === null || generated < count)) {
      generated++;
      if (current.getTime() >= rangeStart.getTime()) {
        const evStart = new Date(current);
        let evEnd;
        if (isAllDay) {
          evEnd = new Date(evStart);
          evEnd.setDate(evEnd.getDate() + (dtend ? Math.round((dtend - dtstart) / 86400000) : 1));
        } else {
          evEnd = new Date(evStart.getTime() + duration);
        }
        occurrences.push({ start: evStart, end: evEnd, allDay: isAllDay });
      }
      if (count !== null && generated >= count) break;

      // Advance by interval weeks
      current.setDate(current.getDate() + 7 * interval);

      // Check UNTIL
      if (until && current.getTime() > until.getTime()) break;
    }
  }

  return occurrences;
}

function parseUntil(val) {
  // UNTIL can be in UTC (e.g., "20240315T235959Z") or as a date
  const parsed = parseDateTime(val, {});
  return parsed ? parsed.date : null;
}

// ------------------------------------------------------------ main parse function

/**
 * Parse an ICS text into an array of events.
 *
 * @param {string} icsText           Raw ICS content
 * @param {Date}    rangeStart       Include events starting on or after this
 * @param {Date}    rangeEnd         Include events starting before this
 * @param {object}  personMap        Map of { categoryName: personId } for assigning people
 * @returns {Array<object>} events in the dashboard format
 */
export function parseICS(icsText, rangeStart, rangeEnd, personMap) {
  personMap = personMap || {};
  const lines = unfold(icsText);

  // Build a tree: component nesting
  const root = { type: 'VCALENDAR', props: {}, children: [] };
  const stack = [root];
  let current = root;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^BEGIN:/i.test(line)) {
      const type = line.substring(6).trim().toUpperCase();
      const comp = { type, props: {}, children: [] };
      current.children.push(comp);
      stack.push(comp);
      current = comp;
    } else if (/^END:/i.test(line)) {
      stack.pop();
      current = stack[stack.length - 1];
    } else {
      const prop = parsePropLine(line);
      if (prop) {
        current.props[prop.name] = current.props[prop.name] || [];
        current.props[prop.name].push(prop);
      }
    }
  }

  // Extract VEVENT components
  const vevents = [];
  function walk(comp) {
    if (comp.type === 'VEVENT') vevents.push(comp.props);
    comp.children.forEach(walk);
  }
  root.children.forEach(walk);

  // Build person name → ID mapping from personMap and also from names if available
  const nameToId = {};
  for (const [cat, id] of Object.entries(personMap)) {
    nameToId[cat.toLowerCase()] = id;
  }

  const result = [];

  for (const props of vevents) {
    // Get dtstart
    const dtstartProp = props.DTSTART ? props.DTSTART[0] : null;
    const dtendProp = props.DTEND ? props.DTEND[0] : null;
    if (!dtstartProp) continue;

    const startInfo = parseDateTime(dtstartProp.value, dtstartProp.params);
    if (!startInfo) continue;

    let endInfo = dtendProp ? parseDateTime(dtendProp.value, dtendProp.params) : null;

    if (!endInfo) {
      // If no DTEND, assume same as DTSTART (1-hour event for timed, 1-day for all-day)
      if (startInfo.allDay) {
        const end = new Date(startInfo.date);
        end.setDate(end.getDate() + 1);
        endInfo = { date: end, allDay: true };
      } else {
        endInfo = { date: new Date(startInfo.date.getTime() + 3600000), allDay: false };
      }
    }

    // Get properties
    const summaryProp = props.SUMMARY ? props.SUMMARY[0] : null;
    const descProp = props.DESCRIPTION ? props.DESCRIPTION[0] : null;
    const locProp = props.LOCATION ? props.LOCATION[0] : null;
    const uidProp = props.UID ? props.UID[0] : null;
    const categoriesProps = props.CATEGORIES || [];

    const title = summaryProp ? decodeValue(summaryProp.value) : '(no title)';
    const description = descProp ? decodeValue(descProp.value).replace(/\\n/g, '\n') : '';
    const location = locProp ? decodeValue(locProp.value) : '';
    const uid = uidProp ? uidProp.value : ('gen_' + Math.random().toString(36).substring(2));
    const categories = categoriesProps.map(p => decodeValue(p.value));

    // Map categories to person IDs
    let people = [];
    if (categories.length > 0) {
      for (const cat of categories) {
        const id = nameToId[cat.toLowerCase()] || nameToId[cat];
        if (id) people.push(id);
      }
    }

    // Parse EXDATE (recurrence exceptions)
    const exdates = new Set();
    const exdateProps = props.EXDATE || [];
    for (const exd of exdateProps) {
      const exdValues = exd.value.split(',');
      for (const ev of exdValues) {
        const info = parseDateTime(ev.trim(), exd.params);
        if (info) {
          exdates.add(info.date.toISOString().substring(0, 10));
        }
      }
    }

    // Build base event
    const baseEvent = {
      uid,
      title,
      description,
      location,
      start: startInfo.date,
      end: endInfo.date,
      allDay: startInfo.allDay,
      categories,
      people,
      _veventProps: props, // keep for RRULE expansion
      _allDay: startInfo.allDay,
      _dtstart: startInfo.date,
      _dtend: endInfo.date,
      _exdates: exdates,
    };

    // Check if it has RRULE
    const hasRRULE = props.RRULE && props.RRULE.length > 0;

    if (hasRRULE && baseEvent._dtstart) {
      // Expand recurring events
      const expanded = expandRecurrence(baseEvent, rangeStart, rangeEnd);
      if (expanded.length > 0) {
        for (const occ of expanded) {
          // Skip if this occurrence date is in exdates
          const dateKey = occ.start.toISOString().substring(0, 10);
          if (baseEvent._exdates && baseEvent._exdates.has(dateKey)) continue;

          result.push(formatEvent({
            ...baseEvent,
            start: occ.start,
            end: occ.end,
            allDay: occ.allDay,
          }));
        }
      } else {
        // No expanded occurrences - include the original if in range
        if (baseEvent.start >= rangeStart && baseEvent.start < rangeEnd) {
          result.push(formatEvent(baseEvent));
        }
      }
    } else {
      // Non-recurring event
      if (baseEvent.start >= rangeStart && baseEvent.start < rangeEnd) {
        result.push(formatEvent(baseEvent));
      }
    }
  }

  return result;
}

function formatEvent(e) {
  return {
    id: e.uid,
    title: e.title,
    description: e.description || undefined,
    location: e.location || undefined,
    start: e.start.toISOString(),
    end: e.end.toISOString(),
    allDay: e.allDay,
    categories: e.categories && e.categories.length > 0 ? e.categories : undefined,
    people: e.people && e.people.length > 0 ? e.people : undefined,
  };
}

/**
 * Decode iCal escaped chars: \\n → \n, \\N → \n, \\; → ;, \\, → ,, \\\\ → \
 */
function decodeValue(val) {
  if (!val) return '';
  return val
    .replace(/\\n/gi, '\n')
    .replace(/\\;/g, ';')
    .replace(/\\,/g, ',')
    .replace(/\\\\/g, '\\');
}