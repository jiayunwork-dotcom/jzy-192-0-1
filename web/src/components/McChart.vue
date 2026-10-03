<script setup lang="ts">
import { computed } from "vue";
import type { MergedRow, Reading, Transition } from "../types";
import { fmt } from "../api";

const props = defineProps<{
  readings: Reading[];
  transitions: Transition[];
  merged: MergedRow[];
}>();

const W = 900;
const H = 320;
const M = { l: 48, r: 16, t: 18, b: 34 };

const points = computed(() => props.readings.filter((r) => r.sampleMc !== null));
const temps = computed(() => props.readings.filter((r) => r.dryBulb !== null));

const t0 = computed(() => (points.value.length ? new Date(points.value[0]!.takenAt).getTime() : Date.now()));
const t1 = computed(() => {
  const all = props.readings;
  return all.length ? new Date(all[all.length - 1]!.takenAt).getTime() : Date.now() + 1;
});
const xSpan = computed(() => Math.max(t1.value - t0.value, 3_600_000));

// 左轴含水率 0..80；右轴温度 0..120
const mcMax = 80;
const tMax = 120;
const x = (t: string) => M.l + ((new Date(t).getTime() - t0.value) / xSpan.value) * (W - M.l - M.r);
const yMc = (v: number) => M.t + (1 - v / mcMax) * (H - M.t - M.b);
const yT = (v: number) => M.t + (1 - v / tMax) * (H - M.t - M.b);

const mcPath = computed(() =>
  points.value
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.takenAt).toFixed(1)},${yMc(p.sampleMc!).toFixed(1)}`)
    .join(" "),
);
const dbPath = computed(() =>
  temps.value
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.takenAt).toFixed(1)},${yT(p.dryBulb!).toFixed(1)}`)
    .join(" "),
);
const wbPath = computed(() =>
  temps.value
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.takenAt).toFixed(1)},${yT(p.wetBulb!).toFixed(1)}`)
    .join(" "),
);
const xTicks = computed(() => {
  const n = 6;
  return Array.from({ length: n + 1 }, (_, i) => {
    const ts = t0.value + (xSpan.value * i) / n;
    return { x: M.l + ((W - M.l - M.r) * i) / n, label: fmt.time(new Date(ts).toISOString()) };
  });
});
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${H}`" style="width:100%;height:auto">
    <!-- 网格 + 左轴（含水率） -->
    <g v-for="v in [0, 20, 40, 60, 80]" :key="'g' + v">
      <line :x1="M.l" :x2="W - M.r" :y1="yMc(v)" :y2="yMc(v)" stroke="#eef1f5" />
      <text :x="M.l - 6" :y="yMc(v) + 4" text-anchor="end" font-size="11" fill="#6b7686">{{ v }}%</text>
    </g>
    <!-- 右轴（温度） -->
    <g v-for="v in [0, 30, 60, 90, 120]" :key="'t' + v">
      <text :x="W - M.r + 5" :y="yT(v) + 4" font-size="11" fill="#c07a2a">{{ v }}°</text>
    </g>
    <!-- 阶段进入条件阈值线 -->
    <g v-for="row in merged.filter(r => r.enterBelow !== null)" :key="'th' + row.stageNo">
      <line
        :x1="M.l" :x2="W - M.r" :y1="yMc(row.enterBelow!)" :y2="yMc(row.enterBelow!)"
        stroke="#9bb8f0" stroke-dasharray="5 4"
      />
      <text :x="W - M.r - 4" :y="yMc(row.enterBelow!) - 3" text-anchor="end" font-size="10" fill="#2a6df4">
        进入阶段 {{ row.stageNo }}：&lt;{{ row.enterBelow }}%
      </text>
    </g>
    <!-- 阶段切换竖线 -->
    <g v-for="tr in transitions.filter(t => t.recordNo > 0)" :key="'tr' + tr.stageNo">
      <line :x1="x(tr.at)" :x2="x(tr.at)" :y1="M.t" :y2="H - M.b" stroke="#1e8e5a" stroke-dasharray="3 3" opacity="0.7" />
      <text :x="x(tr.at) + 3" :y="M.t + 10" font-size="10" fill="#1e8e5a">→阶段{{ tr.stageNo }}</text>
    </g>
    <!-- 温度曲线（干球/湿球） -->
    <path :d="wbPath" fill="none" stroke="#e0a800" stroke-width="1.6" />
    <path :d="dbPath" fill="none" stroke="#d35400" stroke-width="1.6" />
    <!-- 样板含水率曲线（阶梯保持） -->
    <path :d="mcPath" fill="none" stroke="#2a6df4" stroke-width="2.4" />
    <circle
      v-for="p in points" :key="'p' + p.recordNo"
      :cx="x(p.takenAt)" :cy="yMc(p.sampleMc!)" r="3.2" fill="#2a6df4"
    >
      <title>{{ fmt.time(p.takenAt) }} 称重 {{ p.weightG }}g → MC {{ p.sampleMc?.toFixed(2) }}%</title>
    </circle>
    <!-- X 轴 -->
    <line :x1="M.l" :x2="W - M.r" :y1="H - M.b" :y2="H - M.b" stroke="#c8cfda" />
    <text v-for="(tk, i) in xTicks" :key="'x' + i" :x="tk.x" :y="H - M.b + 16"
          text-anchor="middle" font-size="10" fill="#6b7686">{{ tk.label }}</text>
  </svg>
  <div class="legend" style="margin-top:6px">
    <span><span style="color:#2a6df4;font-weight:700">━</span> 样板含水率（两次称重间保持上次值）</span>
    <span><span style="color:#d35400;font-weight:700">━</span> 干球</span>
    <span><span style="color:#e0a800;font-weight:700">━</span> 湿球</span>
    <span><span style="color:#1e8e5a">┊</span> 阶段切换</span>
    <span><span style="color:#9bb8f0">┄</span> 进入条件</span>
  </div>
</template>
