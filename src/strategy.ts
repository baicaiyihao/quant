import {IPosition, ISwapParams, OnChainCalls, QueryChain, Pool, IFeeAndRewards} from "@firefly-exchange/library-sui/spot";
import {Ed25519Keypair, SuiClient, toBigNumber, toBigNumberStr, ClmmPoolUtil, TickMath} from "@firefly-exchange/library-sui";

import {getMainnetConfig} from "./config";
import {BN} from "bn.js";
import {logger} from "./Logger";
import {calTickIndex, coinTypeToName, scalingDown, stringToDividedNumber} from "./utils";
import {getStrategyConfig, setStrategyConfig, StrategyConfig} from "./strategy-config";
import {fetchHistoricalPriceData, displayPoolChart} from "./analyze";
import {createBalancedSuiClient} from "./rpc-balancer";
import {fetchTokenPrices, calculateTotalRewardPrice} from "./price-service";


/**
 * 突破类型
 */
enum BreakType {
    Unknown,
    Up,
    Down,
}

// 策略
export class Strategy {
    client: SuiClient
    keyPair: Ed25519Keypair;
    walletAddress: string
    poolId: string
    private coinA: string | null = "unknown";// 代币A 类型
    private coinB: string | null = "unknown"; // 代币B 类型
    private decimalsA: number = 6; // 代币A精度
    private decimalsB: number = 6; //代币B 精度
    // CLMM Tick Spacing
    private tick_spacing: number = 60;
    private nameA: string = "unknowns";
    private nameB: string = "unknowns";
    private lastBreak = BreakType.Unknown
    private readonly G: number = 0;
    private mainnetConfig: any = null; // 缓存配置
    private consecutiveBreakCount: number = 0; // 连续突破计数器，用于指数退避
    private lastBreakTime: number = 0; // 最后突破时间戳，用于10分钟冷却
    private isRunning: boolean = false; // 策略运行状态
    private stopRequested: boolean = false; // 停止请求标志


    constructor(endpoint: string, privateKey: string, poolId: string, g: number, strategyConfig?: Partial<StrategyConfig>) {
        this.poolId = poolId;
        this.client = createBalancedSuiClient(); // 使用负载均衡的客户端
        this.G = g
        
        // 设置策略配置
        if (strategyConfig) {
            setStrategyConfig(strategyConfig);
        }
        
        if (privateKey.startsWith("suiprivkey")) {
            this.keyPair = Ed25519Keypair.fromSecretKey(privateKey);
        } else {
            this.keyPair = Ed25519Keypair.fromSecretKey(Buffer.from(privateKey, 'hex'));
        }
        this.walletAddress = this.keyPair.toSuiAddress();
        logger.info(`ENV: walletAddress:${this.walletAddress}`);
        
        // 打印配置信息
        const config = getStrategyConfig();
        logger.info(`策略配置: 资金使用率=${config.fundUsageRate * 100}%, 最小区间倍数=${config.minRangeMultiplier}, 滑点=${config.slippage * 100}%, 配平误差=${config.balanceError * 100}%, Pool仓位比例阈值=${config.poolPositionRatio * 100}%, Swap最小价值阈值=$${config.minSwapValue}`);
        
        // 从环境变量读取奖励配置
        const rewardsConfig = process.env.REWARDS_CONFIG || "";
        if (rewardsConfig) {
            setStrategyConfig({ rewardsConfig });
            logger.info(`奖励监测配置: ${rewardsConfig}`);
        }
        
        // 默认启动策略
        this.isRunning = true;
        this.stopRequested = false;
    }

    // 获取配置 - 无限重试直到成功
    private async getConfig() {
        if (!this.mainnetConfig) {
            let attemptCount = 0;
            
            while (true) {
                attemptCount++;
                try {
                    this.mainnetConfig = await getMainnetConfig();
                    if (this.mainnetConfig) {
                        logger.info(`Successfully got config after ${attemptCount} attempts`);
                        break;
                    }
                } catch (e) {
                    logger.error(`getMainnetConfig attempt ${attemptCount} failed: ${e}`);
                }
                
                // 切换客户端
                this.client = createBalancedSuiClient();
                logger.info(`Switched client for config attempt ${attemptCount + 1}`);
                
                // 短暂延迟避免过于频繁的请求
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        return this.mainnetConfig;
    }

    // 获取池子信息 - 无限重试直到成功
    async getPool(poolID: string) {
        let attemptCount = 0;
        const maxAttempts = 3; // 最大重试次数
        
        while (attemptCount < maxAttempts) {
            attemptCount++;
            let qc = new QueryChain(this.client);
            
            try {
                const pool = await qc.getPool(poolID);
                if (pool) {
                    logger.info(`Successfully got pool data after ${attemptCount} attempts`);
                    return pool;
                } else {
                    logger.error(`Pool not found: ${poolID}`);
                    return null;
                }
            } catch (e) {
                const errorMessage = String(e);
                logger.error(`QueryChain.getPool attempt ${attemptCount} failed: ${e}`);
                
                // 检查是否是对象已删除的错误
                if (errorMessage.includes('deleted') || errorMessage.includes('invalid') || errorMessage.includes('not found')) {
                    logger.warn(`Pool可能已被删除或无效: ${poolID}`);
                    return null;
                }
                
                if (attemptCount >= maxAttempts) {
                    logger.error(`达到最大重试次数，无法获取Pool数据`);
                    return null;
                }
            }
            
            // 切换客户端
            this.client = createBalancedSuiClient();
            logger.info(`Switched client for attempt ${attemptCount + 1}`);
            
            // 短暂延迟避免过于频繁的请求
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        logger.error(`获取Pool数据失败，已达到最大重试次数`);
        return null;
    }

    /***
     * 获取用户资产信息，限定本池中的A和B - 无限重试直到成功
     */
    async getAssert(): Promise<number[] | null> {
        const COIN_SUI = "0x2::sui::SUI"
        const DECIMALS_SUI = 9

        let attemptCount = 0;
        const maxAttempts = 3; // 最大重试次数
        
        while (attemptCount < maxAttempts) {
            attemptCount++;
            let amountA: number = 0.0;
            let amountB: number = 0.0;
            let amountSUI: number = 0.0;
            
            try {
                const balances = await this.client.getAllBalances({owner: this.walletAddress});

                for (const balance of balances) {
                    if (balance.coinType === this.coinA) {
                        amountA = stringToDividedNumber(balance.totalBalance, this.decimalsA);
                    }

                    if (balance.coinType === this.coinB) {
                        amountB = stringToDividedNumber(balance.totalBalance, this.decimalsB);
                    }

                    if (balance.coinType === COIN_SUI) {
                        amountSUI = stringToDividedNumber(balance.totalBalance, DECIMALS_SUI);
                    }
                }
                
                logger.info(`Successfully got asset data after ${attemptCount} attempts: A=${amountA}, B=${amountB}, SUI=${amountSUI}`);
                return [amountA, amountB, amountSUI];
            } catch (e) {
                const errorMessage = String(e);
                logger.error(`getAllBalances attempt ${attemptCount} failed: ${e}`);
                
                // 检查是否是对象已删除的错误
                if (errorMessage.includes('deleted') || errorMessage.includes('invalid') || errorMessage.includes('not found')) {
                    logger.warn(`用户资产可能已被删除或无效`);
                    return [0, 0, 0]; // 返回零余额
                }
                
                if (attemptCount >= maxAttempts) {
                    logger.error(`达到最大重试次数，无法获取资产数据`);
                    return null;
                }
            }
            
            // 切换客户端
            this.client = createBalancedSuiClient();
            logger.info(`Switched client for asset attempt ${attemptCount + 1}`);
            
            // 短暂延迟避免过于频繁的请求
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        logger.error(`获取资产数据失败，已达到最大重试次数`);
        return null;
    }

    /**
     * 获取用户仓位信息 - 无限重试直到成功
     * @param userAddress 钱包地址
     */
    async getUserPositions(userAddress: string) {
        let attemptCount = 0;
        const maxAttempts = 3; // 最大重试次数
        
        while (attemptCount < maxAttempts) {
            attemptCount++;
            let qc = new QueryChain(this.client);
            const config = await this.getConfig();
            
            try {
                const positions = await qc.getUserPositions(config.contractConfig.BasePackage, userAddress);
                if (positions) {
                    logger.info(`Successfully got user positions after ${attemptCount} attempts`);
                    return positions;
                } else {
                    logger.info(`No positions found for user`);
                    return [];
                }
            } catch (e) {
                const errorMessage = String(e);
                logger.error(`QueryChain.getUserPositions attempt ${attemptCount} failed: ${e}`);
                
                // 检查是否是对象已删除的错误
                if (errorMessage.includes('deleted') || errorMessage.includes('invalid') || errorMessage.includes('not found')) {
                    logger.warn(`用户仓位可能已被删除或无效`);
                    return [];
                }
                
                if (attemptCount >= maxAttempts) {
                    logger.error(`达到最大重试次数，无法获取用户仓位`);
                    return null;
                }
            }
            
            // 切换客户端
            this.client = createBalancedSuiClient();
            logger.info(`Switched client for positions attempt ${attemptCount + 1}`);
            
            // 短暂延迟避免过于频繁的请求
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        logger.error(`获取用户仓位失败，已达到最大重试次数`);
        return null;
    }

    /***
     * 系统初始化
     */
    async initSys() {
        const pool = await this.getPool(this.poolId)
        if (!pool) {
            throw new Error(`无效的池子地址: ${this.poolId}`);
        }

        this.coinA = pool.coin_a.address;
        this.coinB = pool.coin_b.address;

        this.decimalsA = pool.coin_a.decimals;
        this.decimalsB = pool.coin_b.decimals;

        this.tick_spacing = pool.ticks_manager.tick_spacing;
        const nameA = coinTypeToName(this.coinA);
        const nameB = coinTypeToName(this.coinB)
        this.nameA = nameA;
        this.nameB = nameB;
        logger.info(`poolId ${this.poolId}`);
        logger.info(`coinA: ${nameA} decimalsA: ${this.decimalsA}`);
        logger.info(`coinB:  ${nameB} decimalsB: ${this.decimalsB}`);
        logger.info(`tick_spacing ${this.tick_spacing}`);
        logger.info(`G ${this.G}`);
        if (isNaN(this.G)) {
            throw Error(`错误的启动参数G,必须为大于等于0的正整数`);
        }
        const result = await this.getAssert()
        if (result === null) {
            throw Error(`获取资金信息fail`)
        }
        const [balanceA, balanceB, balanceSUI] = result;
        logger.info(`BalanceA: ${balanceA} ${nameA}`);
        logger.info(`BalanceB: ${balanceB} ${nameB}`);
        logger.info(`GasPay: ${balanceSUI} SUI`);
        if (balanceA <= 0 && balanceB <= 0) {
            throw Error(`余额不足，至少需要一种可用资金 ${nameA} or ${nameB}`)
        }
    }

    /***
     * 计算偏移量
     */
    calG() {
        // 检查是否需要冷却重置
        this.checkCoolDownReset();
        
        const strategyConfig = getStrategyConfig();
        const rangeExpansionMultiplier = strategyConfig.rangeExpansionMultiplier;
        
        // 计算指数退避后的最小区间倍数
        const expandedMinRangeMultiplier = strategyConfig.minRangeMultiplier * Math.pow(rangeExpansionMultiplier, this.consecutiveBreakCount);
        
        if (this.lastBreak == BreakType.Unknown) {
            const g1 = 0 + this.G;
            const g2 = 1 + this.G;
            logger.info(`lastBreak:Unknown BaseG:${this.G} g1:${g1} g2:${g2} consecutiveBreakCount:${this.consecutiveBreakCount} expandedMinRangeMultiplier:${expandedMinRangeMultiplier.toFixed(2)}`)
            return [g1, g2]
        }
        if (this.lastBreak == BreakType.Up) {
            const g1 = 1 + this.G;
            const g2 = 2 + this.G;
            logger.info(`lastBreak:Up BaseX:${this.G} g1:${g1} g2:${g2} consecutiveBreakCount:${this.consecutiveBreakCount} expandedMinRangeMultiplier:${expandedMinRangeMultiplier.toFixed(2)}`)

            return [g1, g2]
        }
        if (this.lastBreak == BreakType.Down) {
            // noinspection PointlessArithmeticExpressionJS
            const g1 = 1 + this.G;
            const g2 = 2 + this.G;
            logger.info(`lastBreak:Down BaseX:${this.G} g1:${g1} g2:${g2} consecutiveBreakCount:${this.consecutiveBreakCount} expandedMinRangeMultiplier:${expandedMinRangeMultiplier.toFixed(2)}`)
            return [g1, g2]
        }
        logger.warn(`lastBreak is None!! default g1,g2`)
        return [0, 1]
    }


    /**
     * 计算开仓需要的A和B的数量对比
     * @param lowerTick 目标区间下
     * @param upperTick 目标区间上
     * @param current_sqrt_price 当前sqr价格
     */
    calXY(lowerTick: number, upperTick: number, current_sqrt_price: string) {
        const coinAmountBN = new BN(toBigNumberStr(1000, this.decimalsA));
        const fix_amount_a = true
        const roundUp = true
        const slippage = 0.05
        const curSqrtPrice = new BN(current_sqrt_price);

        const liquidityInput = ClmmPoolUtil.estLiquidityAndCoinAmountFromOneAmounts(
            lowerTick,
            upperTick,
            coinAmountBN,
            fix_amount_a,
            roundUp,
            slippage,
            curSqrtPrice
        );
        const x = scalingDown(liquidityInput.coinAmountA.toNumber(), this.decimalsA);
        const y = scalingDown(liquidityInput.coinAmountB.toNumber(), this.decimalsB);
        return [x, y]
    }

    /***
     * 开仓逻辑
     * @param pool 池子信息
     */
    async toOpenPos(pool: Pool) {
        // 获取当前价格位置
        const currentTick = pool.current_tick;
        const currentSqrtPrice = pool.current_sqrt_price;
        // 计算偏移量
        let [g1, g2] = this.calG();
        // 计算目标开仓区间
        const tickSpacing = pool.ticks_manager.tick_spacing
        const strategyConfig = getStrategyConfig();
        
        // 使用指数退避后的最小区间倍数
        const expandedMinRangeMultiplier = strategyConfig.minRangeMultiplier * Math.pow(strategyConfig.rangeExpansionMultiplier, this.consecutiveBreakCount);
        const [lowerTick, upperTick] = calTickIndex(currentTick, tickSpacing, g1, g2, expandedMinRangeMultiplier)
        logger.info(`tickSpacing:${tickSpacing} currentTick:${currentTick} lowerTick:${lowerTick} upperTick:${upperTick} expandedMinRangeMultiplier:${expandedMinRangeMultiplier.toFixed(2)} consecutiveBreakCount:${this.consecutiveBreakCount}`);
        // 换算价格区间
        const currentPrice = TickMath.tickIndexToPrice(currentTick, this.decimalsA, this.decimalsB).toNumber();
        const lowerTickPrice = TickMath.tickIndexToPrice(lowerTick, this.decimalsA, this.decimalsB).toNumber();
        const upperTickPrice = TickMath.tickIndexToPrice(upperTick, this.decimalsA, this.decimalsB).toNumber();

        logger.info(`CurrentPrice: ${currentPrice} ||Price Range:  ${lowerTickPrice} <--> ${upperTickPrice}`);
        const [x, y] = this.calXY(lowerTick, upperTick, currentSqrtPrice)
        logger.info(`x:y = ${x}:${y}`);
        
        // 先尝试开仓
        logger.info(`开始开仓 => AddLiquidity`);
        try {
            const addLiquidityOK = await this.toAddLiquidity(lowerTick, upperTick);
            if (addLiquidityOK) {
                logger.info(`开仓成功 => 重置连续突破计数器`);
                this.consecutiveBreakCount = 0; // 开仓成功后重置连续突破计数器
                this.lastBreakTime = 0; // 重置最后突破时间
                
                // 开仓成功后，检查是否需要配平资金
                logger.info(`开仓成功，检查是否需要配平资金...`);
                await this.checkAndBalanceAfterOpen(pool, currentPrice, x, y);
                
            } else {
                logger.error(`开仓失败`);
            }
        } catch (addLiquidityError) {
            logger.error(`开仓异常: ${addLiquidityError}`);
        }
    }

    /**
     * 开仓后检查并配平资金
     * @param pool 池子信息
     * @param currentPrice 当前价格
     * @param x 目标代币A数量
     * @param y 目标代币B数量
     */
    async checkAndBalanceAfterOpen(pool: Pool, currentPrice: number, x: number, y: number) {
        try {
            // 等待一段时间让开仓交易确认
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // 重新获取钱包资产信息
            const result = await this.getAssert();
            if (result === null) {
                logger.error("获取资金信息异常 => 跳过配平");
                return;
            }
            
            const [balanceA, balanceB, balanceSUI] = result as number[];
            logger.info(`开仓后钱包资产: ${this.nameA}: ${balanceA} | ${this.nameB}: ${balanceB} SUI: ${balanceSUI}`);
            
            const strategyConfig = getStrategyConfig();
            
            // 计算当前pool仓位占据总可利用token price的仓位比例
            // 计算总可利用token的price价值
            const totalAvailableValue = balanceA * currentPrice + balanceB;
            
            // 计算当前pool仓位的price价值（假设pool仓位占用了大部分资金）
            const poolPositionValue = Math.min(balanceA * currentPrice, balanceB);
            
            // 计算pool仓位比例
            const poolRatio = totalAvailableValue > 0 ? poolPositionValue / totalAvailableValue : 0;
            
            logger.info(`开仓后Pool仓位比例计算: 总可利用价值=${totalAvailableValue.toFixed(6)}, Pool仓位价值=${poolPositionValue.toFixed(6)}, 比例=${(poolRatio*100).toFixed(1)}%`);
            
            // 使用新的基于pool仓位比例的配平逻辑
            const [a2b, amount] = this.calSwapByPoolRatio(
                currentPrice, x, y, balanceA, balanceB, poolRatio, strategyConfig.poolPositionRatio
            );
            logger.info(`开仓后配平计算: a2b=${a2b}, amount=${amount}`);
            
            if (amount > 0) {
                logger.info(`开仓后需要配平 => Swap`);
                
                // 在配平前进行价格检查
                const swapValue = await this.calculateSwapValue(pool, a2b, amount);
                if (swapValue < strategyConfig.minSwapValue) {
                    logger.warn(`🚫 开仓后配平被拒绝: 交易价值($${swapValue.toFixed(2)})小于$${strategyConfig.minSwapValue}美金阈值`);
                    logger.info(`跳过配平`);
                } else {
                    logger.info(`✅ 开仓后配平通过价格检查: 交易价值$${swapValue.toFixed(2)} >= $${strategyConfig.minSwapValue}`);
                    
                    try {
                        const swapOK = await this.toSwap(pool, a2b, amount, strategyConfig.slippage)
                        if (swapOK) {
                            logger.info(`开仓后配平成功`);
                        } else {
                            logger.error(`开仓后配平失败`);
                        }
                    } catch (swapError) {
                        logger.error(`开仓后配平异常: ${swapError}`);
                    }
                }
            } else {
                logger.info(`开仓后资金配比合理，无需配平`);
            }
        } catch (error) {
            logger.error(`开仓后配平检查失败: ${error}`);
        }
    }

    /***
     * 添加流动性仓位
     * @param lowerTick 仓位区间 Lower
     * @param upperTick 仓位区间 Upper
     */
    async toAddLiquidity(lowerTick: number, upperTick: number) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 等待0.5~1秒，必须，防止资产数据延迟获取
        const result = await this.getAssert();
        if (result === null) {
            logger.error("获取资金信息异常 => Not ADD Liquidity");
            return false;
        }
        const [balanceA, balanceB, balanceSUI] = result as number[];
        logger.info(`开仓前钱包资产: ${this.nameA}: ${balanceA} | ${this.nameB}: ${balanceB} SUI: ${balanceSUI}`);
        const pool = await this.getPool(this.poolId)
        if (!pool) {
            logger.info(`获取Pool异常 => Not ADD Liquidity`);
            return false;
        }
        
        // 检查当前tick是否在区间内
        const currentTick = pool.current_tick;
        if (currentTick <= lowerTick || currentTick >= upperTick) {
            logger.error(`当前tick ${currentTick} 超出区间 [${lowerTick}, ${upperTick}] => Not ADD Liquidity`);
            return false;
        }
        
        const curSqrtPrice = new BN(pool.current_sqrt_price);
        const strategyConfig = getStrategyConfig();
        
        // 计算实际可用余额，预留一些作为gas费
        const gasReserve = 0.1;
        const bufferRatio = 0.02; // 2%缓冲量
        const availableBalanceA = Math.max(0, balanceA * (1 - bufferRatio) - (this.coinA === "0x2::sui::SUI" ? gasReserve : 0));
        const availableBalanceB = Math.max(0, balanceB * (1 - bufferRatio) - (this.coinB === "0x2::sui::SUI" ? gasReserve : 0));
        
        const usageRate = strategyConfig.fundUsageRate;
        const usableAmountA = availableBalanceA * usageRate;
        const usableAmountB = availableBalanceB * usageRate;
        
        logger.info(`资金计算: A=${usableAmountA.toFixed(6)} ${this.nameA}, B=${usableAmountB.toFixed(6)} ${this.nameB} (使用率${(usageRate*100).toFixed(0)}%, 缓冲${(bufferRatio*100).toFixed(1)}%)`);
        
        // 智能选择基准代币：根据目标比例选择能充分利用资金的方案
        const [x, y] = this.calXY(lowerTick, upperTick, curSqrtPrice.toString());
        const ratio = x / y; // A:B的目标比例
        
        // 计算以A为基准能添加多少流动性
        const requiredBFromA = usableAmountA / ratio;
        // 计算以B为基准能添加多少流动性  
        const requiredAFromB = usableAmountB * ratio;
        
        let useACoin = false;
        let baseAmount = 0;
        
        if (requiredBFromA <= usableAmountB && usableAmountA > 0) {
            // 可以以A为基准
            if (requiredAFromB <= usableAmountA && usableAmountB > 0) {
                // 两种都可以，选择能提供更多流动性的
                if (usableAmountA > requiredAFromB) {
                    useACoin = true;
                    baseAmount = usableAmountA;
                    logger.info(`选择A代币作为基准，使用${baseAmount.toFixed(6)} ${this.nameA}, 需要${requiredBFromA.toFixed(6)} ${this.nameB}`);
                } else {
                    useACoin = false;
                    baseAmount = usableAmountB;
                    logger.info(`选择B代币作为基准，使用${baseAmount.toFixed(6)} ${this.nameB}, 需要${requiredAFromB.toFixed(6)} ${this.nameA}`);
                }
            } else {
                // 只能以A为基准
                useACoin = true;
                baseAmount = usableAmountA;
                logger.info(`只能以A代币作为基准，使用${baseAmount.toFixed(6)} ${this.nameA}, 需要${requiredBFromA.toFixed(6)} ${this.nameB}`);
            }
        } else if (requiredAFromB <= usableAmountA && usableAmountB > 0) {
            // 只能以B为基准
            useACoin = false;
            baseAmount = usableAmountB;
            logger.info(`只能以B代币作为基准，使用${baseAmount.toFixed(6)} ${this.nameB}, 需要${requiredAFromB.toFixed(6)} ${this.nameA}`);
        } else {
            logger.error(`资金不足以开仓: A需要=${requiredAFromB.toFixed(6)}(有${usableAmountA.toFixed(6)}), B需要=${requiredBFromA.toFixed(6)}(有${usableAmountB.toFixed(6)})`);
            return false;
        }
        
        if (baseAmount <= 0) {
            logger.error(`基准代币数量不足: ${baseAmount}`);
            return false;
        }
        
        const coinAmountBN = new BN(toBigNumberStr(baseAmount, useACoin ? this.decimalsA : this.decimalsB));
        const liquidityInput = ClmmPoolUtil.estLiquidityAndCoinAmountFromOneAmounts(
            lowerTick,
            upperTick,
            coinAmountBN,
            useACoin, // 根据选择使用A或B代币作为基准
            true,
            strategyConfig.slippage,
            curSqrtPrice
        );
        
        // 显示计算结果
        logger.info(`流动性计算结果: coinAmountA=${liquidityInput?.coinAmountA?.toString()}, coinAmountB=${liquidityInput?.coinAmountB?.toString()}`);
        
        // 检查计算结果是否有效
        if (!liquidityInput || liquidityInput.coinAmountA.isNeg() || liquidityInput.coinAmountB.isNeg()) {
            logger.error(`流动性计算结果无效: coinAmountA=${liquidityInput?.coinAmountA?.toString()}, coinAmountB=${liquidityInput?.coinAmountB?.toString()}`);
            return false;
        }
        
        // 验证计算的金额是否超过可用余额
        const requiredA = liquidityInput.coinAmountA.toNumber() / Math.pow(10, this.decimalsA);
        const requiredB = liquidityInput.coinAmountB.toNumber() / Math.pow(10, this.decimalsB);
        logger.info(`最终需要资金: ${this.nameA}=${requiredA.toFixed(6)}, ${this.nameB}=${requiredB.toFixed(6)}`);
        logger.info(`可用余额: ${this.nameA}=${availableBalanceA.toFixed(6)}, ${this.nameB}=${availableBalanceB.toFixed(6)}`);
        
        if (requiredA > availableBalanceA || requiredB > availableBalanceB) {
            logger.error(`计算错误，所需资金超出可用余额: 需要${this.nameA}=${requiredA.toFixed(6)}(可用${availableBalanceA.toFixed(6)}), 需要${this.nameB}=${requiredB.toFixed(6)}(可用${availableBalanceB.toFixed(6)})`);
            return false;
        }
        // liquidityInput
        try {
            const config = await this.getConfig();
            if (!config || !config.contractConfig) {
                logger.error(`Add Liquidity Failed: Invalid config`);
                return false;
            }
            
            let oc = new OnChainCalls(this.client, config.contractConfig, {signer: this.keyPair});
            let resp = await oc.openPositionWithFixedAmount(pool, lowerTick, upperTick, liquidityInput);
            
            // 检查交易状态
            const transaction = resp as any;
            const status = transaction?.effects?.status?.status;
            if (status === 'success') {
                logger.info(`Add Liquidity success`);
                return true;
            } else {
                logger.error(`Add Liquidity failed: status = ${status}`);
                return false;
            }
        } catch (e) {
            logger.error(`ADD Liquidity Failed: ${e}`);
            return false;
        }
    }

    async toSwap(poolState: Pool, a2b: boolean, amount: number, slippage = 0.05) {
        try {
            // 在swap前进行价格检查
            const strategyConfig = getStrategyConfig();
            const swapValue = await this.calculateSwapValue(poolState, a2b, amount);
            if (swapValue < strategyConfig.minSwapValue) {
                logger.warn(`🚫 Swap被拒绝: 交易价值($${swapValue.toFixed(2)})小于$${strategyConfig.minSwapValue}美金阈值`);
                return false;
            }
            
            logger.info(`✅ Swap通过价格检查: 交易价值$${swapValue.toFixed(2)} >= $${strategyConfig.minSwapValue}`);
            
            let iSwapParams: ISwapParams = {
                pool: poolState,
                amountIn: toBigNumber(amount, a2b ? this.decimalsA : this.decimalsB),
                amountOut: 0,
                aToB: a2b,
                byAmountIn: true,
                slippage: slippage
            }
            const config = await getMainnetConfig();
            let oc = new OnChainCalls(this.client, config.contractConfig, {signer: this.keyPair});

            const resp = await oc.swapAssets(iSwapParams);
            // logger.info(`Swap Resp: ${JSON.stringify(resp)}`);
            // @ts-ignore
            return resp["effects"]['status']['status'] === 'success'

        } catch (e) {
            logger.error(`Swap Failed: ${e}`);
            return false
        }

    }


    /**
     * 计算swap交易的价值（美元）
     * @param poolState 池子状态
     * @param a2b 是否A换B
     * @param amount swap数量
     * @returns 交易价值（美元）
     */
    async calculateSwapValue(poolState: Pool, a2b: boolean, amount: number): Promise<number> {
        try {
            // 确定要查询价格的代币地址
            const tokenAddress = a2b ? this.coinA : this.coinB;
            
            if (!tokenAddress) {
                logger.warn('无法确定代币地址，跳过价格检查');
                return 0;
            }
            
            // 获取代币价格
            const tokenPrices = await fetchTokenPrices([tokenAddress]);
            
            if (tokenPrices.length === 0) {
                logger.warn(`无法获取代币 ${tokenAddress} 的价格信息，跳过价格检查`);
                return 0;
            }
            
            const priceInfo = tokenPrices[0];
            const priceValue = parseFloat(priceInfo.price);
            const swapValue = amount * priceValue;
            
            logger.info(`💰 Swap价格计算: 代币=${a2b ? this.nameA : this.nameB}, 数量=${amount.toFixed(6)}, 价格=$${priceValue.toFixed(6)}, 总价值=$${swapValue.toFixed(2)}`);
            
            return swapValue;
            
        } catch (error) {
            logger.error(`计算swap价值失败: ${error}`);
            return 0;
        }
    }

    /**
     * 计算配平参数
     * @param p 当前价格
     * @param x 目标代币A数量
     * @param y 目标代币B数量
     * @param a 当前钱包代币A余额
     * @param b 当前钱包代币B余额
     * @param slip 允许误差，0.1表示10%
     * @returns a2b swap方向，amount swap数量
     */
    calSwap(p: number, x: number, y: number, a: number, b: number, slip: number): [boolean, number] {
        const k = x / y; // 目标比例 A:B
        const A = this.nameA;
        const B = this.nameB;

        logger.info(`配平计算: 目标比例k=${k.toFixed(6)}, 当前比例=${(a/b).toFixed(6)}, 价格p=${p.toFixed(6)}, 滑点=${slip}`);

        // 如果B资产为0，只能用A换B
        if (b === 0) {
            logger.info(`${B} 资产不足, 执行 ${A} => ${B}`);
            const a2b = true;
            const n = (a - b * k) / (1 + p * k);  // n此时表示代币A的输入值
            const a_ = a - n;
            const b_ = b + n * p;
            logger.info(`计算 Swap:${A}->${B},输入转移数量:${n} 配平后 ${a_} ${b_}`);
            return [a2b, this.round(n, 4)];
        }

        // 检查是否在容忍范围内，无需配平
        if (k <= a / b && a / b <= (1 + slip) * k) {
            const a2b = false;
            const n = 0;
            logger.info(`Swap:否 配平前 ${a} ${b} 转移数量:${n} 滑点:${slip}`);
            return [a2b, n];
        }

        // A资产过多，需要A换B
        if (a / b > (1 + slip) * k) {
            logger.info(`${B} 资产不足, 执行 ${A} => ${B}`);
            const n = (a - b * k) / (1 + p * k);  // n此时表示代币A的输入值
            const a_ = a - n;
            const b_ = b + n * p;
            const a2b = true;
            logger.info(`计算 Swap:${A}->${B},输入转移数量:${n} 配平后 ${a_} ${b_}`);
            return [a2b, this.round(n, 4)];
        }

        // A资产不足，需要B换A  
        if (a / b < k) {
            logger.info(`${A} 资产不足, 执行 ${B} => ${A}`);
            const n = (b * k * p - a * p) / (1 + k * p);  // n此时表示输入代币B的数量
            const a_ = a + n / p;
            const b_ = b - n;
            const a2b = false;
            logger.info(`计算 Swap:${B}->${A},输入转移数量:${n} 配平后 ${a_} ${b_}`);
            return [a2b, this.round(n, 4)];
        }

        // 如果没有满足的条件，返回默认值
        return [false, 0];
    }

    /**
     * 基于pool仓位比例的配平计算
     * @param p 当前价格
     * @param x 目标代币A数量
     * @param y 目标代币B数量
     * @param a 当前代币A余额
     * @param b 当前代币B余额
     * @param poolRatio 当前pool仓位占据总可利用token price的仓位比例
     * @param threshold 阈值，默认0.6表示60%
     * @returns [是否需要swap, swap数量]
     */
    calSwapByPoolRatio(p: number, x: number, y: number, a: number, b: number, poolRatio: number, threshold: number = 0.6): [boolean, number] {
        const k = x / y; // 目标比例 A:B
        const A = this.nameA;
        const B = this.nameB;

        logger.info(`Pool仓位比例配平计算: 目标比例k=${k.toFixed(6)}, 当前比例=${(a/b).toFixed(6)}, 价格p=${p.toFixed(6)}, pool仓位比例=${(poolRatio*100).toFixed(1)}%, 阈值=${(threshold*100).toFixed(1)}%`);

        // 如果B资产为0，只能用A换B
        if (b === 0) {
            logger.info(`${B} 资产不足, 执行 ${A} => ${B}`);
            const a2b = true;
            const n = (a - b * k) / (1 + p * k);
            const a_ = a - n;
            const b_ = b + n * p;
            logger.info(`计算 Swap:${A}->${B},输入转移数量:${n} 配平后 ${a_} ${b_}`);
            return [a2b, this.round(n, 4)];
        }

        // 检查pool仓位比例是否低于阈值
        if (poolRatio < threshold) {
            logger.info(`Pool仓位比例${(poolRatio*100).toFixed(1)}% < 阈值${(threshold*100).toFixed(1)}%，需要执行swap配平`);
            
            // 计算当前比例与目标比例的差异
            const currentRatio = a / b;
            const ratioDiff = Math.abs(currentRatio - k);
            
            // 如果当前比例接近目标比例，选择较小的swap量
            if (ratioDiff < k * 0.1) { // 差异小于10%
                logger.info(`当前比例接近目标比例，执行最小swap量配平`);
                const minSwapAmount = Math.min(a, b) * 0.1; // 取较小余额的10%作为最小swap量
                
                if (currentRatio > k) {
                    // A过多，A换B
                    const a2b = true;
                    const n = Math.min(minSwapAmount, (a - b * k) / (1 + p * k));
                    logger.info(`执行最小swap: ${A}->${B}, 数量=${n.toFixed(6)}`);
                    return [a2b, this.round(n, 4)];
                } else {
                    // B过多，B换A
                    const a2b = false;
                    const n = Math.min(minSwapAmount, (b * k * p - a * p) / (1 + k * p));
                    logger.info(`执行最小swap: ${B}->${A}, 数量=${n.toFixed(6)}`);
                    return [a2b, this.round(n, 4)];
                }
            } else {
                // 比例差异较大，执行完整配平
                if (currentRatio > k) {
                    // A过多，需要A换B
                    logger.info(`${B} 资产不足, 执行 ${A} => ${B}`);
                    const n = (a - b * k) / (1 + p * k);
                    const a_ = a - n;
                    const b_ = b + n * p;
                    const a2b = true;
                    logger.info(`计算 Swap:${A}->${B},输入转移数量:${n} 配平后 ${a_} ${b_}`);
                    return [a2b, this.round(n, 4)];
                } else {
                    // A不足，需要B换A
                    logger.info(`${A} 资产不足, 执行 ${B} => ${A}`);
                    const n = (b * k * p - a * p) / (1 + k * p);
                    const a_ = a + n / p;
                    const b_ = b - n;
                    const a2b = false;
                    logger.info(`计算 Swap:${B}->${A},输入转移数量:${n} 配平后 ${a_} ${b_}`);
                    return [a2b, this.round(n, 4)];
                }
            }
        } else {
            // Pool仓位比例足够，无需配平
            logger.info(`Pool仓位比例${(poolRatio*100).toFixed(1)}% >= 阈值${(threshold*100).toFixed(1)}%，无需配平，直接追加`);
            return [false, 0];
        }
    }

    /***
     * 检测仓位
     * @param pos 仓位信息
     * @param pool 池子信息
     */
    async checkPos(pos: IPosition, pool: Pool) {
        if (pos.pool_id != pool.id) {
            logger.warn(`发现非策略目标Pool:${pos.pool_id} => PASS`)
            return
        }
        const current_tick = pool.current_tick;
        // let currentSqrtPrice = pool.current_sqrt_price;

        let lowerTick = pos.lower_tick;
        let upperTick = pos.upper_tick;
        let posID = pos.position_id;

        if (current_tick < upperTick && current_tick > lowerTick) {
            logger.info(`当前Tick: ${current_tick} => 处于区间:[${lowerTick},${upperTick}] => 保留`);
            return;
        }
        //突破
        if (current_tick < lowerTick) {
            logger.info(`当前Tick: ${current_tick} => 突破下区间:${lowerTick} => 平仓`);

            const closeOK = await this.toClosePos(pool, posID);
            logger.info(`关闭仓位并自动收集奖励: ${closeOK ? "success" : "fail"}`);

            this.lastBreak = BreakType.Down
            this.consecutiveBreakCount++; // 增加连续突破计数器
            this.lastBreakTime = Date.now(); // 更新最后突破时间
            logger.info(`设置突破标志位: ${this.lastBreak}, 连续突破次数: ${this.consecutiveBreakCount}, 突破时间: ${new Date(this.lastBreakTime).toLocaleString()}`);
            return;
        }
        // 突破
        if (current_tick > upperTick) {
            logger.info(`当前Tick: ${current_tick} => 突破上区间:${upperTick} => 平仓`);

            const closeOK = await this.toClosePos(pool, posID);
            logger.info(`关闭仓位并自动收集奖励: ${closeOK ? "success" : "fail"}`);

            this.lastBreak = BreakType.Up
            this.consecutiveBreakCount++; // 增加连续突破计数器
            this.lastBreakTime = Date.now(); // 更新最后突破时间
            logger.info(`设置突破标志位: ${this.lastBreak}, 连续突破次数: ${this.consecutiveBreakCount}, 突破时间: ${new Date(this.lastBreakTime).toLocaleString()}`);

            return;
        }

    }

    /**
     * 关闭指定仓位
     * @param pool 池信息
     * @param posID 仓位ID
     */
    async toClosePos(pool: Pool, posID: string) {
        try {
            const config = await this.getConfig();
            if (!config || !config.contractConfig) {
                logger.error(`Close Position Failed: Invalid config`);
                return false;
            }
            
            let oc = new OnChainCalls(this.client, config.contractConfig, {signer: this.keyPair});
            let resp = await oc.closePosition(pool, posID);
            
            // 检查交易状态
            const transaction = resp as any;
            const status = transaction?.effects?.status?.status;
            if (status === 'success') {
                logger.info(`Close Position success (自动收集所有fee和rewards)`);
                return true;
            } else {
                logger.error(`Close Position failed: status = ${status}`);
                return false;
            }
        } catch (e) {
            const errorMessage = String(e);
            logger.error(`Close Position Failed: ${e}`);
            
            // 检查是否是对象已删除的错误
            if (errorMessage.includes('deleted') || errorMessage.includes('invalid') || errorMessage.includes('not found')) {
                logger.warn(`仓位对象可能已被删除或无效，无法关闭仓位`);
                return true; // 如果仓位已经不存在，认为关闭成功
            }
            
            return false;
        }
    }

    /**
     * 处理开仓和显示流程
     */
    async handlePositionCreation(pool: Pool, currentPrice: number) {
        logger.info(`开始处理开仓流程...`);
        
        try {
            // 显示开仓前的状态和策略配置
            logger.info(`📊 开仓前状态显示...`);  
            // 执行开仓
            logger.info(`🚀 开始执行开仓操作...`);
            await this.toOpenPos(pool);
            await new Promise(resolve => setTimeout(resolve, 1000));
            try {
                const [g1, g2] = this.calG();
                const tickSpacing = pool.ticks_manager.tick_spacing;
                const strategyConfig = getStrategyConfig();
                
                // 使用指数退避后的最小区间倍数
                const expandedMinRangeMultiplier = strategyConfig.minRangeMultiplier * Math.pow(strategyConfig.rangeExpansionMultiplier, this.consecutiveBreakCount);
                const [lowerTick, upperTick] = calTickIndex(pool.current_tick, tickSpacing, g1, g2, expandedMinRangeMultiplier);
                
                const lowerPrice = TickMath.tickIndexToPrice(lowerTick, this.decimalsA, this.decimalsB).toNumber();
                const upperPrice = TickMath.tickIndexToPrice(upperTick, this.decimalsA, this.decimalsB).toNumber();
                
                const rangePercentage = ((upperPrice - lowerPrice) / currentPrice * 100).toFixed(2);
                const lowerPercentage = ((lowerPrice - currentPrice) / currentPrice * 100).toFixed(2);
                const upperPercentage = ((upperPrice - currentPrice) / currentPrice * 100).toFixed(2);
                
                logger.info(`=== 📊 开仓策略配置 ===`);
                logger.info(`当前价格: ${currentPrice.toFixed(6)} ${this.nameB}/${this.nameA}`);
                logger.info(`策略参数: G=${this.G}, g1=${g1}, g2=${g2}`);
                logger.info(`最小区间倍数: ${strategyConfig.minRangeMultiplier} × tickSpacing(${tickSpacing})`);
                logger.info(`连续突破次数: ${this.consecutiveBreakCount}, 扩展倍数: ${expandedMinRangeMultiplier.toFixed(2)}`);
                logger.info(`区间范围: ${lowerPrice.toFixed(6)} - ${upperPrice.toFixed(6)} (${rangePercentage}%)`);
                logger.info(`价格偏移: 下界${lowerPercentage}%, 上界${upperPercentage}%`);
                
                const historicalData = await fetchHistoricalPriceData(pool);
                const predictedRange = { lower: lowerPrice, upper: upperPrice };
                
                displayPoolChart(pool, currentPrice, null, historicalData, predictedRange);
            } catch (preDisplayError) {
                logger.warn(`开仓前显示渲染失败: ${preDisplayError}`);
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
            // 等待交易确认
            logger.info(`⏳ 等待交易确认...`);
            // 重新获取仓位信息
            logger.info(`🔍 检查开仓结果...`);
            const newPositions = await this.getUserPositions(this.walletAddress);
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (newPositions) {
                const newPoss = newPositions.filter(position => position.pool_id === this.poolId);
                if (newPoss.length > 0) {
                    logger.info(`✅ 开仓成功，新仓位已创建`);
                    logger.info(`仓位详情: ID=${newPoss[0].position_id}, 区间=[${newPoss[0].lower_tick}, ${newPoss[0].upper_tick}]`);
                    
                    // 获取历史数据并显示
                    try {
                        const historicalData = await fetchHistoricalPriceData(pool);
                        const pos = newPoss[0];
                        const lowerPrice = TickMath.tickIndexToPrice(pos.lower_tick, this.decimalsA, this.decimalsB).toNumber();
                        const upperPrice = TickMath.tickIndexToPrice(pos.upper_tick, this.decimalsA, this.decimalsB).toNumber();
                        const positionRange = { lower: lowerPrice, upper: upperPrice };
                        
                        logger.info(`📊 渲染开仓后的仓位信息...`);
                        displayPoolChart(pool, currentPrice, null, historicalData, positionRange);
                        
                        logger.info(`🎯 开仓流程完成，仓位已建立并显示`);
                    } catch (displayError) {
                        logger.warn(`开仓后显示渲染失败: ${displayError}`);
                    }
                } else {
                    logger.warn(`⚠️ 开仓后未检测到新仓位，可能开仓失败`);
                    // 显示当前状态
                    try {
                        const historicalData = await fetchHistoricalPriceData(pool);
                        const [g1, g2] = this.calG();
                        const tickSpacing = pool.ticks_manager.tick_spacing;
                        const strategyConfig = getStrategyConfig();
                        const [lowerTick, upperTick] = calTickIndex(pool.current_tick, tickSpacing, g1, g2, strategyConfig.minRangeMultiplier);
                        
                        const lowerPrice = TickMath.tickIndexToPrice(lowerTick, this.decimalsA, this.decimalsB).toNumber();
                        const upperPrice = TickMath.tickIndexToPrice(upperTick, this.decimalsA, this.decimalsB).toNumber();
                        const predictedRange = { lower: lowerPrice, upper: upperPrice };
                        
                        displayPoolChart(pool, currentPrice, null, historicalData, predictedRange);
                    } catch (fallbackError) {
                        logger.warn(`fallback显示也失败: ${fallbackError}`);
                    }
                }
            } else {
                logger.warn(`❌ 无法获取仓位信息，开仓状态未知`);
            }
        } catch (error) {
            logger.error(`开仓流程失败: ${error}`);
        }
    }

    /**
     * 核心启动器
     */
    async core() {
        // 每次核心循环都重新获取负载均衡的客户端
        this.client = createBalancedSuiClient();
        logger.info(`重新获取负载均衡RPC客户端`);
        
        // 检查是否需要冷却重置
        this.checkCoolDownReset();
        
        // 获取当前仓位
        const positions = await this.getUserPositions(this.walletAddress)
        if (positions === null) {
            logger.warn(`获取仓位列表fail => PASS`);
            return;
        }
        // 仓位集合过滤，去除非目标池下的仓位
        const poss: IPosition[] = positions.filter(position => position.pool_id === this.poolId);
        //休息1000ms
        await new Promise(resolve => setTimeout(resolve, 1000));
        // 获取Pool信息
        const pool = await this.getPool(this.poolId);
        if (pool === null) {
            logger.warn("获取Pool信息fail => PASS")
            return;
        }
        logger.info(`获取Pool信息: ${this.nameA}/${this.nameB} success`);

        // 显示Pool详细信息
        logger.info(`=== Pool详细信息 ===`);
        logger.info(`Pool ID: ${pool.id}`);
        logger.info(`代币A: ${this.nameA} (${this.coinA})`);
        logger.info(`代币B: ${this.nameB} (${this.coinB})`);
        logger.info(`精度: A=${this.decimalsA}, B=${this.decimalsB}`);
        logger.info(`Tick Spacing: ${pool.ticks_manager.tick_spacing}`);

        // 计算当前价格和预测的仓位区间
        const currentTick = pool.current_tick;
        const currentPrice = TickMath.tickIndexToPrice(currentTick, this.decimalsA, this.decimalsB).toNumber();
        
        logger.info(`当前价格: ${currentPrice.toFixed(6)} ${this.nameB}/${this.nameA}`);
        logger.info(`当前Tick: ${currentTick}`);
        
        // 计算预测的仓位区间（用于开仓）
        let predictedPositionRange = { lower: currentPrice * 0.998, upper: currentPrice * 1.002 };
        if (poss.length === 0) {
            // 如果没有仓位，计算预测的仓位区间
            const [g1, g2] = this.calG();
            const tickSpacing = pool.ticks_manager.tick_spacing;
            const strategyConfig = getStrategyConfig();
            
            // 使用指数退避后的最小区间倍数
            const expandedMinRangeMultiplier = strategyConfig.minRangeMultiplier * Math.pow(strategyConfig.rangeExpansionMultiplier, this.consecutiveBreakCount);
            const [lowerTick, upperTick] = calTickIndex(currentTick, tickSpacing, g1, g2, expandedMinRangeMultiplier);
            
            const lowerPrice = TickMath.tickIndexToPrice(lowerTick, this.decimalsA, this.decimalsB).toNumber();
            const upperPrice = TickMath.tickIndexToPrice(upperTick, this.decimalsA, this.decimalsB).toNumber();
            predictedPositionRange = { lower: lowerPrice, upper: upperPrice };
            
            logger.info(`预测仓位区间: ${lowerPrice.toFixed(6)} - ${upperPrice.toFixed(6)} (tick: ${lowerTick} - ${upperTick})`);
            logger.info(`连续突破次数: ${this.consecutiveBreakCount}, 扩展倍数: ${expandedMinRangeMultiplier.toFixed(2)}`);
        }
        //休息1000ms
        await new Promise(resolve => setTimeout(resolve, 1000));
        // 实时可视化监控
        try {
            const historicalData = await fetchHistoricalPriceData(pool);
            
            let positionRange = predictedPositionRange;
            if (poss.length > 0) {
                const pos = poss[0];
                const lowerPrice = TickMath.tickIndexToPrice(pos.lower_tick, this.decimalsA, this.decimalsB).toNumber();
                const upperPrice = TickMath.tickIndexToPrice(pos.upper_tick, this.decimalsA, this.decimalsB).toNumber();
                positionRange = { lower: lowerPrice, upper: upperPrice };
            }
            
            displayPoolChart(pool, currentPrice, null, historicalData, positionRange);
        } catch (error) {
            logger.warn(`渲染监控图表失败: ${error}`);
        }

        await new Promise(resolve => setTimeout(resolve, 300));
        // 开仓逻辑
        if (poss.length === 0) { logger.info(`当前仓位不存在 => 准备开仓`);
        
        // 在开仓前显示策略配置和预期价格区间
        const [g1, g2] = this.calG();
        const tickSpacing = pool.ticks_manager.tick_spacing;
        const strategyConfig = getStrategyConfig();
        const [lowerTick, upperTick] = calTickIndex(currentTick, tickSpacing, g1, g2, strategyConfig.minRangeMultiplier);
        
        const lowerPrice = TickMath.tickIndexToPrice(lowerTick, this.decimalsA, this.decimalsB).toNumber();
        const upperPrice = TickMath.tickIndexToPrice(upperTick, this.decimalsA, this.decimalsB).toNumber();
        
        const rangePercentage = ((upperPrice - lowerPrice) / currentPrice * 100).toFixed(2);
        const lowerPercentage = ((lowerPrice - currentPrice) / currentPrice * 100).toFixed(2);
        const upperPercentage = ((upperPrice - currentPrice) / currentPrice * 100).toFixed(2);
        
        logger.info(`=== 📊 开仓策略配置 ===`);
        logger.info(`当前价格: ${currentPrice.toFixed(6)} ${this.nameB}/${this.nameA}`);
        logger.info(`策略参数: G=${this.G}, g1=${g1}, g2=${g2}`);
        logger.info(`最小区间倍数: ${strategyConfig.minRangeMultiplier} × tickSpacing(${tickSpacing})`);
        logger.info(`连续突破次数: ${this.consecutiveBreakCount}, 扩展倍数: ${strategyConfig.minRangeMultiplier.toFixed(2)}`);
        logger.info(`区间范围: ${lowerPrice.toFixed(6)} - ${upperPrice.toFixed(6)} (${rangePercentage}%)`);
        logger.info(`价格偏移: 下界${lowerPercentage}%, 上界${upperPercentage}%`);
        await this.handlePositionCreation(pool, currentPrice);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return;
        }


        // 仓位检测和平仓
        for (const pos of poss) {
            // 首先检查仓位是否需要关闭（基于价格突破）
            await this.checkPos(pos, pool);
            
            // 检查并显示仓位费用和奖励信息
            logger.info(`=== 检查仓位 ${pos.position_id} 的费用和奖励信息 ===`);
            const feeAndRewards = await this.getPositionFeeAndRewards(pos, pool);
            
            // 检查是否有可领取的费用或奖励
            let hasRewards = false;
            let hasFees = false;
            
            if (feeAndRewards) {
                if (feeAndRewards.rewards && feeAndRewards.rewards.length > 0) {
                    hasRewards = true;
                }
                
                if (feeAndRewards.fee) {
                    const feeA = stringToDividedNumber(feeAndRewards.fee.coinA.toString(), this.decimalsA);
                    const feeB = stringToDividedNumber(feeAndRewards.fee.coinB.toString(), this.decimalsB);
                    if (feeA > 0 || feeB > 0) {
                        hasFees = true;
                    }
                }
            }
            
            // 然后检查是否需要关闭仓位（基于奖励阈值）
            let shouldClosePosition = false;
            if (feeAndRewards) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const shouldReopen = await this.checkRewardsThreshold(feeAndRewards);
                
                if (shouldReopen) {
                    logger.info(`🎯 手续费+奖励满足重开条件，准备重开仓位`);
                    shouldClosePosition = true;
                    
                    // 直接关闭仓位，会自动收集所有fee和rewards
                    const closeSuccess = await this.toClosePos(pool, pos.position_id);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    if (closeSuccess) {
                        logger.info(`✅ 成功关闭仓位并自动收集手续费和奖励，准备重新开仓`);
                        
                        // 等待交易确认
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        // 重新开仓
                        await this.handlePositionCreation(pool, currentPrice);
                        return; // 重开后退出当前循环
                    } else {
                        logger.error(`❌ 关闭仓位失败，无法重开`);
                    }
                }
            }
            
            // 只有在不需要关闭仓位的情况下，才检查是否需要追加流动性
            if (!shouldClosePosition && feeAndRewards && poss.length > 0) {
                logger.info(`检查是否需要为现有仓位追加流动性...`);
                const shouldAddLiquidity = await this.checkShouldAddLiquidity(pos, pool, feeAndRewards);
                
                if (shouldAddLiquidity) {
                    await this.checkAndAddToExistingPosition(poss[0], pool);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else {
                    logger.info(`跳过追加流动性：收益占比检查未通过或获取收益失败`);
                }
            }

            
            // 提示可领取的内容（关闭仓位时会自动收集）
            if (hasRewards) {
                logger.info(`发现可领取的奖励，关闭仓位时会自动收集，或使用 collectPositionRewards() 方法手动领取`);
            }
            if (hasFees) {
                logger.info(`发现可领取的费用，关闭仓位时会自动收集，或使用 collectPositionFeeAndRewards() 方法手动领取`);
            }
        }

    }

    /**
     * 检查并向现有仓位追加流动性
     */
    async checkAndAddToExistingPosition(position: IPosition, pool: Pool) {
        try {
            // 获取当前余额
            const result = await this.getAssert();
            if (result === null) {
                logger.info("获取资金信息异常，跳过追加流动性检查");
                return;
            }
            
            const [balanceA, balanceB, balanceSUI] = result as number[];
            const strategyConfig = getStrategyConfig();
            
            // 计算可用余额，预留gas费和缓冲量
            const gasReserve = 0.1;
            const bufferRatio = 0.02; // 2%缓冲量，避免精度问题
            const availableBalanceA = Math.max(0, balanceA * (1 - bufferRatio) - (this.coinA === "0x2::sui::SUI" ? gasReserve : 0));
            const availableBalanceB = Math.max(0, balanceB * (1 - bufferRatio) - (this.coinB === "0x2::sui::SUI" ? gasReserve : 0));
            
            // 检查是否有足够的余额需要追加
            const minAddThreshold = parseFloat(process.env.MIN_ADD_THRESHOLD || '1'); // 最小追加阈值，从环境变量获取，默认1
            if (availableBalanceA < minAddThreshold && availableBalanceB < minAddThreshold) {
                logger.info(`余额不足追加阈值，跳过追加流动性: A=${availableBalanceA}, B=${availableBalanceB}`);
                return;
            }
            
            // 检查当前价格是否还在仓位区间内
            const currentTick = pool.current_tick;
            if (currentTick <= position.lower_tick || currentTick >= position.upper_tick) {
                logger.info(`当前价格已超出仓位区间，不追加流动性: tick=${currentTick}, 区间=[${position.lower_tick}, ${position.upper_tick}]`);
                return;
            }
            
            logger.info(`检测到可追加余额: A=${availableBalanceA.toFixed(6)} ${this.nameA}, B=${availableBalanceB.toFixed(6)} ${this.nameB} (已扣除${(bufferRatio*100).toFixed(1)}%缓冲量)`);
            
            // 计算追加流动性所需的代币比例
            const curSqrtPrice = new BN(pool.current_sqrt_price);
            const [x, y] = this.calXY(position.lower_tick, position.upper_tick, pool.current_sqrt_price);
            logger.info(`现有仓位所需比例 x:y = ${x}:${y}`);
            
            // 计算当前pool仓位占据总可利用token price的仓位比例
            const currentPrice = TickMath.tickIndexToPrice(currentTick, this.decimalsA, this.decimalsB).toNumber();
            
            // 计算总可利用token的price价值
            const totalAvailableValue = availableBalanceA * currentPrice + availableBalanceB;
            
            // 计算当前pool仓位的price价值（假设pool仓位占用了大部分资金）
            const poolPositionValue = Math.min(availableBalanceA * currentPrice, availableBalanceB);
            
            // 计算pool仓位比例
            const poolRatio = totalAvailableValue > 0 ? poolPositionValue / totalAvailableValue : 0;
            
            logger.info(`Pool仓位比例计算: 总可利用价值=${totalAvailableValue.toFixed(6)}, Pool仓位价值=${poolPositionValue.toFixed(6)}, 比例=${(poolRatio*100).toFixed(1)}%`);
            
            // 使用新的基于pool仓位比例的配平逻辑
            const [a2b, swapAmount] = this.calSwapByPoolRatio(
                currentPrice, x, y, availableBalanceA, availableBalanceB, poolRatio, strategyConfig.poolPositionRatio
            );
            
            // 如果需要配平，先检查配平数量是否达到阈值
            if (swapAmount > 0) {
                if (swapAmount < minAddThreshold) {
                    logger.info(`配平数量太小(${swapAmount.toFixed(6)} < ${minAddThreshold})，跳过配平但继续检查是否可直接追加流动性`);
                } else {
                    logger.info(`追加流动性前需要配平: ${a2b ? this.nameA + '->' + this.nameB : this.nameB + '->' + this.nameA}, 数量=${swapAmount}`);
                    
                    // 在配平前进行价格检查
                    const strategyConfig = getStrategyConfig();
                    const swapValue = await this.calculateSwapValue(pool, a2b, swapAmount);
                    if (swapValue < strategyConfig.minSwapValue) {
                        logger.warn(`🚫 追加流动性配平被拒绝: 交易价值($${swapValue.toFixed(2)})小于$${strategyConfig.minSwapValue}美金阈值`);
                        // 跳过配平但继续检查是否可直接追加流动性
                    } else {
                        logger.info(`✅ 追加流动性配平通过价格检查: 交易价值$${swapValue.toFixed(2)} >= $${strategyConfig.minSwapValue}`);
                        const swapOK = await this.toSwap(pool, a2b, swapAmount, strategyConfig.slippage);
                        if (!swapOK) {
                            logger.warn("配平失败，但尝试直接追加流动性");
                        }
                        // 等待交易确认
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }
            
            // 重新获取余额（如果进行了配平）或使用原始余额
            let finalAvailableA = availableBalanceA;
            let finalAvailableB = availableBalanceB;
            
            if (swapAmount > 0 && swapAmount >= minAddThreshold) {
                // 只有在实际执行了配平时才重新获取余额
                const resultAfterSwap = await this.getAssert();
                if (resultAfterSwap === null) {
                    logger.error("配平后获取资金信息异常，取消追加流动性");
                    return;
                }
                
                const [newBalanceA, newBalanceB] = resultAfterSwap as number[];
                finalAvailableA = Math.max(0, newBalanceA * (1 - bufferRatio) - (this.coinA === "0x2::sui::SUI" ? gasReserve : 0));
                finalAvailableB = Math.max(0, newBalanceB * (1 - bufferRatio) - (this.coinB === "0x2::sui::SUI" ? gasReserve : 0));
                logger.info(`配平后重新获取余额: A=${finalAvailableA.toFixed(6)}, B=${finalAvailableB.toFixed(6)}`);
            } else {
                logger.info(`使用原始余额进行追加流动性: A=${finalAvailableA.toFixed(6)}, B=${finalAvailableB.toFixed(6)}`);
            }
            
            // 计算可使用的资金量
            const usageRate = strategyConfig.fundUsageRate;
            const usableAmountA = finalAvailableA * usageRate;
            const usableAmountB = finalAvailableB * usageRate;
            
            logger.info(`可用资金计算: A=${usableAmountA.toFixed(6)} ${this.nameA}, B=${usableAmountB.toFixed(6)} ${this.nameB} (使用率${(usageRate*100).toFixed(0)}%)`);
            
            // 智能选择基准代币：选择能提供更多流动性的代币作为基准
            const ratio = x / y; // A:B的目标比例
            
            // 计算以A为基准能添加多少流动性
            const maxLiquidityFromA = usableAmountA;
            const requiredBFromA = maxLiquidityFromA / ratio;
            
            // 计算以B为基准能添加多少流动性  
            const maxLiquidityFromB = usableAmountB * ratio;
            const requiredAFromB = usableAmountB * ratio;
            
            let useACoin = false;
            let baseAmount = 0;
            
            if (requiredBFromA <= usableAmountB && maxLiquidityFromA >= minAddThreshold) {
                // 可以以A为基准
                if (requiredAFromB <= usableAmountA && maxLiquidityFromB >= minAddThreshold) {
                    // 两种都可以，选择能提供更多流动性的
                    if (maxLiquidityFromA > maxLiquidityFromB) {
                        useACoin = true;
                        baseAmount = maxLiquidityFromA;
                        logger.info(`选择A代币作为基准，可添加更多流动性: ${maxLiquidityFromA.toFixed(6)} > ${maxLiquidityFromB.toFixed(6)}`);
                    } else {
                        useACoin = false;
                        baseAmount = usableAmountB;
                        logger.info(`选择B代币作为基准，可添加更多流动性: ${maxLiquidityFromB.toFixed(6)} >= ${maxLiquidityFromA.toFixed(6)}`);
                    }
                } else {
                    // 只能以A为基准
                    useACoin = true;
                    baseAmount = maxLiquidityFromA;
                    logger.info(`只能以A代币作为基准: 需要B=${requiredBFromA.toFixed(6)}, 可用B=${usableAmountB.toFixed(6)}`);
                }
            } else if (requiredAFromB <= usableAmountA && maxLiquidityFromB >= minAddThreshold) {
                // 只能以B为基准
                useACoin = false;
                baseAmount = usableAmountB;
                logger.info(`只能以B代币作为基准: 需要A=${requiredAFromB.toFixed(6)}, 可用A=${usableAmountA.toFixed(6)}`);
            } else {
                logger.info(`两种代币都不足以达到最小追加阈值${minAddThreshold}, A基准需要=${requiredBFromA.toFixed(6)}B(有${usableAmountB.toFixed(6)}), B基准需要=${requiredAFromB.toFixed(6)}A(有${usableAmountA.toFixed(6)})`);
                return;
            }
            
            if (baseAmount <= 0) {
                logger.info("基准代币数量不足，取消追加流动性");
                return;
            }
            
            const coinAmountBN = new BN(toBigNumberStr(baseAmount, useACoin ? this.decimalsA : this.decimalsB));
            const liquidityInput = ClmmPoolUtil.estLiquidityAndCoinAmountFromOneAmounts(
                position.lower_tick,
                position.upper_tick,
                coinAmountBN,
                useACoin, // 使用A或B代币作为基准
                true,
                strategyConfig.slippage,
                curSqrtPrice
            );
            
            if (!liquidityInput || liquidityInput.coinAmountA.isNeg() || liquidityInput.coinAmountB.isNeg()) {
                logger.error("追加流动性计算失败");
                return;
            }
            
            const requiredA = liquidityInput.coinAmountA.toNumber() / Math.pow(10, this.decimalsA);
            const requiredB = liquidityInput.coinAmountB.toNumber() / Math.pow(10, this.decimalsB);
            
            // 检查追加数量是否达到最小阈值
            if (requiredA < minAddThreshold && requiredB < minAddThreshold) {
                logger.info(`追加数量太小，跳过追加流动性: A=${requiredA.toFixed(6)} ${this.nameA}, B=${requiredB.toFixed(6)} ${this.nameB} (阈值=${minAddThreshold})`);
                return;
            }
            
            if (requiredA > finalAvailableA || requiredB > finalAvailableB) {
                logger.warn(`追加流动性所需资金超出余额: 需要A=${requiredA}(有${finalAvailableA}), 需要B=${requiredB}(有${finalAvailableB})`);
                return;
            }
            
            logger.info(`准备追加流动性: A=${requiredA.toFixed(6)} ${this.nameA}, B=${requiredB.toFixed(6)} ${this.nameB} (基于使用率${(strategyConfig.fundUsageRate*100).toFixed(0)}%计算)`);
            
            // 执行追加流动性
            const config = await this.getConfig();
            if (!config || !config.contractConfig) {
                logger.error("配置无效，无法追加流动性");
                return;
            }
            
            const oc = new OnChainCalls(this.client, config.contractConfig, {signer: this.keyPair});
            const resp = await oc.provideLiquidityWithFixedAmount(pool, position.position_id, liquidityInput);
            
            const transaction = resp as any;
            const status = transaction?.effects?.status?.status;
            if (status === 'success') {
                logger.info(`✅ 追加流动性成功: A=${requiredA} ${this.nameA}, B=${requiredB} ${this.nameB}`);
            } else {
                logger.error(`❌ 追加流动性失败: status = ${status}`);
            }
            
        } catch (error) {
            logger.error(`追加流动性过程中发生错误: ${error}`);
        }
    }

    /**
     * 获取当前仓位的奖励信息 - 无限重试直到成功
     * @param position 仓位信息
     * @param pool 池子信息
     * @returns 奖励信息数组
     */
    async getPositionRewards(position: IPosition, pool: Pool) {
        let attemptCount = 0;
        
        while (true) {
            attemptCount++;
            try {
                const config = await this.getConfig();
                if (!config || !config.contractConfig) {
                    logger.error(`获取仓位奖励失败: 配置无效`);
                    // 切换客户端并重试
                    this.client = createBalancedSuiClient();
                    logger.info(`Switched client for rewards attempt ${attemptCount + 1}`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
                
                let oc = new OnChainCalls(this.client, config.contractConfig, {signer: this.keyPair});
                const rewards = await oc.getAccruedRewards(pool, position.position_id);
                
                if (rewards && rewards.length > 0) {
                    logger.info(`🎁 获取到仓位奖励信息: ${rewards.length} 种奖励`);
                    
                    // 构建表格数据
                    const headers = ['序号', '代币符号', '奖励数量'];
                    const rows = rewards.map((reward, index) => {
                        const amount = stringToDividedNumber(reward.coinAmount, reward.coinDecimals);
                        return [(index + 1).toString(), reward.coinSymbol, amount.toString()];
                    });
                    
                    logger.info(`🎁 奖励信息表格:`);
                    logger.renderTable(headers, rows);
                    
                    logger.info(`Successfully got position rewards after ${attemptCount} attempts`);
                    return rewards;
                } else {
                    logger.info(`🎁 当前仓位暂无奖励`);
                    return [];
                }
            } catch (e) {
                logger.error(`获取仓位奖励 attempt ${attemptCount} failed: ${e}`);
            }
            
            // 切换客户端
            this.client = createBalancedSuiClient();
            logger.info(`Switched client for rewards attempt ${attemptCount + 1}`);
            
            // 短暂延迟避免过于频繁的请求
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    /**
     * 获取当前仓位的费用和奖励信息 - 无限重试直到成功
     * @param position 仓位信息
     * @param pool 池子信息
     * @returns 费用和奖励信息
     */
    async getPositionFeeAndRewards(position: IPosition, pool: Pool) {
        let attemptCount = 0;
        const maxAttempts = 3; // 最大重试次数
        
        while (attemptCount < maxAttempts) {
            attemptCount++;
            try {
                const config = await this.getConfig();
                if (!config || !config.contractConfig) {
                    logger.error(`获取仓位费用和奖励失败: 配置无效`);
                    if (attemptCount >= maxAttempts) {
                        logger.error(`达到最大重试次数，放弃获取费用和奖励`);
                        return null;
                    }
                    // 切换客户端并重试
                    this.client = createBalancedSuiClient();
                    logger.info(`Switched client for feeAndRewards attempt ${attemptCount + 1}`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
                
                let oc = new OnChainCalls(this.client, config.contractConfig, {signer: this.keyPair});
                const feeAndRewards = await oc.getAccruedFeeAndRewards(pool, position.position_id);
                
                if (feeAndRewards) {
                    logger.info(`获取到仓位费用和奖励信息:`);
                    
                    // 显示费用信息
                    if (feeAndRewards.fee) {
                        const feeA = stringToDividedNumber(feeAndRewards.fee.coinA.toString(), this.decimalsA);
                        const feeB = stringToDividedNumber(feeAndRewards.fee.coinB.toString(), this.decimalsB);
                        
                        // 构建费用表格数据
                        const feeHeaders = ['代币', '费用数量'];
                        const feeRows = [];
                        
                        if (feeA > 0) {
                            feeRows.push([this.nameA, feeA.toString()]);
                        }
                        if (feeB > 0) {
                            feeRows.push([this.nameB, feeB.toString()]);
                        }
                        
                        if (feeRows.length > 0) {
                            logger.info(`💰 手续费信息表格:`);
                            logger.renderTable(feeHeaders, feeRows);
                        } else {
                            logger.info(`💰 暂无手续费`);
                        }
                    }
                    
                    // 显示奖励信息
                    if (feeAndRewards.rewards && feeAndRewards.rewards.length > 0) {
                        logger.info(`🎁 奖励信息 (${feeAndRewards.rewards.length} 种):`);
                        
                        // 构建奖励表格数据
                        const rewardHeaders = ['序号', '代币符号', '奖励数量'];
                        const rewardRows = feeAndRewards.rewards.map((reward, index) => {
                            const amount = stringToDividedNumber(reward.coinAmount, reward.coinDecimals);
                            return [(index + 1).toString(), reward.coinSymbol, amount.toString()];
                        });
                        
                        logger.info(`🎁 奖励信息表格:`);
                        logger.renderTable(rewardHeaders, rewardRows);
                    } else {
                        logger.info(`🎁 暂无奖励`);
                    }
                    
                    logger.info(`Successfully got position fee and rewards after ${attemptCount} attempts`);
                    return feeAndRewards;
                } else {
                    logger.info(`当前仓位暂无费用和奖励`);
                    return null;
                }
            } catch (e) {
                const errorMessage = String(e);
                logger.error(`获取仓位费用和奖励 attempt ${attemptCount} failed: ${e}`);
                
                // 检查是否是对象已删除的错误
                if (errorMessage.includes('deleted') || errorMessage.includes('invalid')) {
                    logger.warn(`仓位对象可能已被删除或无效，跳过费用和奖励检查`);
                    return null;
                }
                
                if (attemptCount >= maxAttempts) {
                    logger.error(`达到最大重试次数，放弃获取费用和奖励`);
                    return null;
                }
            }
            
            // 切换客户端
            this.client = createBalancedSuiClient();
            logger.info(`Switched client for feeAndRewards attempt ${attemptCount + 1}`);
            
            // 短暂延迟避免过于频繁的请求
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        logger.error(`获取仓位费用和奖励失败，已达到最大重试次数`);
        return null;
    }

    /**
     * 领取仓位奖励
     * @param position 仓位信息
     * @param pool 池子信息
     * @returns 是否成功
     */
    async collectPositionRewards(position: IPosition, pool: Pool) {
        try {
            const config = await this.getConfig();
            if (!config || !config.contractConfig) {
                logger.error(`领取仓位奖励失败: 配置无效`);
                return false;
            }
            
            let oc = new OnChainCalls(this.client, config.contractConfig, {signer: this.keyPair});
            const resp = await oc.collectRewards(pool, position.position_id);
            
            // 检查交易状态
            const transaction = resp as any;
            const status = transaction?.effects?.status?.status;
            if (status === 'success') {
                logger.info(`✅ 领取仓位奖励成功`);
                return true;
            } else {
                logger.error(`❌ 领取仓位奖励失败: status = ${status}`);
                return false;
            }
        } catch (e) {
            logger.error(`领取仓位奖励失败: ${e}`);
            return false;
        }
    }

    /**
     * 领取仓位费用和奖励
     * @param position 仓位信息
     * @param pool 池子信息
     * @returns 是否成功
     */
    async collectPositionFeeAndRewards(position: IPosition, pool: Pool) {
        try {
            const config = await this.getConfig();
            if (!config || !config.contractConfig) {
                logger.error(`领取仓位费用和奖励失败: 配置无效`);
                return false;
            }
            
            let oc = new OnChainCalls(this.client, config.contractConfig, {signer: this.keyPair});
            const resp = await oc.collectFeeAndRewards(pool, position.position_id);
            
            // 检查交易状态
            const transaction = resp as any;
            const status = transaction?.effects?.status?.status;
            if (status === 'success') {
                logger.info(`✅ 领取仓位费用和奖励成功`);
                return true;
            } else {
                logger.error(`❌ 领取仓位费用和奖励失败: status = ${status}`);
                return false;
            }
        } catch (e) {
            logger.error(`领取仓位费用和奖励失败: ${e}`);
            return false;
        }
    }

    /**
     * 测试OnChainCalls库是否正常工作
     */
    async testOnChainCalls() {
        try {
            logger.info(`测试OnChainCalls库...`);
            const config = await this.getConfig();
            if (!config || !config.contractConfig) {
                logger.error(`配置无效，无法测试OnChainCalls`);
                return false;
            }
            
            logger.info(`配置验证通过，尝试创建OnChainCalls实例...`);
            const oc = new OnChainCalls(this.client, config.contractConfig, {signer: this.keyPair});
            logger.info(`OnChainCalls实例创建成功`);
            
            // 尝试获取一个简单的查询来测试连接
            const pool = await this.getPool(this.poolId);
            if (pool) {
                logger.info(`Pool查询成功，OnChainCalls库工作正常`);
                return true;
            } else {
                logger.error(`Pool查询失败，OnChainCalls库可能有问题`);
                return false;
            }
        } catch (error) {
            logger.error(`OnChainCalls测试失败: ${error}`);
            return false;
        }
    }

    /**
     * 解析奖励配置字符串
     * @param configStr 配置字符串，格式如 "BLUE>1.1orTOKENB>1.2"
     * @returns 解析后的条件数组
     */
    private parseRewardsConfig(configStr: string): Array<{token: string, threshold: number}> {
        if (!configStr || configStr.trim() === "") {
            return [];
        }
        
        const conditions: Array<{token: string, threshold: number}> = [];
        
        // 按 "or" 分割多个条件
        const parts = configStr.split("or");
        
        for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            
            // 查找 > 符号
            const gtIndex = trimmed.indexOf(">");
            if (gtIndex === -1) {
                logger.warn(`无效的奖励配置格式: ${trimmed}`);
                continue;
            }
            
            const token = trimmed.substring(0, gtIndex).trim();
            const thresholdStr = trimmed.substring(gtIndex + 1).trim();
            const threshold = parseFloat(thresholdStr);
            
            if (isNaN(threshold)) {
                logger.warn(`无效的阈值: ${thresholdStr}`);
                continue;
            }
            
            conditions.push({ token, threshold });
        }
        
        return conditions;
    }

    /**
     * 检查手续费+奖励是否满足重开条件
     * @param feeAndRewards 手续费和奖励信息
     * @returns 是否满足重开条件
     */
    private async checkRewardsThreshold(rewards: IFeeAndRewards): Promise<boolean> {
        const strategyConfig = getStrategyConfig();
        const conditions = this.parseRewardsConfig(strategyConfig.rewardsConfig);
        
        if (conditions.length === 0) {
            return false; // 没有配置条件，不重开
        }
        
        logger.info(`检查手续费+奖励重开条件: ${strategyConfig.rewardsConfig}`);
        
        // 分离价格条件和数量条件
        const priceConditions = conditions.filter(condition => 
            condition.token.toLowerCase() === 'price'
        );
        const amountConditions = conditions.filter(condition => 
            condition.token.toLowerCase() !== 'price'
        );
        
        // 检查数量条件
        let amountConditionMet = false;
        if (amountConditions.length > 0) {
            amountConditionMet = this.checkAmountBasedRewards(rewards, amountConditions);
        }
        
        // 检查价格条件
        let priceConditionMet = false;
        if (priceConditions.length > 0) {
            priceConditionMet = await this.checkPriceBasedRewards(rewards);
        }
        
        // 如果任一条件满足，则返回true
        const finalResult = amountConditionMet || priceConditionMet;
        logger.info(`策略检查结果: 数量条件=${amountConditionMet}, 价格条件=${priceConditionMet}, 最终结果=${finalResult}`);
        
        return finalResult;
    }
    
    /**
     * 基于价格的奖励检查
     */
    private async checkPriceBasedRewards(rewards: IFeeAndRewards): Promise<boolean> {
        try {
            const strategyConfig = getStrategyConfig();
            const conditions = this.parseRewardsConfig(strategyConfig.rewardsConfig);
            
            // 获取价格阈值
            const priceCondition = conditions.find(condition => 
                condition.token.toLowerCase() === 'price'
            );
            
            if (!priceCondition) {
                logger.warn('未找到价格条件配置');
                return false;
            }
            
            const priceThreshold = priceCondition.threshold;
            
            // 合并手续费和奖励
            const allRewards = [];
            
            // 添加手续费
            if (rewards.fee) {
                if (rewards.fee.coinA && rewards.fee.coinA.toString() !== '0') {
                    const feeA = stringToDividedNumber(rewards.fee.coinA.toString(), this.decimalsA);
                    if (feeA > 0) {
                        allRewards.push({
                            coinType: this.coinA,
                            coinAmount: rewards.fee.coinA.toString(),
                            coinDecimals: this.decimalsA,
                            coinSymbol: this.nameA
                        });
                    }
                }
                if (rewards.fee.coinB && rewards.fee.coinB.toString() !== '0') {
                    const feeB = stringToDividedNumber(rewards.fee.coinB.toString(), this.decimalsB);
                    if (feeB > 0) {
                        allRewards.push({
                            coinType: this.coinB,
                            coinAmount: rewards.fee.coinB.toString(),
                            coinDecimals: this.decimalsB,
                            coinSymbol: this.nameB
                        });
                    }
                }
            }
            
            // 添加奖励
            if (rewards.rewards && rewards.rewards.length > 0) {
                allRewards.push(...rewards.rewards);
            }
            
            if (allRewards.length === 0) {
                logger.info('没有奖励信息，不执行价格检测');
                return false;
            }
            
            // 提取代币地址
            const tokens = allRewards.map(reward => reward.coinType).filter((token): token is string => token !== null && token !== undefined);
            
            if (tokens.length === 0) {
                logger.warn('没有有效的代币地址');
                return false;
            }
            
            // 获取代币价格
            const tokenPrices = await fetchTokenPrices(tokens);
            
            if (tokenPrices.length === 0) {
                logger.warn('无法获取代币价格信息');
                return false;
            }
            
            // 计算总价格
            const totalPrice = calculateTotalRewardPrice(allRewards, tokenPrices);
            
            // 检查是否满足价格条件
            const meetsCondition = totalPrice > priceThreshold;
            logger.info(`价格检测: 总价格=${totalPrice.toFixed(6)}, 阈值=${priceThreshold}, 满足条件=${meetsCondition}`);
            
            return meetsCondition;
            
        } catch (error) {
            logger.error(`价格检测失败: ${error}`);
            return false;
        }
    }
    
    /**
     * 基于数量的奖励检查 (原有逻辑)
     */
    private checkAmountBasedRewards(rewards: IFeeAndRewards, conditions: Array<{token: string, threshold: number}>): boolean {
        // 合并手续费和奖励的代币数量
        const combinedTokens: { [key: string]: number } = {};
        
        // 添加手续费
        if (rewards.fee) {
            if (rewards.fee.coinA && rewards.fee.coinA.toString() !== '0') {
                const feeA = stringToDividedNumber(rewards.fee.coinA.toString(), this.decimalsA);
                if (feeA > 0) {
                    combinedTokens[this.nameA] = (combinedTokens[this.nameA] || 0) + feeA;
                }
            }
            if (rewards.fee.coinB && rewards.fee.coinB.toString() !== '0') {
                const feeB = stringToDividedNumber(rewards.fee.coinB.toString(), this.decimalsB);
                if (feeB > 0) {
                    combinedTokens[this.nameB] = (combinedTokens[this.nameB] || 0) + feeB;
                }
            }
        }
        
        // 添加奖励
        if (rewards.rewards && rewards.rewards.length > 0) {
            for (const reward of rewards.rewards) {
                if (reward.coinSymbol && reward.coinAmount) {
                    const amount = stringToDividedNumber(reward.coinAmount, reward.coinDecimals);
                    if (amount > 0) {
                        combinedTokens[reward.coinSymbol] = (combinedTokens[reward.coinSymbol] || 0) + amount;
                    }
                }
            }
        }
        
        // 检查每个条件
        for (const condition of conditions) {
            const { token, threshold } = condition;
            
            // 跳过价格条件，因为已经在价格检测中处理
            if (token.toLowerCase() === 'price') {
                continue;
            }
            
            // 在合并的代币中查找对应代币
            const matchingToken = Object.keys(combinedTokens).find(coinSymbol => 
                coinSymbol.toUpperCase() === token.toUpperCase()
            );
            
            if (matchingToken) {
                const totalAmount = combinedTokens[matchingToken];
                logger.info(`代币 ${token}: 手续费+奖励总计=${totalAmount}, 阈值=${threshold}`);
                
                if (totalAmount >= threshold) {
                    logger.info(`✅ 满足重开条件: ${token} >= ${threshold}`);
                    return true;
                }
            } else {
                logger.info(`未找到代币 ${token} 的手续费或奖励`);
            }
        }
        
        logger.info(`❌ 不满足任何重开条件`);
        return false;
    }

    /**
     * 检查是否应该追加流动性
     * @param position 仓位信息
     * @param pool 池子信息
     * @param feeAndRewards 费用和奖励信息
     * @returns 是否应该追加流动性
     */
    private async checkShouldAddLiquidity(position: IPosition, pool: Pool, feeAndRewards: IFeeAndRewards): Promise<boolean> {
        try {
            // 获取环境变量配置的总收益价值阈值，默认1美元
            const totalRewardThreshold = parseFloat(process.env.TOTAL_REWARD_THRESHOLD || '1');
            logger.info(`检查追加流动性条件: 总收益价值阈值=$${totalRewardThreshold}`);
            
            // 计算当前已获取的总收益价值
            const totalRewardValue = await this.calculateTotalRewardValue(feeAndRewards);
            
            if (totalRewardValue === 0) {
                logger.warn(`无法计算已获取收益价值，默认执行一次追加流动性`);
                return true;
            }
            
            logger.info(`当前总收益价值: $${totalRewardValue.toFixed(2)}, 目标阈值: $${totalRewardThreshold}`);
            
            // 检查当前总收益价值是否达到阈值
            if (totalRewardValue/totalRewardThreshold < parseFloat(process.env.REWARD_RATIO_THRESHOLD || '0.3')) {
                logger.info(`✅ 总收益价值检查通过: $${totalRewardValue.toFixed(2)} / $${totalRewardThreshold} < ${parseFloat(process.env.REWARD_RATIO_THRESHOLD || '0.3')}`);
                return true;
            } else {
                logger.info(`❌ 总收益价值检查未通过: $${totalRewardValue.toFixed(2)} / $${totalRewardThreshold} >= ${parseFloat(process.env.REWARD_RATIO_THRESHOLD || '0.3')}`);
                return false;
            }
            
        } catch (error) {
            logger.error(`检查追加流动性条件失败: ${error}`);
            logger.warn(`发生错误，默认执行一次追加流动性`);
            return true;
        }
    }

    /**
     * 计算当前已获取的总收益价值
     * @param feeAndRewards 费用和奖励信息
     * @returns 总收益价值（美元）
     */
    private async calculateTotalRewardValue(feeAndRewards: IFeeAndRewards): Promise<number> {
        try {
            // 合并手续费和奖励
            const allRewards = [];
            
            // 添加手续费
            if (feeAndRewards.fee) {
                if (feeAndRewards.fee.coinA && feeAndRewards.fee.coinA.toString() !== '0') {
                    const feeA = stringToDividedNumber(feeAndRewards.fee.coinA.toString(), this.decimalsA);
                    if (feeA > 0) {
                        allRewards.push({
                            coinType: this.coinA,
                            coinAmount: feeAndRewards.fee.coinA.toString(),
                            coinDecimals: this.decimalsA,
                            coinSymbol: this.nameA
                        });
                    }
                }
                if (feeAndRewards.fee.coinB && feeAndRewards.fee.coinB.toString() !== '0') {
                    const feeB = stringToDividedNumber(feeAndRewards.fee.coinB.toString(), this.decimalsB);
                    if (feeB > 0) {
                        allRewards.push({
                            coinType: this.coinB,
                            coinAmount: feeAndRewards.fee.coinB.toString(),
                            coinDecimals: this.decimalsB,
                            coinSymbol: this.nameB
                        });
                    }
                }
            }
            
            // 添加奖励
            if (feeAndRewards.rewards && feeAndRewards.rewards.length > 0) {
                allRewards.push(...feeAndRewards.rewards);
            }
            
            if (allRewards.length === 0) {
                return 0;
            }
            
            // 提取代币地址
            const tokens = allRewards.map(reward => reward.coinType).filter((token): token is string => token !== null && token !== undefined);
            
            if (tokens.length === 0) {
                return 0;
            }
            
            // 获取代币价格
            const tokenPrices = await fetchTokenPrices(tokens);
            
            if (tokenPrices.length === 0) {
                return 0;
            }
            
            // 计算总价值
            const totalValue = calculateTotalRewardPrice(allRewards, tokenPrices);
            
            return totalValue;
            
        } catch (error) {
            logger.error(`计算总收益价值失败: ${error}`);
            return 0;
        }
    }

    /**
     * 计算追加流动性可能产生的收益价值
     * @param pool 池子信息
     * @param position 仓位信息
     * @param amountA 代币A数量
     * @param amountB 代币B数量
     * @returns 潜在收益价值（美元）
     */
    private async calculatePotentialRewardValue(pool: Pool, position: IPosition, amountA: number, amountB: number): Promise<number> {
        try {
            // 基于当前仓位的收益比例，估算追加流动性可能产生的收益
            // 这里使用一个简化的估算方法：基于追加资金量与现有仓位的比例
            
            // 获取当前仓位的流动性信息（这里需要根据实际情况调整）
            const currentLiquidity = position.liquidity || 1; // 如果没有流动性信息，使用默认值
            
            // 计算追加资金的总价值
            const tokens: string[] = [];
            if (amountA > 0 && this.coinA) {
                tokens.push(this.coinA);
            }
            if (amountB > 0 && this.coinB) {
                tokens.push(this.coinB);
            }
            
            if (tokens.length === 0) {
                return 0;
            }
            
            // 获取代币价格
            const tokenPrices = await fetchTokenPrices(tokens);
            
            if (tokenPrices.length === 0) {
                return 0;
            }
            
            // 计算追加资金的总价值
            let totalValue = 0;
            if (amountA > 0) {
                const priceA = tokenPrices.find(p => p.address === this.coinA)?.price || '0';
                totalValue += amountA * parseFloat(priceA);
            }
            if (amountB > 0) {
                const priceB = tokenPrices.find(p => p.address === this.coinB)?.price || '0';
                totalValue += amountB * parseFloat(priceB);
            }
            
            // 基于追加资金与现有仓位的比例，估算潜在收益
            // 这里使用一个保守的估算：假设追加资金产生的收益与现有收益成比例
            const potentialRewardRatio = 0.1; // 假设追加资金产生的收益是追加资金价值的10%
            const potentialRewardValue = totalValue * potentialRewardRatio;
            
            logger.info(`潜在收益估算: 追加资金价值=$${totalValue.toFixed(2)}, 估算收益比例=${potentialRewardRatio * 100}%, 潜在收益=$${potentialRewardValue.toFixed(2)}`);
            
            return potentialRewardValue;
            
        } catch (error) {
            logger.error(`计算潜在收益价值失败: ${error}`);
            return 0;
        }
    }

    /**
     * 间隔运行核心
     */
    async run() {
        console.log("run this Strategy");
        await this.initSys();
        
        // 测试OnChainCalls库
        const onChainTest = await this.testOnChainCalls();
        if (!onChainTest) {
            logger.error(`OnChainCalls库测试失败，但继续运行...`);
        }
        
        // 获取间隔时间（毫秒），默认10秒
        const intervalMs = parseInt(process.env.STRATEGY_INTERVAL_MS || '10000');
        console.log(`使用间隔时间: ${intervalMs}ms`);
        
        this.isRunning = true;
        this.stopRequested = false;
        
        // noinspection InfiniteLoopJS
        while (!this.stopRequested) { // 检查停止请求
            await this.core(); // 等待 fetchData 完成
            if (!this.stopRequested) {
                await new Promise(resolve => setTimeout(resolve, intervalMs));
            }
        }
        
        this.isRunning = false;
        logger.info("策略已停止");
    }

    /**
     * 停止策略
     */
    stop() {
        this.stopRequested = true;
        logger.info("收到停止请求，将在当前循环结束后停止");
    }

    /**
     * 获取策略运行状态
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            stopRequested: this.stopRequested
        };
    }

    // 小数位处理
    private round(value: number, decimals: number): number {
        const factor = Math.pow(10, decimals);
        return Math.round(value * factor) / factor;
    }

    /***
     * 检查是否需要冷却重置
     * 如果超过10分钟没有突破，重置连续突破计数器
     */
    private checkCoolDownReset() {
        const now = Date.now();
        const thirtyMinutes = 15 * 60 * 1000; // 10分钟的毫秒数
        
        if (this.lastBreakTime > 0 && (now - this.lastBreakTime) > thirtyMinutes) {
            if (this.consecutiveBreakCount > 0) {
                logger.info(`🔄 30分钟冷却时间已到，重置连续突破计数器: ${this.consecutiveBreakCount} -> 0`);
                this.consecutiveBreakCount = 0;
                this.lastBreakTime = 0; // 重置时间戳
            }
        }
    }
}