<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { del, get, patch, post } from '@/api/http';
import type { Application } from '@/api/types';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const loading = ref(false);
const rows = ref<any[]>([]);
const apps = ref<Application[]>([]);
const allEvents = ref<string[]>([]);
const appFilter = ref('');

const createVisible = ref(false);
const form = reactive({ application_id: '', url: '', events: [] as string[] });

const secretVisible = ref(false);
const secretText = ref('');

const deliveriesVisible = ref(false);
const deliveries = ref<any[]>([]);
const dTotal = ref(0);
const dQuery = reactive({ endpoint_id: '', status: '', page: 1, page_size: 20 });
const detailRow = ref<any>(null);

const eventLabel: Record<string, string> = {
  'license.activated': '卡密激活',
  'license.banned': '卡密封禁',
  'license.unbanned': '卡密解封',
  'license.revoked': '卡密作废',
  'license.renewed': '卡密续期',
  'license.device_bound': '设备绑定',
  'license.device_unbound': '设备解绑',
};

async function load() {
  loading.value = true;
  try {
    rows.value = (await get<{ items: any[] }>('/admin/webhooks', {
      application_id: appFilter.value || undefined,
    })).items;
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  const [a, e] = await Promise.all([
    get<{ items: Application[] }>('/admin/applications', { page_size: 100 }),
    get<string[]>('/admin/webhooks/events'),
  ]);
  apps.value = a.items;
  allEvents.value = e;
  await load();
});

function openCreate() {
  Object.assign(form, { application_id: appFilter.value || apps.value[0]?.id || '', url: '', events: [] });
  createVisible.value = true;
}

async function create() {
  if (!form.application_id || !form.url) { ElMessage.warning('请填写应用和地址'); return; }
  const res = await post<any>('/admin/webhooks', {
    application_id: form.application_id, url: form.url,
    events: form.events.length ? form.events : undefined,
  });
  createVisible.value = false;
  secretText.value = res.secret;
  secretVisible.value = true;
  await load();
}

async function toggle(row: any) {
  await patch(`/admin/webhooks/${row.id}`, { enabled: !row.enabled });
  await load();
}

async function remove(row: any) {
  await ElMessageBox.confirm(`确认删除这个 Webhook？接入方将不再收到事件。`, '删除', { type: 'warning' });
  await del(`/admin/webhooks/${row.id}`);
  await load();
}

async function showSecret(row: any) {
  await ElMessageBox.confirm('查看签名密钥会记入审计日志，确认继续？', '查看密钥', { type: 'warning' });
  const res = await get<any>(`/admin/webhooks/${row.id}/secret`);
  secretText.value = res.secret;
  secretVisible.value = true;
}

async function openDeliveries(row: any) {
  dQuery.endpoint_id = row.id;
  dQuery.status = '';
  dQuery.page = 1;
  await loadDeliveries();
  deliveriesVisible.value = true;
}

async function loadDeliveries() {
  const res = await get<any>('/admin/webhooks/deliveries', { ...dQuery });
  deliveries.value = res.items;
  dTotal.value = res.total;
}

async function redeliver(d: any) {
  await post(`/admin/webhooks/deliveries/${d.id}/redeliver`);
  ElMessage.success('已重新投递');
  await loadDeliveries();
}

async function copy(t: string) { await navigator.clipboard.writeText(t); ElMessage.success('已复制'); }

const statusMeta: Record<string, { type: any; label: string }> = {
  pending: { type: 'info', label: '待投递' },
  delivered: { type: 'success', label: '成功' },
  failed: { type: 'warning', label: '重试中' },
  dead: { type: 'danger', label: '已失败' },
};
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>Webhook 推送</h2>
        <div class="sub">
          卡密激活、封禁、作废、设备绑定/解绑等事件，实时签名推送到你配置的地址，用于业务联动。
          失败会按 1s→5s→30s→2m→10m→1h 退避重试，共 6 次
        </div>
      </div>
      <el-button v-if="auth.can('application:write')" type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>新建 Webhook
      </el-button>
    </div>

    <div class="filter-bar">
      <el-select v-model="appFilter" placeholder="全部应用" clearable style="width:220px" @change="load">
        <el-option v-for="a in apps" :key="a.id" :label="`${a.name} (${a.app_id})`" :value="a.id" />
      </el-select>
    </div>

    <el-table :data="rows" v-loading="loading" border>
      <el-table-column label="应用" width="140">
        <template #default="{ row }"><span class="mono">{{ row.app_id }}</span></template>
      </el-table-column>
      <el-table-column label="推送地址" min-width="240">
        <template #default="{ row }"><span class="mono">{{ row.url }}</span></template>
      </el-table-column>
      <el-table-column label="订阅事件" min-width="180">
        <template #default="{ row }">
          <span v-if="!row.events" class="sub">全部事件</span>
          <div v-else>
            <el-tag v-for="e in row.events" :key="e" size="small" style="margin:1px 3px 1px 0">
              {{ eventLabel[e] || e }}
            </el-tag>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.enabled ? 'success' : 'info'" size="small" effect="light">
            {{ row.enabled ? '启用' : '停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="230" fixed="right" align="right">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="openDeliveries(row)">投递记录</el-button>
          <template v-if="auth.can('application:write')">
            <el-button size="small" link @click="showSecret(row)">密钥</el-button>
            <el-button size="small" link @click="toggle(row)">{{ row.enabled ? '停用' : '启用' }}</el-button>
            <el-button size="small" link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </template>
      </el-table-column>
      <template #empty>
        <div style="padding:24px 0"><el-empty :image-size="64" description="还没有 Webhook" /></div>
      </template>
    </el-table>

    <!-- 新建 -->
    <el-dialog v-model="createVisible" title="新建 Webhook" width="560px">
      <el-form label-width="90px">
        <el-form-item label="应用" required>
          <el-select v-model="form.application_id" style="width:100%">
            <el-option v-for="a in apps" :key="a.id" :label="`${a.name} (${a.app_id})`" :value="a.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="推送地址" required>
          <el-input v-model="form.url" placeholder="https://your-server.com/webhook" />
          <div class="sub">你的服务器接收事件的地址，必须能公网访问</div>
        </el-form-item>
        <el-form-item label="订阅事件">
          <el-select v-model="form.events" multiple style="width:100%" placeholder="留空 = 全部事件">
            <el-option v-for="e in allEvents" :key="e" :label="`${eventLabel[e] || e}  (${e})`" :value="e" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" @click="create">创建</el-button>
      </template>
    </el-dialog>

    <!-- 密钥 -->
    <el-dialog v-model="secretVisible" title="Webhook 签名密钥" width="600px">
      <el-alert type="warning" :closable="false" style="margin-bottom:14px"
        title="用这个密钥验证推送的真实性。收到请求时用 HMAC-SHA256(密钥, X-Timestamp + '.' + 请求体) 算出签名，与 X-Signature 比对。" />
      <el-input :model-value="secretText" readonly class="mono">
        <template #append><el-button @click="copy(secretText)">复制</el-button></template>
      </el-input>
      <template #footer><el-button type="primary" @click="secretVisible = false">我已保存</el-button></template>
    </el-dialog>

    <!-- 投递记录 -->
    <el-drawer v-model="deliveriesVisible" title="投递记录" size="720px">
      <div class="filter-bar">
        <el-select v-model="dQuery.status" placeholder="全部状态" clearable style="width:130px" @change="dQuery.page=1; loadDeliveries()">
          <el-option v-for="(m,k) in statusMeta" :key="k" :label="m.label" :value="k" />
        </el-select>
      </div>
      <el-table :data="deliveries" size="small" border>
        <el-table-column label="事件" width="150">
          <template #default="{ row }">
            <div>{{ eventLabel[row.event_type] || row.event_type }}</div>
            <div class="tabular sub">{{ new Date(row.created_at).toLocaleString('zh-CN',{hour12:false}) }}</div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="statusMeta[row.status]?.type" size="small" effect="light">{{ statusMeta[row.status]?.label }}</el-tag>
            <div class="sub">{{ row.attempts }}/{{ row.max_attempts }} 次</div>
          </template>
        </el-table-column>
        <el-table-column label="详情" min-width="150">
          <template #default="{ row }">
            <div v-if="row.last_status_code" class="sub">HTTP {{ row.last_status_code }}</div>
            <div v-if="row.last_error" class="mono sub" style="color:var(--c-danger)">{{ row.last_error }}</div>
            <el-button link type="primary" size="small" @click="detailRow = row">查看 payload</el-button>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" align="right">
          <template #default="{ row }">
            <el-button v-if="row.status !== 'delivered' && auth.can('application:write')"
                       size="small" link type="primary" @click="redeliver(row)">重投</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination style="margin-top:12px;justify-content:flex-end" background small layout="total, prev, pager, next"
                     :total="dTotal" v-model:current-page="dQuery.page" @current-change="loadDeliveries" />

      <el-dialog v-model="detailRow" title="事件 payload" width="560px" append-to-body>
        <div class="code-block" v-if="detailRow">
          <pre><code>{{ JSON.stringify(detailRow.payload, null, 2) }}</code></pre>
        </div>
      </el-dialog>
    </el-drawer>
  </div>
</template>

<style scoped>
.code-block { background: #12161c; border-radius: 8px; padding: 14px; overflow: auto; max-height: 400px; }
.code-block code { font-family: var(--font-mono); font-size: 12.5px; color: #d6deeb; white-space: pre; }
</style>
