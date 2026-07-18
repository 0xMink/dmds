/* Runner acceptance fixture — NOT a product suite. Simulates the two
   failure classes so tests/run.sh's stop/propagate/archive behavior is
   itself tested, not just inspected:
     node tests/fail-fixture.js            → exit 1 (assertion failure)
     FIXTURE_MODE=harness node ...         → exit 2 (harness failure) */
(async () => {
  if (process.env.FIXTURE_MODE === 'harness') throw new Error('simulated launch failure');
  console.log('  FAIL fixture:always-fails simulated assertion');
  console.log('FIXTURE: FAIL');
  process.exit(1);
})().catch(e => { console.error('FIXTURE RUN FAILED', e); process.exit(2); });
