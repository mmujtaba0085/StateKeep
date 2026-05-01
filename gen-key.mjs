import { createApiKey } from './src/registry/apiKeyRepo.js';

const result = await createApiKey({ label: 'admin', tier: 'enterprise' });

console.log('Your API key (save this - shown once):');
console.log(result.rawKey);
