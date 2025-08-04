# BlueQuant - Advanced RPC Load Balancer

## 功能特性

### 🚀 高级负载均衡策略
- **平滑加权轮询 (Smooth Weighted Round Robin)**: 默认策略，根据权重分配请求，避免传统加权轮询的突发性
- **轮询 (Round Robin)**: 简单的轮询分配
- **最少连接 (Least Connections)**: 选择当前连接数最少的端点
- **响应时间优先 (Response Time)**: 选择响应时间最短的端点
- **随机选择 (Random)**: 随机选择端点

### 📊 智能监控
- **实时响应时间监控**: 使用指数移动平均计算平均响应时间
- **成功率统计**: 跟踪每个端点的成功/失败率
- **健康检查**: 定期检查端点可用性
- **自动故障恢复**: 指数退避机制，自动恢复故障端点

### 🔧 配置灵活
- **权重配置**: 支持通过环境变量设置端点权重
- **策略切换**: 运行时动态切换负载均衡策略
- **详细监控**: 提供端点和整体性能指标

## 环境变量配置

### 基本配置
```bash
# 单个端点
ENDPPOINT=https://sui-mainnet.blockvision.org

# 多个端点（支持权重）
ENDPPOINT=https://sui-mainnet.blockvision.org:3
ENDPPOINT1=https://sui-mainnet-rpc.allthatnode.com:2
ENDPPOINT2=https://sui-mainnet-rpc.nodereal.io:1
```

### 权重说明
- 权重格式：`url:weight`
- 权重越高，分配到的请求越多
- 默认权重为1
- 最小权重为1

## 使用示例

### 基本使用
```typescript
import { createBalancedSuiClient } from './src/rpc-balancer';

// 使用默认策略（平滑加权轮询）
const client = createBalancedSuiClient();

// 获取账户余额
const balance = await client.getBalance({
    owner: "0x...",
    coinType: "0x2::sui::SUI"
});
```

### 指定策略
```typescript
import { createBalancedSuiClient, getRPCLoadBalancer } from './src/rpc-balancer';

// 使用响应时间优先策略
const client = createBalancedSuiClient('response_time');

// 或者动态切换策略
const balancer = getRPCLoadBalancer();
balancer.setStrategy('least_connections');
```

### 监控和状态
```typescript
import { getRPCLoadBalancer } from './src/rpc-balancer';

const balancer = getRPCLoadBalancer();

// 获取详细状态
const status = balancer.getStatus();
console.log('Load Balancer Status:', status);

// 获取性能指标
const metrics = balancer.getMetrics();
console.log('Performance Metrics:', metrics);
```

## 负载均衡策略详解

### 1. 平滑加权轮询 (weighted_round_robin)
- **算法**: 平滑加权轮询算法，避免传统加权轮询的突发性
- **适用场景**: 端点性能差异较大，需要按权重分配负载
- **优势**: 分配更均匀，避免突发流量

### 2. 轮询 (round_robin)
- **算法**: 简单的轮询分配
- **适用场景**: 端点性能相近，需要均匀分配
- **优势**: 实现简单，分配均匀

### 3. 最少连接 (least_connections)
- **算法**: 选择当前请求数最少的端点
- **适用场景**: 端点处理能力差异较大
- **优势**: 负载分配更均衡

### 4. 响应时间优先 (response_time)
- **算法**: 选择平均响应时间最短的端点
- **适用场景**: 对响应时间敏感的应用
- **优势**: 优先使用性能最好的端点

### 5. 随机选择 (random)
- **算法**: 随机选择端点
- **适用场景**: 简单的负载分散
- **优势**: 实现简单，避免热点

## 监控指标

### 端点状态
```typescript
{
  url: string,
  isActive: boolean,
  isHealthy: boolean,
  weight: number,
  currentWeight: number,
  failureCount: number,
  backoffDelay: number,
  responseTime: number,
  successRate: string,
  totalRequests: number,
  successCount: number,
  timeSinceLastFailure: number | null
}
```

### 整体指标
```typescript
{
  avgResponseTime: number,
  totalRequests: number,
  totalSuccess: number,
  overallSuccessRate: string,
  activeEndpointCount: number
}
```

## 故障处理机制

### 自动故障检测
- 连续失败3次后自动禁用端点
- 指数退避重试机制
- 定期健康检查恢复

### 故障恢复
- 端点恢复后自动重新启用
- 重置失败计数和权重
- 渐进式恢复策略

## 性能优化

### 响应时间优化
- 使用指数移动平均计算响应时间
- 平滑因子为0.1，平衡响应性和稳定性
- 最大响应时间阈值：10秒

### 健康检查
- 检查间隔：30秒
- 使用轻量级API调用进行健康检查
- 并行检查所有端点

## 最佳实践

1. **权重设置**: 根据端点性能和稳定性设置合理权重
2. **策略选择**: 根据应用需求选择合适的负载均衡策略
3. **监控**: 定期检查端点和整体性能指标
4. **故障处理**: 监控失败率，及时调整配置

## 故障排除

### 常见问题
1. **无可用端点**: 检查环境变量配置和网络连接
2. **响应时间过长**: 考虑切换到响应时间优先策略
3. **成功率低**: 检查端点配置和网络稳定性

### 调试信息
```typescript
// 启用详细日志
const balancer = getRPCLoadBalancer();
console.log('Status:', balancer.getStatus());
console.log('Metrics:', balancer.getMetrics());
```