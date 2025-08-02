// 合约配置相关接口
export interface ContractConfig {
    AdminCap: string;
    BasePackage: string;
    CurrentPackage: string;
    Display: string;
    GlobalConfig: string;
    ProtocolFeeCap: string;
    Publisher: string;
    UpgradeCap: string;
}

// 缓存配置
let contractConfigCache: ContractConfig | null = null;

// 从API获取合约配置
export async function fetchContractConfig(): Promise<ContractConfig> {
    // 检查缓存是否存在
    if (contractConfigCache) {
        return contractConfigCache;
    }
    
    try {
        const response = await fetch('https://swap.api.sui-prod.bluefin.io/api/v1/meta-data/config/contracts');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const config = await response.json();
        
        // 更新缓存
        contractConfigCache = config;
        
        return config;
    } catch (error) {
        console.error('Failed to fetch contract config:', error);
        throw error;
    }
} 