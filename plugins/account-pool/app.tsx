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
  PoolAvailability,
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
  "parentMode" | "routingStrategy" | "reserveDrainHours" | "restDays"
>;

const PROVIDERS: Array<{
  id: PoolProvider;
  title: string;
  description: string;
}> = [
  {
    id: "claude",
    title: "Claude",
    description:
      "Claude Code threads on every machine route through these accounts.",
  },
  {
    id: "codex",
    title: "Codex",
    description: "Codex threads route through these ChatGPT accounts.",
  },
];
const FAMILY_LABELS: Record<ModelFamily, string> = {
  fable: "Fable 7 day",
  sonnet: "Sonnet 7 day",
  opus: "Opus 7 day",
  haiku: "Haiku 7 day",
  other: "Other 7 day",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpUrlError(value: string): string | null {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:"
      ? null
      : "Must be an HTTP or HTTPS URL.";
  } catch {
    return "Must be a valid URL.";
  }
}

function configDrafts(config: AccountPoolConfig): Record<ConfigField, string> {
  return {
    anthropicUpstreamBaseUrl: config.anthropicUpstreamBaseUrl,
    codexUpstreamBaseUrl: config.codexUpstreamBaseUrl,
    switchThreshold: String(config.switchThreshold),
  };
}
function parentHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function parentBannerBody(parent: NonNullable<PoolStatus["parent"]>): string {
  const host = parentHost(parent.baseUrl);
  if (parent.mode !== "proxy") {
    return `This server was started from a thread on ${host}. Turn this on to send Claude and Codex requests to its pool instead of using the accounts below.`;
  }
  const served = PROVIDERS.filter(
    (provider) => parent.availability[provider.id],
  ).map((provider) => provider.title);
  if (served.length === 0) {
    return `${host} has no accounts available right now, so nothing is being sent there. Requests fall back to each provider's own credentials.`;
  }
  const missing = PROVIDERS.filter(
    (provider) => !parent.availability[provider.id],
  ).map((provider) => provider.title);
  const routed = `${served.join(" and ")} requests are sent to the pool on ${host}.`;
  return missing.length === 0
    ? `${routed} Accounts on this server are not used while this is on.`
    : `${routed} ${missing.join(" and ")} has no accounts there, so those requests fall back to their own credentials.`;
}
function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}
function relative(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
function windowShortLabel(window: LimitWindow): string {
  if (window.windowMinutes === null)
    return window.slot === "primary" ? "LIMIT" : "LIMIT 2";
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440}D`;
  if (window.windowMinutes % 60 === 0) return `${window.windowMinutes / 60}H`;
  return `${window.windowMinutes}M`;
}
function windowLongLabel(window: LimitWindow): string {
  if (window.windowMinutes === null)
    return window.slot === "primary" ? "Usage limit" : "Secondary limit";
  if (window.windowMinutes === 7 * 24 * 60) return "Weekly";
  if (window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440} day`;
  if (window.windowMinutes % 60 === 0)
    return `${window.windowMinutes / 60} hour`;
  return `${window.windowMinutes} minute`;
}
function resetLabel(timestamp: number | null): string {
  if (timestamp === null) return "";
  const minutes = Math.max(1, Math.round((timestamp - Date.now()) / 60_000));
  if (minutes < 1_440)
    return `resets in ${minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`}`;
  return `resets ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(timestamp)}`;
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

function statusPresentation(
  account: AccountSummary,
  threshold: number,
): {
  label: string;
  dot: string;
} {
  if (account.status === "held")
    return {
      label: `Held${account.heldUntil === null ? "" : ` · retry at ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(account.heldUntil)}`}`,
      dot: "bg-warning",
    };
  if (account.status === "exhausted") {
    const resetAt = blockingResetAt(account, null, threshold, Date.now());
    return {
      label: `Exhausted${resetAt === null ? "" : ` · ${resetLabel(resetAt)}`}`,
      dot: "bg-destructive",
    };
  }
  if (account.status === "error")
    return { label: "Error", dot: "bg-destructive" };
  if (account.status === "disabled")
    return { label: "Disabled", dot: "bg-muted-foreground" };
  return { label: "Ready", dot: "bg-success" };
}
function tier(account: AccountSummary): string {
  return (
    account.subscriptionType ??
    (account.kind === "api-key" ? "API key" : "OAuth")
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
};

function quotaSlots(account: AccountSummary): QuotaSlot[] {
  if (account.provider === "codex") {
    if (account.limitWindows.length === 0)
      return [
        { key: "primary", label: "LIMIT", utilization: null, status: null },
      ];
    return account.limitWindows.map((window) => ({
      key: window.slot,
      label: windowShortLabel(window),
      utilization: window.utilization,
      status: window.status,
    }));
  }
  return [
    {
      key: "five-hour",
      label: "5H",
      utilization: account.fiveHourUtilization,
      status: account.fiveHourStatus,
    },
    {
      key: "seven-day",
      label: "7D",
      utilization: account.sevenDayUtilization,
      status: account.sevenDayStatus,
    },
    {
      key: "fable",
      label: "FABLE",
      utilization: account.familyWeekly.fable?.utilization ?? null,
      status: account.familyWeekly.fable?.status ?? null,
    },
  ];
}

function quotaToneClass(slot: QuotaSlot, threshold: number): string {
  if (
    slot.status?.toLowerCase() === "rejected" ||
    (slot.utilization !== null && slot.utilization >= 1)
  )
    return "text-destructive-text";
  if (slot.utilization !== null && slot.utilization >= threshold - 0.1)
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
      <div
        className={cn("text-xs font-semibold", quotaToneClass(slot, threshold))}
      >
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
    ? `cap ${percent(account.capLimit)} now`
    : `cap ${percent(account.capLimit)} now (${percent(curve.early)}→${percent(curve.late)})`;
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
  const slots = quotaSlots(account);
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
        aria-label={`Reorder ${account.label}`}
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
          aria-label={`Open ${account.label}`}
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
                <SettingsBadge>Reserve</SettingsBadge>
              ) : null}
              {current ? <SettingsBadge>Current</SettingsBadge> : null}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground/75">
              <span className="inline-flex shrink-0 items-center gap-1.5">
                <span className={cn("size-1.5 rounded-full", status.dot)} />
                {status.label}
              </span>
              {account.lastUsedAt === null ? null : (
                <span>used {relative(account.lastUsedAt)}</span>
              )}
              {cap === null ? null : <span>{cap}</span>}
              {refreshing ? <span>refreshing usage…</span> : null}
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
              aria-label={`${account.label} actions`}
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
              {account.enabled ? "Disable" : "Enable"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("priority")}
            >
              <Icon name="ListView" />
              Set priority…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("role")}
            >
              <Icon name="ListView" />
              Set role…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("cap")}
            >
              <Icon name="ListView" />
              Set weekly cap…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={pending}
              onSelect={() => onAction("refresh")}
            >
              <Icon name="RotateCcw" />
              Refresh usage
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={pending}
              onSelect={() => onAction("remove")}
            >
              <Icon name="Trash2" />
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label={`Open ${account.label} details`}
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
          Add account
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
              Sign in to {provider === "claude" ? "Claude" : "Codex"}
            </span>
            <span className="block text-xs text-muted-foreground">
              {provider === "claude"
                ? "Opens claude.ai, paste the code back"
                : "Opens ChatGPT with a device code"}
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="items-start py-2"
          onSelect={() => onChoose("import")}
        >
          <Icon name="Download" className="mt-0.5" />
          <span>
            <span className="block">Import from this machine</span>
            <span className="block text-xs text-muted-foreground">
              Copies the server host&apos;s{" "}
              {provider === "claude" ? "~/.claude" : "Codex"} login
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
                <span className="block">Add API key…</span>
                <span className="block text-xs text-muted-foreground">
                  Metered fallback, never routes first
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
    <div className="flex gap-1.5" aria-label={`Step ${step} of 3`}>
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
}: {
  label: string;
  quota: FamilyQuota | null;
  threshold: number;
}) {
  const utilization = quota?.utilization ?? null;
  return (
    <div className="grid grid-cols-[7rem_1fr] items-center gap-3 text-sm">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0">
        <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full",
              utilization !== null && utilization >= 1
                ? "bg-destructive"
                : utilization !== null && utilization >= threshold - 0.1
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
          · will be skipped at {Math.round(threshold * 100)}%
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
          aria-label="Codex user code"
        >
          {userCode}
        </span>
        <Button
          type="button"
          variant="ghost"
          aria-label="Copy Codex sign-in code"
          className="col-start-3 size-11 justify-self-start text-muted-foreground hover:text-foreground sm:size-9"
          onClick={copy}
        >
          <Icon name={copyState === "copied" ? "Check" : "Copy"} />
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copyState === "copied"
          ? "Sign-in code copied"
          : copyState === "manual"
            ? "Your browser blocked copying. The code is selected; copy it manually."
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
          aria-label={`${name} authorization URL`}
        />
        <Button
          variant="outline"
          className="shrink-0"
          aria-label={`Copy ${name} authorization URL`}
          onClick={copy}
        >
          {copyState === "copied" ? "Copied" : "Copy"}
        </Button>
        <Button className="shrink-0" onClick={() => openUrl(url)}>
          Open
        </Button>
      </div>
      <span aria-live="polite" className="sr-only">
        {copyState === "copied"
          ? "Authorization URL copied"
          : copyState === "manual"
            ? "Your browser blocked copying. The URL is selected; copy it manually."
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
          <span className="sr-only">Close</span>
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
    switchThreshold: "",
  });
  const [configErrors, setConfigErrors] = useState<
    Record<ConfigField, string | null>
  >({
    anthropicUpstreamBaseUrl: null,
    codexUpstreamBaseUrl: null,
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
  const [restDraft, setRestDraft] = useState("");
  const [routingError, setRoutingError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const mounted = useRef(true);
  const threshold =
    config?.switchThreshold ?? DEFAULT_ACCOUNT_POOL_CONFIG.switchThreshold;
  const applyConfig = useCallback((next: AccountPoolConfig) => {
    setConfig(next);
    setDrafts(configDrafts(next));
    setDrainDraft(String(next.reserveDrainHours));
    setRestDraft(next.restDays.join(","));
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
          switchThreshold: "Must be greater than 0 and at most 1.",
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
      setRoutingError("Drain hours must be greater than 0 and at most 168.");
      return;
    }
    if (value === config.reserveDrainHours) return;
    await saveRouting({ reserveDrainHours: value });
  }
  async function saveRestDays(): Promise<void> {
    if (config === null) return;
    const raw = restDraft.trim();
    const days =
      raw === "" || raw === "none"
        ? []
        : raw.split(",").map((day) => (day.trim() === "" ? NaN : Number(day)));
    if (
      days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
      new Set(days).size !== days.length
    ) {
      setRoutingError(
        "Rest days must be unique weekday numbers from 0 (Sunday) to 6.",
      );
      return;
    }
    if (days.join(",") === config.restDays.join(",")) return;
    await saveRouting({ restDays: days });
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
    "no machines";
  const parent = status?.parent ?? null;
  const proxying = parent !== null && parent.mode === "proxy";
  const currentLabel = (provider: PoolProvider): string => {
    const id = status?.activeAccounts[provider] ?? null;
    return accounts.find((account) => account.id === id)?.label ?? "none";
  };
  const currentId = (provider: PoolProvider): string | null =>
    status?.activeAccounts[provider] ?? null;
  return (
    <div className="w-full space-y-6">
      {parent === null ? null : (
        <div className="rounded-lg border border-border px-4 py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">
                {proxying
                  ? "Using the parent Account Pooler"
                  : "Parent Account Pooler available"}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {parentBannerBody(parent)}
              </p>
            </div>
            <Switch
              checked={proxying}
              disabled={pending !== null}
              aria-label="Use the parent Account Pooler"
              onCheckedChange={(enabled) =>
                void run("parent-mode", async () => {
                  await rpc.call("config.set", {
                    parentMode: enabled ? "proxy" : "isolate",
                  });
                })
              }
            />
          </div>
        </div>
      )}
      <div
        className={proxying ? "space-y-6 opacity-50" : "space-y-6"}
        inert={proxying ? true : undefined}
      >
        <p className="text-xs text-subtle-foreground/75">
          Hub {status?.accepting ? "accepting" : "not accepting"} ·{" "}
          {status?.inFlight ?? 0} in flight · used by {hubHosts}
          {statusIsCached ? " · refreshing…" : null}
        </p>
        <p className="flex flex-wrap gap-x-3 text-xs text-subtle-foreground/75">
          {PROVIDERS.map((provider) => (
            <span key={provider.id}>
              {`Current ${provider.title}: ${currentLabel(provider.id)}`}
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
              No accounts in the pool
            </h2>
            <p className="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">
              Add a Claude or Codex account and threads on every machine will
              route through it. Your machine&apos;s own login keeps working
              until then.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={() => void startClaude()}>
                Sign in to Claude
              </Button>
              <Button size="sm" onClick={() => void startCodex()}>
                Sign in to Codex
              </Button>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              or use either provider&apos;s Add account menu to import this
              machine&apos;s login
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
                    aria-label={`Route ${provider.title} threads`}
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
                <p className="py-2.5 text-sm text-muted-foreground">Loading…</p>
              ) : providerAccounts.length === 0 ? (
                <p className="py-2.5 text-sm text-subtle-foreground">
                  No accounts yet.
                </p>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  modifiers={accountDragModifiers}
                  onDragEnd={(event) =>
                    void reorderAccounts(provider.id, event)
                  }
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
                            statusIsCached ||
                            pending === `refresh-${account.id}`
                          }
                          reorderDisabled={providerAccounts.length < 2}
                          onAction={(action) =>
                            void accountAction(account, action)
                          }
                          onOpen={() =>
                            setDialog({
                              kind: "account",
                              accountId: account.id,
                            })
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
            Routing
          </div>
          <div className="divide-y divide-border border-t border-border">
            <ConfigFieldRow
              label="Balanced routing"
              description="New conversations go to the account with the most weekly quota left before its reset. Off keeps priority order."
              error={null}
            >
              <Switch
                checked={config?.routingStrategy === "balanced"}
                disabled={config === null || pending !== null}
                aria-label="Balanced routing"
                onCheckedChange={(enabled) =>
                  void saveRouting({
                    routingStrategy: enabled ? "balanced" : "sequential",
                  })
                }
              />
            </ConfigFieldRow>
            <ConfigFieldRow
              label="Reserve drain hours"
              description="Working hours before a weekly reset when reserve accounts join primary ones."
              error={null}
            >
              <Input
                type="number"
                min="1"
                max="168"
                step="1"
                aria-label="Reserve drain hours"
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
              label="Rest days"
              description="Weekdays that do not count toward window progress, 0 is Sunday. Empty counts every day."
              error={routingError}
            >
              <Input
                aria-label="Rest days"
                placeholder="0,6"
                disabled={config === null || pending !== null}
                value={restDraft}
                onChange={(event) => {
                  setRestDraft(event.target.value);
                  setRoutingError(null);
                }}
                onBlur={() => void saveRestDays()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </ConfigFieldRow>
          </div>
        </div>
        <Collapsible className="rounded-lg border border-border px-4">
          <CollapsibleTrigger className="flex w-full items-center gap-2 py-2.5 text-sm font-medium text-foreground">
            <Icon
              name="ChevronRight"
              className="size-4 transition-transform [[data-state=open]>&]:rotate-90"
            />
            Advanced
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="divide-y divide-border border-t border-border">
              <ConfigFieldRow
                label="Anthropic upstream base URL"
                description="QA override for Anthropic traffic."
                error={configErrors.anthropicUpstreamBaseUrl}
              >
                <Input
                  aria-label="Anthropic upstream base URL"
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
                  onBlur={() =>
                    void saveConfigField("anthropicUpstreamBaseUrl")
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </ConfigFieldRow>
              <ConfigFieldRow
                label="Codex upstream base URL"
                description="QA override for ChatGPT Codex traffic."
                error={configErrors.codexUpstreamBaseUrl}
              >
                <Input
                  aria-label="Codex upstream base URL"
                  aria-invalid={
                    configErrors.codexUpstreamBaseUrl === null
                      ? undefined
                      : true
                  }
                  disabled={config === null || pending !== null}
                  value={drafts.codexUpstreamBaseUrl}
                  onChange={(event) =>
                    updateConfigDraft(
                      "codexUpstreamBaseUrl",
                      event.target.value,
                    )
                  }
                  onBlur={() => void saveConfigField("codexUpstreamBaseUrl")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              </ConfigFieldRow>
              <ConfigFieldRow
                label="Quota switch threshold"
                description="Stop selecting an account at this quota fraction."
                error={configErrors.switchThreshold}
              >
                <Input
                  type="number"
                  min="0.01"
                  max="1"
                  step="0.01"
                  aria-label="Quota switch threshold"
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
                  <div className="text-sm text-foreground">Machine tokens</div>
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
                      Rotate {host.hostName ?? host.hostId}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
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
            close={closeDialog}
            act={(action) => void accountAction(selectedAccount, action)}
          />
        ) : null}
        {dialog?.kind === "priority" && selectedAccount !== null ? (
          <DialogFrame
            title="Set priority"
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
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
                  Save
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Lower numbers come first in the failover order. Ties follow the
              order accounts were added. Existing conversations stay pinned.
            </p>
            <Input
              type="number"
              aria-label="Account priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </DialogFrame>
        ) : null}
        {dialog?.kind === "role" && selectedAccount !== null ? (
          <DialogFrame
            title="Set role"
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
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
                  Save
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Primary accounts take traffic normally. Reserve accounts are used
              only when no primary account is eligible or close to their weekly
              reset, and always stay under their weekly cap.
            </p>
            <div className="flex gap-2">
              {(["primary", "reserve"] as const).map((role) => (
                <Button
                  key={role}
                  variant={roleDraft === role ? undefined : "outline"}
                  aria-pressed={roleDraft === role}
                  onClick={() => setRoleDraft(role)}
                >
                  {role === "primary" ? "Primary" : "Reserve"}
                </Button>
              ))}
            </div>
          </DialogFrame>
        ) : null}
        {dialog?.kind === "cap" && selectedAccount !== null ? (
          <DialogFrame
            title="Set weekly cap"
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
                  Remove cap
                </Button>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
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
                  Save
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              The pool leaves this account alone once its weekly usage reaches a
              limit that rises from the week-start value to the reset value over
              working time. Use fractions from 0 to 1.
              {selectedAccount.cap === null && selectedAccount.role === "reserve"
                ? " Reserve accounts use 0.15 to 0.98 until you set a cap."
                : ""}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="number"
                min="0"
                max="1"
                step="0.01"
                aria-label="Cap at week start"
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
                aria-label="Cap at reset"
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
            title="Add an Anthropic API key"
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
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
                  Add API key
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              Metered fallback stored in the Account Pooler&apos;s protected
              secret directory.
            </p>
            <Input
              type="password"
              autoComplete="off"
              aria-label="Anthropic API key"
              placeholder="sk-ant-…"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </DialogFrame>
        ) : null}
        {dialog?.kind === "remove" && selectedAccount !== null ? (
          <DialogFrame
            title={`Remove ${selectedAccount.label}?`}
            footer={
              <>
                <span className="flex-1" />
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
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
                  Remove
                </Button>
              </>
            }
          >
            <p className="text-sm text-muted-foreground">
              This deletes the account&apos;s secret file. Threads fall back to
              their machine login when no other pooled account is available.
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

function AccountDialog({
  account,
  threshold,
  close,
  act,
}: {
  account: AccountSummary;
  threshold: number;
  close: () => void;
  act: (action: "toggle" | "refresh" | "remove") => void;
}) {
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
            {account.enabled ? "Disable" : "Enable"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => act("refresh")}>
            Refresh usage
          </Button>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive-text"
            onClick={() => act("remove")}
          >
            Remove
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2">
        <SettingsBadge>{tier(account)}</SettingsBadge>
        <SettingsBadge>
          {statusPresentation(account, threshold).label}
        </SettingsBadge>
      </div>
      <div className="space-y-4">
        {account.provider === "codex" ? (
          account.limitWindows.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No usage limits observed yet.
            </div>
          ) : (
            account.limitWindows.map((window) => (
              <QuotaDetail
                key={window.slot}
                label={windowLongLabel(window)}
                quota={window}
                threshold={threshold}
              />
            ))
          )
        ) : (
          <>
            <QuotaDetail
              label="5 hour"
              quota={shared(
                account.fiveHourUtilization,
                account.fiveHourResetAt,
                account.fiveHourStatus,
              )}
              threshold={threshold}
            />
            <QuotaDetail
              label="7 day"
              quota={shared(
                account.sevenDayUtilization,
                account.sevenDayResetAt,
                account.sevenDayStatus,
              )}
              threshold={threshold}
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
                    />,
                  ],
            )}
          </>
        )}
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 border-t border-border pt-4 text-sm">
        {account.email === null ? null : (
          <>
            <dt className="text-muted-foreground">Email</dt>
            <dd className="break-all">{account.email}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Kind</dt>
        <dd>
          {account.kind === "oauth"
            ? `OAuth · ${account.provider === "claude" ? "claude.ai" : "ChatGPT"}`
            : "API key"}
        </dd>
        <dt className="text-muted-foreground">Priority</dt>
        <dd>{account.priority}</dd>
        <dt className="text-muted-foreground">Last used</dt>
        <dd>
          {account.lastUsedAt === null
            ? "Never"
            : `${relative(account.lastUsedAt)}${account.lastUsedHostName === null ? "" : ` · ${account.lastUsedHostName}`}`}
        </dd>
        <dt className="text-muted-foreground">Usage refreshed</dt>
        <dd>
          {account.observedAt === null ? "Never" : relative(account.observedAt)}
        </dd>
        {providerId === null || providerId === undefined ? null : (
          <>
            <dt className="text-muted-foreground">Account id</dt>
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
      title={`Sign in to ${name}`}
      className="sm:max-w-xl"
      footer={
        loginDone !== null ? (
          <>
            <span className="flex-1" />
            <Button variant="outline" onClick={restart}>
              Add another
            </Button>
            <Button onClick={close}>Done</Button>
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
              Complete
            </Button>
          </>
        ) : null
      }
    >
      <StepIndicator step={loginDone === null ? 2 : 3} />
      {loginDone !== null ? (
        <div>
          <h3 className="text-base font-semibold">Connected {loginDone}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {name} threads on every machine now route through this account.
            Usage refreshes in the background.
          </p>
        </div>
      ) : url === undefined ? (
        provider === "codex" && error !== null ? (
          <div className="space-y-3">
            <p className="text-sm text-destructive-text">{error}</p>
            <Button variant="outline" onClick={restart}>
              Try again
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Starting sign-in…</p>
        )
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {provider === "claude"
              ? "Sign in at claude.ai, then paste the code from the final page."
              : "Open the verification page, sign in to ChatGPT, and enter this code."}
          </p>
          {codexStep === null ? null : (
            <UserCodeBlock userCode={codexStep.userCode} />
          )}
          <AuthorizationUrlRow name={name} url={url} openUrl={openUrl} />
          {provider === "claude" ? (
            <Input
              aria-label="Claude authorization code"
              placeholder="Paste code#state here"
              value={pastedCode}
              onChange={(event) => setPastedCode(event.target.value)}
            />
          ) : (
            <p className="text-center text-sm text-muted-foreground">
              Waiting for you to authorize… expires in{" "}
              {Math.floor(countdown / 60)}:
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
