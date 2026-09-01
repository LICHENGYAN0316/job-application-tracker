# 职序 · 多用户求职进程管理

职序是一个面向个人与小范围用户的多用户联网求职管理系统，用来管理公司、岗位、投递日期、招聘流程与下一步安排。

在线地址：[job-application-desk-lcy.plupluto.chatgpt.site](https://job-application-desk-lcy.plupluto.chatgpt.site/)

## 主要功能

- ChatGPT 或 GitHub 登录；两种身份只负责认证，数据始终按稳定账号 ID 隔离。
- 公司、岗位和招聘流程的增删改查，以及按用户隔离的云端同步。
- 可安装到手机主屏幕的 PWA。
- “职程领航 · 智能助手”支持基础助手与豆包智能模式自由切换。
- 受控 Agent Tool 支持查询、新增、修改和删除；所有写操作只生成提案，必须再次确认后才会执行。
- 公司不存在时，可先展示“创建公司并新增岗位”的组合提案；确认前不会写入任何数据。
- 管理员可以控制全局开关、普通用户额度、单用户停用状态，并查看不含岗位正文或对话正文的匿名质量指标与 Token 用量。

## 安全边界

- 豆包 API Key、GitHub OAuth Secret 和管理员稳定 ID 只保存在部署端 Secret 中。
- 模型不能直接访问数据库，只能调用服务端允许的受控 Tool。
- 查询仅限当前账号；所有写操作都经过账号校验、参数校验、二次确认、幂等校验和数据版本校验。
- 不保存完整问题与回答，只保存调用状态、Token、耗时以及匿名评估事件。
- 本仓库只包含源码和数据库结构，不包含线上 D1 用户数据或部署端 Secret。

## 本地开发

要求 Node.js 22.13 或更高版本。

```bash
npm install
npm run dev
```

完整的联网功能还需要 D1 数据库和以下服务端变量：

| 变量 | 用途 |
| --- | --- |
| `ARK_API_KEY` | 火山方舟通用 API Key，必须作为 Secret 保存 |
| `ARK_MODEL_ID` | 豆包模型完整 ID |
| `ADMIN_CHATGPT_USER_ID` | 唯一初始管理员的稳定 ChatGPT 用户 ID |
| `GITHUB_CLIENT_ID` | GitHub OAuth App Client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App Secret，必须作为 Secret 保存 |
| `PUBLIC_APP_ORIGIN` | 正式网站 Origin |

数据库迁移保存在 `drizzle/`。不要把 `.env`、`.dev.vars`、API Key、OAuth Secret、管理员 ID 或真实用户备份提交到 Git。

## 验证

```bash
npm test
npm run lint
npm run build
```

更完整的上线配置与安全检查见 `部署说明-智能助手与GitHub登录.md`。
