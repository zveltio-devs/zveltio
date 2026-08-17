import { runScript } from './lib/script-runner.js';

const evil = `
  const fs = await import('node:fs');
  return fs.readFileSync('/etc/hostname', 'utf8');
`;
const res = await runScript(evil, {}, 5000);
console.log('OUTPUT:', JSON.stringify(res.output));
console.log('ERROR:', res.error);
