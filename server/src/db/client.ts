/**
 * 数据库访问抽象：生产用 node-postgres 的 Pool，测试用内存 PGlite。
 * 两者都实现 query<Row>(text, params)，这里统一行类型映射（NUMERIC -> string,
 * 由 repository 负责转 number；TIMESTAMPTZ -> Date）。
 */
export interface QueryRow {
  [column: string]: unknown;
}

export interface DbClient {
  query<R extends QueryRow = QueryRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
  /** 事务：回调内全部使用同一连接，异常回滚 */
  tx<R>(fn: (tx: DbClient) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

/** 行里的 NUMERIC 在 pg/PGlite 下都以 string 返回，统一转 number */
export function num(v: unknown): number {
  if (v === null || v === undefined) return Number.NaN;
  return Number(v);
}

/** 时间列可能返回 Date 或 ISO 字符串，统一转 Date */
export function dt(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}
