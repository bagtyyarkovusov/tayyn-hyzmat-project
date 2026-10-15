<template>
  <v-app>

    <v-main>
      <router-view></router-view>
    </v-main>

    <!-- Shared toast queue (see driver/components/ToastHost.vue) - the
         driver-only APK bundle mounts its own copy in DriverApp.vue since it
         never loads this file at all; this one covers the admin panel and
         the driver panel when reached through the plain website instead of
         the APK/driver.html build. -->
    <ToastHost />

    <!-- Admin (/admin*) and driver (/driver*) already have their own
         self-contained header + navigation (AdminNav.vue / BottomNav.vue) -
         this legacy top bar + drawer is only for the remaining client-facing
         pages, and must never expose a path from inside the driver/admin
         panels into anywhere else. -->
    <template v-if="showLegacyChrome">
      <v-snackbar v-model="snackbar" app>
        Здравствуйте, {{ displayName }}
        <v-btn text color="primary" @click.native="snackbar = false">Закрыть</v-btn>
      </v-snackbar>

      <v-navigation-drawer fixed v-model="drawer" bottom right temporary app color="#333">
        <v-list>
          <v-list-item>
            <v-list-item-content>
              <router-link to="/">
                <v-list-item-title><h3 class="pt-2">Главная</h3></v-list-item-title>
              </router-link>
            </v-list-item-content>
          </v-list-item>
          <div v-if="connected">
            <v-list-item>
              <v-list-item-content>
                <v-list-item-title @click='home'>{{ displayName }}</v-list-item-title>
              </v-list-item-content>
            </v-list-item>
            <v-list-item>
              <v-list-item-content>
                <v-list-item-title @click="signout()" style="cursor: pointer;"><h3 class="pt-2">Выйти</h3></v-list-item-title>
              </v-list-item-content>
            </v-list-item>
          </div>
          <div v-else>
            <v-list-item>
              <v-list-item-content>
                <router-link to="/login" :key="$route.fullPath">
                  <v-list-item-title><h3 class="pt-2">Войти / Создать аккаунт</h3></v-list-item-title>
                </router-link>
              </v-list-item-content>
            </v-list-item>
          </div>
          <v-list-item>
            <v-list-item-content>
              <router-link to="/clientDashboard">
                <v-list-item-title><h3 class="pt-2">Личный кабинет</h3></v-list-item-title>
              </router-link>
            </v-list-item-content>
          </v-list-item>
          <v-list-item>
            <v-list-item-content>
              <router-link to="/clientRegister">
                <v-list-item-title><h3 class="pt-2">Регистрация</h3></v-list-item-title>
              </router-link>
            </v-list-item-content>
          </v-list-item>
          <v-list-item>
            <v-list-item-content>
              <router-link to="/map">
                <v-list-item-title><h3 class="pt-2">Карта</h3></v-list-item-title>
              </router-link>
            </v-list-item-content>
          </v-list-item>
          <v-list-item>
            <v-list-item-content>
              <router-link to="/clientSupport">
                <v-list-item-title><h3 class="pt-2">Поддержка</h3></v-list-item-title>
              </router-link>
            </v-list-item-content>
          </v-list-item>
        </v-list>
      </v-navigation-drawer>

      <v-app-bar dense dark app color="#53346d">
        <v-spacer></v-spacer>
        <v-app-bar-nav-icon @click.stop="drawer = !drawer" dark></v-app-bar-nav-icon>
      </v-app-bar>
    </template>

  </v-app>
</template>

<script>
import * as firebase from 'firebase'
import ToastHost from './driver/components/ToastHost.vue'

export default {
  components: { ToastHost },
  data() {
    return {
      drawer: false,
      connected: false,
      displayName: '',
      uid: '',
      snackbar: false
    }
  },
  computed: {
    showLegacyChrome() {
      return !/^\/(admin|driver)/.test(this.$route.path)
    }
  },
  methods: {
    home() {
      this.$router.push('/')
    },
    checkConnection() {
      let vm = this
      firebase.auth().onAuthStateChanged(
        function(user) {
          if (user) {
            vm.connected = !user.isAnonymous
            vm.displayName = user.isAnonymous ? 'Anonymous User' : user.displayName
            vm.uid = user.uid
            vm.snackbar = !user.isAnonymous
          } else {
            vm.connected = false
            vm.displayName = ''
            vm.uid = ''
          }
        },
        function(error) {
          console.log(error)
        }
      )
    },
    signout() {
      let vm = this
      firebase
        .auth()
        .signOut()
        .then(function() {
          vm.displayName = ''
          vm.connected = false
        })
    }
  },
  mounted() {
    this.checkConnection()
  }
}
</script>

<style>
@media screen and (max-width: 600px) {
  #toolbarTitle {
    display: none;
  }
}

ul {
  list-style: none
}

a {
  text-decoration: none;
}
</style>
