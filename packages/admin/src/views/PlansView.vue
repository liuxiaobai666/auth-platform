<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { del, get, patch, post } from '@/api/http';
import type { Application, Plan } from '@/api/types';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const rows = ref<Plan[]>([]);
const apps = ref<Application[]>([]);
const appFilter = ref('');
const loading = ref(false);
const visible = ref(false);
const editing = ref<Plan | null>(null);

const form = reactive({
  application_id: '', code: '', name: '',
  permanent: false, duration_days: 30, device_limit: 1,
  allow_rebind: true, unlimited_rebind: false, rebind_limit: 3,
  price: 0, offline_grace_hours: 72, status: 'active' as 'active' | 'inactive',
});

async function load() {
  loading.value = true;
  try {
    const [p, a] = await Promise.all([
      get<{ items: Plan[] }>('/admin/plans', { application_id: appFilter.value || undefined }),
      get<{ items: Application[] }>('/admin/applications', { page_size: 100 }),
    ]);
    rows.value = p.items;
    apps.value = a.items;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function openCreate() {
  editing.value = null;
  Object.assign(form, {
    application_id: appFilter.value || apps.value[0]?.id || '', code: '', name: '',
    permanent: false, duration_days: 30, device_limit: 1,
    allow_rebind: true, unlimited_rebind: false, rebind_limit: 3,
    price: 0, offline_grace_hours: 72, status: 'active',
  });
  visible.value = true;
}

function openEdit(row: Plan) {
  editing.value = row;
  Object.assign(form, {
    application_id: row.application_id, code: row.code, name: row.name,
    permanent: row.duration_days === null, duration_days: row.duration_days ?? 30,
    device_limit: row.device_limit, allow_rebind: row.allow_rebind,
    unlimited_rebind: row.allow_rebind && row.rebind_limit === null,
    rebind_limit: row.rebind_limit ?? 3,
    price: row.price, offline_grace_hours: row.offline_grace_hours, status: row.status,
  });
  visible.value = true;
}

async function save() {
  const body: any = {
    name: form.name,
    duration_days: form.permanent ? null : form.duration_days,
    device_limit: form.device_limit,
    allow_rebind: form.allow_rebind,
    rebind_limit: !form.allow_rebind || form.unlimited_rebind ? null : form.rebind_limit,
    price: form.price,
    offline_grace_hours: form.offline_grace_hours,
    status: form.status,
  };
  if (editing.value) {
    await patch(`/admin/plans/${editing.value.id}`, body);
  } else {
    await post('/admin/plans', { ...body, application_id: form.application_id, code: form.code });
  }
  ElMessage.success('已保存');
  visible.value = false;
  await load();
}

async function remove(row: Plan) {
  await ElMessageBox.confirm(`确认删除套餐「${row.name}」？`, '删除套餐', { type: 'warning' });
  await del(`/admin/plans/${row.id}`);
  await load();
}
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>套餐管理</h2>
        <div class="sub">套餐决定卡密的有效期、设备数和换绑规则。卡密生成时会把规则快照下来，之后改套餐不影响已发出的卡密</div>
      </div>
      <el-button v-if="auth.can('plan:write')" type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>新建套餐
      </el-button>
    </div>

    <div class="filter-bar">
      <el-select v-model="appFilter" placeholder="全部应用" clearable style="width:220px" @change="load">
        <el-option v-for="a in apps" :key="a.id" :label="`${a.name} (${a.app_id})`" :value="a.id" />
      </el-select>
    </div>

    <el-table :data="rows" v-loading="loading" border>
      <el-table-column label="套餐" min-width="180">
        <template #default="{ row }">
          <div>{{ row.name }}</div>
          <div class="mono sub">{{ row.app_id }} / {{ row.code }}</div>
        </template>
      </el-table-column>
      <el-table-column label="有效期" width="110">
        <template #default="{ row }">
          <el-tag v-if="row.is_permanent" type="success" size="small">永久</el-tag>
          <span v-else>{{ row.duration_days }} 天</span>
        </template>
      </el-table-column>
      <el-table-column prop="device_limit" label="设备数" width="90" />
      <el-table-column label="换绑规则" width="140">
        <template #default="{ row }">
          <span v-if="!row.allow_rebind" style="color:#dc2626">不允许</span>
          <span v-else-if="row.rebind_limit === null">不限次数</span>
          <span v-else>最多 {{ row.rebind_limit }} 次</span>
        </template>
      </el-table-column>
      <el-table-column label="离线宽限" width="110">
        <template #default="{ row }">
          <span v-if="row.offline_grace_hours === 0" style="color:#dc2626">必须联网</span>
          <span v-else>{{ row.offline_grace_hours }} 小时</span>
        </template>
      </el-table-column>
      <el-table-column label="价格" width="100">
        <template #default="{ row }">￥{{ row.price.toFixed(2) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
            {{ row.status === 'active' ? '在售' : '停售' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="license_count" label="已发卡" width="90" />
      <el-table-column label="操作" width="140" fixed="right">
        <template #default="{ row }">
          <template v-if="auth.can('plan:write')">
            <el-button size="small" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" link @click="remove(row)">删除</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="visible" :title="editing ? '编辑套餐' : '新建套餐'" width="560px">
      <el-form label-width="110px">
        <el-form-item label="所属应用" required>
          <el-select v-model="form.application_id" :disabled="!!editing" style="width:100%">
            <el-option v-for="a in apps" :key="a.id" :label="`${a.name} (${a.app_id})`" :value="a.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="套餐代码" required>
          <el-input v-model="form.code" :disabled="!!editing" placeholder="month / year / lifetime" />
        </el-form-item>
        <el-form-item label="套餐名称" required><el-input v-model="form.name" placeholder="月卡" /></el-form-item>
        <el-form-item label="有效期">
          <el-switch v-model="form.permanent" active-text="永久卡" inactive-text="限时卡" />
          <el-input-number v-if="!form.permanent" v-model="form.duration_days" :min="1" :max="36500"
                           style="margin-left:12px" /> <span v-if="!form.permanent" class="sub">天</span>
        </el-form-item>
        <el-form-item label="设备上限"><el-input-number v-model="form.device_limit" :min="1" :max="10000" /></el-form-item>
        <el-form-item label="允许换绑">
          <el-switch v-model="form.allow_rebind" />
          <template v-if="form.allow_rebind">
            <el-checkbox v-model="form.unlimited_rebind" style="margin-left:14px">不限次数</el-checkbox>
            <el-input-number v-if="!form.unlimited_rebind" v-model="form.rebind_limit" :min="0" :max="10000"
                             style="margin-left:10px" />
          </template>
        </el-form-item>
        <el-form-item label="离线宽限">
          <el-input-number v-model="form.offline_grace_hours" :min="0" :max="8760" />
          <span class="sub" style="margin-left:8px">小时，0 表示每次启动都必须联网</span>
        </el-form-item>
        <el-form-item label="销售价">
          <el-input-number v-model="form.price" :min="0" :precision="2" :step="1" />
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="form.status">
            <el-radio-button value="active">在售</el-radio-button>
            <el-radio-button value="inactive">停售</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>
