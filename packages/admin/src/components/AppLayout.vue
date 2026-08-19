<script setup lang="ts">
import { ElMessageBox } from 'element-plus';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useThemeStore } from '@/stores/theme';

const auth = useAuthStore();
const theme = useThemeStore();
const route = useRoute();
const router = useRouter();

/** 菜单按职能分组：日常发卡和系统配置不该混在一列里 */
const groups = computed(() => {
  const all = router.getRoutes()
    .filter((r) => r.meta?.title && !r.meta?.hidden)
    .filter((r) => !r.meta?.perm || auth.can(r.meta.perm as string))
    .map((r) => ({
      name: r.name as string,
      title: r.meta!.title as string,
      icon: r.meta!.icon as string,
      group: (r.meta!.group as string) ?? '其他',
    }));

  const order = ['概览', '业务', '配置', '其他'];
  return order
    .map((g) => ({ label: g, items: all.filter((i) => i.group === g) }))
    .filter((g) => g.items.length);
});

async function onLogout() {
  await ElMessageBox.confirm(
    '退出后当前账号在所有设备上的登录状态都会失效，确认退出？',
    '退出登录',
    { type: 'warning', confirmButtonText: '退出', cancelButtonText: '取消' },
  );
  await auth.logout();
  router.push({ name: 'login' });
}
</script>

<template>
  <div class="shell">
    <aside class="nav">
      <div class="brand">
        <div class="brand-mark">
          <el-icon><Key /></el-icon>
        </div>
        <div class="brand-text">
          <div class="brand-name">卡密授权中心</div>
          <div class="brand-sub">License Platform</div>
        </div>
      </div>

      <nav class="nav-body">
        <template v-for="g in groups" :key="g.label">
          <div class="nav-group">{{ g.label }}</div>
          <router-link
            v-for="m in g.items" :key="m.name"
            :to="{ name: m.name }"
            class="nav-item"
            :class="{ active: route.name === m.name || route.matched.some(r => r.name === m.name) }"
          >
            <el-icon class="nav-icon"><component :is="m.icon" /></el-icon>
            <span>{{ m.title }}</span>
          </router-link>
        </template>
      </nav>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="topbar-title">{{ route.meta?.title ?? '' }}</div>
        <div class="topbar-actions">
          <el-tooltip :content="theme.isDark ? '切换到亮色' : '切换到暗色'" placement="bottom">
            <button class="theme-btn" @click="theme.toggle()">
              <el-icon><Moon v-if="!theme.isDark" /><Sunny v-else /></el-icon>
            </button>
          </el-tooltip>
          <el-dropdown trigger="click">
          <div class="account">
            <div class="avatar">{{ (auth.admin?.nickname ?? 'A').slice(0, 1) }}</div>
            <div class="account-text">
              <div class="account-name">{{ auth.admin?.nickname ?? auth.admin?.username }}</div>
              <div class="account-role">
                {{ auth.admin?.is_super_admin ? '超级管理员' : '管理员' }}
              </div>
            </div>
            <el-icon class="account-caret"><ArrowDown /></el-icon>
          </div>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item disabled>
                <span class="mono">{{ auth.admin?.username }}</span>
              </el-dropdown-item>
              <el-dropdown-item divided :class="{ 'theme-active': theme.pref === 'light' }" @click="theme.set('light')">
                <el-icon><Sunny /></el-icon>亮色
              </el-dropdown-item>
              <el-dropdown-item :class="{ 'theme-active': theme.pref === 'dark' }" @click="theme.set('dark')">
                <el-icon><Moon /></el-icon>暗色
              </el-dropdown-item>
              <el-dropdown-item :class="{ 'theme-active': theme.pref === 'auto' }" @click="theme.set('auto')">
                <el-icon><Monitor /></el-icon>跟随系统
              </el-dropdown-item>
              <el-dropdown-item divided @click="onLogout">
                <el-icon><SwitchButton /></el-icon>退出登录
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
          </el-dropdown>
        </div>
      </header>

      <main class="content">
        <router-view />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell { display: flex; height: 100vh; overflow: hidden; }

/* ---------------- 侧边栏 ---------------- */
.nav {
  width: 216px; flex-shrink: 0;
  background: var(--c-nav);
  display: flex; flex-direction: column;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
}

.brand {
  display: flex; align-items: center; gap: 10px;
  padding: 18px 16px 16px;
}
.brand-mark {
  width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
  background: linear-gradient(135deg, #3d7bf7, #2f6feb);
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 16px;
}
.brand-name { color: #fff; font-size: 14px; font-weight: 600; line-height: 1.3; }
.brand-sub {
  color: rgba(255, 255, 255, 0.34); font-size: 10.5px;
  letter-spacing: 0.06em; text-transform: uppercase; margin-top: 1px;
}

.nav-body { flex: 1; overflow-y: auto; padding: 4px 10px 16px; }
.nav-group {
  color: rgba(255, 255, 255, 0.3); font-size: 10.5px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
  padding: 14px 8px 6px;
}
.nav-item {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; margin-bottom: 1px;
  border-radius: 6px; text-decoration: none;
  color: var(--c-nav-text); font-size: 13.5px;
  transition: background 0.12s, color 0.12s;
}
.nav-item:hover { background: var(--c-nav-hover); color: #e6e9ee; }
.nav-item.active { background: var(--c-nav-active); color: var(--c-nav-text-on); font-weight: 500; }
.nav-icon { font-size: 15px; }

/* ---------------- 顶栏 ---------------- */
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }

.topbar {
  height: 56px; flex-shrink: 0;
  background: var(--c-surface);
  border-bottom: 1px solid var(--c-border);
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 var(--s-6);
}
.topbar-title { font-size: 14.5px; font-weight: 600; color: var(--c-text); }
.topbar-actions { display: flex; align-items: center; gap: 6px; }
.theme-btn {
  width: 34px; height: 34px; border: none; background: transparent;
  border-radius: 8px; cursor: pointer; color: var(--c-text-soft);
  display: flex; align-items: center; justify-content: center; font-size: 17px;
  transition: background 0.12s, color 0.12s;
}
.theme-btn:hover { background: var(--c-surface-sunk); color: var(--c-text); }
:deep(.theme-active) { color: var(--c-primary); font-weight: 500; }

.account {
  display: flex; align-items: center; gap: 9px;
  cursor: pointer; padding: 5px 8px; border-radius: 7px;
  transition: background 0.12s;
}
.account:hover { background: var(--c-surface-sunk); }
.avatar {
  width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
  background: linear-gradient(135deg, #4b83f5, #2f6feb);
  color: #fff; font-size: 13px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
}
.account-name { font-size: 13px; font-weight: 500; line-height: 1.3; }
.account-role { font-size: 11px; color: var(--c-text-mute); line-height: 1.3; }
.account-caret { font-size: 12px; color: var(--c-text-mute); }

/* ---------------- 内容区 ---------------- */
.content { flex: 1; overflow: auto; padding: var(--s-6); }

@media (max-width: 900px) {
  .nav { width: 62px; }
  .brand-text, .nav-item span, .nav-group, .account-text { display: none; }
  .nav-item { justify-content: center; }
  .content { padding: var(--s-4); }
}
</style>
