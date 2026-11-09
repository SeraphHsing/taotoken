import test, { beforeEach } from "node:test"
import assert from "node:assert/strict"
import { _internal, TaoTokenAuthPlugin } from "../index.mjs"

const { windowsOf, toISO, readUsage, isNum } = _internal

beforeEach(() => {
  delete globalThis.fetch
})

// mirror of the real /v1/plan/overview answer (user looked up on 2026-11-10)
const FIXTURE = {
  code: 200,
  data: {
    codingPlan: {
      supportModels: ["deepseek_for_coding", "glm_for_coding"],
      subscriptions: [
        {
          id: 12367,
          goodsId: "coding_plan_quarter_pro",
          planKind: "coding",
          planTier: "pro_quarter",
          showPlanTier: "Pro季卡",
          periodStart: "2026-11-08 23:24:32",
          periodEnd: "2027-02-08 23:24:32",
        },
      ],
      buckets: [
        { quotaCode: "1_month", used: 417, quotaLimit: 42000, startTime: "2026-11-08 23:24:32", endTime: "2026-12-08 23:24:32", usagePercent: 0.99 },
        { quotaCode: "1_week", used: 417, quotaLimit: 15000, startTime: "2026-11-08 23:24:32", endTime: "2026-11-15 23:24:32", usagePercent: 2.78 },
        { quotaCode: "5_hour", used: 417, quotaLimit: 3000, startTime: "2026-11-10 13:00:00", endTime: "2026-11-10 18:00:00", usagePercent: 13.9 },
      ],
    },
  },
}

test("windowsOf: 三档 quotaCode 映射成 5h/本周/本月，且 5 小时排最前", () => {
  const windows = windowsOf(FIXTURE.data.codingPlan.buckets) // 入参顺序 month, week, 5_hour
  assert.equal(windows.length, 3)
  assert.deepEqual(
    windows.map((w) => w.name),
    ["5 小时", "本周", "本月"],
  )
  const [five, week, mon] = windows

  assert.equal(five.name, "5 小时")
  assert.equal(five.amount, 417)
  assert.equal(five.limit, 3000)
  assert.equal(five.unit, "次")
  assert.equal(five.display, "417 / 3000 次")
  assert.equal(five.used, 13.9)
  assert.equal(five.span, 5 * 3600)
  assert.equal(five.resetsAt, "2026-11-10T10:00:00.000Z") // 北京时间 18:00 → UTC 10:00，任何时区机器恒成立

  assert.equal(week.name, "本周")
  assert.equal(week.used, 2.78)
  assert.equal(week.span, 7 * 86400)

  assert.equal(mon.name, "本月")
  assert.equal(mon.used, 0.99)
  assert.equal(mon.span, 30 * 86400)
})

test("windowsOf: used 非数字/limit 为 0 的 bucket 被丢弃；未知 quotaCode 原样显示", () => {
  const windows = windowsOf([
    { quotaCode: "1_week", used: 12, quotaLimit: 100, usagePercent: 12 },
    { quotaCode: "X_other", used: 5, quotaLimit: 10, usagePercent: 50 },
    { quotaCode: "bad", used: "n/a", quotaLimit: 10 },
    { quotaCode: "zero", used: 0, quotaLimit: 0, usagePercent: 5 },
    null,
    { quotaCode: "empty", quotaLimit: 10, used: undefined },
  ])
  assert.equal(windows.length, 2)
  assert.equal(windows[0].name, "本周")
  assert.equal(windows[1].name, "X_other") // 未知 code 兜底用原名
})

test("windowsOf: 空数组与 null 返回 []", () => {
  assert.deepEqual(windowsOf([]), [])
  assert.deepEqual(windowsOf(undefined), [])
  assert.deepEqual(windowsOf(null), [])
})

test("toISO: 无时区时间按北京时间 +08 解析，其他格式直通，非法值 undefined", () => {
  assert.equal(toISO("2026-11-15 23:24:32"), "2026-11-15T15:24:32.000Z")
  assert.equal(toISO("2026-11-15T23:24:32Z"), "2026-11-15T23:24:32.000Z")
  assert.equal(toISO(""), undefined)
  assert.equal(toISO("not-a-date"), undefined)
  assert.equal(toISO(undefined), undefined)
  assert.equal(toISO(0), undefined)
})

test("isNum: 只有有限数字为 true", () => {
  assert.equal(isNum(1), true)
  assert.equal(isNum(0), true)
  assert.equal(isNum("1"), false)
  assert.equal(isNum(NaN), false)
  assert.equal(isNum(undefined), false)
  assert.equal(isNum(Infinity), false)
})

// —— readUsage ——

const JWT = "eyJhbGciOiJIUzI1NiJ9.payload.signature"
let fetchCalls = []

function mockOk() {
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    return new Response(JSON.stringify(FIXTURE), { status: 200, headers: { "content-type": "application/json" } })
  }
}
function mockFail(status, json = {}) {
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    return new Response(JSON.stringify(json || { status, error: "err" }), { status })
  }
}

const getAuth = (jwt = JWT) => async () => ({ type: "api", key: "sk-test", metadata: { loginToken: jwt } })
const getAuthNoJwt = () => async () => ({ type: "api", key: "sk-test", metadata: {} })

test("readUsage: 未填用量令牌 → error + 空 windows，不发请求", async () => {
  fetchCalls = []
  mockFail(500)
  const out = await readUsage(getAuthNoJwt())
  assert.match(out.error, /用量令牌/)
  assert.deepEqual(out.windows, [])
  assert.equal(fetchCalls.length, 0)
})

test("readUsage: 200 真实结构 → plan/windows/until 正确，Authorization 用裸 JWT", async () => {
  fetchCalls = []
  mockOk()
  const out = await readUsage(getAuth())
  assert.equal(out.plan, "Pro季卡")
  assert.equal(out.until, "2027-02-08T15:24:32.000Z")
  assert.equal(out.windows.length, 3)
  const c = fetchCalls[0]
  assert.match(String(c.url), /\/v1\/plan\/overview$/)
  assert.equal(c.init.headers.Authorization, JWT)
  assert.equal(c.init.headers["x-auth-type"], "taotoken")
})

test("readUsage: 401 → 明确指出令牌过期；429/5xx → 提示服务不可用；403 → 原样状态码", async () => {
  fetchCalls = []
  mockFail(401, { status: 401, error: "Unauthorized" })
  assert.match((await readUsage(getAuth())).error, /已过期或无效/)

  mockFail(503)
  assert.match((await readUsage(getAuth())).error, /暂时不可用/)

  mockFail(403)
  assert.match((await readUsage(getAuth())).error, /HTTP 403/)
})

test("readUsage: 网络错误 → error + 空 windows，且每次都重新请求", async () => {
  fetchCalls = []
  globalThis.fetch = async () => {
    fetchCalls.push(1)
    throw new Error("ECONNRESET")
  }
  const out = await readUsage(getAuth())
  assert.match(out.error, /网络错误/)
  assert.deepEqual(out.windows, [])

  await readUsage(getAuth()) // 无缓存：每一次调用都会重试请求
  assert.equal(fetchCalls.length, 2)
})

test("readUsage: 无 codingPlan buckets → error", async () => {
  fetchCalls = []
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ code: 200, data: { codingPlan: { subscriptions: [] } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  const out = await readUsage(getAuth())
  assert.match(out.error, /没有生效/)
  assert.deepEqual(out.windows, [])
})

// —— loader / provider.models（契约核心路径）——

test("loader: 有 key → baseURL/apiKey；无 key / 非 api 登录 → 空对象", async () => {
  const plugin = await TaoTokenAuthPlugin({ client: {} }, {})
  assert.deepEqual(await plugin.auth.loader(async () => ({ type: "api", key: "sk-x" })), {
    baseURL: "https://api.taotoken.net/coding/v1",
    apiKey: "sk-x",
    headers: {},
  })
  assert.deepEqual(await plugin.auth.loader(async () => ({ type: "api", key: "" })), {})
  assert.deepEqual(await plugin.auth.loader(async () => null), {})
})

test("provider.models: 登录后拉取 → 覆盖模型表；失败/未登录 → 原样返回", async () => {
  const plugin = await TaoTokenAuthPlugin({ client: {} }, {})
  const cfg = {}
  await plugin.config(cfg)
  const provider = cfg.provider.taotoken
  const baseModels = provider.models

  // 未登录（auth undefined）→ 返回原列表
  assert.equal(await plugin.provider.models(provider, {}), baseModels)

  // 登录且接口 200 → 用线上模型覆盖
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: "glm-5.3-flash", name: "GLM-5.3-Flash", context_length: 2000000 },
          { id: "brand-new", name: "brand-new", context_length: 1000000 },
          { id: "deepseek-flash", name: "deepseek-flash", context_length: 1000000 },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  const fetched = await plugin.provider.models(provider, { auth: { type: "api", key: "sk-x" } })
  assert.ok(fetched["glm-5.3-flash"])
  assert.equal(fetched["glm-5.3-flash"].limit.context, 2_000_000) // 线上拉取的 context 覆盖静态值
  assert.ok(fetched["brand-new"])
  assert.ok(fetched["brand-new"].tool_call)

  // 接口 500 → 回退原始 provider.models（未覆盖）
  globalThis.fetch = async () => new Response("boom", { status: 500 })
  assert.equal(await plugin.provider.models(provider, { auth: { type: "api", key: "sk-x" } }), baseModels)
})