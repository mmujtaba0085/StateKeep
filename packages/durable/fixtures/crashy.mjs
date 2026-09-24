// Used by test.js: a workflow whose process dies in the middle of step "b".
import { appendFileSync } from 'node:fs';
import { createEngine } from '../index.js';

export const crashy = {
  v1: async (ctx, input) => {
    await ctx.step('a', () => appendFileSync(input.log, 'a\n'));
    await ctx.step('b', () => {
      if (process.env.CRASH_IN_B) process.exit(9);            // power cut mid-step
      appendFileSync(input.log, 'b\n');
    });
    return 'finished';
  },
};

if (process.argv[2]) {                                         // node crashy.mjs <url> <log>
  const engine = createEngine({ url: process.argv[2], workflows: { crashy } });
  await engine.start('crashy', { log: process.argv[3] });
}
