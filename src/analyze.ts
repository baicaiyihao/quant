import { logger } from "./Logger";
import * as asciichart from "asciichart";

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
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // 验证返回的数据结构
      if (!data || !data.bars || !Array.isArray(data.bars)) {
        throw new Error(`Invalid response format: missing or invalid bars array`);
      }
      
      logger.info(`Successfully fetched ${data.bars.length} historical data points`);
      return data;
    } catch (error) {
      logger.warn(`获取历史数据失败: ${error}`);
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