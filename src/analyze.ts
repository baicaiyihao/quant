import { logger } from "./Logger";
import * as asciichart from "asciichart";
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

// 简单的内存缓存
interface CacheEntry {
  data: string;
  timestamp: number;
  isExpired: boolean; // 标记是否过期，但保留数据作为fallback
}

const cache = new Map<string, CacheEntry>();
const CACHE_DURATION = 60 * 1000; // 1分钟缓存

// 缓存管理函数
function getCachedResponse(url: string): string | null {
  const entry = cache.get(url);
  if (!entry) return null;
  
  const now = Date.now();
  const isExpired = now - entry.timestamp > CACHE_DURATION;
  
  // 如果过期，标记为过期但保留数据
  if (isExpired && !entry.isExpired) {
    entry.isExpired = true;
  }
  
  // 返回数据（无论是否过期，都可用于fallback）
  return entry.data;
}

function setCachedResponse(url: string, data: string): void {
  cache.set(url, {
    data,
    timestamp: Date.now(),
    isExpired: false
  });
}

// 清理过期缓存（只清理真正过期的数据，保留fallback数据）
function cleanupExpiredCache(): void {
  const now = Date.now();
  for (const [url, entry] of cache.entries()) {
    // 只清理超过5分钟的数据（给fallback数据更多时间）
    if (now - entry.timestamp > 5 * 60 * 1000) {
      cache.delete(url);
    }
  }
}

// 获取fallback数据（过期的缓存数据）
function getFallbackResponse(url: string): string | null {
  const entry = cache.get(url);
  if (!entry || !entry.isExpired) return null;
  
  return entry.data;
}

// 使用Node.js内置模块进行HTTP请求
async function makeHttpRequest(urlString: string): Promise<any> {
  // 检查缓存
  const cachedData = getCachedResponse(urlString);
  if (cachedData) {
    logger.info(`Using cached response for: ${urlString}`);
    try {
      return JSON.parse(cachedData);
    } catch (parseError) {
      logger.warn(`Failed to parse cached data: ${parseError}`);
      // 如果解析失败，删除缓存并继续正常请求
      cache.delete(urlString);
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
        'User-Agent': 'BlueQuant/1.0.0',
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
            setCachedResponse(urlString, data);
            logger.info(`Cached response for: ${urlString}`);
            
            const jsonData = JSON.parse(data);
            resolve(jsonData);
          } else {
            // 网络请求失败，尝试使用fallback数据
            const fallbackData = getFallbackResponse(urlString);
            if (fallbackData) {
              logger.warn(`Network request failed, using fallback data for: ${urlString}`);
              try {
                const jsonData = JSON.parse(fallbackData);
                resolve(jsonData);
              } catch (parseError) {
                reject(new Error(`Failed to parse fallback data: ${parseError}`));
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage || 'Unknown error'}`));
            }
          }
        } catch (parseError) {
          // 解析失败，尝试使用fallback数据
          const fallbackData = getFallbackResponse(urlString);
          if (fallbackData) {
            logger.warn(`Response parsing failed, using fallback data for: ${urlString}`);
            try {
              const jsonData = JSON.parse(fallbackData);
              resolve(jsonData);
            } catch (fallbackParseError) {
              reject(new Error(`Failed to parse fallback data: ${fallbackParseError}`));
            }
          } else {
            reject(new Error(`Failed to parse JSON response: ${parseError}`));
          }
        }
      });
    });

    req.on('error', (error) => {
      // 网络错误，尝试使用fallback数据
      const fallbackData = getFallbackResponse(urlString);
      if (fallbackData) {
        logger.warn(`Network error, using fallback data for: ${urlString}`);
        try {
          const jsonData = JSON.parse(fallbackData);
          resolve(jsonData);
        } catch (parseError) {
          reject(new Error(`Failed to parse fallback data: ${parseError}`));
        }
      } else {
        reject(new Error(`Network error: ${error.message}`));
      }
    });

    req.on('timeout', () => {
      req.destroy();
      // 超时，尝试使用fallback数据
      const fallbackData = getFallbackResponse(urlString);
      if (fallbackData) {
        logger.warn(`Request timeout, using fallback data for: ${urlString}`);
        try {
          const jsonData = JSON.parse(fallbackData);
          resolve(jsonData);
        } catch (parseError) {
          reject(new Error(`Failed to parse fallback data: ${parseError}`));
        }
      } else {
        reject(new Error('Request timeout after 10 seconds'));
      }
    });

    req.end();
  });
}

export async function fetchHistoricalPriceData(pool: any) {
    try {
      // 验证pool结构
      if (!pool || !pool.coin_a || !pool.coin_b) {
        throw new Error(`Invalid pool structure: missing coin_a or coin_b`);
      }
      
      // 构建API URL - 使用正确的pool结构
      const baseCoin = pool.coin_a.address;
      const quoteCoin = pool.coin_b.address;
      
      if (!baseCoin || !quoteCoin) {
        throw new Error(`Invalid coin addresses: baseCoin=${baseCoin}, quoteCoin=${quoteCoin}`);
      }
      
      // 获取2小时前的时间戳
      const now = Math.floor(Date.now() / 1000);
      const from = now - (2 * 60 * 60); // 2小时前
      
      const url = `https://candlesticks.api.sui-prod.bluefin.io/api/v1/pair-price-feed?baseCoin=${baseCoin}&quoteCoin=${quoteCoin}&resolution=60&from=${from}&to=${now}`;
      logger.info(`Fetching historical data from: ${url}`);
      
      // 使用Node.js内置的https模块替代fetch
      const data = await makeHttpRequest(url);
      
      // 验证返回的数据结构
      if (!data || !data.bars || !Array.isArray(data.bars)) {
        throw new Error(`Invalid response format: missing or invalid bars array`);
      }
      
      logger.info(`Successfully fetched ${data.bars.length} historical data points`);
      return data;
    } catch (error) {
      logger.warn(`获取历史数据失败: ${error}`);
      // 添加更详细的错误信息
      if (error instanceof Error) {
        logger.error(`详细错误信息: ${error.message}`);
        if (error.stack) {
          logger.debug(`错误堆栈: ${error.stack}`);
        }
      }
      return null;
    }
}


// 显示Pool价格走势图
export function displayPoolChart(pool: any, currentPrice: number, optimalRanges: any, historicalData: any, positionRange: any) {
logger.renderHeading(2, '📈 Pool价格走势分析');
// 有可能没有 positionRange

if (historicalData && historicalData.bars && historicalData.bars.length > 0) {
    // 提取收盘价
    let prices = historicalData.bars.map((bar: any) => bar.close);
    
    // 计算价格范围
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const midPrice = (minPrice + maxPrice) / 2;
    
    // 使用实际传入的当前价格
    const currentPriceAdjusted = currentPrice;
    
    // 如果数据点超过1000，进行平滑处理
    if (prices.length > 1000) {
    const targetLength = 1000;
    const step = prices.length / targetLength;
    const smoothedPrices = [];
    
    for (let i = 0; i < targetLength; i++) {
        const startIndex = Math.floor(i * step);
        const endIndex = Math.min(startIndex + Math.ceil(step), prices.length);
        const segment = prices.slice(startIndex, endIndex);
        const average = segment.reduce((sum: number, price: number) => sum + price, 0) / segment.length;
        smoothedPrices.push(average);
    }
    
    prices = smoothedPrices;
    }
    
    // 添加当前价格到序列末尾
    prices.push(currentPriceAdjusted);
    
    // 计算实际的价格范围
    const priceRange = maxPrice - minPrice;
    
    // 设置图表参数
    const height = 15;
    const config = {
    height,
    format: (value: number) => value >= 0 ? ` ${value.toFixed(6)}` : value.toFixed(6),
    };

    // 渲染基础图
    const plotLines = asciichart.plot(prices, config).split('\n');

    // 计算position区间应该插入在哪一行
    const range = maxPrice - minPrice;
    const toRow = (value: number) =>
    Math.round((1 - (value - minPrice) / range) * (height - 1));

    // 计算position区间的行位置
    const lowerRow = toRow(positionRange.lower);
    const upperRow = toRow(positionRange.upper);

    // 确保行索引在有效范围内
    const validLowerRow = Math.max(0, Math.min(lowerRow, plotLines.length - 1));
    const validUpperRow = Math.max(0, Math.min(upperRow, plotLines.length - 1));

    // 计算时间范围
    const startTime = historicalData.bars[0]?.openTime || new Date(Date.now() - 2 * 60 * 60 * 1000);
    const endTime = new Date();
    const startTimeStr = new Date(startTime).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const endTimeStr = endTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    // 在图表上标记position区间
    for (let i = 0; i < plotLines.length; i++) {
    if (i === validLowerRow || i === validUpperRow) {
        // 替换整行，用 "═" 表示 LP 价格区间边界
        plotLines[i] = '═'.repeat(plotLines[i].length);
    }
    }

    // 如果position区间超出图表范围，在边界添加标记
    if (lowerRow < 0) {
    plotLines.unshift('═'.repeat(plotLines[0].length));
    }
    if (upperRow >= plotLines.length) {
    plotLines.push('═'.repeat(plotLines[0].length));
    }

    // 输出图表
    logger.renderMarkdown(plotLines.join('\n'));
    
    // 分析价格是否在position区间内
    const isInRange = currentPriceAdjusted >= positionRange.lower && currentPriceAdjusted <= positionRange.upper;
    
    // 创建表格展示关键信息
    const headers = ['**指标**', '**数值**'];
    const rows = [
      ['**时间范围**', `\`${startTimeStr} - ${endTimeStr}\``],
      ['**价格范围**', `\`${minPrice.toFixed(6)} - ${maxPrice.toFixed(6)}\``],
      ['**当前价格**', `\`${currentPriceAdjusted.toFixed(6)}\``],
      ['**Position区间**', `\`${positionRange.lower.toFixed(6)} - ${positionRange.upper.toFixed(6)}\``],
      ['**Position状态**', isInRange ? '✅ 在区间内' : '⚠️ 超出区间']
    ];
    
    logger.renderTable(headers, rows);
    
} else {
    // 如果没有历史数据，显示静态分析
    const isInRange = currentPrice >= positionRange.lower && currentPrice <= positionRange.upper;
    
    // 创建简单的ASCII图表作为fallback
    const height = 10;
    const width = 50;
    const chart = [];
    
    // 计算价格范围
    const priceRange = positionRange.upper - positionRange.lower;
    const minPrice = Math.max(0, positionRange.lower - priceRange * 0.1);
    const maxPrice = positionRange.upper + priceRange * 0.1;
    const totalRange = maxPrice - minPrice;
    
    // 创建图表
    for (let i = 0; i < height; i++) {
        let line = '';
        for (let j = 0; j < width; j++) {
            const priceAtPoint = minPrice + (j / width) * totalRange;
            const rowPrice = maxPrice - (i / height) * totalRange;
            
            if (Math.abs(priceAtPoint - currentPrice) < totalRange * 0.02) {
                line += '●'; // 当前价格点
            } else if (Math.abs(priceAtPoint - positionRange.lower) < totalRange * 0.02 || 
                      Math.abs(priceAtPoint - positionRange.upper) < totalRange * 0.02) {
                line += '═'; // 区间边界
            } else if (priceAtPoint >= positionRange.lower && priceAtPoint <= positionRange.upper) {
                line += '─'; // 区间内
            } else {
                line += ' '; // 空白
            }
        }
        chart.push(line);
    }
    
    logger.renderHeading(3, '**简化价格图表 (无历史数据):**');
    logger.renderMarkdown(chart.join('\n'));
    
    // 创建表格展示关键信息
    const headers = ['**指标**', '**数值**'];
    const rows = [
      ['**时间范围**', '`无历史数据`'],
      ['**价格范围**', `\`${minPrice.toFixed(6)} - ${maxPrice.toFixed(6)}\``],
      ['**当前价格**', `\`${currentPrice.toFixed(6)}\``],
      ['**Position区间**', `\`${positionRange.lower.toFixed(6)} - ${positionRange.upper.toFixed(6)}\``],
      ['**Position状态**', isInRange ? '✅ 在区间内' : '⚠️ 超出区间']
    ];
    
    logger.renderTable(headers, rows);
}
}

// 定期清理过期缓存（每30秒执行一次）
setInterval(cleanupExpiredCache, 30 * 1000);

// 导出缓存统计信息函数（用于调试）
export function getCacheStats() {
  const now = Date.now();
  let validEntries = 0;
  let expiredEntries = 0;
  let fallbackEntries = 0;
  
  for (const [url, entry] of cache.entries()) {
    if (entry.isExpired) {
      fallbackEntries++;
    } else if (now - entry.timestamp > CACHE_DURATION) {
      expiredEntries++;
    } else {
      validEntries++;
    }
  }
  
  return {
    totalEntries: cache.size,
    validEntries,
    expiredEntries,
    fallbackEntries,
    cacheDuration: CACHE_DURATION / 1000 + 's'
  };
}