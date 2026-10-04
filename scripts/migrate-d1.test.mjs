import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digestCollisionSql, main } from "./migrate-d1.mjs";

const pending = "Migrations to be applied:\n0067_review_delivery.sql\n";
const result = (rows) => ({ status: 0, stdout: JSON.stringify([{ success: true, results: rows }]) });
afterEach(() => vi.restoreAllMocks());

describe("Slack migration safety in the deployment wrapper", () => {
  it.each([
    "0069_slack_file_cleanup.sql",
    "0070_slack_review_fences.sql",
    "0072_slack_link_authorization_started_at.sql",
  ])("stops remote %s before preflight or migration application", (migration) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const execute = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: `Migrations to be applied:\n0067_review_delivery.sql\n${migration}\n` });
    expect(main(["--remote", "--env", "production"], execute)).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("manually confirmed safe upgrade"));
  });

  it.each(["--local", "--remote"])("applies confirmed or local migrations: %s", (target) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const execute = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: "Migrations to be applied:\n0069_slack_file_cleanup.sql\n0070_slack_review_fences.sql\n",
      })
      .mockReturnValueOnce({ status: 0 });
    expect(main([target], execute, { slackReviewMigrationSafe: target === "--remote" })).toBe(0);
    expect(execute.mock.calls.at(-1)[0]).toEqual(["d1", "migrations", "apply", "DB", target]);
  });
});

function legacy() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE slack_digest_receipts(id TEXT,subscription_id TEXT,state TEXT,window_start INTEGER,window_end INTEGER);
    CREATE TABLE slack_channel_events(id TEXT,subscription_id TEXT,page_id TEXT,cadence TEXT,created_at INTEGER,delivered_at INTEGER,suppressed_at INTEGER);
    INSERT INTO slack_digest_receipts VALUES ('first','mapping','pending',0,100),('second','mapping','pending',50,150);`);
  const execute = vi.fn((args) => {
    if (args[2] === "list") return { status: 0, stdout: pending };
    if (args[2] === "apply") return { status: 0, stdout: "Applied" };
    return result(db.prepare(args.at(-1)).all());
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  return { db, execute };
}
describe("0067 migration deployment guard", () => {
  it.each([undefined, "450000"])(
    "gives each preflight its own budget and leaves application interactive: %s",
    (timeout) => {
      const { db, execute } = legacy();
      try {
        expect(main(["--remote", ...(timeout ? ["--preflight-timeout-ms", timeout] : [])], execute)).toBe(0);
        expect(execute.mock.calls[0][1]).toEqual({ timeout: 60000, stdio: "pipe" });
        for (const [args, options] of execute.mock.calls.filter(([commandArgs]) => commandArgs[1] === "execute")) {
          expect(args).not.toContain("--preflight-timeout-ms");
          expect(options).toEqual({ timeout: Number(timeout ?? 300000), stdio: "pipe" });
        }
        expect(execute.mock.calls.at(-1)[1]).toEqual({ stdio: "inherit" });
      } finally {
        db.close();
      }
    },
  );
  it.each(["0", "-1", "1.5", "abc", "Infinity", "9007199254740992", undefined])(
    "rejects invalid preflight budgets: %s",
    (value) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const execute = vi.fn();
      expect(main(["--local", "--preflight-timeout-ms", ...(value === undefined ? [] : [value])], execute)).toBe(1);
      expect(execute).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--preflight-timeout-ms"));
    },
  );
  it.each(["migration listing", "migration schema preflight", "digest collision preflight", "migration application"])(
    "reports the failing stage: %s",
    (stage) => {
      const { db, execute } = legacy();
      try {
        const original = execute.getMockImplementation();
        execute.mockImplementation((args, options) => {
          const current =
            args[2] === "list"
              ? "migration listing"
              : args[2] === "apply"
                ? "migration application"
                : args.at(-1) === digestCollisionSql
                  ? "digest collision preflight"
                  : "migration schema preflight";
          return current === stage
            ? { status: null, error: { code: "ETIMEDOUT" }, signal: "SIGTERM" }
            : original(args, options);
        });
        expect(main(["--local"], execute)).toBe(1);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`${stage} timed out`));
      } finally {
        db.close();
      }
    },
  );
  it("rejects duplicate assignments before applying migrations and preserves data", () => {
    const { db, execute } = legacy();
    try {
      db.exec("INSERT INTO slack_channel_events VALUES ('overlap','mapping','page','digest',75,NULL,NULL);");
      const before = db.prepare("SELECT * FROM slack_digest_receipts").all();
      expect(main(["--remote", "--env", "production"], execute)).toBe(1);
      expect(execute.mock.calls.some(([args]) => args[2] === "apply")).toBe(false);
      expect(db.prepare("SELECT * FROM slack_digest_receipts").all()).toEqual(before);
      expect(JSON.parse(console.error.mock.calls[0][0])).toMatchObject({
        collisionCount: 1,
        samples: [{ eventId: "overlap", receipts: ["first", "second"] }],
      });
      expect(execute.mock.calls.every(([args]) => args[1] !== "execute" || /^SELECT|^WITH/.test(args.at(-1)))).toBe(
        true,
      );
    } finally {
      db.close();
    }
  });
  it("allows overlapping windows when their selected events do not overlap", () => {
    const { db, execute } = legacy();
    try {
      db.exec(
        "INSERT INTO slack_channel_events VALUES ('early','mapping','a','digest',25,NULL,NULL),('late','mapping','b','digest',125,NULL,NULL);",
      );
      expect(main(["--local"], execute)).toBe(0);
      expect(execute.mock.calls.at(-1)[0]).toEqual(["d1", "migrations", "apply", "DB", "--local"]);
    } finally {
      db.close();
    }
  });
  it("allows an empty legacy database", () => {
    const { db, execute } = legacy();
    try {
      expect(main(["--local"], execute)).toBe(0);
      expect(execute.mock.calls.at(-1)[0][2]).toBe("apply");
    } finally {
      db.close();
    }
  });
  it("uses legacy cadence, suppression, completion, and half-open window rules", () => {
    const { db, execute } = legacy();
    try {
      db.exec(
        "INSERT INTO slack_channel_events VALUES ('immediate','mapping','a','immediate',75,NULL,NULL),('suppressed','mapping','b','digest',75,NULL,1),('delivered','mapping','c','digest',75,1,NULL),('end','mapping','d','digest',100,NULL,NULL);",
      );
      expect(db.prepare(digestCollisionSql).all()).toEqual([]);
      expect(main(["--local"], execute)).toBe(0);
    } finally {
      db.close();
    }
  });
  it("matches the first-ten-page selection rather than rejecting every window overlap", () => {
    const { db, execute } = legacy();
    try {
      db.exec("INSERT INTO slack_channel_events VALUES ('overlap','mapping','old','digest',75,NULL,NULL);");
      for (let n = 0; n < 10; n++)
        db.prepare("INSERT INTO slack_channel_events VALUES (?, 'mapping',?,'digest',?,NULL,NULL)").run(
          `new-${n}`,
          `new-${n}`,
          101 + n,
        );
      expect(db.prepare(digestCollisionSql).all()).toEqual([]);
      expect(main(["--local"], execute)).toBe(0);
    } finally {
      db.close();
    }
  });
  it("bounds collision samples and receipt identifiers", () => {
    const { db } = legacy();
    try {
      for (let n = 0; n < 12; n++)
        db.prepare("INSERT INTO slack_digest_receipts VALUES (?,'mapping','pending',0,150)").run(`extra-${n}`);
      for (let n = 0; n < 30; n++)
        db.prepare("INSERT INTO slack_channel_events VALUES (?,'mapping','page','digest',75,NULL,NULL)").run(
          `event-${n}`,
        );
      const rows = db.prepare(digestCollisionSql).all();
      expect(rows).toHaveLength(20);
      expect(rows[0].collision_count).toBe(30);
      expect(JSON.parse(rows[0].receipts_json)).toHaveLength(10);
    } finally {
      db.close();
    }
  });
  it.each(["No migrations to apply!", "Migrations to be applied:\n0068_future.sql\n"])(
    "skips digest queries after 0067 was applied: %s",
    (listing) => {
      const execute = vi.fn().mockReturnValueOnce({ status: 0, stdout: listing }).mockReturnValueOnce({ status: 0 });
      expect(main(["--local"], execute)).toBe(0);
      expect(execute.mock.calls).toHaveLength(2);
    },
  );
  it("allows a fresh database without legacy receipts", () => {
    const execute = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: "Migrations to be applied:\n0066_slack_round2.sql\n0067_review_delivery.sql\n",
      })
      .mockReturnValueOnce(result([]))
      .mockReturnValueOnce({ status: 0 });
    expect(main(["--local"], execute)).toBe(0);
    expect(execute.mock.calls.at(-1)[0][2]).toBe("apply");
  });
  it.each([{ status: 1, stdout: "" }, { status: 0, stdout: "not JSON" }, result([{ unexpected: "value" }])])(
    "rejects incomplete or unreadable schema/query output %#",
    (failure) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const execute = vi.fn().mockReturnValueOnce({ status: 0, stdout: pending }).mockReturnValueOnce(failure);
      expect(main(["--local"], execute)).toBe(1);
      expect(execute.mock.calls.some(([args]) => args[2] === "apply")).toBe(false);
    },
  );
  it.each([
    { status: 1, stdout: "" },
    { status: 0, stdout: "not JSON" },
    result([{ event_id: "event", receipt_count: 2, collision_count: 1, receipts_json: "invalid JSON" }]),
    { status: 0, stdout: JSON.stringify([{ results: [] }]) },
  ])("rejects collision-query failures before migration application %#", (failure) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const execute = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: pending })
      .mockReturnValueOnce(result([{ name: "slack_digest_receipts" }, { name: "slack_channel_events" }]))
      .mockReturnValueOnce(failure);
    expect(main(["--local"], execute)).toBe(1);
    expect(execute.mock.calls.some(([args]) => args[2] === "apply")).toBe(false);
  });
  it.each(["", "Unrecognized migration list"])("rejects unreadable migration listings: %s", (stdout) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const execute = vi.fn().mockReturnValue({ status: 0, stdout });
    expect(main(["--local"], execute)).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
  });
});
