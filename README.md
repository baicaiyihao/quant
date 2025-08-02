# 量化

## 运行环境&部署

本机环境需要安装

1. 安装`node.js` [>安装Node链接](https://nodejs.org/zh-cn/download/package-manager)
2. 执行`npm install -g typescript`
3. 需要使用一个稳定的RPC节点，不要使用默认的，那个不稳定

## 启动方式

在启动程序之前，必须先配置好配置文件，在项目路径下新建一个文件`.env`示例文件如下：

```.dotenv

# 钱包私钥 需要替换
PRIVATE_KEY="你的私钥"

# Sui节点URL，替换成你的，这里仅测试
ENDPPOINT="https://go.getblock.io/fb5b37a5687249e089aa7c21e2ea10"

# 目标交易POLL地址，仅测试，具体POOL自己筛选
POOL_ID="0x9b1a3eb1538cbb0402b009e4e2e39aecd4d97dbe80791c5c1fb6644b0bff2688"

# 默认偏移量,即在计算区间之上再加上G作为最终目标区间，设置为0即可，波动大换成其他正整数
G=0

# 策略配置参数（可选）
# 资金使用率 (0-1之间，默认0.9表示90%)
FUND_USAGE_RATE=0.9

# 最小区间倍数 (相对于tickSpacing的倍数，默认3表示3*tickSpacing)
MIN_RANGE_MULTIPLIER=90

# 滑点设置 (0-1之间，默认0.05表示5%)
SLIPPAGE=0.05

# 配平误差 (0-1之间，默认0.1表示10%)
BALANCE_ERROR=0.1
```

配置文件完成后，你需要在你的钱包中充值一部分资产，具体跟你选择的Pool有关，比如池子`A/B`，那么你需要至少任意一种资产（`A`或者`B`）不小于0。

- 使用Makefile文件启动

```shell
# Linux环境
make start
```

- 或者使用node

```shell
npm install && tsc && node dist/index.js
```

## 策略说明

程序将自动跟随价格波动进行开仓和平仓，当奖励占比小于手续费占比时，不建议使用本策略。
# 配置参数说明

## 环境变量配置

在项目根目录创建 `.env` 文件，包含以下配置：

```bash
# 必需配置
PRIVATE_KEY="你的私钥"
ENDPPOINT="https://your-sui-rpc-endpoint"
POOL_ID="目标池子地址"
G=0

# 可选策略配置
FUND_USAGE_RATE=0.9
MIN_RANGE_MULTIPLIER=3
SLIPPAGE=0.05
BALANCE_ERROR=0.1
```

## 配置参数详解

### 必需参数

- **PRIVATE_KEY**: 钱包私钥
- **ENDPPOINT**: Sui RPC节点地址
- **POOL_ID**: 目标交易池地址
- **G**: 偏移量参数，控制开仓区间的偏移

### 可选策略参数

#### FUND_USAGE_RATE (资金使用率)
- **类型**: 数值 (0-1)
- **默认值**: 0.9 (90%)
- **说明**: 控制开仓时使用的资金比例
- **示例**: 
  - `0.8` = 使用80%的资金
  - `0.95` = 使用95%的资金

#### MIN_RANGE_MULTIPLIER (最小区间倍数)
- **类型**: 数值 (>0)
- **默认值**: 3
- **说明**: 控制开仓区间的最小范围，相对于tickSpacing的倍数
- **示例**:
  - `2` = 最小区间为2*tickSpacing
  - `5` = 最小区间为5*tickSpacing

#### SLIPPAGE (滑点设置)
- **类型**: 数值 (0-1)
- **默认值**: 0.05 (5%)
- **说明**: 交易时的滑点容忍度
- **示例**:
  - `0.03` = 3%滑点
  - `0.1` = 10%滑点

#### BALANCE_ERROR (配平误差)
- **类型**: 数值 (0-1)
- **默认值**: 0.1 (10%)
- **说明**: 资产配平时的误差容忍度
- **示例**:
  - `0.05` = 5%误差
  - `0.15` = 15%误差

## 配置建议

### 保守策略
```bash
FUND_USAGE_RATE=0.8
MIN_RANGE_MULTIPLIER=5
SLIPPAGE=0.03
BALANCE_ERROR=0.05
```

### 激进策略
```bash
FUND_USAGE_RATE=0.95
MIN_RANGE_MULTIPLIER=2
SLIPPAGE=0.1
BALANCE_ERROR=0.15
```

### 平衡策略
```bash
FUND_USAGE_RATE=0.9
MIN_RANGE_MULTIPLIER=3
SLIPPAGE=0.05
BALANCE_ERROR=0.1
```

## 注意事项

1. 所有数值参数都应该是有效的数字
2. 资金使用率不应超过1.0
3. 滑点和配平误差建议保持在合理范围内
4. 最小区间倍数建议不小于1
5. 修改配置后需要重启程序才能生效 