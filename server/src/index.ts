import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { pool, runMigrations } from "./db.js";
import { registerSpeciesRoutes } from "./routes/species.js";
import { registerVersionRoutes } from "./routes/versions.js";
import {
  recomputeAllFromReadings,
  registerKilnRoutes,
  registerReadingRoutes,
} from "./routes/kilns.js";

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, "..", "..", "web", "dist");

export async function buildServer() {
  const app = Fastify({ logger: { transport: undefined } });

  await app.register(cors, { origin: true });

  // 启动即建表/迁移；随后从已存读数重放派生状态，保证重启不丢不重。
  await runMigrations();
  await recomputeAllFromReadings();

  await app.register(registerSpeciesRoutes);
  await app.register(registerVersionRoutes);
  await app.register(registerKilnRoutes);
  await app.register(registerReadingRoutes);

  app.get("/api/health", async () => ({ ok: true }));

  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    if ((err as { code?: string }).code === "23505") {
      return reply.code(409).send({ error: "唯一约束冲突", fields: [] });
    }
    if ((err as { code?: string }).code === "23514" || (err as { code?: string }).code === "23502") {
      return reply.code(400).send({ error: "数据违反数据库约束", fields: [] });
    }
    return reply.code(500).send({ error: "服务器内部错误" });
  });

  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "接口不存在" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}

async function main() {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ host: "0.0.0.0", port });
  console.info(`[kiln] listening on :${port}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { pool };
