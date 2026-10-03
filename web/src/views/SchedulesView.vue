<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import type {
  Content, MergedRow, Species, ThicknessGrade, VersionDetail, VersionMeta,
} from "../types";

const speciesList = ref<Species[]>([]);
const grades = ref<ThicknessGrade[]>([]);
const versions = ref<VersionMeta[]>([]);
const selectedSpecies = ref<string>("");
const version = ref<VersionDetail | null>(null);
const activeGrade = ref<string>("std");
const message = ref<{ kind: "err" | "ok"; text: string; details?: { field: string; message: string }[] } | null>(null);
const busy = ref(false);

// 编辑中的两份数据
const base = ref<{ enterBelow: string; dryBulb: string; wetBulb: string }[]>([]);
const overrides = ref<Record<string, { stageNo: number; enterBelow: string; dryBulb: string; wetBulb: string }[]>>({});

const isPublished = computed(() => version.value?.status === "published");

async function loadSpecies() {
  speciesList.value = await api.get("/api/species");
  grades.value = await api.get("/api/thickness-grades");
  if (!selectedSpecies.value && speciesList.value.length) {
    await selectSpecies(speciesList.value[0]!.code);
  }
}

async function selectSpecies(code: string) {
  selectedSpecies.value = code;
  message.value = null;
  versions.value = await api.get(`/api/species/${code}/versions`);
  const current = versions.value.find((v) => v.status === "published" && !v.supersededAt) ?? versions.value[0];
  if (current) await openVersion(current.id);
  else version.value = null;
}

async function openVersion(id: number) {
  version.value = await api.get(`/api/versions/${id}`);
  hydrate(version.value.content);
  activeGrade.value = grades.value.find((g) => g.code === "std")?.code ?? grades.value[0]?.code ?? "std";
  message.value = null;
}

function hydrate(c: Content) {
  base.value = c.base.map((r) => ({
    enterBelow: r.enterBelow === null ? "" : String(r.enterBelow),
    dryBulb: String(r.dryBulb),
    wetBulb: String(r.wetBulb),
  }));
  const ov: typeof overrides.value = {};
  for (const g of grades.value) {
    ov[g.code] = (c.overridesByGrade[g.code] ?? []).map((r) => ({
      stageNo: r.stageNo,
      enterBelow: r.enterBelow === undefined ? "" : r.enterBelow === null ? "" : String(r.enterBelow),
      dryBulb: r.dryBulb === undefined ? "" : String(r.dryBulb),
      wetBulb: r.wetBulb === undefined ? "" : String(r.wetBulb),
    }));
  }
  overrides.value = ov;
}

function addStage() {
  base.value.push({ enterBelow: "", dryBulb: "", wetBulb: "" });
}
function removeStage(i: number) {
  if (!confirm(`删除第 ${i + 1} 阶段？`)) return;
  base.value.splice(i, 1);
  // 覆盖行重新映射：删掉该行，其后阶段号 -1
  for (const g of Object.keys(overrides.value)) {
    overrides.value[g] = overrides.value[g]!
      .filter((o) => o.stageNo !== i + 1)
      .map((o) => (o.stageNo > i + 1 ? { ...o, stageNo: o.stageNo - 1 } : o));
  }
}

const currentOverrides = computed({
  get: () => overrides.value[activeGrade.value] ?? [],
  set: (v) => { overrides.value[activeGrade.value] = v; },
});

function addOverride() {
  const used = new Set(currentOverrides.value.map((o) => o.stageNo));
  const free = base.value.findIndex((_, i) => !used.has(i + 1));
  if (free < 0) return;
  currentOverrides.value = [
    ...currentOverrides.value,
    { stageNo: free + 1, enterBelow: "", dryBulb: "", wetBulb: "" },
  ].sort((a, b) => a.stageNo - b.stageNo);
}
function removeOverride(stageNo: number) {
  currentOverrides.value = currentOverrides.value.filter((o) => o.stageNo !== stageNo);
}

/** 组装提交内容：空字符串的覆盖格视为“不写=继承”；全空的覆盖行丢弃 */
function buildContent(): Content {
  const num = (s: string) => (s === "" ? null : Number(s));
  return {
    base: base.value.map((r, i) => ({
      stageNo: i + 1,
      enterBelow: i === 0 ? null : num(r.enterBelow),
      dryBulb: Number(r.dryBulb),
      wetBulb: Number(r.wetBulb),
    })),
    overridesByGrade: Object.fromEntries(
      grades.value.map((g) => {
        const rows = (overrides.value[g.code] ?? [])
          .map((o) => {
            const row: Record<string, number | null | undefined> = { stageNo: o.stageNo };
            // 进入条件：覆盖行允许显式写值；第一阶段进入条件本就必须空
            if (o.enterBelow !== "") row.enterBelow = Number(o.enterBelow);
            if (o.dryBulb !== "") row.dryBulb = Number(o.dryBulb);
            if (o.wetBulb !== "") row.wetBulb = Number(o.wetBulb);
            return row as { stageNo: number; enterBelow?: number | null; dryBulb?: number; wetBulb?: number };
          })
          .filter((r) => r.enterBelow !== undefined || r.dryBulb !== undefined || r.wetBulb !== undefined);
        return [g.code, rows];
      }),
    ),
  };
}

/** 实时合并预览：直接用与发布/跑批同一份后端合并算法的等价结构（保存后由后端重算并回显） */
const liveMerged = computed<MergedRow[]>(() => {
  const c = buildContent();
  const ov = c.overridesByGrade[activeGrade.value] ?? [];
  const byStage = new Map(ov.map((o) => [o.stageNo, o]));
  return c.base.map((row) => {
    const o = byStage.get(row.stageNo);
    return {
      stageNo: row.stageNo,
      enterBelow: o?.enterBelow !== undefined ? o.enterBelow : row.enterBelow,
      dryBulb: o?.dryBulb ?? row.dryBulb,
      wetBulb: o?.wetBulb ?? row.wetBulb,
      sources: {
        enterBelow: o?.enterBelow !== undefined ? "override" : "base",
        dryBulb: o?.dryBulb !== undefined ? "override" : "base",
        wetBulb: o?.wetBulb !== undefined ? "override" : "base",
      },
    };
  });
});

async function save() {
  message.value = null;
  busy.value = true;
  try {
    const saved = await api.put<VersionDetail>(`/api/versions/${version.value!.id}`, buildContent());
    versions.value = await api.get(`/api/species/${selectedSpecies.value}/versions`);
    version.value = saved;
    message.value = { kind: "ok", text: "草稿已保存（下方预览即发布后将生效的有效基准）" };
  } catch (e) {
    const err = e as Error & { details?: { field: string; message: string }[] };
    message.value = { kind: "err", text: err.message, details: err.details ?? [] };
  } finally {
    busy.value = false;
  }
}

async function createDraft(copy: boolean) {
  busy.value = true;
  message.value = null;
  try {
    const r = await api.post<{ id: number }>(`/api/species/${selectedSpecies.value}/versions`, {
      copyFromCurrent: copy,
    });
    await selectSpecies(selectedSpecies.value);
    await openVersion(r.id);
    message.value = { kind: "ok", text: copy ? "已从当前发布版复制出新草稿" : "已创建空白草稿" };
  } catch (e) {
    message.value = { kind: "err", text: (e as Error).message };
  } finally {
    busy.value = false;
  }
}

async function publish() {
  if (!confirm("发布后该版本冻结只读；在跑批次继续使用旧版本。确认发布？")) return;
  busy.value = true;
  try {
    version.value = await api.post(`/api/versions/${version.value!.id}/publish`, {});
    message.value = { kind: "ok", text: "已发布，成为该树种当前有效基准" };
    await selectSpecies(selectedSpecies.value);
  } catch (e) {
    const err = e as Error & { details?: { field: string; message: string }[] };
    message.value = { kind: "err", text: err.message, details: err.details ?? [] };
  } finally {
    busy.value = false;
  }
}

async function removeDraft() {
  if (!confirm("删除该草稿？")) return;
  await api.del(`/api/versions/${version.value!.id}`);
  await selectSpecies(selectedSpecies.value);
}

async function addSpecies() {
  const code = prompt("树种代码（小写英文，如 oak、pine）")?.trim();
  if (!code) return;
  const name = prompt("树种中文名")?.trim();
  if (!name) return;
  try {
    await api.post("/api/species", { code, name });
    await loadSpecies();
    await selectSpecies(code);
  } catch (e) {
    message.value = { kind: "err", text: (e as Error).message };
  }
}

const currentVersionMeta = computed(() =>
  versions.value.find((v) => v.id === version.value?.id));
</script>

<template>
  <div class="panel">
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">树种与基准版本</h2>
      <button class="btn" @click="addSpecies">新增树种</button>
    </div>
    <div class="row" style="margin-top:12px">
      <label class="fld">树种
        <select v-model="selectedSpecies" style="width:220px" @change="selectSpecies(String(($event.target as HTMLSelectElement).value))">
          <option v-for="s in speciesList" :key="s.code" :value="s.code">{{ s.name }}（{{ s.code }}）</option>
        </select>
      </label>
      <div class="row" v-if="versions.length" style="gap:6px">
        <button
          v-for="v in versions" :key="v.id"
          class="btn"
          :class="{ primary: version?.id === v.id }"
          @click="openVersion(v.id)"
        >
          v{{ v.versionNo }}
          <span class="badge" :class="v.status">
            {{ v.status === "draft" ? "草稿" : v.supersededAt ? "已失效" : "当前发布" }}
          </span>
        </button>
      </div>
      <button class="btn" :disabled="busy" @click="createDraft(true)">从当前版改新版</button>
      <button class="btn" :disabled="busy" @click="createDraft(false)">空白新版</button>
    </div>
  </div>

  <div v-if="message" class="error-box" :style="message.kind === 'ok' ? {background:'#e4f6ec',borderColor:'#9ad9b8',color:'#155c3a'} : {}">
    {{ message.text }}
    <ul v-if="message.details?.length">
      <li v-for="d in message.details" :key="d.field"><b>{{ d.field }}</b>：{{ d.message }}</li>
    </ul>
  </div>

  <template v-if="version">
    <!-- 基础表编辑 -->
    <div class="panel">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">
          ① 树种基础阶段表
          <span class="badge" :class="version.status">{{ version.status === "draft" ? "草稿可编辑" : "已发布只读" }}</span>
        </h2>
        <span v-if="!isPublished" class="row">
          <button class="btn" @click="addStage">+ 增加阶段</button>
        </span>
      </div>
      <table class="grid" style="margin-top:10px">
        <thead>
          <tr><th style="width:70px">阶段</th><th>进入条件：含水率低于 %</th><th>干球温度 °C</th><th>湿球温度 °C</th><th v-if="!isPublished" style="width:70px">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in base" :key="i">
            <td><b>{{ i + 1 }}</b></td>
            <td>
              <input v-if="i === 0" disabled value="（起始阶段）" />
              <input v-else-if="!isPublished" type="number" step="0.1" v-model="r.enterBelow" />
              <span v-else>{{ r.enterBelow }}</span>
            </td>
            <td><input :disabled="isPublished" type="number" step="0.1" v-model="r.dryBulb" /></td>
            <td><input :disabled="isPublished" type="number" step="0.1" v-model="r.wetBulb" /></td>
            <td v-if="!isPublished"><button class="btn danger" @click="removeStage(i)">删</button></td>
          </tr>
        </tbody>
      </table>
      <p class="muted small" style="margin-top:8px">
        进入条件从第 2 阶段起必须逐行严格递减；湿球不得高于干球；温度范围 0–120°C，违反时保存会被拒收并指出字段。
      </p>
    </div>

    <!-- 厚度覆盖编辑 -->
    <div class="panel" v-if="grades.length">
      <h2>② 厚度等级覆盖（只写与基础表不同的格，留空即继承）</h2>
      <div class="row">
        <button
          v-for="g in grades" :key="g.code"
          class="btn" :class="{ primary: activeGrade === g.code }"
          @click="activeGrade = g.code"
        >{{ g.label }}</button>
        <button v-if="!isPublished" class="btn" @click="addOverride">+ 覆盖一个阶段</button>
      </div>
      <table class="grid" style="margin-top:10px">
        <thead>
          <tr><th style="width:70px">阶段</th><th>进入条件 %（留空继承）</th><th>干球 °C（留空继承）</th><th>湿球 °C（留空继承）</th><th v-if="!isPublished" style="width:70px">操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="o in currentOverrides" :key="o.stageNo">
            <td><b>{{ o.stageNo }}</b></td>
            <td><input :disabled="isPublished" type="number" step="0.1" v-model="o.enterBelow" :placeholder="`继承 ${base[o.stageNo - 1]?.enterBelow || '起始'}`" /></td>
            <td><input :disabled="isPublished" type="number" step="0.1" v-model="o.dryBulb" :placeholder="`继承 ${base[o.stageNo - 1]?.dryBulb}`" /></td>
            <td><input :disabled="isPublished" type="number" step="0.1" v-model="o.wetBulb" :placeholder="`继承 ${base[o.stageNo - 1]?.wetBulb}`" /></td>
            <td v-if="!isPublished"><button class="btn danger" @click="removeOverride(o.stageNo)">删</button></td>
          </tr>
          <tr v-if="!currentOverrides.length"><td colspan="5" class="muted">该厚度等级暂无覆盖，全部继承基础表</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 合并预览 -->
    <div class="panel">
      <h2>③ 合并预览 — {{ grades.find(g => g.code === activeGrade)?.label }}（发布后的有效基准）</h2>
      <div class="legend" style="margin-bottom:8px">
        <span><span class="sw"></span>黄底格来自厚度覆盖层，其余继承基础表</span>
      </div>
      <table class="grid">
        <thead>
          <tr><th style="width:70px">阶段</th><th>进入条件 %</th><th>干球 °C</th><th>湿球 °C</th></tr>
        </thead>
        <tbody>
          <tr v-for="m in liveMerged" :key="m.stageNo">
            <td><b>{{ m.stageNo }}</b></td>
            <td :class="{ 'src-override': m.sources.enterBelow === 'override' }">
              {{ m.enterBelow === null ? "起始" : m.enterBelow }}
            </td>
            <td :class="{ 'src-override': m.sources.dryBulb === 'override' }">{{ m.dryBulb }}</td>
            <td :class="{ 'src-override': m.sources.wetBulb === 'override' }">{{ m.wetBulb }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted small" style="margin-top:8px">
        预览由与后端相同的合并规则生成；保存后后端返回的 mergedByGrade 即窑上开跑时实际使用的同一份表。
      </p>
    </div>

    <div class="panel row" v-if="!isPublished">
      <button class="btn primary" :disabled="busy" @click="save">保存草稿</button>
      <button class="btn primary" :disabled="busy" @click="publish">发布（冻结只读）</button>
      <button class="btn danger" :disabled="busy" @click="removeDraft">删除草稿</button>
      <span class="muted small">发布后不可再改，在跑批次不受影响；要调整就“从当前版改新版”。</span>
    </div>
    <div class="panel row" v-else>
      <span class="muted">此版本 {{ currentVersionMeta?.supersededAt ? "已被新版本取代（历史只读）" : "为当前发布版" }}；在跑批次即使跨越发布时刻也继续按本版本跑完。</span>
    </div>
  </template>

  <div v-else class="panel muted">该树种还没有任何版本，点上方“空白新版”创建草稿。</div>
</template>
