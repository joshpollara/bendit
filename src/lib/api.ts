import type {
  ExerciseEntry,
  Fast,
  Food,
  FoodLogEntry,
  Meal,
  Measurement,
  MeasurementSite,
  Profile,
  WeightEntry,
} from '../types';
import type { DayTotals } from './report';
import type { MealFeedback } from './mealPhoto';

// Thin client for the server API. The server owns the SQLite database; the
// browser holds no data.

export interface JoinedEntry extends FoodLogEntry {
  food?: Food;
}

/** A server refusal with enough structure for the screen to offer the right recovery. */
export class ApiError extends Error {
  code: string | null;
  status: number;
  retryAfterSeconds: number | null;
  /** Anything else the server sent about the refusal, such as a Picnic checkout issue. */
  details: Record<string, unknown> | null;

  constructor(
    message: string,
    {
      code = null,
      status,
      retryAfterSeconds = null,
      details = null,
    }: { code?: string | null; status: number; retryAfterSeconds?: number | null; details?: Record<string, unknown> | null },
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.details = details;
  }
}

/** A quick add you've typed before, offered back with whatever it recorded. */
export interface QuickAddSuggestion {
  label: string;
  calories: number;
  protein?: number | null;
  carbs?: number | null;
  fat?: number | null;
}

export interface BrowsedFood extends Food {
  usageCount: number;
  /** Nutri-Score A–E: published where the source states one, otherwise computed. */
  grade: NutriGrade | null;
}

export type NutriGrade = 'A' | 'B' | 'C' | 'D' | 'E';

/** Points for each part of the Nutri-Score, as the published algorithm counts them. */
export interface NutriBreakdown {
  /** Drinks are scored on stricter energy and sugar tables. */
  beverage: boolean;
  energy: number;
  sugars: number;
  satFat: number;
  sodium: number;
  fibre: number;
  protein: number;
  /** False once 11 or more points count against a food that isn't mostly fruit or veg. */
  proteinCounted: boolean;
  fruitVeg: number;
}

export interface GradedFood {
  id: string;
  name: string;
  servingLabel: string;
  basis: 'g' | 'ml';
  kcal100: number | null;
  protein100: number | null;
  fiber100: number | null;
  sugar100: number | null;
  satFat100: number | null;
  sodiumMg100: number | null;
  fruitVeg: number | null;
  grade: NutriGrade;
  /** The source states this grade, rather than it being computed here. */
  published: boolean;
  score: number | null;
  breakdown: NutriBreakdown | null;
}

export interface NutriScoreGuide {
  grade: NutriGrade;
  counts: Record<NutriGrade, number>;
  total: number;
  foods: GradedFood[];
}

export interface PicnicStatus {
  /** The server has a Picnic account in its environment. */
  configured: boolean;
  connected: boolean;
  /** Picnic sent an SMS code and is waiting for it. */
  awaitingCode: boolean;
  countryCode: string;
}

/** A product as Picnic's search returns it. Prices are in cents. */
export interface PicnicProduct {
  id: string;
  name: string;
  image_id: string;
  display_price: number;
  unit_quantity: string;
  max_count: number;
}

export interface PicnicProductDetails {
  id: string;
  name: string;
  brand: string | null;
  unitQuantity: string;
  unitPrice: string | null;
  displayPrice: number;
  maxCount: number;
  imageIds: string[];
  description: string | null;
  highlights: string[];
  allergens: string[];
  infoSections: { title: string; content: string }[];
  promotion: { id: string; label: string } | null;
  /** The food this product would add to the database; null when Picnic lists no nutrition. */
  food: (Food & { kcal100: number }) | null;
}

export interface PicnicCartArticle {
  id: string;
  name: string;
  unit_quantity: string;
  price: number;
  image_ids: string[];
  max_count: number;
  /** A QUANTITY decorator carries how many are in the cart; absent means one. */
  decorators: { type: string; quantity?: number }[];
}

export interface PicnicCart {
  id: string;
  items: { id: string; items: PicnicCartArticle[]; display_price: number; price: number }[];
  total_count: number;
  total_price: number;
  checkout_total_price: number;
}

export type FoodSort = 'default' | 'grade' | 'grade-desc';

export type FoodCounts = Record<Food['source'], number>;

export interface ReportData {
  from: string | null;
  to: string | null;
  days: DayTotals[];
  weights: { date: string; weightKg: number }[];
  /** Dates the user marked as finished logging. */
  done?: string[];
}

export interface WeekData {
  from: string;
  to: string;
  days: { date: string; food: number; exercise: number; entries: number }[];
}

/** A planned meal you haven't logged yet, as Today shows it. */
export interface PlannedPortion {
  itemId: string;
  meal: Meal;
  name: string;
  foodId: string;
  servings: number;
  servingLabel: string;
  calories: number;
}

export interface HouseholdMember {
  id: string;
  username: string;
}

export interface PlanItem {
  id: string;
  date: string;
  meal: Meal;
  foodId: string;
  recipeId: string | null;
  name: string;
  servingLabel: string;
  perServing: { calories: number; protein: number | null; carbs: number | null; fat: number | null };
  portions: { userId: string; username: string; servings: number; logged: boolean }[];
}

export interface PlanItemInput {
  date: string;
  meal: Meal;
  foodId?: string;
  recipeId?: string;
  portions: { userId: string; servings: number }[];
}

export interface ShoppingList {
  listKey: string;
  items: {
    key: string;
    name: string;
    /** Total weight, where every use of it could be weighed. */
    grams: number | null;
    /** Amounts that couldn't be weighed, as written: "0.5 tsp". */
    written: string[];
    usedIn: string[];
    checked: boolean;
  }[];
}

/** A Picnic product as a shopping-list line carries it. */
export interface PicnicListProduct {
  productId: string;
  name: string;
  imageId: string | null;
  unitQuantity: string | null;
  price: number | null;
}

export interface PicnicShoppingList extends ShoppingList {
  items: (ShoppingList['items'][number] & {
    /** What the household picked for this line. */
    choice: PicnicListProduct | null;
    /** Picnic's top search result, when nobody has picked yet. */
    suggestion: PicnicListProduct | null;
    /** How many packs cover what the plan needs. */
    packs: number | null;
  })[];
}

export interface PicnicSlot {
  slotId: string;
  windowStart: string;
  windowEnd: string;
  cutOffTime: string;
  isAvailable: boolean;
  isGreenChoice: boolean;
  minimumOrderValue: number | null;
}

export interface PicnicSlots {
  slots: PicnicSlot[];
  selectedSlot: {
    slotId: string;
    windowStart: string | null;
    windowEnd: string | null;
    /** False when Picnic picked it rather than someone here. */
    isExplicitSelection: boolean;
  } | null;
}

export interface PicnicDeliverySummary {
  id: string;
  status: string;
  creationTime: string;
  windowStart: string | null;
  windowEnd: string | null;
  totalPrice: number;
}

export interface PicnicDelivery {
  id: string;
  status: string;
  createdAt: string;
  window: { start: string | null; end: string | null };
  eta: { start: string; end: string } | null;
  delivered: { start: string; end: string } | null;
  position: { eta: number; eta_window: { start: string; end: string } } | null;
  items: { id: string; name: string; unitQuantity: string; imageId: string | null; quantity: number }[];
}

export interface PicnicCheckoutSummary {
  orderId: string;
  /** Cents, deposit included. */
  total: number;
  count: number;
  deposit: number;
  savings: number;
  expiresAt: string | null;
  address: { street?: string; house_number?: number; postcode?: string; city?: string } | null;
  slot: { start: string; end: string } | null;
  minimumOrder: number | null;
}

/** Something in the cart Picnic wants dealt with before checkout. */
export interface PicnicCheckoutIssue {
  title: string;
  message: string;
  blocking: boolean;
  resolveKey: string | null;
}

export interface PicnicCheckoutState {
  orderId: string;
  status: 'STARTED' | 'PAYING' | 'FINISHED' | 'PLACED' | 'CONFIRMED' | 'CANCELLED';
  total: number | null;
  startedAt: string;
  paymentStatus?: string;
  placed: boolean;
}

export interface PicnicPayment {
  id: string;
  status: string;
  transaction_type: string;
  amount_in_cents: number;
  timestamp: number;
  display_name: string;
  account: string | null;
}

/** One line of the assistant conversation as the person sees it. */
export type AssistantEntry =
  | { role: 'user' | 'assistant'; text: string }
  | { role: 'action'; id: string; text: string; status: 'pending' | 'done' | 'skipped' | 'failed'; error?: string };

export interface AssistantState {
  log: AssistantEntry[];
  /** Proposals are waiting on a decision before the assistant carries on. */
  waiting: boolean;
  configured?: boolean;
}

export interface AssistantContext {
  today: string;
  budget: number;
  targets: { protein: number | null; carbs: number | null; fat: number | null };
}

/** A product as it was in a past Picnic order. */
export interface PicnicOrderItem {
  productId: string;
  name: string;
  unitQuantity: string | null;
  imageId: string | null;
  quantity: number;
}

export interface PicnicPastOrder {
  id: string;
  status: string;
  windowStart: string;
  totalPrice: number;
  items: PicnicOrderItem[];
}

export interface PicnicUsual extends PicnicOrderItem {
  /** How many of the recent orders it was in, out of how many. */
  orders: number;
  ofOrders: number;
  lastOrdered: string;
  /** Typical days between orders of it; null when bought only once. */
  everyDays: number | null;
  due: boolean;
}

export interface DayData {
  entries: JoinedEntry[];
  /** Your portions from the household plan for this day, not yet logged. */
  planned?: PlannedPortion[];
  exercises: ExerciseEntry[];
  latestWeightKg?: number;
  yesterdayMealCounts: Partial<Record<Meal, number>>;
  /** The user has declared logging finished for this day. */
  done: boolean;
  /** Nutri-Score and processing per meal, where enough was known to work it out. */
  meals?: Partial<
    Record<
      Meal,
      {
        grade?: string | null;
        covered?: number;
        processing?: { worst: number; ultraShare: number } | null;
      }
    >
  >;
}

export interface MealTemplateItem {
  id: string;
  foodId: string | null;
  servings: number;
  caloriesCached: number;
  label?: string;
  /** Grams for the whole item, as on a quick add with no food behind it. */
  proteinCached?: number | null;
  carbsCached?: number | null;
  fatCached?: number | null;
  food?: Food;
}

export interface MealTemplate {
  id: string;
  name: string;
  createdAt: string;
  items: MealTemplateItem[];
}

export interface RecipeIngredient {
  id?: string;
  raw: string;
  name?: string | null;
  quantity?: number | null;
  unit?: string | null;
  grams: number | null;
  weighedBy?: string | null;
  reason?: string | null;
  foodId?: string | null;
  food?: { id: string; name: string; brand: string | null; source: string; kcal100: number | null } | null;
  calories?: number | null;
  nutrition?: { calories: number; protein: number | null; carbs: number | null; fat: number | null } | null;
}

export interface RecipeIngredientInput {
  raw: string;
  /** AI-normalized lookup name; kept only while this exact raw line is unchanged. */
  matchName?: string | null;
  /** A server-selected match that should survive repricing and saving. */
  foodId?: string | null;
}

export interface RecipeInput {
  name: string;
  servings: number;
  servingsStated?: boolean;
  ingredients: RecipeIngredientInput[];
  instructions?: string | null;
  notes?: string | null;
  sourceType?: 'url' | 'photo' | 'manual';
  sourceUrl?: string | null;
}

/** What a read recipe looks like before it is saved. */
export interface RecipeDraft {
  name?: string;
  servings: number;
  servingsStated?: boolean;
  servingsReasoning?: string | null;
  ingredients: RecipeIngredient[];
  instructions?: string | null;
  notes?: string | null;
  sourceType?: 'url' | 'photo' | 'manual';
  sourceUrl?: string | null;
  /** Nutrition declared by the recipe publisher, used only as a sanity check. */
  sourceNutrition?: {
    calories: number | null;
    protein: number | null;
    carbs: number | null;
    fat: number | null;
  } | null;
  /** Whether AI could verify that a photographed source contained the whole recipe. */
  sourceComplete?: boolean;
  sourceWarnings?: string[];
  /** 'page' when AI was unavailable and the site's own recipe data was used. */
  readBy?: 'page' | 'model';
  total: { grams: number | null; calories: number | null };
  perServing: { grams: number | null; calories: number | null; protein: number | null; carbs: number | null; fat: number | null };
  unresolved: string[];
  unmatched?: string[];
  unweighable?: string[];
  amountMissing?: string[];
  complete?: boolean;
  approximate: string[];
}

export interface Recipe {
  id: string;
  name: string;
  servings: number;
  servingsStated: boolean;
  sourceType: string | null;
  sourceUrl: string | null;
  instructions: string | null;
  notes: string | null;
  author: string | null;
  createdBy: string;
  ingredients: RecipeIngredient[];
  food: Food | null;
  total: { grams: number; calories: number };
  perServing: { calories: number | null; grams: number | null };
}

/** Counts over some set of model calls — a window, a task, or a model. */
export interface UsageTally {
  calls: number;
  ok: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated, from the token counts and this server's rate table. */
  costUsd: number;
  /** Calls on a model this server has no rate for, so excluded from the cost. */
  unpricedCalls: number;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
}

export interface UsageWindow extends UsageTally {
  label: string;
  /** First day counted, or null for all time. */
  from: string | null;
}

export interface VisionCall {
  id: string;
  createdAt: string;
  task: string;
  model: string;
  status: string;
  errorCode: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

export interface VisionUsage {
  provider: string;
  model: string;
  configured: boolean;
  dailyLimit: number;
  usedToday: number;
  remainingToday: number;
  /** US dollars per million tokens, by model. */
  prices: Record<string, { input: number; output: number }>;
  windows: Record<'today' | 'week' | 'month' | 'all', UsageWindow>;
  /** How many days the task and error breakdowns cover. */
  breakdownDays: number;
  byTask: (UsageTally & { task: string })[];
  byError: { code: string; calls: number }[];
  byModel: (UsageTally & { model: string; priced: boolean })[];
  recent: VisionCall[];
}

/** The one that's running, if any, and the ones that have finished. */
export interface FastsData {
  current: Fast | null;
  recent: Fast[];
}

export interface ProgressPhoto {
  id: string;
  date: string;
  createdAt: string;
}

/** Fires when the server says we're not signed in, so the app can react once. */
export const UNAUTHORIZED_EVENT = 'bendit:unauthorized';

/**
 * Writes that can be replayed safely: the client supplies an idempotency key
 * and the server treats a repeat as the same operation, so a lost reply costs
 * nothing.
 */
async function queueableWrite(
  path: string,
  body: unknown,
  {
    id,
    date,
    method = 'POST',
  }: { id: string; date?: string; method?: 'POST' | 'PUT' },
): Promise<unknown> {
  const park = async () => {
    const { useQueue } = await import('./offlineQueue');
    useQueue.getState().enqueue({
      id,
      path,
      ...(method === 'POST' ? {} : { method }),
      body,
      date,
      queuedAt: Date.now(),
    });
  };

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // Nothing reached the server: park it and let the app carry on.
    await park();
    return body;
  }

  // Everything below here is the server answering, which is a different thing
  // from not reaching it. Catching both together is what made a refused write
  // look like a saved one: it was queued, the caller was told it succeeded, and
  // the next flush dropped it on the floor for being a refusal — so it appeared
  // in the log, survived until the next sync, and then quietly wasn't there.
  if (res.status === 401) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    // Worth keeping: signing back in replays it, which is why the queue holds
    // on to a 401 rather than discarding it.
    await park();
    throw new Error('Not signed in.');
  }

  if (res.ok) {
    // A success with an unreadable body is still a success. The row is on the
    // server; re-sending it would be the only way to get it wrong.
    return res.json().catch(() => body);
  }

  if (res.status >= 500) {
    await park();
    return body;
  }

  const problem = await res.json().catch(() => null);
  throw new Error(problem?.error ?? `${res.status} ${res.statusText}`);
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (res.status === 401) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new Error('Not signed in.');
  }
  if (!res.ok) {
    // Server errors carry a human-readable message; fall back to the status.
    const body = await res.json().catch(() => null);
    const problem = body?.error;
    if (problem && typeof problem === 'object') {
      throw new ApiError(
        typeof problem.message === 'string'
          ? problem.message
          : `${res.status} ${res.statusText}`,
        {
          code: typeof problem.code === 'string' ? problem.code : null,
          status: res.status,
          retryAfterSeconds:
            typeof problem.retryAfterSeconds === 'number' ? problem.retryAfterSeconds : null,
          details: problem.details && typeof problem.details === 'object' ? problem.details : null,
        },
      );
    }
    throw new ApiError(
      typeof problem === 'string' ? problem : `${res.status} ${res.statusText}`,
      { status: res.status },
    );
  }
  return res.json() as Promise<T>;
}

const post = (path: string, body: unknown, method = 'POST') =>
  j<unknown>(path, { method, body: JSON.stringify(body) });

// The server allows a long recipe read and one complete provider retry. Keep a
// slightly larger browser deadline so a suspended connection cannot spin
// forever, without cutting off a response the server is still producing.
const RECIPE_PHOTO_DEADLINE_MS = 75_000;

async function recipeFromPhoto(image: string): Promise<RecipeDraft> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECIPE_PHOTO_DEADLINE_MS);
  try {
    return await j<RecipeDraft>('/api/recipes/from-photo', {
      method: 'POST',
      body: JSON.stringify({ image, mimeType: 'image/jpeg' }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new ApiError('AI took too long to read that photo.', { code: 'timeout', status: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  session: () =>
    j<{ authed: boolean; configured: boolean; username: string | null }>('/api/session'),
  login: async (username: string, password: string) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? 'Could not sign in.');
    return body as { ok: true; username: string };
  },
  logout: () => post('/api/logout', {}),
  changePassword: (currentPassword: string, newPassword: string) =>
    post('/api/password', { currentPassword, newPassword }),

  getProfile: () => j<Profile | null>('/api/profile'),
  putProfile: (p: Profile) => post('/api/profile', p, 'PUT'),

  getDay: (date: string, yesterday: string) =>
    j<DayData>(`/api/day?date=${date}&yesterday=${yesterday}`),

  searchFoods: (q: string) => j<Food[]>(`/api/foods?q=${encodeURIComponent(q)}`),
  customFoods: () => j<Food[]>('/api/foods?source=custom'),
  foodByBarcode: (code: string) => j<Food | null>(`/api/foods/barcode/${encodeURIComponent(code)}`),
  saveFoods: (foods: Food | Food[]) => post('/api/foods', foods),
  recentFoods: () => j<Food[]>('/api/recents'),
  browseFoods: (
    q: string,
    { sources = [], grades = [], sort = 'default' }: { sources?: Food['source'][]; grades?: NutriGrade[]; sort?: FoodSort } = {},
  ) => {
    const params = new URLSearchParams({ q });
    if (sources.length) params.set('source', sources.join(','));
    if (grades.length) params.set('grades', grades.join(','));
    if (sort !== 'default') params.set('sort', sort);
    return j<BrowsedFood[]>(`/api/foods/browse?${params}`);
  },
  nutriScoreGuide: (grade: NutriGrade, q: string) =>
    j<NutriScoreGuide>(`/api/nutri-score?${new URLSearchParams({ grade, q })}`),
  assistant: () => j<AssistantState>('/api/assistant'),
  assistantSend: (text: string, context: AssistantContext) =>
    post('/api/assistant/messages', { text, context }) as Promise<AssistantState>,
  assistantDecide: (decisions: Record<string, 'approve' | 'skip'>) =>
    post('/api/assistant/decisions', { decisions }) as Promise<AssistantState>,
  assistantReset: () => j<AssistantState>('/api/assistant', { method: 'DELETE' }),
  household: () => j<HouseholdMember[]>('/api/household'),
  mealPlan: (from: string, to: string) => j<PlanItem[]>(`/api/meal-plan?${new URLSearchParams({ from, to })}`),
  addPlanItem: (item: PlanItemInput) => post('/api/meal-plan', item) as Promise<PlanItem>,
  updatePlanItem: (id: string, changes: Partial<Pick<PlanItemInput, 'date' | 'meal' | 'portions'>>) =>
    post(`/api/meal-plan/${encodeURIComponent(id)}`, changes, 'PATCH') as Promise<PlanItem>,
  deletePlanItem: (id: string) => j<unknown>(`/api/meal-plan/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  logPlanItem: (id: string) => post(`/api/meal-plan/${encodeURIComponent(id)}/log`, {}),
  shoppingList: (from: string, to: string) =>
    j<ShoppingList>(`/api/shopping-list?${new URLSearchParams({ from, to })}`),
  setShoppingCheck: (listKey: string, itemKey: string, checked: boolean) =>
    post('/api/shopping-list/checks', { listKey, itemKey, checked }, 'PUT'),
  picnicShoppingList: (from: string, to: string) =>
    j<PicnicShoppingList>(`/api/shopping-list/picnic?${new URLSearchParams({ from, to })}`),
  picnicChoose: (itemKey: string, product: PicnicProduct) =>
    post('/api/picnic/choices', { itemKey, product }, 'PUT'),
  picnicForget: (itemKey: string) =>
    j<unknown>(`/api/picnic/choices/${encodeURIComponent(itemKey)}`, { method: 'DELETE' }),
  picnicAddList: (from: string, to: string) =>
    post('/api/shopping-list/picnic/cart', { from, to }) as Promise<{ added: number; cart: PicnicCart }>,
  picnicSlots: () => j<PicnicSlots>('/api/picnic/slots'),
  picnicSetSlot: (slotId: string) => post('/api/picnic/slot', { slotId }, 'PUT') as Promise<PicnicCart>,
  picnicNewOrder: (refresh = false) =>
    j<{ orders: PicnicPastOrder[]; usuals: PicnicUsual[] }>(`/api/picnic/new-order${refresh ? '?refresh=1' : ''}`),
  picnicAddBulk: (items: { productId: string; quantity: number }[]) =>
    post('/api/picnic/cart/bulk', { items }) as Promise<PicnicCart>,
  picnicStartCheckout: (resolveKey?: string) =>
    post('/api/picnic/checkout', resolveKey ? { resolveKey } : {}) as Promise<PicnicCheckoutSummary>,
  picnicPay: (orderId: string) =>
    post(`/api/picnic/checkout/${encodeURIComponent(orderId)}/pay`, { origin: window.location.origin }) as Promise<{
      transactionId: string;
      redirectUrl: string | null;
    }>,
  picnicCheckoutState: (orderId: string) =>
    j<PicnicCheckoutState>(`/api/picnic/checkout/${encodeURIComponent(orderId)}`),
  picnicCancelPayment: (orderId: string) =>
    post(`/api/picnic/checkout/${encodeURIComponent(orderId)}/cancel`, {}) as Promise<PicnicCheckoutState>,
  picnicConfirmOrder: (orderId: string) =>
    post(`/api/picnic/checkout/${encodeURIComponent(orderId)}/confirm`, {}) as Promise<PicnicCheckoutState>,
  picnicWallet: (page = 1) => j<PicnicPayment[]>(`/api/picnic/wallet?page=${page}`),
  picnicWalletDetail: (id: string) =>
    j<{ deliveryId: string | null; lines: { name: string; quantity: number; price: number | null }[] }>(
      `/api/picnic/wallet/${encodeURIComponent(id)}`,
    ),
  picnicRate: (id: string, rating: number) =>
    post(`/api/picnic/deliveries/${encodeURIComponent(id)}/rating`, { rating }, 'PUT'),
  picnicCancelDelivery: (id: string) => post(`/api/picnic/deliveries/${encodeURIComponent(id)}/cancel`, {}),
  picnicEmailInvoice: (id: string) => post(`/api/picnic/deliveries/${encodeURIComponent(id)}/invoice`, {}),
  picnicDeliveries: () => j<PicnicDeliverySummary[]>('/api/picnic/deliveries'),
  picnicDelivery: (id: string) => j<PicnicDelivery>(`/api/picnic/deliveries/${encodeURIComponent(id)}`),
  picnicStatus: () => j<PicnicStatus>('/api/picnic/status'),
  picnicConnect: () => post('/api/picnic/connect', {}) as Promise<PicnicStatus>,
  picnicVerify: (code: string) => post('/api/picnic/verify', { code }) as Promise<PicnicStatus>,
  picnicDisconnect: () => post('/api/picnic/disconnect', {}) as Promise<PicnicStatus>,
  picnicSearch: (q: string) => j<PicnicProduct[]>(`/api/picnic/search?${new URLSearchParams({ q })}`),
  picnicProduct: (id: string, name: string) =>
    j<PicnicProductDetails>(`/api/picnic/products/${encodeURIComponent(id)}?${new URLSearchParams({ name })}`),
  picnicSaveFood: (id: string, name: string) =>
    post(`/api/picnic/products/${encodeURIComponent(id)}/food`, { name }) as Promise<Food>,
  picnicCart: () => j<PicnicCart>('/api/picnic/cart'),
  picnicAddToCart: (productId: string, count = 1) =>
    post('/api/picnic/cart', { productId, count }) as Promise<PicnicCart>,
  picnicRemoveFromCart: (productId: string, count = 1) =>
    j<PicnicCart>(`/api/picnic/cart/${encodeURIComponent(productId)}?count=${count}`, { method: 'DELETE' }),
  picnicClearCart: () => j<PicnicCart>('/api/picnic/cart', { method: 'DELETE' }),
  foodCounts: () => j<FoodCounts>('/api/foods/counts'),
  deleteFood: (id: string) => j<unknown>(`/api/foods/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  addLogEntry: (e: Omit<FoodLogEntry, 'id'> & { id?: string }) =>
    (() => {
      const body = { ...e, id: e.id ?? crypto.randomUUID() };
      return queueableWrite('/api/food-log', body, { id: body.id, date: body.date });
    })(),
  deleteLogEntry: (id: string) => j<unknown>(`/api/food-log/${id}`, { method: 'DELETE' }),

  updateLogEntry: (
    id: string,
    changes: Partial<
      Pick<
        FoodLogEntry,
        | 'meal'
        | 'servings'
        | 'caloriesCached'
        | 'label'
        | 'proteinCached'
        | 'carbsCached'
        | 'fatCached'
      >
    >,
  ) => post(`/api/food-log/${id}`, changes, 'PATCH'),

  recipes: () => j<Recipe[]>('/api/recipes'),
  recipe: (id: string) => j<Recipe>(`/api/recipes/${id}`),
  recipeFromUrl: (url: string) => post('/api/recipes/from-url', { url }) as Promise<RecipeDraft>,
  recipeFromPhoto,
  priceRecipe: (ingredients: RecipeIngredientInput[], servings: number) =>
    post('/api/recipes/price', { ingredients, servings }) as Promise<RecipeDraft>,
  saveRecipe: (recipe: RecipeInput, id?: string) =>
    (id ? post(`/api/recipes/${id}`, recipe, 'PUT') : post('/api/recipes', recipe)) as Promise<Recipe>,
  deleteRecipe: (id: string) => j<unknown>(`/api/recipes/${id}`, { method: 'DELETE' }),

  mealTemplates: () => j<MealTemplate[]>('/api/meal-templates'),
  createMealTemplate: (name: string, items: Omit<MealTemplateItem, 'id' | 'food'>[]) =>
    post('/api/meal-templates', { name, items }) as Promise<unknown>,
  saveMealAsTemplate: (name: string, date: string, meal: Meal) =>
    post('/api/meal-templates/from-day', { name, date, meal }),
  logMealTemplate: (id: string, date: string, meal: Meal) =>
    post(`/api/meal-templates/${id}/log`, { date, meal }),
  mealTemplateAsFood: (id: string, name: string, servings: number) =>
    post(`/api/meal-templates/${id}/as-food`, { name, servings }) as Promise<Food>,
  deleteMealTemplate: (id: string) => j<unknown>(`/api/meal-templates/${id}`, { method: 'DELETE' }),

  listMeasurements: () => j<Measurement[]>('/api/measurements'),
  putMeasurement: (m: { date: string; site: MeasurementSite; valueCm: number }) =>
    post('/api/measurements', m, 'PUT'),
  deleteMeasurement: (id: string) => j<unknown>(`/api/measurements/${id}`, { method: 'DELETE' }),

  recentQuickAdds: () =>
    j<QuickAddSuggestion[]>('/api/recent-quick-adds'),

  addExercise: (e: Omit<ExerciseEntry, 'id'> & { id?: string }) =>
    (() => {
      const body = { ...e, id: e.id ?? crypto.randomUUID() };
      return queueableWrite('/api/exercise', body, { id: body.id, date: body.date });
    })(),
  updateExercise: (
    id: string,
    changes: Partial<Pick<ExerciseEntry, 'name' | 'minutes' | 'caloriesBurned'>>,
  ) => post(`/api/exercise/${id}`, changes, 'PATCH'),
  deleteExercise: (id: string) => j<unknown>(`/api/exercise/${id}`, { method: 'DELETE' }),

  getReport: (from?: string) =>
    j<ReportData>(`/api/report${from ? `?from=${from}` : ''}`),

  getWeek: (date: string) => j<WeekData>(`/api/week?date=${date}`),

  getWeights: () => j<WeightEntry[]>('/api/weights'),
  putWeight: (w: { date: string; weightKg: number }) => post('/api/weights', w, 'PUT'),
  deleteWeight: (id: string) => j<unknown>(`/api/weights/${id}`, { method: 'DELETE' }),

  setDayDone: (date: string, done: boolean) => post('/api/day-done', { date, done }, 'PUT'),

  fasts: () => j<FastsData>('/api/fasts'),
  startFast: (fast: { startedAt?: string; endedAt?: string | null; goalHours?: number | null }) =>
    post('/api/fasts', fast) as Promise<Fast>,
  updateFast: (id: string, changes: Partial<Pick<Fast, 'startedAt' | 'endedAt' | 'goalHours'>>) =>
    post(`/api/fasts/${id}`, changes, 'PATCH') as Promise<Fast>,
  deleteFast: (id: string) => j<unknown>(`/api/fasts/${id}`, { method: 'DELETE' }),

  pushConfig: () =>
    j<{ enabled: boolean; publicKey: string | null; subscriptions: number }>('/api/push/config'),
  pushSubscribe: (subscription: unknown) => post('/api/push/subscribe', subscription),
  pushUnsubscribe: (endpoint: string) => post('/api/push/unsubscribe', { endpoint }),
  pushTest: () => post('/api/push/test', {}),

  visionUsage: () => j<VisionUsage>('/api/vision/usage'),
  putMealEstimateFeedback: (estimateId: string, feedback: MealFeedback) =>
    queueableWrite(
      `/api/meals/estimate/${encodeURIComponent(estimateId)}/feedback`,
      feedback,
      { id: `meal-feedback:${estimateId}`, method: 'PUT' },
    ),

  listPhotos: () => j<ProgressPhoto[]>('/api/photos'),
  uploadPhoto: async (date: string, image: Blob) => {
    const res = await fetch(`/api/photos?date=${date}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: image,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json() as Promise<ProgressPhoto>;
  },
  photoUrl: (id: string) => `/api/photos/${encodeURIComponent(id)}/image`,
  setPhotoDate: (id: string, date: string) =>
    post(`/api/photos/${encodeURIComponent(id)}`, { date }, 'PATCH'),
  deletePhoto: (id: string) => j<unknown>(`/api/photos/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  resetAll: () => j<unknown>('/api/all', { method: 'DELETE' }),
};
