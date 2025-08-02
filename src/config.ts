import { PoolConfig, fetchPoolsInfo, convertApiPoolsToPoolConfig } from './pool-service';
import { ContractConfig, fetchContractConfig } from './contract-service';


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