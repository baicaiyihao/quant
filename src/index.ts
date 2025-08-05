import {Strategy} from "./strategy";
import {config} from "dotenv"
import {logger} from "./Logger";
import {StrategyConfig} from "./strategy-config";
import {getRPCLoadBalancer} from "./rpc-balancer";
import {startServer, setStrategyInstance} from "./server";

config();

async function main() {
    const private_key = process.env.PRIVATE_KEY as string;
    // 初始化RPC负载均衡器
    const rpcBalancer = getRPCLoadBalancer();
    logger.info('RPC Load Balancer Status:', rpcBalancer.getStatus());

    const poolId = process.env.POOL_ID as string;
    logger.info(`ENV: poolId:${poolId}`);

    const g = process.env.G as string
    logger.info(`ENV: g:${g}`);

    // 读取策略配置
    const fundUsageRate = process.env.FUND_USAGE_RATE ? parseFloat(process.env.FUND_USAGE_RATE) : undefined;
    const minRangeMultiplier = process.env.MIN_RANGE_MULTIPLIER ? parseFloat(process.env.MIN_RANGE_MULTIPLIER) : undefined;
    const slippage = process.env.SLIPPAGE ? parseFloat(process.env.SLIPPAGE) : undefined;
    const balanceError = process.env.BALANCE_ERROR ? parseFloat(process.env.BALANCE_ERROR) : undefined;
    const rangeExpansionMultiplier = process.env.RANGE_EXPANSION_MULTIPLIER ? parseFloat(process.env.RANGE_EXPANSION_MULTIPLIER) : undefined;
    const poolPositionRatio = process.env.POOL_POSITION_RATIO ? parseFloat(process.env.POOL_POSITION_RATIO) : undefined;
    const minSwapValue = process.env.MIN_SWAP_VALUE ? parseFloat(process.env.MIN_SWAP_VALUE) : undefined;

    logger.info(`ENV: fundUsageRate:${fundUsageRate}`);
    logger.info(`ENV: minRangeMultiplier:${minRangeMultiplier}`);
    logger.info(`ENV: slippage:${slippage}`);
    logger.info(`ENV: balanceError:${balanceError}`);
    logger.info(`ENV: rangeExpansionMultiplier:${rangeExpansionMultiplier}`);
    logger.info(`ENV: poolPositionRatio:${poolPositionRatio}`);
    logger.info(`ENV: minSwapValue:${minSwapValue}`);

    if (!private_key) {
        throw Error(`private_key Is Nan`);
    }

    // endpoint检查已移除，由负载均衡器管理
    if (!poolId) {
        throw Error(`poolId Is Nan`);
    }

    if (!g) {
        throw Error(`g is Nan`);
    }

    // 构建策略配置
    const strategyConfig: Partial<StrategyConfig> = {};
    if (fundUsageRate !== undefined) strategyConfig.fundUsageRate = fundUsageRate;
    if (minRangeMultiplier !== undefined) strategyConfig.minRangeMultiplier = minRangeMultiplier;
    if (slippage !== undefined) strategyConfig.slippage = slippage;
    if (balanceError !== undefined) strategyConfig.balanceError = balanceError;
    if (rangeExpansionMultiplier !== undefined) strategyConfig.rangeExpansionMultiplier = rangeExpansionMultiplier;
    if (poolPositionRatio !== undefined) strategyConfig.poolPositionRatio = poolPositionRatio;
    if (minSwapValue !== undefined) strategyConfig.minSwapValue = minSwapValue;

    // 传递空字符串作为endpoint参数，因为现在使用负载均衡器
    const st = new Strategy("https://fullnode.mainnet.sui.io:443", private_key, poolId, Number(g), strategyConfig);
    
    // 设置策略实例到服务器
    setStrategyInstance(st);
    
    // 启动HTTP服务器
    startServer();
    
    // 自动启动策略
    st.run().catch((error: any) => {
        logger.error('策略运行出错:', error);
    });
    
    logger.info("系统已启动，策略已自动启动...");
    logger.info("使用以下API接口控制策略:");
    logger.info("  curl -X POST http://localhost:8080/start  # 启动策略");
    logger.info("  curl -X POST http://localhost:8080/stop   # 停止策略");
    logger.info("  curl http://localhost:8080/status         # 查看状态");
}

main();