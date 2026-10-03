/**
 * 数据库 schema。迁移语句按顺序执行，记录到 schema_migrations。
 * 生产用 PostgreSQL 16，测试用 PGlite（同一套 DDL）。
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE species (
  id   SMALLSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 基准版本：draft 可编辑，published 只读；同树种版本号唯一
CREATE TABLE schedule_versions (
  id           SERIAL PRIMARY KEY,
  species_id   SMALLINT NOT NULL REFERENCES species(id),
  version      INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','published')),
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  UNIQUE (species_id, version)
);
CREATE INDEX idx_versions_species_status ON schedule_versions(species_id, status);

CREATE TABLE schedule_stages (
  version_id    INTEGER NOT NULL REFERENCES schedule_versions(id) ON DELETE CASCADE,
  stage_no      INTEGER NOT NULL CHECK (stage_no >= 1),
  mc_threshold  NUMERIC(5,2),           -- 进入条件含水率%；第1阶段为 NULL
  dry_bulb_c    NUMERIC(5,2) NOT NULL,
  wet_bulb_c    NUMERIC(5,2) NOT NULL,
  PRIMARY KEY (version_id, stage_no)
);

-- 厚度等级（按树种维护编码，如 THICK=厚板）
CREATE TABLE thickness_grades (
  id         SERIAL PRIMARY KEY,
  species_id SMALLINT NOT NULL REFERENCES species(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  label      TEXT NOT NULL,
  UNIQUE (species_id, code)
);

-- 厚度覆盖：只写与基础表不同的格子，NULL 表示继承
CREATE TABLE stage_overrides (
  grade_id     INTEGER NOT NULL REFERENCES thickness_grades(id) ON DELETE CASCADE,
  version_id   INTEGER NOT NULL REFERENCES schedule_versions(id) ON DELETE CASCADE,
  stage_no     INTEGER NOT NULL,
  mc_threshold NUMERIC(5,2),
  dry_bulb_c   NUMERIC(5,2),
  wet_bulb_c   NUMERIC(5,2),
  PRIMARY KEY (grade_id, version_id, stage_no),
  CHECK (
    mc_threshold IS NOT NULL OR dry_bulb_c IS NOT NULL OR wet_bulb_c IS NOT NULL
  )
);

CREATE TABLE kilns (
  id   SMALLSERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

-- 一批料：开跑时绑定当时的有效版本（published），一直跑到结束
CREATE TABLE batches (
  id                 SERIAL PRIMARY KEY,
  kiln_id            SMALLINT NOT NULL REFERENCES kilns(id),
  species_id         SMALLINT NOT NULL REFERENCES species(id),
  version_id         INTEGER NOT NULL REFERENCES schedule_versions(id),
  thickness_grade_id INTEGER REFERENCES thickness_grades(id),
  initial_weight_g   NUMERIC(10,2) NOT NULL,
  initial_mc_pct     NUMERIC(5,2) NOT NULL,
  drying_k_per_hour  NUMERIC(6,4) NOT NULL DEFAULT 0.0500,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ
);
CREATE INDEX idx_batches_kiln ON batches(kiln_id);

-- 读数：记录编号全局唯一，重复上报由唯一约束拒绝
CREATE TABLE readings (
  record_no   BIGINT PRIMARY KEY,
  kiln_id     SMALLINT NOT NULL REFERENCES kilns(id),
  recorded_at TIMESTAMPTZ NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('psychro','weight')),
  dry_bulb_c  NUMERIC(5,2),
  wet_bulb_c  NUMERIC(5,2),
  weight_g    NUMERIC(10,2),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT readings_shape CHECK (
    (kind = 'psychro' AND dry_bulb_c IS NOT NULL AND wet_bulb_c IS NOT NULL AND weight_g IS NULL)
    OR
    (kind = 'weight' AND weight_g IS NOT NULL AND dry_bulb_c IS NULL AND wet_bulb_c IS NULL)
  )
);
CREATE INDEX idx_readings_kiln_time ON readings(kiln_id, recorded_at);
`,
  },
  {
    version: 2,
    sql: `
-- 初始数据：六座窑
INSERT INTO kilns (id, name) VALUES
  (1,'1号窑'),(2,'2号窑'),(3,'3号窑'),
  (4,'4号窑'),(5,'5号窑'),(6,'6号窑');

-- 示例树种与已发布基准（橡木含“厚板”厚度层，模拟现网场景）
INSERT INTO species (id, name) VALUES (1,'橡木'),(2,'松木');

INSERT INTO schedule_versions (id, species_id, version, status, published_at, note)
VALUES (1,1,1,'published', now(), '橡木基础基准');
INSERT INTO schedule_stages (version_id, stage_no, mc_threshold, dry_bulb_c, wet_bulb_c) VALUES
  (1,1, NULL, 60, 56),
  (1,2, 40.00, 65, 57),
  (1,3, 30.00, 70, 58),
  (1,4, 20.00, 75, 62),
  (1,5, 12.00, 80, 68);

INSERT INTO thickness_grades (id, species_id, code, label) VALUES (1,1,'THICK','厚板(≥50mm)');
INSERT INTO stage_overrides (grade_id, version_id, stage_no, mc_threshold, dry_bulb_c, wet_bulb_c) VALUES
  (1,1,2, NULL, 60, NULL),
  (1,1,3, NULL, 65, NULL),
  (1,1,4, NULL, 70, NULL);

INSERT INTO schedule_versions (id, species_id, version, status, published_at, note)
VALUES (2,2,1,'published', now(), '松木基础基准');
INSERT INTO schedule_stages (version_id, stage_no, mc_threshold, dry_bulb_c, wet_bulb_c) VALUES
  (2,1, NULL, 55, 52),
  (2,2, 35.00, 60, 54),
  (2,3, 25.00, 68, 58),
  (2,4, 15.00, 75, 65);
SELECT setval(pg_get_serial_sequence('species','id'), 2, true);
SELECT setval(pg_get_serial_sequence('schedule_versions','id'), 2, true);
SELECT setval(pg_get_serial_sequence('thickness_grades','id'), 1, true);
`,
  },
];
