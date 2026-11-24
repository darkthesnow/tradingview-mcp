import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/options.js';

export function registerOptionsTools(server) {
  server.tool('options_get_chain', 'Read the options chain from an already-open TradingView options-chain page (per strike and side: bid/ask, IV, Greeks, volume, open interest). Read-only — it never opens, navigates or clicks, so open the symbol\'s options chain (Options tab) in TradingView Desktop first. Only the expiration expanded on the page carries displayed bid/ask, volume and open interest; other expirations get bid/ask from the page\'s calculation model and null volume/openInterest (see notes). Percent fields are in percent units; underlying_close is the price the page computes distance and breakeven from.', {
    symbol: z.string().optional().describe('Underlying to read (e.g., "TSLA" or "NASDAQ:TSLA"). Omit when only one options chain page is open.'),
    expiration: z.string().optional().describe('Single expiration: YYYYMMDD, YYYY-MM-DD or a label fragment ("Nov 25"). Omit for the nearest max_expirations.'),
    around_atm: z.coerce.number().optional().describe('Strikes around the underlying price per expiration (default 6, 0 = every loaded strike)'),
    max_expirations: z.coerce.number().optional().describe('Nearest expirations to return when expiration is omitted (default 4)'),
    fields: z.enum(['core', 'all']).optional().describe('core (default): bid, ask, volume, openInterest, iv, theoPrice, delta, gamma, theta, vega, rho, breakeven. all: also ltp, volumeOiRatio, spread, bidIv/askIv, ivSpread, intrinsic/extrinsic, distance and more'),
  }, async ({ symbol, expiration, around_atm, max_expirations, fields }) => {
    try { return jsonResult(await core.getOptionsChain({ symbol, expiration, around_atm, max_expirations, fields })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
