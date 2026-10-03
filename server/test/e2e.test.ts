import { afterAll, beforeAll, describe, expect, it } from "vitest";

// E2E：真实 PostgreSQL 16（embedded-postgres）+ Fastify。
// 仅在 RUN_E2E=1 时运行：RUN_E2E=1 npm test
const RUN = process.env.RUN_E2E === "1";
const describeIf = RUN ? describe : describe.skip;

describeIf("E2E（PostgreSQL 16 + HTTP）", () => {
  let app: Awaited<ReturnType<typeof import("../src/index.js").buildServer>>;

  beforeAll(async () => {
    const { rmSync } = await import("node:fs");
    rmSync("/tmp/epg-kiln-e2e", { recursive: true, force: true });
    const EmbeddedPostgres = (await import("embedded-postgres")).default;
    const pg = new EmbeddedPostgres({
      databaseDir: "/tmp/epg-kiln-e2e",
      user: "kiln",
      password: "kilnsecret",
      port: 55432,
      persistent: true,
      initdbFlags: [],
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("kiln_e2e");
    process.env.DATABASE_URL = "postgres://kiln:kilnsecret@localhost:55432/kiln_e2e";

    const { buildServer } = await import("../src/index.js");
    app = await buildServer();
  }, 120_000);

  afterAll(async () => {
    const { pool } = await import("../src/index.js");
    await pool.end();
  });

  const inject = (method: string, url: string, body?: unknown) =>
    app.inject({
      method,
      url,
      payload: body as never,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    });

  const T0 = Date.UTC(2026, 8, 1, 8, 0, 0);
  const at = (h: number, m = 0) => new Date(T0 + (h * 60 + m) * 60000).toISOString();

  it("种子：6 座窑、厚度等级、橡木发布版", async () => {
    const kilns = (await inject("GET", "/api/kilns")).json();
    expect(kilns).toHaveLength(6);
    const grades = (await inject("GET", "/api/thickness-grades")).json();
    expect(grades.map((g: { code: string }) => g.code)).toEqual(["thin", "std", "thick"]);
    const species = (await inject("GET", "/api/species")).json();
    expect(species[0].code).toBe("oak");
    expect(species[0].current_version_id).toBeTruthy();
  });

  it("合并预览 = 发布后有效基准：橡木 v1 厚板覆盖来源标注正确", async () => {
    const versions = (await inject("GET", "/api/species/oak/versions")).json();
    const v = (await inject("GET", `/api/versions/${versions[0].id}`)).json();
    const thick = v.mergedByGrade.thick;
    expect(thick[2].dryBulb).toBe(52);
    expect(thick[2].sources.dryBulb).toBe("override");
    expect(thick[2].wetBulb).toBe(45);
    expect(thick[2].sources.wetBulb).toBe("base");
    expect(thick[3].dryBulb).toBe(60);
    expect(thick[3].wetBulb).toBe(43);
    expect(thick[3].sources.dryBulb).toBe("override");
    // std 全继承
    expect(v.mergedByGrade.std.every((r: { sources: Record<string, string> }) =>
      Object.values(r.sources).every((s) => s === "base"))).toBe(true);
  });

  it("校验：湿球>干球 / 条件不递减 / 温度越界 全部 400 且指出字段", async () => {
    await inject("POST", "/api/species", { code: "pine", name: "松木" });
    const created = (await inject("POST", "/api/species/pine/versions", {})).json();
    const put = (content: unknown) => inject("PUT", `/api/versions/${created.id}`, content);

    const r1 = await put({
      base: [{ stageNo: 1, enterBelow: null, dryBulb: 40, wetBulb: 42 }],
      overridesByGrade: {},
    });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().fields).toContain("base[0].wetBulb");

    const r2 = await put({
      base: [
        { stageNo: 1, enterBelow: null, dryBulb: 45, wetBulb: 42 },
        { stageNo: 2, enterBelow: 30, dryBulb: 50, wetBulb: 45 },
        { stageNo: 3, enterBelow: 30, dryBulb: 55, wetBulb: 45 },
      ],
      overridesByGrade: {},
    });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().fields.some((f: string) => f.includes("enterBelow"))).toBe(true);

    const r3 = await put({
      base: [{ stageNo: 1, enterBelow: null, dryBulb: 121, wetBulb: 42 }],
      overridesByGrade: {},
    });
    expect(r3.statusCode).toBe(400);
    expect(r3.json().fields).toContain("base[0].dryBulb");

    // 合法内容可保存
    const ok = await put({
      base: [
        { stageNo: 1, enterBelow: null, dryBulb: 45, wetBulb: 42 },
        { stageNo: 2, enterBelow: 40, dryBulb: 50, wetBulb: 45 },
      ],
      overridesByGrade: {},
    });
    expect(ok.statusCode).toBe(200);
    // 覆盖了不存在的厚度等级
    const badGrade = await put({
      base: [
        { stageNo: 1, enterBelow: null, dryBulb: 45, wetBulb: 42 },
        { stageNo: 2, enterBelow: 40, dryBulb: 50, wetBulb: 45 },
      ],
      overridesByGrade: { no_such_grade: [{ stageNo: 2, dryBulb: 60 }] },
    });
    expect(badGrade.statusCode).toBe(400);
  });

  it("读数校验：湿球>干球、负称重、不存在的窑/树种 全部拒收", async () => {
    await inject("POST", "/api/kilns/1/start", {
      speciesCode: "oak", thicknessGrade: "std", initialWeightG: 5000, initialMc: 60,
      startedAt: at(0),
    });
    const wet = await inject("POST", "/api/readings", {
      recordNo: 900001, kilnNo: 1, takenAt: at(1), dryBulb: 60, wetBulb: 62,
    });
    expect(wet.statusCode).toBe(400);
    expect(wet.json().fields).toContain("wetBulb");

    const neg = await inject("POST", "/api/readings", {
      recordNo: 900002, kilnNo: 1, takenAt: at(1), weightG: -5,
    });
    expect(neg.statusCode).toBe(400);
    expect(neg.json().fields).toContain("weightG");

    const noKiln = await inject("POST", "/api/readings", {
      recordNo: 900003, kilnNo: 9, takenAt: at(1), weightG: 4000,
    });
    expect(noKiln.statusCode).toBe(400);
    expect(noKiln.json().fields).toContain("kilnNo");

    const noSpecies = await inject("POST", "/api/kilns/2/start", {
      speciesCode: "nope", thicknessGrade: "std", initialWeightG: 5000, initialMc: 60,
    });
    expect(noSpecies.statusCode).toBe(400);
    expect(noSpecies.json().fields).toContain("speciesCode");
  });

  it("核心验收：乱序上报与顺序上报的切换时刻相同；重复不改变结果；重启恢复一致", async () => {
    // 窑1 已开跑（std）。窑2 同样开跑 oak/std。
    const st2 = await inject("POST", "/api/kilns/2/start", {
      speciesCode: "oak", thicknessGrade: "std", initialWeightG: 5000, initialMc: 60,
      startedAt: at(0),
    });
    expect(st2.statusCode).toBe(201);

    const readings = [
      { temp: true, no: 101, h: 1, db: 50, wb: 45 },
      { w: 4300, no: 102, h: 2 },     // 37.6% → 阶段 2
      { temp: true, no: 103, h: 3, db: 55, wb: 45 },
      { w: 4062.5, no: 104, h: 4 },   // 30.0%，不 <30，停留
      { temp: true, no: 105, h: 5, db: 65, wb: 45 },
      { w: 3700, no: 106, h: 6 },     // 18.4% → 阶段 3、4
    ];
    const payload = (kilnNo: number, r: typeof readings[number]) =>
      "temp" in r
        ? { recordNo: r.no * 10 + kilnNo, kilnNo, takenAt: at(r.h), dryBulb: r.db, wetBulb: r.wb }
        : { recordNo: r.no * 10 + kilnNo, kilnNo, takenAt: at(r.h), weightG: r.w };

    // 窑1：顺序上报
    for (const r of readings) {
      const res = await inject("POST", "/api/readings", payload(1, r));
      expect(res.statusCode).toBe(201);
    }
    // 窑2：乱序（先晚后早）
    for (const r of [...readings].reverse()) {
      const res = await inject("POST", "/api/readings", payload(2, r));
      expect(res.statusCode).toBe(201);
    }

    const timeline = async (no: number) => {
      const s = (await inject("GET", `/api/kilns/${no}/state`)).json();
      return {
        currentStage: s.run.currentStage,
        transitions: s.transitions
          .filter((t: { recordNo: number }) => t.recordNo > 0)
          .map((t: { stageNo: number; at: string }) => ({ stageNo: t.stageNo, at: t.at })),
        readings: s.readings.map((r: { sampleMc: number | null }) => r.sampleMc),
      };
    };
    const tl1 = await timeline(1);
    const tl2 = await timeline(2);
    expect(tl1).toEqual(tl2);
    expect(tl1.currentStage).toBe(4);
    expect(tl1.transitions).toEqual([
      { stageNo: 2, at: at(2) },
      { stageNo: 3, at: at(6) },
      { stageNo: 4, at: at(6) },
    ]);

    // 派生量已落库：称重 4062.5 → MC 30；温度行有 RH/EMC
    const s1 = (await inject("GET", "/api/kilns/1/state")).json();
    const w30 = s1.readings.find((r: { weightG: number }) => r.weightG === 4062.5);
    expect(w30.sampleMc).toBeCloseTo(30, 6);
    const tempRow = s1.readings.find((r: { recordNo: string | number }) => Number(r.recordNo) === 1011);
    expect(tempRow).toBeTruthy();
    expect(tempRow.rh).toBeGreaterThan(0);
    expect(tempRow.rh).toBeLessThan(100);
    expect(Math.abs(tempRow.emc - 13.6)).toBeLessThan(5);
    expect(tempRow.rh).toBeLessThan(100);
    expect(Math.abs(tempRow.emc - 13.6)).toBeLessThan(5);

    // 晚到补录一条更早的称重（窑1）：切换时间轴仍然与顺序集合同构
    const backfill = await inject("POST", "/api/readings", {
      recordNo: 199, kilnNo: 1, takenAt: at(1, 30), weightG: 4900, // 56.8%，不切换
    });
    expect(backfill.statusCode).toBe(201);
    const tl1b = await timeline(1);
    expect(tl1b.transitions).toEqual(tl1.transitions);

    // 重复记录：409 且不改变状态
    const dup = await inject("POST", "/api/readings", payload(1, readings[1]!));
    expect(dup.statusCode).toBe(409);
    expect(dup.json().fields).toContain("recordNo");
    expect(await timeline(1)).toEqual(tl1b);

    // 重启恢复：显式全量重放后完全一致
    const replay = await inject("POST", "/api/admin/replay-all", {});
    expect(replay.statusCode).toBe(200);
    expect(await timeline(1)).toEqual(tl1b);
    expect(await timeline(2)).toEqual(tl2);
  });

  it("发布冻结：已发布版本只读；新草稿发布后旧版保留，在跑批次继续引用旧版", async () => {
    const versions = (await inject("GET", "/api/species/oak/versions")).json();
    const pub = versions.find((v: { status: string; supersededAt: string | null }) =>
      v.status === "published" && !v.supersededAt);
    const edit = await inject("PUT", `/api/versions/${pub.id}`, {
      base: [{ stageNo: 1, enterBelow: null, dryBulb: 99, wetBulb: 90 }],
      overridesByGrade: {},
    });
    expect(edit.statusCode).toBe(409);

    // 窑 1 在跑，绑定的是 v1；新建 v2（复制）发布后，窑1 的 state 仍是 v1
    const draft = (await inject("POST", "/api/species/oak/versions", { copyFromCurrent: true })).json();
    const published = await inject("POST", `/api/versions/${draft.id}/publish`, {});
    expect(published.statusCode).toBe(200);
    const s1 = (await inject("GET", "/api/kilns/1/state")).json();
    const all = (await inject("GET", "/api/species/oak/versions")).json();
    const v1 = all.find((v: { versionNo: number }) => v.versionNo === 1);
    expect(Number(s1.schedule.versionId)).toBe(Number(v1.id));
    expect(v1.supersededAt).toBeTruthy();
  });
});
