import { register } from '../router.js';
import * as core from '../../core/snapshot.js';

register('snapshot', {
  description: 'Get a real-time analysis snapshot: quote, watchlist, options summary, recent bars, indicator values (read-only)',
  options: {
    bars: { type: 'string', short: 'n', description: 'Recent bars to include (default 20, max 500, 0 = none)' },
    expirations: { type: 'string', short: 'e', description: 'Nearest option expirations to summarize (default 3)' },
    only: { type: 'string', short: 'o', description: 'Comma-separated sections: quote,watchlist,options,bars,studies' },
    interval: { type: 'string', short: 'i', description: 'Emit a snapshot every N ms until Ctrl+C (default 60000). Omit for a single JSON object' },
    count: { type: 'string', short: 'c', description: 'Stop after N snapshots (needs --interval)' },
  },
  handler: async (opts) => {
    const numbers = {};
    for (const name of ['bars', 'expirations', 'interval', 'count']) {
      if (opts[name] !== undefined) {
        numbers[name] = Number(opts[name]);
        if (!Number.isFinite(numbers[name])) throw new Error(`--${name} must be a number, got: ${opts[name]}`);
      }
    }
    if (numbers.count !== undefined && numbers.interval === undefined) throw new Error('--count needs --interval');
    const options = {
      bars: numbers.bars,
      expirations: numbers.expirations,
      only: opts.only ? opts.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
    };
    if (numbers.interval === undefined) return core.getSnapshot(options);

    // Like `tv stream`: writes JSONL to stdout until stopped, never returns through the router.
    process.stderr.write(`[stream:snapshot] started, interval=${numbers.interval}ms, Ctrl+C to stop\n`);
    const emitted = await core.streamSnapshot(options, {
      interval: numbers.interval,
      count: numbers.count ?? Infinity,
    });
    process.stderr.write(`[stream:snapshot] stopped after ${emitted} snapshot(s)\n`);
    process.exit(0);
  },
});
