import { defineStore } from 'pinia';
import { http } from '@/api/http';

interface AdminInfo {
  id: string;
  username: string;
  nickname: string;
  is_super_admin: boolean;
  permissions: string[];
}

const STORAGE_KEY = 'jc-kami-auth';

export const useAuthStore = defineStore('auth', {
  state: () => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const parsed = saved ? JSON.parse(saved) : {};
    return {
      accessToken: (parsed.accessToken ?? '') as string,
      refreshToken: (parsed.refreshToken ?? '') as string,
      admin: (parsed.admin ?? null) as AdminInfo | null,
    };
  },

  getters: {
    isLoggedIn: (s) => !!s.accessToken,
    /** 前端权限判断只用于隐藏入口，真正的拦截在服务端 */
    can: (s) => (perm: string) =>
      !!s.admin && (s.admin.is_super_admin || s.admin.permissions.includes(perm)),
  },

  actions: {
    persist() {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        admin: this.admin,
      }));
    },

    async login(username: string, password: string) {
      const { data } = await http.post('/admin/auth/login', { username, password });
      this.accessToken = data.access_token;
      this.refreshToken = data.refresh_token;
      this.admin = data.admin;
      this.persist();
    },

    async refresh(): Promise<boolean> {
      try {
        const { data } = await http.post('/admin/auth/refresh', { refresh_token: this.refreshToken });
        this.accessToken = data.access_token;
        this.refreshToken = data.refresh_token;
        this.admin = data.admin;
        this.persist();
        return true;
      } catch {
        this.reset();
        return false;
      }
    },

    async loadProfile() {
      const { data } = await http.get('/admin/auth/profile');
      this.admin = {
        id: data.id, username: data.username, nickname: data.nickname,
        is_super_admin: data.is_super_admin, permissions: data.permissions,
      };
      this.persist();
    },

    async logout() {
      await http.post('/admin/auth/logout').catch(() => undefined);
      this.reset();
    },

    reset() {
      this.accessToken = '';
      this.refreshToken = '';
      this.admin = null;
      localStorage.removeItem(STORAGE_KEY);
    },
  },
});
