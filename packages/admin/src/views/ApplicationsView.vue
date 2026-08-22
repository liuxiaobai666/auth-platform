<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onMounted, reactive, ref } from 'vue';
import { del, get, patch, post, put } from '@/api/http';
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
  // 升级到带签名的版本之前建的应用没有验签公钥，这里补一副。
  // 开发者必须先拿到公钥才能内置进客户端打包，不能等到发版那一刻才有。
  if (!detail.update_sign_public_key && auth.can('application:write')) {
    try {
      const r = await post<{ update_sign_public_key: string }>(
        `/admin/applications/${row.id}/sign-key`,
      );
      detail.update_sign_public_key = r.update_sign_public_key;
    } catch {
      // 补发失败不影响查看其他策略，公钥处会显示「尚未生成」
    }
  }
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

// ---- 分发页 ----
const distVisible = ref(false);
const distApp = ref<Application | null>(null);
const dist = reactive({
  enabled: false, slug: '', title: '', tagline: '', logo_url: '', intro: '',
  purchase_url: '', support_qq: '', support_wechat: '', support_email: '',
  require_license: true, show_changelog: true, download_count: 0, url_path: '',
});

async function openDist(row: Application) {
  distApp.value = row;
  const d = await get<any>(`/admin/applications/${row.id}/dist-site`);
  Object.assign(dist, {
    enabled: d.enabled, slug: d.slug, title: d.title ?? '', tagline: d.tagline ?? '',
    logo_url: d.logo_url ?? '', intro: d.intro ?? '', purchase_url: d.purchase_url ?? '',
    support_qq: d.support_qq ?? '', support_wechat: d.support_wechat ?? '',
    support_email: d.support_email ?? '', require_license: d.require_license,
    show_changelog: d.show_changelog, download_count: d.download_count, url_path: d.url_path,
  });
  distVisible.value = true;
}

const distUrl = computed(() => `${location.origin}${dist.url_path || '/d/' + dist.slug}`);

async function saveDist() {
  if (!distApp.value) return;
  const d = await put<any>(`/admin/applications/${distApp.value.id}/dist-site`, {
    enabled: dist.enabled, slug: dist.slug, title: dist.title || undefined,
    tagline: dist.tagline || undefined, logo_url: dist.logo_url || undefined,
    intro: dist.intro || undefined, purchase_url: dist.purchase_url || undefined,
    support_qq: dist.support_qq || undefined, support_wechat: dist.support_wechat || undefined,
    support_email: dist.support_email || undefined,
    require_license: dist.require_license, show_changelog: dist.show_changelog,
  });
  dist.url_path = d.url_path;
  ElMessage.success(dist.enabled ? '分发页已更新' : '分发页已保存（当前未开启）');
}

async function copyDistUrl() {
  await navigator.clipboard.writeText(distUrl.value);
  ElMessage.success('链接已复制');
}

async function copyPubKey() {
  await navigator.clipboard.writeText(ctlApp.value?.update_sign_public_key ?? '');
  ElMessage.success('公钥已复制，粘贴到客户端代码里');
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
          <el-button size="small" @click="openDist(row)">分发页</el-button>
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

    <!-- 分发页 -->
    <el-drawer v-model="distVisible" :title="`分发页 — ${distApp?.name ?? ''}`" size="560px">
      <el-alert type="info" :closable="false" style="margin-bottom:16px"
                title="给新用户下载安装包的对外页面。开启后任何人都能访问这个链接，页面本身不含任何后台信息" />

      <el-form label-width="110px">
        <el-form-item label="开启分发页">
          <el-switch v-model="dist.enabled" />
          <span class="sub" style="margin-left:10px">关闭后链接立即失效，返回 404</span>
        </el-form-item>
        <el-form-item label="链接名">
          <el-input v-model="dist.slug" placeholder="小写字母、数字、下划线、短横线" />
          <div class="pubkey-box" style="margin-top:8px">
            <code class="mono">{{ distUrl }}</code>
            <el-button size="small" @click="copyDistUrl">复制</el-button>
          </div>
        </el-form-item>

        <el-divider content-position="left">页面内容</el-divider>
        <el-form-item label="标题">
          <el-input v-model="dist.title" placeholder="留空则用应用名称" />
        </el-form-item>
        <el-form-item label="一句话简介">
          <el-input v-model="dist.tagline" placeholder="显示在标题下方" />
        </el-form-item>
        <el-form-item label="Logo 地址">
          <el-input v-model="dist.logo_url" placeholder="选填，https:// 开头的图片地址" />
        </el-form-item>
        <el-form-item label="使用说明">
          <el-input v-model="dist.intro" type="textarea" :rows="6"
                    placeholder="支持 ## 标题、- 列表、**粗体**、`代码`" />
          <div class="sub tip">安装步骤、常见问题写在这里。会原样转义，写 HTML 不会被执行</div>
        </el-form-item>
        <el-form-item label="购卡链接">
          <el-input v-model="dist.purchase_url" placeholder="选填，指向你的发卡网或店铺" />
        </el-form-item>

        <el-divider content-position="left">客服方式</el-divider>
        <el-form-item label="QQ"><el-input v-model="dist.support_qq" /></el-form-item>
        <el-form-item label="微信"><el-input v-model="dist.support_wechat" /></el-form-item>
        <el-form-item label="邮箱"><el-input v-model="dist.support_email" /></el-form-item>

        <el-divider content-position="left">访问控制</el-divider>
        <el-form-item label="需要卡密">
          <el-switch v-model="dist.require_license" />
          <span class="sub" style="margin-left:10px">
            {{ dist.require_license ? '先验卡密才给下载地址' : '任何人都能直接下载' }}
          </span>
        </el-form-item>
        <el-form-item label="显示更新日志">
          <el-switch v-model="dist.show_changelog" />
        </el-form-item>
        <el-form-item label="累计下载">
          <span class="mono">{{ dist.download_count }}</span>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="distVisible = false">取消</el-button>
        <el-button type="primary" @click="saveDist">保存</el-button>
      </template>
    </el-drawer>

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

      <el-divider content-position="left">更新验签公钥</el-divider>
      <el-alert type="warning" :closable="false" style="margin-bottom:12px"
                title="把这串公钥内置进你的客户端代码，用于安装更新前验签。它必须写死在客户端里——若改成从服务器下载，篡改响应的人就能连公钥一起换掉，验签将形同虚设。" />
      <div class="pubkey-box">
        <code class="mono">{{ ctlApp?.update_sign_public_key || '（尚未生成）' }}</code>
        <el-button size="small" :disabled="!ctlApp?.update_sign_public_key"
                   @click="copyPubKey">复制</el-button>
      </div>
      <div class="sub">对应私钥只以密文存在服务端，任何接口都不会返回。发布版本时由服务端自动签名。</div>

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

<style scoped>
.pubkey-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  margin-bottom: 6px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}
.pubkey-box code {
  flex: 1;
  word-break: break-all;
  font-size: 12px;
}
</style>
