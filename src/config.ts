import { PoolConfig, fetchPoolsInfo, convertApiPoolsToPoolConfig } from './pool-service';
import { ContractConfig, fetchContractConfig } from './contract-service';

// 环境变量配置
export interface EnvConfig {
    API_KEY: string;
    PORT: number;
}

// 获取环境变量配置
export function getEnvConfig(): EnvConfig {
    const apiKey = process.env.API_KEY;
    const port = parseInt(process.env.PORT || '8080', 10);
    
    if (!apiKey) {
        throw new Error('API_KEY 环境变量未设置');
    }
    
    return {
        API_KEY: apiKey,
        PORT: port
    };
}

// 主网配置相关接口
export interface MainnetConfig {
    contractConfig: ContractConfig;
    Pools: PoolConfig[];
}

// 获取mainnet配置
export async function getMainnetConfig(): Promise<MainnetConfig> {
    const [contractConfig, apiPools] = await Promise.all([
        fetchContractConfig(),
        fetchPoolsInfo()
    ]);
    
    const pools = convertApiPoolsToPoolConfig(apiPools);
    
    return {
        contractConfig: contractConfig,
        "Pools": pools
    };
}