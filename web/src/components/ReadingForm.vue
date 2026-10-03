<script setup lang="ts">
import { reactive, ref } from "vue";
import { api } from "../api";

const props = defineProps<{ kilnNo: number; suggestedRecordNo: number }>();
const emit = defineEmits<{ (e: "saved"): void }>();

const form = reactive({
  recordNo: props.suggestedRecordNo,
  takenAt: "",
  kind: "temp" as "temp" | "weight",
  dryBulb: "" as number | string,
  wetBulb: "" as number | string,
  weightG: "" as number | string,
});
const error = ref<string | null>(null);
const detail = ref<{ field: string; message: string }[]>([]);
const busy = ref(false);

function toLocalInput(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
form.takenAt = toLocalInput();

async function submit() {
  error.value = null;
  detail.value = [];
  const body: Record<string, unknown> = {
    recordNo: form.recordNo,
    kilnNo: props.kilnNo,
    takenAt: new Date(form.takenAt).toISOString(),
  };
  if (form.kind === "temp") {
    body.dryBulb = form.dryBulb === "" ? null : Number(form.dryBulb);
    body.wetBulb = form.wetBulb === "" ? null : Number(form.wetBulb);
  } else {
    body.weightG = form.weightG === "" ? null : Number(form.weightG);
  }
  busy.value = true;
  try {
    await api.post("/api/readings", body);
    form.recordNo = Number(form.recordNo) + 1;
    form.takenAt = toLocalInput();
    form.dryBulb = "";
    form.wetBulb = "";
    form.weightG = "";
    emit("saved");
  } catch (e) {
    const err = e as Error & { fields?: string[]; details?: { field: string; message: string }[] };
    error.value = err.message;
    detail.value = err.details ?? [];
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div>
    <div v-if="error" class="error-box">
      {{ error }}
      <ul v-if="detail.length">
        <li v-for="d in detail" :key="d.field"><b>{{ d.field }}</b>：{{ d.message }}</li>
      </ul>
    </div>
    <div class="row">
      <label class="fld">记录编号
        <input type="number" v-model.number="form.recordNo" style="width:110px" />
      </label>
      <label class="fld">读数时刻
        <input type="datetime-local" v-model="form.takenAt" style="width:200px" />
      </label>
      <label class="fld">读数类型
        <select v-model="form.kind" style="width:150px">
          <option value="temp">干湿球温度</option>
          <option value="weight">样板称重</option>
        </select>
      </label>
      <template v-if="form.kind === 'temp'">
        <label class="fld">干球 °C <input type="number" step="0.1" v-model="form.dryBulb" /></label>
        <label class="fld">湿球 °C <input type="number" step="0.1" v-model="form.wetBulb" /></label>
      </template>
      <template v-else>
        <label class="fld">称重 g <input type="number" step="0.1" v-model="form.weightG" /></label>
      </template>
      <button class="btn primary" style="margin-top:14px" :disabled="busy" @click="submit">上报 / 补录</button>
    </div>
    <p class="muted small" style="margin:8px 0 0">
      补录历史读数时把“读数时刻”改成实际时刻即可——阶段时间轴会按时刻重排，与当时在线上报结果一致；
      记录编号重复会被拒收。
    </p>
  </div>
</template>
