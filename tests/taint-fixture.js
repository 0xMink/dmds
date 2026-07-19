/* Runner acceptance fixture — a self-TAINTING passing suite: modifies a
   tracked file (tests/taint-canary.txt) during its own run so the
   runner's tree-stability ENFORCEMENT (exit 77, no success banner) can
   be acceptance-tested rather than merely recorded. */
const fs = require('fs'), path = require('path');
fs.appendFileSync(path.join(__dirname, 'taint-canary.txt'), 'tainted mid-run\n');
console.log('  ok   fixture:taints-tracked-file-then-passes');
console.log('FIXTURE TAINT: PASS (1 checks)');
process.exit(0);
