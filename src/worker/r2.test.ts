import { describe, expect, it, vi } from "vitest";
import { conditionalGetStatus, deleteR2AttemptArtifactKeys, deleteR2AttemptArtifacts, normalizeR2Range } from "./r2";

describe("R2 attempt cleanup", () => {
  it("scans once and deletes only the requested artifacts through the current attempt", async () => {
    const list = vi.fn(async () => ({
      objects: [
        { key: "jobs/job-1/attempts/1/documents/old.bin" },
        { key: "jobs/job-1/attempts/1/output/keep.bin" },
        { key: "jobs/job-1/attempts/2/documents/current.bin" },
        { key: "jobs/job-1/attempts/3/documents/future.bin" },
      ],
      truncated: false,
    }));
    const deleteObjects = vi.fn(async (_keys: string | string[]) => undefined);
    const bucket = { list, delete: deleteObjects } as unknown as R2Bucket;

    await deleteR2AttemptArtifacts(bucket, "jobs/job-1", 2, "documents/");

    expect(list).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledWith({ prefix: "jobs/job-1/attempts/" });
    expect(deleteObjects).toHaveBeenCalledWith([
      "jobs/job-1/attempts/1/documents/old.bin",
      "jobs/job-1/attempts/2/documents/current.bin",
    ]);
  });

  it("batches deterministic attempt keys without listing every attachment prefix", async () => {
    const deleteObjects = vi.fn(async (_keys: string | string[]) => undefined);
    const list = vi.fn();
    const bucket = { list, delete: deleteObjects } as unknown as R2Bucket;
    const artifacts = Array.from({ length: 501 }, (_, index) => ({
      rootPrefix: `assets/workspace/attachment-${index}`,
      artifactPath: "hash",
    }));

    await deleteR2AttemptArtifactKeys(bucket, artifacts, 2);

    expect(list).not.toHaveBeenCalled();
    expect(deleteObjects).toHaveBeenCalledTimes(2);
    expect(deleteObjects.mock.calls[0]![0]).toHaveLength(1_000);
    expect(deleteObjects.mock.calls[1]![0]).toHaveLength(2);
    expect(deleteObjects.mock.calls[0]![0]).toContain("assets/workspace/attachment-0/attempts/1/hash");
    expect(deleteObjects.mock.calls[1]![0]).toContain("assets/workspace/attachment-500/attempts/2/hash");
  });
});

describe("R2 range normalization", () => {
  it("normalizes bounded ranges", () => {
    expect(normalizeR2Range({ offset: 100, length: 50 }, 1_000)).toEqual({ offset: 100, length: 50 });
  });

  it("handles R2 runtime objects that expose an undefined suffix getter", () => {
    const runtimeRange = { offset: 2, length: 4, suffix: undefined } as unknown as R2Range;
    expect(normalizeR2Range(runtimeRange, 10)).toEqual({ offset: 2, length: 4 });
  });

  it("normalizes open-ended ranges", () => {
    expect(normalizeR2Range({ offset: 100 }, 1_000)).toEqual({ offset: 100, length: 900 });
  });

  it("normalizes suffix ranges", () => {
    expect(normalizeR2Range({ suffix: 500 }, 1_000)).toEqual({ offset: 500, length: 500 });
  });

  it("clamps oversized suffixes and bounded ranges to the object", () => {
    expect(normalizeR2Range({ suffix: 5_000 }, 1_000)).toEqual({ offset: 0, length: 1_000 });
    expect(normalizeR2Range({ offset: 900, length: 500 }, 1_000)).toEqual({ offset: 900, length: 100 });
  });
});

describe("R2 conditional response status", () => {
  const object = { httpEtag: '"current"', uploaded: new Date("2026-08-14T12:00:00Z") };

  it("returns 304 for matching cache validators", () => {
    expect(conditionalGetStatus(new Headers({ "if-none-match": '"current"' }), object)).toBe(304);
    expect(conditionalGetStatus(new Headers({ "if-none-match": 'W/"current"' }), object)).toBe(304);
    expect(
      conditionalGetStatus(
        new Headers({
          "if-modified-since": "Fri, 14 Aug 2026 12:00:00 GMT",
        }),
        object,
      ),
    ).toBe(304);
  });

  it("continues a GET when cache validators do not match", () => {
    expect(conditionalGetStatus(new Headers({ "if-none-match": '"different"' }), object)).toBe(200);
    expect(
      conditionalGetStatus(
        new Headers({
          "if-modified-since": "Fri, 14 Aug 2026 11:00:00 GMT",
        }),
        object,
      ),
    ).toBe(200);
  });

  it("returns 412 for failed preconditions", () => {
    expect(conditionalGetStatus(new Headers({ "if-match": '"different"' }), object)).toBe(412);
    expect(
      conditionalGetStatus(
        new Headers({
          "if-unmodified-since": "Fri, 14 Aug 2026 11:00:00 GMT",
        }),
        object,
      ),
    ).toBe(412);
  });

  it("uses strong comparison for If-Match before evaluating cache validators", () => {
    expect(
      conditionalGetStatus(
        new Headers({
          "if-match": 'W/"current"',
          "if-none-match": '"current"',
        }),
        object,
      ),
    ).toBe(412);
  });

  it("does not split commas inside entity tags", () => {
    const commaObject = { ...object, httpEtag: '"revision,2"' };

    expect(
      conditionalGetStatus(
        new Headers({
          "if-none-match": '"different", W/"revision,2"',
        }),
        commaObject,
      ),
    ).toBe(304);
    expect(
      conditionalGetStatus(
        new Headers({
          "if-match": '"different", "revision,2"',
        }),
        commaObject,
      ),
    ).toBe(200);
    expect(
      conditionalGetStatus(
        new Headers({
          "if-match": '"different", W/"revision,2"',
        }),
        commaObject,
      ),
    ).toBe(412);
  });

  it("treats wildcard conditions as a match", () => {
    expect(conditionalGetStatus(new Headers({ "if-match": "*" }), object)).toBe(200);
    expect(conditionalGetStatus(new Headers({ "if-none-match": "*" }), object)).toBe(304);
  });

  it("ignores empty entity-tag list members", () => {
    expect(conditionalGetStatus(new Headers({ "if-none-match": `"current",` }), object)).toBe(304);
    expect(conditionalGetStatus(new Headers({ "if-match": `"current",` }), object)).toBe(200);
    expect(conditionalGetStatus(new Headers({ "if-match": " , " }), object)).toBe(412);
    expect(conditionalGetStatus(new Headers({ "if-none-match": " , " }), object)).toBe(200);
  });
});
