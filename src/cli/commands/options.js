import { register } from '../router.js';
import * as core from '../../core/options.js';

register('options', {
  description: 'Options chain tools (chain)',
  subcommands: new Map([
    ['chain', {
      description: 'Read the options chain from an already-open TradingView options-chain page',
      options: {
        symbol: { type: 'string', short: 's', description: 'Underlying (e.g., TSLA or NASDAQ:TSLA). Omit when one chain page is open' },
        expiration: { type: 'string', short: 'e', description: 'Single expiration: YYYYMMDD, YYYY-MM-DD or a label fragment' },
        around: { type: 'string', short: 'n', description: 'Strikes around the underlying price per expiration (default 6, 0 = all)' },
        expirations: { type: 'string', short: 'm', description: 'Nearest expirations to return (default 4)' },
        fields: { type: 'string', short: 'f', description: 'core (default) or all' },
      },
      handler: (opts) => core.getOptionsChain({
        symbol: opts.symbol,
        expiration: opts.expiration,
        around_atm: opts.around,
        max_expirations: opts.expirations,
        fields: opts.fields,
      }),
    }],
  ]),
});
