import { defineStore } from 'pinia';

export type ThemePref = 'light' | 'dark' | 'auto';
const KEY = 'jc-kami-theme';

/** 系统当前是否偏好暗色 */
function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export const useThemeStore = defineStore('theme', {
  state: () => ({
    // light / dark 是用户明确选择；auto 跟随系统
    pref: (localStorage.getItem(KEY) as ThemePref) || 'auto',
  }),

  getters: {
    /** 最终生效的模式（把 auto 解析成 light/dark） */
    resolved(state): 'light' | 'dark' {
      return state.pref === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : state.pref;
    },
    isDark(): boolean {
      return this.resolved === 'dark';
    },
  },

  actions: {
    /** 把当前主题落到 <html data-theme> 上，CSS 变量据此切换 */
    apply() {
      document.documentElement.setAttribute('data-theme', this.resolved);
    },

    set(pref: ThemePref) {
      this.pref = pref;
      localStorage.setItem(KEY, pref);
      this.apply();
    },

    /** 在 亮 / 暗 之间直接切换（跳过 auto，符合点一下就换的直觉） */
    toggle() {
      this.set(this.isDark ? 'light' : 'dark');
    },

    /** 应用启动时调用：应用主题，并在 auto 模式下监听系统切换 */
    init() {
      this.apply();
      window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (this.pref === 'auto') this.apply();
      });
    },
  },
});
