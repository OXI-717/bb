import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { Button } from "@bb/shared-ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@bb/shared-ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bb/shared-ui/dropdown-menu";
import { Icon } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import { ResourceRowDetailChevron } from "@bb/shared-ui/resource-list";
import { Switch } from "@bb/shared-ui/switch";
import type {
  AccountSummary,
  AccountPoolConfig,
  AccountPoolConfigSetInput,
  FamilyQuota,
  LimitWindow,
  ModelFamily,
  PoolProvider,
  PoolStatus,
} from "./src/contracts.js";
import type { accountPoolRpcContract } from "./src/rpc.js";
import type { OAuthLoginStart } from "./src/oauth-login.js";
import type { CodexDeviceLoginStart } from "./src/codex-device-login.js";
import {
  DEFAULT_ACCOUNT_POOL_CONFIG,
  modelFamilySchema,
  statusSchema,
} from "./src/contracts.js";
import { blockingResetAt } from "./src/quota.js";
import { DEFAULT_RESERVE_CAP } from "./src/balancer.js";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_CONFIG_CHANGED,
} from "./src/realtime.js";

type DialogState =
  | {
      kind: "account" | "priority" | "role" | "cap" | "remove";
      accountId: string;
    }
  | { kind: "claude-login" | "codex-login" | "api-key" }
  | null;

type ConfigField = Exclude<
  keyof AccountPoolConfig,
  "routingStrategy" | "reserveDrainHours" | "restDays"
>;

const PROVIDERS: Array<{
  id: PoolProvider;
  title: string;
  description: string;
}> = [
  {
    id: "claude",
    title: "Claude",
    description: "Треды Claude Code на всех машинах идут через эти аккаунты.",
  },
  {
    id: "codex",
    title: "Codex",
    description: "Треды Codex идут через эти аккаунты ChatGPT.",
  },
  {
    id: "kimi",
    title: "Kimi For Coding",
    description:
      "Треды opencode с подпиской Kimi идут через эти ключи: на машине остаётся только токен хаба.",
  },
  {
    id: "zai",
    title: "Z.ai Coding Plan",
    description:
      "Треды opencode с подпиской z.ai идут через эти ключи: на машине остаётся только токен хаба.",
  },
  {
    id: "opencode-go",
    title: "OpenCode Go",
    description:
      "Треды opencode с подпиской Go идут через эти ключи: на машине остаётся только токен хаба.",
  },
  {
    id: "cursor",
    title: "Cursor",
    description:
      "Треды Cursor идут через этот ключ: машина получает токен хаба вместо ключа подписки.",
  },
];
const FAMILY_LABELS: Record<ModelFamily, string> = {
  fable: "Fable, неделя",
  sonnet: "Sonnet, неделя",
  opus: "Opus, неделя",
  haiku: "Haiku, неделя",
  other: "Прочие, неделя",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpUrlError(value: string): string | null {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:"
      ? null
      : "Нужен адрес http или https.";
  } catch {
    return "Нужен корректный адрес.";
  }
}

function configDrafts(config: AccountPoolConfig): Record<ConfigField, string> {
  return {
    anthropicUpstreamBaseUrl: config.anthropicUpstreamBaseUrl,
    codexUpstreamBaseUrl: config.codexUpstreamBaseUrl,
    kimiUpstreamBaseUrl: config.kimiUpstreamBaseUrl,
    zaiUpstreamBaseUrl: config.zaiUpstreamBaseUrl,
    opencodeGoUpstreamBaseUrl: config.opencodeGoUpstreamBaseUrl,
    cursorUpstreamBaseUrl: config.cursorUpstreamBaseUrl,
    switchThreshold: String(config.switchThreshold),
  };
}
function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}
const WEEKDAY_LABELS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

function daysOffSummary(restDays: readonly number[]): string {
  if (restDays.length === 0) return "Все дни идут в счёт до сброса.";
  const names = [...restDays]
    .sort((left, right) => left - right)
    .map((day) => WEEKDAY_LABELS[day] ?? String(day));
  return `${names.join(", ")} не идут в счёт до сброса.`;
}

const POOL_TIME_ZONE = "Europe/Moscow";

function moment(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: POOL_TIME_ZONE,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("day")}.${part("month")} ${part("hour")}:${part("minute")} (${part("weekday")})`;
}

function accountFullName(account: AccountSummary): string {
  return account.email ?? account.label;
}
function relative(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} ч назад` : `${Math.round(hours / 24)} дн назад`;
}
function windowShortLabel(
  window: LimitWindow,
  provider: PoolProvider = "codex",
): string {
  if (window.windowMinutes === null) {
    if (provider === "codex") return window.slot === "primary" ? "5Ч" : "7Д";
    return window.slot === "primary" ? "ЛИМИТ" : "ЛИМИТ 2";
  }
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440}Д`;
  if (window.windowMinutes % 60 === 0) return `${window.windowMinutes / 60}Ч`;
  return `${window.windowMinutes}М`;
}
function windowLongLabel(
  window: LimitWindow,
  provider: PoolProvider = "codex",
): string {
  if (window.windowMinutes === null) {
    if (provider === "codex")
      return window.slot === "primary" ? "5 часов" : "Неделя";
    return window.slot === "primary" ? "Лимит" : "Второй лимит";
  }
  if (window.windowMinutes === 7 * 24 * 60) return "Неделя";
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440} дн`;
  if (window.windowMinutes % 60 === 0) return `${window.windowMinutes / 60} ч`;
  return `${window.windowMinutes} мин`;
}
function resetLabel(timestamp: number | null): string {
  if (timestamp === null) return "";
  const minutes = Math.max(1, Math.round((timestamp - Date.now()) / 60_000));
  if (minutes < 1_440)
    return `сброс через ${minutes >= 60 ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин` : `${minutes} мин`}`;
  return `сброс ${new Intl.DateTimeFormat("ru-RU", { month: "short", day: "numeric", timeZone: POOL_TIME_ZONE }).format(timestamp)}`;
}
const STATUS_CACHE_KEY = "account-pool:status";

function readCachedStatus(): PoolStatus | null {
  try {
    const raw = window.localStorage.getItem(STATUS_CACHE_KEY);
    if (raw === null) return null;
    const parsed = statusSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeCachedStatus(status: PoolStatus): void {
  try {
    window.localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify(status));
  } catch {
    return;
  }
}

function weeklyResetAt(account: AccountSummary): number | null {
  if (account.provider === "claude") return account.sevenDayResetAt;
  return longestCodexWindow(account)?.resetAt ?? null;
}

function longestCodexWindow(account: AccountSummary): LimitWindow | null {
  let longest: LimitWindow | null = null;
  for (const window of account.limitWindows) {
    if (
      longest === null ||
      (window.windowMinutes ?? 0) > (longest.windowMinutes ?? 0)
    )
      longest = window;
  }
  return longest;
}

function statusPresentation(
  account: AccountSummary,
  threshold: number,
): {
  label: string;
  dot: string;
} {
  if (account.status === "ready" && account.capReached) {
    const resetAt = weeklyResetAt(account);
    return {
      label: `Потолок${resetAt === null ? "" : ` · ${resetLabel(resetAt)}`}`,
      dot: "bg-warning",
    };
  }
  if (account.status === "ready" && !account.eligible)
    return {
      label:
        account.role === "reserve" ? "Резерв · в запасе" : "Сейчас не выбран",
      dot: "bg-muted-foreground",
    };
  if (account.status === "held")
    return {
      label: `Пауза${account.heldUntil === null ? "" : ` · повтор в ${new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: POOL_TIME_ZONE }).format(account.heldUntil)}`}`,
      dot: "bg-warning",
    };
  if (account.status === "exhausted") {
    const resetAt = blockingResetAt(account, null, threshold, Date.now());
    return {
      label: `Исчерпан${resetAt === null ? "" : ` · ${resetLabel(resetAt)}`}`,
      dot: "bg-destructive",
    };
  }
  if (account.status === "error")
    return { label: "Ошибка", dot: "bg-destructive" };
  if (account.status === "disabled")
    return { label: "Выключен", dot: "bg-muted-foreground" };
  return { label: "В работе", dot: "bg-success" };
}
function tier(account: AccountSummary): string {
  return (
    account.subscriptionType ??
    (account.kind === "api-key" ? "API-ключ" : "OAuth")
  );
}
function secondaryEmail(account: AccountSummary): string | null {
  return account.email === null || account.email === account.label
    ? null
    : account.email;
}
function SettingsBadge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-2xs leading-none text-subtle-foreground">
      {children}
    </span>
  );
}

function SettingsSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
            {description}
          </p>
        </div>
        <div className="shrink-0 self-start">{action}</div>
      </div>
      <div className="border-t border-border">{children}</div>
    </section>
  );
}

type QuotaSlot = {
  key: string;
  label: string;
  utilization: number | null;
  status: string | null;
  limit: number;
};

function quotaSlots(account: AccountSummary, threshold: number): QuotaSlot[] {
  const weeklyLimit = Math.min(threshold, account.capLimit ?? threshold);
  if (account.provider === "codex") {
    if (account.limitWindows.length === 0)
      return [
        {
          key: "primary",
          label: "5Ч",
          utilization: null,
          status: null,
          limit: threshold,
        },
      ];
    return account.limitWindows.map((window) => ({
      key: window.slot,
      label: windowShortLabel(window, account.provider),
      utilization: window.utilization,
      status: window.status,
      limit:
        (window.windowMinutes ?? (window.slot === "primary" ? 300 : 10_080)) >=
        1_440
          ? weeklyLimit
          : threshold,
    }));
  }
  return [
    {
      key: "five-hour",
      label: "5Ч",
      utilization: account.fiveHourUtilization,
      status: account.fiveHourStatus,
      limit: threshold,
    },
    {
      key: "seven-day",
      label: "7Д",
      utilization: account.sevenDayUtilization,
      status: account.sevenDayStatus,
      limit: weeklyLimit,
    },
    {
      key: "fable",
      label: "FABLE",
      utilization: account.familyWeekly.fable?.utilization ?? null,
      status: account.familyWeekly.fable?.status ?? null,
      limit: weeklyLimit,
    },
  ];
}

function quotaToneClass(slot: QuotaSlot): string {
  if (
    slot.status?.toLowerCase() === "rejected" ||
    (slot.utilization !== null && slot.utilization >= slot.limit)
  )
    return "text-destructive-text";
  if (slot.utilization !== null && slot.utilization >= slot.limit - 0.1)
    return "text-warning-text";
  return slot.utilization === null
    ? "text-subtle-foreground/75"
    : "text-foreground";
}

function QuotaValue({
  slot,
  threshold,
  refreshing,
}: {
  slot: QuotaSlot;
  threshold: number;
  refreshing: boolean;
}) {
  return (
    <div
      className={cn(
        "w-16 text-left tabular-nums transition-opacity sm:text-right",
        refreshing && "opacity-50",
      )}
    >
      <div className="text-2xs uppercase tracking-wide text-subtle-foreground/75">
        {slot.label}
      </div>
      <div className={cn("text-xs font-semibold", quotaToneClass(slot))}>
        {percent(slot.utilization)}
      </div>
    </div>
  );
}

const restrictAccountDragToVerticalAxis: Modifier = ({ transform }) => ({
  ...transform,
  x: 0,
});
const accountDragModifiers: Modifier[] = [restrictAccountDragToVerticalAxis];

type AccountAction =
  | "toggle"
  | "priority"
  | "role"
  | "cap"
  | "refresh"
  | "remove";

function capText(account: AccountSummary): string | null {
  if (account.capLimit === null) return null;
  const curve =
    account.cap ?? (account.role === "reserve" ? DEFAULT_RESERVE_CAP : null);
  return curve === null
    ? `потолок сейчас ${percent(account.capLimit)}`
    : `потолок сейчас ${percent(account.capLimit)} (${percent(curve.early)}→${percent(curve.late)})`;
}

function AccountRow({
  account,
  threshold,
  current,
  pending,
  refreshing,
  onAction,
  onOpen,
  reorderDisabled,
}: {
  account: AccountSummary;
  threshold: number;
  current: boolean;
  pending: boolean;
  refreshing: boolean;
  onAction: (action: AccountAction) => void;
  onOpen: () => void;
  reorderDisabled: boolean;
}) {
  const cap = capText(account);
  const status = statusPresentation(account, threshold);
  const slots = quotaSlots(account, threshold);
  const email = secondaryEmail(account);
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: account.id, disabled: pending || reorderDisabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-3 text-sm",
        isDragging && "relative z-10 rounded-md bg-card opacity-90 shadow-lift",
      )}
    >
      <Button
        ref={setActivatorNodeRef}
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 touch-none text-muted-foreground enabled:cursor-grab enabled:active:cursor-grabbing"
        disabled={pending || reorderDisabled}
        aria-label={`Переместить ${account.label}`}
        {...attributes}
        {...listeners}
      >
        <Icon name="DragDropVertical" aria-hidden="true" />
      </Button>
      <div
        className={cn(
          "group -mx-2 flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2.5 transition-colors hover:bg-state-hover focus-within:bg-state-hover",
          !account.enabled && "opacity-55",
        )}
      >
        <button
          type="button"
          className="grid min-w-0 flex-1 grid-cols-1 items-center gap-y-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-y-0"
          aria-label={`Открыть ${account.label}`}
          onClick={onOpen}
        >
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">
                {account.label}
              </span>
              {email === null ? null : (
                <span className="min-w-0 truncate text-xs text-subtle-foreground/75">
                  {email}
                </span>
              )}
              <SettingsBadge>{tier(account)}</SettingsBadge>
              {account.role === "reserve" ? (
                <SettingsBadge>Резерв</SettingsBadge>
              ) : null}
              {current ? <SettingsBadge>Текущий</SettingsBadge> : null}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground/75">
              <span className="inline-flex shrink-0 items-center gap-1.5">
                <span className={cn("size-1.5 rounded-full", status.dot)} />
                {status.label}
              </span>
              {account.lastUsedAt === null ? null : (
                <span>использован {relative(account.lastUsedAt)}</span>
              )}
              {cap === null ? null : <span>{cap}</span>}
              {refreshing ? <span>обновляю квоты…</span> : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:flex-nowrap sm:gap-1">
            {slots.map((slot) => (
              <QuotaValue
                key={slot.key}
                slot={slot}
                threshold={threshold}
                refreshing={refreshing}
              />
            ))}
          </div>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 data-[state=open]:bg-state-active"
              aria-label={`Действия: ${account.label}`}
            >
              <Icon name="MoreHorizontal" className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("toggle")}
            >
              <Icon name={account.enabled ? "Circle" : "CircleCheck"} />
              {account.enabled ? "Выключить" : "Включить"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("priority")}
            >
              <Icon name="ListView" />
              Задать приоритет…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("role")}
            >
              <Icon name="ListView" />
              Задать роль…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("cap")}
            >
              <Icon name="ListView" />
              Задать недельный потолок…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("refresh")}
            >
              <Icon name="RotateCcw" />
              Обновить квоты
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={pending}
              onSelect={() => onAction("remove")}
            >
              <Icon name="Trash2" />
              Удалить
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label={`Открыть карточку: ${account.label}`}
          onClick={onOpen}
        >
          <ResourceRowDetailChevron />
        </button>
      </div>
    </div>
  );
}

function AddAccountMenu({
  provider,
  onChoose,
}: {
  provider: PoolProvider;
  onChoose: (choice: "login" | "import" | "api-key") => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Icon name="Plus" className="size-3.5" />
          Добавить аккаунт
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem
          className="items-start py-2"
          onSelect={() => onChoose("login")}
        >
          <Icon name="UserRound" className="mt-0.5" />
          <span>
            <span className="block">
              Вход в {provider === "claude" ? "Claude" : "Codex"}
            </span>
            <span className="block text-xs text-muted-foreground">
              {provider === "claude"
                ? "Откроет claude.ai, код вставите обратно"
                : "Откроет ChatGPT с кодом устройства"}
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="items-start py-2"
          onSelect={() => onChoose("import")}
        >
          <Icon name="Download" className="mt-0.5" />
          <span>
            <span className="block">Импорт с этой машины</span>
            <span className="block text-xs text-muted-foreground">
              Скопирует вход {provider === "claude" ? "~/.claude" : "Codex"} с
              хоста сервера
            </span>
          </span>
        </DropdownMenuItem>
        {provider === "claude" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="items-start py-2"
              onSelect={() => onChoose("api-key")}
            >
              <Icon name="Lock" className="mt-0.5" />
              <span>
                <span className="block">Добавить API-ключ…</span>
                <span className="block text-xs text-muted-foreground">
                  Платный запасной вариант, выбирается последним
                </span>
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StepIndicator({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="flex gap-1.5" aria-label={`Шаг ${step} из 3`}>
      {[1, 2, 3].map((value) => (
        <span
          key={value}
          className={cn(
            "h-1 flex-1 rounded-full",
            value <= step ? "bg-primary" : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}
function QuotaDetail({
  label,
  quota,
  threshold,
  skipAt,
}: {
  label: string;
  quota: FamilyQuota | null;
  threshold: number;
  skipAt?: number;
}) {
  const utilization = quota?.utilization ?? null;
  const limit = skipAt ?? threshold;
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-3 text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0">
        <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full",
              utilization !== null && utilization >= limit
                ? "bg-destructive"
                : utilization !== null && utilization >= limit - 0.1
                  ? "bg-warning"
                  : "bg-primary",
            )}
            style={{
              width: `${Math.min(100, Math.max(0, (utilization ?? 0) * 100))}%`,
            }}
          />
        </div>
        <div className="text-xs text-muted-foreground">
          {percent(utilization)}
          {quota?.resetAt === null || quota === null
            ? ""
            : ` · ${resetLabel(quota.resetAt)}`}{" "}
          · пропуск при {Math.round(limit * 100)}%
        </div>
      </div>
    </div>
  );
}

type CopyState = "idle" | "copied" | "manual";

function useCopyToClipboard(text: string, selectFallback: () => void) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setCopyState("idle");
  }, [text]);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopyState("copied");
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopyState("idle"), 1500);
      },
      () => {
        selectFallback();
        setCopyState("manual");
      },
    );
  }, [text, selectFallback]);

  return { copyState, copy };
}

function UserCodeBlock({ userCode }: { userCode: string }) {
  const codeRef = useRef<HTMLSpanElement>(null);
  const selectCode = useCallback(() => {
    const element = codeRef.current;
    if (element === null) return;
    const selection = window.getSelection();
    if (selection === null) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);
  const { copyState, copy } = useCopyToClipboard(userCode, selectCode);

  return (
    <div className="rounded-lg border border-border bg-surface-recessed px-4 py-4">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center">
        <span
          ref={codeRef}
          className="col-start-2 select-all text-center font-mono text-2xl font-semibold tracking-widest"
          aria-label="Код устройства Codex"
        >
          {userCode}
        </span>
        <Button
          type="button"
          variant="ghost"
          aria-label="Скопировать код входа Codex"
          className="col-start-3 size-11 justify-self-start text-muted-foreground hover:text-foreground sm:size-9"
          onClick={copy}
        >
          <Icon name={copyState === "copied" ? "Check" : "Copy"} />
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copyState === "copied"
          ? "Код входа скопирован"
          : copyState === "manual"
            ? "Браузер заблокировал копирование. Код выделен — скопируйте вручную."
            : ""}
      </span>
    </div>
  );
}

function AuthorizationUrlRow({
  name,
  url,
  openUrl,
}: {
  name: string;
  url: string;
  openUrl: (url: string) => boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectUrl = useCallback(() => {
    inputRef.current?.select();
  }, []);
  const { copyState, copy } = useCopyToClipboard(url, selectUrl);

  return (
    <div>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          readOnly
          value={url}
          aria-label={`Ссылка авторизации ${name}`}
        />
        <Button
          variant="outline"
          className="shrink-0"
          aria-label={`Скопировать ссылку авторизации ${name}`}
          onClick={copy}
        >
          {copyState === "copied" ? "Скопировано" : "Копировать"}
        </Button>
        <Button className="shrink-0" onClick={() => openUrl(url)}>
          Открыть
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copyState === "copied"
          ? "Ссылка авторизации скопирована"
          : copyState === "manual"
            ? "Браузер заблокировал копирование. Ссылка выделена — скопируйте вручную."
            : ""}
      </span>
    </div>
  );
}

function DialogFrame({
  title,
  children,
  footer,
  className,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  className?: string;
}) {
  return (
    <DialogContent
      hideCloseButton
      className={cn(
        "max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto]",
        className,
      )}
    >
      <DialogHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <DialogTitle>{title}</DialogTitle>
        <DialogClose className="-mr-1 shrink-0 cursor-pointer rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
          <Icon name="X" className="size-4" />
          <span className="sr-only">Закрыть</span>
        </DialogClose>
      </DialogHeader>
      <div className="min-h-0 space-y-5 overflow-y-auto">{children}</div>
      {footer === null ? null : (
        <DialogFooter className="flex-row items-center gap-2 sm:space-x-0">
          {footer}
        </DialogFooter>
      )}
    </DialogContent>
  );
}

function ConfigFieldRow({
  label,
  description,
  error,
  children,
}: {
  label: string;
  description: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {description}
        </div>
      </div>
      <div className="w-80 max-w-[50%] shrink-0">
        {children}
        {error === null ? null : (
          <p className="mt-1 text-xs text-destructive-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function AccountPoolSettings() {
  const rpc = useRpc<typeof accountPoolRpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<PoolStatus | null>(readCachedStatus);
  const [statusIsCached, setStatusIsCached] = useState(status !== null);
  const [config, setConfig] = useState<AccountPoolConfig | null>(null);
  const [drafts, setDrafts] = useState<Record<ConfigField, string>>({
    anthropicUpstreamBaseUrl: "",
    codexUpstreamBaseUrl: "",
    kimiUpstreamBaseUrl: "",
    zaiUpstreamBaseUrl: "",
    opencodeGoUpstreamBaseUrl: "",
    cursorUpstreamBaseUrl: "",
    switchThreshold: "",
  });
  const [configErrors, setConfigErrors] = useState<
    Record<ConfigField, string | null>
  >({
    anthropicUpstreamBaseUrl: null,
    codexUpstreamBaseUrl: null,
    kimiUpstreamBaseUrl: null,
    zaiUpstreamBaseUrl: null,
    opencodeGoUpstreamBaseUrl: null,
    cursorUpstreamBaseUrl: null,
    switchThreshold: null,
  });
  const [dialog, setDialog] = useState<DialogState>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [optimisticOrder, setOptimisticOrder] = useState<{
    provider: PoolProvider;
    ids: string[];
  } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const [loginStep, setLoginStep] = useState<OAuthLoginStart | null>(null);
  const [codexStep, setCodexStep] = useState<CodexDeviceLoginStart | null>(
    null,
  );
  const [loginDone, setLoginDone] = useState<string | null>(null);
  const [pastedCode, setPastedCode] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [priority, setPriority] = useState("100");
  const [roleDraft, setRoleDraft] = useState<AccountSummary["role"]>("primary");
  const [capDraft, setCapDraft] = useState({ early: "", late: "" });
  const [drainDraft, setDrainDraft] = useState("");
  const [routingError, setRoutingError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const mounted = useRef(true);
  const threshold =
    config?.switchThreshold ?? DEFAULT_ACCOUNT_POOL_CONFIG.switchThreshold;
  const applyConfig = useCallback((next: AccountPoolConfig) => {
    setConfig(next);
    setDrafts(configDrafts(next));
    setDrainDraft(String(next.reserveDrainHours));
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await rpc.call("status.get", null);
      writeCachedStatus(next);
      if (!mounted.current) return;
      setStatus(next);
      setStatusIsCached(false);
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [rpc]);
  const refreshConfig = useCallback(async () => {
    try {
      const next = await rpc.call("config.get", null);
      if (mounted.current) applyConfig(next);
    } catch (loadError) {
      if (mounted.current) setError(errorText(loadError));
    }
  }, [applyConfig, rpc]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    void refreshConfig();
    return () => {
      mounted.current = false;
    };
  }, [refresh, refreshConfig]);
  useRealtime(ACCOUNT_POOL_ACCOUNTS_CHANGED, () => {
    void refresh();
  });
  useRealtime(ACCOUNT_POOL_CONFIG_CHANGED, () => {
    void refreshConfig();
  });
  useEffect(() => {
    if (codexStep === null || loginDone !== null) return;
    const update = () =>
      setCountdown(
        Math.max(0, Math.ceil((codexStep.expiresAt - Date.now()) / 1_000)),
      );
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [codexStep, loginDone]);
  useEffect(() => {
    if (codexStep === null || loginDone !== null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const result = await rpc.call("codexLogin.poll", {
          sessionId: codexStep.sessionId,
        });
        if (cancelled) return;
        if (result.status === "complete") {
          setLoginDone(result.account.label);
          setCodexStep(null);
          await refresh();
        } else if (result.status === "error") {
          setCodexStep(null);
          setError(result.message);
        } else timer = setTimeout(poll, codexStep.intervalMs);
      } catch (pollError) {
        if (!cancelled) setError(errorText(pollError));
      }
    };
    timer = setTimeout(poll, codexStep.intervalMs);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [codexStep, loginDone, refresh, rpc]);
  const accounts = status?.accounts ?? [];
  const selectedAccount =
    dialog?.kind === "account" ||
    dialog?.kind === "priority" ||
    dialog?.kind === "role" ||
    dialog?.kind === "cap" ||
    dialog?.kind === "remove"
      ? (accounts.find((account) => account.id === dialog.accountId) ?? null)
      : null;
  async function run(key: string, action: () => Promise<void>): Promise<void> {
    if (pending !== null) return;
    setPending(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setPending(null);
    }
  }
  function updateConfigDraft(field: ConfigField, value: string): void {
    setDrafts((current) => ({ ...current, [field]: value }));
    setConfigErrors((current) => ({ ...current, [field]: null }));
  }
  async function saveConfigField(field: ConfigField): Promise<void> {
    if (config === null || pending !== null) return;
    let update: AccountPoolConfigSetInput;
    if (field === "switchThreshold") {
      const raw = drafts.switchThreshold.trim();
      const value = Number(raw);
      if (
        raw.length === 0 ||
        !Number.isFinite(value) ||
        value <= 0 ||
        value > 1
      ) {
        setConfigErrors((current) => ({
          ...current,
          switchThreshold: "Должно быть больше 0 и не больше 1.",
        }));
        return;
      }
      if (value === config.switchThreshold) return;
      update = { switchThreshold: value };
    } else {
      const value = drafts[field].trim();
      const validationError = httpUrlError(value);
      if (validationError !== null) {
        setConfigErrors((current) => ({
          ...current,
          [field]: validationError,
        }));
        return;
      }
      if (value === config[field]) return;
      update =
        field === "anthropicUpstreamBaseUrl"
          ? { anthropicUpstreamBaseUrl: value }
          : { codexUpstreamBaseUrl: value };
    }
    setPending(`config-${field}`);
    setConfigErrors((current) => ({ ...current, [field]: null }));
    try {
      applyConfig(await rpc.call("config.set", update));
    } catch (saveError) {
      setConfigErrors((current) => ({
        ...current,
        [field]: errorText(saveError),
      }));
    } finally {
      setPending(null);
    }
  }
  async function startClaude(): Promise<void> {
    setDialog({ kind: "claude-login" });
    setLoginDone(null);
    await run("claude-login", async () => {
      const started = await rpc.call("login.start", null);
      setLoginStep(started);
      setPastedCode("");
    });
  }
  async function startCodex(): Promise<void> {
    setDialog({ kind: "codex-login" });
    setLoginDone(null);
    await run("codex-login", async () => {
      setCodexStep(await rpc.call("codexLogin.start", null));
    });
  }
  async function chooseAdd(
    provider: PoolProvider,
    choice: "login" | "import" | "api-key",
  ): Promise<void> {
    if (choice === "login") {
      if (provider === "claude") await startClaude();
      else await startCodex();
      return;
    }
    if (choice === "api-key") {
      setDialog({ kind: "api-key" });
      return;
    }
    await run(`import-${provider}`, async () => {
      await rpc.call("account.add", {
        provider,
        source: { kind: "import" },
        label: null,
        priority: 100,
      });
    });
  }
  async function saveRouting(update: AccountPoolConfigSetInput): Promise<void> {
    if (config === null || pending !== null) return;
    setPending("config-routing");
    setRoutingError(null);
    try {
      applyConfig(await rpc.call("config.set", update));
    } catch (saveError) {
      setRoutingError(errorText(saveError));
    } finally {
      setPending(null);
    }
  }
  async function saveDrainHours(): Promise<void> {
    if (config === null) return;
    const raw = drainDraft.trim();
    const value = Number(raw);
    if (raw === "" || !Number.isFinite(value) || value <= 0 || value > 168) {
      setRoutingError("Часы расхода: больше 0 и не больше 168.");
      return;
    }
    if (value === config.reserveDrainHours) return;
    await saveRouting({ reserveDrainHours: value });
  }
  async function accountAction(
    account: AccountSummary,
    action: AccountAction,
  ): Promise<void> {
    if (action === "priority") {
      setPriority(String(account.priority));
      setDialog({ kind: "priority", accountId: account.id });
      return;
    }
    if (action === "role") {
      setRoleDraft(account.role);
      setDialog({ kind: "role", accountId: account.id });
      return;
    }
    if (action === "cap") {
      const curve = account.cap ?? DEFAULT_RESERVE_CAP;
      setCapDraft({ early: String(curve.early), late: String(curve.late) });
      setDialog({ kind: "cap", accountId: account.id });
      return;
    }
    if (action === "remove") {
      setDialog({ kind: "remove", accountId: account.id });
      return;
    }
    await run(`${action}-${account.id}`, async () => {
      if (action === "toggle")
        await rpc.call(account.enabled ? "account.disable" : "account.enable", {
          id: account.id,
        });
      if (action === "refresh")
        await rpc.call("account.refreshUsage", { accountId: account.id });
    });
  }
  async function reorderAccounts(
    provider: PoolProvider,
    event: DragEndEvent,
  ): Promise<void> {
    if (pending !== null || event.over === null) return;
    const ids = accounts
      .filter((account) => account.provider === provider)
      .map((account) => account.id);
    const from = ids.findIndex((id) => id === event.active.id);
    const to = ids.findIndex((id) => id === event.over?.id);
    if (from < 0 || to < 0 || from === to) return;
    const accountIds = arrayMove(ids, from, to);
    setOptimisticOrder({ provider, ids: accountIds });
    try {
      await run(`order-${provider}`, async () => {
        await rpc.call("account.reorder", { provider, accountIds });
      });
    } finally {
      setOptimisticOrder(null);
    }
  }
  function closeDialog(): void {
    if (dialog?.kind === "codex-login" && codexStep !== null)
      void rpc.call("codexLogin.cancel", { sessionId: codexStep.sessionId });
    setDialog(null);
    setLoginStep(null);
    setCodexStep(null);
    setLoginDone(null);
    setError(null);
  }
  const hubHosts =
    status?.hosts.map((host) => host.hostName ?? host.hostId).join(", ") ||
    "машин нет";
  const currentLabel = (provider: PoolProvider): string => {
    const id = status?.activeAccounts[provider] ?? null;
    return accounts.find((account) => account.id === id)?.label ?? "нет";
  };
  const currentId = (provider: PoolProvider): string | null =>
    status?.activeAccounts[provider] ?? null;
  const reserveAccounts = accounts
    .filter((account) => account.role === "reserve")
    .sort(
      (left, right) =>
        (left.drainOpensAt ?? Number.POSITIVE_INFINITY) -
        (right.drainOpensAt ?? Number.POSITIVE_INFINITY),
    );
  return (
    <div className="w-full space-y-6">
      <p className="text-xs text-subtle-foreground/75">
        Хаб {status?.accepting ? "принимает" : "не принимает"} ·{" "}
        {status?.inFlight ?? 0} в работе · используют {hubHosts}
        {statusIsCached ? " · обновляю…" : null}
      </p>
      <p className="flex flex-wrap gap-x-3 text-xs text-subtle-foreground/75">
        {PROVIDERS.map((provider) => (
          <span key={provider.id}>
            {`Сейчас ${provider.title}: ${currentLabel(provider.id)}`}
          </span>
        ))}
      </p>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle-foreground/75">
        {[
          { dot: "bg-success", label: "берёт трафик" },
          { dot: "bg-warning", label: "близко к лимиту или потолку" },
          { dot: "bg-destructive", label: "заблокирован до сброса" },
          {
            dot: "bg-muted-foreground",
            label: "в запасе, выключен или без данных",
          },
        ].map((entry) => (
          <span key={entry.label} className="inline-flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", entry.dot)} />
            {entry.label}
          </span>
        ))}
      </p>
      {error === null ? null : (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-surface-destructive px-3 py-2 text-sm text-destructive-text"
        >
          {error}
        </div>
      )}
      {status !== null && !statusIsCached && accounts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-5 py-6 text-center">
          <h2 className="text-sm font-semibold text-foreground">
            В пуле нет аккаунтов
          </h2>
          <p className="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">
            Добавьте аккаунт Claude или Codex — и треды на всех машинах route
            through it. Your machine&apos;s own login keeps working until then.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button size="sm" onClick={() => void startClaude()}>
              Войти в Claude
            </Button>
            <Button size="sm" onClick={() => void startCodex()}>
              Войти в Codex
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            либо импортируйте вход этой машины через меню «Добавить аккаунт»
            нужного провайдера
          </p>
        </div>
      ) : null}
      {PROVIDERS.map((provider) => {
        const serverAccounts = accounts.filter(
          (account) => account.provider === provider.id,
        );
        const order =
          optimisticOrder?.provider === provider.id
            ? optimisticOrder.ids
            : null;
        const providerAccounts =
          order !== null &&
          order.length === serverAccounts.length &&
          serverAccounts.every((account) => order.includes(account.id))
            ? order.flatMap((id) =>
                serverAccounts.filter((account) => account.id === id),
              )
            : serverAccounts;
        return (
          <SettingsSection
            key={provider.id}
            title={provider.title}
            description={provider.description}
            action={
              <div className="flex items-center gap-2">
                <Switch
                  checked={status?.routing[provider.id] ?? true}
                  disabled={pending !== null}
                  aria-label={`Направлять треды ${provider.title}`}
                  onCheckedChange={(enabled) =>
                    void run(`routing-${provider.id}`, async () => {
                      await rpc.call("routing.set", {
                        provider: provider.id,
                        enabled,
                      });
                    })
                  }
                />
                <AddAccountMenu
                  provider={provider.id}
                  onChoose={(choice) => void chooseAdd(provider.id, choice)}
                />
              </div>
            }
          >
            {status === null ? (
              <p className="py-2.5 text-sm text-muted-foreground">Загрузка…</p>
            ) : providerAccounts.length === 0 ? (
              <p className="py-2.5 text-sm text-subtle-foreground">
                Аккаунтов пока нет.
              </p>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={accountDragModifiers}
                onDragEnd={(event) => void reorderAccounts(provider.id, event)}
              >
                <SortableContext
                  items={providerAccounts.map((account) => account.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="divide-y divide-border">
                    {providerAccounts.map((account) => (
                      <AccountRow
                        key={account.id}
                        account={account}
                        threshold={threshold}
                        current={account.id === currentId(provider.id)}
                        pending={pending !== null}
                        refreshing={
                          statusIsCached || pending === `refresh-${account.id}`
                        }
                        reorderDisabled={providerAccounts.length < 2}
                        onAction={(action) =>
                          void accountAction(account, action)
                        }
                        onOpen={() =>
                          setDialog({ kind: "account", accountId: account.id })
                        }
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </SettingsSection>
        );
      })}
      <div className="rounded-lg border border-border px-4">
        <div className="py-2.5 text-sm font-medium text-foreground">
          Маршрутизация
        </div>
        <div className="divide-y divide-border border-t border-border">
          <ConfigFieldRow
            label="Балансировка"
            description="Новые разговоры уходят на аккаунт с наибольшим остатком недельной квоты до сброса. Выключено — идём по приоритету."
            error={null}
          >
            <Switch
              checked={config?.routingStrategy === "balanced"}
              disabled={config === null || pending !== null}
              aria-label="Балансировка"
              onCheckedChange={(enabled) =>
                void saveRouting({
                  routingStrategy: enabled ? "balanced" : "sequential",
                })
              }
            />
          </ConfigFieldRow>
          <div className="py-2.5">
            <div className="text-sm text-foreground">Окна расхода</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              Когда каждый резервный аккаунт подключается к основным — в рабочих
              часах до его недельного сброса.
            </div>
            {reserveAccounts.length === 0 ? (
              <p className="mt-2 text-xs text-subtle-foreground/75">
                Резервных аккаунтов пока нет.
              </p>
            ) : (
              PROVIDERS.flatMap((provider) => {
                const rows = reserveAccounts.filter(
                  (account) => account.provider === provider.id,
                );
                if (rows.length === 0) return [];
                return [
                  <div key={provider.id} className="mt-3 overflow-x-auto">
                    <div className="text-xs font-medium text-foreground">
                      {provider.title}
                    </div>
                    <table
                      className="mt-1 w-full text-left text-xs"
                      aria-label={`Окна расхода ${provider.title}`}
                    >
                      <thead className="text-subtle-foreground/75">
                        <tr>
                          <th className="py-1 pr-3 font-normal">Аккаунт</th>
                          <th className="py-1 pr-3 font-normal">
                            Открытьs (UTC+3)
                          </th>
                          <th className="py-1 pr-3 font-normal">
                            Недельный сброс (UTC+3)
                          </th>
                          <th className="py-1 font-normal">Потолок сейчас</th>
                        </tr>
                      </thead>
                      <tbody className="tabular-nums">
                        {rows.map((account) => {
                          const reset = weeklyResetAt(account);
                          const opens = account.drainOpensAt;
                          return (
                            <tr
                              key={account.id}
                              className="border-t border-border"
                            >
                              <td className="py-1 pr-3 whitespace-nowrap">
                                {accountFullName(account)}
                              </td>
                              <td className="py-1 pr-3 whitespace-nowrap">
                                {opens === null
                                  ? "сброс неизвестен"
                                  : opens <= Date.now()
                                    ? "уже открыто"
                                    : moment(opens)}
                              </td>
                              <td className="py-1 pr-3 whitespace-nowrap">
                                {reset === null ? "—" : moment(reset)}
                              </td>
                              <td className="py-1">
                                {percent(account.capLimit)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>,
                ];
              })
            )}
          </div>
          <ConfigFieldRow
            label="Часы расхода резерва"
            description="Рабочие часы до недельного сброса, когда резервные аккаунты подключаются к основным."
            error={null}
          >
            <Input
              type="number"
              min="1"
              max="168"
              step="1"
              aria-label="Часы расхода резерва"
              disabled={config === null || pending !== null}
              value={drainDraft}
              onChange={(event) => {
                setDrainDraft(event.target.value);
                setRoutingError(null);
              }}
              onBlur={() => void saveDrainHours()}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </ConfigFieldRow>
          <ConfigFieldRow
            label="Выходные"
            description="Дни, которые пул считает нерабочими: их часы не двигают аккаунт к сбросу, поэтому на выходных потолки остаются низкими."
            error={routingError}
          >
            <div>
              <div className="flex flex-wrap gap-1" aria-label="Выходные">
                {WEEKDAY_LABELS.map((title, day) => {
                  const off = (config?.restDays ?? []).includes(day);
                  return (
                    <Button
                      key={title}
                      type="button"
                      size="sm"
                      variant={off ? undefined : "outline"}
                      aria-pressed={off}
                      disabled={config === null || pending !== null}
                      onClick={() =>
                        void saveRouting({
                          restDays: off
                            ? (config?.restDays ?? []).filter(
                                (value) => value !== day,
                              )
                            : [...(config?.restDays ?? []), day].sort(
                                (left, right) => left - right,
                              ),
                        })
                      }
                    >
                      {title}
                    </Button>
                  );
                })}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {daysOffSummary(config?.restDays ?? [])}
              </p>
            </div>
          </ConfigFieldRow>
        </div>
      </div>
      <Collapsible className="rounded-lg border border-border px-4">
        <CollapsibleTrigger className="flex w-full items-center gap-2 py-2.5 text-sm font-medium text-foreground">
          <Icon
            name="ChevronRight"
            className="size-4 transition-transform [[data-state=open]>&]:rotate-90"
          />
          Дополнительно
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="divide-y divide-border border-t border-border">
            <ConfigFieldRow
              label="Базовый URL upstream Anthropic"
              description="QA-переопределение для трафика Anthropic."
              error={configErrors.anthropicUpstreamBaseUrl}
            >
              <Input
                aria-label="Базовый URL upstream Anthropic"
                aria-invalid={
                  configErrors.anthropicUpstreamBaseUrl === null
                    ? undefined
                    : true
                }
                disabled={config === null || pending !== null}
                value={drafts.anthropicUpstreamBaseUrl}
                onChange={(event) =>
                  updateConfigDraft(
                    "anthropicUpstreamBaseUrl",
                    event.target.value,
                  )
                }
                onBlur={() => void saveConfigField("anthropicUpstreamBaseUrl")}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </ConfigFieldRow>
            <ConfigFieldRow
              label="Базовый URL upstream Codex"
              description="QA-переопределение для трафика ChatGPT Codex."
              error={configErrors.codexUpstreamBaseUrl}
            >
              <Input
                aria-label="Базовый URL upstream Codex"
                aria-invalid={
                  configErrors.codexUpstreamBaseUrl === null ? undefined : true
                }
                disabled={config === null || pending !== null}
                value={drafts.codexUpstreamBaseUrl}
                onChange={(event) =>
                  updateConfigDraft("codexUpstreamBaseUrl", event.target.value)
                }
                onBlur={() => void saveConfigField("codexUpstreamBaseUrl")}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </ConfigFieldRow>
            <ConfigFieldRow
              label="Порог переключения по квоте"
              description="Не выбирать аккаунт при этой доле израсходованной квоты."
              error={configErrors.switchThreshold}
            >
              <Input
                type="number"
                min="0.01"
                max="1"
                step="0.01"
                aria-label="Порог переключения по квоте"
                aria-invalid={
                  configErrors.switchThreshold === null ? undefined : true
                }
                disabled={config === null || pending !== null}
                value={drafts.switchThreshold}
                onChange={(event) =>
                  updateConfigDraft("switchThreshold", event.target.value)
                }
                onBlur={() => void saveConfigField("switchThreshold")}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </ConfigFieldRow>
            <div className="flex items-start justify-between gap-4">
              <div className="py-2.5">
                <div className="text-sm text-foreground">Токены машин</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {hubHosts}
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2 py-2.5">
                {status?.hosts.map((host) => (
                  <Button
                    key={host.hostId}
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void run(`rotate-${host.hostId}`, async () => {
                        await rpc.call("token.rotate", {
                          machine: host.hostId,
                        });
                      })
                    }
                  >
                    Обновить {host.hostName ?? host.hostId}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        {dialog?.kind === "account" && selectedAccount !== null ? (
          <AccountDialog
            account={selectedAccount}
            threshold={threshold}
            current={selectedAccount.id === currentId(selectedAccount.provider)}
            drainHours={
              config?.reserveDrainHours ??
              DEFAULT_ACCOUNT_POOL_CONFIG.reserveDrainHours
            }
            close={closeDialog}
            act={(action) => void accountAction(selectedAccount, action)}
          />
        ) : null}
        {dialog?.kind === "priority" && selectedAccount !== null ? (
          <DialogFrame
            title="Приоритет"
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Отмена
                </Button>
                <Button
                  disabled={
                    !Number.isInteger(Number(priority)) || pending !== null
                  }
                  onClick={() =>
                    void run(`priority-${selectedAccount.id}`, async () => {
                      await rpc.call("account.setPriority", {
                        accountId: selectedAccount.id,
                        priority: Number(priority),
                      });
                      setDialog(null);
                    })
                  }
                >
                  Сохранить
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Меньшие числа идут первыми в порядке переключения. При равенстве —
              в порядке добавления. Текущие разговоры остаются на своём
              аккаунте.
            </p>
            <Input
              type="number"
              aria-label="Приоритет аккаунта"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </DialogFrame>
        ) : null}
        {dialog?.kind === "role" && selectedAccount !== null ? (
          <DialogFrame
            title="Роль"
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Отмена
                </Button>
                <Button
                  disabled={pending !== null}
                  onClick={() =>
                    void run(`role-${selectedAccount.id}`, async () => {
                      await rpc.call("account.setRole", {
                        accountId: selectedAccount.id,
                        role: roleDraft,
                      });
                      setDialog(null);
                    })
                  }
                >
                  Сохранить
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Основные аккаунты берут трафик как обычно. Резервные включаются,
              только когда ни один основной не подходит или близок недельный
              сброс, и всегда остаются под своим недельным потолком.
            </p>
            <div className="flex gap-2">
              {(["primary", "reserve"] as const).map((role) => (
                <Button
                  key={role}
                  variant={roleDraft === role ? undefined : "outline"}
                  aria-pressed={roleDraft === role}
                  onClick={() => setRoleDraft(role)}
                >
                  {role === "primary" ? "Основной" : "Резерв"}
                </Button>
              ))}
            </div>
          </DialogFrame>
        ) : null}
        {dialog?.kind === "cap" && selectedAccount !== null ? (
          <DialogFrame
            title="Недельный потолок"
            footer={
              <>
                <Button
                  variant="outline"
                  disabled={pending !== null || selectedAccount.cap === null}
                  onClick={() =>
                    void run(`cap-${selectedAccount.id}`, async () => {
                      await rpc.call("account.setCap", {
                        accountId: selectedAccount.id,
                        cap: null,
                      });
                      setDialog(null);
                    })
                  }
                >
                  Удалить cap
                </Button>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Отмена
                </Button>
                <Button
                  disabled={
                    pending !== null ||
                    capDraft.early.trim() === "" ||
                    capDraft.late.trim() === "" ||
                    !Number.isFinite(Number(capDraft.early)) ||
                    !Number.isFinite(Number(capDraft.late))
                  }
                  onClick={() =>
                    void run(`cap-${selectedAccount.id}`, async () => {
                      await rpc.call("account.setCap", {
                        accountId: selectedAccount.id,
                        cap: {
                          early: Number(capDraft.early),
                          late: Number(capDraft.late),
                        },
                      });
                      setDialog(null);
                    })
                  }
                >
                  Сохранить
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Пул перестаёт трогать аккаунт, когда недельный расход достигает
              предела, который растёт от значения в начале недели к значению у
              сброса по мере рабочего времени. Доли от 0 до 1.
              {selectedAccount.cap === null &&
              selectedAccount.role === "reserve"
                ? " Резервные аккаунты работают от 0.15 до 0.98, пока потолок не задан."
                : ""}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="number"
                min="0"
                max="1"
                step="0.01"
                aria-label="Потолок в начале недели"
                value={capDraft.early}
                onChange={(event) =>
                  setCapDraft((current) => ({
                    ...current,
                    early: event.target.value,
                  }))
                }
              />
              <Input
                type="number"
                min="0"
                max="1"
                step="0.01"
                aria-label="Потолок к сбросу"
                value={capDraft.late}
                onChange={(event) =>
                  setCapDraft((current) => ({
                    ...current,
                    late: event.target.value,
                  }))
                }
              />
            </div>
          </DialogFrame>
        ) : null}
        {dialog?.kind === "api-key" ? (
          <DialogFrame
            title="Добавить API-ключ Anthropic"
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Отмена
                </Button>
                <Button
                  disabled={apiKey.trim().length === 0 || pending !== null}
                  onClick={() =>
                    void run("api-key", async () => {
                      await rpc.call("account.add", {
                        provider: "claude",
                        source: { kind: "api-key", apiKey: apiKey.trim() },
                        label: null,
                        priority: 100,
                      });
                      setApiKey("");
                      setDialog(null);
                    })
                  }
                >
                  Добавить ключ
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Платный запасной вариант; хранится в защищённом каталоге секретов
              пула аккаунтов.
            </p>
            <Input
              type="password"
              autoComplete="off"
              aria-label="API-ключ Anthropic"
              placeholder="sk-ant-…"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </DialogFrame>
        ) : null}
        {dialog?.kind === "remove" && selectedAccount !== null ? (
          <DialogFrame
            title={`Удалить ${selectedAccount.label}?`}
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Отмена
                </Button>
                <Button
                  variant="destructive"
                  disabled={pending !== null}
                  onClick={() =>
                    void run(`remove-${selectedAccount.id}`, async () => {
                      await rpc.call("account.remove", {
                        id: selectedAccount.id,
                      });
                      setDialog(null);
                    })
                  }
                >
                  Удалить
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Файл секрета аккаунта будет удалён. Если других аккаунтов в пуле
              нет, треды вернутся к входу своей машины.
            </p>
          </DialogFrame>
        ) : null}
        {dialog?.kind === "claude-login" ? (
          <LoginDialog
            provider="claude"
            loginStep={loginStep}
            codexStep={null}
            loginDone={loginDone}
            pending={pending !== null}
            pastedCode={pastedCode}
            countdown={0}
            error={error}
            close={closeDialog}
            openUrl={navigate.openUrl}
            setPastedCode={setPastedCode}
            complete={() =>
              void run("complete-claude", async () => {
                if (loginStep === null) return;
                const added = await rpc.call("login.complete", {
                  sessionId: loginStep.sessionId,
                  pasted: pastedCode,
                });
                setLoginDone(added.label);
                setLoginStep(null);
              })
            }
            restart={() => void startClaude()}
          />
        ) : null}
        {dialog?.kind === "codex-login" ? (
          <LoginDialog
            provider="codex"
            loginStep={null}
            codexStep={codexStep}
            loginDone={loginDone}
            pending={pending !== null}
            pastedCode=""
            countdown={countdown}
            error={error}
            close={closeDialog}
            openUrl={navigate.openUrl}
            setPastedCode={() => {}}
            complete={() => {}}
            restart={() => void startCodex()}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

function capSummary(account: AccountSummary): string | null {
  const curve =
    account.cap ?? (account.role === "reserve" ? DEFAULT_RESERVE_CAP : null);
  if (curve === null) return null;
  return `${percent(curve.early)} → ${percent(curve.late)}${
    account.capLimit === null ? "" : ` · сейчас ${percent(account.capLimit)}`
  }`;
}

function AccountDialog({
  account,
  threshold,
  current,
  drainHours,
  close,
  act,
}: {
  account: AccountSummary;
  threshold: number;
  current: boolean;
  drainHours: number;
  close: () => void;
  act: (action: "toggle" | "refresh" | "remove") => void;
}) {
  const cap = capSummary(account);
  const weeklySkipAt =
    account.capLimit === null
      ? undefined
      : Math.min(threshold, account.capLimit);
  const shared = (
    utilization: number | null,
    resetAt: number | null,
    status: string | null,
  ): FamilyQuota => ({
    utilization,
    resetAt,
    status,
    observedAt: account.observedAt ?? 0,
    source: "header",
  });
  const providerId =
    account.provider === "claude"
      ? account.accountUuid
      : account.codexAccountId;
  return (
    <DialogFrame
      title={account.label}
      className="sm:max-w-xl"
      footer={
        <>
          <Button size="sm" variant="outline" onClick={() => act("toggle")}>
            {account.enabled ? "Выключить" : "Включить"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => act("refresh")}>
            Обновить квоты
          </Button>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive-text"
            onClick={() => act("remove")}
          >
            Удалить
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <SettingsBadge>{tier(account)}</SettingsBadge>
        <SettingsBadge>
          {statusPresentation(account, threshold).label}
        </SettingsBadge>
        <SettingsBadge>
          {account.role === "reserve" ? "Резерв" : "Основной"}
        </SettingsBadge>
        {current ? <SettingsBadge>Текущий</SettingsBadge> : null}
      </div>
      {account.role === "reserve" ? (
        <p className="text-sm text-muted-foreground">
          {`Используется, только когда ни один основной аккаунт не подходит, или за ${drainHours} рабочих часов до его недельного сброса.`}
        </p>
      ) : null}
      {cap === null ? null : (
        <div className="grid grid-cols-[7rem_1fr] items-center gap-3 text-sm">
          <div className="text-muted-foreground">Недельный потолок</div>
          <div className="min-w-0">{cap}</div>
        </div>
      )}
      <div className="space-y-4">
        {account.provider === "codex" ? (
          account.limitWindows.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              Лимиты пока не наблюдались.
            </div>
          ) : (
            account.limitWindows.map((window) => (
              <QuotaDetail
                key={window.slot}
                label={windowLongLabel(window, account.provider)}
                quota={window}
                threshold={threshold}
                skipAt={
                  (window.windowMinutes ?? 0) >= 1_440
                    ? weeklySkipAt
                    : undefined
                }
              />
            ))
          )
        ) : (
          <>
            <QuotaDetail
              label="5 часов"
              quota={shared(
                account.fiveHourUtilization,
                account.fiveHourResetAt,
                account.fiveHourStatus,
              )}
              threshold={threshold}
            />
            <QuotaDetail
              label="7 дней"
              quota={shared(
                account.sevenDayUtilization,
                account.sevenDayResetAt,
                account.sevenDayStatus,
              )}
              threshold={threshold}
              skipAt={weeklySkipAt}
            />
            {modelFamilySchema.options.flatMap((family) =>
              account.familyWeekly[family] === null
                ? []
                : [
                    <QuotaDetail
                      key={family}
                      label={FAMILY_LABELS[family]}
                      quota={account.familyWeekly[family]}
                      threshold={threshold}
                      skipAt={weeklySkipAt}
                    />,
                  ],
            )}
          </>
        )}
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 border-t border-border pt-4 text-sm">
        {account.email === null ? null : (
          <>
            <dt className="text-muted-foreground">Почта</dt>
            <dd className="break-all">{account.email}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Тип</dt>
        <dd>
          {account.kind === "oauth"
            ? `OAuth · ${account.provider === "claude" ? "claude.ai" : "ChatGPT"}`
            : "API-ключ"}
        </dd>
        <dt className="text-muted-foreground">Приоритет</dt>
        <dd>{account.priority}</dd>
        <dt className="text-muted-foreground">Использован</dt>
        <dd>
          {account.lastUsedAt === null
            ? "Никогда"
            : `${relative(account.lastUsedAt)}${account.lastUsedHostName === null ? "" : ` · ${account.lastUsedHostName}`}`}
        </dd>
        <dt className="text-muted-foreground">Квоты обновлены</dt>
        <dd>
          {account.observedAt === null
            ? "Никогда"
            : relative(account.observedAt)}
        </dd>
        {providerId === null || providerId === undefined ? null : (
          <>
            <dt className="text-muted-foreground">ID аккаунта</dt>
            <dd className="font-mono text-xs">{`${providerId.slice(0, 4)}…${providerId.slice(-4)}`}</dd>
          </>
        )}
      </dl>
    </DialogFrame>
  );
}

function LoginDialog({
  provider,
  loginStep,
  codexStep,
  loginDone,
  pending,
  pastedCode,
  countdown,
  error,
  close,
  openUrl,
  setPastedCode,
  complete,
  restart,
}: {
  provider: PoolProvider;
  loginStep: OAuthLoginStart | null;
  codexStep: CodexDeviceLoginStart | null;
  loginDone: string | null;
  pending: boolean;
  pastedCode: string;
  countdown: number;
  error: string | null;
  close: () => void;
  openUrl: (url: string) => boolean;
  setPastedCode: (value: string) => void;
  complete: () => void;
  restart: () => void;
}) {
  const name = provider === "claude" ? "Claude" : "Codex";
  const url =
    provider === "claude"
      ? loginStep?.authorizeUrl
      : codexStep?.verificationUri;
  return (
    <DialogFrame
      title={`Вход в ${name}`}
      className="sm:max-w-xl"
      footer={
        loginDone !== null ? (
          <>
            <span className="flex-1" />
            <Button variant="outline" onClick={restart}>
              Добавить ещё
            </Button>
            <Button onClick={close}>Готово</Button>
          </>
        ) : provider === "claude" ? (
          <>
            <span className="flex-1" />
            <Button
              disabled={
                loginStep === null || pastedCode.trim().length === 0 || pending
              }
              onClick={complete}
            >
              Завершить
            </Button>
          </>
        ) : null
      }
    >
      <StepIndicator step={loginDone === null ? 2 : 3} />
      {loginDone !== null ? (
        <div>
          <h3 className="text-base font-semibold">Подключён {loginDone}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Треды {name} на всех машинах теперь идут через этот аккаунт. Квоты
            обновляются в фоне.
          </p>
        </div>
      ) : url === undefined ? (
        provider === "codex" && error !== null ? (
          <div className="space-y-3">
            <p className="text-sm text-destructive-text">{error}</p>
            <Button variant="outline" onClick={restart}>
              Попробовать снова
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Запускаю вход…</p>
        )
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {provider === "claude"
              ? "Войдите на claude.ai и вставьте код с последней страницы."
              : "Откройте страницу проверки, войдите в ChatGPT и введите этот код."}
          </p>
          {codexStep === null ? null : (
            <UserCodeBlock userCode={codexStep.userCode} />
          )}
          <AuthorizationUrlRow name={name} url={url} openUrl={openUrl} />
          {provider === "claude" ? (
            <Input
              aria-label="Код авторизации Claude"
              placeholder="Вставьте code#state сюда"
              value={pastedCode}
              onChange={(event) => setPastedCode(event.target.value)}
            />
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              Жду авторизацию… осталось {Math.floor(countdown / 60)}:
              {String(countdown % 60).padStart(2, "0")}
            </p>
          )}
        </>
      )}
    </DialogFrame>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "accounts",
    component: AccountPoolSettings,
  });
});
