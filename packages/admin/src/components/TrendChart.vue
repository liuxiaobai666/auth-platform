<script setup lang="ts">
import { computed } from 'vue';

/**
 * 纯 SVG 折线图。零依赖，两条线（激活数 / 新增卡密），带网格、悬停不做（保持简单）。
 * 后台趋势图不需要重型图表库，SVG 足够且加载快。
 */
const props = defineProps<{
  dates: string[];
  series: { name: string; data: number[]; color: string }[];
  height?: number;
}>();

const W = 760;
const H = computed(() => props.height ?? 220);
const PAD = { top: 16, right: 16, bottom: 28, left: 36 };

const maxY = computed(() => {
  const all = props.series.flatMap((s) => s.data);
  return Math.max(10, Math.ceil(Math.max(...all, 1) / 5) * 5);
});

const plotW = computed(() => W - PAD.left - PAD.right);
const plotH = computed(() => H.value - PAD.top - PAD.bottom);

function x(i: number) {
  const n = props.dates.length;
  return PAD.left + (n <= 1 ? plotW.value / 2 : (i / (n - 1)) * plotW.value);
}
function y(v: number) {
  return PAD.top + plotH.value - (v / maxY.value) * plotH.value;
}

const linePath = (data: number[]) =>
  data.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');

// Y 轴刻度
const yTicks = computed(() => {
  const ticks = [];
  for (let i = 0; i <= 4; i++) ticks.push(Math.round((maxY.value / 4) * i));
  return ticks;
});
// X 轴只标几个日期，避免拥挤
const xLabels = computed(() => {
  const n = props.dates.length;
  const step = Math.max(1, Math.ceil(n / 7));
  return props.dates.map((d, i) => ({ i, label: d.slice(5), show: i % step === 0 || i === n - 1 }));
});
</script>

<template>
  <div class="chart-wrap">
    <div class="legend">
      <span v-for="s in series" :key="s.name" class="legend-item">
        <span class="dot" :style="{ background: s.color }" />{{ s.name }}
      </span>
    </div>
    <svg :viewBox="`0 0 ${W} ${H}`" class="chart" preserveAspectRatio="xMidYMid meet">
      <!-- 网格线 + Y 刻度 -->
      <g>
        <template v-for="(t, idx) in yTicks" :key="idx">
          <line :x1="PAD.left" :y1="y(t)" :x2="W - PAD.right" :y2="y(t)"
                stroke="var(--c-border)" stroke-width="1" :stroke-dasharray="idx === 0 ? '0' : '3 3'" />
          <text :x="PAD.left - 8" :y="y(t) + 4" text-anchor="end" class="axis-text">{{ t }}</text>
        </template>
      </g>
      <!-- X 标签 -->
      <g>
        <template v-for="l in xLabels" :key="l.i">
          <text v-if="l.show" :x="x(l.i)" :y="H - 8" text-anchor="middle" class="axis-text">{{ l.label }}</text>
        </template>
      </g>
      <!-- 折线 + 点 -->
      <g v-for="s in series" :key="s.name">
        <path :d="linePath(s.data)" fill="none" :stroke="s.color" stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round" />
        <circle v-for="(v, i) in s.data" :key="i" :cx="x(i)" :cy="y(v)" r="2.5" :fill="s.color" />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.chart-wrap { width: 100%; }
.chart { width: 100%; height: auto; display: block; }
.legend { display: flex; gap: 16px; margin-bottom: 8px; }
.legend-item { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--c-text-soft); }
.dot { width: 9px; height: 9px; border-radius: 3px; }
.axis-text { font-size: 10.5px; fill: var(--c-text-mute); font-family: var(--font-mono); }
</style>
