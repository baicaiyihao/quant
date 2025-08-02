import {Strategy} from "./strategy";
import {config} from "dotenv"
import {logger} from "./Logger";
import {StrategyConfig} from "./strategy-config";

config();

async function main() {
    const private_key = process.env.PRIVATE_KEY as string;
    logger.info(`ENV: private_key:${private_key}`);

    const endpoint = process.env.ENDPPOINT as string;
    logger.info(`ENV: endpoint:${endpoint}`);

    const poolId = process.env.POOL_ID as string;
    logger.info(`ENV: poolId:${poolId}`);

    const g = process.env.G as string
    logger.info(`ENV: g:${g}`);

    // 读取策略配置
    const fundUsageRate = process.env.FUND_USAGE_RATE ? parseFloat(process.env.FUND_USAGE_RATE) : undefined;
    const minRangeMultiplier = process.env.MIN_RANGE_MULTIPLIER ? parseFloat(process.env.MIN_RANGE_MULTIPLIER) : undefined;
    const slippage = process.env.SLIPPAGE ? parseFloat(process.env.SLIPPAGE) : undefined;
    const balanceError = process.env.BALANCE_ERROR ? parseFloat(process.env.BALANCE_ERROR) : undefined;

    logger.info(`ENV: fundUsageRate:${fundUsageRate}`);
    logger.info(`ENV: minRangeMultiplier:${minRangeMultiplier}`);
    logger.info(`ENV: slippage:${slippage}`);
    logger.info(`ENV: balanceError:${balanceError}`);

    if (!private_key) {
        throw Error(`private_key Is Nan`);
    }

    if (!endpoint) {
        throw Error(`endpoint Is Nan`);
    }
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

    const st = new Strategy(endpoint, private_key, poolId, Number(g), strategyConfig);
    await st.run();

}

main();