-- 干燥窑控系统初始结构（PostgreSQL 16）
-- 只存“事实”：基准版本、批次、原始读数。派生状态（阶段时间轴、当前阶段、
-- RH/EMC/样板MC）由领域层重放得出，重启后可完整重建。

CREATE TABLE thickness_grades (
  code        TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  sort_order  INT  NOT NULL
);

CREATE TABLE species (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE schedule_versions (
  id              BIGSERIAL PRIMARY KEY,
  species_code    TEXT NOT NULL REFERENCES species(code),
  version_no      INT  NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  -- 发布后内容冻结；被新版本取代时置 superseded_at（旧版本保留，在跑批次继续引用）
  superseded_at   TIMESTAMPTZ,
  -- { base: StageRow[], overridesByGrade: { grade: OverrideRow[] } }
  content         JSONB NOT NULL DEFAULT '{"base":[],"overridesByGrade":{}}',
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (species_code, version_no),
  -- 每个树种至多一个 draft
  EXCLUDE (species_code WITH =) WHERE (status = 'draft'),
  -- 每个树种至多一个“当前发布版”（superseded_at 为空的 published）
  EXCLUDE (species_code WITH =) WHERE (status = 'published' AND superseded_at IS NULL)
);

CREATE TABLE kilns (
  no          INT PRIMARY KEY CHECK (no BETWEEN 1 AND 6),
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE runs (
  id                BIGSERIAL PRIMARY KEY,
  kiln_no           INT NOT NULL REFERENCES kilns(no),
  version_id        BIGINT NOT NULL REFERENCES schedule_versions(id),
  thickness_grade   TEXT NOT NULL REFERENCES thickness_grades(code),
  -- 样板绝干折算参数
  initial_weight_g  DOUBLE PRECISION NOT NULL CHECK (initial_weight_g > 0),
  initial_mc        DOUBLE PRECISION NOT NULL CHECK (initial_mc > 0),
  current_stage     INT NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished')),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_runs_kiln_status ON runs (kiln_no, status) WHERE status = 'active';

-- 同一时刻一座窑至多一个在跑批次
CREATE UNIQUE INDEX uq_active_run_per_kiln
  ON runs (kiln_no) WHERE status = 'active';

CREATE TABLE readings (
  record_no     BIGINT PRIMARY KEY,           -- 全库唯一上报序号
  kiln_no       INT NOT NULL REFERENCES kilns(no),
  run_id        BIGINT REFERENCES runs(id),
  taken_at      TIMESTAMPTZ NOT NULL,
  dry_bulb      DOUBLE PRECISION,
  wet_bulb      DOUBLE PRECISION,
  weight_g      DOUBLE PRECISION,
  -- 派生量（重放时回写，查询时不必再算）
  rh            DOUBLE PRECISION,
  emc           DOUBLE PRECISION,
  sample_mc     DOUBLE PRECISION,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (dry_bulb IS NOT NULL AND wet_bulb IS NOT NULL) OR weight_g IS NOT NULL
  ),
  CHECK (dry_bulb IS NULL OR (dry_bulb BETWEEN 0 AND 120)),
  CHECK (wet_bulb IS NULL OR (wet_bulb BETWEEN 0 AND 120)),
  CHECK (wet_bulb IS NULL OR dry_bulb IS NULL OR wet_bulb <= dry_bulb),
  CHECK (weight_g IS NULL OR weight_g > 0)
);
CREATE INDEX idx_readings_run_time ON readings (run_id, taken_at, record_no);

-- 事件溯源：阶段切换是重放结果，可整体删除重建。
CREATE TABLE stage_transitions (
  id          BIGSERIAL PRIMARY KEY,
  run_id      BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_no    INT NOT NULL,
  record_no   BIGINT NOT NULL DEFAULT -1,  -- -1 表示开跑即进入第 1 阶段
  at          TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, stage_no)
);

-- ---------- 种子数据 ----------
INSERT INTO thickness_grades (code, label, sort_order) VALUES
  ('thin',  '薄板 (<30mm)',   10),
  ('std',   '常规 (30-50mm)', 20),
  ('thick', '厚板 (>50mm)',   30)
ON CONFLICT (code) DO NOTHING;

INSERT INTO kilns (no, name) VALUES
  (1,'1 号窑'),(2,'2 号窑'),(3,'3 号窑'),
  (4,'4 号窑'),(5,'5 号窑'),(6,'6 号窑')
ON CONFLICT (no) DO NOTHING;

-- 橡木：一个已发布版本（含厚板覆盖），可直接开跑演示
INSERT INTO species (code, name) VALUES ('oak','橡木')
ON CONFLICT (code) DO NOTHING;

INSERT INTO schedule_versions (species_code, version_no, status, content, published_at)
SELECT 'oak', 1, 'published',
  jsonb_build_object(
    'base', jsonb_build_array(
      jsonb_build_object('stageNo',1,'enterBelow',NULL,'dryBulb',45,'wetBulb',42),
      jsonb_build_object('stageNo',2,'enterBelow',40,'dryBulb',50,'wetBulb',45),
      jsonb_build_object('stageNo',3,'enterBelow',30,'dryBulb',55,'wetBulb',45),
      jsonb_build_object('stageNo',4,'enterBelow',20,'dryBulb',65,'wetBulb',45)
    ),
    'overridesByGrade', jsonb_build_object(
      'thick', jsonb_build_array(
        jsonb_build_object('stageNo',3,'dryBulb',52),
        jsonb_build_object('stageNo',4,'dryBulb',60,'wetBulb',43)
      )
    )
  ),
  now()
WHERE NOT EXISTS (SELECT 1 FROM schedule_versions WHERE species_code='oak' AND version_no=1);
