<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import {
  api,
  type Species,
  type VersionInfo,
  type Grade,
  type EffectiveStageRow,
  type BaseStageRow,
  type FieldError,
} from '../api';

const speciesList = ref<Species[]>([]);
const speciesId = ref(1);
const versions = ref<VersionInfo[]>([]);
const draft = ref<VersionInfo | null>(null);
const grades = ref<Grade[]>([]);
const gradeCode = ref<string>('');

const baseRows = ref<BaseStageRow[]>([]);
// 覆盖表：与基础表同构，null/空表示继承
interface OvCell { stageNo: number; mcThresholdPct: number | null; dryBulbC: number | null; wetBulbC: number | null }
const overrideRows = ref<OvCell[]>([]);
const preview = ref<EffectiveStageRow[] | null>(null);

const errors = ref<FieldError[] | null>(null);
const flash = ref('');

function emptyBase(): BaseStageRow[] {
  return [
    { stageNo: 1, mcThresholdPct: null, dryBulbC: 60, wetBulbC: 55 },
    { stageNo: 2, mcThresholdPct: 35, dryBulbC: 65, wetBulbC: 56 },
    { stageNo: 3, mcThresholdPct: 25, dryBulbC: 70, wetBulbC: 58 },
    { stageNo: 4, mcThresholdPct: 12, dryBulbC: 78, wetBulbC: 64 },
  ];
}

async function refresh() {
  errors.value = null;
  versions.value = await api.listVersions(speciesId.value);
  draft.value = versions.value.find((v) => v.status === 'draft') ?? null;
  grades.value = await api.listGrades(speciesId.value);
  if (draft.value) {
    const p = await api.preview(speciesId.value, gradeCode.value || null);
    baseRows.value = p.baseStages.map((r) => ({ ...r }));
    preview.value = p.effectiveStages;
    if (gradeCode.value) {
      // 用预览反推覆盖输入：override 来源的格子填值，其余留空
      overrideRows.value = p.effectiveStages.map((row) => ({
        stageNo: row.stageNo,
        mcThresholdPct: row.mcThresholdPct.source === 'override' ? row.mcThresholdPct.value : null,
        dryBulbC: row.dryBulbC.source === 'override' ? row.dryBulbC.value : null,
        wetBulbC: row.wetBulbC.source === 'override' ? row.wetBulbC.value : null,
      }));
    }
  } else {
    baseRows.value = [];
    preview.value = null;
    overrideRows.value = [];
  }
}

onMounted(async () => {
  speciesList.value = await api.listSpecies();
  await refresh();
});

watch(speciesId, async () => {
  gradeCode.value = '';
  await refresh();
});
watch(gradeCode, async () => {
  if (draft.value) await refresh();
});

async function createDraft() {
  errors.value = null;
  try {
    const d = await api.createDraft(speciesId.value, '工艺员编辑稿');
    flash.value = `已基于当前有效版本创建编辑稿 v${d.version}`;
    await refresh();
  } catch (e) {
    errors.value = (e as { errors: FieldError[] }).errors;
  }
}

function addStageRow() {
  const last = baseRows.value[baseRows.value.length - 1];
  baseRows.value.push({
    stageNo: (last?.stageNo ?? 0) + 1,
    mcThresholdPct: last?.mcThresholdPct ? Math.round((last.mcThresholdPct - 5) * 10) / 10 : 10,
    dryBulbC: last?.dryBulbC ?? 60,
    wetBulbC: last?.wetBulbC ?? 55,
  });
}
function removeStageRow(i: number) {
  baseRows.value.splice(i, 1);
  baseRows.value.forEach((r, idx) => (r.stageNo = idx + 1));
}

async function saveBase() {
  errors.value = null;
  try {
    await api.saveStages(speciesId.value, baseRows.value);
    flash.value = '基础表已保存';
    await refresh();
  } catch (e) {
    errors.value = (e as { errors: FieldError[] }).errors;
  }
}

async function saveOverrides() {
  errors.value = null;
  const payload = overrideRows.value
    .filter((r) => r.mcThresholdPct !== null || r.dryBulbC !== null || r.wetBulbC !== null)
    .map((r) => ({
      stageNo: r.stageNo,
      mcThresholdPct: r.mcThresholdPct,
      dryBulbC: r.dryBulbC,
      wetBulbC: r.wetBulbC,
    }));
  try {
    await api.saveOverrides(speciesId.value, gradeCode.value, payload);
    flash.value = `厚度层[${gradeCode.value}]覆盖已保存`;
    await refresh();
  } catch (e) {
    errors.value = (e as { errors: FieldError[] }).errors;
  }
}

async function addGrade() {
  const code = prompt('厚度等级编码（英文，如 THICK）');
  if (!code) return;
  const label = prompt('显示名称（如 厚板≥50mm）') ?? code;
  errors.value = null;
  try {
    await api.createGrade(speciesId.value, code, label);
    gradeCode.value = code;
    await refresh();
  } catch (e) {
    errors.value = (e as { errors: FieldError[] }).errors;
  }
}

async function publish() {
  errors.value = null;
  try {
    const v = await api.publish(speciesId.value);
    flash.value = `已发布 v${v.version}，此后只读；新批次将绑定该版本`;
    await refresh();
  } catch (e) {
    errors.value = (e as { errors: FieldError[] }).errors;
  }
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
</script>

<template>
  <div class="errors" v-if="errors">
    <strong>拒收：</strong>
    <ul>
      <li v-for="(e, i) in errors" :key="i">
        <code v-if="e.field">{{ e.field }}</code> {{ e.message }}
      </li>
    </ul>
  </div>
  <div class="ok-flash" v-if="flash" @click="flash = ''">{{ flash }}（点击消失）</div>

  <div class="panel">
    <div class="row" style="justify-content: space-between">
      <div class="row">
        <label>树种
          <select v-model="speciesId" class="field">
            <option v-for="s in speciesList" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <span class="muted">版本：</span>
        <span v-for="v in versions" :key="v.id" class="badge" :class="v.status === 'draft' ? 'status-draft' : 'status-published'">
          v{{ v.version }} {{ v.status === 'draft' ? '编辑稿' : '已发布' }}
        </span>
      </div>
      <button v-if="!draft" class="btn" @click="createDraft">新建编辑稿（复制当前有效版本）</button>
      <button v-else class="btn" @click="publish">发布编辑稿 v{{ draft.version }}</button>
    </div>
  </div>

  <div v-if="!draft" class="panel">
    <p class="muted">该树种当前没有编辑稿。新版本从“当前有效版本”整体复制后再改；发布后只读，在跑批次仍使用其绑定的旧版本。</p>
  </div>

  <template v-else>
    <div class="panel">
      <h2>① 树种基础表（编辑稿 v{{ draft.version }}）</h2>
      <table class="grid">
        <thead>
          <tr>
            <th style="width: 60px">阶段</th>
            <th>进入条件：含水率低于(%)</th>
            <th>干球°C</th>
            <th>湿球°C</th>
            <th style="width: 70px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in baseRows" :key="i">
            <td>{{ r.stageNo }}</td>
            <td>
              <input
                v-if="i === 0"
                :value="'起始（装料即进入）'"
                disabled
              />
              <input v-else v-model.number="r.mcThresholdPct" type="number" step="0.1" />
            </td>
            <td><input v-model.number="r.dryBulbC" type="number" step="0.1" /></td>
            <td><input v-model.number="r.wetBulbC" type="number" step="0.1" /></td>
            <td><button class="btn secondary" @click="removeStageRow(i)" :disabled="i === 0">删</button></td>
          </tr>
        </tbody>
      </table>
      <div class="row" style="margin-top: 10px">
        <button class="btn secondary" @click="addStageRow">+ 增加阶段</button>
        <button class="btn" @click="saveBase">保存基础表</button>
      </div>
    </div>

    <div class="panel">
      <div class="row" style="justify-content: space-between">
        <h2 style="margin: 0">② 厚度等级覆盖（只写不同的格子，留空继承基础表）</h2>
        <button class="btn secondary" @click="addGrade">+ 新厚度等级</button>
      </div>
      <div class="row" style="margin: 10px 0">
        <label>厚度层
          <select v-model="gradeCode" class="field">
            <option value="">（仅基础表）</option>
            <option v-for="g in grades" :key="g.id" :value="g.code">{{ g.label }}</option>
          </select>
        </label>
      </div>

      <template v-if="gradeCode">
        <table class="grid">
          <thead>
            <tr><th>阶段</th><th>进入条件覆盖</th><th>干球覆盖</th><th>湿球覆盖</th></tr>
        </thead>
          <tbody>
            <tr v-for="r in overrideRows" :key="r.stageNo">
              <td>{{ r.stageNo }}</td>
              <td>
                <input
                  v-if="r.stageNo !== 1"
                  :value="r.mcThresholdPct ?? ''"
                  type="number"
                  step="0.1"
                  placeholder="继承"
                  @input="r.mcThresholdPct = numOrNull(($event.target as HTMLInputElement).value)"
                />
                <span v-else class="muted">—</span>
              </td>
              <td>
                <input
                  :value="r.dryBulbC ?? ''"
                  type="number"
                  step="0.1"
                  placeholder="继承"
                  @input="r.dryBulbC = numOrNull(($event.target as HTMLInputElement).value)"
                />
              </td>
              <td>
                <input
                  :value="r.wetBulbC ?? ''"
                  type="number"
                  step="0.1"
                  placeholder="继承"
                  @input="r.wetBulbC = numOrNull(($event.target as HTMLInputElement).value)"
                />
              </td>
            </tr>
          </tbody>
        </table>
        <div style="margin-top: 10px">
          <button class="btn" @click="saveOverrides">保存厚度覆盖</button>
        </div>
      </template>
    </div>

    <div class="panel">
      <h2>③ 合并预览（逐格标注来源；发布后的有效基准与此完全一致）</h2>
      <table class="grid">
        <thead>
          <tr>
            <th style="width: 60px">阶段</th>
            <th>进入条件(%)</th>
            <th>干球°C</th>
            <th>湿球°C</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in preview" :key="row.stageNo">
            <td>{{ row.stageNo }}</td>
            <td :class="row.mcThresholdPct.source === 'override' ? 'cell-override' : 'cell-base'">
              {{ row.mcThresholdPct.value ?? '起始' }}
              <span v-if="row.mcThresholdPct.source" class="badge" :class="row.mcThresholdPct.source">
                {{ row.mcThresholdPct.source === 'base' ? '基础' : '厚度' }}
              </span>
            </td>
            <td :class="row.dryBulbC.source === 'override' ? 'cell-override' : 'cell-base'">
              {{ row.dryBulbC.value }}
              <span class="badge" :class="row.dryBulbC.source ?? ''">
                {{ row.dryBulbC.source === 'base' ? '基础' : '厚度' }}
              </span>
            </td>
            <td :class="row.wetBulbC.source === 'override' ? 'cell-override' : 'cell-base'">
              {{ row.wetBulbC.value }}
              <span class="badge" :class="row.wetBulbC.source ?? ''">
                {{ row.wetBulbC.source === 'base' ? '基础' : '厚度' }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <p class="muted" style="font-size: 12px; margin-bottom: 0">
        白底=基础表继承；琥珀底=厚度层覆盖。发布前会对每个厚度层逐一校验湿球≤干球、温度 0~120°C、进入条件逐行递减。
      </p>
    </div>
  </template>
</template>
