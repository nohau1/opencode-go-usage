/**
 * OpenCode Go usage — a small TUI plugin that shows the rolling 5h, weekly and
 * monthly allowance in a modal, with reset countdowns.
 *
 * Open:
 *   - click the `[Go 5%]` chip in the footer, or
 *   - press the keybind (default: alt+u), or
 *   - run `/gousage` (palette: "OpenCode Go: расход подписки").
 *
 * Close:
 *   - click the ✕ in the top-right corner, or press Esc.
 *
 * Data sources, in order:
 *   1. The OpenCode server endpoint (`client.usage.limits`, 2.2.0+) — no key
 *      needed, works with the Console sign-in and with remote servers.
 *   2. `https://opencode.ai/zen/go/v1/usage` with the Go API key taken from
 *      `OPENCODE_GO_API_KEY`, the plugin settings, or OpenCode's auth.json.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { createSignal, onCleanup, Show } from "solid-js"

import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"

const PLUGIN_ID = "opencode-go-usage"
const DEFAULT_KEYBIND = "alt+u"
const ZEN_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const DEFAULT_BAR_CELLS = 18
const DIALOG_REFRESH_MS = 20_000
const FOOTER_REFRESH_MS = 120_000
const REQUEST_TIMEOUT_MS = 12_000

type Theme = Context["theme"]

interface Options {
  /** Key that opens the modal. Set false to disable the automatic binding. */
  keybind?: string | false
  /** Width of the usage bars, in characters. */
  barCells?: number
  /** Show a clickable `[Go 5%]` chip in the home and prompt footers. */
  showFooter?: boolean
  /** How often the footer chip refreshes, in seconds. */
  refreshSeconds?: number
}

interface Meter {
  percent: number
  resetsAt: number | null
  limited: boolean
}

interface Usage {
  rolling: Meter
  weekly: Meter
  monthly: Meter
  workspace?: string
  updatedAt: number
  source: "server" | "api"
}

type RefreshResult = "ok" | "need-key" | "error"

class MissingKeyError extends Error {
  constructor() {
    super("missing key")
  }
}

class AuthError extends Error {
  constructor() {
    super("unauthorized")
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clampPercent(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(100, number))
}

/** The Zen endpoint returns ISO strings, the server endpoint returns epoch ms. */
function toMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Tolerate seconds as well as milliseconds.
    return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function meterColor(theme: Theme, meter: Meter) {
  if (meter.limited || meter.percent >= 85) return theme.text.feedback.error.base
  if (meter.percent >= 60) return theme.text.feedback.warning.base
  return theme.text.feedback.success.base
}

function renderBar(percent: number, cells: number): string {
  const filled = Math.round((clampPercent(percent) / 100) * cells)
  return "█".repeat(filled) + "░".repeat(Math.max(0, cells - filled))
}

function formatRemaining(resetsAt: number | null): string {
  if (resetsAt === null) return "—"
  const delta = resetsAt - Date.now()
  if (delta <= 0) return "сейчас"

  const totalMinutes = Math.floor(delta / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60

  if (days > 0) return `${days}д ${hours}ч`
  if (hours > 0) return `${hours}ч ${minutes}м`
  return `${Math.max(1, minutes)}м`
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function dataDirectories(): string[] {
  const directories: string[] = []
  const explicit = process.env.OPENCODE_DATA_DIR
  if (explicit) directories.push(explicit)

  const xdg = process.env.XDG_DATA_HOME
  if (xdg) directories.push(join(xdg, "opencode"))

  directories.push(join(homedir(), ".local", "share", "opencode"))
  directories.push(join(homedir(), "Library", "Application Support", "opencode"))

  if (process.env.APPDATA) directories.push(join(process.env.APPDATA, "opencode"))
  return directories
}

/**
 * Read the Go API key from OpenCode's own auth store. This is the same key
 * `opencode auth login` writes, so no extra setup is needed on a local install.
 */
function readAuthKey(): string | undefined {
  for (const directory of dataDirectories()) {
    const file = join(directory, "auth.json")
    if (!existsSync(file)) continue

    try {
      const auth = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>
      const direct = auth?.["opencode-go"]?.key ?? auth?.["opencode-go-cli"]?.key
      if (typeof direct === "string" && direct.length > 0) return direct

      for (const [id, entry] of Object.entries(auth ?? {})) {
        if (!/^opencode[-_.]?go/i.test(id)) continue
        const key = (entry as any)?.key
        if (typeof key === "string" && key.length > 0) return key
      }
    } catch {
      // A malformed or unreadable auth file is not fatal: another source may work.
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    const options = (context.options ?? {}) as Options
    const theme = context.theme
    const barCells = Number.isFinite(options.barCells)
      ? Math.min(40, Math.max(6, Math.floor(options.barCells as number)))
      : DEFAULT_BAR_CELLS
    const showFooter = options.showFooter !== false
    const keybind = options.keybind === false ? false : (options.keybind ?? DEFAULT_KEYBIND)
    const footerRefreshMs = Number.isFinite(options.refreshSeconds)
      ? Math.max(10, Math.floor(options.refreshSeconds as number)) * 1000
      : FOOTER_REFRESH_MS

    const [settings, updateSettings] = context.storage.store("settings", {
      initial: { apiKey: "" },
    })

    const [usage, setUsage] = createSignal<Usage | undefined>(undefined)
    const [error, setError] = createSignal<string | undefined>(undefined)
    const [loading, setLoading] = createSignal(false)

    let cache: Usage | undefined
    let inflight: Promise<RefreshResult> | undefined
    let dialogOpen = false
    let footerTimer: ReturnType<typeof setInterval> | undefined
    let footerSignature = ""
    let footerDisposers: Array<() => void> = []

    // ------------------------------------------------------------------ data

    function storedKey(): string | undefined {
      const value = settings.apiKey?.trim()
      return value ? value : undefined
    }

    function resolveKey(): string | undefined {
      const fromEnv = process.env.OPENCODE_GO_API_KEY?.trim()
      if (fromEnv) return fromEnv
      return storedKey() ?? readAuthKey()
    }

    function serverApiAvailable(): boolean {
      const client = context.client as any
      return typeof client?.usage?.limits === "function"
    }

    async function loadFromServer(): Promise<Usage | undefined> {
      const client = context.client as any
      const response = await client.usage.limits({ location: context.location })
      const data = response?.data
      const go = data?.go
      if (!go?.rolling || !go?.weekly || !go?.monthly) return undefined

      const meter = (input: any): Meter => ({
        percent: clampPercent(input?.percent),
        resetsAt: toMs(input?.resetsAt),
        limited: Boolean(input?.limited),
      })

      return {
        rolling: meter(go.rolling),
        weekly: meter(go.weekly),
        monthly: meter(go.monthly),
        workspace: data?.workspace?.name,
        updatedAt: Date.now(),
        source: "server",
      }
    }

    async function loadFromZen(key: string): Promise<Usage> {
      let response: Response
      try {
        response = await fetch(ZEN_USAGE_URL, {
          headers: {
            authorization: `Bearer ${key}`,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (cause) {
        throw new Error(`сеть: ${(cause as Error)?.message ?? "нет соединения"}`)
      }

      if (response.status === 401 || response.status === 403) throw new AuthError()
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const body = (await response.json()) as any
      const payload = body?.usage ?? body
      if (!payload?.rolling || !payload?.weekly || !payload?.monthly) {
        throw new Error("неожиданный ответ API")
      }

      const meter = (input: any): Meter => ({
        percent: clampPercent(input?.percent),
        resetsAt: toMs(input?.resetsAt),
        limited:
          typeof input?.status === "string"
            ? input.status !== "ok"
            : Boolean(input?.limited),
      })

      return {
        rolling: meter(payload.rolling),
        weekly: meter(payload.weekly),
        monthly: meter(payload.monthly),
        updatedAt: Date.now(),
        source: "api",
      }
    }

    async function fetchUsage(): Promise<Usage> {
      if (serverApiAvailable()) {
        try {
          const fromServer = await loadFromServer()
          if (fromServer) return fromServer
        } catch {
          // Fall through to the API-key path.
        }
      }

      const key = resolveKey()
      if (!key) throw new MissingKeyError()
      return loadFromZen(key)
    }

    async function doRefresh(): Promise<RefreshResult> {
      setLoading(true)
      try {
        const next = await fetchUsage()
        cache = next
        setUsage(next)
        setError(undefined)
        renderFooter()
        return "ok"
      } catch (cause) {
        if (cause instanceof MissingKeyError) {
          setError("Не найден API-ключ OpenCode Go.")
          return "need-key"
        }
        if (cause instanceof AuthError) {
          setError("Ключ не подошёл (401).")
          return "error"
        }
        const message = (cause as Error)?.message ?? String(cause)
        setError(`Не удалось получить данные: ${message}`)
        return "error"
      } finally {
        setLoading(false)
      }
    }

    function refresh(): Promise<RefreshResult> {
      if (inflight) return inflight
      inflight = doRefresh().finally(() => {
        inflight = undefined
      })
      return inflight
    }

    async function saveKey(key: string): Promise<void> {
      await updateSettings((draft) => {
        draft.apiKey = key
      })
      cache = undefined
      renderFooter()
      startFooterTimer()
    }

    // ---------------------------------------------------------------- footer

    function renderFooter(): void {
      if (!showFooter) return

      const data = cache
      const signature = data ? `${Math.round(data.rolling.percent)}` : ""
      if (signature === footerSignature && footerDisposers.length > 0) return

      for (const dispose of footerDisposers) {
        try {
          dispose()
        } catch {
          // already released
        }
      }
      footerDisposers = []
      footerSignature = signature
      if (!data) return

      const chip = () => (
        <text
          fg={meterColor(theme, data.rolling)}
          onMouseUp={() => void open()}
        >
          {` [Go 5ч ${Math.round(data.rolling.percent)}%] `}
        </text>
      )

      footerDisposers.push(
        context.ui.slot({ append: "home.footer.status", render: chip }),
        context.ui.slot({ append: "prompt.footer.status", render: chip }),
      )
    }

    function startFooterTimer(): void {
      if (footerTimer) return
      if (!serverApiAvailable() && !resolveKey()) return
      footerTimer = setInterval(() => {
        void refresh()
      }, footerRefreshMs)
    }

    // ----------------------------------------------------------------- modal

    function close(): void {
      dialogOpen = false
      context.ui.dialog.clear()
    }

    const MeterBlock = (props: { label: string; meter: Meter }) => {
      const color = () => meterColor(theme, props.meter)
      return (
        <box flexDirection="column" marginTop={1}>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text.base}>{props.label}</text>
            <box flexDirection="row">
              <text fg={color()}>{`${Math.round(props.meter.percent)}%`}</text>
              <text fg={theme.text.muted}>
                {`  ↻ ${formatRemaining(props.meter.resetsAt)}`}
              </text>
            </box>
          </box>
          <text fg={color()}>{renderBar(props.meter.percent, barCells)}</text>
        </box>
      )
    }

    const UsageDialog = () => {
      // The layer lives as long as the dialog component does.
      context.keymap.layer(() => ({
        mode: "global",
        priority: 100,
        commands: [
          {
            id: "opencode-go-usage.close",
            bind: "escape",
            run: () => close(),
          },
        ],
      }))

      const timer = setInterval(() => {
        void refresh()
      }, DIALOG_REFRESH_MS)
      onCleanup(() => clearInterval(timer))

      return (
        <box
          width="100%"
          flexDirection="column"
          border={["top", "right", "bottom", "left"]}
          borderColor={theme.border.base}
          backgroundColor={theme.background.raised.base}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={0}
          paddingBottom={0}
        >
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text.base} attributes={1}>
              OpenCode Go
            </text>
            <text fg={theme.text.muted} onMouseDown={() => close()}>
              {" ✕ "}
            </text>
          </box>

          <box border={["bottom"]} borderColor={theme.border.base} height={1} />

          <Show
            when={usage()}
            fallback={
              <box flexDirection="column" marginTop={1}>
                <Show
                  when={error()}
                  fallback={
                    <text fg={theme.text.muted}>
                      {loading() ? "Загрузка…" : "Нет данных"}
                    </text>
                  }
                >
                  <text fg={theme.text.feedback.error.base} wrapMode="word">
                    {error()}
                  </text>
                  <text fg={theme.text.muted} marginTop={1} wrapMode="word">
                    Ключ: opencode.ai → Console → API keys, затем /gousage key
                  </text>
                </Show>
              </box>
            }
          >
            {(data) => (
              <box flexDirection="column">
                <MeterBlock label="Скользящее 5ч" meter={data().rolling} />
                <MeterBlock label="Неделя" meter={data().weekly} />
                <MeterBlock label="Месяц" meter={data().monthly} />

                <Show when={error()}>
                  <text
                    fg={theme.text.feedback.warning.base}
                    marginTop={1}
                    wrapMode="word"
                  >
                    {error()}
                  </text>
                  <text fg={theme.text.muted} marginTop={1} wrapMode="word">
                    Сменить ключ: /gousage key
                  </text>
                </Show>

                <box flexDirection="row" justifyContent="space-between" marginTop={1}>
                  <text fg={theme.text.faint}>
                    {`обновлено ${formatTime(data().updatedAt)}`}
                  </text>
                  <text fg={theme.text.muted}>esc · ✕</text>
                </box>
              </box>
            )}
          </Show>
        </box>
      )
    }

    function showDialog(): void {
      dialogOpen = true
      context.ui.dialog.set({ size: "medium", centered: true })
      context.ui.dialog.show(
        () => <UsageDialog />,
        () => {
          dialogOpen = false
        },
      )
    }

    async function promptForKey(): Promise<string | undefined> {
      const value = await context.ui.dialog.prompt({
        title: "OpenCode Go",
        description:
          "Вставьте API-ключ OpenCode Go (opencode.ai → Console → API keys). Он сохранится локально.",
        placeholder: "sk-...",
      })
      const key = value?.trim()
      return key ? key : undefined
    }

    async function open(): Promise<void> {
      if (dialogOpen) {
        void refresh()
        return
      }

      showDialog()

      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await refresh()
        if (result !== "need-key") return

        close()
        const key = await promptForKey()
        if (!key) return

        await saveKey(key)
        showDialog()
      }
    }

    // -------------------------------------------------------------- commands

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "opencode-go-usage.show",
          title: "OpenCode Go: расход подписки",
          description: "Скользящее 5ч / неделя / месяц и время сброса",
          group: "OpenCode Go",
          bind: keybind,
          palette: true,
          slash: { name: "gousage", aliases: ["go-usage"], arguments: true },
          suggested: true,
          run: async (input) => {
            const text = (input ?? "").trim()

            if (text === "key" || text.startsWith("key ")) {
              const raw = text.slice(3).trim()
              if (raw === "reset") {
                await updateSettings((draft) => {
                  draft.apiKey = ""
                })
                cache = undefined
                context.ui.toast.show({
                  title: "OpenCode Go",
                  message: "Сохранённый ключ удалён, снова используется auth.json",
                  variant: "info",
                  duration: 3000,
                })
                return
              }

              // Never take the key from the command line: it would land in the
              // prompt history. Always use the masked prompt instead.
              const key = await promptForKey()
              if (!key) return
              await saveKey(key)
              context.ui.toast.show({
                title: "OpenCode Go",
                message: "API-ключ сохранён",
                variant: "success",
                duration: 2500,
              })
              return
            }

            await open()
          },
        },
      ],
      bindings: ["opencode-go-usage.show"],
    }))

    // ----------------------------------------------------------------- start

    void refresh().then(() => {
      startFooterTimer()
    })

    return () => {
      if (footerTimer) clearInterval(footerTimer)
      footerTimer = undefined
      for (const dispose of footerDisposers) {
        try {
          dispose()
        } catch {
          // already released
        }
      }
      footerDisposers = []
    }
  },
})
