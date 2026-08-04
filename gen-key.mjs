import { createApiKey } from './src/registry/apiKeyRepo.js';

const label = process.argv[2] || 'default';
const result = await createApiKey({ label });

console.log(`API key "${label}" created (save this — shown once):`);
console.log(result.rawKey);
