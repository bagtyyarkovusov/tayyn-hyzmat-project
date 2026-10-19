<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from "vue-router";
import {
  ArrowRight,
  LoaderCircle,
  ShieldCheck,
  Truck,
  Users,
} from "lucide-vue-next";
import BrandLogo from "@/shared/BrandLogo.vue";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import PhoneInput from "@/shared/ui/phone-input/PhoneInput.vue";
import { passwordError, passwordHint } from "@/shared/password";
import { Label } from "@/shared/ui/label";
import { adminSession, driverSession } from "./session";
import { ApiError, errorMessage } from "@/shared/api";
const route = useRoute();
const development = import.meta.env.DEV;
const router = useRouter();
const isAdmin = computed(() => route.path.replace(/\/$/, "") === "/adminLogin");
const registering = computed(
  () => route.path.replace(/\/$/, "") === "/driverRegister",
);
const phone = ref("+993");
const password = ref("");
const fullName = ref("");
const busy = ref(false);
const error = ref("");
const recovery = ref(false);
let controller: AbortController | null = null;
function cancel() {
  controller?.abort();
  controller = null;
  busy.value = false;
}
onBeforeRouteLeave(cancel);
onBeforeRouteUpdate(cancel);
onBeforeUnmount(cancel);
watch(
  () => route.path,
  () => {
    error.value = "";
    recovery.value = false;
    password.value = "";
  },
);
async function submit() {
  if (busy.value) return;
  if (!navigator.onLine) {
    error.value = "Нет интернета. Подключитесь и попробуйте снова.";
    return;
  }
  if (registering.value && passwordError(password.value)) {
    error.value = passwordError(password.value);
    return;
  }
  busy.value = true;
  error.value = "";
  const request = new AbortController();
  controller = request;
  const creating = registering.value;
  const admin = isAdmin.value;
  try {
    if (creating) {
      await driverSession.register(
        fullName.value,
        phone.value,
        password.value,
        request.signal,
      );
    } else {
      await (admin ? adminSession : driverSession).login(
        phone.value,
        password.value,
        request.signal,
      );
    }
    if (request.signal.aborted) return;
    await router.replace(admin ? "/adminDashboard" : "/driverDashboard");
  } catch (cause) {
    if (request.signal.aborted) return;
    recovery.value =
      creating &&
      (!(cause instanceof ApiError) ||
        cause.status >= 500 ||
        cause.status === 409);
    // A 409 carries the server's sign-in/dispatcher guidance for an existing phone.
    error.value = recovery.value
      ? "Не удалось подтвердить создание аккаунта. Попробуйте войти с этим номером и паролем. Если вход недоступен, обратитесь к диспетчеру."
      : errorMessage(cause);
  } finally {
    if (controller === request) {
      controller = null;
      busy.value = false;
    }
  }
}
</script>
<template>
  <div class="auth-layout">
    <section class="auth-story" aria-label="Tayyn Hyzmat">
      <RouterLink to="/" class="brand"><BrandLogo /></RouterLink>
      <div>
        <h1>
          {{
            isAdmin
              ? "Город движется.\nВы задаёте ритм."
              : "Ваш регион.\nВаш следующий заказ."
          }}
        </h1>
        <p>
          {{
            isAdmin
              ? "Заказы, водители и регионы в одном рабочем пространстве."
              : "Выходите на линию, получайте заказы своего региона и оставайтесь на связи с диспетчером."
          }}
        </p>
      </div>
      <div v-if="development" class="flex items-center gap-3 text-sm">
        <ShieldCheck class="size-5" />Тестовая среда · расчёты только в TMT
      </div>
    </section>
    <section class="auth-form-wrap">
      <div class="w-full max-w-sm">
        <div
          class="auth-context mb-8 flex items-center gap-2 text-sm text-muted-foreground"
        >
          <component :is="isAdmin ? Users : Truck" class="size-5" />{{
            isAdmin ? "Рабочее место диспетчера" : "Приложение водителя"
          }}
        </div>
        <h2 class="auth-heading mb-2 text-3xl font-semibold tracking-tight">
          {{ registering ? "Создать аккаунт" : "С возвращением" }}
        </h2>
        <p class="auth-intro mb-8 text-muted-foreground">
          {{
            registering
              ? "После создания аккаунта вы сразу войдёте. Для выхода на линию пополните баланс и включите GPS."
              : "Войдите, чтобы продолжить работу."
          }}
        </p>
        <form class="grid gap-5" @submit.prevent="submit">
          <div v-if="registering" class="field">
            <Label for="fullName">Имя и фамилия</Label
            ><Input
              id="fullName"
              v-model="fullName"
              autocomplete="name"
              required
              minlength="2"
              maxlength="120"
            />
          </div>
          <div class="field">
            <Label for="phone">Номер телефона</Label
            ><PhoneInput id="phone" v-model="phone" required />
          </div>
          <div class="field">
            <Label for="password">Пароль</Label
            ><Input
              id="password"
              v-model="password"
              type="password"
              :autocomplete="registering ? 'new-password' : 'current-password'"
              required
              :minlength="registering ? 6 : 1"
              :maxlength="registering ? 72 : undefined"
            />
          </div>
          <p v-if="registering" class="text-xs text-muted-foreground">
            {{ passwordHint }}
          </p>
          <p v-if="error" role="alert" class="error-message">{{ error }}</p>
          <Button
            v-if="!recovery"
            type="submit"
            :disabled="busy"
            class="h-12 w-full"
            ><LoaderCircle v-if="busy" class="size-4 animate-spin" />{{
              busy ? "Подождите…" : registering ? "Создать аккаунт" : "Войти"
            }}<ArrowRight v-if="!busy" class="ml-auto size-4"
          /></Button>
          <Button v-if="recovery" as-child class="h-12 w-full">
            <RouterLink to="/driverLogin">Перейти ко входу</RouterLink>
          </Button>
        </form>
        <p v-if="!isAdmin" class="mt-6 text-sm text-muted-foreground">
          {{ registering ? "Уже есть аккаунт?" : "Ещё не зарегистрированы?" }}
          <RouterLink
            :to="registering ? '/driverLogin' : '/driverRegister'"
            class="font-semibold text-primary underline underline-offset-4"
            >{{ registering ? "Войти" : "Создать аккаунт" }}</RouterLink
          >
        </p>
      </div>
    </section>
  </div>
</template>
<style scoped>
.auth-layout {
  min-height: 100svh;
  display: grid;
  grid-template-columns: 1fr 1fr;
}
.auth-story {
  background: #122d4b;
  color: #ffffff;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: clamp(2rem, 5vw, 5rem);
  gap: 5rem;
}
.auth-story h1 {
  font-size: clamp(2.5rem, 4vw, 4.5rem);
  font-weight: 600;
  letter-spacing: -0.035em;
  line-height: 1.12;
  white-space: pre-line;
}
.auth-story p {
  margin-top: 1.5rem;
  max-width: 36ch;
  color: #c1cddd;
  font-size: 1.05rem;
}
.auth-form-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3rem 1.5rem;
}
@media (max-width: 760px) {
  .auth-layout {
    display: flex;
    flex-direction: column;
  }
  .auth-story {
    padding: 1rem 1.25rem;
    gap: 0;
  }
  .auth-story > div {
    display: none;
  }
  .auth-form-wrap {
    align-items: flex-start;
    padding: 1.5rem 1.25rem max(1.5rem, env(safe-area-inset-bottom));
  }
  .auth-context {
    margin-bottom: 1rem;
  }
  .auth-heading {
    font-size: 1.5rem;
    line-height: 2rem;
  }
  .auth-intro {
    margin-bottom: 1.25rem;
  }
}
</style>
