export interface StrategyConfig {
    // 资金使用率 (0-1之间，默认0.9表示90%)
    fundUsageRate: number;
    // 最小区间倍数 (相对于tickSpacing的倍数，默认3表示3*tickSpacing)
    minRangeMultiplier: number;
    // 滑点设置 (0-1之间，默认0.05表示5%)
    slippage: number;
    // 配平误差 (0-1之间，默认0.1表示10%)
    balanceError: number;
    // 奖励监测配置 (格式: "TOKEN1>1.1orTOKEN2>1.2" 或 "price>1")
    rewardsConfig: string;
    // 区间扩大倍数 (用于连续突破时的指数退避，默认2)
    rangeExpansionMultiplier: number;
    // Pool仓位比例阈值 (0-1之间，默认0.6表示60%，如果当前pool price的仓位占据总price计算仓位的60%以下就执行swap)
    poolPositionRatio: number;
    // Swap交易最小价值阈值 (美元，默认10表示10美元)
    minSwapValue: number;
}

// 默认配置
export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
    fundUsageRate: 0.9,        // 90%资金使用率
    minRangeMultiplier: 3,      // 3倍tickSpacing
    slippage: 0.05,            // 5%滑点
    balanceError: 0.1,          // 10%配平误差
    rewardsConfig: "",
    rangeExpansionMultiplier: 2, // 区间扩大倍数，用于指数退避
    poolPositionRatio: 0.6,     // 60%pool仓位比例阈值
    minSwapValue: 10            // 10美元swap最小价值阈值
};

// 全局配置实例
let globalStrategyConfig: StrategyConfig = { ...DEFAULT_STRATEGY_CONFIG };

/**
 * 设置策略配置
 * @param config 配置对象
 */
export function setStrategyConfig(config: Partial<StrategyConfig>): void {
    globalStrategyConfig = { ...globalStrategyConfig, ...config };
}

/**
 * 获取当前策略配置
 * @returns 当前配置
 */
export function getStrategyConfig(): StrategyConfig {
    return { ...globalStrategyConfig };
}

/**
 * 重置为默认配置
 */
export function resetStrategyConfig(): void {
    globalStrategyConfig = { ...DEFAULT_STRATEGY_CONFIG };
}

/**
 * 验证配置参数
 * @param config 配置对象
 * @returns 是否有效
 */
export function validateStrategyConfig(config: StrategyConfig): boolean {
    return (
        config.fundUsageRate >= 0 && config.fundUsageRate <= 1 &&
        config.minRangeMultiplier > 0 &&
        config.slippage >= 0 && config.slippage <= 1 &&
        config.balanceError >= 0 && config.balanceError <= 1 &&
        config.poolPositionRatio >= 0 && config.poolPositionRatio <= 1 &&
        config.minSwapValue > 0
    );
} 