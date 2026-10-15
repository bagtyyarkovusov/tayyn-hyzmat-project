const STORAGE_KEY = 'openride.theme'; // 'system' | 'light' | 'dark'

function resolveTheme(preference) {
  if (preference === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return preference;
}

function applyTheme(theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

let nextToastId = 1;

const state = () => ({
  themePreference: localStorage.getItem(STORAGE_KEY) || 'system',
  theme: 'light',
  // Shared toast queue (see driver/components/ToastHost.vue) - a single
  // visual/animation implementation for every "toast notification" the
  // redesign spec asks for (admin message, order completed, etc.) instead
  // of each screen rolling its own.
  toasts: []
});

const getters = {
  isDark: (s) => s.theme === 'dark'
};

const mutations = {
  SET_PREFERENCE(s, preference) {
    s.themePreference = preference;
    s.theme = resolveTheme(preference);
  },
  PUSH_TOAST(s, toast) {
    s.toasts.push(toast);
  },
  DISMISS_TOAST(s, id) {
    s.toasts = s.toasts.filter((t) => t.id !== id);
  }
};

const actions = {
  init({ commit, state: s }) {
    commit('SET_PREFERENCE', s.themePreference);
    applyTheme(s.theme);

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (s.themePreference === 'system') {
        commit('SET_PREFERENCE', 'system');
        applyTheme(s.theme);
      }
    });
  },
  setPreference({ commit, state: s }, preference) {
    commit('SET_PREFERENCE', preference);
    localStorage.setItem(STORAGE_KEY, preference);
    applyTheme(s.theme);
  },
  toggle({ dispatch, state: s }) {
    dispatch('setPreference', s.theme === 'dark' ? 'light' : 'dark');
  },
  // variant: 'default' | 'success' | 'error'. Auto-dismisses after `duration`ms
  // (default 5s) unless the caller passes duration: 0 to keep it until the
  // user/screen dismisses it explicitly.
  pushToast({ commit, dispatch }, { title = '', body = '', variant = 'default', duration = 5000 } = {}) {
    const id = nextToastId++;
    commit('PUSH_TOAST', { id, title, body, variant });
    if (duration > 0) {
      window.setTimeout(() => dispatch('dismissToast', id), duration);
    }
    return id;
  },
  dismissToast({ commit }, id) {
    commit('DISMISS_TOAST', id);
  }
};

export default { namespaced: true, state, getters, mutations, actions };
