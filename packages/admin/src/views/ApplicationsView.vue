<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { del, get, patch, post } from '@/api/http';
import type { Application, Paged } from '@/api/types';
import { useAuthStore } from '@/stores/auth';
import AppPluginsPanel from '@/components/AppPluginsPanel.vue';
import CredentialsDialog from '@/components/CredentialsDialog.vue';

const auth = useAuthStore();
const loading = ref(false);
const rows = ref<Application[]>([]);
const keyword = ref('');

const editVisible = ref(false);
const editing = ref<Application | null>(null);
const form = reactive({ app_id: '', name: '', type: 'windows', remark: '', with_default_plugin: true });

// 接入凭据抽屉
const pluginsVisible = ref(false);
const pluginsApp = ref<Application | null>(null);

// 新建应用后一次性展示默认凭据
const credVisible = ref(false);
const cred = reactive({ title: '', pluginId: '', token: '', secret: '', hint: '' });

const ctlVisible = ref(false);
const ctlApp = ref<Application | null>(null);
const ctl = reactive({
  kill_switch: false, kill_message: '',
  maintenance: false, maintenance_message: '',
  min_version: '', latest_version: '', force_upgrade: false, upgrade_message: '',
  notice_enabled: false, notice_level: 'info' as 'info' | 'warning' | 'critical',
  notice_title: '', notice_content: '',
  policy_ttl_seconds: 300,
});

async function load() {
  loading.value = true;
  try {
    const res = await get<Paged<Application>>('/admin/applications', {
      keyword: keyword.value || undefined, page_size: 100,
    });
    rows.value = res.items;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function openCreate() {
  editing.value = null;
  Object.assign(form, { app_id: '', name: '', type: 'windows', remark: '', with_default_plugin: true });
  editVisible.value = true;
}
function openEdit(row: Application) {
  editing.value = row;
  Object.assign(form, {
    app_id: row.app_id, name: row.name, type: row.type,
    remark: row.remark ?? '', with_default_plugin: false,
  });
  editVisible.value = true;
}

function openPlugins(row: Application) {
  pluginsApp.value = row;
  pluginsVisible.value = true;
}

async function save() {
  if (editing.value) {
    await patch(`/admin/applications/${editing.value.id}`, {
      name: form.name, type: form.type, remark: form.remark,
    });
    ElMessage.success('已保存');
  } else {
    const res = await post<any>('/admin/applications', form);
    // 建应用时顺带发的第一副凭据，明文只有这一次机会展示
    if (res.default_plugin?.credentials) {
      Object.assign(cred, {
        title: '应用已创建 — 这是接入凭据，请立即保存',
        pluginId: res.default_plugin.plugin_id,
        token: res.default_plugin.credentials.plugin_token,
        secret: res.default_plugin.credentials.plugin_secret,
        hint: '接入方用这三个值即可对接。之后可在该应用的「接入凭据」里再次查看或轮换。',
      });
      credVisible.value = true;
    } else {
      ElMessage.success('应用已创建');
    }
  }
  editVisible.value = false;
  await load();
}

async function toggleStatus(row: Application) {
  const next = row.status === 'active' ? 'disabled' : 'active';
  await ElMessageBox.confirm(
    next === 'disabled'
      ? '停用后该应用的所有激活与验证请求都会被拒绝，客户端会立即无法使用。确认停用？'
      : '确认重新启用该应用？',
    '确认操作', { type: 'warning' },
  );
  await patch(`/admin/applications/${row.id}`, { status: next });
  ElMessage.success('已更新');
  await load();
}

async function remove(row: Application) {
  await ElMessageBox.confirm(`确认删除应用「${row.name}」？此操作不可撤销。`, '删除应用', { type: 'error' });
  await del(`/admin/applications/${row.id}`);
  ElMessage.success('已删除');
  await load();
}

async function openControl(row: Application) {
  const detail = await get<Application>(`/admin/applications/${row.id}`);
  ctlApp.value = detail;
  const p = detail.policy!;
  Object.assign(ctl, {
    kill_switch: p.kill_switch, kill_message: p.kill_message ?? '',
    maintenance: p.maintenance, maintenance_message: p.maintenance_message ?? '',
    min_version: p.min_version ?? '', latest_version: p.latest_version ?? '',
    force_upgrade: p.force_upgrade, upgrade_message: p.upgrade_message ?? '',
    notice_enabled: p.notice_enabled, notice_level: p.notice_level,
    notice_title: p.notice_title ?? '', notice_content: p.notice_content ?? '',
    policy_ttl_seconds: p.policy_ttl_seconds,
  });
  ctlVisible.value = true;
}

async function saveControl() {
  // 熔断是最高危的操作，必须再确认一次
  if (ctl.kill_switch && !ctlApp.value?.kill_switch) {
    await ElMessageBox.confirm(
      `开启后「${ctlApp.value?.name}」的所有客户端会在下一次验证时立即停止工作。确认远程关停？`,
      '危险操作', { type: 'error', confirmButtonText: '确认关停', confirmButtonClass: 'el-button--danger' },
    );
  }
  await patch(`/admin/applications/${ctlApp.value!.id}/policy`, { ...ctl });
  ElMessage.success('策略已下发，客户端将在下次验证时生效');
  ctlVisible.value = false;
  await load();
}
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>应用管理</h2>
        <div class="sub">每接入一个新软件或网站就创建一个应用。卡密、套餐、远程管控都挂在应用上；接入用的密钥在每个应用的「接入凭据」里管理</div>
      </div>
      <el-button v-if="auth.can('application:write')" type="primary" @click="openCreate">
        <el-icon><Plus /></el-icon>新建应用
      </el-button>
    </div>

    <div class="filter-bar">
      <el-input v-model="keyword" placeholder="搜索 app_id 或名称" style="width:260px" clearable @keyup.enter="load" />
      <el-button @click="load">查询</el-button>
    </div>

    <el-table :data="rows" v-loading="loading" border>
      <el-table-column label="app_id" width="140">
        <template #default="{ row }"><span class="mono">{{ row.app_id }}</span></template>
      </el-table-column>
      <el-table-column prop="name" label="名称" min-width="130" />
      <el-table-column prop="type" label="类型" width="90" />
      <el-table-column label="运行状态" width="110">
        <template #default="{ row }">
          <el-tag v-if="row.kill_switch" type="danger" size="small">已远程关停</el-tag>
          <el-tag v-else-if="row.status !== 'active'" type="info" size="small">已停用</el-tag>
          <el-tag v-else-if="row.maintenance" type="warning" size="small">维护中</el-tag>
          <el-tag v-else type="success" size="small">正常</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="版本策略" width="140">
        <template #default="{ row }">
          <span class="mono">最低 {{ row.min_version || '不限' }}<br>最新 {{ row.latest_version || '未发布' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="关联" width="155">
        <template #default="{ row }">
          <span class="mono">接入端 {{ row.counts?.plugins ?? 0 }} · 套餐 {{ row.counts?.plans ?? 0 }} · 卡密 {{ row.counts?.licenses ?? 0 }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="240" fixed="right">
        <template #default="{ row }">
          <el-button v-if="auth.can('plugin:read')" size="small" type="primary" plain @click="openPlugins(row)">
            接入凭据
          </el-button>
          <el-button v-if="auth.can('application:control')" size="small" type="warning" plain @click="openControl(row)">
            远程管控
          </el-button>
          <el-dropdown v-if="auth.can('application:write')" style="margin-left:6px;vertical-align:middle">
            <el-button size="small" text><el-icon><MoreFilled /></el-icon></el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="openEdit(row)">编辑</el-dropdown-item>
                <el-dropdown-item @click="toggleStatus(row)">
                  {{ row.status === 'active' ? '停用应用' : '启用应用' }}
                </el-dropdown-item>
                <el-dropdown-item divided @click="remove(row)">删除应用</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新建 / 编辑 -->
    <el-dialog v-model="editVisible" :title="editing ? '编辑应用' : '新建应用'" width="520px">
      <el-form label-width="90px">
        <el-form-item label="app_id" required>
          <el-input v-model="form.app_id" :disabled="!!editing" placeholder="video_tool（小写字母、数字、下划线）" />
          <div class="sub" v-if="!editing">创建后不可修改，客户端接入时要用它</div>
        </el-form-item>
        <el-form-item label="应用名称" required><el-input v-model="form.name" /></el-form-item>
        <el-form-item label="类型">
          <el-select v-model="form.type" style="width:100%">
            <el-option v-for="t in ['windows','android','web','api','other']" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注"><el-input v-model="form.remark" type="textarea" :rows="2" /></el-form-item>
        <el-form-item v-if="!editing" label="接入凭据">
          <el-switch v-model="form.with_default_plugin" :disabled="!auth.can('plugin:write')" />
          <span class="sub" style="margin-left:10px">
            {{ auth.can('plugin:write')
               ? '同时生成一副默认凭据，创建后立即展示'
               : '当前账号没有插件管理权限，无法生成凭据' }}
          </span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <!-- 接入凭据 -->
    <el-drawer v-model="pluginsVisible" :title="`接入凭据 — ${pluginsApp?.name ?? ''}`" size="820px" destroy-on-close>
      <AppPluginsPanel v-if="pluginsApp" :app="pluginsApp" />
    </el-drawer>

    <CredentialsDialog v-model="credVisible" :title="cred.title" :plugin-id="cred.pluginId"
                       :token="cred.token" :secret="cred.secret" :hint="cred.hint" />

    <!-- 远程管控 -->
    <el-drawer v-model="ctlVisible" :title="`远程管控 — ${ctlApp?.name ?? ''}`" size="560px">
      <el-alert type="info" :closable="false" style="margin-bottom:16px"
                title="这里的改动会通过客户端每次验证时下发的策略生效，无需客户端重新安装" />

      <div class="danger-zone">
        <h4>紧急熔断</h4>
        <el-form label-width="110px">
          <el-form-item label="立即关停">
            <el-switch v-model="ctl.kill_switch" active-text="已关停" inactive-text="正常" />
          </el-form-item>
          <el-form-item label="关停提示语">
            <el-input v-model="ctl.kill_message" placeholder="该产品已停止运营，请联系客服" />
          </el-form-item>
        </el-form>
        <div class="sub">开启后，该应用所有客户端的激活与验证请求立即返回 APP_KILLED。</div>
      </div>

      <el-divider content-position="left">维护模式</el-divider>
      <el-form label-width="110px">
        <el-form-item label="维护中">
          <el-switch v-model="ctl.maintenance" />
          <span class="sub" style="margin-left:10px">只拦新设备激活，已激活设备照常使用</span>
        </el-form-item>
        <el-form-item label="维护提示语"><el-input v-model="ctl.maintenance_message" /></el-form-item>
      </el-form>

      <el-divider content-position="left">版本策略</el-divider>
      <el-form label-width="110px">
        <el-form-item label="最低可用版本">
          <el-input v-model="ctl.min_version" placeholder="留空表示不限制，例如 1.2.0" />
          <div class="sub">低于此版本的客户端会被拒绝，返回 CLIENT_VERSION_TOO_LOW</div>
        </el-form-item>
        <el-form-item label="强制升级">
          <el-switch v-model="ctl.force_upgrade" />
          <span class="sub" style="margin-left:10px">有新版时标记为必须升级</span>
        </el-form-item>
        <el-form-item label="升级提示语"><el-input v-model="ctl.upgrade_message" /></el-form-item>
        <el-form-item label="当前最新版">
          <el-input v-model="ctl.latest_version" placeholder="通常由「版本发布」自动维护" />
        </el-form-item>
      </el-form>

      <el-divider content-position="left">公告推送</el-divider>
      <el-form label-width="110px">
        <el-form-item label="启用公告"><el-switch v-model="ctl.notice_enabled" /></el-form-item>
        <el-form-item label="级别">
          <el-radio-group v-model="ctl.notice_level">
            <el-radio-button value="info">普通</el-radio-button>
            <el-radio-button value="warning">警示</el-radio-button>
            <el-radio-button value="critical">重要</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="标题"><el-input v-model="ctl.notice_title" /></el-form-item>
        <el-form-item label="内容"><el-input v-model="ctl.notice_content" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="策略缓存">
          <el-input-number v-model="ctl.policy_ttl_seconds" :min="0" :max="86400" />
          <span class="sub" style="margin-left:8px">秒，客户端两次拉取策略的建议间隔</span>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="ctlVisible = false">取消</el-button>
        <el-button type="primary" @click="saveControl">下发策略</el-button>
      </template>
    </el-drawer>
  </div>
</template>
