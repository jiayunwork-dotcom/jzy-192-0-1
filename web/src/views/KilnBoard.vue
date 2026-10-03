<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { api, type KilnOverview, type KilnDetail, type FieldError } from '../api';
import McChart from '../components/McChart.vue';

const kilns = ref<KilnOverview[]>([]);
const selected = ref<number>(1);
const detail = ref<KilnDetail | null>(null);
const loading = ref(false);
const formError = ref<FieldError[] | null>(null);
const flash = ref('');

// 开跑表单
const startForm = ref({
  speciesId: 1,
  thicknessGrade: '' as string,
  initialWeightG: 5000,
  initialMcPct: 60,
  startedAt: '',
});
const species = ref<{ id: number; name: string }[]>([]);
const grades = ref<{ code: string; label: string }[]>([]);

// 读数补录表单
const readingForm = ref({
  recordNo: Math.floor(Date.now() / 1000),
  recordedAt: new Date().toISOString().slice(0, 16),
  kind: 'psychro' as 'psychro' | 'weight',
  dryBulbC: 60,
  wetBulbC: 54,
  weightG: 4000,
});

async function loadBoard() {
  kilns.value = await api.listKilns();
}

async function loadDetail(id: number) {
  selected.value = id;
  loading.value = true;
  try {
    detail.value = await api.kiln(id);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  species.value = await api.listSpecies();
  await loadBoard();
  await loadDetail(1);
  timer = setInterval(async () => {
    await loadBoard();
    await loadDetail(selected.value);
  }, 30_000);
});

let timer: ReturnType<typeof setInterval> | null = null;
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

async function startBatch() {
  formError.value = null;
  try {
    await api.startBatch(selected.value, {
      speciesId: Number(startForm.value.speciesId),
      thicknessGrade: startForm.value.thicknessGrade || null,
      initialWeightG: Number(startForm.value.initialWeightG),
      initialMcPct: Number(startForm.value.initialMcPct),
      startedAt: startForm.value.startedAt
        ? new Date(startForm.value.startedAt).toISOString()
        : null,
    });
    flash.value = '已开跑，批次绑定当前有效基准版本';
    await loadBoard();
    await loadDetail(selected.value);
  } catch (e) {
    formError.value = (e as { errors: FieldError[] }).errors;
  }
}

async function finishBatch() {
  formError.value = null;
  try {
    await api.finishBatch(selected.value);
    flash.value = '本批料已结束';
    await loadBoard();
    await loadDetail(selected.value);
  } catch (e) {
    formError.value = (e as { errors: FieldError[] }).errors;
  }
}

async function submitReading() {
  formError.value = null;
  const f = readingForm.value;
  const payload: Record<string, unknown> = {
    recordNo: Number(f.recordNo),
    kilnId: selected.value,
    recordedAt: new Date(f.recordedAt).toISOString(),
  };
  if (f.kind === 'psychro') {
    payload.dryBulbC = Number(f.dryBulbC);
    payload.wetBulbC = Number(f.wetBulbC);
  } else {
    payload.weightG = Number(f.weightG);
  }
  try {
    await api.submitReading(payload);
    flash.value = '读数已接收';
    await loadBoard();
    await loadDetail(selected.value);
  } catch (e) {
    formError.value = (e as { errors: FieldError[] }).errors;
  }
}

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const readings = computed(() => detail.value?.timeline?.points ?? []);
const transitions = computed(() => detail.value?.timeline?.transitions ?? []);
</script>

<template>
  <div class="errors" v-if="formError">
    <strong>无法提交：</strong>
    <ul>
      <li v-for="(e, i) in formError" :key="i">
        <code v-if="e.field">{{ e.field }}</code> {{ e.message }}
      </li>
    </ul>
  </div>
  <div class="ok-flash" v-if="flash" @click="flash = ''">{{ flash }}（点击消失）</div>

  <div class="kiln-grid">
    <div
      v-for="k in kilns"
      :key="k.id"
      class="kiln-card"
      :class="{ selected: k.id === selected }"
      @click="loadDetail(k.id)"
    >
      <div class="row" style="justify-content: space-between">
        <span class="name">{{ k.name }}</span>
        <span class="badge" :class="k.running ? 'status-published' : 'status-draft'">
          {{ k.running ? '在跑' : '空闲' }}
        </span>
      </div>
      <div v-if="k.running">
        <div class="big">{{ k.currentMcPct?.toFixed(1) }}<span style="font-size:13px">%</span></div>
        <div class="muted">
          阶段 {{ k.currentStageNo }}/{{ k.stageCount }} · EMC {{ k.latestEmcPct?.toFixed(1) ?? '—' }}%
        </div>
      </div>
      <div v-else class="idle" style="margin-top: 10px">无在跑批次</div>
    </div>
  </div>

  <div class="panel" style="margin-top: 16px">
    <h2>{{ kilns.find((k) => k.id === selected)?.name }} — 详情</h2>

    <div v-if="!detail?.running">
      <h3>装料开跑（绑定当前有效基准版本，之后发布新版不影响本批）</h3>
      <div class="row">
        <label>树种
          <select v-model="startForm.speciesId" class="field">
            <option v-for="s in species" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <label>厚度等级
          <input v-model="startForm.thicknessGrade" class="field" placeholder="留空=基础表，如 THICK" />
        </label>
        <label>样板初称(g) <input v-model.number="startForm.initialWeightG" class="field" type="number" /></label>
        <label>初始含水率(%) <input v-model.number="startForm.initialMcPct" class="field" type="number" /></label>
        <label>开跑时刻 <input v-model="startForm.startedAt" class="field" type="datetime-local" /></label>
        <button class="btn" @click="startBatch">开跑</button>
      </div>
    </div>

    <div v-else>
      <div class="row" style="justify-content: space-between">
        <div>
          批次 #{{ detail.batch!.id }} ·
          绑定版本 #{{ detail.batch!.versionId }} ·
          开跑 {{ fmtTime(detail.batch!.startedAt) }} ·
          样板 {{ detail.batch!.initialWeightG }}g / {{ detail.batch!.initialMcPct }}%
        </div>
        <button class="btn danger" @click="finishBatch">收料结束</button>
      </div>

      <h3>含水率曲线</h3>
      <McChart :points="readings" :transitions="transitions" />
      <div class="muted" style="font-size: 12px">
        蓝实线=估计含水率；棕虚线=平衡含水率 EMC；红点=样板称重锚点；绿色竖线=阶段切换。
      </div>

      <h3>阶段时间轴</h3>
      <table class="grid" style="max-width: 720px">
        <thead>
          <tr><th>阶段</th><th>进入时刻</th><th>触发读数</th><th>干球/湿球(°C)</th></tr>
        </thead>
        <tbody>
          <tr v-for="tr in transitions" :key="tr.stageNo">
            <td :style="{ fontWeight: tr.stageNo === detail.timeline!.currentStageNo ? 700 : 400 }">
              {{ tr.stageNo }}
            </td>
            <td>{{ fmtTime(tr.enteredAt) }}</td>
            <td>{{ tr.triggerRecordNo === null ? '开跑' : '#' + tr.triggerRecordNo }}</td>
            <td>
              {{ detail.stages?.find((s) => s.stageNo === tr.stageNo)?.dryBulbC }} /
              {{ detail.stages?.find((s) => s.stageNo === tr.stageNo)?.wetBulbC }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h2>手工补录 / 上报读数</h2>
    <div class="row">
      <label>记录编号 <input v-model.number="readingForm.recordNo" class="field" type="number" style="width: 130px" /></label>
      <label>时刻 <input v-model="readingForm.recordedAt" class="field" type="datetime-local" /></label>
      <label>类型
        <select v-model="readingForm.kind" class="field">
          <option value="psychro">干湿球温度</option>
          <option value="weight">样板称重</option>
        </select>
      </label>
      <template v-if="readingForm.kind === 'psychro'">
        <label>干球°C <input v-model.number="readingForm.dryBulbC" class="field" type="number" style="width: 90px" /></label>
        <label>湿球°C <input v-model.number="readingForm.wetBulbC" class="field" type="number" style="width: 90px" /></label>
      </template>
      <template v-else>
        <label>称重(g) <input v-model.number="readingForm.weightG" class="field" type="number" style="width: 110px" /></label>
      </template>
      <button class="btn" @click="submitReading">提交</button>
    </div>
    <p class="muted" style="font-size: 12px; margin-bottom: 0">
      可补录早于当前时刻的历史读数；系统按时刻重放，阶段时间轴与按时序上报完全一致。重复记录编号会被拒收。
    </p>
  </div>
</template>
