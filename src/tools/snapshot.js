import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/snapshot.js';

export function registerSnapshotTools(server) {
  server.tool('data_get_snapshot', 'Get a real-time analysis snapshot in one read-only call: the chart symbol\'s latest bar, day change and regular-session stats (high, low, volume, VWAP), the watchlist quotes (indices, macro, peers), an options summary (ATM IV, call/put volume and open interest, put/call ratios, max pain) from an open options-chain page, the last N bars and the current values of the chart\'s indicators. Never switches or changes the chart. Poll it (e.g. once a minute) to follow a symbol in real time; trim it with `only` and `bars` when every snapshot lands in your context.', {
    bars: z.coerce.number().optional().describe('Recent bars of the chart\'s timeframe to include (default 20, max 500, 0 = none)'),
    expirations: z.coerce.number().optional().describe('Nearest option expirations to summarize (default 3). Options come from an options-chain page that is already open for the chart symbol; without one the options section reports available: false'),
    only: z.array(z.enum(core.SECTIONS)).optional().describe('Sections to include (default all): quote, watchlist, options, bars, studies'),
  }, async ({ bars, expirations, only }) => {
    try { return jsonResult(await core.getSnapshot({ bars, expirations, only })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
