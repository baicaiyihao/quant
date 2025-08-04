import { SuiClient } from '@firefly-exchange/library-sui';
import { logger } from './Logger';

interface EndpointConfig {
    url: string;
    isActive: boolean;
    failureCount: number;
    lastFailureTime?: number;
    backoffDelay: number; // 指数退避延迟（毫秒）
    weight: number; // 基础权重
    currentWeight: number; // 当前权重（用于平滑加权轮询）
    effectiveWeight: number; // 有效权重（考虑失败惩罚）
    responseTime: number; // 平均响应时间（毫秒）
    successCount: number; // 成功请求数
    totalRequests: number; // 总请求数
    lastHealthCheck?: number; // 最后健康检查时间
    isHealthy: boolean; // 健康状态
    consecutiveFailures: number; // 连续失败次数
    consecutiveSuccesses: number; // 连续成功次数
    lastSuccessTime?: number; // 最后成功时间
}

type LoadBalancingStrategy = 'round_robin' | 'weighted_round_robin' | 'least_connections' | 'response_time' | 'random';

export class RPCLoadBalancer {
    private endpoints: EndpointConfig[] = [];
    private currentIndex: number = 0;
    private readonly maxFailures: number = 3; // 最大失败次数
    private readonly baseBackoffDelay: number = 1000; // 基础退避延迟1秒
    private readonly maxBackoffDelay: number = 300000; // 最大退避延迟5分钟
    private readonly backoffMultiplier: number = 2; // 指数退避倍数
    private readonly healthCheckInterval: number = 60000; // 健康检查间隔（毫秒）- 1分钟
    private readonly responseTimeWindow: number = 60000; // 响应时间统计窗口（毫秒）
    private readonly maxResponseTime: number = 10000; // 最大可接受响应时间（毫秒）
    private strategy: LoadBalancingStrategy = 'weighted_round_robin';
    private lastHealthCheck: number = 0;
    
    // 失败处理相关配置
    private readonly failureWeightPenalty: number = 0.5; // 失败权重惩罚系数
    private readonly successWeightRecovery: number = 0.1; // 成功权重恢复系数
    private readonly minEffectiveWeight: number = 0.1; // 最小有效权重
    private readonly maxConsecutiveFailures: number = 5; // 最大连续失败次数
    private readonly recoveryThreshold: number = 3; // 恢复阈值（连续成功次数）

    constructor(strategy: LoadBalancingStrategy = 'weighted_round_robin') {        // 启动健康检查
        this.strategy = strategy;
        this.loadEndpointsFromEnv();
        this.startHealthCheck();
        if (this.endpoints.length === 0) {
            throw new Error('No valid RPC endpoints found in environment variables');
        }
        logger.info(`Initialized RPC Load Balancer with ${this.endpoints.length} endpoints using ${strategy} strategy`);
    }

    private loadEndpointsFromEnv(): void {
        const envKeys = Object.keys(process.env);
        const endpointKeys = envKeys.filter(key => 
            key === 'ENDPPOINT' || key.match(/^ENDPPOINT\d+$/)
        ).sort();

        for (const key of endpointKeys) {
            const url = process.env[key];
            if (url && url.trim()) {
                const endpointUrl = url.trim();
                this.endpoints.push({
                    url: endpointUrl,
                    isActive: true,
                    failureCount: 0,
                    backoffDelay: this.baseBackoffDelay,
                    weight: 1, // 初始权重为1，将通过响应时间动态调整
                    currentWeight: 1,
                    effectiveWeight: 1, // 初始有效权重为1
                    responseTime: 0,
                    successCount: 0,
                    totalRequests: 0,
                    isHealthy: true,
                    consecutiveFailures: 0,
                    consecutiveSuccesses: 0
                });
                logger.info(`Added endpoint: ${endpointUrl}`);
            }
        }
    }

    private checkEndpointRecovery(): void {
        const now = Date.now();
        for (const endpoint of this.endpoints) {
            if (!endpoint.isActive && endpoint.lastFailureTime) {
                const timeSinceFailure = now - endpoint.lastFailureTime;
                if (timeSinceFailure >= endpoint.backoffDelay) {
                    endpoint.isActive = true;
                    endpoint.failureCount = 0;
                    endpoint.backoffDelay = this.baseBackoffDelay;
                    endpoint.currentWeight = endpoint.effectiveWeight; // 使用有效权重
                    endpoint.consecutiveFailures = 0;
                    logger.info(`Endpoint recovered: ${endpoint.url} (effective weight: ${endpoint.effectiveWeight})`);
                }
            }
        }
    }

    private getNextEndpoint(): EndpointConfig | null {
        this.checkEndpointRecovery();
        
        const activeEndpoints = this.endpoints.filter(ep => ep.isActive && ep.isHealthy);
        if (activeEndpoints.length === 0) {
            logger.error('No active and healthy endpoints available');
            return null;
        }

        switch (this.strategy) {
            case 'round_robin':
                return this.roundRobin(activeEndpoints);
            case 'weighted_round_robin':
                return this.weightedRoundRobin(activeEndpoints);
            case 'least_connections':
                return this.leastConnections(activeEndpoints);
            case 'response_time':
                return this.responseTimeBased(activeEndpoints);
            case 'random':
                return this.randomSelection(activeEndpoints);
            default:
                return this.weightedRoundRobin(activeEndpoints);
        }
    }

    private roundRobin(activeEndpoints: EndpointConfig[]): EndpointConfig {
        const endpoint = activeEndpoints[this.currentIndex % activeEndpoints.length];
        this.currentIndex = (this.currentIndex + 1) % activeEndpoints.length;
        return endpoint;
    }

    private weightedRoundRobin(activeEndpoints: EndpointConfig[]): EndpointConfig {
        
        // 平滑加权轮询算法（考虑失败影响）
        let maxCurrentWeight = 0;
        let selectedEndpoint: EndpointConfig | null = null;

        // 找到当前权重最大的端点
        for (const endpoint of activeEndpoints) {
            if (endpoint.currentWeight > maxCurrentWeight) {
                maxCurrentWeight = endpoint.currentWeight;
                selectedEndpoint = endpoint;
            }
        }

        if (!selectedEndpoint) {
            return activeEndpoints[0];
        }

        // 更新权重（使用有效权重）
        for (const endpoint of activeEndpoints) {
            if (endpoint === selectedEndpoint) {
                endpoint.currentWeight -= this.getTotalEffectiveWeight(activeEndpoints);
            }
            endpoint.currentWeight += endpoint.effectiveWeight;
        }

        return selectedEndpoint;
    }

    private leastConnections(activeEndpoints: EndpointConfig[]): EndpointConfig {
        return activeEndpoints.reduce((min, current) => 
            current.totalRequests < min.totalRequests ? current : min
        );
    }

    private responseTimeBased(activeEndpoints: EndpointConfig[]): EndpointConfig {
        return activeEndpoints.reduce((min, current) => 
            current.responseTime < min.responseTime ? current : min
        );
    }

    private randomSelection(activeEndpoints: EndpointConfig[]): EndpointConfig {
        const index = Math.floor(Math.random() * activeEndpoints.length);
        return activeEndpoints[index];
    }

    private getTotalEffectiveWeight(endpoints: EndpointConfig[]): number {
        return endpoints.reduce((sum, ep) => sum + ep.effectiveWeight, 0);
    }

    private markEndpointFailure(endpoint: EndpointConfig): void {
        endpoint.failureCount++;
        endpoint.consecutiveFailures++;
        endpoint.consecutiveSuccesses = 0; // 重置连续成功计数
        endpoint.lastFailureTime = Date.now();
        endpoint.totalRequests++;
        
        // 动态调整有效权重（失败惩罚）
        this.adjustEffectiveWeight(endpoint, false);
        
        if (endpoint.failureCount >= this.maxFailures || 
            endpoint.consecutiveFailures >= this.maxConsecutiveFailures) {
            endpoint.isActive = false;
            endpoint.isHealthy = false;
            // 指数退避
            endpoint.backoffDelay = Math.min(
                endpoint.backoffDelay * this.backoffMultiplier,
                this.maxBackoffDelay
            );
            logger.warn(`Endpoint deactivated after ${endpoint.failureCount} failures (${endpoint.consecutiveFailures} consecutive): ${endpoint.url}, effective weight: ${endpoint.effectiveWeight}, next retry in ${endpoint.backoffDelay}ms`);
        } else {
            logger.warn(`Endpoint failure ${endpoint.failureCount}/${this.maxFailures} (${endpoint.consecutiveFailures} consecutive): ${endpoint.url}, effective weight: ${endpoint.effectiveWeight}`);
        }
    }

    private markEndpointSuccess(endpoint: EndpointConfig, responseTime: number): void {
        endpoint.totalRequests++;
        endpoint.successCount++;
        endpoint.consecutiveSuccesses++;
        endpoint.consecutiveFailures = 0; // 重置连续失败计数
        endpoint.lastSuccessTime = Date.now();
        
        // 更新平均响应时间（指数移动平均）
        const alpha = 0.1; // 平滑因子
        endpoint.responseTime = endpoint.responseTime === 0 
            ? responseTime 
            : alpha * responseTime + (1 - alpha) * endpoint.responseTime;
        
        // 动态调整权重（基于成功次数）
        this.adjustEffectiveWeight(endpoint, true);
        
        // 重置失败计数（渐进式恢复）
        if (endpoint.failureCount > 0 && endpoint.consecutiveSuccesses >= this.recoveryThreshold) {
            endpoint.failureCount = Math.max(0, endpoint.failureCount - 1);
            logger.debug(`Endpoint ${endpoint.url} failure count reduced to ${endpoint.failureCount} after ${endpoint.consecutiveSuccesses} consecutive successes`);
        }
    }

    private adjustEffectiveWeight(endpoint: EndpointConfig, isSuccess: boolean): void {
        if (isSuccess) {
            // 成功时，根据成功次数动态调整权重
            const successRate = endpoint.totalRequests > 0 ? endpoint.successCount / endpoint.totalRequests : 0;
            const newWeight = Math.max(0.1, Math.min(5.0, 1 + successRate * 2)); // 权重范围：0.1-5.0
            
            endpoint.weight = newWeight;
            endpoint.effectiveWeight = newWeight;
            
            logger.debug(`Endpoint ${endpoint.url} weight adjusted to ${newWeight.toFixed(2)} (success rate: ${(successRate * 100).toFixed(1)}%)`);
        } else {
            // 失败时，降低有效权重
            endpoint.effectiveWeight = Math.max(
                this.minEffectiveWeight,
                endpoint.effectiveWeight * this.failureWeightPenalty
            );
            logger.debug(`Endpoint ${endpoint.url} effective weight decreased to ${endpoint.effectiveWeight.toFixed(2)}`);
        }
    }

    private async performHealthCheck(endpoint: EndpointConfig): Promise<boolean> {
        try {
            const startTime = Date.now();
            const client = new SuiClient({ url: endpoint.url });
            
            // 执行简单的健康检查（获取最新区块）
            await client.getLatestSuiSystemState();
            
            const responseTime = Date.now() - startTime;
            
            // 只对实际使用的端点更新统计信息
            if (endpoint.totalRequests > 0) {
                this.markEndpointSuccess(endpoint, responseTime);
            } else {
                // 对未使用的端点，只更新响应时间和健康状态
                endpoint.responseTime = responseTime;
                endpoint.lastSuccessTime = Date.now();
            }
            
            if (!endpoint.isHealthy) {
                endpoint.isHealthy = true;
                logger.info(`Endpoint health restored: ${endpoint.url} (effective weight: ${endpoint.effectiveWeight.toFixed(2)})`);
            }
            
            return true;
        } catch (error) {
            logger.warn(`Health check failed for ${endpoint.url}:`, error);
            endpoint.isHealthy = false;
            return false;
        }
    }

    private startHealthCheck(): void {
        logger.info(`Starting health check with interval: ${this.healthCheckInterval}ms`);
        // 首次的运行
        this.performHealthChecks();
        setInterval(() => {
            const now = Date.now();
            if (now - this.lastHealthCheck >= this.healthCheckInterval) {
                this.lastHealthCheck = now;
                this.performHealthChecks();
            }
        }, this.healthCheckInterval);
    }

    private async performHealthChecks(): Promise<void> {
        const promises = this.endpoints
            .filter(ep => ep.isActive)
            .map(ep => this.performHealthCheck(ep));
        
        await Promise.allSettled(promises);
        
        // 对从未使用过的端点也进行健康检查，确保它们的状态正确
        const unusedEndpoints = this.endpoints.filter(ep => ep.totalRequests === 0);
        if (unusedEndpoints.length > 0) {
            const unusedPromises = unusedEndpoints.map(ep => this.performHealthCheck(ep));
            await Promise.allSettled(unusedPromises);
        }
    }

    public createClient(): SuiClient {
        const endpoint = this.getNextEndpoint();
        if (!endpoint) {
            throw new Error('No available RPC endpoints');
        }

        // 显示RPC节点状态表格
        this.displayRPCStatusTable(endpoint);
        
        logger.debug(`Using RPC endpoint: ${endpoint.url} (${this.strategy}, effective weight: ${endpoint.effectiveWeight.toFixed(2)})`);
        
        // 创建代理客户端，用于捕获请求错误
        const client = new SuiClient({ url: endpoint.url });
        
        // 包装客户端方法以处理错误
        return this.wrapClientWithErrorHandling(client, endpoint);
    }

    private wrapClientWithErrorHandling(client: SuiClient, endpoint: EndpointConfig): SuiClient {
        const handler = {
            get: (target: any, prop: string) => {
                const value = target[prop];
                
                // 如果是异步方法，包装它来处理错误
                if (typeof value === 'function' && this.isAsyncMethod(prop)) {
                    return async (...args: any[]) => {
                        const startTime = Date.now();
                        try {
                            const result = await value.apply(target, args);
                            const responseTime = Date.now() - startTime;
                            this.markEndpointSuccess(endpoint, responseTime);
                            return result;
                        } catch (error) {
                            const responseTime = Date.now() - startTime;
                            logger.error(`RPC method ${prop} failed on ${endpoint.url} (${responseTime}ms):`, error);
                            this.markEndpointFailure(endpoint);
                            
                            // 尝试使用下一个端点
                            const nextEndpoint = this.getNextEndpoint();
                            if (nextEndpoint && nextEndpoint.url !== endpoint.url) {
                                logger.info(`Retrying with next endpoint: ${nextEndpoint.url} (effective weight: ${nextEndpoint.effectiveWeight.toFixed(2)})`);
                                const nextClient = new SuiClient({ url: nextEndpoint.url });
                                return await (nextClient as any)[prop](...args);
                            }
                            
                            throw error;
                        }
                    };
                }
                
                return value;
            }
        };

        return new Proxy(client, handler);
    }

    private isAsyncMethod(methodName: string): boolean {
        const asyncMethods = [
            'getBalance', 'getCoins', 'getObject', 'getObjects', 
            'executeTransactionBlock', 'dryRunTransactionBlock',
            'multiGetObjects', 'queryTransactionBlocks',
            'getTransactionBlock', 'getAllBalances', 'getLatestSuiSystemState'
        ];
        return asyncMethods.includes(methodName);
    }

    public setStrategy(strategy: LoadBalancingStrategy): void {
        this.strategy = strategy;
        logger.info(`Load balancing strategy changed to: ${strategy}`);
    }

    public getStatus(): any {
        this.checkEndpointRecovery();
        return {
            strategy: this.strategy,
            totalEndpoints: this.endpoints.length,
            activeEndpoints: this.endpoints.filter(ep => ep.isActive).length,
            healthyEndpoints: this.endpoints.filter(ep => ep.isActive && ep.isHealthy).length,
            endpoints: this.endpoints.map(ep => ({
                url: ep.url,
                isActive: ep.isActive,
                isHealthy: ep.isHealthy,
                weight: Math.round(ep.weight * 100) / 100,
                effectiveWeight: Math.round(ep.effectiveWeight * 100) / 100,
                currentWeight: Math.round(ep.currentWeight * 100) / 100,
                failureCount: ep.failureCount,
                consecutiveFailures: ep.consecutiveFailures,
                consecutiveSuccesses: ep.consecutiveSuccesses,
                backoffDelay: ep.backoffDelay,
                responseTime: Math.round(ep.responseTime),
                successRate: ep.totalRequests > 0 ? (ep.successCount / ep.totalRequests * 100).toFixed(2) + '%' : '0%',
                totalRequests: ep.totalRequests,
                successCount: ep.successCount,
                timeSinceLastFailure: ep.lastFailureTime ? Date.now() - ep.lastFailureTime : null,
                timeSinceLastSuccess: ep.lastSuccessTime ? Date.now() - ep.lastSuccessTime : null
            }))
        };
    }

    public getMetrics(): any {
        const activeEndpoints = this.endpoints.filter(ep => ep.isActive && ep.isHealthy);
        if (activeEndpoints.length === 0) return null;

        const avgResponseTime = activeEndpoints.reduce((sum, ep) => sum + ep.responseTime, 0) / activeEndpoints.length;
        const totalRequests = activeEndpoints.reduce((sum, ep) => sum + ep.totalRequests, 0);
        const totalSuccess = activeEndpoints.reduce((sum, ep) => sum + ep.successCount, 0);
        const overallSuccessRate = totalRequests > 0 ? (totalSuccess / totalRequests * 100).toFixed(2) + '%' : '0%';
        const avgEffectiveWeight = activeEndpoints.reduce((sum, ep) => sum + ep.effectiveWeight, 0) / activeEndpoints.length;

        return {
            avgResponseTime: Math.round(avgResponseTime),
            totalRequests,
            totalSuccess,
            overallSuccessRate,
            activeEndpointCount: activeEndpoints.length,
            avgEffectiveWeight: Math.round(avgEffectiveWeight * 100) / 100,
            totalEffectiveWeight: Math.round(this.getTotalEffectiveWeight(activeEndpoints) * 100) / 100
        };
    }

    /**
     * 显示RPC节点状态表格
     * 状态说明：
     * - 🟢 活跃：已使用且健康的端点
     * - 🟢 可用：未使用但健康的端点
     * - 🔴 离线：已使用但不健康的端点
     * - 🔴 不可用：未使用且不健康的端点
     */
    private displayRPCStatusTable(selectedEndpoint: EndpointConfig): void {
        const headers = ['节点', '状态', '权重(基础/有效)', '使用次数', '成功', '失败', '成功率', '响应时间(ms)'];
        const rows: string[][] = [];

        this.endpoints.forEach((endpoint, index) => {
            const nodeName = `${index + 1}`;
            let status;
            if (endpoint.totalRequests === 0) {
                // 未使用的端点，根据健康检查结果显示状态
                status = endpoint.isHealthy ? '🟢 可用' : '🔴 不可用';
            } else {
                // 已使用的端点，根据活跃和健康状态显示
                status = endpoint.isActive && endpoint.isHealthy ? '🟢 活跃' : '🔴 离线';
            }
            
            const weight = `${endpoint.weight.toFixed(2)}/${endpoint.effectiveWeight.toFixed(2)}`;
            const totalRequests = endpoint.totalRequests.toString();
            const successCount = endpoint.successCount.toString();
            const failureCount = (endpoint.totalRequests - endpoint.successCount).toString();
            const successRate = endpoint.totalRequests > 0 
                ? `${(endpoint.successCount / endpoint.totalRequests * 100).toFixed(1)}%` 
                : '0%';
            const responseTime = Math.round(endpoint.responseTime).toString();

            // 如果是当前选择的节点，添加绿点标记
            const isSelected = endpoint.url === selectedEndpoint.url;
            const nodeDisplay = isSelected ? `🟢 ${nodeName}` : nodeName;

            rows.push([
                nodeDisplay,
                status,
                weight,
                totalRequests,
                successCount,
                failureCount,
                successRate,
                responseTime
            ]);
        });

        logger.renderTable(headers, rows);
    }

    // 新增：获取失败分析
    public getFailureAnalysis(): any {
        const failedEndpoints = this.endpoints.filter(ep => ep.failureCount > 0);
        const inactiveEndpoints = this.endpoints.filter(ep => !ep.isActive);
        
        return {
            failedEndpoints: failedEndpoints.map(ep => ({
                url: ep.url,
                failureCount: ep.failureCount,
                consecutiveFailures: ep.consecutiveFailures,
                effectiveWeight: Math.round(ep.effectiveWeight * 100) / 100,
                timeSinceLastFailure: ep.lastFailureTime ? Date.now() - ep.lastFailureTime : null,
                backoffDelay: ep.backoffDelay
            })),
            inactiveEndpoints: inactiveEndpoints.map(ep => ({
                url: ep.url,
                failureCount: ep.failureCount,
                effectiveWeight: Math.round(ep.effectiveWeight * 100) / 100,
                timeUntilRecovery: ep.lastFailureTime ? (ep.lastFailureTime + ep.backoffDelay - Date.now()) : null
            })),
            totalFailed: failedEndpoints.length,
            totalInactive: inactiveEndpoints.length
        };
    }
}

// 单例实例
let balancerInstance: RPCLoadBalancer | null = null;

export function getRPCLoadBalancer(strategy?: LoadBalancingStrategy): RPCLoadBalancer {
    if (!balancerInstance) {
        balancerInstance = new RPCLoadBalancer(strategy);
    } else if (strategy) {
        balancerInstance.setStrategy(strategy);
    }
    return balancerInstance;
}

export function createBalancedSuiClient(strategy?: LoadBalancingStrategy): SuiClient {
    // 内部实现阻塞重试逻辑
    let retryCount = 0;
    const maxRetries = -1; // 无限重试
    const retryInterval = 5000;
    
    while (maxRetries === -1 || retryCount < maxRetries) {
        try {
            return getRPCLoadBalancer(strategy).createClient();
        } catch (error) {
            retryCount++;
            const balancer = getRPCLoadBalancer(strategy);
            const status = balancer.getStatus();
            
            logger.error(`No available RPC endpoints (attempt ${retryCount}${maxRetries > 0 ? `/${maxRetries}` : ''}), retrying in ${retryInterval/1000}s...`);
            logger.error(`Status: ${status.activeEndpoints}/${status.totalEndpoints} active endpoints`);
            
            // 显示当前节点状态
            if (status.endpoints.length > 0) {
                const failedEndpoints = status.endpoints.filter((ep: any) => !ep.isActive || !ep.isHealthy);
                if (failedEndpoints.length > 0) {
                    logger.error(`Failed endpoints: ${failedEndpoints.map((ep: any) => `${ep.url} (${ep.failureCount} failures)`).join(', ')}`);
                }
            }
            
            // 阻塞等待
            const startTime = Date.now();
            while (Date.now() - startTime < retryInterval) {
                // 简单的阻塞等待
                const waitTime = Math.min(100, retryInterval - (Date.now() - startTime));
                if (waitTime > 0) {
                    // 使用同步等待（不推荐，但为了保持API兼容性）
                    const endTime = Date.now() + waitTime;
                    while (Date.now() < endTime) {
                        // 空循环等待
                    }
                }
            }
        }
    }
    throw new Error(`Failed to create RPC client after ${maxRetries} retries`);
}