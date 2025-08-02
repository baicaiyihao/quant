// 池信息相关类型定义
export interface TokenInfo {
    address: string;
    symbol: string;
    circulatingSupply: string;
    decimals: number;
    hasBluefinPools: boolean;
    isVerified: boolean;
    logoURI: string;
    name: string;
    rfqSupported: boolean;
    totalSupply: string;
}

export interface Reward {
    dailyRewards: string;
    dailyRewardsUsd: string;
    endTime: string;
    perSecondRewards: string;
    token: TokenInfo;
    totalReward: string;
}

export interface PoolRangeConfig {
    defaultRange: string;
    defaultRangePoint: string[];
    tickSpacing: number;
}

export interface AprInfo {
    feeApr: string;
    rewardApr: string;
    total: string;
}

export interface TimeframeData {
    apr: AprInfo;
    fee: string;
    priceMax: string;
    priceMin: string;
    volume: string;
    volumeQuoteQty: string;
}

export interface TokenAmount {
    amount: string;
    info: TokenInfo;
}

export interface ApiPoolInfo {
    address: string;
    config: PoolRangeConfig;
    day: TimeframeData;
    feeRate: string;
    is_paused: boolean;
    month: TimeframeData;
    price: string;
    rewards: Reward[];
    symbol: string;
    tags: string[];
    tokenA: TokenAmount;
    tokenB: TokenAmount;
    totalApr: string;
    tvl: string;
    verified: boolean;
    week: TimeframeData;
}

// 池配置相关接口 - 从ApiPoolInfo中提取的关键信息
export interface PoolConfig {
    id: string;
    coinA: string;
    coinB: string;
    coinADecimals: number;
    coinBDecimals: number;
    name: string;
    fee: number;
    tickSpacing: number;
}

// 缓存
let poolsInfoCache: ApiPoolInfo[] | null = null;

// 从API获取pools信息
export async function fetchPoolsInfo(): Promise<ApiPoolInfo[]> {
    // 检查缓存是否存在
    if (poolsInfoCache) {
        return poolsInfoCache;
    }
    
    try {
        const response = await fetch('https://swap.api.sui-prod.bluefin.io/api/v1/pools/info');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const pools = await response.json();
        
        // 更新缓存
        poolsInfoCache = pools;
        
        return pools;
    } catch (error) {
        console.error('Failed to fetch pools info:', error);
        return [];
    }
}

// 转换API pools数据为PoolConfig格式
export function convertApiPoolsToPoolConfig(apiPools: ApiPoolInfo[]): PoolConfig[] {
    return apiPools.map(pool => ({
        id: pool.address,
        coinA: pool.tokenA.info.address,
        coinB: pool.tokenB.info.address,
        coinADecimals: pool.tokenA.info.decimals,
        coinBDecimals: pool.tokenB.info.decimals,
        name: pool.symbol,
        fee: Math.round(parseFloat(pool.feeRate) * 10000), // 转换费率格式
        tickSpacing: pool.config.tickSpacing
    }));
} 