/**
 * Core options chain logic.
 *
 * The chain lives on its own page (tradingview.com/symbols/<EXCHANGE-SYMBOL>/options-chain/),
 * not on the chart, so this module opens a short-lived CDP session to that page and leaves the
 * cached chart client in connection.js alone. Read-only: nothing is opened, navigated or clicked.
 *
 * Two sources are read from the page and merged:
 * - the rendered table — the values TradingView displays (live bid/ask, volume, open interest),
 *   but only for the expiration that is expanded
 * - the page's chain model (React props) — every expiration with the calculation fields
 *   (IV, Greeks, breakeven, ...), formatted as display strings
 */
import CDP from 'chrome-remote-interface';
import { CDP_HOST, CDP_PORT } from '../connection.js';

const DEFAULT_AROUND_ATM = 6;
const DEFAULT_MAX_EXPIRATIONS = 4;
const MAX_AROUND_ATM = 50;

const OPTIONS_PAGE_RE = /tradingview\.com\/symbols\/([^/]+)\/options-chain/i;

// Chain-model field → output key. Percent fields stay in percent units (iv: 104.27 = 104.27%).
const MODEL_FIELDS = {
  bid: 'bid', ask: 'ask', ltp: 'ltp',
  volume: 'volume', openInterest: 'openInterest', volumeOiRatio: 'volumeOiRatio',
  theoPrice: 'theoPrice', iv: 'iv', bid_iv: 'bidIv', ask_iv: 'askIv', ivSpread: 'ivSpread', spread: 'spread',
  delta: 'delta', gamma: 'gamma', theta: 'theta', vega: 'vega', rho: 'rho',
  breakeven: 'breakeven', toBreakeven: 'toBreakeven', distance: 'distance', relDistance: 'relDistance',
  intrinsic: 'intrinsic', extrinsic: 'extrinsic',
  relBid: 'relBid', relAsk: 'relAsk', relAnnBid: 'relAnnBid', relAnnAsk: 'relAnnAsk',
};
const CORE_FIELDS = ['bid', 'ask', 'volume', 'openInterest', 'iv', 'theoPrice', 'delta', 'gamma', 'theta', 'vega', 'rho', 'breakeven'];
const ALL_FIELDS = Object.values(MODEL_FIELDS);
const FIELD_TO_MODEL = Object.fromEntries(Object.entries(MODEL_FIELDS).map(([model, out]) => [out, model]));

// Rendered cells: column id → output keys for the numbers in the cell, left to right.
const CELL_FIELDS = {
  bidAsk: ['bid', 'ask'],
  volume: ['volume', 'volumeOiRatio'],
  relBidAsk: ['relBid', 'relAsk'],
  ivBidAsk: ['bidIv', 'askIv'],
  intrinsicExtrinsic: ['intrinsic', 'extrinsic'],
};
const COLUMN_TO_FIELD = { theor: 'theoPrice' };
// Rendered straight from the chain model, so a mismatch means the columns were read wrong.
const VERIFIABLE = ['theoPrice', 'iv', 'delta', 'breakeven', 'distance'];

// Page-context JS: returns plain data only (React elements are stripped).
const READ_PAGE_JS = `
  (function() {
    var primitives = function(o) {
      var r = {};
      if (!o || typeof o !== 'object') return r;
      Object.keys(o).forEach(function(k) {
        var v = o[k];
        if (v === null || v === undefined || typeof v === 'object' || typeof v === 'function') return;
        r[k] = v;
      });
      return r;
    };
    var tables = Array.prototype.slice.call(document.querySelectorAll('table')).filter(function(tb) {
      return tb.querySelectorAll('th').length > 10;
    }).sort(function(a, b) { return b.rows.length - a.rows.length; });
    var table = tables[0];
    if (!table) return { error: 'table' };
    var fiber = null, el = table;
    for (var i = 0; i < 6 && el && !fiber; i++) {
      var keys = Object.keys(el);
      for (var j = 0; j < keys.length; j++) {
        if (keys[j].indexOf('__reactFiber$') === 0) { fiber = el[keys[j]]; break; }
      }
      if (!fiber) el = el.parentElement;
    }
    var top = null;
    for (var f = fiber, d = 0; f && d < 80 && !top; f = f.return, d++) {
      var p = f.memoizedProps;
      if (p && typeof p === 'object' && p.data && Array.isArray(p.data.groups)) top = p;
    }
    if (!top) return { error: 'data' };
    var sections = [], cur = null;
    Array.prototype.forEach.call(table.rows, function(row) {
      var cells = Array.prototype.map.call(row.cells, function(c) { return (c.innerText || '').replace(/\\s+/g, ' ').trim(); });
      var text = cells.filter(Boolean);
      if (text.length === 0) return;
      if (cells.length === 1) { cur = { header: text[0], rows: [] }; sections.push(cur); return; }
      // Banner, column-header and underlying-price rows are dropped later, by parseRow().
      if (cur) cur.rows.push(cells);
    });
    return {
      sideCols: (top.colsData && top.colsData.sideCols) || [],
      centralCols: (top.colsData && top.colsData.centralCols) || [],
      groups: top.data.groups.map(function(g) {
        return {
          seriesId: g.seriesId,
          serie: primitives(g.serie),
          underlying: primitives(g.underlying),
          rows: (g.rows || []).map(function(r) {
            return { strike: r.strike, callId: r.callId, putId: r.putId, call: primitives(r.call), put: primitives(r.put) };
          }),
        };
      }),
      sections: sections,
    };
  })()
`;

// ── Pure helpers ──

function normalizeText(text) {
  return String(text ?? '')
    .replace(/\u2212/g, '-')            // minus sign used by TradingView
    .replace(/[\u00a0\u2009\u202f]/g, ' ')
    .replace(/(\d),(\d)/g, '$1$2');     // thousands separators
}
const NO_VALUE = /^[\s\-\u2010-\u2015]*$/;

/** First number in a display string ("−0.48" → -0.48, "104.27%" → 104.27), or null for "—". */
export function parseNumber(text) {
  const s = normalizeText(text).trim();
  if (!s || NO_VALUE.test(s)) return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/** Numbers in a rendered cell, one per part ("4.50 × 6.05" → [4.5, 6.05], "4.50 × —" → [4.5, null]). */
export function parseCell(text) {
  const s = normalizeText(text).trim();
  if (!s || NO_VALUE.test(s)) return [];
  return s.split(/[×\s]+/).map(parseNumber);
}

/** "NASDAQ-TSLA" for a page at tradingview.com/symbols/NASDAQ-TSLA/options-chain/, else null. */
export function optionsPageSymbol(target) {
  const m = OPTIONS_PAGE_RE.exec(target?.url || '');
  if (!m) return null;
  try { return decodeURIComponent(m[1]).toUpperCase(); } catch { return null; }
}

function normalizeSymbol(symbol) {
  return String(symbol ?? '').trim().toUpperCase().replace(/[:/]+/g, '-');
}

export function pickOptionsPage(targets, symbol) {
  const pages = (targets || []).filter(t => t?.type === 'page' && optionsPageSymbol(t));
  const names = pages.map(optionsPageSymbol);
  const open = names.length ? ` Open options chain pages: ${names.join(', ')}.` : '';
  if (pages.length === 0) {
    throw new Error(`No options chain page is open in TradingView Desktop. Open the symbol's options chain (Options tab) first, then retry.`);
  }
  const wanted = normalizeSymbol(symbol);
  if (!wanted) {
    if (pages.length > 1) throw new Error(`Multiple options chain pages are open (${names.join(', ')}). Pass symbol to pick one.`);
    return pages[0];
  }
  const bare = wanted.split('-').pop();
  const matches = pages.filter((_, i) => names[i] === wanted || names[i].endsWith(`-${bare}`));
  if (matches.length === 0) throw new Error(`No options chain page is open for "${String(symbol).trim()}".${open}`);
  if (matches.length > 1) throw new Error(`Multiple options chain pages match "${String(symbol).trim()}": ${matches.map(optionsPageSymbol).join(', ')}. Pass the full symbol (e.g., ${matches.map(optionsPageSymbol).join(' or ')}).`);
  return matches[0];
}

function isoDate(exp) {
  const s = String(exp ?? '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

/** Calendar days from today (New York) to the expiration date. */
export function daysToExpiration(exp, now = new Date()) {
  const s = String(exp ?? '');
  if (!/^\d{8}$/.test(s)) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type) => Number(parts.find(p => p.type === type).value);
  const today = Date.UTC(get('year'), get('month') - 1, get('day'));
  return Math.round((Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8))) - today) / 86400000);
}

/** Index of the group matching YYYYMMDD / YYYY-MM-DD / a label fragment. */
export function findExpiration(groups, query) {
  const q = String(query).trim();
  const digits = q.replace(/\D/g, '');
  let idx = digits.length === 8 ? groups.findIndex(g => String(g.serie?.exp) === digits) : -1;
  if (idx === -1) {
    const lq = q.toLowerCase();
    idx = groups.findIndex(g => String(g.serie?.label || '').toLowerCase().includes(lq));
  }
  if (idx === -1) {
    const list = groups.map(g => isoDate(g.serie?.exp)).filter(Boolean);
    throw new Error(`Expiration "${q}" not found. Available: ${list.slice(0, 8).join(', ')}${list.length > 8 ? `, … (${list.length} total)` : ''}.`);
  }
  return idx;
}

function cellKeys(col) {
  if (CELL_FIELDS[col]) return CELL_FIELDS[col];
  const field = COLUMN_TO_FIELD[col] || col;
  return Object.values(MODEL_FIELDS).includes(field) ? [field] : null;
}

// Calls sit left of the strike in the reverse of sideCols order; puts sit right of it in order.
function parseRow(cells, side, central) {
  if (cells.length < side.length * 2 + central.length) return null;
  const strike = parseNumber(cells[side.length]);
  if (strike === null) return null;    // the column-header row
  const row = { strike, call: {}, put: {} };
  const fill = (target, col, text) => {
    const keys = cellKeys(col);
    if (!keys) return;
    parseCell(text).slice(0, keys.length).forEach((n, i) => { target[keys[i]] = n; });
  };
  side.forEach((col, j) => {
    fill(row.call, col, cells[side.length - 1 - j]);
    fill(row.put, col, cells[side.length + central.length + j]);
  });
  return row;
}

/**
 * Rendered table values per group (null where the group is collapsed). Sections come in the
 * same order as the groups; a section is only trusted when its strikes line up with the group
 * and the model-backed columns still agree with the chain model.
 */
function displayedByGroup(page, groups) {
  const side = page.sideCols || [];
  const central = page.centralCols || [];
  const headers = (page.sections || []).filter(s => s.header);
  if (headers.length !== groups.length) return groups.map(() => null);
  return headers.map((section, gi) => {
    const model = groups[gi].rows || [];
    const parsed = (section.rows || []).map(cells => parseRow(cells, side, central)).filter(Boolean);
    if (parsed.length === 0 || parsed.length !== model.length || parsed.some((r, i) => r.strike !== model[i].strike)) return null;
    let checked = 0, off = 0;
    parsed.forEach((row, i) => ['call', 'put'].forEach((s) => {
      for (const k of VERIFIABLE) {
        if (row[s][k] == null) continue;
        const expected = parseNumber(model[i][s]?.[FIELD_TO_MODEL[k]]);
        if (expected === null) continue;
        checked++;
        if (row[s][k] !== expected) off++;
      }
    }));
    return checked === 0 || off * 2 <= checked ? parsed : null;
  });
}

function shapeOption(model, shown, symbol, keys) {
  const out = { symbol };
  for (const k of keys) {
    const value = shown && shown[k] !== undefined ? shown[k] : parseNumber(model?.[FIELD_TO_MODEL[k]]);
    out[k] = value === undefined ? null : value;
  }
  return out;
}

function pickAround(rows, spot, count) {
  const byStrike = (a, b) => a.strike - b.strike;
  if (!count || count >= rows.length) return rows.slice().sort(byStrike);
  const anchor = spot === null ? rows[Math.floor(rows.length / 2)].strike : spot;
  return rows.slice()
    .sort((a, b) => Math.abs(a.strike - anchor) - Math.abs(b.strike - anchor) || byStrike(a, b))
    .slice(0, count)
    .sort(byStrike);
}

function bounded(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min ? Math.min(Math.floor(n), max) : fallback;
}

/** Turn the raw page read into the tool result. Pure — unit-tested offline. */
export function shapeChain(page, { expiration, around_atm, max_expirations, fields, now = new Date() } = {}) {
  if (!page || page.error) {
    throw new Error(page?.error === 'data'
      ? 'Options chain data not found on the page — it may still be loading.'
      : 'Options chain table not found on the page. Make sure it shows the Options tab and has finished loading.');
  }
  const groups = page.groups || [];
  if (!groups.some(g => g.rows?.length)) throw new Error('The options chain has no strikes yet — it may still be loading.');

  const wanted = expiration ? findExpiration(groups, expiration) : -1;
  const indexes = wanted === -1
    ? groups.map((_, i) => i).slice(0, bounded(max_expirations, DEFAULT_MAX_EXPIRATIONS, 1, groups.length))
    : [wanted];
  const keys = fields === 'all' ? ALL_FIELDS : CORE_FIELDS;
  const around = bounded(around_atm, DEFAULT_AROUND_ATM, 0, MAX_AROUND_ATM);
  const displayed = displayedByGroup(page, groups);

  let compared = 0, differ = 0;
  const expirations = indexes.map((gi) => {
    const g = groups[gi];
    const rows = g.rows || [];
    const shown = displayed[gi] || null;
    if (shown) {
      shown.forEach((row, i) => ['call', 'put'].forEach((s) => {
        const modelBid = parseNumber(rows[i][s]?.bid), modelAsk = parseNumber(rows[i][s]?.ask);
        if ([row[s].bid, row[s].ask, modelBid, modelAsk].every(v => v != null)) {
          compared++;
          if (row[s].bid !== modelBid || row[s].ask !== modelAsk) differ++;
        }
      }));
    }
    const close = Number(g.underlying?.close);
    return {
      expiration: isoDate(g.serie?.exp),
      dte: daysToExpiration(g.serie?.exp, now),
      label: g.serie?.label,
      strike_count: rows.length,
      expanded: Boolean(shown),
      rows: pickAround(rows, Number.isFinite(close) ? close : null, around).map(r => ({
        strike: r.strike,
        call: shapeOption(r.call, shown?.[rows.indexOf(r)]?.call, r.callId, keys),
        put: shapeOption(r.put, shown?.[rows.indexOf(r)]?.put, r.putId, keys),
      })),
    };
  });

  const first = groups[0];
  const notes = [];
  const collapsed = expirations.filter(e => !e.expanded).map(e => e.expiration);
  if (collapsed.length) {
    notes.push(`Not read from the table: ${collapsed.join(', ')} (collapsed on the page, or the table could not be matched). Their bid/ask come from the page's calculation model; volume, openInterest and ltp are null.`);
  }
  if (differ > 0) {
    notes.push(`For expanded expirations the displayed bid/ask are returned; for ${differ} of ${compared} options they differ from the bid/ask the page's calculation model is based on.`);
  }

  return {
    success: true,
    source: 'options_chain_page',
    symbol: first.underlying?.name || first.serie?.underlying || null,
    underlying_close: Number.isFinite(Number(first.underlying?.close)) ? Number(first.underlying.close) : null,
    currency: first.underlying?.currency || null,
    expiration_count: groups.length,
    expirations_returned: expirations.length,
    fields: keys,
    expirations,
    ...(notes.length && { notes }),
  };
}

// ── CDP access ──

async function _listTargets() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  return resp.json();
}

async function _openTarget(target) {
  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
  return {
    async evaluate(expression) {
      const { result, exceptionDetails } = await client.Runtime.evaluate({ expression, returnByValue: true });
      if (exceptionDetails) {
        throw new Error(`JS evaluation error: ${exceptionDetails.exception?.description || exceptionDetails.text || 'Unknown evaluation error'}`);
      }
      return result?.value;
    },
    close: () => client.close(),
  };
}

function _resolve(deps) {
  return {
    listTargets: deps?.listTargets || _listTargets,
    openTarget: deps?.openTarget || _openTarget,
  };
}

export async function getOptionsChain({ symbol, expiration, around_atm, max_expirations, fields, _deps } = {}) {
  const { listTargets, openTarget } = _resolve(_deps);
  let targets;
  try {
    targets = await listTargets();
  } catch (err) {
    throw new Error(`CDP connection failed: ${err.message}. Is TradingView running with --remote-debugging-port=${CDP_PORT}?`);
  }
  // A separate short-lived session: reconnectTo() would move every chart tool to this page.
  const target = await openTarget(pickOptionsPage(targets, symbol));
  let page;
  try {
    page = await target.evaluate(READ_PAGE_JS);
  } finally {
    await target.close();
  }
  return shapeChain(page, { expiration, around_atm, max_expirations, fields });
}
