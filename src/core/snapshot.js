/**
 * Core real-time snapshot logic.
 *
 * One read-only answer to "what do I need to analyze this symbol right now?":
 * the chart symbol's latest bar, day change and session stats, the watchlist
 * quotes (indices, macro, peers), an options summary from the open
 * options-chain page, the last N bars and the current values of the chart's
 * indicators. Nothing is switched, opened or clicked, so a snapshot can be
 * polled (e.g. once a minute) while the user keeps working on the chart.
 */
import { evaluate as _evaluate, KNOWN_PATHS } from '../connection.js';
import { getStudyValues as _getStudyValues } from './data.js';
import { get as _getWatchlist } from './watchlist.js';
import { getOptionsChain as _getOptionsChain } from './options.js';

const CHART_API = KNOWN_PATHS.chartApi;

export const SECTIONS = ['quote', 'watchlist', 'options', 'bars', 'studies'];
export const DEFAULT_BARS = 20;
export const DEFAULT_EXPIRATIONS = 3;
export const DEFAULT_INTERVAL_MS = 60000;
const MAX_BARS = 500;
const MAX_EXPIRATIONS = 12;
// Newest bars scanned for the session stats. The chart loads ~300 bars by
// default and grows as the user scrolls back.
const MAX_RECENT = 3000;

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getStudyValues: deps?.getStudyValues || _getStudyValues,
    getWatchlist: deps?.getWatchlist || _getWatchlist,
    getOptionsChain: deps?.getOptionsChain || _getOptionsChain,
  };
}

// Page-context JS: everything the snapshot needs from the chart page, in one read.
function readChartJs() {
  return `
    (function() {
      var chart = ${CHART_API};
      var out = { symbol: chart.symbol(), resolution: chart.resolution() };
      try {
        var ms = chart._chartWidget.model().mainSeries();
        var si = ms.symbolInfo() || {};
        var info = {
          description: si.description || null, exchange: si.exchange || null,
          currency: si.currency_code || null, pro_name: si.pro_name || null,
          timezone: si.timezone || null, regular_session: si.session || null
        };
        var subs = si.subsessions || [];
        for (var i = 0; i < subs.length; i++) {
          if (subs[i] && subs[i].id === 'regular' && subs[i].session) info.regular_session = subs[i].session;
        }
        out.info = info;
        var b = ms.bars();
        var end = b.lastIndex();
        var start = Math.max(b.firstIndex(), end - ${MAX_RECENT} + 1);
        var recent = [];
        for (var k = start; k <= end; k++) {
          var v = b.valueAt(k);
          if (v) recent.push([v[0], v[1], v[2], v[3], v[4], v[5] || 0]);
        }
        out.recent = recent;
        out.loaded_bars = b.size();
      } catch (e) { out.error = e.message; }
      try {
        out.watchlist_rows = document.querySelectorAll('[class*="layout__area--right"] [data-symbol-full]').length;
      } catch (e) { out.watchlist_rows = 0; }
      return out;
    })()
  `;
}

// ── Pure helpers ──

const round3 = (v) => Math.round(v * 1000) / 1000;
const bare = (symbol) => String(symbol ?? '').split(':').pop().toUpperCase();

/** "770.31 M" → 770310000, "258.46 K" → 258460; null for an empty or non-numeric cell. */
export function parseVolume(text) {
  const s = String(text ?? '').replace(/[\u00a0\u2009\u202f]/g, ' ').trim();
  if (!s) return null;
  const m = /^(-?[\d,]+(?:\.\d+)?)\s*([KMB])?$/i.exec(s);
  if (!m) return null;
  const scale = { K: 1e3, M: 1e6, B: 1e9 }[String(m[2]).toUpperCase()] || 1;
  const value = Number(m[1].replace(/,/g, '')) * scale;
  // Shares are whole numbers: "258.46 K" is 258460, not 258459.99999999997.
  const whole = Math.round(value);
  return Math.abs(value - whole) < 1e-6 * Math.max(1, Math.abs(value)) ? whole : value;
}

const SESSION_RE = /^(\d{1,2})(\d{2})\s*-\s*(\d{1,2})(\d{2})/;

/** Wall-clock fields of an instant in a time zone. */
function zonedParts(timeZone, epochMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(epochMs);
  const get = (type) => Number(parts.find(p => p.type === type).value);
  const y = get('year'), m = get('month'), d = get('day');
  return {
    y, m, d,
    weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(),
    h: get('hour') % 24, mi: get('minute'), s: get('second'),
  };
}

/** Milliseconds east of UTC that `timeZone` is at `epochMs`. */
function zoneOffsetMs(timeZone, epochMs) {
  const p = zonedParts(timeZone, epochMs);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - epochMs;
}

function zonedToEpoch(timeZone, y, m, d, h, mi) {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  // Second pass lands on the right side of a DST change.
  return wall - zoneOffsetMs(timeZone, wall - zoneOffsetMs(timeZone, wall));
}

/**
 * The most recent trading session that has started: { start, end } in epoch ms.
 * `session` is TradingView's "HHMM-HHMM" string in the symbol's time zone.
 * A round-the-clock session ("2000-2000") has no session to report → null.
 */
export function sessionWindow(session, timeZone, nowMs = Date.now()) {
  const m = SESSION_RE.exec(String(session ?? ''));
  if (!m || !timeZone) return null;
  const [startHour, startMinute, endHour, endMinute] = m.slice(1).map(Number);
  const from = startHour * 60 + startMinute;
  const to = endHour * 60 + endMinute;
  if (from === to) return null;
  // A negative span wraps past midnight (1700-1600).
  const lengthMs = (((to - from) + 1440) % 1440) * 60000;
  let today;
  try {
    today = zonedParts(timeZone, nowMs);
  } catch {
    return null; // unknown time zone
  }
  for (let back = 0; back < 8; back++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d - back));
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    const start = zonedToEpoch(timeZone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), startHour, startMinute);
    if (start <= nowMs) return { start, end: start + lengthMs };
  }
  return null;
}

/** Seconds- and minute-based resolutions ("1", "5S", "240"); not D / W / M or range bars. */
export function isIntraday(resolution) {
  return /^\d+S?$/i.test(String(resolution ?? '').trim());
}

/**
 * Regular-session stats (open, high, low, volume, VWAP) from the newest loaded bars.
 * `complete` is false when the loaded bars do not reach back to the session start,
 * e.g. late in a long session on a chart that still holds only its first ~300 bars.
 */
export function sessionStats(recent, window) {
  if (!window || !Array.isArray(recent) || recent.length === 0) return null;
  const inside = recent.filter((b) => b[0] * 1000 >= window.start && b[0] * 1000 < window.end);
  if (inside.length === 0) return null;
  let volume = 0, traded = 0, high = -Infinity, low = Infinity;
  for (const [, , h, l, c, v] of inside) {
    high = Math.max(high, h);
    low = Math.min(low, l);
    volume += v;
    traded += ((h + l + c) / 3) * v;
  }
  return {
    start: Math.floor(window.start / 1000),
    end: Math.floor(window.end / 1000),
    complete: recent[0][0] * 1000 <= window.start,
    bars: inside.length,
    open: inside[0][1],
    high,
    low,
    last: inside[inside.length - 1][4],
    volume,
    vwap: volume > 0 ? round3(traded / volume) : null,
  };
}

/**
 * Per-expiration digest of a chain as returned by getOptionsChain (around_atm: 0).
 * Volume, open interest, the put/call ratios, max pain and the busiest strikes
 * are null for an expiration the page shows collapsed — those values are only
 * rendered for the expanded one. Pure — unit-tested offline.
 */
export function summarizeOptions(chain) {
  if (!chain || !Array.isArray(chain.expirations)) return null;
  const spot = chain.underlying_close;
  const ratio = (numerator, denominator) =>
    (numerator == null || !denominator) ? null : round3(numerator / denominator);
  const totals = (rows, key) => {
    let any = false, call = 0, put = 0;
    for (const r of rows) {
      if (r.call?.[key] != null) { call += r.call[key]; any = true; }
      if (r.put?.[key] != null) { put += r.put[key]; any = true; }
    }
    return any ? { call, put } : { call: null, put: null };
  };
  const busiest = (rows, side) => rows.reduce((best, r) => {
    const v = r[side]?.volume;
    return v != null && (best == null || v > best.volume) ? { strike: r.strike, volume: v } : best;
  }, null);

  const expirations = chain.expirations.map((exp) => {
    const rows = exp.rows || [];
    const nearest = spot == null ? null : rows.reduce((best, r) =>
      best == null || Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best, null);
    const atm = nearest || rows[Math.floor(rows.length / 2)] || null;
    const ivs = atm ? [atm.call?.iv, atm.put?.iv].filter((v) => v != null) : [];
    const volume = totals(rows, 'volume');
    const oi = totals(rows, 'openInterest');

    // Max pain: the strike that costs option writers the least at expiry.
    let maxPain = null;
    if (oi.call != null && oi.put != null) {
      let best = null;
      for (const settle of rows) {
        let pain = 0;
        for (const r of rows) {
          pain += (r.call?.openInterest || 0) * Math.max(0, settle.strike - r.strike);
          pain += (r.put?.openInterest || 0) * Math.max(0, r.strike - settle.strike);
        }
        if (best == null || pain < best.pain) best = { strike: settle.strike, pain };
      }
      maxPain = best?.strike ?? null;
    }

    const callVolume = busiest(rows, 'call');
    const putVolume = busiest(rows, 'put');
    return {
      expiration: exp.expiration,
      dte: exp.dte,
      atm_strike: atm ? atm.strike : null,
      atm_iv: ivs.length ? round3(ivs.reduce((a, b) => a + b, 0) / ivs.length) : null,
      call_volume: volume.call,
      put_volume: volume.put,
      call_oi: oi.call,
      put_oi: oi.put,
      pc_volume: ratio(volume.put, volume.call),
      pc_oi: ratio(oi.put, oi.call),
      max_pain: maxPain,
      busiest_call_strike: callVolume ? callVolume.strike : null,
      busiest_put_strike: putVolume ? putVolume.strike : null,
      data: exp.expanded ? 'displayed' : 'model',
    };
  });

  const collapsed = expirations.filter((e) => e.data === 'model').map((e) => e.expiration);
  return {
    symbol: chain.symbol ?? null,
    underlying_close: spot ?? null,
    expiration_count: chain.expiration_count ?? chain.expirations.length,
    expirations,
    ...(collapsed.length && {
      note: `Volume, open interest, put/call ratios, max pain and the busiest strikes are null for ${collapsed.join(', ')}: the page shows them collapsed. Expand an expiration on the options-chain page to read them.`,
    }),
  };
}

function pickSections(only) {
  const sections = { quote: true, watchlist: true, options: true, bars: true, studies: true };
  for (const name of only || []) {
    if (!SECTIONS.includes(name)) {
      throw new Error(`Unknown section "${name}". Valid sections: ${SECTIONS.join(', ')}.`);
    }
  }
  if (only?.length) {
    for (const name of SECTIONS) sections[name] = only.includes(name);
  }
  return sections;
}

const PLAIN_NUMBER = /^-?\d[\d,]*(?:\.\d+)?%?$/;

/**
 * Data-window values are display strings — return numbers as numbers:
 * "381.96" and "−0.5%" → 381.96 and -0.5, "1.94 K" → 1940. Anything else is kept as shown.
 */
function numericValues(values) {
  const out = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (typeof value !== 'string') { out[key] = value; continue; }
    const text = value.replace(/\u2212/g, '-').trim();
    if (PLAIN_NUMBER.test(text)) out[key] = Number(text.replace(/[,%]/g, ''));
    else if (/^[+-]?[\d,]+(?:\.\d+)?\s*[KMB]$/i.test(text)) out[key] = parseVolume(text);
    else out[key] = value;
  }
  return out;
}

const INPUT_FLAGS = ['text', 'pineId', 'pineVersion', 'pineFeatures'];

/** Indicator inputs without the built-in scripts' source blobs and internal flags, or null. */
function compactInputs(inputs) {
  const out = {};
  for (const [key, raw] of Object.entries(inputs || {})) {
    if (key.startsWith('__') || INPUT_FLAGS.includes(key)) continue;
    // TradingView keeps each input as { v: value, f, t }.
    const value = raw && typeof raw === 'object' && 'v' in raw ? raw.v : raw;
    if (value === '' || (typeof value === 'string' && value.length > 40)) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function parseWatchlist(data) {
  const symbols = (data?.symbols || []).map((row) => ({
    symbol: row.symbol,
    last: parseNumberLike(row.last),
    change: parseNumberLike(row.change),
    change_pct: parseNumberLike(row.change_percent),
    volume: parseVolume(row.volume),
  }));
  return symbols.length ? { symbols } : null;
}

function parseNumberLike(text) {
  const s = String(text ?? '').replace(/\u2212/g, '-').trim();
  return /^[+-]?[\d,]+(?:\.\d+)?%?$/.test(s) ? Number(s.replace(/[,%]/g, '')) : null;
}

const toBar = ([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume });

function buildQuote(read, day) {
  const recent = read.recent;
  const last = recent[recent.length - 1];
  const info = read.info || {};
  const quote = {
    symbol: read.symbol,
    description: info.description ?? null,
    exchange: info.exchange ?? null,
    currency: info.currency ?? null,
    resolution: read.resolution,
    last: last[4],
    bar_time: last[0],
    bar: toBar(last),
    day: day || null,
    session: null,
  };
  if (isIntraday(read.resolution)) {
    quote.session = sessionStats(recent, sessionWindow(info.regular_session, info.timezone));
  }
  return quote;
}

/**
 * Collect one snapshot. The quote is required — without chart bars the call
 * fails. Every other section degrades on its own: an unavailable section is
 * reported as { available: false, error } (or null) and listed under `errors`.
 */
export async function getSnapshot({ bars = DEFAULT_BARS, expirations = DEFAULT_EXPIRATIONS, only, _deps } = {}) {
  const deps = _resolve(_deps);
  const sections = pickSections(only);
  const errors = {};

  let read;
  try {
    read = await deps.evaluate(readChartJs());
  } catch (err) {
    throw new Error(`Could not read the chart: ${err.message}`);
  }
  if (!read || !read.symbol || !Array.isArray(read.recent) || read.recent.length === 0) {
    throw new Error(`Could not read chart data${read?.error ? `: ${read.error}` : ''}. The chart may still be loading.`);
  }

  // Read whenever the panel is showing: the quote's day change comes from the symbol's own row.
  let watchlist = null;
  if (read.watchlist_rows > 0) {
    try {
      watchlist = parseWatchlist(await deps.getWatchlist());
    } catch (err) {
      errors.watchlist = err.message;
    }
  }
  const own = watchlist?.symbols.find((s) => bare(s.symbol) === bare(read.symbol));
  const snapshot = {
    success: true,
    ts: Date.now(),
    quote: buildQuote(read, own && { last: own.last, change: own.change, change_pct: own.change_pct, volume: own.volume }),
  };

  if (sections.watchlist) {
    snapshot.watchlist = watchlist
      ? { count: watchlist.symbols.length, symbols: watchlist.symbols }
      : { available: false, error: errors.watchlist || 'Watchlist panel is closed — open it to include its quotes.' };
  }

  if (sections.options) {
    try {
      const n = Number(expirations);
      const chain = await deps.getOptionsChain({
        symbol: read.symbol,
        around_atm: 0,
        max_expirations: Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_EXPIRATIONS) : DEFAULT_EXPIRATIONS,
      });
      const summary = summarizeOptions(chain);
      snapshot.options = summary
        ? { available: true, ...summary }
        : { available: false, error: 'The options chain page returned no expirations.' };
    } catch (err) {
      snapshot.options = { available: false, error: err.message };
      errors.options = err.message;
    }
  }

  if (sections.bars) {
    const count = Math.min(Math.max(Math.floor(Number(bars)) || 0, 0), MAX_BARS);
    const rows = count > 0 ? read.recent.slice(-count) : [];
    snapshot.bars = { count: rows.length, resolution: read.resolution, bars: rows.map(toBar) };
  }

  if (sections.studies) {
    try {
      snapshot.studies = ((await deps.getStudyValues())?.studies || []).map((study) => ({
        id: study.id,
        name: study.name,
        inputs: compactInputs(study.inputs),
        values: numericValues(study.values),
      }));
    } catch (err) {
      snapshot.studies = null;
      errors.studies = err.message;
    }
  }

  if (Object.keys(errors).length) snapshot.errors = errors;
  return snapshot;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Emit a snapshot every `interval` ms until SIGINT/SIGTERM or `count` lines.
 * Every line is a snapshot — unlike the other streams there is no dedup, since
 * the point is a steady series. A failed read is emitted as
 * { success: false, error } and the loop keeps going.
 */
export async function streamSnapshot(options = {}, { interval = DEFAULT_INTERVAL_MS, count = Infinity, onSnapshot, _sleep = sleep } = {}) {
  const emit = onSnapshot || ((snap) => process.stdout.write(JSON.stringify(snap) + '\n'));
  let running = true;
  const stop = () => { running = false; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let emitted = 0, failures = 0;
  try {
    while (running && emitted < count) {
      let snap;
      try {
        snap = await getSnapshot(options);
        failures = 0;
      } catch (err) {
        snap = { success: false, ts: Date.now(), error: err.message };
      }
      if (!running) break;
      emit(snap);
      emitted++;
      if (running && emitted < count) {
        // Connection errors back off, like the other streams; anything else keeps the cadence.
        const wait = !snap.success && /CDP|ECONNREFUSED|connection/i.test(snap.error)
          ? Math.min(2000 * 2 ** Math.min(failures++, 5), 60000)
          : interval;
        await _sleep(wait);
      }
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  return emitted;
}
