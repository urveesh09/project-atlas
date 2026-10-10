// A parser stand-in that misbehaves on request, to prove the pool's containment.
//   hang.ts   never answers (deadline)          crash.ts  exits mid-parse
//   oom.ts    allocates until the heap limit    pid.ts    reports its pid, then hangs
//   other     answers with minimal valid facts
process.on('message', (m) => {
  if (m?.type !== 'parse') return;
  if (m.path === 'hang.ts') return;
  if (m.path === 'pid.ts') {
    process.send({ type: 'debug', pid: process.pid });
    return;
  }
  if (m.path === 'crash.ts') process.exit(3);
  if (m.path === 'oom.ts') {
    const hog = [];
    for (;;) hog.push(new Array(1e6).fill(Math.random()));
  }
  process.send({
    type: 'result',
    id: m.id,
    facts: { language: 'typescript', parseStatus: 'parsed', failureReason: null, parseErrors: [], imports: [], declarations: [], declarationsOmitted: 0, physicalLines: 1, codeLines: 1, complexity: { callableCount: 0, maxCyclomatic: 0, sumCyclomatic: 0 }, callables: [], callablesOmitted: 0 },
  });
});
process.send({ type: 'ready' });
