import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { createPglite } from '../db/pglite.js';
import { runMigrations } from '../db/migrate.js';
import type { DbClient } from '../db/client.js';

interface AppEnv {
  app: FastifyInstance;
  db: DbClient;
}

let env: AppEnv;

beforeAll(async () => {
  const { db } = createPglite();
  await runMigrations(db);
  const app = await buildApp(db);
  env = { app, db };
});

describe('HTTP 集成（PGlite）', () => {
  it('健康检查与六座窑', async () => {
    const health = await env.app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    const kilns = await env.app.inject({ method: 'GET', url: '/api/kilns' });
    expect(kilns.statusCode).toBe(200);
    const body = kilns.json() as { id: number }[];
    expect(body).toHaveLength(6);
  });

  it('种子：橡木版本合并预览，厚板覆盖干球、湿球继承', async () => {
    const versions = await env.app.inject({
      method: 'GET',
      url: '/api/species/1/versions',
    });
    expect(versions.statusCode).toBe(200);
    const v = versions.json() as {
      id: number;
      version: number;
      status: string;
      baseStages: { stageNo: number; dryBulbC: string }[];
    }[];
    expect(v[0]!.status).toBe('published');

    const eff = await env.app.inject({
      method: 'GET',
      url: '/api/versions/1/effective?grade=THICK',
    });
    expect(eff.statusCode).toBe(200);
    const e = eff.json() as {
      effectiveStages: {
        stageNo: number;
        dryBulbC: { value: number; source: string };
        wetBulbC: { value: number; source: string };
      }[];
    };
    // 厚板第2阶段：干球 60 来自覆盖，湿球 57 来自基础
    expect(e.effectiveStages[1]!.dryBulbC.value).toBe(60);
    expect(e.effectiveStages[1]!.dryBulbC.source).toBe('override');
    expect(e.effectiveStages[1]!.wetBulbC.value).toBe(57);
    expect(e.effectiveStages[1]!.wetBulbC.source).toBe('base');
  });

  it('编辑→预览→发布：预览与发布后有效基准一致', async () => {
    // 1) 新建编辑稿（复制自 v1）
    const draft = await env.app.inject({
      method: 'POST',
      url: '/api/species/1/draft',
      payload: { note: '橡木新版' },
    });
    expect(draft.statusCode).toBe(201);
    const draftId = (draft.json() as { id: number }).id;

    // 2) 改基础表第3阶段干球 72
    const save = await env.app.inject({
      method: 'PUT',
      url: '/api/species/1/draft/stages',
      payload: {
        stages: [
          { stageNo: 1, mcThresholdPct: null, dryBulbC: 60, wetBulbC: 56 },
          { stageNo: 2, mcThresholdPct: 40, dryBulbC: 65, wetBulbC: 57 },
          { stageNo: 3, mcThresholdPct: 30, dryBulbC: 72, wetBulbC: 58 },
          { stageNo: 4, mcThresholdPct: 20, dryBulbC: 75, wetBulbC: 62 },
          { stageNo: 5, mcThresholdPct: 12, dryBulbC: 80, wetBulbC: 68 },
        ],
      },
    });
    expect(save.statusCode).toBe(200);

    // 3) 预览（厚板）
    const preview = await env.app.inject({
      method: 'GET',
      url: '/api/species/1/draft/preview?grade=THICK',
    });
    expect(preview.statusCode).toBe(200);
    const previewJson = preview.json() as {
      effectiveStages: {
        stageNo: number;
        dryBulbC: { value: number; source: string };
        wetBulbC: { value: number; source: string };
      }[];
    };
    // 厚板第3阶段覆盖干球65，应盖住基础的72
    expect(previewJson.effectiveStages[2]!.dryBulbC).toEqual({
      value: 65,
      source: 'override',
    });

    // 4) 发布
    const pub = await env.app.inject({ method: 'POST', url: '/api/species/1/publish' });
    expect(pub.statusCode).toBe(200);
    const pubId = (pub.json() as { id: number }).id;
    expect(pubId).toBe(draftId);

    // 5) 发布后只读查看，与预览逐格一致
    const after = await env.app.inject({
      method: 'GET',
      url: `/api/versions/${pubId}/effective?grade=THICK`,
    });
    const afterJson = after.json() as typeof previewJson;
    expect(afterJson.effectiveStages).toEqual(previewJson.effectiveStages);
  });

  it('没有编辑稿时发布返回 422；发布后版本只读（无写接口可改已发布版本）', async () => {
    const republish = await env.app.inject({
      method: 'POST',
      url: '/api/species/2/publish',
    });
    expect(republish.statusCode).toBe(422);
  });
});
