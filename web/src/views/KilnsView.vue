<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, fmt } from "../api";
import type { Kiln, KilnState, Species, ThicknessGrade } from "../types";
import McChart from "../components/McChart.vue";
import ReadingForm from "../components/ReadingForm.vue";

const kilns = ref<Kiln[]>([]);
const species = ref<Species[]>([]);
const grades = ref<ThicknessGrade[]>([]);
const selected = ref<number | null>(null);
const state = ref<KilnState | null>(null);
const loading = ref(false);
const actionError = ref<string | null>(null);

const startForm = ref({ speciesCode: "", thicknessGrade: "", initialWeightG: 5000, initialMc: 60 });

async function loadAll() {
  [kilns.value, species.value, grades.value] = await Promise.all([
    api.get<Kiln[]>("/api/kilns"),
    api.get<Species[]>("/api/species"),
    api.get<ThicknessGrade[]>("/api/thickness-grades"),
  ]);
  if (!startForm.value.speciesCode && species.value.length) {
    startForm.value.speciesCode = species.value[0].code;
  }
  if (!startForm.value.thicknessGrade && grades.value.length) {
    startForm.value.thicknessGrade = grades.value[1]?.code ?? grades.value[0]!.code;
  }
  if (selected.value) await loadState(selected.value);
}

async function selectKiln(no: number) {
  selected.value = no;
  await loadState(no);
}

async function loadState(no: number) {
  loading.value = true;
  try {
    state.value = await api.get<KilnState>(`/api/kilns/${no}/state`);
  } finally {
    loading.value = false;
  }
}

const suggestedRecordNo = computed(() => {
  const max = (state.value?.readings ?? []).reduce((m, r) => Math.max(m, r.recordNo), 0);
  return max + 1;
});

const gradeLabel = (code: string) => grades.value.find((g) => g.code === code)?.label ?? code;

async function startRun() {
  actionError.value = null;
  try {
    await api.post(`/api/kilns/${selected.value}/start`, startForm.value);
    await loadAll();
  } catch (e) {
    actionError.value = (e as Error).message + renderDetails(e);
  }
}
async function finishRun() {
  actionError.value = null;
  try {
    await api.post(`/api/kilns/${selected.value}/finish`, {});
    await loadAll();
  } catch (e) {
    actionError.value = (e as Error).message;
  }
}
function renderDetails(e: unknown): string {
  const d = (e as { details?: { field: string; message: string }[] }).details ?? [];
  return d.length ? "：" + d.map((x) => `${x.field} ${x.message}`).join("；") : "";
}
</script>

<template>
  <div class="panel">
    <h2>六座窑总览</h2>
    <div class="kiln-cards">
      <div
        v-for="k in kilns" :key="k.no"
        class="kiln-card"
        :class="{ active: selected === k.no }"
        @click="selectKiln(k.no)"
      >
        <div class="row" style="justify-content:space-between">
          <span class="name">{{ k.name }}</span>
          <span v-if="k.latestRun?.status === 'active'" class="badge published">运行中</span>
          <span v-else-if="k.latestRun" class="badge over">已结束</span>
          <span v-else class="badge draft">空窑</span>
        </div>
        <div v-if="k.latestRun" class="stage">
          阶段 {{ k.latestRun.status === "active" ? k.latestRun.currentStage : "—" }}
        </div>
        <div class="muted small">
          <template v-if="k.latestRun">
            开跑 {{ fmt.time(k.latestRun.startedAt) }}
          </template>
          <template v-else>点击查看并装料开跑</template>
        </div>
      </div>
    </div>
  </div>

  <div v-if="selected && state" class="panel">
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">{{ state.kiln.name }} — 运行详情</h2>
      <button class="btn" @click="loadState(state.kiln.no)">刷新</button>
    </div>

    <div v-if="actionError" class="error-box" style="margin-top:12px">{{ actionError }}</div>

    <!-- 空窑：装料开跑 -->
    <template v-if="!state.run">
      <h3>装料开跑（绑定当前发布版本）</h3>
      <div class="row">
        <label class="fld">树种
          <select v-model="startForm.speciesCode" style="width:160px">
            <option v-for="s in species" :key="s.code" :value="s.code">{{ s.name }}（{{ s.code }}）</option>
          </select>
        </label>
        <label class="fld">厚度等级
          <select v-model="startForm.thicknessGrade" style="width:170px">
            <option v-for="g in grades" :key="g.code" :value="g.code">{{ g.label }}</option>
          </select>
        </label>
        <label class="fld">样板初称 g <input type="number" step="0.1" v-model.number="startForm.initialWeightG" /></label>
        <label class="fld">样板初始含水率 % <input type="number" step="0.1" v-model.number="startForm.initialMc" /></label>
        <button class="btn primary" style="margin-top:14px" @click="startRun">开跑</button>
      </div>
      <p v-if="!species.some(s => s.current_version_id)" class="muted small" style="margin-top:8px">
        该树种尚无已发布基准，请到“基准管理”发布后再开跑。
      </p>
    </template>

    <template v-else>
      <div class="row" style="margin:8px 0">
        <span class="badge stage">{{ state.schedule?.speciesName }} · 基准 v{{ state.schedule?.versionNo }}</span>
        <span class="badge draft">{{ gradeLabel(state.run.thicknessGrade) }}</span>
        <span class="muted small">开跑 {{ fmt.time(state.run.startedAt) }}</span>
        <span class="muted small">样板 {{ state.run.initialWeightG }}g @ {{ state.run.initialMc }}%</span>
        <button class="btn danger" style="margin-left:auto" @click="finishRun">结束本批</button>
      </div>

      <!-- 阶段时间轴 -->
      <h3>阶段时间轴</h3>
      <div class="timeline">
        <div class="track">
          <div
            v-for="row in state.schedule?.merged ?? []" :key="row.stageNo"
            class="seg"
            :class="{
              current: state.run!.status === 'active' && state.run!.currentStage === row.stageNo,
              on: state.run!.currentStage >= row.stageNo,
            }"
          >
            <div class="st">阶段 {{ row.stageNo }}</div>
            <div class="small">{{ row.dryBulb }}° / {{ row.wetBulb }}°</div>
            <div class="at">
              <template v-if="row.enterBelow !== null">进入 &lt;{{ row.enterBelow }}%</template>
              <template v-else>起始阶段</template>
            </div>
            <div class="at">
              <template v-for="tr in state.transitions.filter(t => t.stageNo === row.stageNo)" :key="tr.stageNo">
                {{ tr.recordNo < 0 ? '开跑进入' : fmt.time(tr.at) }}
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- 曲线 -->
      <h3>含水率曲线与温湿度</h3>
      <McChart
        v-if="state.schedule"
        :readings="state.readings" :transitions="state.transitions" :merged="state.schedule.merged"
      />

      <!-- 手工补录 -->
      <h3>手工补录 / 上报读数</h3>
      <ReadingForm :kiln-no="state.kiln.no" :suggested-record-no="suggestedRecordNo" @saved="loadState(state.kiln.no)" />

      <!-- 读数表 -->
      <h3>读数记录（{{ state.readings.length }}）</h3>
      <table class="grid">
        <thead>
          <tr>
            <th>记录编号</th><th>时刻</th><th>干球°C</th><th>湿球°C</th>
            <th>RH %</th><th>EMC %</th><th>称重 g</th><th>样板 MC %</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in [...state.readings].reverse()" :key="r.recordNo">
            <td>{{ r.recordNo }}</td>
            <td>{{ fmt.time(r.takenAt) }}</td>
            <td>{{ fmt.num(r.dryBulb) }}</td>
            <td>{{ fmt.num(r.wetBulb) }}</td>
            <td>{{ fmt.num(r.rh) }}</td>
            <td>{{ fmt.num(r.emc, 2) }}</td>
            <td>{{ fmt.num(r.weightG) }}</td>
            <td><b>{{ fmt.num(r.sampleMc, 2) }}</b></td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>
