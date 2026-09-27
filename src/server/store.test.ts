import assert from "node:assert/strict";
import { test } from "node:test";
import { activeStorageKind, storageKind } from "./store.ts";

test("readers follow the store chosen at start, not a later env change", async () => {
  const saved = process.env.NEO4J_URI;
  delete process.env.NEO4J_URI;
  try {
    assert.equal(await activeStorageKind(), "file");
    // NEO4J_* added to .env.local while the server runs: the env says neo4j,
    // but writes still go to the file store, so readers must too.
    process.env.NEO4J_URI = "neo4j+s://example.invalid";
    assert.equal(storageKind(), "neo4j");
    assert.equal(await activeStorageKind(), "file");
  } finally {
    if (saved === undefined) delete process.env.NEO4J_URI;
    else process.env.NEO4J_URI = saved;
  }
});
