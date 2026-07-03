import { Doc } from "../packages/core/src/crdtTypes/doc.js";
import { performance } from "perf_hooks";

async function runBenchmarks() {
  console.log("Starting benchmarks...");
  
  // 1. Event graph with 10K events: rebuild time
  console.log("\n--- Benchmark 1: 10K events rebuild time ---");
  const doc = new Doc("replica-1");
  const start10k = performance.now();
  for (let i = 0; i < 10000; i++) {
    doc.getMap().set(`key-${i}`, i);
  }
  const end10kAdd = performance.now();
  console.log(`Added 10,000 events: ${(end10kAdd - start10k).toFixed(2)}ms`);
  
  const startRebuild = performance.now();
  doc.egWalker.rebuildStateAtVersion(doc.egWalker.graph.getVersion());
  const endRebuild = performance.now();
  console.log(`Rebuild state for 10,000 events: ${(endRebuild - startRebuild).toFixed(2)}ms`);

  // 2. 100 concurrent operations: convergence verification
  console.log("\n--- Benchmark 2: 100 concurrent operations convergence ---");
  const replicas = Array.from({ length: 100 }, (_, i) => new Doc(`replica-${i}`));
  const events = [];
  
  const startConcurrent = performance.now();
  for (let i = 0; i < 100; i++) {
    replicas[i].getMap().set(`concurrent-key`, `value-from-${i}`);
    events.push(...replicas[i].egWalker.graph.getChangesSince([]));
  }
  
  // Integrate all events into all replicas
  for (const replica of replicas) {
    replica.egWalker.integrateRemote(events);
  }
  
  // Verify convergence
  const expectedState = JSON.stringify(replicas[0].getMap().toJSON());
  let allConverged = true;
  for (let i = 1; i < 100; i++) {
    if (JSON.stringify(replicas[i].getMap().toJSON()) !== expectedState) {
      allConverged = false;
      break;
    }
  }
  const endConcurrent = performance.now();
  console.log(`100 Replicas processed 100 concurrent events and converged: ${allConverged}`);
  console.log(`Time taken: ${(endConcurrent - startConcurrent).toFixed(2)}ms`);

  // 3. Snapshot serialization/deserialization size and time
  console.log("\n--- Benchmark 3: Snapshot serialization/deserialization ---");
  const startSerialize = performance.now();
  const snapshotState = doc.egWalker.getStateSnapshot();
  const serialized = JSON.stringify(snapshotState);
  const endSerialize = performance.now();
  
  console.log(`Serialized snapshot size: ${(serialized.length / 1024).toFixed(2)} KB`);
  console.log(`Serialization time: ${(endSerialize - startSerialize).toFixed(2)}ms`);
  
  const docToLoad = new Doc("replica-load");
  const startDeserialize = performance.now();
  const parsed = JSON.parse(serialized);
  docToLoad.egWalker.loadStateSnapshot(parsed);
  const endDeserialize = performance.now();
  console.log(`Deserialization & load time: ${(endDeserialize - startDeserialize).toFixed(2)}ms`);
}

runBenchmarks().catch(console.error);
