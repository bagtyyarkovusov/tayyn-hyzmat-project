export type Money = number | string;
export type OrderStatus =
  "NEW" | "ACCEPTED" | "WAITING" | "STARTED" | "COMPLETED" | "CANCELLED";
export interface District {
  id: string;
  name: string;
  centerLat?: Money;
  centerLng?: Money;
  boundary?: number[][][] | null;
  activeOrders: number;
  publicAvailableOrders: number;
  freeDrivers: number;
  onlineDrivers?: number;
}
export interface Order {
  id: string;
  orderNumber: number;
  status: OrderStatus;
  pickupAddress: string | null;
  dropoffAddress?: string | null;
  pickupLat?: Money | null;
  pickupLng?: Money | null;
  dropoffLat?: Money | null;
  dropoffLng?: Money | null;
  priceEstimated: Money | null;
  priceFinal?: Money | null;
  clientPhone?: string | null;
  note?: string | null;
  etaMinutes?: number;
  createdAt: string;
  acceptedAt?: string | null;
  arrivedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  privateOfferExpiresAt?: string | null;
  privateOfferRemainingMs?: number;
  districtId?: string | null;
  publicRegionOnlyUntil?: string | null;
  publicOfferRemainingMs?: number;
  district?: District;
}
export interface DriverProfile {
  id: string;
  userId: string;
  status: string;
  districtId: string | null;
  district?: District | null;
  isOnline: boolean;
  isAvailable: boolean;
  canControlShift?: boolean;
  lastLat?: Money | null;
  lastLng?: Money | null;
  user: { id: string; fullName: string; phone: string };
  currentVehicle?: {
    plateNumber: string;
    make: string;
    model: string;
    color?: string;
  } | null;
}
export interface Balance {
  amount: Money;
  currency: string;
}
export interface Message {
  id: string;
  senderId: string;
  body: string;
  sentAt: string;
}
export interface Transaction {
  id: string;
  type: string;
  amount: Money;
  balanceAfter: Money;
  createdAt: string;
  note?: string;
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}
export interface History {
  orders: Page<Order>;
  transactions: Page<Transaction>;
}
export const statusLabels: Record<OrderStatus, string> = {
  NEW: "Новый",
  ACCEPTED: "Принят",
  WAITING: "Ожидание",
  STARTED: "В пути",
  COMPLETED: "Завершён",
  CANCELLED: "Отменён",
};
export function money(value: Money | null | undefined) {
  return (
    new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(
      Number(value ?? 0),
    ) + " TMT"
  );
}
export function date(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}
