<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { get } from '@/api/http';
import type { Application } from '@/api/types';
import TrendChart from '@/components/TrendChart.vue';

const router = useRouter();
const loading = ref(true);
const overview = ref<any>({ by_status: {} });
const trend = ref<any>({ dates: [], activations: [], new_licenses: [] });
const byApp = ref<any[]>([]);
const apps = ref<Application[]>([]);
const trendDays = ref(30);

async function loadTrend() {
  trend.value = await get('/admin/analytics/trend', { days: trendDays.value });
}

onMounted(async () => {
  try {
    const [ov, tr, ba, ap] = await Promise.all([
      get<any>('/admin/analytics/overview'),
      get<any>('/admin/analytics/trend', { days: trendDays.value }),
      get<any[]>('/admin/analytics/by-application'),
      get<{ items: Application[] }>('/admin/applications', { page_size: 100 }),
    ]);
    overview.value = ov;
    trend.value = tr;
    byApp.value = ba;
    apps.value = ap.items;
  } finally {
    loading.value = false;
  }
});

const primary = computed(() => [
  { label: '卡密总数', value: overview.value.total_licenses ?? 0, color: 'var(--c-primary)' },
  { label: '核销率', value: (overview.value.redemption_rate ?? 0) + '%', color: 'var(--c-success)' },
  { label: '在线绑定设备', value: overview.value.active_devices ?? 0, color: '#0e7490' },
  { label: '今日激活', value: overview.value.today_activations ?? 0, color: '#7c3aed' },
]);

const trendSeries = computed(() => [
  { name: '每日激活', data: trend.value.activations, color: '#2f6feb' },
  { name: '每日新增卡密', data: trend.value.new_licenses, color: '#16a34a' },
]);

const breakdown = computed(() => {
  const by = overview.value.by_status ?? {};
  const rows = [
    { key: 'unused', label: '未激活', value: by.unused ?? 0, color: '#94a3b8' },
    { key: 'active', label: '使用中', value: by.active ?? 0, color: '#1a7f4b' },
    { key: 'expired', label: '已过期', value: by.expired ?? 0, color: '#a86a00' },
    { key: 'banned', label: '已封禁', value: by.banned ?? 0, color: '#c0362c' },
    { key: 'revoked', label: '已作废', value: by.revoked ?? 0, color: '#7c3aed' },
  ];
  const total = rows.reduce((a, r) => a + r.value, 0) || 1;
  return rows.map((r) => ({ ...r, percent: (r.value / total) * 100 }));
});

const attention = computed(() =>
  apps.value.filter((a) => a.kill_switch || a.maintenance || a.status !== 'active'));

function appRate(rate: number) {
  if (rate >= 50) return 'var(--c-success)';
  if (rate >= 20) return 'var(--c-warning)';
  return 'var(--c-text-mute)';
}
</script>

<template>
  <div v-loading="loading">
    <el-alert v-if="attention.length" type="warning" :closable="false" show-icon style="margin-bottom:16px"
      :title="`有 ${attention.length} 个应用当前不可正常使用：${attention.map(a => a.name).join('、')}`" />

    <!-- 主指标 -->
    <div class="metrics">
      <el-card v-for="m in primary" :key="m.label" class="stat-card" shadow="never" :style="{ '--bar': m.color }">
        <div class="num" :style="{ color: m.color }">{{ m.value }}</div>
        <div class="label">{{ m.label }}</div>
      </el-card>
    </div>

    <!-- 趋势图 -->
    <el-card shadow="never" style="margin-bottom:16px">
      <template #header>
        <div class="card-head">
          <span>经营趋势 <span class="sub" style="font-weight:400">（按 UTC 日期）</span></span>
          <el-radio-group v-model="trendDays" size="small" @change="loadTrend">
            <el-radio-button :value="7">7天</el-radio-button>
            <el-radio-button :value="30">30天</el-radio-button>
            <el-radio-button :value="90">90天</el-radio-button>
          </el-radio-group>
        </div>
      </template>
      <TrendChart v-if="trend.dates.length" :dates="trend.dates" :series="trendSeries" />
    </el-card>

    <div class="grid">
      <!-- 卡密状态分布 -->
      <el-card shadow="never">
        <template #header>
          <div class="card-head">
            <span>卡密状态分布</span>
            <el-button link type="primary" size="small" @click="router.push('/licenses')">
              查看全部<el-icon><ArrowRight /></el-icon>
            </el-button>
          </div>
        </template>
        <div class="bar" v-if="overview.total_licenses">
          <div v-for="r in breakdown.filter(x => x.value)" :key="r.key" class="bar-seg"
               :style="{ width: r.percent + '%', background: r.color }" :title="`${r.label} ${r.value}`" />
        </div>
        <div v-else class="bar bar-empty" />
        <ul class="legend">
          <li v-for="r in breakdown" :key="r.key">
            <span class="dot" :style="{ background: r.color }" />
            <span class="legend-label">{{ r.label }}</span>
            <span class="legend-value tabular">{{ r.value }}</span>
          </li>
        </ul>
      </el-card>

      <!-- 各应用核销对比 -->
      <el-card shadow="never">
        <template #header>
          <div class="card-head">
            <span>各应用核销率</span>
            <el-button link type="primary" size="small" @click="router.push('/batches')">
              批次管理<el-icon><ArrowRight /></el-icon>
            </el-button>
          </div>
        </template>
        <div v-if="byApp.length" class="app-list">
          <div v-for="a in byApp" :key="a.app_id" class="app-row">
            <div class="app-meta">
              <span class="app-name">{{ a.name }}</span>
              <span class="mono sub">{{ a.used }}/{{ a.total }}</span>
            </div>
            <el-progress :percentage="a.redemption_rate" :stroke-width="12" :color="appRate(a.redemption_rate)" />
          </div>
        </div>
        <el-empty v-else :image-size="60" description="还没有数据" />
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 16px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
@media (max-width: 1180px) { .metrics { grid-template-columns: repeat(2, 1fr); } .grid { grid-template-columns: 1fr; } }
.card-head { display: flex; align-items: center; justify-content: space-between; }
.bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--c-surface-sunk); margin-bottom: 18px; }
.bar-seg { transition: width 0.3s; }
.bar-seg + .bar-seg { border-left: 1px solid rgba(255, 255, 255, 0.6); }
.bar-empty { background: var(--c-border); }
.legend { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px 14px; }
.legend li { display: flex; align-items: center; gap: 7px; font-size: 13px; }
.dot { width: 8px; height: 8px; border-radius: 3px; flex-shrink: 0; }
.legend-label { color: var(--c-text-soft); }
.legend-value { margin-left: auto; font-weight: 600; }
.app-list { display: flex; flex-direction: column; gap: 14px; }
.app-meta { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 5px; }
.app-name { font-size: 13.5px; font-weight: 500; }
</style>
