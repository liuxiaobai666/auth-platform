<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { get, post } from '@/api/http';
import { marked } from 'marked';
import { buildSnippets, ERROR_CODES, RETRYABLE } from '@/api/snippets';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const tab = ref<'start' | 'protocol' | 'playground' | 'fulldoc'>('start');
const loading = ref(true);

interface Ctx {
  server_url: string;
  applications: { id: string; app_id: string; name: string; plugins: { plugin_id: string; name: string; status: string }[] }[];
  selected: { id: string; app_id: string; name: string; plugins: { plugin_id: string; name: string; status: string }[] } | null;
}
const ctx = ref<Ctx>({ server_url: '', applications: [], selected: null });
const appId = ref('');
const activeLang = ref('nodejs');

onMounted(async () => {
  try {
    ctx.value = await get<Ctx>('/admin/docs/context');
    appId.value = ctx.value.selected?.id ?? '';
  } finally {
    loading.value = false;
  }
});

async function onAppChange() {
  ctx.value = await get<Ctx>('/admin/docs/context', { application_id: appId.value });
}

const selected = computed(() => ctx.value.selected);
const firstPlugin = computed(() => selected.value?.plugins[0]?.plugin_id ?? 'your_plugin_id');

const snippets = computed(() =>
  buildSnippets({
    serverUrl: ctx.value.server_url,
    appId: selected.value?.app_id ?? 'your_app',
    pluginId: firstPlugin.value,
  }),
);
const activeSnippet = computed(() => snippets.value.find((s) => s.lang === activeLang.value) ?? snippets.value[0]);

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  ElMessage.success('已复制');
}

// ---------------- 完整文档 ----------------
const mdRaw = ref('');       // markdown 原文，供复制/下载
const mdHtml = ref('');      // 渲染后的 HTML，供展示
const mdLoading = ref(false);

async function loadFullDoc() {
  if (mdRaw.value) return;   // 已加载过就不重复请求
  mdLoading.value = true;
  try {
    const res = await get<{ content: string; found: boolean }>('/admin/docs/markdown');
    mdRaw.value = res.content;
    mdHtml.value = await marked.parse(res.content);
  } finally {
    mdLoading.value = false;
  }
}
watch(tab, (t) => { if (t === 'fulldoc') loadFullDoc(); });

async function copyMarkdown() {
  await navigator.clipboard.writeText(mdRaw.value);
  ElMessage.success('已复制完整文档 Markdown');
}

function downloadMarkdown() {
  const blob = new Blob([mdRaw.value], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'INTEGRATION.md';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- 在线测试 ----------------
const routes = ref<{ key: string; method: string; path: string; label: string }[]>([]);
const pg = reactive({
  pluginId: '',
  action: 'policy',
  deviceId: 'test-device-0001',
  licenseKey: '',
  clientVersion: '1.0.0',
});
const pgResult = ref<any>(null);
const pgLoading = ref(false);

watch(selected, (s) => {
  if (s?.plugins[0]) pg.pluginId = s.plugins[0].plugin_id;
}, { immediate: true });

async function loadRoutes() {
  if (!routes.value.length) routes.value = await get('/admin/docs/routes');
}
watch(tab, (t) => { if (t === 'playground') loadRoutes(); });

/** 当前动作需要哪些参数 */
const needsKey = computed(() => pg.action === 'activate');
const needsDevice = computed(() => ['activate', 'verify', 'deactivate', 'status', 'policy'].includes(pg.action));

async function runPlayground() {
  if (!pg.pluginId) { ElMessage.warning('请选择接入端'); return; }
  const appIdStr = selected.value?.app_id;
  const payload: any = { plugin_id: pg.pluginId, action: pg.action };

  if (pg.action === 'activate') {
    payload.body = { app_id: appIdStr, license_key: pg.licenseKey.trim(), device_id: pg.deviceId, client_version: pg.clientVersion };
  } else if (pg.action === 'verify' || pg.action === 'deactivate') {
    // verify/deactivate 需要 license_token —— 提示用户先激活拿到，这里用 status 更实用
    payload.body = { app_id: appIdStr, device_id: pg.deviceId };
    if (pg.action === 'verify') payload.body.client_version = pg.clientVersion;
  } else {
    // GET：status / policy
    payload.query = { app_id: appIdStr, device_id: pg.deviceId };
    if (pg.action === 'status' && pg.licenseKey) payload.query.license_key = pg.licenseKey.trim();
    if (pg.action === 'policy') payload.query.client_version = pg.clientVersion;
  }

  pgLoading.value = true;
  try {
    pgResult.value = await post('/admin/docs/playground/invoke', payload);
  } catch (e: any) {
    pgResult.value = { error: e?.response?.data ?? { message: '请求失败' } };
  } finally {
    pgLoading.value = false;
  }
}

const statusColor = (s: number) => (s >= 200 && s < 300 ? 'var(--c-success)' : s >= 400 ? 'var(--c-danger)' : 'var(--c-warning)');
</script>

<template>
  <div v-loading="loading">
    <div class="page-header">
      <div>
        <h2>接入文档</h2>
        <div class="sub">
          把这份文档和应用的接入凭据一起交给对接人。示例代码已填入所选应用的 app_id 与接入端标识，可直接复制
        </div>
      </div>
      <el-select v-if="ctx.applications.length" v-model="appId" style="width: 240px" @change="onAppChange">
        <el-option v-for="a in ctx.applications" :key="a.id" :label="`${a.name} (${a.app_id})`" :value="a.id" />
      </el-select>
    </div>

    <el-empty v-if="!loading && !ctx.applications.length" description="还没有应用，先去「应用管理」创建一个" />

    <template v-else>
      <el-tabs v-model="tab">
        <el-tab-pane label="快速上手" name="start" />
        <el-tab-pane label="协议规范" name="protocol" />
        <el-tab-pane label="在线测试" name="playground" />
        <el-tab-pane label="完整文档" name="fulldoc" />
      </el-tabs>

      <!-- ============ 快速上手 ============ -->
      <div v-show="tab === 'start'">
        <el-card shadow="never" style="margin-bottom: 16px">
          <template #header><b>这个应用的接入信息</b></template>
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="app_id">
              <span class="mono">{{ selected?.app_id }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="服务器地址">
              <span class="mono">{{ ctx.server_url }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="接入端" :span="2">
              <template v-if="selected?.plugins.length">
                <el-tag v-for="p in selected.plugins" :key="p.plugin_id" size="small" class="mono"
                        style="margin-right: 6px" :type="p.status === 'active' ? 'success' : 'warning'">
                  {{ p.plugin_id }}
                </el-tag>
              </template>
              <span v-else class="sub">该应用还没有可用接入端，去「应用管理 → 接入凭据」创建</span>
            </el-descriptions-item>
          </el-descriptions>
          <el-alert type="info" :closable="false" style="margin-top: 12px"
            title="plugin_token 与 plugin_secret 不在此页展示。请到「应用管理 → 接入凭据」获取，并放进对接方的环境变量，切勿写死在代码或下发到浏览器。" />
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div style="display: flex; justify-content: space-between; align-items: center">
              <b>SDK 快速上手</b>
              <el-radio-group v-model="activeLang" size="small">
                <el-radio-button v-for="s in snippets" :key="s.lang" :value="s.lang">{{ s.label }}</el-radio-button>
              </el-radio-group>
            </div>
          </template>

          <div v-if="activeSnippet">
            <div class="install-row">
              <span class="mono">{{ activeSnippet.install }}</span>
              <el-button link type="primary" size="small" @click="copy(activeSnippet.install)">复制</el-button>
            </div>
            <div class="code-block">
              <el-button class="copy-btn" size="small" @click="copy(activeSnippet.code)">复制代码</el-button>
              <pre><code>{{ activeSnippet.code }}</code></pre>
            </div>
          </div>
        </el-card>
      </div>

      <!-- ============ 协议规范 ============ -->
      <div v-show="tab === 'protocol'">
        <el-card shadow="never" style="margin-bottom: 16px">
          <template #header><b>签名规则</b></template>
          <p class="sub" style="margin-top: 0">
            除管理端外所有请求都要带下面四个头。签名用 HMAC-SHA256，密钥是 plugin_secret。
          </p>
          <div class="code-block">
            <pre><code>X-Plugin-Id    接入端标识
X-Timestamp    Unix 秒（UTC），与服务端相差不超过 300 秒
X-Nonce        单次随机值（UUID v4），窗口内不可重复
X-Signature    小写十六进制 HMAC-SHA256

signature = HMAC_SHA256(plugin_secret,
    METHOD + "\n" +          # 大写，如 POST
    PATH   + "\n" +          # 含查询串、不含域名
    TIMESTAMP + "\n" +
    NONCE  + "\n" +
    SHA256_HEX(BODY))        # GET 的 BODY 视为空字符串</code></pre>
          </div>
          <el-alert type="warning" :closable="false" style="margin-top: 12px"
            title="三个最常踩的坑：① 查询串必须和实际发出的完全一致（含顺序与编码）；② 对原始字节算哈希，别先反序列化再重序列化；③ 重试时时间戳和 nonce 都要换新。" />
        </el-card>

        <el-card shadow="never">
          <template #header><b>错误码</b></template>
          <p class="sub" style="margin-top: 0">
            客户端只能依赖 <span class="mono">code</span> 判断分支，不要匹配 message —— 文案会改，错误码不会。
            带 <el-tag size="small" type="success" effect="plain">可重试</el-tag> 的才值得重试。
          </p>
          <el-table :data="ERROR_CODES" size="small" border max-height="440">
            <el-table-column label="code" width="220">
              <template #default="{ row }">
                <span class="mono">{{ row.code }}</span>
                <el-tag v-if="RETRYABLE.includes(row.code)" size="small" type="success" effect="plain"
                        style="margin-left: 6px">可重试</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="HTTP" width="70" align="center">
              <template #default="{ row }"><span class="tabular">{{ row.http }}</span></template>
            </el-table-column>
            <el-table-column label="含义" prop="meaning" min-width="180" />
            <el-table-column label="建议动作" prop="action" min-width="200" />
          </el-table>
        </el-card>
      </div>

      <!-- ============ 在线测试 ============ -->
      <div v-show="tab === 'playground'">
        <el-alert type="warning" :closable="false" style="margin-bottom: 16px"
          title="在线测试会发出真实请求，产生真实效果——例如激活会真的绑定设备、消耗换绑次数。签名由服务端用应用密钥完成，密钥不经过浏览器。请用测试专用的 device_id 与卡密。" />

        <el-row :gutter="16">
          <el-col :span="10">
            <el-card shadow="never">
              <template #header><b>请求</b></template>
              <el-form label-width="92px" label-position="left">
                <el-form-item label="接入端">
                  <el-select v-model="pg.pluginId" style="width: 100%" placeholder="选择接入端">
                    <el-option v-for="p in selected?.plugins ?? []" :key="p.plugin_id"
                               :label="p.plugin_id" :value="p.plugin_id" />
                  </el-select>
                </el-form-item>
                <el-form-item label="接口">
                  <el-select v-model="pg.action" style="width: 100%">
                    <el-option v-for="r in routes" :key="r.key"
                               :label="`${r.label}  (${r.method} ${r.path.replace('/api/v1/license/', '')})`"
                               :value="r.key" />
                  </el-select>
                </el-form-item>
                <el-form-item label="device_id">
                  <el-input v-model="pg.deviceId" placeholder="测试设备标识（≥8 字符）" />
                </el-form-item>
                <el-form-item v-if="needsKey" label="卡密">
                  <el-input v-model="pg.licenseKey" placeholder="要激活的卡密" />
                </el-form-item>
                <el-form-item v-if="pg.action === 'status'" label="卡密（选填）">
                  <el-input v-model="pg.licenseKey" placeholder="按卡密查状态，留空则查本机" />
                </el-form-item>
                <el-form-item v-if="['activate','verify','policy'].includes(pg.action)" label="客户端版本">
                  <el-input v-model="pg.clientVersion" placeholder="1.0.0" />
                </el-form-item>
                <el-alert v-if="['verify','deactivate'].includes(pg.action)" type="info" :closable="false"
                  style="margin-bottom: 12px"
                  title="verify / deactivate 需要 license_token（激活后返回）。此处仅演示请求构造，实际应传入激活拿到的令牌。" />
                <el-button type="primary" :loading="pgLoading" style="width: 100%" @click="runPlayground">
                  发送请求
                </el-button>
              </el-form>
            </el-card>
          </el-col>

          <el-col :span="14">
            <el-card shadow="never">
              <template #header><b>响应</b></template>
              <el-empty v-if="!pgResult" description="填好参数后点「发送请求」" :image-size="60" />
              <template v-else-if="pgResult.error">
                <el-alert type="error" :closable="false" :title="pgResult.error.code || '请求失败'"
                          :description="pgResult.error.message" show-icon />
              </template>
              <template v-else>
                <div class="resp-status">
                  <span :style="{ color: statusColor(pgResult.response.status), fontWeight: 600, fontSize: '18px' }">
                    {{ pgResult.response.status }}
                  </span>
                  <span class="sub">{{ pgResult.response.duration_ms }}ms</span>
                  <span class="sub mono" style="margin-left: auto">
                    {{ pgResult.request.method }} {{ pgResult.request.url }}
                  </span>
                </div>
                <div class="code-block" style="margin-top: 12px">
                  <el-button class="copy-btn" size="small"
                             @click="copy(JSON.stringify(pgResult.response.body, null, 2))">复制</el-button>
                  <pre><code>{{ JSON.stringify(pgResult.response.body, null, 2) }}</code></pre>
                </div>
                <div class="sub" style="margin-top: 10px">
                  实际发出的请求头（签名与 Token 已脱敏）：
                </div>
                <div class="code-block">
                  <pre><code>{{ JSON.stringify(pgResult.request.headers, null, 2) }}</code></pre>
                </div>
              </template>
            </el-card>
          </el-col>
        </el-row>
      </div>

      <!-- ============ 完整文档 ============ -->
      <div v-show="tab === 'fulldoc'">
        <el-card shadow="never">
          <template #header>
            <div class="doc-head">
              <div>
                <b>接入指南全文</b>
                <span class="sub" style="margin-left:8px">docs/INTEGRATION.md · 任何语言可照此自实现</span>
              </div>
              <div>
                <el-button size="small" @click="downloadMarkdown">
                  <el-icon><Download /></el-icon>下载 .md
                </el-button>
                <el-button size="small" type="primary" @click="copyMarkdown">
                  <el-icon><CopyDocument /></el-icon>一键复制 Markdown
                </el-button>
              </div>
            </div>
          </template>
          <div v-loading="mdLoading" class="markdown-body" v-html="mdHtml" />
        </el-card>
      </div>
    </template>
  </div>
</template>

<style scoped>
.install-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; background: var(--c-surface-sunk);
  border: 1px solid var(--c-border); border-radius: var(--r-sm);
  margin-bottom: 12px;
}
.code-block {
  position: relative; background: #12161c; border-radius: var(--r-md);
  overflow: auto; max-height: 520px;
}
.code-block pre {
  margin: 0; padding: 16px; overflow-x: auto;
}
.code-block code {
  font-family: var(--font-mono); font-size: 12.5px; line-height: 1.7;
  color: #d6deeb; white-space: pre;
}
.copy-btn {
  position: absolute; top: 8px; right: 8px; z-index: 1;
  background: rgba(255, 255, 255, 0.08); border: none; color: #9aa8c0;
}
.copy-btn:hover { background: rgba(255, 255, 255, 0.16); color: #fff; }
.resp-status {
  display: flex; align-items: center; gap: 12px;
}
</style>
