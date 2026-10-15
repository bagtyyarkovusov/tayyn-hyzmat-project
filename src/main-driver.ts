import { createApp } from 'vue'
import App from './App.vue'
import { makeRouter } from './app-router'
import './shared/theme.css'
import './shared/theme'
createApp(App).use(makeRouter(true)).mount('#app')
