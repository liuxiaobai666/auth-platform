<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, post } from '@/api/http';
import type { License } from '@/api/types';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const data = ref<License | null>(null);
const loading = ref(true);

const statusMeta: Record<string, { type: any; label: string }> = {
  unused: { type: 'info', label: '未激活' }, active: { type: 'success', label: '使用中' },
  expired: { type: 'warning', label: '已过期' }, banned: { type: 'danger', label: '已封禁' },
  revoked: { type: 'danger', label: '已作废' },
};

async function load() {
  loading.value = true;
  try {
    data.value = await get<License>(`/admin/licenses/${route.params.id}`);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function unbind(deviceRowId: string) {
  const { value } = await ElMessageBox.prompt(
    '解绑原因。管理员强制解绑默认不消耗用户的换绑次数', '解绑设备',
    { inputValidator: (v) => !!v?.trim() || '必须填写原因' },
  );
  await post(`/admin/licenses/${route.params.id}/devices/${deviceRowId}/unbind`, {
    reason: value, count_as_rebind: false,
  });
  ElMessage.success('已解绑，该设备的授权令牌已立即失效');
  await load();
}

const actionLabel: Record<string, string> = {
  activate: '激活', verify: '验证', deactivate: '解绑', status: '查状态', policy: '拉策略',
};
</script>

<template>
  <div v-loading="loading">
    <div class="page-header">
      <div>
        <h2>卡密详情</h2>
        <div class="mono sub">{{ data?.key_masked }}</div>
      </div>
      <el-button @click="router.back()">返回</el-button>
    </div>

    <el-descriptions v-if="data" :column="3" border>
      <el-descriptions-item label="状态">
        <el-tag :type="statusMeta[data.status]?.type" size="small">{{ statusMeta[data.status]?.label }}</el-tag>
      </el-descriptions-item>
      <el-descriptions-item label="应用"><span class="mono">{{ data.app_id }}</span></el-descriptions-item>
      <el-descriptions-item label="套餐">{{ data.plan_name }}</el-descriptions-item>
      <el-descriptions-item label="激活时间">{{ data.activated_at ? new Date(data.activated_at).toLocaleString() : '未激活' }}</el-descriptions-item>
      <el-descriptions-item label="到期时间">
        <span v-if="data.is_permanent" style="color:#16a34a">永久</span>
        <span v-else>{{ data.expires_at ? new Date(data.expires_at).toLocaleString() : '—' }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="设备上限">{{ data.device_limit }}</el-descriptions-item>
      <el-descriptions-item label="换绑">
        <span v-if="!data.allow_rebind" style="color:#dc2626">不允许</span>
        <span v-else>已用 {{ data.rebind_count }} / {{ data.rebind_limit ?? '不限' }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="批次号"><span class="mono">{{ data.batch_id }}</span></el-descriptions-item>
      <el-descriptions-item label="备注">{{ data.note ?? '—' }}</el-descriptions-item>
      <el-descriptions-item v-if="data.banned_reason" label="封禁原因" :span="3">
        <span style="color:#dc2626">{{ data.banned_reason }}</span>
      </el-descriptions-item>
      <el-descriptions-item v-if="data.revoked_reason" label="作废原因" :span="3">
        <span style="color:#dc2626">{{ data.revoked_reason }}</span>
      </el-descriptions-item>
    </el-descriptions>

    <el-card style="margin-top:16px">
      <template #header><b>绑定设备</b><span class="sub" style="margin-left:8px">设备指纹已脱敏展示</span></template>
      <el-table :data="data?.devices ?? []" size="small">
        <el-table-column label="设备指纹" width="200">
          <template #default="{ row }"><span class="mono">{{ row.device_id }}</span></template>
        </el-table-column>
        <el-table-column prop="device_name" label="设备名" width="150" />
        <el-table-column prop="client_version" label="客户端版本" width="110" />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
              {{ row.status === 'active' ? '已绑定' : '已解绑' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最后活跃" width="170">
          <template #default="{ row }">{{ new Date(row.last_seen_at).toLocaleString() }}</template>
        </el-table-column>
        <el-table-column prop="last_ip" label="最后 IP" width="130" />
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button v-if="row.status === 'active' && auth.can('license:unbind')"
                       size="small" type="danger" link @click="unbind(row.id)">强制解绑</el-button>
            <span v-else-if="row.unbound_reason" class="sub">{{ row.unbound_reason }}</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="!data?.devices?.length" description="尚未绑定任何设备" :image-size="70" />
    </el-card>

    <el-card style="margin-top:16px">
      <template #header><b>最近授权记录</b></template>
      <el-table :data="data?.recent_logs ?? []" size="small">
        <el-table-column label="时间" width="180">
          <template #default="{ row }">{{ new Date(row.created_at).toLocaleString() }}</template>
        </el-table-column>
        <el-table-column label="动作" width="90">
          <template #default="{ row }">{{ actionLabel[row.action] ?? row.action }}</template>
        </el-table-column>
        <el-table-column label="结果" width="150">
          <template #default="{ row }">
            <el-tag v-if="row.success" type="success" size="small">成功</el-tag>
            <el-tag v-else type="danger" size="small">{{ row.code }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="设备" width="190">
          <template #default="{ row }"><span class="mono">{{ row.device_id ?? '—' }}</span></template>
        </el-table-column>
        <el-table-column prop="ip" label="IP" width="130" />
        <el-table-column prop="client_version" label="版本" />
      </el-table>
      <el-empty v-if="!data?.recent_logs?.length" description="暂无记录" :image-size="70" />
    </el-card>
  </div>
</template>
