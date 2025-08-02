import {IPosition, ISwapParams, OnChainCalls, QueryChain, Pool} from "@firefly-exchange/library-sui/spot";
import {Ed25519Keypair, SuiClient, toBigNumber, toBigNumberStr, ClmmPoolUtil, TickMath} from "@firefly-exchange/library-sui";

import {getMainnetConfig} from "./config";
import {BN} from "bn.js";
import {logger} from "./Logger";
import {calTickIndex, coinTypeToName, scalingDown, stringToDividedNumber} from "./utils";
import {getStrategyConfig, setStrategyConfig, StrategyConfig} from "./strategy-config";
import {fetchHistoricalPriceData, displayPoolChart} from "./analyze";


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


    constructor(endpoint: string, privateKey: string, poolId: string, g: number, strategyConfig?: Partial<StrategyConfig>) {
        this.poolId = poolId;
        this.client = new SuiClient({url: endpoint});
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
        logger.info(`walletAddress:${this.walletAddress}`);
        
        // 打印配置信息
        const config = getStrategyConfig();
        logger.info(`策略配置: 资金使用率=${config.fundUsageRate * 100}%, 最小区间倍数=${config.minRangeMultiplier}, 滑点=${config.slippage * 100}%, 配平误差=${config.balanceError * 100}%`);
    }

    // 获取配置
    private async getConfig() {
        if (!this.mainnetConfig) {
            this.mainnetConfig = await getMainnetConfig();
        }
        return this.mainnetConfig;
    }

    // 获取池子信息
    async getPool(poolID: string) {
        let qc = new QueryChain(this.client);
        return await qc.getPool(poolID).catch(e => {
            logger.error(`${e}`);
            return null;
        });
    }

    /***
     * 获取用户资产信息，限定本池中的A和B
     */
    async getAssert(): Promise<number[] | null> {
        const COIN_SUI = "0x2::sui::SUI"
        const DECIMALS_SUI = 9

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
        } catch (e) {
            return null;
        }
        return [amountA, amountB, amountSUI];

    }

    /**
     * 获取用户仓位信息
     * @param userAddress 钱包地址
     */
    async getUserPositions(userAddress: string) {
        let qc = new QueryChain(this.client);
        const config = await this.getConfig();
        return await qc.getUserPositions(config.contractConfig.BasePackage, userAddress).catch(e => {
            logger.error(e);
            return null;
        });
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
        if (this.lastBreak == BreakType.Unknown) {
            const g1 = 0 + this.G;
            const g2 = 1 + this.G;
            logger.info(`lastBreak:Unknown BaseG:${this.G} g1:${g1} g2:${g2}`)
            return [g1, g2]
        }
        if (this.lastBreak == BreakType.Up) {
            const g1 = 1 + this.G;
            const g2 = 2 + this.G;
            logger.info(`lastBreak:Up BaseX:${this.G} g1:${g1} g2:${g2}`)

            return [g1, g2]
        }
        if (this.lastBreak == BreakType.Down) {
            // noinspection PointlessArithmeticExpressionJS
            const g1 = 1 + this.G;
            const g2 = 2 + this.G;
            logger.info(`lastBreak:Down BaseX:${this.G} g1:${g1} g2:${g2}`)
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
        const [lowerTick, upperTick] = calTickIndex(currentTick, tickSpacing, g1, g2, strategyConfig.minRangeMultiplier)
        logger.info(`tickSpacing:${tickSpacing} currentTick:${currentTick} lowerTick:${lowerTick} upperTick:${upperTick} minRangeMultiplier:${strategyConfig.minRangeMultiplier}`);
        // 换算价格区间
        const currentPrice = TickMath.tickIndexToPrice(currentTick, this.decimalsA, this.decimalsB).toNumber();
        const lowerTickPrice = TickMath.tickIndexToPrice(lowerTick, this.decimalsA, this.decimalsB).toNumber();
        const upperTickPrice = TickMath.tickIndexToPrice(upperTick, this.decimalsA, this.decimalsB).toNumber();

        logger.info(`CurrentPrice: ${currentPrice} ||Price Range:  ${lowerTickPrice} <--> ${upperTickPrice}`);
        const [x, y] = this.calXY(lowerTick, upperTick, currentSqrtPrice)
        logger.info(`x:y = ${x}:${y}`);
        // 配平前钱包资产信息
        const result = await this.getAssert();
        if (result === null) {
            logger.error("获取资金信息异常 => PASS");
            return;
        }
        const [balanceA, balanceB, balanceSUI] = result as number[];
        logger.info(`配平前钱包资产: ${this.nameA}: ${balanceA} | ${this.nameB}: ${balanceB} SUI: ${balanceSUI}`);
        const [a2b, amount] = this.calSwap(currentPrice, x, y, balanceA, balanceB, strategyConfig.balanceError);
        logger.info(`a2b: ${a2b} amount: ${amount}`);
        // return;

        if (amount > 0) {
            logger.info(`正在配平 => Swap`);
            let swapSuccess = false;
            
            try {
                const swapOK = await this.toSwap(pool, a2b, amount, strategyConfig.slippage)
                if (swapOK) {
                    logger.info(`Swap success => 去开仓`);
                    swapSuccess = true;
                } else {
                    logger.error(`Swap fail => 尝试直接开仓`);
                    swapSuccess = false;
                }
            } catch (error) {
                logger.error(`Swap过程中发生错误: ${error}`);
                swapSuccess = false;
            }
            
            // 无论swap是否成功，都尝试开仓
            try {
                const addOk = await this.toAddLiquidity(lowerTick, upperTick)
                if (addOk) {
                    logger.info(`开仓成功: ${swapSuccess ? "Swap+开仓" : "直接开仓"}`);
                } else {
                    logger.error(`开仓失败: ${swapSuccess ? "Swap成功但开仓失败" : "直接开仓失败"}`);
                }
            } catch (addError) {
                logger.error(`开仓过程中发生错误: ${addError}`);
            }
        } else {
            logger.info(`无需Swap => 直接开仓`);
            // 无需swap，直接开仓
            try {
                const addOk = await this.toAddLiquidity(lowerTick, upperTick)
                logger.info(`Add Liquidity ${addOk ? "success" : "fail"}`)
            } catch (error) {
                logger.error(`Add Liquidity过程中发生错误: ${error}`);
            }
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
        const gasReserve = 0.1; // 预留0.1 SUI作为gas费
        const availableBalanceB = Math.max(0, balanceB - (this.coinB === "0x2::sui::SUI" ? gasReserve : 0));
        const usableAmount = availableBalanceB * strategyConfig.fundUsageRate;
        
        logger.info(`资金计算: balanceB=${balanceB}, gasReserve=${gasReserve}, availableBalanceB=${availableBalanceB}, fundUsageRate=${strategyConfig.fundUsageRate}, usableAmount=${usableAmount}`);
        
        if (usableAmount <= 0) {
            logger.error(`可用资金不足: usableAmount=${usableAmount}`);
            return false;
        }
        
        let coinAmountBN = new BN(toBigNumberStr(usableAmount, this.decimalsB));
        let roundUp = true
        let slippage = strategyConfig.slippage
        const isCoinA = false;

        const liquidityInput = ClmmPoolUtil.estLiquidityAndCoinAmountFromOneAmounts(
            lowerTick,
            upperTick,
            coinAmountBN,
            isCoinA,
            roundUp,
            slippage,
            curSqrtPrice
        );
        
        // 显示计算结果
        logger.info(`流动性计算结果: coinAmountA=${liquidityInput?.coinAmountA?.toString()}, coinAmountB=${liquidityInput?.coinAmountB?.toString()}`);
        
        // 检查计算结果是否有效
        if (!liquidityInput || liquidityInput.coinAmountA.isNeg() || liquidityInput.coinAmountB.isNeg()) {
            logger.error(`流动性计算结果无效: coinAmountA=${liquidityInput?.coinAmountA?.toString()}, coinAmountB=${liquidityInput?.coinAmountB?.toString()}`);
            return false;
        }
        
        // 验证计算的金额是否超过实际余额
        const requiredA = liquidityInput.coinAmountA.toNumber() / Math.pow(10, this.decimalsA);
        const requiredB = liquidityInput.coinAmountB.toNumber() / Math.pow(10, this.decimalsB);
        logger.info(`需要资金: ${this.nameA}=${requiredA}, ${this.nameB}=${requiredB}`);
        logger.info(`钱包余额: ${this.nameA}=${balanceA}, ${this.nameB}=${balanceB}`);
        
        if (requiredA > balanceA || requiredB > balanceB) {
            logger.error(`资金不足: 需要${this.nameA}=${requiredA}(有${balanceA}), 需要${this.nameB}=${requiredB}(有${balanceB})`);
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
        const k = x / y;
        const A = this.nameA;
        const B = this.nameB;

        if (b === 0) {
            logger.info(`${B} 资产不足, 执行 ${A} => ${B}`);
            const a2b = true;
            const n = (a - b * k) / (1 + p * k);  // n此时表示代币A的输入值
            const a_ = a - n;
            const b_ = b + n * p;
            logger.info(`计算 Swap:${A}->${B},输入转移数量:${n} 配平后 ${a_} ${b_}`);
            return [a2b, this.round(n, 4)];
        }

        if (k <= a / b && a / b <= (1 + slip) * k) {
            const a2b = false;
            const n = 0;
            logger.info(`Swap:否 配平前 ${a} ${b} 转移数量:${n} 滑点:${slip}`);
            return [a2b, n];
        }

        if (a / b > (1 + slip) * k) {
            logger.info(`${B} 资产不足, 执行 ${A} => ${B}`);
            const n = (a - b * k) / (1 + p * k);  // n此时表示代币A的输入值
            const a_ = a - n;
            const b_ = b + n * p;
            const a2b = true;
            logger.info(`计算 Swap:${A}->${B},输入转移数量:${n} 配平后 ${a_} ${b_}`);
            return [a2b, this.round(n, 4)];
        }

        if (a / b < k) {
            logger.info(`${A} 资产不足, 执行 ${B} => ${A}`);
            const n = (b * k * p - a * p) / (1 + k * p);  // m此时表示输入代币B的数量
            const a_ = a + n / p;
            const b_ = b - n;
            const a2b = false;
            logger.info(`计算 Swap:${B}->${A},输入转移数量:${n} 配平后 ${a_} ${b_}`);
            return [a2b, this.round(n, 4)];
        }

        // 如果没有满足的条件，返回默认值
        return [false, 0];
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
            logger.info(`关闭仓位: ${closeOK ? "success" : "fail"}`);

            this.lastBreak = BreakType.Down
            logger.info(`设置突破标志位: ${this.lastBreak}`);
            return;
        }
        // 突破
        if (current_tick > upperTick) {
            logger.info(`当前Tick: ${current_tick} => 突破上区间:${upperTick} => 平仓`);

            const closeOK = await this.toClosePos(pool, posID);
            logger.info(`关闭仓位: ${closeOK ? "success" : "fail"}`);

            this.lastBreak = BreakType.Up
            logger.info(`设置突破标志位: ${this.lastBreak}`);

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
                logger.info(`Close Position success`);
                return true;
            } else {
                logger.error(`Close Position failed: status = ${status}`);
                return false;
            }
        } catch (e) {
            logger.error(`Close Position Failed: ${e}`);
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
            try {
                const [g1, g2] = this.calG();
                const tickSpacing = pool.ticks_manager.tick_spacing;
                const strategyConfig = getStrategyConfig();
                const [lowerTick, upperTick] = calTickIndex(pool.current_tick, tickSpacing, g1, g2, strategyConfig.minRangeMultiplier);
                
                const lowerPrice = TickMath.tickIndexToPrice(lowerTick, this.decimalsA, this.decimalsB).toNumber();
                const upperPrice = TickMath.tickIndexToPrice(upperTick, this.decimalsA, this.decimalsB).toNumber();
                
                const rangePercentage = ((upperPrice - lowerPrice) / currentPrice * 100).toFixed(2);
                const lowerPercentage = ((lowerPrice - currentPrice) / currentPrice * 100).toFixed(2);
                const upperPercentage = ((upperPrice - currentPrice) / currentPrice * 100).toFixed(2);
                
                logger.info(`=== 📊 开仓策略配置 ===`);
                logger.info(`当前价格: ${currentPrice.toFixed(6)} ${this.nameB}/${this.nameA}`);
                logger.info(`策略参数: G=${this.G}, g1=${g1}, g2=${g2}`);
                logger.info(`最小区间倍数: ${strategyConfig.minRangeMultiplier} × tickSpacing(${tickSpacing})`);
                logger.info(`预期开仓区间:`);
                logger.info(`  下界: ${lowerPrice.toFixed(6)} (${lowerPercentage}%)`);
                logger.info(`  上界: ${upperPrice.toFixed(6)} (${upperPercentage}%)`);
                logger.info(`  区间宽度: ${rangePercentage}%`);
                logger.info(`  Tick区间: [${lowerTick}, ${upperTick}]`);
                
                const historicalData = await fetchHistoricalPriceData(pool);
                const predictedRange = { lower: lowerPrice, upper: upperPrice };
                
                displayPoolChart(pool, currentPrice, null, historicalData, predictedRange);
            } catch (preDisplayError) {
                logger.warn(`开仓前显示渲染失败: ${preDisplayError}`);
            }
            
            // 执行开仓
            logger.info(`🚀 开始执行开仓操作...`);
            await this.toOpenPos(pool);
            
            // 等待交易确认
            logger.info(`⏳ 等待交易确认...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // 重新获取仓位信息
            logger.info(`🔍 检查开仓结果...`);
            const newPositions = await this.getUserPositions(this.walletAddress);
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
        // 获取当前仓位
        const positions = await this.getUserPositions(this.walletAddress)
        if (positions === null) {
            logger.warn(`获取仓位列表fail => PASS`);
            return;
        }
        // 仓位集合过滤，去除非目标池下的仓位
        const poss: IPosition[] = positions.filter(position => position.pool_id === this.poolId);
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
            const [lowerTick, upperTick] = calTickIndex(currentTick, tickSpacing, g1, g2, strategyConfig.minRangeMultiplier);
            
            const lowerPrice = TickMath.tickIndexToPrice(lowerTick, this.decimalsA, this.decimalsB).toNumber();
            const upperPrice = TickMath.tickIndexToPrice(upperTick, this.decimalsA, this.decimalsB).toNumber();
            predictedPositionRange = { lower: lowerPrice, upper: upperPrice };
            
            logger.info(`预测仓位区间: ${lowerPrice.toFixed(6)} - ${upperPrice.toFixed(6)} (tick: ${lowerTick} - ${upperTick})`);
        }

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

        // 开仓逻辑
        if (poss.length === 0) {
                    logger.info(`当前仓位不存在 => 准备开仓`);
        
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
        logger.info(`预期开仓区间:`);
        logger.info(`  下界: ${lowerPrice.toFixed(6)} (${lowerPercentage}%)`);
        logger.info(`  上界: ${upperPrice.toFixed(6)} (${upperPercentage}%)`);
        logger.info(`  区间宽度: ${rangePercentage}%`);
        logger.info(`  Tick区间: [${lowerTick}, ${upperTick}]`);
        
        await this.handlePositionCreation(pool, currentPrice);
            return;
        }

        // 仓位检测和平仓
        for (const pos of poss) {
            await this.checkPos(pos, pool)
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
        
        // noinspection InfiniteLoopJS
        while (true) { // 无限循环
            await this.core(); // 等待 fetchData 完成
            await new Promise(resolve => setTimeout(resolve, 10000)); // 等待10秒
        }
    }

    // 小数位处理
    private round(value: number, decimals: number): number {
        const factor = Math.pow(10, decimals);
        return Math.round(value * factor) / factor;
    }
}