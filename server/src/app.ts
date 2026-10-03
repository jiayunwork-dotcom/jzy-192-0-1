import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbClient } from './db/client.js';
import { registerScheduleRoutes } from './routes/schedules.js';
import { registerKilnRoutes } from './routes/kilns.js';
import { ApiValidationError } from './services/kilns.service.js';
import { ValidationFailedError } from './services/schedules.service.js';

const here = dirname(fileURLToPath(import.meta.url));
// 编译后 dist/，前端静态产物在 ../../web/dist；tsx 直跑时定位到 web/dist
const WEB_DIST = resolve(here, '..', '..', 'web', 'dist');

export async function buildApp(db: DbClient): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.LOG_ENABLED !== '0' });
  await app.register(cors, { origin: true });

  app.get('/api/health', async () => ({ ok: true }));
  registerScheduleRoutes(app, db);
  registerKilnRoutes(app, db);

  // 统一兜底：未捕获的领域错误转 JSON，不把堆栈抛给页面
  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    if (err instanceof ApiValidationError || err instanceof ValidationFailedError) {
      return reply.status(400).send({ errors: err.errors });
    }
    return reply.status(500).send({
      errors: [{ field: '', message: '服务器内部错误' }],
    });
  });

  // 同一镜像托管前端静态文件（SPA：非 /api 路由回退 index.html）
  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: '/',
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.status(404).send({
          errors: [{ field: '', message: '接口不存在' }],
        });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
