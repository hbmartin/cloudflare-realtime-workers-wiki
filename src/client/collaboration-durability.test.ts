import { describe, expect, it } from "vitest";
import { CollaborationDurability } from "./collaboration-durability";

describe("collaboration durability", () => {
  it("keeps changes pending until their barrier is acknowledged", () => {
    const durability = new CollaborationDurability();
    durability.markChanged();
    const first = durability.barrierGeneration();
    durability.markChanged();
    const second = durability.barrierGeneration();

    expect(first).toBe(1);
    expect(second).toBe(2);
    durability.acknowledge(first!);
    expect(durability.hasUnsyncedChanges).toBe(true);
    durability.acknowledge(second!);
    expect(durability.hasUnsyncedChanges).toBe(false);
  });

  it("assigns a barrier generation to recoverable IndexedDB state", () => {
    const durability = new CollaborationDurability();
    durability.markChanged();

    expect(durability.hasUnsyncedChanges).toBe(true);
    expect(durability.barrierGeneration()).toBe(1);
  });
});
