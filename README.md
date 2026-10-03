# 木材干燥窑基准与运行系统

六座干燥窑的干燥基准编辑发布、窑位运行监视。后端 Node.js 20 + TypeScript +
Fastify + PostgreSQL 16；前端 Vue 3 + Vite；Vitest 测试；单 Docker 镜像同时
托管 API 与前端静态文件。

## 快速开始

```bash
docker compose up --build
# 打开 http://localhost:3000
```

`app` 容器启动时自动执行数据库迁移并播种：六座窑、橡木（含 THICK 厚板厚度层）
与松木各一份已发布基准。

本地开发（需要本机 PostgreSQL 16，或仅跑测试——测试用内存 PGlite，无需数据库）：

```bash
npm install
npm test                     # 后端全部单测/集成测（PGlite，无需起 Postgres）
npm run build --workspace=server
npm run dev:web              # http://localhost:5173，/api 代理到 :3000
DATABASE_URL=postgres://kiln:kiln@localhost:5432/kiln npm run dev:server
```

## 模型与计算（全部在后端）

详见 [`docs/干燥模型说明.md`](docs/干燥模型说明.md)。

- 干湿球 → 相对湿度：WMO CIMO 通风干湿表公式 + Buck 饱和水汽压。
- 相对湿度 → 平衡含水率：**Simpson (1973) Hailwood–Horrobin 吸湿方程**
  （USDA Wood Handbook 吸附系数）。20°C/65% → **12.00%**，60°C/80% → **13.56%**。
- 样板含水率：绝干基。5000g/60% 初值 → 绝干 3125g；称到 4062.5g 时 MC=**30%**。
- 两次称重之间：一阶松弛干燥模型 `M(t+Δt)=Me+(M(t)−Me)e^{−kΔt}`（默认 k=0.05/h），
  称重为绝对锚点；模型在区间内越过阈值时解析求越界时刻（秒级）。
- 阶段进入条件为**严格小于**：MC < 阈值才进入下一阶段。

## 一致性设计（验收点）

窑状态不单独落库，任何时刻由「批次 + 该窑全部读数」重放得到（`domain/engine.ts`
的纯函数 `replay`），读数先按 `(时刻, 记录编号)` 排序：

- **乱序/晚到上报**：最终切换时刻与按时间顺序上报完全一致（集成测试断言）。
- **重复记录编号**：`readings.record_no` 主键唯一，重复返回 409 且不改结果。
- **重启恢复**：从批次表与读数表重放，不丢不重（已用落盘 PGlite 双进程验证）。
- **基准版本**：draft 可编辑，publish 后只读；开跑批次绑定当时有效版本，
  之后发布新版不影响在跑批次。
- **两层基准**：厚度覆盖只写差异格，未写继承基础表；合并预览与发布后有效基准
  用的是同一个 `mergeSchedule()`，逐格标注 `base` / `override` 来源。

## 拒收规则（错误体 `{errors:[{field,message}]}`，指出字段）

- 湿球温度高于干球温度（`wetBulbC` / 阶段表湿球列）
- 进入条件含水率未逐行严格递减
- 温度超出 0~120°C
- 称重为负（`weightG`）
- 引用不存在的窑（`kilnId`）或树种（`speciesId`）
- 记录编号非正整数、读数时刻非法、温湿度与称重混在一条记录

## 主要 HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/kilns` | 六座窑总览（当前阶段/含水率） |
| GET | `/api/kilns/:id` | 单窑：曲线点、阶段时间轴、有效基准 |
| POST | `/api/kilns/:id/batches` | 装料开跑，绑定当前有效版本 |
| POST | `/api/kilns/:id/finish` | 收料结束 |
| POST | `/api/readings` | 读数上报/手工补录（同一入口，可乱序） |
| GET | `/api/species/:id/versions` | 版本列表 |
| POST | `/api/species/:id/draft` | 从当前有效版本复制出新编辑稿 |
| PUT | `/api/species/:id/draft/stages` | 保存基础表 |
| PUT | `/api/species/:id/draft/grades/:code/overrides` | 保存厚度覆盖 |
| GET | `/api/species/:id/draft/preview?grade=` | 合并预览（逐格带来源） |
| POST | `/api/species/:id/publish` | 发布（逐厚度层校验后只读） |
| GET | `/api/versions/:id/effective?grade=` | 查看已发布版本的有效基准 |

## 目录

```
server/src/
  domain/   纯领域：物理模型、两层合并、重放引擎、校验（含 *.test.ts）
  db/       pg/PGlite 双驱动、迁移、仓储
  services/ 用例编排（事务、错误类型）
  routes/   Fastify 路由（含 HTTP 集成测试）
web/src/    Vue 3：窑位看板（曲线/时间轴/补录）、基准编辑（两层表/预览/发布）
docs/       模型与误差分析
```
