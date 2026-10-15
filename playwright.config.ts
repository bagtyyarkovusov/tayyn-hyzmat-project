import { defineConfig, devices } from '@playwright/test'
export default defineConfig({ testDir:'tests/browser', fullyParallel:false, workers:1, timeout:30000, expect:{timeout:7000}, reporter:'list', use:{baseURL:process.env.TEST_BASE_URL, trace:'retain-on-failure', screenshot:'only-on-failure'}, projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}] })
