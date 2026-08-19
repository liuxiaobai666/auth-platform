import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import { useThemeStore } from './stores/theme';
import './styles/main.css';

const app = createApp(App);
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component);
}
app.use(createPinia());

// 主题要在挂载前应用，避免刷新时先闪一下亮色再切暗
useThemeStore().init();

app.use(router);
app.use(ElementPlus, { locale: zhCn });
app.mount('#app');
