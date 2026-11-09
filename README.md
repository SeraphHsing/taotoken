# TaoToken CodingPlan for magpie / OpenCode

`@magpie-community/opencode-taotoken-auth` — 把 [taotoken.net](https://taotoken.net) 的 CodingPlan 作为一个供应商接入 magpie（兼容 OpenCode）：

- **模型调用**：用你的 TaoToken API key（`sk-…`）访问 CodingPlan 网关 `https://api.taotoken.net/coding/v1`（OpenAI 兼容）。
- **用量卡片**：在你 magpie 的账号卡片上显示 CodingPlan 三档计次限额——**5 小时 / 本周 / 本月**（已用 / 上限 / 刷新时间），数据来自 `GET /v1/plan/overview`，需登录令牌。用量随 magpie 自身的概览/用量页刷新时机读取，每次最新数据。

## 安装

```bash
magpie plugin add ./           # 在本仓库目录下
# 或发布后: magpie plugin add @magpie-community/opencode-taotoken-auth
```

然后在 magpie 中对 `taotoken` 供应商登录（`magpie plugin login taotoken` 或应用界面）。

## 登录需要两个凭证

一个账号同时要两个凭证，填在同一个登录表单里：

| 输入框 | 用途 | 怎么拿 |
|---|---|---|
| **API key**（必填） | 模型调用 | taotoken 控制台 → [API Keys](https://taotoken.net/console/api-keys) → 创建 key（`sk-…`） |
| **用量令牌**（选填） | CodingPlan 用量卡片 | 浏览器登录 taotoken.net → `F12` → 应用(Application) → Cookie → `taotoken.net` → 复制 **`token`** 字段的值（一长串 JWT，以 `eyJ…` 开头） |

> 两个都是账号主人的秘密，magpie 只存在本机 `plugin-auth.json`（权限 600）里。用量令牌会过期；失效时插件卡片会提示 HTTP 401，重新登录即可（Auth 里复制新 token）。

## 模型

登录前默认列出（CodingPlan 网关实测）：

- `glm-5.3-flash` — GLM-5.3-Flash（context 1M）
- `deepseek-flash` — deepseek-flash（context 1M）

登录后会按你的账号从 `GET /coding/v1/models` 拉取实际模型列表覆盖；拉取失败时保留上一份。

## 常见问题

- **用量显示 "HTTP 401"**：用量令牌过期，重新登录复制新 token。
- **用量显示 "当前账号没有生效的 CodingPlan 用量"**：该账号没订阅 CodingPlan，或处于生效期之外。
- **模型请求 401**：API key 无效或被吊销，重新在控制台创建。
- **模型请求 403/404**：该模型不在你的套餐内（用 `.coding/v1/models` 列出的模型）。

## 开发

零运行时依赖（Node ≥ 18 / Bun）。入口 `index.mjs`。

```bash
npm test                              # node --test test/（本地与 UTC 时区均通过）
```

探测与调试脚本（不随包发布）：

- `scripts/probe.mjs` — 鉴权矩阵实测（`--key` / `--cookie-file`）。
- `scripts/cdp-eval.mjs`、`scripts/cdp-cookies.mjs` — 通过 CDP 复用已登录浏览器会话验证用量接口。

## License

MIT