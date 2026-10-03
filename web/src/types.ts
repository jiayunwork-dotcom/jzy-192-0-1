export interface StageRow {
  stageNo: number;
  enterBelow: number | null;
  dryBulb: number;
  wetBulb: number;
}
export interface OverrideRow {
  stageNo: number;
  enterBelow?: number | null;
  dryBulb?: number;
  wetBulb?: number;
}
export interface Content {
  base: StageRow[];
  overridesByGrade: Record<string, OverrideRow[]>;
}
export interface MergedRow extends StageRow {
  sources: { enterBelow: "base" | "override"; dryBulb: "base" | "override"; wetBulb: "base" | "override" };
}
export interface VersionMeta {
  id: number;
  versionNo: number;
  status: "draft" | "published";
  publishedAt: string | null;
  supersededAt: string | null;
}
export interface VersionDetail extends VersionMeta {
  speciesCode: string;
  content: Content;
  mergedByGrade: Record<string, MergedRow[]>;
}
export interface Species {
  code: string;
  name: string;
  current_version_id: string | null;
  draft_id: string | null;
}
export interface ThicknessGrade {
  code: string;
  label: string;
  sortOrder: number;
}
export interface KilnLatestRun {
  id: number;
  status: "active" | "finished";
  currentStage: number;
  thicknessGrade: string;
  versionId: number;
  startedAt: string;
  finishedAt: string | null;
  initialWeightG: number;
  initialMc: number;
}
export interface Kiln {
  no: number;
  name: string;
  latestRun: KilnLatestRun | null;
}
export interface Reading {
  recordNo: number;
  takenAt: string;
  dryBulb: number | null;
  wetBulb: number | null;
  weightG: number | null;
  rh: number | null;
  emc: number | null;
  sampleMc: number | null;
}
export interface Transition {
  stageNo: number;
  recordNo: number;
  at: string;
}
export interface KilnState {
  kiln: { no: number; name: string };
  run: {
    id: number;
    status: string;
    currentStage: number;
    thicknessGrade: string;
    startedAt: string;
    initialWeightG: number;
    initialMc: number;
  } | null;
  schedule?: {
    speciesName: string;
    versionId: number;
    versionNo: number;
    merged: MergedRow[];
  };
  readings: Reading[];
  transitions: Transition[];
}
