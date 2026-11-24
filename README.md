# AirSIM 自建 Relay

这套服务让已配对的安卓手机与 iPhone 交换通话、短信事件和控制命令。双方也可以通过 WebSocket 中继通话音频。Relay 运行在自己的 Linux 服务器上，设备状态由本机 workerd 持久化，iPhone 的普通通知和 PushKit 来电由独立的 Node.js 服务通过 HTTP/2 发往 Apple。

仓库保留了 AirSIM 的设备注册、心跳、命令去重、媒体会话和设备列表分页逻辑。对外入口可接到现有反向代理或隧道。workerd 在本机运行，无需 Cloudflare 账户。

| 路径 | 内容 |
| --- | --- |
| `push-relay-worker/src/` | Relay 协议、设备状态、命令和媒体路由 |
| `push-relay-worker/self-hosted/` | workerd 配置生成器、本地存储适配、APNs 证书代理、systemd 单元及测试 |

## 本机测试

准备 Node.js 22、npm 和 OpenSSL 后，从仓库根目录运行以下命令。测试使用临时数据和测试证书。

```sh
cd push-relay-worker/self-hosted
npm ci
npm test
```

实际部署还需要苹果签发的 APNs Provider 证书、与证书配套的私钥、授权的 Bundle ID 和自己的管理令牌。部署入口、端口和验收命令见[自建部署指南](push-relay-worker/self-hosted/README.md)，申请证书和启用到期提醒见[APNs 证书配置](push-relay-worker/self-hosted/APNS-CERTIFICATE-DEPLOYMENT.md)。

## 来源与许可

本仓库是基于 AirSIM 的个人自建衍生版本。AirSIM 源码按 PolyForm Noncommercial License 1.0.0 授权，保留原项目署名；workerd 和测试依赖 ws 分别沿用 Apache-2.0 和 MIT 许可。详见[上游 AirSIM](https://github.com/kai-wu-cortex/AirSIM)、[项目许可](LICENSE)、[上游署名](NOTICE)和[第三方声明](THIRD_PARTY_NOTICES.md)。
