<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  ArrowRight,
  LoaderCircle,
  ShieldCheck,
  Truck,
  Users,
} from "lucide-vue-next";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { adminSession, driverSession } from "./session";
import { errorMessage, publicRequest } from "@/shared/api";
const route = useRoute();
const router = useRouter();
const isAdmin = computed(() => route.path === "/adminLogin");
const registering = computed(() => route.path === "/driverRegister");
const phone = ref("+993");
const password = ref("");
const fullName = ref("");
const busy = ref(false);
const error = ref("");
const message = ref("");
async function submit() {
  busy.value = true;
  error.value = "";
  message.value = "";
  try {
    if (registering.value) {
      await publicRequest("/auth/register", {
        phone: phone.value,
        password: password.value,
        fullName: fullName.value,
      });
      message.value =
        "Заявка отправлена. Диспетчер проверит ваш аккаунт. После одобрения войдите с этим номером.";
      password.value = "";
      return;
    }
    await (isAdmin.value ? adminSession : driverSession).login(
      phone.value,
      password.value,
    );
    await router.replace(
      isAdmin.value ? "/adminDashboard" : "/driverDashboard",
    );
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="auth-layout">
    <section class="auth-story" aria-label="Tayyn Hyzmat">
      <RouterLink to="/" class="brand"
        ><span class="brand-symbol">т</span
        ><span>тайын хызмат</span></RouterLink
      >
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
      <div class="flex items-center gap-3 text-sm">
        <ShieldCheck class="size-5" />Тестовая среда · расчёты только в TMT
      </div>
    </section>
    <section class="auth-form-wrap">
      <div class="w-full max-w-sm">
        <div class="mb-8 flex items-center gap-2 text-sm text-muted-foreground">
          <component :is="isAdmin ? Users : Truck" class="size-5" />{{
            isAdmin ? "Рабочее место диспетчера" : "Приложение водителя"
          }}
        </div>
        <h2 class="mb-2 text-3xl font-semibold tracking-tight">
          {{ registering ? "Стать водителем" : "С возвращением" }}
        </h2>
        <p class="mb-8 text-muted-foreground">
          {{
            registering
              ? "Создайте аккаунт и дождитесь одобрения диспетчера."
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
            ><Input
              id="phone"
              v-model="phone"
              type="tel"
              autocomplete="tel"
              placeholder="+993 …"
              required
            />
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
            />
          </div>
          <p v-if="error" role="alert" class="error-message">{{ error }}</p>
          <p v-if="message" role="status" class="rounded-lg bg-secondary p-4">
            {{ message }}
          </p>
          <Button type="submit" :disabled="busy" class="h-12 w-full"
            ><LoaderCircle v-if="busy" class="size-4 animate-spin" />{{
              busy ? "Подождите…" : registering ? "Отправить заявку" : "Войти"
            }}<ArrowRight v-if="!busy" class="ml-auto size-4"
          /></Button>
        </form>
        <p v-if="!isAdmin" class="mt-6 text-sm text-muted-foreground">
          {{ registering ? "Уже есть аккаунт?" : "Ещё не зарегистрированы?" }}
          <RouterLink
            :to="registering ? '/driverLogin' : '/driverRegister'"
            class="font-semibold text-primary underline underline-offset-4"
            >{{ registering ? "Войти" : "Подать заявку" }}</RouterLink
          >
        </p>
        <RouterLink
          :to="isAdmin ? '/driverLogin' : '/adminLogin'"
          class="mt-10 inline-block text-sm text-muted-foreground underline underline-offset-4"
          >{{ isAdmin ? "Я водитель" : "Вход для диспетчера" }}</RouterLink
        >
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
  background: #204e3c;
  color: #f3f3e9;
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
  color: #d3e1d4;
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
    grid-template-columns: 1fr;
  }
  .auth-story {
    padding: 1.5rem;
    gap: 2rem;
  }
  .auth-story h1 {
    font-size: 2rem;
  }
  .auth-story > div:last-child {
    display: none;
  }
  .auth-story p {
    margin-top: 0.75rem;
  }
  .auth-form-wrap {
    padding: 2rem 1.5rem;
  }
}
</style>
