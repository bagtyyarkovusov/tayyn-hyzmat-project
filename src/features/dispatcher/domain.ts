export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}
export type Point = [number, number];
export interface District {
  id: string;
  name: string;
  centerLat: number | string;
  centerLng: number | string;
  radiusKm?: number | string;
  boundary?: Point[][] | null;
  activeOrders?: number;
  freeDrivers?: number;
}
export interface Vehicle {
  plateNumber: string;
  make?: string;
  model?: string;
  color?: string;
}
export interface Driver {
  id: string;
  userId: string;
  status: string;
  isOnline: boolean;
  isAvailable: boolean;
  hasActiveTrip?: boolean;
  accountDeleted?: boolean;
  lastLat?: number | string;
  lastLng?: number | string;
  lastSeenAt?: string;
  lastLocationAt?: string;
  blockedReason?: string;
  district?: District;
  currentVehicle?: Vehicle;
  hasUnreadMessage?: boolean;
  user: {
    id: string;
    fullName: string;
    phone: string;
    lastLoginAt?: string;
    balance?: {
      amount: number | string;
      total?: number | string;
      held?: number | string;
      available?: number | string;
    };
  };
}
export interface Order {
  id: string;
  orderNumber: number;
  cancellationReviewRequired?: boolean;
  resolutionActions?: ("REOFFER" | "FINAL_CANCEL")[];
  notificationEventId?: string;
  offerAttemptId?: string;
  status: string;
  district?: District;
  driver?: Driver;
  pickupAddress?: string;
  dropoffAddress?: string;
  pickupLat?: number | string;
  pickupLng?: number | string;
  priceEstimated?: number | string;
  priceFinal?: number | string;
  clientPhone?: string;
  note?: string;
  createdAt: string;
  privateOfferDriverId?: string | null;
  privateOfferExpiresAt?: string | null;
  startedAt?: string | null;
  startedAgeSeconds?: number | null;
  needsCompletion?: boolean;
  resolutionAudits?: {
    action: string;
    reason: string;
    createdAt: string;
    actor?: { fullName: string };
  }[];
  broadcastAfterPrivateExpiry?: boolean;
  privateOfferStoppedAt?: string | null;
}
export interface Message {
  id: string;
  senderId: string;
  isBroadcast?: boolean;
  body: string;
  sentAt: string;
}
export interface Transaction {
  id: string;
  type: string;
  amount: number | string;
  createdAt: string;
  note?: string;
}
export interface History {
  transactions: Page<Transaction>;
  orders: Page<Order>;
}
export interface Activity {
  id: string;
  orderId?: string;
  orderNumber?: number;
  driverId?: string;
  type: string;
  summary: string;
  actor?: string;
  at: string;
}
const statusLabels: Record<string, string> = {
  NEW: "Новый",
  ACCEPTED: "Принят",
  WAITING: "Ожидание",
  STARTED: "В пути",
  COMPLETED: "Завершён",
  CANCELLED: "Отменён",
  // Legacy pre-1.21 rows only; signup no longer creates this status.
  PENDING: "Доступ ограничен",
  APPROVED: "Активен",
  BLOCKED: "Заблокирован",
};
export const statusLabel = (status: string): string =>
  statusLabels[status] ?? status;
export const money = (value: number | string | undefined): string =>
  `${Number(value ?? 0).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} TMT`;
export const date = (value?: string): string =>
  value
    ? new Date(value).toLocaleString("ru-RU", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "Нет данных";

const transactionLabels: Record<string, string> = {
  TOPUP: "Пополнение",
  WITHDRAWAL: "Списание",
  ADJUSTMENT: "Корректировка",
  BONUS: "Бонус",
  ORDER_CHARGE: "Списание за заказ",
  ORDER_REFUND: "Возврат за заказ",
};
export const transactionLabel = (type: string): string =>
  transactionLabels[type] ?? type;
