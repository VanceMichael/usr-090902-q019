# 国际列车旅客事件对账

本项目用于处理铁路与口岸多来源旅客事件及座位段对账。仓库内已有请求契约、确定性规则和示例数据，业务服务尚未接入。

## 目录

- `contracts/`：HTTP 请求结构约束。
- `fixtures/`：本地规则与示例请求。
- `scaffold/`：领域输入完整性检查。
- `compose.yaml`：本地容器环境。

## 本地检查

```sh
docker compose run --rm --no-deps domain-check
```

检查只读取仓库内文件，不访问外部生产系统。
