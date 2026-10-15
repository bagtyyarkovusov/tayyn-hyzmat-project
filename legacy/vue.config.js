module.exports = {
  publicPath: '/legacy/',
  outputDir: '../dist/legacy',
  transpileDependencies: ['vuetify'],

  // @vue/cli-plugin-pwa's default generated service worker only takes over
  // once every open tab of the site has been closed - a deploy can look
  // "not applied" (stale UI, stale CSS) for however long a browser tab
  // stays open, independent of the server actually serving new files
  // (which nginx already does correctly - index.html is no-cache). This
  // makes a new service worker activate and take control immediately on
  // the next page load instead of waiting for every tab to close.
  pwa: {
    workboxOptions: {
      skipWaiting: true,
      clientsClaim: true
    }
  },

  // No source maps in production output: they re-expose readable original
  // source (component logic, API paths, comments) inside the shipped
  // bundle's sibling .map files, which is both a real size cost (was ~1.5MB
  // for the driver bundle alone, ~4x the JS itself) and something a
  // production APK specifically should not carry.
  productionSourceMap: false,

  // Two independent bundles from one repo:
  //  - "index": the full multi-role web SPA (client/admin-legacy/driver),
  //    unchanged - still pulls in Vuetify/Firebase/Leaflet.
  //  - "driver": a lean, driver-only bundle with none of that - this is what
  //    actually ships inside the Android APK (see capacitor.config.json's
  //    webDir, which points at dist/driver.html + its own chunks only).
  pages: {
    // `chunks` pins each page to only its own entry's output - without it,
    // html-webpack-plugin's default multi-page behavior injected BOTH
    // pages' <link rel=preload> resource hints into index.html (driver.js/
    // driver.css alongside its own, confirmed in the deployed HTML), even
    // though index.html never actually uses them - wasted bandwidth for
    // every web visitor and the "preloaded but not used" console warning.
    // driver.html happened to come out scoped correctly already, but this
    // pins both explicitly so neither page can regress the other way.
    index: {
      entry: 'src/main.js',
      template: 'public/index.html',
      filename: 'index.html',
      chunks: ['index']
    },
    driver: {
      entry: 'src/main-driver.js',
      template: 'public/driver.html',
      filename: 'driver.html',
      title: 'Tayyn hyzmat Водитель',
      chunks: ['driver']
    }
  },

  // Vue CLI's default multi-page setup merges every entry's node_modules
  // code into one shared `chunk-vendors.js` - which would silently pull
  // Vuetify/Firebase/Leaflet into the driver bundle too, defeating the
  // entire point of a separate lean entry above. Deleting the injected
  // splitChunks optimization makes each page bundle its own dependency
  // graph in full isolation instead (driver.js ends up with its own small
  // inlined copy of vue/vuex/vue-router rather than sharing a vendor chunk
  // with index.js - a fine trade since only driver's output ships in the APK).
  chainWebpack: (config) => {
    config.optimization.delete('splitChunks')

    // Vue CLI's own preload-webpack-plugin instances are already configured
    // scoped per page (`include: { entries: ['index'] }` / `['driver']`,
    // see `vue-cli-service inspect`) but that scoping doesn't actually hold
    // in this multi-page + no-splitChunks setup: index.html's build still
    // emitted a first, unfiltered pass of <link rel=preload> tags for
    // BOTH driver.js/driver.css and its own index.js/index.css (confirmed
    // in the built HTML - every real visitor's browser fetching and never
    // using ~450KiB it doesn't need, plus the "preloaded but not used"
    // Chrome console warning). Patching fileBlacklist on the plugin
    // instances only fixed a second, already-correctly-scoped pass, not
    // this first one - a real bug/limitation in this old, no-longer
    // actively maintained plugin version when combined with the deleted
    // splitChunks above, not something worth fighting further. Dropping
    // the plugin entirely is the reliable fix: it only ever provided a
    // minor fetch-priority hint, nothing actually depends on it working.
    config.plugins.delete('preload-index')
    config.plugins.delete('prefetch-index')
    config.plugins.delete('preload-driver')
    config.plugins.delete('prefetch-driver')
  }
}
