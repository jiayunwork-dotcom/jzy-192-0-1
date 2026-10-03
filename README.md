# 干燥窑基准与运行监控系统

木材加工厂干燥车间：工艺员在网页上编辑/发布干燥基准（树种基础表 + 厚度等级覆盖两层），
班长在网页上看六座窑的含水率曲线与阶段时间轴。计算全部在后端，前端只编辑和展示。

- 后端：Node.js 20 + TypeScript + Fastify 4 + PostgreSQL 16（`server/`）
- 前端：Vue 3 + Vite + TypeScript（`web/`，无第三方图表库，SVG 自绘曲线）
- 部署：node:20-alpine 多阶段构建，Fastify 同时托管前端静态文件，与 postgres:16-alpine 一份 compose 启动

## 快速启动

```bash
docker compose up --build
# 打开 http://localhost:8080
```

compose 会自动建表、写入种子（6 座窑、三个厚度等级、橡木一份已发布基准 v1）。

本地开发：

```bash
npm install
npm run dev:server   # :8080，需可连 Postgres（DATABASE_URL）
npm run dev:web      # :5173，/api 代理到 8080
```

## 测试

```bash
npm test                 # 领域纯函数测试（RH/EMC/折算/合并/乱序重放/校验，33 项）
RUN_E2E=1 npm test       # 额外跑真实 PostgreSQL 16 + HTTP 的端到端测试（自动下载 embedded PG16）
```

## 关键设计与验收对应

| 验收点 | 实现 |
|---|---|
| EMC 20°C/65%≈12.0%、60°C/80%≈13.6%（±0.3） | Hailwood–Horrobin 模型，系数引自 Simpson, *FPL RP-190* (1973) / Wood Handbook Ch.4；实测 12.00 / 13.57 |
| 样板 5000g@60% → 4062.5g = 30% | 绝干质量折算 `m_dry=m0/(1+MC0/100)` |
| 合并预览 = 发布后有效基准 | 前后端同一份合并规则 `domain/merge.ts`；保存/详情接口返回带每格来源标注的 `mergedByGrade`，开跑时用同一函数 |
| 乱序与顺序上报切换时刻相同 | 每次入库后按 `(taken_at, record_no)` 全量重放该批次（纯集合函数），见 `domain/run.ts` |
| 重复记录只算一次 | readings.record_no 主键，重复上报 409 |
| 重启前后一致 | 只持久化读数事实；启动时从读数重放所有派生状态（阶段时间轴/当前阶段/RH/EMC/样板MC） |
| 非法输入拒收并指出字段 | 湿球>干球、温度越界(0–120)、负称重、进入条件不递减、不存在的窑/树种/厚度等级，均 400/404 + `fields` |
| 发布只读、在跑批次绑定版本 | draft→published 冻结；开跑绑定当时发布版 id，旧发布版标记 superseded 但永久保留给在跑批次 |

两次称重间含水率估计采用**保持上次称重值**（zero-order hold），切换只会**滞后**不超过一个称重间隔、
绝不提前（对防开裂是安全方向）；不这么做的理由、替代方案与误差来源详见
[`docs/DESIGN.md`](docs/DESIGN.md) 第 2.4 节。

## 主要接口

```
GET    /api/kilns                      六座窑总览
POST   /api/kilns/:no/start            装料开跑（自动绑定当前发布版）
POST   /api/kilns/:no/finish
GET    /api/kilns/:no/state            有效基准 + 曲线点 + 阶段时间轴
POST   /api/readings                   上报/手工补录读数（recordNo 全局唯一）
GET    /api/species                    树种
GET/POST /api/species/:code/versions   版本列表 / 新建草稿
GET/PUT/DELETE /api/versions/:id       版本详情(含合并预览) / 编辑 / 删除草稿
POST   /api/versions/:id/publish       发布冻结
```
