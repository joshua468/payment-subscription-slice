import type { Subscription } from "@prisma/client";

export type Plan = "Pro";

export type Interval = "monthly" | "yearly";

export type SubscriptionStatus =
  | "active"
  | "pending_downgrade"
  | "pending_cancellation"
  | "payment_pending"
  | "cancelled";

export type PaymentStage =
  | "initiation"
  | "verification"
  | "fulfilment"
  | "failure";

export type Currency =
  | "USD"
  | "NGN"
  | "EUR"
  | "GBP"
  | "GHS"
  | "KES"
  | "UGX"
  | "RWF"
  | "TZS"
  | "ZAR";

export type PaymentMode = "test" | "prod";

export interface PlanPricing {
  plan: Plan;
  interval: Interval;
  amountMinorUnits: number;
  currency: Currency;
}

export interface CheckoutRequest {
  interval: Interval;
}

export interface ProrationBreakdown {
  daysRemaining: number;
  creditMinorUnits: number;
  fullPrecisionCredit: number;
  proratedChargeMinorUnits: number;
}

export interface CheckoutResponse {
  flutterwaveRedirectUrl: string;
  flutterwavePaymentId: string;
  txRef: string;
  proration?: ProrationBreakdown;
}

export interface CancelRequest {
  reason?: string;
}

export interface CancelResponse {
  cancelled: boolean;
  periodEnd: Date | null;
}

export interface VerifyRequest {
  providerEventId: string;
}

export interface VerifyResponse {
  stage: PaymentStage;
  subscription?: Subscription;
}

export interface ProrationInput {
  currentAmountMinorUnits: number;
  newAmountMinorUnits: number;
  currentInterval: Interval;
  newInterval: Interval;
  daysRemaining: number;
}

export interface ProrationResult {
  creditMinorUnits: number;
  proratedChargeMinorUnits: number;
  fullPrecisionCredit: number;
}

export interface FlutterwaveWebhookPayload {
  event: string;
  data: FlutterwaveWebhookData;
}

export interface FlutterwaveWebhookData {
  id: string;
  tx_ref?: string;
  amount?: number;
  currency?: Currency | string;
  status?: string;
  plan?: string;
  sub?: string;
  customer?: {
    id?: string;
    email?: string;
    name?: string;
  };
  created_at?: string;
}