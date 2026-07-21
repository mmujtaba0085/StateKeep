// Benchmark matrix configuration.
// Each axis is swept independently with all other variables at baseline.

export const BASELINE = {
  machine:     'simple',
  durability:  'buffered',
  encryption:  'off',
  concurrency: 1,
  context:     'none',
  migration:   'idle',
};

export const AXES = {
  machine:     { values: ['simple', 'complex'],              label: 'Machine Complexity'  },
  durability:  { values: ['buffered', 'sync', 'async'],      label: 'Durability Mode'     },
  encryption:  { values: ['off', 'on'],                      label: 'Encryption'          },
  concurrency: { values: [1, 10, 50, 100],                   label: 'Concurrency (actors)'},
  context:     { values: ['none', 'small', 'large'],         label: 'Context Size'        },
  migration:   { values: ['idle', 'active'],                 label: 'Migration Registry'  },
};

export const TIMING = {
  warmupSecs:  parseInt(process.env.WARMUP_SECS  ?? '2',  10),
  measureSecs: parseInt(process.env.MEASURE_SECS ?? '10', 10),
};

// Context payloads passed as initialContext when spawning actors.
// The blob is stored encrypted (if on) and decrypted on every event.
export const CONTEXT_PAYLOADS = {
  none:  null,
  small: { id: 'bench', data: 'x'.repeat(80) },                    // ~100B
  large: { id: 'bench', payload: 'x'.repeat(4800), ts: 0 },        // ~5KB
};
