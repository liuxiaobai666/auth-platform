<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, reactive, ref, watch } from 'vue';
import { del, get, patch, post } from '@/api/http';
import type { Application, Plugin } from '@/api/types';
import { useAuthStore } from '@/stores/auth';
import CredentialsDialog from './CredentialsDialog.vue';

const props = defineProps<{ app: Application }>();
const auth = useAuthStore();

const rows = ref<Plugin[]>([]);
const loading = ref(false);
const createVisible = ref(false);
const form = reactive({ plugin_id: '', name: '', runtime: 'sdk', endpoint: '' });

const credVisible = ref(false);
const cred = reactive({ title: '', pluginId: '', token: '', secret: '', hint: '' });

async function load() {
  loading.value = true;
  try {
    rows.value = (await get<{ items: Plugin[] }>('/admin/plugins', {
      application_id: props.app.id,
    })).items;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch(() => props.app.id, load);

function showCred(title: string, pluginId: string, token: string, secret: string, hint = '') {
  Object.assign(cred, { title, pluginId, token, secret, hint });
  credVisible.value = true;
}

function openCreate() {
  Object.assign(form, {
    plugin_id: `${props.app.app_id}_`, name: '', runtime: 'sdk', endpoint: '',
  });
  createVisible.value = true;
}

async function create() {
  const res = await post<Plugin>('/admin/plugins', { ...form, application_id: props.app.id });
  createVisible.value = false;
  showCred('接入端已创建 — 请立即保存凭据', res.plugin_id,
           res.credentials!.plugin_token, res.credentials!.plugin_secret);
  await load();
}

async function reveal(row: Plugin) {
  await ElMessageBox.confirm('查看明文凭据会记入审计日志，确认继续？', '查看凭据', { type: 'warning' });
  const res = await get<any>(`/admin/plugins/${row.id}/credentials`);
  showCred(`接入凭据 — ${row.name}`, res.plugin_id, res.plugin_token, res.plugin_secret);
}

async function rotateSecret(row: Plugin) {
  const { value } = await ElMessageBox.prompt(
    '旧密钥保留分钟数。轮换期内新旧密钥都可用，方便接入方分批更新；填 0 表示旧密钥立即失效',
    '轮换签名密钥',
    { inputValue: '60', inputPattern: /^\d+$/, inputErrorMessage: '请输入数字' },
  );
  const res = await post<any>(`/admin/plugins/${row.id}/rotate-secret`, { grace_minutes: Number(value) });
  showCred('新签名密钥', row.plugin_id, '（Token 未变更）', res.plugin_secret,
           res.old_secret_valid_until
             ? `旧密钥在 ${new Date(res.old_secret_valid_until).toLocaleString()} 之前仍然可用`
             : '旧密钥已立即失效');
  await load();
}

async function rotateToken(row: Plugin) {
  await ElMessageBox.confirm(
    'Token 轮换没有宽限期，旧 Token 立即失效，未更新的接入方会马上无法调用。确认？',
    '轮换 Token', { type: 'error' },
  );
  const res = await post<any>(`/admin/plugins/${row.id}/rotate-token`);
  showCred('新 Token', row.plugin_id, res.plugin_token, '（密钥未变更）', '旧 Token 已立即失效');
  await load();
}

async function changeStatus(row: Plugin, status: string) {
  if (status === 'disabled') {
    await ElMessageBox.confirm(
      '停用后该接入端的所有请求都会被拒绝。同一应用下的其他接入端不受影响。确认？',
      '停用接入端', { type: 'warning' },
    );
  }
  await patch(`/admin/plugins/${row.id}`, { status });
  ElMessage.success('已更新');
  await load();
}

async function remove(row: Plugin) {
  await ElMessageBox.confirm(`确认删除接入端「${row.name}」？该端会立即失效。`, '删除', { type: 'error' });
  await del(`/admin/plugins/${row.id}`);
  await load();
}

const statusMeta: Record<string, { type: any; label: string }> = {
  draft: { type: 'info', label: '草稿' },
  testing: { type: 'warning', label: '测试中' },
  active: { type: 'success', label: '已启用' },
  disabled: { type: 'danger', label: '已停用' },
};
</script>

<template>
  <div>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;gap:12px">
      <div class="sub" style="flex:1">
        每个接入端（Windows 客户端、网页后端、App）持有一副独立密钥。
        分开发放是为了让吊销的粒度小于整个应用：某个端的密钥泄露时单独停掉它，其他端照常使用。
      </div>
      <el-button v-if="auth.can('plugin:write')" type="primary" size="small" @click="openCreate">
        <el-icon><Plus /></el-icon>新增接入端
      </el-button>
    </div>

    <el-table :data="rows" v-loading="loading" size="small" border>
      <el-table-column label="接入端" min-width="170">
        <template #default="{ row }">
          <div>{{ row.name }}</div>
          <div class="mono sub">{{ row.plugin_id }}</div>
        </template>
      </el-table-column>
      <el-table-column prop="runtime" label="方式" width="80" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="statusMeta[row.status].type" size="small">{{ statusMeta[row.status].label }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="凭据" min-width="190">
        <template #default="{ row }">
          <div class="mono">Token: {{ row.token_masked }}</div>
          <div class="mono">Secret: {{ row.secret_masked }}</div>
          <div v-if="row.prev_secret_expires_at" class="sub">
            旧密钥有效至 {{ new Date(row.prev_secret_expires_at).toLocaleString() }}
          </div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="200">
        <template #default="{ row }">
          <template v-if="auth.can('plugin:write')">
            <el-button size="small" @click="reveal(row)">查看凭据</el-button>
            <el-dropdown style="margin-left:6px">
              <el-button size="small">更多<el-icon><ArrowDown /></el-icon></el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item @click="rotateSecret(row)">轮换签名密钥</el-dropdown-item>
                  <el-dropdown-item @click="rotateToken(row)">轮换 Token</el-dropdown-item>
                  <el-dropdown-item divided v-if="row.status !== 'active'" @click="changeStatus(row, 'active')">启用</el-dropdown-item>
                  <el-dropdown-item v-if="row.status !== 'testing'" @click="changeStatus(row, 'testing')">置为测试中</el-dropdown-item>
                  <el-dropdown-item v-if="row.status !== 'disabled'" @click="changeStatus(row, 'disabled')">停用</el-dropdown-item>
                  <el-dropdown-item divided @click="remove(row)">删除</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </template>
          <span v-else class="sub">无插件管理权限</span>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-if="!loading && !rows.length" description="还没有接入端" :image-size="60" />

    <el-dialog v-model="createVisible" title="新增接入端" width="520px" append-to-body>
      <el-form label-width="100px">
        <el-form-item label="plugin_id" required>
          <el-input v-model="form.plugin_id" placeholder="如 my_app_web" />
          <div class="sub">接入方在请求头 X-Plugin-Id 里使用它</div>
        </el-form-item>
        <el-form-item label="名称" required>
          <el-input v-model="form.name" placeholder="如 网页端 / Windows 客户端" />
        </el-form-item>
        <el-form-item label="运行方式">
          <el-select v-model="form.runtime" style="width:100%">
            <el-option v-for="r in ['sdk','http','webhook','service']" :key="r" :label="r" :value="r" />
          </el-select>
        </el-form-item>
        <el-form-item label="回调地址"><el-input v-model="form.endpoint" placeholder="可留空" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" @click="create">创建</el-button>
      </template>
    </el-dialog>

    <CredentialsDialog v-model="credVisible" :title="cred.title" :plugin-id="cred.pluginId"
                       :token="cred.token" :secret="cred.secret" :hint="cred.hint" />
  </div>
</template>
