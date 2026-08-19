<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const loading = ref(false);
const form = reactive({ username: '', password: '' });

async function submit() {
  if (!form.username || !form.password) {
    ElMessage.warning('请输入用户名和密码');
    return;
  }
  loading.value = true;
  try {
    await auth.login(form.username, form.password);
    ElMessage.success('登录成功');
    router.push((route.query.redirect as string) || '/dashboard');
  } catch {
    // 错误提示已由 http 拦截器统一弹出
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login">
    <!-- 左侧品牌区：在窄屏上隐藏，不挤占表单 -->
    <div class="pane">
      <div class="pane-inner">
        <div class="mark"><el-icon><Key /></el-icon></div>
        <h1>卡密授权中心</h1>
        <p class="tagline">统一管理多个软件的授权、发卡与远程管控</p>
        <ul class="points">
          <li><el-icon><Select /></el-icon>批量发卡、设备绑定、换绑与封禁</li>
          <li><el-icon><Select /></el-icon>一键远程关停，版本策略与灰度升级</li>
          <li><el-icon><Select /></el-icon>授权流水与操作审计全程可追溯</li>
        </ul>
      </div>
    </div>

    <div class="form-side">
      <div class="form-box">
        <h2>管理员登录</h2>
        <p class="hint">请使用后台账号登录</p>

        <el-form label-position="top" size="large" @submit.prevent="submit">
          <el-form-item label="用户名">
            <el-input v-model="form.username" placeholder="admin" autofocus>
              <template #prefix><el-icon><User /></el-icon></template>
            </el-input>
          </el-form-item>
          <el-form-item label="密码">
            <el-input v-model="form.password" type="password" show-password
                      placeholder="请输入密码" @keyup.enter="submit">
              <template #prefix><el-icon><Lock /></el-icon></template>
            </el-input>
          </el-form-item>
          <el-button type="primary" size="large" style="width: 100%" :loading="loading"
                     @click="submit">
            登 录
          </el-button>
        </el-form>

        <div class="note">
          <el-icon><InfoFilled /></el-icon>
          连续输错 5 次将锁定账号 15 分钟
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login { display: flex; height: 100vh; }

/* ---- 左侧品牌区 ---- */
.pane {
  flex: 1.1; position: relative; overflow: hidden;
  background: linear-gradient(155deg, #1c2128 0%, #1e2a44 55%, #223a6b 100%);
  display: flex; align-items: center; justify-content: center;
  padding: 48px;
}
/* 一层极淡的网格，避免大面积纯色显得空 */
.pane::before {
  content: ''; position: absolute; inset: 0;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
  background-size: 44px 44px;
  mask-image: radial-gradient(ellipse at 30% 40%, #000 20%, transparent 72%);
}
.pane-inner { position: relative; max-width: 400px; color: #fff; }

.mark {
  width: 46px; height: 46px; border-radius: 13px;
  background: linear-gradient(135deg, #4b83f5, #2f6feb);
  display: flex; align-items: center; justify-content: center;
  font-size: 23px; margin-bottom: 26px;
  box-shadow: 0 8px 24px rgba(47, 111, 235, 0.4);
}
.pane h1 {
  margin: 0 0 12px; font-size: 30px; font-weight: 650; letter-spacing: -0.02em;
}
.tagline {
  margin: 0 0 32px; font-size: 14.5px; line-height: 1.7;
  color: rgba(255, 255, 255, 0.62);
}
.points { list-style: none; margin: 0; padding: 0; }
.points li {
  display: flex; align-items: center; gap: 10px;
  color: rgba(255, 255, 255, 0.78); font-size: 13.5px;
  padding: 9px 0;
}
.points .el-icon { color: #6ea8ff; font-size: 15px; flex-shrink: 0; }

/* ---- 右侧表单 ---- */
.form-side {
  flex: 1; min-width: 400px;
  display: flex; align-items: center; justify-content: center;
  background: var(--c-surface); padding: 40px;
}
.form-box { width: 100%; max-width: 340px; }
.form-box h2 {
  margin: 0 0 6px; font-size: 22px; font-weight: 600; letter-spacing: -0.01em;
}
.hint { margin: 0 0 28px; color: var(--c-text-mute); font-size: 13.5px; }

.note {
  margin-top: 22px; padding: 11px 13px;
  background: var(--c-surface-sunk); border: 1px solid var(--c-border);
  border-radius: var(--r-sm);
  color: var(--c-text-mute); font-size: 12.5px;
  display: flex; align-items: center; gap: 7px;
}

@media (max-width: 860px) {
  .pane { display: none; }
  .form-side { min-width: 0; }
}
</style>
