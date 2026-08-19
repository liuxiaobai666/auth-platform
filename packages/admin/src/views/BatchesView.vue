<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { get, patch, post } from '@/api/http';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const loading = ref(false);
const rows = ref<any[]>([]);
const total = ref(0);
const apps = ref<{ id: string; name: string; app_id: string }[]>([]);
const channels = ref<string[]>([]);

const query = reactive({ application_id: '', channel: '', keyword: '', page: 1, page_size: 20 });

const editVisible = ref(false);
const editing = ref<any>(null);
const form = reactive({ channel: '', note: '' });

async function load() {
  loading.value = true;
  try {
    const res = await get<any>('/admin/batches', {
      ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '' && v !== undefined)),
    });
    rows.value = res.items;
    total.value = res.total;
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  const [a, c] = await Promise.all([
    get<{ items: any[] }>('/admin/applications', { page_size: 100 }),
    get<string[]>('/admin/batches/channels'),
  ]);
  apps.value = a.items;
  channels.value = c;
  await load();
});

function openEdit(row: any) {
  editing.value = row;
  form.channel = row.channel ?? '';
  form.note = row.note ?? '';
  editVisible.value = true;
}

async function saveEdit() {
  await patch(`/admin/batches/${editing.value.id}`, { channel: form.channel, note: form.note });
  ElMessage.success('已更新');
  editVisible.value = false;
  await load();
}

async function revokeAll(row: any) {
  const { value } = await ElMessageBox.prompt(
    `将作废批次「${row.channel || row.id}」下所有未作废的卡密（共 ${row.stats.total} 张，其中 ${row.stats.used} 张已使用）。` +
      '已激活设备会立即失效。此操作不可撤销，请填写原因。',
    '整批作废',
    { type: 'error', inputValidator: (v) => !!v?.trim() || '必须填写原因' },
  );
  const res = await post<any>(`/admin/batches/${row.id}/revoke-all`, { reason: value });
  ElMessage.success(`已作废 ${res.affected} 张`);
  await load();
}

function viewLicenses(row: any) {
  router.push({ name: 'licenses', query: { batch_id: row.id } });
}

/** 核销率的颜色:高核销=绿,低=灰;封禁/作废占比高=红(异常信号) */
function rateColor(row: any) {
  const bad = row.stats.counts.banned + row.stats.counts.revoked;
  if (bad > 0 && bad / row.stats.total > 0.3) return 'var(--c-danger)';
  if (row.stats.redemption_rate >= 50) return 'var(--c-success)';
  return 'var(--c-text-soft)';
}
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>批次管理</h2>
        <div class="sub">
          每次生成卡密就是一个批次。给批次打上渠道标记（卖给哪个发卡网/代理），
          就能追踪核销进度、定位盗版来源，发现某渠道异常时一键整批作废
        </div>
      </div>
    </div>

    <div class="filter-bar">
      <el-select v-model="query.application_id" placeholder="全部应用" clearable style="width:180px" @change="load">
        <el-option v-for="a in apps" :key="a.id" :label="a.name" :value="a.id" />
      </el-select>
      <el-select v-model="query.channel" placeholder="全部渠道" clearable style="width:160px" @change="load">
        <el-option v-for="c in channels" :key="c" :label="c" :value="c" />
      </el-select>
      <el-input v-model="query.keyword" placeholder="搜索渠道或备注" style="width:200px" clearable @keyup.enter="load" />
      <el-button type="primary" @click="query.page = 1; load()">查询</el-button>
    </div>

    <el-table :data="rows" v-loading="loading" border>
      <el-table-column label="渠道 / 批次" min-width="180">
        <template #default="{ row }">
          <div v-if="row.channel"><el-tag size="small" type="warning" effect="light">{{ row.channel }}</el-tag></div>
          <div v-else class="sub">未标记渠道</div>
          <div class="mono sub" style="margin-top:2px">{{ row.id }}</div>
        </template>
      </el-table-column>
      <el-table-column label="应用 / 套餐" width="140">
        <template #default="{ row }">
          <div class="mono">{{ row.app_id }}</div>
          <div class="sub">{{ row.plan_name }}</div>
        </template>
      </el-table-column>
      <el-table-column label="核销进度" min-width="200">
        <template #default="{ row }">
          <div style="display:flex;align-items:center;gap:10px">
            <el-progress :percentage="row.stats.redemption_rate" :stroke-width="14"
                         :color="rateColor(row)" style="flex:1" />
            <span class="tabular" style="width:90px;text-align:right;font-size:12px" :style="{ color: rateColor(row) }">
              {{ row.stats.used }}/{{ row.stats.total }} 已用
            </span>
          </div>
          <div class="sub" style="margin-top:4px">
            <span>未激活 {{ row.stats.counts.unused }}</span>
            <span style="margin:0 6px">·</span>
            <span>使用中 {{ row.stats.counts.active }}</span>
            <span v-if="row.stats.counts.banned" style="color:var(--c-danger);margin-left:6px">封禁 {{ row.stats.counts.banned }}</span>
            <span v-if="row.stats.counts.revoked" style="color:#7c3aed;margin-left:6px">作废 {{ row.stats.counts.revoked }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="备注" min-width="120">
        <template #default="{ row }"><span class="sub">{{ row.note || '—' }}</span></template>
      </el-table-column>
      <el-table-column label="生成时间" width="160">
        <template #default="{ row }">
          <span class="tabular sub">{{ new Date(row.created_at).toLocaleString('zh-CN', { hour12: false }) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180" fixed="right" align="right">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="viewLicenses(row)">看卡密</el-button>
          <el-button v-if="auth.can('license:write')" size="small" link @click="openEdit(row)">标记</el-button>
          <el-button v-if="auth.can('license:ban')" size="small" link type="danger" @click="revokeAll(row)">整批作废</el-button>
        </template>
      </el-table-column>

      <template #empty>
        <div style="padding: 28px 0">
          <el-empty :image-size="72" description="还没有批次。去「卡密管理」生成卡密时填个渠道，就会出现在这里" />
        </div>
      </template>
    </el-table>

    <el-pagination style="margin-top:14px;justify-content:flex-end" background layout="total, prev, pager, next"
                   :total="total" v-model:current-page="query.page" v-model:page-size="query.page_size"
                   @current-change="load" />

    <el-dialog v-model="editVisible" title="标记批次" width="480px">
      <el-form label-width="80px">
        <el-form-item label="渠道">
          <el-input v-model="form.channel" placeholder="如 发卡网A / 淘宝店 / 代理商张三" />
          <div class="sub">用来追踪这批卡卖到了哪里。发现盗版时，能定位是哪个渠道流出的</div>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
