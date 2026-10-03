<script setup lang="ts">
import { computed } from 'vue';
import type { McPoint, Transition } from '../api';

const props = defineProps<{
  points: McPoint[];
  transitions: Transition[];
  width?: number;
  height?: number;
}>();

const W = computed(() => props.width ?? 900);
const H = computed(() => props.height ?? 320);
const PAD = { l: 46, r: 14, t: 14, b: 30 };

const viewBox = computed(() => '0 0 ' + W.value + ' ' + H.value);

const t0 = computed(() => {
  const p = props.points[0];
  return p ? new Date(p.recordedAt).getTime() : 0;
});
const t1 = computed(() => {
  const p = props.points[props.points.length - 1];
  return p ? new Date(p.recordedAt).getTime() : 1;
});

const mcMax = computed(() => {
  const m = Math.max(60, ...props.points.map((p) => p.mcPct));
  return Math.ceil(m / 10) * 10;
});

function x(tIso: string): number {
  const span = Math.max(1, t1.value - t0.value);
  return PAD.l + ((new Date(tIso).getTime() - t0.value) / span) * (W.value - PAD.l - PAD.r);
}
function y(mc: number): number {
  return PAD.t + (1 - mc / mcMax.value) * (H.value - PAD.t - PAD.b);
}

const mcPath = computed(() =>
  props.points
    .map((p, i) => (i === 0 ? 'M' : 'L') + x(p.recordedAt).toFixed(1) + ',' + y(p.mcPct).toFixed(1))
    .join(' '),
);
const emcPath = computed(() => {
  let pen = false;
  return props.points
    .map((p) => {
      if (p.emcPct === null) {
        pen = false;
        return '';
      }
      const cmd = pen ? 'L' : 'M';
      pen = true;
      return cmd + x(p.recordedAt).toFixed(1) + ',' + y(p.emcPct).toFixed(1);
    })
    .filter(Boolean)
    .join(' ');
});

const weightDots = computed(() =>
  props.points
    .filter((p) => p.kind === 'weight')
    .map((p) => ({ x: x(p.recordedAt), y: y(p.mcPct) })),
);

const yTicks = computed(() => {
  const ticks: number[] = [];
  for (let v = 0; v <= mcMax.value; v += 10) ticks.push(v);
  return ticks;
});

const xTicks = computed(() => {
  const spanH = (t1.value - t0.value) / 3_600_000;
  const ticks: { x: number; label: string }[] = [];
  const stepH = spanH <= 48 ? 6 : spanH <= 240 ? 24 : 48;
  for (let h = 0; h <= spanH; h += stepH) {
    ticks.push({
      x: PAD.l + (h / Math.max(spanH, 1e-9)) * (W.value - PAD.l - PAD.r),
      label: h + 'h',
    });
  }
  return ticks;
});

const transitionLines = computed(() =>
  props.transitions.slice(1).map((tr) => ({ x: x(tr.enteredAt), stageNo: tr.stageNo })),
);
</script>

<template>
  <svg :viewBox="viewBox" class="mc-chart" role="img" aria-label="含水率曲线">
    <g>
      <line
        v-for="v in yTicks"
        :key="'grid' + v"
        :x1="PAD.l"
        :x2="W - PAD.r"
        :y1="y(v)"
        :y2="y(v)"
        stroke="#e6e9ed"
      />
      <text
        v-for="v in yTicks"
        :key="'yt' + v"
        :x="PAD.l - 6"
        :y="y(v) + 4"
        text-anchor="end"
        font-size="11"
        fill="#66788a"
      >{{ v }}</text>
    </g>
    <g>
      <text
        v-for="(t, i) in xTicks"
        :key="'xt' + i"
        :x="t.x"
        :y="H - 8"
        text-anchor="middle"
        font-size="11"
        fill="#66788a"
      >{{ t.label }}</text>
    </g>
    <g>
      <line
        v-for="(tr, i) in transitionLines"
        :key="'tl' + i"
        :x1="tr.x"
        :x2="tr.x"
        :y1="PAD.t"
        :y2="H - PAD.b"
        stroke="#1d7a46"
        stroke-dasharray="4 3"
        stroke-width="1"
      />
      <text
        v-for="(tr, i) in transitionLines"
        :key="'ts' + i"
        :x="tr.x + 3"
        :y="PAD.t + 10"
        font-size="10"
        fill="#1d7a46"
      >→阶段{{ tr.stageNo }}</text>
    </g>
    <path :d="emcPath" fill="none" stroke="#8a6d3b" stroke-width="1.4" stroke-dasharray="2 3" />
    <path :d="mcPath" fill="none" stroke="#1f6fb2" stroke-width="2" />
    <circle
      v-for="(w, i) in weightDots"
      :key="'w' + i"
      :cx="w.x"
      :cy="w.y"
      r="3.6"
      fill="#c0392b"
    />
  </svg>
</template>

<style scoped>
.mc-chart {
  width: 100%;
  height: auto;
  background: #fff;
}
</style>
