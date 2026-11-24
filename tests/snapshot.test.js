/**
 * Snapshot unit tests — no TradingView connection needed.
 * Tests: display-string parsing, session window and stats, the options digest,
 * how the sections compose (and degrade) through injected deps, and the poll loop.
 *
 * Run: node --test tests/snapshot.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSnapshot, streamSnapshot, summarizeOptions, sessionStats, sessionWindow,
  parseVolume, isIntraday,
} from '../src/core/snapshot.js';

// These tests never touch the live app. A code path that falls back to the real
// data sources fails here instead of quietly connecting to TradingView.
globalThis.fetch = async () => { throw new Error('network access from a unit test'); };

// ── Fixtures ──────────────────────────────────────────────────────────────

// 2026-11-24 (Tuesday) 09:30-16:00 in New York.
const T0930 = Date.UTC(2026, 10, 24, 14, 30);
const T1600 = Date.UTC(2026, 10, 24, 21, 0);

// What readChartJs() returns for a 1m chart of BATS:TSLA: a pre-market bar,
// then three bars of the regular session.
function chartRead(over = {}) {
  return {
    symbol: 'BATS:TSLA',
    resolution: '1',
    info: {
      description: 'Tesla, Inc.', exchange: 'Cboe One', currency: 'USD', pro_name: 'NASDAQ:TSLA',
      timezone: 'America/New_York', regular_session: '0930-1600',
    },
    recent: [
      [T0930 / 1000 - 300, 384.0, 384.2, 383.9, 384.0, 40],       // 09:25, pre-market
      [T0930 / 1000, 383.76, 387.86, 380.50, 387.55, 100],
      [T0930 / 1000 + 60, 387.55, 390.10, 386.10, 386.17, 300],
      [T0930 / 1000 + 120, 386.30, 387.95, 384.00, 385.86, 200],
    ],
    loaded_bars: 4,
    watchlist_rows: 2,
    ...over,
  };
}

// What core/watchlist.get() returns.
function watchlist() {
  return {
    success: true, count: 3, list_id: 1, list_name: 'Watchlist', source: 'dom_rows',
    symbols: [
      { symbol: 'SP:SPX', last: '7,160.83', change: '\u221276.34', change_percent: '\u22121.05%', volume: '770.31 M' },
      { symbol: 'NASDAQ:TSLA', last: '380.13', change: '\u22125.33', change_percent: '\u22121.38%', volume: '11.14 M' },
      { symbol: 'TVC:DJI', last: '49,685.98', change: '+86.03', change_percent: '+0.17%', volume: null },
    ],
  };
}

// What getOptionsChain({ around_atm: 0 }) returns: one expanded expiration and one collapsed.
function chain() {
  return {
    success: true, symbol: 'NASDAQ:TSLA', underlying_close: 385.46, expiration_count: 2,
    expirations: [
      {
        expiration: '2026-11-25', dte: 1, expanded: true, strike_count: 3,
        rows: [
          { strike: 380, call: { iv: 101.5, volume: 6000, openInterest: 2000 }, put: { iv: 99.3, volume: 4000, openInterest: 5000 } },
          { strike: 385, call: { iv: 99.31, volume: 3457, openInterest: 695 }, put: { iv: 99.31, volume: 9501, openInterest: 1311 } },
          { strike: 390, call: { iv: 55.57, volume: 1500, openInterest: 800 }, put: { iv: 55.57, volume: 200, openInterest: 300 } },
        ],
      },
      {
        expiration: '2026-11-27', dte: 3, expanded: false, strike_count: 2,
        rows: [
          { strike: 380, call: { iv: 98, volume: null, openInterest: null }, put: { iv: 96, volume: null, openInterest: null } },
          { strike: 390, call: { iv: 60, volume: null, openInterest: null }, put: { iv: 58, volume: null, openInterest: null } },
        ],
      },
    ],
    notes: ['Not read from the table: 2026-11-27 (collapsed on the page, or the table could not be matched).'],
  };
}

// What core/data.getStudyValues() returns. Built-in scripts carry their whole
// source and internal flags in `inputs`, each input stored as { v, f, t }.
function studies() {
  const input = (v, t) => ({ v, f: true, t });
  return {
    success: true, study_count: 3,
    studies: [
      { id: 'xuYvzi', name: 'Volume', inputs: { length: 20, col_prev_close: false }, values: { 'Volume': '1.94 K' } },
      {
        id: 'EDynJ4', name: 'Bollinger Bands',
        inputs: {
          text: 'bmI9Ks46_4byaEbFQthQIfSreUCT09g==_ZcLJSOrBZ00+WxypdgdRj8hXmn6RgXhMvgfF462uRKplTzDDUGZxgpT5fNFmqfbbhsgcEsK7JjK',
          pineId: 'STD;Bollinger_Bands', pineVersion: '33.0', pineFeatures: input('{"indicator":1,"plot":1,"ta":1}', 'text'),
          in_0: input(20, 'integer'), in_1: input('SMA', 'text'), in_2: input('close', 'source'), in_3: input(2, 'float'),
          in_4: input(0, 'integer'), in_5: input('', 'resolution'), in_6: input(true, 'bool'),
          __fast_calc: input(false, 'bool'), __profile: input(false, 'bool'),
        },
        values: { 'Basis': '381.96', 'Upper': '383.52', 'Lower': '\u22120.5%' },
      },
      { id: 'abc123', name: 'Custom Script', inputs: { text: 'indicator("x")\nplot(close)', __profile: input(false, 'bool') }, values: { 'Plot': 'n/a' } },
    ],
  };
}

// Injected deps; any source can be replaced or made to throw with an Error.
function deps({ read, watchlist: wl, options, studies: st } = {}) {
  const calls = { evaluate: 0, watchlist: 0, options: [], studies: 0 };
  const fail = (err, value) => {
    if (err instanceof Error) throw err;
    return structuredClone(value);
  };
  return {
    calls,
    _deps: {
      evaluate: async () => { calls.evaluate++; return read === undefined ? chartRead() : read; },
      getWatchlist: async () => { calls.watchlist++; return fail(wl, watchlist()); },
      getOptionsChain: async (args) => { calls.options.push(args); return fail(options, chain()); },
      getStudyValues: async () => { calls.studies++; return fail(st, studies()); },
    },
  };
}

// ── Display strings ───────────────────────────────────────────────────────

describe('Snapshot — display strings', () => {
  it('parses watchlist volumes with their scale suffix', () => {
    assert.equal(parseVolume('770.31 M'), 770310000);
    assert.equal(parseVolume('258.46 K'), 258460);
    assert.equal(parseVolume('1.2 B'), 1200000000);
    assert.equal(parseVolume('1,234'), 1234);
    assert.equal(parseVolume('0'), 0);
    assert.equal(parseVolume('770.31\u00a0M'), 770310000);     // non-breaking space
    assert.equal(parseVolume('12.5'), 12.5);                   // a real fraction is kept
  });

  it('returns null for empty and non-numeric volumes', () => {
    for (const text of ['', '  ', null, undefined, '\u2014', "106'28'7"]) {
      assert.equal(parseVolume(text), null, `expected null for ${JSON.stringify(text)}`);
    }
  });

  it('tells second- and minute-based resolutions from the rest', () => {
    assert.equal(isIntraday('1'), true);
    assert.equal(isIntraday('240'), true);
    assert.equal(isIntraday('5S'), true);
    for (const r of ['D', '1D', 'W', '1W', 'M', '1M', '5R', '']) assert.equal(isIntraday(r), false, r);
  });
});

// ── Session window ────────────────────────────────────────────────────────

describe('Snapshot — session window', () => {
  const tz = 'America/New_York';

  it('is the session that started most recently, in the symbol time zone', () => {
    assert.deepEqual(sessionWindow('0930-1600', tz, Date.UTC(2026, 10, 24, 15, 0)), { start: T0930, end: T1600 });
    assert.deepEqual(sessionWindow('0930-1600', tz, T0930), { start: T0930, end: T1600 });
  });

  it('rolls back to the previous session before the open and after the close', () => {
    const monday = { start: Date.UTC(2026, 10, 23, 14, 30), end: Date.UTC(2026, 10, 23, 21, 0) };
    assert.deepEqual(sessionWindow('0930-1600', tz, Date.UTC(2026, 10, 24, 14, 0)), monday);     // Tuesday 09:00, pre-market
    assert.deepEqual(sessionWindow('0930-1600', tz, Date.UTC(2026, 10, 23, 21, 0)), monday);     // Monday 16:00, after the close
  });

  it('skips the weekend', () => {
    const sunday = Date.UTC(2026, 10, 22, 17, 0);
    assert.equal(sessionWindow('0930-1600', tz, sunday).start, Date.UTC(2026, 10, 20, 14, 30));
  });

  it('follows daylight saving time', () => {
    assert.equal(sessionWindow('0930-1600', tz, Date.UTC(2026, 6, 1, 15, 0)).start, Date.UTC(2026, 6, 1, 13, 30));
  });

  it('runs a session that wraps past midnight to the next day', () => {
    const w = sessionWindow('1700-1600', tz, Date.UTC(2026, 10, 24, 22, 0));
    assert.equal(w.start, Date.UTC(2026, 10, 24, 22, 0));
    assert.equal(w.end, Date.UTC(2026, 10, 25, 21, 0));
  });

  it('has no window for a round-the-clock session, a malformed string or an unknown time zone', () => {
    assert.equal(sessionWindow('2000-2000', tz), null);
    assert.equal(sessionWindow('24x7', tz), null);
    assert.equal(sessionWindow(null, tz), null);
    assert.equal(sessionWindow('0930-1600', undefined), null);
    assert.equal(sessionWindow('0930-1600', 'Mars/Olympus_Mons'), null);
  });
});

// ── Session stats ─────────────────────────────────────────────────────────

describe('Snapshot — session stats', () => {
  const window = { start: T0930, end: T1600 };

  it('uses the regular-session bars only and marks the stats complete', () => {
    const stats = sessionStats(chartRead().recent, window);
    assert.equal(stats.complete, true);
    assert.equal(stats.bars, 3);
    assert.equal(stats.open, 383.76);
    assert.equal(stats.high, 390.10);
    assert.equal(stats.low, 380.50);
    assert.equal(stats.last, 385.86);
    assert.equal(stats.volume, 600);
    assert.equal(stats.vwap, 386.591);           // sum(typical price x volume) / 600
  });

  it('marks the stats incomplete when the loaded bars start after the open', () => {
    const stats = sessionStats(chartRead().recent.slice(2), window);
    assert.equal(stats.complete, false);
    assert.equal(stats.bars, 2);
    assert.equal(stats.open, 387.55);
  });

  it('returns null without a window or without bars in the session', () => {
    assert.equal(sessionStats(chartRead().recent, null), null);
    assert.equal(sessionStats(chartRead().recent.slice(0, 1), window), null);     // pre-market bar only
    assert.equal(sessionStats([], window), null);
  });

  it('leaves VWAP null when the bars carry no volume', () => {
    const bars = [[T0930 / 1000, 1, 2, 0.5, 1.5, 0]];
    assert.equal(sessionStats(bars, window).vwap, null);
  });
});

// ── Options digest ────────────────────────────────────────────────────────

describe('Snapshot — options digest', () => {
  it('digests an expanded expiration from the displayed values', () => {
    const [first] = summarizeOptions(chain()).expirations;
    assert.deepEqual(first, {
      expiration: '2026-11-25', dte: 1,
      atm_strike: 385, atm_iv: 99.31,
      call_volume: 10957, put_volume: 13701,
      call_oi: 3495, put_oi: 6611,
      pc_volume: 1.25, pc_oi: 1.892,
      max_pain: 380,
      busiest_call_strike: 380, busiest_put_strike: 385,
      data: 'displayed',
    });
  });

  it('keeps the model figures and nulls the rest for a collapsed expiration', () => {
    const [, second] = summarizeOptions(chain()).expirations;
    assert.equal(second.atm_strike, 390);                    // 385.46 is nearer to 390 than to 380
    assert.equal(second.atm_iv, 59);
    for (const key of ['call_volume', 'put_volume', 'call_oi', 'put_oi', 'pc_volume', 'pc_oi', 'max_pain', 'busiest_call_strike', 'busiest_put_strike']) {
      assert.equal(second[key], null, key);
    }
    assert.equal(second.data, 'model');
  });

  it('names the collapsed expirations in a note', () => {
    const summary = summarizeOptions(chain());
    assert.equal(summary.symbol, 'NASDAQ:TSLA');
    assert.equal(summary.underlying_close, 385.46);
    assert.equal(summary.expiration_count, 2);
    assert.match(summary.note, /^Volume, open interest, put\/call ratios, max pain and the busiest strikes are null for 2026-11-27: the page shows them collapsed\./);
    assert.equal('notes' in summary, false);       // the chain's bid/ask notes do not apply to the digest
  });

  it('adds no note when every expiration is expanded', () => {
    const c = chain();
    c.expirations[1].expanded = true;
    assert.equal('note' in summarizeOptions(c), false);
  });

  it('falls back to the middle strike without an underlying price', () => {
    const c = chain();
    c.underlying_close = null;
    assert.equal(summarizeOptions(c).expirations[0].atm_strike, 385);
    assert.equal(summarizeOptions(c).underlying_close, null);
  });

  it('leaves the put/call ratios null when the call side is empty', () => {
    const c = chain();
    for (const row of c.expirations[0].rows) { row.call.volume = 0; row.call.openInterest = 0; }
    const [first] = summarizeOptions(c).expirations;
    assert.equal(first.call_volume, 0);
    assert.equal(first.pc_volume, null);
    assert.equal(first.pc_oi, null);
    assert.equal(first.max_pain, 390);                       // puts alone lose least at the top strike
  });

  it('returns null without a chain', () => {
    assert.equal(summarizeOptions(null), null);
    assert.equal(summarizeOptions({ success: true }), null);
  });
});

// ── getSnapshot composition ───────────────────────────────────────────────

describe('Snapshot — getSnapshot composition', () => {
  it('returns every section by default', async () => {
    const { _deps } = deps();
    const snap = await getSnapshot({ _deps });

    assert.equal(snap.success, true);
    assert.equal(snap.quote.symbol, 'BATS:TSLA');
    assert.equal(snap.quote.last, 385.86);
    assert.equal(snap.quote.bar.time, T0930 / 1000 + 120);
    assert.equal(snap.quote.resolution, '1');

    assert.equal(snap.watchlist.count, 3);
    assert.deepEqual(snap.watchlist.symbols[0], { symbol: 'SP:SPX', last: 7160.83, change: -76.34, change_pct: -1.05, volume: 770310000 });
    assert.deepEqual(snap.watchlist.symbols[2], { symbol: 'TVC:DJI', last: 49685.98, change: 86.03, change_pct: 0.17, volume: null });

    assert.equal(snap.options.available, true);
    assert.equal(snap.options.expirations.length, 2);

    assert.equal(snap.bars.count, 4);
    assert.equal(snap.bars.bars[3].close, 385.86);

    assert.deepEqual(snap.studies, [
      { id: 'xuYvzi', name: 'Volume', inputs: { length: 20, col_prev_close: false }, values: { Volume: 1940 } },
      // The built-in script's source and flags are dropped; its inputs are unwrapped.
      { id: 'EDynJ4', name: 'Bollinger Bands', inputs: { in_0: 20, in_1: 'SMA', in_2: 'close', in_3: 2, in_4: 0, in_6: true }, values: { Basis: 381.96, Upper: 383.52, Lower: -0.5 } },
      { id: 'abc123', name: 'Custom Script', inputs: null, values: { Plot: 'n/a' } },     // not a number: kept as shown
    ]);
    assert.equal('errors' in snap, false);
  });

  it('takes the day change and volume from the symbol\'s own watchlist row', async () => {
    const { _deps } = deps();
    const { quote } = await getSnapshot({ _deps });
    assert.deepEqual(quote.day, { last: 380.13, change: -5.33, change_pct: -1.38, volume: 11140000 });
    assert.equal(quote.description, 'Tesla, Inc.');
    assert.equal(quote.session.high, 390.10);
    assert.equal(quote.session.complete, true);
  });

  it('matches the watchlist row by bare symbol and leaves the day empty when it is not listed', async () => {
    const read = chartRead({ symbol: 'BATS:AMD' });
    const { quote } = await getSnapshot({ _deps: deps({ read })._deps });
    assert.equal(quote.day, null);
  });

  it('does not open the watchlist when its panel is closed', async () => {
    const { _deps, calls } = deps({ read: chartRead({ watchlist_rows: 0 }) });
    const snap = await getSnapshot({ _deps });
    assert.equal(calls.watchlist, 0);
    assert.equal(snap.watchlist.available, false);
    assert.match(snap.watchlist.error, /Watchlist panel is closed/);
    assert.equal(snap.quote.day, null);
  });

  it('reports a failed section and still returns the rest', async () => {
    const { _deps } = deps({
      watchlist: new Error('panel gone'),
      options: new Error('No options chain page is open for "BATS:TSLA".'),
      studies: new Error('boom'),
    });
    const snap = await getSnapshot({ _deps });
    assert.equal(snap.success, true);
    assert.deepEqual(snap.watchlist, { available: false, error: 'panel gone' });
    assert.deepEqual(snap.options, { available: false, error: 'No options chain page is open for "BATS:TSLA".' });
    assert.equal(snap.studies, null);
    assert.deepEqual(snap.errors, { watchlist: 'panel gone', options: 'No options chain page is open for "BATS:TSLA".', studies: 'boom' });
    assert.equal(snap.quote.last, 385.86);
  });

  it('reads every strike of the nearest expirations for the chart symbol', async () => {
    const { _deps, calls } = deps();
    await getSnapshot({ _deps });
    assert.deepEqual(calls.options, [{ symbol: 'BATS:TSLA', around_atm: 0, max_expirations: 3 }]);

    const two = deps();
    await getSnapshot({ expirations: 2, _deps: two._deps });
    assert.equal(two.calls.options[0].max_expirations, 2);

    for (const expirations of [0, -1, 2.5, 'abc']) {
      const d = deps();
      await getSnapshot({ expirations, _deps: d._deps });
      assert.equal(d.calls.options[0].max_expirations, 3, `fallback for ${String(expirations)}`);
    }
  });

  it('limits the bars to the requested count', async () => {
    assert.equal((await getSnapshot({ bars: 0, _deps: deps()._deps })).bars.count, 0);
    const two = await getSnapshot({ bars: 2, _deps: deps()._deps });
    assert.deepEqual(two.bars.bars.map(b => b.close), [386.17, 385.86]);
    assert.equal((await getSnapshot({ bars: 5000, _deps: deps()._deps })).bars.count, 4);
    assert.deepEqual(two.bars.bars[0], { time: T0930 / 1000 + 60, open: 387.55, high: 390.10, low: 386.10, close: 386.17, volume: 300 });
  });

  it('keeps the session stats even when few bars are returned', async () => {
    const { bars, quote } = await getSnapshot({ bars: 1, _deps: deps()._deps });
    assert.equal(bars.count, 1);
    assert.equal(quote.session.bars, 3);
    assert.equal(quote.session.vwap, 386.591);
  });

  it('trims the sections with only, but still reads the watchlist for the day change', async () => {
    const { _deps, calls } = deps();
    const snap = await getSnapshot({ only: ['quote'], _deps });
    assert.deepEqual(Object.keys(snap), ['success', 'ts', 'quote']);
    assert.equal(snap.quote.day.change_pct, -1.38);
    assert.equal(calls.watchlist, 1);
    assert.equal(calls.options.length, 0);
    assert.equal(calls.studies, 0);

    const some = await getSnapshot({ only: ['quote', 'studies'], _deps });
    assert.deepEqual(Object.keys(some), ['success', 'ts', 'quote', 'studies']);
  });

  it('rejects an unknown section', async () => {
    await assert.rejects(getSnapshot({ only: ['quote', 'candles'], _deps: deps()._deps }), /Unknown section "candles". Valid sections: quote, watchlist, options, bars, studies/);
  });

  it('has no session stats on a daily chart', async () => {
    const read = chartRead({ resolution: 'D', info: { description: 'Tesla, Inc.', timezone: 'America/New_York', regular_session: '0930-1600' } });
    const { quote } = await getSnapshot({ _deps: deps({ read })._deps });
    assert.equal(quote.resolution, 'D');
    assert.equal(quote.session, null);
  });

  it('fails when the chart has no bars', async () => {
    await assert.rejects(getSnapshot({ _deps: deps({ read: { ...chartRead(), recent: [] } })._deps }), /Could not read chart data\. The chart may still be loading/);
    await assert.rejects(getSnapshot({ _deps: deps({ read: { ...chartRead(), recent: [], error: 'no model' } })._deps }), /Could not read chart data: no model/);
    await assert.rejects(getSnapshot({ _deps: deps({ read: null })._deps }), /Could not read chart data/);
  });

  it('wraps a failed chart read', async () => {
    const { _deps } = deps();
    _deps.evaluate = async () => { throw new Error('boom'); };
    await assert.rejects(getSnapshot({ _deps }), /Could not read the chart: boom/);
  });
});

// ── Poll loop ─────────────────────────────────────────────────────────────

describe('Snapshot — streamSnapshot poll loop', () => {
  function harness(source) {
    const lines = [], waits = [];
    const { _deps } = deps();
    _deps.evaluate = async () => source();
    return { lines, waits, options: { _deps } };
  }

  it('emits one snapshot per interval until count is reached', async () => {
    const h = harness(chartRead);
    const emitted = await streamSnapshot(h.options, { interval: 60000, count: 3, onSnapshot: (s) => h.lines.push(s.success), _sleep: async (ms) => h.waits.push(ms) });
    assert.equal(emitted, 3);
    assert.deepEqual(h.lines, [true, true, true]);
    assert.deepEqual(h.waits, [60000, 60000]);                  // no wait after the last one
  });

  it('emits a failed read as an error line and keeps the cadence', async () => {
    let n = 0;
    const h = harness(() => { if (++n === 2) return { ...chartRead(), recent: [] }; return chartRead(); });
    await streamSnapshot(h.options, { interval: 5000, count: 3, onSnapshot: (s) => h.lines.push(s), _sleep: async (ms) => h.waits.push(ms) });
    assert.deepEqual(h.lines.map(s => s.success), [true, false, true]);
    assert.match(h.lines[1].error, /Could not read chart data/);
    assert.deepEqual(h.waits, [5000, 5000]);
  });

  it('backs off on connection errors', async () => {
    const h = harness(() => { throw new Error('CDP connection failed after 5 attempts'); });
    await streamSnapshot(h.options, { interval: 1000, count: 3, onSnapshot: (s) => h.lines.push(s.success), _sleep: async (ms) => h.waits.push(ms) });
    assert.deepEqual(h.lines, [false, false, false]);
    assert.deepEqual(h.waits, [2000, 4000]);
  });
});
