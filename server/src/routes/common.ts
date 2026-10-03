import type { FastifyReply } from "fastify";
import type { Content } from "../domain/content.js";

export interface FieldError {
  field: string;
  message: string;
}

export function badRequest(reply: FastifyReply, message: string, fields: string[] = []) {
  return reply.code(400).send({ error: message, fields });
}

export function fieldErrors(reply: FastifyReply, errs: FieldError[]) {
  return reply.code(400).send({
    error: "数据校验未通过",
    fields: [...new Set(errs.map((e) => e.field))],
    details: errs,
  });
}

export function notFound(reply: FastifyReply, message: string) {
  return reply.code(404).send({ error: message });
}

export function conflict(reply: FastifyReply, message: string, fields: string[] = []) {
  return reply.code(409).send({ error: message, fields });
}

/** 归一化并部分校验请求体里的基准内容；返回结构化内容或字段错误 */
export function parseContent(body: unknown): { ok: true; content: Content } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const b = (body ?? {}) as Record<string, unknown>;
  const baseRaw = Array.isArray(b.base) ? b.base : [];
  const ovRaw = (b.overridesByGrade ?? {}) as Record<string, unknown>;

  const base = baseRaw.map((row, i) => {
    const r = (row ?? {}) as Record<string, unknown>;
    const stageNo = Number(r.stageNo ?? i + 1);
    return {
      stageNo,
      enterBelow: r.enterBelow === null || r.enterBelow === undefined || r.enterBelow === ""
        ? null
        : Number(r.enterBelow),
      dryBulb: Number(r.dryBulb),
      wetBulb: Number(r.wetBulb),
    };
  });

  if (base.length === 0) errors.push({ field: "base", message: "基础阶段表至少需要一行" });
  // 阶段号连续 1..N
  if (base.some((r, i) => r.stageNo !== i + 1)) {
    errors.push({ field: "base", message: "阶段号必须从 1 开始连续编号" });
  }

  const overridesByGrade: Content["overridesByGrade"] = {};
  for (const [grade, listRaw] of Object.entries(ovRaw)) {
    if (!Array.isArray(listRaw)) {
      errors.push({ field: `overridesByGrade.${grade}`, message: "覆盖项必须是数组" });
      continue;
    }
    overridesByGrade[grade] = listRaw.map((row, i) => {
      const r = (row ?? {}) as Record<string, unknown>;
      const o: Record<string, number | null | undefined> = {};
      if (r.enterBelow !== undefined) {
        o.enterBelow = r.enterBelow === null || r.enterBelow === "" ? null : Number(r.enterBelow);
      }
      if (r.dryBulb !== undefined && r.dryBulb !== "") o.dryBulb = Number(r.dryBulb);
      if (r.wetBulb !== undefined && r.wetBulb !== "") o.wetBulb = Number(r.wetBulb);
      return { stageNo: Number(r.stageNo ?? i + 1), ...o } as Content["overridesByGrade"][string][number];
    });
  }

  return errors.length ? { ok: false, errors } : { ok: true, content: { base, overridesByGrade } };
}
