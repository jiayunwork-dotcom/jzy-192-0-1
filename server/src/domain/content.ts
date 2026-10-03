import type { OverrideRow, StageRow } from "./types.js";

/** 版本内容的存储/传输结构 */
export interface Content {
  base: StageRow[];
  overridesByGrade: Record<string, OverrideRow[]>;
}

export const EMPTY_CONTENT: Content = { base: [], overridesByGrade: {} };
