const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const legacyDirectory = resolve(__dirname, '../dist/src');
mkdirSync(legacyDirectory, { recursive: true });
writeFileSync(resolve(legacyDirectory, 'main.js'), "'use strict';\nrequire('../main.js');\n");
