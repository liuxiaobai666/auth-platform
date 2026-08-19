<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, post } from '@/api/http';
import type { Application, License, Paged, Plan } from '@/api/types';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const loading = ref(false);
const rows = ref<License[]>([]);
const total = ref(0);
const apps = ref<Application[]>([]);
const plans = ref<Plan[]>([]);
const selected = ref<License[]>([]);

const query = reactive({
  application_id: '', plan_id: '', status: '', batch_id: '',
  key_prefix: '', key: '', page: 1, page_size: 20,
});

const genVisible = ref(false);
const gen = reactive({ plan_id: '', count: 10, prefix: '', groups: 5, note: '', channel: '' });
const genResult = ref<{ batch_id: string; count: number; keys: string[] } | null>(null);

const statusMeta: Record<string, { type: any; label: string }> = {
  unused: { type: 'info', label: '未激活' },
  active: { type: 'success', label: '使用中' },
  expired: { type: 'warning', label: '已过期' },
  banned: { type: 'danger', label: '已封禁' },
  revoked: { type: 'danger', label: '已作废' },
};

async function load() {
  loading.value = true;
  try {
    const res = await get<Paged<License>>('/admin/licenses', {
      ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '' && v !== undefined)),
    });
    rows.value = res.items;
    total.value = res.total;
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  const [a, p] = await Promise.all([
    get<{ items: Application[] }>('/admin/applications', { page_size: 100 }),
    get<{ items: Plan[] }>('/admin/plans'),
  ]);
  apps.value = a.items;
  plans.value = p.items;
  // 从批次管理页跳转过来时，URL 带 batch_id，自动预填并筛选
  if (route.query.batch_id) query.batch_id = String(route.query.batch_id);
  await load();
});

function resetQuery() {
  Object.assign(query, { application_id: '', plan_id: '', status: '', batch_id: '', key_prefix: '', key: '', page: 1 });
  load();
}

async function doGenerate() {
  if (!gen.plan_id) { ElMessage.warning('请选择套餐'); return; }
  const res = await post<any>('/admin/licenses/generate', {
    plan_id: gen.plan_id, count: gen.count, groups: gen.groups,
    prefix: gen.prefix || undefined, note: gen.note || undefined,
    channel: gen.channel || undefined,
  });
  genResult.value = res;
  await load();
}

function downloadKeys() {
  const blob = new Blob([genResult.value!.keys.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `卡密-${genResult.value!.batch_id}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function closeGen() {
  genVisible.value = false;
  genResult.value = null;
  Object.assign(gen, { plan_id: '', count: 10, prefix: '', groups: 5, note: '', channel: '' });
}

/** 导出明文卡密：服务端会写审计日志并记录导出批次 */
async function exportCsv() {
  if (!query.batch_id && !query.application_id && !selected.value.length) {
    ElMessage.warning('导出必须先按批次或应用筛选，或勾选具体卡密，不允许全量导出');
    return;
  }
  await ElMessageBox.confirm('导出会解密卡密明文并记入审计日志，确认继续？', '导出卡密', { type: 'warning' });
  const body: any = selected.value.length
    ? { ids: selected.value.map((r) => r.id) }
    : { batch_id: query.batch_id || undefined, application_id: query.application_id || undefined,
        status: query.status || undefined };
  const res = await post<{ count: number; csv: string }>('/admin/licenses/export', body);
  const blob = new Blob([`﻿${res.csv}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `卡密导出-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  ElMessage.success(`已导出 ${res.count} 条`);
}

async function ban(row: License) {
  const { value } = await ElMessageBox.prompt('封禁原因（会记入审计日志）', '封禁卡密', {
    inputValidator: (v) => !!v?.trim() || '必须填写原因',
  });
  await post(`/admin/licenses/${row.id}/ban`, { reason: value });
  ElMessage.success('已封禁，该卡密的授权令牌已立即失效');
  await load();
}

async function batchBan() {
  const { value } = await ElMessageBox.prompt(`将封禁 ${selected.value.length} 张卡密，请填写原因`, '批量封禁', {
    inputValidator: (v) => !!v?.trim() || '必须填写原因',
  });
  const res = await post<any>('/admin/licenses/batch/ban', {
    ids: selected.value.map((r) => r.id), reason: value,
  });
  ElMessage.success(`已封禁 ${res.affected} 张`);
  await load();
}

async function unban(row: License) {
  await post(`/admin/licenses/${row.id}/unban`);
  ElMessage.success('已解封');
  await load();
}

async function revoke(row: License) {
  const { value } = await ElMessageBox.prompt('作废是终态，之后无法恢复。请填写原因', '作废卡密', {
    type: 'error', inputValidator: (v) => !!v?.trim() || '必须填写原因',
  });
  await post(`/admin/licenses/${row.id}/revoke`, { reason: value });
  ElMessage.success('已作废');
  await load();
}

async function renew(row: License) {
  const { value } = await ElMessageBox.prompt('续期天数', '卡密续期', {
    inputValue: '30', inputPattern: /^[1-9]\d*$/, inputErrorMessage: '请输入正整数',
  });
  const res = await post<any>(`/admin/licenses/${row.id}/renew`, { days: Number(value) });
  ElMessage.success(`已续期至 ${new Date(res.expires_at).toLocaleString()}`);
  await load();
}
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>卡密管理</h2>
        <div class="sub">列表只显示脱敏卡密。查看明文需要导出权限，且每次导出都会留痕</div>
      </div>
      <div>
        <el-button v-if="auth.can('license:export')" @click="exportCsv">
          <el-icon><Download /></el-icon>导出明文
        </el-button>
        <el-button v-if="auth.can('license:write')" type="primary" @click="genVisible = true">
          <el-icon><Plus /></el-icon>生成卡密
        </el-button>
      </div>
    </div>

    <div class="filter-bar">
      <el-select v-model="query.application_id" placeholder="全部应用" clearable style="width:180px" @change="load">
        <el-option v-for="a in apps" :key="a.id" :label="a.name" :value="a.id" />
      </el-select>
      <el-select v-model="query.plan_id" placeholder="全部套餐" clearable style="width:160px" @change="load">
        <el-option v-for="p in plans" :key="p.id" :label="p.name" :value="p.id" />
      </el-select>
      <el-select v-model="query.status" placeholder="全部状态" clearable style="width:130px" @change="load">
        <el-option v-for="(m, k) in statusMeta" :key="k" :label="m.label" :value="k" />
      </el-select>
      <el-input v-model="query.key_prefix" placeholder="按卡密前缀搜索" style="width:170px" clearable @keyup.enter="load" />
      <el-input v-model="query.key" placeholder="输入完整卡密精确查找" style="width:230px" clearable @keyup.enter="load" />
      <el-input v-model="query.batch_id" placeholder="批次号" style="width:200px" clearable @keyup.enter="load" />
      <el-button type="primary" @click="query.page = 1; load()">查询</el-button>
      <el-button @click="resetQuery">重置</el-button>
      <el-button v-if="selected.length && auth.can('license:ban')" type="danger" plain @click="batchBan">
        批量封禁 ({{ selected.length }})
      </el-button>
    </div>

    <el-table :data="rows" v-loading="loading" border @selection-change="selected = $event">
      <el-table-column type="selection" width="44" />
      <el-table-column label="卡密" width="290">
        <template #default="{ row }">
          <span class="mono key-cell">{{ row.key_masked }}</span>
        </template>
      </el-table-column>
      <el-table-column label="应用 / 套餐" width="120">
        <template #default="{ row }">
          <div class="mono">{{ row.app_id }}</div>
          <div class="sub">{{ row.plan_name }}</div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="86">
        <template #default="{ row }">
          <el-tag :type="statusMeta[row.status]?.type" size="small" effect="light">
            {{ statusMeta[row.status]?.label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="设备" width="66" align="center">
        <template #default="{ row }">
          <span class="tabular">{{ row.device_count ?? 0 }}/{{ row.device_limit }}</span>
        </template>
      </el-table-column>
      <el-table-column label="换绑" width="66" align="center">
        <template #default="{ row }">
          <span v-if="!row.allow_rebind" class="sub">禁止</span>
          <span v-else class="tabular">{{ row.rebind_count }}/{{ row.rebind_limit ?? '∞' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="到期时间" min-width="150">
        <template #default="{ row }">
          <el-tag v-if="row.is_permanent" type="success" size="small" effect="plain">永久</el-tag>
          <span v-else-if="row.expires_at" class="tabular">
            {{ new Date(row.expires_at).toLocaleString('zh-CN', { hour12: false }) }}
          </span>
          <span v-else class="sub">未激活</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="130" fixed="right" align="right">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="router.push(`/licenses/${row.id}`)">
            详情
          </el-button>
          <el-dropdown v-if="auth.can('license:ban') || auth.can('license:write')"
                       trigger="click" style="margin-left: 4px; vertical-align: middle">
            <el-button size="small" text><el-icon><MoreFilled /></el-icon></el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <template v-if="auth.can('license:ban')">
                  <el-dropdown-item v-if="row.status === 'banned'" @click="unban(row)">解除封禁</el-dropdown-item>
                  <el-dropdown-item v-else-if="row.status !== 'revoked'" @click="ban(row)">封禁卡密</el-dropdown-item>
                </template>
                <el-dropdown-item
                  v-if="auth.can('license:write') && !row.is_permanent && row.status !== 'revoked'"
                  @click="renew(row)">续期</el-dropdown-item>
                <el-dropdown-item v-if="auth.can('license:ban') && row.status !== 'revoked'"
                                  divided @click="revoke(row)">作废（不可恢复）</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </el-table-column>

      <template #empty>
        <div style="padding: 28px 0">
          <el-empty :image-size="72"
                    :description="total === 0 ? '还没有卡密' : '没有符合筛选条件的卡密'">
            <el-button v-if="auth.can('license:write')" type="primary" @click="genVisible = true">
              生成第一批卡密
            </el-button>
          </el-empty>
        </div>
      </template>
    </el-table>

    <el-pagination style="margin-top:14px;justify-content:flex-end" background layout="total, sizes, prev, pager, next"
                   :total="total" v-model:current-page="query.page" v-model:page-size="query.page_size"
                   :page-sizes="[20, 50, 100]" @current-change="load" @size-change="load" />

    <el-dialog v-model="genVisible" title="生成卡密" width="620px" :close-on-click-modal="false" @closed="closeGen">
      <template v-if="!genResult">
        <el-form label-width="100px">
          <el-form-item label="套餐" required>
            <el-select v-model="gen.plan_id" style="width:100%" placeholder="选择套餐">
              <el-option v-for="p in plans.filter(x => x.status === 'active')" :key="p.id"
                         :label="`${p.app_id} / ${p.name}（${p.is_permanent ? '永久' : p.duration_days + '天'}，${p.device_limit}台）`"
                         :value="p.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="生成数量"><el-input-number v-model="gen.count" :min="1" :max="5000" /></el-form-item>
          <el-form-item label="卡密前缀">
            <el-input v-model="gen.prefix" placeholder="选填，如 VIP，最终形如 VIP-XXXXX-XXXXX-..." maxlength="8" />
          </el-form-item>
          <el-form-item label="分组数">
            <el-radio-group v-model="gen.groups">
              <el-radio-button :value="4">4 组（≈98 位）</el-radio-button>
              <el-radio-button :value="5">5 组（≈122 位）</el-radio-button>
              <el-radio-button :value="6">6 组（≈147 位）</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="备注"><el-input v-model="gen.note" placeholder="选填，例如：双十一活动" /></el-form-item>
          <el-form-item label="渠道标记">
            <el-input v-model="gen.channel" placeholder="选填，如 发卡网A。用于追踪这批卡卖到哪、定位盗版来源" maxlength="64" />
          </el-form-item>
        </el-form>
        <el-alert type="warning" :closable="false"
                  title="明文卡密只在生成后这一次完整展示，请务必下载保存。之后需要明文必须走导出流程并留痕" />
      </template>

      <template v-else>
        <el-result icon="success" :title="`成功生成 ${genResult.count} 张卡密`"
                   :sub-title="`批次号 ${genResult.batch_id}`" />
        <div class="key-list">
          <div v-for="k in genResult.keys" :key="k">{{ k }}</div>
        </div>
      </template>

      <template #footer>
        <template v-if="!genResult">
          <el-button @click="genVisible = false">取消</el-button>
          <el-button type="primary" @click="doGenerate">生成</el-button>
        </template>
        <template v-else>
          <el-button type="primary" @click="downloadKeys">
            <el-icon><Download /></el-icon>下载 TXT
          </el-button>
          <el-button @click="closeGen">完成</el-button>
        </template>
      </template>
    </el-dialog>
  </div>
</template>
