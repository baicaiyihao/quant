import { logger } from "./Logger";
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

// 代币价格信息接口
export interface TokenPrice {
    address: string;
    price: string;
    priceChangePercent24Hrs: string;
}

// 价格API地址
const PRICE_API_URL = 'https://swap.api.sui-prod.bluefin.io/api/v1/tokens/price';

// 价格缓存系统
interface PriceCacheEntry {
    data: string;
    timestamp: number;
    isExpired: boolean; // 标记是否过期，但保留数据作为fallback
}

// 代币地址级别的fallback缓存
interface TokenFallbackCache {
    address: string;
    price: string;
    timestamp: number;
}

const priceCache = new Map<string, PriceCacheEntry>();
const tokenFallbackCache = new Map<string, TokenFallbackCache>();
const PRICE_CACHE_DURATION = 20 * 1000; // 20秒缓存
const FALLBACK_CACHE_DURATION = 2 * 60 * 1000; // 2分钟fallback缓存

// 价格缓存管理函数
function getCachedPriceResponse(url: string): string | null {
    const entry = priceCache.get(url);
    if (!entry) return null;
    
    const now = Date.now();
    const isExpired = now - entry.timestamp > PRICE_CACHE_DURATION;
    
    // 如果过期，标记为过期但保留数据
    if (isExpired && !entry.isExpired) {
        entry.isExpired = true;
    }
    
    // 返回数据（无论是否过期，都可用于fallback）
    return entry.data;
}

function setCachedPriceResponse(url: string, data: string): void {
    priceCache.set(url, {
        data,
        timestamp: Date.now(),
        isExpired: false
    });
    
    // 同时更新代币地址级别的fallback缓存
    try {
        const jsonData = JSON.parse(data);
        if (Array.isArray(jsonData)) {
            for (const token of jsonData) {
                if (token && token.address && token.price) {
                    tokenFallbackCache.set(token.address, {
                        address: token.address,
                        price: token.price,
                        timestamp: Date.now()
                    });
                }
            }
        }
    } catch (error) {
        logger.warn(`Failed to parse price data for fallback cache: ${error}`);
    }
}

// 清理过期价格缓存（只清理真正过期的数据，保留fallback数据）
function cleanupExpiredPriceCache(): void {
    const now = Date.now();
    
    // 清理URL缓存
    for (const [url, entry] of priceCache.entries()) {
        // 只清理超过2分钟的数据（给fallback数据更多时间）
        if (now - entry.timestamp > 2 * 60 * 1000) {
            priceCache.delete(url);
        }
    }
    
    // 清理代币地址fallback缓存
    for (const [address, entry] of tokenFallbackCache.entries()) {
        if (now - entry.timestamp > FALLBACK_CACHE_DURATION) {
            tokenFallbackCache.delete(address);
        }
    }
}

// 获取fallback数据（过期的缓存数据）
function getFallbackPriceResponse(url: string): string | null {
    const entry = priceCache.get(url);
    if (!entry || !entry.isExpired) return null;
    
    return entry.data;
}

// 根据代币地址获取fallback价格
function getTokenFallbackPrice(tokenAddresses: string[]): TokenFallbackCache[] {
    const now = Date.now();
    const fallbackTokens: TokenFallbackCache[] = [];
    
    for (const address of tokenAddresses) {
        const entry = tokenFallbackCache.get(address);
        if (entry && (now - entry.timestamp) <= FALLBACK_CACHE_DURATION) {
            fallbackTokens.push(entry);
        }
    }
    
    return fallbackTokens;
}

/**
 * 标准化代币地址格式
 * @param coinType 代币类型
 * @returns 标准化的代币地址
 */
function normalizeCoinAddress(coinType: string): string {
    // 处理SUI代币的特殊情况
    if (coinType === '0x2::sui::SUI') {
        return '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
    }
    
    // 处理其他可能的简写格式
    if (coinType.startsWith('0x2::')) {
        return coinType.replace('0x2::', '0x0000000000000000000000000000000000000000000000000000000000000002::');
    }
    
    return coinType;
}

// 使用Node.js内置模块进行HTTP请求
async function makeHttpRequest(urlString: string): Promise<any> {
    // 检查价格缓存
    const cachedData = getCachedPriceResponse(urlString);
    if (cachedData) {
        logger.info(`Using cached price response for: ${urlString}`);
        try {
            return JSON.parse(cachedData);
        } catch (parseError) {
            logger.warn(`Failed to parse cached price data: ${parseError}`);
            // 如果解析失败，删除缓存并继续正常请求
            priceCache.delete(urlString);
        }
    }

    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Connection': 'keep-alive'
            },
            timeout: 10000 // 10秒超时
        };

        const client = url.protocol === 'https:' ? https : http;
        
        const req = client.request(options, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        // 缓存原始响应数据（不解析）
                        setCachedPriceResponse(urlString, data);
                        logger.info(`Cached price response for: ${urlString}`);
                        
                        const jsonData = JSON.parse(data);
                        resolve(jsonData);
                    } else {
                        // 网络请求失败，尝试使用fallback数据
                        const fallbackData = getFallbackPriceResponse(urlString);
                        if (fallbackData) {
                            logger.warn(`Network request failed, using fallback price data for: ${urlString}`);
                            try {
                                const jsonData = JSON.parse(fallbackData);
                                resolve(jsonData);
                            } catch (parseError) {
                                reject(new Error(`Failed to parse fallback price data: ${parseError}`));
                            }
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || 'Unknown error'}`));
                        }
                    }
                } catch (parseError) {
                    // 解析失败，尝试使用fallback数据
                    const fallbackData = getFallbackPriceResponse(urlString);
                    if (fallbackData) {
                        logger.warn(`Response parsing failed, using fallback price data for: ${urlString}`);
                        try {
                            const jsonData = JSON.parse(fallbackData);
                            resolve(jsonData);
                        } catch (fallbackParseError) {
                            reject(new Error(`Failed to parse fallback price data: ${fallbackParseError}`));
                        }
                    } else {
                        reject(new Error(`Failed to parse JSON response: ${parseError}`));
                    }
                }
            });
        });

        req.on('error', (error) => {
            // 网络错误，尝试使用fallback数据
            const fallbackData = getFallbackPriceResponse(urlString);
            if (fallbackData) {
                logger.warn(`Network error, using fallback price data for: ${urlString}`);
                try {
                    const jsonData = JSON.parse(fallbackData);
                    resolve(jsonData);
                } catch (parseError) {
                    reject(new Error(`Failed to parse fallback price data: ${parseError}`));
                }
            } else {
                reject(new Error(`Network error: ${error.message}`));
            }
        });

        req.on('timeout', () => {
            req.destroy();
            // 超时，尝试使用fallback数据
            const fallbackData = getFallbackPriceResponse(urlString);
            if (fallbackData) {
                logger.warn(`Request timeout, using fallback price data for: ${urlString}`);
                try {
                    const jsonData = JSON.parse(fallbackData);
                    resolve(jsonData);
                } catch (parseError) {
                    reject(new Error(`Failed to parse fallback price data: ${parseError}`));
                }
            } else {
                reject(new Error('Request timeout after 10 seconds'));
            }
        });

        req.end();
    });
}

/**
 * 获取代币价格
 * @param tokens 代币地址列表，用逗号分隔
 * @returns 代币价格信息
 */
export async function fetchTokenPrices(tokens: string[]): Promise<TokenPrice[]> {
    try {
        if (!tokens || tokens.length === 0) {
            logger.warn('没有提供代币地址');
            return [];
        }

        // 标准化代币地址格式
        const normalizedTokens = tokens.map(token => normalizeCoinAddress(token));
        const tokensParam = normalizedTokens.map(token => encodeURIComponent(token)).join(',');
        const url = `${PRICE_API_URL}?tokens=${tokensParam}`;
        
        logger.info(`获取代币价格: ${url}`);
        logger.debug(`原始代币地址: ${tokens.join(', ')}`);
        logger.debug(`标准化后地址: ${normalizedTokens.join(', ')}`);
        
        try {
            const data = await makeHttpRequest(url);
            
            if (!data || !Array.isArray(data)) {
                logger.warn('价格API返回数据格式无效');
                throw new Error('Invalid API response format');
            }
            
            const tokenPrices: TokenPrice[] = [];
            
            for (const item of data) {
                if (item && item.address && item.price) {
                    tokenPrices.push({
                        address: item.address,
                        price: item.price,
                        priceChangePercent24Hrs: item.priceChangePercent24Hrs || "0"
                    });
                }
            }
            
            logger.info(`成功获取 ${tokenPrices.length} 个代币的价格信息`);
            return tokenPrices;
            
        } catch (networkError) {
            logger.warn(`网络请求失败，尝试使用代币地址级别的fallback缓存: ${networkError}`);
            
            // 使用代币地址级别的fallback缓存
            const fallbackTokens = getTokenFallbackPrice(normalizedTokens);
            
            if (fallbackTokens.length > 0) {
                logger.info(`使用fallback缓存获取 ${fallbackTokens.length} 个代币的价格信息`);
                
                const tokenPrices: TokenPrice[] = fallbackTokens.map(token => ({
                    address: token.address,
                    price: token.price,
                    priceChangePercent24Hrs: "0" // fallback数据没有24小时变化信息
                }));
                
                return tokenPrices;
            } else {
                logger.error(`没有可用的fallback缓存数据`);
                throw networkError;
            }
        }
        
    } catch (error) {
        logger.error(`获取代币价格失败: ${error}`);
        return [];
    }
}

/**
 * 计算奖励代币的总价格
 * @param rewards 奖励信息
 * @param tokenPrices 代币价格信息
 * @returns 总价格
 */
export function calculateTotalRewardPrice(rewards: any[], tokenPrices: TokenPrice[]): number {
    let totalPrice = 0;
    
    // 准备表格数据
    const headers = ['代币', '数量', '价格', '价值'];
    const rows: string[][] = [];
    
    for (const reward of rewards) {
        if (reward && reward.coinAmount && reward.coinDecimals) {
            const amount = parseFloat(reward.coinAmount) / Math.pow(10, reward.coinDecimals);
            
            // 查找对应的价格 - 使用更灵活的匹配逻辑
            let priceInfo = tokenPrices.find(price => 
                price.address === reward.coinType
            );
            
            // 如果直接匹配失败，尝试使用代币符号匹配
            if (!priceInfo && reward.coinSymbol) {
                priceInfo = tokenPrices.find(price => {
                    const priceSymbol = price.address.split('::')[2];
                    return priceSymbol === reward.coinSymbol;
                });
            }
            
            // 如果还是没找到，尝试使用地址的最后部分匹配
            if (!priceInfo) {
                const rewardSymbol = reward.coinType.split('::')[2];
                priceInfo = tokenPrices.find(price => {
                    const priceSymbol = price.address.split('::')[2];
                    return priceSymbol === rewardSymbol;
                });
            }
            
            if (priceInfo) {
                const priceValue = parseFloat(priceInfo.price);
                const rewardValue = amount * priceValue;
                totalPrice += rewardValue;
                
                // 添加到表格行
                const tokenName = reward.coinSymbol || reward.coinType.split('::')[2];
                rows.push([
                    tokenName,
                    amount.toFixed(6),
                    priceValue.toFixed(6),
                    rewardValue.toFixed(6)
                ]);
            } else {
                logger.warn(`未找到代币 ${reward.coinSymbol || reward.coinType} (${reward.coinType}) 的价格信息`);
                // 记录所有可用的价格地址，帮助调试
                logger.debug(`可用的价格地址: ${tokenPrices.map(p => p.address).join(', ')}`);
            }
        }
    }
    
    // 添加总计行
    rows.push(['**总计**', '-', '-', `**${totalPrice.toFixed(6)}**`]);
    
    // 使用Logger的renderTable方法渲染表格
    logger.renderTable(headers, rows);
    
    return totalPrice;
}

// 定期清理过期价格缓存（每10秒执行一次）
setInterval(cleanupExpiredPriceCache, 10 * 1000);

// 导出价格缓存统计信息函数（用于调试）
export function getPriceCacheStats() {
    const now = Date.now();
    let validEntries = 0;
    let expiredEntries = 0;
    let fallbackEntries = 0;
    
    for (const [url, entry] of priceCache.entries()) {
        if (entry.isExpired) {
            fallbackEntries++;
        } else if (now - entry.timestamp > PRICE_CACHE_DURATION) {
            expiredEntries++;
        } else {
            validEntries++;
        }
    }
    
    // 统计代币地址级别的fallback缓存
    let tokenFallbackCount = 0;
    for (const [address, entry] of tokenFallbackCache.entries()) {
        if (now - entry.timestamp <= FALLBACK_CACHE_DURATION) {
            tokenFallbackCount++;
        }
    }
    
    return {
        urlCache: {
            totalEntries: priceCache.size,
            validEntries,
            expiredEntries,
            fallbackEntries,
            cacheDuration: PRICE_CACHE_DURATION / 1000 + 's'
        },
        tokenFallbackCache: {
            totalEntries: tokenFallbackCache.size,
            validEntries: tokenFallbackCount,
            cacheDuration: FALLBACK_CACHE_DURATION / 1000 + 's'
        }
    };
}

 