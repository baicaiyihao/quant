import { SuiClient } from '@firefly-exchange/library-sui';
import { logger } from './Logger';

interface EndpointConfig {
    url: string;
    isActive: boolean;
    failureCount: number;
    lastFailureTime?: number;
    backoffDelay: number; // 指数退避延迟（毫秒）
}

export class RPCLoadBalancer {
    private endpoints: EndpointConfig[] = [];
    private currentIndex: number = 0;
    private readonly maxFailures: number = 3; // 最大失败次数
    private readonly baseBackoffDelay: number = 1000; // 基础退避延迟1秒
    private readonly maxBackoffDelay: number = 300000; // 最大退避延迟5分钟
    private readonly backoffMultiplier: number = 2; // 指数退避倍数

    constructor() {
        this.loadEndpointsFromEnv();
        if (this.endpoints.length === 0) {
            throw new Error('No valid RPC endpoints found in environment variables');
        }
        logger.info(`Initialized RPC Load Balancer with ${this.endpoints.length} endpoints`);
    }

    private loadEndpointsFromEnv(): void {
        const envKeys = Object.keys(process.env);
        const endpointKeys = envKeys.filter(key => 
            key === 'ENDPPOINT' || key.match(/^ENDPPOINT\d+$/)
        ).sort();

        for (const key of endpointKeys) {
            const url = process.env[key];
            if (url && url.trim()) {
                this.endpoints.push({
                    url: url.trim(),
                    isActive: true,
                    failureCount: 0,
                    backoffDelay: this.baseBackoffDelay
                });
                logger.info(`Added endpoint: ${url.trim()}`);
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
                    logger.info(`Endpoint recovered: ${endpoint.url}`);
                }
            }
        }
    }

    private getNextEndpoint(): EndpointConfig | null {
        this.checkEndpointRecovery();
        
        const activeEndpoints = this.endpoints.filter(ep => ep.isActive);
        if (activeEndpoints.length === 0) {
            logger.error('No active endpoints available');
            return null;
        }

        // 轮询选择下一个活跃端点
        let attempts = 0;
        while (attempts < this.endpoints.length) {
            const endpoint = this.endpoints[this.currentIndex];
            this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;
            
            if (endpoint.isActive) {
                return endpoint;
            }
            attempts++;
        }

        return null;
    }

    private markEndpointFailure(endpoint: EndpointConfig): void {
        endpoint.failureCount++;
        endpoint.lastFailureTime = Date.now();
        
        if (endpoint.failureCount >= this.maxFailures) {
            endpoint.isActive = false;
            // 指数退避
            endpoint.backoffDelay = Math.min(
                endpoint.backoffDelay * this.backoffMultiplier,
                this.maxBackoffDelay
            );
            logger.warn(`Endpoint deactivated after ${endpoint.failureCount} failures: ${endpoint.url}, next retry in ${endpoint.backoffDelay}ms`);
        } else {
            logger.warn(`Endpoint failure ${endpoint.failureCount}/${this.maxFailures}: ${endpoint.url}`);
        }
    }

    public createClient(): SuiClient {
        const endpoint = this.getNextEndpoint();
        if (!endpoint) {
            throw new Error('No available RPC endpoints');
        }

        logger.info(`Using RPC endpoint: ${endpoint.url}`);
        
        // 创建代理客户端，用于捕获请求错误
        const client = new SuiClient({ url: endpoint.url });
        
        // 包装客户端方法以处理错误
        return this.wrapClientWithErrorHandling(client, endpoint);
    }

    private wrapClientWithErrorHandling(client: SuiClient, endpoint: EndpointConfig): SuiClient {
        // 创建一个简单的代理，直接使用原客户端，但添加错误处理
        const handler = {
            get: (target: any, prop: string) => {
                const value = target[prop];
                
                // 如果是异步方法，包装它来处理错误
                if (typeof value === 'function' && this.isAsyncMethod(prop)) {
                    return async (...args: any[]) => {
                        try {
                            return await value.apply(target, args);
                        } catch (error) {
                            logger.error(`RPC method ${prop} failed on ${endpoint.url}:`, error);
                            this.markEndpointFailure(endpoint);
                            
                            // 尝试使用下一个端点
                            const nextEndpoint = this.getNextEndpoint();
                            if (nextEndpoint && nextEndpoint.url !== endpoint.url) {
                                logger.info(`Retrying with next endpoint: ${nextEndpoint.url}`);
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
            'getTransactionBlock', 'getAllBalances'
        ];
        return asyncMethods.includes(methodName);
    }

    public getStatus(): any {
        this.checkEndpointRecovery();
        return {
            totalEndpoints: this.endpoints.length,
            activeEndpoints: this.endpoints.filter(ep => ep.isActive).length,
            endpoints: this.endpoints.map(ep => ({
                url: ep.url,
                isActive: ep.isActive,
                failureCount: ep.failureCount,
                backoffDelay: ep.backoffDelay,
                timeSinceLastFailure: ep.lastFailureTime ? Date.now() - ep.lastFailureTime : null
            }))
        };
    }
}

// 单例实例
let balancerInstance: RPCLoadBalancer | null = null;

export function getRPCLoadBalancer(): RPCLoadBalancer {
    if (!balancerInstance) {
        balancerInstance = new RPCLoadBalancer();
    }
    return balancerInstance;
}

export function createBalancedSuiClient(): SuiClient {
    return getRPCLoadBalancer().createClient();
}