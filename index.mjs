// TaoToken CodingPlan, as an OpenCode / magpie provider plugin.
//
// Two credentials, one account:
//   • API key (sk-…)      — the coding gateway's models, calls via
//                           https://api.taotoken.net/coding/v1 (OpenAI-compatible).
//   • login token (JWT)   — the console's CodingPlan usage, read from
//                           GET https://taotoken.net/api/v1/plan/overview.
//                           It is the value of the `token` cookie when signed
//                           in at taotoken.net (Browser DevTools → Application
//                           → Cookies → token). Works as `Authorization` JWT.
//
// Usage is read along magpie's own refresh: magpie calls usage() whenever
// its overview asks, and the plugin answers from taotoken each time.

const PROVIDER = "taotoken"
const NAME = "TaoToken"
const CODING_BASE = "https://api.taotoken.net/coding/v1" // OpenAI-compatible
const WEB_API = "https://taotoken.net/api" // console API (usage)
const SDK = "@ai-sdk/openai-compatible"
const ICON = "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTUyIiBoZWlnaHQ9IjE0NSIgdmlld0JveD0iMCAwIDE1MiAxNDUiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxwYXRoIGQ9Ik04MyA3M0M4MyA3Ni44NjYgNzkuODY2IDgwIDc2IDgwQzcyLjEzNCA4MCA2OSA3Ni44NjYgNjkgNzNDNjkgNjkuMTM0IDcyLjEzNCA2NiA3NiA2NkM3OS44NjYgNjYgODMgNjkuMTM0IDgzIDczWiIgZmlsbD0iIzRGNDZFNSIvPgo8cGF0aCBkPSJNMCA4My42ODEzVjExN0wyMCA5N0g1OC41QzYwLjcwOTEgOTcgNjIuNSA5OC43OTA5IDYyLjUgMTAxVjEyOUwzOC4zMTM1IDE0NUg3NkgxMTMuNjg3TDg5LjUgMTI5VjEwMUM4OS41IDk4Ljc5MDkgOTEuMjkwOSA5NyA5My41IDk3SDEzMkwxNTIgMTE3VjgzLjY4MTNDMTUyIDc4LjgyNzcgMTQ3LjcxMyA3NS4wOTIzIDE0Mi45MDUgNzUuNzU2NUw3NiA4NUw5LjA5NDg2IDc1Ljc1NjVDNC4yODY5NyA3NS4wOTIzIDAgNzguODI3NyAwIDgzLjY4MTNaIiBmaWxsPSIjNEY0NkU1Ii8+CjxwYXRoIGQ9Ik03NiAwSDM4LjMxMzVMNjIuNSAxNlY0NEM2Mi41IDQ2LjIwOTEgNjAuNzA5MSA0OCA1OC41IDQ4SDIwTDAgMjhWNjEuMzE4N0MwIDY2LjE3MjMgNC4yODY5NyA2OS45MDc3IDkuMDk0ODYgNjkuMjQzNUw3NiA2MEwxNDIuOTA1IDY5LjI0MzVDMTQ3LjcxMyA2OS45MDc3IDE1MiA2Ni4xNzIzIDE1MiA2MS4zMTg3VjI4TDEzMiA0OEg5My41QzkxLjI5MDkgNDggODkuNSA0Ni4yMDkxIDg5LjUgNDRWMTZMMTEzLjY4NyAwSDc2WiIgZmlsbD0iIzRGNDZFNSIvPgo8L3N2Zz4K"

// Models the Coding gateway is known to serve; login replaces the list.
const MODELS = [
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", context: 1_000_000 },
  { id: "deepseek-flash", name: "deepseek-flash", context: 1_000_000 },
]

// window names and lengths per the plan's quota buckets
const WINDOWS = {
  "5_hour": { name: "5 小时", span: 5 * 3600 },
  "1_week": { name: "本周", span: 7 * 86400 },
  "1_month": { name: "本月", span: 30 * 86400 },
}

// taotoken dares local wall-clock strings ("2026-11-15 23:24:32", Asia/Shanghai).
// Parse them explicitly as +08:00 so the card is right on any machine.
const toISO = (s) => {
  if (!s) return undefined
  const str = String(s)
  const fixed =
    /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(str) ? str.replace(" ", "T") + "+08:00" : str
  const d = new Date(fixed)
  return Number.isNaN(d.valueOf()) ? undefined : d.toISOString()
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v)

// magpie's account row renders the first two windows only, so the short
// 5-hour window must come first: 5 hour → week → month (unknown kinds last).
const WINDOW_ORDER = { "5_hour": 0, "1_week": 1, "1_month": 2 }

// buckets → magpie windows
const windowsOf = (buckets) =>
  (buckets ?? [])
    .filter((b) => b && isNum(b.used) && isNum(b.quotaLimit) && b.quotaLimit > 0)
    .sort((a, b) => (WINDOW_ORDER[a.quotaCode] ?? 9) - (WINDOW_ORDER[b.quotaCode] ?? 9))
    .map((b) => {
      const meta = WINDOWS[b.quotaCode] ?? {}
      const percent = isNum(b.usagePercent) ? b.usagePercent : (b.used / b.quotaLimit) * 100
      return {
        name: meta.name ?? b.quotaCode ?? "usage",
        used: percent,
        amount: b.used,
        limit: b.quotaLimit,
        unit: "次",
        display: `${b.used} / ${b.quotaLimit} 次`,
        resetsAt: toISO(b.endTime),
        span: meta.span,
      }
    })

const errorOf = (status) =>
  status === 401
    ? "用量令牌已过期或无效，请重新登录 taotoken 并复制新的 Cookie token 值。"
    : status === 429 || status >= 500
      ? `taotoken 用量服务暂时不可用（HTTP ${status}），请稍后再试。`
      : `taotoken 用量接口 HTTP ${status}。`

// the read itself; usage() is a thin wrapper with error mapping
async function readUsage(getAuth) {
  const auth = await getAuth()
  const jwt = auth?.metadata?.loginToken
  if (!jwt) {
    return {
      error:
        "未填 CodingPlan 用量令牌。登录 taotoken.net 后，在开发者工具 → 应用 → Cookie → taotoken.net 复制 token 的值，重登时粘到“用量令牌”。",
      windows: [],
    }
  }

  let res
  try {
    res = await fetch(`${WEB_API}/v1/plan/overview`, {
      headers: { Authorization: jwt, "x-auth-type": "taotoken", "Content-Type": "application/json" },
    })
  } catch (e) {
    return { error: `网络错误，无法读取 taotoken 用量：${e?.message ?? e}`, windows: [] }
  }
  if (!res.ok) {
    return { error: errorOf(res.status), windows: [] }
  }
  let body
  try {
    body = await res.json()
  } catch {
    return { error: "taotoken 用量接口返回了无法解析的内容", windows: [] }
  }
  const cp = body?.data?.codingPlan
  const subs = cp?.subscriptions?.[0]
  const buckets = cp?.buckets
  if (!Array.isArray(buckets) || !buckets.some((b) => isNum(b.used))) {
    return { error: "当前账号没有生效的 CodingPlan 用量", windows: [] }
  }
  return {
    plan: subs?.showPlanTier ?? cp?.planLabel ?? "CodingPlan",
    until: toISO(subs?.periodEnd),
    windows: windowsOf(buckets),
  }
}

// —— the plugin ——

export const TaoTokenAuthPlugin = async () => ({
  // the provider and its models before anyone signs in
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: NAME,
      npm: SDK,
      api: CODING_BASE,
      models: Object.fromEntries(
        MODELS.map((m) => [
          m.id,
          { name: m.name, id: m.id, limit: { context: m.context }, tool_call: true },
        ]),
      ),
    }
  },

  auth: {
    provider: PROVIDER,
    icon: ICON,
    methods: [
      {
        type: "api",
        label: "TaoToken CodingPlan API key",
        placeholder: "sk-…",
        prompts: [
          {
            type: "password",
            key: "loginToken",
            message: "CodingPlan 用量令牌（选填）— taotoken.net 登录后复制 Cookie 里 token 的值；不填则用量卡片不可用",
          },
        ],
      },
    ],

    // model requests: Bearer API key to the coding gateway
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      return { baseURL: CODING_BASE, apiKey: auth.key, headers: {} }
    },

    // the usage card: CodingPlan 5h / week / month, taotoken's fresh answer each ask
    async usage(getAuth) {
      try {
        return await readUsage(getAuth)
      } catch (e) {
        return { error: e?.message ?? String(e), windows: [] }
      }
    },
  },

  // the account's own model list, when signed in
  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      if (auth?.type !== "api" || !auth.key) return provider.models
      let data
      try {
        const res = await fetch(`${CODING_BASE}/models`, {
          headers: { authorization: `Bearer ${auth.key}` },
        })
        if (!res.ok) return provider.models
        const json = await res.json()
        if (!Array.isArray(json?.data) || !json.data.length) return provider.models
        data = json.data
      } catch {
        return provider.models
      }
      const base = provider.models ?? {}
      return Object.fromEntries(
        data.map((m) => {
          const b = base[m.id] ?? {}
          const context = isNum(m.context_length) ? m.context_length : b.limit?.context
          return [
            m.id,
            {
              ...b,
              id: m.id,
              name: m.name ?? m.id,
              limit: { ...(b.limit ?? {}), context },
              tool_call: true,
            },
          ]
        }),
      )
    },
  },
})

// for the unit tests
export const _internal = { MODELS, WINDOWS, windowsOf, readUsage, toISO, isNum, errorOf }