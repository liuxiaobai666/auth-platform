<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import { get } from '@/api/http';
import type { Application } from '@/api/types';

const tab = ref<'activations' | 'audit' | 'login' | 'api'>('activations');
const loading = ref(false);
const rows = ref<any[]>([]);
const total = ref(0);
const apps = ref<Application[]>([]);

const q = reactive({
  page: 1, page_size: 20,
  application_id: '', action: '', success: '', code: '', username: '', plugin_id: '',
});

async function load() {
  loading.value = true;
  try {
    const params = Object.fromEntries(Object.entries(q).filter(([, v]) => v !== '' && v !== undefined));
    const res = await get<any>(`/admin/logs/${tab.value}`, params);
    rows.value = res.items;
    total.value = res.total;
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  apps.value = (await get<{ items: Application[] }>('/admin/applications', { page_size: 100 })).items;
  await load();
});

watch(tab, () => {
  Object.assign(q, { page: 1, application_id: '', action: '', success: '', code: '', username: '', plugin_id: '' });
  load();
});

const actionLabel: Record<string, string> = {
  activate: '激活', verify: '验证', deactivate: '解绑', status: '查状态', policy: '拉策略',
};
const fmt = (t: string) => new Date(t).toLocaleString();
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>日志审计</h2>
        <div class="sub">授权流水、管理员操作、登录记录和 API 调用都在这里追溯。日志中不含卡密原文与完整设备指纹</div>
      </div>
    </div>

    <el-tabs v-model="tab">
      <el-tab-pane label="授权日志" name="activations" />
      <el-tab-pane label="管理员操作" name="audit" />
      <el-tab-pane label="登录记录" name="login" />
      <el-tab-pane label="API 请求" name="api" />
    </el-tabs>

    <div class="filter-bar">
      <template v-if="tab === 'activations'">
        <el-select v-model="q.application_id" placeholder="全部应用" clearable style="width:180px" @change="load">
          <el-option v-for="a in apps" :key="a.id" :label="a.name" :value="a.id" />
        </el-select>
        <el-select v-model="q.action" placeholder="全部动作" clearable style="width:130px" @change="load">
          <el-option v-for="(l, k) in actionLabel" :key="k" :label="l" :value="k" />
        </el-select>
        <el-select v-model="q.success" placeholder="全部结果" clearable style="width:120px" @change="load">
          <el-option label="成功" value="true" />
          <el-option label="失败" value="false" />
        </el-select>
        <el-input v-model="q.code" placeholder="错误码，如 LICENSE_EXPIRED" style="width:220px" clearable @keyup.enter="load" />
      </template>
      <template v-else-if="tab === 'audit'">
        <el-input v-model="q.action" placeholder="操作类型，如 license.ban" style="width:220px" clearable @keyup.enter="load" />
        <el-input v-model="q.username" placeholder="管理员用户名" style="width:180px" clearable @keyup.enter="load" />
      </template>
      <template v-else-if="tab === 'login'">
        <el-input v-model="q.username" placeholder="用户名" style="width:180px" clearable @keyup.enter="load" />
        <el-select v-model="q.success" placeholder="全部结果" clearable style="width:120px" @change="load">
          <el-option label="成功" value="true" />
          <el-option label="失败" value="false" />
        </el-select>
      </template>
      <template v-else>
        <el-input v-model="q.plugin_id" placeholder="plugin_id" style="width:200px" clearable @keyup.enter="load" />
        <el-input v-model="q.code" placeholder="错误码" style="width:200px" clearable @keyup.enter="load" />
      </template>
      <el-button type="primary" @click="q.page = 1; load()">查询</el-button>
    </div>

    <el-table :data="rows" v-loading="loading" border size="small">
      <el-table-column label="时间" width="164">
        <template #default="{ row }">{{ fmt(row.created_at) }}</template>
      </el-table-column>

      <template v-if="tab === 'activations'">
        <el-table-column label="应用" width="100"><template #default="{ row }">
          <span class="mono">{{ row.app_id ?? '—' }}</span></template>
        </el-table-column>
        <el-table-column label="动作" width="72"><template #default="{ row }">
          {{ actionLabel[row.action] ?? row.action }}</template>
        </el-table-column>
        <el-table-column label="结果" width="168"><template #default="{ row }">
          <el-tag v-if="row.success" type="success" size="small" effect="light">成功</el-tag>
          <el-tag v-else type="danger" size="small" effect="light">{{ row.code }}</el-tag></template>
        </el-table-column>
        <el-table-column label="设备" width="152"><template #default="{ row }">
          <span class="mono">{{ row.device_id ?? '—' }}</span></template>
        </el-table-column>
        <el-table-column label="版本" width="66" prop="client_version" />
        <el-table-column label="IP" width="108" prop="ip" />
        <el-table-column label="request_id" min-width="180" show-overflow-tooltip>
          <template #default="{ row }"><span class="mono">{{ row.request_id }}</span></template>
        </el-table-column>
      </template>

      <template v-else-if="tab === 'audit'">
        <el-table-column label="管理员" width="100" prop="username" />
        <el-table-column label="操作" width="180"><template #default="{ row }">
          <span class="mono">{{ row.action }}</span></template>
        </el-table-column>
        <el-table-column label="对象" width="200" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="mono sub">{{ row.target_type }} {{ row.target_id ?? '' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="明细" min-width="220" show-overflow-tooltip>
          <template #default="{ row }"><span class="mono sub">{{ JSON.stringify(row.detail) }}</span></template>
        </el-table-column>
        <el-table-column label="IP" width="108" prop="ip" />
      </template>

      <template v-else-if="tab === 'login'">
        <el-table-column label="用户名" width="150" prop="username" />
        <el-table-column label="结果" width="160"><template #default="{ row }">
          <el-tag v-if="row.success" type="success" size="small" effect="light">登录成功</el-tag>
          <el-tag v-else type="danger" size="small" effect="light">{{ row.fail_reason }}</el-tag></template>
        </el-table-column>
        <el-table-column label="IP" width="150" prop="ip" />
        <el-table-column min-width="60" />
      </template>

      <template v-else>
        <el-table-column label="方法" width="64" prop="method" />
        <el-table-column label="路径" min-width="220" show-overflow-tooltip>
          <template #default="{ row }"><span class="mono">{{ row.path }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="70" align="center"><template #default="{ row }">
          <span class="tabular"
                :style="{ color: row.status_code >= 400 ? 'var(--c-danger)' : 'var(--c-success)', fontWeight: 600 }">
            {{ row.status_code }}</span></template>
        </el-table-column>
        <el-table-column label="错误码" width="172"><template #default="{ row }">
          <span class="mono">{{ row.code ?? '—' }}</span></template>
        </el-table-column>
        <el-table-column label="耗时" width="76" align="right"><template #default="{ row }">
          <span class="tabular">{{ row.duration_ms }} ms</span></template>
        </el-table-column>
        <el-table-column label="插件" width="140"><template #default="{ row }">
          <span class="mono">{{ row.plugin_id ?? '—' }}</span></template>
        </el-table-column>
      </template>
    </el-table>

    <el-pagination style="margin-top:14px;justify-content:flex-end" background
                   layout="total, sizes, prev, pager, next" :total="total"
                   v-model:current-page="q.page" v-model:page-size="q.page_size"
                   :page-sizes="[20, 50, 100]" @current-change="load" @size-change="load" />
  </div>
</template>
