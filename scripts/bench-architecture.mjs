#!/usr/bin/env node
/** Development observations only: fresh processes, known counts, no analyzer SLA claim. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { architectureFixture, architectureAnalysis } from '../packages/graph/test/architecture-fixture.ts';
import { reviewArchitecture } from '../packages/graph/dist/index.js';
import { canonicalJson } from '../packages/schema/dist/index.js';
const root = fileURLToPath(new URL('..',import.meta.url));
if (process.argv.includes('--sample')) {
  const paths = Array.from({length:10000},(_,i)=>`src/f${i}.ts`);
  const imports = Array.from({length:100000},(_,i)=>[i%10000,(i%10000+Math.floor(i/10000)+1)%10000,'imports-type']);
  const baseline = architectureFixture('a',paths,imports),current = architectureFixture('b',paths,imports);
  const policy = {format:'atlas.architecture-policy/1',rules:Array.from({length:16},(_,i)=>({id:`rule-${i}`,kind:'forbidden-dependency',from:{paths:['src']},to:{paths:['src']},edgeKinds:['imports-type']}))};
  const start=performance.now();
  const report=reviewArchitecture(architectureAnalysis,current,policy,baseline);
  const bytes=Buffer.byteLength(canonicalJson(report));
  const ms=performance.now()-start;
  assert.equal(current.edges.length,100000);
  assert.equal(report.rows.length,2000);
  assert.equal(report.rowsOmitted,1598000);
  assert(report.rules.every(r=>r.current===100000 && r.baseline===100000 && r.continuing===100000 && r.newlyObserved===0));
  assert.deepEqual(report.reasons,['evidence-limit']);
  console.log(JSON.stringify({ms,bytes,rss:process.memoryUsage().rss}));
} else {
  const runs=[];
  for(let i=0;i<20;i++)runs.push(JSON.parse(execFileSync(process.execPath,[fileURLToPath(import.meta.url),'--sample'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1048576})));
  const times=runs.map(r=>r.ms).sort((a,b)=>a-b);
  const report={recordedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim(),workingTreeDirty:execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8',windowsHide:true}).trim().length>0,node:process.version,cpu:os.cpus()[0]?.model,method:'20 fresh processes; prepare 10,000-file/100,000-edge baseline and current graphs before timing; 16 matching rules, 1,600,000 continuing matches; time includes normalization/evaluation/retention/schema/canonical serialization. No Git/parser/browser/resource-container or reference-hardware acceptance claim.',p50Ms:times[9],p95Ms:times[18],worstMs:times[19],maxRssBytes:Math.max(...runs.map(r=>r.rss)),serializedBytes:runs[0].bytes,retainedRows:2000,rowsOmitted:1598000,runs};
  assert(runs.every(r=>r.bytes===report.serializedBytes));
  await writeFile(new URL('../docs/benchmarks/architecture-review-capacity.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  await writeFile(new URL('../docs/benchmarks/architecture-review-capacity.md',import.meta.url),`# Architecture review: bounded development observations\n\nRecorded ${report.recordedAt}, Node ${report.node}, ${report.cpu}. Source ${report.sourceCommit}; dirty tree: ${report.workingTreeDirty}.\n\n${report.method}\n\n- p50: ${report.p50Ms.toFixed(1)} ms; p95: ${report.p95Ms.toFixed(1)} ms; worst: ${report.worstMs.toFixed(1)} ms.\n- Serialized JSON: ${report.serializedBytes} bytes; 2,000 rows retained and 1,598,000 omitted explicitly. All 16 rules count every 100,000 matches.\n- Largest end-of-sample process RSS: ${report.maxRssBytes} bytes. This is a sampled RSS, not whole-job peak/container evidence.\n\nNo existing analyzer/render budget is redefined. This does not close G6/R6 or establish a new production SLA.\n`);
  console.log(JSON.stringify({p95Ms:report.p95Ms,worstMs:report.worstMs,maxRssBytes:report.maxRssBytes,serializedBytes:report.serializedBytes}));
}
