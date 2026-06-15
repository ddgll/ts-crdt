import { Doc } from "./packages/core/src/index.js";

function runBenchmark() {
  console.log("--- Benchmark: Event Graph Rebuild Time ---");
  const doc = new Doc("replica-1");
  const eventCount = 10000;

  console.log(`Generating ${eventCount} events...`);
  const startTimeGen = performance.now();
  for (let i = 0; i < eventCount; i++) {
    doc.localInsert(["bench-array"], i, [`item-${i}`]);
  }
  const endTimeGen = performance.now();
  console.log(`Generation took ${(endTimeGen - startTimeGen).toFixed(2)}ms`);

  console.log(`Rebuilding state at version with ${eventCount} events...`);
  const version = doc.egWalker.getVersion();
  const startTimeRebuild = performance.now();
  doc.egWalker.rebuildStateAtVersion(version);
  const endTimeRebuild = performance.now();
  
  console.log(`Rebuild took ${(endTimeRebuild - startTimeRebuild).toFixed(2)}ms`);
}

runBenchmark();
