<script setup lang="ts">
import { ElMessage } from 'element-plus';

const props = defineProps<{
  modelValue: boolean;
  title: string;
  pluginId?: string;
  token?: string;
  secret?: string;
  hint?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

const isReal = (v?: string) => !!v && !v.startsWith('（');

async function copy(text?: string) {
  if (!isReal(text)) return;
  await navigator.clipboard.writeText(text!);
  ElMessage.success('已复制');
}

/** 一键复制全部：格式化成可直接发给对接人的一段文本 */
async function copyAll() {
  const lines: string[] = [];
  if (props.pluginId) lines.push(`plugin_id=${props.pluginId}`);
  if (isReal(props.token)) lines.push(`plugin_token=${props.token}`);
  if (isReal(props.secret)) lines.push(`plugin_secret=${props.secret}`);
  if (!lines.length) return;
  await navigator.clipboard.writeText(lines.join('\n'));
  ElMessage.success('已复制全部凭据');
}
</script>

<template>
  <el-dialog :model-value="modelValue" :title="title" width="640px"
             @update:model-value="emit('update:modelValue', $event)">
    <el-alert type="warning" :closable="false" style="margin-bottom:14px"
              title="签名密钥等同于该应用的授权钥匙。请通过安全渠道交给接入方，不要贴在聊天工具或提交进代码仓库" />
    <el-alert v-if="hint" type="info" :closable="false" style="margin-bottom:14px" :title="hint" />

    <el-form label-width="120px">
      <el-form-item label="plugin_id">
        <el-input :model-value="pluginId" readonly class="mono">
          <template #append><el-button @click="copy(pluginId)">复制</el-button></template>
        </el-input>
      </el-form-item>
      <el-form-item label="plugin_token">
        <el-input :model-value="token" readonly class="mono">
          <template #append><el-button @click="copy(token)">复制</el-button></template>
        </el-input>
      </el-form-item>
      <el-form-item label="plugin_secret">
        <el-input :model-value="secret" readonly class="mono">
          <template #append><el-button @click="copy(secret)">复制</el-button></template>
        </el-input>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button type="primary" plain @click="copyAll">
        <el-icon><CopyDocument /></el-icon>一键复制全部
      </el-button>
      <el-button type="primary" @click="emit('update:modelValue', false)">我已保存</el-button>
    </template>
  </el-dialog>
</template>
