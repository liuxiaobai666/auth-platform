import { ElMessage } from 'element-plus';
import axios, { AxiosError } from 'axios';
import router from '@/router';
import { useAuthStore } from '@/stores/auth';

export const http = axios.create({ baseURL: '/api/v1', timeout: 30_000 });

http.interceptors.request.use((config) => {
  const auth = useAuthStore();
  if (auth.accessToken) {
    config.headers.Authorization = `Bearer ${auth.accessToken}`;
  }
  return config;
});

let refreshing: Promise<boolean> | null = null;

http.interceptors.response.use(
  (res) => res,
  async (error: AxiosError<{ code?: string; message?: string; request_id?: string }>) => {
    const auth = useAuthStore();
    const data = error.response?.data;
    const code = data?.code;
    const original = error.config as any;

    // 访问令牌过期时静默续期一次；并发请求共用同一次刷新，避免刷新风暴
    if (code === 'TOKEN_EXPIRED' && !original?._retried && auth.refreshToken) {
      original._retried = true;
      refreshing ??= auth.refresh().finally(() => { refreshing = null; });
      if (await refreshing) return http(original);
    }

    if (code === 'TOKEN_INVALID' || code === 'UNAUTHORIZED' || code === 'TOKEN_EXPIRED') {
      auth.reset();
      if (router.currentRoute.value.name !== 'login') {
        ElMessage.warning('登录状态已失效，请重新登录');
        void router.push({ name: 'login' });
      }
      return Promise.reject(error);
    }

    const msg = data?.message ?? error.message ?? '请求失败';
    ElMessage.error(data?.request_id ? `${msg}（${data.request_id}）` : msg);
    return Promise.reject(error);
  },
);

/** 统一解包，业务代码直接拿数据，不用到处写 .data.data */
export async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  return (await http.get<T>(url, { params })).data;
}
export async function post<T>(url: string, body?: unknown, config?: any): Promise<T> {
  return (await http.post<T>(url, body, config)).data;
}
export async function patch<T>(url: string, body?: unknown): Promise<T> {
  return (await http.patch<T>(url, body)).data;
}
export async function del<T>(url: string): Promise<T> {
  return (await http.delete<T>(url)).data;
}
