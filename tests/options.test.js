/**
 * Options chain unit tests — no TradingView connection needed.
 * Tests: number parsing, chain page selection, expiration lookup, shaping of the raw page
 * read, and the CDP plumbing through injected deps.
 *
 * Run: node --test tests/options.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getOptionsChain, shapeChain, parseNumber, parseCell,
  optionsPageSymbol, pickOptionsPage, findExpiration, daysToExpiration,
} from '../src/core/options.js';

const NOW = new Date('2026-11-24T13:00:00Z');    // 08:00 in New York
const CORE_FIELDS = ['bid', 'ask', 'volume', 'openInterest', 'iv', 'theoPrice', 'delta', 'gamma', 'theta', 'vega', 'rho', 'breakeven'];

// What READ_PAGE_JS returns for a two-expiration chain whose first expiration is expanded.
// In the expanded group the model-backed columns (theoPrice, iv, delta, breakeven, distance)
// match the rendered cells, while bid/ask/volume/open interest differ — as on the live page.
function pageFixture() {
  const model = (over = {}) => ({
    bid: '4.05', ask: '6.00', volume: '—', openInterest: '—', ltp: '—',
    theoPrice: '9.40', iv: '99.31%', bid_iv: '41.16%', ask_iv: '62.38%', intrinsic: '0.46', extrinsic: '8.94',
    delta: '0.52', gamma: '0.017', theta: '−3.51', vega: '0.09', rho: '0.01', breakeven: '394.40', distance: '0.46',
    ...over,
  });
  const putModel = (over = {}) => model({ delta: '−0.48', theta: '−3.47', rho: '−0.01', breakeven: '376.10', ...over });
  const row = (exp, strike, call, put) => ({
    strike,
    callId: `OPRA:TSLA${exp}C${strike.toFixed(1)}`,
    putId: `OPRA:TSLA${exp}P${strike.toFixed(1)}`,
    call: model(call),
    put: putModel(put),
  });
  const underlying = { name: 'NASDAQ:TSLA', close: 385.46, currency: 'USD' };
  return {
    sideCols: ['openInterest', 'volume', 'distance', 'bidAsk', 'theor', 'iv', 'breakeven', 'delta'],
    centralCols: ['strike'],
    groups: [
      {
        seriesId: 'NASDAQ:TSLA;TSLA;20261125',
        serie: { exp: 20261125, label: 'Nov 25, 2026 (1) TSLA' },
        underlying,
        rows: [
          row('261125', 380, { theoPrice: '12.30', iv: '100.89%', delta: '0.61', breakeven: '392.30', distance: '5.46', bid: '6.20' },
            { theoPrice: '6.80', iv: '100.89%', delta: '−0.39', breakeven: '373.20', distance: '5.46' }),
          row('261125', 385, {}, {}),
          row('261125', 390, { theoPrice: '6.90', iv: '55.57%', delta: '0.45', breakeven: '396.90', distance: '4.54' },
            { theoPrice: '11.60', iv: '55.57%', delta: '−0.55', breakeven: '378.40', distance: '4.54' }),
        ],
      },
      {
        seriesId: 'NASDAQ:TSLA;TSLA;20261127',
        serie: { exp: 20261127, label: 'Nov 27, 2026 (3) TSLA' },
        underlying,
        rows: [row('261127', 385, {}, {}), row('261127', 390, { delta: '0.45' }, { delta: '−0.55' })],
      },
    ],
    sections: [
      {
        header: 'November 25 1 DTE',
        rows: [
          ['0.61', '392.30', '100.89%', '12.30', '6.40 × 8.60', '5.46', '3,321 4.08', '814', '380.0', '1,437', '6,263 4.36', '5.46', '6.70 × 7.30', '6.80', '100.89%', '373.20', '−0.39', ''],
          ['TSLA 385.46 USD', ''],
          ['0.52', '394.40', '99.31%', '9.40', '4.80 × 6.00', '0.46', '3,457 4.97', '695', '385.0', '1,311', '9,501 7.25', '0.46', '8.00 × 10.00', '8.90', '99.31%', '376.10', '−0.48', ''],
          ['0.45', '396.90', '55.57%', '6.90', '2.90 × 4.75', '4.54', '10,001 6.68', '1,498', '390.0', '136', '6,530 48.01', '4.54', '9.00 × 15.00', '11.60', '55.57%', '378.40', '−0.55', ''],
        ],
      },
      { header: 'November 27 3 DTE', rows: [] },
    ],
  };
}

const chainTargets = [
  { id: 'chart-1', type: 'page', url: 'https://www.tradingview.com/chart/VlPL9EFC/' },
  { id: 'chain-1', type: 'page', url: 'https://www.tradingview.com/symbols/NASDAQ-TSLA/options-chain/' },
  { id: 'devtools-1', type: 'other', url: 'devtools://devtools/bundled/devtools_app.html' },
];

function deps(page, targets = chainTargets) {
  const calls = { opened: [], closed: 0 };
  return {
    calls,
    _deps: {
      listTargets: async () => targets,
      openTarget: async (t) => {
        calls.opened.push(t.id);
        return { evaluate: async () => page, close: async () => { calls.closed++; } };
      },
    },
  };
}

describe('Options — number parsing', () => {
  it('parses the display formats the chain page uses', () => {
    assert.equal(parseNumber('3,457'), 3457);
    assert.equal(parseNumber('−0.48'), -0.48);
    assert.equal(parseNumber('104.27%'), 104.27);
    assert.equal(parseNumber('1,311'), 1311);
  });

  it('returns null for empty and placeholder values', () => {
    for (const text of ['—', '-', '–', '', '   ', 'N/A', null, undefined]) {
      assert.equal(parseNumber(text), null, `expected null for ${JSON.stringify(text)}`);
    }
  });

  it('extracts one number per part of a combined cell, keeping empty parts in place', () => {
    assert.deepEqual(parseCell('4.50 × 6.05'), [4.5, 6.05]);
    assert.deepEqual(parseCell('4.50×6.05'), [4.5, 6.05]);
    assert.deepEqual(parseCell('3,457 4.97'), [3457, 4.97]);
    assert.deepEqual(parseCell('4.50 × —'), [4.5, null]);
    assert.deepEqual(parseCell('— 4.97'), [null, 4.97]);
    assert.deepEqual(parseCell('—'), []);
  });
});

describe('Options — chain page selection', () => {
  it('recognizes only options-chain pages', () => {
    assert.equal(optionsPageSymbol(chainTargets[1]), 'NASDAQ-TSLA');
    assert.equal(optionsPageSymbol(chainTargets[0]), null);
    assert.equal(optionsPageSymbol({ type: 'page', url: 'https://www.tradingview.com/symbols/NYSE-BRK.B/options-chain/' }), 'NYSE-BRK.B');
  });

  it('picks the only open chain page when symbol is omitted', () => {
    assert.equal(pickOptionsPage(chainTargets).id, 'chain-1');
  });

  it('matches a bare or a full symbol, case-insensitively', () => {
    const targets = [...chainTargets, { id: 'chain-2', type: 'page', url: 'https://www.tradingview.com/symbols/CBOE-SPX/options-chain/' }];
    assert.equal(pickOptionsPage(targets, 'tsla').id, 'chain-1');
    assert.equal(pickOptionsPage(targets, 'nasdaq:tsla').id, 'chain-1');
    assert.equal(pickOptionsPage(targets, 'CBOE:SPX').id, 'chain-2');
  });

  it('errors with the open chain pages when none matches', () => {
    assert.throws(() => pickOptionsPage(chainTargets, 'AAPL'), /No options chain page is open for "AAPL".*NASDAQ-TSLA/);
    assert.throws(() => pickOptionsPage(chainTargets, 'NASDAQ:AAPL'), /No options chain page is open/);
  });

  it('asks for a symbol when several chain pages are open', () => {
    const targets = [...chainTargets, { id: 'chain-2', type: 'page', url: 'https://www.tradingview.com/symbols/CBOE-SPX/options-chain/' }];
    assert.throws(() => pickOptionsPage(targets), /Multiple options chain pages are open \(NASDAQ-TSLA, CBOE-SPX\)/);
  });

  it('errors when TradingView has no chain page open', () => {
    assert.throws(() => pickOptionsPage([chainTargets[0], chainTargets[2]]), /No options chain page is open in TradingView Desktop/);
  });
});

describe('Options — expiration lookup', () => {
  const { groups } = pageFixture();

  it('accepts YYYYMMDD, YYYY-MM-DD and a label fragment', () => {
    assert.equal(findExpiration(groups, '20261127'), 1);
    assert.equal(findExpiration(groups, '2026-11-27'), 1);
    assert.equal(findExpiration(groups, 'nov 27'), 1);
  });

  it('lists the available expirations when not found', () => {
    assert.throws(() => findExpiration(groups, '20990101'), /not found. Available: 2026-11-25, 2026-11-27\.$/);
  });

  it('counts calendar days in New York', () => {
    assert.equal(daysToExpiration(20261125, NOW), 1);
    assert.equal(daysToExpiration(20261127, NOW), 3);
    assert.equal(daysToExpiration(20261125, new Date('2026-11-25T04:59:00Z')), 1);   // still Nov 24 in New York
    assert.equal(daysToExpiration(20261125, new Date('2026-11-25T05:00:00Z')), 0);
    assert.equal(daysToExpiration('n/a', NOW), null);
  });
});

describe('Options — shaping the page read', () => {
  it('returns core fields for the nearest expirations', () => {
    const result = shapeChain(pageFixture(), { now: NOW });
    assert.equal(result.success, true);
    assert.equal(result.symbol, 'NASDAQ:TSLA');
    assert.equal(result.underlying_close, 385.46);
    assert.equal(result.currency, 'USD');
    assert.equal(result.expiration_count, 2);
    assert.equal(result.expirations_returned, 2);
    assert.deepEqual(result.fields, CORE_FIELDS);
    assert.deepEqual(result.expirations.map(e => [e.expiration, e.dte, e.expanded, e.strike_count]), [
      ['2026-11-25', 1, true, 3],
      ['2026-11-27', 3, false, 2],
    ]);
  });

  it('takes bid/ask, volume and open interest from the rendered table of the expanded expiration', () => {
    const [first] = shapeChain(pageFixture(), { now: NOW }).expirations;
    assert.deepEqual(first.rows.map(r => r.strike), [380, 385, 390]);
    assert.deepEqual(first.rows[1].call, {
      symbol: 'OPRA:TSLA261125C385.0',
      bid: 4.8, ask: 6, volume: 3457, openInterest: 695,
      iv: 99.31, theoPrice: 9.4, delta: 0.52, gamma: 0.017, theta: -3.51, vega: 0.09, rho: 0.01, breakeven: 394.4,
    });
    assert.deepEqual(first.rows[1].put, {
      symbol: 'OPRA:TSLA261125P385.0',
      bid: 8, ask: 10, volume: 9501, openInterest: 1311,
      iv: 99.31, theoPrice: 8.9, delta: -0.48, gamma: 0.017, theta: -3.47, vega: 0.09, rho: -0.01, breakeven: 376.1,
    });
  });

  it('returns null where the expanded expiration shows no value', () => {
    const page = pageFixture();
    page.sections[0].rows[3][4] = '2.90 × —';       // no ask shown for the 390 call
    const [first] = shapeChain(page, { now: NOW }).expirations;
    const row = first.rows.find(r => r.strike === 390);
    assert.equal(row.call.bid, 2.9);
    assert.equal(row.call.ask, null);
  });

  it('falls back to the page model for expirations that are not expanded', () => {
    const [, second] = shapeChain(pageFixture(), { now: NOW }).expirations;
    assert.equal(second.expanded, false);
    assert.deepEqual(second.rows[0].call, {
      symbol: 'OPRA:TSLA261127C385.0',
      bid: 4.05, ask: 6, volume: null, openInterest: null,
      iv: 99.31, theoPrice: 9.4, delta: 0.52, gamma: 0.017, theta: -3.51, vega: 0.09, rho: 0.01, breakeven: 394.4,
    });
  });

  it('explains the collapsed expirations and the bid/ask gap in notes', () => {
    const { notes } = shapeChain(pageFixture(), { now: NOW });
    assert.equal(notes.length, 2);
    assert.match(notes[0], /^Not read from the table: 2026-11-27 \(collapsed on the page/);
    assert.match(notes[1], /displayed bid\/ask are returned; for 6 of 6 options they differ/);
  });

  it('keeps strikes around the underlying price', () => {
    const [first] = shapeChain(pageFixture(), { now: NOW, around_atm: 2 }).expirations;
    assert.deepEqual(first.rows.map(r => r.strike), [385, 390]);    // 385.46 → 385 is nearest, then 390
  });

  it('returns a single expiration when asked', () => {
    const result = shapeChain(pageFixture(), { now: NOW, expiration: '2026-11-27' });
    assert.equal(result.expirations_returned, 1);
    assert.equal(result.expirations[0].expiration, '2026-11-27');
    assert.deepEqual(result.expirations[0].rows.map(r => r.strike), [385, 390]);
  });

  it('limits the number of expirations', () => {
    const result = shapeChain(pageFixture(), { now: NOW, max_expirations: 1 });
    assert.deepEqual(result.expirations.map(e => e.expiration), ['2026-11-25']);
  });

  it('adds the remaining model fields with fields: all', () => {
    const [first] = shapeChain(pageFixture(), { now: NOW, expiration: '20261125', around_atm: 1, fields: 'all' }).expirations;
    const { call } = first.rows[0];
    assert.equal(call.bidIv, 41.16);
    assert.equal(call.askIv, 62.38);
    assert.equal(call.volumeOiRatio, 4.97);     // second number of the rendered "3,457 4.97" cell
    assert.equal(call.intrinsic, 0.46);
    assert.equal(call.extrinsic, 8.94);
    assert.equal(call.ltp, null);
    assert.equal('intrinsicExtrinsic' in call, false);
  });

  it('trusts the model alone when the table rows cannot be lined up', () => {
    const page = pageFixture();
    page.sections[0].rows[2][8] = '999.0';       // a strike the model does not have
    const result = shapeChain(page, { now: NOW, expiration: '20261125', around_atm: 1 });
    assert.equal(result.expirations[0].expanded, false);
    assert.equal(result.expirations[0].rows[0].call.bid, 4.05);
    assert.match(result.notes[0], /Not read from the table: 2026-11-25 \(collapsed on the page, or the table could not be matched\)/);
  });

  it('trusts the model alone when the rendered columns disagree with it', () => {
    const page = pageFixture();
    page.sideCols.reverse();                     // columns read in the wrong order
    const result = shapeChain(page, { now: NOW, expiration: '20261125', around_atm: 1 });
    assert.equal(result.expirations[0].expanded, false);
    assert.equal(result.expirations[0].rows[0].call.bid, 4.05);
  });

  it('omits the bid/ask note when the displayed quotes match the model', () => {
    const page = pageFixture();
    for (const row of page.groups[0].rows) {
      const shown = page.sections[0].rows.find(cells => parseFloat(cells[8]) === row.strike);
      [row.call.bid, row.call.ask] = shown[4].split('×').map(s => s.trim());
      [row.put.bid, row.put.ask] = shown[12].split('×').map(s => s.trim());
    }
    const { notes } = shapeChain(page, { now: NOW });
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Not read from the table/);
  });

  it('errors while the chain is missing or still loading', () => {
    assert.throws(() => shapeChain(null), /Options chain table not found/);
    assert.throws(() => shapeChain({ error: 'table' }), /Options chain table not found/);
    assert.throws(() => shapeChain({ error: 'data' }), /Options chain data not found/);
    const empty = pageFixture();
    empty.groups.forEach(g => { g.rows = []; });
    assert.throws(() => shapeChain(empty), /has no strikes yet/);
  });
});

describe('Options — getOptionsChain plumbing', () => {
  it('reads the chain page through its own session and closes it', async () => {
    const { _deps, calls } = deps(pageFixture());
    const result = await getOptionsChain({ expiration: '20261127', _deps });
    assert.equal(result.success, true);
    assert.deepEqual(calls.opened, ['chain-1']);
    assert.equal(calls.closed, 1);
  });

  it('closes the session even when the page read fails', async () => {
    const { _deps, calls } = deps(pageFixture());
    _deps.openTarget = async () => ({ evaluate: async () => { throw new Error('boom'); }, close: async () => { calls.closed++; } });
    await assert.rejects(getOptionsChain({ _deps }), /boom/);
    assert.equal(calls.closed, 1);
  });

  it('reports an unreachable debug port as a connection failure', async () => {
    const { _deps } = deps(pageFixture());
    _deps.listTargets = async () => { throw new Error('fetch failed'); };
    await assert.rejects(getOptionsChain({ _deps }), /CDP connection failed: fetch failed/);
  });

  it('never opens a session when no chain page is open', async () => {
    const { _deps, calls } = deps(pageFixture(), [chainTargets[0]]);
    await assert.rejects(getOptionsChain({ symbol: 'TSLA', _deps }), /No options chain page is open in TradingView Desktop/);
    assert.deepEqual(calls.opened, []);
  });
});
