<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, reactive, ref } from 'vue';
import { del, get, http, patch, post } from '@/api/http';
import type { Application, Release } from '@/api/types';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const rows = ref<Release[]>([]);
const apps = ref<Application[]>([]);
const appFilter = ref('');
const loading = ref(false);
const uploading = ref(false);
const visible = ref(false);

const form = reactive({
  application_id: '', version: '', channel: 'stable' as 'stable' | 'beta',
  release_notes: '', is_mandatory: false, rollout_percent: 100,
  external_url: '', mode: 'upload' as 'upload' | 'external',
  package_type: 'zip' as 'zip' | 'onefile' | 'onedir',
  install_strategy: 'versioned' as 'versioned' | 'replace' | 'notify',
  strip_root_dir: true, entry: '', post_install: '',
});
const file = ref<File | null>(null);

async function load() {
  loading.value = true;
  try {
    const [r, a] = await Promise.all([
      get<{ items: Release[] }>('/admin/releases', { application_id: appFilter.value || undefined }),
      get<{ items: Application[] }>('/admin/applications', { page_size: 100 }),
    ]);
    rows.value = r.items;
    apps.value = a.items;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function onFileChange(f: any) {
  file.value = f.raw;
}

async function submit() {
  if (!form.application_id || !form.version) { ElMessage.warning('请填写应用和版本号'); return; }
  if (form.mode === 'upload' && !file.value) { ElMessage.warning('请选择安装包文件'); return; }
  if (form.mode === 'external' && !form.external_url) { ElMessage.warning('请填写下载地址'); return; }

  const fd = new FormData();
  fd.append('application_id', form.application_id);
  fd.append('version', form.version);
  fd.append('channel', form.channel);
  fd.append('release_notes', form.release_notes);
  fd.append('is_mandatory', String(form.is_mandatory));
  fd.append('rollout_percent', String(form.rollout_percent));
  fd.append('package_type', form.package_type);
  fd.append('install_strategy', form.install_strategy);
  fd.append('strip_root_dir', String(form.strip_root_dir));
  if (form.entry) fd.append('entry', form.entry);
  if (form.post_install) fd.append('post_install', form.post_install);
  if (form.mode === 'external') fd.append('external_url', form.external_url);
  else fd.append('file', file.value!);

  uploading.value = true;
  try {
    await post('/admin/releases', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    ElMessage.success('已创建，处于草稿状态。确认无误后点「发布」才会下发给客户端');
    visible.value = false;
    file.value = null;
    await load();
  } finally {
    uploading.value = false;
  }
}

async function publish(row: Release) {
  const { value } = await ElMessageBox.prompt(
    '灰度放量百分比（0-100）。按设备指纹稳定分桶，同一台设备的结果不会来回变',
    `发布 ${row.version}`,
    { inputValue: String(row.rollout_percent), inputPattern: /^(100|[1-9]?\d)$/, inputErrorMessage: '请输入 0-100' },
  );
  await post(`/admin/releases/${row.id}/publish`, { rollout_percent: Number(value) });
  ElMessage.success('已发布');
  await load();
}

async function setRollout(row: Release) {
  const { value } = await ElMessageBox.prompt('调整灰度放量百分比', `${row.version} 放量`, {
    inputValue: String(row.rollout_percent), inputPattern: /^(100|[1-9]?\d)$/, inputErrorMessage: '请输入 0-100',
  });
  await patch(`/admin/releases/${row.id}`, { rollout_percent: Number(value) });
  ElMessage.success(`已调整为 ${value}%`);
  await load();
}

async function archive(row: Release) {
  await ElMessageBox.confirm(`归档后 ${row.version} 不再下发给客户端，已安装的用户不受影响。确认？`, '归档版本', { type: 'warning' });
  await post(`/admin/releases/${row.id}/archive`);
  await load();
}

async function remove(row: Release) {
  await ElMessageBox.confirm(`确认删除版本 ${row.version}？安装包文件会一并删除。`, '删除版本', { type: 'error' });
  await del(`/admin/releases/${row.id}`);
  await load();
}

function fmtSize(bytes: number | null) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

const statusMeta: Record<string, { type: any; label: string }> = {
  draft: { type: 'info', label: '草稿' },
  published: { type: 'success', label: '已发布' },
  archived: { type: 'warning', label: '已归档' },
};
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <h2>版本发布</h2>
        <div class="sub">上传安装包并按比例灰度放量，客户端下次验证时自动收到升级提示</div>
      </div>
      <el-button v-if="auth.can('release:write')" type="primary" @click="visible = true">
        <el-icon><Upload /></el-icon>新建版本
      </el-button>
    </div>

    <div class="filter-bar">
      <el-select v-model="appFilter" placeholder="全部应用" clearable style="width:220px" @change="load">
        <el-option v-for="a in apps" :key="a.id" :label="`${a.name} (${a.app_id})`" :value="a.id" />
      </el-select>
    </div>

    <el-table :data="rows" v-loading="loading" border>
      <el-table-column label="版本" width="140">
        <template #default="{ row }">
          <span class="mono" style="font-weight:600">{{ row.version }}</span>
          <el-tag v-if="row.channel === 'beta'" size="small" type="warning" style="margin-left:6px">beta</el-tag>
          <div class="sub mono">{{ row.app_id }}</div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="statusMeta[row.status].type" size="small">{{ statusMeta[row.status].label }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="放量" width="150">
        <template #default="{ row }">
          <el-progress :percentage="row.rollout_percent" :stroke-width="14" text-inside
                       :status="row.rollout_percent === 100 ? 'success' : undefined" />
        </template>
      </el-table-column>
      <el-table-column label="强制" width="80">
        <template #default="{ row }">
          <el-tag v-if="row.is_mandatory" type="danger" size="small">强制</el-tag>
          <span v-else class="sub">可选</span>
        </template>
      </el-table-column>
      <el-table-column label="安装包" min-width="230">
        <template #default="{ row }">
          <template v-if="row.file_name">
            <div>{{ row.file_name }}（{{ fmtSize(row.file_size) }}）</div>
            <div class="mono sub" :title="row.sha256">sha256: {{ row.sha256?.slice(0, 24) }}…</div>
            <div>
              <el-tag v-if="row.signed" type="success" size="small">已签名</el-tag>
              <el-tag v-else-if="row.status === 'published'" type="danger" size="small">未签名</el-tag>
              <el-tag v-if="row.package_type" size="small" type="info" style="margin-left: 4px">
                {{ row.package_type }}
              </el-tag>
            </div>
          </template>
          <a v-else-if="row.external_url" :href="row.external_url" target="_blank" class="mono">{{ row.external_url }}</a>
          <span v-else class="sub">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="download_count" label="下载" width="80" />
      <el-table-column label="操作" width="250" fixed="right">
        <template #default="{ row }">
          <template v-if="auth.can('release:write')">
            <el-button v-if="row.status !== 'published'" size="small" type="primary" @click="publish(row)">发布</el-button>
            <el-button v-if="row.status === 'published'" size="small" @click="setRollout(row)">调整放量</el-button>
            <el-button v-if="row.status === 'published'" size="small" type="warning" plain @click="archive(row)">归档</el-button>
            <el-button v-if="row.status !== 'published'" size="small" type="danger" link @click="remove(row)">删除</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="visible" title="新建版本" width="600px">
      <el-form label-width="110px">
        <el-form-item label="所属应用" required>
          <el-select v-model="form.application_id" style="width:100%">
            <el-option v-for="a in apps" :key="a.id" :label="`${a.name} (${a.app_id})`" :value="a.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="版本号" required>
          <el-input v-model="form.version" placeholder="1.2.0" />
        </el-form-item>
        <el-form-item label="通道">
          <el-radio-group v-model="form.channel">
            <el-radio-button value="stable">正式</el-radio-button>
            <el-radio-button value="beta">测试</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="安装包来源">
          <el-radio-group v-model="form.mode">
            <el-radio-button value="upload">上传文件</el-radio-button>
            <el-radio-button value="external">外部地址</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="form.mode === 'upload'" label="安装包">
          <el-upload :auto-upload="false" :limit="1" :on-change="onFileChange" :show-file-list="true">
            <el-button><el-icon><Upload /></el-icon>选择文件</el-button>
            <template #tip><div class="sub">上传后服务端会计算 SHA-256，客户端可据此校验完整性</div></template>
          </el-upload>
        </el-form-item>
        <el-form-item v-else label="下载地址">
          <el-input v-model="form.external_url" placeholder="https://cdn.example.com/app-1.2.0.exe" />
        </el-form-item>
        <el-form-item label="包形态">
          <el-radio-group v-model="form.package_type">
            <el-radio-button value="onedir">目录包</el-radio-button>
            <el-radio-button value="onefile">单文件</el-radio-button>
            <el-radio-button value="zip">通用压缩包</el-radio-button>
          </el-radio-group>
          <div class="sub tip">PyInstaller --onedir 选「目录包」，--onefile 选「单文件」</div>
        </el-form-item>
        <el-form-item label="安装策略">
          <el-select v-model="form.install_strategy" style="width: 100%">
            <el-option value="versioned" label="版本目录切换（推荐，可回滚）" />
            <el-option value="replace" label="原地覆盖" />
            <el-option value="notify" label="只通知，不自动安装" />
          </el-select>
          <div class="sub tip">
            版本目录切换：新版装进独立目录再切指针，中途失败不影响老版本，出问题可秒回滚
          </div>
        </el-form-item>
        <template v-if="form.install_strategy !== 'notify'">
          <el-form-item label="剥掉外层目录">
            <el-switch v-model="form.strip_root_dir" />
            <span class="sub tip">
              压缩包里如果套了一层 YourApp/ 就剥掉。平铺结构会自动跳过，不会误删文件
            </span>
          </el-form-item>
          <el-form-item label="启动入口">
            <el-input v-model="form.entry" placeholder="app.exe / main.js / index.php" />
          </el-form-item>
          <el-form-item label="安装后命令">
            <el-input v-model="form.post_install" placeholder="选填，如 pip install -r requirements.txt" />
            <div class="sub tip warn">
              这条命令会在用户机器上执行，且不在签名保护范围内。客户端 SDK 默认不执行它，
              需接入方显式开启，请确认清楚再填。
            </div>
          </el-form-item>
        </template>
        <el-form-item label="更新说明">
          <el-input v-model="form.release_notes" type="textarea" :rows="3" />
        </el-form-item>
        <el-form-item label="强制升级">
          <el-switch v-model="form.is_mandatory" />
          <span class="sub" style="margin-left:10px">开启后低于此版本的客户端会被要求必须升级</span>
        </el-form-item>
        <el-form-item label="灰度放量">
          <el-slider v-model="form.rollout_percent" :min="0" :max="100" show-input style="width:100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" :loading="uploading" @click="submit">创建（草稿）</el-button>
      </template>
    </el-dialog>
  </div>
</template>
